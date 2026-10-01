#!/usr/bin/env node
/** crosstab-check — two tabs, one op; does it land on the right one and leave the other alone? */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'xt', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function raw(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __err: JSON.stringify(j.error).slice(0, 160) };
  const blocks = (j.result.content || []).map((x) => x.text || '');
  let json = null;
  try { json = JSON.parse(blocks[0]); } catch { json = { __raw: String(blocks[0]).slice(0, 120) }; }
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mw = async (tabId, func) => { const r = await raw('main_world', { tabId, func }); const res = r && r.results && r.results[0]; return res ? res.result : r; };

const a = await raw('browse', { url: 'https://www.wikipedia.org/' });
console.log('browse A keys :', Object.keys(a).join(','), '| tabId:', a.tabId);
const ta = a.tabId;
const b = await raw('browse', { url: 'https://news.ycombinator.com/', newTab: true });
console.log('browse B keys :', Object.keys(b).join(','), '| tabId:', b.tabId);
const tb = b.tabId;
if (!ta || !tb) { console.log('ABORT: no tabIds'); process.exit(0); }
console.log('distinct tabs :', ta !== tb, '(' + ta + ' / ' + tb + ')');
await sleep(2500);

const beforeA = await mw(ta, '() => ({ url: location.href, sel: (document.querySelector("select")||{}).value || null, txt: document.body.innerText.length })');
console.log('tab A before  :', JSON.stringify(beforeA));

const f = await raw('find', { tabId: tb, field: true, limit: 20 });
const input = (f.hits || []).find((h) => h.tag === 'input');
console.log('tab B field   :', input && input.loc);

const t = await raw('type_text', { tabId: tb, ref: input.loc, text: 'CROSSTAB' });
console.log('type effect   :', t.effect, '| success:', t.success);

const afterA = await mw(ta, '() => ({ url: location.href, sel: (document.querySelector("select")||{}).value || null, txt: document.body.innerText.length })');
const afterB = await mw(tb, '() => { var i=document.querySelector("input[type=text]"); return i ? i.value : null; }');
console.log('tab B input   :', JSON.stringify(afterB), '(want CROSSTAB)');
console.log('tab A after   :', JSON.stringify(afterA));
console.log('tab A untouched:', afterA.url === beforeA.url && afterA.sel === beforeA.sel && afterA.txt === beforeA.txt);
await raw('tabs', { action: 'close', tabId: tb });
