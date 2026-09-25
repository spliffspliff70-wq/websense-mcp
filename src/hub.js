/**
 * WebSense MCP — WebSocket Hub
 * Robust WebSocket server bridging MCP tools to the browser extension.
 * The extension auto-connects via WebSocket — no launcher page or browser tab needed.
 */
import { WebSocketServer } from 'ws';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 38401;
const REQUEST_TIMEOUT = 30000;       // default for most ops
const EXPLORE_TIMEOUT = 90000;       // heavy DOMs (x.com, lemonsqueezy) need more time
const HEAVY_OPS = new Set(['explore_page', 'discover_actions', 'type_many']); // type_many: ~1s/field persistence verify (max 50 fields)
const TLS_PORT = 38411;
// Human-readable WebSocket readyState (read-only diagnostics).
const READY_STATE_NAMES = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
// ms -> "1d 02h 03m 04s" (read-only diagnostics).
function formatUptime(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (d ? d + 'd ' : '') + (d || h ? pad(h) + 'h ' : '') + pad(m) + 'm ' + pad(sec) + 's';
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// cert.pem/key.pem live in the project root (parent of src/)
const ROOT_DIR = path.resolve(__dirname, '..');
const CERT = path.join(ROOT_DIR, 'cert.pem');
const KEY = path.join(ROOT_DIR, 'key.pem');

export class HubServer {
  constructor(port = DEFAULT_PORT, opts = {}) {
    this.port = port;
    this.label = opts.label || 'hub';
    this.useTls = !!opts.tls && fs.existsSync(CERT) && fs.existsSync(KEY);
    this.ws = null;
    // MULTI-SLOT PENDING (2026-08-15): id -> {resolve, reject, timer, client}.
    // The old single-slot `this.pending` allowed exactly ONE in-flight request
    // hub-wide — two concurrent MCP sessions clobbered each other's correlator
    // (first response won, the other hung until timeout), and ANY client
    // disconnect rejected whatever request happened to be pending, even when it
    // belonged to a different client. Per-id entries with client attribution
    // fix both.
    this.pending = new Map();
    this.requestId = 0;
    this.connected = false;
    // Multiple content-script clients (one per open tab). page ops route to
    // the most-recently-active client; tab ops go to the SW bridge client.
    this.clients = new Map();
    this.lastClient = null;
    this.contentClient = null;
    this.mainFrameClient = null; // prefer main-frame CS for page ops (avoids ad-iframe hijack)
    this.offscreenClient = null;
    // FLATTENED ROUTING (2026-08-09): content scripts report which tab they
    // live in (tab_identified), and the offscreen reports which tab is selected
    // (tab_selected after switch_tab/navigate). Page ops then go DIRECTLY to
    // the selected tab's content-script WS when it's alive — no offscreen +
    // SW + tabs.sendMessage round-trip. Falls back to the offscreen relay when
    // the content script WS is down (pages that block ws://, e.g. some CSPs).
    this.contentByTab = new Map(); // tabId -> main-frame content-script ws
    this.selectedTabId = null;     // last tab the bridge explicitly selected
    this.clientSeq = 0;
    this.startedAt = Date.now();   // hub uptime (read-only diagnostics)
    this.eventRing = [];    // ring buffer (P1#1, max 50 page_event entries)
    this.eventRingMax = 50;
    this.eventSeq = 0;

    if (this.useTls) {
      const tlsOpts = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };
      this.http = https.createServer(tlsOpts, (req, res) => this._handleHttp(req, res, 'TLS'));
      console.error(`[websense] ${this.label} hub: TLS (wss://) on 0.0.0.0:${this.port}`);
    } else {
      this.http = http.createServer((req, res) => this._handleHttp(req, res, 'plain'));
      console.error(`[websense] ${this.label} hub: plain (ws://) on 0.0.0.0:${this.port}`);
    }

    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  // ── Hub HTTP surface (2026-09-11) ──
  // GET /health → the client census (census()). Every other path keeps the
  // original friendly one-liner so nothing that probed this listener breaks.
  // Strictly read-only: this handler never sends on a client socket, never
  // touches a map, and cannot throw (census() is total, and this wraps it).
  _handleHttp(req, res, flavor) {
    let path = req.url || '/';
    const q = path.indexOf('?');
    if (q !== -1) path = path.slice(0, q);
    const reply = (code, body) => {
      try {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));
      } catch (_) { try { res.end(); } catch (_) {} }
    };
    if (path === '/health') {
      try { return reply(200, this.census()); }
      catch (err) { return reply(500, { status: 'census_failed', error: String((err && err.message) || err) }); }
    }
    return reply(200, {
      status: 'ok',
      message: 'WebSense MCP Hub' + (flavor ? ' (' + flavor + ')' : '') +
        '. The extension connects automatically via WebSocket. GET /health for the client census.',
    });
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.http.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Hard fail: do NOT swallow EADDRINUSE. If we resolve() here the
          // server process stays alive as a zombie holding no port while the
          // parent (Hermes/Kimi MCP client) waits forever for a stdio
          // handshake that never completes. Exiting lets the client's retry
          // bind the port cleanly instead of piling up dead nodes.
          console.error(`[websense] ${this.label} hub: Port ${this.port} in use — another WebSense server is already running. Exiting so the parent can retry.`);
          reject(err);
        } else reject(err);
      });
      this.http.listen(this.port, '0.0.0.0', () => {
        console.error(`[websense] ${this.label} hub listening on 0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  onConnection(ws) {
    const cid = 'c' + (++this.clientSeq);
    ws.cid = cid;
    ws.clientSource = null; // 'content-script' | 'offscreen' — set on 'ready'
    ws.isMainFrame = false; // set on 'ready'
    ws.clientUrl = null;
    ws.connectedAt = Date.now(); // diagnostics only (never read by routing)
    this.clients.set(cid, ws);
    this.lastClient = ws;
    this.connected = this.clients.size > 0;
    console.error('[websense] Client connected (' + cid + ') — total ' + this.clients.size);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'ready') {
        ws.clientSource = msg.source || 'unknown';
        ws.isMainFrame = !!msg.isMainFrame;
        ws.clientUrl = msg.url || null;
        console.error('[websense] Client ready (' + cid + '): ' + (msg.url || msg.source || '') + ' [' + ws.clientSource + (ws.isMainFrame ? ' MAIN' : 'subframe') + ']');
        this.lastClient = ws; // most-recently-active page becomes the routing target
        if (ws.clientSource === 'content-script') {
          this.contentClient = ws;
          // Track the main-frame content client separately — page ops prefer it
          if (ws.isMainFrame) this.mainFrameClient = ws;
        }
        else if (ws.clientSource === 'offscreen') this.offscreenClient = ws;
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'tab_identified') {
        // Content script tells us which tab it lives in. Track main-frame
        // scripts per tab so page ops can route directly.
        console.error('[websense] tab_identified: tabId=' + (msg.tabId ?? 'null') + ' main=' + (msg.isMainFrame ?? '?') + ' src=' + (ws.clientSource || '?'));
        if (msg.tabId && msg.isMainFrame) {
          // STALE-CLIENT EVICTION (2026-08-13): after an extension reload, the
          // OLD content script's raw ws:// socket survives (its isolated world
          // keeps running in already-loaded tabs) while the NEW script injects
          // on the next navigation. Both register the same tabId — the hub was
          // routing page ops to the STALE script (old code → "Element not
          // found" on selector refs). Newest registration wins: evict the old
          // client for this tab so the fresh code is always the routing target.
          const prev = this.contentByTab.get(Number(msg.tabId));
          if (prev && prev !== ws && prev.readyState === 1) {
            console.error('[websense] evicting stale content client ' + prev.cid + ' for tab ' + msg.tabId + ' (new ' + ws.cid + ')');
            try { prev.close(4000, 'superseded by fresh content script'); } catch (_) {}
            // 2026-09-25: the old code NULLed contentClient/mainFrameClient when
            // the evicted socket held those roles, leaving them empty — page ops
            // then fell through to the offscreen, which has no ref engine, and
            // explore_page returned zero actions. Point them at the NEW client
            // instead: it is the one that owns the tab now.
            if (this.contentClient === prev) this.contentClient = ws;
            if (this.mainFrameClient === prev) this.mainFrameClient = ws;
          }
          this.contentByTab.set(Number(msg.tabId), ws);
          ws.tabId = Number(msg.tabId);
          console.error('[websense] contentByTab[' + msg.tabId + '] = ' + ws.cid + ' (total ' + this.contentByTab.size + ')');
        }
        return;
      }
      if (msg.type === 'tab_selected') {
        // Offscreen tells us which tab the bridge explicitly switched to.
        if (msg.tabId) this.selectedTabId = Number(msg.tabId);
        console.error('[websense] selected tab -> ' + this.selectedTabId);
        return;
      }
      if (msg.type === 'clear_binding') {
        // Phase 1 (2026-08-15): reset_session → clear_binding. Drops the hub's
        // selectedTabId so the next page op re-resolves the active tab from
        // scratch (kills the PITFALL-16 stale-tab latch deterministically).
        this.selectedTabId = null;
        console.error('[websense] clear_binding — selectedTabId reset');
        return;
      }
      if (msg.type === 'tab_event') {
        // Phase 2 (2026-08-15): SW forwards chrome.tabs.onActivated/onRemoved
        // so the hub keeps its tab registry live. On close/remove, drop the
        // dead content-script client so page ops can't route into a dead tab.
        if (msg.event === 'removed' && msg.tabId != null) {
          const dead = this.contentByTab.get(Number(msg.tabId));
          if (dead) { try { dead.close(4001, 'tab closed'); } catch (_) {} this.contentByTab.delete(Number(msg.tabId)); }
          if (this.selectedTabId === Number(msg.tabId)) this.selectedTabId = null;
          console.error('[websense] tab_event removed: tab ' + msg.tabId + ' dropped from registry');
        }
        // P0#1 FIX (2026-08-31, wrong-tab wedge A2): on ACTIVATED, follow the
        // OS truth — the newly-frontmost tab becomes selectedTabId. Previously
        // this event was IGNORED, so selectedTabId went stale on every tab
        // switch and UNBOUND page ops (no explicit cmd.tabId) read the WRONG
        // tab forever — the 2026-08-24 read-routing wedge root cause.
        // Multi-agent note: session-bound ops (explicit cmd.tabId) are
        // unaffected — this only fixes the unbound fallback path, the one
        // that latches stale.
        if (msg.event === 'activated' && msg.tabId != null) {
          const t = Number(msg.tabId);
          if (this.selectedTabId !== t) {
            this.selectedTabId = t;
            console.error('[websense] tab_event activated: selectedTabId -> ' + t);
          }
        }
        return;
      }
      if (msg.type === 'page_event') {
        // P1#1 (2026-08-31): content-script event push (dialog_open,
        // navigation/hashchange/popstate). Keep a small ring buffer the
        // server's wait{event:…} can drain INSTANTLY instead of polling
        // page_state after every action. tabId null = whichever tab sent it;
        // the server matches against its session-bound tab via the event's
        // origin when available.
        const ev = {
          event: msg.event || 'unknown',
          data: msg.data || {},
          ts: msg.ts || Date.now(),
          seq: ++this.eventSeq,
          tabId: msg.tabId != null ? Number(msg.tabId) : (ws.tabId != null ? ws.tabId : null),
        };
        this.eventRing.push(ev);
        if (this.eventRing.length > this.eventRingMax) this.eventRing.splice(0, this.eventRing.length - this.eventRingMax);
        return;
      }
      if (msg.type === 'tab_activated') {
        // P0#2 (2026-08-31, cold-tab wedge A1): content script self-reports on
        // activation. chrome.tabs.onActivated fires in the SW, which forwards
        // here; ALSO the CS itself sends this when it (re)connects or its tab
        // gains focus — covers the case where the SW was cold/missed the event.
        // The tab's content script is by definition injected and alive when we
        // receive this, so it's the freshest possible liveness signal.
        if (ws.clientSource === 'content-script' && ws.tabId != null) {
          this.selectedTabId = ws.tabId;
          console.error('[websense] tab_activated (CS): selectedTabId -> ' + ws.tabId);
        } else if (msg.tabId != null) {
          this.selectedTabId = Number(msg.tabId);
          console.error('[websense] tab_activated: selectedTabId -> ' + this.selectedTabId);
        }
        return;
      }
      // Any message from a client marks it as the active routing target.
      this.lastClient = ws;
      if (ws.clientSource === 'content-script') {
        this.contentClient = ws;
        if (ws.isMainFrame) this.mainFrameClient = ws;
      }
      else if (ws.clientSource === 'offscreen') this.offscreenClient = ws;
      if (msg.id && this.pending.has(msg.id)) {
        this._settlePending(msg.id, null, msg);
      }
    });

    ws.on('close', () => {
      this.clients.delete(cid);
      if (this.lastClient === ws) this.lastClient = this.clients.size ? this.clients.values().next().value : null;
      if (this.contentClient === ws) this.contentClient = null;
      if (this.mainFrameClient === ws) this.mainFrameClient = null;
      if (this.offscreenClient === ws) this.offscreenClient = null;
      // 2026-09-25: this used to delete the tab's registration UNCONDITIONALLY.
      // When a superseded/stale content script finally disconnected it wiped the
      // NEW client's entry for that same tab, and page ops then fell through to
      // the offscreen (no ref engine, no dialog reader) — measured as
      // page_state reporting empty dialogs and explore_page returning zero
      // actions while the correct client was connected and healthy. Only remove
      // the mapping if it still points at THIS socket.
      if (ws.tabId) {
        const mapped = this.contentByTab.get(Number(ws.tabId));
        if (mapped === ws) this.contentByTab.delete(Number(ws.tabId));
      }
      this.connected = this.clients.size > 0;
      console.error('[websense] Client disconnected (' + cid + ') — remaining ' + this.clients.size);
      // Reject ONLY the pendings that were routed to THIS client (per-client
      // attribution). A zombie-killer retry may be in flight for this exact
      // pending — during a zombie kill the retry flow owns recovery, so leave
      // the pending alive for it to re-send.
      if (!this._killingZombie) {
        for (const [id, p] of this.pending) {
          if (p.client === ws) this._settlePending(id, new Error('Extension disconnected'));
        }
      }
    });
    ws.on('error', () => {});
  }

  // Ops that ONLY work through the offscreen → SW → tabs.sendMessage relay:
  // the content script's direct WS dispatcher cannot serve them (upload_file
  // needs SW-world DataTransfer; network_log capture hooks run on the relay
  // path). Routing them to a healthy direct content-script socket made them
  // fail exactly when the bridge was otherwise at its best.
  static get SW_REQUIRED_OPS() { return new Set(['upload_file', 'network_log', 'doctor_sw']); }

  // Route a command to the best client:
  //  - TAB ops (navigate/list_tabs/switch_tab/close_tab/list_frames/
  //    download_state/tab_contents): offscreen → SW bridge (chrome.tabs API
  //    lives in the SW). Fall back to any content script (it relays via SW).
  //  - PAGE ops (click/type/explore/evaluate/extract/...): DIRECTLY to the
  //    selected tab's main-frame content script WS when it's alive — kills the
  //    offscreen + SW + tabs.sendMessage round-trip. Fall back to the offscreen
  //    relay (which does PAGE_CONTROL → SW → tabs.sendMessage) when the target
  //    tab's content script WS is down (CSP-blocked ws://, not yet injected).
  activeClient(cmd) {
    // TABID-CRASH HARDENING (2026-09-11): callers may pass NOTHING — healthCheck()
    // does exactly that on a 30s interval, and the page-op branch below reads
    // cmd.tabId. Normalizing cmd here makes the method TOTAL: no caller, now or
    // later, can reintroduce that throw.
    //
    // EVIDENCE (what is actually verified): hub.log contains 4,981 occurrences of
    // `Uncaught exception (suppressed): Cannot read properties of undefined
    // (reading 'tabId')`, and that is the log's LAST line — so it was still firing
    // when that log was captured. 4,981 x the 30s health interval ~= 41.5 hours,
    // which matches a ping that threw on every tick and was swallowed by
    // process.on('uncaughtException').
    // NOT VERIFIED: which revision had the unguarded read. The immediately
    // preceding code already wrote `cmd && cmd.tabId`, so this revision is
    // belt-and-braces against a regression rather than the fix for a live throw.
    cmd = cmd || {};
    // P2 respawn_offscreen (2026-08-31): route through a CONTENT SCRIPT, never
    // the offscreen — the op kills the offscreen, so a request riding on the
    // offscreen's own WS dies with it ('Extension disconnected' for a
    // successful op). A content script stays alive, relays to the SW via
    // chrome.runtime, and the response returns over the CS's own WS.
    if (cmd && cmd.type === 'respawn_offscreen') {
      // Pick the first READY content script — never an offscreen (it kills its
      // own document mid-reply → false "Extension disconnected" although the
      // respawn succeeded), and never a dead-but-non-null pointer: the old code
      // checked readyState only on the FIRST candidate, so one stale
      // mainFrameClient shadowed a live contentClient and the op fell through
      // to the offscreen (observed 2026-09-25). If no CS is ready the fall-
      // through still works — the offscreen case now replies before dying.
      const cs = [this.mainFrameClient, this.contentClient, this.lastClient]
        .find((w) => w && w.readyState === 1 && w.clientSource !== 'offscreen');
      if (cs) return cs;
    }
    // extension_reload must reach a client that can actually PERFORM it. Both the
    // offscreen and the content script handle it now (2026-09-11); prefer the
    // offscreen because it calls chrome.runtime.reload() directly and never dies
    // mid-request. Before this routing existed the op fell through to the
    // "page op" branch and landed on a client with no handler for it, so the
    // reload silently never happened while the tool still reported
    // reloadSent:true — that flag only ever meant "the WS send succeeded".
    if (cmd && cmd.type === 'extension_reload') {
      const off = this.offscreenClient;
      if (off && off.readyState === 1) return off;
      const cs2 = this.mainFrameClient || this.contentClient || this.lastClient;
      if (cs2 && cs2.readyState === 1) return cs2;
    }
    const isTabOp = cmd && (cmd.type === 'navigate' || cmd.type === 'list_tabs' || cmd.type === 'switch_tab' ||
      cmd.type === 'close_tab' || cmd.type === 'list_frames' || cmd.type === 'download_state' ||
      cmd.type === 'bind_tab' || cmd.type === 'transfer_text' || cmd.type === 'switch_tab_and_read' ||
      cmd.type === 'list_windows' || cmd.type === 'focus_window' || cmd.type === 'move_tab_to_window' || cmd.type === 'ax_state' ||
      cmd.type === 'browser_screenshot' || cmd.type === 'get_active_tab' || cmd.type === 'cookie_op' || cmd.type === 'download_op' || cmd.type === 'respawn_offscreen' || cmd.type === 'main_world_exec');
    if (isTabOp || HubServer.SW_REQUIRED_OPS.has(cmd && cmd.type)) {
      const primary = this.offscreenClient || this.contentClient || this.mainFrameClient;
      if (primary && primary.readyState === 1) return primary;
    } else {
      // Page op — route to the tab this command TARGETS. The server stamps
      // each session's bound tabId onto page ops (concurrency fix 2026-08-12)
      // so session A's click never hits session B's tab. Fall back to the
      // legacy global selectedTabId when no explicit tabId is present.
      const targetTab = (cmd && cmd.tabId != null) ? Number(cmd.tabId) : this.selectedTabId;
      if (targetTab != null) {
        const direct = this.contentByTab.get(targetTab);
        if (direct && direct !== this._lastDirectDead && direct.readyState === 1) {
          return direct;
        }
      }
      // Fallback: offscreen relay (correct tab via currentTabId), then any
      // content script, then any client.
      const relay = this.offscreenClient || this.mainFrameClient || this.contentClient || this.lastClient;
      if (relay && relay.readyState === 1) return relay;
    }
    // fallbacks — any connected client
    for (const c of this.clients.values()) {
      if (c.readyState === 1) return c;
    }
    return null;
  }

  // ═══ Timeout diagnostics (2026-09-11) ═══
  // THE reason WebSense feels unreliable to work with: a bare
  // "Request timeout (30s) for page_state" is indistinguishable from a dead
  // relay, a backgrounded tab, a minimized window, a CSP block, a restricted
  // page, or a genuinely slow page — so the only rational response is to retry
  // or guess at a fallback. That guessing is the real cost. This names the hop
  // the request was routed through and the state of every other layer, so the
  // failure can be attributed instead of guessed at.
  _timeoutDiag(cmd, client, timeout) {
    cmd = cmd || {}; // TABID-CRASH HARDENING: same no-arg hazard as activeClient()
    const type = (cmd && cmd.type) || '?';
    const targetTab = (cmd && cmd.tabId != null) ? Number(cmd.tabId) : this.selectedTabId;
    const src = (client && client.clientSource) || 'unknown';
    const cid = (client && client.cid) || '?';
    const lines = [
      'Request timeout (' + (timeout / 1000) + 's) for ' + type,
      '  routed to   : ' + cid + ' [' + src + '] readyState=' + (client ? client.readyState : 'n/a'),
      '  target tab  : ' + (targetTab != null ? targetTab : '(none)'),
      '  clients     : ' + this.clients.size + ' registered' +
        ' | offscreen=' + (this.offscreenClient && this.offscreenClient.readyState === 1 ? 'yes' : 'NO') +
        ' | mainFrameCS=' + (this.mainFrameClient && this.mainFrameClient.readyState === 1 ? 'yes' : 'no') +
        ' | contentTabs=' + this.contentByTab.size,
      '  in-flight   : ' + this.pending.size,
    ];
    // Name the likely culprit for the hop that was actually used.
    if (src === 'offscreen') {
      lines.push('  likely      : the client ACCEPTED it, so the break is downstream — ' +
        'offscreen → SW → tabs.sendMessage → content script. Usual causes: tab closed/never existed, ' +
        'content script not injected (chrome:// or restricted page), Chrome window MINIMISED or ' +
        'occluded (0×0 viewport — restore the window: tabs{action:"windows"} lists windowIds, ' +
        'then tabs{action:"focus", windowId} raises it), or the SW was evicted before the ' +
        'relay ran. NOTE: a merely BACKGROUNDED (non-active) tab is NOT a cause — page ops route ' +
        'by tabId and work on an inactive tab (measured 2026-09-20).');
    } else if (src === 'content-script') {
      lines.push('  likely      : the direct content-script client stopped answering — ' +
        'page navigated (CS torn down), the Chrome window was MINIMISED/occluded, or a native ' +
        '"Leave site?" dialog is parked over Chrome blocking paint. A BACKGROUNDED tab is not a ' +
        'cause; do not activate it, that steals focus from the user. The offscreen relay is the ' +
        'fallback path; a repeat here means the tab binding went stale.');
    } else {
      lines.push('  likely      : client type is ' + src + ' — check websense_doctor for hop state.');
    }
    return new Error(lines.join('\n'));
  }

  nextId() { return 'r' + (++this.requestId); }

  // ═══ Pending-correlation helpers (multi-slot) ═══
  // _settlePending(id, err|null, msg?) — resolve or reject the entry for `id`.
  // A re-sent zombie-retry may have replaced the entry; timers are per-entry so
  // a stale timeout can never settle the replacement.
  _settlePending(id, err, msg) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (err) p.reject(err);
    else if (msg.success) p.resolve(msg.data);
    else {
      const d = msg.data;
      const text = (d && d.error) ? d.error : (typeof d === 'string' ? d : 'Unknown error');
      const e = new Error(text);
      // PRESERVE STRUCTURED DETAIL (2026-09-11c). This used to reject with a bare
      // `new Error(msg.data.error)`, which destroyed every OTHER field of a failure
      // payload — so an error that carefully named its hop / reason / hint / tabId
      // arrived at the caller as a single anonymous string. That is precisely the
      // loss this codebase keeps paying for (see the hop-naming timeout work).
      // server.js safeHandler() folds `detail` back into the tool result.
      if (d && typeof d === 'object') {
        e.detail = d;
        for (const k of Object.keys(d)) { if (!(k in e)) e[k] = d[k]; }
      }
      p.reject(e);
    }
    return true;
  }

  _storePending(id, entry) {
    const prev = this.pending.get(id);
    if (prev) clearTimeout(prev.timer); // zombie-retry re-send under the same id
    this.pending.set(id, entry);
  }

  // Diagnostics snapshot for websense_doctor / /health — the server-side
  // wrapper only exposes {connected, send, stats}, so this is THE way to read
  // hub internals from a tool handler.
  stats() {
    return {
      port: this.port,
      connectedClients: this.clients.size,
      offscreenConnected: !!(this.offscreenClient && this.offscreenClient.readyState === 1),
      mainFrameContentConnected: !!(this.mainFrameClient && this.mainFrameClient.readyState === 1),
      contentTabs: this.contentByTab.size,
      selectedTabId: this.selectedTabId,
      inFlight: this.pending.size,
      eventRing: this.eventRing, // P1#1: live events for wait{event:…}
      clients: Array.from(this.clients.values()).map((c) => ({
        // TABID-CRASH HARDENING: every field read through a null-guard — a
        // diagnostics call must never be the thing that throws.
        source: (c && c.clientSource) || 'unknown',
        isMainFrame: !!(c && c.isMainFrame),
        url: (c && c.clientUrl) || null,
        tabId: (c && c.tabId != null) ? Number(c.tabId) : null,
        readyState: c ? c.readyState : null,
      })),
    };
  }

  // ═══ Client census (2026-09-11) ═══
  // The relay's single biggest time-sink was that "who is actually connected,
  // and which client owns which tab" could only be inferred from a timeout
  // error message. This is the answer, as a plain JSON snapshot, exposed over
  // HTTP by BOTH listeners (hub :38401 and MCP server :9222 — see
  // _handleHttp() below and the GET /health route in src/server.js).
  //
  // CONTRACT — do not weaken it:
  //   * STRICTLY READ-ONLY. No timers, no eviction, no cleanup, no sends.
  //   * TOTAL. It may not throw: it is called while clients are churning, and a
  //     census that throws is worse than no census. Every field is guarded.
  //   * Pure snapshot: safe to call as often as you like.
  census() {
    const now = Date.now();
    const describe = (c) => {
      const raw = (c && c.clientSource) || null;
      return {
        id: (c && c.cid) || null,
        // normalized type: 'offscreen' | 'content-script' | 'unknown'
        type: raw === 'offscreen' ? 'offscreen' : (raw === 'content-script' ? 'content-script' : 'unknown'),
        clientSource: raw,
        isMainFrame: !!(c && c.isMainFrame),
        url: (c && c.clientUrl) || null,
        tabId: (c && c.tabId != null) ? Number(c.tabId) : null,
        readyState: (c && c.readyState != null) ? c.readyState : null,
        readyStateName: (c && c.readyState != null) ? (READY_STATE_NAMES[c.readyState] || String(c.readyState)) : 'n/a',
        connectedAt: (c && c.connectedAt) || null,
        connectedForMs: (c && c.connectedAt) ? (now - c.connectedAt) : null,
      };
    };

    const clients = [];
    for (const c of this.clients.values()) {
      try { if (c) clients.push(describe(c)); } catch (_) { /* never throw */ }
    }

    // Which main-frame content-script client owns each tab (and which one the
    // hub is currently routing unbound page ops to).
    const contentByTab = {};
    for (const [tabId, c] of this.contentByTab) {
      if (!c) continue;
      contentByTab[String(tabId)] = {
        id: c.cid || null,
        url: c.clientUrl || null,
        isMainFrame: !!c.isMainFrame,
        readyState: (c.readyState != null) ? c.readyState : null,
      };
    }
    let selectedMainFrame = null;
    if (this.selectedTabId != null) {
      const c = this.contentByTab.get(Number(this.selectedTabId));
      if (c) selectedMainFrame = describe(c);
    }
    const off = this.offscreenClient;
    const mf = this.mainFrameClient;

    const inFlight = [];
    for (const [id, p] of this.pending) {
      if (!p) continue;
      inFlight.push({
        id,
        op: p.type || '?',
        ageMs: p.startedAt ? (now - p.startedAt) : null,
        startedAt: p.startedAt || null,
        clientId: (p.client && p.client.cid) || null,
        clientType: (p.client && p.client.clientSource) || null,
      });
    }

    const uptimeMs = now - (this.startedAt || now);
    return {
      status: 'ok',
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      hub: {
        port: (typeof this.port === 'number') ? this.port : null,
        uptimeMs,
        uptimeSec: Math.floor(uptimeMs / 1000),
        uptime: formatUptime(uptimeMs),
        startedAt: this.startedAt || null,
      },
      clientsRegistered: clients.length,
      connected: clients.length > 0,
      clients,
      // e.g. { "2072383081": { id: "c10", url: "...", isMainFrame: true, readyState: 1 } }
      contentByTab,
      contentTabs: this.contentByTab.size,
      selectedTabId: (this.selectedTabId != null) ? Number(this.selectedTabId) : null,
      selectedMainFrameClient: selectedMainFrame,
      offscreenClient: off ? describe(off) : null,
      mainFrameClient: mf ? describe(mf) : null,
      inFlightCount: inFlight.length,
      inFlight,
      eventRingSize: Array.isArray(this.eventRing) ? this.eventRing.length : 0,
      eventSeq: this.eventSeq,
      requestSeq: this.requestId,
      clientSeq: this.clientSeq,
    };
  }

  // 2026-09-25 TEST SUPPORT. Send `cmd` to a SPECIFIC client instead of letting
  // activeClient() choose. The content script has two dispatchers — the direct
  // WebSocket (wsDispatchPage) and the offscreen relay (handleMessageAsync) — and
  // the same op name is implemented in both. Without an explicit route, a
  // comparison between the two copies of an op is not a test: the hub picks
  // whichever client is available, so the result is a coin flip. This method is
  // what makes "run this op on BOTH dispatchers" possible.
  //
  // It mirrors send()'s pending/timeout bookkeeping exactly; the only difference
  // is that the client is supplied by the caller. It deliberately does NOT retry
  // and does NOT fall back — a test that silently reroutes proves nothing.
  async sendViaClient(client, cmd) {
    if (!client || client.readyState !== 1) {
      throw new Error('sendViaClient: target client is not open');
    }
    const id = this.nextId();
    const payload = { ...cmd, id };
    console.error('[websense] RAWOP ' + (cmd.type || '?') + ' -> ' + (client.cid || '?') + ' [' + (client.clientSource || 'unknown') + '] tab=' + (this.selectedTabId ?? '-'));
    const timeout = HEAVY_OPS.has(cmd.type) ? EXPLORE_TIMEOUT : REQUEST_TIMEOUT;
    return new Promise((resolve, reject) => {
      this._storePending(id, {
        client,
        resolve, reject,
        type: (cmd && cmd.type) || '?',
        startedAt: Date.now(),
        timer: setTimeout(() => {
          this._settlePending(id, this._timeoutDiag(cmd, client, 'raw_op forced-transport test'));
        }, timeout),
      });
      try {
        client.send(JSON.stringify(payload));
      } catch (e) {
        this._settlePending(id, { error: 'sendViaClient: ' + (e && e.message ? e.message : String(e)) });
      }
    });
  }

  async send(cmd) {
    let client = this.activeClient(cmd);
    if (!client) {
      // Extension auto-connects within 3s — wait 5s max, then error out fast
      const connected = await this.waitForConnection(5000);
      client = this.activeClient(cmd);
      if (!client) {
        throw new Error('Extension not connected — no client can serve ' + (cmd.type || '?') +
          '. hub clients=' + this.clients.size +
          ' | offscreen=' + (this.offscreenClient && this.offscreenClient.readyState === 1 ? 'yes' : 'NO') +
          ' | mainFrameCS=' + (this.mainFrameClient && this.mainFrameClient.readyState === 1 ? 'yes' : 'no') +
          '. If offscreen=NO, reload the WebSense extension in Chrome (chrome://extensions → reload); ' +
          'it auto-connects to ws://localhost:38401 within 3 seconds.');
      }
    }
    const id = this.nextId();
    const payload = { ...cmd, id };
    console.error('[websense] route ' + (cmd.type || '?') + ' -> ' + (client.cid || '?') + ' [' + (client.clientSource || 'unknown') + '] tab=' + (this.selectedTabId ?? '-'));
    const timeout = HEAVY_OPS.has(cmd.type) ? EXPLORE_TIMEOUT : REQUEST_TIMEOUT;
    const attempt = async (targetClient, isRetry) => {
      return new Promise((resolve, reject) => {
        this._storePending(id, {
          client: targetClient,
          resolve, reject,
          type: (cmd && cmd.type) || '?', // /health census: op name
          startedAt: Date.now(),          // /health census: in-flight age
          timer: setTimeout(() => {
            this._settlePending(id, this._timeoutDiag(cmd, targetClient, timeout));
          }, timeout),
        });
        try { targetClient.send(JSON.stringify(payload)); }
        catch (err) { this._settlePending(id, new Error('Send failed: ' + err.message)); reject(new Error('Send failed: ' + err.message)); }
      }).catch(async (err) => {
        // ZOMBIE-OFFSCREEN RECOVERY: an extension reload/toggle can leave the
        // hub's offscreenClient WS alive while its chrome.runtime context was
        // invalidated — every tab op then fails with 'Extension context
        // invalidated'. Self-heal: kill the zombie socket (the offscreen
        // watchdog then self-closes the dead doc, and the SW's setupOffscreen
        // spawns a fresh one within ~3s), drop cached refs, wait, retry ONCE.
        const msg = String((err && err.message) || err);
        // ONLY genuine context-invalidation (a dead offscreen/content-script
        // whose runtime context was destroyed by a reload) triggers the kill.
        // "Extension disconnected" / timeouts are NORMAL (SW restarts, tab
        // closes) — killing clients for those makes things worse.
        if (!isRetry && /context invalidated/i.test(msg)) {
          console.error('[websense] Zombie client detected (' + msg + ') — killing ' + (targetClient.cid || '?') + ' and retrying once');
          this._killingZombie = true;
          try { if (targetClient && targetClient.readyState === 1) targetClient.terminate(); } catch (_) {}
          setTimeout(() => { this._killingZombie = false; }, 2000);
          // Clean up EVERY tracking structure for the dead socket, including
          // the tab map and the per-tab dead-socket guard.
          if (this.offscreenClient === targetClient) this.offscreenClient = null;
          if (this.contentClient === targetClient) this.contentClient = null;
          if (this.mainFrameClient === targetClient) this.mainFrameClient = null;
          if (this.lastClient === targetClient) this.lastClient = null;
          if (targetClient && targetClient.tabId) this.contentByTab.delete(targetClient.tabId);
          this._lastDirectDead = targetClient; // don't re-pick this exact dead WS
          setTimeout(() => { if (this._lastDirectDead === targetClient) this._lastDirectDead = null; }, 5000);
          if (targetClient && targetClient.cid) this.clients.delete(targetClient.cid);
          this.connected = this.clients.size > 0;
          // Wait ≤5s for a replacement (offscreen watchdog/SW recreate it, or
          // the content script reconnects within 3s), then retry ONCE via the
          // normal routing (direct content script for page ops, offscreen for
          // tab ops).
          const deadline = Date.now() + 5000;
          let fresh = null;
          while (Date.now() < deadline) {
            fresh = this.activeClient(cmd);
            if (fresh && fresh !== targetClient && fresh !== this._lastDirectDead && fresh.readyState === 1) break;
            await new Promise((r) => setTimeout(r, 400));
          }
          if (fresh && fresh !== targetClient) return attempt(fresh, true);
        }
        throw err;
      });
    };
    return attempt(client, false);
  }

  async waitForConnection(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // launchBrowser() removed — the extension auto-connects via WebSocket.
  // No browser tab or launcher page is needed.

  healthCheck() {
    // Explicit cmd object: calling this with NO argument is the shape that threw
    // `Cannot read properties of undefined (reading 'tabId')` on the 30s interval
    // (see the TABID-CRASH note in activeClient). Routing is identical either way —
    // 'health_ping' is neither a tab op nor in SW_REQUIRED_OPS — but passing it
    // documents the intent and keeps the no-arg shape out of the codebase.
    const c = this.activeClient({ type: 'health_ping' });
    if (c) {
      try { c.send(JSON.stringify({ type: 'ping', id: 'health' })); }
      catch (_) { this.lastClient = null; }
    }
  }

  stop() {
    for (const c of this.clients.values()) { try { c.close(); } catch (_) {} }
    this.clients.clear();
    this.lastClient = null;
    this.contentClient = null;
    this.mainFrameClient = null;
    this.offscreenClient = null;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); try { p.reject(new Error('Hub stopped')); } catch (_) {} }
    this.pending.clear();
    if (this.wss) this.wss.close();
    if (this.http) this.http.close();
  }
}
