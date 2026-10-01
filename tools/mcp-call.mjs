#!/usr/bin/env node
/**
 * mcp-call — one tool call against the local WebSense server over raw HTTP.
 *
 * WHY THIS EXISTS: the agent's own MCP client holds a session id, and restarting the server
 * invalidates it — the symptom is a tool call that HANGS until the 300s client timeout, with a
 * perfectly healthy hub behind it (measured 2026-10-01: hub /health said status ok, 1 client
 * connected, while a gateway find() sat for 300s). The hub is fine; the stale session is not.
 * This does the handshake itself, so it keeps working across a server restart.
 *
 * Usage:  node tools/mcp-call.mjs <tool> '<json args>'
 *         node tools/mcp-call.mjs find '{"query":"Close","limit":3}'
 *         node tools/mcp-call.mjs --schema <tool>        (prints the tool's input schema)
 * Set MCP_FULL=1 to print the whole reply instead of the first 1500 characters.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;

const rpc = async (body) => {
  const r = await fetch(B, {
    method: 'POST',
    headers: S ? Object.assign({}, H, { 'mcp-session-id': S }) : H,
    body: JSON.stringify(body),
  });
  const sid = r.headers.get('mcp-session-id');
  if (sid) S = sid;
  const t = await r.text();
  // Streamable HTTP replies arrive as SSE frames; take the data: lines.
  const joined = t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
  return joined || t;
};

const args = process.argv.slice(2);
const full = process.env.MCP_FULL === '1';

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-call', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

let out;
if (args[0] === '--schema') {
  const t = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const j = JSON.parse(t);
  const tool = ((j.result && j.result.tools) || []).find((x) => x.name === args[1]);
  out = tool ? JSON.stringify(tool.inputSchema, null, 1) : 'no such tool: ' + args[1] +
    ' | known: ' + ((j.result && j.result.tools) || []).map((x) => x.name).join(', ');
} else {
  const name = args[0];
  const argv = args[1] ? JSON.parse(args[1]) : {};
  const t = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: argv } });
  const j = JSON.parse(t);
  if (j.error) out = 'RPC ERROR: ' + j.error.message;
  else {
    const blocks = ((j.result && j.result.content) || []).map((x) => x.text || '');
    const whole = blocks.join('\n');
    // MCP_SAVE writes the untruncated reply to a file: a big auto-DIFF is 300 KB and has no
    // business in a context window, but it does need measuring — tools/diff-bloat-report.mjs
    // reads what this writes.
    if (process.env.MCP_SAVE) {
      const fs = await import('fs');
      fs.writeFileSync(process.env.MCP_SAVE, whole);
      out = 'saved ' + whole.length + ' bytes -> ' + process.env.MCP_SAVE;
    } else {
      out = full ? whole : whole.slice(0, 1500);
    }
  }
}
console.log(out);
