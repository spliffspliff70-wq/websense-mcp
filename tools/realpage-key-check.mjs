#!/usr/bin/env node
/**
 * realpage-key-check — the flow that failed BEFORE trusted_key existed.
 *
 * Measured earlier the hard way: on en.wikipedia.org, typing into the search box and pressing Enter
 * did NOTHING. press_key delivered the key ({key:'Enter', trusted:false}) and the form did not
 * submit, because a synthetic event runs no default action; the fix at the time was to call
 * form.requestSubmit() ourselves, which is a guess about what the page wanted.
 *
 * This is the same flow through the browser's own input pipeline, with the page's OWN location.href
 * as the oracle — not the tool's report.
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

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'realpage-key', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const b = await call('browse', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
const tabId = b && b.tabId;
if (!tabId) { console.log('browse gave no tabId — is the extension connected?'); process.exit(1); }
await sleep(3000);

const before = await call('main_world', { tabId, verify: false, func: '() => location.href' });
const beforeHref = (before.results && before.results[0] && before.results[0].result) || '';
console.log('before: ' + beforeHref);

const k = await call('trusted_key', { tabId, ref: '#searchInput', text: 'World War II', key: 'Enter' });
const inner = (k.data && typeof k.data === 'object') ? k.data : k;
console.log('trusted_key -> ' + JSON.stringify({ success: inner.success, via: inner.via, typed: inner.typed, key: inner.key, focus: inner.focus, ms: inner.ms }));
console.log('tool verdict: effect=' + k.effect + (k.navigation ? ' navigation=' + JSON.stringify(k.navigation) : ''));
await sleep(2500);

const after = await call('main_world', { tabId, verify: false, func: '() => ({ href: location.href, title: document.title })' });
const r = (after.results && after.results[0] && after.results[0].result) || {};
console.log('after : ' + r.href);
console.log('title : ' + r.title);
const arrived = /World_War_II|search=/.test(String(r.href));
console.log('\n' + (arrived ? 'PASS — the page NAVIGATED: the browser ran the default action for the key'
  : 'FAIL — the page did not move (' + r.href + ')'));
process.exit(arrived ? 0 : 1);
