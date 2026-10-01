#!/usr/bin/env node
/**
 * slice-to-file — drive the WebSense MCP server over raw Streamable HTTP.
 * Used when the client-side tool registry is orphaned ("not a deferrable tool")
 * while the hub itself is healthy. Also the sane way to pull a >2 MB page_slice
 * that would blow the tool-result budget.
 *
 * Usage: node tools/slice-to-file.mjs <out.json> [toolJsonArgs] [tabId]
 *   node tools/slice-to-file.mjs x-dump.json '{"tool":"page_slice","args":{}}' 328034529
 */
const BASE = 'http://127.0.0.1:9222/mcp';
const out = process.argv[2] || 'slice.json';
const req = process.argv[3] ? JSON.parse(process.argv[3]) : { tool: 'page_slice', args: {} };
const tabId = process.argv[4] ? Number(process.argv[4]) : null;

const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function rpc(body, sid) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: sid ? { ...H, 'mcp-session-id': sid } : H,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const sid2 = r.headers.get('mcp-session-id');
  return { text, sid: sid2, status: r.status };
}

const parse = (t) => {
  const line = t.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : t);
};

const init = await rpc({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'slice-to-file', version: '1' } },
});
const sid = init.sid;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
console.error('session', sid);

const call = async (name, args) => {
  const r = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, sid);
  const j = parse(r.text);
  if (j.error) throw new Error(name + ' -> ' + JSON.stringify(j.error).slice(0, 300));
  const txt = j.result?.content?.[0]?.text ?? '';
  return txt;
};

if (tabId) console.error('bind:', (await call('tabs', { action: 'bind', tabId })).slice(0, 120));

const nav = process.argv[5];
if (nav) {
  console.error('navigate:', (await call('browse', { url: nav })).slice(0, 140));
  await new Promise((r) => setTimeout(r, 9000));
  console.error('re-collect:', (await call('browse', { fresh: true, tabId })).slice(0, 100));
}

const txt = await call(req.tool, { ...req.args, ...(tabId && req.tool !== 'tabs' ? { tabId } : {}) });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, JSON.stringify({ result: txt }));
console.error('wrote', out, txt.length, 'chars');
