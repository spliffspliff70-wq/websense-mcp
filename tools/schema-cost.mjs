#!/usr/bin/env node
// Measure what the TOOL SCHEMAS cost — the payload every session pays for before a single page op.
// Ali: "40k tokens is still a lot for a few visible buttons". This puts a number on it.
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;
async function rpc(body) {
  const r = await fetch(B, { method: 'POST', headers: S ? Object.assign({ 'mcp-session-id': S }, H) : H, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) S = sid;
  const t = await r.text();
  for (const line of t.split('\n')) {
    let s = line.trim();
    if (s.startsWith('data:')) s = s.slice(5).trim();
    if (s.startsWith('{')) { try { return JSON.parse(s); } catch (_) {} }
  }
  return null;
}
await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-cost', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const j = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tools = (j && j.result && j.result.tools) || [];
const rows = tools.map((t) => ({ name: t.name, bytes: JSON.stringify(t).length }));
rows.sort((a, b) => b.bytes - a.bytes);
const total = rows.reduce((n, r) => n + r.bytes, 0);
console.log('tools: ' + rows.length);
console.log('total schema payload: ' + total + ' bytes  (~' + Math.round(total / 4) + ' tokens if 4 chars/token)');
console.log('\nbiggest 12 (this is what the model pays for every session, before doing anything):');
for (const r of rows.slice(0, 12)) console.log('  ' + String(r.bytes).padStart(6) + '  ' + r.name);
console.log('\nsmallest 5:');
for (const r of rows.slice(-5)) console.log('  ' + String(r.bytes).padStart(6) + '  ' + r.name);
