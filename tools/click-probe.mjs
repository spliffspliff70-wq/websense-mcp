#!/usr/bin/env node
/** click-probe — does the click verdict see a navigation? Print the RAW result, not a summary. */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cp', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __err: JSON.stringify(j.error).slice(0, 200) };
  const blocks = (j.result.content || []).map((x) => x.text || '');
  let json = null, diff = null;
  try { json = JSON.parse(blocks[0]); } catch { json = { __raw: 1 }; }
  for (const b of blocks.slice(1)) { const m = b.match(/^DIFF \(auto, after [^)]+\): ([\s\S]*)$/); if (m) { try { diff = JSON.parse(m[1]); } catch { diff = null; } } }
  return { json, diff };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mw = async (tabId, func) => { const r = await call('main_world', { tabId, func }); const res = r.json && r.json.results && r.json.results[0]; return res ? res.result : r.json; };

const b = await call('browse', { url: 'https://news.ycombinator.com/' });
const tabId = b.json.tabId;
await sleep(2500);
const f = await call('find', { tabId, query: 'newest', interactive: true, limit: 20 });
const link = (f.json.hits || [])[0];
console.log('url before :', await mw(tabId, '() => location.href'));
const r = await call('click', { tabId, ref: link.loc });
await sleep(2500);
console.log('url after  :', await mw(tabId, '() => location.href'));
console.log('effect     :', r.json && r.json.effect);
const J = (v) => String(JSON.stringify(v));
console.log('navigation :', J(r.json && r.json.navigation).slice(0, 200));
console.log('beforeState:', J(r.json && r.json.beforeState).slice(0, 200));
console.log('afterState :', J(r.json && r.json.afterState).slice(0, 200));
console.log('escalation :', J(r.json && r.json.escalation).slice(0, 160));
console.log('data       :', J(r.json && r.json.data).slice(0, 500));
console.log('raw keys   :', Object.keys(r.json || {}).join(','));
await call('tabs', { action: 'close', tabId });
