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
import * as z from 'zod';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
const session = new SessionManager();

function getActiveHub() {
  // Per-session stamped wrapper: send() routes page ops to THIS session's
  // bound tab via the hub's tabId-aware activeClient(). `connected` is
  // forwarded for health checks; `stats()` exposes hub internals for
  // websense_doctor (the old doctor read hub.port/hub.clients off this thin
  // wrapper and always TypeError'd).
  return {
    connected: hubChrome.connected,
    send: (cmd) => hubChrome.send(withSessionTab(cmd)),
    stats: () => hubChrome.stats(),
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
  const b = result.beforeState, a = result.afterState;
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

// Wrap any tool handler so errors return a result instead of crashing the server
function safeHandler(fn) {
  return async (args) => {
    try { return await fn(args); }
    catch (err) { return textResult({ success: false, error: err.message }); }
  };
}
// ═══ PER-SESSION TAB BINDING (project directive 2026-08-12 — concurrency fix) ═══
// The hub is SHARED across all MCP sessions, and the extension's boundTabId /
// selectedTabId are GLOBAL — so session A's bind/navigate overwrote session
// B's routing target (workers hijacked the collector's login tab). Fix:
// each session's binding is stored per sessionId, and the HTTP request
// handler runs the request inside an AsyncLocalStorage context carrying that
// binding. getActiveHub().send stamps the session's tabId onto every hub
// command so the hub routes to THAT session's tab — never the global one.
import { AsyncLocalStorage } from 'node:async_hooks';
const sessionCtx = new AsyncLocalStorage();
function sessionTabOf() {
  const st = sessionCtx.getStore();
  return st && st.boundTabId != null ? st.boundTabId : null;
}
// Stamp the session's bound tab onto a hub command (page ops only — tab ops
// like navigate/switch_tab carry their own explicit tabId).
function withSessionTab(cmd) {
  const tid = sessionTabOf();
  if (tid != null && cmd && cmd.type && !cmd.tabId) {
    // Page ops (click/type/explore/evaluate/extract/page_state/...) route by
    // tabId in the hub's activeClient(). Tab ops keep their own semantics.
    const TAB_OPS = new Set(['list_tabs','switch_tab','close_tab',
      'list_frames','download_state','tab_contents','bind_tab','transfer_text',
      'switch_tab_and_read','list_windows','focus_window','move_tab_to_window',
      'ax_state','ax_read','ax_click','ax_type',
      'get_window_tabs','get_tab_info','get_active_tab','cookie_op','download_op','respawn_offscreen']);
    // NOTE: 'navigate' was REMOVED from TAB_OPS (2026-08-13, project directive —
    // session isolation). Each session's navigate is stamped with ITS OWN
    // bound tabId so a worker's navigate never steals another session's tab.
    // Sessions with no binding fall back to the SW's global tab via the
    // offscreen relay (message.tabId absent → boundTabId).
    if (!TAB_OPS.has(cmd.type)) cmd.tabId = tid;
  }
  return cmd;
}
// Wrap hub.send so every command is stamped with the calling session's tab.
function stampedHubSend(cmd) {
  return hubChrome.send(withSessionTab(cmd));
}
// ═══ SCHEMA MINIFIER (project directive 2026-08-18) ═══
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
function reg(server, name, def, handler) {
  const inputSchema = def.inputSchema || {};
  const merged = NO_FRAME.has(name)
    ? inputSchema
    : { ...inputSchema, frameId: z.number().optional().describe(FRAME_DESC) };
  server['registerTool'](name, { ...def, inputSchema: merged }, safeHandler(handler));
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
  function realClickAt(x, y) {
    if (process.platform !== 'win32') {
      throw new Error('autoClimb real-click is Windows-only (uses user32 mouse_event via PowerShell). On ' + process.platform + ', deliver the OS click with your platform\'s native automation and retry.');
    }
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      'Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;' +
      'public class WS_MOUSE{[DllImport(\\"user32.dll\\")]public static extern bool SetCursorPos(int X,int Y);' +
      '[DllImport(\\"user32.dll\\")]public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,System.UIntPtr dwExtraInfo);}' +
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


// ═══ CONSOLIDATED TOOL SURFACE (2026-08-30, project directive: 65 → 20) ═══
// Every one of the 65 original capabilities is preserved. Each consolidated
// tool maps params onto the SAME hub command types the content script already
// implements — zero extension-side changes. Old one-tool-per-verb names are
// gone; the mapping lives in websense_guide + README.

function registerAllTools(server) {

  // ═══ 1. GUIDE ═══
  reg(server, 'websense_guide', {
    description: 'START HERE. Full usage guide for the 21 consolidated WebSense tools: explore, read, click, type, form, scroll, tabs, wait, evaluate, ax, status. Call once before using other tools.',
  }, async () => {
    return textResult(`WebSense MCP — Guide (21 consolidated tools)
==============================================
Non-vision web automation via Chrome extension. No CDP, no bot detection. CSP-safe. React/Vue/Angular compatible.

THE LOOP: explore_page → pick refs → act (click/type_text/form/scroll) → read result → repeat.

THE 20 TOOLS — what each absorbed from the old 65-tool surface:
  websense_guide   this guide
  explore_page     page map (SAG). compact:true = old discover_actions; intent:"submit" = old find_intent; goal:"log in" = old explore_intent; preload:true = lazy-load first; incremental:true = delta since last scan (added/changed/removed, no settle/content — cheap post-action diff; first call returns full SAG)
  read             page text. format: "text" (extract_text) | "content" (read_content) | "markdown" (dump_markdown) | "diff" (page_diff) | "scrollextract" (scroll_and_extract) | "preload" (preload_content)
  click            click ref (default) | mode:"hover" | mode:"rightclick" | mode:"drag" (fromRef/toRef) | x,y for canvas (old click_xy)
  type_text        fill one input (React-safe native setter) — or fields:[{ref,text},...] for batch (old type_many)
  form             action:"state" (form_state) | "select" (ref,value) | "toggle" | "upload" (ref,filePath)
  reveal           pre-extract hidden content: kind:"dropdown" | "tabs" | "accordion"
  scroll           direction+amount (ticks, 1 tick ≈ 80% viewport) | y:<px> absolute (scroll_to) | intoView:"E5" (scroll_into_view)
  tabs             action:"list" | "switch" | "close" | "bind" (no focus) | "windows" | "focus" | "move" | "transfer" (cross-tab copy/paste) | "switchread"
  status           kind:"page" (page_state) | "bridge" (get_status) | "doctor" (diagnostics) | "downloads"
  wait             poll until conditions met (urlContains/hasModal/hasCaptcha/notLoading/pendingDialogsGt/selector/script/timeoutMs/pollMs) — old wait_for; or event:"dialog_open|navigation|network|..." — old wait_for_event
  evaluate         script:<js> (eval, CSP-blocked on strict sites) — or query:{selector,extract,all,inputs,text,state} for CSP-proof no-eval reads (old evaluate_safe)
  ax               native accessibility tree via chrome.debugger: action:"state"|"read"|"click"|"type" + tabId (+ match/role/name). For canvas SPAs & chrome:// pages
  screenshot       captureVisibleTab → PNG/JPEG dataUrl for a vision model
  press_key        key + modifiers ["ctrl","shift","alt","meta"], optional ref target
  dialog           JS dialogs: action:"accept"|"dismiss" + index/value (old handle_dialog) — or keystroke:true + key:"enter|escape|tab|f5|ctrl+c" + value typed first (old dismiss_dialog, OS-level)
  session          action:"reset" (clears map + tab binding) | "map" (exploration graph) | "mermaid" (flowchart export)
  network_log      captured fetch/XHR since last call (clear, maxEntries)
  clipboard        action:"copy" (text) | "read"
  inspect          resolve a ref / one element: kind:"element" (resolve_ref — is this ref alive?) | "geometry" (bounding box, z-depth, scroll-container-aware) | "relation" (refA vs refB: above/below/overlaps)

KEY PATTERNS:
- Forms: form{action:"state", formRef:"F0"} → type_text/select via form{action:"select"} → click submit ref
- After every action: read the before/after + effect verdict (confirmed / suspected_noop / unverifiable). On suspected_noop do NOT retry blind — escalate (OS-level click via windows-control) or try an alternate path
- Iframes: status{kind:"frames"}? No — list_frames lives under tabs{action:"frames"}; pass frameId to any element tool
- Waits: wait{urlContains:"/dashboard"} beats manual poll loops; wait{event:"dialog_open"} after clicks that pop dialogs
- Anti-patterns: no screenshots/vision/CDP for routine work (bot detection); no evaluate for routine reads (CSP); don't guess labels — read them from explore_page

TAB DISCIPLINE: reuse tabs (navigate reuses by default). NEVER close the last open tab/window of an app.
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
      maxActions: z.number().optional().describe('Cap for compact mode (default 250)'),
      incremental: z.boolean().optional().describe('Return only added/changed/removed since the last scan (cheap — no settle, no content). First call or >60% churn auto-falls back to full. Ideal after click/type to see what the action did.'),
    },
  }, async (o) => {
    if (o.intent) return textResult(await getActiveHub().send({ type: 'find_intent', intent: o.intent, frameId: o.frameId }));
    if (o.goal) return textResult(await getActiveHub().send({ type: 'explore_intent', goal: o.goal, frameId: o.frameId }));
    if (o.compact) return textResult(await getActiveHub().send({ type: 'discover_actions', maxActions: o.maxActions === undefined ? 250 : o.maxActions, frameId: o.frameId }));
    if (o.preload) {
      await getActiveHub().send({ type: 'preload_content', maxSteps: 8, settleMs: 250, restore: true });
    }
    const sag = await getActiveHub().send({ type: 'explore_page', full: o.full || false, includeContent: o.includeContent !== false, includeHidden: o.includeHidden || false, incremental: o.incremental || false, frameId: o.frameId });
    if (!sag || sag.success === false) return textResult(sag || { success: false, error: 'No response from content script' });
    if (sag.meta && sag.meta.url) session.recordPage(sag.meta.url, sag);
    // Incremental results are partial deltas — only full SAGs (including the
    // auto-fallback from incremental:true, which sets escalated/returns a
    // complete map) become the session's canonical lastSnapshot.
    if (!sag.incremental || sag.escalated) session.setLastSnapshot(sag);
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
    const beforeUrl = session.currentUrl;
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
      if (result.effect !== 'confirmed') {
        result.escalation = { recommended: 'real_click', reason: 'synthetic click produced no state change — React onClick handlers often ignore dispatched events; re-issue via a genuine OS-level click (windows-control/cua-driver foreground) or try explore_page{intent} for an alternate path' };
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
              result.autoClimb = { attempted: false, reason: 'target tab not OS-active (active=' + activeId + ' bound=' + bound + ') — activate it first or auto-climb would click the wrong window' };
            }
          } else {
            result.autoClimb = { attempted: false, reason: 'no session-bound tab — bind/switch to a tab first' };
          }
        } catch (climbErr) {
          result.autoClimb = { attempted: false, reason: 'auto-climb error: ' + ((climbErr && climbErr.message) || climbErr) };
        }
      }
    }
    session.recordAction({ action: 'click', ref: o.ref, mode }, result);
    if (result.afterState && result.beforeState && result.afterState.url !== result.beforeState.url) {
      session.recordNavigation(beforeUrl, result.afterState.url, o.ref, '', mode);
      session.recordPage(result.afterState.url, null);
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
      session.recordAction({ action: 'type_many', refs: o.fields.map(f => f.ref) }, result);
      return textResult(result);
    }
    result = await getActiveHub().send({ type: 'type_text', ref: o.ref, text: o.text, clearFirst: o.clearFirst !== false, frameId: o.frameId });
    const persisted = result && (result.valueSet === true || result.verified === true || result.success === true);
    result.effect = (result && result.success === false) ? 'failed' : persisted ? 'confirmed' : 'unverifiable';
    if (result.effect !== 'confirmed') {
      result.escalation = { recommended: 're_read', reason: 'value persistence not confirmed — re-explore the field and re-type with clearFirst:true before escalating to OS-level input' };
    }
    session.recordAction({ action: 'type_text', ref: o.ref, text: o.text }, result);
    return textResult(result);
  });

  // ═══ 6. FORM ═══
  reg(server, 'form', {
    description: 'Form ops: action:"state" (fields, validation, submit readiness; formRef optional = all) | "select" (ref,value — native <select> AND ARIA dropdowns) | "toggle" (checkbox/switch/aria-pressed) | "upload" (ref, filePath — DataTransfer, no OS picker).',
    inputSchema: {
      action: z.enum(['state', 'select', 'toggle', 'upload']).describe('Form operation'),
      formRef: z.string().optional().describe('state: form ref e.g. "F0" (omit = all forms)'),
      ref: z.string().optional().describe('Element ref for select/toggle/upload'),
      value: z.string().optional().describe('select: option value'),
      filePath: z.string().optional().describe('upload: absolute file path'),
    },
  }, async (o) => {
    if (o.action === 'state') return textResult(await getActiveHub().send({ type: 'form_state', formRef: o.formRef, frameId: o.frameId }));
    if (o.action === 'select') {
      const result = await getActiveHub().send({ type: 'select_option', ref: o.ref, value: o.value, frameId: o.frameId });
      session.recordAction({ action: 'select_option', ref: o.ref, value: o.value }, result);
      return textResult(result);
    }
    if (o.action === 'toggle') {
      const result = await getActiveHub().send({ type: 'toggle', ref: o.ref, frameId: o.frameId });
      session.recordAction({ action: 'toggle', ref: o.ref }, result);
      return textResult(result);
    }
    // upload
    try {
      const fileBuffer = readFileSync(o.filePath);
      const base64 = fileBuffer.toString('base64');
      const fileName = o.filePath.split(/[\\/]/).pop();
      const ext = fileName.split('.').pop().toLowerCase();
      const mimeTypes = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', pdf:'application/pdf', txt:'text/plain', csv:'text/csv', json:'application/json', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip:'application/zip' };
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
    description: 'Navigate the CURRENT tab to a URL (reuses the tab — no tab spam). Pass newTab:true to open in a fresh tab instead. Returns tabId (session binding follows).',
    inputSchema: { url: z.string(), newTab: z.boolean().optional().describe('Open in a new tab instead of reusing (default false)') },
  }, async ({ url, newTab }) => {
    const result = await getActiveHub().send({ type: 'navigate', url, newTab: !!newTab });
    if (server && result && result.tabId) server._wsBoundTabId = result.tabId;
    session.recordAction({ action: 'navigate', url }, result);
    return textResult(result);
  });

  // ═══ 10. TABS ═══
  reg(server, 'tabs', {
    description: 'Tab/window ops: action:"list" | "switch" (tabId) | "close" (tabId) | "bind" (tabId, activate? — route page ops without focusing) | "frames" (list iframes w/ frameId) | "windows" (all windows+tabs) | "focus" (windowId) | "move" (tabId,windowId) | "transfer" (fromTab,toTab,fromSelector,toSelector — atomic cross-tab copy/paste) | "switchread" (tabId,selector — switch+read in one).',
    inputSchema: {
      action: z.enum(['list', 'switch', 'close', 'bind', 'frames', 'windows', 'focus', 'move', 'transfer', 'switchread']).describe('Tab operation'),
      tabId: z.number().optional().describe('Target tab'),
      windowId: z.number().optional().describe('Target window (focus/move)'),
      activate: z.boolean().optional().describe('bind: also activate the tab'),
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
      case 'frames': return textResult(await getActiveHub().send({ type: 'list_frames' }));
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
          pageUrl = session.currentUrl || null;
          pageTitle = pageUrl ? (session.pages.get(pageUrl)?.title || session.currentTitle || null) : null;
        }
      }
      return textResult({
        hubConnected: getActiveHub().connected,
        pageConnected: pageUrl !== null,
        pageProbe: probe,
        currentUrl: pageUrl,
        currentTitle: pageTitle,
        sessionSteps: session.stepCounter,
        pagesExplored: session.pages.size,
        hint: probe === 'timeout-fallback' ? 'get_status probe timed out (heavy/settling page) — reporting last-known session URL; ops may still work' : (getActiveHub().connected ? null : 'Extension not connected. Load the WebSense Chrome extension (extension/manifest.json) — it auto-connects to ws://localhost:38401 within 3s. Then call websense_guide.'),
      });
    }
    if (kind === 'doctor') {
      const hub = getActiveHub();
      const hubStats = (typeof hub.stats === 'function') ? hub.stats() : { port: hub.port, connectedClients: (hub.clients && hub.clients.size) || 0 };
      const report = { timestamp: Date.now(), hub: hubStats, session: { steps: session.stepCounter, pagesExplored: session.pages.size } };
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
            const r = await getActiveHub().send({ type: 'evaluate', script: '!!document.querySelector(' + JSON.stringify(o.selector) + ')' });
            const inner = innerOf(r);
            if (isCspBlocked(inner)) {
              const r2 = await getActiveHub().send({ type: 'evaluate', script: 'querySelector(' + JSON.stringify(o.selector) + ')' });
              const inner2 = innerOf(r2);
              ok = !!(inner2.success !== false && (inner2.found === true || (inner2.result && inner2.result.found === true)));
            } else {
              ok = !!(inner.success !== false && (inner.result === true || inner.result === 'true'));
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
    description: 'Run JS on the page (extension isolated world, async-aware) — OR CSP-proof no-eval reads via query:{selector,extract:"value|text|attrs|html",all,inputs,text,state}. evaluate is eval-based: blocked on strict-CSP pages (LinkedIn, HN) — use query mode there. PRINCIPLE 5: verify what the page actually accepted.',
    inputSchema: {
      script: z.string().optional().describe('JS to execute (eval mode)'),
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
    return textResult(await getActiveHub().send({ type: 'evaluate', script: o.script }));
  });

  // ═══ 13. AX BRIDGE ═══
  reg(server, 'ax', {
    description: 'Native accessibility tree via chrome.debugger (CDP Accessibility domain) — for canvas SPAs (Telegram web, TradingView) and chrome:// pages. action:"state" (full tree) | "read" (filter by role/name/nameContains) | "click" (match) | "type" (match, text). Requires explicit tabId. Shows a debugger banner while attached.',
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
    description: 'Capture the visible tab via chrome.tabs.captureVisibleTab (chrome.tabs API — NO CDP, no bot-detection surface). Returns {dataUrl, mime} for a vision model. For pages the structured tree can\'t fully represent.',
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional().describe('Default png'),
      quality: z.number().optional().describe('JPEG quality 0-100 (default 80)'),
    },
  }, async (o) => textResult(await getActiveHub().send({ type: 'browser_screenshot', format: o.format || 'png', quality: o.quality || 80 })));

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
      session.reset();
      try { await getActiveHub().send({ type: 'clear_binding' }); } catch (_) {}
      return textResult({ success: true, message: 'Session reset. Tab binding cleared.' });
    }
    if (o.action === 'task') {
      if (o.op === 'begin') {
        if (!o.goal) return textResult({ success: false, error: 'task begin requires a goal' });
        session.beginTask(o.goal, o.steps || []);
        return textResult({ success: true, task: session.getTask() });
      }
      if (o.op === 'done') { session.completeStep(o.step); return textResult({ success: true, task: session.getTask() }); }
      if (o.op === 'skip') { session.skipStep(o.step); return textResult({ success: true, task: session.getTask() }); }
      return textResult({ success: true, task: session.getTask() }); // status
    }
    if (o.action === 'mermaid') {
      const mermaid = exportMermaid(session.getExplorationMap(), { direction: o.direction || 'TD', detail: o.detail || 'pages_actions' });
      return textResult('```mermaid\n' + mermaid + '\n```');
    }
    return textResult(session.getExplorationMap());
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

  // Slim tool schemas on the wire (project directive 2026-08-18)
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

      // Health check
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', hubConnected: getActiveHub().connected, extensionConnected: getActiveHub().connected }));
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
        const store = { boundTabId: session.server && session.server._wsBoundTabId != null ? session.server._wsBoundTabId : null };
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

