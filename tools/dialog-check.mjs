#!/usr/bin/env node
/**
 * dialog-check — does WebSense actually handle the PAGE's own alert/confirm/prompt?
 *
 * Fixture: bench/dialog_fixture.html (served from the repo root).
 * Mechanism under test: extension/dialog-hook.js shadows the three functions in the MAIN world at
 * document_start, publishes the page's dialogs to data-ws-dialogs / data-ws-dialogs-recent, and
 * resolves them via dialog{action}. confirm()/prompt() return a PROMISE that resolves with the
 * answer; alert() is recorded and auto-resolved on setTimeout(...,0).
 *
 * THE RULE THIS FILE IS BUILT ON: every assertion is read back from the PAGE'S OWN RECORD
 * (window.__obs, painted into #rec/#branch) through a main_world read. The tool's `success` field
 * is printed for the report but is NEVER what a check asserts on — otherwise the tool would be
 * grading its own homework, which is exactly the silent-wrong-outcome shape this project keeps
 * having to kill.
 *
 *   1. alert()   — click, then dialog{action:"accept"}; assert the PAGE recorded the dialog fired
 *                  (message + that alert() returned undefined).
 *   2. confirm() — ACCEPT and assert the page took the TRUE branch. Then, on a FRESH page,
 *                  DISMISS and assert it took the OTHER branch.
 *                  ★ THE DISMISS HALF IS THE DISCRIMINATING CONTROL. A check that only accepts
 *                  cannot tell "the answer reached the page" from "the page defaulted to true" —
 *                  both pass. The hook's own fallback for an unanswered confirm is TRUE (auto-answer
 *                  after AUTO_MS), so TRUE is reachable with no agent answer at all. FALSE is
 *                  reachable ONLY by an explicit dismiss reaching the page's promise. Two DIFFERENT
 *                  answers producing two DIFFERENT branches — one of which no default can produce —
 *                  is what proves the agent's choice actually reaches the page.
 *   3. prompt()  — accept with a distinctive string and assert the page received EXACTLY that text.
 *
 * Requires: the MCP server on :9222 and `python -m http.server 8099` in the repo root.
 */
const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;
const rpc = async (body) => {
  let r;
  try {
    r = await fetch(B, { method: 'POST', headers: S ? Object.assign({}, H, { 'mcp-session-id': S }) : H, body: JSON.stringify(body) });
  } catch (e) {
    // The hub can be mid-restart (ECONNREFUSED) while a concurrent edit reloads it. Return a
    // transport error as data so the caller can RETRY or report it — never crash with a raw stack.
    return JSON.stringify({ __transport: String((e && e.message) || e) });
  }
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
const ok = (cond, msg) => { if (!cond) { bad++; console.log('  FAIL ' + msg); } else console.log('  ok   ' + msg); };

const FIXTURE = 'http://127.0.0.1:8099/bench/dialog_fixture.html';
const PROMPT_TEXT = 'WEBSENSE_EXACT_7f3a';

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dialog-check', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

// The hub accepts MCP requests seconds before the EXTENSION has reconnected after a restart —
// browse then answers with no tabId. And the hub itself can be briefly ECONNREFUSED mid-restart.
// Retry both (same wait as bloat-fix-check) so the checker does not cry wolf on that race.
let b = null;
for (let attempt = 0; attempt < 24; attempt++) {
  b = await call('browse', { url: FIXTURE });
  if (b && b.tabId) break;
  const why = (b && (b.__transport || b.__error)) || 'no tabId (extension not reconnected)';
  console.log('  ... waiting for hub/extension (attempt ' + (attempt + 1) + '): ' + why);
  await sleep(5000);
}
let tabId = b && b.tabId;
ok(!!tabId, 'browse bound a tab (' + tabId + ')');
if (!tabId) { console.log('browse failed: ' + JSON.stringify(b).slice(0, 200)); process.exit(1); }
await sleep(1500);

// main_world answers with a per-frame envelope {success, results:[{frameId, result, error}]}.
// Read the page's OWN ledger and return it, unwrapped. If the shape ever changes, __bad is set so a
// check fails loudly instead of a missing field silently reading as "passed".
async function readPage() {
  const r = await call('main_world', { tabId, verify: false, func: '() => (window.__obsDump ? window.__obsDump() : null)' });
  const env = r && Array.isArray(r.results) && r.results[0] ? r.results[0].result : null;
  return (env && env.obs) ? env : { __bad: r };
}
// A fresh DOCUMENT for the dismiss control: reload the same tab with a new query so window.__obs
// resets. `navigate` reuses the bound tab (no tab debris), unlike a second browse.
async function freshPage() {
  const n = await call('navigate', { url: FIXTURE + '?case=' + Date.now(), tabId });
  if (n && n.tabId) tabId = n.tabId;
  await sleep(1500);
  return n;
}
const ret = (p, kind) => (p.obs.returns || []).filter((x) => x.kind === kind).pop() || null;

// ── CHECK 1 — alert() ───────────────────────────────────────────────────────────────────────
console.log('\nCHECK 1 — alert() is captured and the page records it fired');
await call('trusted_click', { tabId, selector: '#btn-alert', verify: false });
const aReply = await call('dialog', { tabId, action: 'accept', verify: false });
await sleep(500);
let p = await readPage();
if (p.__bad) { ok(false, 'the page ledger was unreadable — main_world shape changed'); }
else {
  const called = (p.obs.calls || []).some((c) => /^alert\(/.test(c) && c.indexOf('ALERT_MSG_1') > -1);
  const r1 = ret(p, 'alert');
  console.log('  page recorded : ' + JSON.stringify(p.recorded).slice(0, 160));
  console.log('  dialog reply  : ' + JSON.stringify({ success: aReply.success, handled: aReply.handled, source: aReply.source, message: aReply.message, hookReply: aReply.hookReply, error: aReply.__error || aReply.error }));
  ok(called, 'the page observed alert("ALERT_MSG_1")');
  ok(!!r1, 'the page recorded the alert call returned (it did not wedge)');
  ok(!!r1 && r1.value === 'undefined', 'alert() returned undefined to the page (synchronous, non-blocking)');
}

// ── CHECK 2 — confirm(): ACCEPT on page 1, DISMISS on a fresh page 2 ────────────────────────
console.log('\nCHECK 2 — confirm(): accept and dismiss reach the page as DIFFERENT answers');
await call('trusted_click', { tabId, selector: '#btn-confirm', verify: false });
const cAcceptReply = await call('dialog', { tabId, action: 'accept', verify: false });
await sleep(500);
p = await readPage();
let acceptBranch = p.__bad ? null : (ret(p, 'confirm') || {}).branch;
let acceptValue = p.__bad ? null : (ret(p, 'confirm') || {}).value;
if (p.__bad) ok(false, 'the page ledger was unreadable after confirm-accept');
else {
  console.log('  ACCEPT page reading : ' + JSON.stringify(p.recorded).slice(0, 160));
  console.log('  ACCEPT dialog reply : ' + JSON.stringify({ success: cAcceptReply.success, handled: cAcceptReply.handled, value: cAcceptReply.value, error: cAcceptReply.__error || cAcceptReply.error }));
  ok(acceptValue === true && acceptBranch === 'TRUE', 'accept made the page take the TRUE branch (got ' + JSON.stringify(acceptValue) + ')');
}

console.log('  --- the discriminating control: a FRESH page, then DISMISS ---');
const nav = await freshPage();
if (!nav || nav.__error) console.log('  (fresh page navigation reply: ' + JSON.stringify(nav).slice(0, 140) + ')');
await call('trusted_click', { tabId, selector: '#btn-confirm', verify: false });
const cDismissReply = await call('dialog', { tabId, action: 'dismiss', verify: false });
await sleep(500);
const p2 = await readPage();
let dismissBranch = p2.__bad ? null : (ret(p2, 'confirm') || {}).branch;
let dismissValue = p2.__bad ? null : (ret(p2, 'confirm') || {}).value;
if (p2.__bad) ok(false, 'the page ledger was unreadable after confirm-dismiss');
else {
  console.log('  DISMISS page reading : ' + JSON.stringify(p2.recorded).slice(0, 160));
  console.log('  DISMISS dialog reply : ' + JSON.stringify({ success: cDismissReply.success, handled: cDismissReply.handled, value: cDismissReply.value, error: cDismissReply.__error || cDismissReply.error }));
  ok(dismissValue === false && dismissBranch === 'FALSE', 'dismiss made the page take the OTHER branch (got ' + JSON.stringify(dismissValue) + ')');
  ok(acceptBranch && dismissBranch && acceptBranch !== dismissBranch,
    '★ the two answers are GENUINELY different (' + acceptBranch + ' vs ' + dismissBranch + ') — accept/dismiss is not a constant');
  ok(acceptValue === true && dismissValue === false,
    'and the resolved VALUES differ exactly as the API requires (true vs false)');
}

// ── CHECK 3 — prompt(): the page receives EXACTLY the text passed ───────────────────────────
console.log('\nCHECK 3 — prompt(): the page receives exactly the text the agent passed');
await call('trusted_click', { tabId, selector: '#btn-prompt', verify: false });
const pReply = await call('dialog', { tabId, action: 'accept', value: PROMPT_TEXT, verify: false });
await sleep(500);
p = await readPage();
if (p.__bad) ok(false, 'the page ledger was unreadable after prompt');
else {
  const r3 = ret(p, 'prompt');
  console.log('  page recorded : ' + JSON.stringify(p.recorded).slice(0, 200));
  console.log('  page return   : ' + JSON.stringify(r3));
  console.log('  dialog reply  : ' + JSON.stringify({ success: pReply.success, handled: pReply.handled, value: pReply.value, error: pReply.__error || pReply.error }));
  ok(!!r3, 'the page recorded the prompt call returned');
  ok(!!r3 && r3.value === PROMPT_TEXT, 'the page received EXACTLY ' + JSON.stringify(PROMPT_TEXT) + ' (got ' + JSON.stringify(r3 && r3.value) + ')');
  ok(!!r3 && r3.type === 'string', 'and it arrived as a string (typeof ' + (r3 && r3.type) + ')');
}

console.log('\n' + (bad ? bad + ' CHECK(S) FAILED' : 'all dialog checks passed'));
process.exit(bad ? 1 : 0);
