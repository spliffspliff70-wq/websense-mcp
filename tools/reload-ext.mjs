#!/usr/bin/env node
/** reload the WebSense extension (so a rebuilt content script is what pages get). */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reload', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __err: JSON.stringify(j.error).slice(0, 200) };
  const b = (j.result.content || [])[0];
  try { return JSON.parse(b.text); } catch { return { __raw: String(b.text).slice(0, 200) }; }
}
console.log('reload ->', JSON.stringify(await call('extension_reload', {})).slice(0, 260));

// ★ THE OFFSCREEN DOCUMENT DOES NOT RELOAD WITH THE EXTENSION (2026-09-25, re-confirmed 2026-10-01):
// it survives an extension reload, so a change to offscreen.js is NOT live until it is respawned.
// Both happen here, because forgetting the respawn looks exactly like "my change did nothing".
if (!process.argv.includes('--no-respawn')) {
  await new Promise((r) => setTimeout(r, 1500));
  console.log('respawn ->', JSON.stringify(await call('respawn_offscreen', {})).slice(0, 200));
}

