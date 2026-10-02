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
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheDiff, getDiff, summariseDelta } from './diff-cache.js';
import * as z from 'zod';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { COLLECTOR, putSnapshot, getSnapshot, sliceSnapshot, snapshotStats, branchChain, markSnapshotDirty, regionTree } from './snapshot.js';
import { DIFF_COLLECTOR } from './diff-collector.js';
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
// WEBSENSE_WATCHDOG=0 disables the self-handshake probe (see the watchdog block at the end
// of main()). It is ON by default: the failure it catches is silent, so nothing else finds it.
const WEBSENSE_WATCHDOG = process.env.WEBSENSE_WATCHDOG || '1';

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
// ★ THE RELAY ENVELOPE, IN ONE PLACE (2026-10-01). Hub replies are {type,id,success,data:{…}}.
// The top-level `success` means "a reply was delivered", NEVER "the action worked" — so every
// verdict must read the payload one level down.
//   classifyEffect learned this on 2026-09-25 (before/afterState live under data; reading the
//   top level made every relayed click look 'unverifiable' and trigger a needless real_click).
//   type_text was written later and did NOT unwrap, and the cost was a FALSE SUCCESS: measured on
//   bbc.com/news, the payload said {success:false, reason:'the target is disabled'} while the
//   envelope said success:true, and the tool answered effect:'confirmed' for a type that never
//   landed. The auto-DIFF for that same call said mutated:false — "treat this action as NOT
//   LANDED" — so two signals disagreed and the optimistic one was wrong.
// One helper, so the next handler cannot miss it.
// ★ AN ERROR CAN RIDE INSIDE A SUCCESSFUL ENVELOPE (2026-10-01). Hub replies are
// {type,id,success,data:{…}}, and a relay that does not recognise an op answers
// {data:{error:'Unknown action type: X'}} with success:true at the top — so a handler that only
// tests `success === false` reads that as a performed action. Measured: the first trusted_click
// reported effect:'unverifiable' and the page saw nothing at all. One reader, so a refusal cannot
// be mistaken for a result.
function relayFailure(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.success === false) return String(payload.error || payload.message || 'the relay reported failure');
  if (payload.error) return String(payload.error);
  return null;
}

function unwrapRelay(result) {
  return (result && typeof result === 'object' && result.data && typeof result.data === 'object')
    ? result.data : result;
}

// ★ ONE ACCESSOR FOR PAGE STATE, AND IT UNWRAPS (2026-10-01).
// Three separate places in this file read a URL straight off a hub reply and got `undefined`
// EVERY time, because hub replies are {type,id,success,data:{…}}:
//   · the type_text verdict (fixed earlier — it reported a refused type as 'confirmed'),
//   · the click navigation probe (fixed here — it never fired, so a click that navigated still
//     came back suspected_noop),
//   · auto-climb's "did the OS click change anything" test (fixed here — `changed` was computed
//     from an undefined URL, so it ALWAYS said false and always escalated).
// Same mistake, three times, in one file: so page state now has exactly one reader.
async function readPageState(tabId) {
  try {
    const res = await getActiveHub().send({ type: 'page_state', tabId });
    return unwrapRelay(res) || null;
  } catch (_) { return null; }
}

// ★ A NAVIGATION IS THE STRONGEST EVIDENCE AN INTERACTION LANDED, AND NO STATE PAIR CAN SEE IT.
// (2026-10-01.) before/afterState are captured around an op that returns before the browser has
// committed a navigation, so both snapshots are the PRE-navigation document and are identical by
// construction — measured: clicking HN's "newest" and books' "next" both navigated while the tool
// said suspected_noop, mutated:false, with escalation advice that sends the caller to retry an
// action that already worked.
// It POLLS, because the commit lands after the op returns (measured: the navigation showed up on
// the THIRD read, ~440ms in). It only ever upgrades a verdict, never downgrades one.
// Extracted so click and press_key share ONE implementation — two copies of one idea is what
// produced most of the bugs in this file today.
async function confirmNavigation(result, tabId, tries = 3, fromUrlHint = null) {
  const d = unwrapRelay(result);
  const fromUrl = fromUrlHint || (d && d.beforeState && d.beforeState.url);
  if (!fromUrl) return null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const post = await readPageState(tabId);
    const toUrl = post && post.url;
    if (toUrl && toUrl !== fromUrl) {
      result.effect = 'confirmed';
      result.navigation = { from: fromUrl, to: toUrl, via: 'tab URL read after the op', polls: attempt + 1 };
      delete result.escalation;
      return result.navigation;
    }
    await new Promise((r) => setTimeout(r, 220));
  }
  return null;
}

function classifyEffect(result) {
  if (!result || result.success === false) return 'failed';
  const box = unwrapRelay(result);
  const b = box.beforeState, a = box.afterState;
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
    + 'call explore_page again with no intent/goal for the full action list, or — for the whole page rather than just its actions — use browse + find.';
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
// WebSense registers 37 tools and lists 7 on the wire; raw SDK schemas for all of them would
// cost ~10k+ tokens per request, which is why tools/list is filtered to the listed surface.
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
const DELTA_OPS = new Set(['click', 'type_text', 'form', 'press_key', 'trusted_click', 'trusted_key',
  'real_click', 'real_paste', 'main_world', 'evaluate', 'dialog',
  // scroll is a PAGE INTERACTION too (Ali, 2026-10-01: "dif at each page interaction").
  // It is also the case that most needed the grouping: a scroll changes the
  // interactive+in-viewport subset, which the OLD diff reported as mutation. The DIFF
  // now puts that churn in its own `viewport` group and leaves mutated false.
  'scroll']);

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
// ★ THE AUTO-DIFF (2026-10-01, Ali: "directly dif at each page interaction automatically
// and dynamically group difs into page structure difs and content/scroll visual difs and
// automatically send you changes after each page interaction").
//
// Replaces the old delta, which diffed the interactive+in-viewport SCAN CACHE. That set
// changes as you scroll, so scroll churn was reported as page mutation (measured: a scroll
// gave changedRatio 1.038, "12 added / 40 removed"). This diffs the LOSSLESS inventory
// against a baseline the PAGE holds, and returns three groups with the distinction made
// explicit: structure (page shape — truth), content (the page answered you), viewport
// (scroll/layout churn — NOT a mutation). Unchanged elements are counted, not shipped.
async function runAutoDiff(tabId) {
  const r = await getActiveHub().send({ type: 'main_world_exec', tabId, func: DIFF_COLLECTOR, args: [] });
  // main_world_exec answers with a per-frame envelope ({success, results:[{frameId, result}]}).
  // Unwrap frame 0 — reading only r.result silently shipped the ENVELOPE as the diff
  // (found live: the block contained {"success":true,"results":[...]} instead of the groups).
  const payload = (r && r.results && r.results[0] && r.results[0].result !== undefined) ? r.results[0].result
    : (r && r.result !== undefined) ? r.result
    : (r && r.data && Array.isArray(r.data.results) && r.data.results[0] && r.data.results[0].result !== undefined) ? r.data.results[0].result
    : (r && r.data && r.data.result !== undefined) ? r.data.result
    : r;
  if (typeof payload === 'string') { try { return JSON.parse(payload); } catch (_) { return { mutated: null, reason: 'diff returned non-JSON' }; } }
  return payload && typeof payload === 'object' ? payload : { mutated: null, reason: 'diff returned nothing' };
}

// ★ A READ MUST NEVER FAIL ON STALENESS — IT REFRESHES (2026-10-01, Ali: "we should not
// have stale snapshots... if it does and a page event happens the dif should pick them up
// and update cache. No?").
// The server's copy is refreshed lazily, on READ, when anything has actually happened:
//   - no snapshot yet on this tab            -> collect
//   - an action ran since the collection     -> the page has moved on; collect
//   - the tab is on a different URL now      -> this is a different page; collect
// Idle time is NOT a reason. A page left alone keeps its map forever, and a page-initiated
// event (an expired session the app re-renders, a modal it opens on its own) is picked up
// here rather than being missed — because the collect reads the page as it is NOW.
async function ensureSnapshot(tabId, why) {
  const e = getSnapshot(tabId);
  if (e && !(e.actionsSinceCollect > 0)) return { entry: e, refreshed: false };
  const res = await getActiveHub().send({ type: 'main_world_exec', tabId, func: COLLECTOR, args: [] });
  const snap = (res && res.results && res.results[0] && res.results[0].result)
    || (res && res.result)
    || (res && res.data && Array.isArray(res.data.results) && res.data.results[0] && res.data.results[0].result)
    || (res && res.data && res.data.result);
  if (!snap || !Array.isArray(snap.elements)) {
    if (e) return { entry: e, refreshed: false, note: 'refresh failed; serving the previous copy' };
    return { entry: null, refreshed: false, error: 'could not collect the page inventory' };
  }
  const { seq } = putSnapshot(tabId, snap);
  return { entry: getSnapshot(tabId), refreshed: true, seq, why: why || 'stale (an action ran since the last collect)' };
}

function withDelta(name, handler) {
  if (!DELTA_OPS.has(name)) return handler;
  return async (args) => {
    const res = await handler(args);
    if (args && args.verify === false) return res;
    let delta;
    try {
      delta = await runAutoDiff(args && args.tabId);
    } catch (err) {
      delta = { mutated: null, reason: 'delta unavailable: ' + (err && err.message) };
    }
    // The action ran, so the server's copy of this page may no longer match it. Marked,
    // never discarded — the next READ refreshes it (see ensureSnapshot).
    try { markSnapshotDirty((args && args.tabId) || sessionTabOf()); } catch (_) {}
    const handle = cacheDiff((args && args.tabId) || sessionTabOf(), delta);
    const line = 'DIFF (auto, after ' + name + '): ' + JSON.stringify(summariseDelta(delta))
      + '\nFULL DIFF: ' + handle + ' — read any part with page_slice{diff:"' + handle + '", part:...}';
    // ★ A DIFF ACROSS A NAVIGATION IS MEANINGLESS, AND SAYING NOTHING CHANGED IS THE WRONG ANSWER
    // (2026-10-01). The baseline belongs to the document that was just replaced, so a click that
    // NAVIGATED came back mutated:false — "nothing changed" for a whole new page. Measured with an
    // outside oracle on HN's "newest" and books.toscrape's "next". The result payload now carries
    // the navigation the handler proved; say it here too, because this block is what a caller
    // reads first.
    let navNote = '';
    let payload = null;
    try {
      const firstText = res && Array.isArray(res.content) && res.content[0] && res.content[0].text;
      payload = firstText ? JSON.parse(firstText) : null;
      const nav = payload && payload.navigation;
      if (nav) navNote = '\nTHE PAGE NAVIGATED (' + nav.from + ' -> ' + nav.to + ') — this baseline belongs to the document that was replaced, so structure/content/visual above are NOT meaningful. The navigation itself is the confirmation.'
        + (delta && delta.mutated === false ? ' In particular, mutated:false here does NOT mean nothing happened.' : '');
    } catch (_) { /* an unparseable payload just gets the plain line */ }
    // ★★★ THE VERDICT MUST BE ABLE TO SEE THE DIFF (2026-10-02, Ali: "instead of relying on
    // documented fails can we please fix them?"). Measured on x.com: every trusted TYPE of a
    // thread post came back effect:'unverifiable' while THIS SAME reply said mutated:true — a
    // verdict that contradicted its own evidence, in the worst direction: 'unverifiable' is
    // documented as "not measured", so a caller reads it as "no proof" and re-runs the action.
    //
    // WHY IT HAPPENED: the per-op verdicts are decided from page_state ALONE (url/title/
    // readyState/scroll — see withEffect/classifyEffect), and a trusted type changes none of
    // those. It changes the DOM. The page-side differ had ALREADY measured that change; the
    // verdict simply never read it. The two halves of one reply disagreed.
    //
    // THE FIX: when the page-side diff says the DOM genuinely moved, an 'unverifiable' verdict
    // is superseded — the measurement DID happen, just not in the field classifyEffect reads.
    // ★ ONLY EVER UPGRADES, NEVER DOWNGRADES: a mutated:true diff with a 'failed' verdict stays
    // 'failed' (a refusal is a refusal), and 'confirmed' is already the strongest answer. This
    // can only turn "I could not measure it" into "here is the measurement".
    let verdictNote = '';
    try {
      if (payload && typeof payload === 'object'
        && (payload.effect === 'unverifiable' || payload.effect === 'suspected_noop')
        && delta && delta.mutated === true) {
        payload.effect = 'confirmed';
        payload.effectSource = 'page_diff';
        // Keep the escalation advice consistent — leaving "re-read before retrying" attached to a
        // now-confirmed verdict is how a caller talks itself into clicking a second time.
        if (payload.escalation) delete payload.escalation;
        if (res && Array.isArray(res.content) && res.content[0]) {
          res.content[0].text = JSON.stringify(payload);
        }
        verdictNote = '\nVERDICT: upgraded unverifiable -> confirmed FROM THE DIFF. page_state (url/title/readyState/scroll) did not change because this action only changed the DOM, but the page-side differ measured a real structure/content move (mutated:true) — see the counts above. The earlier unverifiable was the state-pair being blind to DOM edits, not a failure.';
      }
    } catch (_) { /* never let the verdict fix break a result */ }
    try {
      if (res && Array.isArray(res.content)) res.content.push({ type: 'text', text: line + navNote + verdictNote });
      else return { content: [{ type: 'text', text: line + navNote + verdictNote }] };
    } catch (_) { /* never let the flag break a result */ }
    return res;
  };
}

// EVERY WRAPPED HANDLER, KEPT BY NAME (2026-10-01). The surface is being reduced to a few tools and
// a facade must DISPATCH to the real handler, never re-implement it — one idea written twice is this
// codebase's most expensive recurring bug.
const TOOL_WRAPPED = new Map();
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
  const wrapped = safeHandler(withDelta(name, handler));
  TOOL_WRAPPED.set(name, wrapped);
  server['registerTool'](name, { ...def, inputSchema: merged }, wrapped);
}

// Wrap the SDK's tools/list handler: post-process the WIRE OUTPUT so every
// client sees a slim schema. Registration + arg validation stay untouched.
// ★ WHAT A MODEL MAY SEE (2026-10-01, Ali: "combine the tools as it makes sense ... the 14 debug
// tools seem excessive cut it down and combine them into 2-3"). Everything stays registered and
// CALLABLE — the repo's tests and harnesses use the old names — but this is the listed surface.
// The WIRE surface is what a model is allowed to SEE in tools/list (8 of 38 registered).
// preflight joins it deliberately (2026-10-02): it is the FIRST call to make when anything
// is refused, so hiding it behind the debug tool would defeat its purpose — but it is also
// the tool most likely to be called reflexively, which is why its description leads with
// "call this when refused", not "call this always".
const WIRE_SURFACE = new Set(['browse', 'find', 'act', 'page_slice', 'tabs', 'debug', 'websense_guide', 'preflight']);

function installSchemaMinifier(server) {
  const low = server.server;
  if (!low || typeof low.setRequestHandler !== 'function') return;
  const orig = low._requestHandlers && low._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  if (typeof orig !== 'function') return;
  low.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await orig(request, extra);
    if (result && Array.isArray(result.tools)) {
      // filter FIRST: an unlisted tool costs nothing on the wire and nothing to choose between
      result.tools = result.tools.filter((t) => WIRE_SURFACE.has(t.name));
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

// DISPATCH A TOOL BY NAME: the facades call the REAL handler — same args, same auto-diff, same
// verdicts — so a combined tool cannot drift from the one it replaced.
// ★ ONE FRAME-AWARE RESOLVER (2026-10-01, Ali: "for the click and for the drag use the click you
// used on x.com for the + Add button"). It finds the element ANYWHERE, including inside same-origin
// iframes (document.querySelector does NOT descend into frames — that is why the frame click kept
// failing), brings it into view when it is not already clickable (a rect below the fold receives no
// browser input at all), and converts the rect into TOP-viewport coordinates by walking up through
// frameElement.
//
// ★ AND A CORRECT BOX CAN STILL BE UNCLICKABLE (2026-10-01). Measured on bench/click_fingerprint.html:
// the frame's button is at top-viewport y=1727 in a 1271px-tall window, so the resolved rect was
// RIGHT and the click could not land — elementFromPoint at it answers null. After the reveal the
// same button is at (92, 881), elementFromPoint answers IFRAME#fp-frame, and the page's own counter
// goes 0 -> 1. A viewport coordinate is only usable if it is INSIDE the viewport.
//
// ★ THE REVEAL IS CONDITIONAL, AND THAT IS THE POINT. An unconditional scrollIntoView{block:'center'}
// also lands the frame click, but it MOVES THE USER'S TAB on every trusted click — measured on the
// same fixture: clicking its already-visible #btn scrolled the page 0 -> 547. A background tool that
// repositions the tab it is not supposed to disturb is the same class of side effect as stealing
// focus, so the scroll happens only when the CENTRE is outside the viewport.
const PAGE_CENTRE_FUNC = 'function(){' +
  'var SEL=' + 'SELV' + ';' +
  'function find(s,d){var e=d.querySelector(s);' +
  // ★ AN AMBIGUOUS SELECTOR MUST NOT RESOLVE SILENTLY TO "the first one" (2026-10-02, Ali:
  // "instead of relying on documented fails can we please fix them?"). Measured on x.com:
  // [data-testid="tweetTextarea_0"] matches TWICE at once — the /compose/post dialog's real
  // composer AND the empty page-level inline composer. querySelector returns the first with no
  // word, so a type can land in the wrong editor and the reply looks successful either way.
  // That is the two-composer trap, and it is a WIRING failure, not an x.com quirk.
  //
  // THE FIX: when a selector matches more than one element, do NOT guess — report the
  // multiplicity (count + tag) so the caller can scope explicitly, e.g.
  // [role="dialog"] [data-testid="tweetTextarea_0"]. A refusal that NAMES the two candidates
  // beats a click that silently went to the wrong one.
  'if(e){try{var all=d.querySelectorAll(s);if(all.length>1){return {ambiguous:true,count:all.length,tag:String(e.tagName).toLowerCase()};}}catch(_a){}return e;}' +
  // Same-origin frame walk — UNCHANGED, documented capability (only a cross-origin frame is out
  // of reach). Kept AFTER the ambiguity check so a clean multi-frame page still resolves.
  'var fs=d.querySelectorAll("iframe");' +
  'for(var i=0;i<fs.length;i++){try{if(fs[i].contentDocument){var r=find(s,fs[i].contentDocument);if(r)return r;}}catch(x){}}return null;}' +
  'var el=find(SEL,document);if(!el)return null;' +
  'if(el.ambiguous)return el;' +
  // rectOf(e): any element's rect in TOP-viewport space (walks frameElement up). Was topRect(),
  // which was hardcoded to `el`.
  'function rectOf(e){var r=e.getBoundingClientRect();var x=r.left,y=r.top,inF=false;' +
  'var w=e.ownerDocument.defaultView;' +
  'while(w&&w!==window){try{var fe=w.frameElement,f2=fe.getBoundingClientRect();x+=f2.left;y+=f2.top;inF=true;w=w.parent;}catch(ex){break;}}' +
  'return {x:x,y:y,w:r.width,h:r.height,inFrame:inF};}' +
  // pick(): the element's own box when it is clickable-sized. When the own box is DEGENERATE
  // (measured 2026-10-02: duckduckgo.com's submit button lays out 0-width while its icon child
  // renders fine), fall back to the LARGEST descendant box — a real mouse clicks that icon and
  // the event bubbles to the button, so it is the honest target. If NOTHING in the subtree
  // renders (Wikipedia's hidden header checkbox is display:none — no child has a box either),
  // return the degenerate rect so the zero-box guard REFUSES: no coordinate reaches a node the
  // render tree omits, and silently clicking empty space is worse than an honest failure.
  'function pick(){var a=rectOf(el);if(a.w>0&&a.h>0)return a;var best=null;' +
  'var ds=el.querySelectorAll("*");for(var i=0;i<ds.length;i++){var b=rectOf(ds[i]);' +
  'if(b.w<=0||b.h<=0)continue;if(!best||(b.w*b.h)>(best.w*best.h))best=b;}' +
  'return best||a;}' +
  // ★ THE LABEL IS WHERE A HUMAN CLICKS A HIDDEN INPUT (2026-10-02, Ali: "trusted everywhere as
  // the single click action ... it would be like saying a user click will not work ... if it
  // fails it's the wiring"). The visually-hidden pattern gives the control itself NO pixels (0x0,
  // off-screen clip, display:none) — but the page pairs it with a label[for] (or a wrapping
  // label) that DOES render, and that label is the surface a real mouse presses; the browser
  // forwards the trusted click to the input. When the element's own box yields no reachable
  // point, resolve THAT instead of refusing: same page, same user path, still one coordinate.
  'function proxyOf(e){var px=null;' +
  'try{if(e.id){var esc=(window.CSS&&CSS.escape)?CSS.escape(e.id):e.id;' +
  'px=e.ownerDocument.querySelector("label[for=\\""+esc+"\\"]");}}catch(_e){}' +
  'if(!px){try{px=e.closest?e.closest("label"):null;}catch(_e2){}}' +
  'return (px&&px!==e)?px:null;}' +
  'var a=pick();' +
  'var cx=a.x+a.w/2,cy=a.y+a.h/2;' +
  'var off=(cx<0||cy<0||cx>window.innerWidth||cy>window.innerHeight);' +
  // ★ AND THEN SCROLL THE TOP PAGE (2026-10-01). scrollIntoView on a FRAME's child scrolls the
  // frame's own document; the IFRAME element stays where it is in the parent, so the button stayed
  // at top-y 1727 and the trusted click landed on nothing. scrollBy on the TOP window moves the page
  // for real. Measured: the frame click's y went 1727 (nothing) -> 881 (the page echoed its click).
  'if(SCROLLV&&off){el.scrollIntoView({block:"center"});var q=pick();var dy=q.y+q.h/2-window.innerHeight/2;if(Math.abs(dy)>8)window.scrollBy(0,dy);}' +
  // ★ RETURN THE REAL RECT, NOT THE CENTRE (2026-10-02). This used to return the element's
  // CENTRE with w/h hard-coded to 2x2 by the caller — so (a) the trusted_click zero-box guard
  // could NEVER fire (pageCentre always claimed a valid 2x2), and a hidden/zero-sized target
  // was clicked as EMPTY SPACE: measured on en.wikipedia.org the hidden header checkbox was
  // clicked at (1,1) and on duckduckgo.com the 0-width submit button's centre+1 landed on the
  // wrapper DIV, not the button. (b) The centre-as-topleft convention disagreed with the
  // geometry/inventory paths (which return topleft boxes), so the handler's +w/2 added a
  // systematic 1px offset to every page-resolved click. Return topleft+w+h like every other
  // resolver; the handler computes the centre, the guard sees the true size.
  // `t` MUST BE DEFINED BEFORE THE REACH TEST USES IT (2026-10-02). The reach-test patch
  // replaced the old `var t=…; return …;` block and dropped the definition with it — the
  // function then threw ReferenceError at runtime, pageCentre answered null, and the handler
  // silently fell through to the geometry path (observed: the refusal carried the GEOMETRY
  // reply instead of the unreachable verdict). The suite could not catch it: it pins source
  // patterns, not execution. Execute the built function before trusting it.
  'var t=(SCROLLV&&off)?pick():a;' +
  // ★ REACH TEST — the browser's own hit test BEFORE any dispatch (2026-10-02, battery).
  // The box can be real and still be UNCLICKABLE: duckduckgo.com's semantic submit lays out
  // 16x16 behind a sibling overlay, so Input.dispatchMouseEvent at its centre reached the
  // overlay, not the button (click landed, nothing submitted). A human cannot click it either
  // — that is a fact about the page, not about the input rung, so REPORT it. Probe points
  // across the resolved box with elementFromPoint (the exact routing the browser would use),
  // climbing parentNode/host so shadow-DOM children count as reaching their host. First
  // point whose hit resolves to el -> return it as the click coordinate (a point PROVEN to
  // reach the target, which is not necessarily the geometric centre). All probes miss ->
  // unreachable:true + the identity of what sits on top, so the handler can refuse honestly
  // and name the remedy instead of clicking the overlay and reporting a quiet no-op.
  // PROBE IS A FUNCTION BECAUSE IT NOW RUNS TWICE (2026-10-02): once on the element's own box,
  // and — when no point reaches it — again on its label proxy. Same hit test, same verdict shape,
  // one body. `tgt` is the element being probed (label after a proxy switch) and `boxT` the box
  // whose points are sampled (the re-resolved rect after any reveal scroll).
  'function probe(tgt,boxT){' +
  'function reaches(h){var p=h;for(var g=0;g<25&&p;g++){if(p===tgt)return true;p=p.parentNode||p.host;}return false;}' +
  'var own=tgt.getBoundingClientRect(),te=rectOf(tgt);' +
  'var fox=te.x-own.left,foy=te.y-own.top;' +
  'var fr=[[0.5,0.5],[0.25,0.25],[0.75,0.25],[0.25,0.75],[0.75,0.75],[0.5,0.15],[0.5,0.85],[0.15,0.5],[0.85,0.5]];' +
  'var first=null,hp=null;' +
  'for(var i2=0;i2<fr.length;i2++){' +
  'var tx=boxT.x+boxT.w*fr[i2][0],ty=boxT.y+boxT.h*fr[i2][1];' +
  'var h=null;try{h=tgt.ownerDocument.elementFromPoint(tx-fox,ty-foy);}catch(_e){}' +
  'if(!h)continue;if(!first)first=h;' +
  'if(reaches(h)){hp={x:Math.round(tx),y:Math.round(ty)};break;}' +
  '}' +
  // blockedBy must ONLY be set when unreachable — on success first is simply the element the
  // first probe hit (often a child that reaches), and reporting it as an "occluder" is noise
  // that made successful replies self-contradictory (measured: unreachable:false alongside
  // blockedBy:"path" on a click that worked).
  'var bb="";if(!hp&&first){bb=first.tagName||"";if(first.id)bb+="#"+first.id;' +
  'var c=(typeof first.className==="string")?first.className:"";if(c)bb+="."+c.split(" ")[0];}' +
  'return {hp:hp,bb:bb};}' +
  'var R=probe(el,t);' +
  // ★ THE PROXY RETRY — only when the element itself could not be reached. A reachable element
  // is clicked directly (the input, not its label). No proxy in the DOM, or the proxy also has
  // no pixels: the refusal stands, and it is honest — the page renders nothing to press.
  'var viaLabel=false;' +
  'if(!R.hp){var px=proxyOf(el);' +
  'if(px){var pr=rectOf(px);' +
  'if(pr.w>0&&pr.h>0){el=px;viaLabel=true;' +
  'a=pick();cx=a.x+a.w/2;cy=a.y+a.h/2;' +
  'off=(cx<0||cy<0||cx>window.innerWidth||cy>window.innerHeight);' +
  'if(SCROLLV&&off){el.scrollIntoView({block:"center"});var q2=pick();var dy2=q2.y+q2.h/2-window.innerHeight/2;if(Math.abs(dy2)>8)window.scrollBy(0,dy2);}' +
  't=(SCROLLV&&off)?pick():a;' +
  'R=probe(el,t);}}}' +
  'var _bb=R.bb,_hp=R.hp;' +
  'return {x:Math.round(t.x),y:Math.round(t.y),w:Math.round(t.w),h:Math.round(t.h),inFrame:t.inFrame,offViewport:off,scrolled:!!(SCROLLV&&off),viaLabel:viaLabel,click:_hp,unreachable:_hp?false:true,blockedBy:_bb};}';

// ★ THE REPLY IS JSON, SO IT IS READ AS JSON (2026-10-01). pageCentre used to pull the two numbers
// straight out of the reply TEXT with /x[^-\d]{0,10}(-?\d+)/ — a parse that only works because of
// which character class the punctuation happens to fall into, and that FAILED OUTRIGHT on the
// neighbouring flag: it reported inFrame:false for a button that IS inside a frame, because its
// pattern for that was /inFrame[^:]{0,4}true/ and the text reads "inFrame":true — the class excluded
// the very colon it had to cross. A coordinate read out of a regex is a coordinate nobody can trust,
// so the payload is parsed and the numbers are TYPE-CHECKED.
function mainWorldValue(raw) {
  const text = ((raw && raw.content && raw.content[0] && raw.content[0].text) || '');
  let j = null;
  try { j = JSON.parse(text); } catch (_) { return null; }
  // main_world_exec answers with a PER-FRAME ENVELOPE: {success, results:[{frameId, result, error}]}
  const r = (j && Array.isArray(j.results) && j.results[0]) || null;
  return r ? r.result : (j && j.result !== undefined ? j.result : null);
}
async function pageCentre(sel, tabId, doScroll) {
  const raw = await callTool('main_world', { tabId: tabId, verify: false,
    func: PAGE_CENTRE_FUNC.replace(/SELV/g, JSON.stringify(String(sel))).replace(/SCROLLV/g, doScroll ? 'true' : 'false') });
  const p = mainWorldValue(raw);
  // ★ AN AMBIGUOUS SELECTOR IS A REFUSAL, NOT A MISS (2026-10-02). pageCentre must pass it up:
  // returning null here would drop it into the "no box" branch, which blames the ELEMENT and
  // sends the caller off to re-explore a page that is fine. The page told us exactly what is
  // wrong — two elements match — so that is the error the caller must read.
  if (p && p.ambiguous) {
    const e = new Error('ambiguous selector "' + String(sel) + '" matches ' + p.count
      + ' elements (<' + (p.tag || '?') + '>) — refusing to pick one silently. Scope it, e.g. '
      + '[role="dialog"] ' + String(sel) + ', or use a selector that is unique on this page.');
    e.detail = {
      reason: 'ambiguous-selector',
      selector: String(sel),
      matches: p.count,
      tag: p.tag || null,
      hint: 'A selector matching more than one element is refused rather than resolved to the first match. Scope the selector to a container ([role="dialog"], a form, a specific parent) so exactly one element matches.',
    };
    throw e;
  }
  // w/h are REQUIRED (2026-10-02): without them the reply cannot be told apart from a
  // zero-box one, and the guard downstream would have nothing to test. A missing/NaN size
  // falls back to the geometry op rather than fabricating a 2x2.
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' ||
      typeof p.w !== 'number' || typeof p.h !== 'number') return null;
  // ★ CLICK/UNREACHABLE MUST SURVIVE THE RETURN (2026-10-02). This whitelist dropped every
  // field it did not know, so the reach test's verdict (click proven-point / unreachable /
  // blockedBy) would have been erased right before dispatch — the guard downstream would never
  // fire and the blind click it exists to prevent would go out anyway. Pass them through.
  return { x: p.x, y: p.y, w: p.w, h: p.h, fromPage: true, inFrame: !!p.inFrame,
           offViewport: !!p.offViewport, scrolled: !!p.scrolled, viaLabel: !!p.viaLabel,
           click: (p.click && typeof p.click.x === 'number' && typeof p.click.y === 'number') ? { x: p.click.x, y: p.click.y } : null,
           unreachable: !!p.unreachable, blockedBy: (typeof p.blockedBy === 'string') ? p.blockedBy : '' };
}

async function callTool(name, args) {
  const fn = TOOL_WRAPPED.get(name);
  if (!fn) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'no such tool: ' + name }) }] };
  return await fn(args);
}

function registerFacades(server) {
  reg(server, 'act', {
    description: 'DO something: click, hover, rightclick, drag, type, key, form, upload, scroll, dialog. how:"trusted" = the browser own input, so the event is really isTrusted and default actions run; how:"os" = OS-level. For reading use find.',
    inputSchema: {
      action: z.enum(['click', 'hover', 'rightclick', 'drag', 'type', 'key', 'form', 'upload', 'scroll', 'dialog']).describe('what to do'),
      how: z.enum(['auto', 'trusted', 'os']).optional().describe('auto = normal path, trusted = browser input pipeline, os = OS-level input'),
      ref: z.string().optional(), selector: z.string().optional(),
      text: z.string().optional(), key: z.string().optional(), value: z.string().optional(),
      filePath: z.string().optional(), fromRef: z.string().optional(), toRef: z.string().optional(),
      x: z.number().optional(), y: z.number().optional(),
      direction: z.string().optional(), amount: z.number().optional(),
      modifiers: z.array(z.string()).optional(), tabId: z.number().optional(),
    },
  }, async (o) => {
    const a = o.action;
    const trusted = o.how === 'trusted';
    const os = o.how === 'os';
    const pass = (extra) => Object.assign({}, o, extra);
    // JSON decode/encode for the ladder below: a tool answers as textResult JSON, and the routing
    // decision (did the trusted path ACCEPT the click or REFUSE it?) must read success/error
    // structurally — never by string-guessing over the reply text.
    const _json = (r) => { try { const t = r && r.content && r.content[0] && r.content[0].text; return t ? JSON.parse(t) : null; } catch (_) { return null; } };
    const _wrap = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
    if (a === 'click') {
      if (os) return await callTool('real_click', pass({}));
      // ★ TRUSTED COORDINATE CLICKS (2026-10-02): the trusted path used to receive
      // ONLY the selector, so act{action:"click", how:"trusted", x, y} could never
      // reach the SW's trusted_click op (which needs x/y) — raw coordinates were
      // forced onto the UNTRUSTED dispatchEvent click. Canvas/WebGL is exactly where
      // a page inspects isTrusted, so pass x/y through. (A ref/selector stays the
      // normal route; the SW op resolves the box itself.)
      if (trusted) {
        const sel = o.ref || o.selector;
        return await callTool('trusted_click', pass(sel ? { selector: sel } : { x: o.x, y: o.y }));
      }
      // ★ TRUSTED IS THE SINGLE CLICK ACTION (2026-10-02, Ali: "The idea is to have trusted
      // everywhere as the single click action, there is no possible reason that this should not
      // work, it would be like saying a user click will not work ... If it fails it's the wiring
      // and or other components. Make it happen."). TRUSTED-FIRST: how:"auto" runs the real input
      // pipeline FIRST — resolve the box, hit-test it, Input.dispatchMouseEvent — because a user's
      // click IS the default input, not an escalation. The synthetic dispatchEvent click survives
      // as the FALLBACK for the two refusals trusted_click now reports honestly (no coordinate
      // exists for the element and no label proxy rendered either, or every point on it is
      // occluded) plus transport failure (debugger unavailable). A refusal returns BEFORE any
      // dispatch, so the fallback cannot double-click. The reply is TAGGED — path:'auto→trusted'
      // or path:'auto→synthetic' with trustedRefusal — so which rung fired is never silent.
      const selA = o.ref || o.selector;
      const tr0 = await callTool('trusted_click', pass(selA ? { selector: selA } : { x: o.x, y: o.y }));
      const p0 = _json(tr0);
      if (p0 && p0.success === true) { p0.path = 'auto→trusted'; return _wrap(p0); }
      // THE FALLBACK MUST MAP selector -> ref (2026-10-02, first live run): the click tool's
      // schema has NO `selector` field, so pass({selector}) was STRIPPED, ref arrived undefined,
      // and the fallback answered "Element not found" for an element that exists. resolveRef
      // accepts a CSS selector THROUGH `ref` (since the form-fix), so hand it selA as ref —
      // preserving the canvas x,y path (click checks x,y first).
      const r0 = await callTool('click', pass({ ref: selA }));
      const q0 = _json(r0);
      if (q0 && typeof q0 === 'object') {
        q0.path = 'auto→synthetic';
        q0.trustedRefusal = (p0 && (p0.error || '')) || 'trusted_click unavailable';
        return _wrap(q0);
      }
      return r0;
    }
    if (a === 'drag' && trusted) {
      const tb = o.tabId || sessionTabOf();
      // ★ BOTH ENDS OF THE DRAG MUST BE ON SCREEN, ON THE SAME LAYOUT (2026-10-01).
      // A drag needs the SOURCE and the TARGET inside the viewport at the SAME time: browser input
      // is delivered at viewport coordinates, and a rect below the fold receives nothing (measured:
      // the fixture's pair at y~2086 produced ZERO events). The old version scrolled the SOURCE in
      // and then read the TARGET from that layout — fine while the two are neighbours, but the
      // target can land off-screen for a long drag, and then the release lands on nothing and the
      // drag silently cannot complete. So: scroll the source in, measure BOTH, and if either centre
      // is outside the viewport scroll the TARGET in and measure BOTH again. One round trip.
      const DRAG_BOXES_FUNC = 'function(){' +
        'var FS=' + 'FRV' + ',TS=' + 'TRV' + ';' +
        'function q(s){try{return document.querySelector(s);}catch(e){return null;}}' +
        'var a=q(FS),b=q(TS);' +
        'if(!a)return {ok:false,why:"source not found: "+FS};' +
        'if(!b)return {ok:false,why:"target not found: "+TS};' +
        'function box(e){var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}' +
        'function inside(p){return p.x>=0&&p.y>=0&&p.x<window.innerWidth&&p.y<window.innerHeight;}' +
        'a.scrollIntoView({block:"center"});var A=box(a),B=box(b);' +
        'if(!inside(A)||!inside(B)){b.scrollIntoView({block:"center"});A=box(a);B=box(b);}' +
        'return {ok:true,from:{x:A.x,y:A.y},to:{x:B.x,y:B.y},bothInside:inside(A)&&inside(B),' +
        'viewport:{w:window.innerWidth,h:window.innerHeight}};' +
        '}';
      let boxes = null;
      try {
        const raw = await callTool('main_world', { tabId: tb, verify: false,
          func: DRAG_BOXES_FUNC.replace(/FRV/g, JSON.stringify(String(o.fromRef || ''))).replace(/TRV/g, JSON.stringify(String(o.toRef || ''))) });
        boxes = mainWorldValue(raw);
      } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'act drag(trusted): could not measure the drag boxes: ' + String((e && e.message) || e) }) }] }; }
      if (!boxes || !boxes.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'act drag(trusted): could not resolve both boxes',
          detail: (boxes && boxes.why) || 'the page returned no boxes',
          escalation: { recommended: 're_read', reason: 'a drag needs BOTH ends resolvable by document.querySelector. If an end is inside a same-origin IFRAME use trusted_click-style frame addressing; a cross-origin frame cannot be aimed into at all. Re-read with explore_page/find and pass locators that exist.' } }) }] };
      }
      const dr = await getActiveHub().send({ type: 'trusted_drag', tabId: tb, from: boxes.from, to: boxes.to });
      const rr = unwrapRelay(dr);
      // ★ THE VERDICT IS THE PAGE'S, AND IT IS CARRIED THROUGH (2026-10-01). The extension reads a
      // capture-phase drop listener back after the gesture, so `dropped` here is what the PAGE
      // recorded — not whether a CDP call returned. Renderers refuse the completion on a target that
      // does not cancel `dragover`, and the reply now says which of those two things happened.
      if (rr && typeof rr === 'object') {
        rr.drag = { from: boxes.from, to: boxes.to, bothEndsInsideViewport: !!boxes.bothInside,
                    viewport: boxes.viewport };
      }
      if (boxes.bothInside === false && rr && typeof rr === 'object' && !rr.error) {
        rr.warning = 'one end of the drag is OUTSIDE the viewport (' + JSON.stringify(boxes) + ') — browser input is delivered at viewport coordinates, so a release at an off-screen point lands on nothing and no drop can follow. Scroll the page (or resize the window) and retry.';
      }
      return { content: [{ type: 'text', text: JSON.stringify(rr !== undefined && rr !== null ? rr : dr) }] };
    }
    if (a === 'hover' || a === 'rightclick' || a === 'drag') {
      // drag+trusted is handled above (trusted_drag); how:"os" keeps the old synthetic route
      // (the OS rung has no hover, and rightclick's OS path was never wired — unchanged here).
      if (a === 'drag' || os) return await callTool('click', pass({ mode: a }));
      // ★ HOVER AND RIGHT-CLICK ARE THE SAME CLICK ACTION (2026-10-02, Ali: "trusted everywhere as
      // the single click action ... make it happen"). This branch used to drop `how` on the floor:
      // BOTH went to the synthetic dispatch even for how:"trusted", so the trusted rung was
      // unreachable for them. Trusted-first now, same rule as the click branch — right-click is
      // the SAME trusted pipeline with button:'right' (the extension already honors
      // payload.button: mask 2), and hover is the same pipeline WITHOUT the press (the move that
      // precedes every trusted click is exactly what applies :hover; mode:'hover' returns right
      // after it). Synthetic only behind a TAGGED refusal.
      const selH = o.ref || o.selector;
      const extra = {};
      if (a === 'rightclick') extra.button = 'right';
      if (a === 'hover') extra.mode = 'hover';
      const trh = await callTool('trusted_click', pass(Object.assign(selH ? { selector: selH } : { x: o.x, y: o.y }, extra)));
      const ph = _json(trh);
      if (ph && ph.success === true) { ph.path = 'auto→trusted'; return _wrap(ph); }
      // An explicit how:"trusted" keeps its refusal — synthetic is not trusted, and silently
      // substituting it would hide exactly what the caller asked for.
      if (trusted) return trh;
      // selector -> ref for the same reason as the click fallback: the click tool's schema
      // strips `selector`, and resolveRef takes CSS through `ref`.
      const rh = await callTool('click', pass({ mode: a, ref: selH }));
      const qh = _json(rh);
      if (qh && typeof qh === 'object') {
        qh.path = 'auto→synthetic';
        qh.trustedRefusal = (ph && (ph.error || '')) || 'trusted_click unavailable';
        return _wrap(qh);
      }
      return rh;
    }
    if (a === 'type') {
      if (os) return await callTool('real_paste', pass({}));
      if (trusted) return await callTool('trusted_key', pass({}));
      // ★ SELF-ESCALATING TYPE (2026-10-02). `how:"auto"` routes to type_text,
      // which sets the value through the native setter + input/change events.
      // That is untrusted: on a Draft.js/Lexical/ProseMirror editor the value
      // reconciles away and the reply comes back "Element not found" / effect
      // "failed" — exactly what the x.com composer returned — while the SAME
      // text typed through the browser's own pipeline (trusted_key →
      // Input.dispatchKeyEvent) lands. The model should not have to know which
      // controls are reconcilers: try the cheap synthetic path, and when the
      // page refuses it, retry through the trusted pipeline in the same call.
      const r = await callTool('type_text', pass({}));
      const d = unwrapRelay(r);
      const refused = r && (r.effect === 'failed' || r.effect === 'unverifiable')
        && (!d || d.success !== true);
      if (!refused) return r;
      const tr = await callTool('trusted_key', pass({ text: o.text }));
      if (tr && typeof tr === 'object' && Array.isArray(tr.content)) {
        const txt = (tr.content[0] && tr.content[0].text) || '';
        try { const parsed = JSON.parse(txt); if (parsed && parsed.success) parsed.escalatedFrom = 'type_text(auto)'; return { content: [{ type: 'text', text: JSON.stringify(parsed) }] }; } catch (_) {}
      }
      return tr;
    }
    if (a === 'key') {
      return await callTool(trusted ? 'trusted_key' : 'press_key', pass({}));
    }
    if (a === 'upload') return await callTool('form', pass({ action: 'upload' }));
    if (a === 'form') return await callTool('form', pass({}));
    if (a === 'scroll') return await callTool('scroll', pass({}));
    if (a === 'dialog') return await callTool('dialog', pass({}));
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'act: unknown action ' + a }) }] };
  });

  reg(server, 'debug', {
    description: 'WebSense itself, and raw reads: op=status, session, logs, cookies, clipboard, screenshot, ax, evaluate, main_world, explore_page, reload, respawn, guide. Use when something is wrong or a page tool will not answer.',
    inputSchema: {
      op: z.enum(['status', 'session', 'logs', 'cookies', 'clipboard', 'screenshot', 'ax', 'evaluate', 'main_world', 'explore_page', 'reload', 'respawn', 'guide']).describe('what to inspect or maintain'),
      kind: z.string().optional().describe('for logs: network | console'),
      func: z.string().optional(), query: z.string().optional(),
      action: z.string().optional(), url: z.string().optional(),
      tabId: z.number().optional(),
    },
  }, async (o) => {
    const map = { status: 'status', session: 'session', cookies: 'cookies', clipboard: 'clipboard',
      screenshot: 'screenshot', ax: 'ax', evaluate: 'evaluate', main_world: 'main_world',
      explore_page: 'explore_page', reload: 'extension_reload', respawn: 'respawn_offscreen', guide: 'websense_guide' };
    if (o.op === 'logs') return await callTool(o.kind === 'console' ? 'console_log' : 'network_log', o);
    const name = map[o.op];
    return await callTool(name, o);
  });
}

function registerAllTools(server) {
  registerFacades(server);

  // ═══ 1. GUIDE ═══
  reg(server, 'websense_guide', {
    description: 'START HERE. The listed tools: browse, find, act, page_slice, tabs, debug, guide. Call once before you act.',
  }, async () => {
    return textResult(`WebSense MCP — Guide (8 listed / 38 registered)
==============================================
Non-vision web automation via Chrome extension. No CDP debug port, no bot detection. CSP-safe. React/Vue/Angular compatible.

START HERE: browse{url} — ONE call that navigates, seeds the page's diff baseline, stores a lossless inventory and returns only the small INDEX + the vocabulary this page actually uses. Then find{query} to locate a control (it tells you WHERE it is — region, position, and the branch it sits in — and WHAT it is, from the page's own role/name/attributes), page_slice to load just that branch at full fidelity, then act.

DID IT LAND? Every mutating op (click, type_text, form, press_key, real_click, real_paste, main_world, evaluate, dialog) returns a SECOND block: DIFF (auto, after <op>) — the change since your browse baseline, grouped so you cannot confuse churn with truth:
  structure — the page's SHAPE changed (elements added/removed, tag/role/name/attrs changed). Page truth.
  content   — the SAME element's value/text changed and its shape did not. The page answered you.
  viewport  — ONLY vp/x/y differ. This is scroll/layout churn and is NOT a mutation. It used to be reported as one (a scroll measured changedRatio 1.038, "12 added / 40 removed") because the old diff compared the interactive+in-viewport subset, which changes as you scroll.
mutated is true when structure or content moved. The baseline for any page is the first collection after that page loaded, and it is held BY THE PAGE, so navigating gives you a fresh one automatically. Pass verify:false to skip the diff on a call you don't need checked.
A NAVIGATION IS THE STRONGEST CONFIRMATION AND IT IS NOT IN THE GROUPS: when click or press_key (Enter/Space) replaces the document, the result carries effect:"confirmed" plus a navigation {from,to} — and the DIFF line says so explicitly, because a diff taken across a navigation compares two different documents and its groups are meaningless. Measured: clicking HN's "newest" and books.toscrape's "next" both navigated while the old code answered suspected_noop + mutated:false, i.e. it told you a click that worked had done nothing. Also: an untrusted synthetic Enter runs NO default action, so press_key Enter on a form field now calls form.requestSubmit() for you and reports defaultAction when it does.

FULL PAGE MAP vs A SLICE: browse / page_snapshot collect a LOSSLESS inventory of the page (nothing filtered out — not interactive-only, not in-viewport-only) and return only a small INDEX (counts + the dimensions you can slice by). find and page_slice then fetch only what you ask for, at full fidelity. The inventory is scroll-stable: it does not churn the way a viewport-filtered scan does, because it is not a subset that changes as you scroll — which is also why the DIFF can tell viewport churn from real mutation. Elements carry a parent pointer, so the BRANCH an element sits in is data you can walk, not a diagram you have to render. Cost measured on github.com/nodejs/node: index 690 B vs a 116,573 B explore_page, over 3,842 elements.

v2.0 — THE LOOP (four steps, in this order):
  1. browse {url}             opens or binds the tab, collects a LOSSLESS inventory of every element
                              (nothing filtered, capped or truncated) and returns the index + a region
                              outline. The full records stay server-side, addressable by index.
  2. find {query|region|...}   locates the control. Every hit answers WHERE (region + branch chain) and
                              WHAT (role/name/attrs/state) — so you can tell five things called "New" apart.
  3. act {action, ref, ...}    does it: click, hover, rightclick, drag, type, key, form, upload, scroll,
                              dialog. Add how:"trusted" when the page checks isTrusted, reads
                              detail/coordinates, or a default action must be produced the way the
                              browser produces it. Works in a BACKGROUND tab — no focus steal.
  4. READ THE DIFF that arrives with the reply. It says whether the page actually mutated, lists what
                              changed, and ends with FULL DIFF: <handle>. If the summary is not enough,
                              page_slice{diff:"<handle>", part:"structure|content|visual|viewport"} returns any part.
  measured, not assumed: the DIFF is cached because it used to be 379 KB for one action; the summary is
  what changed and the handle is the rest. "mutated" comes from structure+content ONLY, so scroll or
  layout churn can never make an action look landed.
  HONEST LIMITS — read before you plan: trusted clicks/keys are the browser's own
  input but are NOT proven byte-identical to an OS click. Same-origin iframes ARE
  readable and clickable; cross-origin frames are not. Canvas/WebGL: use act{action:"click", x, y}.
  A trusted DRAG DOES COMPLETE (trusted dragstart/dragenter/dragover AND a real drop —
  the drop is read back from the page's own capture-phase listener, so the verdict is
  the page's, not the tool's). What is NOT trusted: the PLAIN drag mode (its events are
  synthetic), so a page checking isTrusted ignores it — use how:"trusted" for a drag.
  ★ SELF-ESCALATION (2026-10-02): act{how:"auto"} (the default) tries the cheap
  synthetic rung first and, when the page measurably ignores it (suspected_noop on a
  click, "Element not found"/failed on a type), automatically retries through the
  trusted pipeline in the same call. You do not have to know which controls gate on
  isTrusted or reconcile Draft.js writes — just call act, and the facade climbs.
  A navigation is never retried (it is the strongest confirmation there is).
  ★ DIALOGS: alert is captured (its return is undefined, so nothing branches on it).
  confirm/prompt stay NATIVE — a hooked one returns a Promise (always truthy), so every
  if(confirm(...)) would take the TRUE branch. To answer a native confirm/prompt on a
  background tab, call dialog{native:true, action:"accept"|"dismiss", value:promptText}
  — it goes through Page.handleJavaScriptDialog so the page's branch follows YOUR choice.
  Nothing auto-answers; a dialog is answered only when you decide.

THE 8 LISTED TOOLS — what each absorbed from the old 65-tool surface:
  act              DO something: action=click|hover|rightclick|drag|type|key|form|upload|scroll|dialog. how="trusted" goes through the browser's own input pipeline (a real isTrusted event, default actions run); how="os" is OS-level input and needs the tab in front. This is the one to reach for.
  preflight        CALL THIS FIRST when a page op is refused or a tool seems inert. Walks launch → server → extension → binding → page-ready in order, stops at the FIRST broken link, and returns THE STATE plus THE COMMAND that fixes it. Read-only by default; repair:true binds an unambiguous single tab. Never guesses which tab you meant.
  debug            WebSense itself + raw reads: op=status|session|logs|cookies|clipboard|screenshot|ax|evaluate|main_world|explore_page|reload|respawn|guide. Reach for it when something is wrong.
  websense_guide   this guide
  browse           TOOL 1 — go to a page and map it in one call: navigate (or bind) + seed the diff baseline + store the inventory + return ONLY the index + vocabulary. Replaces navigate+page_snapshot+map read.
  find             TOOL 2 — search the stored inventory; each hit gives WHERE (region, position, branch chain resolved from parent pointers) and WHAT (the page's own role/name/attrs/state). Returns ALL matches.

★★ TWO ANSWERS YOU MUST KNOW BEFORE YOU TRUST A VERDICT ★★

1. THE VERDICT CAN NOW BE UPGRADED BY THE DIFF. effect is decided from page_state (url/title/readyState/scroll) alone, so an action that ONLY changes the DOM — a trusted type, filling a field, opening an inline menu — used to answer 'unverifiable' while this same reply said mutated:true. That is a verdict contradicting its own evidence, and 'unverifiable' reads as "no proof", so a caller re-runs an action that already worked. Now: when the page-side differ measures a real structure/content move (mutated:true), an 'unverifiable' or 'suspected_noop' verdict is UPGRADED to 'confirmed' and carries effectSource:"page_diff", and the stale escalation advice is dropped with it. ★ IT ONLY EVER UPGRADES: a 'failed' verdict (the action layer refused, e.g. disabled/read-only) stays 'failed'. The measurement happened; classifyEffect just could not see it.

2. AN AMBIGUOUS SELECTOR IS REFUSED, NOT GUESSED. querySelector returns the FIRST match with no word, so a selector matching two elements silently drove the wrong one. Measured on x.com's /compose/post: [data-testid="tweetTextarea_0"] matches TWICE — the dialog's real composer and the empty page-level inline composer. You now get a refusal naming the count and the tag: 'ambiguous selector ... matches 2 elements — refusing to pick one silently'. SCOPE IT and retry: [role="dialog"] [data-testid="tweetTextarea_0"], or a selector unique on that page. ★ THIS COVERS CLICK AND TYPE — verified live after the click path shipped and the type path was found still unguarded: trusted_key resolves the selector server-side first, so text can no longer leak into the wrong editor either. This is also why find returns ALL matches with no cap — a cap would hide the second element and the ambiguity would be invisible.
THE REMAINING 30 — registered and callable by name, but NOT listed, so a model does not have to choose between them. The listed ones (page_slice, tabs) also appear here:
  explore_page     quick look at a page's actions (SAG). compact:true = old discover_actions; intent:"submit" = old find_intent; goal:"log in" = old explore_intent; preload:true = lazy-load first; incremental:true = delta since last scan (you usually do NOT need this any more: every mutating op returns a grouped DIFF automatically; for a full page map use browse + find instead — explore_page is the quick look, not the map)
  read             page text. format: "text" (extract_text) | "content" (read_content) | "markdown" (dump_markdown) | "diff" (page_diff) | "scrollextract" (scroll_and_extract) | "preload" (preload_content)
  click            click ref (default) | mode:"hover" | mode:"rightclick" | mode:"drag" (fromRef/toRef) | x,y for canvas (old click_xy)
  trusted_click    click through the BROWSER'S OWN input pipeline (chrome.debugger + Input.dispatchMouseEvent) instead of dispatching an event. The page receives exactly what a real mouse produces — click isTrusted:true, detail:1, the real clientX/Y, and the move that precedes the press applies :hover and feeds mousemove — and default actions run the way the browser runs them. Still background: no OS focus, no window activation, no bring-to-front. Measured on bench/click_fingerprint.html across a button, a checkbox, a link and an input: every one reports isTrusted=true/detail=1/real coordinates, and every one's default action fires. Reach for it when a page checks isTrusted, reads detail/coordinates/buttons, is a canvas or a custom control, or when click reports success and the page ignores it. Pass ref — it resolves the element box itself.
  trusted_key      type and/or press a key through the BROWSER'S OWN input pipeline (chrome.debugger + Input.dispatchKeyEvent) instead of dispatching a KeyboardEvent. The page receives trusted key events and the BROWSER runs the DEFAULT ACTION — an Enter in a form SUBMITS it, Tab moves focus — instead of us guessing at it with form.requestSubmit(). Still background: no OS focus, no window activation, no bring-to-front. One call does a fill AND a submit: text types a string key by key, key presses one key after it (the usual fill-then-Enter). Pass ref to focus the target first — the reply carries the focus outcome, because a key with no focus goes to body and lands nowhere, which looks exactly like "the key did nothing". Reach for it where press_key lands nothing silently, where a key must trigger a page behaviour, or where the page checks isTrusted. Measured: a fill+Enter on the fixture reports isTrusted:true and the form's submit EVENT fires.

CLICK FIDELITY — measured on bench/click_fingerprint.html, field by field, so you know which to reach for:
  Both paths RUN DEFAULT ACTIONS. That was worth measuring: click finishes with
  HTMLElement.click(), which performs activation behaviour, so it DOES toggle a checkbox, follow a
  link and focus an input. (I had written the opposite here before measuring — it was wrong.)
  What click cannot do is produce a TRUSTED event, and that is the whole difference:
                              click (dispatchEvent)        trusted_click (browser input pipeline)
    click.isTrusted           false                        true
    click.detail              0                            1
    click.clientX / clientY   0 / 0                        the real point (e.g. 83, 147)
    pointermove/mousemove     absent — no move before press present, as a mouse does
    events a real click has   adds pointerenter/mouseenter  exactly the browser's own sequence
                              (visible to capture listeners)
  So: use click for the great majority of React/Vue apps, which listen for the event and never
  inspect its trust. Reach for trusted_click when the page checks isTrusted, reads
  detail/coordinates/buttons, is a canvas or a custom control, or behaves differently between a
  real event and a dispatched one — and when a default action matters and you want it produced the
  way the browser produces it.
  COST: measured ~140-990ms per call (chrome.debugger attach is ~2-3ms and is REUSED for 25s, so a
  burst pays it once; the rest is the page's own handling). While attached Chrome shows its
  "debugging this browser" infobar. No OS focus, no window activation, no bring-to-front — the tab
  stays in the background and YOUR active tab is never touched.
  HOW IT REACHES A BACKGROUND TAB AT ALL: the browser drops input into a renderer that reports
  itself hidden. Measured: without the two emulation calls below, mouseMoved took 5,080ms and the
  PRESS WAS DROPPED ENTIRELY — no pointerdown/mousedown/click reached the page. trusted_click
  therefore sends Emulation.setFocusEmulationEnabled(true) and Page.setWebLifecycleState('active')
  first, which make a background renderer behave as a focused, active page. Same click afterwards:
  151ms and a full trusted sequence.
  Real OS input (real_click) remains the last rung: it is a genuine OS event, needs the window
  visible and foregrounded, and is the only path that survives a page which rejects programmatic
  input outright.
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
    if (o.intent) return textResult(annotateIntentResult(await getActiveHub().send({ type: 'find_intent', intent: o.intent, frameId: o.frameId, tabId: o.tabId }), 'intent', o.intent));
    if (o.goal) return textResult(annotateIntentResult(await getActiveHub().send({ type: 'explore_intent', goal: o.goal, frameId: o.frameId, tabId: o.tabId }), 'goal', o.goal));
    if (o.compact) return textResult(await getActiveHub().send({ type: 'discover_actions', maxActions: o.maxActions === undefined ? 200 : o.maxActions, frameId: o.frameId, tabId: o.tabId }));
    if (o.preload) {
      await getActiveHub().send({ type: 'preload_content', maxSteps: 8, settleMs: 250, restore: true, tabId: o.tabId });
    }
    const sag = await getActiveHub().send({ type: 'explore_page', full: o.full || false, includeContent: o.includeContent !== false, includeHidden: o.includeHidden || false, incremental: o.incremental || false, maxActions: o.maxActions, contentMaxLen: o.contentMaxLen, fresh: o.fresh || false, settle: o.settle, frameId: o.frameId, tabId: o.tabId });
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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
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
    if (fmt === 'diff') return textResult(await getActiveHub().send({ type: 'page_diff', frameId: o.frameId, tabId: o.tabId }));
    if (fmt === 'preload') return textResult(await getActiveHub().send({ type: 'preload_content', maxSteps: o.maxSteps || 25, settleMs: o.settleMs || 250, restore: o.restore !== false, frameId: o.frameId, tabId: o.tabId }));
    if (fmt === 'scrollextract') return textResult(await getActiveHub().send({ type: 'scroll_and_extract', scrolls: o.scrolls || 5, scrollDelay: o.scrollDelay || 1500, maxLen: o.maxLen || 20000, direction: o.direction || 'down', selector: o.selector || null, frameId: o.frameId, tabId: o.tabId }));
    if (fmt === 'markdown') return textResult(await getActiveHub().send({ type: 'dump_markdown', selector: o.selector || null, maxLen: o.maxLen || 20000, frameId: o.frameId, tabId: o.tabId }));
    if (fmt === 'content') return textResult(await getActiveHub().send({ type: 'read_content', selector: o.selector || null, maxLen: o.maxLen || 12000, frameId: o.frameId, tabId: o.tabId }));
    const raw = await getActiveHub().send({ type: 'extract_text', selector: o.selector || 'body', maxLen: o.maxLen || 4000, offset: o.offset || 0, frameId: o.frameId, tabId: o.tabId });
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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
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
      result = await getActiveHub().send({ type: 'click_xy', x: o.x, y: o.y, ref: o.ref, button: o.button || 'left', frameId: o.frameId, tabId: o.tabId });
    } else if (mode === 'drag') {
      result = await getActiveHub().send({ type: 'drag_drop', fromRef: o.fromRef, toRef: o.toRef, frameId: o.frameId, tabId: o.tabId });
    } else if (mode === 'hover') {
      result = await getActiveHub().send({ type: 'hover', ref: o.ref, frameId: o.frameId, tabId: o.tabId });
    } else if (mode === 'rightclick') {
      result = await getActiveHub().send({ type: 'right_click', ref: o.ref, frameId: o.frameId, tabId: o.tabId });
    } else {
      result = await getActiveHub().send({ type: 'click', ref: o.ref, frameId: o.frameId, tabId: o.tabId });
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
      // ★ A NAVIGATION IS A CONFIRMED CLICK, AND THE STATE PAIR CANNOT SEE IT (2026-10-01).
      // Measured with an independent oracle (the page's own location.href): clicking HN's
      // "newest" nav link and books.toscrape's "next" BOTH navigated, while the tool answered
      // effect:'suspected_noop', mutated:false. That is the worst direction to be wrong in —
      // suspected_noop carries escalation advice ("re-read, then consider an OS-level click"),
      // so the caller retries an action that already worked, and the recorded navigation never
      // happens.
      // WHY THE PAIR MISSES IT: beforeState/afterState are captured around a click that RETURNS
      // IMMEDIATELY, so when the click triggers a navigation both snapshots are the PRE-navigation
      // document and are identical BY CONSTRUCTION.
      // WHY THIS PROBE IS SAFE: it only compares a URL captured at click time (beforeState) with
      // the tab's URL read after the op, so a stale session URL cannot manufacture a confirmation.
      // It also only ever UPGRADES a verdict, never downgrades one.
      if (result.effect !== 'confirmed') {
        await confirmNavigation(result, o.tabId || sessionTabOf());
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
              const geo = await getActiveHub().send({ type: 'screen_center', ref: o.ref, frameId: o.frameId, tabId: o.tabId });
              if (geo && geo.success && geo.screen && geo.screen.x != null && geo.screen.y != null && geo.visible !== false) {
                // 3. Genuine OS click + re-diff
                realClickAt(geo.screen.x, geo.screen.y);
                await new Promise((r) => setTimeout(r, 250));
                const after = await readPageState(o.tabId || sessionTabOf());
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
    // the navigation may have been proven by the post-op URL probe rather than by the state pair
    const dRec = unwrapRelay(result);
    const navTo = (result.navigation && result.navigation.to)
      || (dRec && dRec.afterState && dRec.beforeState && dRec.afterState.url !== dRec.beforeState.url ? dRec.afterState.url : null);
    if (navTo) {
      getSession().recordNavigation(beforeUrl, navTo, o.ref, '', mode);
      getSession().recordPage(navTo, null);
    }
    return textResult(result);
  });

  // ═══ 5. TYPE ═══
  reg(server, 'type_text', {
    description: 'Fill input(s) with the React-safe native setter + input/change events. One field: ref+text. Many at once: fields:[{ref,text,clearFirst?},...] (old type_many — one round trip). Verifies value persistence; effect verdict included. On a contenteditable editor (Draft.js/Lexical/ProseMirror/Slate) the result carries mode:"replace"|"append" and expectedFinal, so you can tell a replace from an append without re-reading; clearFirst:false appends onto what is already there.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      ref: z.string().optional().describe('Element ref (single-field mode)'),
      text: z.string().optional().describe('Text to set (single-field mode)'),
      clearFirst: z.boolean().optional().describe('Clear before typing (default true)'),
      fields: z.array(z.object({ ref: z.string(), text: z.string(), clearFirst: z.boolean().optional() })).optional().describe('Batch mode: up to 50 fields'),
    },
  }, async (o) => {
    let result;
    if (o.fields && o.fields.length) {
      result = await getActiveHub().send({ type: 'type_many', fields: o.fields, tabId: o.tabId });
      getSession().recordAction({ action: 'type_many', refs: o.fields.map(f => f.ref) }, result);
      return textResult(result);
    }
    result = await getActiveHub().send({ type: 'type_text', ref: o.ref, text: o.text, clearFirst: o.clearFirst !== false, frameId: o.frameId, tabId: o.tabId });
    // ★ READ THE VERDICT FROM THE PAYLOAD, NOT THE ENVELOPE (2026-10-01) — see unwrapRelay.
    // This line is where the false success came from: `result.success` is the RELAY's success
    // (a reply arrived), so a refused type looked like a confirmed one.
    const d = unwrapRelay(result);
    const persisted = d && (d.valueSet === true || d.verified === true || d.success === true);
    result.effect = (d && d.success === false) ? 'failed' : persisted ? 'confirmed' : 'unverifiable';
    if (result.effect !== 'confirmed') {
      // ★ THE ELEMENT'S OWN STATE BEATS A GENERIC RE-READ (2026-10-01). When the action layer
      // refused for a reason it knows (disabled / read-only / aria-disabled), answering with the
      // blanket "re_read the field and re-type" sends the caller round a loop on a control that
      // can never accept text. Measured on bbc.com/news, whose search input is disabled until its
      // menu opens.
      result.escalation = (d && d.reason)
        ? { recommended: 'enable_then_type', reason: d.reason + (d.hint ? ' — ' + d.hint : '') }
        : { recommended: 're_read', reason: 'value persistence not confirmed — re-explore the field and re-type with clearFirst:true before escalating to OS-level input' };
    }
    getSession().recordAction({ action: 'type_text', ref: o.ref, text: o.text }, result);
    return textResult(result);
  });

  // ═══ 6. FORM ═══
  reg(server, 'form', {
    description: 'Form ops: action:"state" (fields, validation, submit readiness; formRef optional = all) | "select" (ref,value — native <select> AND ARIA dropdowns; select[multiple] accepts JSON array) | "toggle" (checkbox/switch/aria-pressed) | "special" (ref,value — date/time/color/range/number/checkbox/radio with auto-format + browser-rejection detection) | "upload" (ref, filePath — file input / dropzone / rich-editor paste, auto-picked).',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      action: z.enum(['state', 'select', 'toggle', 'special', 'upload']).describe('Form operation'),
      formRef: z.string().optional().describe('state: form ref e.g. "F0" (omit = all forms)'),
      ref: z.string().optional().describe('Element ref for select/toggle/special/upload'),
      value: z.string().optional().describe('select: option value (or JSON array for multi) | special: target value ("2026-09-01", "#ff8800", "42", "true")'),
      clearAll: z.boolean().optional().describe('select on multi-select: deselect non-matching options (default true)'),
      filePath: z.string().optional().describe('upload: absolute file path'),
    },
  }, async (o) => {
    if (o.action === 'state') return textResult(await getActiveHub().send({ type: 'form_state', formRef: o.formRef, frameId: o.frameId, tabId: o.tabId }));
    if (o.action === 'select') {
      requireArgs('form:select', o, { ref: 'element ref of the select', value: 'option value to select' });
      const result = await getActiveHub().send({ type: 'select_option', ref: o.ref, value: o.value, clearAll: o.clearAll, frameId: o.frameId, tabId: o.tabId });
      getSession().recordAction({ action: 'select_option', ref: o.ref, value: o.value }, result);
      return textResult(result);
    }
    if (o.action === 'special') {
      requireArgs('form:special', o, { ref: 'element ref', value: 'target value (date / colour / range / number)' });
      const result = await getActiveHub().send({ type: 'form_special', ref: o.ref, value: o.value, frameId: o.frameId, tabId: o.tabId });
      getSession().recordAction({ action: 'form_special', ref: o.ref, value: o.value }, result);
      return textResult(result);
    }
    if (o.action === 'toggle') {
      const result = await getActiveHub().send({ type: 'toggle', ref: o.ref, frameId: o.frameId, tabId: o.tabId });
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
      const result = await getActiveHub().send({ type: 'upload_file', ref: o.ref, fileContent: base64, fileName, mimeType: mimeTypes[ext] || 'application/octet-stream', frameId: o.frameId, tabId: o.tabId });
      return textResult(result);
    } catch (err) {
      return textResult({ success: false, error: 'Failed to read file: ' + err.message });
    }
  });

  // ═══ 7. REVEAL ═══
  reg(server, 'reveal', {
    description: 'Pre-extract hidden content WITHOUT clicking: kind:"dropdown" (all options, native + ARIA) | "tabs" (all tab panels) | "accordion" (all collapsible sections).',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (tick mode)'),
      amount: z.number().optional().describe('Ticks (default 1)'),
      ref: z.string().optional().describe('Element whose scrollable ancestor to scroll / intoView target'),
      y: z.number().optional().describe('Absolute pixel position (scroll_to mode)'),
      intoView: z.string().optional().describe('Ref to scroll into center of viewport'),
    },
  }, async (o) => {
    if (o.intoView) return textResult(await getActiveHub().send({ type: 'scroll_into_view', ref: o.intoView, frameId: o.frameId, tabId: o.tabId }));
    if (o.y != null) return textResult(await getActiveHub().send({ type: 'scroll_to', y: o.y, frameId: o.frameId, tabId: o.tabId }));
    return textResult(await getActiveHub().send({ type: 'scroll', direction: o.direction || 'down', amount: o.amount === undefined ? 1 : o.amount, ref: o.ref, frameId: o.frameId, tabId: o.tabId }));
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
  reg(server, 'tabs', {
    description: 'Tab/window ops. bind routes page ops to a tab WITHOUT focus — page ops NEVER need activation. action:"list" | "switch" (tabId) | "close" (tabId) | "bind" (tabId — route page ops at this tab WITHOUT focusing; pass activate:true ONLY when you are about to do OS-level input, since real_click/real_paste hit the frontmost window) | "frames" (tabId optional — list iframes w/ frameId for THAT tab; omit for your bound tab) | "windows" (all windows+tabs) | "focus" (windowId) | "move" (tabId,windowId) | "transfer" (fromTab,toTab,fromSelector,toSelector — atomic cross-tab copy/paste) | "switchread" (tabId,selector — switch+read in one).',
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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      kind: z.enum(['page', 'bridge', 'doctor', 'downloads']).optional().describe('Default page'),
    },
  }, async (o) => {
    const kind = o.kind || 'page';
    if (kind === 'bridge') {
      let pageUrl = null, pageTitle = null, probe = 'none';
      if (getActiveHub().connected) {
        try {
          const ps = await Promise.race([
            getActiveHub().send({ type: 'get_status', tabId: o.tabId }),
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
          hub.send({ type: 'doctor_content', tabId: o.tabId }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('content timeout (8s) — content script not responding')), 8000)),
        ]);
      } catch (e) { report.content = { error: String((e && e.message) || e) }; }
      try {
        report.serviceWorker = await Promise.race([
          hub.send({ type: 'doctor_sw', tabId: o.tabId }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('sw timeout (8s)')), 8000)),
        ]);
      } catch (e) { report.serviceWorker = { error: String((e && e.message) || e) }; }
      return textResult(report);
    }
    if (kind === 'downloads') return textResult(await getActiveHub().send({ type: 'download_state' }));
    return textResult(await getActiveHub().send({ type: 'page_state', frameId: o.frameId, tabId: o.tabId }));
  });

  // ═══ 11. WAIT ═══
  reg(server, 'wait', {
    description: 'Block until a condition (poll) OR a page event. Conditions (ANDed): urlContains, hasModal, hasCaptcha, notLoading, pendingDialogsGt, selector (CSP-safe), script (JS expr), timeoutMs, pollMs. Event mode: event:"dialog_open|dialog_close|navigation|network|form_update|any".',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
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
          const r = await getActiveHub().send({ type: 'get_events', since: Date.now() - 30000, tabId: o.tabId });
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
              inner = innerOf(await getActiveHub().send({ type: 'evaluate', script: 'querySelector(' + selJson + ')', tabId: o.tabId }));
            } catch (_) { inner = null; }
            if (inner) {
              ok = !!(inner.success !== false && (inner.found === true || (inner.result && inner.result.found === true)));
            } else {
              // Last resort: the eval form, in case a page wires safeDomRead out.
              try {
                const r = await getActiveHub().send({ type: 'evaluate', script: '!!document.querySelector(' + selJson + ')', tabId: o.tabId });
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
              const r3 = await getActiveHub().send({ type: 'evaluate', script: 'querySelectorAll(' + JSON.stringify(qsa[2]) + ')', tabId: o.tabId });
              const inner3 = innerOf(r3);
              const cnt = (inner3 && inner3.count != null) ? inner3.count : (inner3 && inner3.results ? inner3.results.length : -1);
              const want = parseInt(qsa[4], 10);
              ok = qsa[3] === '>' ? cnt > want : qsa[3] === '>=' ? cnt >= want : cnt === want;
            } else {
              const selM = script.match(/^(?:!!)?querySelector\(\s*(['"])(.*?)\1\s*\)$/);
              if (selM) {
                const r3 = await getActiveHub().send({ type: 'evaluate', script: 'querySelector(' + JSON.stringify(selM[2]) + ')', tabId: o.tabId });
                const inner3 = innerOf(r3);
                ok = !!(inner3 && inner3.success !== false && inner3.found === true);
              } else {
                try {
                  const r = await getActiveHub().send({ type: 'evaluate', script: o.script, tabId: o.tabId });
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
        try { last = await readPageState(o.tabId); } catch (_) { last = null; }
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
    if (o.query) return textResult(await getActiveHub().send({ type: 'evaluate_safe', query: o.query, tabId: o.tabId }));
    const r = await getActiveHub().send({ type: 'evaluate', script: o.script, tabId: o.tabId });
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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      format: z.enum(['png', 'jpeg']).optional().describe('Default png'),
      quality: z.number().optional().describe('JPEG quality 0-100 (default 80)'),
    },
  }, async (o) => {
    let r = await getActiveHub().send({ type: 'browser_screenshot', format: o.format || 'png', quality: o.quality || 80, tabId: o.tabId });
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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      key: z.string().describe('Key name e.g. "Enter", "Tab", "Escape", "c", "ArrowDown"'),
      ref: z.string().optional().describe('Element ref to target'),
      modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional(),
    },
  }, async (o) => {
    // ★ A KEY CAN SUBMIT A FORM OR ACTIVATE A LINK, SO IT GETS THE SAME NAVIGATION CHECK
    // (2026-10-01). Measured on en.wikipedia.org: type into the search box, press Enter, and the
    // page navigated to the article — while this result carried NO verdict at all and its auto-DIFF
    // said mutated:false, because that diff is read before the navigation commits.
    // Unlike click, a key result has no beforeState, so the "before" URL is read here. Gated on
    // Enter/Space and a 2-read budget, so arrow keys and ordinary typing pay nothing.
    const watching = (o.key === 'Enter' || o.key === ' ');
    const pre = watching ? await readPageState(o.tabId || sessionTabOf()) : null;
    const result = await getActiveHub().send({ type: 'press_key', key: o.key, ref: o.ref, modifiers: o.modifiers || [], frameId: o.frameId, tabId: o.tabId });
    if (watching) await confirmNavigation(result, o.tabId || sessionTabOf(), 2, pre && pre.url);
    return textResult(result);
  });

  // ═══ 15b. TRUSTED CLICK — input that the browser itself produced (2026-10-01) ═══
  // The synthetic click dispatches events; a dispatched event is untrusted, so no default action
  // runs and the fields a real input carries are absent. This op routes through
  // Input.dispatchMouseEvent instead — the same pipeline a real mouse uses — with no OS focus and
  // no window activation, so it stays a background tool.
  reg(server, 'trusted_click', {
    description: 'Click through the browser\'s OWN input pipeline (chrome.debugger + Input.dispatchMouseEvent) rather than dispatching a synthetic event. The page receives what a real mouse produces: isTrusted:true, buttons/clickCount/pointerId/pressure present, :hover applied by the move that precedes the press, and DEFAULT ACTIONS RUN (navigation, focus, checkbox toggle). Needs no OS focus and no window activation, so it stays a background tool. Use it when click reports success but the page ignored it, when the site only reacts to trusted input, or when a default action must actually run. Pass ref (or selector): it resolves the element box itself, so never pass coordinates.',
    inputSchema: {
      ref: z.string().optional().describe('Element ref/locator to click'),
      selector: z.string().optional().describe('CSS selector alternative to ref'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
      clickCount: z.number().optional().describe('Click count; 2 for a double click (this is what reaches the page as event.detail)'),
      mode: z.enum(['click', 'hover']).optional().describe('"click" (default) = move+press+release; "hover" = the SAME trusted pipeline with the move only — no press — which is exactly what applies :hover for a real mouse'),
      tabId: z.number().optional().describe('Target tab; omit to use your bound tab'),
    },
  }, async (o) => {
    const tabId = o.tabId || sessionTabOf();
    if (!tabId) return textResult({ success: false, error: 'trusted_click: no tab — pass tabId or browse first' });
    // ★ RAW COORDINATE CLICKS (2026-10-02). This used to REQUIRE a ref/selector, so a
    // coordinate click through the trusted path was UNREACHABLE from the listed surface —
    // act{action:"click", how:"trusted", x, y} passed only the selector (none), and the
    // only coordinate click was the UNTRUSTED dispatchEvent one. Canvas/WebGL surfaces
    // (which the guide itself routes to "act{action:'click', x, y}") are exactly the
    // surfaces where a page inspects isTrusted, so the trusted path is the one that
    // matters there. Coordinates are NOT a stale-box risk (the ref path resolves a box
    // because layout may have moved; a coordinate IS the point — nothing to resolve), so
    // they skip the box resolution entirely.
    if (!o.ref && !o.selector) {
      const cx = Number(o.x), cy = Number(o.y);
      if (!isFinite(cx) || !isFinite(cy)) {
        return textResult({ success: false, error: 'trusted_click: pass ref/selector OR x and y (viewport CSS px)' });
      }
      const btn = o.button || 'left';
      const mask = btn === 'left' ? 1 : btn === 'right' ? 2 : 4;
      const count = Number(o.clickCount) || 1;
      const isHover = o.mode === 'hover';
      const before = isHover ? null : await readPageState(tabId);
      const result = await getActiveHub().send({ type: 'trusted_click', tabId, x: cx, y: cy, button: btn, clickCount: count, mode: isHover ? 'hover' : 'click' });
      const rr = unwrapRelay(result);
      const refuse = relayFailure(rr);
      if (refuse) {
        result.effect = 'failed';
        result.escalation = { recommended: 're_read', reason: refuse };
      } else {
        result.effect = 'unverifiable';
        // A hover reports `hovered`, not `clicked` — it pressed nothing, and a reply field that
        // claims a click for a move is the kind of quiet untruth this codebase keeps paying for.
        if (isHover) result.hovered = { x: cx, y: cy, via: 'Input.dispatchMouseEvent (trusted, move only)' };
        else result.clicked = { x: cx, y: cy, via: 'Input.dispatchMouseEvent (trusted)', button: btn, clickCount: count };
      }
      // A trusted click is precisely the one that CAN navigate — same probe as the ref path.
      // A hover presses nothing, so it must NOT get the navigation probe: polling for a
      // navigation a hover is not supposed to cause is noise that reads like a verdict.
      if (!isHover && result.effect !== 'confirmed') await confirmNavigation(result, tabId, 3, before && before.url);
      return textResult(result);
    }
    // ★ RESOLVE THE BOX NOW, not from the stored snapshot: layout may have moved since the
    // collect, and a stale coordinate clicks whatever is there now — the one failure mode a
    // coordinate click cannot recover from or detect.
    let box = null;
    let vpResolved = null;
    try {
      // ★ SCROLL IT IN AND RESOLVE IT IN THE PAGE (2026-10-01). Same defect the trusted drag had: a
      // rect BELOW THE FOLD cannot receive browser input — measured on the fixture, a drag pair at
      // y=2086 produced ZERO events and the same pair at y=1095 produced the full trusted sequence.
      // This path also reaches SAME-ORIGIN FRAME content, which the content-script geometry op cannot
      // (it runs in the main frame only).
      vpResolved = (o.ref || o.selector) ? await pageCentre(o.ref || o.selector, tabId, true) : null;
      const g = vpResolved ? null : await getActiveHub().send({ type: 'geometry', ref: o.ref, selector: o.selector, tabId });
      // ★ `box` MUST BE THE OUTER ONE (2026-10-01). This used to read `const box = …`, which
      // SHADOWED the variable the caller tests: the geometry answer was scoped to the try block, so
      // `box` stayed null at every use below and the failure reply could not show WHY the resolve
      // failed. One binding per name.
      if (g) box = unwrapRelay(g);
    } catch (e) { box = { error: String((e && e.message) || e) }; }
    let vp = vpResolved || (box && box.viewport);
    if (!vp || !(vp.w > 0) || !(vp.h > 0)) {
      const ent = getSnapshot(tabId);
      const want = String(o.ref || o.selector || "");
      // ★ THE ELEMENTS LIVE AT ent.snap.elements, NOT ent.elements (2026-10-01). getSnapshot answers
      // with the store ENTRY {at, seq, snap, index, actionsSinceCollect}, so `ent.elements` was
      // undefined on every read and this fallback had NEVER ONCE FIRED — the documented last resort
      // for a control the live resolver cannot reach was dead code, and the reply blamed the element
      // for a lookup that never ran. The collector writes rec.x/rec.y already converted into
      // TOP-viewport space (frame offset included), which is exactly what a viewport click needs.
      const els = (ent && ((ent.snap && ent.snap.elements) || ent.elements)) || [];
      const hit = els.find((r2) => r2.loc === want);
      if (hit && hit.w > 0 && hit.h > 0) vp = { x: (hit.x + (hit.w >> 1)) - 1, y: (hit.y + (hit.h >> 1)) - 1, w: 2, h: 2, fromInventory: true };
    }
    if (!vp || !(vp.w > 0) || !(vp.h > 0)) {
      return textResult({ success: false, effect: 'failed', error: 'trusted_click: could not resolve a clickable box for that element',
        ...(box ? { detail: JSON.stringify(box).slice(0, 240) } : {}),
        escalation: { recommended: 'how:auto', reason: 'NO COORDINATE EXISTS FOR THIS ELEMENT (measured 2026-10-02): the resolver found nothing clickable-sized in the subtree (largest-descendant fallback), AND the LABEL PROXY attempt — label[for] / wrapping label, the surface a human presses for a visually-hidden control — found no rendered label either. So the render tree gives this element no pixels at all: display:none, detached, or inside a CROSS-ORIGIN frame (same-origin frames ARE reachable; the resolver walks every iframe document and converts the rect into TOP-viewport space, so list frames with tabs{action:"frames"} before blaming origin). Trusted input is coordinate-based and cannot aim at what the render tree omits — but how:"auto" dispatches the event ON THE NODE, which bypasses geometry entirely. Either switch to how:"auto", or reveal the element first (unhide / scroll it into existence) and retry how:"trusted"' } });
    }
    // ★ THE BOX IS REAL BUT NOTHING ON IT REACHES THE ELEMENT — REFUSE, DON'T CLICK BLIND
    // (2026-10-02, the click battery). Before dispatching, the resolver hit-tested 9 points
    // across the box with the browser's OWN elementFromPoint. All of them answered with some
    // other element (duckduckgo.com's semantic submit sits behind a sibling overlay: the
    // dispatch went through, hit the overlay, and the search silently never ran — a coordinate
    // click can neither aim around nor detect that). An overlay is not an input-rung defect,
    // so report the PAGE's fact with the occluder's identity and the two real remedies.
    if (vp.unreachable) {
      return textResult({ success: false, effect: 'failed',
        error: 'trusted_click: the element has a real box but NO point on it reaches the element',
        detail: `box ${vp.w}x${vp.h} at (${vp.x},${vp.y}) — elementFromPoint answered "${vp.blockedBy || 'another element'}" at every probe point (centre, quarters, edges)${vp.viaLabel ? ', and this IS the label proxy the resolver fell back to, so the visible label itself is covered' : ''}. That element sits on top: a human cannot click this control at these coordinates either.`,
        escalation: { recommended: 'how:auto', reason: 'OCCLUDED, NOT MISSING (measured 2026-10-02): trusted input is coordinate-based, and every coordinate on this element is covered — dispatching would hit the covering element (measured: the click "succeeded" and nothing happened). Two remedies: (1) how:"auto" dispatches the event ON THE NODE and bypasses hit-testing entirely; (2) dismiss/scroll away what covers it (an overlay, sticky header, expanding sibling — reported above) and retry how:"trusted".' } });
    }
    // Prefer the point the reach test PROVEN to route to the element — it may be an edge or a
    // child icon, not the geometric centre (the centre of a zero-width submit's box is a
    // different element entirely). Fall back to the centre for geometry/inventory paths,
    // which never run the probe.
    const x = Math.round(vp.click ? vp.click.x : (vp.x + vp.w / 2));
    const y = Math.round(vp.click ? vp.click.y : (vp.y + vp.h / 2));
    const isHoverR = o.mode === 'hover';
    const before = isHoverR ? null : await readPageState(tabId);
    const result = await getActiveHub().send({ type: 'trusted_click', tabId, x, y, button: o.button || 'left', clickCount: o.clickCount || 1, mode: isHoverR ? 'hover' : 'click' });
    const rr = unwrapRelay(result);
    const refuse = relayFailure(rr);
    if (refuse) {
      result.effect = 'failed';
      result.escalation = { recommended: 're_read', reason: refuse };
    } else {
      // The input was injected; whether it LANDED is decided below by the page itself.
      result.effect = 'unverifiable';
      // `hovered` for a move (no press was sent), `clicked` otherwise — the field must say what
      // actually went out. `vp` carries viaLabel when the coordinate is the LABEL proxy's, so the
      // reply shows which surface was actually aimed at.
      if (isHoverR) result.hovered = { x, y, box: vp, via: 'Input.dispatchMouseEvent (trusted, move only)' };
      else result.clicked = { x, y, box: vp, via: 'Input.dispatchMouseEvent (trusted)', button: o.button || 'left', clickCount: o.clickCount || 1 };
    }
    // ★ A TRUSTED click is precisely the one that CAN navigate, so it gets the same probe as
    // click — the strongest evidence available, and it needs no OS focus either. A hover presses
    // nothing: no navigation probe (polling for a navigation a hover should not cause is noise
    // that reads like a verdict).
    if (!isHoverR && result.effect !== 'confirmed') await confirmNavigation(result, tabId, 3, before && before.url);
    return textResult(result);
  });

  // ═══ 15c. TRUSTED KEY — keyboard the browser itself delivered (2026-10-01) ═══
  // The keyboard half of trusted_click. A dispatched KeyboardEvent is untrusted, so the browser
  // runs no default action for it: measured on en.wikipedia.org, an Enter reached the element with
  // the right target ({key:'Enter', trusted:false}) and the form did NOT submit — and press_key
  // worked around that by CALLING form.requestSubmit() itself, which is a guess about what the page
  // wanted. This goes through Input.dispatchKeyEvent, so the default action is the browser's.
  reg(server, 'trusted_key', {
    description: 'Type text and/or press a key through the BROWSER\'S OWN input pipeline (chrome.debugger + Input.dispatchKeyEvent) rather than dispatching a KeyboardEvent. The page receives trusted key events (isTrusted:true, real code/keyCode), and DEFAULT ACTIONS RUN — an Enter in a form SUBMITS it, Tab moves focus, an arrow key moves a slider — because the browser is the one acting. It works on a BACKGROUND tab: no OS focus and no window activation, so the page does not need to be in front. Fills and submits in ONE call: pass text to type a string key by key, key to press one key after (the usual fill-then-Enter). Pass ref to focus the target first; the reply says whether the focus was accepted. Use it where press_key silently lands nothing, where a key must trigger a page behaviour, or where a page checks isTrusted.',
    inputSchema: {
      text: z.string().optional().describe('Type this string, one key press per character'),
      key: z.string().optional().describe('Then press this key once: Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, Delete, Home, End, PageUp, PageDown or a single character'),
      ref: z.string().optional().describe('Element to focus first (a ref/locator), so the key has a target'),
      modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])).optional().describe('Modifiers held for every event'),
      tabId: z.number().optional(),
    },
  }, async (o) => {
    const tabId = o.tabId || sessionTabOf();
    if (!o.text && !o.key) return textResult({ success: false, error: 'trusted_key: pass text and/or key' });
    // CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
    const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
    let mods = 0;
    for (const m of (o.modifiers || [])) mods |= (MOD[m] || 0);
    const before = await readPageState(tabId);
    // ★ THE AMBIGUITY GUARD MUST ALSO COVER TYPING (2026-10-02, measured live). trusted_key
    // hands `selector` straight to the content script, which resolves it with its own
    // querySelector — so it never reached pageCentre and the 2-match refusal (added for the
    // click path) never fired here. MEASURED on x.com: with TWO [data-testid="tweetTextarea_0"]
    // elements on the page (the dialog composer and the page-level one), `act{type, trusted}`
    // typed into the first one and reported success. That is precisely the silent-wrong-target
    // bug the refusal exists to stop, so the check is resolved HERE, server-side, before the
    // key events go out. Click and type must agree: a selector is either unambiguous or refused.
    let selGuard = null;
    // ★ READ BOTH NAMES, OR THE GUARD IS DEAD CODE (measured 2026-10-02). trusted_key's schema
    // names the parameter `ref`, but the `act` facade forwards the caller's `selector` verbatim
    // (`pass()` is Object.assign over the whole arg object). So the first version of this guard
    // read `o.ref`, which was undefined on every `act` call — the refusal never fired, and a live
    // re-test typed straight into the wrong composer with a clean success reply. The two paths
    // name the same thing differently; accept either.
    const selForGuard = o.ref || o.selector || null;
    if (selForGuard) {
      try {
        const probe = await pageCentre(selForGuard, tabId, false);
        // pageCentre throws a named ambiguous-selector error on a multi-match; a null probe
        // simply means the content script will resolve it, which is the pre-existing path.
        selGuard = probe || null;
      } catch (e) {
        if (e && e.detail && e.detail.reason === 'ambiguous-selector') {
          return textResult({
            success: false,
            effect: 'failed',
            error: e.message,
            detail: e.detail,
            escalation: { recommended: 'scope_selector', reason: 'This selector matches ' + e.detail.matches + ' elements. Scope it (e.g. [role="dialog"] ' + selForGuard + ') so exactly one matches.' },
          });
        }
      }
    }
    const result = await getActiveHub().send({ type: 'trusted_key', tabId, text: o.text, key: o.key, selector: o.ref, modifiers: mods });
    const rr = unwrapRelay(result);
    const refuse = relayFailure(rr);
    if (refuse) {
      result.effect = 'failed';
      result.escalation = { recommended: 're_read', reason: refuse };
    } else {
      result.effect = 'unverifiable';
      // The focus outcome is worth surfacing: a key with no focus goes to <body> and lands
      // nowhere, which looks identical to "the key did nothing".
      if (rr && rr.focus && rr.focus !== 'focused') result.focusWarning = 'the element was not left focused (' + rr.focus + ') — the key may have gone nowhere';
    }
    // A key can submit a form or activate a link, so it gets the same navigation check as a click.
    // ★ AND THE WINDOW MATTERS (measured 2026-10-01): type "World War II" into Wikipedia's search
    // and press Enter, and the page DOES navigate — but a full document load took longer than the
    // probe, so the verdict came back 'unverifiable' for a key that had plainly worked. An Enter is
    // therefore given a longer window (~1.3s); anything else gets a single immediate probe, because
    // typing a character must not cost a second of polling.
    const looksLikeSubmit = (String(o.key || '') === 'Enter');
    if (result.effect !== 'confirmed') {
      await confirmNavigation(result, tabId, looksLikeSubmit ? 6 : 1, before && before.url);
    }
    return textResult(result);
  });

  // ═══ 16. DIALOG ═══
  reg(server, 'dialog', {
    description: 'Resolve dialogs. JS dialogs (alert/confirm/prompt — captured, non-blocking): action:"accept"|"dismiss" + index? + value? (prompt answer). native:true answers a NATIVE confirm/prompt (left native by default) via Page.handleJavaScriptDialog on a background tab. OS-level dialogs (basic-auth, print — unreachable by DOM): keystroke:true + key:"enter|escape|tab|space|f5|ctrl+c" + optional value typed first (e.g. credentials).',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
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
    // ★ NATIVE-DIALOG ANSWER (2026-10-02). confirm/prompt are left
    // NATIVE (a hooked one returns a Promise = always truthy = every
    // if(confirm()) takes TRUE), so they never enter the hook's captured
    // queue and handle_dialog cannot see them. A page in a BACKGROUND
    // tab blocks on its own native dialog, and Chrome auto-dismisses a
    // dialog raised while hidden. When the caller names a dialog type the
    // hook does not capture, answer it through the browser
    // (Page.handleJavaScriptDialog) so the page's branch follows the
    // agent's real choice — reviving d5afe20 after its revert 29a0766,
    // but ONLY on an explicit accept/dismiss of a named dialog, never an
    // auto-answer. Routed through the existing `dialog` tool (no new
    // listed tool) with native:true as the switch.
    if (o.native) {
      return textResult(await getActiveHub().send({ type: 'dialog_answer', tabId: o.tabId, accept: o.action !== 'dismiss', promptText: o.value }));
    }
    return textResult(await getActiveHub().send({ type: 'handle_dialog', action: o.action || 'accept', index: (o.index === undefined ? null : o.index), value: (o.value === undefined ? null : o.value), tabId: o.tabId }));
  });

  // ═══ 17. SESSION ═══
  // ═══ 12. PREFLIGHT — THE WHOLE LAUNCH → CONNECT → BIND → VERIFY CHAIN (2026-10-02) ═══
  // ★ WHY THIS EXISTS. Four failures look identical from the outside — "the tool doesn't
  // work" — but have four different fixes, and each was diagnosed by hand today:
  //   1. no server        -> /health refuses connection
  //   2. server up, no extension -> hub connected:false, and Chromium is not even running
  //   3. extension up, session unbound -> the tab-hijack guard refuses EVERY page op
  //   4. bound, but the page is not ready -> the op runs against a half-hydrated DOM
  // A caller cannot tell these apart from an error message, so it re-diagnoses and
  // re-tries. preflight walks the chain in order, stops at the first break, and returns
  // THE STATE plus THE COMMAND that fixes it. It never silently repairs anything: launching
  // a browser or resetting a session are the caller's decisions, not ours.
  reg(server, 'preflight', {
    description: 'Walk the launch → connect → bind → verify chain and report the FIRST broken link plus the exact command that fixes it. Call this FIRST when a page op is refused, a tool seems inert, or you are starting work in a new session: it distinguishes "no server", "no extension", "session not bound" and "page not ready" in one call instead of by trial and error. Read-only by default; pass repair:true to perform the launch/bind steps it says are needed.',
    inputSchema: {
      tabId: z.number().optional().describe('Tab to verify/bind (default: the session-bound tab, else the only matching tab)'),
      url: z.string().optional().describe('Optional URL to check readiness against (e.g. the URL you are about to drive)'),
      expectSelector: z.string().optional().describe('Optional selector that must exist before you act — the readiness test'),
      repair: z.boolean().optional().describe('Actually perform the launch/bind steps (default false = diagnose only)'),
      timeoutMs: z.number().optional().describe('Per-step budget in ms (default 8000)'),
    },
  }, async (o) => {
    const budget = o.timeoutMs || 8000;
    const steps = [];
    const deadline = Date.now() + budget;
    const hub = getActiveHub();

    // ── LINK 1: is the hub itself answering? ──────────────────────────────────
    // A wedged server answers /health while /mcp initialize returns zero bytes, so the
    // ONLY honest test is a real MCP-shaped round trip, never the health one-liner.
    let hubOk = false, hubDetail = null;
    try {
      const st = (typeof hub.stats === 'function') ? hub.stats() : null;
      hubOk = true;
      hubDetail = { clients: st && st.clients, connected: hub.connected };
    } catch (e) {
      hubDetail = { error: String((e && e.message) || e) };
    }
    steps.push({ link: 'server', ok: hubOk, detail: hubDetail,
      ifBroken: 'Start it: `node src/server.js --http --http-port 9222` (the extension auto-connects on :38401).' });
    if (!hubOk) {
      return textResult({ ok: false, brokenAt: 'server', steps,
        fix: 'node src/server.js --http --http-port 9222',
        why: 'No hub is answering, so every tool call fails identically and nothing else can be diagnosed.' });
    }

    // ── LINK 2: did the EXTENSION connect? ────────────────────────────────────
    // The browser being closed is INVISIBLE from here: the server happily serves tools
    // and every page op then fails at the far end. Check the census, not the port.
    let census = {};
    try { census = (typeof hub.census === 'function') ? hub.census() : {}; } catch (_) {}
    const clients = census.clientsRegistered != null ? census.clientsRegistered
      : (typeof hub.stats === 'function' && hub.stats() ? (hub.stats().clients || 0) : 0);
    const extOk = !!hub.connected && clients > 0;
    steps.push({ link: 'extension', ok: extOk, detail: { connected: !!hub.connected, clients, census: census.contentTabs },
      ifBroken: 'The browser is not running, or the extension is not loaded/connected. Load extension/ via chrome://extensions (Developer mode → Load unpacked); it auto-connects — no launcher page.' });
    if (!extOk) {
      return textResult({ ok: false, brokenAt: 'extension', steps,
        fix: hub.connected ? 'Reload the extension (chrome://extensions → Reload on WebSense MCP Bridge).'
                           : 'Launch the browser with the extension loaded, then wait ~2s for the WebSocket.',
        why: hub.connected
          ? 'A client is registered but none are answering — usually a suspended/zombie offscreen document. Reloading the extension respawns it.'
          : 'The server is up but no browser is connected. This is why "the tool does nothing" with no error.' });
    }

    // ── LINK 3: is THIS SESSION bound to a tab? ───────────────────────────────
    // The tab-hijack guard refuses every unbound page op with a long message. Naming
    // that up front is cheaper than rediscovering it from the refusal.
    // ★ USE THE REAL MECHANISM (measured, not assumed). The binding lives in the
    // AsyncLocalStorage session store (`sessionTabOf()`), mirrored onto the McpServer
    // object as `_wsBoundTabId` so it survives across HTTP requests. My first draft read
    // getSession().boundTabId, which does not exist — it would always report "unbound".
    const srv = sessionCtx.getStore() ? sessionCtx.getStore().server : null;
    const bound = sessionTabOf() != null ? sessionTabOf()
      : (srv && srv._wsBoundTabId != null ? srv._wsBoundTabId : (o.tabId != null ? o.tabId : null));
    let tabs = [];
    try {
      const r = unwrapRelay(await hub.send({ type: 'list_tabs' }));
      tabs = Array.isArray(r) ? r : (r && Array.isArray(r.tabs) ? r.tabs : []);
    } catch (e) { tabs = []; }
    const bindOk = bound != null && tabs.some((t) => Number(t.id) === Number(bound));
    steps.push({ link: 'binding', ok: bindOk,
      detail: { sessionBoundTab: bound, requested: o.tabId || null, tabsVisible: tabs.length,
                urls: tabs.slice(0, 6).map((t) => String(t.url || '').slice(0, 80)) },
      ifBroken: 'Every page op refuses without a tab (the hub will not guess one). Bind explicitly: tabs{action:"bind", tabId:N} — never rely on the implicit selected tab.' });
    if (!bindOk) {
      // BIND ONLY WHEN UNAMBIGUOUS, AND ONLY WITH repair:true. Binding redirects this
      // session's ops, and with several tabs open a wrong guess would drive someone
      // else's page — the exact hijack class of bug this project has been fixing.
      const candidates = tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: !!t.active }));
      const unique = candidates.length === 1 ? candidates[0] : null;
      let didBind = false;
      if (o.repair && unique) {
        try {
          const st = sessionCtx.getStore();
          if (st) { st.boundTabId = unique.tabId; if (st.server) st.server._wsBoundTabId = unique.tabId; claimTab(st.server, unique.tabId); }
          didBind = true;
        } catch (_) { didBind = false; }
      }
      return textResult({
        ok: didBind, brokenAt: didBind ? null : 'binding', steps,
        candidates,
        fix: unique ? ('tabs{action:"bind", tabId:' + unique.tabId + '}')
                    : ('tabs{action:"bind", tabId:N} — ' + candidates.length + ' tabs are open; pick by URL. WebSense will NOT guess: a wrong guess drives the wrong page.'),
        why: candidates.length === 1
          ? 'Exactly one tab is open — preflight binds it for you when called with repair:true.'
          : 'Several tabs are open and this session is unbound, so every page op is refused. Match a tab by URL and bind it.',
      });
    }

    // ── LINK 4: is the bound PAGE actually ready to act on? ───────────────────
    // Acting on a half-hydrated SPA reads a 140-element skeleton and looks like a broken
    // selector. readyState + the caller's own selector is the honest readiness test.
    let ready = null, pageDetail = null;
    try {
      const st = unwrapRelay(await hub.send({ type: 'page_state', tabId: bound }));
      ready = st && st.readyState === 'complete';
      pageDetail = { url: st && st.url, title: st && st.title, readyState: st && st.readyState };
    } catch (e) { pageDetail = { error: String((e && e.message) || e) }; }
    let selectorOk = null;
    if (o.expectSelector) {
      try {
        const probe = await pageCentre(o.expectSelector, bound, false);
        selectorOk = !!probe;
      } catch (e) {
        // A refusal here is the ambiguity guard working — which means the element EXISTS.
        selectorOk = !!(e && e.detail && e.detail.reason === 'ambiguous-selector');
      }
      pageDetail = Object.assign({}, pageDetail, { expectSelector: o.expectSelector, present: selectorOk });
    }
    const pageOk = ready !== false && selectorOk !== false;
    steps.push({ link: 'page', ok: pageOk, detail: pageDetail,
      ifBroken: 'The page is still loading or the selector is absent. wait{notLoading:true} or wait{selector:"…"} rather than acting now — an op on a hydrating DOM reads a skeleton and looks like a missing element.' });

    const anyRepair = steps.some((s) => !s.ok);
    return textResult({
      ok: pageOk, brokenAt: pageOk ? null : 'page', steps,
      elapsedMs: Date.now() - (deadline - budget),
      summary: steps.map((s) => (s.ok ? 'OK ' : 'BROKEN ') + s.link).join(' → '),
    });
  });

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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      clear: z.boolean().optional().describe('Clear log after returning (default true)'),
      maxEntries: z.number().optional().describe('Default 50'),
    },
  }, async (o) => textResult(await getActiveHub().send({ type: 'network_log', clear: o.clear !== false, maxEntries: o.maxEntries || 50, tabId: o.tabId })));

  // ═══ 19. CONSOLE (parity with Hermes browser_console — 2026-08-30) ═══
  reg(server, 'console_log', {
    description: 'Captured browser console + JS errors since last call (console.log/warn/error/info/debug + window.onerror + unhandledrejection, ring buffer 300). Call once to start capturing, then again after an interaction that "does nothing" to read what the page JS is complaining about. clear, maxEntries (default 100).',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      clear: z.boolean().optional().describe('Clear the buffer after returning (default true)'),
      maxEntries: z.number().optional().describe('Max entries to return (default 100)'),
    },
  }, async (o) => textResult(await getActiveHub().send({ type: 'console_log', clear: o.clear !== false, maxEntries: o.maxEntries || 100, tabId: o.tabId })));

  // ═══ 19b. COOKIES (P2 — 2026-08-31) ═══
  // Session inspection / transplant / cleanup. Values ARE returned for
  // action:'get' (needed for session transplant between tabs/profiles);
  // action:'list' is metadata-only (names, expiry, flags).
  reg(server, 'cookies', {
    description: 'Cookie session manager: action:"list" (metadata for a url domain — names, expiry, httpOnly, secure; NO values) | "get" (one cookie WITH value — for session transplant) | "clear" (one cookie by name) | "clear_all" (all cookies for the domain). url is the page/API origin.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
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
        const st = await hub.send({ type: 'get_status', tabId: o.tabId }, { timeoutMs: 4000 });
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
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      action: z.enum(['copy', 'read']).describe('Clipboard operation'),
      text: z.string().optional().describe('copy: text to copy'),
    },
  }, async (o) => {
    if (o.action === 'read') return textResult(await getActiveHub().send({ type: 'read_clipboard', tabId: o.tabId }));
    return textResult(await getActiveHub().send({ type: 'copy_to_clipboard', text: o.text, frameId: o.frameId, tabId: o.tabId }));
  });

  // ═══ 20. INSPECT ═══
  reg(server, 'inspect', {
    description: 'Element introspection without vision: kind:"element" (is ref alive? re-resolve after re-render → {found,tag,text,locator}) | "geometry" (bounding box, z-depth, position vs real scroll container; ref or selector) | "relation" (refA vs refB: above/below/overlaps/covers — modal-over-form detection).',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      kind: z.enum(['element', 'geometry', 'relation']).describe('What to inspect'),
      ref: z.string().optional().describe('element/geometry: element ref'),
      selector: z.string().optional().describe('geometry: CSS selector alternative'),
      refA: z.string().optional().describe('relation: first element'),
      refB: z.string().optional().describe('relation: second element'),
    },
  }, async (o) => {
    if (o.kind === 'geometry') return textResult(await getActiveHub().send({ type: 'geometry', ref: o.ref, selector: o.selector, tabId: o.tabId }));
    if (o.kind === 'relation') return textResult(await getActiveHub().send({ type: 'layout_relation', refA: o.refA, refB: o.refB, tabId: o.tabId }));
    return textResult(await getActiveHub().send({ type: 'resolve_ref', ref: o.ref, tabId: o.tabId }));
  });

  // ═══ 21. REAL-INPUT RUNG (v4.4 — 2026-09-01) ═══
  // Synthetic events are ignored by React/Lit/Custom-Element submit buttons
  // (shreddit, Lexical editors, faceplate components). These tools climb the
  // ladder to GENUINE OS input via UIA (pywinauto) + SendInput (pyautogui),
  // title-gated so multi-agent tab churn can't land input on a sibling tab.
  // All coords are VIEWPORT coords (same space as inspect geometry); the
  // helper measures the Chrome Document origin itself.
  // ★ THE INTERPRETER MUST BE DISCOVERED, NOT HARD-CODED (2026-10-02). This read
  // 'C:/Users/Ali/AppData/Local/Programs/Python/Python311/python.exe' — the OPERATOR's
  // absolute path, shipped as the DEFAULT. Every other user therefore got a command
  // that could not execute: the OS-level rungs (real_click / real_paste /
  // dialog{keystroke}) failed with a spawn error while the failure read like a page
  // problem. It was both a privacy leak (someone's home directory in a public repo)
  // and a broken install for 100% of everyone else.
  // Resolution order: an explicit override, then the names PATH resolves on this
  // platform. `python3` first on POSIX; on Windows the launcher is `py`, and `python`
  // is a Store stub that exits without running anything, so it is tried last.
  const PY_CANDIDATES = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  let PY = process.env.WEBSENSE_PYTHON || null;
  if (!PY) {
    for (const cand of PY_CANDIDATES) {
      try {
        execSync(`"${cand}" -c "import sys"`, { stdio: 'ignore', timeout: 8000 });
        PY = cand;
        break;
      } catch (_) { /* not this one */ }
    }
  }
  if (!PY) PY = process.platform === 'win32' ? 'py' : 'python3';   // last resort; the error names the fix
  const REAL_INPUT = fileURLToPath(new URL('../scripts/real_input.py', import.meta.url));

  function runRealInput(args) {
    try {
      const out = execFileSync(PY, [REAL_INPUT, ...args], { encoding: 'utf8', timeout: 30000 });
      return JSON.parse(out.trim().split('\n').pop());
    } catch (e) {
      // A missing interpreter is the single most likely cause here and it used to
      // surface as an opaque exec failure. Name it.
      if (e && e.code === 'ENOENT') {
        return { success: false, error: 'OS input needs Python 3 with pyautogui + pywinauto, and no interpreter was found. Install Python, or set WEBSENSE_PYTHON to its full path. Tried: ' + PY_CANDIDATES.join(', ') + '.' };
      }
      return { success: false, error: String((e && (e.stderr || e.message)) || e).slice(0, 300) };
    }
  }

  // Genuine OS input (click/paste) is delivered OUTSIDE the page's JS, so there is
  // no synthetic event to inspect — the only honest check is whether page state
  // changed. Capture it around the call and classify (2026-09-11d). Previously the
  // escalation rung — the one that exists precisely BECAUSE synthetic input is
  // unreliable — was the only rung returning no verdict at all.
  // LIMIT (stated, not hidden): page_state covers url/title/readyState/scroll, so a
  // modal or DOM-only change reads as suspected_noop. That is NOT proof of failure.
  async function withEffect(fn) {
    const quick = async () => await readPageState(o.tabId);
    const before = await quick();
    const res = await fn();
    if (!res || typeof res !== 'object' || res.success === false) return res;
    await new Promise((r) => setTimeout(r, 450));   // let the handler run
    const after = await quick();
    // ★ THE STATES MUST LAND WHERE classifyEffect READS THEM (2026-10-01). quick() used to return
    // the raw hub envelope and these lines set beforeState/afterState on the ENVELOPE — then
    // classifyEffect unwrapped to `.data`, found nothing, and answered 'unverifiable' every time.
    // Set them on the payload it actually reads, and keep the documented top-level shape for
    // callers as well. (Same envelope mistake as type_text / the click probe / auto-climb.)
    const box = unwrapRelay(res);
    if (box && typeof box === 'object') { box.beforeState = before; box.afterState = after; }
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
  reg(server, 'page_snapshot', {
    description: 'LOSSLESS page inventory held server-side; returns the small INDEX (counts + addressable dimensions). Then call page_slice to fetch one slice at full fidelity. Unlike explore_page nothing is filtered out (no interactive-only, no in-viewport-only), and unlike the scan cache the snapshot does NOT change when you scroll. There is no TTL: reads self-heal, and fresh:true forces a re-collect.',
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
    description: 'Full-fidelity records from the stored page snapshot, filtered to ONE slice: indices / tag / role / region / vp (true|false) / interactive / field / focusable / attr / query. Returns ALL matches by default — pass limit only if you actually want a cut, and truncatedByLimit will say so. This is how you load only the branch you need WITHOUT re-reading the page and without anything being cut out. indices:[i] is the companion to a DIFF block, which names what changed by index and leaves the detail here. Call page_snapshot or browse first.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      tag: z.string().optional().describe('Filter by tag, e.g. input'),
      role: z.string().optional().describe('Filter by ARIA role (read from the element own recorded attributes)'),
      region: z.string().optional().describe('Filter by region substring — region is derived from the nearest ancestor the PAGE labelled'),
      vp: z.boolean().optional().describe('true = in viewport only, false = off-viewport only'),
      interactive: z.boolean().optional().describe('true = actionable only, DERIVED (focusable || form field || role present), not a tag table'),
      field: z.boolean().optional().describe('true = form controls only (platform-reported)'),
      focusable: z.boolean().optional().describe('true = focusable only (el.tabIndex >= 0, the browser own computation)'),
      attr: z.union([
        z.string(),
        z.object({ name: z.string(), value: z.string().optional() }),
      ]).optional().describe('Filter by ANY attribute the page wrote, e.g. attr:"data-testid" or attr:{name:"data-offset",value:"3"}'),
      query: z.string().optional().describe('Substring match over name / locator / tag / region / attribute names'),
      diff: z.string().optional().describe('A FULL DIFF handle from a DIFF block (e.g. diff:328034470:m1a2) — returns that part of the CACHED diff instead of reading the page'),
      part: z.enum(['structure', 'content', 'visual', 'viewport', 'all']).optional().describe('Which part of a cached diff (default all)'),
      // ★ DECLARED 2026-10-01 — IT WAS NOT, AND IT SILENTLY RETURNED THE WHOLE PAGE.
      // The handler has always forwarded its args straight to sliceSnapshot(), which HAS
      // supported `indices` since the DIFF was built: the DIFF names what changed by index and
      // says the detail is "one page_slice{indices:[i]} away". But `indices` was absent from
      // this schema, so it was stripped before the handler ever saw it and the call fell through
      // to "no filter" — the exact opposite of the documented follow-up. Measured on
      // books.toscrape: page_slice{indices:[31]} returned 543 of 543 records. The class of bug
      // is not new (find{field:true} returned 103/103 for the same reason); what is new is a
      // test that walks EVERY tool forwarding to sliceSnapshot instead of just the one that
      // broke last time. See 'slice: every key sliceSnapshot understands must be declared'.
      indices: z.array(z.number()).optional().describe('Fetch exact records by inventory index — this is how you pull the detail for indices a DIFF block named, WITHOUT re-reading the page'),
      limit: z.number().optional().describe('OPT-IN cap on returned records. Omit for ALL matches (no default, no clamp)'),
    },
  }, async (o) => {
    // A CACHED-DIFF READ SHORT-CIRCUITS THE PAGE (2026-10-01): the caller asks about a PAST diff, not
    // the current page, so no snapshot is needed and nothing can go stale.
    if (o.diff) {
      const full = getDiff(o.diff);
      if (!full) return textResult({ success: false, error: 'no cached diff for ' + o.diff + ' (the cache holds the last 25)' });
      if (!o.part || o.part === 'all') return textResult({ success: true, diff: o.diff, part: 'all', content: full });
      return textResult({ success: true, diff: o.diff, part: o.part, content: full[o.part] });
    }
    const tabId = o.tabId || sessionTabOf();
    // ★ SELF-HEALING READ (2026-10-01): a slice never fails on staleness either. If the page
    // has moved on since the last collect, refresh and serve the current page.
    const ens = await ensureSnapshot(tabId, 'page_slice');
    if (!ens.entry) {
      return textResult({
        success: false,
        error: ens.error || ('could not map tab ' + tabId),
        stats: snapshotStats(),
      });
    }
    const e = ens.entry;
    const s = sliceSnapshot(e.snap, o);
    return textResult({
      success: true, snapshotSeq: e.seq, ageMs: Date.now() - e.at, url: e.snap.url,
      matched: s.matched, returned: s.returned, truncatedByLimit: s.truncatedByLimit,
      elements: s.elements,
    });
  });

  // ═══ TOOL 1 — browse (Ali 2026-10-01) ═══
  // "this should be automatically triggered when you bind to a tab and navigate to a page
  //  it should cache ... the baseline for any page is initial navigation to that page
  //  perhaps this should be tool 1 - browse or something"
  //
  // ONE call replaces navigate + page_snapshot + the map read. It navigates (or binds),
  // seeds the page's DIFF BASELINE, stores the lossless inventory, and returns only the
  // INDEX + the vocabulary. From then on every mutating op auto-diffs against that
  // baseline, so the model never has to ask "what changed?".
  reg(server, 'browse', {
    description: 'TOOL 1. Go to a page and map it in ONE call: navigate (or bind an existing tab), seed the auto-diff BASELINE for that page, store the lossless inventory, and return ONLY the small index + the vocabulary this page actually uses. After browse, every mutating op automatically returns a DIFF grouped into structure / content / viewport — you never have to ask what changed. Then use find{query} to locate a control and page_slice to load just that branch. This is the token-efficient entry point: the index is bytes, the inventory stays server-side.',
    inputSchema: {
      url: z.string().optional().describe('URL to navigate to. Omit to just (re)baseline the bound tab.'),
      tabId: z.number().optional().describe('Existing tab to bind instead of navigating'),
      newTab: z.boolean().optional().describe('Force a fresh tab rather than reusing the bound one'),
      fresh: z.boolean().optional().describe('Re-collect even if a snapshot for this tab is still warm'),
    },
  }, async (o) => {
    let tabId = o.tabId || null;
    let navigated = null;
    if (o.url) {
      const r = await getActiveHub().send({ type: 'navigate', url: o.url, newTab: !!o.newTab || !sessionTabOf(), tabId: o.tabId });
      tabId = (r && r.tabId) || tabId;
      navigated = o.url;
      if (tabId) {
        server._wsBoundTabId = tabId;
        claimTab(server, tabId);
        const st = sessionCtx.getStore();
        if (st) st.boundTabId = Number(tabId);
      }
    }
    if (!tabId) tabId = sessionTabOf();
    if (!tabId) return textResult({ success: false, error: 'no tab — pass url or bind a tab first' });

    if (!o.fresh) {
      const warm = getSnapshot(tabId);
      if (warm && Date.now() - warm.at < 20_000 && navigated === null) {
        getSession().recordAction({ action: 'browse(warm)', tabId }, { elements: warm.index.elements });
        // ★ THE WARM PATH MUST RETURN THE SAME SHAPE AS THE COLD ONE (2026-10-01). It used to
        // omit `regions`, so a second browse inside the cache window silently withheld the page
        // model while the first one had it — the same call giving different answers depending
        // on cache state. `regions` is a pure function of the stored snapshot, so it costs
        // nothing to recompute here.
        let warmRegions = null;
        try { warmRegions = regionTree(warm.snap); } catch (e) { warmRegions = { error: String(e && e.message) }; }
        return textResult({ success: true, cached: true, tabId, ageMs: Date.now() - warm.at, handle: 'snap:' + tabId + ':' + warm.seq, seq: warm.seq, index: warm.index, regions: warmRegions && warmRegions.outline, hint: 'regions = the containers THIS page named, nested. find{query} to locate a control with its branch, page_slice to load one branch. tabId = the tab this page is bound to.' });
      }
    }

    // Seed the page-held diag baseline FIRST, so the very next op is already diffable.
    let baseline = null;
    try { baseline = await runAutoDiff(tabId); } catch (e) { baseline = { error: String(e && e.message) }; }

    const res = await getActiveHub().send({ type: 'main_world_exec', tabId, func: COLLECTOR, args: [] });
    const snap = (res && res.result)
      || (res && Array.isArray(res.results) && res.results[0] && res.results[0].result)
      || (res && res.data && res.data.result)
      || (res && res.data && Array.isArray(res.data.results) && res.data.results[0] && res.data.results[0].result);
    if (!snap || !Array.isArray(snap.elements)) {
      return textResult({ success: false, error: 'browse could not collect the inventory', got: JSON.stringify(res).slice(0, 300) });
    }
    const { seq, index } = putSnapshot(tabId, snap);
    getSession().recordAction({ action: 'browse', tabId }, { elements: index.elements });
    // ★ THE PAGE AS THE PAGE NAMES IT (2026-10-01): the containers THIS page labelled, nested,
    // with no counts. Ali: "center feed is 1 element for me ... if there is 1 central feed why
    // does it need to show 1617?" — it should not. The counts were bookkeeping for picking
    // which named things are regions; display is the names and the nesting only.
    // Computed entirely server-side from the inventory we already hold (parent pointers +
    // verbatim attributes), so it costs no extra page collection and no extra round trip.
    let regions = null;
    try { regions = regionTree(snap); } catch (e) { regions = { error: String(e && e.message) }; }
    return textResult({
      success: true, cached: false, navigated: navigated, handle: 'snap:' + tabId + ':' + seq, seq,
      // ★ tabId IS PART OF THE ANSWER (2026-10-01). It was missing, so a caller that wanted to
      // address this tab explicitly — which is what any session sharing a Chrome with other
      // workers must do, and what the factory does — had nothing to pass and could only rely on
      // session binding. Found by attempting a cross-tab isolation test: browse answered with an
      // opaque `handle` and no tabId, so the test could not even name the two tabs it had opened.
      tabId,
      baseline: baseline && baseline.first ? 'seeded — the NEXT op on this page is diffable' : (baseline && baseline.note) || 'seeded',
      index,
      regions: regions && regions.outline,
      hint: 'regions = the containers THIS page named, nested. find{query} to locate a control with its branch, or page_slice{...} to load one branch. Mutating ops now return a grouped DIFF automatically. tabId = the tab this page is bound to — pass it explicitly on later ops if this Chrome is shared.',
    });
  });

  // ═══ TOOL 2 — find (Ali 2026-10-01) ═══
  // "be able to search in the page elements so ... when a search hits it shows you where
  //  and what that does from context (positioning, branch it belongs to)"
  //
  // Returns WHERE (region, position, and the BRANCH — the ancestor chain, which is data,
  // not a rendered diagram) and WHAT (the page's own role/name/attrs, plus state).
  // The branch is resolved from the parent pointers in the inventory (branchChain, in
  // snapshot.js) — so no mermaid graph is needed and nothing is re-fetched.
  reg(server, 'find', {
    description: 'TOOL 2. Search the stored page inventory and get WHERE and WHAT the hit is: its own role/name/attributes/state, its viewport position, the REGION the page labelled, and the BRANCH it sits in (the ancestor chain, resolved from parent pointers — no diagram, nothing re-fetched). This is the cheap way to locate a control: browse first, find by text/role/attribute, then act on the slice. Returns ALL matches (no cap).',
    inputSchema: {
      query: z.string().optional().describe('Substring match over name / locator / tag / region / attribute names. Prefer a word you can SEE on the page.'),
      role: z.string().optional().describe('The page\'s own role attribute value, e.g. button'),
      attr: z.union([z.string(), z.object({ name: z.string(), value: z.string().optional() })]).optional().describe('Match any attribute the page wrote'),
      tag: z.string().optional().describe('Element tag'),
      region: z.string().optional().describe('Region substring (region is derived from the nearest ancestor the PAGE labelled)'),
      interactive: z.boolean().optional().describe('true = only controls (derived: focusable || field || role present)'),
      // ★ DECLARED 2026-10-01. These two were accepted-looking but ABSENT: not in the schema
      // and not in the handler's filter list, so find{field:true} returned every element on
      // the page (103 of 103 on the workbench, html and style included) while looking like a
      // filtered answer. Both layers fixed, and a test now pins the schema against the list.
      field: z.boolean().optional().describe('true = only form controls (platform-reported: the element is an input/select/textarea/etc.)'),
      focusable: z.boolean().optional().describe('true = only focusable elements (el.tabIndex >= 0 — the browser own computation)'),
      vp: z.boolean().optional().describe('true = in viewport only'),
      branchDepth: z.number().optional().describe('How many ancestors to include in the branch chain (default 5)'),
      indices: z.array(z.number()).optional().describe('Fetch exact records by inventory index — this is how you pull the detail for indices a DIFF block named.'),
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      limit: z.number().optional().describe('OPT-IN cap on hits. Omit for ALL matches.'),
    },
  }, async (o) => {
    const tabId = o.tabId || sessionTabOf();
    // ★ SELF-HEALING READ: never "no live snapshot" on a tab that is sitting right there.
    const ens = await ensureSnapshot(tabId, 'find');
    if (!ens.entry) return textResult({ success: false, error: ens.error || ('could not map tab ' + tabId) });
    const e = ens.entry;
    const filter = {};
    // ★ `field` and `focusable` WERE MISSING HERE (found 2026-10-01 by running find{field:true}
    // on the workbench: it returned 103 of 103 elements — html, style, head — because the
    // filter was never copied through, and sliceSnapshot only filters on keys it is given.
    // A filter the tool ACCEPTS in its schema but never applies is worse than no filter: it
    // answers confidently and wrongly. The test pins this list against the schema.
    for (const k of ['query', 'role', 'attr', 'tag', 'region', 'interactive', 'vp', 'limit', 'indices', 'field', 'focusable']) {
      if (o[k] !== undefined) filter[k] = o[k];
    }
    const s = sliceSnapshot(e.snap, filter);
    const depth = o.branchDepth === undefined ? 5 : o.branchDepth;
    const hits = s.elements.map((r) => {
      const role = (r.attrs && r.attrs.role) || '';
      const out = {
        i: r.i, tag: r.tag, loc: r.loc, region: r.region,
        role: role || undefined,
        name: r.name || undefined,
        state: {
          focusable: r.focusable ? 1 : 0, field: r.field ? 1 : 0,
          disabled: r.dis ? 1 : 0, checked: r.chk ? 1 : 0, inViewport: r.vp ? 1 : 0,
        },
        pos: (r.x == null) ? undefined : { x: r.x, y: r.y },
        // ★ THE BOX IS PART OF THE ANSWER (2026-10-02, Ali: "all elements are indexed...
        // right there waiting for an action — if they are active"). The collector has
        // ALWAYS recorded w/h (snapshot.js rec.w/rec.h); find just didn't emit them, so
        // from the index alone you could not tell a live control from duckduckgo's
        // 0-width submit button or Wikipedia's display:none checkbox — you only found
        // out after a click missed. pos stays (x,y) for eyeballing; box is the full rect.
        box: (r.w == null) ? undefined : { x: r.x, y: r.y, w: r.w, h: r.h },
        attrs: r.attrs,
        branch: branchChain(e.snap, r, depth),
      };
      return out;
    });
    getSession().recordAction({ action: 'find', tabId, query: o.query }, { matched: s.matched });
    return textResult({
      success: true, url: e.snap.url, snapshotSeq: e.seq, ageMs: Date.now() - e.at,
      matched: s.matched, returned: hits.length, truncatedByLimit: s.truncatedByLimit,
      hits,
    });
  });

  reg(server, 'real_activate_tab', {
    description: 'OS-INPUT ONLY (before real_click/real_paste) — page ops NEVER need this. REAL OS click on a Chrome tab pill via UIA (pywinauto): makes the tab the OS-active one and gates on the window title. address the tab EITHER by match (title substring) OR by index (0-based position) — and on an SPA you MUST use index: x.com reports EVERY /compose/post tab as "Home / X" through UIA, so a title match is ambiguous there (the tool now refuses with the tab list instead of activating the wrong one). WHEN YOU NEED IT: only before OS-LEVEL INPUT (real_click / real_paste), because SendInput lands on whatever window is frontmost. You do NOT need it for page ops — navigate, explore_page, read, click(ref), type_text, inspect, form and main_world all travel over tabs.sendMessage by tabId and work on a backgrounded tab (measured 2026-09-20: bound an active:false tab, no activation, explore_page returned 29 live matches). CHEAPER ALTERNATIVE, no OS input at all: tabs{action:"bind", tabId, activate:true} makes a tab OS-active by tabId and needs no title — prefer it unless you specifically need this. It CANNOT fix a minimised Chrome window either — a UIA click needs the window on screen; restore that with tabs{action:"focus"} instead. Do not reach for it as a liveness remedy for a hang: diagnose a minimised/occluded window or a parked native dialog first. Requires the user\'s foreground — never use it for routine page work.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      match: z.string().optional().describe('Tab title substring to match (omit when using index)'),
      index: z.number().optional().describe('Activate the Nth open tab, 0-based — REQUIRED when several tabs share a title (SPAs do: on x.com every /compose/post tab reads "Home / X"). Pair with tabs{action:"list"}, which enumerates tabs in the same order.'),
      gate: z.string().optional().describe('Expected window title after activation (default: match)'),
    },
  }, async (o) => textResult(await withEffect(() => runRealInput(`activate-tab${(o.index !== undefined && o.index !== null) ? ` --index ${Math.round(Number(o.index))}` : ` --match "${(o.match||'').replace(/"/g,'\\"')}"`}${o.gate ? ` --gate "${o.gate.replace(/"/g,'\\"')}"` : ''}`))));

  reg(server, 'real_click', {
    description: 'GENUINE OS-level click (SendInput) at VIEWPORT coords (x,y) — bypasses synthetic-click-ignoring submit buttons (React/Lit/CustomElement). Title-gated: gate must match the active Chrome tab title or the click is refused (multi-agent churn protection). Get coords from inspect{kind:"geometry"}. origin: override doc-origin Y if the auto-measure fails (default measured via UIA).',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
      x: z.number().describe('Viewport X (from inspect geometry: vp.x + vp.w/2)'),
      y: z.number().describe('Viewport Y (from inspect geometry: vp.y + vp.h/2)'),
      gate: z.string().describe('Expected active-tab title substring (gate)'),
      origin: z.number().optional().describe('Override page Document origin Y (default: auto-measured ~121)'),
    },
  }, async (o) => textResult(await withEffect(() => runRealInput(`click-xy --x ${Math.round(o.x)} --y ${Math.round(o.y)} --gate "${(o.gate||'').replace(/"/g,'\\"')}"${o.origin ? ` --origin ${Math.round(o.origin)}` : ''}`))));

  reg(server, 'real_paste', {
    description: 'GENUINE paste into a focused editor (click at VIEWPORT coords + system clipboard + real Ctrl+V) — for Lexical/Draft.js/ProseMirror editors that revert synthetic paste events. text: content to paste; x,y: viewport coords of the editor (inspect geometry center); gate: expected active-tab title substring. Verify after with evaluate extract:"html".',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),
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
        // ★ THE WATCHDOG GOES IN THE REPLY, because /health is exactly what lies about a
        // wedge (2026-10-02). `mcpOk:false` with the probe's reason is the honest signal;
        // `status:'ok'` here means "this listener answered", NOT "the MCP endpoint works".
        const wd = (typeof globalThis.__websenseWatchdog === 'function') ? globalThis.__websenseWatchdog() : null;
        res.end(JSON.stringify({
          status: 'ok',
          hubConnected: hubChrome.connected,
          extensionConnected: hubChrome.connected,
          // null = not probed yet (first probe is ~10s after boot). false = WEDGED.
          mcpOk: wd ? wd.ok : null,
          mcpProbe: wd,
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

  // ═══ SELF-HANDSHAKE WATCHDOG (2026-10-02) ═══
  // ★ THE FAILURE IT EXISTS TO CATCH. On 2026-10-02 the server (PID 16916) answered
  // GET /health with status:ok while POST /mcp initialize returned ZERO BYTES FOREVER.
  // It was listening on both ports and looked perfectly healthy to every cheap probe,
  // so nothing restarted it. The only honest test of an MCP endpoint is an MCP-shaped
  // round trip; /health cannot see this failure because it is answered by the very
  // listener that is wedged.
  //
  // WHAT IT DOES NOT DO: it does not restart the process itself. A wedged node cannot
  // reliably respawn itself, and a self-restart that fails leaves nothing running at all.
  // Instead it detects the wedge EARLY and says so in the log and over /health, and it
  // tells the operator the exact command — because whoever supervises it (a task
  // scheduler, systemd, launchd, the Windows scheduled task) is what can actually
  // replace the process.
  if (typeof WEBSENSE_WATCHDOG !== 'undefined' && WEBSENSE_WATCHDOG !== '0') {
    const PROBE_EVERY = 5 * 60 * 1000;
    const PROBE_TIMEOUT = 8000;
    let lastProbe = null;
    const probe = async () => {
      // A no-op POST with a deliberately incomplete body: a healthy Streamable HTTP
      // handler rejects it fast (400 "Server not initialized"); a WEDGED one never
      // answers, and that difference is the signal. No session is created.
      const started = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT);
      try {
        const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
          signal: ac.signal,
        });
        // Drain so the socket is released; any status means the handler is alive.
        try { await r.text(); } catch (_) {}
        lastProbe = { ok: true, status: r.status, ms: Date.now() - started, at: Date.now() };
        console.error(`[websense] watchdog: MCP endpoint alive (HTTP ${r.status}, ${lastProbe.ms}ms)`);
      } catch (e) {
        const why = (e && e.name) === 'AbortError' ? 'TIMEOUT — no response' : String((e && e.message) || e);
        lastProbe = { ok: false, error: why, ms: Date.now() - started, at: Date.now() };
        console.error('[websense] ★ WATCHDOG: /mcp did not answer a real initialize within '
          + PROBE_TIMEOUT + 'ms (' + why + ') — the endpoint is WEDGED even though /health may still say ok.');
        console.error('[websense] ★ FIX (the supervisor must run it; this process cannot safely replace itself):');
        console.error('[websense] ★   taskkill /PID <this pid> /F   &&   node src/server.js --http --http-port ' + HTTP_PORT);
      } finally { clearTimeout(timer); }
    };
    // Give the listener a moment to come up before the first probe.
    setTimeout(() => { probe(); setInterval(probe, PROBE_EVERY); }, 10000);
    globalThis.__websenseWatchdog = () => lastProbe;
  }
}

main().catch((err) => { console.error('[websense] Fatal:', err.message); process.exit(1); });

// Global crash prevention — never let unhandled rejections kill the server
process.on('unhandledRejection', (reason) => {
  console.error('[websense] Unhandled rejection (suppressed):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[websense] Uncaught exception (suppressed):', err.message);
});

