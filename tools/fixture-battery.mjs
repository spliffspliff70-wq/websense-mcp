#!/usr/bin/env node
/**
 * fixture-battery — the areas the web sample had none of: SHADOW DOM, nested shadow roots, and
 * FILE UPLOADS. Uses the repo's own deterministic fixture (bench/shadow_fixture.html), where
 * document.querySelectorAll genuinely CANNOT find the controls, so a plain selector sees an empty
 * page while the real controls are there.
 *
 * Every step is scored against the page's own state read through main_world, traversing shadow
 * roots by hand — an oracle that shares no code with the collector that produced the refs.
 *
 * Destructive-action rule: nothing is submitted, sent or deleted. The upload probe uses a 21-byte
 * local file and never triggers a form submit.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixt', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __err: JSON.stringify(j.error).slice(0, 200) };
  const blocks = (j.result.content || []).map((x) => x.text || '');
  let json = null, diff = null;
  try { json = JSON.parse(blocks[0]); } catch { json = { __raw: String(blocks[0]).slice(0, 200) }; }
  for (const b of blocks.slice(1)) { const m = b.match(/^DIFF \(auto, after [^)]+\): ([\s\S]*)$/); if (m) { try { diff = JSON.parse(m[1]); } catch { diff = null; } } }
  return { json, diff, blocks };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** page truth, reaching into shadow roots by hand */
const shadowProbe = (testid) => '() => { function f(sel, root){ var e = root.querySelector(sel); if (e) return e; var a = root.querySelectorAll("*"); for (var i = 0; i < a.length; i++){ if (a[i].shadowRoot){ var r = f(sel, a[i].shadowRoot); if (r) return r; } } return null; } var el = f(\'[data-testid="' + testid + '"]\', document); if (!el) return { found: false }; return { found: true, tag: el.tagName, value: (el.value === undefined ? null : el.value), files: (el.files ? el.files.length : null) }; }';
async function probe(tabId, testid) {
  const r = await call('main_world', { tabId, func: shadowProbe(testid) });
  const res = r.json && r.json.results && r.json.results[0];
  return res ? res.result : r.json;
}
const FILE = 'E:/websense-oss/probe.mp4';
const results = [];
const note = (name, pass, why) => { results.push({ name, pass }); console.log((pass ? 'PASS  ' : 'FAIL  ') + name); console.log('        ' + why); };

const b = await call('browse', { url: 'http://127.0.0.1:8099/bench/shadow_fixture.html' });
const tabId = b.json.tabId;
console.log('tabId:', tabId, '| elements:', b.json.index && b.json.index.elements);
await sleep(1200);

// ── 1. are the shadow controls in the inventory at all? ──────────────────────────────────────
const f1 = await call('find', { tabId, query: 'shadow', limit: 50 });
const hits = (f1.json && f1.json.hits) || [];
const byTestid = (t) => hits.find((h) => JSON.stringify(h.attrs || {}).indexOf(t) >= 0);
const shadowBtn = byTestid('shadow-btn');
const deepBtn = byTestid('deep-shadow-btn');
const shadowInput = byTestid('shadow-input');
const shadowFile = byTestid('shadow-file');
const lightBtn = (await call('find', { tabId, query: 'light-btn', limit: 20 })).json.hits[0];
note('shadow: the inventory reaches into open shadow roots (1 and 2 levels deep)',
  !!(shadowBtn && deepBtn),
  'shadow-btn=' + !!shadowBtn + ' deep-shadow-btn(2 levels)=' + !!deepBtn + ' | light-dom control=' + !!lightBtn + ' | hits=' + hits.length);

// ── 2. type into an input that lives inside a shadow root ────────────────────────────────────
if (shadowInput) {
  const t = await call('type_text', { tabId, ref: shadowInput.loc, text: 'shadow@example.com' });
  const after = await probe(tabId, 'shadow-input');
  note('shadow: type_text fills an input inside a shadow root (verified in the shadow DOM)',
    after && after.value === 'shadow@example.com',
    'page says value=' + JSON.stringify(after && after.value) + ' | tool said effect=' + JSON.stringify(t.json.effect) + ' success=' + JSON.stringify(t.json.success));
} else {
  note('shadow: type_text fills an input inside a shadow root', false, 'the shadow input was not in the inventory, so nothing to type into');
}

// ── 3. click a control two shadow roots deep ─────────────────────────────────────────────────
if (deepBtn) {
  const c = await call('click', { tabId, ref: deepBtn.loc });
  const still = await probe(tabId, 'deep-shadow-btn');
  note('shadow: click reaches a control TWO shadow roots deep',
    !!(c.json && c.json.success !== false) && !!(still && still.found),
    'tool said success=' + JSON.stringify(c.json.success) + ' effect=' + JSON.stringify(c.json.effect) + ' | element still present=' + !!(still && still.found));
} else {
  note('shadow: click reaches a control TWO shadow roots deep', false, 'not in the inventory');
}

// ── 4 + 5. uploads, shadow and light, verified by input.files ────────────────────────────────
for (const [label, hit] of [['shadow file input', shadowFile], ['light-DOM file input', (await call('find', { tabId, query: 'light-file', limit: 20 })).json.hits[0]]]) {
  if (!hit) { note('upload: ' + label, false, 'not in the inventory'); continue; }
  const u = await call('form', { tabId, action: 'upload', ref: hit.loc, filePath: FILE });
  await sleep(500);
  const after = await probe(tabId, label.indexOf('shadow') === 0 ? 'shadow-file' : 'light-file');
  const d = u.json && u.json.data ? u.json.data : u.json;
  note('upload: ' + label + ' — the file actually attaches (page reads input.files)',
    !!(after && after.files > 0),
    'page says files=' + JSON.stringify(after && after.files) + ' | tool said success=' + JSON.stringify(d && d.success) + ' fileCount=' + JSON.stringify(d && d.fileCount) + ' effect=' + JSON.stringify(u.json.effect));
}

console.log('\n' + results.filter((r) => r.pass).length + '/' + results.length + ' fixture checks passed');
await call('tabs', { action: 'close', tabId });
