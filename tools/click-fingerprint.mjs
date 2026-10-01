#!/usr/bin/env node
/**
 * click-fingerprint — "register exactly how a human click is registered in the website code".
 *
 * Runs the SAME three clicks through two paths and diffs the FULL event record the page saw:
 *   A. click{ref}        — the content-script path: dispatchEvent() of a pointer+mouse sequence
 *   B. trusted_click{ref} — chrome.debugger + Input.dispatchMouseEvent: the browser's OWN input
 *                           pipeline, i.e. what a real mouse produces
 *
 * Compares (1) WHICH events arrive and in what order, (2) the fields that carry state
 * (isTrusted/buttons/clickCount/pointerId/pressure/coords), and (3) whether each element's DEFAULT
 * ACTION actually ran — checkbox toggled, hash changed, input focused. (3) is the functional half:
 * a page does not have to inspect a single event property to behave differently.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fp', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __err: JSON.stringify(j.error).slice(0, 200) };
  const blocks = (j.result.content || []).map((x) => x.text || '');
  let json = null;
  try { json = JSON.parse(blocks[0]); } catch { json = { __raw: String(blocks[0]).slice(0, 200) }; }
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (tabId, func) => { const r = await call('main_world', { tabId, func }); const res = r && r.results && r.results[0]; return res ? res.result : r; };

const b = await call('browse', { url: 'http://127.0.0.1:8099/bench/click_fingerprint.html' });
const tabId = b.tabId;
console.log('tabId:', tabId, '| elements:', b.index && b.index.elements);
await sleep(900);

const reset = () => ev(tabId, '() => { window.__reset(); return true; }');
const dumpState = () => ev(tabId, '() => ({ rec: window.__rec, count: window.__count, chk: document.getElementById("chk").checked, hash: location.hash, focused: (document.activeElement && document.activeElement.id) || null })');
const findRef = async (testid) => {
  // find{query} matches name / locator / tag / region / ATTRIBUTE NAMES — not attribute values, so
  // searching 'fp-btn' matches nothing. Search the attribute NAME and pick the element that carries
  // the value we want. (My first version searched the value and got {} for every ref.)
  const f = await call('find', { tabId, query: 'data-testid', limit: 40 });
  const h = (f.hits || []).find((x) => x.attrs && x.attrs['data-testid'] === testid);
  return h && h.loc;
};

const refs = {
  btn: await findRef('fp-btn'), chk: await findRef('fp-chk'), lnk: await findRef('fp-lnk'), inp: await findRef('fp-inp'),
};
console.log('refs:', JSON.stringify(refs));

async function run(path, op, ref) {
  await reset();
  await sleep(120);
  const t = op === 'trusted_click'
    ? await call('trusted_click', { tabId, ref })
    : await call('click', { tabId, ref });
  await sleep(450);
  const st = await dumpState();
  return { st, claim: t.effect, raw: t };
}

const elOf = { btn: 'fp-btn', chk: 'fp-chk', lnk: 'fp-lnk', inp: 'fp-inp' };
const rows = [];
for (const key of ['btn', 'chk', 'lnk', 'inp']) {
  const ref = refs[key];
  const A = await run('synthetic', 'click', ref);
  const Bt = await run('trusted', 'trusted_click', ref);
  const typesA = (A.st.rec || []).map((e) => e.type).join('>');
  const typesB = (Bt.st.rec || []).map((e) => e.type).join('>');
  const clickA = (A.st.rec || []).find((e) => e.type === 'click');
  const clickB = (Bt.st.rec || []).find((e) => e.type === 'click');
  // default-action outcomes, which need no event inspection at all
  const dfltA = key === 'chk' ? A.st.chk : key === 'lnk' ? A.st.hash : key === 'inp' ? A.st.focused : A.st.count;
  const dfltB = key === 'chk' ? Bt.st.chk : key === 'lnk' ? Bt.st.hash : key === 'inp' ? Bt.st.focused : Bt.st.count;
  rows.push({ key, typesA, typesB, clickA, clickB, dfltA, dfltB, claimA: A.claim, claimB: Bt.claim, rawB: Bt.raw, rawA: A.raw });
}

const fld = (c, k) => (c ? JSON.stringify(c[k]) : '-');
console.log('\n══ WHICH EVENTS ARRIVE (synthetic → trusted) ══');
for (const r of rows) {
  console.log('\n#' + r.key);
  console.log('  A(synthetic): ' + (r.typesA || '(none)'));
  console.log('  B(trusted)  : ' + (r.typesB || '(none)'));
  console.log('  same sequence: ' + (r.typesA === r.typesB));
  console.log('  click A: isTrusted=' + fld(r.clickA, 'isTrusted') + ' detail=' + fld(r.clickA, 'detail') + ' clientX=' + fld(r.clickA, 'clientX') + ' buttons=' + fld(r.clickA, 'buttons'));
  console.log('  click B: isTrusted=' + fld(r.clickB, 'isTrusted') + ' detail=' + fld(r.clickB, 'detail') + ' clientX=' + fld(r.clickB, 'clientX') + ' buttons=' + fld(r.clickB, 'buttons'));
  console.log('  DEFAULT ACTION  A=' + JSON.stringify(r.dfltA) + '  B=' + JSON.stringify(r.dfltB));
  console.log('  tool verdict    A=' + JSON.stringify(r.claimA) + '  B=' + JSON.stringify(r.claimB));
  console.log('  B raw reply: ' + JSON.stringify(r.rawB).slice(0, 420));
}
await call('tabs', { action: 'close', tabId });
