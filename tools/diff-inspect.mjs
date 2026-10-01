#!/usr/bin/env node
/**
 * diff-inspect — browse a page, do NOTHING that changes anything intentional, scroll, and dump
 * the auto-DIFF group by group so a false "mutated:true" can be read rather than guessed.
 *
 * The question this answers: a pure scroll must land in `viewport`. If it shows up in
 * `structure` or `content`, WHAT is in there and is it real?
 *
 * Usage: node tools/diff-inspect.mjs <url> [scrollTicks]
 */
const BASE = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rpc = async (b, s) => {
  const r = await fetch(BASE, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) });
  return { t: await r.text(), s: r.headers.get('mcp-session-id') };
};
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'di', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) throw new Error(name + ' ' + JSON.stringify(j.error).slice(0, 200));
  const texts = ((j.result && j.result.content) || []).map((b) => b.text || '');
  const dl = texts.find((t) => t.indexOf('DIFF (auto') === 0);
  const diff = dl ? JSON.parse(dl.slice(dl.indexOf(': ') + 2)) : null;
  let body; try { body = JSON.parse(texts[0] || ''); } catch { body = {}; }
  return { body, diff, texts };
}

const url = process.argv[2];
const ticks = Number(process.argv[3] || 3);
const b = await call('browse', { url });
const tabId = b.body.tabId;
await sleep(13000);
await call('browse', { fresh: true, tabId });

const sc = await call('scroll', { tabId, direction: 'down', amount: ticks });
const d = sc.diff || {};
console.log('url', url, ' tab', tabId);
const summarize = (label, dd) => {
  console.log('\n=== ' + label + ' ===  mutated: ' + dd.mutated + '  baselineAt->at: ' + dd.baselineAt + ' -> ' + dd.at);
  for (const g of ['structure', 'content', 'visual', 'viewport']) {
    const v = dd[g];
    if (!v) continue;
    const items = v.changed || v.added || v.removed || v;
    const n = Array.isArray(items) ? items.length : (typeof items === 'object' ? Object.keys(items).length : 0);
    console.log('  ' + g + ' (' + n + ')');
    if (g === 'viewport') { console.log('     ' + JSON.stringify(v).slice(0, 200)); continue; }
    const arr = Array.isArray(items) ? items : [];
    arr.slice(0, 6).forEach((x) => console.log('     ' + JSON.stringify(x).slice(0, 190)));
    if (n > 6) console.log('     ... +' + (n - 6) + ' more');
  }
};
summarize('scroll #1', d);
// ★ THE BASELINE IS PAGE-HELD AND STABLE BY DESIGN, so the FIRST op after a settle carries
// everything the page did during that settle. If the model is right, a second identical scroll
// with nothing happening in between must be CLEAN.
const sc2 = await call('scroll', { tabId, direction: 'down', amount: ticks });
summarize('scroll #2 (nothing happened in between)', sc2.diff || {});
await call('tabs', { action: 'close', tabId });
