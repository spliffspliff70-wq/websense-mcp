#!/usr/bin/env node
/**
 * close-extra-tabs — leave exactly ONE tab open (standing house rule), driving the MCP server
 * over raw Streamable HTTP so it works even when the Hermes-side client registry is orphaned.
 * Usage: node tools/close-extra-tabs.mjs [--dry]
 */
const BASE = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const dry = process.argv.includes('--dry');

const rpc = async (b, s) => {
  const r = await fetch(BASE, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) });
  return { t: await r.text(), s: r.headers.get('mcp-session-id') };
};
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'closer', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
const call = async (n, a) => {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: n, arguments: a } }, S);
  const j = parse(c.t);
  if (j.error) throw new Error(n + ' -> ' + JSON.stringify(j.error).slice(0, 200));
  return j.result.content[0].text;
};

const listOf = (d) => {
  // the result is sometimes a bare array of tabs, sometimes window wrappers — handle both
  if (Array.isArray(d)) return d.flatMap((w) => (Array.isArray(w.tabs) ? w.tabs : [w]));
  if (Array.isArray(d.tabs)) return d.tabs.flatMap((w) => (Array.isArray(w.tabs) ? w.tabs : [w]));
  if (Array.isArray(d.windows)) return d.windows.flatMap((w) => w.tabs || []);
  return [];
};

const before = listOf(JSON.parse(await call('tabs', { action: 'list' })));
console.log('open before:', before.length, before.map((t) => t.id + (t.active ? '*' : '')).join(' '));
const keep = before.find((t) => t.active) || before[0];
if (!keep) { console.log('nothing to do'); process.exit(0); }
if (!dry) {
  for (const t of before) {
    if (t.id === keep.id) continue;
    try { await call('tabs', { action: 'close', tabId: t.id }); }
    catch (e) { console.log('  close failed', t.id, String(e.message).slice(0, 70)); }
  }
}
const after = listOf(JSON.parse(await call('tabs', { action: 'list' })));
console.log('open after :', after.length, '| kept', keep.id, String(keep.url || '').slice(0, 50));
