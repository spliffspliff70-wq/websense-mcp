#!/usr/bin/env node
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
const mw = async (tabId, func, args) => { const r = await call('main_world', { tabId, verify: false, func, args }); const p = r && r.results && r.results[0] && r.results[0].result; return p !== undefined ? p : r; };

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p2', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const b = await call('browse', { url: OUT });
const tabId = b.tabId;
await sleep(1500);
console.log('tabId:', tabId, ' inner:', JSON.stringify(await mw(tabId, '() => ({ iw: window.innerWidth, ih: window.innerHeight, dpr: devicePixelRatio, vis: document.visibilityState, sy: scrollY })')));

// raw hits — full JSON so we can see rec.x/rec.y/rec.w/rec.h/vp
const seen = await call('find', { tabId, query: 'frame-btn' });
console.log('RAW HITS:', JSON.stringify(seen.hits, null, 1).slice(0, 2600));

// is the frame's button below the fold, and does the parent doc scroll when we scrollIntoView the frame child?
console.log('BEFORE scroll:', JSON.stringify(await mw(tabId, `() => {
  const f = document.getElementById('fp-frame'), d = f.contentDocument;
  const fr = f.getBoundingClientRect(), br = d.querySelector('#frame-btn').getBoundingClientRect();
  return { top: fr.top, btnTopInFrame: br.top, topCentre: fr.left+br.left+br.width/2, topCentreY: fr.top+br.top+br.height/2, parentScrollY: scrollY, frameScrollY: d.defaultView.scrollY };
}`)));
const scrolled = await mw(tabId, `() => {
  const f = document.getElementById('fp-frame'), d = f.contentDocument;
  const el = d.querySelector('#frame-btn');
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const fr = f.getBoundingClientRect(), br = el.getBoundingClientRect();
  return { called: 'scrollIntoView on the frame child, from the TOP document',
    parentScrollY: scrollY, frameScrollY: d.defaultView.scrollY,
    iframeTopAfter: fr.top, btnTopInFrame: br.top,
    newTopCentre: { x: fr.left+br.left+br.width/2, y: fr.top+br.top+br.height/2 },
    elementAtNewCentre: (function(){ const e = document.elementFromPoint(fr.left+br.left+br.width/2, fr.top+br.top+br.height/2); return e ? e.tagName+'#'+e.id : 'null (still off-screen)'; })() };
}`);
console.log('AFTER scrollIntoView (parent doc reached in via contentDocument):', JSON.stringify(scrolled, null, 1));
process.exit(0);
