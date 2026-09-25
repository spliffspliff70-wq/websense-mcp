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
// so it can be compiled for real, below.
import { COLLECTOR } from './src/snapshot.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-11b — cost attribution + single-DOM-query invariants
// ─────────────────────────────────────────────────────────────────────────────

test('cs: _collectSelectorHits does NOT walk the whole subtree (no double DOM query)', () => {
  const m = CS_SRC.match(/function _collectSelectorHits\([\s\S]*?\n  \}/);
  assert(m, '_collectSelectorHits exists');
  assert(!m[0].includes("querySelectorAll('*')"),
    '_collectSelectorHits must not do a `*` walk — the document-level walk runs once in ' +
    'collectInteractiveCandidates and is reused for the element count (it used to run twice)');
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

test('cs: the action loop (semantic work) is the bounded term via maxActions', () => {
  const m = CS_SRC.match(/const tGeo = Date\.now\(\);[\s\S]{0,400}?const actions = \[\]/);
  assert(m, 'geometry mark precedes the action loop');
  assert(m[0].includes('DEFAULT_MAX_ACTIONS'),
    'the action loop is capped by DEFAULT_MAX_ACTIONS (measured ~0.65ms/accepted action)');
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
    const firstLine = src.split('\r\n')[0];
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
  // IMPORTANT: the CS ships TWO 'upload_file' labels. The bridge dispatcher
  // (00-bridge-and-transport.js) deliberately returns a "requires the SW relay"
  // error; the REAL handler is the brace-form case in 70-capture-and-readers.js.
  // Matching the bare label picks the stub and the assertion fails for the wrong
  // reason — so match the brace form.
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
  assert(/const box = \(result && typeof result === 'object' && result\.data/.test(SRV_SRC),
    'classifyEffect must unwrap the {data:{…}} relay envelope before reading states');
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
    'evaluate script mode is blocked on EVERY page (extension CSP), not only strict sites');
  assert(!/JS dialogs: action:"accept"/.test(SRV_SRC),
    'the guide must not present JS dialog capture as a working surface');
  assert(/SYNTHETIC KeyboardEvents only/.test(SRV_SRC),
    'press_key must state it performs no default browser actions');
  assert(/TAB SCOPING MODEL/.test(SRV_SRC) && /jobs do NOT get separate profiles/.test(SRV_SRC),
    'the guide must state the one-profile/per-tab isolation model');
  assert(/REF LIFECYCLE/.test(SRV_SRC) && /RENUMBERS/.test(SRV_SRC),
    'the guide must warn that E# refs renumber and rot across re-renders');
  assert(/main_world func must be an EXPRESSION/.test(SRV_SRC) || /func must be an EXPRESSION/.test(SRV_SRC),
    'the guide must state main_world requires a function expression');
  assert(/is GLOBAL to the hub/.test(SRV_SRC),
    'the guide must warn that session state is shared across sessions');
  assert(/Pass tabId to target a specific tab/.test(SRV_SRC),
    'the guide must document navigate{tabId}');
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

test('delta: the guide tells the agent to read the DELTA block instead of re-exploring', () => {
  // A feature an agent cannot discover is not a feature — this is the mem-795 failure
  // mode (fixes on disk that never reach the model). The guide is served as the tool
  // RESULT (textResult), not the description, so it is NOT hit by the 110-char wire cap.
  assert(/DID IT LAND\?/.test(SRV_SRC), 'the guide must carry a DID IT LAND section');
  assert(/DELTA \(auto, after/.test(SRV_SRC), 'the guide must name the DELTA block format');
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
// "THE 20 TOOLS", with 31 tools registered — 11 of them undocumented. This guard makes the
// count self-enforcing so the docs cannot drift silently again.
test('docs: the guide states the TRUE tool count and lists every registered tool', () => {
  const regs = [...SRV_SRC.matchAll(/reg\(server, '([a-z_]+)'/g)].map((m) => m[1]);
  assert(regs.length >= 30, 'expected the full tool surface, got ' + regs.length);
  assert(SRV_SRC.includes('Guide (' + regs.length + ' consolidated tools)'),
    'the guide header must state the real count (' + regs.length + ')');
  assert(SRV_SRC.includes('THE ' + regs.length + ' TOOLS'),
    'the guide tool-list heading must state the real count');
  const missing = regs.filter((n) => !new RegExp('^  ' + n + '\\s', 'm').test(SRV_SRC));
  assert(missing.length === 0, 'registered but undocumented in the guide: ' + missing.join(', '));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
