const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;
const j = async (o) => {
  const r = await fetch(B, { method: 'POST', headers: S ? Object.assign({}, H, { 'mcp-session-id': S }) : H, body: JSON.stringify(o) });
  const s = r.headers.get('mcp-session-id'); if (s) S = s;
  const t = await r.text();
  const d = t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
  return d || t;
};
const call = async (n, a) => {
  const t = await j({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: n, arguments: a || {} } });
  const p = JSON.parse(t);
  return ((p.result && p.result.content) || []).map((x) => x.text || '').join('\n');
};
// THE SURFACE CHECK (2026-10-01): the combined tools must DISPATCH, end to end, in ONE session —
// each mcp-call is a new MCP session, so browse + act must happen in the same process or the hub's
// cross-session guard rightly refuses the op.
await j({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'surface-check', version: '1' } } });
await j({ jsonrpc: '2.0', method: 'notifications/initialized' });
const read = (t) => call('debug', { op: 'main_world', tabId: T, func: t, verify: false });
const br = JSON.parse(await call('browse', { url: 'http://127.0.0.1:8099/bench/click_fingerprint.html' }));
const T = br.tabId;
console.log('1. browse listed and answered, tabId =', T);
const before = await read('() => document.getElementById("fp-grow-state").textContent');
console.log('2. debug{op:main_world} ->', before.replace(/\s+/g, ' ').slice(0, 80));
const r = await call('act', { action: 'click', ref: '#fp-grow', tabId: T, verify: false });
console.log('3. act{action:click}   ->', /success/.test(r) ? 'dispatched' : 'REPLY: ' + r.slice(0, 120));
const after = await read('() => document.getElementById("fp-grow-state").textContent');
const changed = before !== after;
console.log('4. page state after     ->', after.replace(/\s+/g, ' ').slice(0, 80));
console.log('5. the click LANDED (page says so):', changed);
const st = await call('debug', { op: 'status' });
console.log('6. debug{op:status}     ->', st.replace(/\s+/g, ' ').slice(0, 110));
console.log(changed && /"url"/.test(st) ? '\nSURFACE CHECK: PASS' : '\nSURFACE CHECK: FAIL');
