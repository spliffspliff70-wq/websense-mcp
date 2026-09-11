#!/usr/bin/env node
/*
 * test-regressions.mjs — verify the v2.1-latchproof hub + server fixes.
 * Run: node test-regressions.mjs
 */
import assert from 'assert';
import { HubServer } from './src/hub.js';
import { planAutoClimb } from './src/climb.js';
import { summarizeRead } from './src/summarize.js';
import { uploadVerdict } from './src/upload.js';
import { SessionManager } from './src/session.js';
import { diffScan, identityKey, disambiguate, fieldChanges } from './src/incr.js';

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
  assert(r.reason.includes('target tab not OS-active'), 'reason: ' + r.reason);
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

// ── 2026-09-11b: performance + reload-path guards ───────────────────────────
// Measured baseline these exist to prevent from returning: explore_page's DEFAULT
// call had no action cap, walked every DOM node in document order, read
// getBoundingClientRect twice and getComputedStyle once PER ELEMENT, and
// hard-stalled at the 90s hub timeout above ~5,000 elements (556 els = 0.44s,
// 2,206 = 11s, 11,006 = TIMEOUT). Separately, `extension_reload` was handled by
// the service worker only, so whenever the hub routed it to the offscreen (the
// client that is live on strict-CSP sites) it fell through a switch and did
// nothing — while still reporting reloadSent:true.

test('cs: default action cap is BOUNDED (an unbounded default is the 90s bug)', () => {
  assert(/var DEFAULT_MAX_ACTIONS = \d+;/.test(CS_SRC), 'DEFAULT_MAX_ACTIONS is defined numerically');
  const m = CS_SRC.match(/var DEFAULT_MAX_ACTIONS = (\d+);/);
  assert(Number(m[1]) > 0, 'default cap must be > 0 (0 = unbounded = the regression)');
  assert(CS_SRC.includes('options.maxActions > 0 ? options.maxActions : DEFAULT_MAX_ACTIONS'),
    'the extraction path actually falls back to the bounded default');
  // The old code was `options.maxActions || 0` — that is the unbounded form.
  assert(!/const maxActions = options\.maxActions \|\| 0;/.test(CS_SRC),
    'the unbounded `maxActions || 0` default must not come back');
});

test('cs: work is bounded by an elements-SCANNED ceiling, not only returned actions', () => {
  assert(/var SCAN_CEILING = \d+;/.test(CS_SRC), 'SCAN_CEILING defined');
  assert(CS_SRC.includes('pass1.length < SCAN_CEILING'), 'attribute pass respects the ceiling');
  assert(CS_SRC.includes('cursorScanned < SCAN_CEILING'), 'cursor sweep respects the ceiling');
});

test('cs: candidates come from a SELECTOR, not a walk of every node', () => {
  assert(CS_SRC.includes('INTERACTIVE_SELECTOR'), 'selector list exists');
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
