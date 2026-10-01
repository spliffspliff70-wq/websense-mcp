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

// ═══ MAIN-world network hook (2026-09-25) ═══
// Same world split the console hook documents: page fetch/XHR live in the MAIN
// world, so the content script's own copy of window.fetch is never called by
// page code and network_log stayed empty. network-hook.js is registered the
// same way and writes its ring buffer onto #__ws_net_buffer for the CS to read.
async function registerNetworkHook() {
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'ws-network-hook',
      matches: ['<all_urls>'],
      js: ['network-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    }]);
  } catch (e) {
    // Duplicate ID → already registered; otherwise network_log degrades to
    // isolated-world capture (empty on real pages, which is the old behaviour).
  }
}

// 2026-09-25: same MAIN-world pattern for alert/confirm/prompt. The content
// script's isolated-world override never saw the page's own dialogs (measured:
// a real alert() left pendingDialogs:[]), and in a background tab Chrome
// silently auto-dismisses them — so the page continued with no agent able to
// see or answer. The hook publishes to a DOM attribute the CS reads.
async function registerDialogHook() {
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'ws-dialog-hook',
      matches: ['<all_urls>'],
      js: ['dialog-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    }]);
  } catch (e) {
    // Duplicate ID → already registered.
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

// EXPLICIT-BIND LATCH (fixed 2026-09-21). `bind` is documented as "routes page
// ops to a tab WITHOUT focus — page ops NEVER need activation", but onActivated
// below overwrote boundTabId on EVERY tab switch, so any user (or another
// session) activating a tab silently retargeted every subsequent page op.
// Measured consequences: `tabs{bind}` appeared to work and then resolved
// "ref not found" for elements that demonstrably existed, because the answer
// came from whichever tab was last activated; and a `navigate` meant to reload
// one page loaded a DIFFERENT tab instead (Ali: "it still loaded an x.com over
// lemonsqueezy I had to reopen"). Once a tab is bound EXPLICITLY, activation
// must not steal it. It is released when that tab closes, or replaced by the
// next explicit bind/switch — never by someone else clicking a tab.
let explicitBind = false;

// Restricted-page guard (mirrors offscreen.js). Content scripts cannot run on
// chrome://, chrome-extension://, about:, edge://, file:// — page ops into
// those must fall back to a real http(s) tab.
function isContentScriptAllowed(url) {
  if (!url) return false;
  return ![/^chrome:\/\//, /^chrome-extension:\/\//, /^about:/, /^edge:\/\//, /^file:\/\//].some(function (p) { return p.test(url); });
}

// ═══ 2026-09-11c: TAB-HOP GUARDS (unhandled-rejection fix + fast-fail) ═══
// chrome.tabs.sendMessage rejects with "Could not establish connection.
// Receiving end does not exist." whenever the target tab has no LIVE content
// script (never injected / page navigated away / tab closed). If any call site
// lets that rejection escape, the SW console fills with `Uncaught (in promise)`
// noise that masks real errors. isNoReceivingEnd() recognises the class;
// sendMsgError() turns ANY sendMessage rejection into a structured, hop-naming
// object so the caller learns WHICH hop broke instead of a bare message.
function isNoReceivingEnd(err) {
  var m = String((err && err.message) || err || '');
  return /receiving end does not exist|could not establish connection|message port closed|no tab with id|tab was closed/i.test(m);
}

function sendMsgError(err, tabId, hop) {
  var m = String((err && err.message) || err || 'unknown error');
  var tid = (tabId === undefined) ? null : tabId;
  if (isNoReceivingEnd(err)) {
    return {
      success: false,
      error: 'no-receiving-end',
      tabId: tid,
      hop: hop || 'bg->content-script',
      hint: 'No live content script in tab ' + tid + ' (not injected, page navigated away, or tab closed). Reload the page or rebind the tab (tabs{action:"switch"}), then retry.',
      message: m,
    };
  }
  return { success: false, error: 'send-failed', tabId: tid, hop: hop || 'bg->content-script', message: m };
}

// FAST-FAIL pre-flight for page/content ops. Cheap: ONE chrome.tabs.get — no
// script injection, no poll loop. It fails a page op in ~1ms with the NAMED hop
// when the target tab cannot possibly answer, instead of hanging for the hub's
// 30s (90s for some ops) timeout. tabs.get is used deliberately: tab enumeration
// via tabs.query has been observed to throw 'Extension context invalidated'
// after a SW context loss, while tabs.get stays robust.
// Returns { ok:true, tab } on success, else
//   { success:false, error:'content-script-not-ready', tabId, url, status, reason, hop, hint }.
async function checkContentScriptReady(tabId) {
  var id = (tabId === undefined || tabId === null || tabId === '') ? null : Number(tabId);
  if (!id || isNaN(id)) {
    return { success: false, error: 'content-script-not-ready', tabId: id, url: null, status: null,
             reason: 'no-tab-id', hop: 'bg->chrome.tabs',
             hint: 'No target tab id — bind a tab first (tabs{action:"switch"}).' };
  }
  var tab = null;
  try {
    tab = await chrome.tabs.get(id);
  } catch (e) {
    return { success: false, error: 'content-script-not-ready', tabId: id, url: null, status: null,
             reason: 'no-such-tab', hop: 'bg->chrome.tabs',
             hint: 'Tab ' + id + ' no longer exists (closed). List tabs (tabs{action:"list"}) and rebind.' };
  }
  var url = (tab && tab.url) || '';
  // (b) URLs where a content script can NEVER run. isContentScriptAllowed covers
  // chrome:// chrome-extension:// edge:// about: file://; add the Web Store.
  var webStore = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);
  if (!isContentScriptAllowed(url) || webStore) {
    return { success: false, error: 'content-script-not-ready', tabId: id, url: url, status: (tab && tab.status) || null,
             reason: 'restricted-url', hop: 'bg->chrome.tabs',
             hint: 'Content scripts never run on ' + url + ' (chrome://, chrome-extension://, edge://, about:, file:// or the Web Store). Navigate to an http(s) page first.' };
  }
  // (c) tab still loading — DO NOT hard-fail here (2026-09-11c).
  // A tab reports status='loading' until its load event fires, and a page with a
  // long-polling / streaming / never-finishing subresource can sit at 'loading'
  // indefinitely WHILE its content script is perfectly usable. Hard-blocking would
  // turn working page ops into failures, so this is returned as a WARNING the
  // caller surfaces only if the sendMessage actually fails. The status is still
  // captured, so a real failure names both the hop and the tab state.
  var warning = null;
  if (tab && tab.status && tab.status !== 'complete') {
    warning = { tabStatus: tab.status, note: 'tab reported status=' + tab.status + ' at op time' };
  }
  return { ok: true, tab: tab, loadingWarning: warning };
}

// Invalidate the binding when the bound tab is closed
// the offscreen's cached id used to survive closes and route ops to a dead
// tab, PITFALL 26 class).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === boundTabId) { boundTabId = null; explicitBind = false; }
  // Phase 2 (2026-08-15): tell the offscreen → hub so the hub's tab registry
  // drops the dead content-script client (no routing into a dead tab).
  try {
    chrome.runtime.sendMessage({ type: 'tab_event', event: 'removed', tabId: tabId }).catch(() => {});
  } catch (_) { /* offscreen may not be ready — harmless */ }
});

// Phase 2 (2026-08-15): onActivated keeps the binding live to the tab the
// USER actually switched to — without this the SW's boundTabId could point at
// a stale tab forever (root of PITFALL 16 latch). The offscreen also needs to
// learn of user-driven switches so its getActiveTabId() resolves correctly.
chrome.tabs.onActivated.addListener((activeInfo) => {
  // NEVER let an activation steal an EXPLICIT bind — see the explicitBind note
  // above. The anti-latch concern this listener was added for (PITFALL 16) is
  // still covered: the flag is dropped when the bound tab closes, and every
  // deliberate switch rebinds through switch_to_tab / bind_tab.
  if (!explicitBind) boundTabId = activeInfo.tabId;
  try {
    chrome.runtime.sendMessage({ type: 'tab_event', event: 'activated', tabId: activeInfo.tabId, windowId: activeInfo.windowId }).catch(() => {});
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

// ═══ Await navigation commit (2026-09-11) ═══
// chrome.tabs.update() resolves when the navigation is STARTED, not when the new
// document is live. Callers that read immediately therefore saw the OLD page —
// measured: a `status` call issued right after `navigate` still returned the
// previous URL. That reads as a flaky tool and invites a retry loop, when it is
// really just a race. Wait for the tab to reach 'complete' on the requested URL,
// bounded so a slow page or an unload-blocked one can never hang the call.
function waitForTabCommit(tabId, wantUrl, timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = null;
    function done(res) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (_) {}
      resolve(res);
    }
    function statusOk(tab) {
      var url = (tab && tab.url) || '';
      if (!wantUrl) return true;
      var base = String(wantUrl).split('#')[0];
      return url === wantUrl || url.indexOf(base) === 0;
    }
    function onUpd(id, info, tab) {
      if (id !== tabId || info.status !== 'complete') return;
      if (!statusOk(tab)) return;
      done({ ok: true, url: (tab && tab.url) || null });
    }
    timer = setTimeout(function () {
      chrome.tabs.get(tabId).then(function (t) {
        done({ ok: false, reason: 'timeout', url: (t && t.url) || null });
      }).catch(function () { done({ ok: false, reason: 'timeout', url: null }); });
    }, timeoutMs || 10000);
    try { chrome.tabs.onUpdated.addListener(onUpd); } catch (_) {
      done({ ok: false, reason: 'no-onUpdated', url: null }); return;
    }
    // Fast path: already there (same-URL navigation). Only resolves when the URL
    // ALREADY matches what was requested, so it can never short-circuit a real
    // A→B navigation that is still sitting on A.
    chrome.tabs.get(tabId).then(function (t) {
      if (t && t.status === 'complete' && statusOk(t)) {
        done({ ok: true, url: t.url || null });
      }
    }).catch(function () {});
  });
}

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
  }).map((t) => ({
    id: t.id, url: t.url || '', title: t.title || '', active: t.active,
    // 2026-09-11c: `status` is exposed for attribution. A tab stuck at 'loading'
    // explains a content script that has not registered yet — and it is ALSO why
    // the fast-fail guard must not hard-block on 'loading': pages with
    // long-polling/streaming requests can report 'loading' indefinitely while
    // their content script is perfectly usable.
    status: t.status || null,
  }));
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
    const hop = 'bg->content-script (PAGE_CONTROL:' + action + ')';
    // FAST-FAIL (2026-09-11c): pre-flight the hop so a page op into a dead /
    // restricted / still-loading tab returns content-script-not-ready in ~1ms
    // instead of hanging for the hub timeout. sendMessage is then always
    // awaited inside try/catch → no unhandled rejection can escape the SW.
    (async () => {
      const ready = await checkContentScriptReady(tabId);
      if (!ready.ok) { sendResponse(ready); return; }
      try {
        const resp = await chrome.tabs.sendMessage(tabId, { type: action, ...payload }, frameId !== undefined ? { frameId } : undefined);
        sendResponse(resp);
      } catch (err) {
        const e = sendMsgError(err, tabId, hop);
        // Surface the tab's load state when it was not 'complete' — that is the
        // most common reason a content script is not answering yet.
        if (ready.loadingWarning) { e.tabStatus = ready.tab && ready.tab.status; e.note = ready.loadingWarning.note; }
        sendResponse(e);
      }
    })();
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

// ★ KEEP THE DEBUGGER ATTACHED BRIEFLY (2026-10-01). chrome.debugger.attach is the expensive part
// of a trusted click — measured 5,019ms end to end for one click at a cold attach, essentially all
// of it the attach itself. Attaching per call would make trusted input unusable in any loop, so an
// attachment is REUSED for 25s of inactivity and then detached on a timer: the infobar does not
// linger, the tab is left clean, and a burst of clicks pays the attach once.
const __dbgAttached = new Map();   // tabId -> { timer }
function __dbgKeepAlive(tabId) {
  const prev = __dbgAttached.get(tabId);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const timer = setTimeout(function () {
    __dbgAttached.delete(tabId);
    try { chrome.debugger.detach({ tabId: tabId }, function () {}); } catch (_) {}
  }, 25000);
  __dbgAttached.set(tabId, { timer: timer });
}
try {
  if (chrome.debugger && chrome.debugger.onDetach) {
    chrome.debugger.onDetach.addListener(function (source) {
      const id = source && source.tabId;
      const rec = id != null ? __dbgAttached.get(id) : null;
      if (rec && rec.timer) clearTimeout(rec.timer);
      if (id != null) __dbgAttached.delete(id);
    });
  }
} catch (_) {}

// ★ ONE PREPARATION FOR EVERY TRUSTED-INPUT OP (2026-10-01).
// Attach, keep-alive, and the two emulation calls that make a BACKGROUND renderer behave as
// focused and active. Both are needed by every trusted op, and a second copy of this is a second
// chance to get it wrong — the failure mode this codebase has paid for most often. A new trusted
// op (keyboard, paste, drag) calls this; it does not re-implement it.
async function __dbgPrepare(tabId) {
  const out = { attached: false, attachMs: 0, emulation: {} };
  if (!__dbgAttached.has(tabId)) {
    const tA = Date.now();
    try { await chrome.debugger.attach({ tabId }, '1.3'); out.attached = true; }
    catch (e) {
      const m = String((e && e.message) || e);
      if (!/already attached/i.test(m)) throw e;   // someone else's attachment is also fine
    }
    out.attachMs = Date.now() - tA;
  }
  __dbgKeepAlive(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    out.emulation.focusEmulation = true;
  } catch (e) { out.emulation.focusEmulationError = String((e && e.message) || e); }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' });
    out.emulation.lifecycle = 'active';
  } catch (e) { out.emulation.lifecycleError = String((e && e.message) || e); }
  return out;
}

async function handleTabControl(action, payload) {
  switch (action) {
    case 'main_world_exec': {
      // MAIN-world toolkit (F12-insider path, 2026-09-01, Ali directive):
      // run model-supplied function SOURCE in the page's main world via
      // chrome.userScripts.execute({world:'MAIN'}) — arbitrary code strings,
      // extension-injected so PAGE CSP does not apply (content-script class
      // injection). NOT CDP (no debug port), NOT page eval.
      // NOTE: scripting.executeScript({func}) was rejected — building a
      // function object from source needs new Function() which MV3 SW CSP
      // blocks (EvalError). userScripts.execute takes raw code instead.
      const mwTabId = parseInt(payload.tabId, 10);
      if (!mwTabId) return { error: 'main_world_exec: tabId required' };
      if (!payload.func) return { error: 'main_world_exec: func (function expression source) required' };
      if (!chrome.userScripts) {
        return { error: 'main_world_exec: chrome.userScripts unavailable — requires Chrome 135+ with Developer Mode enabled (unpacked extensions have it)' };
      }
      try {
        const argsJson = JSON.stringify(Array.isArray(payload.args) ? payload.args : []);
        const code = '(function(){ try { var __args = ' + argsJson + ';'
          + ' var __fn = (' + payload.func + ');'
          + ' var __r = __fn.apply(null, __args);'
          + ' return JSON.stringify({ ok: true, result: __r === undefined ? null : __r });'
          + ' } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); } })()';
        const results = await chrome.userScripts.execute({
          target: { tabId: mwTabId, allFrames: !!payload.allFrames },
          world: 'MAIN',
          js: [{ code }],
        });
        const out = (results || []).map((r) => {
          let parsed = null;
          try { parsed = JSON.parse(r.result); } catch (_) { parsed = { ok: true, result: r.result }; }
          return {
            frameId: r.frameId === undefined ? null : r.frameId,
            result: parsed && parsed.ok ? parsed.result : null,
            error: (parsed && !parsed.ok && parsed.error) || r.error || null,
          };
        });
        return { success: true, results: out };
      } catch (e) {
        return { error: 'main_world_exec failed: ' + (e && e.message ? e.message : String(e)) };
      }
    }
    case 'trusted_click': {
      // ★ A GENUINELY TRUSTED CLICK, IN THE BACKGROUND (2026-10-01, Ali: "verify and register
      // exactly how a human click is registered in the website code and simulate it in code
      // background and implement when you find something that works 1:1 identical").
      //
      // WHY THIS EXISTS: a content-script click is dispatchEvent(), and an untrusted event runs NO
      // default action — no navigation, no focus, no checkbox toggle — and carries zeros where a
      // real input carries state (buttons, clickCount, pointerId, pressure). Measured on
      // bench/click_fingerprint.html: the synthetic sequence reports isTrusted:false, detail:0,
      // click clientX/Y 0,0 and no buttons/pointerId at all, while a real mouse reports
      // isTrusted:true with the full field set. Input.dispatchMouseEvent goes through the
      // browser's OWN input pipeline, so the page receives the same trusted record a real mouse
      // produces and default actions RUN — and it needs NO OS focus and NO window activation, so
      // it works on a background tab.
      //
      // chrome.debugger is already used in this file (the screenshot fallback), the 'debugger'
      // permission is already declared, and the offscreen relay cannot do this (no debugger API
      // there) — hence the SW.
      const tClick = parseInt(payload.tabId, 10);
      if (!tClick) return { error: 'trusted_click: tabId required' };
      const cx = Number(payload.x), cy = Number(payload.y);
      if (!isFinite(cx) || !isFinite(cy)) return { error: 'trusted_click: x and y (viewport CSS px) required' };
      const btn = payload.button || 'left';
      const mask = btn === 'left' ? 1 : btn === 'right' ? 2 : 4;
      const count = Number(payload.clickCount) || 1;
      const mods = Number(payload.modifiers) || 0;
      const t0 = Date.now();
      let didAttach = false;
      let attachMs = 0;
      let ok = false;
      try {
        // ★ THE PREPARATION IS SHARED WITH EVERY OTHER TRUSTED OP (__dbgPrepare).
        // What it does and why it is not optional: on a background tab the page reports
        // document.visibilityState:'hidden', mouseMoved took ~5,080ms to return (renderer
        // throttling) and the PRESS WAS DROPPED ENTIRELY — no pointerdown/mousedown/click arrived,
        // so a "trusted" click did nothing while its transport envelope said success. After
        // Emulation.setFocusEmulationEnabled(true) + Page.setWebLifecycleState('active') the same
        // click is ~151ms and lands, and it needs NO bring-to-front — the user's active tab is
        // never touched.
        const prep = await __dbgPrepare(tClick);
        didAttach = prep.attached;
        attachMs = prep.attachMs;
        const emu = prep.emulation;
        const base = { x: cx, y: cy, button: btn, clickCount: count, pointerType: 'mouse', modifiers: mods };
        const gap = (ms) => new Promise((r) => setTimeout(r, ms));
        const tMove = Date.now();
        // A real mouse ARRIVES at the point before pressing. The move is load-bearing: it is what
        // applies :hover and feeds mousemove-driven UI, so the press lands on the state a user
        // would have been looking at.
        await chrome.debugger.sendCommand({ tabId: tClick }, 'Input.dispatchMouseEvent',
          Object.assign({ type: 'mouseMoved', buttons: 0 }, base));
        // ★ AND IT TAKES TIME TO PRESS (2026-10-01). Firing move→press→release in the same tick
        // meant Chrome's input pipeline coalesced the press away: the page received
        // pointerover/pointermove and NO pointerdown/mousedown/click at all — measured on
        // bench/click_fingerprint.html. A human has tens of milliseconds of real time between
        // arriving and pressing; the gaps below are that time, and they are what makes the press
        // real. (Gap is overridable for tests, never zero.)
        await gap(Number(payload.movePressGapMs) || 60);
        const tPress = Date.now();
        await chrome.debugger.sendCommand({ tabId: tClick }, 'Input.dispatchMouseEvent',
          Object.assign({ type: 'mousePressed', buttons: mask }, base));
        await gap(Number(payload.pressReleaseGapMs) || 40);
        await chrome.debugger.sendCommand({ tabId: tClick }, 'Input.dispatchMouseEvent',
          Object.assign({ type: 'mouseReleased', buttons: 0 }, base));
        ok = true;
        return { success: true, mode: 'trusted', via: 'Input.dispatchMouseEvent',
                 x: cx, y: cy, button: btn, clickCount: count,
                 ms: Date.now() - t0, emulation: emu,
                 timings: { totalMs: Date.now() - t0, attachMs: attachMs, moveToPressMs: tPress - tMove } };
      } catch (e) {
        return { error: 'trusted_click failed: ' + String((e && e.message) || e) };
      } finally {
        // On SUCCESS the attachment is kept briefly (see __dbgKeepAlive) so a loop of trusted
        // clicks pays the ~5s attach once. On FAILURE it is released immediately — a broken
        // attachment must not sit there holding the infobar.
        if (!ok && didAttach) { try { await chrome.debugger.detach({ tabId: tClick }); } catch (_) {} }
      }
    }
    case 'trusted_key': {
      // ★ A GENUINELY TRUSTED KEY, IN THE BACKGROUND (2026-10-01).
      // Same reason as trusted_click: a synthetic KeyboardEvent is untrusted, so it reaches the
      // page's listeners and the browser runs NO DEFAULT ACTION. Measured on en.wikipedia.org: a
      // dispatched Enter arrived with the right target ({key:'Enter', trusted:false}) and the form
      // did NOT submit — and the old code worked around that by calling form.requestSubmit()
      // itself, which is a GUESS about what the page would have done. Input.dispatchKeyEvent goes
      // through the browser's own input pipeline, so the default action belongs to the browser.
      //
      // TWO SHAPES, one round trip each: payload.text types a string key by key (a form fill is
      // one call, not one call per character), and payload.key presses a single named key. Both
      // can be given together — the usual "fill this field and press Enter".
      const tKey = parseInt(payload.tabId, 10);
      if (!tKey) return { error: 'trusted_key: tabId required' };
      const named = payload.key ? String(payload.key) : '';
      const text = (payload.text === undefined || payload.text === null) ? '' : String(payload.text);
      if (!named && !text) return { error: 'trusted_key: pass key and/or text' };
      const mods = Number(payload.modifiers) || 0;
      const t0 = Date.now();
      let prep = null, ok = false, focusResult = null;
      try {
        prep = await __dbgPrepare(tKey);
        // The renderer routes key events to its FOCUSED element, so the target must be focused
        // first. focus() is a DOM call, not a key press — it needs no input pipeline and no OS
        // focus — and the result is reported so a caller can tell "focused" from "refused".
        if (payload.selector) {
          const sel = JSON.stringify(String(payload.selector));
          const r = await chrome.debugger.sendCommand({ tabId: tKey }, 'Runtime.evaluate', {
            expression: '(function(){var e=document.querySelector(' + sel + ');'
              + ' if(!e) return "not-found"; try { e.focus(); } catch (x) { return "focus-threw"; }'
              + ' return (document.activeElement===e) ? "focused" : "focus-refused";})()',
            returnByValue: true,
          });
          focusResult = r && r.result ? r.result.value : null;
        }
        // key / code / virtual-key for a printable character. US layout — what the renderer assumes.
        const VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38,
          ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33,
          PageDown: 34, ' ': 32 };
        const forChar = (ch) => {
          if (ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z') {
            return { key: ch, code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: ch };
          }
          if (ch >= '0' && ch <= '9') return { key: ch, code: 'Digit' + ch, vk: ch.charCodeAt(0), text: ch };
          return { key: ch, code: '', vk: 0, text: ch };
        };
        const forName = (k) => {
          if (VK[k] === undefined) return { key: k, code: k, vk: 0, text: null };
          const t = (k === 'Enter') ? '\r' : (k === 'Tab' ? '\t' : (k === ' ' ? ' ' : null));
          return { key: k, code: (k === ' ') ? 'Space' : k, vk: VK[k], text: t };
        };
        const send = async (type, spec) => {
          const p = { type: type, modifiers: mods, key: spec.key, code: spec.code,
            windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
          if (type !== 'keyUp' && spec.text !== null && spec.text !== undefined) {
            p.text = spec.text; p.unmodifiedText = spec.text;
          }
          await chrome.debugger.sendCommand({ tabId: tKey }, 'Input.dispatchKeyEvent', p);
        };
        const press = async (spec) => {
          // A key that produces text is a keyDown WITH text (that is what makes the character
          // appear and what lets the browser see an Enter as a submit); one that does not is a
          // rawKeyDown.
          await send((spec.text === null || spec.text === undefined) ? 'rawKeyDown' : 'keyDown', spec);
          await send('keyUp', spec);
        };
        let typed = 0;
        for (let ci = 0; ci < text.length; ci++) { await press(forChar(text[ci])); typed++; }
        if (named) await press(forName(named));
        ok = true;
        return { success: true, mode: 'trusted', via: 'Input.dispatchKeyEvent',
                 typed: typed, key: named || null, modifiers: mods, focus: focusResult,
                 ms: Date.now() - t0, emulation: prep.emulation,
                 timings: { totalMs: Date.now() - t0, attachMs: prep.attachMs } };
      } catch (e) {
        return { error: 'trusted_key failed: ' + String((e && e.message) || e) };
      } finally {
        if (!ok && prep && prep.attached) { try { await chrome.debugger.detach({ tabId: tKey }); } catch (_) {} }
      }
    }
    case 'trusted_drag': {
      // ★ A TRUSTED DRAG THAT ACTUALLY COMPLETES — AND THE ROOT CAUSE OF WHY IT DID NOT (2026-10-01).
      //
      // WHAT WAS WRONG, MEASURED. The previous version enabled Input.setInterceptDrags(true) and
      // then dispatched its OWN dragEnter/dragOver/drop via Input.dispatchDragEvent at the end.
      // Both halves were wrong:
      //
      // 1. INTERCEPTION KILLS THE DRAG IT WAS MEANT TO DRIVE. With setInterceptDrags(true), the
      //    browser hands the drag to the CLIENT instead of running it: measured on
      //    bench/click_fingerprint.html the page's record STOPS AT dragstart (a single event) and
      //    the CDP event Input.dragIntercepted fires with {dragOperationsMask:-1, items:[]}. Nothing
      //    can complete a drag the browser has handed away — so a drop was impossible by
      //    construction. Interception must be OFF for a real drag to run.
      //
      // 2. THE PAGE DECLINED THE INJECTED drop — WITHOUT ANY ERROR. Input.dispatchDragEvent
      //    {type:'drop'} was accepted by CDP every time and returned nothing, which is why five
      //    earlier experiments all looked like "the call succeeded but nothing happened". The
      //    renderer was refusing it: measured on the PRISTINE fixture the page received
      //    dragenter > dragover > DROP-CONVERTED-TO-dragleave. A drop is only delivered to a DROP
      //    ZONE, and a drop zone is defined by the TARGET cancelling `dragover`
      //    (preventDefault()). The fixture's #fp-drop never did, so Blink resolved the operation to
      //    `none` and fired dragleave instead — by specification, for ANY drag, trusted or not.
      //    Adding e.preventDefault() on dragover to #fp-drop made the very same gesture produce
      //    {type:'drop', isTrusted:true, target:'fp-drop'}.
      //
      // THE FIX. Drive the drag with the browser's own mouse pipeline and let the BROWSER complete
      // it (arrive, press, move while pressed, release over the target). Measured on that drop zone:
      // dragstart > drag > dragenter > dragover > drop > dragend, every event isTrusted:true, with no
      // interception and no dispatchDragEvent at all. The client-driven dispatchDragEvent sequence is
      // kept as a FALLBACK, used only when the page reports no drop (it is the documented completion
      // for an intercepted drag, and harmless when the native gesture already landed).
      //
      // AND THE REPLY NOW CARRIES THE PAGE'S OWN VERDICT: a capture-phase drop listener observes
      // (it never preventDefaults, so it cannot change what the page does), is read back after the
      // gesture, and is removed. "The CDP calls returned" is not evidence that a drag completed;
      // the page's record is.
      const tG = parseInt(payload.tabId, 10);
      if (!tG) return { error: 'trusted_drag: tabId required' };
      const s = payload.from, t = payload.to;
      if (!s || !t) return { error: 'trusted_drag: from and to {x,y} required' };
      const prep = await __dbgPrepare(tG);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const send = (method, params) => chrome.debugger.sendCommand({ tabId: tG }, method, params);
      const cmd = (type, o) => send('Input.dispatchMouseEvent', Object.assign({ type: type, button: 'left' }, o));
      // ★ INTERCEPTION OFF, EXPLICITLY. A previous call could have left it enabled (it is a
      // browser-wide flag), and with it enabled the drag dies at dragstart — see (1) above.
      try { await send('Input.setInterceptDrags', { enabled: false }); } catch (e) {}
      // The drop oracle. Observes only; preventDefault is deliberately NOT called here.
      const probeOn = '(function(){try{if(window.__wsDropProbe)document.removeEventListener("drop",window.__wsDropProbe,true);}catch(e){}'
        + 'window.__wsDragRec={drop:0,target:null,seen:[]};'
        + 'window.__wsDropProbe=function(ev){window.__wsDragRec.drop++;window.__wsDragRec.target=(ev.target&&(ev.target.id||ev.target.tagName))||null;'
        + 'window.__wsDragRec.seen.push(ev.type);};'
        + 'document.addEventListener("drop",window.__wsDropProbe,true);return 1;})()';
      const probeOff = '(function(){var d=window.__wsDragRec||{drop:0,target:null,seen:[]};'
        + 'try{if(window.__wsDropProbe)document.removeEventListener("drop",window.__wsDropProbe,true);}catch(e){}'
        + 'try{delete window.__wsDropProbe;delete window.__wsDragRec;}catch(e){}return JSON.stringify(d);})()';
      const readDrop = async () => {
        try {
          const rv = await send('Runtime.evaluate', { expression: probeOff, returnByValue: true });
          return JSON.parse((rv && rv.result && rv.result.value) || '{}') || {};
        } catch (e) { return {}; }
      };
      try { await send('Runtime.evaluate', { expression: probeOn, returnByValue: true }); } catch (e) {}
      // ★ THE GESTURE. The moves WHILE PRESSED are what promote the press into a drag; the release
      // over the target is what completes it. The gaps are real time — a human has them, and
      // without them Chrome coalesces the sequence away (the defect trusted_click already paid for).
      const STEPS = 8;
      const gesture = async () => {
        await cmd('mouseMoved', { x: s.x, y: s.y, buttons: 0 });
        await wait(30);
        await cmd('mousePressed', { x: s.x, y: s.y, buttons: 1, clickCount: 1 });
        await wait(40);
        for (let i = 1; i <= STEPS; i++) {
          await cmd('mouseMoved', { x: Math.round(s.x + (t.x - s.x) * i / STEPS), y: Math.round(s.y + (t.y - s.y) * i / STEPS), buttons: 1 });
          await wait(30);
        }
        await cmd('mouseReleased', { x: t.x, y: t.y, buttons: 0, clickCount: 1 });
        await wait(250);
      };
      let threw = null;
      try { await gesture(); } catch (e) { threw = String((e && e.message) || e); }
      let rec = await readDrop();
      let fellBack = false;
      // ★ FALLBACK: the client-driven completion, only when the native gesture produced no drop.
      // This is the documented protocol for a drag the client is driving; it is also how a page whose
      // native completion was refused gets a second, still-honest attempt (the renderer still refuses
      // it on a non-drop-zone target, and the reply then says so).
      if (threw === null && !(rec && rec.drop > 0) && payload.fallback !== false) {
        fellBack = true;
        try {
          const dd = { items: [{ mimeType: 'text/plain', data: 'ws' }], files: [], dragOperationsMask: 1 };
          await send('Runtime.evaluate', { expression: probeOn, returnByValue: true });
          await send('Input.dispatchDragEvent', { type: 'dragEnter', x: s.x, y: s.y, data: dd });
          await send('Input.dispatchDragEvent', { type: 'dragOver', x: t.x, y: t.y, data: dd });
          await send('Input.dispatchDragEvent', { type: 'drop', x: t.x, y: t.y, data: dd });
          await wait(250);
          rec = await readDrop();
        } catch (e) { if (!threw) threw = String((e && e.message) || e); }
      }
      const dropped = !!(rec && rec.drop > 0);
      return { success: true, mode: 'trusted', via: 'mouseMoved>mousePressed>' + STEPS + 'x mouseMoved(pressed)>mouseReleased',
               dropped: dropped, dropTarget: (rec && rec.target) || null, dropCount: (rec && rec.drop) || 0,
               fellBackToDispatchDragEvent: fellBack,
               from: s, to: t, emulation: prep.emulation,
               ...(threw ? { transportError: threw } : {}),
               ...(dropped ? {} : { note: 'NO drop reached the page. A drag only completes over a DROP ZONE: the target must cancel `dragover` (ev.preventDefault()) — that is what makes a drop target valid in HTML drag-and-drop, and without it the browser fires dragleave/dragend and no drop, by specification, for a real mouse exactly as for this one. Trusted dragstart/dragenter/dragover still fired, so the gesture itself was delivered.' }) };
    }
    case 'capture_visible_tab': {
      // Phase 4 (2026-08-15): browser_screenshot tool. chrome.tabs.captureVisibleTab
      // is a chrome.tabs API — no CDP, no webdriver flag, no bot-detection surface.
      // Returns a data URL the model can pass to vision.
      // BACKGROUND-TAB FALLBACK (2026-08-31, OSS 24-tool sweep): captureVisibleTab
      // only captures the VISIBLE tab — on a background/bound tab it fails with
      // "image readback failed". Fall back to chrome.debugger Page.captureScreenshot
      // on the target tab (same transport the ax tool already uses; brief debugging
      // infobar appears). Now a background tab screenshots fine.
      const fmt = (payload.format === 'jpeg' || payload.format === 'jpg') ? 'jpeg' : 'png';
      // 2026-09-25: captureVisibleTab has NO tab argument — it always grabs the
      // OS-ACTIVE tab. So when the caller asked for a SPECIFIC tab, the visible
      // path silently returned a DIFFERENT tab's screen while reporting success
      // (measured: screenshot{tabId:github-tab} returned pixel-identical output to
      // screenshot{} while an unrelated tab was active). That is a correctness AND
      // privacy problem — another tab's content can land in a vision call. When a
      // tabId is given and it is not the active tab, go straight to the debugger
      // path instead of trying the visible capture.
      const wantTabId = payload.tabId ? parseInt(payload.tabId, 10)
        : (typeof boundTabId === 'number' ? boundTabId : null);
      let activeId = null;
      try { const at = await getActiveTab(); activeId = at ? at.id : null; } catch (_) {}
      if (wantTabId && activeId !== wantTabId) {
        try {
          const target = { tabId: wantTabId };
          try { await chrome.debugger.attach(target, '1.3'); } catch (_) { /* already attached is fine */ }
          try {
            const res = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? (payload.quality || 80) : undefined });
            return { success: true, dataUrl: 'data:image/' + fmt + ';base64,' + res.data, mime: 'image/' + fmt, mode: 'debugger-fallback', tabId: wantTabId, note: 'target tab is not the OS-active tab; captured via chrome.debugger (no activation, no focus change)' };
          } finally {
            try { await chrome.debugger.detach(target); } catch (_) {}
          }
        } catch (dbgErr) {
          return { error: 'screenshot failed for tab ' + wantTabId + ' (not the active tab; debugger capture: ' + (dbgErr.message || dbgErr) + ')' };
        }
      }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: fmt, quality: payload.quality || 80 });
        return { success: true, dataUrl: dataUrl, mime: 'image/' + fmt, mode: 'visible', tabId: activeId };
      } catch (visibleErr) {
        // No specific tab requested (or it IS the active one) and the visible
        // capture failed — debugger fallback on the bound tab.
        try {
          const tabId = wantTabId;
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
      // v5 (2026-09-25): reload SYNCHRONOUSLY. The old bare setTimeout(150)
      // only survived if Chrome happened to keep the SW alive after
      // sendResponse returned — with no pending event it can suspend first,
      // and the timer never fired: `extension_reload` reported reloadSent:true
      // while the client-id set stayed identical for 15s (the false-success
      // this case's v4 comment already warned about). No caller awaits this
      // response (offscreen and the content script both relay fire-and-forget),
      // so tearing down right here is safe: the hub's client-id poll IS the ack.
      try { chrome.runtime.reload(); } catch (_) {}
      return { success: true, message: 'reloading extension now' };
    }
    case 'get_window_tabs': {
      const tabs = await getAllTabs();
      return { success: true, tabs };
    }
    case 'switch_to_tab': {
      const tabId = parseInt(payload.tabId, 10);
      if (!tabId || isNaN(tabId)) return { error: 'Invalid tabId: ' + payload.tabId };
      try {
        // Bind the tab WITHOUT activating it (2026-08-13, Ali directive:
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
        explicitBind = true; // explicit-bind latch: a later activation must not steal this
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
        explicitBind = true; // the caller picked THIS tab on purpose — hold it
        return { success: true, tabId, url: tab.url || '', title: tab.title || '' };
      } catch (err) {
        return { error: 'Failed to bind tab ' + tabId + ': ' + (err.message || err) };
      }
    }
    case 'get_bound_tab': {
      // B1: pure SW-state read — sub-ms, no chrome.tabs.get round trip.
      // `explicit` lets a caller tell "someone deliberately bound this tab"
      // from "this is just whatever the user last activated".
      return { success: true, tabId: boundTabId, explicit: explicitBind };
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
      if (moved && moved.id != null) explicitBind = true;
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
        // FAST-FAIL (2026-09-11c): guard BOTH hops before touching them so a
        // dead/restricted/loading tab fails in ~1ms with the named hop.
        const fromReady = await checkContentScriptReady(fromTab);
        if (!fromReady.ok) return Object.assign({ op: 'transfer_text' }, fromReady);
        const toReady = await checkContentScriptReady(toTab);
        if (!toReady.ok) return Object.assign({ op: 'transfer_text' }, toReady);
        // NOTE: chrome.tabs.sendMessage resolves with the content-script's
        // envelope {type,id,success,data} — always unwrap .data (the v2
        // read_selector/write_selector helpers put their result there).
        const unwrap = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' && 'success' in r.data) ? r.data : (r || {});
        // 1. READ from the source tab (~10ms)
        const readRaw = await chrome.tabs.sendMessage(fromTab, { type: 'read_selector', selector: payload.fromSelector })
          .catch((e) => sendMsgError(e, fromTab, 'bg->cs:read_selector (fromTab)'));
        const read = unwrap(readRaw);
        if (!read || read.success !== true) return (read && read.error === 'no-receiving-end') ? read : { error: 'read failed: ' + ((read && read.error) || 'unknown') };
        const text = payload.useValue ? (read.value != null ? String(read.value) : '') : (read.text || '');
        // 2. WRITE into the destination (~10ms) — no activation needed, no OS
        //    focus steal (2026-08-13, Ali directive: background-only)
        boundTabId = toTab;
        // 3. WRITE into the destination (~10ms) — React-safe native setter
        const writeRaw = await chrome.tabs.sendMessage(toTab, { type: 'write_selector', selector: payload.toSelector, value: text })
          .catch((e) => sendMsgError(e, toTab, 'bg->cs:write_selector (toTab)'));
        const write = unwrap(writeRaw);
        if (!write || write.success !== true) return (write && write.error === 'no-receiving-end') ? write : { error: 'write failed: ' + ((write && write.error) || 'unknown') };
        // 4. VERIFY (~10ms) — read back the destination value
        const verifyRaw = await chrome.tabs.sendMessage(toTab, { type: 'read_selector', selector: payload.toSelector })
          .catch((e) => sendMsgError(e, toTab, 'bg->cs:read_selector (verify,toTab)'));
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
        // (background-only; activation raises the OS window — Ali directive 2026-08-13)
        boundTabId = tabId;
        const ready = await checkContentScriptReady(tabId);
        if (!ready.ok) return Object.assign({ op: 'switch_tab_and_read' }, ready);
        const resRaw = await chrome.tabs.sendMessage(tabId, { type: 'read_selector', selector: payload.selector || 'body' })
          .catch((e) => sendMsgError(e, tabId, 'bg->cs:read_selector (switch_tab_and_read)'));
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
      // BACKGROUND OPEN (2026-08-13, Ali directive): create without activating
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
        // BACKGROUND NAVIGATION (2026-08-13, Ali directive): do NOT activate
        // the tab. `active:true` raises the Chrome window to the OS foreground
        // on every navigation — the #1 source of "foreground hijacking" when
        // factory workers navigate their own tabs. Content scripts inject
        // into ALL tabs (<all_urls>, all_frames), and sendMessage targets by
        // tabId — activation is NEVER required for navigation to work.
        await chrome.tabs.update(tab.id, { url: payload.url });
        boundTabId = tab.id; // B1
        // AWAIT COMMIT (2026-09-11): tabs.update resolves when the navigation is
        // STARTED, not when the new document is live. Reading immediately after
        // returned the OLD page, which reads as a flaky tool and provokes retries.
        // Bounded wait; when it does not commit we say so (committed:false +
        // timeout) rather than implying success.
        const commit = await waitForTabCommit(tab.id, payload.url, payload.commitTimeoutMs || 10000);
        const result = { success: true, tabId: tab.id, reused: true, background: true,
                         committed: !!commit.ok, committedUrl: commit.url || null };
        if (!commit.ok) { result.timeout = true; result.reason = commit.reason || 'not-committed'; }
        return result;
      } catch (err) {
        return { error: 'Failed to navigate tab: ' + (err.message || err) };
      }
    }
    case 'get_tab_info': {
      const tab = await chrome.tabs.get(payload.tabId);
      return { success: true, url: (tab && tab.url) || '', title: (tab && tab.title) || '' };
    }
    case 'list_frames': {
      // 2026-09-25: honor an explicit tabId. This case used to call
      // getActiveTab() unconditionally, so tabs{action:"frames", tabId:X}
      // reported the OS-ACTIVE tab's frames — on a multi-tab box that handed
      // back a completely different tab's frame list while claiming success
      // (observed: asked about the workbench, got chat.z.ai's frames). Fall
      // back to the bound tab, then the active tab, so an unbound session
      // behaves as before.
      const want = payload && payload.tabId ? parseInt(payload.tabId, 10) : boundTabId;
      let tab = null;
      if (want) { try { tab = await chrome.tabs.get(want); } catch (_) { tab = null; } }
      if (!tab) tab = await getActiveTab();
      if (!tab) return { error: 'No active tab' };
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      return { success: true, tabId: tab.id, requestedTabId: want || null, frames: (frames || []).map((f) => ({ frameId: f.frameId, url: f.url || '', parentFrameId: f.parentFrameId, errorOccurred: !!f.errorOccurred })) };
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
      // FAST-FAIL (2026-09-11c): name the hop instead of hanging on a dead /
      // restricted / still-loading tab; and consume any sendMessage rejection.
      const ready = await checkContentScriptReady(tab.id);
      if (!ready.ok) return Object.assign({ op: action }, ready);
      try {
        const resRaw = await chrome.tabs.sendMessage(tab.id, { type: action });
        const unw = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' && 'success' in r.data) ? r.data : (r || {});
        return unw(resRaw);
      } catch (err) {
        return sendMsgError(err, tab.id, 'bg->cs:' + action);
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
    case 'doctor':
    case 'doctor_sw': { // 2026-09-25: server.js sends `doctor_sw` for the
      // serviceWorker half of status{kind:doctor}, but only this `doctor` case
      // existed → every doctor report carried serviceWorker.error "Unknown
      // content action: doctor_sw". Same handler, two op names.
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
  registerNetworkHook();
  registerDialogHook();
  setupOffscreen().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  registerConsoleHook();
  registerNetworkHook();
  registerDialogHook();
  setupOffscreen().catch(() => {});
});

// Also try on service worker wake — MV3 kills service workers, so we need
// to recreate the offscreen when the service worker restarts
setupOffscreen().catch(() => {});
registerConsoleHook();
registerNetworkHook();
registerDialogHook();

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

// ═══ 2026-09-11 FIX: ax click/type NEVER WORKED ═══
// CDP AX values arrive either as a plain string or as an AXValue object
// {type:'computedString', value:'Reconnect', sources:[...]}. The old
// `v.value || v` fallback returned the OBJECT whenever `value` was the empty
// string, so `.toLowerCase()` threw
//   "(n.name.value || n.name || \"\").toLowerCase is not a function"
// and the matcher aborted on the first name-less node — which every real page
// has many of. Net effect: ax read worked, ax click/type were dead.
function axStr(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v.value === 'string') return v.value;
  return '';
}

function axNodeToObj(node) {
  var o = {
    role: axStr(node.role) || 'unknown',
    name: axStr(node.name),
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
    var role = axStr(n.role).toLowerCase();
    var name = axStr(n.name).toLowerCase();
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
    var r = axStr(n.role).toLowerCase();
    var nm = axStr(n.name).toLowerCase();
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
