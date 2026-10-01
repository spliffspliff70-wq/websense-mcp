#!/usr/bin/env node
// What the RUNNING server has registered. Several manual restarts exited non-zero with only bash
// noise while an older instance kept serving, so "I restarted it" is not evidence the live process
// matches HEAD. This asks the live process.
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;
const rpc = async (body) => {
  const r = await fetch(B, { method: 'POST', headers: S ? Object.assign({ 'mcp-session-id': S }, H) : H, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) S = sid;
  return await r.text();
};
const parse = (t) => { for (const l of t.split('\n')) { const s = l.startsWith('data:') ? l.slice(5).trim() : l.trim(); if (s.startsWith('{')) { try { return JSON.parse(s); } catch (_) {} } } return null; };
(async () => {
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-list', version: '1' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const j = parse(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  const names = ((j && j.result && j.result.tools) || []).map((t) => t.name).sort();
  console.log('registered tools: ' + names.length);
  console.log('trusted ops present: ' + names.filter((n) => n.indexOf('trusted') === 0).join(', '));
  for (const want of ['browse', 'find', 'trusted_click', 'trusted_key', 'press_key']) {
    if (names.indexOf(want) < 0) console.log('MISSING from the live server: ' + want);
  }
})();
