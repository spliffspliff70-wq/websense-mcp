#!/usr/bin/env node
// Print the registered tools with a SHORT description each, so the list can be read and grouped.
// Usage: node tools/tools-list.mjs            -> names only, plus trusted-op presence (preflight use)
//        node tools/tools-list.mjs --full     -> name + first line of the description
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;
async function rpc(body) {
  const r = await fetch(B, { method: 'POST', headers: S ? Object.assign({ 'mcp-session-id': S }, H) : H, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) S = sid;
  const t = await r.text();
  for (const line of t.split('\n')) {
    let s = line.trim();
    // The server answers over SSE, so the JSON is behind a "data:" prefix; a plain-JSON answer
    // arrives bare. Handle both — an earlier version of this only handled the bare form and
    // reported "0 tools" against a healthy server, which is exactly the kind of false negative
    // this file exists to prevent.
    if (s.startsWith('data:')) s = s.slice(5).trim();
    if (s.startsWith('{')) { try { return JSON.parse(s); } catch (_) {} }
  }
  return null;
}
await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-list', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const j = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tools = (j && j.result && j.result.tools) || [];
const full = process.argv.indexOf('--full') > 0;
console.log('registered tools: ' + tools.length);
if (full) {
  for (const t of tools) {
    const d = String(t.description || '').replace(/\s+/g, ' ').trim();
    console.log(t.name.padEnd(18) + d.slice(0, 78));
  }
} else {
  const bad = ['trusted_click', 'trusted_key'].filter((n) => !tools.some((t) => t.name === n));
  console.log(bad.length ? 'MISSING from the live server: ' + bad.join(', ') : 'trusted ops present: trusted_click, trusted_key');
}
