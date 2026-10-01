#!/usr/bin/env node
/**
 * frames-drag-check — the two areas I had been LISTING as "untested" instead of testing.
 *
 * Checks, each against the page's own state (not the tool's self-report):
 *   1. FRAME  — can the collector see into a same-origin iframe, and if not, is there a documented
 *               way to act inside it? The child posts back to the parent, so a click that LANDS is
 *               provable from the parent document even when the parent's tree cannot see the frame.
 *   2. DRAG   — does click{mode:"drag"} produce the real dragstart..drop triad, and is it trusted?
 *               The fixture records every drag event with isTrusted in the capture phase.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const OUT = 'http://127.0.0.1:8099/bench/click_fingerprint.html';
let S = null;
async function rpc(body) {
  const r = await fetch(B, { method: 'POST', headers: S ? Object.assign({ 'mcp-session-id': S }, H) : H, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) S = sid;
  const t = await r.text();
  for (const line of t.split('\n')) { let s = line.trim(); if (s.startsWith('data:')) s = s.slice(5).trim(); if (s.startsWith('{')) { try { return JSON.parse(s); } catch (_) {} } }
  return null;
}
async function call(name, args) {
  const j = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
  if (!j) return {};
  if (j.error) return { __error: j.error.message };
  const blocks = ((j.result && j.result.content) || []).map((x) => x.text || '');
  const first = blocks[0] || '';
  try { const o = JSON.parse(first); o.__diff = blocks.slice(1).join('\n'); return o; }
  catch (_) { return { __raw: first.slice(0, 400) }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const say = (ok, label, detail) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? ' — ' + detail : '')); if (!ok) fails++; };

// The handshake is not optional: a bare tools/call answers "Server not initialized". (I left it out
// of the first version of this file and the browse call failed exactly that way — the same mistake
// has cost takes before, which is why it is written down here.)
await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'frames-drag', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const b = await call('browse', { url: OUT });
const tabId = b.tabId;
if (!tabId) { console.log('browse failed: ' + JSON.stringify(b).slice(0, 200)); process.exit(1); }
await sleep(1500);

// ── 1. FRAME ────────────────────────────────────────────────────────────────────────────────
console.log('FRAME');
const seen = await call('find', { tabId, query: 'frame-btn', limit: 5 });
const inTree = (seen.hits || []).length > 0;
console.log('  the outer tree sees the frame\'s button: ' + (inTree ? 'YES' : 'no') + '  (matched ' + (seen.matched === undefined ? '?' : seen.matched) + ')');
const frames = await call('tabs', { tabId, action: 'frames' });
console.log('  frames: ' + JSON.stringify(frames).slice(0, 200));

// try to act inside the frame the documented way (frameId), and prove it from the parent
let frameClicked = false, how = '';
if (inTree) {
  const hit = (seen.hits || [])[0];
  const r = await call('trusted_click', { tabId, selector: hit.loc, verify: false });
  frameClicked = r.success === true && !r.__error;
  how = 'outer-tree ref ' + hit.loc;
} else {
  // no ref for a frame child exists, so the only way is a frame-scoped act: the frame's own selector
  // (action 'list_frames' answers nothing — 'frames' is the name that works; the earlier call in
  // this same file proved it by returning the list)
  const list = await call('tabs', { tabId, action: 'frames' });
  // ★ frames[0] is the MAIN frame (frameId 0, parentFrameId -1). The first version of this picked
  // frames[0] and clicked inside the top document, found nothing, and would have reported "frames
  // do not work" — a conclusion about the tool drawn from a mistake in the test.
  const kid = (list.frames || []).filter((f) => f.parentFrameId !== -1)[0];
  const fid = kid && kid.frameId;
  if (fid !== undefined) {
    const r = await call('trusted_click', { tabId, frameId: fid, selector: '#frame-btn', verify: false });
    frameClicked = r.success === true && !r.__error;
    how = 'frameId ' + fid + ' + selector #frame-btn';
  }
}
await sleep(600);
const echo = await call('main_world', { tabId, verify: false, func: '() => ({ echo: document.getElementById("fp-frame-echo").textContent, frameClicks: (function(){ try { return document.getElementById("fp-frame").contentWindow.__frameClicks(); } catch(e){ return "unreachable:" + e.name; } })() })' });
const ec = echo && echo.echo ? echo.echo : JSON.stringify(echo).slice(0, 160);
const landed = /clicks [1-9]/.test(String(ec)) || (typeof echo.frameClicks === 'number' && echo.frameClicks > 0);
say(landed, 'a click reaches a control INSIDE a same-origin iframe', 'via ' + (how || 'nothing tried') + ' | parent echo: ' + String(ec).slice(0, 90));

// ── 2. DRAG ─────────────────────────────────────────────────────────────────────────────────
console.log('DRAG');
await call('main_world', { tabId, verify: false, func: '() => { window.__drag = []; document.getElementById("fp-drag-state").textContent = "drop: none"; return 1; }' });
const d = await call('click', { tabId, mode: 'drag', fromRef: '#fp-drag-src', toRef: '#fp-drop', verify: false });
await sleep(600);
const dg = await call('main_world', { tabId, verify: false, func: '() => window.__dragDump()' });
const evts = Array.isArray(dg.__raw) ? dg.__raw : (Array.isArray(dg) ? dg : (dg && dg.result ? dg.result : []));
const types = Array.isArray(evts) ? evts.map((e) => e.type + (e.isTrusted ? '(trusted)' : '(synthetic)')) : [];
console.log('  click{mode:drag} returned: ' + JSON.stringify({ success: d.success, effect: d.effect, error: d.__error || d.error }).slice(0, 160));
console.log('  events the page saw: ' + (types.length ? types.join(' > ') : '(none)'));
const dropped = types.some((t) => t.indexOf('drop') === 0);
say(dropped, 'a drag produces a real drop event on the page', types.length ? 'sequence above' : 'no drag events at all');
say(types.length > 0 && types.every((t) => t.indexOf('(trusted)') > 0), 'those drag events are TRUSTED', types.length ? '' : 'nothing to judge');

console.log(fails === 0 ? '\nall frame/drag checks passed' : '\n' + fails + ' check(s) failed');
process.exit(fails === 0 ? 0 : 1);
