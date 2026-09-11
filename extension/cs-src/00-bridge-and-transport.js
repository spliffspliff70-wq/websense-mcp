/* Bridge + transport: page events, wsLog, WS connect/backoff, dispatch
 * Part 00 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */

  // ═══ Native dialog capture (alert / confirm / prompt) ═══
  // These become JS-controlled so the model can see + resolve them
  // without the page blocking on a native OS dialog.
  var WS_DIALOGS = [];
  var WS_HAS_BEFOREUNLOAD = false;
  try { window.addEventListener('beforeunload', function () { WS_HAS_BEFOREUNLOAD = true; }); } catch (_) {}
  try {
    window.alert = function (msg) { WS_DIALOGS.push({ type: 'alert', message: String(msg == null ? '' : msg), ts: Date.now() }); pushPageEvent('dialog_open', { type: 'alert', message: String(msg == null ? '' : msg) }); return undefined; };
    window.confirm = function (msg) {
      var d = { type: 'confirm', message: String(msg == null ? '' : msg), ts: Date.now(), _res: null, _auto: false };
      var p = new Promise(function (r) { d._res = r; });
      // Phase 3 (2026-08-15): auto-resolve fallback. A confirm() blocked on the
      // agent resolving WS_DIALOGS would hang the PAGE THREAD forever if the
      // agent isn't watching (e.g. normal interaction flow, no handle_dialog
      // call). After 30s with no agent response, resolve `true` (proceed) so the
      // page never deadlocks. The agent can still resolve earlier via
      // handle_dialog. A timed-out dialog is marked _auto so page_state reports
      // it was auto-answered.
      var autoTimer = setTimeout(function () {
        if (d._res) { d._auto = true; d._res(true); WS_DIALOGS = WS_DIALOGS.filter(function (x) { return x !== d; }); }
      }, 30000);
      d._timer = autoTimer;
      WS_DIALOGS.push(d); pushPageEvent('dialog_open', { type: 'confirm', message: String(msg == null ? '' : msg) }); return p;
    };
    window.prompt = function (msg, def) {
      var d = { type: 'prompt', message: String(msg == null ? '' : msg), defaultValue: (def == null ? '' : String(def)), ts: Date.now(), _res: null, _auto: false };
      var p = new Promise(function (r) { d._res = r; });
      // Phase 3 (2026-08-15): same auto-resolve fallback as confirm — never
      // block the page thread. Auto-answer with the default value after 30s.
      var autoTimer = setTimeout(function () {
        if (d._res) { d._auto = true; d._res((def == null ? '' : String(def))); WS_DIALOGS = WS_DIALOGS.filter(function (x) { return x !== d; }); }
      }, 30000);
      d._timer = autoTimer;
      WS_DIALOGS.push(d); pushPageEvent('dialog_open', { type: 'prompt', message: String(msg == null ? '' : msg) }); return p;
    };
  } catch (_) {}

  // P1#1 (2026-08-31): event-push supervisor — push page events (dialog_open,
  // navigation) to the hub as they happen so the server's wait{event:…} can
  // respond instantly instead of polling page_state after every action. The
  // hub stores a small ring buffer per client; the server drains it.
  function pushPageEvent(event, data) {
    try {
      if (wsReady && ws && ws.readyState === 1) {
        wsSendRaw({ type: 'page_event', event: event, tabId: null, data: data || {}, ts: Date.now() });
      }
    } catch (_) { /* hub not connected — events captured in WS_DIALOGS anyway */ }
  }
  // Navigation events: hashchange (SPA) + a light beforeunload hook. Full
  // navigations also surface via the hub's tab_event + tab_identified paths.
  try {
    window.addEventListener('hashchange', function () { pushPageEvent('navigation', { url: location.href, kind: 'hashchange' }); });
  } catch (_) {}
  try {
    window.addEventListener('popstate', function () { pushPageEvent('navigation', { url: location.href, kind: 'popstate' }); });
  } catch (_) {}

  // ═══ Debug Logging (root-cause investigation) ═══
  const WS_DEBUG = [];
  function wsLog(...args) { try { const m = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '); WS_DEBUG.push(m); console.log('[WEBSENSE] ' + m); } catch (_) {} }
  window.__WEBSENSE_DEBUG__ = WS_DEBUG;
  window.addEventListener('error', function (e) { wsLog('GLOBAL_ERROR:', e.message, '| stack:', (e.error && e.error.stack) ? e.error.stack.slice(0, 800) : 'no-stack'); });
  window.addEventListener('unhandledrejection', function (e) { wsLog('UNHANDLED_REJECTION:', e.reason && (e.reason.message || e.reason)); });

  // ═══ Direct WebSocket bridge to the WebSense MCP hub (SW-independent) ═══
  // Connects via ws://127.0.0.1:38401. Chrome exempts 127.0.0.1 from
  // mixed-content blocking, so ws:// works from HTTPS pages (lemonsqueezy etc.)
  // without cert errors. Runs in the content script's isolated world and lives as
  // long as the page is open — independent of the MV3 service-worker lifecycle,
  // so the bridge stays up even when the SW is killed after idle. Tab-level ops
  // that need the SW (navigate/list_tabs/...) are relayed on demand via
  // chrome.runtime.sendMessage, which wakes the SW only when needed.
  var WS_PORT = 38401; // ws:// — 127.0.0.1 is mixed-content exempt
  var WS_PROTO = 'ws://'; // force plain ws (localhost-exempt; wss:// self-signed cert is rejected by Chrome)
  var ws = null;
  var wsReady = false;
  var wsReconnectTimer = null;

  function wsSendRaw(obj) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); return true; } catch (_) {} }
    return false;
  }

  // Tab control relay — only used for ops the content script can't do itself.
  function relayTabControl(action, payload) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'TAB_CONTROL', action: action, payload: payload || {} }, function (resp) {
          resolve(resp || { error: 'No response from background' });
        });
      } catch (e) { resolve({ error: String(e) }); }
    });
  }

  // ═══ Ad-frame detection — skip the WS bridge entirely in ad iframes ═══
  // Content scripts with all_frames:true run inside Google SafeFrame / ad
  // iframes too. Those must NOT connect to the hub — they'd hijack page ops.
  var WS_IS_AD_FRAME = false;
  (function () {
    try {
      if (window.self === window.top) return; // main frame is never an ad
      var u = location.href || '';
      var AD_PATTERNS = [
        'googleads', 'googlesyndication', 'doubleclick', 'adservice',
        'adzerk', 'amazon-adsystem', 'criteo', 'taboola', 'outbrain',
        'adnxs', 'rubiconproject', 'openx', 'pubmatic', 'casalemedia',
        'lijit', 'sonobi', 'indexexchange', 'spotxchange', 'gumgum',
        'amazon-adsystem', 'bidswitch', 'contextweb', 'districtm',
        'media.net', 'sharethrough', 'teads', 'triplelift', 'undertone',
        '/ads/', '/adserver', 'safeframe', 'g.doubleclick'
      ];
      for (var i = 0; i < AD_PATTERNS.length; i++) {
        if (u.indexOf(AD_PATTERNS[i]) !== -1) { WS_IS_AD_FRAME = true; break; }
      }
    } catch (_) { WS_IS_AD_FRAME = false; }
  })();

  // ═══ Direct-bridge viability gate (2026-09-11) ═══
  // At most ONE direct WS client per TAB, and only where it can be used:
  //
  //  1. AD FRAMES — pre-existing guard (SafeFrame / ad iframes must never hold a
  //     hub slot; they answered broadcast relays with garbage — PITFALL 25).
  //
  //  2. SUBFRAMES ARE POINTLESS. Verified against the hub's own routing:
  //     hub.handleMessage only writes the routing table on
  //     `if (msg.tabId && msg.isMainFrame)` → contentByTab, so a subframe client
  //     can NEVER be selected for a page op; frame-targeted delivery is done by
  //     the SW via chrome.tabs.sendMessage(tabId, msg, {frameId}). A subframe
  //     socket therefore only inflates hub membership (measured peak: 24
  //     concurrent clients, 664 disconnects in one log) and widens the
  //     wrong-client / hijack surface that PITFALL 16/25/26 describe.
  //
  // NOT gated on https. An earlier draft of this fix assumed Chrome's
  // mixed-content rule blocks plain ws:// from every https page. That is FALSE —
  // measured live 2026-09-11: content-script clients connected as MAIN on
  // https://hackerone.com tabs immediately after an extension reload. What
  // actually blocks the socket is the SITE's own CSP connect-src (x.com and
  // LinkedIn are strict; hackerone is not). Since a content script cannot know
  // its page's effective connect-src up front, that case is handled by the
  // backoff + give-up below instead of by a protocol guess.
  var WS_IS_MAIN_FRAME = false;
  try { WS_IS_MAIN_FRAME = (window.self === window.top); } catch (_) { WS_IS_MAIN_FRAME = false; }
  var WS_BRIDGE_UNUSABLE = WS_IS_AD_FRAME || !WS_IS_MAIN_FRAME;

  if (WS_BRIDGE_UNUSABLE) {
    wsLog('WS_SKIP: direct bridge not used here (' +
      (WS_IS_AD_FRAME ? 'ad frame' : 'subframe — hub only routes to main-frame clients') +
      ') — offscreen relay handles this tab');
  }

  // Exponential backoff with give-up. The old flat 3s retry re-attempted a
  // doomed socket forever (no backoff, no ceiling), which is what produced the
  // endless WS_CLOSE 1006 stream. A genuine state change (tab activated)
  // resets the streak and retries once — see bindVisibilityActivationReport.
  var wsFailStreak = 0;
  var WS_MAX_FAIL_STREAK = 4;
  var WS_BACKOFF_MIN_MS = 3000;
  var WS_BACKOFF_MAX_MS = 60000;

  // ═══ Extraction budget (2026-09-11) ═══
  // Measured baseline before these existed: explore_page's DEFAULT call (no
  // maxActions) walked the entire DOM, cost ~5ms per element, and hard-stalled
  // at the 90s hub timeout on pages over ~5,000 elements. 556 els = 0.44s,
  // 2,206 els = 11s, 11,006 els = TIMEOUT. The three constants below are the
  // difference between "unbounded walk" and "bounded, useful answer".
  //
  // A cap on RETURNED actions (what maxActions always was) is not a cap on WORK:
  // the old loop only broke once it had ACCEPTED N actions, so on a page with
  // few in-viewport interactives it never broke and walked everything. PROVEN:
  // maxActions=5 and maxActions=200 both cost 11.0s on the same 2,206-el page.
  var DEFAULT_MAX_ACTIONS = 200;   // was: unbounded (0) on the explore_page path
  var SCAN_CEILING = 8000;         // hard cap on ELEMENTS EXAMINED (bounds worst case)
  var CURSOR_SWEEP_MAX_ELEMENTS = 1800; // above this, skip the cursor:pointer sweep
  var AUTO_COMPACT_CANDIDATES = 400;    // auto-trim content extraction above this
  var CONTENT_MAX_CHARS = 6000;    // default bodyText cap (was 8000, payload-heavy)
  var SETTLE_SKIP_IF_QUIET_MS = 150;    // skip waitForSettle if DOM has been quiet
  var SAG_CACHE_TTL_MS = 1500;          // reuse a SAG when DOM is provably unchanged

  function wsConnect() {
    if (WS_BRIDGE_UNUSABLE) return;
    if (wsFailStreak >= WS_MAX_FAIL_STREAK) {
      wsLog('WS_GIVEUP: ' + wsFailStreak + ' consecutive failures — retry deferred to next tab activation');
      return;
    }
    try { ws = new WebSocket(WS_PROTO + '127.0.0.1:' + WS_PORT); }
    catch (e) { wsLog('WS_CREATE_FAIL: ' + (e && e.message ? e.message : String(e))); wsFailStreak++; wsScheduleReconnect(); return; }

    ws.onopen = function () {
      wsReady = true;
      wsFailStreak = 0; // healthy socket — clear the backoff streak
      // Detect if we're in the main frame (not inside an iframe)
      var isMainFrame = false;
      try { isMainFrame = (window.self === window.top); } catch (_) { isMainFrame = false; }
      wsLog('WS_OPEN: bridge connected mainFrame=' + isMainFrame);
      wsSendRaw({ type: 'ready', version: '2.0.0', source: 'content-script', url: location.href, isMainFrame: isMainFrame, frameTitle: document.title || '' });
      // Ask the SW which tab we live in — the hub uses this to route page ops
      // DIRECTLY to the selected tab's content script (no offscreen round-trip).
      try {
        chrome.runtime.sendMessage({ type: 'GET_MY_TAB_ID' }, function (resp) {
          wsLog('TAB_ID_RESP: ' + JSON.stringify(resp));
          if (resp && resp.tabId) {
            wsSendRaw({ type: 'tab_identified', tabId: resp.tabId, isMainFrame: isMainFrame });
            // P0#2 (2026-08-31): also broadcast activation so the hub
            // immediately routes page ops to this tab — kills the cold-tab
            // wedge for CS reconnects.
            wsSendRaw({ type: 'tab_activated', tabId: resp.tabId });
            wsLog('TAB_IDENTIFIED_SENT: tabId=' + resp.tabId);
          } else {
            wsLog('TAB_ID_NONE: no tabId in response');
            // P0#2 retry — SW may have been cold; retry once after 1s
            setTimeout(function () {
              try {
                chrome.runtime.sendMessage({ type: 'GET_MY_TAB_ID' }, function (resp2) {
                  if (resp2 && resp2.tabId) {
                    wsSendRaw({ type: 'tab_identified', tabId: resp2.tabId, isMainFrame: isMainFrame });
                    wsSendRaw({ type: 'tab_activated', tabId: resp2.tabId });
                    wsLog('TAB_ID_RETRY_OK: tabId=' + resp2.tabId);
                  }
                });
              } catch (_e) { wsLog('TAB_ID_RETRY_ERR'); }
            }, 1000);
          }
        });
      } catch (e) { wsLog('TAB_ID_ERR: ' + (e && e.message ? e.message : String(e))); }
    };
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'ready' || msg.type === 'pong') return;
      wsHandle(msg);
    };
    ws.onclose = function (ev) { wsLog('WS_CLOSE: code=' + (ev && ev.code) + ' reason=' + (ev && ev.reason ? ev.reason : '')); wsReady = false; ws = null; wsFailStreak++; wsScheduleReconnect(); };
    ws.onerror = function (ev) { wsLog('WS_ERROR: ' + ((ev && ev.message) || 'unknown')); };
  }

  function wsScheduleReconnect() {
    if (WS_BRIDGE_UNUSABLE || wsReconnectTimer) return;
    if (wsFailStreak >= WS_MAX_FAIL_STREAK) {
      wsLog('WS_GIVEUP: ' + wsFailStreak + ' consecutive failures — not retrying until the tab is activated again');
      return;
    }
    // 3s, 6s, 12s, 24s … capped at 60s (was a flat 3s forever).
    var delay = Math.min(WS_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, wsFailStreak - 1)), WS_BACKOFF_MAX_MS);
    wsLog('WS_RETRY_IN: ' + delay + 'ms (streak ' + wsFailStreak + ')');
    wsReconnectTimer = setTimeout(function () { wsReconnectTimer = null; wsConnect(); }, delay);
  }

  // A real state change is the one honest reason to retry after give-up: the
  // tab is being foregrounded, so the hub may now be reachable. Reset the
  // streak and make one fresh attempt (used by the visibility handler below).
  function wsResetAndRetry() {
    if (WS_BRIDGE_UNUSABLE) return;
    if (wsReady && ws && ws.readyState === 1) return;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    wsFailStreak = 0;
    wsConnect();
  }

  // P0#2 (2026-08-31, cold-tab wedge A1): when THIS tab becomes visible (the
  // user/worker actually activates it), re-broadcast tab_activated so the hub
  // routes page ops here even if the SW missed the onActivated event (cold SW
  // at tab-open time) or the initial GET_MY_TAB_ID round-trip failed. This is
  // the CS-side half of the wedge fix: the CS is by definition alive and
  // injected when the tab is foregrounded, so this is the freshest liveness
  // signal the hub can get.
  function bindVisibilityActivationReport() {
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (wsReady && ws && ws.readyState === 1) {
          wsLog('TAB_VISIBLE: re-broadcasting tab_activated');
          try {
            chrome.runtime.sendMessage({ type: 'GET_MY_TAB_ID' }, function (resp) {
              if (resp && resp.tabId) {
                wsSendRaw({ type: 'tab_identified', tabId: resp.tabId, isMainFrame: WS_IS_MAIN_FRAME });
                wsSendRaw({ type: 'tab_activated', tabId: resp.tabId });
                wsLog('TAB_VISIBLE_ACTIVATED: tabId=' + resp.tabId);
              }
            });
          } catch (_e) { wsLog('TAB_VISIBLE_ERR'); }
        } else {
          // Bridge is down (or gave up on backoff) and this tab is now the one
          // being looked at — the honest moment to retry once (2026-09-11).
          wsLog('TAB_VISIBLE: bridge down — resetting retry streak and reconnecting');
          wsResetAndRetry();
        }
      });
    } catch (_e) { /* visibilitychange may not exist — harmless */ }
  }
  bindVisibilityActivationReport();

  async function wsHandle(msg) {
    var id = msg.id;
    try {
      var result;
      // Tab-level ops that need the background SW (woken on demand).
      if (msg.type === 'navigate' || msg.type === 'list_tabs' || msg.type === 'switch_tab' ||
          msg.type === 'close_tab' || msg.type === 'list_frames' || msg.type === 'download_state' ||
          msg.type === 'tab_contents' || msg.type === 'get_active_tab' ||
          msg.type === 'cookie_op' || msg.type === 'download_op' || msg.type === 'respawn_offscreen') {
        if (msg.type === 'list_tabs') {
          result = await relayTabControl('get_window_tabs', {});
        } else if (msg.type === 'navigate') {
          if (msg.newTab) {
            // BACKGROUND-ONLY (2026-08-13, Ali directive): never activate —
            // activation raises the Chrome window (foreground hijack).
            result = await relayTabControl('open_new_tab', { url: msg.url, active: false });
            result = { success: true, tabId: (result && result.tabId) || null, reused: false, background: true };
          } else {
            result = await relayTabControl('navigate_current_tab', { url: msg.url });
            result = { success: true, tabId: (result && result.tabId) || null, reused: !!(result && result.reused) };
          }
        } else if (msg.type === 'switch_tab') {
          // Accept both tab_id (snake from MCP) and tabId (camel) — coerce to int
          var tid = msg.tab_id || msg.tabId;
          result = await relayTabControl('switch_to_tab', { tabId: parseInt(tid, 10) });
        } else if (msg.type === 'close_tab') {
          var cid = msg.tab_id || msg.tabId;
          result = await relayTabControl('close_tab', { tabId: parseInt(cid, 10) });
        } else if (msg.type === 'list_frames') {
          result = await relayTabControl('list_frames', {});
        } else if (msg.type === 'download_state') {
          result = await relayTabControl('download_state', {});
        } else if (msg.type === 'get_active_tab') {
          // P0#3 (2026-08-31): pass through to SW's get_active_tab handler
          result = await relayTabControl('get_active_tab', {});
        } else {
          result = await relayTabControl(msg.type, msg);
        }
      } else if (msg.type === 'get_status') {
        result = { hubConnected: true, pageConnected: true, currentUrl: location.href, currentTitle: document.title, source: 'content-script' };
      } else {
        // Page-level ops handled directly in the isolated world.
        result = await wsDispatchPage(msg);
      }
      wsSendRaw({ type: msg.type + '_result', id: id, success: !result || !result.error, data: result || {} });
    } catch (err) {
      wsSendRaw({ type: msg.type + '_result', id: id, success: false, data: { error: err.message || String(err) } });
    }
  }

  async function wsDispatchPage(msg) {
    var params = msg;
    switch (msg.type) {
      case 'explore_page': return await extractActionGraph({ full: !!params.full, includeContent: params.includeContent !== false, includeHidden: !!params.includeHidden, frameId: params.frameId, incremental: !!params.incremental, maxActions: params.maxActions, contentMaxLen: params.contentMaxLen, settle: params.settle, quietMs: params.quietMs, fresh: params.fresh });
      // Only reached when the hub routes here (a live direct bridge). Relay to the
      // SW, which performs chrome.runtime.reload(). Fire-and-forget on purpose:
      // the SW dies mid-call, so awaiting its response would hang. 2026-09-11.
      case 'extension_reload': { try { chrome.runtime.sendMessage({ type: 'extension_reload' }); } catch (_) {} return { success: true, message: 'reload relayed to the service worker' }; }
      case 'discover_actions': { const sag = await extractActionGraph({ includeContent: false, full: false, includeHidden: false, maxActions: params.maxActions || DEFAULT_MAX_ACTIONS, frameId: params.frameId }); return sag.actions; }
      case 'click': { var b = getQuickState(); const cr = await nativeClick(await resolveRefHealed(params.ref)); return { success: true, ref: params.ref, ...(cr && typeof cr === 'object' ? cr : {}), beforeState: b, afterState: getQuickState() }; }
      case 'type_text': { var r = await nativeType(await resolveRefHealed(params.ref), params.text, params.clearFirst !== false); r.ref = params.ref; return r; }
      case 'select_option': { var s = nativeSelect(await resolveRefHealed(params.ref), params.value, params.clearAll); s.ref = params.ref; return s; }
      case 'form_special': { var fs = await nativeSetSpecial(await resolveRefHealed(params.ref), params.value); fs.ref = params.ref; return fs; }
      case 'toggle': { var t = nativeToggle(await resolveRefHealed(params.ref)); t.ref = params.ref; return t; }
      case 'scroll': return nativeScroll(params.direction, params.amount || 1, params.ref);
      case 'scroll_to': return nativeScrollTo(params.y);
      case 'scroll_into_view': return nativeScrollIntoView(await resolveRefHealed(params.ref));
      case 'press_key': return nativePressKeyEnhanced(params.key, params.ref, params.modifiers);
      case 'evaluate': return nativeEvaluate(params.script);
      case 'evaluate_safe': return nativeEvaluateSafe(params.query || {});
      case 'type_many': return nativeTypeMany(params.fields);
      case 'hover': return nativeHover(await resolveRefHealed(params.ref));
      case 'right_click': return nativeRightClick(await resolveRefHealed(params.ref));
      case 'drag_drop': return nativeDragDrop(resolveRef(params.fromRef), resolveRef(params.toRef));
      case 'click_xy': return nativeClickXY(params.x, params.y, params.ref, params.button);
      case 'console_log': if (!consoleCapturing) startConsoleCapture(); return getConsoleLog(params.clear !== false, params.maxEntries || 100);
      case 'copy_to_clipboard': return nativeCopyToClipboard(params.text);
      case 'form_state': return getFormState(params.formRef, params.frameId);
      case 'action_preview': return getActionPreview(params.ref);
      case 'dropdown_options': return getDropdownOptions(resolveRef(params.ref));
      case 'tab_contents': return getTabContents(resolveRef(params.ref));
      case 'accordion_contents': return getAccordionContents(resolveRef(params.ref));
      case 'page_state': return getPageState(params.frameId);
      case 'extract_text': { const sel=params.selector||'body'; const ml=(params.maxLen!==undefined?params.maxLen:(params.max_len!==undefined?params.max_len:4000)); const off=params.offset||0; const el=document.querySelector(sel); const txt=el?fullText(el):''; var et=el?txt.slice(off, off+ml):'Element not found for selector: '+sel; et+=(off+ml < txt.length)?'\n...[TRUNCATED — call extract_text again with offset='+(off+ml)+' for the next window]':''; return { text: et }; }
      case 'read_content': return readContent(params);
      case 'dump_markdown': return nativeDumpMarkdown(params);
      case 'resolve_ref': {
        const el = resolveRef(params.ref);
        if (!el) return { success: false, error: 'ref not found: ' + params.ref };
        const loc = buildLocator(el);
        return { success: true, found: true, ref: params.ref, tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').trim().slice(0, 80),
          value: (el.value != null ? el.value : '').toString().slice(0, 80),
          locator: loc && loc.length ? loc[0] : null, connected: el.isConnected };
      }
      case 'page_diff': return getPageDiff();
      case 'find_intent': return findIntent(params.intent || '');
      case 'geometry': return getGeometry(params.ref || params.selector || '');
      case 'screen_center': return screenCenter(params.ref || params.selector || '');
      case 'layout_relation': return layoutRelation(params.refA || '', params.refB || '');
      case 'get_events': return getEvents(params.since);
      case 'ping': return { pong: true, ts: Date.now() };
      case 'get_status': return { hubConnected: true, pageConnected: true, currentUrl: location.href, currentTitle: document.title, source: 'content-script' };
      case 'handle_dialog': {
        const idx = (params.index !== undefined && params.index !== null) ? params.index : (WS_DIALOGS.length - 1);
        const dlg = WS_DIALOGS[idx];
        if (!dlg) return { success: false, error: 'No pending dialog at index ' + idx };
        const act = params.action || 'accept';
        if (dlg._timer) { try { clearTimeout(dlg._timer); } catch (_) {} }
        if (dlg.type === 'alert') { WS_DIALOGS.splice(idx, 1); return { success: true, handled: 'alert' }; }
        else if (dlg.type === 'confirm') { const cv = (act === 'dismiss') ? false : true; if (dlg._res) dlg._res(cv); WS_DIALOGS.splice(idx, 1); return { success: true, handled: 'confirm', value: cv }; }
        else if (dlg.type === 'prompt') { const pv = (act === 'dismiss') ? null : (params.value !== undefined && params.value !== null ? params.value : dlg.defaultValue); if (dlg._res) dlg._res(pv); WS_DIALOGS.splice(idx, 1); return { success: true, handled: 'prompt', value: pv }; }
        return { success: false, error: 'Unknown dialog type: ' + dlg.type };
      }
      case 'explore_intent': return exploreIntent(params.goal || '');
      case 'read_selector': {
        // B2 helper: read text/value from a selector (used by SW compound ops)
        try {
          const el = deepQuery(params.selector);
          if (!el) return { success: false, error: 'selector not found: ' + params.selector };
          return { success: true, selector: params.selector, text: (el.innerText || el.textContent || '').trim().slice(0, 2000), value: (el.value != null ? el.value : null) };
        } catch (e) { return { success: false, error: e.message }; }
      }
      case 'write_selector': {
        // B2 helper: set value + dispatch input events (used by SW compound ops)
        try {
          const el = deepQuery(params.selector);
          if (!el) return { success: false, error: 'selector not found: ' + params.selector };
          const v = String(params.value == null ? '' : params.value);
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
          if (setter) setter.call(el, v); else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, selector: params.selector, set: v, actual: el.value };
        } catch (e) { return { success: false, error: e.message }; }
      }
      case 'scroll_and_extract': return await scrollAndExtract(params);
      case 'preload_content': return await preloadPage(params);
      case 'doctor_content': return doctorContent();
      case 'network_log': return { note: 'network_log not available from content bridge' };
      case 'mermaid_export': return { note: 'mermaid_export handled by server' };
      case 'wait_for': return { note: 'wait_for not available from content bridge' };
      case 'upload_file': return { error: 'upload_file requires the background SW (drag-and-drop DataTransfer unavailable in content world) — use the SW relay' };
      case 'read_clipboard': {
        try {
          const ta = document.createElement('textarea');
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;';
          document.body.appendChild(ta); ta.focus(); ta.select();
          const ok = document.execCommand('paste');
          ta.remove();
          return { success: true, text: ok ? ta.value : '' };
        } catch (e) { return { success: false, error: 'clipboard read failed: ' + (e.message || e) }; }
      }
      case 'reset_session': wsReady = true; return { success: true };
      default: return { error: 'Unknown content action: ' + msg.type };
    }
  }

  wsConnect();

  // ═══ Ref System ═══
