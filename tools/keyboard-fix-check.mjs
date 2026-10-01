#!/usr/bin/env node
/**
 * keyboard-fix-check — is trusted_key actually trusted, and does the BROWSER run the default action?
 *
 * The fixture's form has ONE text input and no submit button: an Enter there is implicit submission,
 * which is exactly the case the old code had to fake by calling form.requestSubmit() itself. The
 * form's submit handler cancels the navigation and counts, so the page survives while the FIRING of
 * the submit event stays the proof — an untrusted Enter fires nothing.
 *
 * This measures BOTH paths on the same page so the difference is visible rather than asserted:
 *   trusted_key  -> Input.dispatchKeyEvent  (the browser's own pipeline)
 *   dispatchEvent -> a synthetic KeyboardEvent, which is what press_key is built on
 *
 * Requires the server on :9222 and `python -m http.server 8099` in the repo root.
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
let bad = 0;
const ok = (c, m) => { if (!c) { bad++; console.log('  FAIL ' + m); } else console.log('  ok   ' + m); };
const FIX = 'http://127.0.0.1:8099/bench/click_fingerprint.html';

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kbd-check', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

let b = null;
for (let i = 0; i < 12; i++) {
  b = await call('browse', { url: FIX });
  if (b && b.tabId) break;
  console.log('  ... waiting for the extension (attempt ' + (i + 1) + ')');
  await sleep(5000);
}
const tabId = b && b.tabId;
ok(!!tabId, 'browse bound the fixture tab (' + tabId + ')');
if (!tabId) process.exit(1);
await sleep(1500);

const reset = () => call('main_world', { tabId, verify: false, func: '() => { window.__reset(); document.getElementById("fp-q").value = ""; window.__submits = 0; document.getElementById("fp-submits").textContent = "0"; return true; }' });
const readKeys = async () => {
  const r = await call('main_world', { tabId, verify: false, func: '() => ({ keys: window.__rec.filter(function(e){return e.type === "keydown";}).map(function(e){return {key: e.key, code: e.code, keyCode: e.keyCode, isTrusted: e.isTrusted};}), submits: window.__submits, value: document.getElementById("fp-q").value })' });
  return (r.results && r.results[0] && r.results[0].result) || {};
};

console.log('\n=== PATH 1: trusted_key — the browser\'s own input pipeline ===');
await reset();
const tk = await call('trusted_key', { tabId, ref: '#fp-q', text: 'hello', key: 'Enter' });
const tkInner = (tk.data && typeof tk.data === 'object') ? tk.data : tk;
console.log('  reply: ' + JSON.stringify({ success: tkInner.success, via: tkInner.via, typed: tkInner.typed, key: tkInner.key, focus: tkInner.focus, ms: tkInner.ms }));
const a = await readKeys();
console.log('  keydowns recorded: ' + JSON.stringify(a.keys));
console.log('  submits: ' + a.submits + ' | field value: ' + JSON.stringify(a.value));
ok(a.keys.length >= 5, 'every character and the Enter produced a keydown (' + a.keys.length + ')');
ok(a.keys.length > 0 && a.keys.every((k) => k.isTrusted === true), 'EVERY key event is isTrusted:true');
ok(a.keys.length > 0 && a.keys[a.keys.length - 1].key === 'Enter' && a.keys[a.keys.length - 1].keyCode === 13,
  'the Enter carries key/keyCode 13 as a real one does');
ok(a.value === 'hello', 'the typed text landed in the field (' + JSON.stringify(a.value) + ')');
ok(a.submits === 1, '★ THE BROWSER RAN THE DEFAULT ACTION: the form SUBMITTED (submits=' + a.submits + ')');

console.log('\n=== PATH 2: a dispatched KeyboardEvent — what press_key is built on ===');
await reset();
await call('main_world', {
  tabId, verify: false,
  func: '() => { var q = document.getElementById("fp-q"); q.focus(); q.value = "hello"; var o = {key:"Enter", bubbles:true, cancelable:true, composed:true}; q.dispatchEvent(new KeyboardEvent("keydown", o)); q.dispatchEvent(new KeyboardEvent("keyup", o)); return true; }',
});
await sleep(300);
const c = await readKeys();
console.log('  keydowns recorded: ' + JSON.stringify(c.keys));
console.log('  submits: ' + c.submits);
ok(c.keys.length > 0 && c.keys.every((k) => k.isTrusted === false),
  'the synthetic key events are isTrusted:FALSE — a page can tell them apart');
ok(c.submits === 0,
  'and the BROWSER ran NO default action for them: the form did NOT submit (submits=0). This is the gap trusted_key closes, and why press_key had to call form.requestSubmit() itself.');

console.log('\n' + (bad ? bad + ' CHECK(S) FAILED' : 'all checks passed'));
process.exit(bad ? 1 : 0);
