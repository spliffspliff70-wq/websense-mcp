#!/usr/bin/env node
/**
 * regions-generalize — browse a list of live URLs over raw MCP HTTP and report the `regions`
 * outline for each: lines, bytes, and the outline itself. The generalization check for any
 * change to regionTree. Drives the REAL browse tool, so it measures what a caller receives.
 *
 * Usage: node tools/regions-generalize.mjs [--keep] <url> [url...]
 */
const BASE = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const B = (s) => Buffer.byteLength(s, 'utf8');

const args = process.argv.slice(2);
const keep = args[0] === '--keep';
const urls = args.filter((a) => a.lastIndexOf('http', 0) === 0);

const rpc = async (body, sid) => {
  const r = await fetch(BASE, { method: 'POST', headers: sid ? { ...H, 'mcp-session-id': sid } : H, body: JSON.stringify(body) });
  const t = await r.text();
  return { t, sid: r.headers.get('mcp-session-id') };
};
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gen', version: '1' } } });
const sid = init.sid;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

const call = async (name, a) => {
  const r = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: a } }, sid);
  const j = parse(r.t);
  if (j.error) throw new Error(name + ': ' + JSON.stringify(j.error).slice(0, 200));
  return j.result?.content?.[0]?.text ?? '';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = [];
for (const url of urls) {
  try {
    // browse{url} navigates AND collects, but it collects whatever the page looked like at that
    // instant — on a client-rendered page that is the loading shell (measured: x.com/home came
    // back as 137 elements, "Loading…"). Wait for it to settle, then re-collect with fresh:true
    // (the schema skips the 20 s warm cache when fresh is set).
    const first = JSON.parse(await call('browse', { url }));
    const tabId = first.tabId;
    if (tabId) tabs.push(tabId);
    await sleep(14000);
    const j = JSON.parse(await call('browse', { fresh: true, tabId }));
    const reg = j.regions || '';
    console.log('\n' + '='.repeat(90));
    console.log(url + '   elements=' + (j.index && j.index.elements != null ? j.index.elements : '?') + '  lines=' + reg.split('\n').length + '  bytes=' + B(reg));
    console.log('-'.repeat(90));
    console.log(reg);
  } catch (e) {
    console.log('\n' + url + '  ERROR ' + String(e.message).slice(0, 160));
  }
}
if (!keep && tabs.length > 1) {
  for (const t of tabs.slice(1)) { try { await call('tabs', { action: 'close', tabId: t }); } catch { /* ignore */ } }
  console.log('\n[closed ' + (tabs.length - 1) + ' extra tab(s); kept ' + tabs[0] + ']');
}
