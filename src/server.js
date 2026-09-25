#!/usr/bin/env node
/**
 * WebSense MCP — Server Entry Point
 * Supports both stdio and HTTP transport modes.
 *
 * stdio mode (default):  node src/server.js
 * HTTP mode (multi-client): node src/server.js --http [--http-port 9222]
 *
 * In HTTP mode, the server runs as a persistent background service.
 * Multiple MCP clients (Hermes, Cline, Cursor) connect to http://localhost:9222/mcp.
 * The extension connects to the WS hub once and stays connected.
 *
 * Architecture: MCP Client → (stdio|HTTP) → This server → WebSocket Hub → Chrome Extension → Content Script → DOM
 * All tools are CSP-safe — no eval. All DOM work happens in the content script's isolated world.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { COLLECTOR, putSnapshot, getSnapshot, sliceSnapshot, snapshotStats } from './snapshot.js';
import { HubServer } from './hub.js';
import { SessionManager } from './session.js';
import { exportMermaid } from './mermaid.js';
import { summarizeRead } from './summarize.js';

function parsePort() {
  const eq = process.argv.find((a) => a.startsWith('--port='));
  if (eq) return parseInt(eq.split('=')[1], 10);
  const i = process.argv.indexOf('--port');
  if (i !== -1 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return parseInt(process.env.PORT || '38401', 10);
}
const PORT = parsePort();
const USE_HTTP = process.argv.includes('--http');
const HTTP_PORT = parseInt(process.argv.find(a => a.startsWith('--http-port='))?.split('=')[1] || '9222');

// Chrome: plain ws:// on 38401. 127.0.0.1 is localhost-exempt from
// mixed-content blocking, so ws:// works from HTTPS pages (lemonsqueezy etc.)
// AND from the offscreen document. No TLS needed — a self-signed cert on
// wss://127.0.0.1 is rejected by Chrome's WebSocket, which breaks the bridge.
const hubChrome = new HubServer(PORT);
// 2026-09-25: session state (exploration map + history) used to be ONE
// process-wide SessionManager, so `session{action:"reset"}` wiped every other
// job's history mid-task and one job's steps showed up in another's map. That
// was documented as a limitation ("session reset clears everyone's history").
//
// It is a singleton-by-accident, not a design constraint: the server already
// runs each request inside sessionCtx (added for tab isolation), and each MCP
// session owns its own McpServer object. So keep ONE SessionManager PER MCP
// SESSION, resolved through the same context, and leave the 36 `session.`
// call sites untouched — they read the per-request instance.
//
// Fallback matters: stdio mode has exactly one session, and any code path that
// runs outside the context must still get a working manager rather than null.
const SESSIONS_BY_SERVER = new WeakMap();
let fallbackSession = null;
function getSession() {
  const st = sessionCtx.getStore();
  const srv = st && st.server;
  if (srv) {
    let s = SESSIONS_BY_SERVER.get(srv);
    if (!s) { s = new SessionManager(); SESSIONS_BY_SERVER.set(srv, s); }
    return s;
  }
  if (!fallbackSession) fallbackSession = new SessionManager();
  return fallbackSession;
}

// 2026-09-25 TEST SUPPORT. getActiveHub() is a deliberate THIN ALLOW-LIST (that
// thinness is why the old doctor and the reload census probe once failed
// silently). The raw_op audit harness needs the hub's client registry and its
// forced-transport send, so this exposes the real instance for that one purpose.
function getRawHub() { return hubChrome; }

function getActiveHub() {
  // Per-session stamped wrapper: send() routes page ops to THIS session's
  // bound tab via the hub's tabId-aware activeClient(). `connected` is
  // forwarded for health checks; `stats()` exposes hub internals for
  // websense_doctor (the old doctor read hub.port/hub.clients off this thin
  // wrapper and always TypeError'd).
  // NOTE (2026-09-11d): this wrapper is a THIN allow-list. Anything not forwarded
  // here is invisible to every tool handler — which is exactly how the old doctor
  // "always TypeError'd" (it read hub.port/hub.clients off this object), and how
  // the first version of the extension_reload census probe silently fell back to
  // its legacy path instead of engaging. `census` is forwarded explicitly now.
  return {
    connected: hubChrome.connected,
    send: (cmd) => hubChrome.send(withSessionTab(cmd)),
    stats: () => hubChrome.stats(),
    census: () => hubChrome.census(),
  };
}

function textResult(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

// ═══ EFFECT VERDICT (2026-08-25 — borrowed from cua-driver's verify ladder) ═══
// Classify whether an interaction actually changed page state. Synthetic
// clicks/keys are frequently ignored by React handlers; without this the agent
// retries blindly. effect: confirmed = observable state change;
// suspected_noop = before/after identical; unverifiable = no states to compare.
function classifyEffect(result) {
  if (!result || result.success === false) return 'failed';
  // 2026-09-25 FIX: the RELAY path wraps payloads in {type,id,success,data:{…}}
  // (hub round-trip via the offscreen), so beforeState/afterState live one level
  // down. This function only ever looked at the top level, so on every relayed
  // op it saw NO states and returned 'unverifiable' — which then triggered the
  // automatic real_click escalation even for actions that demonstrably landed
  // (measured: identical-state click → 'unverifiable' + real_click recommended,
  // while a differing-state action ALSO reported unverifiable). Unwrap first,
  // exactly like summarizeDelta does for the same envelope.
  const box = (result && typeof result === 'object' && result.data && typeof result.data === 'object') ? result.data : result;
  const b = box.beforeState, a = box.afterState;
  if (!b && !a) return 'unverifiable';
  if (b && a) {
    // URL change is the strongest signal
    if ((a.url || '') !== (b.url || '')) return 'confirmed';
    // any top-level field divergence in quick state
    try {
      const bk = JSON.stringify(b), ak = JSON.stringify(a);
      if (bk !== ak) return 'confirmed';
    } catch (_) { /* circular etc */ }
    return 'suspected_noop';
  }
  return 'unverifiable';
}

// ═══ ARG GUARD (2026-09-11d) ═══
// The MCP SDK validates the SCHEMA (types), but every action-specific parameter is
// declared `.optional()` — so a missing one surfaces later as an opaque runtime
// error (form upload: readFileSync(undefined) -> 'The "path" argument must be of
// type string') or, worse, as a silent no-op. Fail HERE instead, naming the
// parameter and echoing what WAS received — which is what exposes a typo like
// filepath/filePath, because unknown keys are STRIPPED by the schema before the
// handler ever runs, so the handler cannot notice them itself.
function requireArgs(tool, o, spec) {
  const missing = Object.keys(spec).filter((n) => o[n] === undefined || o[n] === null || o[n] === '');
  if (missing.length) {
    const err = new Error('missing required argument(s) for ' + tool + ': '
      + missing.map((n) => n + ' -- ' + spec[n]).join('; '));
    err.detail = {
      reason: 'missing-argument',
      tool,
      missing,
      expected: spec,
      received: Object.keys(o),
      hint: 'Parameters not in this tool\'s schema are silently dropped before the handler runs, so check "received" for a typo.',
    };
    throw err;
  }
}

// Decode an image's pixel size straight from its data-URL header (no deps).
// The two screenshot paths return DIFFERENT geometries: captureVisibleTab gives
// the whole visible tab (2560x1271 in this environment) while the debugger
// fallback gives the rendered page (2560x1215). A consumer mapping page
// coordinates to pixels must not assume one, so report it instead of making
// every caller hand-parse PNG/JPEG headers (2026-09-11).
function imageSize(dataUrl) {
  try {
    const b = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {              // PNG
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {               // JPEG
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xFF) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch (_) { /* not an image / truncated */ }
  return {};
}

// A semantic intent search that matches NOTHING returns an empty list that is
// indistinguishable from "this page has no interactive elements" — a false
// negative that reads as a real result. (2026-09-11: explore_page({intent:"full"})
// looked like an empty page; "full" is a BOOLEAN flag of explore_page, not an
// intent.) Zero hits must say so.
function annotateIntentResult(r, kind, q) {
  // Results arrive EITHER bare or wrapped as {type,id,success,data:{...}} depending
  // on the relay hop (find_intent comes back wrapped). Inspect both levels — the
  // first version of this helper only looked at the top level, so it silently
  // never applied, which is the same "a check nothing reads" failure it exists to
  // prevent. Verified against a live zero-hit call (2026-09-11d).
  const box = (r && typeof r === 'object' && r.data && typeof r.data === 'object') ? r.data : r;
  const n = (box && typeof box === 'object')
    ? (typeof box.count === 'number' ? box.count
      : Array.isArray(box.matches) ? box.matches.length
      : Array.isArray(box.actions) ? box.actions.length : null)
    : null;
  if (n !== 0) return r;
  const note = 'no elements matched ' + kind + ' "' + q + '" -- this is a ZERO-HIT SEMANTIC SEARCH, not an empty page. '
    + 'If you passed a FLAG as an intent (e.g. intent:"full" -- "full" is a BOOLEAN parameter of explore_page, not an intent), '
    + 'call explore_page again with no intent/goal for the full page map.';
  if (box === r) return Object.assign({}, r, { matched: 0, note });
  return Object.assign({}, r, { data: Object.assign({}, box, { matched: 0, note }) });
}

// Wrap any tool handler so errors return a result instead of crashing the server
function safeHandler(fn) {
  return async (args) => {
    try { return withBindingNote(await fn(args)); }
    catch (err) {
      const out = { success: false, error: err && err.message };
      // Fold back the structured failure detail the hub preserved (2026-09-11c),
      // so a failure keeps the hop / reason / hint / tabId it was diagnosed with
      // instead of collapsing to a single opaque string. Additive: existing
      // consumers still read `error`.
      if (err && err.detail && typeof err.detail === 'object') {
        for (const k of Object.keys(err.detail)) { if (!(k in out)) out[k] = err.detail[k]; }
      }
      return textResult(out);
    }
  };
}
// ═══ PER-SESSION TAB BINDING (Ali directive 2026-08-12 — concurrency fix) ═══
// The hub is SHARED across all MCP sessions, and the extension's boundTabId /
// selectedTabId are GLOBAL — so session A's bind/navigate overwrote session
// B's routing target (workers hijacked the collector's login tab). Fix:
// each session's binding is stored per sessionId, and the HTTP request
// handler runs the request inside an AsyncLocalStorage context carrying that
// binding. getActiveHub().send stamps the session's tabId onto every hub
// command so the hub routes to THAT session's tab — never the global one.
import { AsyncLocalStorage } from 'node:async_hooks';
const sessionCtx = new AsyncLocalStorage();
// ── CROSS-SESSION TAB CLAIMS (2026-09-21) ────────────────────────────────────
// Which tab each live MCP session has pinned. Keyed by the per-session McpServer
// object (unique per HTTP session, and already carried in the ALS store).
// WHY: an unbound session used to inherit the hub GLOBAL selectedTabId. That cursor
// is moved by ANY activate:true / tabs{focus} / OS tab switch (hub.js tab_activated
// and `activated` handlers), so an unbound session could silently operate on a tab
// another agent owned. With this registry we can tell "the cursor is mine/free" from
// "the cursor belongs to someone else" — the difference between safe and hijacking.
const boundTabsBySession = new Map(); // serverObject -> { tabId, at }
// A claim is only evidence of a LIVE owner if that session touched its tab recently.
// Python/script clients exit without a clean MCP close, so transport.onclose does not
// always fire and a dead session's claim lingered — producing false "bound to a
// DIFFERENT live session" refusals for later callers (found 2026-09-21).
const CLAIM_TTL_MS = 10 * 60 * 1000;

function claimTab(srv, tid) {
  if (!srv || tid == null) return;
  boundTabsBySession.set(srv, { tabId: Number(tid), at: Date.now() });
}

// Return the OTHER session that currently owns `tid`, ignoring (and evicting) stale claims.
function liveClaimOwner(srv, tid) {
  if (tid == null) return null;
  const now = Date.now();
  for (const [s, c] of boundTabsBySession) {
    if (!c) { boundTabsBySession.delete(s); continue; }
    if (now - (c.at || 0) > CLAIM_TTL_MS) { boundTabsBySession.delete(s); continue; }
    if (s !== srv && Number(c.tabId) === Number(tid)) return s;
  }
  return null;
}
function sessionTabOf() {
  const st = sessionCtx.getStore();
  return st && st.boundTabId != null ? st.boundTabId : null;
}
// Stamp the session's bound tab onto a hub command (page ops only — tab ops
// like navigate/switch_tab carry their own explicit tabId).
// Ops that carry their OWN explicit tabId and must never be stamped.
// NOTE: 'navigate' is deliberately NOT here (removed 2026-08-13, Ali directive —
// session isolation): each session's navigate is stamped with ITS OWN bound
// tabId, so a worker's navigate never steals another session's tab.
const SESSION_TAB_OPS = new Set(['list_tabs','switch_tab','close_tab',
  'list_frames','download_state','tab_contents','bind_tab','transfer_text',
  'switch_tab_and_read','list_windows','focus_window','move_tab_to_window',
  'ax_state','ax_read','ax_click','ax_type',
  'get_window_tabs','get_tab_info','get_active_tab','cookie_op','download_op','respawn_offscreen','extension_reload']);
// 2026-09-25: 'main_world_exec' was in this set, which is the TAB-MANAGEMENT
// set — those ops are never stamped with the session's bound tab. The main_world
// TOOL resolves its own tab before sending, so nothing noticed; but the
// evaluate{script} CSP fallback sends main_world_exec un-stamped and it died
// with "main_world_exec: tabId required". It is a PAGE op and belongs here.

// Surface the auto-bind to the CALLER (safeHandler calls this on every result).
// Without this the fix would be invisible again — which is the exact failure
// mode we spent 2026-09-20 chasing.
function withBindingNote(res) {
  const st = sessionCtx.getStore();
  if (!st || !st.autoBound || st.autoBoundNotified) return res;
  st.autoBoundNotified = true;
  const b = st.autoBound;
  const note = 'SESSION WAS UNBOUND — auto-bound to tab ' + b.tabId + ' for this ' + b.op + '. ' +
    'An unbound session previously fell back to the hub GLOBAL selected tab, which follows the ' +
    'OS-frontmost tab (and whichever tab any other session last bound/activated), so it could ' +
    'silently operate on ANOTHER session\'s tab. It is now pinned to tab ' + b.tabId + '. To choose ' +
    'your own tab: navigate (binds automatically) or tabs{action:"bind", tabId}.';
  try {
    if (res && Array.isArray(res.content)) res.content.push({ type: 'text', text: 'WARNING: ' + note });
  } catch (_) { /* never let a note break a result */ }
  console.error('[websense] ' + note);
  return res;
}

function withSessionTab(cmd) {
  const st = sessionCtx.getStore();
  const tid = st && st.boundTabId != null ? st.boundTabId : null;
  if (tid != null && cmd && cmd.type && !cmd.tabId) {
    // Page ops (click/type/explore/evaluate/extract/page_state/...) route by
    // tabId in the hub's activeClient(). Tab ops keep their own semantics.
    if (!SESSION_TAB_OPS.has(cmd.type)) cmd.tabId = tid;
    return cmd;
  }
  // ── UNBOUND PAGE OP — the leak (fixed 2026-09-20) ─────────────────────────
  // Previously an unbound session stamped NOTHING, so the hub fell back to its
  // GLOBAL selectedTabId. That cursor follows the OS-frontmost tab and whatever
  // tab any other session last identified/activated — so a fresh session
  // (typically a cron worker that had not navigated yet) silently operated on
  // ANOTHER session's tab. Reproduced live 2026-09-20: an unbound third session
  // read session B's example.org tab with no error and no signal.
  // Ali's design intent is "1 tab to 1 caller/agent ... parallel ... no
  // foreground". Rather than breaking every caller that reads before it
  // navigates (many crons do), bind THIS session to the tab it is about to use
  // and pin the command to it: routing becomes explicit and the session stops
  // being unbound, and safeHandler tells the caller it happened.
  if (tid == null && st && st.server && cmd && cmd.type && !cmd.tabId
      && !SESSION_TAB_OPS.has(cmd.type)) {
    // A BINDING op (navigate) creates/reuses this session's OWN tab, so it must never
    // inherit the shared cursor. Return it UNSTAMPED and let the navigate handler force a
    // fresh tab (newTab) and bind this session to the result — that is Ali's "1 tab to 1
    // caller" model, and it is what stops an unbound session from navigating ANOTHER
    // agent's tab to its own URL.
    if (cmd.type === 'navigate') return cmd;
    let sel = null;
    try { sel = (hubChrome && hubChrome.selectedTabId != null) ? Number(hubChrome.selectedTabId) : null; } catch (_) {}

    // Is the cursor tab already OWNED by a different LIVE session?
    // `navigate` is EXEMPT: it is the BINDING op — it creates/reuses this session's own
    // tab — so refusing it deadlocked every fresh session, because the refusal message
    // told callers to "call navigate first" while navigate was itself blocked. Found
    // live 2026-09-21: a fresh session's navigate AND explore both returned the refusal,
    // leaving no path forward. A binding op can never inherit, so there is nothing to refuse.
    const isBindingOp = cmd.type === 'navigate';
    const owner = (!isBindingOp && sel != null) ? liveClaimOwner(st.server, sel) : null;
    if (owner) {
      // REFUSE, don't inherit. This is the hijack case: the global cursor moved
      // (activate:true / tabs{focus} / an OS tab switch — hub.js tab_activated and
      // `activated` handlers) onto a tab another session pinned. Silently using it
      // would read or act on another agent's tab with no error and no signal.
      // Throwing surfaces through safeHandler as a normal tool error.
      throw new Error(
        'Unbound session refused a page op: the hub routing cursor points at tab ' + sel +
        ', which is bound to a DIFFERENT live session. Using it would silently operate on ' +
        'another agent\'s tab. Fix: call navigate (binds a tab to THIS session) or ' +
        'tabs{action:"bind", tabId} first. Before 2026-09-21 this fell through silently to ' +
        'the shared cursor, which is why tabs appeared hijacked between concurrent runs.'
      );
    }
    if (sel != null) {
      st.boundTabId = sel;              // this session is now pinned
      st.server._wsBoundTabId = sel;    // ...persisted for its later requests
      claimTab(st.server, sel);
      cmd.tabId = sel;                  // ...and this command routes explicitly
      st.autoBound = { tabId: sel, op: cmd.type, at: Date.now() };
    }
  }
  // Keep the claim registry fresh for any session that has a binding (refreshes `at`,
  // which is what makes the TTL honest about who is actually still working).
  if (tid != null && st && st.server) claimTab(st.server, tid);
  return cmd;
}
// Wrap hub.send so every command is stamped with the calling session's tab.
function stampedHubSend(cmd) {
  return hubChrome.send(withSessionTab(cmd));
}
// ═══ SCHEMA MINIFIER (Ali directive 2026-08-18) ═══
// WebSense exposes ~65 tools; raw SDK schemas cost ~10k+ tokens per request.
// The SDK converts zod -> JSON schema internally, so we post-process the
// tools/list WIRE OUTPUT (installSchemaMinifier below): strip structural fat
// ($schema, additionalProperties), clip tool descriptions, drop/trim param
// descriptions. ALL tool names, params, types, enums and required fields
// survive — only prose is shortened. Full instructions remain in the tools'
// RETURN values (websense_guide, explore_page, etc.). The SDK's own arg
// validation is untouched (registration still uses zod).
const DESC_CAP = Number(process.env.WEBSENSE_DESC_CAP || 110);   // per-tool description cap (chars)
const PARAM_CAP = Number(process.env.WEBSENSE_PARAM_CAP || 40);  // per-param description cap (chars)
const FRAME_DESC = 'frameId (omit=top)';

// Params whose names are self-evident — drop their description entirely.
const SELF_EVIDENT = new Set([
  'ref', 'text', 'url', 'value', 'key', 'selector', 'filePath', 'direction', 'amount',
  'limit', 'tabId', 'windowId', 'name', 'role', 'question', 'format', 'button',
  'seconds', 'offset', 'maxLen', 'x', 'y', 'action', 'index', 'query', 'comment',
]);

// Tab/window ops + global utilities whose handlers never read frameId.
const NO_FRAME = new Set([
  'websense_guide', 'navigate', 'tabs', 'status', 'wait', 'evaluate', 'ax',
  'screenshot', 'dialog', 'session', 'network_log', 'console_log', 'clipboard', 'inspect',
]);

function clipDesc(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s;
  const cut = s.slice(0, cap);
  const p = cut.lastIndexOf('.');
  return (p > cap * 0.6 ? cut.slice(0, p + 1) : cut) + '…';
}

// Recursive: strip structural fat + clip every description in the JSON schema.
function processSchema(node) {
  if (Array.isArray(node)) { node.forEach(processSchema); return; }
  if (!node || typeof node !== 'object') return;
  delete node.$schema;
  delete node.additionalProperties;
  if (typeof node.description === 'string') node.description = clipDesc(node.description, PARAM_CAP);
  for (const k of Object.keys(node)) processSchema(node[k]);
}

// Recursive: drop descriptions for params whose names are self-evident.
function dropSelfEvident(node) {
  if (!node || typeof node !== 'object') return;
  if (node.properties && typeof node.properties === 'object') {
    for (const k of Object.keys(node.properties)) {
      const p = node.properties[k];
      if (SELF_EVIDENT.has(k) && p && typeof p === 'object') delete p.description;
      dropSelfEvident(p);
    }
  }
}

// Helper to register a tool with automatic error wrapping
// ═══ ACTION DELTA — flag "did it land" PROGRAMMATICALLY (Ali 2026-09-21) ═══
// Ali's directive, verbatim: "if you did the dif should notify the model that a difference
// exists it should be flagged so when a paste action for example (not limited to) is done
// the model doesn't have to spend time and tokens to ask did it land it should be flagged
// programatically."
//
// BEFORE: the only way to KNOW an input landed was an extra explore_page{incremental:true}
// round-trip — a separate tool call plus its tokens, per action. The weak `effect` verdict
// (beforeState/afterState) could not see mutations that change neither URL nor title — the
// proven case is liking a post (mem 800: effect:unverifiable while the like DID register).
//
// NOW: every MUTATING op automatically carries a DOM-DIFF verdict, computed from the
// content script's own per-tab scan cache and its incremental differ — the same mechanism
// the model would otherwise have had to call for itself. That mechanism compares real
// element FINGERPRINTS (value/checked/disabled/expanded/... per element), so it catches
// changes that beforeState/afterState structurally cannot.
//
// COST NOTE: this is NOT free — it adds one hub round-trip per mutating op (~20-60ms, and
// the delta payload itself is a few hundred bytes). Callers who don't want it pass
// verify:false to skip the diff for that call.
const DELTA_OPS = new Set(['click', 'type_text', 'form', 'press_key',
  'real_click', 'real_paste', 'main_world', 'evaluate', 'dialog']);

// Turn an incremental scan result into the compact verdict we hand back.
// CRITICAL: a first call on a tab has no baseline, so the content script ESCALATES and
// returns a FULL SAG. We must NEVER forward that (it is huge, and it would silently
// replace the payload the caller asked for). We report honestly that we could not tell.
function summarizeDelta(res) {
  if (!res || typeof res !== 'object') return { mutated: null, reason: 'no scan result' };
  // Hub replies are WRAPPED: {type, id, success, data:{...}}. The delta arrays live under
  // .data. Reading them off the top level silently reports "no baseline" FOREVER — the
  // exact bug this function shipped with on first write (caught by test/action-delta-test.py,
  // where every call claimed no baseline even though inc2+ were real deltas).
  const d = (res && typeof res.data === 'object' && res.data) ? res.data : res;
  const isDelta = Array.isArray(d.added) && Array.isArray(d.changed) && Array.isArray(d.removed);
  if (!isDelta) {
    return {
      mutated: null,
      reason: 'no scan baseline existed for this tab, so this action seeded one — ' +
        'it is NOT verifiable. The NEXT action on this tab will be flagged.',
    };
  }
  const n = d.added.length + d.changed.length + d.removed.length;
  const out = {
    mutated: n > 0,
    changed: d.changed.length,
    added: d.added.length,
    removed: d.removed.length,
    unchanged: d.unchangedCount,
  };
  if (n > 0) {
    // Only the mutated elements, and only the fields that matter, so the block stays small.
    out.elements = []
      .concat(d.changed.slice(0, 4).map((c) => {
        const a = c.action || {};
        const e = { ref: a.ref, label: String(a.label == null ? '' : a.label).slice(0, 60), kind: 'changed' };
        if (a.value !== undefined && a.value !== '') e.value = String(a.value).slice(0, 60);
        if (a.checked !== undefined) e.checked = a.checked;
        if (Array.isArray(c.changes) && c.changes.length) {
          e.fields = c.changes.slice(0, 4).map((f) => (typeof f === 'string' ? f : (f && (f.field || f.name)) || '?'));
        }
        return e;
      }))
      .concat(d.added.slice(0, 3).map((a) => ({
        ref: a.ref, label: String(a.label == null ? '' : a.label).slice(0, 60), kind: 'added',
      })))
      .concat(d.removed.slice(0, 3).map((r) => ({
        ref: r.ref, label: String(r.label == null ? '' : r.label).slice(0, 60), kind: 'removed',
      })));
  } else {
    // 2026-09-25: the old hint said mutated:false means NOT LANDED. It does not.
    // The fingerprint covers INTERACTIVE elements only, so these all report
    // mutated:false while genuinely landing: non-action text changes, async
    // handlers that settle after the diff, focus-only clicks, downloads, and
    // _blank opens. Say what the signal actually means and what to read instead.
    out.hint = 'NO INTERACTIVE-ELEMENT CHANGE detected. This is NOT proof the action did not land — the diff ' +
      'fingerprints interactive elements only. It CAN miss: text/content changes outside those elements, async ' +
      'handlers that settle after this diff, focus-only clicks, downloads, and new-tab opens. Confirm with a real ' +
      'read (status / explore_page / read{diff} / main_world / the downloads or tabs store) before concluding ' +
      '"not landed" and before retrying with a different approach.';
  }
  return out;
}

// Wrap a mutating handler so its result carries the diff verdict as a SECOND content block
// (a separate block, so the JSON payload the caller asked for can never be corrupted).
function withDelta(name, handler) {
  if (!DELTA_OPS.has(name)) return handler;
  return async (args) => {
    const res = await handler(args);
    if (args && args.verify === false) return res;
    let delta;
    try {
      const inc = await getActiveHub().send({
        type: 'explore_page', incremental: true, includeContent: false,
      });
      delta = summarizeDelta(inc);
    } catch (err) {
      delta = { mutated: null, reason: 'delta unavailable: ' + (err && err.message) };
    }
    const line = 'DELTA (auto, after ' + name + '): ' + JSON.stringify(delta);
    try {
      if (res && Array.isArray(res.content)) res.content.push({ type: 'text', text: line });
      else return { content: [{ type: 'text', text: line }] };
    } catch (_) { /* never let the flag break a result */ }
    return res;
  };
}

function reg(server, name, def, handler) {
  const inputSchema = def.inputSchema || {};
  const merged0 = NO_FRAME.has(name)
    ? inputSchema
    : { ...inputSchema, frameId: z.number().optional().describe(FRAME_DESC) };
  // Mutating ops gain verify:false so a caller can opt out of the automatic delta diff.
  const merged = DELTA_OPS.has(name)
    ? {
      ...merged0,
      verify: z.boolean().optional().describe(
        'Set false to SKIP the automatic post-action DOM diff. By default every mutating op '
        + 'returns a DELTA block (mutated true/false) so you can tell whether it landed '
        + 'without spending a second call.'),
    }
    : merged0;
  server['registerTool'](name, { ...def, inputSchema: merged }, safeHandler(withDelta(name, handler)));
}

// Wrap the SDK's tools/list handler: post-process the WIRE OUTPUT so every
// client sees a slim schema. Registration + arg validation stay untouched.
function installSchemaMinifier(server) {
  const low = server.server;
  if (!low || typeof low.setRequestHandler !== 'function') return;
  const orig = low._requestHandlers && low._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  if (typeof orig !== 'function') return;
  low.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await orig(request, extra);
    if (result && Array.isArray(result.tools)) {
      for (const t of result.tools) {
        if (typeof t.description === 'string') t.description = clipDesc(t.description, DESC_CAP);
        if (t.inputSchema && typeof t.inputSchema === 'object') {
          processSchema(t.inputSchema);
          dropSelfEvident(t.inputSchema);
          if (t.inputSchema.properties && t.inputSchema.properties.frameId) {
            t.inputSchema.properties.frameId.description = FRAME_DESC;
          }
        }
      }
    }
    return result;
  });
}

// ═══ Windows-control bridge helpers (native OS dialog dismissal) ═══
function escapeSendKeys(s) {
  // SendKeys special chars must be wrapped in braces
  return String(s == null ? '' : s).replace(/([+^%~()[\]{}])/g, '{$1}');
}
function sendKeysForWindows(key) {
  const map = { enter:'{ENTER}', return:'{ENTER}', escape:'{ESC}', tab:'{TAB}', space:' ', backspace:'{BACKSPACE}', delete:'{DEL}', up:'{UP}', down:'{DOWN}', left:'{LEFT}', right:'{RIGHT}', f5:'{F5}', f12:'{F12}', esc:'{ESC}' };
  if (map[key]) return map[key];
  const m = /^([a-z]+)\+(.+)$/i.exec(key || '');
  if (m) { const mod = m[1].toLowerCase(); const modChar = mod === 'ctrl' ? '^' : mod === 'alt' ? '%' : mod === 'shift' ? '+' : mod[0].toUpperCase(); return '(' + modChar + m[2].toUpperCase() + ')'; }
    return key;
  }

  // P0#3 (2026-08-31): genuine OS-level left-click at PHYSICAL screen coords.
  // PowerShell user32 mouse_event — the same trust class as a human click, so
  // React-controlled submits (which ignore synthetic dispatched events) fire.
  // DPI note: the CS screen_center tool already multiplies by devicePixelRatio,
  // so `x`/`y` here are physical pixels (what the OS wants).
  // PLATFORM GUARD (OSS release): Windows-only enhancement. On macOS/Linux
  // this returns an honest error and the tool falls back to reporting the
  // escalation hint (no crash, no silent fake success).
  // FOREGROUND GUARD (2026-08-31, Ali: "why is foreground stolen by factory
  // agents?"): the mouse_event click lands on whatever window is FRONTMOST at
  // the OS level. Even with the active-tab guard, a sibling worker churning
  // tabs could make the check pass while the user's app is actually in front.
  // This checks the foreground window's owning process is Chrome BEFORE moving
  // the cursor — if the user is in a non-Chrome app, it refuses (honest error,
  // no click into the user's active app).
  function realClickAt(x, y) {
    if (process.platform !== 'win32') {
      throw new Error('autoClimb real-click is Windows-only (uses user32 mouse_event via PowerShell). On ' + process.platform + ', deliver the OS click with your platform\'s native automation and retry.');
    }
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      'Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;' +
      'public class WS_MOUSE{[DllImport(\\\\"user32.dll\\\\")]public static extern IntPtr GetForegroundWindow();' +
      '[DllImport(\\\\"user32.dll\\\\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);' +
      '[DllImport(\\\\"user32.dll\\\\")]public static extern bool SetCursorPos(int X,int Y);' +
      '[DllImport(\\\\"user32.dll\\\\")]public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,System.UIntPtr dwExtraInfo);}' +
      '$fg=[WS_MOUSE]::GetForegroundWindow();' +
      '$fgPid=0;[void][WS_MOUSE]::GetWindowThreadProcessId($fg,[ref]$fgPid);' +
      '$p=Get-Process -Id $fgPid -ErrorAction SilentlyContinue;' +
      'if($p -and $p.ProcessName -notlike "*chrome*"){throw "foreground window is $($p.ProcessName) (PID $fgPid), not Chrome — refusing OS click into the user\'s active app"};' +
      '[WS_MOUSE]::SetCursorPos(' + Math.round(x) + ',' + Math.round(y) + ');' +
      'Start-Sleep -Milliseconds 60;' +
      '[WS_MOUSE]::mouse_event(0x0002,0,0,0,[System.UIntPtr]::Zero);' + // LEFTDOWN
      'Start-Sleep -Milliseconds 40;' +
      '[WS_MOUSE]::mouse_event(0x0004,0,0,0,[System.UIntPtr]::Zero);'; // LEFTUP
    execSync('powershell -NoProfile -NonInteractive -Command ' + JSON.stringify(ps), { timeout: 12000, windowsHide: true });
  }

  // P0#3: auto-climb decision — only real-click when the TARGET tab is the
  // OS-active tab (multi-agent churn guard, mem 385: real input landing on a
  // sibling worker's tab is the #1 wrong-click source).
  function isActiveTabResult(activeResult) {
    return !!(activeResult && activeResult.success && activeResult.tab && activeResult.tab.id != null);
  }


// ═══ CONSOLIDATED TOOL SURFACE (2026-08-30, Ali directive: 65 → 20) ═══
// Every one of the 65 original capabilities is preserved. Each consolidated
// tool maps params onto the SAME hub command types the content script already
// implements — zero extension-side changes. Old one-tool-per-verb names are
// gone; the mapping lives in websense_guide + README.

function registerAllTools(server) {

  // ═══ 1. GUIDE ═══
  reg(server, 'websense_guide', {
    description: 'START HERE. Full usage guide for the 31 consolidated WebSense tools: explore, read, click, type, form, scroll, tabs, wait, evaluate, main_world, ax, snapshot map/slice, real input, status. Call once before using other tools.',
  }, async () => {
    return textResult(`WebSense MCP — Guide (31 consolidated tools)
==============================================
Non-vision web automation via Chrome extension. No CDP debug port, no bot detection. CSP-safe. React/Vue/Angular compatible.

THE LOOP: explore_page → pick refs → act (click/type_text/form/scroll) → read result → repeat.

DID IT LAND? Every mutating op (click, type_text, form, press_key, real_click, real_paste, main_world, evaluate, dialog) returns a SECOND block: DELTA (auto, after <op>): {mutated: true|false|null, ...}. Read that instead of spending an extra explore_page{incremental:true} call — it is the same diff, already paid for. mutated:false means NO INTERACTIVE-ELEMENT CHANGE was detected — it is NOT proof the action failed: the diff fingerprints interactive elements only, so text/content changes elsewhere, async handlers that settle after the diff, focus-only clicks, downloads, and new-tab opens all report mutated:false while genuinely landing. Confirm with a real read (status / read{diff} / main_world / the downloads or tabs store) before concluding "not landed". mutated:null means no baseline existed yet on that tab, so that action seeded one and only the NEXT action is verifiable. Pass verify:false to skip the diff on a call you don't need checked.

FULL PAGE MAP vs A SLICE: page_snapshot collects a LOSSLESS inventory of the page (nothing filtered out — not interactive-only, not in-viewport-only) and returns only a small INDEX (counts + the dimensions you can slice by). page_slice then fetches ONE slice (tag/role/region/vp/interactive/query) at full fidelity. Use this when you need the whole page's shape or something the SAG does not show (off-viewport elements, the rest of a long page, a full tag/region inventory). It is also scroll-stable, so its index does not churn the way a viewport-filtered scan does. Cost measured on github.com/nodejs/node: index 690 B vs a 116,573 B explore_page, over 3,842 elements.

THE 31 TOOLS — what each absorbed from the old 65-tool surface:
  websense_guide   this guide
  explore_page     page map (SAG). compact:true = old discover_actions; intent:"submit" = old find_intent; goal:"log in" = old explore_intent; preload:true = lazy-load first; incremental:true = delta since last scan (added/changed/removed, no settle/content — you usually do NOT need this any more: mutating ops return a DELTA block automatically; first call returns full SAG)
  read             page text. format: "text" (extract_text) | "content" (read_content) | "markdown" (dump_markdown) | "diff" (page_diff) | "scrollextract" (scroll_and_extract) | "preload" (preload_content)
  click            click ref (default) | mode:"hover" | mode:"rightclick" | mode:"drag" (fromRef/toRef) | x,y for canvas (old click_xy)
  type_text        fill one input (React-safe native setter) — or fields:[{ref,text},...] for batch (old type_many). Batch fills are SEQUENTIAL with a persistence check per field, so a 50-field batch takes ~50s; it reports filled/failed from the verified result, not from whether the write was dispatched. Password/OTP values are never echoed back.
  form             action:"state" (form_state) | "select" (ref,value) | "toggle" | "upload" (ref,filePath)
  reveal           pre-extract hidden content without opening it: kind:"dropdown" (ref = the trigger → its options) | "tabs" (ref optional → tab panels) | "accordion" (ref optional → details/summary). Works with E# or CSS refs.
  scroll           direction+amount (ticks, 1 tick ≈ 80% viewport) | y:<px> absolute (scroll_to) | intoView:"E5" (scroll_into_view)
  tabs             action:"list" | "switch" | "close" | "bind" (no focus) | "windows" | "focus" | "move" | "transfer" (cross-tab copy/paste) | "switchread"
  status           kind:"page" (page_state) | "bridge" (get_status) | "doctor" (diagnostics) | "downloads"
  wait             poll until conditions met (urlContains/hasModal/hasCaptcha/notLoading/pendingDialogsGt/selector/script/timeoutMs/pollMs) — old wait_for; or event:"dialog_open|navigation|network|..." — old wait_for_event
  evaluate         script:<js> runs and RETURNS ITS VALUE. The isolated-world path uses new Function, which the extension's own MV3 CSP blocks — so on a CSP block it transparently re-routes through the MAIN world (chrome.userScripts, no eval) and reports via:"main_world". Works on every page. query:{selector,extract,all,inputs,text,state} is the no-eval read path (preferred for plain reads). Password/OTP values are always masked.
  ax               native accessibility tree via chrome.debugger (Chrome's EXTENSION API — ALLOWED, unlike a CDP debug port): action:"state"|"read"|"click"|"type" + tabId (+ match/role/name). For canvas SPAs & chrome:// pages
  screenshot       captureVisibleTab → PNG/JPEG dataUrl for a vision model
  press_key        key + modifiers ["ctrl","shift","alt","meta"], optional ref target. SYNTHETIC KeyboardEvents only — it does NOT perform default browser actions: ctrl+a does not select, letter keys do not insert text. It fires page JS key handlers and nothing else. Use type_text for text entry.
  dialog           JS dialogs: action:"accept"|"dismiss" + value (prompt). CAPTURES THE PAGE'S OWN alert/confirm/prompt via a MAIN-world hook — status lists them in pendingDialogs (waiting) and recentDialogs (already fired); the answer reaches the page's promise. Check recentDialogs after any destructive-looking click. DOM [role=dialog] modals: close by ref (hasModal/dialogCount are visibility-BLIND). keystroke:true + key for OS-level dialogs (enter|escape|tab|f5|ctrl+c)
  session          action:"reset" (clears YOUR map + history only — since 1.4.7 each MCP session has its own SessionManager, so it no longer wipes other jobs) | "map" (exploration graph) | "mermaid" (flowchart export). History stores the text you typed.
  network_log      captured fetch/XHR since last call (clear, maxEntries) — see the fuller note below the tool list
  clipboard        action:"copy" (text) | "read"
  inspect          resolve a ref / one element: kind:"element" (resolve_ref — is this ref alive?) | "geometry" (bounding box, z-depth, scroll-container-aware) | "relation" (refA vs refB: above/below/overlaps)
  navigate         navigate a tab to a URL. Pass tabId to target a specific tab; omit it to reuse your BOUND tab (no tab spam). newTab:true forces a fresh tab. An UNBOUND session gets its OWN tab automatically (it never inherits another session's tab)
  main_world       run a COMPILED function EXPRESSION in the page MAIN world (F12-insider view) — CSP-proof, the escape hatch when evaluate is blocked. func must be an EXPRESSION (() => …, async () => …); a statement body returns null with success:true and does nothing. This is the reliable way to READ what a click/type actually did
  page_snapshot    LOSSLESS inventory of the page, held server-side; returns only the INDEX (counts + sliceable dimensions + handle). Nothing is cut: not interactive-only, not in-viewport-only. Scroll-stable. fresh:true re-collects
  page_slice       fetch ONE slice of the snapshot at full fidelity: by tag / role / region / vp / interactive / query (+limit). Every record carries a usable locator, so you can act on what you fetch
  console_log      captured browser console + JS errors since last call (the page telling you WHY something failed) — a MAIN-world hook, so page logs ARE captured
  network_log      captured PAGE fetch/XHR since last call (clear, maxEntries). A MAIN-world hook captures real page traffic; totalCaptured is the count BEFORE clearing, so a clear:true call still tells you what it just flushed. Header capture is off unless asked.
  cookies          cookie session manager: action:"list" (metadata for a url — names/expiry, NEVER values) | "get" (returns values for a named cookie) | "clear"
  respawn_offscreen  force-close + recreate the offscreen document so the extension reloads fresh code (MV3 trap: the offscreen does NOT reload with the extension card)
  extension_reload   reload the WebSense extension itself
  real_activate_tab  OS-INPUT ONLY — genuinely activates a tab (SendInput). Page ops NEVER need this; it exists solely to precede real_click/real_paste
  real_click       GENUINE OS-level click (SendInput) at VIEWPORT coords (x,y) — for canvases/raw-input surfaces a page op cannot reach. Lands on the FRONTMOST window
  real_paste       GENUINE paste (Ctrl+V) into a focused editor at viewport coords — the working route for attaching a real file/image to a composer

TAB SCOPING MODEL (read this before running concurrent jobs): this is ONE Chrome profile with ONE extension — jobs do NOT get separate profiles, and nothing here gives you cookie/storage isolation from another job. Isolation is per-TAB. Ops that take an explicit tabId (navigate, tabs switch/close/bind/frames, form, ax, screenshot, real_*) target that tab and ignore the cursor. CURSOR-SCOPED ops (status, wait, scroll, evaluate, reveal, inspect, session, dialog, clipboard, console_log, network_log, read, explore_page, click, type_text) follow the session's BOUND tab, NOT the OS-frontmost tab. An unbound session is pinned to a tab automatically and WARNS you — it never silently inherits the shared global cursor (which is what made tabs appear "hijacked" between concurrent agents). tabs{action:"bind", tabId} sets the target WITHOUT focusing. session state (map/history) is PER-SESSION since v1.4.7: each MCP session gets its own SessionManager, so session{action:"reset"} clears only YOUR history and one job's steps never appear in another's map. (Before 1.4.7 it was a process-wide singleton and reset wiped everyone — that is fixed.)

WHAT TOUCHES THE FOREGROUND (the complete list — nothing else does): (1) real_activate_tab, real_click, real_paste — OS-input by design, and the ONLY sanctioned ways to take the foreground. (2) tabs action:"focus" / "move". (3) ONE automatic case: if the bound tab's Chrome window is MINIMIZED or COLLAPSED, its viewport is 0x0 and every page read comes back empty, so a page op restores that window to "normal" first and then reports windowRestored:true with a note saying why. It never raises a window that is merely in the background or occluded. If you see a window come to the front during a page op, that is this case — minimized windows cannot be read otherwise. (4) Attaching a REAL file to a composer (form action:"upload" onto a custom dropzone) attaches a realm-local File that never uploads; the working route is real_paste or scripts/real_input.py paste-file, which DO need the foreground. Native file dialogs (OS open/save) and OS-level print/print-preview always need the foreground and have no background path.

REF LIFECYCLE: E# refs are assigned in VIEWPORT order on the FIRST scan, then held by ELEMENT IDENTITY (a per-element cache plus a data-websense-ref attribute), so they are STABLE across re-explores, scrolls, and framework re-renders. MEASURED 2026-09-25: 41/41 refs unchanged across a full re-explore, 0 changed after a scroll, 0 after a re-render, and a stale ref correctly HEALED onto a replacement node with an identical label and no id/class (the click landed on the NEW node). A ref only dies if its element leaves the DOM with nothing to heal from — re-explore if a call reports the element not found. CSS-selector refs (#id, .class) remain the safest choice for anything long-lived or across navigations.

KEY PATTERNS:
- Forms: form{action:"state", formRef:"F0"} → type_text/select via form{action:"select"} → click submit ref
- After every action: read the before/after + effect verdict (confirmed / suspected_noop / unverifiable). Verdicts are WEAK evidence, not proof: suspected_noop means the measured state was identical (re-read the real outcome first — async work, downloads, new tabs all measure as identical), and unverifiable means the effect could not be measured at all. NEVER escalate straight to OS-level input (real_click) on suspected_noop/unverifiable: re-read the page first, and only use real_click when a page op provably cannot reach the element (canvas/raw-input/native surface).
- Iframes: status{kind:"frames"}? No — list_frames lives under tabs{action:"frames"}; pass frameId to any element tool
- Waits: wait{urlContains:"/dashboard"} beats manual poll loops; wait{event:"dialog_open"} after clicks that pop dialogs
- Anti-patterns: no screenshots/vision for routine work; no CDP *debug port* (bot detection) — note chrome.debugger via the ax tool is NOT that and is allowed; no evaluate for routine reads (CSP); don't guess labels — read them from explore_page

TAB DISCIPLINE: reuse tabs (navigate reuses by default). NEVER close the last open tab/window of an app.
PAGE OPS vs OS-INPUT (do not conflate — the #1 source of wasted calls):
  page ops (navigate/explore_page/read/click{ref}/type_text/form/scroll/inspect/main_world/status/wait)
    route over tabs.sendMessage BY TABID and work on a tab that is NOT active. Never activate
    a tab for these. Measured 2026-09-20: explore_page on an active:false tab, no activation, 29 matches.
  OS-input ops (real_click/real_paste/real_activate_tab/dialog{keystroke}/computer_use) use SendInput,
    which hits the FRONTMOST window — those need the target active first, and they steal the
    user's focus. Use them only when a page op genuinely cannot work.
  A page op that HANGS is almost never activation. Check in order: (1) Chrome MINIMISED/occluded
    (0x0 window — restore it: tabs{action:"windows"} then tabs{action:"focus", windowId};
    an unrendered tab stops answering and every call then
    burns the 90s timeout), (2) a native "Leave site?" dialog parked over Chrome (dismiss it),
    (3) another process already driving that tab. Do NOT "fix" a hang by activating the tab.
NATIVE DIALOGS: JS alert/confirm/prompt are captured (dialog{action}); OS dialogs need dialog{keystroke:true}.`);
  });

  // ═══ 2. EXPLORE ═══
  reg(server, 'explore_page', {
    description: 'Page map: every interactive element with ref (E#), action type, predicted effect, forms (F#), content. compact:true = quick list; intent:"submit" = find by intent; goal:"log in" = goal-filtered minimal set; preload:true = force lazy content first.',
    inputSchema: {
      compact: z.boolean().optional().describe('Quick list only (old discover_actions), no content/forms'),
      intent: z.string().optional().describe('Find elements by semantic intent e.g. "submit", "password" (old find_intent)'),
      goal: z.string().optional().describe('Natural-language goal; returns ONLY goal-relevant elements (old explore_intent)'),
      preload: z.boolean().optional().describe('Force-load lazy content before extraction'),
      full: z.boolean().optional().describe('Include offscreen elements'),
      includeContent: z.boolean().optional().describe('Include body text (default true)'),
      includeHidden: z.boolean().optional().describe('Include hidden elements'),
      maxActions: z.number().optional().describe('Cap on RETURNED actions (default 200). 0 = unbounded (NOT recommended: an unbounded scan is what used to time out at 90s on heavy pages).'),
      incremental: z.boolean().optional().describe('Return only added/changed/removed since the last scan (cheap — no settle, no content). First call or >60% churn auto-falls back to full. Ideal after click/type to see what the action did.'),
      contentMaxLen: z.number().optional().describe('Cap on extracted body text (default 8000; auto-lowered to 6000 when the action list is large)'),
      fresh: z.boolean().optional().describe('Force a real re-scan. Without it, a repeated call on an unchanged DOM inside ~1.5s returns the cached map (cached:true)'),
      settle: z.boolean().optional().describe('false = skip the SPA hydration settle wait entirely'),
    },
  }, async (o) => {
    // A zero-hit semantic search must not look like an empty page (see annotateIntentResult).
    if (o.intent) return textResult(annotateIntentResult(await getActiveHub().send({ type: 'find_intent', intent: o.intent, frameId: o.frameId }), 'intent', o.intent));
    if (o.goal) return textResult(annotateIntentResult(await getActiveHub().send({ type: 'explore_intent', goal: o.goal, frameId: o.frameId }), 'goal', o.goal));
    if (o.compact) return textResult(await getActiveHub().send({ type: 'discover_actions', maxActions: o.maxActions === undefined ? 200 : o.maxActions, frameId: o.frameId }));
    if (o.preload) {
      await getActiveHub().send({ type: 'preload_content', maxSteps: 8, settleMs: 250, restore: true });
    }
    const sag = await getActiveHub().send({ type: 'explore_page', full: o.full || false, includeContent: o.includeContent !== false, includeHidden: o.includeHidden || false, incremental: o.incremental || false, maxActions: o.maxActions, contentMaxLen: o.contentMaxLen, fresh: o.fresh || false, settle: o.settle, frameId: o.frameId });
    if (!sag || sag.success === false) return textResult(sag || { success: false, error: 'No response from content script' });
    if (sag.meta && sag.meta.url) getSession().recordPage(sag.meta.url, sag);
    // Incremental results are partial deltas — only full SAGs (including the
    // auto-fallback from incremental:true, which sets escalated/returns a
    // complete map) become the session's canonical lastSnapshot.
    if (!sag.incremental || sag.escalated) getSession().setLastSnapshot(sag);
    return textResult(sag);
  });

  // ═══ 3. READ ═══
  reg(server, 'read', {
    description: 'Read page content. format: "text" (innerText of selector, offset-paged) | "content" (smart SPA extraction) | "markdown" (clean MD conversion) | "diff" (only what changed since last read — huge token saver) | "scrollextract" (infinite scroll) | "preload" (defeat lazy loading).',
    inputSchema: {
      format: z.enum(['text', 'content', 'markdown', 'diff', 'scrollextract', 'preload']).optional().describe('Default text'),
      selector: z.string().optional().describe('CSS selector (default body/auto)'),
      maxLen: z.number().optional().describe('Char cap'),
      offset: z.number().optional().describe('Char offset for text format (paging long pages)'),
      scrolls: z.number().optional().describe('scrollextract: number of scrolls (default 5)'),
      scrollDelay: z.number().optional().describe('scrollextract: ms per scroll (default 1500)'),
      direction: z.enum(['down', 'up', 'left', 'right']).optional().describe('scrollextract direction (default down)'),
      maxSteps: z.number().optional().describe('preload: max scroll steps (default 25)'),
      settleMs: z.number().optional().describe('preload/scrollextract: ms per step'),
      restore: z.boolean().optional().describe('preload: restore scroll after sweep (default true)'),
      goal: z.string().optional().describe('text format: goal phrase — auto-summarizes long pages to goal-relevant segments (P1#2)'),
      summarizeAt: z.number().optional().describe('text format: auto-summarize above this many chars (default 8000)'),
    },
  }, async (o) => {
    const fmt = o.format || 'text';
    if (fmt === 'diff') return textResult(await getActiveHub().send({ type: 'page_diff', frameId: o.frameId }));
    if (fmt === 'preload') return textResult(await getActiveHub().send({ type: 'preload_content', maxSteps: o.maxSteps || 25, settleMs: o.settleMs || 250, restore: o.restore !== false, frameId: o.frameId }));
    if (fmt === 'scrollextract') return textResult(await getActiveHub().send({ type: 'scroll_and_extract', scrolls: o.scrolls || 5, scrollDelay: o.scrollDelay || 1500, maxLen: o.maxLen || 20000, direction: o.direction || 'down', selector: o.selector || null, frameId: o.frameId }));
    if (fmt === 'markdown') return textResult(await getActiveHub().send({ type: 'dump_markdown', selector: o.selector || null, maxLen: o.maxLen || 20000, frameId: o.frameId }));
    if (fmt === 'content') return textResult(await getActiveHub().send({ type: 'read_content', selector: o.selector || null, maxLen: o.maxLen || 12000, frameId: o.frameId }));
    const raw = await getActiveHub().send({ type: 'extract_text', selector: o.selector || 'body', maxLen: o.maxLen || 4000, offset: o.offset || 0, frameId: o.frameId });
    // P1#2 (2026-08-31): goal-aware budget — when the extracted text is huge,
    // summarize to the goal-relevant segments instead of flooding the context.
    // Only auto-summarize on the TEXT path (the format agents use for long
    // reads); content/markdown/scrollextract already cap their own maxLen.
    if (raw && raw.success && typeof raw.data === 'string') {
      const s = summarizeRead(raw.data, o.goal || null, { threshold: o.summarizeAt || 8000, keep: o.maxLen || 4000 });
      if (s.summarized) raw.data = s.text;
    }
    return textResult(raw);
  });

  // ═══ 4. CLICK ═══
  reg(server, 'click', {
    description: 'Interact by ref: click (default) | mode:"hover" | mode:"rightclick" | mode:"drag" (fromRef→toRef) — or x,y viewport coords for canvas (ref optional origin). Returns before/after + effect verdict; on suspected_noop escalate (OS-level click) instead of retrying blind.',
    inputSchema: {
      ref: z.string().optional().describe('Element ref e.g. "E7"'),
      mode: z.enum(['click', 'hover', 'rightclick', 'drag']).optional().describe('Default click'),
      x: z.number().optional().describe('Viewport X (canvas clicks; origin=ref if given)'),
      y: z.number().optional().describe('Viewport Y'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Button for x,y clicks (default left)'),
      fromRef: z.string().optional().describe('drag: ref to drag from'),
      toRef: z.string().optional().describe('drag: ref to drop onto'),
      autoClimb: z.boolean().optional().describe('On suspected_noop, auto-deliver a genuine OS click at the element (only when the target tab is OS-active). Default: WEBSENSE_AUTOCLIMB env (off).'),
    },
  }, async (o) => {
    const beforeUrl = getSession().currentUrl;
    let result;
    const mode = o.mode || 'click';
    if (o.x != null && o.y != null) {
      result = await getActiveHub().send({ type: 'click_xy', x: o.x, y: o.y, ref: o.ref, button: o.button || 'left', frameId: o.frameId });
    } else if (mode === 'drag') {
      result = await getActiveHub().send({ type: 'drag_drop', fromRef: o.fromRef, toRef: o.toRef, frameId: o.frameId });
    } else if (mode === 'hover') {
      result = await getActiveHub().send({ type: 'hover', ref: o.ref, frameId: o.frameId });
    } else if (mode === 'rightclick') {
      result = await getActiveHub().send({ type: 'right_click', ref: o.ref, frameId: o.frameId });
    } else {
      result = await getActiveHub().send({ type: 'click', ref: o.ref, frameId: o.frameId });
      result.effect = classifyEffect(result);
      // 2026-09-25: recommend OS input ONLY for a REAL no-op (states compared,
      // identical). 'unverifiable' means the effect could not be measured — that
      // is NOT evidence the click failed, and auto-recommending real_click there
      // is what produced the focus-steal loop: async handlers, downloads,
      // _blank opens and focus-only clicks all change nothing measurable yet
      // all landed. For unverifiable, re-read the actual page state first.
      if (result.effect === 'suspected_noop') {
        result.escalation = { recommended: 'real_click', reason: 'before/after quick state are IDENTICAL — the synthetic click measurably changed nothing. First re-read the page (wait for async work / check the real outcome); only if a page op provably cannot reach this element, re-issue via a genuine OS-level click (real_click).' };
      } else if (result.effect === 'unverifiable') {
        result.escalation = { recommended: 're_read', reason: 'effect could not be measured (no before/after state pair) — this is NOT a failure signal. Re-read the actual page (status/explore/main_world/DELTA) before retrying or escalating to OS input.' };
      }
      // P0#3 AUTO-CLIMB (2026-08-31): if the synthetic click no-op'd AND this
      // session's bound tab is the OS-active tab, resolve the element's
      // physical screen center and deliver a GENUINE OS click (PowerShell
      // user32 mouse_event — same trust class as a human). React-controlled
      // submits fire on real input, so this replaces the manual real-click
      // escalation the agent used to have to do. Guard: only climb when the
      // target tab is ACTIVE — a real click lands on whatever window is
      // frontmost, and in the multi-agent factory that would be a sibling
      // worker's tab (mem 385). Off by default on the server; enable via
      // WEBSENSE_AUTOCLIMB=1 or per-call autoClimb:true.
      const wantClimb = (o.autoClimb === true) || (o.autoClimb === undefined && process.env.WEBSENSE_AUTOCLIMB === '1');
      if (wantClimb && result.effect === 'suspected_noop' && o.ref) {
        try {
          // 1. Is the target tab the OS-active one? (activeTabId = session bound)
          const bound = sessionTabOf();
          if (bound != null) {
            const activeRes = await getActiveHub().send({ type: 'get_active_tab' });
            const activeId = activeRes && activeRes.tab && activeRes.tab.id != null ? Number(activeRes.tab.id) : null;
            if (activeId != null && Number(activeId) === Number(bound)) {
              // 2. Element's physical screen center
              const geo = await getActiveHub().send({ type: 'screen_center', ref: o.ref, frameId: o.frameId });
              if (geo && geo.success && geo.screen && geo.screen.x != null && geo.screen.y != null && geo.visible !== false) {
                // 3. Genuine OS click + re-diff
                realClickAt(geo.screen.x, geo.screen.y);
                await new Promise((r) => setTimeout(r, 250));
                const after = await getActiveHub().send({ type: 'page_state' });
                const changed = !!(after && after.url && result.afterState && after.url !== result.afterState.url);
                result.effect = changed ? 'confirmed' : 'suspected_noop';
                result.autoClimb = { attempted: true, screen: geo.screen, activeTab: true, changed };
                if (changed) delete result.escalation;
                else result.escalation = { recommended: 'real_click_manual', reason: 'auto-climb OS click also produced no state change — element may be disabled, covered, or the submit needs additional interaction' };
              } else {
                result.autoClimb = { attempted: false, reason: geo && !geo.success ? (geo.error || 'screen_center failed') : 'element not visible or no screen coords' };
              }
            } else {
              result.autoClimb = { attempted: false, reason: 'auto-climb uses a real OS click, which lands on the frontmost window, so the target tab must be OS-active (active=' + activeId + ' bound=' + bound + ') — an OS-INPUT requirement, not a page-op one' };
            }
          } else {
            result.autoClimb = { attempted: false, reason: 'no session-bound tab — bind/switch to a tab first' };
          }
        } catch (climbErr) {
          result.autoClimb = { attempted: false, reason: 'auto-climb error: ' + ((climbErr && climbErr.message) || climbErr) };
        }
      }
    }
    getSession().recordAction({ action: 'click', ref: o.ref, mode }, result);
    if (result.afterState && result.beforeState && result.afterState.url !== result.beforeState.url) {
      getSession().recordNavigation(beforeUrl, result.afterState.url, o.ref, '', mode);
      getSession().recordPage(result.afterState.url, null);
    }
    return textResult(result);
  });

  // ═══ 5. TYPE ═══
  reg(server, 'type_text', {
    description: 'Fill input(s) with the React-safe native setter + input/change events. One field: ref+text. Many at once: fields:[{ref,text,clearFirst?},...] (old type_many — one round trip). Verifies value persistence; effect verdict included.',
    inputSchema: {
      ref: z.string().optional().describe('Element ref (single-field mode)'),
      text: z.string().optional().describe('Text to set (single-field mode)'),
      clearFirst: z.boolean().optional().describe('Clear before typing (default true)'),
      fields: z.array(z.object({ ref: z.string(), text: z.string(), clearFirst: z.boolean().optional() })).optional().describe('Batch mode: up to 50 fields'),
    },
  }, async (o) => {
    let result;
    if (o.fields && o.fields.length) {
      result = await getActiveHub().send({ type: 'type_many', fields: o.fields });
      getSession().recordAction({ action: 'type_many', refs: o.fields.map(f => f.ref) }, result);
      return textResult(result);
    }
    result = await getActiveHub().send({ type: 'type_text', ref: o.ref, text: o.text, clearFirst: o.clearFirst !== false, frameId: o.frameId });
    const persisted = result && (result.valueSet === true || result.verified === true || result.success === true);
    result.effect = (result && result.success === false) ? 'failed' : persisted ? 'confirmed' : 'unverifiable';
    if (result.effect !== 'confirmed') {
      result.escalation = { recommended: 're_read', reason: 'value persistence not confirmed — re-explore the field and re-type with clearFirst:true before escalating to OS-level input' };
    }
    getSession().recordAction({ action: 'type_text', ref: o.ref, text: o.text }, result);
    return textResult(result);
  });

  // ═══ 6. FORM ═══
  reg(server, 'form', {
    description: 'Form ops: action:"state" (fields, validation, submit readiness; formRef optional = all) | "select" (ref,value — native <select> AND ARIA dropdowns; select[multiple] accepts JSON array) | "toggle" (checkbox/switch/aria-pressed) | "special" (ref,value — date/time/color/range/number/checkbox/radio with auto-format + browser-rejection detection) | "upload" (ref, filePath — file input / dropzone / rich-editor paste, auto-picked).',
    inputSchema: {
      action: z.enum(['state', 'select', 'toggle', 'special', 'upload']).describe('Form operation'),
      formRef: z.string().optional().describe('state: form ref e.g. "F0" (omit = all forms)'),
      ref: z.string().optional().describe('Element ref for select/toggle/special/upload'),
      value: z.string().optional().describe('select: option value (or JSON array for multi) | special: target value ("2026-09-01", "#ff8800", "42", "true")'),
      clearAll: z.boolean().optional().describe('select on multi-select: deselect non-matching options (default true)'),
      filePath: z.string().optional().describe('upload: absolute file path'),
    },
  }, async (o) => {
    if (o.action === 'state') return textResult(await getActiveHub().send({ type: 'form_state', formRef: o.formRef, frameId: o.frameId }));
    if (o.action === 'select') {
      requireArgs('form:select', o, { ref: 'element ref of the select', value: 'option value to select' });
      const result = await getActiveHub().send({ type: 'select_option', ref: o.ref, value: o.value, clearAll: o.clearAll, frameId: o.frameId });
      getSession().recordAction({ action: 'select_option', ref: o.ref, value: o.value }, result);
      return textResult(result);
    }
    if (o.action === 'special') {
      requireArgs('form:special', o, { ref: 'element ref', value: 'target value (date / colour / range / number)' });
      const result = await getActiveHub().send({ type: 'form_special', ref: o.ref, value: o.value, frameId: o.frameId });
      getSession().recordAction({ action: 'form_special', ref: o.ref, value: o.value }, result);
      return textResult(result);
    }
    if (o.action === 'toggle') {
      const result = await getActiveHub().send({ type: 'toggle', ref: o.ref, frameId: o.frameId });
      getSession().recordAction({ action: 'toggle', ref: o.ref }, result);
      return textResult(result);
    }
    // upload
    // Without this, a missing filePath reached readFileSync(undefined) and threw
    // 'The "path" argument must be of type string. Received undefined' — an error
    // that never names the argument you actually forgot.
    requireArgs('form:upload', o, {
      filePath: 'absolute path of the file to upload',
      ref: 'element ref of the file input / editor / drop zone',
    });
    try {
      const fileBuffer = readFileSync(o.filePath);
      const base64 = fileBuffer.toString('base64');
      const fileName = o.filePath.split(/[\\/]/).pop();
      const ext = fileName.split('.').pop().toLowerCase();
      // MIME map — the extension decides whether Chrome ACCEPTS the file: when a
      // file's type does not match the input's `accept` list, Chrome filters it out
      // and `input.files`comes back EMPTY (the `fileCount:0` / "Input rejected the
      // file" signature). Video and audio were missing entirely before 2026-09-11,
      // so `upload_file` silently failed on every .mp4/.mov/.mp3 (x.com video
      // posts, YouTube uploads, etc.). Keep this list ahead of real-world accepts.
      const mimeTypes = {
        // images
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
        tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic',
        // video
        mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
        avi: 'video/x-msvideo', mkv: 'video/x-matroska', mpg: 'video/mpeg', mpeg: 'video/mpeg',
        // audio
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
        ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
        weba: 'audio/webm',
        // documents
        pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
        json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
        rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        // archives
        zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
        '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
      };
      const result = await getActiveHub().send({ type: 'upload_file', ref: o.ref, fileContent: base64, fileName, mimeType: mimeTypes[ext] || 'application/octet-stream', frameId: o.frameId });
      return textResult(result);
    } catch (err) {
      return textResult({ success: false, error: 'Failed to read file: ' + err.message });
    }
  });

  // ═══ 7. REVEAL ═══
  reg(server, 'reveal', {
    description: 'Pre-extract hidden content WITHOUT clicking: kind:"dropdown" (all options, native + ARIA) | "tabs" (all tab panels) | "accordion" (all collapsible sections).',
    inputSchema: {
      kind: z.enum(['dropdown', 'tabs', 'accordion']).describe('What to reveal'),
      ref: z.string().optional().describe('Element ref (optional for tabs/accordion)'),
    },
  }, async (o) => {
    const type = o.kind === 'dropdown' ? 'dropdown_options' : o.kind === 'tabs' ? 'tab_contents' : 'accordion_contents';
    return textResult(await getActiveHub().send({ type, ref: o.ref, frameId: o.frameId }));
  });

  // ═══ 8. SCROLL ═══
  reg(server, 'scroll', {
    description: 'Scroll: direction:"down"+amount (ticks, 1 tick ≈ 80% viewport; ref scrolls that element\'s container) — or y:<px> absolute — or intoView:"E5" (center element).',
    inputSchema: {
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (tick mode)'),
      amount: z.number().optional().describe('Ticks (default 1)'),
      ref: z.string().optional().describe('Element whose scrollable ancestor to scroll / intoView target'),
      y: z.number().optional().describe('Absolute pixel position (scroll_to mode)'),
      intoView: z.string().optional().describe('Ref to scroll into center of viewport'),
    },
  }, async (o) => {
    if (o.intoView) return textResult(await getActiveHub().send({ type: 'scroll_into_view', ref: o.intoView, frameId: o.frameId }));
    if (o.y != null) return textResult(await getActiveHub().send({ type: 'scroll_to', y: o.y, frameId: o.frameId }));
    return textResult(await getActiveHub().send({ type: 'scroll', direction: o.direction || 'down', amount: o.amount === undefined ? 1 : o.amount, ref: o.ref, frameId: o.frameId }));
  });

  // ═══ 9. NAVIGATE ═══
  reg(server, 'navigate', {
    description: 'Navigate a tab to a URL (reuses your bound tab — no tab spam). Pass tabId to target a specific tab; pass newTab:true to open in a fresh tab instead. Returns tabId (session binding follows).',
    inputSchema: { url: z.string(), tabId: z.number().optional().describe('Target this tab. Omit to navigate your bound tab (fresh session gets a new tab). Ignored when newTab:true.'), newTab: z.boolean().optional().describe('Open in a new tab instead of reusing (default false)') },
  }, async ({ url, tabId, newTab }) => {
    // An UNBOUND session must get its OWN tab. Reusing "the current tab" means reusing the
    // SHARED routing cursor, i.e. navigating whatever tab another agent happens to be on.
    // So on first use we force a fresh tab, then bind this session to it.
    const stBefore = sessionCtx.getStore();
    const hadBinding = !!(stBefore && stBefore.boundTabId != null)
      || !!(server && server._wsBoundTabId != null);
    const forceFresh = !hadBinding;
    // 2026-09-25: forward an explicit tabId. The schema used to have NO tabId,
    // so callers' tabId was dropped before it could reach the offscreen — which
    // DOES forward it and whose SW handler already honored it. The result looked
    // like success but navigated the cursor tab instead (measured: a2-rerender
    // request re-navigated the workbench).
    const result = await getActiveHub().send({ type: 'navigate', url, newTab: !!(newTab || forceFresh), ...(tabId != null && !newTab && !forceFresh ? { tabId } : {}) });
    if (server && result && result.tabId) {
      server._wsBoundTabId = result.tabId;
      claimTab(server, result.tabId);
    }
    // Bind THIS request's session store too, so any op later in the same session is
    // already routed at the tab we just navigated (the store is otherwise only seeded
    // from server._wsBoundTabId on the NEXT request).
    if (result && result.tabId) {
      const st = sessionCtx.getStore();
      if (st) st.boundTabId = Number(result.tabId);
    }
    getSession().recordAction({ action: 'navigate', url }, result);
    return textResult(result);
  });

  // ═══ 10. TABS ═══
  // The first 110 chars of a description are what agents actually read (the wire
  // cap). This one leads with the background-only contract on purpose: an earlier
  // revision put the OS-LEVEL warning first and pushed "page ops NEVER need
  // activation" past the cut, so no agent ever saw it. A test pins the position.
  reg(server, 'tabs', {
    description: 'Tab ops. page ops NEVER need activation — BACKGROUND-ONLY except action:"focus"/"move" (OS-LEVEL, raise a window). action:"list" | "switch" (tabId) | "close" (tabId) | "bind" (tabId — route page ops at this tab WITHOUT focusing; pass activate:true ONLY when you are about to do OS-level input, since real_click/real_paste hit the frontmost window) | "frames" (tabId optional — list iframes w/ frameId for THAT tab; omit for your bound tab) | "windows" (all windows+tabs) | "focus" (windowId — OS-LEVEL: raises that Chrome window and can pull the user’s cursor away from their work; use only when an OS-input rung is genuinely required) | "move" (tabId,windowId — OS-LEVEL: moving a tab between windows can change which window is frontmost) | "transfer" (fromTab,toTab,fromSelector,toSelector — atomic cross-tab copy/paste) | "switchread" (tabId,selector — switch+read in one).',
    inputSchema: {
      action: z.enum(['list', 'switch', 'close', 'bind', 'frames', 'windows', 'focus', 'move', 'transfer', 'switchread']).describe('Tab operation'),
      tabId: z.number().optional().describe('Target tab'),
      windowId: z.number().optional().describe('Target window (focus/move)'),
      activate: z.boolean().optional().describe('bind: ALSO make this the OS-active tab. Not needed for page ops (they route by tabId on a backgrounded tab); pass it only when OS-level input (real_click/real_paste) follows, because SendInput hits the frontmost window.'),
      fromTab: z.number().optional().describe('transfer: source tab'),
      toTab: z.number().optional().describe('transfer: destination tab'),
      fromSelector: z.string().optional().describe('transfer: source selector'),
      toSelector: z.string().optional().describe('transfer: destination selector'),
      useValue: z.boolean().optional().describe('transfer: copy input VALUE instead of visible text'),
      selector: z.string().optional().describe('switchread: selector to read (default body)'),
    },
  }, async (o) => {
    switch (o.action) {
      case 'list': return textResult(await getActiveHub().send({ type: 'list_tabs' }));
      case 'switch':
        if (server) server._wsBoundTabId = o.tabId;
        return textResult(await getActiveHub().send({ type: 'switch_tab', tabId: o.tabId }));
      case 'close': return textResult(await getActiveHub().send({ type: 'close_tab', tabId: o.tabId }));
      case 'bind':
        if (server) server._wsBoundTabId = o.tabId;
        return textResult(await getActiveHub().send({ type: 'bind_tab', tabId: o.tabId, activate: !!o.activate }));
      case 'frames': return textResult(await getActiveHub().send({ type: 'list_frames', ...(o.tabId != null ? { tabId: o.tabId } : {}) }));
      case 'windows': return textResult(await getActiveHub().send({ type: 'list_windows' }));
      case 'focus': return textResult(await getActiveHub().send({ type: 'focus_window', windowId: o.windowId }));
      case 'move': return textResult(await getActiveHub().send({ type: 'move_tab_to_window', tabId: o.tabId, windowId: o.windowId }));
      case 'transfer': return textResult(await getActiveHub().send({ type: 'transfer_text', fromTab: o.fromTab, toTab: o.toTab, fromSelector: o.fromSelector, toSelector: o.toSelector, useValue: !!o.useValue }));
      case 'switchread': return textResult(await getActiveHub().send({ type: 'switch_tab_and_read', tabId: o.tabId, selector: o.selector || 'body' }));
    }
  });

  // ═══ 10. STATUS ═══
  reg(server, 'status', {
    description: 'Diagnostics: kind:"page" (URL/title/modal/captcha/loading/viewport — call after actions) | "bridge" (hub+page connection, instant) | "doctor" (full self-diagnostics: hub, clients, SW alarms, wsDebug, cookie names+expiry) | "downloads" (recent downloads state).',
    inputSchema: {
      kind: z.enum(['page', 'bridge', 'doctor', 'downloads']).optional().describe('Default page'),
    },
  }, async (o) => {
    const kind = o.kind || 'page';
    if (kind === 'bridge') {
      let pageUrl = null, pageTitle = null, probe = 'none';
      if (getActiveHub().connected) {
        try {
          const ps = await Promise.race([
            getActiveHub().send({ type: 'get_status' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
          ]);
          pageUrl = ps?.url || null;
          pageTitle = ps?.title || null;
          probe = pageUrl !== null ? 'live' : 'empty';
        } catch (_) {
          // A5 (2026-08-31, OSS smoke-test): get_status timed out but ops DO
          // work — a heavy page / settling SPA can exceed the 3s probe. Don't
          // report a hard false (that reads as "extension dead" and misroutes
          // agents); fall back to the session's last-known-good URL.
          probe = 'timeout-fallback';
          pageUrl = getSession().currentUrl || null;
          pageTitle = pageUrl ? (getSession().pages.get(pageUrl)?.title || getSession().currentTitle || null) : null;
        }
      }
      return textResult({
        hubConnected: getActiveHub().connected,
        pageConnected: pageUrl !== null,
        pageProbe: probe,
        currentUrl: pageUrl,
        currentTitle: pageTitle,
        sessionSteps: getSession().stepCounter,
        pagesExplored: getSession().pages.size,
        hint: probe === 'timeout-fallback' ? 'get_status probe timed out (heavy/settling page) — reporting last-known session URL; ops may still work' : (getActiveHub().connected ? null : 'Extension not connected. Load the WebSense Chrome extension (extension/manifest.json) — it auto-connects to ws://localhost:38401 within 3s. Then call websense_guide.'),
      });
    }
    if (kind === 'doctor') {
      const hub = getActiveHub();
      const hubStats = (typeof hub.stats === 'function') ? hub.stats() : { port: hub.port, connectedClients: (hub.clients && hub.clients.size) || 0 };
      const report = { timestamp: Date.now(), hub: hubStats, session: { steps: getSession().stepCounter, pagesExplored: getSession().pages.size } };
      try {
        report.content = await Promise.race([
          hub.send({ type: 'doctor_content' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('content timeout (8s) — content script not responding')), 8000)),
        ]);
      } catch (e) { report.content = { error: String((e && e.message) || e) }; }
      try {
        report.serviceWorker = await Promise.race([
          hub.send({ type: 'doctor_sw' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('sw timeout (8s)')), 8000)),
        ]);
      } catch (e) { report.serviceWorker = { error: String((e && e.message) || e) }; }
      return textResult(report);
    }
    if (kind === 'downloads') return textResult(await getActiveHub().send({ type: 'download_state' }));
    return textResult(await getActiveHub().send({ type: 'page_state', frameId: o.frameId }));
  });

  // ═══ 11. WAIT ═══
  reg(server, 'wait', {
    description: 'Block until a condition (poll) OR a page event. Conditions (ANDed): urlContains, hasModal, hasCaptcha, notLoading, pendingDialogsGt, selector (CSP-safe), script (JS expr), timeoutMs, pollMs. Event mode: event:"dialog_open|dialog_close|navigation|network|form_update|any".',
    inputSchema: {
      urlContains: z.string().optional(),
      hasModal: z.boolean().optional(),
      hasCaptcha: z.boolean().optional(),
      notLoading: z.boolean().optional(),
      pendingDialogsGt: z.number().optional(),
      selector: z.string().optional().describe('Wait until querySelector matches (CSP-safe)'),
      script: z.string().optional().describe('Wait until JS expression truthy'),
      event: z.string().optional().describe('Event mode: dialog_open, dialog_close, navigation, network, form_update, any'),
      timeoutMs: z.number().optional().describe('Default 10000'),
      pollMs: z.number().optional().describe('Default 400'),
    },
  }, async (o) => {
    if (o.event) {
      const want = (o.event || 'any').toLowerCase();
      const deadline = Date.now() + (o.timeoutMs || 10000);
      let last = null;
      // P1#1 (2026-08-31): FIRST drain the hub's push event ring (the CS
      // pushes dialog_open/navigation as they happen — zero polling). Fall
      // back to the legacy CS get_events probe only if the ring is empty.
      // This collapses the wait-for-dialog loop from 250ms polls to instant.
      const ringHit = (function () {
        try {
          const st = getActiveHub().stats && getActiveHub().stats();
          const ring = (st && Array.isArray(st.eventRing)) ? st.eventRing : [];
          for (let i = ring.length - 1; i >= 0; i--) {
            const ev = ring[i];
            const et = (ev && (ev.event || '')).toLowerCase();
            if (want === 'any' || et === want) return ev;
          }
        } catch (_) {}
        return null;
      })();
      if (ringHit) return textResult({ success: true, event: ringHit, source: 'ring', timedOut: false });
      while (Date.now() < deadline) {
        try {
          const r = await getActiveHub().send({ type: 'get_events', since: Date.now() - 30000 });
          const inner = (r && typeof r === 'object' && r.data && typeof r.data === 'object' && 'events' in r.data) ? r.data : (r || {});
          const evts = inner.events || [];
          if (evts.length) {
            const hit = want === 'any' ? evts[evts.length - 1] : evts.slice().reverse().find((e) => (e.type || '').toLowerCase() === want);
            if (hit) return textResult({ success: true, event: hit, source: 'poll', timedOut: false });
          }
          last = inner;
        } catch (_) {}
        await new Promise((res) => setTimeout(res, 250));
      }
      return textResult({ success: false, timedOut: true, wanted: want, last: last || null });
    }
    const timeoutMs = o.timeoutMs || 10000;
    const pollMs = o.pollMs || 400;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    const hasDomCond = o.selector != null || o.script != null;
    while (Date.now() < deadline) {
      let domOk = true;
      if (hasDomCond) {
        try {
          const innerOf = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' &&
            ('success' in r.data || 'found' in r.data || 'result' in r.data || 'error' in r.data)) ? r.data : (r || {});
          const isCspBlocked = (inner) => !!(inner && (inner.cspBlocked === true ||
            /CSP blocked|Content Security Policy|unsafe-eval/i.test(String((inner && inner.error) || ''))));
          if (o.selector != null) {
            let ok = false;
            // 2026-09-25 FIX: the selector branch used to send an EVAL probe
            // (`!!document.querySelector(...)`) first, expect it to come back
            // CSP-blocked, and only then send the no-eval safe-query form. That
            // dependency never held: the eval probe never produced a usable
            // value (the extension's own MV3 CSP blocks new Function on every
            // page), so the fallback send never happened — measured 1 evaluate
            // send per poll and a clean timeout even for a selector that
            // evaluate{query} proves exists. Ask the no-eval path FIRST, which
            // works on every page and needs no detection round-trip. The eval
            // form is kept only as a last resort if the safe send throws.
            const selJson = JSON.stringify(o.selector);
            let inner = null;
            try {
              inner = innerOf(await getActiveHub().send({ type: 'evaluate', script: 'querySelector(' + selJson + ')' }));
            } catch (_) { inner = null; }
            if (inner) {
              ok = !!(inner.success !== false && (inner.found === true || (inner.result && inner.result.found === true)));
            } else {
              // Last resort: the eval form, in case a page wires safeDomRead out.
              try {
                const r = await getActiveHub().send({ type: 'evaluate', script: '!!document.querySelector(' + selJson + ')' });
                const i2 = innerOf(r);
                ok = !!(i2 && !isCspBlocked(i2) && i2.success !== false && (i2.result === true || i2.result === 'true'));
              } catch (_) { ok = false; }
            }
            if (!ok) domOk = false;
          }
          if (domOk && o.script != null) {
            let ok = false;
            const script = o.script.trim();
            const qsa = script.match(/^querySelectorAll\(\s*(['"])(.*?)\1\s*\)\.length\s*(>=|>|===|==)\s*(\d+)\s*$/);
            if (qsa) {
              const r3 = await getActiveHub().send({ type: 'evaluate', script: 'querySelectorAll(' + JSON.stringify(qsa[2]) + ')' });
              const inner3 = innerOf(r3);
              const cnt = (inner3 && inner3.count != null) ? inner3.count : (inner3 && inner3.results ? inner3.results.length : -1);
              const want = parseInt(qsa[4], 10);
              ok = qsa[3] === '>' ? cnt > want : qsa[3] === '>=' ? cnt >= want : cnt === want;
            } else {
              const selM = script.match(/^(?:!!)?querySelector\(\s*(['"])(.*?)\1\s*\)$/);
              if (selM) {
                const r3 = await getActiveHub().send({ type: 'evaluate', script: 'querySelector(' + JSON.stringify(selM[2]) + ')' });
                const inner3 = innerOf(r3);
                ok = !!(inner3 && inner3.success !== false && inner3.found === true);
              } else {
                try {
                  const r = await getActiveHub().send({ type: 'evaluate', script: o.script });
                  const inner = innerOf(r);
                  ok = !!(!isCspBlocked(inner) && inner.success !== false && (inner.result === true || inner.result === 'true'));
                } catch (_) { ok = false; }
              }
            }
            if (!ok) domOk = false;
          }
        } catch (_) { domOk = false; }
      }
      const hasStateCond = o.urlContains != null || o.hasModal != null || o.hasCaptcha != null || o.notLoading != null || o.pendingDialogsGt != null;
      let stateOk = true;
      if (hasStateCond) {
        try { last = await getActiveHub().send({ type: 'page_state' }); } catch (_) { last = null; }
        if (last && last.success !== false) {
          const okUrl = o.urlContains == null || (last.url || '').includes(o.urlContains);
          const okModal = o.hasModal == null || (o.hasModal ? !!last.hasModal : !last.hasModal);
          const okCaptcha = o.hasCaptcha == null || (o.hasCaptcha ? !!last.hasCaptcha : !last.hasCaptcha);
          const okLoading = o.notLoading === false ? true : (last.isLoading === false);
          const okDlg = o.pendingDialogsGt == null || ((last.pendingDialogs || []).length > o.pendingDialogsGt);
          stateOk = okUrl && okModal && okCaptcha && okLoading && okDlg;
        } else {
          stateOk = false;
        }
      }
      if (domOk && stateOk) {
        return textResult({ success: true, timedOut: false, state: last ? { url: last.url, hasModal: last.hasModal, hasCaptcha: last.hasCaptcha, isLoading: last.isLoading, pendingDialogs: last.pendingDialogs || [] } : null });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return textResult({ success: false, timedOut: true, state: last || null });
  });

  // ═══ 12. EVALUATE ═══
  reg(server, 'evaluate', {
    description: 'Run JS on the page, or do a CSP-proof no-eval DOM read. script:<js> runs and RETURNS A VALUE; on strict-CSP pages (and by default in MV3) it transparently re-routes through the MAIN world (chrome.userScripts) and reports via:"main_world". query:{selector,extract:"value|text|attrs|html",all,inputs,text,state} is the no-eval read path. Password/OTP values are always masked. PRINCIPLE 5: verify what the page actually accepted.',
    inputSchema: {
      script: z.string().optional().describe('JS to execute. A bare expression or statements both work; the value of the final expression is returned.'),
      tabId: z.number().optional().describe('Target tab (default: your session-bound tab)'),
      query: z.object({
        selector: z.string().optional(),
        extract: z.enum(['value', 'text', 'attrs', 'html']).optional(),
        all: z.boolean().optional(),
        inputs: z.boolean().optional(),
        text: z.boolean().optional(),
        state: z.boolean().optional(),
        maxLen: z.number().optional(),
      }).optional().describe('No-eval read mode (old evaluate_safe)'),
    },
  }, async (o) => {
    if (o.query) return textResult(await getActiveHub().send({ type: 'evaluate_safe', query: o.query }));
    const r = await getActiveHub().send({ type: 'evaluate', script: o.script });
    // 2026-09-25: script mode's isolated-world path uses new Function, which the
    // extension's OWN MV3 CSP blocks (script-src 'self' 'wasm-unsafe-eval') — so
    // it was dead on EVERY page, not just "strict sites". That was never an
    // architectural limit: chrome.userScripts.execute — the engine main_world
    // already uses — injects raw code into the MAIN world and needs no eval, and
    // the page's own CSP does not apply. So a CSP-blocked script now FALLS BACK
    // to that route instead of dead-ending, and the result says so. If the relay
    // is unavailable the original honest error is returned unchanged.
    //
    // NORMALIZE FIRST: on the relay path the payload can arrive as a JSON STRING
    // (textResult passes strings through verbatim). Measuring the CSP fields on
    // a string finds nothing, so cspBlocked evaluated false and the dead-end was
    // returned — which is why this branch looked unreachable.
    let rr = r;
    if (typeof rr === 'string') { try { rr = JSON.parse(rr); } catch (_) { /* keep the string */ } }
    const box = (rr && typeof rr === 'object' && rr.data && typeof rr.data === 'object') ? rr.data : (rr || {});
    const cspBlocked = box.cspBlocked === true
      || /CSP blocked|unsafe-eval|Content Security Policy/i.test(String(box.error || (typeof rr === 'string' ? rr : '')));
    if (!cspBlocked) return textResult(r);
    // 2026-09-25: do NOT resolve a tab here. Every page op is routed through the
    // central stamper, which injects this session's bound tab when a command
    // carries none — the same mechanism click/type_text rely on. Resolving it
    // locally was both redundant and wrong: `server` is not in scope inside this
    // registration callback, so the binding was always undefined and the
    // fallback silently dead-ended (measured: evaluate{script} kept returning the
    // CSP error even with an explicit tabId). Send it un-stamped and let the
    // router do its job.
    try {
      // Wrap the caller's script so BOTH shapes work:
      //  - a bare expression  → `return (EXPR);`
      //  - statement block    → run it; the last expression's value is returned
      // A bare `1+1` inside `(function(){ 1+1 })` evaluates and DISCARDS the
      // value (measured 2026-09-25: result came back null), so the expression
      // form has to be returned explicitly.
      const src = String(o.script || 'null').trim();
      // A statement block's value is its LAST expression, but we cannot know
      // where that is without parsing. Split on top-level semicolons and return
      // the final non-empty chunk — so `var x = 7; x * 6` yields 42 rather than
      // null. Chunks are rejoined so statements with `;` inside strings survive.
      const splitTopLevel = (text) => {
        const parts = []; let cur = ''; let q = null; let depth = 0;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (q) { cur += ch; if (ch === q && text[i - 1] !== '\\\\') q = null; continue; }
          if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
          if (ch === '(' || ch === '[' || ch === '{') depth++;
          if (ch === ')' || ch === ']' || ch === '}') depth--;
          if (ch === ';' && depth === 0) { parts.push(cur); cur = ''; continue; }
          cur += ch;
        }
        if (cur.trim()) parts.push(cur);
        return parts;
      };
      const chunks = splitTopLevel(src);
      let body;
      if (chunks.length > 1) {
        const last = chunks[chunks.length - 1].trim();
        const head = chunks.slice(0, -1).join(';');
        body = head + '; return (' + last + ');';
      } else if (/(^|[;{}])\s*(var|let|const|if|for|while|function|throw|try|switch|do)\b/.test(src)) {
        body = src;   // single statement that has no value of its own
      } else {
        body = 'return (' + src + ');';
      }
      const bridge = 'window.__wsEvalOut = {done:false};'
        + ' (function(){ try {'
        + '  var __r = (function(){ ' + body + ' }).call(window);'
        + '  Promise.resolve(__r).then(function(v){'
        + '    try { window.__wsEvalOut = {done:true, value: (function(){'
        + '      try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }'
        + '      catch(_){ return String(v); } })() }; } catch(_){}'
        + '  }, function(e){'
        + '    try { window.__wsEvalOut = {done:true, error: String((e && e.message) || e)}; } catch(_){}'
        + '  });'
        + ' } catch(e) {'
        + '  try { window.__wsEvalOut = {done:true, error: String((e && e.message) || e)}; } catch(_){}'
        + ' } })();';
      const viaMain = await getActiveHub().send({
        type: 'main_world_exec',
        tabId: o.tabId,   // undefined → the router stamps the session's bound tab
        func: '() => { ' + bridge + ' return true; }',
        args: [],
        allFrames: false,
      });
      const mbox0 = (viaMain && typeof viaMain === 'object' && viaMain.data && typeof viaMain.data === 'object') ? viaMain.data : (viaMain || {});
      if (mbox0 && mbox0.error) {
        // The bridge itself could not run (no tab, no userScripts, restricted
        // page). Say so plainly instead of pretending the CSP error was final.
        return textResult({ success: false, error: 'script mode: isolated-world eval is CSP-blocked and the MAIN-world fallback is unavailable — ' + String(mbox0.error), originalError: box.error });
      }
      // Poll the side channel briefly: a synchronous script is already done, a
      // promise settles on a microtask. 2s ceiling keeps a hanging promise from
      // wedging the call.
      const deadline = Date.now() + 2000;
      let out = null;
      while (Date.now() < deadline) {
        const poll = await getActiveHub().send({
          type: 'main_world_exec',
          tabId: o.tabId,
          func: '() => (window.__wsEvalOut || null)',
          args: [],
          allFrames: false,
        });
        const pb = (poll && typeof poll === 'object' && poll.data && typeof poll.data === 'object') ? poll.data : (poll || {});
        const first = Array.isArray(pb.results) && pb.results[0] ? pb.results[0] : null;
        if (first && first.result) {
          out = first.result;
          if (out && out.done) break;
        }
        await new Promise((res) => setTimeout(res, 40));
      }
      if (out && out.error) return textResult({ success: false, error: 'script threw: ' + out.error, via: 'main_world' });
      if (out && out.done) return textResult({ success: true, result: (out.value === undefined ? null : out.value), via: 'main_world', note: 'script ran in the page MAIN world (chrome.userScripts, no eval) because the isolated-world eval path is CSP-blocked by the extension policy' });
      return textResult({ success: false, error: 'script mode: the MAIN-world fallback did not return a value within 2s (a pending promise that never settles?)', via: 'main_world', originalError: box.error });
    } catch (fallbackErr) {
      return textResult({ success: false,
        error: 'script mode: isolated-world eval is CSP-blocked; MAIN-world fallback failed — ' + String((fallbackErr && fallbackErr.message) || fallbackErr),
        originalError: box.error });
    }
    return textResult(r);
  });

  // ═══ 13. AX BRIDGE ═══
  reg(server, 'ax', {
    description: 'Native accessibility tree via chrome.debugger — Chrome\'s EXTENSION API, NOT a CDP debug port, and ALLOWED (Ali 2026-09-20). No page-visible signal: measured navigator.webdriver=false, no automation globals, and Accessibility.getFullAXTree over a 2105-node tree produced no >=50ms main-thread long task; it attaches and detaches inside this one call and never enables the Debugger domain. Use for canvas SPAs (Telegram web, TradingView) and chrome:// pages the SAG cannot represent. action:"state" (full tree) | "read" (filter by role/name/nameContains) | "click" (match) | "type" (match, text). Requires explicit tabId. Shows a LOCAL debugger banner while attached — local UI, not page-readable.',
    inputSchema: {
      action: z.enum(['state', 'read', 'click', 'type']).describe('AX operation'),
      tabId: z.number().describe('Tab to act on (required)'),
      role: z.string().optional().describe('read: AX role filter e.g. "button"'),
      name: z.string().optional().describe('read: exact AX name match'),
      nameContains: z.string().optional().describe('read: substring AX name match'),
      match: z.object({ role: z.string().optional(), name: z.string().optional(), nameContains: z.string().optional() }).optional().describe('click/type: node matcher'),
      text: z.string().optional().describe('type: text to set'),
    },
  }, async (o) => {
    if (o.action === 'state') return textResult(await getActiveHub().send({ type: 'ax_state', tabId: o.tabId }));
    if (o.action === 'read') return textResult(await getActiveHub().send({ type: 'ax_read', tabId: o.tabId, role: o.role, name: o.name, nameContains: o.nameContains }));
    if (o.action === 'click') return textResult(await getActiveHub().send({ type: 'ax_click', tabId: o.tabId, match: o.match }));
    return textResult(await getActiveHub().send({ type: 'ax_type', tabId: o.tabId, match: o.match, text: o.text }));
  });

  // ═══ 14. SCREENSHOT ═══
  reg(server, 'screenshot', {
    description: 'Capture the visible tab. No debug port, no bot-detection surface. (chrome.tabs.captureVisibleTab, with a chrome.debugger fallback the result reports via mode=). Returns {dataUrl, mime} for a vision model. For pages the structured tree can\'t fully represent.',
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional().describe('Default png'),
      quality: z.number().optional().describe('JPEG quality 0-100 (default 80)'),
    },
  }, async (o) => {
    let r = await getActiveHub().send({ type: 'browser_screenshot', format: o.format || 'png', quality: o.quality || 80 });
    // Normalize: a relay path can hand back a JSON STRING rather than the object
    // (textResult passes strings through verbatim, so the client would have to
    // parse twice). Always emit one object shape.
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { r = { success: false, error: r.slice(0, 300) }; } }
    if (r && r.dataUrl) {
      const d = imageSize(r.dataUrl);
      if (d.width) { r.width = d.width; r.height = d.height; }
      // The two capture paths differ in height (visible-tab vs rendered page), so
      // say which produced this frame instead of leaving the caller to guess.
      r.note = 'mode=' + (r.mode || 'unknown') + ' — visible-tab and debugger-fallback frames can differ in height; use width/height above when mapping page coords to pixels.';
    }
    return textResult(r);
  });

  // ═══ 15. PRESS_KEY ═══
  reg(server, 'press_key', {
    description: 'Press key(s) with modifiers: press_key("c",["ctrl"]) = Ctrl+C, press_key("Tab",["shift"]) = Shift+Tab. Optional ref target (default: focused element).',
    inputSchema: {
      key: z.string().describe('Key name e.g. "Enter", "Tab", "Escape", "c", "ArrowDown"'),
      ref: z.string().optional().describe('Element ref to target'),
      modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional(),
    },
  }, async (o) => textResult(await getActiveHub().send({ type: 'press_key', key: o.key, ref: o.ref, modifiers: o.modifiers || [], frameId: o.frameId })));

  // ═══ 16. DIALOG ═══
  reg(server, 'dialog', {
    description: 'Resolve dialogs. JS dialogs (alert/confirm/prompt — captured, non-blocking): action:"accept"|"dismiss" + index? + value? (prompt answer). OS-level dialogs (basic-auth, print — unreachable by DOM): keystroke:true + key:"enter|escape|tab|space|f5|ctrl+c" + optional value typed first (e.g. credentials).',
    inputSchema: {
      action: z.enum(['accept', 'dismiss']).optional().describe('JS-dialog resolution'),
      index: z.number().optional().describe('Which captured dialog (default newest)'),
      value: z.string().optional().describe('Prompt answer / text typed before keystroke'),
      keystroke: z.boolean().optional().describe('OS-level mode (old dismiss_dialog)'),
      key: z.string().optional().describe('keystroke: enter|escape|tab|space|f5|combo like ctrl+c'),
    },
  }, async (o) => {
    if (o.keystroke) {
      try {
        if (process.platform !== 'win32') {
          return textResult({ success: false, error: 'OS-level keystroke is Windows-only (PowerShell SendKeys). On ' + process.platform + ', resolve OS dialogs with your platform\'s native automation.' });
        }
        if (!o.key && !o.value) return textResult({ success: false, error: 'Provide key or value' });
        let ps = 'Add-Type -AssemblyName System.Windows.Forms; ';
        if (o.value) ps += '[System.Windows.Forms.SendKeys]::SendWait(' + JSON.stringify(escapeSendKeys(o.value)) + '); Start-Sleep -Milliseconds 120; ';
        if (o.key) ps += '[System.Windows.Forms.SendKeys]::SendWait(' + JSON.stringify(sendKeysForWindows(o.key)) + ');';
        execSync('powershell -NoProfile -NonInteractive -Command ' + JSON.stringify(ps), { timeout: 12000, windowsHide: true });
        return textResult({ success: true, sent: o.key || null, typed: o.value ? true : false });
      } catch (e) { return textResult({ success: false, error: String((e && e.message) || e) }); }
    }
    return textResult(await getActiveHub().send({ type: 'handle_dialog', action: o.action || 'accept', index: (o.index === undefined ? null : o.index), value: (o.value === undefined ? null : o.value) }));
  });

  // ═══ 17. SESSION ═══
  reg(server, 'session', {
    description: 'Exploration session: action:"reset" (clear map + tab binding — use when starting a new task) | "map" (pages visited, action history, current position) | "mermaid" (Mermaid flowchart of the journey; direction, detail) | "task" (P2 task-stack: op:"begin"|"done"|"skip"|"status", goal, steps — per-session state machine so multi-step journeys keep their next-action in one place).',
    inputSchema: {
      action: z.enum(['reset', 'map', 'mermaid', 'task']).describe('Session operation'),
      direction: z.enum(['TD', 'LR', 'BT', 'RL']).optional().describe('mermaid layout (default TD)'),
      detail: z.enum(['pages', 'pages_actions']).optional().describe('mermaid detail (default pages_actions)'),
      // P2 task-stack params
      op: z.enum(['begin', 'done', 'skip', 'status']).optional().describe('task: operation'),
      goal: z.string().optional().describe('task begin: the task goal'),
      steps: z.array(z.union([z.string(), z.object({ label: z.string() })])).optional().describe('task begin: ordered step labels'),
      step: z.string().optional().describe('task done/skip: step label (omitting marks the current next-action)'),
    },
  }, async (o) => {
    if (o.action === 'reset') {
      getSession().reset();
      try { await getActiveHub().send({ type: 'clear_binding' }); } catch (_) {}
      return textResult({ success: true, message: 'Session reset. Tab binding cleared.' });
    }
    if (o.action === 'task') {
      if (o.op === 'begin') {
        if (!o.goal) return textResult({ success: false, error: 'task begin requires a goal' });
        getSession().beginTask(o.goal, o.steps || []);
        return textResult({ success: true, task: getSession().getTask() });
      }
      if (o.op === 'done') { getSession().completeStep(o.step); return textResult({ success: true, task: getSession().getTask() }); }
      if (o.op === 'skip') { getSession().skipStep(o.step); return textResult({ success: true, task: getSession().getTask() }); }
      return textResult({ success: true, task: getSession().getTask() }); // status
    }
    if (o.action === 'mermaid') {
      const mermaid = exportMermaid(getSession().getExplorationMap(), { direction: o.direction || 'TD', detail: o.detail || 'pages_actions' });
      return textResult('```mermaid\n' + mermaid + '\n```');
    }
    return textResult(getSession().getExplorationMap());
  });

  // ═══ 18. NETWORK ═══
  reg(server, 'network_log', {
    description: 'Captured fetch/XHR since last call (call once to start, again after interactions). Returns URLs, methods, statuses, response bodies (truncated). clear, maxEntries.',
    inputSchema: {
      clear: z.boolean().optional().describe('Clear log after returning (default true)'),
      maxEntries: z.number().optional().describe('Default 50'),
    },
  }, async (o) => textResult(await getActiveHub().send({ type: 'network_log', clear: o.clear !== false, maxEntries: o.maxEntries || 50 })));

  // ═══ 19. CONSOLE (parity with Hermes browser_console — 2026-08-30) ═══
  reg(server, 'console_log', {
    description: 'Captured browser console + JS errors since last call (console.log/warn/error/info/debug + window.onerror + unhandledrejection, ring buffer 300). Call once to start capturing, then again after an interaction that "does nothing" to read what the page JS is complaining about. clear, maxEntries (default 100).',
    inputSchema: {
      clear: z.boolean().optional().describe('Clear the buffer after returning (default true)'),
      maxEntries: z.number().optional().describe('Max entries to return (default 100)'),
    },
  }, async (o) => textResult(await getActiveHub().send({ type: 'console_log', clear: o.clear !== false, maxEntries: o.maxEntries || 100 })));

  // ═══ 19b. COOKIES (P2 — 2026-08-31) ═══
  // Session inspection / transplant / cleanup. Values ARE returned for
  // action:'get' (needed for session transplant between tabs/profiles);
  // action:'list' is metadata-only (names, expiry, flags).
  reg(server, 'cookies', {
    description: 'Cookie session manager: action:"list" (metadata for a url domain — names, expiry, httpOnly, secure; NO values) | "get" (one cookie WITH value — for session transplant) | "clear" (one cookie by name) | "clear_all" (all cookies for the domain). url is the page/API origin.',
    inputSchema: {
      action: z.enum(['list', 'get', 'clear', 'clear_all']).optional().describe('Default list'),
      url: z.string().describe('Page/API origin e.g. https://hackerone.com'),
      name: z.string().optional().describe('Cookie name (get/clear)'),
    },
  }, async (o) => textResult(await getActiveHub().send({ type: 'cookie_op', op: o.action || 'list', url: o.url, name: o.name, frameId: o.frameId })));

  // ═══ 19c. RESPAWN OFFSCREEN (P2 — 2026-08-31) ═══
  // MV3 keeps the offscreen document alive across extension-card reloads, so
  // after editing offscreen.js the old code keeps running and new ops 404
  // ('Unknown action type'). This forces closeDocument + recreate so the
  // CURRENT on-disk code loads. Pure SW op — safe, no page impact.
  reg(server, 'respawn_offscreen', {
    description: 'Force-close + recreate the offscreen document so the CURRENT on-disk extension code loads. Use after editing offscreen.js/background.js when new tab ops return "Unknown action type" (MV3 does not reload the offscreen on card reload). No page impact.',
    inputSchema: {},
  }, async () => textResult(await getActiveHub().send({ type: 'respawn_offscreen' })));

  // ═══ 19d. EXTENSION SELF-RELOAD (v4 — 2026-08-31) ═══
  // Full `chrome.runtime.reload()` without the chrome://extensions dance.
  // Flow: SW reloads itself → all extension contexts die → hub loses the client
  // → the fresh SW's keepalive reconnects within ~3s → hub answers 'extension_reloaded'.
  // The server polls the hub until it's back (default 15s), so the MCP result
  // arrives AFTER the extension is live again — no manual reload, no dead window.
  reg(server, 'extension_reload', {
    description: 'Reload the WebSense extension itself (chrome.runtime.reload) and wait for it to reconnect. Use after editing ANY extension file (websense-cs.js, offscreen.js, background.js, manifest) so on-disk code goes live — replaces the manual chrome://extensions Reload click. Returns reconnected status; page tabs are NOT closed (content scripts re-inject on next navigate or explore).',
    inputSchema: {
      timeoutMs: z.number().optional().describe('How long to wait for reconnect (default 15000)'),
    },
  }, async (o) => {
    const hub = getActiveHub();
    const timeoutMs = (o && o.timeoutMs) || 15000;
    // Read-only hub census accessor. Declared FIRST because it is used below to
    // snapshot client ids before the reload — a `const` arrow is in the temporal
    // dead zone until its own line runs, so ordering here is load-bearing.
    const censusSnap = () => {
      try { return (typeof hub.census === 'function') ? hub.census() : null; } catch (_) { return null; }
    };
    // Snapshot the CLIENT IDS before reloading. Connectivity alone is not evidence
    // that a reload happened — a client was already connected BEFORE the call, so a
    // connectivity-only probe reports success unconditionally (measured 2026-09-11d:
    // ids c1,c2,c3 identical before and after while chrome.runtime.reload() had in
    // fact never run, and the on-disk content script stayed STALE). A real reload
    // replaces clients, so require the id set to change.
    const idSet = (c) => (Array.isArray(c && c.clients) ? c.clients.map((x) => x.id).sort().join(',') : '');
    const beforeIds = idSet(censusSnap());
    let reloadSent = false;
    try {
      await hub.send({ type: 'extension_reload' });
      reloadSent = true;
    } catch (e) {
      // expected: the SW dies mid-request, so the send may reject. Treat as sent.
      reloadSent = true;
    }
    // LIVENESS PROBE (2026-09-11d). The old probe sent get_status through the
    // relay and was wrong twice over: (a) right after chrome.runtime.reload() the
    // hub can still hold the OLD offscreen socket, so a message gets accepted by a
    // context that no longer exists (zombie) — the probe then reported a FALSE
    // NEGATIVE while the extension was already healthy; (b) content scripts
    // re-inject lazily, so nothing can answer yet even when the reload succeeded.
    // Ask the hub's own READ-ONLY client census instead — a dead route cannot fool
    // it — and keep the message probe only as a fallback for older hubs.
    const t0 = Date.now();
    let back = false;
    let changed = false;
    let dropped = false;
    let lastErr = null;
    let lastCensus = null;
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 400));
      const c = censusSnap();
      if (c) {
        lastCensus = { clientsRegistered: c.clientsRegistered, offscreenConnected: c.offscreenConnected === true, ids: idSet(c) };
        const anyOpen = Array.isArray(c.clients) && c.clients.some((x) => x.readyStateName === 'OPEN');
        if (c.clientsRegistered === 0) dropped = true;
        // A changed id set is the signal that a reload actually occurred.
        if (lastCensus.ids !== beforeIds) { changed = true; if (anyOpen) { back = true; break; } }
        if (anyOpen) back = true;      // connected, but not (yet) proven reloaded
        continue;
      }
      try {   // census unavailable (older hub) — message probe
        const st = await hub.send({ type: 'get_status' }, { timeoutMs: 4000 });
        if (st && (st.hubConnected || st.connected || st.ok)) { back = true; break; }
      } catch (e) { lastErr = String(e); }
    }
    const verified = changed || (dropped && back);
    return textResult({
      reloadSent,
      reconnected: back,
      reloadVerified: verified,
      waitedMs: Date.now() - t0,
      probe: lastCensus ? 'hub-census' : 'get_status-fallback',
      clientIdsBefore: beforeIds || undefined,
      clientsSeen: lastCensus || undefined,
      lastError: verified ? undefined : (lastErr || 'the client set never changed'),
      note: verified
        ? 'extension reloaded and reconnected — fresh code is live. Re-bind tabs before page ops (content scripts re-inject lazily).'
        : 'NOT VERIFIED — the client id set never changed (' + (beforeIds || 'none') + '), so a reload probably never ran and the ON-DISK code may NOT be live even though a client is connected. Use the popup path instead: navigate a tab to chrome-extension://<id>/popup.html and click Reconnect (chrome.runtime.reload() runs directly in the popup).',
    });
  });

  // ═══ 20. CLIPBOARD ═══
  reg(server, 'clipboard', {
    description: 'System clipboard: action:"copy" (text) | "read" (needs clipboardRead permission; best-effort).',
    inputSchema: {
      action: z.enum(['copy', 'read']).describe('Clipboard operation'),
      text: z.string().optional().describe('copy: text to copy'),
    },
  }, async (o) => {
    if (o.action === 'read') return textResult(await getActiveHub().send({ type: 'read_clipboard' }));
    return textResult(await getActiveHub().send({ type: 'copy_to_clipboard', text: o.text, frameId: o.frameId }));
  });

  // ═══ 20. INSPECT ═══
  reg(server, 'inspect', {
    description: 'Element introspection without vision: kind:"element" (is ref alive? re-resolve after re-render → {found,tag,text,locator}) | "geometry" (bounding box, z-depth, position vs real scroll container; ref or selector) | "relation" (refA vs refB: above/below/overlaps/covers — modal-over-form detection).',
    inputSchema: {
      kind: z.enum(['element', 'geometry', 'relation']).describe('What to inspect'),
      ref: z.string().optional().describe('element/geometry: element ref'),
      selector: z.string().optional().describe('geometry: CSS selector alternative'),
      refA: z.string().optional().describe('relation: first element'),
      refB: z.string().optional().describe('relation: second element'),
    },
  }, async (o) => {
    if (o.kind === 'geometry') return textResult(await getActiveHub().send({ type: 'geometry', ref: o.ref, selector: o.selector }));
    if (o.kind === 'relation') return textResult(await getActiveHub().send({ type: 'layout_relation', refA: o.refA, refB: o.refB }));
    return textResult(await getActiveHub().send({ type: 'resolve_ref', ref: o.ref }));
  });

  // ═══ 21. REAL-INPUT RUNG (v4.4 — 2026-09-01) ═══
  // Synthetic events are ignored by React/Lit/Custom-Element submit buttons
  // (shreddit, Lexical editors, faceplate components). These tools climb the
  // ladder to GENUINE OS input via UIA (pywinauto) + SendInput (pyautogui),
  // title-gated so multi-agent tab churn can't land input on a sibling tab.
  // All coords are VIEWPORT coords (same space as inspect geometry); the
  // helper measures the Chrome Document origin itself.
  const PY = process.env.WEBSENSE_PYTHON || 'C:/Users/Ali/AppData/Local/Programs/Python/Python311/python.exe';
  const REAL_INPUT = fileURLToPath(new URL('../scripts/real_input.py', import.meta.url));

  function runRealInput(args) {
    const out = execSync(`"${PY}" "${REAL_INPUT}" ${args}`, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    try { return JSON.parse(out.trim().split('\n').pop()); }
    catch (e) { return { success: false, error: 'parse failed: ' + out.slice(0, 300) }; }
  }

  // Genuine OS input (click/paste) is delivered OUTSIDE the page's JS, so there is
  // no synthetic event to inspect — the only honest check is whether page state
  // changed. Capture it around the call and classify (2026-09-11d). Previously the
  // escalation rung — the one that exists precisely BECAUSE synthetic input is
  // unreliable — was the only rung returning no verdict at all.
  // LIMIT (stated, not hidden): page_state covers url/title/readyState/scroll, so a
  // modal or DOM-only change reads as suspected_noop. That is NOT proof of failure.
  async function withEffect(fn) {
    const quick = async () => { try { return await getActiveHub().send({ type: 'page_state' }); } catch (_) { return null; } };
    const before = await quick();
    const res = await fn();
    if (!res || typeof res !== 'object' || res.success === false) return res;
    await new Promise((r) => setTimeout(r, 450));   // let the handler run
    const after = await quick();
    res.beforeState = before;
    res.afterState = after;
    res.effect = classifyEffect(res);
    if (res.effect !== 'confirmed') {
      res.escalation = {
        recommended: 'read',
        reason: 'page_state (url/title/scroll) did not change after genuine OS input. This does NOT prove the click failed — a modal or DOM-only change will not show here. Verify by re-reading the DOM or taking a screenshot.',
      };
    }
    return res;
  }

  // ═══ 21b. MAIN-WORLD INSIDER TOOLKIT (v4.5 — 2026-09-01, Ali directive) ═══
  // The F12-equivalent: run a COMPILED function inside the page's own JS
  // universe (world:'MAIN') where React fibers / Lexical instances / Lit
  // internals are reachable. The page sees page-context code — isTrusted is
  // irrelevant because we call the app's OWN API (editor.update(), native
  // setters on real instances). 100% background, CSP-immune (no eval — the
  // function is serialized by Chrome itself), no CDP, no webdriver surface.
  // Ladder position: BEFORE real-input (this removes most foreground need).
  reg(server, 'main_world', {
    description: 'Run a COMPILED function in the page MAIN world (F12-insider path). Reads/writes framework state isolated-world code cannot see: React fiber props/state, Lexical editor instances (window.__lexicalEditor etc), Lit custom-element internals, window globals. func: a function expression string e.g. "(el) => el.textContent" — args are JSON-serializable, first arg may be a selector string to resolve to an element. 100% background, CSP-immune, no CDP. Use when synthetic type/click is ignored AND you need state-truth beyond the DOM (e.g. call editor.update() on a Lexical instance, read component state, click through framework APIs).',
    inputSchema: {
      func: z.string().describe('Function expression string, e.g. "() => window.location.href" or "(el, txt) => { el.textContent = txt; el.dispatchEvent(new Event(\'input\', {bubbles:true})); return el.textContent; }"'),
      args: z.array(z.any()).optional().describe('JSON-serializable args. If args[0] is a string, it is treated as a CSS selector and resolved to the element before your function runs.'),
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      allFrames: z.boolean().optional().describe('Run in all frames (default main frame only)'),
    },
  }, async (o) => {
    const tabId = o.tabId || sessionTabOf();
    if (!tabId) return textResult({ success: false, error: 'no tab bound — bind/navigate first or pass tabId' });
    return textResult(await getActiveHub().send({ type: 'main_world_exec', tabId, func: o.func, args: o.args || [], allFrames: !!o.allFrames }));
  });

  // ═══ 21c. PAGE SNAPSHOT + ADDRESSABLE INDEX + SLICE (Ali 2026-09-21) ═══
  // "why can't the structuring not cut anything out but simply map or index the webpage
  //  for agentic use... implement fully and wire locally and test end to end."
  //
  // page_snapshot collects a LOSSLESS inventory (via main_world — no extension change)
  // and returns only the small INDEX. page_slice then fetches ONE slice at full fidelity.
  // Store everything, ship the index, make every element addressable.
  // 2026-09-25 TEST HARNESS. The MCP transport DROPS declared properties whose
  // name it considers self-evident — tools/list served this tool with only
  // `frameId` visible, so `op`/`args` never reached the handler and every call
  // arrived as {type: undefined} -> "Unknown content action: undefined". That is
  // the same class of silent transport loss that hid earlier fixes, so the
  // harness reads its payload from frameId (a name the transport keeps) rather
  // than from a declared property.
  reg(server, 'raw_op', {
    description: 'TEST HARNESS ONLY — `query` carries a JSON string {"op":"<name>","args":{...}}. Disabled unless the server runs with WS_RAW_OP=1. Not a product tool.',
    // reg() reads def.inputSchema ONLY. A `properties` key at the top level is
    // silently IGNORED, so the parameter never reaches the wire schema and the
    // handler sees undefined. (This is also why frameId cannot be reused: reg()
    // overwrites any declared frameId with z.number().)
    inputSchema: {
      // Zod, not raw JSON schema: every other tool in this file declares params
      // with z.* and the SDK's key validator expects that shape. A hand-written
      // JSON schema registers but throws "keyValidator._parse is not a function"
      // on the first call.
      query: z.string().describe('JSON: {"op":"<name>","args":{...},"via":"direct"|"relay"}'),
    },
  }, async (o) => {
    if (process.env.WS_RAW_OP !== '1') {
      return textResult({ success: false, error: 'raw_op is a test harness and is disabled. Set WS_RAW_OP=1 on the server to enable it.' });
    }
    let spec;
    try { spec = JSON.parse(String(o.query)); }
    catch (e) { return textResult({ success: false, error: 'raw_op: pass query as JSON, e.g. {"op":"action_preview","args":{"ref":"E0"}} (got: ' + String(o.query).slice(0, 60) + ')' }); }
    if (!spec || typeof spec.op !== 'string') {
      return textResult({ success: false, error: 'raw_op: query JSON must contain {"op":"<name>"}' });
    }
    const hub = getActiveHub();
    // `via` FORCES a transport so the same op can be executed on BOTH
    // dispatchers. Without it the hub picks by availability, and comparing the
    // two copies of an op is not a test — it is a coin flip.
    //   direct -> the content script's wsHandle/wsDispatchPage switch (00-*.js)
    //   relay  -> offscreen -> SW -> handleMessage/handleMessageAsync (70-*.js)
    //
    // getActiveHub() is a THIN ALLOW-LIST wrapper: it exposes only connected /
    // send / stats / census, so the hub internals must be reached via
    // `getRawHub()` below. There is no sendTo() on HubServer, so the pending
    // map is driven by hand (mirroring HubServer.send) and the promise is
    // settled by _settlePending when the content script replies.
    const raw = getRawHub();
    const via = spec.via === 'direct' || spec.via === 'relay' ? spec.via : null;
    const cmd = withSessionTab({ type: spec.op, ...(spec.args || {}) });
    if (!via) {
      const r = await hub.send(cmd);
      const box = (r && typeof r === 'object' && r.data && typeof r.data === 'object') ? r.data : (r || {});
      return textResult({ op: spec.op, via: 'auto', transport: 'auto', success: !box.error, raw: box, error: box.error || null });
    }
    const targetTab = cmd.tabId != null ? Number(cmd.tabId) : raw.selectedTabId;
    const client = via === 'direct'
      ? raw.contentByTab.get(targetTab)
      : raw.offscreenClient;
    if (!client || client.readyState !== 1) {
      return textResult({
        op: spec.op, via, success: false,
        skipped: via === 'direct'
          ? 'no direct content-script client for this tab — the direct WebSocket is not connected, so 00-bridge cannot be exercised right now'
          : 'no offscreen client connected',
      });
    }
    const r = await raw.sendViaClient(client, cmd);
    const box = (r && typeof r === 'object' && r.data && typeof r.data === 'object') ? r.data : (r || {});
    return textResult({ op: spec.op, via, transport: via, client: client.cid, success: !box.error, raw: box, error: box.error || null });
  });

  reg(server, 'page_snapshot', {
    description: 'LOSSLESS page inventory held server-side; returns the small INDEX (counts + addressable dimensions). Then call page_slice to fetch one slice at full fidelity. Unlike explore_page nothing is filtered out (no interactive-only, no in-viewport-only), and unlike the scan cache the snapshot does NOT change when you scroll. fresh:true re-collects.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      fresh: z.boolean().optional().describe('Re-collect even if a live snapshot exists'),
    },
  }, async (o) => {
    const tabId = o.tabId || sessionTabOf();
    if (!tabId) return textResult({ success: false, error: 'no tab bound — bind/navigate first or pass tabId' });
    const existing = getSnapshot(tabId);
    if (existing && !o.fresh) {
      return textResult({
        success: true, cached: true, handle: 'snap:' + tabId + ':' + existing.seq,
        seq: existing.seq, ageMs: Date.now() - existing.at, index: existing.index,
        hint: 'slice it with page_slice{tag|role|region|vp|interactive|query}. fresh:true to re-collect.',
      });
    }
    const res = await getActiveHub().send({ type: 'main_world_exec', tabId, func: COLLECTOR, args: [] });
    // The inventory comes back as {success, results:[{frameId, result:{...}}]} — frame 0 is
    // the main frame. (Earlier versions of this handler looked for res.result / res.data.result
    // and reported "no inventory" while the collector had worked perfectly; measured, not read.)
    const snap = (res && res.result)
      || (res && Array.isArray(res.results) && res.results[0] && res.results[0].result)
      || (res && res.data && res.data.result)
      || (res && res.data && Array.isArray(res.data.results) && res.data.results[0] && res.data.results[0].result);
    if (!snap || !Array.isArray(snap.elements)) {
      return textResult({
        success: false, error: 'the collector returned no element inventory',
        got: JSON.stringify(res).slice(0, 400),
      });
    }
    const { seq, index } = putSnapshot(tabId, snap);
    getSession().recordAction({ action: 'page_snapshot', tabId }, { elements: index.elements });
    return textResult({
      success: true, cached: false, handle: 'snap:' + tabId + ':' + seq, seq, index,
      hint: 'slice it with page_slice{tag|role|region|vp|interactive|query}.',
    });
  });

  reg(server, 'page_slice', {
    description: 'Full-fidelity records from the stored page snapshot, filtered to ONE slice: tag / role / region / vp (true|false) / interactive / query (+limit, default 200). This is how you load only the branch you need WITHOUT re-reading the page and without cutting anything out. Call page_snapshot first.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      tag: z.string().optional().describe('Filter by tag, e.g. input'),
      role: z.string().optional().describe('Filter by ARIA role'),
      region: z.string().optional().describe('Filter by region substring, e.g. form, nav, footer'),
      vp: z.boolean().optional().describe('true = in viewport only, false = off-viewport only'),
      interactive: z.boolean().optional().describe('true = actionable elements only'),
      query: z.string().optional().describe('Substring match over name / locator / tag'),
      limit: z.number().optional().describe('Max records (default 200, hard max 2000)'),
    },
  }, async (o) => {
    const tabId = o.tabId || sessionTabOf();
    const e = getSnapshot(tabId);
    if (!e) {
      return textResult({
        success: false,
        error: 'no live snapshot for tab ' + tabId + ' — call page_snapshot first (or it expired)',
        stats: snapshotStats(),
      });
    }
    const s = sliceSnapshot(e.snap, o);
    return textResult({
      success: true, snapshotSeq: e.seq, ageMs: Date.now() - e.at, url: e.snap.url,
      matched: s.matched, returned: s.returned, truncatedByLimit: s.truncatedByLimit,
      elements: s.elements,
    });
  });

  reg(server, 'real_activate_tab', {
    description: 'OS-INPUT ONLY (before real_click/real_paste) — page ops NEVER need this. REAL OS click on a Chrome tab pill via UIA (pywinauto click_input): makes the tab the OS-active one and gates on the window title. match: substring of the tab title; gate: expected title after activation (default match). WHEN YOU NEED IT: only before OS-LEVEL INPUT (real_click / real_paste), because SendInput lands on whatever window is frontmost. You do NOT need it for page ops — navigate, explore_page, read, click(ref), type_text, inspect, form and main_world all travel over tabs.sendMessage by tabId and work on a backgrounded tab (measured 2026-09-20: bound an active:false tab, no activation, explore_page returned 29 live matches). It CANNOT fix a minimised Chrome window either — a UIA click needs the window on screen; restore that with focus_window instead. Do not reach for it as a liveness remedy for a hang: diagnose a minimised/occluded window or a parked native dialog first. Requires the user\'s foreground — never use it for routine page work.',
    inputSchema: {
      match: z.string().describe('Tab title substring to match (e.g. "Submit to r/mcp")'),
      gate: z.string().optional().describe('Expected window title after activation (default: match)'),
    },
  }, async (o) => textResult(await withEffect(() => runRealInput(`activate-tab --match "${(o.match||'').replace(/"/g,'\\"')}"${o.gate ? ` --gate "${o.gate.replace(/"/g,'\\"')}"` : ''}`))));

  reg(server, 'real_click', {
    description: 'GENUINE OS-level click (SendInput) at VIEWPORT coords (x,y) — bypasses synthetic-click-ignoring submit buttons (React/Lit/CustomElement). Title-gated: gate must match the active Chrome tab title or the click is refused (multi-agent churn protection). Get coords from inspect{kind:"geometry"}. origin: override doc-origin Y if the auto-measure fails (default measured via UIA).',
    inputSchema: {
      x: z.number().describe('Viewport X (from inspect geometry: vp.x + vp.w/2)'),
      y: z.number().describe('Viewport Y (from inspect geometry: vp.y + vp.h/2)'),
      gate: z.string().describe('Expected active-tab title substring (gate)'),
      origin: z.number().optional().describe('Override page Document origin Y (default: auto-measured ~121)'),
    },
  }, async (o) => textResult(await withEffect(() => runRealInput(`click-xy --x ${Math.round(o.x)} --y ${Math.round(o.y)} --gate "${(o.gate||'').replace(/"/g,'\\"')}"${o.origin ? ` --origin ${Math.round(o.origin)}` : ''}`))));

  reg(server, 'real_paste', {
    description: 'GENUINE paste into a focused editor (click at VIEWPORT coords + system clipboard + real Ctrl+V) — for Lexical/Draft.js/ProseMirror editors that revert synthetic paste events. text: content to paste; x,y: viewport coords of the editor (inspect geometry center); gate: expected active-tab title substring. Verify after with evaluate extract:"html".',
    inputSchema: {
      x: z.number().describe('Editor viewport X center'),
      y: z.number().describe('Editor viewport Y center'),
      text: z.string().describe('Text to paste'),
      gate: z.string().describe('Expected active-tab title substring (gate)'),
    },
  }, async (o) => textResult(await withEffect(() => runRealInput(`paste-text --x ${Math.round(o.x)} --y ${Math.round(o.y)} --gate "${(o.gate||'').replace(/"/g,'\\"')}" --text "${String(o.text).replace(/"/g,'\\"')}"`))));

  // Slim tool schemas on the wire (Ali directive 2026-08-18)
  installSchemaMinifier(server);
}

// ═══ Main — supports stdio and HTTP transport ═══

async function main() {
  // Start Chrome hub only (plain ws://38401)
  await hubChrome.start();

  if (USE_HTTP) {
    // ── HTTP mode: persistent server, multiple clients ──
    const sessions = new Map(); // sessionId -> { server, transport }

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers for MCP clients
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check — REAL client census (2026-09-11): who is connected, which
      // content-script client owns which tab, what is in flight, hub uptime.
      // STRICTLY READ-ONLY (census() never mutates hub state). The legacy
      // fields (status/hubConnected/extensionConnected) are kept for existing
      // consumers; everything else is the census.
      if (req.url === '/health' || (req.url || '').startsWith('/health?')) {
        let census = {};
        try {
          census = (typeof hubChrome.census === 'function') ? hubChrome.census() : {};
        } catch (err) {
          census = { status: 'census_failed', error: String((err && err.message) || err) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          hubConnected: hubChrome.connected,
          extensionConnected: hubChrome.connected,
          ...census,
        }, null, 2));
        return;
      }

      // Only handle /mcp endpoint
      if (req.url !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found. Use /mcp endpoint.');
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      let session = sessionId ? sessions.get(sessionId) : null;

      try {
        if (!session) {
          // New session: create server + transport
          const server = new McpServer({ name: 'websense-mcp', version: '1.0.0' });
          registerAllTools(server);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
          transport.onclose = () => {
            console.error('[websense] HTTP client disconnected');
            if (transport.sessionId) sessions.delete(transport.sessionId);
            // Release this session's tab claim so a dead session cannot cause false
            // refusals for later ones (registry is keyed by the server object).
            try { boundTabsBySession.delete(server); } catch (_) {}
          };
          await server.connect(transport);
          session = { server, transport };
        }

        console.error(`[websense-http] ${req.method} ${req.url} sessionId=${sessionId || '(new)'} existing=${!!sessions.get(sessionId)}`);

        // Per-session routing context (concurrency fix 2026-08-12): run the
        // request inside AsyncLocalStorage carrying THIS session's bound tab,
        // so every hub command this session issues routes to ITS tab — never
        // the shared global binding (worker sessions can no longer hijack the
        // collector's login tab).
        const store = { boundTabId: session.server && session.server._wsBoundTabId != null ? session.server._wsBoundTabId : null, server: session.server };
        await sessionCtx.run(store, () => session.transport.handleRequest(req, res));

        // After first initialize, store session by transport sessionId
        if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
          sessions.set(session.transport.sessionId, session);
          console.error(`[websense-http] session registered: ${session.transport.sessionId}`);
        }

        // Clean up on DELETE
        if (req.method === 'DELETE' && session.transport.sessionId) {
          sessions.delete(session.transport.sessionId);
          try { await session.transport.close(); } catch (_) {}
        }
      } catch (err) {
        console.error('[websense-http] request error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });

    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      console.error(`[websense] MCP server ready (HTTP) — http://127.0.0.1:${HTTP_PORT}/mcp`);
      console.error(`[websense] Extension connection on localhost:${PORT}`);
      console.error('[websense] Multiple MCP clients can connect simultaneously.');
    });
  } else {
    // ── stdio mode: single client (backward compatible) ──
    const server = new McpServer({ name: 'websense-mcp', version: '1.0.0' });
    registerAllTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[websense] MCP server ready (stdio) — extension connection on localhost:' + PORT);
    console.error('[websense] For multi-client mode, use: node src/server.js --http');
  }

  setInterval(() => { hubChrome.healthCheck(); }, 30000);
}

main().catch((err) => { console.error('[websense] Fatal:', err.message); process.exit(1); });

// Global crash prevention — never let unhandled rejections kill the server
process.on('unhandledRejection', (reason) => {
  console.error('[websense] Unhandled rejection (suppressed):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[websense] Uncaught exception (suppressed):', err.message);
});

