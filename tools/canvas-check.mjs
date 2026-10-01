#!/usr/bin/env node
/**
 * canvas-check — can WebSense click a CANVAS by COORDINATES, and does the PAGE agree?
 *
 * Fixture: bench/canvas_fixture.html (served from the repo root on :8099).
 * Tool surface under test:  click { x, y, tabId }  — no ref. In src/server.js this is the
 * `o.x != null && o.y != null` branch → hub `click_xy` → content script `nativeClickXY`,
 * which hit-tests with document.elementFromPoint(clientX, clientY) and dispatches a
 * pointer/mouse sequence. It is a PAGE OP (dispatchEvent), NOT OS input.
 *
 * WHY THIS CHECK EXISTS
 *   A tool reply of success:true has twice been a false success in this codebase. So nothing
 *   here is judged from the reply: the fixture writes down the coordinates IT received, and
 *   every verdict is read back from the page with a main_world call.
 *
 * ★ THE DISCRIMINATING CONTROL
 *   A check that can only pass is worthless. Two steps are expected to produce a DIFFERENT
 *   result and are asserted as such:
 *     CONTROL A — click 47/33 px away from the intended point. The page must record the
 *                 DISPATCHED point, so the recorded point must NOT equal the intended one,
 *                 and the check's own matcher must REJECT that record. This proves the
 *                 verifier is coordinate-sensitive rather than a rubber stamp.
 *     CONTROL B — click a plain <div> far below the canvases. No canvas click may be
 *                 recorded, and the canvas click COUNT must not move. This proves the
 *                 readout is not a canned "a click arrived" that fires on anything.
 *
 * Requires: the MCP server on :9222 and `python -m http.server 8099` in the repo root.
 * Usage: node tools/canvas-check.mjs
 */
const URL_FIXTURE = 'http://127.0.0.1:8099/bench/canvas_fixture.html';
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
// main_world answers with a per-frame envelope: { success, results:[{ frameId, result }] }
async function mw(tabId, func) {
  const r = await call('main_world', { tabId, func });
  if (r && r.__error) return { __error: r.__error };
  const res = r && r.results && r.results[0];
  return res ? res.result : r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log('  FAIL ' + msg); } else console.log('  ok   ' + msg); };
const info = (msg) => console.log('  .... ' + msg);
const TOL = 1; // px — integer client coords vs a fractional element rect
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= TOL;
// The check's own verdict for "the page recorded the point I aimed at".
const matches = (e, which, lx, ly) => !!(e && e.canvas === which && near(e.localX, lx) && near(e.localY, ly));

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'canvas-check', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

// ── bind a tab (retry: the hub accepts requests before the extension reconnects) ──
let b = null;
for (let attempt = 0; attempt < 12; attempt++) {
  b = await call('browse', { url: URL_FIXTURE });
  if (b && b.tabId) break;
  console.log('  ... waiting for the extension to reconnect (attempt ' + (attempt + 1) + ')');
  await sleep(5000);
}
const tabId = b && b.tabId;
ok(!!tabId, 'browse bound a tab (tabId=' + tabId + ')');
if (!tabId) { console.log('\nCANNOT RUN: no tab bound. Raw browse reply: ' + ((b && b.__all) || JSON.stringify(b)).slice(0, 400)); process.exit(1); }
await sleep(1200);

// ── what does the page say about itself BEFORE anything is clicked? ──
const box = await mw(tabId, '() => window.__rects()');
const st0 = await mw(tabId, '() => window.__state()');
console.log('\nPAGE-STATE READ (main_world, before any click)');
console.log('  rects: ' + JSON.stringify(box));
ok(!!(box && box.c2d && box.cgl), 'the page reports both canvas boxes (getBoundingClientRect works on a canvas)');
ok(!!(st0 && st0.last === null), 'the page has recorded NO click yet (last=null, count=0) — the readout starts empty');
info('WebGL context on #cgl: glOk=' + (st0 && st0.glOk) + (st0 && st0.glErr ? '  err=' + st0.glErr : ''));

// ── does WebSense's own inventory produce a ref/box for a canvas? (informational) ──
const slice = await call('page_slice', { tabId, tag: 'canvas', limit: 5 });
const cvs = (slice && slice.elements) || [];
info('page_slice tag=canvas returned ' + cvs.length + ' element(s): ' +
  (cvs.length ? JSON.stringify(cvs.map((e) => ({ ref: e.ref, loc: String(e.loc || '').slice(0, 60), vp: e.vp }))) : '(none)'));
info('NOTE: the canvases DO have a measurable element box; the clicks below deliberately pass NO ref, so the point is delivered as raw viewport x/y.');

// ── informational: was the bound tab the ACTIVE tab? A page op must not need that. ──
async function tabActive(tabId) {
  const r = await call('tabs', { action: 'list' });
  const t = (r && r.tabs) || (Array.isArray(r) ? r : null);
  if (!t) return null;
  const me = t.find((x) => x && x.id === tabId);
  const act = t.find((x) => x && x.active);
  return { found: !!me, mineActive: me ? !!me.active : null, activeTab: act ? { id: act.id, url: String(act.url).slice(0, 60) } : null };
}
const bg = await tabActive(tabId);
console.log('\nBACKGROUND CHECK — a coordinate click is a PAGE OP, so the tab must not need activation');
info('active tab right now: ' + JSON.stringify(bg && bg.activeTab) + '   | my bound tab ' + tabId + ': ' + JSON.stringify(bg && { found: bg.found, active: bg.mineActive }));
ok(!bg || bg.mineActive !== true,
  'the bound fixture tab was NOT the active tab while it was clicked — no tab activation, no OS focus (page op, not SendInput)');

// local (canvas-relative) points we aim at
const A2D = { lx: 61, ly: 47 };   // 2D canvas, intended point
const AG = { lx: 90, ly: 70 };   // WebGL canvas, intended point
const WRONG = { dx: 47, dy: 33 }; // CONTROL A: deliberate miss inside the canvas

const reset = async () => { await mw(tabId, '() => window.__resetFX()'); };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCHECK 1 — 2D canvas: click BY COORDINATES, no ref');
{
  await reset();
  const px = Math.round(box.c2d.left + A2D.lx);
  const py = Math.round(box.c2d.top + A2D.ly);
  info('aiming at viewport (' + px + ',' + py + ')  =  #c2d rect.left/top (' +
    box.c2d.left + ',' + box.c2d.top + ') + local (' + A2D.lx + ',' + A2D.ly + ')');
  const clk = await call('click', { tabId, x: px, y: py });
  console.log('  RAW TOOL REPLY (click): ' + String(clk.__all || JSON.stringify(clk)).slice(0, 700).replace(/\n/g, '\n    '));
  info('tool reply fields: ' + Object.keys(clk).filter((k) => k !== '__all').join(', ') +
    "  |  has an 'effect' verdict: " + ('effect' in clk));
  ok(clk.success === true, 'the tool reported success:true — recorded as the tool\'s CLAIM only, never as evidence');
  ok(clk.target === 'canvas', 'the tool\'s own hit-test named the target "' + clk.target + '" (corroboration, not proof)');
  await sleep(300);
  const st = await mw(tabId, '() => window.__state()');
  const e = st && st.last;
  console.log('  RAW PAGE READING: ' + JSON.stringify(e));
  console.log('  RAW PAGE READOUT TEXT: ' + JSON.stringify(st && st.readoutText));
  if (!e) {
    ok(false, 'the page recorded a click on #c2d at the dispatched coordinates (it recorded NOTHING)');
  } else {
    ok(matches(e, 'c2d', A2D.lx, A2D.ly),
      'the page recorded the intended point: expected local (' + A2D.lx + ',' + A2D.ly + '), page says (' + e.localX + ',' + e.localY + ')');
    ok(near(e.clientX, px) && near(e.clientY, py),
      'the event the page received carried the dispatched client coords (' + px + ',' + py + '), page says (' + e.clientX + ',' + e.clientY + ')');
    ok(e.inside === true, 'the recorded point is inside the canvas box (page-computed)');
    info('measured event provenance: isTrusted=' + e.isTrusted + ' detail=' + e.detail + ' button=' + e.button);
    info('offsetX/offsetY the BROWSER computed for this dispatched event: (' + e.offsetX + ',' + e.offsetY + ') vs local (' + e.localX + ',' + e.localY + ')');
    // MEASURED, page-side detail (not a delivery error): offsetX/offsetY are relative to the
    // canvas PADDING edge, so they exclude the 2px CSS border, while clientX-rect.left includes it.
    const bw = Math.round((e.rectW - 260) / 2);
    info('the ' + (e.localX - e.offsetX) + 'px / ' + (e.localY - e.offsetY) + 'px gap is the canvas border (' + bw + 'px CSS): offsetX/offsetY exclude it, clientX-rect.left includes it. A canvas app reading offsetX is the same ' + bw + 'px off with a REAL mouse.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCHECK 2 — WebGL canvas: click BY COORDINATES, no ref');
{
  await reset();
  const px = Math.round(box.cgl.left + AG.lx);
  const py = Math.round(box.cgl.top + AG.ly);
  info('aiming at viewport (' + px + ',' + py + ')  =  #cgl rect.left/top (' +
    box.cgl.left + ',' + box.cgl.top + ') + local (' + AG.lx + ',' + AG.ly + ')');
  const clk = await call('click', { tabId, x: px, y: py });
  console.log('  RAW TOOL REPLY (click): ' + String(clk.__all || JSON.stringify(clk)).slice(0, 700).replace(/\n/g, '\n    '));
  await sleep(300);
  const st = await mw(tabId, '() => window.__state()');
  const e = st && st.last;
  console.log('  RAW PAGE READING: ' + JSON.stringify(e));
  if (!e) {
    ok(false, 'the page recorded a click on #cgl at the dispatched coordinates (it recorded NOTHING)');
  } else {
    ok(matches(e, 'cgl', AG.lx, AG.ly),
      'the page recorded the intended point on the WebGL canvas: expected (' + AG.lx + ',' + AG.ly + '), page says (' + e.localX + ',' + e.localY + ')');
    ok(near(e.clientX, px) && near(e.clientY, py),
      'the WebGL canvas received the dispatched client coords (' + px + ',' + py + '), page says (' + e.clientX + ',' + e.clientY + ')');
    ok(e.inside === true, 'the recorded WebGL point is inside the canvas box');
    info('measured event provenance: isTrusted=' + e.isTrusted + ' detail=' + e.detail);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n★ CONTROL A — the SAME call at a DELIBERATELY WRONG offset must land DIFFERENTLY');
{
  await reset();
  const wlx = A2D.lx + WRONG.dx, wly = A2D.ly + WRONG.dy;
  const px = Math.round(box.c2d.left + wlx);
  const py = Math.round(box.c2d.top + wly);
  info('aiming at viewport (' + px + ',' + py + ') = local (' + wlx + ',' + wly + ') — ' + WRONG.dx + '/' + WRONG.dy + ' px away from the CHECK 1 point');
  const clk = await call('click', { tabId, x: px, y: py });
  console.log('  RAW TOOL REPLY (control click): ' + String(clk.__all || JSON.stringify(clk)).slice(0, 500).replace(/\n/g, '\n    '));
  await sleep(300);
  const st = await mw(tabId, '() => window.__state()');
  const e = st && st.last;
  console.log('  RAW PAGE READING: ' + JSON.stringify(e));
  if (!e) {
    ok(false, 'the control click produced a page record to compare (page recorded NOTHING)');
  } else {
    ok(e.canvas === 'c2d', 'the control click still landed on #c2d (so this is a coordinate test, not a hit-test miss)');
    ok(matches(e, 'c2d', wlx, wly),
      'the page did NOT record the CHECK 1 intended point — it recorded the WRONG offset (' + e.localX + ',' + e.localY + ') as asked');
    ok(!matches(e, 'c2d', A2D.lx, A2D.ly),
      '★★ the check\'s own matcher REJECTS this record for the CHECK 1 point — the verifier is coordinate-sensitive, not a rubber stamp');
    const d = Math.hypot(e.localX - A2D.lx, e.localY - A2D.ly);
    ok(d > 40, 'the recorded point differs from the intended one by ' + d.toFixed(1) + ' px (expected > 40)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n★ CONTROL B — a click on a non-canvas element must NOT be recorded as a canvas click');
{
  await reset();
  const tgt = await mw(tabId, '() => { var r = document.getElementById("offtarget").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }');
  const px = Math.round(tgt.left + tgt.width / 2);
  const py = Math.round(tgt.top + tgt.height / 2);
  info('aiming at viewport (' + px + ',' + py + ') — the centre of #offtarget (a plain div, below the canvases)');
  const clk = await call('click', { tabId, x: px, y: py });
  console.log('  RAW TOOL REPLY (control click): ' + String(clk.__all || JSON.stringify(clk)).slice(0, 500).replace(/\n/g, '\n    '));
  await sleep(300);
  const st = await mw(tabId, '() => window.__state()');
  console.log('  RAW PAGE READING: ' + JSON.stringify({ last: st && st.last, count: st && st.count, readout: st && st.readoutText }));
  ok(!!st && st.last === null && st.count === 0,
    'no canvas click was recorded when the click targeted a non-canvas element (last=null, count=0) — the readout is not a canned "a click arrived"');
}

console.log('\n' + (bad ? bad + ' CHECK(S) FAILED' : 'all canvas coordinate-click checks passed'));
process.exit(bad ? 1 : 0);
