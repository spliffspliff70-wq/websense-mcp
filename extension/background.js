/**
 * WebSense MCP — Background Service Worker
 * Manages offscreen document lifecycle and message routing.
 * Creates offscreen document IMMEDIATELY on startup for auto-connect.
 */
'use strict';

// ═══ MAIN-world console/JS-error hook (2026-08-30, parity with Hermes browser_console) ═══
// Page console.* runs in the MAIN world; the isolated content script can't see it.
// Register console-hook.js into the MAIN world at document_start — it writes a
// JSON ring buffer onto a hidden DOM node (#__ws_console_buffer) that the content
// script's console_log reads. Idempotent: registerContentScripts throws on a
// duplicate ID, which we swallow (already registered).
async function registerConsoleHook() {
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'ws-console-hook',
      matches: ['<all_urls>'],
      js: ['console-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    }]);
  } catch (e) {
    // Duplicate ID → already registered; or scripting unavailable → hook falls
    // back to the isolated-world capture only (partial console coverage).
  }
}

// ═══ Offscreen Document Management ═══

let offscreenCreating = null;

// 2026-08-12 (Ali: 'the hub should never disconnect'): chrome.offscreen
// createDocument can HANG (never resolve) when Chrome is mid-suspension or a
// zombie registration is half-cleared. If it hangs, offscreenCreating stays a
// never-settling promise and line 48's `await offscreenCreating` deadlocks
// EVERY later recovery attempt (keepalive alarms keep firing but never
// recreate). Wrap creation in a hard timeout so a hang can never block.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
  ]);
}

// B1: SW is the SINGLE SOURCE OF TRUTH for tab binding. The offscreen no
// longer caches a currentTabId — every page op asks the SW for the bound tab
// (sub-ms state read) or falls back to the OS-active tab. Lifecycle listeners
// below invalidate it when the tab closes; navigate/switch rebind it.
let boundTabId = null;

// Restricted-page guard (mirrors offscreen.js). Content scripts cannot run on
// chrome://, chrome-extension://, about:, edge://, file:// — page ops into
// those must fall back to a real http(s) tab.
function isContentScriptAllowed(url) {
  if (!url) return false;
  return ![/^chrome:\/\//, /^chrome-extension:\/\//, /^about:/, /^edge:\/\//, /^file:\/\//].some(function (p) { return p.test(url); });
}

// Invalidate the binding when the bound tab is closed (SW single source —
// the offscreen's cached id used to survive closes and route ops to a dead
// tab, PITFALL 26 class).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === boundTabId) boundTabId = null;
  // Phase 2 (2026-08-15): tell the offscreen → hub so the hub's tab registry
  // drops the dead content-script client (no routing into a dead tab).
  try {
    chrome.runtime.sendMessage({ type: 'tab_event', event: 'removed', tabId: tabId });
  } catch (_) { /* offscreen may not be ready — harmless */ }
});

// Phase 2 (2026-08-15): onActivated keeps the binding live to the tab the
// USER actually switched to — without this the SW's boundTabId could point at
// a stale tab forever (root of PITFALL 16 latch). The offscreen also needs to
// learn of user-driven switches so its getActiveTabId() resolves correctly.
chrome.tabs.onActivated.addListener((activeInfo) => {
  boundTabId = activeInfo.tabId;
  try {
    chrome.runtime.sendMessage({ type: 'tab_event', event: 'activated', tabId: activeInfo.tabId, windowId: activeInfo.windowId });
  } catch (_) { /* offscreen may not be ready — harmless */ }
});

// When the bound tab navigates away (SPA route or full load), the content
// script re-injects — keep the binding (same tab, new page) but the hub's
// contentByTab map re-registers the fresh content script on its ready
// handshake, so direct routing stays correct.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === boundTabId && changeInfo.status === 'complete') {
    // Content script will reconnect; nothing to do here — the hub handles it.
  }
  // Invalidate binding if the bound tab becomes a restricted page (chrome://
  // etc.) so the next page op falls back to the OS-active http(s) tab instead
  // of routing into a page the content script can't touch.
  if (tabId === boundTabId && changeInfo.url && !isContentScriptAllowed(changeInfo.url)) {
    boundTabId = null;
  }
});

async function hasOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    return contexts.length > 0;
  } catch (_) {
    return false;
  }
}

async function setupOffscreen() {
  if (offscreenCreating) { try { await withTimeout(offscreenCreating, 8000, 'pending creation'); } catch (_) {} offscreenCreating = null; }
  try {
    offscreenCreating = (async () => {
      // ZOMBIE-OFFSCREEN RECOVERY: after an extension reload/toggle, Chrome can
      // keep the OLD offscreen document registered ("only a single offscreen
      // document may be created") while its chrome.runtime context is dead —
      // the WS even reconnects, but every tab op fails with 'Extension context
      // invalidated' and recreation is blocked. Probe the existing document:
      // if it does not answer, closeDocument() it and create a fresh one.
      try {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [chrome.runtime.getURL('offscreen.html')],
        });
        if (contexts.length > 0) {
          const ok = await new Promise((resolve) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 1500);
            try {
              chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROBE' }).then((resp) => {
                if (done) return;
                done = true; clearTimeout(t); resolve(!!(resp && resp.alive));
              }).catch(() => { if (!done) { done = true; clearTimeout(t); resolve(false); } });
            } catch (_) { if (!done) { done = true; clearTimeout(t); resolve(false); } }
          });
          if (!ok) {
            console.warn('[websense-bg] Existing offscreen unresponsive — closing to force recreation');
            try { await chrome.offscreen.closeDocument(); } catch (_) {}
          }
        }
      } catch (_) { /* no getContexts/offscreen API — fall through to create */ }
      await withTimeout(chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['IFRAME_SCRIPTING'],
        justification: 'WebSocket connection to WebSense MCP server for browser automation bridging',
      }), 8000, 'createDocument');
    })();
    await offscreenCreating;
  } catch (err) {
    // "Only a single offscreen document may be created" = a zombie holds the
    // slot (its runtime is dead but the registration survived a reload/toggle).
    // Force-close it and retry ONCE — the old code treated this as "OK" and
    // silently gave up, leaving the hub with a dead offscreen forever
    // (Ali 2026-08-12: workers hijacked tabs + tab ops failed with
    // 'Extension context invalidated' because the offscreen never respawned).
    const msg = String((err && err.message) || err);
    if (/only a single offscreen/i.test(msg)) {
      console.warn('[websense-bg] Offscreen slot held by zombie — force-closing and retrying');
      try {
        await chrome.offscreen.closeDocument();
      } catch (_) {}
      try {
        offscreenCreating = (async () => {
          await withTimeout(chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['IFRAME_SCRIPTING'],
            justification: 'WebSocket connection to WebSense MCP server for browser automation bridging',
          }), 8000, 'createDocument-retry');
        })();
        await withTimeout(offscreenCreating, 10000, 'recreate-await');
        console.warn('[websense-bg] Offscreen recreated after zombie close');
      } catch (err2) {
        console.error('[websense-bg] Offscreen recreation failed:', err2);
      }
    } else {
      console.error('[websense-bg] Failed to create offscreen:', err);
    }
  }
  offscreenCreating = null;
}

// ═══ Tab Management ═══

async function getActiveTab() {
  // Phase 2 (2026-08-15): sanitized active-tab pick. The old
  // {active:true, currentWindow:true} could be hijacked by a STRAY second
  // Chrome window (e.g. chrome://extensions left open) — page ops then routed
  // to a content-script-less window (PITFALL 26). Now: if the current window's
  // active tab is a RESTRICTED page (chrome://, about:, etc.), fall back to the
  // first active http(s) tab across ALL windows. Otherwise return the focused
  // window's active tab as before.
  const focused = await chrome.tabs.query({ active: true, currentWindow: true });
  const f = focused && focused[0];
  if (f && isContentScriptAllowed(f.url)) return f;
  const all = await chrome.tabs.query({ active: true });
  const http = all.find((t) => isContentScriptAllowed(t.url));
  return http || f || null;
}

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => {
    const url = t.url || '';
    return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('edge://') && !url.startsWith('about:');
  }).map((t) => ({ id: t.id, url: t.url || '', title: t.title || '', active: t.active }));
}

// ═══ Message Routing ═══

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Tab control messages from offscreen
  if (message.type === 'TAB_CONTROL') {
    handleTabControl(message.action, message.payload).then(sendResponse).catch((err) => {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  // Page control messages from offscreen → forward to content script in target tab (or specific frame)
  if (message.type === 'PAGE_CONTROL') {
    const { action, payload, targetTabId } = message;
    const tabId = targetTabId || sender.tab?.id;
    if (!tabId) { sendResponse({ error: 'No target tab ID' }); return true; }
    const frameId = (payload && payload.frameId !== undefined) ? payload.frameId : undefined;
    chrome.tabs.sendMessage(tabId, { type: action, ...payload }, frameId !== undefined ? { frameId } : undefined).then(sendResponse).catch((err) => {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }

  // Health check from offscreen
  if (message.type === 'OFFSCREEN_ALIVE' || message.type === 'OFFSCREEN_PROBE') {
    sendResponse({ alive: true });
    return true;
  }

  // Content script asks "which tab am I in?" — the SW knows via sender.tab.
  // Used so the hub can route page ops DIRECTLY to the selected tab's content
  // script (kills the offscreen+SW round-trip for page ops).
  if (message.type === 'GET_MY_TAB_ID') {
    sendResponse({ tabId: (sender && sender.tab && sender.tab.id) || null });
    return true;
  }

  return false;
});

// ═══ AX BRIDGE via chrome.debugger (Phase 4, 2026-08-15) ═══
// Long-lived port — chrome.debugger.attach is slow and sendMessage times out.
chrome.runtime.onConnect.addListener(function(port) {
  if (port.name !== 'ax-bridge') return;
  port.onMessage.addListener(function(message) {
    if (message && message.type === 'AX_CONTROL') {
      handleAxControl(message).then(function(response) {
        port.postMessage(response || { error: 'No response' });
      }).catch(function(err) {
        port.postMessage({ error: err instanceof Error ? err.message : String(err) });
      });
    }
  });

  return false;
});

async function handleTabControl(action, payload) {
  switch (action) {
    case 'capture_visible_tab': {
      // Phase 4 (2026-08-15): browser_screenshot tool. chrome.tabs.captureVisibleTab
      // is a chrome.tabs API — no CDP, no webdriver flag, no bot-detection surface.
      // Returns a data URL the model can pass to vision.
      // BACKGROUND-TAB FALLBACK (2026-08-31, OSS 24-tool sweep): captureVisibleTab
      // only captures the VISIBLE tab — on a background/bound tab it fails with
      // "image readback failed". Fall back to chrome.debugger Page.captureScreenshot
      // on the BOUND tab (same transport the ax tool already uses; brief debugging
      // infobar appears). Now a background tab screenshots fine.
      const fmt = (payload.format === 'jpeg' || payload.format === 'jpg') ? 'jpeg' : 'png';
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: fmt, quality: payload.quality || 80 });
        return { success: true, dataUrl: dataUrl, mime: 'image/' + fmt, mode: 'visible' };
      } catch (visibleErr) {
        // Bound tab is backgrounded (or capture refused) — debugger fallback.
        try {
          const tabId = (typeof boundTabId === 'number') ? boundTabId : (payload.tabId ? parseInt(payload.tabId, 10) : null);
          if (!tabId) return { error: 'captureVisibleTab failed: ' + (visibleErr.message || visibleErr) + ' — and no bound tab for debugger fallback' };
          const target = { tabId };
          try { await chrome.debugger.attach(target, '1.3'); } catch (_) { /* already attached is fine */ }
          try {
            const res = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? (payload.quality || 80) : undefined });
            return { success: true, dataUrl: 'data:image/' + fmt + ';base64,' + res.data, mime: 'image/' + fmt, mode: 'debugger-fallback', tabId };
          } finally {
            try { await chrome.debugger.detach(target); } catch (_) {}
          }
        } catch (dbgErr) {
          return { error: 'screenshot failed (visible: ' + (visibleErr.message || visibleErr) + '; debugger fallback: ' + (dbgErr.message || dbgErr) + ')' };
        }
      }
    }
    case 'get_active_tab': {
      const tab = await getActiveTab();
      return { success: true, tab };
    }
    case 'respawn_offscreen': {
      // P2 (2026-08-31): force the offscreen document to be torn down and
      // recreated with the CURRENT on-disk code. MV3 does NOT reliably reload
      // the offscreen doc on extension-card reload — it keeps the old one
      // running (persistent document), so new offscreen-side ops (cookie_op,
      // download_op) 404 with 'Unknown action type' after a code edit. Closing
      // + setupOffscreen() loads the fresh offscreen.js.
      try { await chrome.offscreen.closeDocument(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 400));
      await setupOffscreen();
      return { success: true, message: 'offscreen respawned' };
    }
    case 'extension_reload': {
      // v4 (2026-08-31): full self-reload — chrome.runtime.reload() tears down
      // ALL extension contexts (SW, offscreen, content scripts) and reloads
      // everything from disk. The server-side extension_reload tool polls the
      // hub until the fresh SW reconnects (~3s), so callers get one clean
      // result. NOTE: this SW dies right here — the response never makes it
      // back; the poll is the actual confirmation mechanism.
      setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 150);
      return { success: true, message: 'reloading extension in 150ms' };
    }
    case 'get_window_tabs': {
      const tabs = await getAllTabs();
      return { success: true, tabs };
    }
    case 'switch_to_tab': {
      const tabId = parseInt(payload.tabId, 10);
      if (!tabId || isNaN(tabId)) return { error: 'Invalid tabId: ' + payload.tabId };
      try {
        // Bind the tab WITHOUT activating it (2026-08-13, project directive:
        // background-only — each connected instance drives its own tab context
        // like "present one tab in Meet"; activation raises the OS window and
        // hijacks the user's foreground). `active:true` here used to steal the
        // window on every worker switch. sendMessage routes by tabId, so the
        // binding is all that's needed. Use `focus_window` if a window really
        // must come forward.
        // Phase 2 (2026-08-15): honor payload.activate for AX/UIA reads that
        // require the tab foregrounded.
        if (payload.activate) {
          try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
        }
        boundTabId = tabId; // B1: SW is the single source of truth for binding
        return { success: true, tabId };
      } catch (err) {
        return { error: 'Failed to switch tab ' + tabId + ': ' + (err.message || err) };
      }
    }
    case 'bind_tab': {
      // B1: explicit binding WITHOUT activating the tab (or with — caller's
      // choice). Sets the routing target so page ops go DIRECT to this tab's
      // content script. No OS focus steal, no activation side effect unless
      // payload.activate is true.
      const tabId = parseInt(payload.tabId, 10);
      if (!tabId || isNaN(tabId)) return { error: 'Invalid tabId: ' + payload.tabId };
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab) return { error: 'No such tab: ' + tabId };
        if (payload.activate) await chrome.tabs.update(tabId, { active: true });
        boundTabId = tabId;
        return { success: true, tabId, url: tab.url || '', title: tab.title || '' };
      } catch (err) {
        return { error: 'Failed to bind tab ' + tabId + ': ' + (err.message || err) };
      }
    }
    case 'get_bound_tab': {
      // B1: pure SW-state read — sub-ms, no chrome.tabs.get round trip.
      return { success: true, tabId: boundTabId };
    }
    case 'list_windows': {
      // B3 (2026-08-10): every Chrome window + its tabs in ONE call.
      const wins = await chrome.windows.getAll({ populate: true });
      return { success: true, count: wins.length, windows: wins.map((w) => ({
        id: w.id, focused: w.focused, type: w.type, state: w.state || 'normal',
        tabs: (w.tabs || []).map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
      })) };
    }
    case 'focus_window': {
      // B3: bring a Chrome window to the foreground (used for multi-window
      // flows; harmless because Chrome windows are ours to manage).
      const wid = parseInt(payload.windowId, 10);
      if (!wid || isNaN(wid)) return { error: 'Invalid windowId' };
      await chrome.windows.update(wid, { focused: true });
      return { success: true, windowId: wid };
    }
    case 'move_tab_to_window': {
      // B3: relocate a tab into another window (merge tabs across windows).
      const tid = parseInt(payload.tabId, 10);
      const wid = parseInt(payload.windowId, 10);
      if (!tid || !wid || isNaN(tid) || isNaN(wid)) return { error: 'tabId and windowId required' };
      const moved = await chrome.tabs.move(tid, { windowId: wid, index: -1 });
      boundTabId = moved && moved.id != null ? moved.id : boundTabId;
      return { success: true, tabId: moved && moved.id, windowId: wid };
    }
    case 'transfer_text': {
      // B2 (2026-08-10): THE COMPOUND CROSS-TAB OP — the 1-2s copy-paste cycle.
      // ONE atomic extension-side op: read text from fromTab/fromSelector,
      // activate toTab, write the value into toSelector, verify. Zero LLM hops
      // between steps. Extension-side target <100ms; whole MCP cycle 1-2s.
      const fromTab = parseInt(payload.fromTab, 10);
      const toTab = parseInt(payload.toTab, 10);
      if (!fromTab || !toTab || isNaN(fromTab) || isNaN(toTab)) return { error: 'fromTab and toTab required' };
      if (!payload.fromSelector || !payload.toSelector) return { error: 'fromSelector and toSelector required' };
      try {
        const t0 = Date.now();
        // NOTE: chrome.tabs.sendMessage resolves with the content-script's
        // envelope {type,id,success,data} — always unwrap .data (the v2
        // read_selector/write_selector helpers put their result there).
        const unwrap = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' && 'success' in r.data) ? r.data : (r || {});
        // 1. READ from the source tab (~10ms)
        const readRaw = await chrome.tabs.sendMessage(fromTab, { type: 'read_selector', selector: payload.fromSelector })
          .catch((e) => ({ success: false, error: 'read: ' + (e.message || e) }));
        const read = unwrap(readRaw);
        if (!read || read.success !== true) return { error: 'read failed: ' + ((read && read.error) || 'unknown') };
        const text = payload.useValue ? (read.value != null ? String(read.value) : '') : (read.text || '');
        // 2. WRITE into the destination (~10ms) — no activation needed, no OS
        //    focus steal (2026-08-13, project directive: background-only)
        boundTabId = toTab;
        // 3. WRITE into the destination (~10ms) — React-safe native setter
        const writeRaw = await chrome.tabs.sendMessage(toTab, { type: 'write_selector', selector: payload.toSelector, value: text })
          .catch((e) => ({ success: false, error: 'write: ' + (e.message || e) }));
        const write = unwrap(writeRaw);
        if (!write || write.success !== true) return { error: 'write failed: ' + ((write && write.error) || 'unknown') };
        // 4. VERIFY (~10ms) — read back the destination value
        const verifyRaw = await chrome.tabs.sendMessage(toTab, { type: 'read_selector', selector: payload.toSelector })
          .catch((e) => ({ success: false, error: 'verify: ' + (e.message || e) }));
        const verify = unwrap(verifyRaw);
        const actual = verify && verify.success ? (verify.value != null ? String(verify.value) : (verify.text || '')) : '';
        const ok = actual === text;
        const elapsed = Date.now() - t0;
        return { success: true, copied: text.slice(0, 200), pasted: actual.slice(0, 200), verified: ok, elapsedMs: elapsed, tabId: toTab };
      } catch (err) {
        return { error: 'transfer_text failed: ' + (err.message || err) };
      }
    }
    case 'switch_tab_and_read': {
      // B2: switch + extract in ONE call — no separate read round trip.
      const tabId = parseInt(payload.tabId, 10);
      if (!tabId || isNaN(tabId)) return { error: 'Invalid tabId' };
      try {
        // B2: switch + read in ONE call — bind the tab WITHOUT activating it
        // (background-only; activation raises the OS window — project directive 2026-08-13)
        boundTabId = tabId;
        const resRaw = await chrome.tabs.sendMessage(tabId, { type: 'read_selector', selector: payload.selector || 'body' })
          .catch((e) => ({ success: false, error: 'read: ' + (e.message || e) }));
        const unw = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' && 'success' in r.data) ? r.data : (r || {});
        return { success: true, tabId, ...(unw(resRaw) || {}) };
      } catch (err) {
        return { error: 'switch_tab_and_read failed: ' + (err.message || err) };
      }
    }
    case 'close_tab': {
      const tabId = parseInt(payload.tabId, 10);
      if (!tabId || isNaN(tabId)) return { error: 'Invalid tabId: ' + payload.tabId };
      try {
        await chrome.tabs.remove(tabId);
        if (boundTabId === tabId) boundTabId = null; // B1: invalidate on close
        return { success: true, tabId };
      }
      catch (err) { return { error: 'Failed to close tab ' + tabId + ': ' + (err.message || err) }; }
    }
    case 'open_new_tab': {
      // BACKGROUND OPEN (2026-08-13, project directive): create without activating
      // so a new tab never steals the OS foreground. Content script injects
      // and the bound-tab routing works on background tabs.
      const tab = await chrome.tabs.create({ url: payload.url, active: false });
      boundTabId = tab.id; // B1: new tab becomes the binding
      return { success: true, tabId: tab.id, background: true };
    }
    case 'navigate_current_tab': {
      // Prefer the SW's bound tab (single source of truth — multi-window
      // latch-proof). Falls back to the OS-active tab for fresh sessions.
      let tab = null;
      const want = payload.tabId ? parseInt(payload.tabId, 10) : boundTabId;
      if (want) {
        try { tab = await chrome.tabs.get(want); } catch (_) { tab = null; }
      }
      if (!tab) tab = await getActiveTab();
      if (!tab) return { error: 'No active tab' };
      try {
        // BACKGROUND NAVIGATION (2026-08-13, project directive): do NOT activate
        // the tab. `active:true` raises the Chrome window to the OS foreground
        // on every navigation — the #1 source of "foreground hijacking" when
        // factory workers navigate their own tabs. Content scripts inject
        // into ALL tabs (<all_urls>, all_frames), and sendMessage targets by
        // tabId — activation is NEVER required for navigation to work.
        await chrome.tabs.update(tab.id, { url: payload.url });
        boundTabId = tab.id; // B1
        return { success: true, tabId: tab.id, reused: true, background: true };
      } catch (err) {
        return { error: 'Failed to navigate tab: ' + (err.message || err) };
      }
    }
    case 'get_tab_info': {
      const tab = await chrome.tabs.get(payload.tabId);
      return { success: true, url: (tab && tab.url) || '', title: (tab && tab.title) || '' };
    }
    case 'list_frames': {
      const tab = await getActiveTab();
      if (!tab) return { error: 'No active tab' };
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      return { success: true, tabId: tab.id, frames: (frames || []).map((f) => ({ frameId: f.frameId, url: f.url || '', parentFrameId: f.parentFrameId, errorOccurred: !!f.errorOccurred })) };
    }
    case 'tab_contents':
    case 'accordion_contents': {
      // 2026-08-31 post-reload verification: the CS direct-WS path has
      // tab_contents/accordion_contents, and the hub classifies them as PAGE
      // ops — but when the bound tab's content script is momentarily down the
      // hub falls back to the offscreen, which relays here as TAB_CONTROL.
      // The SW had no case → 'Unknown tab action'. Forward to the bound
      // tab's content script via PAGE_CONTROL (same relay PAGE ops use).
      const tab = await getActiveTab();
      if (!tab) return { error: 'No active tab for ' + action };
      try {
        const resRaw = await chrome.tabs.sendMessage(tab.id, { type: action });
        const unw = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' && 'success' in r.data) ? r.data : (r || {});
        return unw(resRaw);
      } catch (err) {
        return { error: action + ' failed: ' + (err.message || err) };
      }
    }
    case 'download_state': {
      const items = await chrome.downloads.search({});
      return { success: true, downloads: (items || []).slice(0, 20).map((d) => ({ id: d.id, filename: d.filename, url: d.url, state: d.state, endTime: d.endTime || null, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes })) };
    }
    case 'download_op': {
      // P2 downloads manager (2026-08-31): cancel / pause / resume / remove /
      // list by id or state. chrome.downloads lives in the SW.
      const op = (payload && payload.op) || 'list';
      try {
        if (op === 'cancel') {
          await chrome.downloads.cancel(payload.id);
          return { success: true, op, id: payload.id };
        }
        if (op === 'pause') {
          await chrome.downloads.pause(payload.id);
          return { success: true, op, id: payload.id };
        }
        if (op === 'resume') {
          await chrome.downloads.resume(payload.id);
          return { success: true, op, id: payload.id };
        }
        if (op === 'remove') {
          await chrome.downloads.removeFile(payload.id).catch(() => {});
          await chrome.downloads.erase({ id: payload.id }).catch(() => {});
          return { success: true, op, id: payload.id };
        }
        // list (default): recent downloads, newest first
        const items = await chrome.downloads.search({ limit: payload.limit || 25 });
        return { success: true, op: 'list', downloads: (items || []).map((d) => ({ id: d.id, filename: d.filename, url: d.url, state: d.state, mime: d.mime || null, startTime: d.startTime || null, endTime: d.endTime || null, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, error: d.error || null })) };
      } catch (err) {
        return { success: false, error: 'download_op failed: ' + (err.message || err) };
      }
    }
    case 'cookie_op': {
      // P2 cookies tool (2026-08-31): list / get-value / clear cookies for a
      // domain. chrome.cookies lives in the SW — this is the SW-side impl.
      // Values ARE returned for get (needed for session transplant); the
      // doctor stays metadata-only for diagnostics.
      const op = (payload && payload.op) || 'list';
      const url = payload && payload.url;
      try {
        if (!url || !/^https?:/.test(url)) return { success: false, error: 'cookie_op requires an http(s) url' };
        const u = new URL(url);
        const domain = payload.domain || u.hostname;
        if (op === 'clear') {
          const removed = await chrome.cookies.remove({ url: url, name: payload.name });
          return { success: true, removed: !!removed, name: payload.name, domain };
        }
        if (op === 'clear_all') {
          const all = await chrome.cookies.getAll({ domain: domain });
          let removedCount = 0;
          for (const c of all) {
            try { await chrome.cookies.remove({ url: 'https://' + domain + c.path, name: c.name }); removedCount++; } catch (_) {}
            try { await chrome.cookies.remove({ url: 'http://' + domain + c.path, name: c.name }); } catch (_) {}
          }
          return { success: true, removedCount, domain };
        }
        // list | get
        const all = await chrome.cookies.getAll({ domain: domain });
        if (op === 'get') {
          const c = all.find((x) => x.name === payload.name) || null;
          return { success: true, domain, cookie: c ? { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, session: !c.expirationDate, expirationDate: c.expirationDate || null } : null };
        }
        return { success: true, domain, cookies: all.map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, session: !c.expirationDate, expiresInDays: c.expirationDate ? Math.max(-1, Math.round((c.expirationDate * 1000 - Date.now()) / 86400000)) : null })) };
      } catch (err) {
        return { success: false, error: 'cookie_op failed: ' + (err.message || err) };
      }
    }
    case 'doctor': {
      // SW + site diagnostics: alarms, cookies (names + expiry ONLY — never
      // values), extension ID. Local-only; nothing leaves the machine.
      let alarms = [];
      try { alarms = await chrome.alarms.getAll(); } catch (_) {}
      let cookies = { error: 'cookies API unavailable' };
      try {
        if (chrome.cookies) {
          const tab = await getActiveTab();
          if (tab && tab.url && /^https?:/.test(tab.url)) {
            const u = new URL(tab.url);
            const all = await chrome.cookies.getAll({ domain: u.hostname });
            cookies = {
              domain: u.hostname,
              count: all.length,
              cookies: all.map((c) => ({
                name: c.name,
                domain: c.domain,
                secure: c.secure,
                httpOnly: c.httpOnly,
                session: !c.expirationDate,
                expiresInDays: c.expirationDate ? Math.max(-1, Math.round((c.expirationDate * 1000 - Date.now()) / 86400000)) : null,
              })),
            };
          } else {
            cookies = { error: 'No http(s) active tab' };
          }
        }
      } catch (err) {
        cookies = { error: String((err && err.message) || err) };
      }
      return {
        success: true,
        extensionId: chrome.runtime.id,
        swAlive: true,
        alarms: alarms.map((a) => ({ name: a.name, periodInMinutes: a.periodInMinutes, scheduledTime: a.scheduledTime })),
        cookies,
      };
    }
    default:
      return { error: 'Unknown tab action: ' + action };
  }
}

// ═══ AUTO-CONNECT: Create offscreen immediately on install/startup ═══
// The offscreen document will try to connect to ws://localhost:38401
// If the MCP server isn't running yet, it retries every 3 seconds.

chrome.runtime.onInstalled.addListener(() => {
  registerConsoleHook();
  setupOffscreen().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  registerConsoleHook();
  setupOffscreen().catch(() => {});
});

// Also try on service worker wake — MV3 kills service workers, so we need
// to recreate the offscreen when the service worker restarts
setupOffscreen().catch(() => {});
registerConsoleHook();

// ═══ AX BRIDGE via chrome.debugger (Phase 4, 2026-08-15) ═══
// chrome.debugger is only available in the background service worker.
// The offscreen forwards ax_* ops here for CDP-based AX tree access.
// Stable Chrome compatible — no dev-channel flags needed.

function axAttach(tabId) {
  return new Promise(function(resolve, reject) {
    try {
      chrome.debugger.attach({tabId: tabId}, "1.3", function() {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve();
      });
    } catch(e) { reject(e); }
  });
}

function axDetach(tabId) {
  return new Promise(function(resolve) {
    try {
      chrome.debugger.detach({tabId: tabId}, function() { resolve(); });
    } catch(e) { resolve(); }
  });
}

function axSendCommand(tabId, method, params) {
  return new Promise(function(resolve, reject) {
    try {
      chrome.debugger.sendCommand({tabId: tabId}, method, params, function(result) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(result || {});
      });
    } catch(e) { reject(e); }
  });
}

async function axGetTree(tabId) {
  await axAttach(tabId);
  try {
    var result = await axSendCommand(tabId, "Accessibility.getFullAXTree", {});
    return result.nodes || [];
  } finally {
    await axDetach(tabId);
  }
}

function axNodeToObj(node) {
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

async function axRead(tabId, opts) {
  opts = opts || {};
  var nodes = await axGetTree(tabId);
  var filter = (opts.role || '').toLowerCase();
  var nameMatch = (opts.name || '').toLowerCase();
  var nameContains = (opts.nameContains || '').toLowerCase();
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    if (out.length >= 500) break;
    var n = nodes[i];
    var role = n.role ? (n.role.value || n.role || '').toLowerCase() : '';
    var name = n.name ? (n.name.value || n.name || '').toLowerCase() : '';
    var hit = true;
    if (filter && role !== filter) hit = false;
    if (nameMatch && name !== nameMatch) hit = false;
    if (nameContains && name.indexOf(nameContains) === -1) hit = false;
    if (hit) out.push(axNodeToObj(n));
  }
  return { tabId: tabId, matched: out.length, nodes: out };
}

async function axFindNode(nodes, match) {
  var role = (match.role || '').toLowerCase();
  var name = (match.name || '').toLowerCase();
  var nameContains = (match.nameContains || '').toLowerCase();
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var r = n.role ? (n.role.value || n.role || '').toLowerCase() : '';
    var nm = n.name ? (n.name.value || n.name || '').toLowerCase() : '';
    var okRole = !role || r === role;
    var okName = !name || nm === name;
    var okContains = !nameContains || nm.indexOf(nameContains) !== -1;
    if (okRole && (okName || okContains)) return n;
  }
  return null;
}

async function axClick(tabId, match) {
  var nodes = await axGetTree(tabId);
  var node = await axFindNode(nodes, match);
  if (!node) return { success: false, error: 'AX node not found: ' + JSON.stringify(match) };
  if (!node.backendDOMNodeId) return { success: false, error: 'AX node has no backend DOM node' };
  await axAttach(tabId);
  try {
    var resolved = await axSendCommand(tabId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
    if (!resolved || !resolved.object || !resolved.object.objectId) {
      return { success: false, error: 'Could not resolve DOM node' };
    }
    await axSendCommand(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function() { this.click(); }",
      returnByValue: true
    });
    return { success: true, role: node.role ? node.role.value : 'unknown', name: node.name ? node.name.value : '' };
  } finally {
    await axDetach(tabId);
  }
}

async function axType(tabId, match, text) {
  var nodes = await axGetTree(tabId);
  var node = await axFindNode(nodes, match);
  if (!node) return { success: false, error: 'AX node not found: ' + JSON.stringify(match) };
  if (!node.backendDOMNodeId) return { success: false, error: 'AX node has no backend DOM node' };
  await axAttach(tabId);
  try {
    var resolved = await axSendCommand(tabId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
    if (!resolved || !resolved.object || !resolved.object.objectId) {
      return { success: false, error: 'Could not resolve DOM node' };
    }
    await axSendCommand(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(v) { this.value = v; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }",
      arguments: [{ value: text }],
      returnByValue: true
    });
    return { success: true, role: node.role ? node.role.value : 'unknown', name: node.name ? node.name.value : '' };
  } finally {
    await axDetach(tabId);
  }
}

async function axState(tabId) {
  try {
    var nodes = await axGetTree(tabId);
    return { success: true, nodeCount: nodes.length, nodes: nodes.slice(0, 100).map(axNodeToObj) };
  } catch (e) {
    return { success: false, error: String(e && e.message || e) };
  }
}

async function handleAxControl(message) {
  var tabId = message.tabId || null;
  if (tabId == null) return { error: 'ax_* requires an explicit tabId' };
  switch (message.axType) {
    case 'ax_state': return await axState(tabId);
    case 'ax_read': return await axRead(tabId, message);
    case 'ax_click': return await axClick(tabId, message.match || {});
    case 'ax_type': return await axType(tabId, message.match || {}, message.text || '');
    default: return { error: 'Unknown ax op: ' + message.axType };
  }
}

// Keep the offscreen (and therefore the WS bridge) alive across MV3 SW
// deaths. setInterval dies with the SW, so we use chrome.alarms, which
// survives SW teardown and wakes the SW to respawn the offscreen.
// NOTE: periodInMinutes minimum is 0.5 — 0.3 throws and kills the listener.
chrome.alarms.create('websense-keepalive', { periodInMinutes: 0.5 }); // 30s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'websense-keepalive') {
    // KEEPALIVE = PING the offscreen, don't just (re)create it. MV3 suspends
    // offscreen documents after ~30s of inactivity even with an open WS — a
    // suspended offscreen runs NO JS (no reconnect loop, no watchdog), so the
    // hub looks disconnected forever. A chrome.runtime.sendMessage to the
    // offscreen WAKES it (message events wake the document) and verifies it
    // answers. Only when the probe fails (dead/zombie/missing) do we
    // force-recreate. (Ali 2026-08-12: 'the hub should never disconnect' —
    // this is the missing keep-alive that makes recovery automatic.)
    (async () => {
      const alive = await new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 1500);
        try {
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROBE' }).then((resp) => {
            if (done) return;
            done = true; clearTimeout(t); resolve(!!(resp && resp.alive));
          }).catch(() => { if (!done) { done = true; clearTimeout(t); resolve(false); } });
        } catch (_) { if (!done) { done = true; clearTimeout(t); resolve(false); } }
      });
      if (!alive) {
        console.warn('[websense-bg] keepalive: offscreen not responding — recreating');
        // Close any zombie first (unconditional — the probe may have hit a
        // dead context that never answers), then create fresh.
        try { await chrome.offscreen.closeDocument(); } catch (_) {}
        await setupOffscreen();
      }
      // If alive: the message itself kept it awake; nothing else needed.
    })();
  }
});
