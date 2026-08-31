/**
 * WebSense MCP — Offscreen Document (WS Client)
 *
 * AUTO-CONNECTS to ws://localhost:38401 on load.
 * If the MCP server isn't running yet, retries every 3 seconds.
 * This eliminates the need for a launcher page — the extension
 * is always trying to connect, so when the MCP server starts,
 * the connection happens automatically.
 *
 * All DOM work is in content.js. This file only forwards messages.
 */
'use strict';

var PORT = 38401;
var ws = null;
var reconnectDelay = 3000; // Fixed 3s retry — server might not be up yet
var reconnectTimer = null;
// B1: NO currentTabId cache here. The SW holds the single source of truth
// (boundTabId); the offscreen just relays. Kills the stale-cache latch class
// (PITFALL 26) at the root: there is nothing to go stale.

function log(msg) { console.log('[websense] ' + msg); }

// Answer the SW's liveness probe (used by setupOffscreen to detect a zombie
// offscreen whose chrome.runtime context died but whose WS still connects).
try {
  chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
    if (msg && msg.type === 'OFFSCREEN_PROBE') { sendResponse({ alive: true }); }
    // Phase 2 (2026-08-15): SW forwards chrome.tabs lifecycle events (removed/
    // activated) so the hub can keep its tab registry live. Relay to the hub.
    if (msg && msg.type === 'tab_event') { send({ type: 'tab_event', event: msg.event, tabId: msg.tabId, windowId: msg.windowId }); }
    return false;
  });
} catch (_) {}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Tell the hub which tab the bridge explicitly selected, so page ops can route
// DIRECTLY to that tab's content script (flattened path, no offscreen relay).
function notifyTabSelected(tabId) {
  if (tabId) send({ type: 'tab_selected', tabId: tabId });
}

// ═══ Tab resolution ═══

function sendTabControl(action, payload) {
  return chrome.runtime.sendMessage({ type: 'TAB_CONTROL', action: action, payload: payload }).catch(function(err) {
    log('TAB_CONTROL ' + action + ' failed: ' + err);
    // ZOMBIE SELF-CLEAN: after an extension reload/toggle, this offscreen
    // document can survive with a LIVE WS to the hub but a DEAD chrome.runtime
    // context ("Extension context invalidated"). Every tab op then fails while
    // the document blocks recreation (Chrome allows only ONE offscreen).
    // Close ourselves so the SW's keepalive/setupOffscreen spawns a fresh one.
    var msg = String((err && err.message) || err);
    if (/context invalidated/i.test(msg)) {
      log('chrome.runtime context invalidated — self-closing to force recreation');
      try { window.close(); } catch (_) {}
    }
    return null;
  });
}

async function getActiveTabId() {
  // B1: prefer the SW's BOUND tab (explicitly selected via switch_tab/bind_tab/
  // navigate). Ask the SW — sub-ms state read, no chrome.tabs round trip.
  // Falls back to the OS-active tab only when nothing is bound.
  var bound = await sendTabControl('get_bound_tab', {});
  if (bound && bound.tabId) return bound.tabId;
  var res = await sendTabControl('get_active_tab', {});
  return (res && res.tab && res.tab.id) || null;
}

function isContentScriptAllowed(url) {
  if (!url) return false;
  return ![/^chrome:\/\//, /^chrome-extension:\/\//, /^about:/, /^edge:\/\//, /^file:\/\//].some(function(p) { return p.test(url); });
}

// ═══ Dispatch to content script via background ═══

async function dispatchToContent(message) {
  // B1: route to the SW's bound tab (single source of truth — kills the
  // multi-window latch where tabs.query from the SW resolved to a different
  // window's active tab). Falls back to the OS-active tab when unbound.
  // 2026-08-12 concurrency fix: when the hub relays a message that carries an
  // EXPLICIT tabId (stamped by the server per-session), honor IT — the global
  // SW binding may belong to a DIFFERENT session (worker hijack prevention).
  var tabId = (message && (message.tabId != null ? Number(message.tabId) : null)) || await getActiveTabId();
  if (!tabId) return { error: 'No active tab' };
  var tabInfo = await sendTabControl('get_tab_info', { tabId: tabId });
  var url = (tabInfo && tabInfo.url) || '';
  if (!isContentScriptAllowed(url)) return { error: 'Restricted page: ' + url };
  // Phase 2 (2026-08-15): 0x0 viewport self-heal. A MINIMIZED Chrome window
  // yields a 0x0 viewport — every page read returns empty (PITFALL 31) and the
  // external Python helper was the only recovery. Now the SW restores the
  // window before relaying the page op so reads work without user intervention.
  if (tabInfo && tabInfo.windowId != null) {
    try {
      var win = await chrome.windows.get(tabInfo.windowId);
      if (win && (win.state === 'minimized' || win.state === 'collapsed')) {
        await chrome.windows.update(tabInfo.windowId, { state: 'normal' });
      }
    } catch (_) { /* window query can fail on some pages — non-fatal */ }
  }
  return new Promise(function(resolve) {
    chrome.runtime.sendMessage({
      type: 'PAGE_CONTROL',
      action: message.type,
      payload: message,
      targetTabId: tabId,
    }).then(function(response) {
      resolve(response || { error: 'No response from content script' });
    }).catch(function(err) {
      resolve({ error: err instanceof Error ? err.message : String(err) });
    });
  });
}

// ═══ Tab operations (handled directly, no content script needed) ═══

async function handleTabOperation(message) {
  switch (message.type) {
    case 'list_tabs': { var res = await sendTabControl('get_window_tabs', {}); return (res && res.tabs) || []; }
    case 'get_active_tab': {
      // P0#3 (2026-08-31): answer with the OS-active tab — used by the
      // server's auto-climb guard to refuse real-clicks when the target tab
      // is not frontmost (multi-agent wrong-window protection).
      var at = await sendTabControl('get_active_tab', {});
      return (at && at.tab) ? { success: true, tab: at.tab } : { success: false, error: 'no active tab' };
    }
    case 'switch_tab': {
      // B1: ONE hop — SW activates AND binds. No local cache write; the SW
      // is the source of truth. Notify the hub so page ops route DIRECT to
      // this tab's content script on the next call (flattened hot path).
      // Phase 2 (2026-08-15): honor activate:true so foreground-requiring
      // reads can bring a tab forward on demand. Default false =
      // background-only (no OS focus steal).
      var tid = message.tab_id || message.tabId;
      var r = await sendTabControl('switch_to_tab', { tabId: parseInt(tid, 10), activate: !!message.activate });
      if (r && r.error) return { error: r.error };
      notifyTabSelected(parseInt(tid, 10));
      return { success: true };
    }
    case 'bind_tab': {
      var tid2 = message.tab_id || message.tabId;
      var rb = await sendTabControl('bind_tab', { tabId: parseInt(tid2, 10), activate: !!message.activate });
      if (rb && rb.error) return { error: rb.error };
      notifyTabSelected(parseInt(tid2, 10));
      return { success: true, tabId: parseInt(tid2, 10) };
    }
    case 'transfer_text': {
      // B2: atomic cross-tab copy-paste — relay straight to the SW (it
      // orchestrates both tabs natively). Notify the hub of the destination
      // binding so the flattened path stays hot.
      var tr = await sendTabControl('transfer_text', { fromTab: parseInt(message.fromTab, 10), toTab: parseInt(message.toTab, 10), fromSelector: message.fromSelector, toSelector: message.toSelector, useValue: !!message.useValue });
      if (tr && tr.tabId) notifyTabSelected(tr.tabId);
      return tr || { error: 'transfer_text failed' };
    }
    case 'switch_tab_and_read': {
      var sr = await sendTabControl('switch_tab_and_read', { tabId: parseInt(message.tabId, 10), selector: message.selector });
      if (sr && sr.tabId) notifyTabSelected(sr.tabId);
      return sr || { error: 'switch_tab_and_read failed' };
    }
    case 'list_windows': { return await sendTabControl('list_windows', {}); }
    case 'focus_window': { return await sendTabControl('focus_window', { windowId: parseInt(message.windowId, 10) }); }
    case 'move_tab_to_window': { return await sendTabControl('move_tab_to_window', { tabId: parseInt(message.tabId, 10), windowId: parseInt(message.windowId, 10) }); }
    case 'close_tab': {
      var cid2 = message.tab_id || message.tabId;
      var r2 = await sendTabControl('close_tab', { tabId: parseInt(cid2, 10) });
      if (r2 && r2.error) return { error: r2.error };
      return { success: true };
    }
    case 'tab_contents': {
      // Pre-extract all tab-panel contents WITHOUT clicking each tab. Routes
      // to the SW which reads each panel via the live DOM. Was an
      // unknown-action error before (Phase 1, 2026-08-15).
      var tc = await sendTabControl('tab_contents', {});
      if (tc && tc.error) return { error: tc.error };
      return tc || { error: 'tab_contents failed' };
    }
    case 'clear_binding': {
      // Phase 1 (2026-08-15): clears the SW's bound-tab source of truth so the
      // PITFALL-16 stale-tab recovery cycle (reset_session → navigate → extract)
      // becomes deterministic. The hub also drops selectedTabId on receipt.
      try {
        await sendTabControl('clear_binding', {});
      } catch (_) { /* SW may not implement — harmless */ }
      notifyTabSelected(null);
      return { success: true };
    }
    case 'browser_screenshot': {
      // Phase 4 (2026-08-15): capture the visible tab to a data URL via the SW
      // (chrome.tabs.captureVisibleTab — a chrome.tabs API, no CDP, no
      // navigator.webdriver, no bot-detection surface). Returns {dataUrl,
      // mime}. Lets vision models read heavy/visually-laid-out pages the
      // structured tree can't fully represent.
      var sc = await sendTabControl('capture_visible_tab', { format: message.format || 'png', quality: message.quality || 80 });
      if (sc && sc.error) return { error: sc.error };
      return sc || { error: 'screenshot failed' };
    }
    case 'navigate': {
      // Reuse the current tab by default (no tab spam). newTab:true forces a fresh tab.
      // BACKGROUND-ONLY (2026-08-13, project directive): never activate — activation
      // raises the Chrome window and hijacks the user's foreground.
      if (message.newTab) {
        var r3 = await sendTabControl('open_new_tab', { url: message.url, active: false });
        var nt = (r3 && r3.tabId) || null;
        notifyTabSelected(nt);
        return { success: true, tabId: nt, reused: false, background: true };
      }
      var r4 = await sendTabControl('navigate_current_tab', { url: message.url, ...(message.tabId ? { tabId: message.tabId } : {}) });
      if (r4 && r4.error) return { error: r4.error };
      var nid = (r4 && r4.tabId) || null;
      notifyTabSelected(nid);
      return { success: true, tabId: nid, reused: !!(r4 && r4.reused) };
    }
    case 'list_frames': { return await sendTabControl('list_frames', {}); }
    case 'download_state': { return await sendTabControl('download_state', {}); }
    case 'download_op': { return await sendTabControl('download_op', message); }
    case 'cookie_op': { return await sendTabControl('cookie_op', message); }
    case 'respawn_offscreen': { return await sendTabControl('respawn_offscreen', {}); }
    case 'doctor_sw': { return await sendTabControl('doctor', {}); }
    default: return null;
  }
}

// ═══ AX BRIDGE via chrome.debugger (stable Chrome compatible) ═══
// chrome.debugger is only available in the background service worker, not the
// offscreen document. Forward ax_* ops to the background SW which does the
// actual CDP work and returns the result.

function axForwardToBackground(message) {
  // chrome.debugger.attach is slow. Use a long-lived port + keepalive to
  // prevent Chrome MV3 from suspending the offscreen mid-handshake.
  return new Promise(function(resolve, reject) {
    try {
      // Keep the offscreen alive during the slow debugger operation
      var keepaliveTimer = setInterval(function() { /* keepalive */ }, 20000);
      
      var port = chrome.runtime.connect({ name: 'ax-bridge' });
      var settled = false;
      
      port.onMessage.addListener(function(response) {
        if (settled) return;
        settled = true;
        clearInterval(keepaliveTimer);
        port.disconnect();
        if (response && response.error) return reject(new Error(response.error));
        resolve(response || { error: 'No response from background' });
      });
      
      port.onDisconnect.addListener(function() {
        if (settled) return;
        settled = true;
        clearInterval(keepaliveTimer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else reject(new Error('Port disconnected'));
      });
      
      port.postMessage({ type: 'AX_CONTROL', axType: message.type, tabId: message.tabId, match: message.match, text: message.text });
    } catch(e) { reject(e); }
  });
}

function axNodeToObj(node, depth) {
  if (depth > 12) return null;
  var o = {
    role: node.role ? (node.role.value || node.role) : 'unknown',
    name: node.name ? (node.name.value || node.name) : '',
    backendDOMNodeId: node.backendDOMNodeId || null,
  };
  if (node.properties) {
    o.state = {};
    node.properties.forEach(function(p) {
      if (p.value && p.value.value !== undefined) {
        o.state[p.name] = p.value.value;
      }
    });
  }
  if (node.childIds && node.childIds.length) {
    o.childrenCount = node.childIds.length;
  }
  return o;
}

function handleAxOperationDebugger(message) {
  var tabId = message.tabId || null;
  if (tabId == null) return Promise.resolve({ error: 'ax_* requires an explicit tabId' });
  return axForwardToBackground(message);
}

// ═══ WS Message Handler ═══

async function handleWsMessage(msg) {
  if (msg.type === 'ax_state' || msg.type === 'ax_read' || msg.type === 'ax_click' || msg.type === 'ax_type') {
    return await handleAxOperationDebugger(msg);
  }
  var tabResult = await handleTabOperation(msg);
  if (tabResult !== null) return tabResult;
  return await dispatchToContent(msg);
}

function processMessage(msg) {
  handleWsMessage(msg).then(function(data) {
    send({ type: msg.type + '_result', id: msg.id, success: !data || !data.error, data: data });
  }).catch(function(err) {
    send({ type: msg.type + '_result', id: msg.id, success: false, data: err instanceof Error ? err.message : String(err) });
  });
}

// ═══ WebSocket Connection — AUTO-CONNECT with retry ═══

function connect() {
  log('Connecting to ws://localhost:' + PORT + '...');
  try {
    ws = new WebSocket('ws://127.0.0.1:' + PORT);
  } catch (err) {
    log('WebSocket creation failed: ' + err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', function() {
    log('✓ Connected to WebSense MCP server');
    send({ type: 'ready', version: '1.0.0', source: 'offscreen' });
    // B1: re-sync the hub's selectedTabId with the SW's bound tab after any
    // reconnect (hub restart, offscreen respawn). Without this, selectedTabId
    // stays null after a gateway restart → page ops fall to the slow relay
    // path instead of the flattened direct route (B0.3).
    sendTabControl('get_bound_tab', {}).then(function(bound) {
      if (bound && bound.tabId) notifyTabSelected(bound.tabId);
    });
  });

  ws.addEventListener('message', function(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    if (msg.type === 'ready') return;
    if (msg.type === 'ping') { send({ type: 'pong', id: msg.id }); return; }
    processMessage(msg);
  });

  ws.addEventListener('close', function() {
    log('Disconnected — will retry in ' + (reconnectDelay / 1000) + 's');
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener('error', function() {
    // Error handler — close handler will trigger reconnect
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function() {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
}

// ═══ Self-healing watchdog ═══
// If the WS dies and can't reconnect, this offscreen document is a zombie —
// it blocks recreation (chrome.offscreen allows only ONE) while doing nothing.
// Close ourselves so the SW's keepalive alarm recreates a fresh one.
var lastWsAliveAt = Date.now();
setInterval(function() {
  // Context-invalidated check: after an extension reload this document can
  // hold a live WS while chrome.runtime is dead — no tab op will ever work.
  // Detect via chrome.runtime.id (undefined after context invalidation) and
  // self-close so the SW recreates a fresh offscreen.
  var ctxDead = false;
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) ctxDead = true;
  } catch (_) { ctxDead = true; }
  if (ctxDead) {
    log('chrome.runtime context dead — self-closing to force recreation');
    try { window.close(); } catch (_) {}
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (Date.now() - lastWsAliveAt > 10000) {
      log('WS dead for 10s — self-closing to force recreation');
      try { window.close(); } catch (_) {}
    }
  } else {
    lastWsAliveAt = Date.now();
  }
}, 2000);

// ═══ START: Connect immediately on load ═══
connect();
log('WebSense bridge started — auto-connecting to localhost:' + PORT);
