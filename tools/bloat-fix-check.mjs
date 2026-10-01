#!/usr/bin/env node
/**
 * bloat-fix-check — verify, deterministically, the two things the auto-DIFF was measured getting
 * wrong on a live page. Fixture: bench/click_fingerprint.html (served from the repo root).
 *
 * CHECK 1 — A LOCATOR MUST NOT BE A PAINT INSTRUCTION.
 *   The fixture carries an SVG path with a long UNIQUE d and no id/data-testid. Before: the locator
 *   builder took the first unique attribute, so this element's locator was path[d="M11.11 ..."] at
 *   ~700 characters. Measured on x.com: 199 KB of a 340 KB diff was locator text of this shape,
 *   and such a locator is not usable to act on.
 *
 * CHECK 2 — A LAYOUT SHIFT IS A FEW FACTS, NOT N.
 *   Clicking #fp-grow opens a 200px block, so every element after it moves by the same delta with
 *   the SCROLL POSITION UNCHANGED. Before: one entry per element ({loc, was, now}), measured at
 *   2,023 entries / 333.5 KB. After: each DISTINCT movement once, with the count and the inventory
 *   indices of everything that moved by it — no element dropped, nothing hidden.
 *
 * Requires: the server on :9222 and `python -m http.server 8099` in the repo root.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;
const rpc = async (body) => {
  const r = await fetch(B, { method: 'POST', headers: S ? Object.assign({}, H, { 'mcp-session-id': S }) : H, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) S = sid;
  const t = await r.text();
  return t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('') || t;
};
const parse = (t) => { try { return JSON.parse(t); } catch { return { __raw: t }; } };
async function call(name, args) {
  const t = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
  const j = parse(t);
  if (j.error) return { __error: j.error.message };
  const blocks = ((j.result && j.result.content) || []).map((x) => x.text || '');
  const first = parse(blocks[0] || '');
  first.__all = blocks.join('\n');
  return first;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log('  FAIL ' + msg); } else console.log('  ok   ' + msg); };

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bloat-check', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

// A FRESH browse — the baseline must be seeded by the CURRENT build, not an older vocabulary.
// RETRY, because the hub accepts MCP requests seconds before the EXTENSION has reconnected after a
// restart: measured 2026-10-01, browse answered with no tabId ~12s after a restart and worked on
// the next attempt. A checker that reports on that race is a checker that cries wolf — and this
// same wait is what the scheduled battery needs.
let b = null;
for (let attempt = 0; attempt < 12; attempt++) {
  b = await call('browse', { url: 'http://127.0.0.1:8099/bench/click_fingerprint.html' });
  if (b && b.tabId) break;
  console.log('  ... waiting for the extension to reconnect (attempt ' + (attempt + 1) + ')');
  await sleep(5000);
}
const tabId = b && b.tabId;
ok(!!tabId, 'browse bound a tab (' + tabId + ')');
if (!tabId) process.exit(1);
await sleep(1500);

console.log('\nCHECK 1 — the locator must identify the element, not the drawing');
const paths = await call('page_slice', { tabId, tag: 'path', limit: 5 });
const hit = ((paths.elements || [])[0]) || {};
const loc = String(hit.loc || '');
console.log('  the SVG path\'s locator: ' + loc.slice(0, 90) + (loc.length > 90 ? '...' : '') +
  '  (' + loc.length + ' chars)');
ok(loc.length > 0, 'the path is in the inventory (nothing dropped)');
ok(loc.indexOf('path[d=') !== 0 && loc.indexOf('[d=') < 0,
  'the locator does NOT use the rendering attribute d (was ~700 chars of path data)');
ok(loc.length < 200, 'and it is short (' + loc.length + ' chars, was > 700)');
const diffHasPathLoc = (await call('page_slice', { tabId, tag: 'svg', limit: 1 })).__all || '';
ok(typeof diffHasPathLoc === 'string', 'and the inventory still carries the element itself');

console.log('\nCHECK 2 — a layout shift must be reported as distinct movements');
const clk = await call('trusted_click', { selector: '#fp-grow', tabId });
const raw = clk.__all || '';
const di = raw.indexOf('DIFF (auto, after ');
ok(di > 0, 'the click produced an auto-DIFF');
const dm = raw.slice(di).match(/^DIFF \(auto, after [^)]+\):\s*([^\n]+)/);
let d = null;
// ★ THE BLOCK HAS TWO LINES NOW (2026-10-01): the summary, then the FULL DIFF handle. The first
// version captured across both with [\s\S]* and could not parse — and then still reported "passed",
// because an unparseable diff fell through to the default verdict. An unparseable diff is a
// FAILURE: it means the block changed shape under the checker.
try { d = JSON.parse(dm[1]); } catch (e) { console.log('  FAIL the DIFF line is not JSON: ' + String(e.message).slice(0, 70)); ok(false, 'the diff must parse'); }
if (d) {
  const vp = d.viewport || {};
  console.log('  diff bytes            : ' + raw.length);
  console.log('  viewport group bytes  : ' + JSON.stringify(vp).length);
  console.log('  moved                 : ' + vp.moved);
  console.log('  shift entries         : ' + (vp.shifts ? vp.shifts.length : '(none — still enumerating per element)'));
  if (vp.shifts) {
    for (const s of vp.shifts.slice(0, 3)) {
      console.log('    dx=' + s.dx + ' dy=' + s.dy + ' count=' + s.count + ' indices=' + (s.i ? s.i.length : 0));
    }
    // ★ THE INVARIANT IS NOW: THE BLOCK IS A SUMMARY, AND THE DETAIL IS RETRIEVABLE (2026-10-01,
    // Ali: "registered in cache and just show you specifically what changed"). The index lists left
    // the block on purpose — so the honest check is not "the indices are here", it is "the indices
    // are HERE OR IN THE CACHE, and the block tells you where".
    const handle = (raw.match(/FULL DIFF: (\S+)/) || [])[1];
    ok(!!handle, 'the block must name the FULL DIFF handle holding the rest');
    if (handle) {
      const full = await call('page_slice', { diff: handle, part: 'viewport' });
      const v = full && full.content;
      const total = v && v.shifts ? v.shifts.reduce((n, s) => n + (s.i ? s.i.length : 0), 0) : 0;
      ok(total === vp.moved,
        'the cached diff must still carry ALL ' + vp.moved + ' indices (found ' + total + ') — a summary that loses the detail is a cut, not a summary');
      const c = await call('page_slice', { diff: handle, part: 'content' });
      ok(!!(c && c.content), 'and any other part is one more call away (content was readable)');
    }
    ok(vp.shifts.every((s) => !Array.isArray(s.i)),
      'the block itself must NOT carry the index lists (that is what was 39.9 KB on x.com)');
    ok(vp.shifts.length < vp.moved,
      'distinct movements (' + vp.shifts.length + ') are fewer than the elements moved (' + vp.moved + ') — that is the collapse');
    ok(JSON.stringify(vp).length < 20000,
      'the viewport group is under 20 KB for ' + vp.moved + ' movements (was ~165 bytes EACH)');
  } else {
    ok(false, 'viewport must report shifts, not one entry per element');
  }
  // The scroll branch must be untouched: this fixture is not scrolled, so nothing should claim a scroll.
  ok(!vp.scrolled, 'a layout change must not be reported as a scroll');
  console.log('  structure count       : ' + (d.structure && d.structure.count) + ' (the toggle adds no structure)');
  console.log('  mutated               : ' + d.mutated);
}

console.log('\n' + (bad ? bad + ' CHECK(S) FAILED' : 'both checks passed'));
process.exit(bad ? 1 : 0);
