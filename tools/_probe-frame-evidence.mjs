#!/usr/bin/env node
// EVIDENCE probe for the frame click: the raw trusted_click reply, the resolved box, the
// true top-viewport centre, and the page's own click count.
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
    } catch (e) { if (att === attempts - 1) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
async function call(name, args) {
  const j = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
  if (!j) return { __error: 'no reply' };
  if (j.error) return { __error: j.error.message };
  const blocks = ((j.result && j.result.content) || []).map((x) => x.text || '');
  try { const o = JSON.parse(blocks[0] || ''); o.__diff = blocks.slice(1).join('\n'); return o; } catch (_) { return { __raw: blocks[0] }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mw = async (tabId, func) => { const r = await call('main_world', { tabId, verify: false, func }); const p = r && r.results && r.results[0] && r.results[0].result; return p !== undefined ? p : r; };
const GT = `() => {
  const f = document.getElementById('fp-frame'), d = f.contentDocument;
  const fr = f.getBoundingClientRect(), b = d.querySelector('#frame-btn'), br = b.getBoundingClientRect();
  const cx = fr.left + br.left + br.width/2, cy = fr.top + br.top + br.height/2;
  const e = document.elementFromPoint(cx, cy);
  return { parentScrollY: Math.round(scrollY), frameScrollY: d.defaultView.scrollY,
    iframeTopViewport: { left: Math.round(fr.left), top: Math.round(fr.top) },
    btnInFrame: { left: Math.round(br.left), top: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) },
    TRUE_TOP_VIEWPORT_CENTRE: { x: Math.round(cx), y: Math.round(cy) },
    elementAtThatPoint: e ? e.tagName + (e.id ? '#' + e.id : '') : 'null (outside the viewport)',
    viewport: { w: innerWidth, h: innerHeight } };
}`;

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ev', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const b = await call('browse', { url: OUT });
const tabId = b.tabId;
await sleep(1500);
console.log('tabId:', tabId);

console.log('\n[1] BEFORE the click — where the button really is in TOP-viewport space:');
console.log(JSON.stringify(await mw(tabId, GT), null, 1));

const seen = await call('find', { tabId, query: 'frame-btn' });
const loc = ((seen.hits || [])[0] || {}).loc;
console.log('\n[2] find{query:"frame-btn"} matched =', seen.matched, ' -> selector:', JSON.stringify(loc));

const tc = await call('trusted_click', { tabId, selector: loc, verify: false });
console.log('\n[3] RAW trusted_click reply (the whole thing):');
console.log(JSON.stringify(tc).slice(0, 1500));
console.log('\n    resolved box:', JSON.stringify(tc.clicked && tc.clicked.box), ' click at', tc.clicked && tc.clicked.x + ',' + tc.clicked.y);
await sleep(800);

console.log('\n[4] AFTER the click — the page\'s OWN count and where it now is:');
console.log(JSON.stringify(await mw(tabId, GT), null, 1));
const echo = await mw(tabId, `() => ({ parentEcho: document.getElementById('fp-frame-echo').textContent,
  frameLog: document.getElementById('fp-frame').contentDocument.getElementById('frame-log').textContent,
  frameClicks: document.getElementById('fp-frame').contentWindow.__frameClicks() })`);
console.log('    PAGE ECHO:', JSON.stringify(echo));

// the check's own oracle, verbatim
const landed = /clicks [1-9]/.test(String(echo.parentEcho)) || (typeof echo.frameClicks === 'number' && echo.frameClicks > 0);
console.log('\n[5] check oracle (/clicks [1-9]/ or frameClicks>0) =>', landed ? 'LANDED' : 'DID NOT LAND');
process.exit(0);
