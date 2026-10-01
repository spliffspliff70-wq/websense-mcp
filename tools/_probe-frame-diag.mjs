#!/usr/bin/env node
// DIAGNOSTIC probe: where does the frame click actually go?
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const OUT = 'http://127.0.0.1:8099/bench/click_fingerprint.html';
let S = null;
async function rpc(body, attempts = 4) {
  for (let att = 0; att < attempts; att++) {
    try {
      const r = await fetch(B, { method: 'POST', headers: S ? Object.assign({ 'mcp-session-id': S }, H) : H, body: JSON.stringify(body) });
      const sid = r.headers.get('mcp-session-id'); if (sid) S = sid;
      const t = await r.text();
      for (const line of t.split('\n')) { let s = line.trim(); if (s.startsWith('data:')) s = s.slice(5).trim(); if (s.startsWith('{')) { try { return JSON.parse(s); } catch (_) {} } }
      return null;
    } catch (e) {
      if (att === attempts - 1) throw e;
      console.error('  [reconnect after ' + String(e.cause ? e.cause.code : e.message) + ']');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
async function call(name, args) {
  const j = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
  if (!j) return { __error: 'no reply' };
  if (j.error) return { __error: j.error.message };
  const blocks = ((j.result && j.result.content) || []).map((x) => x.text || '');
  const first = blocks[0] || '';
  try { const o = JSON.parse(first); o.__diff = blocks.slice(1).join('\n'); return o; }
  catch (_) { return { __raw: first }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const b = await call('browse', { url: OUT });
const tabId = b.tabId;
await sleep(1500);
console.log('tabId:', tabId);

// ── ground truth read straight off the page (parent can reach same-origin child) ──
const gt = await call('main_world', { tabId, verify: false, func: `() => {
  const f = document.getElementById('fp-frame');
  const fr = f.getBoundingClientRect();
  const d = f.contentDocument;
  const br = d.querySelector('#frame-btn').getBoundingClientRect();
  const sc = d.documentElement;
  return {
    iframeRect: { left: fr.left, top: fr.top, w: fr.width, h: fr.height },
    iframeClientBox: { left: fr.left + f.clientLeft, top: fr.top + f.clientTop, w: f.clientWidth, h: f.clientHeight },
    btnRectInFrame: { left: br.left, top: br.top, w: br.width, h: br.height, cx: br.left + br.width/2, cy: br.top + br.height/2 },
    frameScroll: { x: d.defaultView.scrollX, y: d.defaultView.scrollY },
    parentScroll: { x: window.scrollX, y: window.scrollY },
    correctTopViewportCentre: { x: fr.left + br.left + br.width/2, y: fr.top + br.top + br.height/2 },
    elementAtCorrectPoint: (function(){ const el = document.elementFromPoint(fr.left + br.left + br.width/2, fr.top + br.top + br.height/2); return el ? el.tagName + '#' + el.id : null; })()
  };
}` });
console.log('GROUND TRUTH (page):', JSON.stringify(gt));

// ── what the inventory stored ──
const seen = await call('find', { tabId, query: 'frame-btn', limit: 5 });
console.log('FIND frame-btn matched=', seen.matched, ' hits=', JSON.stringify((seen.hits||[]).map(h => ({ref:h.ref||h.loc, loc:h.loc, x:h.x, y:h.y, w:h.w, h:h.h, region:h.region}))));

const hit = (seen.hits || [])[0];
const loc = hit && (hit.loc || hit.ref);
console.log('using loc:', loc);

// ── what the content-script geometry op answers for that loc ──
const geo = await call('inspect', { tabId, kind: 'geometry', ref: loc, verify: false });
console.log('GEOMETRY op reply:', JSON.stringify(geo).slice(0, 900));

// ── the raw trusted_click reply ──
const tc = await call('trusted_click', { tabId, selector: loc, verify: false });
console.log('TRUSTED_CLICK raw reply:', JSON.stringify({ success: tc.success, effect: tc.effect, error: tc.error, clicked: tc.clicked, __error: tc.__error, via: tc.via, ms: tc.ms }));
console.log('TRUSTED_CLICK full:', JSON.stringify(tc).slice(0, 1200));
await sleep(700);

// ── the page's own click count ──
const echo = await call('main_world', { tabId, verify: false, func: `() => ({ parentEcho: document.getElementById('fp-frame-echo').textContent, frameLog: document.getElementById('fp-frame').contentDocument.getElementById('frame-log').textContent, frameClicks: document.getElementById('fp-frame').contentWindow.__frameClicks() })` });
console.log('PAGE ECHO:', JSON.stringify(echo));

// ── where WOULD a click at tc.clicked have landed in the top doc? ──
if (tc.clicked) {
  const at = await call('main_world', { tabId, verify: false, func: `() => { const el = document.elementFromPoint(${tc.clicked.x}, ${tc.clicked.y}); return el ? el.tagName + (el.id ? '#'+el.id : '') : 'null'; }` });
  console.log('elementFromPoint at tool coords (' + tc.clicked.x + ',' + tc.clicked.y + ') =', JSON.stringify(at));
}
process.exit(0);
