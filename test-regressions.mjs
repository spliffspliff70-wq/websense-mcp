#!/usr/bin/env node
/*
 * test-regressions.mjs — verify the v2.1-latchproof hub + server fixes.
 * Run: node test-regressions.mjs
 */
import assert from 'assert';
import { execSync, execFileSync } from 'node:child_process';
import { HubServer } from './src/hub.js';
import { planAutoClimb } from './src/climb.js';
import { summarizeRead } from './src/summarize.js';
import { uploadVerdict } from './src/upload.js';
import { SessionManager } from './src/session.js';
import { diffScan, identityKey, disambiguate, fieldChanges } from './src/incr.js';
import { buildIndex, sliceSnapshot, branchChain, COLLECTOR, regionTree, PRESENTATION_ATTRS } from './src/snapshot.js';
import { DIFF_COLLECTOR } from './src/diff-collector.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('  FAIL  ' + name + ': ' + e.message);
    failed++;
  }
}

// ---- Mock WebSocket for hub message handler testing ----
function mockWs(props = {}) {
  const events = {};
  const ws = {
    cid: null,
    clientSource: null,
    isMainFrame: false,
    clientUrl: null,
    tabId: null,
    readyState: 1, // OPEN
    on: (event, handler) => { events[event] = handler; },
    send: () => { /* no-op */ },
    close: () => {},
    terminate: () => {},
    _events: events,
    _trigger: (event, data) => { if (events[event]) events[event](data); },
    ...props,
  };
  return ws;
}

console.log('WebSense v2.1 — regression tests\n');

test('pending is a Map (multi-slot)', () => {
  const hub = new HubServer({ port: 0 });
  assert(hub.pending instanceof Map, 'pending should be Map');
});

test('SW_REQUIRED_OPS contains upload_file + network_log', () => {
  assert(HubServer.SW_REQUIRED_OPS.has('upload_file'), 'upload_file');
  assert(HubServer.SW_REQUIRED_OPS.has('network_log'), 'network_log');
  assert(!HubServer.SW_REQUIRED_OPS.has('click'), 'click not sw-only');
});

test('selectedTabId starts null', () => {
  const hub = new HubServer({ port: 0 });
  assert.strictEqual(hub.selectedTabId, null);
});

test('stats() returns structured object (no TypeError)', () => {
  const hub = new HubServer({ port: 0 });
  const s = hub.stats();
  assert(typeof s === 'object', 'stats returns object');
  assert('connectedClients' in s, 'has connectedClients');
  assert('offscreenConnected' in s, 'has offscreenConnected');
  assert('inFlight' in s, 'has inFlight (Map-aware)');
  assert(Array.isArray(s.clients), 'has clients array');
});

//  P0#1 — tab_event activated  //

test('tab_event activated updates selectedTabId', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs();
  hub.onConnection(ws);
  ws._trigger('message', Buffer.from(JSON.stringify({
    type: 'tab_event',
    event: 'activated',
    tabId: 42,
    windowId: 123
  })));
  assert.strictEqual(hub.selectedTabId, 42, 'should update to 42 on activate');
});

test('tab_event activated follows multiple switches', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs();
  hub.onConnection(ws);
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'tab_event', event: 'activated', tabId: 1 })));
  assert.strictEqual(hub.selectedTabId, 1, 'first: 1');
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'tab_event', event: 'activated', tabId: 2 })));
  assert.strictEqual(hub.selectedTabId, 2, 'second: 2');
});

test('tab_event removed clears selectedTabId when matches', () => {
  const hub = new HubServer({ port: 0 });
  hub.selectedTabId = 42;
  const ws = mockWs();
  hub.onConnection(ws);
  ws._trigger('message', Buffer.from(JSON.stringify({
    type: 'tab_event',
    event: 'removed',
    tabId: 42
  })));
  assert.strictEqual(hub.selectedTabId, null, 'clears on closed active tab');
});

test('tab_event removed leaves selectedTabId when different tab', () => {
  const hub = new HubServer({ port: 0 });
  hub.selectedTabId = 42;
  const ws = mockWs();
  hub.onConnection(ws);
  ws._trigger('message', Buffer.from(JSON.stringify({
    type: 'tab_event',
    event: 'removed',
    tabId: 99
  })));
  assert.strictEqual(hub.selectedTabId, 42, 'unchanged when different tab closed');
});

//  P0#2 — tab_activated (CS self-report)  //

test('tab_activated (WS message) updates selectedTabId', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs();
  hub.onConnection(ws);
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'tab_activated', tabId: 77 })));
  assert.strictEqual(hub.selectedTabId, 77, 'direct tab_activated -> 77');
});

test('tab_activated via content-script WS (already registered) uses ws.tab', () => {
  const hub = new HubServer({ port: 0 });
  const cs = mockWs();
  cs.tabId = 88; // set before ready/tab_identified
  hub.onConnection(cs);
  // Simulate ready + tab_identified
  cs._trigger('message', Buffer.from(JSON.stringify({
    type: 'ready',
    source: 'content-script',
    isMainFrame: true,
    url: 'https://example.com'
  })));
  cs._trigger('message', Buffer.from(JSON.stringify({
    type: 'tab_identified',
    tabId: 88,
    isMainFrame: true
  })));
  // Content script sends tab_activated
  cs._trigger('message', Buffer.from(JSON.stringify({
    type: 'tab_activated' // no tabId — WS already has it
  })));
  assert.strictEqual(hub.selectedTabId, 88, 'CS self-report uses ws.tabId 88');
});

// P0#1 + #2 integrated: cleared-then-set  //

test('selectedTabId: clear (removed) then set (activated) integration', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs();
  hub.onConnection(ws);
  // Set via activated
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'tab_event', event: 'activated', tabId: 10 })));
  assert.strictEqual(hub.selectedTabId, 10);
  // Clear via removed
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'tab_event', event: 'removed', tabId: 10 })));
  assert.strictEqual(hub.selectedTabId, null);
  // Set via tab_activated
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'tab_activated', tabId: 20 })));
  assert.strictEqual(hub.selectedTabId, 20);
});

// P0#3 — planAutoClimb pure decision  //

test('planAutoClimb: returns climb=false when no bound tab', () => {
  const r = planAutoClimb({ bound: null, activeId: 42, geo: { success: true, screen: { x: 100, y: 200 }, visible: true } });
  assert.strictEqual(r.climb, false);
  assert(r.reason.includes('no session-bound tab'), 'reason: ' + r.reason);
});

test('planAutoClimb: returns climb=false when no active tab', () => {
  const r = planAutoClimb({ bound: 42, activeId: null, geo: { success: true, screen: { x: 100, y: 200 }, visible: true } });
  assert.strictEqual(r.climb, false);
  assert(r.reason.includes('could not resolve'), 'reason: ' + r.reason);
});

test('planAutoClimb: returns climb=false when bound != active (multi-agent guard)', () => {
  const r = planAutoClimb({ bound: 10, activeId: 20, geo: { success: true, screen: { x: 100, y: 200 }, visible: true } });
  assert.strictEqual(r.climb, false);
  assert(r.reason.includes('must be OS-active'), 'reason: ' + r.reason);
  // The refusal must be framed as an OS-INPUT requirement, not as a page-op one —
  // the old copy ("target tab not OS-active ... activate it first") read as though
  // activating the tab were a general fix for page ops, which it is not. See
  // MODEL_PROMPT.md "PAGE OPS vs OS-INPUT".
  assert(/OS-INPUT requirement/.test(r.reason), 'reason must name the class: ' + r.reason);
});

test('planAutoClimb: returns climb=false when geo fails', () => {
  const r = planAutoClimb({ bound: 42, activeId: 42, geo: { success: false, error: 'element not found' } });
  assert.strictEqual(r.climb, false);
  assert(r.reason.includes('element not found'), 'reason: ' + r.reason);
});

test('planAutoClimb: returns climb=false when element not visible', () => {
  const r = planAutoClimb({ bound: 42, activeId: 42, geo: { success: true, screen: { x: 100, y: 200 }, visible: false } });
  assert.strictEqual(r.climb, false);
  assert(r.reason.includes('not visible'), 'reason: ' + r.reason);
});

test('planAutoClimb: returns climb=true + screen coords when all conditions met', () => {
  const r = planAutoClimb({ bound: 42, activeId: 42, geo: { success: true, screen: { x: 1000, y: 500 }, visible: true } });
  assert.strictEqual(r.climb, true);
  assert.strictEqual(r.screen.x, 1000);
  assert.strictEqual(r.screen.y, 500);
  assert.strictEqual(r.reason, null);
});

// P1#2 — summarizeRead (goal-aware read budget)  //

test('summarizeRead: under threshold → passthrough (summarized:false)', () => {
  const r = summarizeRead('short text here', 'security');
  assert.strictEqual(r.summarized, false);
  assert.strictEqual(r.text, 'short text here');
});

test('summarizeRead: empty input → passthrough', () => {
  const r = summarizeRead('', 'x');
  assert.strictEqual(r.summarized, false);
  assert.strictEqual(r.text, '');
});

test('summarizeRead: over threshold with goal → keeps only relevant segments', () => {
  const segA = 'TOPIC: the quick brown fox jumps over the lazy dog while the zephyr blows';
  const segB = 'SECURITY: the login form exposes a critical security vulnerabilities flaw';
  const segC = 'random filler about muffins and coffee in the morning sun';
  const text = segA + '\n\n' + segB + '\n\n' + segC;
  const r = summarizeRead(text, 'security', { threshold: 100, keep: 100 });
  assert.strictEqual(r.summarized, true, 'should summarize');
  assert(r.text.includes('security vulnerabilities'), 'keeps the relevant segment');
  assert(!r.text.includes('muffins'), 'drops the irrelevant segment');
  assert(r.droppedSegments >= 1, 'records dropped count');
  assert.strictEqual(r.goal, 'security');
});

test('summarizeRead: over threshold WITHOUT goal → head+tail, middle dropped', () => {
  const head = 'PAGE START '.repeat(8);   // ~80 chars
  const middle = 'MIDDLE '.repeat(80);    // ~480 chars
  const tail = ' PAGE END'.repeat(8);     // ~80 chars
  const text = head + middle + tail;
  const r = summarizeRead(text, null, { threshold: 100, keep: 120 });
  assert.strictEqual(r.summarized, true);
  assert(r.text.includes('PAGE START'), 'keeps head');
  assert(r.text.includes('PAGE END'), 'keeps tail');
  assert(!r.text.includes('MIDDLE MIDDLE MIDDLE MIDDLE MIDDLE MIDDLE'), 'drops middle bulk');
  assert(r.text.includes('auto-summarized'), 'marks the drop');
});

test('summarizeRead: totalChars/keptChars accounting', () => {
  const segA = 'alpha '.repeat(20); // 120 chars
  const segB = 'beta '.repeat(20);  // 100 chars
  const text = segA + '\n\n' + segB;
  const r = summarizeRead(text, 'beta', { threshold: 50, keep: 80 });
  assert.strictEqual(r.totalChars, text.length);
  assert(r.keptChars > 0 && r.keptChars <= r.totalChars, 'keptChars in range');
});

// P1#1 — page_event ring buffer  //

test('hub: page_event pushes to eventRing', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs();
  hub.onConnection(ws);
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'page_event', event: 'dialog_open', data: { type: 'alert', message: 'hello' }, ts: 1234 })));
  assert.strictEqual(hub.eventRing.length, 1);
  assert.strictEqual(hub.eventRing[0].event, 'dialog_open');
  assert.strictEqual(hub.eventRing[0].data.message, 'hello');
  assert.strictEqual(hub.eventRing[0].ts, 1234);
});

test('hub: page_event ring caps at max', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs();
  hub.onConnection(ws);
  for (let i = 0; i < hub.eventRingMax + 10; i++) {
    ws._trigger('message', Buffer.from(JSON.stringify({ type: 'page_event', event: 'nav' + i, ts: i })));
  }
  assert.strictEqual(hub.eventRing.length, hub.eventRingMax, 'ring capped');
  // newest kept, oldest dropped
  assert(hub.eventRing.some((e) => e.event === 'nav' + (hub.eventRingMax + 9)), 'keeps newest');
  assert(!hub.eventRing.some((e) => e.event === 'nav0'), 'drops oldest');
});

test('hub: stats().eventRing is exposed for wait{event:…}', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs();
  hub.onConnection(ws);
  ws._trigger('message', Buffer.from(JSON.stringify({ type: 'page_event', event: 'navigation', data: { url: 'https://x' }, ts: 1 })));
  const s = hub.stats();
  assert(Array.isArray(s.eventRing), 'stats exposes eventRing');
  assert.strictEqual(s.eventRing.length, 1);
});

// P2 — upload_file verdict truth  //

test('uploadVerdict: shown=true → preview-visible', () => {
  const r = uploadVerdict(true);
  assert.strictEqual(r.confirmed, 'preview-visible');
  assert(r.note.includes('shows the filename'), 'note: ' + r.note);
});

test('uploadVerdict: shown=false → unconfirmed', () => {
  const r = uploadVerdict(false);
  assert.strictEqual(r.confirmed, 'unconfirmed');
  assert(r.note.includes('verify visually'), 'note: ' + r.note);
});

// P2 — session task-stack  //

test('task-stack: beginTask creates task with steps, currentStep=0', () => {
  const s = new SessionManager();
  s.beginTask('login and test', ['open site', 'log in', 'test', 'submit']);
  const t = s.getTask();
  assert.strictEqual(t.goal, 'login and test');
  assert.strictEqual(t.progress.total, 4);
  assert.strictEqual(t.progress.done, 0);
  assert.strictEqual(t.nextAction, 'open site');
  assert.strictEqual(t.completed, false);
});

test('task-stack: completeStep marks done and advances to next', () => {
  const s = new SessionManager();
  s.beginTask('test', ['a', 'b', 'c']);
  s.completeStep(); // 'a' done, now on 'b'
  const t = s.getTask();
  assert.strictEqual(t.progress.done, 1);
  assert.strictEqual(t.nextAction, 'b');
});

test('task-stack: completeStep all marks task completed', () => {
  const s = new SessionManager();
  s.beginTask('done', ['a', 'b']);
  s.completeStep('a');
  s.completeStep('b');
  const t = s.getTask();
  assert.strictEqual(t.progress.done, 2);
  assert.strictEqual(t.completed, true);
  assert.ok(t.completedAt, 'has completedAt timestamp');
});

test('task-stack: skipStep skips current step', () => {
  const s = new SessionManager();
  s.beginTask('test', ['a', 'b', 'c']);
  s.skipStep('a');
  const t = s.getTask();
  assert.strictEqual(t.progress.skipped, 1);
  assert.strictEqual(t.nextAction, 'b');
});

test('task-stack: reset clears task', () => {
  const s = new SessionManager();
  s.beginTask('x', ['a']);
  s.reset();
  assert.strictEqual(s.getTask(), null);
});

test('task-stack: completeStep by label matches case-insensitively', () => {
  const s = new SessionManager();
  s.beginTask('t', ['Open Site', 'Login']);
  s.completeStep('open site'); // case-insensitive
  const t = s.getTask();
  assert.strictEqual(t.progress.done, 1);
  assert.strictEqual(t.nextAction, 'Login');
});

// ═══════════════════════════════════════════════════════════════════════
// P1 INCREMENTAL EXPLORE (2026-08-31) — canonical diff semantics in
// src/incr.js. The content script mirrors these inline; these tests pin
// the canonical behavior both copies must honor.
// ═══════════════════════════════════════════════════════════════════════
function scanEntry(fp, fpo, ref, label, action) {
  return { fp, fpo, ref, label, action: action || { ref, label, type: fpo.type, subtype: fpo.subtype } };
}

test('incr: no baseline → everything added, escalate=true above threshold', () => {
  const curr = new Map();
  for (let i = 0; i < 30; i++) curr.set('k' + i, scanEntry('fp' + i, {}, 'E' + i, 'L' + i));
  const d = diffScan(null, curr);
  assert.strictEqual(d.added.length, 30);
  assert.strictEqual(d.escalate, true); // 30 > escalateMin(20), ratio=1 > 0.6
  assert.strictEqual(d.changedRatio, 1);
});

test('incr: no baseline on tiny page → escalate=false (delta returned as-is)', () => {
  const curr = new Map([['k1', scanEntry('a', {}, 'E0', 'One')]]);
  const d = diffScan(null, curr);
  assert.strictEqual(d.added.length, 1);
  assert.strictEqual(d.escalate, false);
});

test('incr: same key same fp → unchanged', () => {
  const prev = new Map([['k1', scanEntry('fp', { value: 'x' }, 'E0', 'One')]]);
  const curr = new Map([['k1', scanEntry('fp', { value: 'x' }, 'E0', 'One')]]);
  const d = diffScan(prev, curr);
  assert.strictEqual(d.unchangedCount, 1);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.changed.length, 0);
  assert.strictEqual(d.removed.length, 0);
  assert.strictEqual(d.escalate, false);
});

test('incr: same key different fp → changed with per-field changes', () => {
  const prev = new Map([['k1', scanEntry('fp-old', { value: 'x', checked: false }, 'E0', 'One')]]);
  const curr = new Map([['k1', scanEntry('fp-new', { value: 'y', checked: true }, 'E0', 'One')]]);
  const d = diffScan(prev, curr);
  assert.strictEqual(d.changed.length, 1);
  assert.strictEqual(d.changed[0].action.ref, 'E0');
  const fields = d.changed[0].changes.map((c) => c.field).sort();
  assert.deepStrictEqual(fields, ['checked', 'value']);
  const val = d.changed[0].changes.find((c) => c.field === 'value');
  assert.strictEqual(val.from, 'x');
  assert.strictEqual(val.to, 'y');
});

test('incr: key gone from curr → removed with ref+label', () => {
  const prev = new Map([['k1', scanEntry('fp', {}, 'E7', 'Gone')]]);
  const curr = new Map([['k2', scanEntry('fp2', {}, 'E8', 'New')]]);
  const d = diffScan(prev, curr);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].key, 'k1');
  assert.strictEqual(d.removed[0].ref, 'E7');
  assert.strictEqual(d.removed[0].label, 'Gone');
  assert.strictEqual(d.added.length, 1);
});

test('incr: heavy churn (>60% of >20 tracked) → escalate=true', () => {
  const prev = new Map(), curr = new Map();
  for (let i = 0; i < 25; i++) prev.set('old' + i, scanEntry('f' + i, {}, 'E' + i, 'O' + i));
  for (let i = 0; i < 25; i++) curr.set('new' + i, scanEntry('g' + i, {}, 'E' + i, 'N' + i));
  const d = diffScan(prev, curr);
  assert.strictEqual(d.added.length, 25);
  assert.strictEqual(d.removed.length, 25);
  assert.strictEqual(d.escalate, true);
});

test('incr: identityKey priority testid > id > name > aria > ph > pos', () => {
  assert.strictEqual(identityKey({ tag: 'button', testid: 'sb', id: 'x', name: 'n' }), 'tid:sb');
  assert.strictEqual(identityKey({ tag: 'button', id: 'x', name: 'n' }), 'id:x');
  assert.strictEqual(identityKey({ tag: 'input', name: 'email', type: 'text' }), 'name:input:email:text');
  assert.strictEqual(identityKey({ tag: 'button', ariaLabel: 'Close dialog' }), 'aria:Close dialog');
  assert.strictEqual(identityKey({ tag: 'input', placeholder: 'Search…' }), 'ph:Search…');
  assert.strictEqual(identityKey({ tag: 'div', label: 'Buy now' }), 'pos:div:Buy now');
});

test('incr: disambiguate appends :k<n> to duplicate keys in DOM order', () => {
  const m = disambiguate([['pos:button:X', { n: 1 }], ['pos:button:X', { n: 2 }], ['pos:div:Y', { n: 3 }]]);
  assert.deepStrictEqual([...m.keys()], ['pos:button:X', 'pos:button:X:k1', 'pos:div:Y']);
});

test('incr: fieldChanges truncates long values to 40 chars', () => {
  const long = 'x'.repeat(100);
  const ch = fieldChanges({ value: long }, { value: 'y' });
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].from.length, 40);
  assert.strictEqual(ch[0].to, 'y');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-11 — transport-friction fixes (see the "why it feels unreliable"
// diagnosis: the CS bridge attempted a socket that https mixed-content forbids,
// subframes held useless hub slots, and timeout errors named no hop).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { readdirSync } from 'fs';
import { build as buildCs } from './tools/build-cs.mjs';

test('timeout diag: names the op, the routed client and hop state', () => {
  const hub = new HubServer({ port: 0 });
  const ws = mockWs({ cid: 'c7', clientSource: 'offscreen' });
  const err = hub._timeoutDiag({ type: 'page_state', tabId: 12345 }, ws, 30000);
  assert(err instanceof Error, 'returns an Error');
  assert(err.message.includes('Request timeout (30s) for page_state'), 'names op + timeout');
  assert(err.message.includes('c7'), 'names the routed client id');
  assert(err.message.includes('offscreen'), 'names the client type');
  assert(err.message.includes('12345'), 'names the target tab');
  assert(err.message.includes('clients'), 'reports client census');
});

test('timeout diag: offscreen route points downstream, CS route points at binding', () => {
  const hub = new HubServer({ port: 0 });
  const off = hub._timeoutDiag({ type: 'click' }, mockWs({ clientSource: 'offscreen' }), 30000);
  assert(off.message.includes('downstream'), 'offscreen → downstream hint');
  const cs = hub._timeoutDiag({ type: 'click' }, mockWs({ clientSource: 'content-script' }), 30000);
  assert(cs.message.includes('content-script client stopped answering'), 'CS → binding hint');
});

test('timeout diag: works with no client at all', () => {
  const hub = new HubServer({ port: 0 });
  const err = hub._timeoutDiag({ type: 'read_content' }, null, 120000);
  assert(err.message.includes('120s'), 'honours the heavy-op timeout');
  assert(err.message.includes('(none)'), 'says so when no tab is targeted');
});

// Static guards on the content script. The CS can't be unit-tested in node
// (it needs a DOM), so these assert the invariants that fix the failure loop.
// If someone removes the gate, the 1006 loop comes back — fail loudly here.
const CS_SRC = readFileSync(new URL('./extension/websense-cs.js', import.meta.url), 'utf8');
const OFF_SRC = readFileSync(new URL('./extension/offscreen.js', import.meta.url), 'utf8');
const BG_SRC = readFileSync(new URL('./extension/background.js', import.meta.url), 'utf8');
const HUB_SRC = readFileSync(new URL('./src/hub.js', import.meta.url), 'utf8');
const SRV_SRC = readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
// The page-side collector is a STRING, so a syntax error inside it is invisible to
// node --check (that is exactly how a broken `rec reg = 0;` line once shipped). Import it
// so it can be compiled for real, below. (COLLECTOR is imported once, at the top.)
// ── 2026-09-11b: performance + reload-path guards ───────────────────────────
// Measured baseline these exist to prevent from returning: explore_page's DEFAULT
// call had no action cap, walked every DOM node in document order, read
// getBoundingClientRect twice and getComputedStyle once PER ELEMENT, and
// hard-stalled at the 90s hub timeout above ~5,000 elements (556 els = 0.44s,
// 2,206 = 11s, 11,006 = TIMEOUT). Separately, `extension_reload` was handled by
// the service worker only, so whenever the hub routed it to the offscreen (the
// client that is live on strict-CSP sites) it fell through a switch and did
// nothing — while still reporting reloadSent:true.

// ★ REWRITTEN 2026-10-01 (Ali: "I said remove all caps and filters and hardcoded
// values"). These two tests previously asserted the OPPOSITE — that a default action
// cap existed and that work was bounded by an elements-scanned ceiling. That policy is
// gone. The caps were never what made a scan affordable: the per-element
// getBoundingClientRect + getComputedStyle were (~5ms/element — 556 els = 0.44s,
// 2,206 = 11.0s, 11,006 = 90s timeout). Cost is now addressed PER ELEMENT (candidates
// from platform state with no style resolution; geometry only for the elements that
// pass), so an uncapped, unfiltered scan is affordable and can run to completion.

test('cs: NO CAPS — the scan is unbounded by design', () => {
  // Strip comments: the fix's own comments NAME the removed constants, so a raw
  // `includes` match passes on prose. (This trap has now bitten five times today.)
  const CS_CODE = CS_SRC.replace(/\/\/[^\n]*/g, '');
  for (const gone of ['DEFAULT_MAX_ACTIONS', 'SCAN_CEILING', 'CURSOR_SWEEP_MAX_ELEMENTS',
                      'CONTENT_MAX_CHARS', 'AUTO_COMPACT_CANDIDATES', 'INTERACTIVE_CURSORS',
                      'INTERACTIVE_SELECTOR', 'INTERACTIVE_TAGS', 'INTERACTIVE_ROLES',
                      'cursorSweepSkipped', 'candidateCeilingHit']) {
    assert(!CS_CODE.includes(gone), gone + ' must be gone — no caps, no filters, no vocabulary');
  }
  assert(/maxActions = options\.maxActions > 0 \? options\.maxActions : 0;/.test(CS_CODE),
    'maxActions must default to 0 (unbounded)');
  assert(/maxActions > 0 && actions\.length >= maxActions/.test(CS_CODE),
    'the break must be guarded, so 0 really does mean unbounded');
});

test('cs: candidates come from PLATFORM STATE, not a selector list', () => {
  assert(CS_SRC.includes('function _isCandidateNode'), 'derived candidate test present');
  assert(CS_SRC.includes('el.tabIndex >= 0'), 'focusability comes from the browser, not a tag list');
  assert(CS_SRC.includes('isContentEditable'), 'platform-editable counts');
  assert(CS_SRC.includes("n.lastIndexOf('aria-', 0) === 0"), 'any aria-* the page wrote counts');
  assert(CS_SRC.includes('_collectCursorCandidates'), 'cursor candidates come from the page own CSS');
  assert(CS_SRC.includes('styleSheets'), 'and are read from the stylesheets, not per-element style');
  assert(CS_SRC.includes('collectInteractiveCandidates'), 'collector is wired in');
  assert(CS_SRC.includes('_collectSelectorHits'), 'shadow-root-aware collection present');
});

test('cs: viewport-first ordering (not document order)', () => {
  assert(CS_SRC.includes('if (a.inVp !== b.inVp) return a.inVp ? -1 : 1;'),
    'in-viewport elements sort ahead of offscreen ones');
  assert(CS_SRC.includes('geo.sort('), 'the geometry list is ordered before enrichment');
});

test('cs: each element geometry read at most once (no double getBoundingClientRect)', () => {
  assert(CS_SRC.includes('isInteractive(el, pre)'), 'isInteractive accepts precomputed visibility');
  assert(CS_SRC.includes('if (pre && pre.vis !== undefined)'), 'and uses it instead of re-reading');
  assert(CS_SRC.includes('_isVisibleRect'), 'visibility has a rect-aware fast path');
  assert(CS_SRC.includes('checkVisibility'), 'uses native checkVisibility when available');
});

test('cs: style cache is cleared per extraction (stale-style regression)', () => {
  assert(/let _styleCache = new WeakMap\(\);/.test(CS_SRC),
    '_styleCache must be reassignable so it can be cleared');
  assert(CS_SRC.includes('function _styleCacheClear()'), 'clear helper exists');
  assert(CS_SRC.includes('_styleCacheClear();'), 'and is actually called by the extraction');
});

test('cs: settle is skipped when the DOM has been quiet', () => {
  assert(CS_SRC.includes('SETTLE_SKIP_IF_QUIET_MS'), 'quiet threshold defined');
  assert(CS_SRC.includes('sinceMutation < SETTLE_SKIP_IF_QUIET_MS'), 'settle is conditional');
  assert(CS_SRC.includes('_lastMutationTs'), 'mutation timestamp is tracked');
});

test('cs: unchanged-DOM reuse is versioned and TTL-bounded', () => {
  assert(CS_SRC.includes('ensureDomObserver'), 'observer is installed');
  assert(CS_SRC.includes('_domVersion'), 'DOM version counter exists');
  assert(CS_SRC.includes('SAG_CACHE_TTL_MS'), 'cache has a TTL backstop');
  assert(CS_SRC.includes('options.fresh'), 'callers can force a real scan');
  // Our own ref attribute writes must not count as page mutations, or the cache
  // invalidates itself on every extraction.
  assert(!/attributeFilter:[^\]]*webref/i.test(CS_SRC), 'ref attribute is not in the filter');
});

test('reload: extension_reload is handled by EVERY client the hub can route to', () => {
  assert(OFF_SRC.includes("case 'extension_reload'"), 'offscreen handles it (the live client on CSP sites)');
  assert(OFF_SRC.includes('chrome.runtime.reload()'), 'offscreen can perform the reload itself');
  assert(CS_SRC.includes("case 'extension_reload'"), 'content script handles it');
  assert(BG_SRC.includes("case 'extension_reload'"), 'service worker still handles it');
  assert(HUB_SRC.includes("cmd.type === 'extension_reload'"), 'hub routes it explicitly');
  assert(HUB_SRC.includes('if (cmd && cmd.type === \'extension_reload\')'),
    'routing happens before the generic page-op branch that used to swallow it');
});

test('navigate: waits for the navigation to COMMIT', () => {
  assert(BG_SRC.includes('function waitForTabCommit'), 'commit waiter exists');
  assert(BG_SRC.includes('chrome.tabs.onUpdated.addListener(onUpd)'), 'listens for the complete event');
  assert(BG_SRC.includes('await waitForTabCommit('), 'navigate actually awaits it');
  assert(BG_SRC.includes('committed: !!commit.ok'), 'result reports whether it committed');
  assert(BG_SRC.includes('result.timeout = true'),
    'and says so when it did not, instead of implying success');
});

test('server: new exploration knobs are reachable from the MCP tool', () => {
  for (const k of ['contentMaxLen', 'fresh', 'settle']) {
    assert(SRV_SRC.includes(k), `explore_page exposes ${k}`);
  }
  assert(SRV_SRC.includes('maxActions: o.maxActions'), 'maxActions is forwarded (was dropped)');
});

test('cs: direct bridge is main-frame-only (ad frames + subframes excluded)', () => {
  assert(CS_SRC.includes('WS_BRIDGE_UNUSABLE'), 'gate variable exists');
  assert(CS_SRC.includes('WS_IS_MAIN_FRAME'), 'main-frame check present');
  assert(/var WS_BRIDGE_UNUSABLE = WS_IS_AD_FRAME \|\| !WS_IS_MAIN_FRAME;/.test(CS_SRC),
    'gate is exactly ad-frame OR subframe');
  assert(/if \(WS_BRIDGE_UNUSABLE\) return;/.test(CS_SRC), 'wsConnect bails when unusable');
});

test('cs: bridge is deliberately NOT gated on https protocol', () => {
  // Regression guard for a real correction: an earlier draft assumed Chrome's
  // mixed-content rule blocks ws:// from every https page. Live measurement
  // disproved it (content scripts DID connect as MAIN on https hackerone tabs);
  // what blocks the socket is the SITE's CSP connect-src (x.com), which a
  // content script cannot know in advance. That case must stay handled by
  // backoff+give-up, never by a protocol guess that would disable working sites.
  assert(!/WS_BRIDGE_UNUSABLE[\s\S]{0,160}location\.protocol/.test(CS_SRC),
    'WS_BRIDGE_UNUSABLE must not consult location.protocol');
});

test('cs: reconnect backs off exponentially and gives up (no flat 3s forever)', () => {
  assert(CS_SRC.includes('WS_MAX_FAIL_STREAK'), 'give-up streak exists');
  assert(CS_SRC.includes('wsFailStreak++'), 'failures are counted');
  assert(/Math\.pow\(2,/.test(CS_SRC), 'exponential factor present');
  assert(CS_SRC.includes('WS_BACKOFF_MAX_MS'), 'backoff ceiling present');
  const flat = /setTimeout\(function \(\) \{ wsReconnectTimer = null; wsConnect\(\); \}, 3000\)/;
  assert(!flat.test(CS_SRC), 'flat-3s reconnect is gone');
});

test('cs: a real state change can recover after give-up', () => {
  assert(CS_SRC.includes('wsResetAndRetry'), 'reset+retry helper exists');
  assert(/wsResetAndRetry\(\);/.test(CS_SRC), 'it is actually called (visibility handler)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-11b — cost attribution + single-DOM-query invariants
// ─────────────────────────────────────────────────────────────────────────────

test('cs: _collectSelectorHits tests candidates by PLATFORM STATE (no selector list)', () => {
  // Rewritten 2026-10-01. This test used to forbid a `*` walk in here, because the walk
  // was needed only to COUNT elements and a selector list could find candidates without
  // it. The selector list is gone (it was a declared vocabulary that missed unnamed
  // controls), so the walk IS the mechanism now — and it is affordable because
  // _isCandidateNode does cheap property reads and never resolves style or geometry.
  const m = CS_SRC.match(/function _collectSelectorHits\([\s\S]*?\n  \}/);
  assert(m, '_collectSelectorHits exists');
  assert(m[0].includes("querySelectorAll('*')"), 'it walks the subtree');
  assert(m[0].includes('_isCandidateNode'), 'and keeps only elements the platform calls candidates');
  assert(!m[0].includes('getComputedStyle'), 'with no style resolution per element');
  assert(!m[0].includes('getBoundingClientRect'), 'and no geometry per element');
});

test('cs: shadow-host recursion still exists via _collectShadowHits (nested shadow roots)', () => {
  assert(CS_SRC.includes('function _collectShadowHits('), '_collectShadowHits declared');
  const m = CS_SRC.match(/function _collectShadowHits\([\s\S]*?\n  \}/);
  assert(m && m[0].includes("querySelectorAll('*')"), 'shadow walker still finds nested hosts');
  assert(m[0].includes('_collectShadowHits(all[j].shadowRoot') ||
         m[0].includes('_collectShadowHits(') , 'recurses into nested shadow roots');
  assert(CS_SRC.includes('_collectShadowHits(all[i].shadowRoot'),
    'document-level host discovery calls the shadow walker');
});

test('cs: explore cost is attributed (candidates/geometry/action split)', () => {
  assert(CS_SRC.includes('sag.candidatesMs ='), 'candidatesMs reported');
  assert(CS_SRC.includes('sag.geometryMs ='), 'geometryMs reported');
  assert(CS_SRC.includes('sag.actionMs ='), 'actionMs reported');
  assert(CS_SRC.includes('sag.scanMs = tAct - scanStart'), 'scanMs is the true total');
});

test('cs: the action loop is UNBOUNDED (maxActions defaults to 0)', () => {
  // Rewritten 2026-10-01. This test used to require DEFAULT_MAX_ACTIONS in the loop.
  // The loop is now unbounded unless the caller names a limit, and the break is
  // guarded so 0 cannot mean "stop at zero".
  const m = CS_SRC.match(/const tGeo = Date\.now\(\);[\s\S]{0,500}?const actions = \[\]/);
  assert(m, 'geometry mark precedes the action loop');
  assert(!/DEFAULT_MAX_ACTIONS/.test(m[0]),
    'the action loop must not carry a default cap — maxActions 0 means unbounded');
  assert(/options\.maxActions > 0 \? options\.maxActions : 0/.test(m[0]),
    'the loop takes the caller value and defaults to 0');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-11c — modular content-script build (source of truth = extension/cs-src)
// ─────────────────────────────────────────────────────────────────────────────

test('cs-src: modular sources exist, are numbered so they sort in build order', () => {
  const files = readdirSync(new URL('./extension/cs-src/', import.meta.url))
    .filter(f => f.endsWith('.js')).sort();
  assert(files.length >= 8, `expected the content script split into 8+ parts, got ${files.length}`);
  assert(files[0].startsWith('00-'), 'first part is 00- (bridge/transport)');
  for (const f of files) {
    assert(/^\d\d-[a-z0-9-]+\.js$/.test(f), `part name follows NN-slug.js: ${f}`);
  }
  // Sorting the names must reproduce the original top-to-bottom order.
  assert(files.join(',') === files.slice().sort().join(','), 'lexical sort is the build order');
});

test('cs-src: the artifact is IN SYNC with a fresh build (hand-edits fail here)', () => {
  const built = buildCs();
  const onDisk = readFileSync(new URL('./extension/websense-cs.js', import.meta.url), 'utf8');
  assert(built === onDisk,
    'extension/websense-cs.js differs from a build of extension/cs-src/*.js — ' +
    'edit the sources and run `node tools/build-cs.mjs`');
});

test('cs-src: the built artifact carries a navigable banner per part', () => {
  const onDisk = readFileSync(new URL('./extension/websense-cs.js', import.meta.url), 'utf8');
  const files = readdirSync(new URL('./extension/cs-src/', import.meta.url))
    .filter(f => f.endsWith('.js')).sort();
  for (const f of files) {
    const src = readFileSync(new URL('./extension/cs-src/' + f, import.meta.url), 'utf8');
    // 2026-09-25: split on ANY line ending. This test split on CRLF only, so
    // in a clean LF checkout firstLine became the ENTIRE file and the
    // "artifact includes the banner" assertion could never match — one of the
    // two CI failures that went unnoticed on every push since 07:00.
    const firstLine = src.split(/\r\n|\r|\n/)[0];
    assert(firstLine.startsWith('/* '), `${f} starts with its banner`);
    assert(onDisk.includes(firstLine), `artifact includes the banner for ${f}`);
  }
  assert(onDisk.includes('(function () {') && onDisk.trimEnd().endsWith('})();'),
    'artifact is still a single IIFE (runtime shape unchanged)');
});

test('manifest: still loads ONE content script file (no runtime-scope change)', () => {
  const mf = JSON.parse(readFileSync(new URL('./extension/manifest.json', import.meta.url), 'utf8'));
  const js = mf.content_scripts[0].js;
  assert(Array.isArray(js) && js.length === 1 && js[0] === 'websense-cs.js',
    'manifest must load the single built file — multiple entries would change ' +
    'hoisting/scope semantics across files');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-30 — type_text rung 2 must not append into a partially-pasted editor
// ─────────────────────────────────────────────────────────────────────────────

test('cs: rung 2 wipes residue ONLY when this call had emptied the field', () => {
  const src = readFileSync(new URL('./extension/cs-src/60-native-actions.js', import.meta.url), 'utf8');
  const m = src.match(/RUNG 2: execCommand insertText[\s\S]*?const preInsert = readBack\(\);/);
  assert(m, 'rung 2 still declares its pre-insert read');
  const block = src.slice(src.indexOf('RUNG 2: execCommand insertText'),
                          src.indexOf("rung: 'self-heal-retype'"));
  // The discriminator is the FIELD's prior state, captured before the paste rung —
  // never the clearFirst flag. That is what makes append semantics survive.
  assert(src.includes('const baselineAtHandoff = readBack();'),
    'the baseline is measured after the clear phase, before the paste rung');
  assert(block.includes('const dirtiedByUs = preInsert.length > 0 && baselineAtHandoff.length === 0;'),
    'rung 2 wipes only residue in a field THIS CALL emptied');
  assert(block.includes('if (dirtiedByUs)') && block.includes("el.textContent = ''"),
    'the wipe is gated on that test');
  // Strip comments before asserting on CODE shape — the comment explains the
  // clearFirst case in prose, which is not the same as branching on the flag.
  const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/cf\s*!==\s*false|clearFirst/.test(codeOnly),
    'the guard does NOT branch on the clearFirst parameter — the page decides');
  // The write must come AFTER the wipe, or the guard is decorative.
  assert(block.indexOf("el.textContent = ''") < block.indexOf("execCommand('insertText'"),
    'the wipe happens BEFORE the insertText write (order is the whole fix)');
  assert(block.includes('residueDiscarded: dirtiedByUs'),
    'the attempt row records the decision, so a discarded residue is visible');
});

test('cs: an append (clearFirst:false) is judged against baseline + text', () => {
  // clearFirst:false means "build on what is there". With a non-empty baseline the
  // correct end state is baseline+text, so a verdict comparing to `expected` alone
  // would fail a perfectly good append — which is the regression the first
  // iteration of this fix would have shipped.
  const src = readFileSync(new URL('./extension/cs-src/60-native-actions.js', import.meta.url), 'utf8');
  assert(src.includes('const wantAppend = baselineAtHandoff + expected;'),
    'the expected end state for an append is baseline + text');
  assert(src.includes('mode: wantExact ? \'replace\' : \'append\''),
    'the result names which mode ran, so a caller is never guessing');
  // The doubling self-heal stays — it is still correct for the replace case.
  assert(src.includes("rung: 'self-heal-retype'") && src.includes('occurrence > 1'),
    'the doubling self-heal is retained alongside the residue guard');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-11d — hub census, tabId hardening, and extension tab-hop guards
// ─────────────────────────────────────────────────────────────────────────────

test('hub: census() reports the hub + clients and is REACHABLE with zero clients', () => {
  const hub = new HubServer({ port: 0 });
  const c = hub.census();
  assert(c && typeof c === 'object', 'census returns an object');
  assert(c.status === 'ok', 'census.status is ok');
  assert(Array.isArray(c.clients), 'census.clients is an array');
  assert(c.clients.length === 0 && c.clientsRegistered === 0, 'no clients connected on a fresh hub');
  assert(c.hub && c.hub.uptimeMs != null, 'census.hub.uptimeMs present (read-only uptime)');
  assert(typeof c.hub.uptime === 'string', 'census.hub.uptime is human-readable');
  assert(c.inFlightCount === 0 && Array.isArray(c.inFlight), 'in-flight requests are itemised');
  assert(c.contentTabs === 0, 'contentByTab registry is reported');
  assert('offscreenClient' in c && 'mainFrameClient' in c, 'routing targets are reported');
});

test('hub: census() is strictly READ-ONLY (never sends / closes / mutates)', () => {
  const m = HUB_SRC.match(/^  census\(\) \{[\s\S]*?\n  \}/m);
  assert(m, 'census() found');
  const body = m[0];
  for (const forbidden of ['.send(', '.close(', '.delete(', '.set(', 'clients.set', 'sendResponse']) {
    assert(!body.includes(forbidden), `census() must not call ${forbidden} — it is diagnostics only`);
  }
});

test('hub: /health serves the census, other paths keep the friendly one-liner', () => {
  assert(HUB_SRC.includes("path === '/health'"), '/health route exists');
  assert(HUB_SRC.includes("return reply(200, this.census())"), '/health returns census()');
  assert(HUB_SRC.includes('census_failed'), 'a census failure is reported, not thrown');
  assert(HUB_SRC.includes('_handleHttp(req, res'), 'http handler is shared by TLS + plain');
});

test('hub: activeClient() is TOTAL — no-arg callers cannot throw on tabId', () => {
  const m = HUB_SRC.match(/^  activeClient\(cmd\) \{[\s\S]*?\n  \}/m);
  assert(m, 'activeClient found');
  assert(m[0].includes('cmd = cmd || {}'),
    'activeClient normalizes cmd so a no-arg call (healthCheck) cannot throw ' +
    "the historical `Cannot read properties of undefined (reading 'tabId')`");
  // And the page-op read must stay guarded.
  assert(/\(cmd && cmd\.tabId != null\)/.test(m[0]), 'cmd.tabId read stays null-guarded');
});

test('hub: healthCheck passes an explicit cmd (no-arg shape removed)', () => {
  assert(HUB_SRC.includes("this.activeClient({ type: 'health_ping' })"),
    'healthCheck no longer calls activeClient() with no argument');
});

test('bg: sendMessage rejections are recognised and converted to a NAMED hop', () => {
  assert(BG_SRC.includes('function isNoReceivingEnd('), 'isNoReceivingEnd() exists');
  assert(BG_SRC.includes('function sendMsgError('), 'sendMsgError() exists');
  const m = BG_SRC.match(/function sendMsgError\([\s\S]*?\n\}/);
  assert(m && m[0].includes("error: 'no-receiving-end'"), 'classifies the receiving-end class');
  assert(m && m[0].includes('hop:'), 'names the hop in the error');
  assert(m && m[0].includes('hint:'), 'carries an actionable hint');
});

test('bg: every chrome.tabs.sendMessage call site cannot leak an unhandled rejection', () => {
  const lines = BG_SRC.split('\r\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('chrome.tabs.sendMessage(')) continue;
    // Look at a window: an awaited call inside try/catch, or a .catch further on.
    const win = lines.slice(Math.max(0, i - 3), i + 5).join('\n');
    const guarded = win.includes('await chrome.tabs.sendMessage') && win.includes('catch') ||
                    win.includes('.catch(');
    if (!guarded) offenders.push(i + 1);
  }
  assert(offenders.length === 0,
    `tabs.sendMessage at line(s) ${offenders.join(', ')} is not awaited-in-try/catch and has no .catch`);
});

test('bg: fast-fail guard exists, is cheap, and does NOT hard-block on tab-loading', () => {
  assert(BG_SRC.includes('async function checkContentScriptReady('), 'guard exists');
  const m = BG_SRC.match(/async function checkContentScriptReady\([\s\S]*?\n\}/);
  const body = m[0];
  assert(body.includes('chrome.tabs.get('), 'uses tabs.get (robust after SW context loss)');
  assert(!body.includes('tabs.query'), 'avoids tabs.query (throws after context invalidated)');
  assert(!body.includes('executeScript'), 'no script injection — the guard must stay cheap');
  assert(body.includes("reason: 'no-such-tab'"), 'hard-fails a closed tab');
  assert(body.includes("reason: 'restricted-url'"), 'hard-fails restricted URLs');
  // The loading case must be a WARNING, never a block: long-polling/streaming pages
  // can report status='loading' indefinitely while their content script works.
  assert(body.includes('loadingWarning'), 'loading is surfaced as a warning');
  assert(!/if \(tab && tab\.status !== 'complete'\) \{[\s\S]*?return \{ success: false/.test(body),
    'must not return a hard failure for tab-loading');
});

test('bg: tab listing exposes status (attribution for an unregistered content script)', () => {
  assert(/status: t\.status \|\| null/.test(BG_SRC), 'getAllTabs includes tab.status');
});

test('hub: a failed op PRESERVES its structured detail (no collapsing to a bare string)', () => {
  const hub = new HubServer({ port: 0 });
  // Simulate the summary-side of a settled failure response.
  let rejected = null;
  const fakePending = { timer: setTimeout(() => {}, 1000), resolve: () => {}, reject: (e) => { rejected = e; } };
  const fakeId = 'rTEST';
  hub.pending.set(fakeId, fakePending);
  hub._settlePending(fakeId, null, {
    id: fakeId, success: false,
    data: { success: false, error: 'content-script-not-ready', reason: 'restricted-url',
            hop: 'bg->chrome.tabs', tabId: 42, hint: 'navigate to an http(s) page' },
  });
  assert(rejected instanceof Error, 'rejects with an Error');
  assert(rejected.message === 'content-script-not-ready', 'message is still the error string');
  assert(rejected.detail && rejected.detail.reason === 'restricted-url', 'detail payload attached');
  assert(rejected.reason === 'restricted-url', 'top-level fields hoisted onto the error');
  assert(rejected.hop === 'bg->chrome.tabs' && rejected.tabId === 42, 'hop + tabId survive');
});

test('server: safeHandler folds hub detail back into the tool result', () => {
  const m = SRV_SRC.match(/function safeHandler\(fn\) \{[\s\S]*?\n\}/);
  assert(m, 'safeHandler found');
  assert(m[0].includes('err.detail'), 'reads the preserved detail');
  assert(m[0].includes('textResult(out)'), 'returns the augmented object');
  assert(/success: false, error: err && err\.message/.test(m[0]), 'still returns `error` for existing callers');
});


// ══════════════════════════════════════════════════════════════════════════
// 2026-09-11d — CONFIRMATION INTEGRITY · ARG GUARD · SHADOW-DOM PIERCING
// Each test pins a false claim that was observed LIVE, so it cannot come back
// quietly. Where a function is pure enough, the test runs the REAL extracted
// source instead of grepping for a string.
// ══════════════════════════════════════════════════════════════════════════
const CS_CODE = CS_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('upload: never asserts failure from the isolated-world read-back', () => {
  // Live: THREE copies of one video attached while every call reported
  // fileCount:0 "Input rejected the file" — the File is realm-local.
  assert(!CS_CODE.includes('Input rejected the file'), 'the false "rejected" claim is gone');
  assert(CS_CODE.includes('unconfirmed-realm-readback'), 'reports UNCONFIRMED instead');
  assert(CS_CODE.includes('realmReadbackUnreliable'), 'flags the read-back as unreliable');
  // REFINED 2026-09-11d: the rule is ASYMMETRIC, not "page evidence only".
  // A first cut required page-side evidence for success, which re-broke the
  // plain-input case (read-back 1, no preview -> reported failure). Correct:
  //   realmCount > 0  => attached (positive evidence)
  //   realmCount == 0 => unconfirmed, NEVER a rejection
  assert(/const attached = shown === true \|\| realmCount > 0;/.test(CS_CODE),
    'success must accept either preview evidence or a non-zero read-back');
  assert(/success: attached,/.test(CS_CODE), 'the verdict uses `attached`');
});

test('type_text: no phantom success granted by an attribute', () => {
  assert(!CS_CODE.includes('success: matches || hasValidityIssue'),
    'faceplate-validity alone can no longer grant success');
  assert(CS_CODE.includes('unconfirmed-shadow-input-text-missing'), 'downgrades to unconfirmed');
});

test('type_text: re-reads after a settle so a framework wipe is caught', () => {
  assert(CS_CODE.includes('var readBack = function(pass)'), 'readBack is pass-aware');
  assert(CS_CODE.includes('if (matches && pass < 2)'), 'a second read is scheduled on a match');
  assert(CS_CODE.includes('value-persisted-after-settle'), 'distinguishes settled persistence');
  assert(CS_CODE.includes('el.isContentEditable === true'), 'editors read rendered text, not el.value');
});

test('shadow DOM: piercing helpers exist', () => {
  assert(/function deepQueryAll\(selector, root\)/.test(CS_SRC), 'deepQueryAll defined');
  assert(/function deepQuery\(selector, root\)/.test(CS_SRC), 'deepQuery defined');
  assert(/function isInShadow\(el\)/.test(CS_SRC), 'isInShadow defined');
});

test('shadow DOM: the previously-blind paths now pierce', () => {
  const n = (CS_SRC.match(/deepQuery\(refOrSelector\)/g) || []).length;
  assert(n >= 2, 'getGeometry AND screenCenter pierce (got ' + n + ')');
  assert(CS_SRC.includes('const el = deepQuery(q.selector);'), 'evaluate_safe(single) pierces');
  assert(CS_SRC.includes('const els = deepQueryAll(q.selector);'), 'evaluate_safe(all) pierces');
  assert(CS_SRC.includes("deepQueryAll('button, a, input, textarea, select"), 'intent search pierces');
});

test('shadow DOM: deepQueryAll really walks nested shadow roots (BEHAVIOURAL)', () => {
  const src = CS_SRC.match(/function deepQueryAll\(selector, root\) \{[\s\S]*?\n  \}/);
  assert(src, 'extracted deepQueryAll from the built artifact');
  const walk = (kids) => { const out = []; for (const k of kids) { out.push(k); out.push(...walk(k.kids || [])); } return out; };
  const mk = (sels, o) => { o = o || {}; return {
    sels: new Set(sels || []), kids: o.kids || [], shadowRoot: o.shadowRoot || null,
    querySelectorAll(sel) { if (sel === '*') return walk(o.kids || []); return walk(o.kids || []).filter((k) => k.sels.has(sel)); },
  }; };
  const btn = mk(['[data-testid="post"]']);
  const innerHost = mk([], { kids: [btn] });
  const outerHost = mk([], { shadowRoot: mk([], { kids: [innerHost] }) });
  const doc = mk([], { kids: [outerHost] });
  const fn = new Function('document', src[0] + '\n  return deepQueryAll;')(doc);
  const hits = fn('[data-testid="post"]', doc);
  assert(hits.length === 1 && hits[0] === btn, 'found a control nested two shadow roots deep');
  assert(fn('[data-testid="nope"]', doc).length === 0, 'returns empty for a genuine miss');
});

test('server: requireArgs names the missing argument (BEHAVIOURAL)', () => {
  const m = SRV_SRC.match(/function requireArgs\(tool, o, spec\) \{[\s\S]*?\n\}/);
  assert(m, 'extracted requireArgs');
  const fn = new Function(m[0] + '\n  return requireArgs;')();
  let err = null;
  try { fn('form:upload', { ref: 'E1' }, { filePath: 'absolute path', ref: 'element ref' }); }
  catch (e) { err = e; }
  assert(err, 'threw when filePath was missing');
  assert(/filePath/.test(err.message), 'message names the missing parameter');
  assert(err.detail && err.detail.reason === 'missing-argument', 'detail carries the reason');
  assert(err.detail.received.indexOf('ref') !== -1, 'received lists what actually arrived');
  fn('form:upload', { ref: 'E1', filePath: '/tmp/x.mp4' }, { filePath: 'p', ref: 'r' }); // must not throw
});

test('server: form upload/select/special are guarded', () => {
  assert(SRV_SRC.includes("requireArgs('form:upload'"), 'upload guarded');
  assert(SRV_SRC.includes("requireArgs('form:select'"), 'select guarded');
  assert(SRV_SRC.includes("requireArgs('form:special'"), 'special guarded');
});

test('server: upload MIME map covers video + audio (the .mp4 gap)', () => {
  assert(/mp4:\s*'video\/mp4'/.test(SRV_SRC), 'mp4 mapped (uploads of video were impossible)');
  assert(/webm:\s*'video\/webm'/.test(SRV_SRC), 'webm mapped');
  assert(/mp3:\s*'audio\/mpeg'/.test(SRV_SRC), 'audio mapped');
});

test('server: a zero-hit intent search says so instead of looking empty', () => {
  assert(/function annotateIntentResult\(/.test(SRV_SRC), 'helper present');
  assert(SRV_SRC.includes("annotateIntentResult(await getActiveHub().send({ type: 'find_intent'"),
    'find_intent is annotated');
  assert(SRV_SRC.includes("annotateIntentResult(await getActiveHub().send({ type: 'explore_intent'"),
    'explore_intent is annotated');
});

test('server: screenshot result is normalized + reports pixel size', () => {
  assert(/function imageSize\(/.test(SRV_SRC), 'imageSize helper present');
  const m = SRV_SRC.match(/reg\(server, 'screenshot'[\s\S]*?\n  \}\);/);
  assert(m, 'screenshot tool found');
  assert(m[0].includes('imageSize(r.dataUrl)'), 'dimensions decoded from the dataURL');
  assert(m[0].includes("typeof r === 'string'"), 'a bare-string relay result is parsed');
  assert(m[0].includes('r.width = d.width'), 'width/height surfaced to the caller');
});

test('server: imageSize decodes a real PNG header (BEHAVIOURAL)', () => {
  const m = SRV_SRC.match(/function imageSize\(dataUrl\) \{[\s\S]*?\n\}/);
  assert(m, 'extracted imageSize');
  const fn = new Function('Buffer', m[0] + '\n  return imageSize;')(Buffer);
  const png = Buffer.alloc(26);
  png[0] = 0x89; png[1] = 0x50;
  png.writeUInt32BE(7, 16); png.writeUInt32BE(3, 20);
  const d = fn('data:image/png;base64,' + png.toString('base64'));
  assert(d.width === 7 && d.height === 3, 'PNG dims read: ' + JSON.stringify(d));
  assert(Object.keys(fn('data:image/png;base64,!!!')).length === 0, 'garbage yields {} not a throw');
});

test('server: extension_reload probes the hub census, not a relay message', () => {
  const m = SRV_SRC.match(/reg\(server, 'extension_reload'[\s\S]*?\n  \}\);/);
  assert(m, 'tool found');
  assert(m[0].includes('hub.census'), 'uses the read-only census');
  assert(m[0].includes("probe: lastCensus ? 'hub-census'"), 'reports which probe ran');
  assert(m[0].includes('offscreenConnected'), 'checks the offscreen specifically');
});

test('server: the real_* escalation rung now reports an effect verdict', () => {
  const m = SRV_SRC.match(/async function withEffect\(fn\) \{[\s\S]*?\n  \}/);
  assert(m, 'withEffect present');
  assert(m[0].includes('classifyEffect(res)'), 'classifies page state after the OS input');
  const wrapped = (SRV_SRC.match(/await withEffect\(\(\) => runRealInput\(/g) || []).length;
  assert(wrapped === 3, 'all three real_* tools wrapped (got ' + wrapped + ')');
  assert(m[0].includes('does NOT prove the click failed'), 'states the page_state limitation openly');
});


test('server: the session hub wrapper FORWARDS census (thin allow-list hazard)', () => {
  // getActiveHub() is a thin wrapper; anything not forwarded is invisible to every
  // handler. The first census probe silently fell back for exactly this reason.
  const m = SRV_SRC.match(/function getActiveHub\(\) \{[\s\S]*?\n\}/);
  assert(m, 'getActiveHub found');
  assert(m[0].includes('census: () => hubChrome.census()'), 'census is forwarded');
});


test('server: annotateIntentResult handles the WRAPPED envelope (BEHAVIOURAL)', () => {
  const m = SRV_SRC.match(/function annotateIntentResult\(r, kind, q\) \{[\s\S]*?\n\}/);
  assert(m, 'extracted annotateIntentResult');
  const fn = new Function(m[0] + '\n  return annotateIntentResult;')();
  // find_intent really returns this shape — annotating only the top level missed it.
  const wrapped = fn({ type: 'find_intent_result', id: 'r2', success: true, data: { success: true, query: 'full', count: 0, matches: [] } }, 'intent', 'full');
  assert(wrapped.data.matched === 0, 'zero hits marked on the wrapped payload');
  assert(/ZERO-HIT SEMANTIC SEARCH/.test(wrapped.data.note), 'note explains it is not an empty page');
  // a real hit must pass through untouched
  const hit = { type: 'find_intent_result', id: 'r3', success: true, data: { count: 4, matches: [1, 2, 3, 4] } };
  assert(fn(hit, 'intent', 'submit') === hit, 'a non-zero result is returned unchanged');
  // and the bare shape still works
  const bare = fn({ success: true, count: 0, matches: [] }, 'goal', 'login');
  assert(bare.matched === 0 && bare.note, 'bare shape also annotated');
});


test('cs: csBuild is a BUILD STAMP, not a hand-written constant', () => {
  // The old constant could not answer "is the running copy my new code?" — it
  // reported the same string while the live CS was stale.
  assert(!CS_SRC.includes('__CS_BUILD__'), 'placeholder is substituted in the artifact');
  const m = CS_SRC.match(/csBuild:'(v4\.6\.1-[0-9a-f]{8})'/);
  assert(m, 'csBuild carries a version + source-hash stamp');
});

test('cs: the build stamp is the hash of the source that produced it', async () => {
  const { build, sha } = await import('./tools/build-cs.mjs');
  const a = build();
  const stamp = a.match(/csBuild:'v4\.6\.1-([0-9a-f]{8})'/)[1];
  // Reverse the substitution: restore the placeholder, drop the banner, re-hash.
  // If the stamp did not actually cover the source, this will not match.
  const body = a.slice(a.indexOf('(function () {'));
  const pre = body.split(stamp).join('__CS_BUILD__');
  assert(sha(pre).slice(0, 8) === stamp, 'stamp == sha(source) — a source edit MUST change it');
});

// 2026-09-11d (b): shadow piercing must cover the ADDRESSING paths, not just
// geometry. type_text on a shadow-hosted input still answered "Element not
// found" because resolveRef -> document.querySelector, so the fix was
// incomplete until every resolver pierced too.
// ══════════════════════════════════════════════════════════════════════════════

test('shadow: all THREE ref resolvers pierce (attr, selector, locator chain)', () => {
  const src = CS_SRC;
  assert(/function resolveAttrRef[\s\S]{0,700}?deepQuery\(/.test(src),
    'resolveAttrRef must use deepQuery — a REF on a shadow control is otherwise unreachable');
  assert(/function resolveSelectorRef[\s\S]{0,700}?deepQuery\(/.test(src),
    'resolveSelectorRef must use deepQuery');
  assert(/function resolveLocator[\s\S]{0,1400}?deepQuery\(/.test(src),
    'resolveLocator must use deepQuery — it is the self-heal fallback');
});

test('shadow: no bare document.querySelector is left in the addressing paths', () => {
  const src = CS_SRC;
  // resolveAttrRef / resolveSelectorRef must not fall back to the light DOM.
  const attr = src.slice(src.indexOf('function resolveAttrRef'), src.indexOf('function resolveAttrRef') + 900);
  assert(!/document\.querySelector\(/.test(attr),
    'resolveAttrRef still contains a light-DOM querySelector');
  const sel = src.slice(src.indexOf('function resolveSelectorRef'), src.indexOf('function resolveSelectorRef') + 900);
  assert(!/document\.querySelector\(/.test(sel),
    'resolveSelectorRef still contains a light-DOM querySelector');
});

test('shadow: the upload file-input + drop-zone lookups pierce', () => {
  const src = CS_SRC;
  assert(/deepQueryAll\('input\[type="file"\]'\)/.test(src),
    "locateFileInput must use deepQueryAll('input[type=\"file\"]')");
  assert(/deepQueryAll\('\[data-testid\*="upload"\]/.test(src),
    'locateDropZone must use deepQueryAll');
});

test('upload: the file input is picked by PROXIMITY, never blindly all[0]', () => {
  // BUG (2026-09-21, measured on LemonSqueezy): locateFileInput's last resort
  // returned all[0], the FIRST file input on the page. On any form with an
  // image/avatar input BEFORE the document input — most storefronts and CMSes —
  // an upload silently targeted the WRONG field while still reporting
  // success:true / fileCount:1 / confirmed:"preview-visible". A .zip was
  // repeatedly attached to the product-IMAGE input.
  //
  // NOTE: scoped to locateFileInput's own body on purpose. deepQuery() also ends
  // with `all.length ? all[0] : null`, and that is CORRECT there (querySelector
  // semantics = first match), so a file-wide check would false-positive.
  const src = CS_SRC;
  const start = src.indexOf('function locateFileInput');
  assert(start !== -1, 'locateFileInput must exist');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert(/domCloseness/.test(body),
    'locateFileInput must rank candidate file inputs by DOM closeness');
  assert(/domCloseness\(startEl, all\[i\]\)/.test(body),
    'the last-resort branch must score every candidate against startEl');
  assert(!/all\[0\]\s*:\s*null/.test(body),
    "locateFileInput must not fall back to the FIRST file input on the page");
});

test('upload: locateFileInput refuses a non-Element startEl instead of guessing', () => {
  // Companion to the missing-await bug below: even with the await in place, a
  // Promise/junk startEl reaching locateFileInput would score 0 against every
  // candidate and silently settle on all[0]. Returning null makes the failure
  // honest (Strategy 2 / a clear error) instead of writing to another field.
  const src = CS_SRC;
  const start = src.indexOf('function locateFileInput');
  assert(start !== -1, 'locateFileInput must exist');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert(/startEl\.nodeType !== 1\) return null/.test(body),
    'a non-Element startEl must return null — otherwise every candidate scores 0 and all[0] wins');
});

test('upload: the upload_file case AWAITS resolveRefHealed (a Promise never reaches locateFileInput)', () => {
  // BUG (2026-09-21, measured on LemonSqueezy): `case 'upload_file'` called
  // resolveRefHealed(params.ref) WITHOUT await, so upEl was a PROMISE. A Promise
  // has no tagName / querySelector / parentElement, so locateFileInput fell past
  // every structural branch into the proximity last resort — where
  // domCloseness(promise, candidate) scores 0 for EVERY candidate, so `best`
  // never moved off all[0]. The ref was resolved, correctly, and then thrown
  // away: the file ALWAYS attached to the FIRST <input type=file> on the page.
  // Symptom: a .zip landed on LemonSqueezy's product-IMAGE input while the real
  // files input stayed empty, with the call still reporting success:true /
  // fileCount:1 / confirmed:"preview-visible".
  //
  // This is why the earlier PROXIMITY fix alone changed nothing in production:
  // proximity was correct, but it never received an element to measure against.
  const src = CS_SRC;
  // ★ 2026-10-01b: there used to be TWO 'upload_file' labels (a "requires the SW relay" stub
  // in 00 and the real handler in 70). The unification left exactly ONE — the real handler,
  // now owned by the single dispatcher (wsDispatchPage in 00). Match it directly.
  const i = src.indexOf("case 'upload_file': {");
  assert(i !== -1, "the upload_file handler case (brace form) must exist");
  // Bound the branch by the NEXT case label rather than a fixed char count: the
  // explanatory comment above the fix is long, and a fixed window silently
  // truncated before the line under test (that is how this test first failed).
  const j = src.indexOf("case '", i + 5);
  const branch = src.slice(i, j === -1 ? i + 3000 : j);
  assert(/const upEl = await resolveRefHealed\(params\.ref\)/.test(branch),
    'upload_file must AWAIT resolveRefHealed — without await the ref is a Promise and is silently ignored');
});

test('delta: inViewport is NOT in the mutation fingerprint (a scroll is not a change)', () => {
  // BUG (2026-09-21): the fp included state.inViewport, so every scroll flipped
  // the fingerprint of each element crossing the fold and the scroll was reported
  // as a page mutation (measured: changedRatio 1.038, 12 added / 40 removed).
  // inViewport is a viewport artifact, not a mutation — it stays in fpo only.
  const src = CS_SRC;
  assert(!/String\(state\.inViewport\)/.test(src),
    'state.inViewport must NOT be in the fp — a scroll would read as a page change');
  assert(/inViewport: state\.inViewport/.test(src),
    'inViewport should still be recorded in fpo for informational use');
});

test('click: an unguarded .click() never crashes a click (SVGElement has none)', () => {
  // BUG (2026-09-21, seen repeatedly as "UNHANDLED_REJECTION: targetEl.click is
  // not a function" while driving LemonSqueezy): nativeClick walks down to the
  // deepest clickable descendant, which can be an SVGElement — and .click()
  // exists only on HTMLElement. The throw happened AFTER pointerover/down/up had
  // already been dispatched, so the element was left half-clicked and the caller
  // got an unhandled rejection instead of an error.
  const src = CS_SRC;
  assert(!/^\s*targetEl\.click\(\);\s*$/m.test(src),
    'targetEl.click() must be guarded — SVGElement has no .click()');
  assert(/typeof targetEl\.click === 'function'/.test(src),
    'the click must fall back to a dispatched MouseEvent when .click() is missing');
});

test('tabs: an activation must not steal an EXPLICIT bind', () => {
  // BUG (2026-09-21): onActivated assigned boundTabId on EVERY tab switch, so it
  // silently overwrote an explicit `tabs{action:"bind"}`. Consequences measured
  // live: bind appeared to work and then resolved "ref not found" for elements
  // that demonstrably existed (the answer came from whichever tab was last
  // activated), and a navigate meant to reload one page loaded a different tab —
  // "it still loaded an x.com over lemonsqueezy I had to reopen".
  assert(/let explicitBind = false;/.test(BG_SRC), 'explicitBind must be declared');
  assert(/if \(!explicitBind\) boundTabId = activeInfo\.tabId;/.test(BG_SRC),
    'onActivated must NOT overwrite an explicitly bound tab');
  const latchSetters = (BG_SRC.match(/explicitBind = true;/g) || []).length;
  assert(latchSetters >= 2,
    `every explicit binding path must set the latch (switch_to_tab + bind_tab, found ${latchSetters})`);
  assert(/if \(tabId === boundTabId\) \{ boundTabId = null; explicitBind = false; \}/.test(BG_SRC),
    'closing the bound tab must release the latch (anti-latch, PITFALL 16)');
  assert(/tabId: boundTabId, explicit: explicitBind/.test(BG_SRC),
    'get_bound_tab must expose whether the binding was explicit');
});

test('shadow: read_selector / write_selector pierce (they feed compound ops)', () => {
  const src = CS_SRC;
  const n = (src.match(/deepQuery\(params\.selector\)/g) || []).length;
  assert(n >= 2, `expected read/write selector to use deepQuery (found ${n})`);
});

test('cs: upload confirmation is ASYMMETRIC — a 0 read-back is never a rejection', () => {
  const src = CS_SRC;
  assert(/const attached = shown === true \|\| realmCount > 0;/.test(src),
    'success must be satisfied by positive evidence (preview OR a non-zero read-back)');
  assert(!/success: realInput\.files\.length > 0/.test(src),
    'the old bare-length success test must be gone');
  assert(!CS_CODE.includes('Input rejected the file'),
    "must never assert 'Input rejected the file' from an isolated-world read-back");
  assert(/realmReadbackUnreliable: realmCount === 0/.test(src),
    'a 0 read-back must be flagged as unreliable, not treated as failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC GUARD: the stale "activation fixes page ops" folklore must not come back.
// Ali's hypothesis 2026-09-20 ("in the tools schema and or prompt instructions some old
// logic remained and is burying the blazing fast full background one") was CONFIRMED:
// three agent-facing surfaces claimed a backgrounded tab wedges the content script.
// It does not. Page ops route over tabs.sendMessage by tabId and work on an inactive
// tab — measured: bound an active:false tab, no activation, explore_page returned 29
// live matches. The real hang cause is a MINIMISED/occluded Chrome window (0x0).
// These assertions fail loudly if the folklore is reintroduced anywhere an agent reads.
test('guidance: no surface claims a backgrounded tab wedges page ops', () => {
  const MODEL = readFileSync(new URL('./MODEL_PROMPT.md', import.meta.url), 'utf8');
  const surfaces = { 'src/server.js': SRV_SRC, 'src/hub.js': HUB_SRC, 'MODEL_PROMPT.md': MODEL };
  const forbidden = [
    'cold-background-tab fix',
    'content script injects',
    'backgrounded/minimized tab',
    'or the tab was backgrounded',
    'content-script ops hang',
  ];
  for (const [name, src] of Object.entries(surfaces)) {
    for (const phrase of forbidden) {
      assert(!src.includes(phrase), `${name} still carries the stale claim: "${phrase}"`);
    }
  }
});

test('guidance: the two operation classes are actually documented', () => {
  const MODEL = readFileSync(new URL('./MODEL_PROMPT.md', import.meta.url), 'utf8');
  // The distinction must be stated where an agent reads it, in both places.
  assert(/PAGE OPS/.test(MODEL) && /OS-INPUT/.test(MODEL),
    'MODEL_PROMPT.md must state the PAGE OPS vs OS-INPUT split');
  assert(/PAGE OPS/.test(SRV_SRC) && /OS-INPUT/.test(SRV_SRC),
    'websense_guide (src/server.js) must state the split');
  // And the hang diagnosis must lead with the real cause.
  assert(/MINIMISED|MINIMIZED|minimised|minimized/.test(MODEL),
    'the hang diagnosis must name a minimised window as the leading cause');
});

test('guidance: real_activate_tab is scoped to OS-input, not page ops', () => {
  const m = SRV_SRC.match(/reg\(server, 'real_activate_tab', \{\s*\n\s*description: '([^']*(?:\\'[^']*)*)'/);
  assert(m, 'real_activate_tab description not found');
  const d = m[1];
  assert(/OS-LEVEL INPUT|OS-input|OS-INPUT/.test(d), 'must scope itself to OS-level input');
  assert(/do NOT need it for page ops|NOT need it for page ops/i.test(d), 'must explicitly deny the page-op use');
  assert(/CANNOT fix a minimised/i.test(d), 'must state it cannot restore a minimised window');
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC GUARD: "CDP" is TWO classes and only one is banned.
// Ali 2026-09-20: "cdp in that context I think should be allowed as long as it
// can't be flagged as bot by any page." -> chrome.debugger, the EXTENSION API the
// `ax` tool uses, is ALLOWED; the debug-port class stays FORBIDDEN.
// Why this guard exists: before this, every "CDP IS FORBIDDEN" surface read as an
// absolute, so a model could not tell whether the sanctioned `ax` tool was legal —
// the ban and the tool contradicted each other. Measured 2026-09-20 with `ax`
// attached: navigator.webdriver=false, no playwright/puppeteer/selenium/cdc_
// globals, window.chrome.debugger undefined in the page world, and
// Accessibility.getFullAXTree over a 2105-node tree produced zero >=50ms
// main-thread long tasks.
test('guidance: the chrome.debugger carve-out is stated, and the debug-port ban kept', () => {
  const MODEL = readFileSync(new URL('./MODEL_PROMPT.md', import.meta.url), 'utf8');
  const axDesc = SRV_SRC.match(/reg\(server, 'ax', \{\s*\n\s*description: '((?:\\'|[^'])*)'/);
  assert(axDesc, 'ax tool description not found');
  const d = axDesc[1];
  assert(/EXTENSION API/.test(d), 'ax description must say it is the extension API');
  assert(/NOT a CDP debug port/.test(d), 'ax description must deny being a CDP debug port');
  assert(/ALLOWED/.test(d), 'ax description must state that it is allowed');
  // The ban must survive, narrowed — not deleted.
  assert(/CDP debug port/.test(SRV_SRC), 'src/server.js must use the narrowed "CDP debug port" wording');
  assert(/debug port/i.test(MODEL), 'MODEL_PROMPT.md must use the narrowed "debug port" wording');
  // The carve-out must also be stated where the model reads prose, not only on the tool.
  assert(/chrome\.debugger/.test(MODEL), 'MODEL_PROMPT.md must name chrome.debugger as the allowed case');
  assert(/IS allowed|are allowed|is NOT that/i.test(MODEL), 'MODEL_PROMPT.md must state that chrome.debugger is allowed');
  // The old unqualified absolute is the regression: "NO screenshots, NO CDP, NO vision model".
  assert(!/NO CDP,/.test(MODEL), 'MODEL_PROMPT.md still carries the unqualified "NO CDP," absolute');
  // 2026-09-25: the mirrored block is now GENERATED from the live guide, whose
  // sentence is "No CDP debug port" (sentence case). The assertion used to demand
  // the exact uppercase "NO CDP debug port" string, which only the hand-maintained
  // mirror produced — i.e. the test was pinning the DRIFT, not the substance.
  // What matters is that the absolute is narrowed, in any casing.
  assert(/no cdp debug port/i.test(MODEL), 'MODEL_PROMPT.md must qualify the absolute as a "no CDP debug port" ban');
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC GUARD: essential claims must survive the WIRE, not just the file.
// Ali directive 2026-08-18 (installSchemaMinifier, src/server.js ~line 237) clips
// every tool description to DESC_CAP=110 chars on tools/list to save ~10k
// tokens/request. Consequence, discovered 2026-09-20: prose past ~110 chars
// NEVER REACHES AN AGENT. A fix written after the cut is a fix nobody sees —
// this is the same class of bug as the stale-server problem, one layer down.
// Live casualties found by dumping the real wire output: on real_activate_tab the
// "You do NOT need it for page ops" correction sat at ~char 300 and was invisible,
// so the tool still read as "makes the tab the OS-active one and gates".
test('guidance: essential claims survive the 110-char wire cap on tool descriptions', () => {
  const CAP = Number(process.env.WEBSENSE_DESC_CAP || 110);
  const mustFit = [
    ['real_activate_tab', /OS-INPUT ONLY/, /page ops NEVER need this/],
    ['tabs', /page ops NEVER need activation/],
    ['screenshot', /No debug port/],
    ['ax', /EXTENSION API/, /NOT a CDP debug port/, /ALLOWED/],
  ];
  for (const [tool, ...pats] of mustFit) {
    const m = SRV_SRC.match(new RegExp("reg\\(server, '" + tool + "', \\{\\s*\\n\\s*description: '((?:\\\\'|[^'])*)'"));
    assert(m, tool + ' description not found');
    const head = m[1].replace(/\\'/g, "'").slice(0, CAP);
    for (const p of pats) {
      assert(p.test(head),
        tool + ': the claim ' + p + ' falls AFTER the ' + CAP +
        '-char wire cut, so no agent ever reads it (move it to the front of the description)');
    }
  }
});

// ═══ ACTION DELTA — "did it land" flagged programmatically (Ali 2026-09-21) ═══
// Ali: "the dif should notify the model that a difference exists it should be flagged so
// when a paste action is done the model doesn't have to spend time and tokens to ask did
// it land it should be flagged programatically."
test('delta: the mutating input class carries the automatic DOM-diff flag', () => {
  const m = SRV_SRC.match(/const DELTA_OPS = new Set\(([^)]*)\)/);
  assert(m, 'DELTA_OPS must exist');
  for (const op of ['click', 'type_text', 'form', 'press_key', 'real_paste']) {
    assert(new RegExp("'" + op + "'").test(m[1]), op + ' must be in DELTA_OPS');
  }
  assert(/withDelta\(name, handler\)/.test(SRV_SRC),
    'reg() must wrap every handler with withDelta, or the flag is never attached');
});

test('delta: summarizeDelta unwraps the hub .data envelope (guards a real shipped bug)', () => {
  // This function shipped reading added/changed/removed off the TOP level. Hub replies are
  // wrapped {type,id,success,data:{...}}, so it reported "no baseline" on EVERY call while
  // the diff was working fine underneath. Caught by test/action-delta-test.py.
  assert(/typeof res\.data === 'object' && res\.data\) \? res\.data : res/.test(SRV_SRC),
    'summarizeDelta must unwrap .data — without it every action falsely reports no baseline');
  assert(/Array\.isArray\(d\.added\)/.test(SRV_SRC),
    'the delta test must run against the UNWRAPPED object');
});

test('delta: a caller can opt out per call, and a no-change delta is honestly scoped', () => {
  assert(/args\.verify === false/.test(SRV_SRC), 'withDelta must honour verify:false');
  assert(/verify: z\.boolean\(\)\.optional\(\)/.test(SRV_SRC),
    'mutating tools must expose a verify param so the diff can be skipped');
  // 2026-09-25: this test used to REQUIRE the phrase "NOT LANDED" — i.e. the
  // regression suite itself pinned the false claim that mutated:false proves a
  // failed action. Four measured false-negative classes (non-action text change,
  // async handler settling after the diff, focus-only click, first-op seed) all
  // report mutated:false while genuinely landing. The invariant now is that the
  // hint scopes itself to what the fingerprint actually covers and points at a
  // real read instead of asserting failure.
  assert(!/Treat this action as NOT LANDED/.test(SRV_SRC),
    'a zero-change delta must NOT claim the action did not land (fingerprints cover interactive elements only)');
  assert(/NO INTERACTIVE-ELEMENT CHANGE detected/.test(SRV_SRC),
    'a zero-change delta must state what it actually measured');
  assert(/NOT proof the action did not land/.test(SRV_SRC),
    'the hint must explicitly deny that mutated:false proves failure');
});

test('effect: classifyEffect unwraps the relay envelope, and unverifiable never escalates to OS input', () => {
  // 2026-09-25: the relay wraps payloads as {type,id,success,data:{…}} so
  // beforeState/afterState sit one level down. classifyEffect only read the top
  // level, so EVERY relayed click returned 'unverifiable' — and the click handler
  // then recommended real_click for anything non-confirmed, which is the
  // focus-steal loop (async/download/_blank/focus actions all landed while the
  // verdict said "retry with OS input").
  assert(/function unwrapRelay\(result\) \{[\s\S]*?result\.data && typeof result\.data === 'object'/.test(SRV_SRC),
    'unwrapRelay must unwrap the {data:{…}} relay envelope');
  assert(/const box = unwrapRelay\(result\)/.test(SRV_SRC),
    'classifyEffect must use unwrapRelay before reading before/afterState');
  assert(/result\.effect === 'suspected_noop'/.test(SRV_SRC),
    'OS-input escalation must be gated on a real measured no-op');
  assert(/recommended: 're_read'/.test(SRV_SRC),
    'an unverifiable effect must recommend re-reading the page, not OS input');
  const realClickEscalations = (SRV_SRC.match(/recommended: 'real_click'/g) || []).length;
  assert(realClickEscalations <= 2,
    'real_click must not be recommended from a non-no-op verdict path');
});

test('wait: the selector condition asks the no-eval path first (2026-09-25)', () => {
  // The branch used to probe with an EVAL first and only fall back to the
  // no-eval safe-query form when that probe came back CSP-blocked. The probe
  // NEVER produced a usable value (the extension's own CSP blocks it on every
  // page), so the fallback send never ran: measured exactly 1 evaluate send per
  // poll and a clean timeout for a selector that evaluate{query} proves exists.
  const selBranch = SRV_SRC.slice(SRV_SRC.indexOf('if (o.selector != null)'), SRV_SRC.indexOf('if (domOk && o.script != null)'));
  assert(/querySelector\(' \+ selJson/.test(selBranch),
    'wait{selector} must send the no-eval querySelector form first');
  assert(selBranch.indexOf('!!document.querySelector') > selBranch.indexOf('querySelector(1'),
    'the eval form may only remain as a last-resort fallback, after the safe send');
});

test('guide: the shipped guide must not teach the measured-false doctrines (2026-09-25)', () => {
  // Every assertion here corresponds to a claim that was live in the guide and
  // was measured FALSE against the running code. The guide is the agent's only
  // spec; a false line in it is a bug that ships to every caller.
  assert(!/mutated:false means the action did NOT land/.test(SRV_SRC),
    'the guide must not claim mutated:false proves an action did not land');
  assert(!/On suspected_noop do NOT retry blind — escalate/.test(SRV_SRC),
    'the guide must not tell agents to jump to OS-level input on suspected_noop');
  assert(!/CSP-blocked on strict sites\)/.test(SRV_SRC),
    'evaluate script mode is not a strict-site limitation (it falls back to the MAIN world)');
  // 2026-09-25: script mode USED to be declared dead on every page. It is not —
  // it falls back to chrome.userScripts, so the guide must not tell agents to
  // avoid it.
  assert(!/treat script mode as unavailable/.test(SRV_SRC),
    'the guide must not tell agents evaluate script mode is unavailable — it works via the MAIN world');
  assert(/re-routes through the MAIN world/.test(SRV_SRC),
    'the guide must state that script mode re-routes through the MAIN world');
  assert(/main_world_exec/.test(SRV_SRC),
    'the evaluate handler must implement the MAIN-world fallback');
  // 2026-09-25: JS dialog capture was declared impossible here on the strength
  // of one measurement. It was a world-split bug, now fixed with a MAIN-world
  // hook, so this assertion had to be INVERTED — it was pinning the limitation
  // rather than the requirement.
  assert(/CAPTURES THE PAGE'S OWN alert\/confirm\/prompt/.test(SRV_SRC),
    'the guide must state that the page\'s own JS dialogs are captured');
  assert(/recentDialogs/.test(SRV_SRC),
    'the guide must tell agents to check recentDialogs after a destructive-looking click');
  assert(/SYNTHETIC KeyboardEvents only/.test(SRV_SRC),
    'press_key must state it performs no default browser actions');
  assert(/TAB SCOPING MODEL/.test(SRV_SRC) && /jobs do NOT get separate profiles/.test(SRV_SRC),
    'the guide must state the one-profile/per-tab isolation model');
  // 2026-09-25: INVERTED. The claim that E# refs renumber/rot was measured
  // false — 41/41 refs unchanged across a full re-explore, 0 after a scroll,
  // 0 after a re-render, and a stale ref healed onto a replacement node. The
  // guide must now state the measured stability, not the old caveat.
  assert(/REF LIFECYCLE/.test(SRV_SRC) && /held by ELEMENT IDENTITY/.test(SRV_SRC),
    'the guide must state that E# refs are held by element identity');
  assert(/STABLE across re-explores, scrolls, and framework re-renders/.test(SRV_SRC),
    'the guide must state the measured ref stability');
  assert(!/RENUMBERS them/.test(SRV_SRC),
    'the guide must not claim refs renumber on re-explore — measured false');
  assert(/main_world func must be an EXPRESSION/.test(SRV_SRC) || /func must be an EXPRESSION/.test(SRV_SRC),
    'the guide must state main_world requires a function expression');
  // 2026-09-25: INVERTED — session state is PER-SESSION since 1.4.7. It used to
  // be a process-wide SessionManager singleton, so reset wiped every job's
  // history mid-task. The old assertion pinned that bug.
  assert(/is PER-SESSION since v1\.4\.7/.test(SRV_SRC),
    'the guide must state that session state is per-session (1.4.7)');
  assert(!/is GLOBAL to the hub/.test(SRV_SRC),
    'the guide must not claim session state is global to the hub');
  assert(/Pass tabId to target a specific tab/.test(SRV_SRC),
    'the guide must document navigate{tabId}');
});

test('docs: README does not advertise capabilities the audit proved absent', () => {
  // 2026-09-25: the 31-tool live audit found several README claims that were
  // false against the running code, and a visitor reads the README before the
  // guide. Each assertion below corresponds to a claim that was live here.
  const README = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  // 2026-09-25: inverted — JS dialog capture was declared impossible on the
  // strength of one measurement, but it was a world-split bug (the isolated-world
  // override is never called by page code). A MAIN-world hook now captures them,
  // so the README must state the working behavior.
  // 2026-09-25: the README stated the OLD dialog limitation in "Known limitations"
  // while the "Dialog handling" section above it documented the FIX. Two sections,
  // two truths, shipped together. Assert the limitation list cannot contradict the
  // feature list again.
  const dialogSection = README.slice(README.indexOf('## Dialog handling'), README.indexOf('## Iframes'));
  const limitsSection = README.slice(README.indexOf('## Known limitations'), README.indexOf('## v1.4.5'));
  assert(/are captured/.test(dialogSection) && /MAIN-world hook shadows the three functions/.test(dialogSection),
    'the Dialog handling section must state that JS dialogs are captured');
  assert(!/not reliably captured/.test(limitsSection),
    'Known limitations must not repeat the retired "dialogs are not captured" claim');
  assert(/auto-dismisses/.test(limitsSection),
    'the real remaining dialog limitation (hidden tab) must be stated');

  assert(!/blocked by strict page CSP/.test(README),
    'README must not scope the evaluate CSP block to "strict sites" only');
  assert(!/Use `evaluate\{query`/i.test(README) || /re-routes/i.test(README),
    'README must not tell users to avoid evaluate script mode — it works via the MAIN world');
  assert(/re-routes\s+through the MAIN world/.test(README),
    'README must state that evaluate script mode re-routes through the MAIN world');
  assert(!/returns every frame in the active tab/.test(README),
    'tabs frames is target-scoped (tabId), not active-tab-only');
  assert(/Refs are stable/.test(README) && /held by\s+element identity/.test(README),
    'README must state the measured E# ref stability, not the retired drift claim');
  assert(/One profile, per-tab isolation/.test(README),
    'README must state the one-profile / per-tab isolation model');
});

test('docs: MODEL_PROMPT.md is GENERATED from the live guide, not hand-maintained', () => {
  // 2026-09-25: MODEL_PROMPT.md was a hand-maintained mirror of a 21-tool guide
  // the server had already replaced, so it kept teaching agents claims the
  // running server contradicted (mutated:false = "not landed", JS dialogs
  // "captured, NOT blocking", evaluate blocked only on "strict sites", escalate
  // to real_click on unverifiable). A mirror nobody regenerates is a second
  // source of truth that rots. tools/export-guide.mjs now generates the block,
  // and this test fails if the two ever disagree again.
  let out;
  try {
    out = execFileSync(process.execPath, ['tools/export-guide.mjs', '--check'],
      { encoding: 'utf8', cwd: process.cwd() });
  } catch (e) {
    assert.fail('MODEL_PROMPT.md is STALE — run: node tools/export-guide.mjs\n' + (e.stdout || '') + (e.stderr || ''));
  }
  assert(/in sync/.test(out), 'the guide export check must confirm the mirror is fresh');
});

test('delta: the guide tells the agent to read the DIFF block instead of re-exploring', () => {
  // A feature an agent cannot discover is not a feature — this is the mem-795 failure
  // mode (fixes on disk that never reach the model). The guide is served as the tool
  // RESULT (textResult), not the description, so it is NOT hit by the 110-char wire cap.
  // 2026-10-01: the block was renamed DELTA -> DIFF and now carries the THREE GROUPS, so
  // the guide must name the groups too or the agent cannot tell churn from truth.
  assert(/DID IT LAND\?/.test(SRV_SRC), 'the guide must carry a DID IT LAND section');
  assert(/DIFF \(auto, after/.test(SRV_SRC), 'the guide must name the DIFF block format');
  for (const g of ['structure', 'content', 'viewport']) {
    assert(new RegExp('^  ' + g + '\\s+—', 'm').test(SRV_SRC),
      'the guide must name the ' + g + ' group and what it means');
  }
  assert(/NOT a mutation/i.test(SRV_SRC),
    'the guide must say viewport churn is not a mutation — that is the whole grouping');
  assert(/verify:false/.test(SRV_SRC), 'the guide must document the verify:false opt-out');
});

// ═══ SNAPSHOT + INDEX + SLICE (Ali 2026-09-21) ═══
// Ali: "why can't the structuring not cut anything out but simply map or index the webpage
// for agentic use... implement fully and wire locally and test end to end."
test('snapshot: the page-side COLLECTOR compiles (node --check cannot see inside a string)', () => {
  let fn = null, err = null;
  try { fn = new Function('return (' + COLLECTOR + ')'); } catch (e) { err = e; }
  assert(fn, 'the COLLECTOR must compile as a function expression: ' + (err && err.message));
  assert(typeof COLLECTOR === 'string' && COLLECTOR.length > 500, 'COLLECTOR looks truncated');
  // It must collect the things the index/slice dimensions rely on. (The collector builds
  // `loc:` and `region:` in the record literal and assigns `rec.name = ...` — assert the
  // real shapes, not a wished-for one.)
  assert(/loc:/.test(COLLECTOR), 'COLLECTOR must emit loc per element');
  assert(/region:/.test(COLLECTOR), 'COLLECTOR must emit region per element');
  assert(/rec\.name/.test(COLLECTOR), 'COLLECTOR must emit name per element');
  assert(/getBoundingClientRect/.test(COLLECTOR), 'COLLECTOR must measure geometry for the vp flag');
});

test('snapshot: page_snapshot/page_slice are registered and hold the lossless invariant', () => {
  assert(/reg\(server, 'page_snapshot'/.test(SRV_SRC), 'page_snapshot must be registered');
  assert(/reg\(server, 'page_slice'/.test(SRV_SRC), 'page_slice must be registered');
  // The unwrap that cost a round-trip: main_world returns {results:[{result:{...}}]}.
  assert(/results\[0\]/.test(SRV_SRC), 'the handler must unwrap main_world results[0].result');
  assert(/sliceSnapshot\(/.test(SRV_SRC), 'the slice path must be wired in the server');
  assert(/putSnapshot\(/.test(SRV_SRC) && /getSnapshot\(/.test(SRV_SRC), 'store must be wired');
  const SNAP_SRC = readFileSync(new URL('./src/snapshot.js', import.meta.url), 'utf8');
  assert(/buildIndex/.test(SNAP_SRC) && /sliceSnapshot/.test(SNAP_SRC), 'index + slice live in snapshot.js');
  // The filter that made the scan cache lossy must NOT appear in the page-side code. Assert on
  // COLLECTOR (the executable string) rather than the whole file — the file's COMMENT quotes
  // the offending line to explain what it avoids, which would trip a file-wide search.
  assert(!/isInViewport\(/.test(COLLECTOR),
    'the COLLECTOR must NOT filter by viewport — that is the whole point (scroll must not churn it)');
  assert(!/\.closest\('\[role="dialog"\]/.test(COLLECTOR),
    'the COLLECTOR must not carry the dialog viewport exemption either');
});

test('snapshot: the guide tells agents the map/slice tools exist', () => {
  // Same failure mode as the DELTA block: a tool an agent cannot discover is not a tool.
  assert(/FULL PAGE MAP vs A SLICE/.test(SRV_SRC), 'the guide must describe page_snapshot/page_slice');
  assert(/page_snapshot collects a LOSSLESS/.test(SRV_SRC), 'the guide must state the lossless property');
  assert(/scroll-stable/.test(SRV_SRC), 'the guide must state why it beats the viewport-filtered scan');
});

// ═══ THE BUILD MUST PARSE ══════════════════════════════════════════════════════
// 2026-09-21: a TRUNCATED edit shipped a server.js with a syntax error to GitHub, and
// npm test did NOT catch it — these tests read server.js as a TEXT blob. This actually
// parses it (and everything it imports).
test('src/server.js parses (a broken build once shipped — never again)', () => {
  try {
    execSync('node --check src/server.js', { stdio: 'pipe' });
  } catch (e) {
    assert(false, 'node --check src/server.js FAILED: ' + String(e.stderr || e.message));
  }
});

test('no shipped source carries a literal ...[truncated] marker', () => {
  for (const f of ['src/server.js', 'src/snapshot.js', 'src/hub.js']) {
    const s = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    assert(!s.includes('...[truncated]'), f + ' contains a literal ...[truncated] marker');
  }
});

// ═══ DOC DRIFT: the guide must state the TRUE tool count and list every tool ═══
// Found 2026-09-21: the guide header said "29 consolidated tools" while its own list said
// "THE 20 TOOLS", with a 31-tool registered surface — 11 of them undocumented. This guard makes the
// count self-enforcing so the docs cannot drift silently again.
test('docs: the guide states the TRUE tool count and lists every registered tool', () => {
  const regs = [...SRV_SRC.matchAll(/reg\(server, '([a-z_]+)'/g)].map((m) => m[1]);
  assert(regs.length >= 30, 'expected the full tool surface, got ' + regs.length);
  const surfM = SRV_SRC.match(/WIRE_SURFACE = new Set\(\[([^\]]+)\]/);
  assert(surfM, 'WIRE_SURFACE must exist — it is what a model is allowed to see');
  const surface = [...surfM[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert(surface.length <= 8, 'the LISTED surface must stay small, got ' + surface.length);
  for (const s of surface) assert(regs.includes(s), 'listed but not registered: ' + s);
  assert(SRV_SRC.includes('Guide (' + surface.length + ' listed / ' + regs.length + ' registered)'),
    'the guide header must state BOTH numbers (' + surface.length + ' listed / ' + regs.length + ' registered)');
  assert(SRV_SRC.includes('THE ' + surface.length + ' LISTED TOOLS'),
    'and the body must lead with the LISTED surface');
  assert(new RegExp('^THE REMAINING ' + (regs.length - surface.length) + ' ', 'm').test(SRV_SRC),
    'and must account for the rest rather than hiding them');
  const entryNames = (SRV_SRC.match(/^  [a-z_]+ {2,}/gm) || []).map((l) => l.trim().split(/ +/)[0]);
  const missing = regs.filter((n) => !entryNames.includes(n));
  assert(missing.length === 0, 'registered but undocumented in the guide: ' + missing.join(', '));
});

// ═══ 2026-09-25 — JS dialogs, async evaluate, and the CRLF/CI fix ═══

test('dialogs: a MAIN-world hook captures the PAGE\'s own alert/confirm/prompt', () => {
  // The isolated-world override was never called by page code, so a page's own
  // dialog was invisible AND Chrome auto-dismissed it in a background tab — a
  // silent-wrong-outcome class (an agent could report a destructive step as
  // successful when the user would have been asked about it).
  const BG = readFileSync(new URL('./extension/background.js', import.meta.url), 'utf8');
  const HOOK = readFileSync(new URL('./extension/dialog-hook.js', import.meta.url), 'utf8');
  // ★ 2026-10-01: the readers now live at the TOP of 00 (first in the concatenation) because
  // 00's own handle_dialog/get_status could not resolve them when they sat in 70. So read
  // BOTH: 00 holds the definitions, 70 holds the consumers (page_state, handle_dialog).
  const READERS = readFileSync(new URL('./extension/cs-src/00-bridge-and-transport.js', import.meta.url), 'utf8')
    + '\n' + readFileSync(new URL('./extension/cs-src/70-capture-and-readers.js', import.meta.url), 'utf8');
  const ART = readFileSync(new URL('./extension/websense-cs.js', import.meta.url), 'utf8');

  assert(/async function registerDialogHook\(\)/.test(BG), 'background must register the dialog hook');
  assert((BG.match(/registerDialogHook\(\);/g) || []).length >= 3,
    'the dialog hook must be registered on install, on startup, and at top level');
  assert(/id: 'ws-dialog-hook'/.test(BG) && /world: 'MAIN'/.test(BG) && /runAt: 'document_start'/.test(BG),
    'the dialog hook must be a MAIN-world document_start registration');

  for (const fn of ['alert', 'confirm', 'prompt']) {
    assert(HOOK.includes("install('" + fn + "'"), 'the hook must shadow ' + fn);
  }
  assert(/data-ws-dialogs'/.test(HOOK) && /data-ws-dialogs-recent/.test(HOOK),
    'the hook must publish both the pending list and the recent history');
  assert(/AUTO_MS = 30000/.test(HOOK),
    'confirm/prompt must auto-answer so a page can never wedge');
  assert(/pending\.filter\(\(d\) => !d\.done\)/.test(HOOK),
    'only UNRESOLVED dialogs may be published as pending');

  assert(/function readMainWorldDialogs\(\)/.test(READERS), 'the CS must read the MAIN-world queue');
  assert(/function readRecentMainWorldDialogs\(\)/.test(READERS), 'the CS must read the recent history');
  assert(/readMainWorldDialogs\(\)\.slice/.test(READERS), 'page_state must include the MAIN-world dialogs');
  assert(/recentDialogs:/.test(READERS), 'page_state must expose recentDialogs');
  assert(/source: 'main_world'/.test(READERS), 'handle_dialog must report which world it answered');
  assert(/readMainWorldDialogs/.test(ART), 'the built artifact must contain the dialog reader');
});

test('evaluate: script mode is async-capable, returns statement values, and reports real errors', () => {
  // The MAIN-world fallback serialized a Promise to {} (JSON.stringify), so an
  // async script came back empty and the agent had to hand-roll polling.
  assert(/__wsEvalOut/.test(SRV_SRC), 'the MAIN-world bridge must use a side channel for the value');
  assert(/Promise\.resolve\(__r\)/.test(SRV_SRC),
    'the bridge must resolve the value in the page before serializing');
  assert(/script threw: /.test(SRV_SRC),
    'a real script error must be reported as itself, not masked by the CSP error');
  assert(/splitTopLevel/.test(SRV_SRC),
    'statement blocks must return their last expression (var x = 7; x * 6 -> 42)');
  // main_world_exec must NOT be in the tab-management set: those ops are never
  // stamped with the session's bound tab, and the fallback died with
  // "main_world_exec: tabId required".
  const m = SRV_SRC.match(/const SESSION_TAB_OPS = new Set\(\[([\s\S]*?)\]\)/);
  assert(m, 'SESSION_TAB_OPS must exist');
  assert(!/main_world_exec/.test(m[1]),
    'main_world_exec is a PAGE op and must be stampable with the session bound tab');
});

test('repo: line endings pinned so the generated artifact is byte-reproducible in CI', () => {
  // No .gitattributes + core.autocrlf=true meant the Windows checkout had CRLF
  // and the Linux CI checkout had LF, so the "artifact is in sync with a fresh
  // build" guard failed in CI (126 passed, 2 failed) while passing locally.
  const GA = readFileSync(new URL('./.gitattributes', import.meta.url), 'utf8');
  assert(/text=auto eol=lf/.test(GA), 'the repo must normalize to LF');
  assert(/extension\/websense-cs\.js text eol=lf/.test(GA),
    'the generated artifact must be pinned to LF (a test byte-compares it)');
  assert(/extension\/cs-src\/\*\* text eol=lf/.test(GA), 'the CS sources must be pinned to LF');
  const EX = readFileSync(new URL('./tools/export-guide.mjs', import.meta.url), 'utf8');
  assert(/normalizeEol/.test(EX),
    'the guide exporter must normalize EOLs before comparing (CI saw MODEL_PROMPT.md as stale)');
});

test('session: exploration state is PER-SESSION, not a process-wide singleton', () => {
  // 2026-09-25: `const session = new SessionManager()` at module scope meant one
  // map + one history for every MCP session, so session{action:"reset"} wiped
  // other jobs mid-task and their steps showed up in each other's maps. The
  // server already runs each request inside sessionCtx with its own McpServer
  // object, so the manager is now resolved per session through that context.
  const S = SRV_SRC;
  assert(!/^const session = new SessionManager\(\);$/m.test(S),
    'the module-level SessionManager singleton must be gone');
  assert(/function getSession\(\)/.test(S), 'a per-session resolver must exist');
  assert(/SESSIONS_BY_SERVER/.test(S) && /WeakMap/.test(S),
    'session managers must be keyed per MCP server (WeakMap, so they are collectable)');
  assert(/sessionCtx\.getStore\(\)/.test(S),
    'the resolver must read the per-request session context');
  // No SessionManager call site may still read the old free variable.
  const body = S.slice(S.indexOf('function registerAllTools('));
  const strays = body.match(/(?<![\w.])session\.(recordPage|recordAction|recordNavigation|setLastSnapshot|reset|beginTask|getTask|getExplorationMap|currentUrl|stepCounter)\b/g) || [];
  assert(strays.length === 0,
    'every SessionManager call site must go through getSession() — strays: ' + strays.join(','));
});

test('hub: evicting a stale content client re-points the roles, never nulls them', () => {
  // 2026-09-25: the eviction nulled contentClient/mainFrameClient when the
  // evicted socket held those roles. With both empty, page ops fell through to
  // the offscreen (no ref engine) and explore_page returned zero actions —
  // measured as an alternating full-result/empty response on one tab.
  const H = readFileSync(new URL('./src/hub.js', import.meta.url), 'utf8');
  const m = H.match(/if \(prev && prev !== ws[\s\S]*?\n\s*\}/);
  assert(m, 'the stale-client eviction block must exist');
  assert(!/contentClient === prev\) this\.contentClient = null/.test(m[0]),
    'contentClient must not be nulled on eviction — page ops would fall to the offscreen');
  assert(!/mainFrameClient === prev\) this\.mainFrameClient = null/.test(m[0]),
    'mainFrameClient must not be nulled on eviction');
  assert(/contentClient === prev\) this\.contentClient = ws/.test(m[0]),
    'contentClient must be re-pointed at the NEW client that now owns the tab');
  assert(/mainFrameClient === prev\) this\.mainFrameClient = ws/.test(m[0]),
    'mainFrameClient must be re-pointed at the NEW client');
});

test('hub: a disconnecting stale client never unregisters the tab\'s NEW client', () => {
  // 2026-09-25: `if (ws.tabId) this.contentByTab.delete(ws.tabId)` ran on every
  // close. A superseded content script disconnecting wiped the NEW client's
  // registration for that tab, so page ops fell through to the offscreen (no ref
  // engine, no dialog reader) — measured: page_state reported zero dialogs and
  // explore_page returned zero actions while the healthy client was connected.
  const H = readFileSync(new URL('./src/hub.js', import.meta.url), 'utf8');
  assert(!/if \(ws\.tabId\) this\.contentByTab\.delete\(ws\.tabId\);/.test(H),
    'the unconditional contentByTab.delete on close must be gone');
  assert(/const mapped = this\.contentByTab\.get\(Number\(ws\.tabId\)\)/.test(H),
    'the close handler must read the current mapping for the tab');
  assert(/if \(mapped === ws\) this\.contentByTab\.delete\(Number\(ws\.tabId\)\)/.test(H),
    'the close handler must only remove the mapping when it still points at THIS socket');
});

test('hub: an unstamped PAGE op is REFUSED — no global-cursor fallback', () => {
  // 2026-10-01 TAB-HIJACK FIX (first of two). activeClient() ended
  //   `: this.selectedTabId`
  // for page ops. selectedTabId is a hub-GLOBAL cursor that the `activated`
  // handler moves to the OS-FRONTMOST tab and that any content script's
  // tab_activated also moves — so an unstamped page op was silently delivered to
  // whatever tab the USER last clicked, or a tab another session had activated.
  // A wrong-tab write is undetectable from the caller's side, so the hub must
  // refuse rather than guess.
  const H = readFileSync(new URL('./src/hub.js', import.meta.url), 'utf8');
  assert(/function assertPageOpsAreTabStamped\(cmd\)/.test(H),
    'the tab-hijack guard must exist');
  assert(/assertPageOpsAreTabStamped\(cmd\);/.test(H),
    'send() must invoke the guard before routing');
  const pageBranch = H.match(/\/\/ Page op — route to the tab this command TARGETS[\s\S]*?const targetTab = ([^;]+);/);
  assert(pageBranch, 'the page-op routing branch must exist');
  assert(!/this\.selectedTabId/.test(pageBranch[1]),
    'the page-op target must NOT fall back to the hub-global selectedTabId (tab-hijack path)');
  assert(/cmd\.tabId != null\) \? Number\(cmd\.tabId\) : null/.test(pageBranch[1]),
    'the page-op target must be the explicit tabId or nothing');
  // The guard must not be so broad that it breaks tab management or health.
  assert(/NON_PAGE_OPS\.has\(cmd\.type\)/.test(H) && /SW_REQUIRED_OPS\.has\(cmd\.type\)/.test(H),
    'the guard must exempt tab-management and SW-required ops');
});

test('offscreen: a relayed PAGE op with no tabId is REFUSED, not resolved globally', () => {
  // 2026-10-01 TAB-HIJACK FIX (second of two). dispatchToContent() ended
  //   || await getActiveTabId()
  // and getActiveTabId() resolves to the SW's GLOBALLY-BOUND tab, else the
  // OS-ACTIVE tab. Both are process-wide and OS-driven, so the relay path was a
  // second, independent route to the wrong tab. dispatchToContent is reached
  // ONLY for page ops (handleTabOperation has already returned null).
  const O = readFileSync(new URL('./extension/offscreen.js', import.meta.url), 'utf8');
  const fn = O.match(/async function dispatchToContent\(message\) \{[\s\S]*?\n\}/);
  assert(fn, 'dispatchToContent must exist');
  // Assert on CODE, not prose: the explanatory comment deliberately quotes the
  // old `|| await getActiveTabId()` line, so strip comments before checking.
  const code = fn[0].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert(!/getActiveTabId/.test(code),
    'dispatchToContent must NOT call getActiveTabId() (global SW binding / OS-active tab)');
  assert(/Refused \(tab-hijack guard\)/.test(code),
    'dispatchToContent must refuse a page op that carries no tabId');
  assert(/var tabId = \(message && message\.tabId != null\) \? Number\(message\.tabId\) : null;/.test(code),
    'dispatchToContent must take the tab ONLY from an explicit message.tabId');
});

test('tab routing: neither global cursor can be reintroduced silently', () => {
  // The two fixes are one class ("no explicit tabId -> use a process-wide
  // cursor"). Assert the CLASS at the routing site: activeClient() decides which
  // client serves a cmd, so it must not consult the OS-driven global cursor at
  // all. selectedTabId legitimately survives in the cursor's own bookkeeping,
  // in the census/stats payload and in _timeoutDiag — none of which route.
  const H = readFileSync(new URL('./src/hub.js', import.meta.url), 'utf8');
  const ac = H.match(/activeClient\(cmd\) \{[\s\S]*?\n  \}/);
  assert(ac, 'activeClient must exist');
  // Strip comments first: the fix's own explanatory comment quotes the removed
  // `: this.selectedTabId` line, so a raw text match would pass on prose alone.
  const acCode = ac[0].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert(!/selectedTabId/.test(acCode),
    'activeClient must not read the hub-global selectedTabId — that is the tab-hijack path');
  const S = readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
  assert(/withSessionTab\(cmd\)/.test(S),
    'server.js must keep stamping every page op with the calling session tab');
});

test('visibility: opacity is NOT a visibility criterion (x.com "+" regression)', () => {
  // 2026-10-01. `checkVisibility({checkOpacity:true})` walks ANCESTORS, so
  // x.com's a[data-testid="addButton"] (opacity 1, 24x24, in-viewport, enabled)
  // was reported invisible because a wrapper above it had opacity 0 — and every
  // collector gate dropped it, making the thread "+" unreachable from find,
  // explore_page and page_slice alike. It also disagreed with the function's own
  // fallback and with isVisible(), which both read OWN style. Pin both rules.
  const C = readFileSync(new URL('./extension/cs-src/50-candidates.js', import.meta.url), 'utf8');
  const fn = C.match(/function _isVisibleRect\(el, rect\) \{[\s\S]*?\n  \}/);
  assert(fn, '_isVisibleRect must exist');
  const code = fn[0].replace(/\/\/[^\n]*/g, '');   // strip comments: the fix explains itself in prose
  assert(!/checkOpacity:\s*true/.test(code),
    'checkOpacity must NOT be true — it walks ancestors and drops opaque elements under an opacity:0 wrapper');
  assert(/checkOpacity:\s*false/.test(code),
    'checkOpacity must be explicitly false, so the rule is the element OWN style');
  assert(!/opacity\s*===\s*'0'/.test(code),
    "own opacity 0 must not be treated as hidden — opacity:0 is a standard present-and-interactive pattern");
  // and the rule must reject the three real hiding mechanisms
  assert(/display === 'none'/.test(code) && /visibility === 'hidden'/.test(code),
    'display:none and visibility:hidden must still be rejected');
});

test('no capping / no filtering: the snapshot inventory is complete by construction', () => {
  // 2026-10-01 (Ali: "Agreed no capping no filtering implement and test"). Four real
  // cuts were removed from src/snapshot.js. Pin all four so none can return.
  const S = readFileSync(new URL('./src/snapshot.js', import.meta.url), 'utf8');
  // Strip comments up front: each fix's own comment names the removed code, so a raw
  // regex would match PROSE. (This trap bit four times while writing these.)
  const S_code = S.replace(/\/\/[^\n]*/g, '');

  // 1. No element cap in the collector.
  const collector = S.match(/export const COLLECTOR = `([\s\S]*?)`;/);
  assert(collector, 'COLLECTOR must be a template literal');
  const body = collector[1];
  // Strip comments FIRST. The fix's own comments name the removed cap ("used to be
  // MAX = 20000"), so a raw text match fails on prose — the third time this trap bit.
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert(!/MAX\s*=\s*\d+/.test(code), 'the collector must not carry an element MAX cap');
  assert(!/out\.length\s*>=\s*MAX/.test(code), 'the collector must not break early on a cap');
  assert(!/t === 'script'[\s\S]{0,120}continue;/.test(code),
    'script/style/meta/link/head/title/base must NOT be skipped — every element is recorded');
  // 3. No hardcoded vocabularies anywhere in the collector or the index.
  //    (Ali: "any value or names should be dynamically parsed by the script".)
  assert(!/new Set\(\[/.test(S_code),
    'no hardcoded tag/role table may remain (the INTERACTIVE sets were two of them)');
  assert(!/data-testid/.test(code),
    'the locator must not prefer data-testid — uniqueness is derived from the element OWN attributes');
  assert(!/INTERACTIVE\.has\(/.test(S_code),
    'interactive must be DERIVED (isInteractiveRec), not looked up in a declared table');
  assert(/function isInteractiveRec/.test(S) && /e\.focusable \|\| e\.field/.test(S),
    'isInteractiveRec must read platform state (focusable/field), not a name list');
  assert(/el\.tabIndex >= 0/.test(code),
    'focusability must come from the BROWSER (tabIndex), which is a computed platform fact');
  assert(/el\.attributes/.test(code) && /rec\.attrs = attrs/.test(code),
    'EVERY attribute the page wrote must be recorded — the page owns the field names');
  assert(!/regionOf[\s\S]{0,400}=== 'form'/.test(code),
    'regionOf must not test a hardcoded tag vocabulary (form/header/nav/...)');
  // 3. No field truncation — short() must normalise whitespace only.
  const shortFn = body.match(/function short\(s, n\) \{[\s\S]*?\n  \}/);
  assert(shortFn, 'short() must exist');
  assert(!/\.slice\(0,\s*n\)/.test(shortFn[0]),
    'short() must not truncate — a stored record cut mid-string is unreadable (cf. LABEL_MAX=40)');
  // 4. The slice returns everything unless the caller asks for a limit; no clamp.
  assert(/hasLimit/.test(S_code), 'slice must treat limit as opt-in');
  assert(!/Math\.min\(Number\(filter\.limit\)/.test(S_code),
    'the slice limit must not be defaulted to 200 nor clamped to 2000');
  // 5. Completeness must be REPORTED, so a future cut cannot hide.
  assert(/dropped:/.test(S), 'the index must report dropped (must be 0)');
  // 6. The full group lists, not a top-N cut.
  assert(!/slice\(0,\s*n\)/.test(S.match(/const top = [\s\S]*?\n/)[0]),
    'topTags/topRoles must not be cut to a top-N');
});

test('no capping / no filtering: BEHAVIOUR — a slice returns everything by default', () => {
  // The static test proves the old cap is gone from the source; this proves the
  // behaviour actually changed. 250 elements is chosen because the OLD default slice
  // limit was 200, so this exact size would previously have come back short.
  const els = [];
  for (let i = 0; i < 250; i++) {
    // Elements carry their OWN attributes — that is the only vocabulary the map has.
    els.push({ i, tag: i % 3 === 0 ? 'div' : 'a', loc: '#e' + i, region: 'body', vp: 1,
               name: 'n' + i, focusable: i % 3 === 0 ? 1 : undefined,
               attrs: i % 5 === 0 ? { 'data-offset': String(i) } : { role: 'link' } });
  }
  const snap = { url: 'x', title: 't', total: 250, elements: els };

  // 1. Completeness is reported and it is exact.
  const idx = buildIndex(snap);
  assert.strictEqual(idx.elements, 250, 'all 250 must be in the index');
  assert.strictEqual(idx.domTotal, 250, 'domTotal must be reported');
  assert.strictEqual(idx.dropped, 0, 'dropped must be 0 — nothing was cut');
  // interactive is DERIVED from platform/page state, not looked up in a table:
  // 84 elements are focusable (i%3==0), 200 carry a role (i%5!=0), 67 are both.
  // Union = 84 + 200 - 67 = 217. Exact, and computed with no vocabulary of ours.
  assert.strictEqual(idx.interactive, 217,
    'interactive must be the DERIVED union of focusable and role-carrying elements');

  // 2. A bare slice returns ALL matches (the old code capped this at 200).
  const all = sliceSnapshot(snap, {});
  assert.strictEqual(all.matched, 250, 'all 250 must match');
  assert.strictEqual(all.returned, 250, 'a bare slice must return all 250, not 200');
  assert.strictEqual(all.truncatedByLimit, false, 'nothing was truncated');
  assert.strictEqual(all.elements.length, 250, 'the elements array must hold all 250');

  // 3. An explicit limit is honoured EXACTLY (no clamp) and self-reported.
  const lim = sliceSnapshot(snap, { limit: 5 });
  assert.strictEqual(lim.returned, 5, 'an explicit limit of 5 returns 5');
  assert.strictEqual(lim.truncatedByLimit, true, 'an explicit limit reports that it truncated');
  const big = sliceSnapshot(snap, { limit: 5000 });
  assert.strictEqual(big.returned, 250, 'a limit above the size must not pad or clamp');

  // 4. Slice by ANY attribute the page wrote — no fixed vocabulary involved.
  const byAttr = sliceSnapshot(snap, { attr: 'data-offset' });
  assert.strictEqual(byAttr.matched, 50, 'attr by name only must match the 50 carrying it');
  const byAttrVal = sliceSnapshot(snap, { attr: { name: 'data-offset', value: '5' } });
  assert.strictEqual(byAttrVal.matched, 1, 'attr name+value must narrow to one');
  const byRole = sliceSnapshot(snap, { role: 'link' });
  assert.strictEqual(byRole.matched, 200, 'role is read from the recorded attribute');
  const byField = sliceSnapshot(snap, { focusable: true });
  assert.strictEqual(byField.matched, 84, 'focusable is a first-class slice dimension');

  // 5. dropped goes non-zero ONLY when the inventory really is short — so the field
  //    can actually detect a future cut rather than always reading 0.
  const short = buildIndex({ url: 'x', title: 't', total: 250, elements: els.slice(0, 200) });
  assert.strictEqual(short.dropped, 50, 'dropped must expose a short inventory (50 missing)');
});

test('page_slice: the new dynamic dimensions are reachable from the tool', () => {
  // A dimension that exists in snapshot.js but not in the tool schema is unreachable —
  // the caller can never ask for it. Pin the wiring on both sides.
  const S = readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
  const reg = S.match(/reg\(server, 'page_slice'[\s\S]*?\n  \}, async/);
  assert(reg, 'page_slice must be registered');
  const schema = reg[0].replace(/\/\/[^\n]*/g, '');
  for (const dim of ['field', 'focusable', 'attr']) {
    assert(new RegExp('\\b' + dim + ':').test(schema), 'page_slice must expose the ' + dim + ' dimension');
  }
  assert(!/default 200/.test(schema),
    'the schema must not still advertise a default limit of 200 — limit is opt-in now');
  // and the handler must hand the caller args straight to the slicer
  assert(/sliceSnapshot\(e\.snap, o\)/.test(S),
    'the handler must pass the caller args through to sliceSnapshot');
});

// ═══ 2026-10-01 — browse / find / grouped auto-DIFF / branch pointers ═══

test('browse + find are registered and documented', () => {
  assert(/reg\(server, 'browse'/.test(SRV_SRC), 'browse must be a tool');
  assert(/reg\(server, 'find'/.test(SRV_SRC), 'find must be a tool');
  assert(/^  browse\s/m.test(SRV_SRC), 'browse must be documented in the guide');
  assert(/^  find\s/m.test(SRV_SRC), 'find must be documented in the guide');
});

test('diff: the auto-DIFF groups structure / content / viewport', () => {
  const D = readFileSync(new URL('./src/diff-collector.js', import.meta.url), 'utf8');
  const code = D.replace(/\/\/[^\n]*/g, '');
  // It must actually evaluate as a function — a broken string here would silently no-op
  // every mutating op's verdict. Import the MODULE value, not the file text: the source
  // contains `${COLLECTOR}` which only interpolates on import.
  const fn = eval('(' + DIFF_COLLECTOR + ')');
  assert(typeof fn === 'function', 'DIFF_COLLECTOR must eval to a function');
  for (const g of ['structure', 'content', 'viewport']) {
    assert(new RegExp(g + ': \\{').test(code) || new RegExp("out\\." + g).test(code),
      'the diff must emit a ' + g + ' group');
  }
  // mutated must be derived from structure+content ONLY — viewport churn must never
  // make an action look landed.
  assert(/out\.mutated = structN > 0 \|\| contentN > 0;/.test(code),
    'mutated must ignore viewport churn (a scroll is not a mutation)');
  assert(!/out\.mutated = [^;]*viewportN\s*>\s*0/.test(code),
    'mutated must NOT be set by viewport movement');
  // The page holds the baseline, so navigation gives a fresh one for free.
  assert(/window\[KEY\]/.test(code), 'the baseline must live on the page');
  // A URL change must re-seed rather than diff across documents.
  assert(/prev\.url !== now\.url/.test(code), 'a navigation must re-seed the baseline');
  // ★ THE FINGERPRINT MUST BE IDENTITY, NOT CONTEXT. Including `region` produced ~1,049
  // phantom changes on a 1,049-element page (region is derived from ancestors, so it
  // flips on re-render) and a 103 KB diff for a no-op. Measured live, then fixed.
  const fp = code.match(/function fingerprint\(r\) \{[\s\S]*?\n  \}/);
  assert(fp, 'fingerprint must exist');
  assert(!/r\.region/.test(fp[0]), 'the fingerprint must NOT include region (context, not identity)');
  // ★ THE DIFF MUST BE AN INDEX OF THE CHANGE, NOT A COPY OF THE PAGE. Measured live:
  // shipping full attrs + name per changed element produced a 1,285,618-char DIFF when a
  // page hydrated 138 -> 2,401 elements — worse than the SAG it exists to replace.
  const ident = code.match(/function ident\(r\) \{[\s\S]*?\n  \}/);
  assert(ident, 'ident must exist');
  assert(!/attrs\s*:/.test(ident[0]) && !/\.name/.test(ident[0]),
    'ident must carry identity only — never attrs or name (both are already in the inventory)');
  assert(/addedIdx\.push\(nr\.i\)/.test(code),
    'adds must be recorded as INDICES so a large change stays an index');
  assert(/o2\.changed = attrsDiff;/.test(code),
    'changes must name WHICH fields moved, not their values');
  // ★ CONTENT MUST NOT SHIP WHOLE TEXT EITHER. name on a style tag is its entire CSS
  // source; that group alone was 227,703 of a 271,713-char diff (84%). Preview + true
  // length, with the full text fetchable from the inventory by index.
  assert(/cc\.nameLen = nm\.length/.test(code), 'content must report the TRUE length of the text');
  assert(/nm\.length > 120 \? nm\.slice\(0, 120\)/.test(code), 'content must ship a preview, not the blob');
  assert(!/cc\.name = nr\.name;/.test(code), 'content must not ship the raw name');
  assert(/cc\.value = nr\.value/.test(code) && /cc\.wasValue = or\.value/.test(code),
    'a FIELD value stays exact — it is short and it is the answer to "did my input land"');
  // ★ A SCROLL IS ONE FACT, NOT N THOUSANDS. Scrolling an already-hydrated x.com page
  // enumerated 2,525 element movements — 300,769 chars, 77% of a 379 KB diff — to say "the
  // page scrolled 972px". The document scroll POSITION is the discriminator: the uniform-
  // delta test was tried and FAILED on a virtualized list (x.com recycles nodes, so the
  // deltas differ), which is exactly the kind of thing only a measurement finds.
  assert(/var scrolled = \(Number\(prev\.sx\) !== Number\(now\.sx\)\)/.test(code),
    'the scroll position must be the scroll-vs-relayout discriminator');
  assert(/out\.viewport = \{[\s\S]{0,80}scrolled: \{ dx:/.test(code),
    'a scroll must report its delta, not enumerate every element');
  assert(/enumerated: false/.test(code), 'and must say it did not enumerate');
  // ★ AND A RELAYOUT IS A FEW FACTS, NOT N (2026-10-01 — the second measurement on this code).
  // The relayout branch used to enumerate {loc, was, now} for every element that moved. Opening
  // x.com's composer moved 2,023 elements and produced 333.5 KB: 98% of a 379 KB tool result, to
  // say "the timeline shifted down 73px". It now reports each DISTINCT movement ONCE with the
  // count and the inventory indices of every element that moved by it. No element is dropped, no
  // fact is hidden — the index IS the identity and its repeated locator was the expensive part
  // (199 KB of those bytes, because icons carry 1,200-char path locators).
  assert(/out\.viewport = \{ moved: viewportN, shifts: shifts/.test(code),
    'a relayout must report DISTINCT shifts, one fact each — not one entry per element');
  assert(/byDelta\[dk\]\.i\.push\(mv\.i\)/.test(code),
    'every moved element must keep its index, or the summary would be hiding them');
  assert(/var dk = dx \+ ',' \+ dy \+ ',' \+ vw \+ '>' \+ vn;/.test(code),
    'the viewport transition must be part of the shift key, so entering/leaving stays visible');
  // ★ PRESENTATION IS NOT IDENTITY — and it is not just class/style. Measured: 609
  // structure.changed entries at 98,441 chars whose differences were class/style,
  // class/data-testid/style, class/dir/style. data-* is metadata BY DEFINITION in HTML.
  assert(/function isPresentationAttr\(n\)/.test(code), 'a presentation test must exist');
  assert(/n\.lastIndexOf\('data-', 0\) === 0/.test(code),
    'data-* attributes are framework bookkeeping, not element identity');
  assert(/if \(isPresentationAttr\(k\)\) continue;/.test(code),
    'the fingerprint must exclude every presentation attribute');
  assert(/if \(isPresentationAttr\(attrsDiff\[pd\]\)\) presentOnly\.push/.test(code),
    'the classification must use the SAME rule, or a repaint lands in structure again');
  assert(/var visual = \{ changed: \[\] \};/.test(code), 'a visual group must exist');
  assert(/out\.visual = \{ changed: visual\.changed/.test(code), 'visual must be reported (nothing hidden)');
  assert(/out\.mutated = structN > 0 \|\| contentN > 0;/.test(code),
    'mutated must still be structure+content ONLY — a repaint is not a mutation');
});

test('snapshot: elements carry a parent pointer, and branchChain walks it', () => {
  const S = readFileSync(new URL('./src/snapshot.js', import.meta.url), 'utf8');
  const code = S.replace(/\/\/[^\n]*/g, '');
  assert(/rec\.p = idxOf\.get\(pn\)/.test(code), 'records must carry a parent index');
  assert(/var idxOf = new Map\(\)/.test(code), 'the element->index map must be built');
  // Behavioural: a chain with MEANINGFUL and ANONYMOUS ancestors interleaved. The walk must
  // keep the ones that say something and skip the layout wrappers — because on x.com the
  // nearest ancestors are five identical anonymous divs, which cannot answer "is this the
  // New of the composer or the New of the news feed?".
  const snap = { elements: [
    { i: 0, tag: 'body', loc: 'body', region: 'body', attrs: {} },                                  // anonymous
    { i: 1, tag: 'div', loc: 'div:nth-of-type(1)', region: 'body', attrs: { class: 'x' } },          // anonymous
    { i: 2, tag: 'div', loc: 'div[data-testid="primaryColumn"]', region: 'body',
      attrs: { 'data-testid': 'primaryColumn' }, p: 1 },                                             // meaningful (hook)
    { i: 3, tag: 'div', loc: 'div:nth-of-type(2)', region: 'role:dialog', attrs: {}, p: 2 },         // anonymous
    { i: 4, tag: 'div', loc: 'div[role="dialog"]', region: 'role:dialog',
      attrs: { role: 'dialog', 'aria-label': 'Composer' }, p: 3 },                                   // meaningful (role + name)
    { i: 5, tag: 'button', loc: 'button[aria-label="Post"]', region: 'role:dialog',
      attrs: { 'aria-label': 'Post', role: 'button' }, p: 4, name: 'Post' },                          // the hit itself
  ] };
  const chain = branchChain(snap, snap.elements[5], 5);
  assert.strictEqual(chain.length, 2, 'only the MEANINGFUL ancestors are kept (2 of 4)');
  assert.strictEqual(chain[0].i, 4, 'nearest meaningful ancestor first');
  assert.strictEqual(chain[0].role, 'dialog', 'and it carries the role');
  assert.strictEqual(chain[0].ariaLabel, 'Composer', 'and the accessible name');
  assert.strictEqual(chain[1].i, 2, 'then the next meaningful one up');
  assert.strictEqual(chain[1].hook, 'data-testid="primaryColumn"', 'with its page hook');
  // ★ THE ATTRIBUTE NAME IS IDENTITY; ITS VALUE IS NOT ALWAYS. Live, x.com's
  // data-at-shortcutkeys is ~1.5 KB of JSON and one ancestor inflated every find result by
  // that much. A short value IS the identity and is kept; a long one is reported by length.
  assert(/v\.length <= 40 \? \(k \+ '="' \+ v \+ '"'\)/.test(code),
    'a short hook value is kept — it is the identity');
  assert(/\[value ' \+ v\.length \+ ' chars\]/.test(code),
    'a long hook value must be reported by LENGTH, not shipped whole');
  const bigHook = { elements: [
    { i: 0, tag: 'div', loc: 'div:nth-of-type(1)', region: 'body', p: undefined,
      attrs: { 'data-at-shortcutkeys': 'x'.repeat(1500) } },
    { i: 1, tag: 'span', loc: 'span:nth-of-type(1)', region: 'body', attrs: {}, p: 0 },
  ] };
  const hc = branchChain(bigHook, bigHook.elements[1], 5);
  assert.strictEqual(hc.length, 1, 'the hook-holding ancestor is meaningful');
  assert(hc[0].hook.length < 60, 'and its 1500-char value must NOT be shipped: ' + hc[0].hook.length);
  assert(/1500 chars/.test(hc[0].hook), 'the true length is reported instead');
  // depth bounds the number of MEANINGFUL ancestors, not raw hops
  assert.strictEqual(branchChain(snap, snap.elements[5], 1).length, 1, 'depth must bound the walk');
  // a root has no branch
  assert.strictEqual(branchChain(snap, snap.elements[0], 5).length, 0, 'a root has no branch');
  // if the page labels NOTHING on the path, the branch is the nearest ancestors rather than
  // an empty chain — blank would read as "no context", which would be a quiet lie.
  const bare = { elements: [
    { i: 0, tag: 'div', loc: 'div:nth-of-type(1)', region: 'body', attrs: {} },
    { i: 1, tag: 'span', loc: 'span:nth-of-type(1)', region: 'body', attrs: {}, p: 0 },
  ] };
  const bareChain = branchChain(bare, bare.elements[1], 5);
  assert.strictEqual(bareChain.length, 1, 'an unlabelled page still returns the nearest ancestor');
});

test('collectors: NO BACKTICKS inside the template-literal collector bodies', () => {
  // ★ THIS HAS NOW BIT SIX TIMES (2026-10-01). COLLECTOR and DIFF_COLLECTOR are TEMPLATE
  // LITERALS holding page-side functions, so a backtick anywhere inside — including in an
  // ordinary explanatory comment — terminates the literal and breaks the file. One such
  // commit was made and only caught because the next `npm test` crashed. The suite must
  // catch it, not luck.
  for (const f of ['./src/snapshot.js', './src/diff-collector.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const m = src.match(/= `([\s\S]*?)`;/);
    assert(m, f + ': a template-literal collector must exist');
    assert(!m[1].includes('`'),
      f + ': the collector body must contain NO backticks (it is itself a template literal)');
  }
  // And the modules must actually load — a broken literal would not even parse.
  assert(typeof COLLECTOR === 'string' && COLLECTOR.length > 200, 'COLLECTOR must be a real string');
  assert(typeof DIFF_COLLECTOR === 'string' && DIFF_COLLECTOR.length > 200, 'DIFF_COLLECTOR must be a real string');
});

test('snapshot lifecycle: nothing expires on a clock; reads SELF-HEAL', () => {
  // ★ Ali, 2026-10-01: "we should not have stale snapshots... if no action is taken there
  // is nothing to expire and if it does and a page event happens the dif should pick them
  // up and update cache. No?"
  // He is right, and the old 5-minute TTL was a design error: it made the MODEL of the page
  // vanish while the page was still open — a plain `find` failed with "no live snapshot" on
  // a tab sitting right there, unchanged. A wall clock is not an invalidation event.
  const S = readFileSync(new URL('./src/snapshot.js', import.meta.url), 'utf8');
  const code = S.replace(/\/\/[^\n]*/g, '');
  assert(!/Date\.now\(\) - e\.at > TTL_MS/.test(code),
    'getSnapshot must not expire an entry by age — a clock is not an invalidation event');
  assert(!/TTL_MS/.test(code), 'the TTL constant must be gone entirely from the store');
  assert(/export function markSnapshotDirty/.test(code), 'an action must be able to mark the copy stale');
  assert(/export function getSnapshot\(tabId\) \{[\s\S]*?\n\}/.test(code), 'getSnapshot must exist');
  const gs = code.match(/export function getSnapshot\(tabId\) \{[\s\S]*?\n\}/)[0];
  assert(!/\.at\b/.test(gs), 'getSnapshot must not compare the entry age against anything');
  assert(/actionsSinceCollect: 0/.test(code), 'a fresh collect resets the dirty counter');
  assert(/expiry: 'none \(invalidated by URL change or tab close\)'/.test(S),
    'the store must state that nothing expires by time');

  // The server side: reads refresh rather than failing, and actions mark dirty.
  assert(/async function ensureSnapshot\(tabId, why\)/.test(SRV_SRC), 'ensureSnapshot must exist');
  assert(/actionsSinceCollect > 0\)\) return \{ entry: e, refreshed: false \}/.test(SRV_SRC),
    'a clean snapshot must be served without a needless re-collect');
  assert(/await ensureSnapshot\(tabId, 'find'\)/.test(SRV_SRC), 'find must self-heal');
  assert(/await ensureSnapshot\(tabId, 'page_slice'\)/.test(SRV_SRC), 'page_slice must self-heal');
  assert(!/no live snapshot for tab/.test(SRV_SRC),
    'the "no live snapshot" failure must be gone — that was the stale-snapshot complaint');
  assert(/markSnapshotDirty\(\(args && args\.tabId\) \|\| sessionTabOf\(\)\)/.test(SRV_SRC),
    'every performed action must mark the copy dirty');
});

test('dispatchers: every shared op has ONE implementation, and the relay DELEGATES to it', () => {
  // ★ 2026-10-01b, Ali: "make them not conflict for all we worked on and have proven to be
  // better". The earlier 2026-10-01a pass closed ELEVEN live divergences by hand, in BOTH
  // copies — which left the MECHANISM intact. Root cause (mem 994): WebSense had TWO
  // content-script dispatchers —
  //   00-bridge-and-transport.js  wsDispatchPage     (direct WS)
  //   70-capture-and-readers.js   handleMessageAsync (offscreen relay)
  // — with 48 OPS HAND-MAINTAINED IN BOTH. Every fix had to be written twice, and about half
  // the time only one copy received it. That mechanism produced the 2026-09-25
  // pendingDialogs:[] bug, the upload_file one-sided failure, and — when this test was
  // rewritten — a live path whose action_preview called `getActionPreview`, a function that
  // exists NOWHERE, so every direct-WS action_preview threw a ReferenceError.
  //
  // The fix is STRUCTURE, not vigilance: there is now ONE implementation (wsDispatchPage in
  // 00) that owns every page op, and the relay path keeps ONLY the tab-relay ops it alone can
  // serve and DELEGATES the rest. This test fails the moment a second copy reappears: the
  // overlap of case labels between the two files must be ZERO.
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const srcOf = (file) => strip(readFileSync(new URL('./extension/cs-src/' + file, import.meta.url), 'utf8'));
  const A = srcOf('00-bridge-and-transport.js');
  const B = srcOf('70-capture-and-readers.js');
  const cases = (s) => new Set([...s.matchAll(/case '([a-z_0-9]+)'\s*:/g)].map((m) => m[1]));

  const aOps = cases(A), bOps = cases(B);
  const overlap = [...aOps].filter((k) => bOps.has(k));
  assert.strictEqual(overlap.length, 0,
    'a shared op must have ONE implementation; these are duplicated across BOTH dispatchers again: '
    + overlap.join(', '));
  assert(aOps.size > 45, 'the ONE dispatcher must own the whole page-op set, saw ' + aOps.size);

  // The relay must DELEGATE, explicitly — and keep the ops only IT can serve.
  assert(/result\s*=\s*await\s+wsDispatchPage\(message,\s*\{\s*sender:\s*sender\s*\}\)/.test(B),
    'the relay path must DELEGATE to the one dispatcher, wsDispatchPage(), passing sender as ctx');
  for (const op of ['cookie_op', 'download_op', 'get_active_tab', 'respawn_offscreen',
                    'switch_tab', 'close_tab', 'list_frames', 'download_state', 'list_tabs']) {
    assert(bOps.has(op), 'the relay-only op ' + op + ' must stay routed in 70');
  }

  // The capability fixes that WERE one-sided must live in the ONE implementation.
  for (const [op, must, what] of [
    ['upload_file', /nativeUpload/, 'upload_file (a real handler, not a "requires the SW" error)'],
    ['network_log', /getNetworkLog/, 'network_log'],
    ['handle_dialog', /readMainWorldDialogs/, 'handle_dialog (MAIN-world dialogs first)'],
    ['form_state', /getFormState/, 'form_state (the dedicated function, not an inline SAG)'],
    ['get_status', /pendingDialogs/, 'get_status (real dialog count, not a hardcoded healthy stub)'],
    ['drag_drop', /resolveRefHealed/, 'drag_drop (the HEALED resolver)'],
    ['type_many', /await\s+nativeTypeMany/, 'type_many (AWAITED)'],
    ['click', /await\s+nativeClick/, 'click (AWAITED before afterState)'],
    ['action_preview', /previewAction/, 'action_preview (the real function)'],
    ['read_clipboard', /handleReadClipboard/, 'read_clipboard (the ONE clipboard reader)'],
  ]) {
    assert(new RegExp("case '" + op + "'").test(A), op + ' must be in the ONE dispatcher');
    const i = A.search(new RegExp("case '" + op + "'"));
    const j = A.indexOf("case '", i + 5);
    assert(must.test(A.slice(i, j === -1 ? i + 1500 : j)),
      op + ' must be its implementation here: ' + what);
    assert(!new RegExp("case '" + op + "'").test(B), op + ' must NOT have a second copy in 70');
  }

  // The dead symbol that motivated this rewrite: a call into a function nobody defines.
  const ART = strip(readFileSync(new URL('./extension/websense-cs.js', import.meta.url), 'utf8'));
  assert(!/getActionPreview/.test(A + B + ART),
    'getActionPreview is defined NOWHERE — path A\'s action_preview threw a ReferenceError on every call');
});

test('find: every filter the handler applies must ALSO be declared in the schema', () => {
  // ★ Found 2026-10-01 by running find{field:true} on the workbench and getting 103 of 103
  // elements back — html, head, style included. `field` and `focusable` were in NEITHER the
  // tool schema NOR the handler's filter-copy list, so the filter silently did nothing and
  // the answer looked filtered. That is worse than having no filter at all.
  const src = SRV_SRC;
  const m = src.match(/reg\(server, 'find',[\s\S]*?for \(const k of \[([^\]]+)\]\)/);
  assert(m, 'the find handler filter list must be findable');
  const applied = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);

  const schemaBlock = src.match(/reg\(server, 'find', \{[\s\S]*?inputSchema: \{[\s\S]*?\n    \}/);
  assert(schemaBlock, 'the find schema must be findable');
  const schemaText = schemaBlock[0];

  const missing = applied.filter((k) => !new RegExp('^\\s*' + k + ':', 'm').test(schemaText));
  assert(missing.length === 0,
    'these filters are applied by the handler but NOT declared in the schema, so they can be '
    + 'stripped before the handler sees them: ' + missing.join(', '));

  // And the two that were actually broken must be present, in both places.
  for (const k of ['field', 'focusable']) {
    assert(applied.includes(k), k + ' must be in the handler filter list');
    assert(new RegExp('^\\s*' + k + ':', 'm').test(schemaText), k + ' must be in the schema');
  }
});

test('slice: every key sliceSnapshot understands must be declared in EVERY tool that forwards to it', () => {
  // ★ GENERALISED 2026-10-01. The `find` test above pins ONE tool, and the same defect class
  // then shipped unnoticed in page_slice: `indices` was absent from its schema, so it was
  // stripped before the handler saw it and page_slice{indices:[31]} returned 543 of 543 records
  // — the WHOLE page — while the DIFF block tells the model that this exact call is how you pull
  // the detail for an index it named. A filter the schema accepts and the handler ignores is
  // worse than no filter: it answers confidently and wrongly, and here it also silently
  // reintroduced the context bloat the index/diff split exists to prevent.
  //
  // So take the vocabulary from sliceSnapshot ITSELF and check every caller against it.
  const snapSrc = readFileSync(new URL('./src/snapshot.js', import.meta.url), 'utf8');
  const fn = snapSrc.match(/export function sliceSnapshot\(snap, filter = \{\}\) \{[\s\S]*?\n\}/);
  assert(fn, 'sliceSnapshot must be findable in src/snapshot.js');
  const keys = [...new Set([...fn[0].matchAll(/filter\.([a-zA-Z_]+)/g)].map((m) => m[1]))];
  assert(keys.length >= 10, 'expected the full filter vocabulary, got: ' + keys.join(', '));

  // every tool whose handler forwards to sliceSnapshot
  const callers = [];
  const re = /reg\(server, '([a-z_]+)', \{/g;
  let m;
  while ((m = re.exec(SRV_SRC))) callers.push({ name: m[1], at: m.index });
  for (let i = 0; i < callers.length; i++) {
    const end = i + 1 < callers.length ? callers[i + 1].at : SRV_SRC.length;
    callers[i].text = SRV_SRC.slice(callers[i].at, end);
  }
  const forwarding = callers.filter((c) => c.text.includes('sliceSnapshot('));
  assert(forwarding.length >= 2,
    'expected at least find and page_slice to forward to sliceSnapshot, got: ' + forwarding.map((c) => c.name).join(', '));

  for (const c of forwarding) {
    const schema = c.text.match(/inputSchema: \{[\s\S]*?\n    \}/);
    assert(schema, c.name + ' schema must be findable');
    // find copies an explicit allow-list into its filter object; page_slice forwards its args
    // wholesale, so for page_slice EVERY key must be declared.
    const copies = c.text.match(/for \(const k of \[([^\]]+)\]\)/);
    const allowed = new Set(copies ? copies[1].split(',').map((s) => s.trim().replace(/['"]/g, '')) : []);
    const missing = keys.filter((k) => !allowed.has(k) && !new RegExp('^\\s*' + k + ':', 'm').test(schema[0]));
    assert(missing.length === 0,
      c.name + ' forwards to sliceSnapshot but its schema strips: ' + missing.join(', ')
      + ' — the caller gets an unfiltered (whole-page) answer that looks filtered');
  }
});

test('collector: a locator built from an id must be CSS-escaped', () => {
  // ★ Found 2026-10-01 by simulating a task on bbc.com/news. React's useId() mints ids like
  // ":R35tbdm:", and locatorOf returned '#' + id — which is NOT valid CSS (a colon starts a
  // pseudo-class), so find/page_slice handed out a locator that could never be used and every
  // act on that element failed with a selector error. A selector error reads as "the control is
  // broken", not "the locator is broken", which is why it needs pinning rather than noticing.
  assert(/CSS\.escape\(el\.id\)/.test(COLLECTOR), 'the id locator must go through CSS.escape');
  assert(!/return '#' \+ el\.id;/.test(COLLECTOR), 'the unescaped id locator must be gone');
  // ...but an attribute VALUE is not an identifier: inside a quoted attribute value CSS.escape
  // over-escapes, and the backslash it emits does not survive transport (measured live: every
  // backslash-bearing form failed to resolve while the plain form resolved and reached the
  // guard). Only " and \ need escaping there.
  assert(!/CSS\.escape\(at\[i\]\.value\)/.test(COLLECTOR),
    'attribute values must be quote-escaped, never CSS.escaped — the emitted backslashes do not '
    + 'survive the pipeline and the locator silently stops resolving');
});

test('cs: typing into a disabled/read-only control must SAY SO, not advise a re-read loop', () => {
  // ★ Found 2026-10-01 simulating a task on bbc.com/news: the search input is disabled:1 until
  // its menu opens, so typing "failed" — and the failure carried the blanket escalation
  // "re_read the field and re-type", which loops forever on a control that is disabled BY
  // DESIGN. setNativeValue happily assigns .value to a disabled input, so without an explicit
  // state guard there is nothing in the read-back that reveals the cause.
  const m = CS_SRC.match(/async function nativeType\(el, text, clearFirst\) \{[\s\S]*?\n  \}/);
  assert(m, 'nativeType must be findable in the content script');
  for (const g of ['el.disabled', 'el.readOnly', "getAttribute('aria-disabled')", "el.type === 'file'"]) {
    assert(m[0].includes(g), 'nativeType must guard against ' + g);
  }
  assert(/reason: 'the target is disabled'/.test(m[0]), 'and it must name the reason');
  assert(/hint:/.test(m[0]), 'and carry a usable next step instead of a re-read loop');
});

test('collector: the walk must descend into OPEN SHADOW ROOTS', () => {
  // ★ Measured on the repo's own bench/shadow_fixture.html, 2026-10-01: one
  // document.querySelectorAll('*') saw 22 light-DOM elements and NONE of the marked shadow
  // controls (shadow-btn, deep-shadow-btn two roots deep, shadow-input, shadow-file) — so on any
  // Lit/FAST/Stencil/faceplate site, browse/find reported an empty page over a real one. The
  // fixture exists to catch exactly this and its own comment says a plain selector sees an
  // "empty" page. After the fix the same page yields 27 elements and all five controls, typing
  // into a shadow input was verified inside the shadow DOM, and both file inputs read files=1.
  assert(/function walkShadow\(root, host, ox, oy\)/.test(COLLECTOR), 'the collector must walk shadow roots (now also frames, carrying a viewport offset)');
  assert(/walkShadow\(le\.shadowRoot, le, ox, oy\)/.test(COLLECTOR), 'descending into each host open shadowRoot');
  assert(/le\.parentElement \|\| host/.test(COLLECTOR), 'a shadow child logical parent is its HOST (it has no parentElement)');
  assert(/function parentOf\(el\)/.test(COLLECTOR), 'and the branch pointer must resolve through it');
  assert(!/try \{ all = document\.querySelectorAll/.test(COLLECTOR), 'the light-DOM-only enumeration must be gone');
});

test('trusted_click: wired through all four layers, and it must make the renderer LIVE first', () => {
  // ★ THE MEASURED DISCOVERY, and the reason this op is not just "dispatch through CDP": the
  // browser DROPS input into a renderer that reports itself hidden. Measured on
  // bench/click_fingerprint.html with a background tab: mouseMoved took 5,080ms and the press
  // vanished — the page saw pointerover/pointermove and NO pointerdown/mousedown/click — so a
  // "trusted" click did nothing. After Emulation.setFocusEmulationEnabled(true) +
  // Page.setWebLifecycleState('active') the SAME click is 151ms and the page records
  // click.isTrusted=true, detail=1, clientX=83 (real), with the default action firing on a button,
  // a checkbox, a link and an input.
  assert(/SW_REQUIRED_OPS[\s\S]{0,200}trusted_click/.test(HUB_SRC),
    'the hub must route trusted_click to the service worker (chrome.debugger is not in a page)');
  assert(/case 'trusted_click'/.test(OFF_SRC),
    'and the offscreen relay must FORWARD it — the relay itself has no debugger API, and without a case it answers "Unknown action type" inside a success envelope');
  assert(/Emulation\.setFocusEmulationEnabled/.test(BG_SRC),
    'the SW must enable focus emulation, or the press is dropped on a background tab');
  assert(/Page\.setWebLifecycleState[\s\S]{0,80}'active'/.test(BG_SRC),
    'and lift the frozen/idle lifecycle');
  for (const k of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    assert(BG_SRC.indexOf(k) > 0, 'the SW must dispatch the real three-step sequence: missing ' + k);
  }
  assert(/movePressGapMs/.test(BG_SRC),
    'with a gap between arriving and pressing — same-tick move+press gets coalesced away');
  assert(/__dbgKeepAlive/.test(BG_SRC), 'and REUSE the attach: a cold attach is the slow part');
  assert(/relayFailure/.test(SRV_SRC),
    'and a refusal riding inside a success envelope must not read as a performed action');
});

test('trusted_key: wired like the click, and it must SHARE the preparation', () => {
  // The keyboard half of trusted_click, for the same measured reason: a dispatched KeyboardEvent is
  // untrusted, so the browser runs NO default action. Measured on en.wikipedia.org: an Enter reached
  // the element ({key:'Enter', trusted:false}) and the form did NOT submit — press_key worked around
  // that by calling form.requestSubmit() itself, which is a GUESS at what the page wanted.
  assert(/SW_REQUIRED_OPS[\s\S]{0,200}trusted_key/.test(HUB_SRC), 'the hub must route trusted_key to the SW');
  assert(/case 'trusted_key'/.test(OFF_SRC), 'the offscreen relay must forward it (it has no debugger API)');
  assert(/case 'trusted_key'/.test(BG_SRC), 'the SW must handle it');
  assert(/Input\.dispatchKeyEvent/.test(BG_SRC), 'through the browser\'s own input pipeline');
  assert(/rawKeyDown/.test(BG_SRC),
    'a key with no text is rawKeyDown; one that produces text is keyDown WITH text — that is what makes an Enter submit');
  assert(/Runtime\.evaluate[\s\S]{0,300}\.focus\(\)/.test(BG_SRC),
    'the target must be focused first: the renderer routes key events to its focused element');
  // ★ ONE PREPARATION, NOT TWO. Attach + keep-alive + the focus emulation are the part that is
  // easy to get subtly wrong, and this codebase has paid repeatedly for two copies of one idea.
  const prepCalls = (BG_SRC.match(/await __dbgPrepare\(/g) || []).length;
  assert(prepCalls >= 2, 'BOTH trusted ops must call the shared preparation (found ' + prepCalls + ')');
  const afterPrep = BG_SRC.split('async function __dbgPrepare')[1] || '';
  // Counting CALL SITES is position-independent, which matters here: splitting at the function's
  // signature leaves its own BODY in the second half, so a "not in the remainder" test is wrong by
  // construction. (First version of this assertion failed on its own body; the one before that
  // failed on the comment that documents it.)
  const emuCalls = (BG_SRC.match(/'Emulation\.setFocusEmulationEnabled'/g) || []).length;
  assert(emuCalls === 1,
    'the focus emulation must have exactly ONE call site, inside __dbgPrepare (found ' + emuCalls + ')');
  assert(afterPrep.indexOf('function ') > 0, 'sanity: the split really did yield the rest of the file');
  assert(/looksLikeSubmit \? 6 : 1/.test(SRV_SRC),
    'the server side must give an Enter a LONGER navigation window (a real page load outlasts a short probe: measured — Wikipedia navigated and the verdict still said unverifiable) and a single probe to everything else, so typing a character costs nothing');
});

test('collector: a SAME-ORIGIN IFRAME is part of the page', () => {
  // Measured on the fixture, before and after: find{query:'frame-btn'} went from matched 0 to
  // matched 2 with its branch chain walking up through the iframe. Perception only — the rect is
  // in the FRAME's coordinate space, so acting on it still needs the frame offset.
  assert(/le\.contentDocument && le\.contentDocument !== root/.test(COLLECTOR),
    'the walk must descend into a same-origin iframe document');
  assert(/catch \(e\) \{\}/.test(COLLECTOR), 'cross-origin frames must be skipped, not break the collect');
  assert(/shadowRoot\) walkShadow/.test(COLLECTOR), 'and the shadow walk must stay');
});

test('drag: the full sequence INCLUDING drop, and a frame must not be blamed on the element', () => {
  // ★ I CLAIMED DRAG WAS A SILENT NO-OP. I WAS WRONG. Measured (2026-10-01): the page recorded
  // dragstart > drag > dragenter > dragover > DROP > dragend with a DataTransfer, dropCount 1. My
  // check had read dg.result instead of dg.results[0].result, so it saw nothing and I filed my own
  // mistake as a finding about the tool. This pins it.
  assert(/DragEvent\('dragstart'/.test(CS_SRC), 'dragstart must be dispatched');
  assert(/DragEvent\('drop'/.test(CS_SRC), 'DROP must be dispatched — it is the one that matters');
  assert(/DragEvent\('dragend'/.test(CS_SRC), 'and dragend');
  assert(/dataTransfer: dt/.test(CS_SRC), 'carrying a real DataTransfer');
  assert(/OR inside an IFRAME/.test(SRV_SRC), 'a failed box resolve must name the IFRAME possibility');
  assert(!/has no box \(hidden, detached, or zero-sized\)/.test(SRV_SRC),
    'and the old wording, which blamed the element, must be gone');
});

test('diff: the block is a SUMMARY and the rest lives in the cache', () => {
  // Ali: "The composer-close dif it's huge if that ends up in your context. Isn't it better to be
  // registered in cache and just show you specifically what changed?"
  assert(/from '\.\/diff-cache\.js'/.test(SRV_SRC), 'the server must import the diff cache');
  assert(/const handle = cacheDiff\(/.test(SRV_SRC), 'every auto-diff is cached under a handle');
  assert(/summariseDelta\(delta\)/.test(SRV_SRC), 'the block carries the SUMMARY, not the delta');
  assert(/FULL DIFF: /.test(SRV_SRC), 'and names the handle so the rest is fetchable');
  assert(/if \(o\.diff\) \{[\s\S]{0,600}getDiff\(o\.diff\)/.test(SRV_SRC), 'page_slice serves a cached part');
  const DC = readFileSync(new URL('./src/diff-cache.js', import.meta.url), 'utf8');
  assert(/if \(delta\.content\) out\.content = delta\.content;/.test(DC),
    'CONTENT passes through whole — it is the answer to whether the action landed, already small');
  assert(/dy: s\.dy, count: s\.count \}\)\)/.test(DC), 'the viewport shifts drop the index arrays');
});

test('browse: the reply must include the tabId (a caller sharing Chrome has nothing else to pass)', () => {
  // ★ Found 2026-10-01 by attempting a cross-tab isolation test: browse answered with an opaque
  // `handle` and no tabId, so the test could not name the two tabs it had opened, and a caller
  // that wants to address the tab explicitly — which is what any session sharing a Chrome with
  // other workers must do — had nothing to pass and could only rely on session binding.
  const at = SRV_SRC.indexOf("reg(server, 'browse'");
  assert(at > 0, 'the browse handler must be findable');
  const b = SRV_SRC.slice(at);
  assert(/cached: true, tabId,/.test(b), 'the WARM browse reply must carry tabId');
  // anchor on the COLD reply's own opening fields — there are earlier `return textResult({` lines
  // in this handler (the no-tab error and the collect-failed error), so searching for the first
  // one asserts on the wrong object
  assert(/navigated: navigated, handle:[\s\S]{0,900}?tabId,/.test(b), 'and so must the COLD one');
});

test('diff: a diff taken across a NAVIGATION must say so', () => {
  // ★ A click that navigated came back mutated:false — "nothing changed" for a whole new document
  // — because the baseline belongs to the document that was replaced. Measured with an outside
  // oracle on HN's "newest" and books.toscrape's "next". Wrong in the most misleading direction,
  // so the line now names the navigation and denies the misreading.
  const at = SRV_SRC.indexOf('function withDelta(');
  const w = SRV_SRC.slice(at, at + 2400);
  assert(at > 0, 'withDelta must be findable');
  assert(/THE PAGE NAVIGATED/.test(w), 'the DIFF line must name a navigation when the result proved one');
  assert(/mutated:false here does NOT mean nothing happened/.test(w),
    'and must explicitly deny that mutated:false means nothing happened');
  assert(/payload\.navigation/.test(w), 'it must read the navigation the handler proved');
});

test('page state: ONE unwrapping reader — the envelope hid the URL three times', () => {
  // type_text's verdict, the click navigation probe, and auto-climb's "did the OS click change
  // anything" check each read a URL straight off a hub reply and got `undefined` every time
  // ({type,id,success,data:{…}}). type_text then called a refused type 'confirmed'; the click
  // probe never ran at all; auto-climb always reported changed:false. One mistake, three places —
  // so page state has exactly one reader now, and this test keeps it that way.
  assert(/async function readPageState\(tabId\)/.test(SRV_SRC), 'readPageState must exist');
  assert(/return unwrapRelay\(res\)/.test(SRV_SRC), 'and it must unwrap the relay envelope');
  // Two sends are legitimate and both are deliberate: the accessor itself, and the `status`
  // diagnostic, which FORWARDS the reply verbatim and reads no field off it. Every other reader
  // goes through the accessor — the four that did not were all broken (type_text's verdict, the
  // click navigation probe, auto-climb's changed test, withEffect, and wait{urlContains}).
  const direct = (SRV_SRC.match(/getActiveHub\(\)\.send\(\{ type: 'page_state'/g) || []).length;
  assert(direct === 2, 'only the accessor and the status pass-through may send page_state; found ' + direct);
});

test('click: a navigation must be CONFIRMED, and read from the payload', () => {
  // ★ Measured 2026-10-01 with an outside oracle (the page's own location.href): clicking HN's
  // "newest" nav link and books.toscrape's "next" BOTH navigated while the tool answered
  // effect:'suspected_noop' + mutated:false. suspected_noop's escalation tells the caller to
  // re-read and then consider OS-level input, i.e. it retries an action that already worked.
  // The state pair cannot see it: before/afterState are captured around a click that RETURNS
  // IMMEDIATELY, so when the click navigates both snapshots are the PRE-navigation document.
  // ★ AND THE FIRST FIX OF THIS READ result.beforeState AT THE TOP LEVEL, where it does not exist
  // ({type,id,success,data,…}) — so the probe silently never ran and the tool was unchanged. Only
  // a negative check (delete the line, expect the suite to fail) caught that. This test asserts on
  // the unwrapped read so the envelope cannot hide it again.
  const t = SRV_SRC.slice(SRV_SRC.indexOf("reg(server, 'click'"));
  assert(/confirmNavigation\(result, o\.tabId \|\| sessionTabOf\(\)\)/.test(t),
    'the click handler must use the shared confirmNavigation probe');
  assert(/async function confirmNavigation\(result, tabId, tries = 3/.test(SRV_SRC),
    'confirmNavigation must exist and be shared — two copies of one idea is what broke this file');
  assert(/toUrl !== fromUrl/.test(SRV_SRC), 'it must compare the tab URL after the op against the click-time URL');
  assert(/result\.navigation = \{/.test(SRV_SRC), 'and record the navigation it proved, so the verdict is explainable');
  assert(/await new Promise\(\(r\) => setTimeout\(r, 220\)\)/.test(SRV_SRC),
    'it must POLL: the navigation commits after the op returns (measured: found on the 3rd read)');
  // press_key can submit a form, so it must get the same check or a submit reads as no-change
  const pk = SRV_SRC.slice(SRV_SRC.indexOf("reg(server, 'press_key'"));
  assert(/confirmNavigation\(result/.test(pk), 'press_key must get the navigation check too (Enter submits forms)');
  assert(/o\.key === 'Enter'/.test(pk), 'gated on Enter so ordinary keys pay nothing');
});

test('cs: an Enter must run the default action a real one would (submit the form)', () => {
  // ★ Measured on en.wikipedia.org, 2026-10-01: press_key Enter reached the element with the
  // right target ({key:'Enter', trusted:false, target:'searchInput'}) and the page did not move —
  // an untrusted event runs NO default action. So "type a query, press Enter" silently did
  // nothing, and nothing in the result said why.
  // ★ AND THE FIRST VERSION OF THIS TEST WAS WORTHLESS, which is the real lesson here: it
  // asserted on nativePressKey — a function with ZERO callers — so it went green while the tool
  // behaved exactly as before. Both dispatchers call nativePressKeyEnhanced. A test that asserts
  // on a symbol nobody calls proves nothing, so this resolves the symbol the dispatchers CALL.
  const calls = [...CS_SRC.matchAll(/case 'press_key':[\s\S]{0,90}?([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  assert(calls.length >= 1, 'the dispatchers must route press_key to some function');
  for (const fn of new Set(calls)) {
    const body = CS_SRC.match(new RegExp('function ' + fn + '\\([\\s\\S]*?\\n  \\}'));
    assert(body, fn + ' must be defined — press_key routes to it');
    // ★ ASSERT ON CODE, NOT ON PROSE, AND PROVE IT WITH A NEGATIVE CHECK. The second version of
    // this test matched /requestSubmit\(\)/ — which the human-readable message
    // 'form.requestSubmit() — a real Enter would have…' satisfies on its own, so deleting the
    // CALL still left the suite green. These three patterns only match executable statements:
    // the call (';' after it, which the message does not have), the guard, and the assignment.
    assert(/\.requestSubmit\(\)\s*;/.test(body[0]), fn + ' must CALL form.requestSubmit() on Enter');
    assert(/[!]\s*[A-Za-z_$][\w$]*\.defaultPrevented/.test(body[0]), fn + ' must NOT submit when the page claimed the key');
    assert(/\.defaultAction\s*=/.test(body[0]), fn + ' must record what it did, not just do it');
  }
  assert(!/[^A-Za-z]nativePressKey\s*\(/.test(CS_SRC),
    'the dead nativePressKey (zero callers) must stay deleted — a fix landed on it and changed nothing');
});

test('cs: a locator must not be rejected by a hand-rolled character whitelist', () => {
  // ★ Found 2026-10-01, on x.com's file input. resolveSelectorRef had a character whitelist that
  // omitted '/' — so input[accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"]
  // returned null BEFORE querySelector ever saw it, and the tool reported "Element not found" for
  // an element that was sitting right there. Every href/src locator is in the same state, which is
  // most links on the web. Letting the CSS parser decide is both simpler and correct: an invalid
  // selector throws and is caught, which is what the whitelist was hand-rolling — minus the false
  // negatives.
  const m = CS_SRC.match(/function resolveSelectorRef\(ref\) \{[\s\S]*?\n  \}/);
  assert(m, 'resolveSelectorRef must be findable');
  // strip comment lines before matching, or the note recording the old form reads as the form
  const code = m[0].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert(!/\^\[\\/.test(code), 'the character whitelist must be gone (a locator containing / could never resolve)');
  assert(/deepQuery\(ref\)/.test(code), 'the selector must still be tried');
  assert(/catch \(_\) \{ return null; \}/.test(code), 'and the parser must be what rejects a bad one');
});

test('verdicts: read the action result from the PAYLOAD, never the relay envelope', () => {
  // ★ A FALSE SUCCESS (found 2026-10-01 simulating a task on bbc.com/news). Hub replies are
  // {type,id,success,data:{…}} and the TOP-LEVEL success means "a reply was delivered", not "the
  // action worked". type_text judged from the envelope, so a refused type came back
  // effect:'confirmed' while its own payload said {success:false, reason:'the target is disabled'}
  // — and the auto-DIFF for the same call said mutated:false, "treat this action as NOT LANDED".
  // Two signals disagreed and the optimistic one was wrong, which is the failure mode that
  // matters most: the caller believes the text landed when it did not.
  assert(/function unwrapRelay\(/.test(SRV_SRC), 'unwrapRelay must exist so handlers cannot miss it');
  const ce = SRV_SRC.match(/function classifyEffect\(result\) \{[\s\S]*?\n\}/);
  assert(ce && /unwrapRelay\(result\)/.test(ce[0]),
    'classifyEffect must unwrap before reading before/afterState');
  const ttStart = SRV_SRC.indexOf("reg(server, 'type_text'");
  const ttNext = SRV_SRC.indexOf("reg(server, '", ttStart + 10);
  const tt = SRV_SRC.slice(ttStart, ttNext > 0 ? ttNext : ttStart + 4000);
  assert(ttStart > 0, 'the type_text handler must be findable');
  assert(/unwrapRelay\(result\)/.test(tt), 'type_text must unwrap before judging success');
  assert(!/const persisted = result && \(result\.valueSet/.test(tt),
    'the verdict must not be computed from the envelope — that is the false success');
});

test('page ops: every tool that can act on a tab must DECLARE tabId in its schema', () => {
  // ★ Found 2026-10-01 by running a real task on the workbench: type_text{ref:'#txt',
  // tabId:328034510} returned "Element not found" and its auto-DIFF came back for a DIFFERENT
  // SITE — the session's tab. `tabId` was not declared in type_text's inputSchema, so zod
  // stripped it before the handler ran, the handler fell back to sessionTabOf(), and the op
  // silently acted on a tab the caller had not chosen.
  // That is the worst failure shape available: the parameter is documented, accepted without
  // complaint, and inert — so every page op can land somewhere you did not pick and report a
  // result you cannot attribute. Only 9 of the then-registered tools declared it; 28 did after the fix.
  const src = SRV_SRC;

  // Any tool whose body routes through the hub for a PAGE op must accept a tab.
  const PAGE_OPS = [
    'click', 'type_text', 'form', 'read', 'reveal', 'scroll', 'press_key', 'inspect',
    'wait', 'dialog', 'screenshot', 'network_log', 'console_log', 'cookies', 'clipboard',
    'real_paste', 'real_click', 'real_activate_tab', 'status',
    'evaluate', 'ax', 'main_world', 'page_snapshot', 'page_slice', 'browse', 'find', 'navigate', 'tabs',
  ];

  const missing = [];
  for (const name of PAGE_OPS) {
    const needle = "reg(server, '" + name + "'";
    const at = src.indexOf(needle);
    if (at < 0) { missing.push(name + ' (NOT REGISTERED)'); continue; }
    const sm = /inputSchema:\s*\{/.exec(src.slice(at));
    if (!sm) { missing.push(name + ' (no inputSchema)'); continue; }
    const start = at + sm.index + sm[0].length;
    let depth = 1, i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const block = src.slice(start, i);
    if (!/\btabId\s*:/.test(block)) missing.push(name);
  }
  assert(missing.length === 0,
    'these page ops do not declare tabId, so a tabId passed to them is silently stripped and '
    + 'the op lands on the session tab instead: ' + missing.join(', '));

  // And the failure must stay documented where the next reader will look.
  assert(/zod stripped it before the handler ran|silently stripped/.test(src) ||
         /tabId/.test(src), 'tabId must be declared');
});

test('cs: the dialog + clipboard helpers are defined EXACTLY ONCE, in a scope both dispatchers see', () => {
  // ★ 2026-10-01. They lived in 70 and 00 could not see them: handle_dialog failed with
  // "readMainWorldDialogs is not defined", and get_status called it inside try/catch so it
  // SILENTLY reported pendingDialogs: [] — a wrong answer indistinguishable from "no
  // dialogs". Hoisted to the top of 00, which is first in the concatenation.
  // handleReadClipboard joins them for the same reason (2026-10-01b): it was declared INSIDE
  // the switch block of 70's handleMessageAsync — block-scoped under 'use strict' — so once
  // the shared dispatcher in 00 took over the read_clipboard op it could not have reached it.
  const files = readdirSync(new URL('./extension/cs-src/', import.meta.url))
    .filter((f) => f.endsWith('.js')).sort();
  const FNS = ['readMainWorldDialogs', 'readRecentMainWorldDialogs', 'resolveMainWorldDialog',
               'handleReadClipboard'];
  const where = {};
  for (const f of files) {
    const s = readFileSync(new URL('./extension/cs-src/' + f, import.meta.url), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const fn of FNS) {
      if (new RegExp('function\\s+' + fn + '\\s*\\(').test(s)) (where[fn] = where[fn] || []).push(f);
    }
  }
  for (const fn of FNS) {
    const files_ = where[fn] || [];
    assert.strictEqual(files_.length, 1,
      fn + ' must be defined exactly once (found in: ' + (files_.join(', ') || 'NOWHERE') + ')');
    // 00 is FIRST in the concatenation, so its declarations are visible to every section.
    assert.strictEqual(files_[0], '00-bridge-and-transport.js',
      fn + ' must live in 00-bridge-and-transport.js (the first file), so every dispatcher '
      + 'can see it — it was in ' + files_[0] + ' and 00 could not resolve it');
  }
});

test('regions: the page\'s OWN named containers, nested, with NO counts', () => {
  // ★ 2026-10-01, Ali: "center feed is 1 element for me ... If there is 1 central feed why does
  // it need to show 1617?" He was right. The outline names the containers and nests them; it
  // never prints a subtree count.
  // A REGION = a named element that CONTAINS another named element — that one tree fact
  // separates a region (primaryColumn, holding "Home timeline") from a control (a named link,
  // holding nothing named), with no vocabulary and no size threshold of ours.
  const mk = (i, tag, attrs, p) => {
    const r = { i, tag };
    if (attrs) {
      r.attrs = attrs;
      r.attrNames = Object.keys(attrs);
    }
    if (p != null) r.p = p;
    return r;
  };
  //                                    i  tag      attrs                              parent
  const snap = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'body', null, 0),
    mk(2, 'header', { role: 'banner' }, 1),
    mk(3, 'nav', { 'aria-label': 'Primary' }, 2),
    mk(4, 'a', { 'aria-label': 'Home' }, 3),            // named LEAF -> a control, not a region
    mk(5, 'main', { role: 'main' }, 1),
    mk(6, 'div', { 'data-testid': 'primaryColumn' }, 5),
    mk(7, 'div', { 'aria-label': 'Home timeline' }, 6),
    mk(8, 'article', { 'data-testid': 'cell' }, 7),
    mk(9, 'span', { 'aria-label': 'inner' }, 8),        // makes article a region
    mk(10, 'span', { 'aria-label': 'meta' }, 8),
    mk(11, 'article', { 'data-testid': 'cell' }, 7),
    mk(12, 'span', { 'aria-label': 'inner' }, 11),
    mk(13, 'span', { 'aria-label': 'meta' }, 11),
    mk(14, 'article', { 'data-testid': 'cell' }, 7),
    mk(15, 'span', { 'aria-label': 'inner' }, 14),
    mk(16, 'span', { 'aria-label': 'meta' }, 14),
    mk(17, 'div', { 'data-testid': 'composer' }, 6),
    mk(18, 'span', { 'aria-label': 'What is happening' }, 17),
    mk(19, 'span', { 'aria-label': 'Post' }, 17),
    mk(20, 'div', { 'data-testid': 'sidebarColumn' }, 5),
    mk(21, 'div', { 'aria-label': 'Trending' }, 20),
    mk(22, 'span', { 'aria-label': 'topic' }, 21),
    mk(23, 'span', { 'aria-label': 'topic two' }, 21),
    mk(24, 'div', { 'aria-label': 'Search' }, 20),
    mk(25, 'span', { 'aria-label': 'Search box' }, 24),
  ] };

  const t = regionTree(snap);
  assert(typeof t.outline === 'string' && t.outline.length > 0, 'must produce an outline');

  assert(/banner/.test(t.outline), 'a named region (header role=banner) must appear');
  assert(/Primary/.test(t.outline), 'a named region (nav aria-label) must appear');
  assert(/primaryColumn/.test(t.outline), 'the page\'s own hook name must appear');
  assert(/Home timeline/.test(t.outline), 'a nested named region must appear');
  assert(/sidebarColumn/.test(t.outline) && /Trending/.test(t.outline), 'the rail must appear');

  // ★ THE POINT OF THE QUESTION: a named leaf control is NOT a region, so it is not listed —
  // this is what stops the outline from becoming a dump of every named node.
  assert(!/aria-label="Home"|:: "Home"|:: Home/.test(t.outline),
    'a named LEAF (a link holding nothing named) must NOT be listed as a region');

  // repetition of identical regions collapses to one + a count of the REPEAT
  assert(/REPEATS x3/.test(t.outline), 'three identical article regions must collapse');

  // ★ NO BARE SUBTREE COUNTS ANYWHERE — the exact thing Ali objected to.
  assert(!/\{\d+\}/.test(t.outline), 'the outline must never print a {count} — that was the bug');

  // nesting is real: Trending is deeper than main
  const lines = t.outline.split('\n');
  const trend = lines.find((l) => /Trending/.test(l));
  assert(trend && trend.startsWith('  '), 'a nested region must be indented');

  // ★ AN ATTRIBUTE NAME IS IDENTITY; ITS VALUE IS SOMETIMES A PAYLOAD. Measured live on x.com:
  // data-at-shortcutkeys holds the whole keyboard-shortcut map (~1.5 KB) and it landed IN THE
  // OUTLINE because the name printer concatenated the value. A short value IS the identity
  // (data-testid=primaryColumn); a long one must be reported by NAME ONLY.
  const longVal = 'x'.repeat(400);
  const snap2 = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'div', { 'data-shortcuts': longVal }, 0),
    mk(2, 'span', { 'aria-label': 'inner' }, 1),
    mk(3, 'span', { 'aria-label': 'other' }, 1),
  ] };
  const t2 = regionTree(snap2);
  assert(t2.outline.indexOf(longVal) === -1, 'a long data-* VALUE must never be printed');
  assert(/data-shortcuts/.test(t2.outline), 'the attribute NAME must still be printed');
  assert(t2.outline.length < 200, 'the outline must not carry the payload (got ' + t2.outline.length + ' chars)');

  // ★ THE DEFAULT IS LOSSLESS (Ali, 2026-10-01): "there shall be no hard coding, filtering,
  // truncating, grouping limiting rules ... everything must be done dynamically with the full
  // data available from the page". A first pass at the bbc.com/news flood made the wrapper
  // rule the DEFAULT, which meant the outline silently dropped the page's own words — that was
  // a cut, not an organisation. It is now opt-in, and both halves are pinned.
  //
  // bbc.com puts data-testid="anchor-inner-wrapper" on 157 elements, each wrapping a single
  // <a>, and with it the page ran to 116 lines with 941 of 1,424 elements counted as "named".
  const snapWrap = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'div', { 'data-testid': 'anchor-inner-wrapper' }, 0),   // wraps ONE <a>
    mk(2, 'a', { 'data-testid': 'internal-link' }, 1),
    mk(3, 'span', { 'aria-label': 'label' }, 2),
  ] };
  assert(/anchor-inner-wrapper/.test(regionTree(snapWrap).outline),
    'DEFAULT is lossless: the page\'s own wrapper name is KEPT');
  assert(!/anchor-inner-wrapper/.test(regionTree(snapWrap, { passthrough: true }).outline),
    'passthrough:true is the OPT-IN organisation that stops a one-child wrapper being a region');

  // ★ NO NAME IS REJECTED BY DEFAULT — the position/spread and instance-identifier tests are
  // available but OFF, because discarding the page's own words is exactly the cut Ali called out.
  const snapSpread = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'body', null, 0),
    mk(2, 'section', null, 1),
    mk(3, 'div', { 'data-testid': 'widget' }, 2),
    mk(4, 'a', { 'aria-label': 'one' }, 3),
    mk(5, 'a', { 'aria-label': 'one b' }, 3),
    mk(6, 'article', null, 1),
    mk(7, 'div', { 'data-testid': 'widget' }, 6),   // same hook, DIFFERENT position shape
    mk(8, 'a', { 'aria-label': 'two' }, 7),
    mk(9, 'a', { 'aria-label': 'two b' }, 7),
  ] };
  assert(/data-testid=widget/.test(regionTree(snapSpread).outline),
    'DEFAULT is lossless: a hook used in two places is still shown');
  assert(!/data-testid=widget/.test(regionTree(snapSpread, { spread: 1 }).outline),
    'spread:1 is the OPT-IN test that treats a word used in many places as a component marker');

  // ★ AND THE SAME HOOK AT THE SAME POSITION IS STILL A PLACE — otherwise the opt-in rule above
  // would just be "ignore hooks", and the whole feed would vanish. The main fixture proves it
  // (data-testid="cell" x3 collapses), asserted above.
  assert(/REPEATS x3/.test(t.outline), 'a hook repeated at ONE position is a place, and collapses');

  // ★ CLASS IS ALWAYS A NAME SOURCE (Ali, 2026-10-01, "the full data available from the page"):
  // a page that names its entire layout with class only (books.toscrape: div.page >
  // article.product_pod, no id/role/data-* on a single container) must still produce a model.
  // It used to be a last-resort fallback behind a "did the page name anything?" test — that was
  // a fixed policy, and it is gone.
  const snapBare = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'body', { id: 'default' }, 0),
    mk(2, 'div', { class: 'page' }, 1),
    mk(3, 'article', { class: 'product_pod' }, 2),
    mk(4, 'span', { 'aria-label': 'inner' }, 3),
    mk(5, 'article', { class: 'product_pod' }, 2),
    mk(6, 'span', { 'aria-label': 'inner' }, 5),
    mk(7, 'article', { class: 'product_pod' }, 2),
    mk(8, 'span', { 'aria-label': 'inner' }, 7),
    mk(9, 'span', { 'aria-label': 'meta' }, 3),
    mk(10, 'span', { 'aria-label': 'meta' }, 5),
    mk(11, 'span', { 'aria-label': 'meta' }, 7),
  ] };
  const t5 = regionTree(snapBare);
  assert(/product_pod/.test(t5.outline), 'a class-only page must still produce a model (books.toscrape)');
  assert(/REPEATS x3/.test(t5.outline), 'and its repeated cards must collapse');

  // ★ AN id IS MINTED PER ELEMENT BY SPEC (2026-10-01, found on the live x.com feed).
  // Every tweet carried a React-generated id — #id__kaz8g4cuhrn, #id__nhffana1zz,
  // #id__uyjanmr0dmf — and each is unique, so every "is this name shared?" test passed it
  // happily while the timeline grew ~40 lines of per-tweet noise. A page showing SEVERAL
  // DIFFERENT ids at ONE position is minting identifiers, not naming places. Note the two
  // articles here are named, so without the rule the id divs WOULD be regions and would
  // appear — this assertion is not vacuous.
  const snapIds = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'body', null, 0),
    mk(2, 'article', { 'data-testid': 'cell' }, 1),
    mk(3, 'div', { id: 'id__aaa111' }, 2),
    mk(4, 'span', { 'aria-label': 'x' }, 3),
    mk(5, 'span', { 'aria-label': 'y' }, 3),
    mk(6, 'article', { 'data-testid': 'cell' }, 1),
    mk(7, 'div', { id: 'id__bbb222' }, 6),
    mk(8, 'span', { 'aria-label': 'x' }, 7),
    mk(9, 'span', { 'aria-label': 'y' }, 7),
  ] };
  const t6 = regionTree(snapIds);
  assert(/data-testid=cell/.test(t6.outline), 'the named card is still a place');
  // ★ RE-TYPED, NOT REMOVED (2026-10-01). This assertion used to say the per-instance id was
  // KEPT in the default outline. It was only ever kept because the test that recognises a
  // minted identifier shared a guard with the SPREAD filter, so switching the spread filter
  // off (Ali's no-filtering rule) switched the identifier test off with it — an accident, and
  // the comment directly above describes the rule as the correct behaviour. The two tests are
  // now separate: spread stays opt-in (it DROPS a word, which is a cut), while recognising a
  // per-instance value stays ON (it RE-TYPES a word, which is not a cut). Both halves are
  // pinned below — the map stops calling a minted key a place-name, and the DATA is untouched.
  assert(!/id__aaa111/.test(t6.outline),
    'a minted per-instance id is not a place-NAME (it is re-typed, not printed as identity)');
  assert(!/id__bbb222/.test(t6.outline), 'and the same holds for its sibling instance');
  assert(snapIds.elements.filter((e) => e.attrs && e.attrs.id === 'id__aaa111').length === 1,
    'LOSSLESS: the id is still taken from the page and still addressable in the inventory');
  assert(!/id__aaa111|id__bbb222/.test(regionTree(snapIds, { spread: 1 }).outline),
    'the OPT-IN spread test additionally drops a word the page uses in many different places');

  // ★ A LABEL THAT SUMMARISES ITS OWN CONTENTS IS A DATUM; AN AUTHOR-CHOSEN LABEL IS A NAME.
  // Both cases are from the live x.com sidebar (2026-10-01), and the first two cuts got it
  // wrong in BOTH directions before it was measured:
  //   - "the slot holds a different value on every occurrence" demoted aside "Subscribe to
  //     Premium" and aside "Who to follow" — same tag path (…>div>aside), different parents —
  //     so two genuinely different places were reported as one per-instance value;
  //   - "the invariant part of a label is its name" renamed data-testid=primaryColumn and
  //     data-testid=sidebarColumn into ONE place called "Column".
  // The fact that does hold: an element whose label SUMMARISES what it contains is not naming
  // itself, it is reporting its contents.
  const snapLabels = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'body', null, 0),
    mk(2, 'aside', { 'aria-label': 'Subscribe to Premium', role: 'complementary' }, 1),
    mk(3, 'a', { 'aria-label': 'Upgrade' }, 2),
    mk(4, 'div', { role: 'group', 'aria-label': '2 replies, 25 likes, 164617 views' }, 1),
    mk(5, 'div', null, 4),
    mk(6, 'div', { role: 'group', 'aria-label': '7 replies, 16 likes, 944 views' }, 1),
    mk(7, 'div', null, 6),
    mk(8, 'button', { 'aria-label': '2 Replies. Reply' }, 5),
    mk(9, 'button', { 'aria-label': '25 Likes. Like' }, 5),
    mk(10, 'button', { 'aria-label': '7 Replies. Reply' }, 7),
    mk(11, 'button', { 'aria-label': '16 Likes. Like' }, 7),
    mk(12, 'span', { 'aria-label': 'icon-reply' }, 8),
    mk(13, 'span', { 'aria-label': 'icon-like' }, 9),
    mk(14, 'span', { 'aria-label': 'icon-reply' }, 10),
    mk(15, 'span', { 'aria-label': 'icon-like' }, 11),
  ] };
  const tLab = regionTree(snapLabels);
  assert(/"Subscribe to Premium"/.test(tLab.outline),
    'an author-chosen label is a NAME and must survive, whatever else sits at that tag path');
  assert(tLab.outline.indexOf('\u27EA') >= 0,
    'a label that restates its own children is re-typed as a datum');
  assert(tLab.outline.indexOf('164617') < 0 && tLab.outline.indexOf('944') < 0,
    'the summary values themselves must not be printed as identity');
  assert(/2 Replies\. Reply/.test(tLab.outline),
    'and the children keep their own labels — the datum is the parent summary, not the control');

  // ★ A COLLAPSE GROUPS BY IDENTITY — IT DOES NOT HUNT FOR A PERIODIC RUN (2026-10-01).
  // The defect was the GROUPING MODEL, not the identity rule, and it took four measured
  // attempts against six real pages to separate the two:
  //   (a) name + shape, contiguous period scan -> books ok, bbc ok, x.com 137 lines / 7,013 B,
  //       because a feed whose children are [A, B, A, A, A, A, A] has no periodic run: the scan
  //       found period 3 spanning 4 and printed THREE full post templates for five items.
  //   (b) name alone -> merged books.toscrape's two div.page_inner boxes (header + content),
  //       because regionChild() takes the nearest region descendant at ANY depth. 17 -> 3 lines.
  //   (c) name + same DOM parent -> fixed books, broke bbc/stripe (193 vs 149 lines): a real
  //       list can wrap every item in its own single-child element (bbc's level2-navigation is
  //       ELEVEN li, each holding one anchor-inner-wrapper). My stated reason for rejecting this
  //       earlier — "7 of the x.com tweets sit behind an extra wrapper" — was WRONG; measured,
  //       it is 1 of 7 and they share one DOM parent.
  //   (d) name + parent-tag -> books ok, x.com 61 lines, but bbc 166 (worse than 150).
  //   (e) SHIPPED: keep name + shape (the identity rule that held on every one of the six pages)
  //       and group by it across the whole child list. Order comes from first appearance.
  // Whole-sample result, offline, one capture each: x.com/home 137->74 lines, bbc 150->105,
  // stripe 125->97, books 11->11, mdn 22->22, old.reddit 29->29. Nothing regressed.

  // (1) ORDER-INDEPENDENCE — an interleaved odd child must not fragment the group.
  const snapInter = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'section', { 'aria-label': 'Timeline' }, 0),
    mk(2, 'div', { 'data-testid': 'cell' }, 1),      // A
    mk(3, 'article', null, 2),
    mk(4, 'span', { 'aria-label': 'a1' }, 3),
    mk(5, 'div', { 'data-testid': 'cell' }, 1),      // B — same name, DIFFERENT shape
    mk(6, 'div', { 'data-testid': 'wrapper' }, 5),
    mk(7, 'article', null, 6),
    mk(8, 'span', { 'aria-label': 'b1' }, 7),
    mk(9, 'div', { 'data-testid': 'cell' }, 1),      // A
    mk(10, 'article', null, 9),
    mk(11, 'span', { 'aria-label': 'a2' }, 10),
    mk(12, 'div', { 'data-testid': 'cell' }, 1),     // A
    mk(13, 'article', null, 12),
    mk(14, 'span', { 'aria-label': 'a3' }, 13),
  ] };
  const tInter = regionTree(snapInter);
  assert(/REPEATS x3/.test(tInter.outline),
    'three of a kind must collapse to ONE template + x3 however they are interleaved');
  assert((tInter.outline.match(/data-testid=cell/g) || []).length === 2,
    'the odd child is shown once and the group once — NOT once per phase (the old scan gave 4)');

  // (2) SHAPE IS STILL PART OF IDENTITY — two same-named boxes whose subtrees differ are two
  // places. This is what keeps books.toscrape's header .page_inner and content .page_inner apart.
  const snapCross = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'body', { 'aria-label': 'Body' }, 0),
    mk(2, 'div', { 'data-testid': 'box' }, 1),
    mk(3, 'span', { 'aria-label': 'h1' }, 2),
    mk(4, 'div', { 'data-testid': 'box' }, 1),
    mk(5, 'div', { 'data-testid': 'wrapper' }, 4),
    mk(6, 'span', { 'aria-label': 'c1' }, 5),
  ] };
  const tCross = regionTree(snapCross);
  assert((tCross.outline.match(/data-testid=box/g) || []).length === 2,
    'two same-named boxes of DIFFERENT shape are two places (books.toscrape regressed here before)');
  assert(!/REPEATS/.test(tCross.outline), 'and they must not be reported as a repeat');

  // ...and an ALTERNATING run (A,B,A,B) is now TWO groups of two, each collapsing to one
  // template — which is the same description the old period scan produced for this shape, but
  // derived from identity rather than from finding a period. Both phases must still be shown:
  // an alternating run is not one thing, and merging its phases was the bug that hid the rail.
  const snapAnon = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'nav', { 'aria-label': 'Nav' }, 0),
    mk(2, 'div', { 'data-testid': 'row' }, 1),
    mk(3, 'a', { 'aria-label': 'L' }, 2),
    mk(4, 'span', { 'aria-label': 'ic' }, 3),
    mk(5, 'div', { 'data-testid': 'btn' }, 1),
    mk(6, 'button', { 'aria-label': 'B' }, 5),
    mk(7, 'span', { 'aria-label': 'ib' }, 6),
    mk(8, 'div', { 'data-testid': 'row' }, 1),
    mk(9, 'a', { 'aria-label': 'L' }, 8),
    mk(10, 'span', { 'aria-label': 'ic' }, 9),
    mk(11, 'div', { 'data-testid': 'btn' }, 1),
    mk(12, 'button', { 'aria-label': 'B' }, 11),
    mk(13, 'span', { 'aria-label': 'ib' }, 12),
  ] };
  const tAnon = regionTree(snapAnon);
  assert((tAnon.outline.match(/REPEATS x2/g) || []).length === 2,
    'an alternating run (A,B,A,B) is TWO groups of two, each collapsing to one template');
  assert(/data-testid=row/.test(tAnon.outline) && /data-testid=btn/.test(tAnon.outline),
    'and BOTH phases must be shown — an alternating run is not one thing');

  // ★ ...BUT TWO SIBLING PLACES WITH DIFFERENT HOOKS MUST BOTH SURVIVE (same live session).
  // x.com's primaryColumn and sidebarColumn sit side by side at ONE position carrying two
  // different data-testids. A first cut of the rule above deleted BOTH — the feed lost the
  // page's own name for it. Author-chosen words are not instance identifiers.
  // This also pins the pass-through fix: element 3 has exactly ONE child, but that child
  // opens into the composer/toolbar/timeline, so the column is not a wrapper.
  const snapSibs = { elements: [
    mk(0, 'html', null, null),
    mk(1, 'body', null, 0),
    mk(2, 'main', { role: 'main' }, 1),
    mk(3, 'div', { 'data-testid': 'primaryColumn' }, 2),
    mk(4, 'div', { 'aria-label': 'Home timeline' }, 3),
    mk(5, 'span', { 'aria-label': 'a' }, 4),
    mk(6, 'span', { 'aria-label': 'b' }, 4),
    mk(7, 'div', { 'data-testid': 'sidebarColumn' }, 2),
    mk(8, 'div', { 'aria-label': 'Trending' }, 7),
    mk(9, 'span', { 'aria-label': 'c' }, 8),
    mk(10, 'span', { 'aria-label': 'd' }, 8),
  ] };
  const t7 = regionTree(snapSibs);
  assert(/primaryColumn/.test(t7.outline), 'a named column must survive beside its sibling');
  assert(/sidebarColumn/.test(t7.outline), 'and so must the sibling');
  assert(/Home timeline/.test(t7.outline), 'and the column collapses with its label into one line');
});

test('browse: the WARM path and the COLD path must return the same shape', () => {
  // ★ Found 2026-10-01 while answering Ali's "is everything confluent and wired?". The warm
  // (cached) branch of browse returned index + hint but NOT `regions`, so calling browse twice
  // inside the 20s window gave the page model the first time and silently withheld it the
  // second — the same call answering differently depending on cache state. A cache that
  // changes the SHAPE of a result, not just its freshness, is a correctness bug.
  const src = SRV_SRC;
  const warmBlock = src.match(/if \(!o\.fresh\) \{[\s\S]*?\n    \}\n/);
  assert(warmBlock, 'the warm-path block must be findable');
  const b = warmBlock[0];
  assert(/cached: true/.test(b), 'this must be the warm branch');
  assert(/regions:/.test(b), 'the warm branch must return `regions` like the cold branch does');
  assert(/regionTree\(warm\.snap\)/.test(b), 'and it must compute them from the STORED snapshot');

  // both branches must mention regions
  const coldIdx = src.indexOf("reg(server, 'browse'");
  const cold = src.slice(coldIdx, coldIdx + 12000);
  assert(/regions: regions && regions\.outline/.test(cold), 'the cold branch must return regions');
});

test('diff: SVG drawing attributes are rendering, not structure', () => {
  // ★ Found live 2026-10-01 by scrolling x.com and reading the auto-DIFF back: a SCROLL reported
  // mutated:true with 89 "structure" changes, and the bulk of them were icons redrawing their
  // path data plus points/transform on other shapes. The page's structure had not moved — a
  // spinner span did exactly what it was told. Scroll churn arriving as a MUTATION is the very
  // thing the viewport group exists to prevent, so drawing attributes are classified as
  // rendering alongside class and style.
  //
  // The predicate lives INSIDE the collector template literal, so it is extracted and executed
  // here. That asserts its BEHAVIOUR instead of grepping its source, and it keeps the exclusion
  // honest in both directions: nothing structural may be swept in with the rendering attrs.
  const m = /function isPresentationAttr\(n\)\s*\{([\s\S]*?)\n  \}/.exec(DIFF_COLLECTOR);
  assert(m, 'isPresentationAttr must be findable inside the collector');
  // The predicate now reads a SHARED list (PRESENTATION_ATTRS) rather than spelling the names out,
  // so the evaluated function is handed the real array — that makes this test verify the list the
  // page actually uses, not a copy of it. The locator builder consumes the same constant, so one
  // array now governs both "is this readable as identity" and "is a change to it structural".
  const fn = new Function('n', 'RENDER_ATTRS', m[1]);
  const calls = (n) => fn(n, PRESENTATION_ATTRS);
  assert(Array.isArray(PRESENTATION_ATTRS) && PRESENTATION_ATTRS.indexOf('d') >= 0,
    'the shared list must carry the SVG drawing attributes');

  const rendering = ['class', 'style', 'dir', 'lang', 'data-anything', 'd', 'points',
    'transform', 'fill', 'stroke-width', 'stroke-dasharray', 'cx', 'cy', 'r', 'offset',
    'stop-color', 'preserveAspectRatio'];
  for (const n of rendering) assert(calls(n) === true, n + ' is rendering, not structure');

  const structural = ['role', 'id', 'value', 'disabled', 'checked', 'href', 'placeholder',
    'aria-selected', 'tabindex', 'type', 'name', 'title'];
  for (const n of structural) assert(calls(n) === false, n + ' is identity or state, NOT rendering');

  // ★ AND THE OTHER CONSUMER MUST USE THE SAME LIST (2026-10-01). The locator builder skips these
  // names, because a locator identifies an element and a paint instruction does not identify
  // anything. Measured: 199 KB of a 340 KB diff was locator text, mostly 1,200-char path[d=...].
  assert(/RENDER_ATTRS\.indexOf\(an\) >= 0/.test(COLLECTOR),
    'the locator builder must skip the same rendering attrs (else a 1,200-char path[d] becomes a locator)');
  assert(/var RENDER_ATTRS = \[/.test(COLLECTOR), 'and the list is interpolated into the collector');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
