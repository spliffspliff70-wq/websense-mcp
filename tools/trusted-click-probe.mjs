#!/usr/bin/env node
/**
 * trusted-click-probe — is the press dropped because the TAB IS NOT ACTIVE?
 *
 * The trusted path delivers mouseMoved (the page sees pointerover/pointermove) but never
 * pointerdown/click, and the move command takes ~5s to return. Two candidate causes: Chrome
 * deferring input to a non-active tab, or the input pipeline coalescing. This toggles exactly one
 * variable — tab activation — and prints the event list and timings for both cases.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tc', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __err: JSON.stringify(j.error).slice(0, 200) };
  const blk = (j.result.content || [])[0];
  try { return JSON.parse(blk.text); } catch { return { __raw: String(blk.text).slice(0, 200) }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (tabId, func) => { const r = await call('main_world', { tabId, func }); const res = r && r.results && r.results[0]; return res ? res.result : r; };

const b = await call('browse', { url: 'http://127.0.0.1:8099/bench/click_fingerprint.html' });
const tabId = b.tabId;
await sleep(900);
const findRef = async (testid) => {
  const f = await call('find', { tabId, query: 'data-testid', limit: 40 });
  const h = (f.hits || []).find((x) => x.attrs && x.attrs['data-testid'] === testid);
  return h && h.loc;
};
const ref = await findRef('fp-btn');
const state = () => ev(tabId, '() => ({ types: window.__rec.map(function(e){return e.type;}), click: window.__rec.filter(function(e){return e.type==="click";})[0] || null, count: window.__count, hasFocus: document.hasFocus(), vis: document.visibilityState })');
const reset = () => ev(tabId, '() => { window.__reset(); return true; }');

console.log('tabId', tabId, 'ref', ref);
console.log('tab list before:', JSON.stringify((await call('tabs', { action: 'list' })).tabs ? (await call('tabs', { action: 'list' })).tabs.map((t) => t.id + (t.active ? '*' : '') + (t.tabId ? '' : '')) : 'n/a').slice(0, 200));

// ── case 1: exactly as-is (whatever activation state the tab is in) ───────────────────────────
await reset(); await sleep(150);
const r1 = await call('trusted_click', { tabId, ref });
await sleep(500);
const s1 = await state();
console.log('\nCASE 1 — no activation attempt');
console.log('  timings:', JSON.stringify(r1.timings), '| ms:', r1.ms);
console.log('  hasFocus:', s1.hasFocus, '| visibility:', s1.vis);
console.log('  events:', (s1.types || []).join('>') || '(none)');
console.log('  click:', s1.click ? ('isTrusted=' + s1.click.isTrusted + ' detail=' + s1.click.detail + ' clientX=' + s1.click.clientX) : '(none)');
console.log('  counter (default action):', s1.count);

// ── case 2: make the tab ACTIVE first, change nothing else ────────────────────────────────────
await call('tabs', { action: 'switch', tabId });
await sleep(700);
await reset(); await sleep(150);
const r2 = await call('trusted_click', { tabId, ref });
await sleep(500);
const s2 = await state();
console.log('\nCASE 2 — after tabs{action:"switch"} (tab made active)');
console.log('  timings:', JSON.stringify(r2.timings), '| ms:', r2.ms);
console.log('  hasFocus:', s2.hasFocus, '| visibility:', s2.vis);
console.log('  events:', (s2.types || []).join('>') || '(none)');
console.log('  click:', s2.click ? ('isTrusted=' + s2.click.isTrusted + ' detail=' + s2.click.detail + ' clientX=' + s2.click.clientX) : '(none)');
console.log('  counter (default action):', s2.count);
await call('tabs', { action: 'close', tabId });
