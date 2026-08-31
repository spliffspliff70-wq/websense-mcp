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
const HEAVY_OPS = new Set(['explore_page', 'discover_actions']);
const TLS_PORT = 38411;
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
    this.eventRing = [];    // ring buffer (P1#1, max 50 page_event entries)
    this.eventRingMax = 50;
    this.eventSeq = 0;

    if (this.useTls) {
      const tlsOpts = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };
      this.http = https.createServer(tlsOpts, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'WebSense MCP Hub (TLS). The extension connects automatically via WebSocket.' }));
      });
      console.error(`[websense] ${this.label} hub: TLS (wss://) on 0.0.0.0:${this.port}`);
    } else {
      this.http = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'WebSense MCP Hub. The extension connects automatically via WebSocket.' }));
      });
      console.error(`[websense] ${this.label} hub: plain (ws://) on 0.0.0.0:${this.port}`);
    }

    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.http.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Hard fail: do NOT swallow EADDRINUSE. If we resolve() here the
          // server process stays alive as a zombie holding no port while the
          // parent (MCP client) waits forever for a stdio
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
            if (this.contentClient === prev) this.contentClient = null;
            if (this.mainFrameClient === prev) this.mainFrameClient = null;
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
      if (ws.tabId) this.contentByTab.delete(ws.tabId);
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
  static get SW_REQUIRED_OPS() { return new Set(['upload_file', 'network_log']); }

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
    // P2 respawn_offscreen (2026-08-31): route through a CONTENT SCRIPT, never
    // the offscreen — the op kills the offscreen, so a request riding on the
    // offscreen's own WS dies with it ('Extension disconnected' for a
    // successful op). A content script stays alive, relays to the SW via
    // chrome.runtime, and the response returns over the CS's own WS.
    if (cmd && cmd.type === 'respawn_offscreen') {
      const cs = this.mainFrameClient || this.contentClient || this.lastClient;
      if (cs && cs.readyState === 1) return cs;
    }
    const isTabOp = cmd && (cmd.type === 'navigate' || cmd.type === 'list_tabs' || cmd.type === 'switch_tab' ||
      cmd.type === 'close_tab' || cmd.type === 'list_frames' || cmd.type === 'download_state' ||
      cmd.type === 'bind_tab' || cmd.type === 'transfer_text' || cmd.type === 'switch_tab_and_read' ||
      cmd.type === 'list_windows' || cmd.type === 'focus_window' || cmd.type === 'move_tab_to_window' || cmd.type === 'ax_state' ||
      cmd.type === 'browser_screenshot' || cmd.type === 'get_active_tab' || cmd.type === 'cookie_op' || cmd.type === 'download_op' || cmd.type === 'respawn_offscreen');
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
    else p.reject(new Error(msg.data && msg.data.error ? msg.data.error : (typeof msg.data === 'string' ? msg.data : 'Unknown error')));
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
        source: c.clientSource || 'unknown',
        isMainFrame: !!c.isMainFrame,
        url: c.clientUrl || null,
        tabId: c.tabId != null ? c.tabId : null,
        readyState: c.readyState,
      })),
    };
  }

  async send(cmd) {
    let client = this.activeClient(cmd);
    if (!client) {
      // Extension auto-connects within 3s — wait 5s max, then error out fast
      const connected = await this.waitForConnection(5000);
      client = this.activeClient(cmd);
      if (!client) {
        throw new Error('Extension not connected. Reload the WebSense extension in Chrome (chrome://extensions → click reload). The content script auto-connects to ws://localhost:38401 within 3 seconds.');
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
          timer: setTimeout(() => {
            this._settlePending(id, new Error('Request timeout (' + (timeout/1000) + 's) for ' + cmd.type));
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
    const c = this.activeClient();
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
