#!/usr/bin/env node
/**
 * ref-escape-check — decide, without shell quoting in the way, whether an escaped id ref
 * survives the transport, and whether the disabled-target guard fires once a ref RESOLVES.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const BS = String.fromCharCode(92);            // a real backslash, no escaping anywhere
const rpc = async (b, s) => { const r = await fetch(B, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) }); return { t: await r.text(), s: r.headers.get('mcp-session-id') }; };
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'esc', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __err: JSON.stringify(j.error).slice(0, 200) };
  const blocks = (j.result.content || []).map((x) => x.text || '');
  // the auto-DIFF rides as a SECOND content block, so joining them breaks JSON.parse
  try { return JSON.parse(blocks[0]); } catch { return { __raw: String(blocks[0]).slice(0, 200) }; }
}

const b = await call('browse', { url: 'https://www.bbc.com/news' });
const tabId = b.tabId;
await new Promise((r) => setTimeout(r, 12000));
await call('browse', { fresh: true, tabId });

const refs = {
  escapedId: '#' + BS + ':R35tbdm' + BS + ':',
  rawId: '#:R35tbdm:',
  attrIdEscaped: 'input[id="' + BS + ':R35tbdm' + BS + ':"]',
  attrIdPlain: 'input[id=":R35tbdm:"]',
  byDataTestid: '[data-testid="search-input-field"]',
};
for (const [label, ref] of Object.entries(refs)) {
  const r = await call('type_text', { tabId, ref, text: 'sweep' });
  const env = r && r.data ? r : r;
  const d = (env && env.data && typeof env.data === 'object') ? env.data : env;
  console.log(String(label).padEnd(15), JSON.stringify(ref).padEnd(36),
    'resolved=' + (d && d.success !== undefined ? 'yes' : 'NO'),
    'reason=' + JSON.stringify(d && d.reason), 'effect=' + JSON.stringify(r.effect));
}
await call('tabs', { action: 'close', tabId });
