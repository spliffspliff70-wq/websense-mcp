#!/usr/bin/env node
/**
 * task-battery — REAL multi-step tasks, each scored against an oracle that is NOT the tool's own
 * diff (main_world reads the page's own JS: location, title, DOM values).
 *
 * v2 fixes three instrument faults found by v1's first run:
 *   1. only the LAST step's claim was reported, so a failure gave no idea WHICH step broke ->
 *      every step is now traced with its effect and its diff counts.
 *   2. S3 clicked into a category that has a single page, so "no next link" was TRUE and not a
 *      tool failure -> it now uses the catalogue, which definitely paginates.
 *   3. a diff that never arrives is now shown as NO-DIFF rather than as zero changes, because
 *      those are different facts and v1 conflated them (click returned NO-DIFF).
 *
 * Destructive-action rule: reads, navigations and unsubmitted form fills only. Nothing is posted,
 * purchased, sent or deleted.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'battery2', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);

let trace = [];
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) { trace.push({ op: name, err: JSON.stringify(j.error).slice(0, 90) }); return { __err: JSON.stringify(j.error).slice(0, 200) }; }
  const blocks = (j.result.content || []).map((x) => x.text || '');
  let json = null, diff = null;
  try { json = JSON.parse(blocks[0]); } catch { json = { __raw: String(blocks[0]).slice(0, 160) }; }
  for (const b of blocks.slice(1)) {
    const m = b.match(/^DIFF \(auto, after [^)]+\): ([\s\S]*)$/);
    if (m) { try { diff = JSON.parse(m[1]); } catch { diff = { __raw: 1 }; } }
  }
  const d = diff || {};
  trace.push({
    op: name,
    effect: json && json.effect,
    success: json && json.success,
    reason: json && (json.reason || (json.data && json.data.reason)),
    loc: json && (json.loc || json.ref || (json.data && json.data.ref)),
    diff: diff ? ('S' + ((d.structure || {}).count) + '/C' + ((d.content || {}).count) + '/V' + ((d.viewport || {}).count) + ' mut=' + d.mutated) : 'NO-DIFF',
  });
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function oracle(tabId, func) {
  const r = await call('main_world', { tabId, func });
  const res = r && r.results && r.results[0];
  return res ? res.result : r;
}
const showTrace = () => trace.filter((t) => t.op !== 'main_world' && t.op !== 'browse').forEach((t) =>
  console.log('          · ' + t.op.padEnd(11) + ' effect=' + String(t.effect).padEnd(10) + ' diff=' + String(t.diff).padEnd(28)
    + (t.reason ? 'reason=' + String(t.reason).slice(0, 40) : '') + (t.err ? 'ERR ' + t.err : '')));

const scenarios = [
  {
    name: 'S1 wikipedia: fill the real search box, submit with Enter, land on the article',
    run: async () => {
      const b = await call('browse', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
      const tabId = b.tabId;
      await sleep(3000);
      const f = await call('find', { tabId, field: true, limit: 60 });
      const input = (f.hits || []).find((h) => /searchInput|search/i.test(JSON.stringify(h.loc) + JSON.stringify(h.attrs)));
      if (!input) return { pass: false, why: 'no search field in the inventory' };
      await call('type_text', { tabId, ref: input.loc, text: 'World War II' });
      const held = await oracle(tabId, '() => { var e = document.querySelector("#searchInput"); return e ? e.value : "NO-INPUTFIELD"; }');
      await call('press_key', { tabId, key: 'Enter', ref: input.loc });
      await sleep(3500);
      const o = await oracle(tabId, '() => ({ href: location.href, title: document.title })');
      const ok = o && /World_War_II|search=/.test(String(o.href));
      return { pass: !!ok, why: 'field=' + input.loc + ' valueAfterType=' + JSON.stringify(held) + ' finalHref=' + (o && o.href) };
    },
  },
  {
    name: 'S2 hacker news: click a nav link whose destination we read from the page first',
    run: async () => {
      const b = await call('browse', { url: 'https://news.ycombinator.com/' });
      const tabId = b.tabId;
      await sleep(2500);
      const f = await call('find', { tabId, query: 'newest', interactive: true, limit: 20 });
      const link = (f.hits || [])[0];
      if (!link) return { pass: false, why: 'no newest link found' };
      const predicted = (link.attrs && (link.attrs.href || link.attrs.HREF)) || null;
      await call('click', { tabId, ref: link.loc });
      await sleep(2500);
      const o = await oracle(tabId, '() => ({ pathname: location.pathname, href: location.href })');
      return { pass: !!(o && o.pathname === '/newest'), why: 'predicted=' + predicted + ' actual=' + (o && o.href) };
    },
  },
  {
    name: 'S3 books.toscrape: paginate the catalogue (guaranteed > 1 page), verified by URL',
    run: async () => {
      const b = await call('browse', { url: 'https://books.toscrape.com/catalogue/page-1.html' });
      const tabId = b.tabId;
      await sleep(2500);
      const o1 = await oracle(tabId, '() => location.href');
      const f = await call('find', { tabId, query: 'next', interactive: true, limit: 30 });
      const next = (f.hits || []).find((h) => h.attrs && /page-2/.test(String(h.attrs.href)));
      if (!next) return { pass: false, why: 'start=' + o1 + ' but no page-2 link found among ' + (f.hits || []).length + ' hits; hrefs=' + JSON.stringify((f.hits || []).slice(0, 6).map((h) => h.attrs && h.attrs.href)) };
      await call('click', { tabId, ref: next.loc });
      await sleep(2500);
      const o2 = await oracle(tabId, '() => location.href');
      return { pass: /page-2/.test(String(o2)), why: 'start=' + o1 + ' -> ' + o2 };
    },
  },
  {
    name: 'S4 wikipedia portal: change a real <select> and verify the PAGE state changed',
    run: async () => {
      const b = await call('browse', { url: 'https://www.wikipedia.org/' });
      const tabId = b.tabId;
      await sleep(2500);
      const f = await call('find', { tabId, query: 'Language', interactive: true, limit: 40 });
      let sel = (f.hits || []).find((h) => h.tag === 'select');
      if (!sel) { const f2 = await call('find', { tabId, query: 'select', interactive: true, limit: 40 }); sel = (f2.hits || []).find((h) => h.tag === 'select'); }
      if (!sel) return { pass: false, why: 'no <select> found in the inventory' };
      const before = await oracle(tabId, '() => { var s=document.querySelector("select"); return s ? s.value : null; }');
      const opts = await oracle(tabId, '() => { var s=document.querySelector("select"); return s ? Array.prototype.map.call(s.options, function(o){return o.value;}) : []; }');
      const target = (opts || []).find((v) => v && v !== before);
      if (!target) return { pass: false, why: 'no alternative option found (options=' + JSON.stringify((opts || []).slice(0, 5)) + ')' };
      const r = await call('form', { tabId, action: 'select', ref: sel.loc, value: target });
      await sleep(900);
      const after = await oracle(tabId, '() => { var s=document.querySelector("select"); return s ? s.value : null; }');
      const ph = await oracle(tabId, '() => { var i=document.querySelector("#searchInput"); return i ? i.placeholder : null; }');
      const claimTxt = r && (r.success === false ? 'form reported FAILURE' : 'form success=' + r.success);
      return { pass: after === target, why: 'select ' + before + ' -> ' + after + ' (target ' + target + ') | placeholder=' + JSON.stringify(ph) + ' | tool said: ' + claimTxt, on: sel.loc };
    },
  },
];

let pass = 0;
for (const s of scenarios) {
  trace = [];
  let r;
  try { r = await s.run(); } catch (e) { r = { pass: false, why: 'THREW: ' + String(e).slice(0, 180) }; }
  if (r.pass) pass++;
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + s.name);
  console.log('        oracle: ' + r.why);
  showTrace();
}
const noDiff = trace.length ? '' : '';
console.log('\n' + pass + '/' + scenarios.length + ' tasks completed against an independent oracle');
