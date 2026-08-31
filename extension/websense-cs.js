/**
 * WebSense MCP — Enhanced Content Script
 * Runs in Chrome's isolated world (NOT subject to page CSP).
 * All operations are native DOM manipulation — NO eval, NO string-to-code.
 */
(function () {
  'use strict';

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

  function wsConnect() {
    if (WS_IS_AD_FRAME) { wsLog('WS_SKIP: ad frame — bridge disabled'); return; }
    try { ws = new WebSocket(WS_PROTO + '127.0.0.1:' + WS_PORT); }
    catch (e) { wsLog('WS_CREATE_FAIL: ' + (e && e.message ? e.message : String(e))); wsScheduleReconnect(); return; }

    ws.onopen = function () {
      wsReady = true;
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
    ws.onclose = function (ev) { wsLog('WS_CLOSE: code=' + (ev && ev.code) + ' reason=' + (ev && ev.reason ? ev.reason : '')); wsReady = false; ws = null; wsScheduleReconnect(); };
    ws.onerror = function (ev) { wsLog('WS_ERROR: ' + ((ev && ev.message) || 'unknown')); };
  }

  function wsScheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(function () { wsReconnectTimer = null; wsConnect(); }, 3000);
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
        if (document.visibilityState === 'visible' && wsReady && ws && ws.readyState === 1) {
          wsLog('TAB_VISIBLE: re-broadcasting tab_activated');
          try {
            chrome.runtime.sendMessage({ type: 'GET_MY_TAB_ID' }, function (resp) {
              if (resp && resp.tabId) {
                wsSendRaw({ type: 'tab_identified', tabId: resp.tabId, isMainFrame: (window.self === window.top) });
                wsSendRaw({ type: 'tab_activated', tabId: resp.tabId });
                wsLog('TAB_VISIBLE_ACTIVATED: tabId=' + resp.tabId);
              }
            });
          } catch (_e) { wsLog('TAB_VISIBLE_ERR'); }
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
      case 'explore_page': return await extractActionGraph({ full: !!params.full, includeContent: params.includeContent !== false, includeHidden: !!params.includeHidden, frameId: params.frameId, incremental: !!params.incremental });
      case 'discover_actions': { const sag = await extractActionGraph({ includeContent: false, full: false, includeHidden: false, maxActions: params.maxActions || 250, frameId: params.frameId }); return sag.actions; }
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
          const el = document.querySelector(params.selector);
          if (!el) return { success: false, error: 'selector not found: ' + params.selector };
          return { success: true, selector: params.selector, text: (el.innerText || el.textContent || '').trim().slice(0, 2000), value: (el.value != null ? el.value : null) };
        } catch (e) { return { success: false, error: e.message }; }
      }
      case 'write_selector': {
        // B2 helper: set value + dispatch input events (used by SW compound ops)
        try {
          const el = document.querySelector(params.selector);
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
  const REF_ATTR = 'data-websense-ref';
  let refMap = new Map();
  const elementSignatures = new WeakMap();
  // A2: ref → locator chain (a plain Map — WeakMap is not iterable, so the
  // resolveRef fallback can't scan elementSignatures; keep the locator
  // indexed by ref for O(1) re-resolution after re-render).
  const locatorByRef = new Map();
  let refCounter = 0;

  function elementSignature(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const name = el.getAttribute('name') || '';
    const role = el.getAttribute('role') || '';
    const type = el.getAttribute('type') || '';
    const cls = (el.className || '').toString().slice(0, 50);
    let posIdx = -1;
    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
      posIdx = siblings.indexOf(el);
    }
    return [tag, id, name, role, type, cls, posIdx].join('|');
  }

  // A2 (2026-08-10): semantic locator chain — a STABLE address that survives
  // re-render. Priority: data-testid → id → aria-label → name → stable CSS
  // path → role+text. `resolveRef` falls back through this when the element
  // is removed from the DOM (React/Angular re-renders kill the REF_ATTR node).
  function buildLocator(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const chain = [];
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testid) chain.push('[data-testid="' + CSS.escape(testid) + '"]');
    if (el.id) chain.push('#' + CSS.escape(el.id));
    const aria = el.getAttribute('aria-label');
    if (aria) chain.push('[aria-label="' + CSS.escape(aria) + '"]');
    const name = el.getAttribute('name');
    if (name) chain.push('[name="' + CSS.escape(name) + '"]');
    // Stable CSS path: climb to a stable ancestor (id/testid/body), record
    // :nth-of-type indices — survives shallow re-renders.
    let css = '';
    let node = el;
    let guard = 0;
    while (node && node.nodeType === Node.ELEMENT_NODE && guard++ < 8) {
      const tag = node.tagName.toLowerCase();
      if (node.id) { css = '#' + CSS.escape(node.id) + ' ' + css; break; }
      if (node.getAttribute('data-testid')) { css = '[data-testid="' + CSS.escape(node.getAttribute('data-testid')) + '"] ' + css; break; }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        const idx = sameTag.indexOf(node);
        css = tag + (sameTag.length > 1 ? ':nth-of-type(' + (idx + 1) + ')' : '') + (css ? ' > ' + css : '');
      } else { css = tag + (css ? ' > ' + css : ''); }
      node = parent;
    }
    if (css) chain.push(css);
    // role+text — the most semantic, last resort
    const role2 = el.getAttribute('role');
    const txt = (el.innerText || el.textContent || '').trim().slice(0, 40);
    if (role2 && txt) chain.push('[role="' + CSS.escape(role2) + '"][aria-label="' + CSS.escape(txt) + '"]');
    else if (txt) chain.push('//' + el.tagName.toLowerCase() + '[normalize-space(.)="' + txt.replace(/"/g, '\\"') + '"]');
    return chain.length ? chain : null;
  }

  // Resolve a locator chain against the live DOM (CSP-safe, no eval).
  function resolveLocator(chain) {
    if (!Array.isArray(chain)) return null;
    for (const sel of chain) {
      try {
        if (sel.startsWith('//')) {
          // XPath-ish fallback (text match) — querySelector can't do text.
          const m = sel.match(/^\/([a-z]+)\[normalize-space\(\.\)="([^"]*)"\]$/);
          if (m) {
            const els = Array.from(document.getElementsByTagName(m[1]));
            for (const e of els) {
              if ((e.innerText || e.textContent || '').trim().slice(0, 40) === m[2]) return e;
            }
          }
          continue;
        }
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) { /* try next */ }
    }
    return null;
  }

  function assignRef(el) {
    if (elementSignatures.has(el)) return elementSignatures.get(el).ref;
    const ref = 'E' + refCounter++;
    const loc = buildLocator(el);
    elementSignatures.set(el, { ref, sig: elementSignature(el), locator: loc });
    refMap.set(ref, el);
    if (loc && loc.length) locatorByRef.set(ref, loc);
    try { el.setAttribute(REF_ATTR, ref); } catch (_) {}
    return ref;
  }

  // v4 (2026-08-31): quote-safe [data-websense-ref="<ref>"] lookup + selector
  // fast-path. Escapes backslashes and double quotes before embedding the ref
  // into an attribute selector, so refs containing quotes can never crash
  // querySelector again.
  function resolveAttrRef(ref) {
    if (typeof ref !== 'string' || !ref) return null;
    try {
      const esc = ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return document.querySelector('[' + REF_ATTR + '="' + esc + '"]') || null;
    } catch (_) { return null; }
  }

  // SELECTOR-REF fast path (v4): if the ref looks like a CSS selector, try it
  // directly before falling back to the locator chain.
  function resolveSelectorRef(ref) {
    if (typeof ref !== 'string') return null;
    if (!/^[\[\]#\.>\+~,:*='"\w\-()%|\s]+$/.test(ref)) return null;
    if (!(ref.startsWith('[') || ref.startsWith('#') || ref.startsWith('.') || ref.includes(' > ') || ref.includes('>') || ref.includes('~'))) return null;
    try {
      return document.querySelector(ref) || null;
    } catch (_) { return null; }
  }

  function resolveRef(ref) {
    if (refMap.has(ref)) {
      const el = refMap.get(ref);
      if (el && el.isConnected) return el;
      refMap.delete(ref);
    }
    // v4 (2026-08-31): attribute-lookup with QUOTE-SAFE escaping. A ref/selector
    // containing double quotes (e.g. [data-testid="tweetTextarea_0"]) crashed
    // the naive string concat with "not a valid selector". Also fast-path:
    // a well-formed selector ref goes straight to querySelector.
    const el = resolveAttrRef(ref);
    if (el) { refMap.set(ref, el); return el; }
    // SELECTOR REFS (2026-08-13): accept CSS selectors directly
    // so tools like geometry()'s returned refs ("[aria-label='X']", "#id",
    // ".class > span") can be clicked without an E# SAG entry. v4 (2026-08-31):
    // wrapped in resolveAttrRef() which QUOTE-ESCAPES the attribute value —
    // selectors containing double quotes (e.g. [data-testid="tweetTextarea_0"])
    // previously crashed querySelector with "not a valid selector".
    {
      const selEl = resolveSelectorRef(ref);
      if (selEl) { refMap.set(ref, selEl); return selEl; }
    }
    // A2 (2026-08-10): the ref node died (re-render). Re-resolve via the
    // semantic locator chain — data-testid → id → aria-label → name → CSS
    // path → role+text. Re-binds the ref to the re-rendered element.
    const loc = locatorByRef.get(ref);
    if (loc) {
      const found = resolveLocator(loc);
      if (found) {
        refMap.set(ref, found);
        try { found.setAttribute(REF_ATTR, ref); } catch (_) {}
        return found;
      }
    }
    return null;
  }

  // SELF-HEAL RESOLVE (2026-08-31, OSS smoke-test finding): async wrapper —
  // ref was assigned in a scan BEFORE a full/compact explore rebuilt refMap,
  // or the element is below fold / viewport-filtered / slow-render, and the
  // sync DOM-walk resolution missed. Rebuild the graph ONCE, then retry —
  // beats a hard "Element not found" and lets callers climb honestly.
  // Guarded against recursion (extractActionGraph itself never calls this).
  async function resolveRefHealed(ref) {
    const first = resolveRef(ref);
    if (first) return first;
    if (resolveRefHealed._healing) return null;
    try {
      resolveRefHealed._healing = true;
      await extractActionGraph({ includeContent: false, full: false, includeHidden: false });
    } catch (_) { /* heal failed — return null below */ }
    finally { resolveRefHealed._healing = false; }
    return resolveRef(ref);
  }

  // ═══ Framework Detection ═══
  let _framework = null;
  function detectFramework() {
    if (_framework) return _framework;
    try {
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) _framework = 'react';
      else if (document.querySelector('[data-reactroot], [data-reactid], div[id^="__next"]')) _framework = 'react';
      else if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) _framework = 'vue';
      else if (window.ng || document.querySelector('[ng-version]')) _framework = 'angular';
      else if (document.querySelector('[data-svelte]')) _framework = 'svelte';
      else _framework = 'vanilla';
    } catch (_) { _framework = 'vanilla'; }
    return _framework;
  }

  // ═══ Visibility Helpers ═══
  function isVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = cachedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function isInViewport(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // Element is "in viewport" if any part intersects the viewport
    const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    // Also treat zero-size interactive elements (inputs hidden by CSS but present) as in-viewport
    // so they aren't dropped from the graph when offscreen scan is off.
    return inView || (rect.width === 0 && rect.height === 0 && isVisible(el));
  }


  // ═══ Interactive Element Detection ═══
  const INTERACTIVE_TAGS = new Set(['a','button','input','select','textarea','details','summary','label','option','optgroup']);
  const INTERACTIVE_ROLES = new Set(['button','link','menuitem','menuitemradio','menuitemcheckbox','radio','checkbox','tab','switch','option','combobox','searchbox','textbox','slider','spinbutton','treeitem']);
  const INTERACTIVE_CURSORS = new Set(['pointer','move','text','grab','grabbing','cell','copy','alias','context-menu','crosshair','zoom-in','zoom-out']);

  function isInteractive(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!isVisible(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('inert') !== null) return false;
    if (el.isContentEditable) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    if (INTERACTIVE_TAGS.has(tag)) {
      if (tag === 'input' && el.getAttribute('type') === 'hidden') return false;
      return true;
    }
    const role = el.getAttribute('role') || '';
    if (INTERACTIVE_ROLES.has(role)) return true;
    const style = cachedStyle(el);
    if (style.cursor && INTERACTIVE_CURSORS.has(style.cursor)) return true;
    if (el.getAttribute('aria-haspopup') || el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle') || el.classList.contains('dropdown-toggle')) return true;
    if (el.tabIndex !== null && el.tabIndex >= 0) return true;
    return false;
  }

  // ═══ Element Classification ═══
  function getLabel(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return (l.innerText||l.textContent||'').trim(); }
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim();
    if (el.getAttribute('title')) return el.getAttribute('title').trim();
    if (el.getAttribute('alt')) return el.getAttribute('alt').trim();
    const text = fullText(el);
    if (text) return text.slice(0, 100);
    if (el.value && el.tagName !== 'SELECT') return String(el.value).slice(0, 50);
    return '';
  }

  // ═══ Pseudo-element / CSS content text (innerText misses ::before/::after) ═══
  function pseudoContent(el) {
    try {
      var parts = [];
      ['::before', '::after'].forEach(function (p) {
        var c = window.getComputedStyle(el, p).content;
        if (c && c !== 'none' && c !== 'normal' && c !== '""' && c !== "''") parts.push(String(c).replace(/^["']|["']$/g, ''));
      });
      return parts.join(' ');
    } catch (_) { return ''; }
  }
  function fullText(el) {
    var t = (el.innerText || el.textContent || '').trim();
    var p = pseudoContent(el);
    if (p && t.indexOf(p) === -1) t = (t + ' ' + p).trim();
    return t;
  }

  function getAttrs(el) {
    const attrs = {};
    const names = el.getAttributeNames ? el.getAttributeNames() : [];
    for (const name of names) { const v = el.getAttribute(name); if (v !== null) attrs[name] = v; }
    return attrs;
  }

  function classifyAction(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = getAttrs(el);
    const role = attrs.role || '';
    const type = attrs.type || '';
    const style = window.getComputedStyle(el);

    if (tag === 'a' && attrs.href) return { type:'navigation', subtype:'link', href:attrs.href, target:attrs.target||'_self' };
    if (tag === 'a') return { type:'action', subtype:'anchor_button' };
    if (tag === 'input' || tag === 'textarea') {
      if (type === 'checkbox') return { type:'toggle', subtype:'checkbox' };
      if (type === 'radio') return { type:'toggle', subtype:'radio' };
      if (type === 'submit' || type === 'image') { const f = el.closest('form'); return { type:'form_submit', subtype:'input_submit', formRef: f?assignRef(f):null }; }
      if (type === 'file') return { type:'file_upload', subtype:'file' };
      if (type === 'button') return { type:'action', subtype:'input_button' };
      return { type:'form_input', subtype: type||'text' };
    }
    if (tag === 'select') return { type:'form_input', subtype:'select' };
    if (el.isContentEditable || attrs.contenteditable === 'true') return { type:'form_input', subtype:'contenteditable' };
    if (attrs['aria-haspopup'] === 'dialog' || attrs['aria-haspopup'] === 'true' || attrs['data-toggle'] === 'modal' || attrs['data-bs-toggle'] === 'modal')
      return { type:'modal_trigger', subtype: tag==='button'?'button':role||'element', target: attrs['aria-controls']||(attrs['data-target']||'').replace('#','') };
    if (attrs['aria-haspopup'] === 'menu' || attrs['data-toggle'] === 'dropdown' || attrs['data-bs-toggle'] === 'dropdown' || el.classList.contains('dropdown-toggle'))
      return { type:'dropdown_trigger', subtype: tag==='button'?'button':role||'element', target: attrs['aria-controls']||'' };
    if (role === 'tab' || attrs['data-toggle'] === 'tab' || attrs['data-bs-toggle'] === 'tab')
      return { type:'tab_trigger', subtype:'tab', target: attrs['aria-controls']||'', selected: attrs['aria-selected']==='true' };
    if (tag === 'summary' || (role === 'button' && attrs['aria-expanded'] !== undefined))
      return { type:'expand_collapse', subtype:'button', expanded: attrs['aria-expanded']==='true' };
    if (tag === 'details') return { type:'expand_collapse', subtype:'details', expanded: el.open };
    if (role === 'switch' || attrs['aria-pressed'] !== undefined)
      return { type:'toggle', subtype: role==='switch'?'switch':'button', pressed: attrs['aria-pressed']==='true' };
    if (tag === 'button') {
      if (type === 'submit') { const f = el.closest('form'); return { type:'form_submit', subtype:'button', formRef: f?assignRef(f):null }; }
      const f = el.closest('form');
      if (f) { const btns = f.querySelectorAll('button[type="submit"], button:not([type])'); if (btns.length === 1 && btns[0] === el) return { type:'form_submit', subtype:'button', formRef: assignRef(f) }; }
      return { type:'action', subtype:'button' };
    }
    if (INTERACTIVE_ROLES.has(role)) return { type:'action', subtype:role };
    if (style.cursor === 'pointer') return { type:'action', subtype:'clickable' };
    return { type:'unknown', subtype:tag };
  }

  // ═══ A3 (2026-08-10): INTENT DETECTION ═══
  // Pure-JS heuristics that tag an element with its SEMANTIC PURPOSE —
  // "submit login form", "enter password", "search", "cancel modal". No LLM on
  // the page. The agent can then find elements by INTENT, not just by type.
  const INTENT_BUTTON_TEXT = {
    'submit': ['submit','send','save','ok','confirm','create','add','update','continue','next','done','apply','register','sign up','signup','get started'],
    'login': ['login','log in','sign in','signin','enter','authenticate'],
    'search': ['search','find','lookup','query','go'],
    'cancel': ['cancel','close','dismiss','back','never mind','x'],
    'delete': ['delete','remove','trash','discard','clear'],
    'logout': ['logout','log out','sign out','signout'],
    'accept': ['accept','agree','allow','yes','approve'],
    'reject': ['reject','deny','decline','no thanks','no'],
  };
  const INTENT_INPUT_TYPE = { 'password':'enter password', 'email':'enter email', 'search':'search', 'tel':'enter phone', 'number':'enter number', 'url':'enter url', 'date':'pick date', 'file':'attach file' };
  const INTENT_AUTOCOMPLETE = { 'current-password':'enter password', 'new-password':'set password', 'email':'enter email', 'username':'enter username', 'tel':'enter phone', 'one-time-code':'enter OTP' };
  const INTENT_PLACEHOLDER = { 'password':'enter password', 'email':'enter email', 'search':'search', 'username':'enter username', 'phone':'enter phone', 'otp':'enter OTP', 'code':'enter code' };

  function detectIntent(el, c) {
    try {
      const tag = el.tagName.toLowerCase();
      const attrs = getAttrs(el);
      const label = (getLabel(el) || '').toLowerCase().trim();
      const ph = (attrs.placeholder || '').toLowerCase().trim();
      const auto = (attrs.autocomplete || '').toLowerCase().trim();
      const txt = (el.innerText || el.textContent || '').toLowerCase().trim().slice(0, 30);

      // Inputs: type > autocomplete > placeholder > label
      if (tag === 'input' || tag === 'textarea') {
        const t = (attrs.type || 'text').toLowerCase();
        if (INTENT_INPUT_TYPE[t]) return INTENT_INPUT_TYPE[t];
        if (INTENT_AUTOCOMPLETE[auto]) return INTENT_AUTOCOMPLETE[auto];
        if (INTENT_PLACEHOLDER[ph]) return INTENT_PLACEHOLDER[ph];
        for (const [kw, intent] of Object.entries(INTENT_PLACEHOLDER)) { if (label.includes(kw)) return intent; }
        if (c && c.type === 'form_input') return 'enter ' + (label || t || 'value');
        return 'enter text';
      }
      // Buttons/links: text match against intent tables
      if (tag === 'button' || tag === 'a' || (c && (c.type === 'form_submit' || c.type === 'action'))) {
        const hay = txt + ' ' + label;
        for (const [intent, kws] of Object.entries(INTENT_BUTTON_TEXT)) {
          for (const kw of kws) { if (hay.includes(kw)) return intent; }
        }
        if (c && c.type === 'form_submit') return 'submit';
        return 'action';
      }
      if (c && c.type === 'modal_trigger') return 'open dialog';
      if (c && c.type === 'dropdown_trigger') return 'open menu';
      if (c && c.type === 'tab_trigger') return 'switch view';
      if (c && c.type === 'expand_collapse') return (c.expanded ? 'collapse' : 'expand');
      if (c && c.type === 'toggle') return 'toggle';
      if (c && c.type === 'file_upload') return 'attach file';
      if (c && c.type === 'navigation') return 'navigate';
      return 'unknown';
    } catch (_) { return 'unknown'; }
  }

  // A3: find elements by intent — returns refs matching a semantic intent.
  function findIntent(intentQuery) {
    const q = (intentQuery || '').toLowerCase().trim();
    if (!q) return { success: false, error: 'intent required (e.g. "submit", "password", "search")' };
    const all = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="tab"], [role="dialog"]'));
    const matches = [];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const c = classifyAction(el);
      const intent = detectIntent(el, c);
      const labelText = (getLabel(el) || '').toLowerCase();
      const hrefText = ((c.href || '') + '').toLowerCase();
      if (intent.includes(q) || q.includes(intent) || (el.getAttribute('name')||'').toLowerCase().includes(q) || (el.getAttribute('id')||'').toLowerCase().includes(q) || labelText.includes(q) || hrefText.includes(q)) {
        matches.push({ ref: assignRef(el), intent, type: c.type, subtype: c.subtype, label: getLabel(el).slice(0, 60), locator: (buildLocator(el)||[])[0] || null });
      }
    }
    return { success: true, query: q, count: matches.length, matches: matches.slice(0, 15) };
  }

  // ═══ A7 (2026-08-10): NO-DUMP CONTRACT ═══
  // explore_intent(goal): given a natural-language goal, return ONLY the
  // elements relevant to that goal — filtered in the content script, not in
  // the agent's context. Combines A3 intent tags with goal-keyword matching.
  // This is the anti-explore_page: no 125KB dump, just the handful of elements
  // that matter for the task at hand.
  const GOAL_ALIASES = {
    'submit': ['submit','send','save','confirm','ok','done','apply','continue','next','create','add','update','register','sign up'],
    'login': ['login','log in','sign in','signin','authenticate','password','username','email'],
    'search': ['search','find','lookup','query'],
    'password': ['password','pass','secret'],
    'email': ['email','mail','e-mail'],
    'cancel': ['cancel','close','dismiss','back'],
    'delete': ['delete','remove','trash','discard'],
    'upload': ['upload','attach','file','choose file'],
    'download': ['download','export','save as'],
    'filter': ['filter','sort','category'],
    'chat': ['chat','message','send','composer','reply','dm'],
    'comment': ['comment','reply','post'],
    'settings': ['settings','preferences','options','config'],
  };

  function exploreIntent(goal) {
    const g = (goal || '').toLowerCase().trim();
    if (!g) return { success: false, error: 'goal required (e.g. "submit the form", "log in", "search")' };
    // Expand the goal into keywords: goal words + aliases for matched intents
    const keywords = new Set(g.split(/\s+/).filter((w) => w.length > 2));
    for (const [intent, aliases] of Object.entries(GOAL_ALIASES)) {
      if (g.includes(intent)) { for (const a of aliases) keywords.add(a); }
      else { for (const a of aliases) { if (g.includes(a)) { for (const a2 of aliases) keywords.add(a2); break; } } }
    }
    const all = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="tab"], [role="dialog"], form'));
    const relevant = [];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const c = classifyAction(el);
      const intent = detectIntent(el, c);
      const label = (getLabel(el) || '').toLowerCase();
      const name = (el.getAttribute('name') || '').toLowerCase();
      const id = (el.getAttribute('id') || '').toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const hay = intent + ' ' + label + ' ' + name + ' ' + id + ' ' + ph;
      // Score: how many goal keywords does this element touch?
      let score = 0;
      for (const kw of keywords) { if (hay.includes(kw)) score++; }
      // An intent match on a goal keyword is the strongest signal
      if (score > 0 || Array.from(keywords).some((kw) => intent.includes(kw))) {
        relevant.push({ ref: assignRef(el), intent, type: c.type, subtype: c.subtype, label: getLabel(el).slice(0, 60), score, locator: (buildLocator(el)||[])[0] || null });
      }
    }
    relevant.sort((a, b) => b.score - a.score);
    return { success: true, goal: g, keywords: Array.from(keywords), count: relevant.length, matches: relevant.slice(0, 12),
      hint: relevant.length ? relevant.slice(0, 5).map((m) => m.intent + ' (' + m.label + ')').join(' | ') : 'no goal-relevant elements found' };
  }

  // ═══ State Detection ═══
  function detectDisabledReason(el) {
    if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') return null;
    const form = el.closest('form');
    if (form) { const req = form.querySelectorAll('input[required],textarea[required],select[required]'); for (const f of req) { if (!f.value && f.type!=='checkbox' && f.type!=='radio') return 'required_fields_empty'; } }
    if (el.getAttribute('aria-disabled') === 'true') return 'aria_disabled';
    return 'disabled';
  }

  function extractState(el) {
    const a = getAttrs(el);
    return {
      disabled: el.disabled||a['aria-disabled']==='true', disabledReason: detectDisabledReason(el),
      checked: el.checked||a['aria-checked']==='true', expanded: a['aria-expanded']==='true',
      selected: a['aria-selected']==='true', pressed: a['aria-pressed']==='true',
      required: el.required||a.required!==undefined, readOnly: el.readOnly||a.readonly!==undefined,
      valid: el.validity?el.validity.valid:null, error: el.validationMessage||null,
      value: el.value!==undefined?el.value:null, visible: isVisible(el), inViewport: isInViewport(el),
    };
  }

  function resolveUrl(href) { try { return new URL(href, window.location.href).href; } catch(_) { return href; } }

  function predictEffect(el, c, attrs) {
    switch (c.type) {
      case 'navigation': return 'navigate_to:'+resolveUrl(c.href);
      case 'form_submit': { const f=el.closest('form'); return 'submit_form:'+(f?(f.getAttribute(REF_ATTR)||'?'):'?')+' -> '+(f?(f.method||'GET').toUpperCase():'GET')+' '+(f?f.action:'current'); }
      case 'modal_trigger': return 'open_modal:#'+(c.target||'unknown');
      case 'dropdown_trigger': return 'open_dropdown:#'+(c.target||'unknown');
      case 'tab_trigger': return 'switch_tab:#'+(c.target||'unknown');
      case 'toggle': return 'toggle:'+(attrs.name||'state')+' -> '+(c.pressed||attrs['aria-checked']==='true'?'off':'on');
      case 'expand_collapse': return (c.expanded?'collapse':'expand')+':'+getLabel(el).slice(0,30);
      case 'file_upload': return 'file_upload:open_file_dialog';
      default: return 'click:unknown_effect';
    }
  }

  // ═══ Form Extraction ═══
  function findFieldLabel(input) {
    if (input.id) { const l = document.querySelector('label[for="'+CSS.escape(input.id)+'"]'); if (l) return (l.innerText||l.textContent||'').trim(); }
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label').trim();
    const lb = input.getAttribute('aria-labelledby'); if (lb) { const el = document.getElementById(lb); if (el) return (el.innerText||el.textContent||'').trim(); }
    if (input.placeholder) return input.placeholder.trim();
    const pl = input.closest('label'); if (pl) { const t = (pl.innerText||pl.textContent||'').trim(); if (t && t !== input.value) return t.slice(0,100); }
    if (input.getAttribute('title')) return input.getAttribute('title').trim();
    return '';
  }
  function findSubmitButton(form) {
    const s = form.querySelector('button[type="submit"],input[type="submit"]'); if (s) return s;
    const btns = form.querySelectorAll('button,input[type="button"]');
    for (const b of btns) { const t=(b.innerText||b.value||b.textContent||'').toLowerCase(); if (t.includes('submit')||t.includes('apply')||t.includes('send')||t.includes('save')||t.includes('next')) return b; }
    return null;
  }
  function isFormSubmittable(form) {
    const req = form.querySelectorAll('[required]');
    for (const f of req) { if (f.type==='checkbox'&&!f.checked) return false; if (f.type==='radio') { if (!form.querySelector('input[type="radio"][name="'+CSS.escape(f.name)+'"]:checked')) return false; continue; } if (!f.value||!f.value.trim()) return false; }
    return true;
  }
  function extractSelectOptions(sel) { return Array.from(sel.options).map((o)=>({value:o.value,text:(o.textContent||'').trim(),selected:o.selected})); }
  function extractForms() {
    return Array.from(document.querySelectorAll('form')).filter(isVisible).map((form) => {
      const formRef = assignRef(form);
      const fields = Array.from(form.querySelectorAll('input,select,textarea')).filter((el)=>el.type!=='hidden').map((input) => {
        const tag = input.tagName.toLowerCase();
        return { ref:assignRef(input), tag, type:input.type||(tag==='select'?'select':tag), name:input.name||'', label:findFieldLabel(input), placeholder:input.placeholder||'', value:input.value||'', required:input.required, valid:input.validity?input.validity.valid:null, error:input.validationMessage||null, checked:input.checked||false, disabled:input.disabled, options:tag==='select'?extractSelectOptions(input):undefined };
      });
      const sb = findSubmitButton(form); const sub = isFormSubmittable(form);
      return { ref:formRef, id:form.id||'', method:(form.method||'get').toLowerCase(), action:form.action||'', fields, submitRef:sb?assignRef(sb):null, submitLabel:sb?getLabel(sb):'', submitEnabled:sb?!sb.disabled&&sub:false, submitDisabledReason:sb?(sb.disabled?detectDisabledReason(sb):(!sub?'required_fields_not_met':null)):null };
    });
  }

  // getFormState (2026-08-31 full-tool sweep): the form{action:"state"} tool
  // hit "getFormState is not defined" — the function was referenced in the
  // message switch but NEVER implemented (dead tool since the 65→20 merge).
  // One-form variant of extractForms: resolves the formRef (E# or selector),
  // returns the SAME shape as a form entry in the SAG so agents can diff
  // form{state} against explore_page output directly.
  function getFormState(formRef, frameId) {
    const el = formRef ? resolveRef(formRef) : null;
    if (!el || el.tagName !== 'FORM') return { success: false, error: el ? 'ref ' + formRef + ' is not a <form> (got ' + el.tagName + ')' : 'form ref not found: ' + (formRef || '(none)') };
    const all = extractForms();
    const found = all.find((f) => f.ref === formRef) || extractForms().find((f) => f.id === (formRef||'').replace(/^#/,''));
    if (found) return { success: true, form: found };
    // Fallback: rebuild for just this form (extractForms may skip hidden forms)
    const fields = Array.from(el.querySelectorAll('input,select,textarea')).filter((i)=>i.type!=='hidden').map((input) => {
      const tag = input.tagName.toLowerCase();
      return { ref:assignRef(input), tag, type:input.type||(tag==='select'?'select':tag), name:input.name||'', label:findFieldLabel(input), placeholder:input.placeholder||'', value:input.value||'', required:input.required, valid:input.validity?input.validity.valid:null, error:input.validationMessage||null, checked:input.checked||false, disabled:input.disabled, options:tag==='select'?extractSelectOptions(input):undefined };
    });
    const sb = findSubmitButton(el); const sub = isFormSubmittable(el);
    return { success: true, form: { ref: formRef, id: el.id||'', method:(el.method||'get').toLowerCase(), action:el.action||'', fields, submitRef:sb?assignRef(sb):null, submitLabel:sb?getLabel(sb):'', submitEnabled:sb?!sb.disabled&&sub:false, submitDisabledReason:sb?(sb.disabled?detectDisabledReason(sb):(!sub?'required_fields_not_met':null)):null } };
  }

  // ═══ Content Intelligence: read_content + scroll_and_extract ═══

  function readContent(params) {
    // Smart content extraction for heavy SPA pages.
    // Tries multiple heuristics to find the main content, skipping nav/ads/sidebar.
    var maxLen = (params && params.maxLen) || 12000;
    var selector = params && params.selector;
    var result = { text: '', method: '', elements: 0, url: location.href, title: document.title };

    // Method 1: Explicit selector
    if (selector) {
      var els = document.querySelectorAll(selector);
      var texts = [];
      els.forEach(function (el) { var t = (el.innerText || el.textContent || '').trim(); if (t) texts.push(t); });
      result.text = texts.join('\n\n').slice(0, maxLen);
      result.method = 'selector:' + selector;
      result.elements = els.length;
      if (result.text.length > 0) return result;
    }

    // Method 2: Main content containers (high priority) — site quirks first, then generic
    var mainSelectors = siteContentSelectors().concat([
      'article', 'main', '[role="main"]',
      '.post-content', '.entry-content', '.article-content',
      '.product-description', '.description',
      '.markdown-body', '.prose',
      '[data-testid="tweetText"]', // x.com tweets
      '[data-testid="cellInnerDiv"]', // x.com timeline
    ]);
    for (var i = 0; i < mainSelectors.length && result.text.length < 200; i++) {
      var elements = document.querySelectorAll(mainSelectors[i]);
      result.elements += elements.length;
      var parts = [];
      elements.forEach(function (el) {
        var t = (el.innerText || el.textContent || '').trim();
        if (t.length > 30) parts.push(t);
      });
      if (parts.length > 0) {
        result.text = parts.join('\n\n').slice(0, maxLen);
        result.method = 'main:' + mainSelectors[i];
      }
    }
    if (result.text.length > 200) return result;

    // Method 3:段落 and list items extraction (good for structured content)
    var paraTexts = [];
    var paras = document.querySelectorAll('p, li, h1, h2, h3, blockquote, td, [role="text"], [data-testid]');
    paras.forEach(function (el) {
      if (!isVisible(el)) return;
      var t = (el.innerText || el.textContent || '').trim();
      if (t.length > 10 && t.length < 2000) paraTexts.push(t);
    });
    if (paraTexts.length > 5) {
      result.text = paraTexts.join('\n').slice(0, maxLen);
      result.method = 'paragraphs';
      result.elements = paraTexts.length;
      if (result.text.length > 200) return result;
    }

    // Method 4: Full body text via smarter walk (including span, a, button text)
    result.text = extractBodyText(maxLen);
    result.method = 'body-walk';
    return result;
  }

  // ── dump_markdown (borrowed from Lightpanda's --dump markdown, 2026-08-10) ──
  // Convert a page (or a selector's subtree) to clean Markdown. CSP-safe: pure
  // DOM walk, no eval. Reuses readContent's container detection for the default.
  function nativeDumpMarkdown(params) {
    var maxLen = (params && params.maxLen) || 20000;
    var selector = params && params.selector;
    var root = null;
    var method = '';

    if (selector) {
      root = document.querySelector(selector);
      method = 'selector:' + selector;
      if (!root) return { success: true, markdown: '', title: document.title, url: location.href, elements: 0, method: method + ' (no match)' };
    } else {
      // Reuse readContent's main-container detection.
      var mainSelectors = siteContentSelectors().concat([
        'article', 'main', '[role="main"]',
        '.post-content', '.entry-content', '.article-content',
        '.markdown-body', '.prose',
        '[data-testid="tweetText"]',
      ]);
      for (var i = 0; i < mainSelectors.length; i++) {
        var els = document.querySelectorAll(mainSelectors[i]);
        if (els.length) {
          var best = null, bestLen = 0;
          for (var j = 0; j < els.length; j++) {
            var t = (els[j].innerText || els[j].textContent || '').trim();
            if (t.length > bestLen) { bestLen = t.length; best = els[j]; }
          }
          if (best && bestLen > 30) { root = best; method = 'main:' + mainSelectors[i]; break; }
        }
      }
      if (!root) { root = document.body; method = 'body'; }
    }

    var parts = [];
    var st = { count: 0 };
    var elementCount = 0;
    walkMarkdown(root, parts, 0, st);
    elementCount = st.count;
    var md = parts.join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (md.length > maxLen) md = md.slice(0, maxLen) + '\n\n...[TRUNCATED — raise maxLen or pass a narrower selector]';

    return {
      success: true,
      markdown: md,
      title: document.title,
      url: location.href,
      elements: elementCount,
      method: method,
    };

    function walkMarkdown(node, out, depth, st) {
      if (!node || !node.tagName) return;
      var tag = node.tagName.toLowerCase();
      if (node.nodeType === 3) { // text node
        var tx = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (tx) out[out.length - 1] = (out[out.length - 1] || '') + tx;
        return;
      }
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'iframe' || tag === 'svg' || tag === 'canvas' || tag === 'template' || tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'form' || tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'label' || tag === 'aside' || tag === 'figure') return;
      if (!isVisible(node)) return;

      // Skip empty containers quickly.
      var ownText = (node.innerText || node.textContent || '').trim();
      if (!ownText && tag !== 'img' && tag !== 'br' && tag !== 'hr' && tag !== 'table') return;

      var block = ['p','div','section','article','li','blockquote','pre','td','th','tr','table','ul','ol','h1','h2','h3','h4','h5','h6','dl','dt','dd','hr','br'].indexOf(tag) >= 0;
      if (block) {
        var prev = out.length ? out[out.length - 1] : '';
        if (prev !== '' && !/^\n+$/.test(prev)) out.push('');
      }

      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
          var lvl = parseInt(tag[1], 10);
          var ht = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (ht) { out.push(Array(lvl + 1).join('#') + ' ' + ht); st.count++; }
          return;
        }
        case 'img': {
          var src = node.getAttribute('src') || '';
          var alt = node.getAttribute('alt') || '';
          if (src) { out.push('![' + alt + '](' + src + ')'); st.count++; }
          return;
        }
        case 'a': {
          var href = node.getAttribute('href') || '';
          var at = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (at && href && href.indexOf('javascript:') !== 0) { out.push('[' + at + '](' + href + ')'); st.count++; return; }
          if (at) { out.push(at); st.count++; return; }
          break;
        }
        case 'br': out.push(''); return;
        case 'hr': out.push('---'); return;
        case 'ul': case 'ol': {
          var items = node.children;
          for (var i2 = 0; i2 < items.length; i2++) {
            var li = items[i2];
            if (li.tagName && li.tagName.toLowerCase() === 'li') {
              var lt = (li.innerText || li.textContent || '').replace(/\s+/g, ' ').trim();
              if (lt) { out.push((tag === 'ol' ? (i2 + 1) + '. ' : '- ') + lt); st.count++; }
            }
          }
          return;
        }
        case 'blockquote': {
          var qt = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (qt) { out.push('> ' + qt); st.count++; }
          return;
        }
        case 'pre': case 'code': {
          var ct = (node.innerText || node.textContent || '');
          if (ct.trim()) { out.push('```\n' + ct.replace(/\n{3,}/g, '\n\n').trim() + '\n```'); st.count++; }
          return;
        }
        case 'table': {
          var rows = node.querySelectorAll('tr');
          for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].querySelectorAll('th, td');
            var rowMd = [];
            for (var c = 0; c < cells.length; c++) rowMd.push(' ' + (cells[c].innerText || '').replace(/\s+/g, ' ').trim() + ' ');
            if (rowMd.length) out.push('|' + rowMd.join('|') + '|');
          }
          if (rows.length > 1) {
            var headerCells = rows[0].querySelectorAll('th, td');
            out.push('|' + Array(headerCells.length + 1).join(' --- |'));
          }
          st.count += rows.length;
          return;
        }
      }

      // Recurse into children for generic containers.
      var kids = node.children || [];
      for (var k = 0; k < kids.length; k++) walkMarkdown(kids[k], out, depth + 1, st);
    }
  }

  async function scrollAndExtract(params) {
    // Scroll the page N times, collecting new content after each scroll.
    // Great for infinite scroll pages (x.com timeline, lemonsqueezy product grids).
    var scrolls = (params && params.scrolls) || 5;
    var scrollDelay = (params && params.scrollDelay) || 1500; // ms between scrolls
    var maxLen = (params && params.maxLen) || 20000;
    var direction = (params && params.direction) || 'down';
    var selector = params && params.selector;
    var seenText = new Set();
    var allChunks = [];
    var result = { chunks: [], totalText: '', scrollCount: 0, url: location.href, title: document.title, finalScrollY: 0 };

    for (var s = 0; s < scrolls; s++) {
      // Scroll
      nativeScroll(direction, 500, null);
      result.scrollCount++;

      // Wait for lazy content to load
      await new Promise(function (r) { setTimeout(r, scrollDelay); });

      // Extract visible content
      var content = readContent({ selector: selector, maxLen: maxLen });
      var text = content.text || '';

      // Only keep new content we haven't seen before
      var lines = text.split('\n').filter(function (l) {
        var lt = l.trim();
        if (lt.length < 5) return false;
        if (seenText.has(lt)) return false;
        seenText.add(lt);
        return true;
      });

      if (lines.length > 0) {
        var chunk = lines.join('\n');
        allChunks.push({ scroll: s + 1, lines: lines.length, preview: chunk.slice(0, 200) });
        result.chunks.push({ scroll: s + 1, text: chunk });
      }
    }

    result.totalText = result.chunks.map(function (c) { return c.text; }).join('\n\n').slice(0, maxLen);
    result.finalScrollY = window.scrollY;
    result.totalLines = result.totalText.split('\n').length;
    return result;
  }

  // ═══ Lazy-load defeat + real scroll container ═══
  // Research-verified: x.com scrolls an INNER div — window.scrollTo is a silent
  // no-op there. Find the real scroll container, then force-eager every lazy
  // resource so explore/read see everything without manual scrolling.

  function findScrollContainer() {
    // 1. The documentElement if IT scrolls
    var de = document.documentElement;
    if (de.scrollHeight > de.clientHeight + 50) return de;
    // 2. Walk body ancestors for the tallest overflow-auto/scroll container
    var candidates = [];
    var el = document.body;
    while (el && el !== document.documentElement) {
      try {
        var st = window.getComputedStyle(el);
        var oy = st.overflowY;
        if (/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 50) {
          candidates.push({ el: el, h: el.scrollHeight - el.clientHeight });
        }
      } catch (_) {}
      el = el.parentElement;
    }
    if (candidates.length) {
      candidates.sort(function (a, b) { return b.h - a.h; });
      return candidates[0].el;
    }
    // 3. Fallback: any element with a big scrollHeight
    var all = document.querySelectorAll('div, main, section');
    var best = null, bestH = 0;
    for (var i = 0; i < all.length && i < 2000; i++) {
      var e = all[i];
      var h = e.scrollHeight - e.clientHeight;
      if (h > bestH) { bestH = h; best = e; }
    }
    return best || de;
  }

  function scrollContainerY(container) {
    if (!container) return 0;
    return (container === document.documentElement) ? window.scrollY : container.scrollTop;
  }

  // ═══ A5 (2026-08-10): GEOMETRY ANSWERS ═══
  // Spatial reasoning without vision: bounding boxes, z-order, and layout
  // relations computed against the REAL scroll container (PITFALL 31 —
  // x.com scrolls an inner div, not window). Answers "is the modal over the
  // form?", "what's above X?" from data, not pixels.
  // P0#3 (2026-08-31): convert a ref's viewport center to PHYSICAL SCREEN
  // coordinates for a genuine OS-level click. A real OS click needs screen
  // pixels, not viewport CSS pixels. Formula:
  //   screenX = window.screenX + chromeLeftX + viewportCenterX
  //   screenY = window.screenY + chromeTopY + viewportCenterY
  // where the chrome offsets are the difference between window and inner
  // (viewport) edges — tab strip + toolbar on top, scrollbar/rounding on
  // left. devicePixelRatio converts CSS px to physical px on HiDPI (the
  // caller sends these coords to the OS, which thinks in physical pixels).
  function screenCenter(refOrSelector) {
    let el = null;
    if (refOrSelector && /^E\d+$/.test(refOrSelector)) el = resolveRef(refOrSelector);
    if (!el && refOrSelector) { try { el = document.querySelector(refOrSelector); } catch (_) {} }
    if (!el) return { success: false, error: 'element not found: ' + (refOrSelector || '?') };
    const rect = el.getBoundingClientRect();
    // viewport center (CSS px)
    const vx = rect.left + rect.width / 2;
    const vy = rect.top + rect.height / 2;
    // window chrome offsets: window outer edge vs inner viewport edge
    const chromeLeft = (window.outerWidth - window.innerWidth) / 2 || 0;
    const chromeTop = (window.outerHeight - window.innerHeight) || 0;
    const screenX = (window.screenX || 0) + chromeLeft + vx;
    const screenY = (window.screenY || 0) + chromeTop + vy;
    const dpr = window.devicePixelRatio || 1;
    return {
      success: true,
      ref: refOrSelector,
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      // viewport CSS px center (what the CS/nativeClickXY uses)
      viewport: { x: Math.round(vx), y: Math.round(vy) },
      // physical screen px center (what a real OS click needs)
      screen: { x: Math.round(screenX * dpr), y: Math.round(screenY * dpr) },
      dpr: dpr,
      chrome: { left: Math.round(chromeLeft), top: Math.round(chromeTop) },
      text: (el.innerText || el.textContent || '').trim().slice(0, 60),
    };
  }

  function getGeometry(refOrSelector) {
    let el = null;
    if (refOrSelector && /^E\d+$/.test(refOrSelector)) el = resolveRef(refOrSelector);
    if (!el && refOrSelector) { try { el = document.querySelector(refOrSelector); } catch (_) {} }
    if (!el) return { success: false, error: 'element not found: ' + (refOrSelector || '?') };
    const sc = findScrollContainer();
    const rect = el.getBoundingClientRect();
    const srect = sc.getBoundingClientRect();
    // z-order: walk ancestors counting positioned elements
    let z = 0, node = el;
    while (node && node !== document.body) {
      try { const st = window.getComputedStyle(node); if (st.position !== 'static') z++; } catch (_) {}
      node = node.parentElement;
    }
    const st = window.getComputedStyle(el);
    return {
      success: true,
      ref: refOrSelector,
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      viewport: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      // Coordinates relative to the REAL scroll container (x.com inner div)
      container: { tag: sc.tagName ? sc.tagName.toLowerCase() : 'window', id: sc.id || '', cls: (sc.className || '').toString().slice(0, 40) },
      containerPos: { x: Math.round(rect.x - srect.x), y: Math.round(rect.y - srect.y + scrollContainerY(sc)), w: Math.round(rect.width), h: Math.round(rect.height) },
      scroll: { containerY: Math.round(scrollContainerY(sc)), containerMaxY: Math.round((sc.scrollHeight || 0) - (sc.clientHeight || 0)) },
      zDepth: z,
      position: st.position,
      zIndex: st.zIndex && st.zIndex !== 'auto' ? st.zIndex : null,
      text: (el.innerText || el.textContent || '').trim().slice(0, 60),
    };
  }

  // A5: layout relations — above / below / covers / overlaps
  function layoutRelation(refA, refB) {
    const a = getGeometry(refA);
    const b = getGeometry(refB);
    if (!a.success || !b.success) return { success: false, error: 'one or both elements not found' };
    const ar = a.viewport, br = b.viewport;
    const aBottom = ar.y + ar.h, bBottom = br.y + br.h;
    let relation = 'separate';
    if (ar.x < br.x + br.w && ar.x + ar.w > br.x && ar.y < bBottom && aBottom > br.y) {
      relation = 'overlaps';
      // covers: A fully contains B in both axes AND is on top (later DOM/z)
      if (ar.x <= br.x && ar.x + ar.w >= br.x + br.w && ar.y <= br.y && aBottom >= bBottom) {
        relation = (a.zDepth >= b.zDepth) ? 'covers' : 'covered_by';
      }
    } else if (aBottom <= br.y) relation = 'above';
    else if (ar.y >= bBottom) relation = 'below';
    return { success: true, relation, a: a.ref || a.tag, b: b.ref || b.tag,
      aBox: ar, bBox: br, hint: relation === 'above' ? a.tag + ' is above ' + b.tag : relation === 'covers' ? a.tag + ' covers ' + b.tag + ' (modal?)' : relation };
  }

  function forceEagerAll() {
    // (a) Native lazy loading: attribute rewrite re-triggers fetch immediately.
    var imgs = document.querySelectorAll('img[loading="lazy"]');
    var lazyCount = 0;
    for (var i = 0; i < imgs.length; i++) { imgs[i].loading = 'eager'; lazyCount++; }
    // (b) data-src / data-srcset framework loaders (lozad, vanilla-lazyload...)
    var ds = document.querySelectorAll('[data-src], [data-srcset], [data-original]');
    var dataCount = 0;
    for (var j = 0; j < ds.length; j++) {
      var d = ds[j];
      if (d.getAttribute('data-src') && !d.getAttribute('src')) { d.setAttribute('src', d.getAttribute('data-src')); dataCount++; }
      if (d.getAttribute('data-srcset') && !d.getAttribute('srcset')) { d.setAttribute('srcset', d.getAttribute('data-srcset')); }
      if (d.getAttribute('data-original') && !d.getAttribute('src')) { d.setAttribute('src', d.getAttribute('data-original')); dataCount++; }
    }
    // (c) content-visibility:auto subtrees render lazily — force visible.
    var cv = document.querySelectorAll('[style*="content-visibility"], [style*="content-visibility"]');
    var cvCount = 0;
    var cvAll = document.querySelectorAll('*');
    for (var k = 0; k < cvAll.length && k < 5000; k++) {
      try {
        var cvs = window.getComputedStyle(cvAll[k]).contentVisibility;
        if (cvs === 'auto') { cvAll[k].style.contentVisibility = 'visible'; cvCount++; }
      } catch (_) {}
    }
    // (d) synthetic resize + scroll nudge to trigger IO callbacks
    try {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
    } catch (_) {}
    return { lazy: lazyCount, dataSrc: dataCount, contentVisibility: cvCount };
  }

  async function preloadPage(params) {
    // Combined lazy-load defeat: attribute pass → scroll sweep (real container)
    // → straggler prefetch → restore scroll. Returns stats + per-step notes.
    var maxSteps = (params && params.maxSteps) || 25;
    var settleMs = (params && params.settleMs) || 250;
    var restore = (params && params.restore) !== false;
    var stats = { eager: null, steps: 0, loadedNew: 0, finalY: 0, restored: false, container: 'window' };
    var startY = window.scrollY;

    // 1. Attribute pass — free, no scroll
    stats.eager = forceEagerAll();

    // 2. Scroll sweep on the REAL container
    var container = findScrollContainer();
    if (container !== document.documentElement) stats.container = 'inner';
    var lastH = container.scrollHeight || 0;
    var plateau = 0;
    for (var s = 0; s < maxSteps; s++) {
      var before = (container.scrollHeight || 0);
      if (container === document.documentElement) window.scrollBy(0, window.innerHeight * 0.8);
      else container.scrollTop += window.innerHeight * 0.8;
      stats.steps++;
      await new Promise(function (r) { setTimeout(r, settleMs); });
      // Re-run attribute pass each step (new lazy items appear)
      var st = forceEagerAll();
      stats.loadedNew += st.lazy + st.dataSrc;
      var now = container.scrollHeight || 0;
      if (now <= lastH + 5) { plateau++; if (plateau >= 3) break; } else plateau = 0;
      lastH = now;
      if (before === now && s > 2) { /* content stopped growing; one more try then bail */ if (plateau >= 2) break; }
    }

    // 3. Straggler prefetch (safe: new Image() uses <img> creds, no CORS issue)
    var pending = [];
    var allImgs = document.querySelectorAll('img');
    for (var p = 0; p < allImgs.length && p < 500; p++) {
      var im = allImgs[p];
      if (im.complete && im.naturalWidth === 0) continue; // broken/blocked — skip
      if (!im.src && im.getAttribute('data-src')) continue; // already handled
      if (im.src && im.complete) continue;
      if (im.src) pending.push(im.src);
    }
    var prefetched = 0;
    for (var q = 0; q < pending.length && q < 100; q++) {
      try { var img = new Image(); img.fetchPriority = 'low'; img.src = pending[q]; prefetched++; } catch (_) {}
    }
    stats.prefetched = prefetched;

    // 4. Restore scroll
    if (restore) {
      if (container === document.documentElement) window.scrollTo(0, startY);
      else { container.scrollTop = startY; window.scrollTo(0, startY); }
      stats.restored = true;
    }
    stats.finalY = container === document.documentElement ? window.scrollY : container.scrollTop;
    return stats;
  }

  // ═══ Site-quirks registry (borrowed from agentreach driver-per-platform) ═══
  // Per-site tuning without code changes: content selectors, scroll behavior,
  // label priorities. Matching is by hostname regex.
  var WS_SITE_QUIRKS = [
    { host: /(^|\.)x\.com$/, quirks: { name: 'x.com', scrollMode: 'auto', contentSelectors: ['[data-testid="tweetText"]', '[data-testid="cellInnerDiv"]', 'article'] } },
    { host: /(^|\.)twitter\.com$/, quirks: { name: 'twitter', scrollMode: 'auto', contentSelectors: ['[data-testid="tweetText"]', '[data-testid="cellInnerDiv"]', 'article'] } },
    { host: /(^|\.)lemonsqueezy\.com$/, quirks: { name: 'lemonsqueezy', scrollMode: 'auto', contentSelectors: ['.product-description', '.description', 'main', 'article'] } },
    { host: /(^|\.)youtube\.com$/, quirks: { name: 'youtube', scrollMode: 'window', contentSelectors: ['#description', '#comments', 'ytd-watch-metadata'] } },
    { host: /(^|\.)github\.com$/, quirks: { name: 'github', scrollMode: 'auto', contentSelectors: ['article.markdown-body', '.comment-body', 'main'] } },
    { host: /(^|\.)linkedin\.com$/, quirks: { name: 'linkedin', scrollMode: 'auto', contentSelectors: ['.feed-shared-update-v2', '.jobs-description__content', 'main'] } },
    { host: /(^|\.)reddit\.com$/, quirks: { name: 'reddit', scrollMode: 'auto', contentSelectors: ['shreddit-post', '[data-testid="post-container"]', 'main'] } },
  ];
  function getSiteQuirks() {
    var h = location.hostname || '';
    for (var i = 0; i < WS_SITE_QUIRKS.length; i++) {
      if (WS_SITE_QUIRKS[i].host.test(h)) return WS_SITE_QUIRKS[i].quirks;
    }
    return { name: h, scrollMode: 'auto', contentSelectors: [] };
  }
  function siteContentSelectors() {
    return getSiteQuirks().contentSelectors || [];
  }

  // ═══ End Content Intelligence ═══
  function detectSections(actions) {
    const sections = []; const sectionMap = new Map();
    function addSection(el, name) { if (!el||!isVisible(el)) return null; const ref='S'+sections.length; sections.push({ref,name,elements:[],description:getLabel(el).slice(0,80)||''}); sectionMap.set(el,ref); return ref; }
    document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]').forEach((d)=>{ if(isVisible(d)) addSection(d,'modal'); });
    const h = document.querySelector('header,[role="banner"]'); if (h) addSection(h,'header');
    document.querySelectorAll('nav,[role="navigation"]').forEach((n)=>{ if(isVisible(n)) addSection(n,'navigation'); });
    const m = document.querySelector('main,[role="main"]'); if (m) addSection(m,'main');
    document.querySelectorAll('aside,[role="complementary"]').forEach((a)=>{ if(isVisible(a)) addSection(a,'sidebar'); });
    const f = document.querySelector('footer,[role="contentinfo"]'); if (f) addSection(f,'footer');
    for (const action of actions) { const el = resolveRef(action.ref); if (el) { let found=false; for (const [se,sr] of sectionMap) { if (se.contains(el)) { action.section=sr; const s=sections.find((x)=>x.ref===sr); if(s) s.elements.push(action.ref); found=true; break; } } if(!found) action.section=null; } }
    return sections;
  }

  // ═══ Content Extraction ═══
  function extractHeadings() {
    const h = []; document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el)=>{ if(isVisible(el)){const t=(el.innerText||el.textContent||'').trim(); if(t)h.push(t);} }); return h.slice(0,20);
  }
  function extractBodyText(maxLen) {
    const max = maxLen || 8000;
    // Strategy: try common content containers first, then fall back to body walk.
    // This works for React/Vue/Angular SPAs where the content is in a specific
    // container, and also for vanilla pages where body has the content.
    var text = '';

    // 1. Try article/main content containers (site quirks first, then generic)
    var contentHosts = siteContentSelectors().concat([
      'article', 'main', '[role="main"]',
      '#content', '.content', '.main-content',
      '[data-testid="tweetText"]', // x.com
      '.timeline', '.stream',
      '.post-content', '.entry-content',
      '.product-description', '.description', // e-commerce
      '[data-testid]', // generic test-id containers
    ]);
    for (var i = 0; i < contentHosts.length && text.length < max; i++) {
      var els = document.querySelectorAll(contentHosts[i]);
      for (var j = 0; j < els.length && text.length < max; j++) {
        var t = (els[j].innerText || els[j].textContent || '').trim();
        if (t.length > 50) { // only meaningful text
          text += t + '\n\n';
        }
      }
    }

    // 2. If content containers didn't yield enough, do the full body walk
    if (text.length < 200) {
      text = '';
      function walk(n) {
        if (text.length >= max) return;
        if (n.nodeType === Node.TEXT_NODE) { const s = n.textContent.trim(); if (s) text += s + ' '; return; }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const tag = n.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'svg', 'template', 'head'].includes(tag)) return;
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return;
        const style = cachedStyle(n);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (/^(div|p|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|main|aside|blockquote|pre|ul|ol|table|form|fieldset|span|a|button|label)$/i.test(tag)) text += '\n';
        for (const c of n.childNodes) walk(c);
        if (/^(div|p|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|main|aside|blockquote|pre|ul|ol|table|form|fieldset)$/i.test(tag)) text += '\n';
      }
      walk(document.body);
    }

    text = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
    if (text.length > max) text = text.slice(0, max) + '...(truncated)';
    return text;
  }
  function extractPageType() {
    const url=window.location.href.toLowerCase(), title=(document.title||'').toLowerCase();
    if(url.includes('login')||title.includes('log in')||title.includes('sign in'))return'auth';
    if(url.includes('register')||url.includes('signup')||title.includes('sign up'))return'auth';
    if(url.includes('search')||title.includes('search'))return'search';
    if(url.includes('dashboard')||title.includes('dashboard'))return'app';
    if(url.includes('settings')||url.includes('profile'))return'settings';
    if(document.querySelector('article,.article,.post,.blog-post'))return'article';
    return'generic';
  }

  // ═══ Shadow DOM + Iframe Traversal ═══
  function getAllElements(root) {
    // Phase 4 (2026-08-15): OPTIONAL iframe recursion. With all_frames:true
    // every frame runs its own content script, but the model can't always
    // target frames by frameId, so the main-frame explore_page now ALSO walks
    // into SAME-ORIGIN iframes and tags each element with its frameId. Cross-
    // origin iframes (and ad frames) are skipped — they're not reachable from
    // here and have their own bridge. This makes explore_page return the FULL
    // interactive surface in one call instead of missing in-frame controls.
    const elements = [];
    function walk(node, frameId) {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        node.__wsFrameId = frameId;
        elements.push(node);
        if (node.shadowRoot) { for (const c of node.shadowRoot.children) walk(c, frameId); }
      }
      if (node.children) { for (const c of node.children) walk(c, frameId); }
    }
    walk(root || document.body, 0);
    // Recurse into same-origin iframes (top-level = frameId 0 already done).
    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(function (f, idx) {
        if (f.src && /^(https?:)?\/\//.test(f.src) && !sameOrigin(f.src)) return; // cross-origin: skip
        if (WS_IS_AD_FRAME) return; // never recurse ad frames
        try {
          const fd = f.contentDocument;
          if (fd && fd.body) walk(fd.body, idx + 1);
        } catch (_) { /* cross-origin or not ready — skip */ }
      });
    } catch (_) {}
    return elements;
  }

  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (_) { return false; }
  }

  // ═══ Main SAG Extraction (chunked + async for heavy DOMs) ═══
  // Process elements in batches with yield-between to avoid blocking the
  // main thread and to stay within the WebSocket response window.
  const BATCH_SIZE = 150; // elements per chunk
  const CHUNK_YIELD_MS = 0; // setTimeout(0) yield between chunks

  // Wait for the DOM to stop mutating (SPA hydration settle) before extraction.
  // React/Vue apps render progressively; exploring mid-hydration gives a
  // half-empty SAG. Default: wait up to 2.5s for a 400ms quiet window.
  function waitForSettle(maxWaitMs, quietMs) {
    return new Promise(function (resolve) {
      var maxWait = maxWaitMs || 2500;
      var quiet = quietMs || 400;
      var deadline = Date.now() + maxWait;
      var timer = null;
      function arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          observer.disconnect();
          resolve();
        }, quiet);
      }
      var observer = new MutationObserver(function () {
        if (Date.now() > deadline) { observer.disconnect(); if (timer) clearTimeout(timer); resolve(); return; }
        arm();
      });
      try { observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (_) { resolve(); return; }
      arm();
    });
  }

  function extractActionGraphSync(options) {
    // Quick synchronous path for small pages (used as fallback).
    return _doExtract(options, null);
  }

  async function extractActionGraph(options) {
    options = options || {};
    // P1 (2026-08-31): incremental path — cheap scan + diff vs last scan,
    // full-SAG fallback on first call / churn (see exploreIncremental).
    if (options.incremental) return await exploreIncremental(options);
    wsLog('EAG:start opts=', JSON.stringify(options));
    // REF STABILITY (2026-08-31, OSS smoke-test finding): refCounter is NOT
    // reset here. Resetting it made refs from a previous explore silently
    // re-point at DIFFERENT elements after a re-scan (silent wrong-click
    // hazard) or die with "Element not found" (below-fold elements). Refs
    // are only reset on SPA navigation (navObserver) — within one page they
    // are stable for the tab's lifetime. refMap is still rebuilt (bounded).
    refMap = new Map(); locatorByRef.clear();
    // On heavy pages, wait briefly for SPA hydration to settle (don't capture
    // a half-rendered tree). Skips quickly when the DOM is already quiet.
    await waitForSettle(options.settleMs || 2500, 400);
    wsLog('EAG:getAllElements...');
    const allElements = getAllElements(document.body);
    wsLog('EAG:got ' + allElements.length + ' elements');

    // For small DOMs (< 300 elements) do it synchronously — faster, no round-trips.
    if (allElements.length < 300) {
      return _doExtractFromList(allElements, options);
    }

    // For heavy DOMs: chunked processing with yields.
    const actions = [];
    const maxActions = options.maxActions || 0;
    let i = 0;
    while (i < allElements.length) {
      const end = Math.min(i + BATCH_SIZE, allElements.length);
      for (let j = i; j < end; j++) {
        if (maxActions > 0 && actions.length >= maxActions) break;
        const el = allElements[j];
        if (!isInteractive(el)) continue;
        if (options.includeHidden === false && !isVisible(el)) continue;
        if (!options.includeHidden && !isInViewport(el) && !options.full) continue;
        try {
          const ref = assignRef(el);
          const classification = _cachedClassify(el);
          const attrs = getAttrs(el);
          const state = extractState(el);
          const label = getLabel(el);
          const effect = predictEffect(el, classification, attrs);
          const action = { ref, type: classification.type, subtype: classification.subtype, label, predictedEffect: effect, ...state };
        // Phase 4 (2026-08-15): surface frameId from explore_page iframe recursion.
        if (el.__wsFrameId != null && el.__wsFrameId !== 0) action.frameId = el.__wsFrameId;
          // A2 (2026-08-10): expose the semantic locator so the agent can
          // re-target after re-render (locator survives; ref E# may die).
          const loc = buildLocator(el);
          if (loc && loc.length) action.locator = loc[0];
          // A3 (2026-08-10): intent tag — the element's semantic purpose.
          action.intent = detectIntent(el, classification);
          if (classification.href) action.href = classification.href;
          if (classification.target) action.target = classification.target;
          if (classification.formRef) action.formRef = classification.formRef;
          if (classification.expanded !== undefined) action.expanded = classification.expanded;
          if (classification.selected !== undefined) action.selected = classification.selected;
          if (classification.pressed !== undefined) action.pressed = classification.pressed;
          actions.push(action);
        } catch (_) { /* skip broken element */ }
      }
      if (maxActions > 0 && actions.length >= maxActions) { wsLog('EAG:capped at maxActions=' + maxActions); break; }
      wsLog('EAG:chunk ' + i + '-' + end + ' done, ' + actions.length + ' actions so far');
      i = end;
      // Yield to event loop so the WS bridge doesn't block
      await new Promise(function (r) { setTimeout(r, CHUNK_YIELD_MS); });
    }
    wsLog('EAG:loop done, ' + actions.length + ' actions');

    // Build the rest of the SAG from the collected actions
    return _buildSAG(actions, options);
  }

  // Style cache — prevents calling getComputedStyle multiple times per element
  const _styleCache = new WeakMap();
  function cachedStyle(el) {
    if (_styleCache.has(el)) return _styleCache.get(el);
    var s;
    try { s = window.getComputedStyle(el); } catch (_) { s = { display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' }; }
    _styleCache.set(el, s);
    return s;
  }
  function _cachedClassify(el) {
    // Re-use cached style instead of calling getComputedStyle again
    const tag = el.tagName.toLowerCase();
    const attrs = getAttrs(el);
    const role = attrs.role || '';
    const type = attrs.type || '';
    const style = cachedStyle(el);

    if (tag === 'a' && attrs.href) return { type: 'navigation', subtype: 'link', href: attrs.href, target: attrs.target || '_self' };
    if (tag === 'a') return { type: 'action', subtype: 'anchor_button' };
    if (tag === 'input' || tag === 'textarea') {
      if (type === 'checkbox') return { type: 'toggle', subtype: 'checkbox' };
      if (type === 'radio') return { type: 'toggle', subtype: 'radio' };
      if (type === 'submit' || type === 'image') { const f = el.closest('form'); return { type: 'form_submit', subtype: 'input_submit', formRef: f ? assignRef(f) : null }; }
      if (type === 'file') return { type: 'file_upload', subtype: 'file' };
      if (type === 'button') return { type: 'action', subtype: 'input_button' };
      return { type: 'form_input', subtype: type || 'text' };
    }
    if (tag === 'select') return { type: 'form_input', subtype: 'select' };
    if (el.isContentEditable || attrs.contenteditable === 'true') return { type: 'form_input', subtype: 'contenteditable' };
    if (attrs['aria-haspopup'] === 'dialog' || attrs['aria-haspopup'] === 'true' || attrs['data-toggle'] === 'modal' || attrs['data-bs-toggle'] === 'modal')
      return { type: 'modal_trigger', subtype: tag === 'button' ? 'button' : role || 'element', target: attrs['aria-controls'] || (attrs['data-target'] || '').replace('#', '') };
    if (attrs['aria-haspopup'] === 'menu' || attrs['data-toggle'] === 'dropdown' || attrs['data-bs-toggle'] === 'dropdown' || el.classList.contains('dropdown-toggle'))
      return { type: 'dropdown_trigger', subtype: tag === 'button' ? 'button' : role || 'element', target: attrs['aria-controls'] || '' };
    if (role === 'tab' || attrs['data-toggle'] === 'tab' || attrs['data-bs-toggle'] === 'tab')
      return { type: 'tab_trigger', subtype: 'tab', target: attrs['aria-controls'] || '', selected: attrs['aria-selected'] === 'true' };
    if (tag === 'summary' || (role === 'button' && attrs['aria-expanded'] !== undefined))
      return { type: 'expand_collapse', subtype: 'button', expanded: attrs['aria-expanded'] === 'true' };
    if (tag === 'details') return { type: 'expand_collapse', subtype: 'details', expanded: el.open };
    if (role === 'switch' || attrs['aria-pressed'] !== undefined)
      return { type: 'toggle', subtype: role === 'switch' ? 'switch' : 'button', pressed: attrs['aria-pressed'] === 'true' };
    if (tag === 'button') {
      if (type === 'submit') { const f = el.closest('form'); return { type: 'form_submit', subtype: 'button', formRef: f ? assignRef(f) : null }; }
      const f = el.closest('form');
      if (f) { const btns = f.querySelectorAll('button[type="submit"], button:not([type])'); if (btns.length === 1 && btns[0] === el) return { type: 'form_submit', subtype: 'button', formRef: assignRef(f) }; }
      return { type: 'action', subtype: 'button' };
    }
    if (INTERACTIVE_ROLES.has(role)) return { type: 'action', subtype: role };
    if (style.cursor === 'pointer') return { type: 'action', subtype: 'clickable' };
    return { type: 'unknown', subtype: tag };
  }

  // Synchronous extraction for small DOMs
  function _doExtractFromList(allElements, options) {
    const actions = [];
    let step = 'loop-start';
    try {
      const maxActions = options.maxActions || 0;
      for (const el of allElements) {
        if (maxActions > 0 && actions.length >= maxActions) break;
        step = 'isInteractive';
        if (!isInteractive(el)) continue;
        if (options.includeHidden === false && !isVisible(el)) continue;
        if (!options.includeHidden && !isInViewport(el) && !options.full) continue;
        step = 'assignRef';
        const ref = assignRef(el);
        step = 'classifyAction';
        const classification = _cachedClassify(el);
        step = 'getAttrs';
        const attrs = getAttrs(el);
        step = 'extractState';
        const state = extractState(el);
        step = 'getLabel';
        const label = getLabel(el);
        step = 'predictEffect';
        const effect = predictEffect(el, classification, attrs);
        step = 'build-action';
        const action = { ref, type: classification.type, subtype: classification.subtype, label, predictedEffect: effect, ...state };
        // Phase 4 (2026-08-15): surface frameId from explore_page iframe recursion.
        if (el.__wsFrameId != null && el.__wsFrameId !== 0) action.frameId = el.__wsFrameId;
        // A2: expose the semantic locator (sync loop — discover_actions path)
        const loc2 = buildLocator(el);
        if (loc2 && loc2.length) action.locator = loc2[0];
        // A3: intent tag (sync loop)
        action.intent = detectIntent(el, classification);
        if (classification.href) action.href = classification.href;
        if (classification.target) action.target = classification.target;
        if (classification.formRef) action.formRef = classification.formRef;
        if (classification.expanded !== undefined) action.expanded = classification.expanded;
        if (classification.selected !== undefined) action.selected = classification.selected;
        if (classification.pressed !== undefined) action.pressed = classification.pressed;
        actions.push(action);
      }
      wsLog('EAG:loop done (sync), ' + actions.length + ' actions');
      return _buildSAG(actions, options);
    } catch (e) {
      wsLog('EAG:CRASH at step=' + step + ' | ' + e.message + ' | ' + (e.stack || '').slice(0, 600));
      throw e;
    }
  }

  function _doExtract(options, _unused) {
    const allElements = getAllElements(document.body);
    return _doExtractFromList(allElements, options);
  }

  // ═══ P1 INCREMENTAL EXPLORE (2026-08-31) ═══
  // The full SAG path re-pays settle(≤2.5s) → full classify → content/bodyText
  // extraction on EVERY call — expensive on heavy DOMs when the agent only
  // needs to know WHAT CHANGED after its last action. The incremental path
  // walks the DOM (no settle, no content extraction), compares each
  // interactive element against the LAST SCAN, and returns only the delta:
  // added / changed (with per-field changes) / removed.
  //
  // SCAN_CACHE: key(semantic identity) -> { fp, fpo, ref, label, action }.
  // Per-document — a real navigation kills the CS and wipes it automatically;
  // same-document SPA soft-navs keep it (which is the point).
  // Semantics are CANONICAL in src/incr.js (diffScan/fieldChanges/
  // identityKey/disambiguate) and unit-pinned in test-regressions.mjs. The
  // inline mirrors below must stay in lockstep with src/incr.js.
  let SCAN_CACHE = new Map();

  // MIRROR of incr.js identityKey — priority: testid > id > name > aria > ph > pos.
  function wsIdentityKey(a) {
    if (a.testid) return 'tid:' + a.testid;
    if (a.id) return 'id:' + a.id;
    if (a.name) return 'name:' + a.tag + ':' + a.name + (a.type ? ':' + a.type : '');
    if (a.ariaLabel) return 'aria:' + a.ariaLabel.slice(0, 60);
    if (a.placeholder) return 'ph:' + a.placeholder.slice(0, 60);
    return 'pos:' + a.tag + (a.type ? ':' + a.type : '') + ':' + (a.label || '').slice(0, 40) + (a.href ? ':' + String(a.href).slice(0, 40) : '');
  }

  // MIRROR of incr.js fieldChanges — per-field diff, values truncated.
  function wsFieldChanges(prevFpo, currFpo, maxLen) {
    var ml = maxLen || 40;
    var out = [];
    if (!prevFpo || !currFpo) return out;
    var keys = Object.keys(Object.assign({}, prevFpo, currFpo));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (prevFpo[k] !== currFpo[k]) {
        out.push({
          field: k,
          from: String(prevFpo[k] == null ? '' : prevFpo[k]).slice(0, ml),
          to: String(currFpo[k] == null ? '' : currFpo[k]).slice(0, ml),
        });
      }
    }
    return out;
  }

  // Fingerprint of the action-relevant fields. Password values NEVER enter
  // the fingerprint (privacy — mirrors the full path, which also masks them
  // nowhere but they only surface in explicit form extraction).
  function scanFingerprintOf(attrs, classification, label, state) {
    var t = attrs.__tag;
    var sensitive = t === 'input' && (attrs.type === 'password' || (attrs.type === 'text' && attrs.autocomplete === 'current-password'));
    var value = sensitive ? '' : (state.value == null ? '' : String(state.value));
    return {
      fp: [
        classification.type, classification.subtype, label,
        classification.href || '', classification.target || '', value,
        String(state.checked), String(state.disabled), String(state.disabledReason || ''),
        String(state.expanded), String(state.selected), String(state.pressed),
        String(state.visible), String(state.inViewport), String(state.required), String(state.readOnly),
      ].join('|'),
      fpo: {
        type: classification.type, subtype: classification.subtype, label: label,
        href: classification.href || '', target: classification.target || '', value: value,
        checked: state.checked, disabled: state.disabled,
        expanded: state.expanded, selected: state.selected, pressed: state.pressed,
        visible: state.visible, inViewport: state.inViewport,
        required: state.required, readOnly: state.readOnly,
      },
    };
  }

  // Cheap pass: walk elements, extract identity + fingerprint + a lean action
  // object. NO settle wait, NO extractHeadings/extractBodyText, NO chunked
  // yields. Dialog elements are scanned even when offscreen-viewport (the
  // modal is usually what changed).
  function collectScan() {
    const allElements = getAllElements(document.body);
    const pairs = [];
    for (const el of allElements) {
      if (!isInteractive(el)) continue;
      if (!isInViewport(el) && !el.closest('[role="dialog"],[aria-modal="true"]')) continue;
      const attrs = getAttrs(el);
      const t = el.tagName.toLowerCase();
      attrs.__tag = t;
      const classification = _cachedClassify(el);
      const label = getLabel(el);
      const state = extractState(el);
      const fp = scanFingerprintOf(attrs, classification, label, state);
      const key = wsIdentityKey({
        tag: t,
        id: attrs.id || '',
        testid: attrs['data-testid'] || attrs['data-test'] || '',
        name: attrs.name || '',
        type: attrs.type || '',
        ariaLabel: (attrs['aria-label'] || '').slice(0, 60),
        placeholder: (attrs.placeholder || '').slice(0, 60),
        label: (label || '').slice(0, 40),
        href: classification.href ? String(classification.href).slice(0, 40) : '',
      });
      pairs.push([key, { fp: fp.fp, fpo: fp.fpo, ref: null, label: String(label || '').slice(0, 60), el: el }]);
    }
    // MIRROR of incr.js disambiguate — duplicate keys get ':k<n>' in DOM order.
    const seen = new Map();
    const out = new Map();
    for (const [key, entry] of pairs) {
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      out.set(n === 0 ? key : key + ':k' + n, entry);
    }
    return out;
  }

  // STABLE REFS: incremental explores do NOT reset refCounter/refMap, so refs
  // from previous explores stay valid. Only NEW elements get fresh refs.
  // NOTE: locator/intent are NOT built here — that's the expensive part, and
  // they're only needed for the DELTA (added/changed). Enriched post-diff.
  function collectScanWithRefs() {
    const scan = collectScan();
    for (const entry of scan.values()) {
      const existing = elementSignatures.get(entry.el);
      entry.ref = existing ? existing.ref : assignRef(entry.el);
      // Lean action object — enriched with locator/intent for delta entries only.
      entry.action = {
        ref: entry.ref,
        type: entry.fpo.type,
        subtype: entry.fpo.subtype,
        label: entry.label,
        value: entry.fpo.value === '' ? null : entry.fpo.value,
        checked: entry.fpo.checked,
        disabled: entry.fpo.disabled,
        expanded: entry.fpo.expanded,
        selected: entry.fpo.selected,
      };
      if (entry.fpo.href) entry.action.href = entry.fpo.href;
    }
    return scan;
  }

  // Post-diff enrichment: build locator + intent ONLY for delta entries (the
  // agent needs to act on those; unchanged elements already have locators
  // from previous full SAGs).
  function enrichDeltaActions(delta) {
    const need = [].concat(delta.added, delta.changed.map(function (c) { return c.action; }));
    for (const action of need) {
      if (!action || !action.ref) continue;
      const el = resolveRef(action.ref);
      if (!el) continue;
      const cls = _cachedClassify(el);
      const loc = buildLocator(el);
      if (loc && loc.length) action.locator = loc[0];
      action.intent = detectIntent(el, cls);
      if (cls.href) action.href = cls.href;
    }
    return delta;
  }

  async function exploreIncremental(options) {
    wsLog('INCR:start');
    // NO settle wait — hydration settled long ago by the time an agent calls
    // incrementally; waiting would only make the delta stale.
    const scan = collectScanWithRefs();
    const hadBaseline = SCAN_CACHE.size > 0;
    const prev = SCAN_CACHE;
    // ── Inline diff (MIRROR of incr.js diffScan) ──
    const added = [], changed = [], removed = [];
    let unchangedCount = 0;
    for (const [key, e] of scan) {
      const p = prev.get(key);
      if (!p) added.push(e.action);
      else if (p.fp !== e.fp) changed.push({ action: e.action, changes: wsFieldChanges(p.fpo, e.fpo) });
      else unchangedCount++;
    }
    for (const [key, p] of prev) {
      if (!scan.has(key)) removed.push({ key: key, ref: p.ref || null, label: p.label || '' });
    }
    const totalTracked = Math.max(prev.size, scan.size);
    const changedRatio = totalTracked > 0 ? (added.length + removed.length + changed.length) / totalTracked : 0;
    const escalate = hadBaseline && totalTracked > 20 && changedRatio > 0.6;
    // Always advance the baseline — next call diffs against THIS scan.
    SCAN_CACHE = scan;

    const meta = { url: location.href, title: document.title, readyState: document.readyState };

    if (!hadBaseline || (escalate && options.full !== false)) {
      // No baseline (first call) or >60% churn → FULL extraction fallback.
      // NOTE: extractActionGraph resets refCounter/refMap — the complete SAG
      // it returns supersedes all previously handed-out refs (same contract
      // as a normal full explore). Seed the scan baseline from the result.
      const sag = await extractActionGraph(Object.assign({}, options, { incremental: undefined }));
      try { SCAN_CACHE = collectScanWithRefs(); } catch (_) {}
      sag.incremental = true;
      sag.escalated = hadBaseline; // true = churn fallback, false = first call
      return sag;
    }

    // Locator/intent only for the delta — the scan itself stays cheap.
    enrichDeltaActions({ added: added, changed: changed });

    return {
      incremental: true,
      escalated: false,
      added: added,
      changed: changed,
      removed: removed,
      unchangedCount: unchangedCount,
      changedRatio: changedRatio,
      forms: extractForms(),
      meta: meta,
      elementCount: added.length + changed.length,
      timestamp: Date.now(),
    };
  }

  // Build the full SAG result from collected actions + page metadata
  function _buildSAG(actions, options) {
    wsLog('EAG:buildSAG actions=' + actions.length);
    try {
      wsLog('EAG:extractForms...');
      const forms = extractForms();
      wsLog('EAG:detectSections...');
      const sections = detectSections(actions);
      wsLog('EAG:extractContent...');
      const content = options.includeContent === false ? null : { headings: extractHeadings(), bodyText: extractBodyText(options.contentMaxLen || 8000) };
      wsLog('EAG:pageState...');
      const pageState = { url: window.location.href, title: document.title, readyState: document.readyState, pageType: extractPageType(), framework: detectFramework(), viewport: { w: window.innerWidth, h: window.innerHeight }, scroll: { y: window.scrollY, maxY: Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight), pagesBelow: Math.max(0, Math.ceil(((document.documentElement.scrollHeight || 0) - window.innerHeight - window.scrollY) / window.innerHeight)) } };
      wsLog('EAG:dialogs...');
      const dialogs = [];
      document.querySelectorAll('[role="dialog"][aria-modal="true"],dialog[open],.modal:not([hidden]),.ReactModal__Overlay--after-open').forEach(function (d) { if (isVisible(d)) dialogs.push({ ref: assignRef(d), label: getLabel(d).slice(0, 80) }); });
      wsLog('EAG:captcha...');
      const hasCaptcha = !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],.g-recaptcha,#captcha,[class*="captcha"]');
      const isLoading = !!document.querySelector('[aria-busy="true"],.loading,.spinner,.loader,[data-loading]');
      wsLog('EAG:navigation...');
      const navigation = actions.filter(function (a) { return a.type === 'navigation'; }).map(function (a) { return { ref: a.ref, label: a.label, target: a.href }; });
      wsLog('EAG:done successfully');
      return { meta: pageState, forms, actions, sections, navigation, content, dialogs, alerts: [], captcha: hasCaptcha, loading: isLoading, elementCount: actions.length, timestamp: Date.now() };
    } catch (e) {
      wsLog('EAG:buildSAG CRASH | ' + e.message + ' | ' + (e.stack || '').slice(0, 600));
      throw e;
    }
  }

  // ═══ Native Action Handlers (ALL CSP-safe — NO eval) ═══
  // Phase 3 (2026-08-15): walk the FULL prototype chain for the 'value' setter.
  // Custom-element inputs (Lit, Stencil, Ionic, React-controlled web components)
  // define value on a MIDDLE prototype, not the immediate one — the old
  // Object.getPrototypeOf(element) only check missed them and silently fell back
  // to el.value = value (which React/custom-elements revert on next render).
  function getNativeValueSetter(element) {
    let proto = Object.getPrototypeOf(element);
    while (proto) {
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) return d;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
  function setNativeValue(element, value) { const d = getNativeValueSetter(element); if (d&&d.set) d.set.call(element, value); else element.value = value; }

  async function nativeClick(el) {
    if (!el) throw new Error('Element not found');
    // v4 DISABLED DIAGNOSIS (2026-08-31, x.com Post-button lesson): a disabled
    // button silently "absorbs" clicks — the agent then retries blindly. Refuse
    // with a REASON instead. Checks: [disabled] attr, aria-disabled, and
    // disabled-class heuristics (X uses r-icoktb / r-3pj75a on disabled buttons).
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
      // Why is it disabled? Look for an adjacent char counter / required hint.
      let hint = null;
      try {
        const scope = el.closest('[role="dialog"], form, [data-testid]') || el.parentElement;
        const counter = scope && (scope.querySelector('[data-testid$="counter"], [class*="counter"], [aria-live]'));
        if (counter) hint = (counter.textContent || '').trim().slice(0, 40);
      } catch (_) {}
      return {
        success: false,
        refused: 'disabled-button',
        disabled: true,
        ariaDisabled: el.getAttribute('aria-disabled') === 'true',
        label: (el.textContent || '').trim().slice(0, 40),
        hint,
        reason: hint ? 'button disabled — adjacent counter says: ' + hint
                     : 'button disabled — a prerequisite (text/validation) is not satisfied; typing/clicking it cannot work',
      };
    }
    // BACKGROUND BLANK-TARGET (2026-08-13): <a target="_blank">
    // clicks make Chrome open a new ACTIVE tab, raising the OS window — the
    // remaining foreground-steal path (Bugcrowd "Submit report" is one).
    // Intercept: open the href in a BACKGROUND tab via the SW instead.
    let anchor = null;
    if (el.tagName === 'A' && (el.target === '_blank' || el.target === '_new')) anchor = el;
    else if (el.closest) { const a = el.closest('a[target="_blank"], a[target="_new"]'); if (a) anchor = a; }
    if (anchor && anchor.href && !anchor.download) {
      try {
        const href = anchor.href;
        const r = await relayTabControl('open_new_tab', { url: href, active: false });
        if (r && !r.error) return { success: true, background: true, tabId: r.tabId, blankTarget: true };
      } catch (_) { /* fall through to normal click */ }
    }
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
    const rect = el.getBoundingClientRect(); const x = rect.left+rect.width/2; const y = rect.top+rect.height/2;
    // REAL-CLICK SEMANTICS (2026-08-13, Ali directive — Bugcrowd VRT lesson):
    // a genuine mouse click lands on the TOPMOST element at the cursor, not on
    // the resolved container. React trees like Bugcrowd's VRT dropdown close on
    // container (li) clicks but expand on the inner span/button. If the resolved
    // element is a container, find the deepest clickable descendant at the point
    // and dispatch there — identical to what elementFromPoint would give a user.
    let targetEl = el;
    try {
      const top = document.elementFromPoint(x, y);
      if (top && top !== el && el.contains(top)) {
        // Walk down from the hit element to the deepest interactive child
        // (button/span/a/input/label or the deepest leaf) — mirrors a real
        // click's event target.
        let deepest = top;
        while (deepest.children && deepest.children.length > 0) {
          let hit = null;
          for (const c of deepest.children) {
            const r = c.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { hit = c; break; }
          }
          if (!hit) break;
          deepest = hit;
        }
        targetEl = deepest;
      }
    } catch (_) { targetEl = el; }
    const pOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse'};
    const mOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,button:0};
    targetEl.dispatchEvent(new PointerEvent('pointerover',pOpts)); targetEl.dispatchEvent(new PointerEvent('pointerenter',{...pOpts,bubbles:false}));
    targetEl.dispatchEvent(new MouseEvent('mouseover',mOpts)); targetEl.dispatchEvent(new MouseEvent('mouseenter',{...mOpts,bubbles:false}));
    targetEl.dispatchEvent(new PointerEvent('pointerdown',pOpts)); targetEl.dispatchEvent(new MouseEvent('mousedown',mOpts));
    try{targetEl.focus({preventScroll:true});}catch(_){}
    targetEl.dispatchEvent(new PointerEvent('pointerup',pOpts)); targetEl.dispatchEvent(new MouseEvent('mouseup',mOpts));
    targetEl.click();
    return { success: true, target: targetEl.tagName.toLowerCase(), dispatchedOn: targetEl === el ? 'resolved' : 'deepest' };
  }

  // ═══ v4 EDITOR FRAMEWORK DETECTOR (2026-08-31) ═══
  // Classifies any text-entry element so nativeType can pick the right strategy.
  // Returns { kind, framework, strategy, stateControl }.
  //   kind: input | textarea | select | editor | unknown
  //   framework: draftjs | lexical | prosemirror | slate | quill | trix |
  //              ckeditor | tinymce | google-docs | contenteditable | null
  //   strategy: value | paste | insertText | beforeinput | iframe | unsupported
  //   stateControl: selector of the dependent submit button, if discoverable
  function detectEditor(el) {
    if (!el || el.nodeType !== 1) return { kind: 'unknown', framework: null, strategy: 'none', stateControl: null };
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return { kind: 'textarea', framework: null, strategy: 'value', stateControl: null };
    if (tag === 'SELECT') return { kind: 'select', framework: null, strategy: 'select', stateControl: null };
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      // value-settable types
      if (!['checkbox','radio','file','range','color','submit','button','image','reset'].includes(t))
        return { kind: 'input', framework: null, strategy: 'value', stateControl: null };
      return { kind: 'input', framework: null, strategy: 'none', stateControl: null, inputType: t };
    }
    if (!el.isContentEditable) return { kind: 'unknown', framework: null, strategy: 'none', stateControl: null };

    // ---- contenteditable: identify the editor framework ----
    const cls = el.className || '';
    const d = (sel) => !!el.querySelector(sel);
    const up = (sel) => { let p = el.parentElement; while (p) { if (p.matches && p.matches(sel)) return true; p = p.parentElement; } return false; };

    let framework = 'contenteditable';
    let strategy = 'paste';           // default best bet for editors
    if (d('.public-DraftEditor-content') || el.hasAttribute('data-offset-key') || d('[data-offset-key]') || up('.DraftEditor-root')) framework = 'draftjs';
    else if (el.hasAttribute('data-lexical-editor') || d('[data-lexical-editor]')) framework = 'lexical';
    else if (el.classList.contains('ProseMirror') || d('.ProseMirror')) framework = 'prosemirror';
    else if (el.hasAttribute('data-slate-editor') || d('[data-slate-editor]')) framework = 'slate';
    else if (el.classList.contains('ql-editor') || up('.ql-editor') || d('.ql-editor')) framework = 'quill';
    else if (tag === 'TRIX-EDITOR' || up('trix-editor') || d('trix-editor')) framework = 'trix';
    else if (el.classList.contains('ck-editor__editable') || el.classList.contains('ck-content') || d('.ck-editor__editable')) framework = 'ckeditor';
    else if (up('.tox-edit-area') || d('.tox-edit-area')) framework = 'tinymce';
    else if (up('#docs-editor') || d('.kix-appview-editor')) { framework = 'google-docs'; strategy = 'unsupported'; }

    // iframe-hosted editor (CKEditor/TinyMCE inline frames)
    let inIframe = false;
    try { inIframe = (window.self !== window.top); } catch (_) { inIframe = true; }

    // state control: a submit-ish sibling — the "source of truth" that proves
    // the app REGISTERED our text. Walk up to the form-ish container, look for
    // button[type=submit], [data-testid*=submit], or a button mentioning post/send/submit.
    let stateControl = null;
    try {
      let scope = el.parentElement;
      for (let i = 0; i < 6 && scope && !stateControl; i++) {
        const btns = scope.querySelectorAll('button, [role="button"]');
        for (const b of btns) {
          const lbl = ((b.textContent || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
          const isSubmitish = b.getAttribute('type') === 'submit' || /submit|post|send|reply|tweet|publish|comment/.test(lbl);
          if (isSubmitish) { stateControl = b; break; }
        }
        scope = scope.parentElement;
      }
    } catch (_) {}
    const scInfo = stateControl ? {
      disabled: stateControl.disabled || stateControl.getAttribute('aria-disabled') === 'true',
      testid: stateControl.getAttribute('data-testid'),
      text: (stateControl.textContent || '').trim().slice(0, 30),
    } : null;

    return { kind: 'editor', framework, strategy, inIframe, stateControl: scInfo };
  }

  // SYNTHETIC PASTE (v4): the strategy Draft.js/Lexical/ProseMirror/Slate/Quill
  // actually honor — a ClipboardEvent with a real DataTransfer, dispatch on the
  // focused editor. CSP-safe (no eval). Returns true if a handler preventDefault()ed
  // (i.e. an editor consumed it).
  function syntheticPaste(el, text) {
    try {
      el.focus();
      // caret to end
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      dt.setData('text/html', text
        .split('\n')
        .map((l) => l.trim() === '' ? '<br>' : '<div>' + l.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>')
        .join(''));
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      const notConsumed = !el.dispatchEvent(ev);
      return { dispatched: true, consumed: !notConsumed, text: dt.getData('text/plain') };
    } catch (e) {
      return { dispatched: false, consumed: false, error: String(e) };
    }
  }

  // STATE-TRUTH CHECK (v4): after typing, verify the app REGISTERED the text by
  // inspecting the dependent submit control. DOM text present + submit still
  // disabled = editor state didn't sync = strategy failed.
  function checkStateTruth(el) {
    try {
      const det = el.__wsEditorDetect || detectEditor(el);
      if (det.stateControl) {
        const b = det.stateControl;
        const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
        return { synced: !disabled, submitDisabled: disabled, submitLabel: det.stateControl.text };
      }
    } catch (_) {}
    return { synced: null, submitDisabled: null, submitLabel: null };
  }

  async function nativeType(el, text, clearFirst) {
    if (!el) throw new Error('Element not found');
    var cf = (typeof clearFirst !== 'undefined') ? clearFirst : true;
    nativeClick(el);
    if (cf!==false) { setNativeValue(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); }
    setNativeValue(el, text);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    if (detectFramework()==='react') el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,data:text,inputType:'insertText'}));
    // CONTENTEDITABLE SUPPORT (2026-08-31, marketing-campaign need): Draft.js /
    // Lexical editors (x.com, LinkedIn, Reddit composers) are contenteditable
    // DIVs — they have no .value, so the value-setter path above is a no-op and
    // nativeType "succeeded" while typing nothing. For these, focus + select-all
    // + document.execCommand('insertText') — CSP-safe (no eval), fires the
    // beforeinput/input events Draft.js and Lexical actually listen to, and
    // works multi-line. Verify by reading textContent instead of .value.
    if (el.isContentEditable) {
      // ═══ v4 STRATEGY LADDER (2026-08-31) ═══
      // Detect the framework, then try: synthetic paste → execCommand insertText.
      // Verify against the app's STATE TRUTH (dependent submit control), not the DOM.
      const det = detectEditor(el);
      el.__wsEditorDetect = det;
      el.focus();
      const sel = window.getSelection();
      const results = { framework: det.framework, attempts: [] };

      // CLEAR phase (shared): select-all + delete + settle ticks
      // v4.1: VERIFY the clear actually emptied the editor before inserting.
      // A framework that swallows execCommand('delete') leaves old content →
      // insertText then APPENDS (doubling bug, observed live 2026-08-31).
      // Retry up to 2x, then fall back to direct textContent wipe.
      if (cf !== false) {
        const readBackNow = () => (el.innerText || el.textContent || '').trim();
        for (let i = 0; i < 3 && readBackNow() !== ''; i++) {
          const rAll = document.createRange();
          rAll.selectNodeContents(el);
          sel.removeAllRanges(); sel.addRange(rAll);
          document.execCommand('delete', false, null);
          if (readBackNow() !== '') { el.textContent = ''; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 120));
          await new Promise((r) => setTimeout(r, 80));
        }
      }

      const readBack = () => (el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      const expected = String(text).trim();
      const textMatches = () => { const v = readBack(); return v === expected || v.replace(/\n/g, '') === expected.replace(/\n/g, ''); };

      // RUNG 1: synthetic ClipboardEvent paste (the strategy editors consume)
      const p = syntheticPaste(el, text);
      results.attempts.push({ rung: 'paste', dispatched: p.dispatched, consumed: p.consumed });
      await new Promise((r) => setTimeout(r, 250));
      if (p.dispatched && p.consumed && textMatches()) {
        const truth = checkStateTruth(el);
        results.attempts.push({ rung: 'verify', truth });
        return new Promise(function(resolve) {
          setTimeout(function() {
            resolve({
              success: true,
              confirmed: truth.synced === false ? 'dom-synced-state-unsynced' : 'editor-state-synced',
              actualValue: readBack().slice(0, 200),
              reverted: false,
              expected: expected.slice(0, 200),
              ...results,
            });
          }, 300);
        });
      }

      // RUNG 2: execCommand insertText (plain contenteditable fallback)
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      const ok = document.execCommand('insertText', false, text);
      results.attempts.push({ rung: 'insertText', ok });
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(function(resolve) {
        setTimeout(function() {
          const finalVal = readBack();
          const matches = ok && (finalVal === expected || finalVal.replace(/\n/g,'') === expected.replace(/\n/g,''));
          const truth = checkStateTruth(el);
          resolve({
            success: matches,
            confirmed: matches ? (truth.synced === false ? 'dom-synced-state-unsynced' : 'contenteditable-persisted') : false,
            actualValue: finalVal.slice(0, 200),
            reverted: !matches,
            expected: expected.slice(0, 200),
            execCommandOk: ok,
            stateTruth: truth,
            ...results,
          });
        }, 500);
      });
    }
    // Phase 3 (2026-08-15): VERIFY-PERSIST. React/custom-elements frequently
    // DISCARD the programmatic value on the next render (value shows transiently
    // then snaps back to the controlled value). The old code reported
    // success:true from the immediate el.value read — a phantom success. Now we
    // wait 2 rAF + ~400ms settle, re-read el.value, and only report success if
    // the FINAL value actually equals what we set. `confirmed` = the app persisted
    // it; `reverted` = the framework threw it away (caller must retry or report).
    return new Promise(function(resolve) {
      var readBack = function() {
        var finalVal = el.value;
        var matches = (finalVal === text) || (finalVal === String(text));
        resolve({
          success: matches,
          confirmed: matches ? 'value-persisted' : false,
          actualValue: finalVal,
          reverted: matches ? false : true,
          expected: text,
        });
      };
      var raf2 = function() { setTimeout(readBack, 400); };
      var raf1 = function() { requestAnimationFrame(raf2); };
      requestAnimationFrame(raf1);
    });
  }

  function nativeSelect(el, value, clearAll) {
    if (!el) throw new Error('Element not found');
    if (el.tagName!=='SELECT') { let p=el.parentElement; while(p&&p.tagName!=='SELECT')p=p.parentElement; if(p)el=p; else throw new Error('Not a select'); }
    // v4 (2026-08-31): multi-select support — value can be a string or an array
    // (also JSON-encoded array string). Toggling option.selected fires the
    // change event React/Naive selects listen to.
    if (el.multiple) {
      let wanted = Array.isArray(value) ? value.map(String)
        : (() => { try { const j = JSON.parse(value); return Array.isArray(j) ? j.map(String) : [String(value)]; } catch (_) { return [String(value)]; } })();
      let matchedAny = false;
      const clearRest = typeof clearAll === 'boolean' ? clearAll : true;
      for (const opt of el.options) {
        const match = wanted.some((w) => opt.value === w || (opt.textContent || '').trim() === w || (opt.label || '') === w);
        if (match) { opt.selected = true; matchedAny = true; }
        else if (clearRest) { opt.selected = false; }
      }
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: matchedAny, value: [].map.call(el.selectedOptions, (o) => o.value), multi: true };
    }
    let matched=false;
    for (const opt of el.options) { if (opt.value===value||(opt.textContent||'').trim()===value||(opt.label||'')===value) { const d=getNativeValueSetter(el); if(d&&d.set)d.set.call(el,opt.value); else el.value=opt.value; matched=true; break; } }
    if (matched) { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    return { success:matched, value:el.value };
  }

  // v4 (2026-08-31): special input types — the value-setter path is wrong or
  // insufficient for these. One entry point: form_special(ref, kind, value).
  //   range    → set .value AsNumber within min/max/step + input/change
  //   color    → set .value as #rrggbb + input/change
  //   date     → set .valueAsDate (YYYY-MM-DD) + input/change
  //   time     → set .value (HH:MM, HH:MM:SS) + input/change
  //   number   → set .value via native setter (float-safe) + input/change
  //   checkbox → .checked = !!value + change (no click — idempotent set)
  //   radio    → .checked = true on the matching radio in its group + change
  async function nativeSetSpecial(el, value) {
    if (!el || el.tagName !== 'INPUT') throw new Error('Not an input');
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const set = (v) => { const d = getNativeValueSetter(el); if (d && d.set) d.set.call(el, v); else el.value = v; };
    switch (t) {
      case 'range': {
        const num = Number(value);
        if (isNaN(num)) return { success: false, refused: 'range-needs-number' };
        const min = el.min === '' ? 0 : Number(el.min);
        const max = el.max === '' ? 100 : Number(el.max);
        const step = el.step && el.step !== 'any' ? Number(el.step) : 1;
        let v = Math.min(max, Math.max(min, num));
        // snap to step
        v = min + Math.round((v - min) / step) * step;
        v = Math.min(max, Math.max(min, v));
        set(String(v)); fire();
        return { success: true, value: el.value, min, max, step };
      }
      case 'color': {
        let v = String(value).trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
          // accept #rgb or rgb() and normalize
          if (/^#[0-9a-fA-F]{3}$/.test(v)) v = '#' + v.slice(1).split('').map((c) => c + c).join('');
          else { const m = v.match(/rgb\((\d+)[,\s]+(\d+)[,\s]+(\d+)\)/); if (m) v = '#' + [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join(''); else return { success: false, refused: 'color-needs-hex' }; }
        }
        set(v); fire();
        return { success: true, value: el.value };
      }
      case 'date': case 'datetime-local': case 'month': case 'week': {
        const v = String(value).trim();
        set(v); fire();
        // verify the browser accepted it (invalid dates keep value '')
        return { success: el.value === v, value: el.value, note: el.value === v ? undefined : 'browser rejected the value format for type=' + t };
      }
      case 'time': {
        const v = String(value).trim();
        set(v); fire();
        return { success: el.value === v, value: el.value };
      }
      case 'number': {
        const num = Number(value);
        if (isNaN(num)) return { success: false, refused: 'number-needs-number' };
        set(String(num)); fire();
        return { success: el.value !== '' && !isNaN(Number(el.value)), value: el.value };
      }
      case 'checkbox': {
        el.checked = !!value && value !== 'false' && value !== '0';
        fire();
        return { success: true, checked: el.checked };
      }
      case 'radio': {
        // value may be 'true' (just check this one) or a value of the radio in its group
        const name = el.name;
        if (value === true || value === 'true' || value === '') {
          el.checked = true; fire();
          return { success: el.checked, checked: el.checked };
        }
        const group = name ? Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(name) + '"]')) : [el];
        const target = group.find((r) => r.value === String(value)) || (group.find((r) => (r.labels || [])[0] && (r.labels[0].textContent || '').trim() === String(value)));
        if (!target) return { success: false, refused: 'radio-not-found', group: group.map((r) => r.value) };
        target.checked = true; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, checked: true, value: target.value };
      }
      default:
        return { success: false, refused: 'not-special', inputType: t };
    }
  }

  function nativeToggle(el) {
    if (!el) throw new Error('Element not found');
    if (el.tagName==='INPUT'&&(el.type==='checkbox'||el.type==='radio')) { nativeClick(el); return {success:true,checked:el.checked}; }
    if (el.getAttribute('aria-pressed')!==null||el.getAttribute('role')==='switch') { nativeClick(el); return {success:true,pressed:el.getAttribute('aria-pressed')==='true'}; }
    nativeClick(el); return {success:true};
  }

  function nativeScrollIntoView(el) { if(!el)throw new Error('Element not found'); el.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'}); return{success:true}; }
  function nativeScroll(direction, amount, ref) {
    let target = document.documentElement;
    if (ref) {
      const el = resolveRef(ref);
      if (el) {
        let c = el;
        while (c && c !== document.body) {
          const st = window.getComputedStyle(c);
          if (/(auto|scroll|overlay)/.test(st.overflowY) && c.scrollHeight > c.clientHeight) { target = c; break; }
          c = c.parentElement;
        }
      }
    } else {
      // No ref: find the REAL page scroll container. x.com scrolls an inner div —
      // window.scrollBy is a silent no-op there. Fall back to documentElement.
      const sc = findScrollContainer();
      if (sc) target = sc;
    }
    // amount semantics: NEW server sends TICKS (default 1); OLD server sent raw
    // pixels (default 500). Rule: amount <= 20 → ticks (1 tick ≈ 80% viewport);
    // amount > 20 → legacy raw pixels. This keeps a running OLD server safe
    // until it restarts with the new code, and makes ticks work immediately.
    var raw = (typeof amount === 'number' && !isNaN(amount)) ? amount : 1;
    var sa;
    if (raw > 20) {
      sa = raw * (direction === 'down' || direction === 'right' ? 1 : -1);
    } else {
      var ticks = raw > 0 ? raw : 1;
      var px = Math.round(ticks * window.innerHeight * 0.8);
      if (direction === 'left' || direction === 'right') px = Math.round(ticks * window.innerWidth * 0.8);
      sa = px * (direction === 'down' || direction === 'right' ? 1 : -1);
    }
    if (direction === 'down' || direction === 'up') {
      if (target === document.documentElement) window.scrollBy({ top: sa, behavior: 'auto' });
      else target.scrollTop += sa;
    } else {
      if (target === document.documentElement) window.scrollBy({ left: sa, behavior: 'auto' });
      else target.scrollLeft += sa;
    }
    return { success: true, scrolledPx: sa, scrollY: target === document.documentElement ? window.scrollY : target.scrollTop, scrollX: target === document.documentElement ? window.scrollX : target.scrollLeft };
  }
  function nativeScrollTo(y) {
    const sc = findScrollContainer();
    const target = sc || document.documentElement;
    if (target === document.documentElement) window.scrollTo({ top: y, behavior: 'auto' });
    else target.scrollTop = y;
    return { success: true, scrollY: target === document.documentElement ? window.scrollY : target.scrollTop };
  }
  function nativePressKey(key, ref) { const t=ref?resolveRef(ref):document.activeElement||document.body; if(!t)throw new Error('Target not found'); t.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); t.dispatchEvent(new KeyboardEvent('keypress',{key,bubbles:true})); t.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true})); return{success:true}; }
  function nativeEvaluate(script) {
    // Supports both expressions and statements. Async-aware: a script whose
    // last expression is a Promise is awaited and its resolved value returned.
    try {
      const fn = new Function('"use strict"; return (async () => { ' + script + ' })();');
      const p = fn();
      if (p && typeof p.then === 'function') {
        return p.then(function (r) { return { success: true, result: serializeEvalResult(r) }; })
                .catch(function (e) { return { success: false, error: String((e && e.message) || e) }; });
      }
      return { success: true, result: serializeEvalResult(p) };
    } catch (err) {
      // new Function can be blocked by strict page CSP (LinkedIn, HN, H1).
      // Fall back to a NON-EVAL DOM reader for the common read cases.
      const msg = String((err && err.message) || err);
      const readFallback = safeDomRead(script);
      if (readFallback !== undefined) return readFallback;
      return { success: false, error: 'CSP blocked eval: ' + msg + ' — use evaluate_safe (no-eval DOM queries) or native tools', cspBlocked: true };
    }
  }
  function serializeEvalResult(r) {
    if (r === undefined) return 'undefined';
    if (r === null) return 'null';
    const t = typeof r;
    if (t === 'string' || t === 'number' || t === 'boolean') return r;
    if (r instanceof Element) return '<' + r.tagName.toLowerCase() + (r.id ? '#' + r.id : '') + (r.className && typeof r.className === 'string' ? '.' + r.className.split(/\s+/).join('.') : '') + '>';
    try { return JSON.stringify(r); } catch (_) { return String(r); }
  }
  // CSP-proof read-only DOM queries that need NO eval. Called as an automatic
  // fallback when new Function is blocked, and directly by the evaluate_safe tool.
  function safeDomRead(expr) {
    var q = String(expr || '').trim();
    if (!q) return undefined;
    var m = q.match(/^querySelector(?:All)?\((['"])(.*?)\1\)(?:\.(textContent|innerText|value|checked|href|src|options))?$/);
    if (!m) return undefined;
    var sel = m[2], kind = m[3];
    try {
      if (q.indexOf('querySelectorAll') === 0) {
        var all = document.querySelectorAll(sel);
        var out = [];
        for (var i = 0; i < all.length && i < 50; i++) {
          var e = all[i];
          out.push(e && e[kind] !== undefined && kind ? e[kind] : (e ? e.textContent || '' : ''));
        }
        return { success: true, method: 'safe-querySelectorAll', count: all.length, results: out };
      }
      var el = document.querySelector(sel);
      if (!el) return { success: true, method: 'safe-querySelector', found: false };
      return { success: true, method: 'safe-querySelector', found: true, value: kind ? el[kind] : (el.textContent || '') };
    } catch (e) { return { success: false, error: String((e && e.message) || e) }; }
  }
  function nativeEvaluateSafe(query) {
    // Structured, no-eval DOM reader for strict-CSP pages. Modes:
    //   {selector:"input[name=email]", extract:"value"}          → single
    //   {selector:".item", extract:"text", all:true}             → array
    //   {inputs:true}                                            → all form controls
    //   {text:true}                                              → body innerText (capped)
    //   {state:true}                                             → page state snapshot
    try {
      const q = query || {};
      if (q.state) {
        const d = document;
        const inputs = Array.prototype.slice.call(d.querySelectorAll('input,textarea,select')).map(function (i) {
          return { tag: i.tagName.toLowerCase(), name: i.name || '', type: i.type || '', value: i.value, checked: !!(i.checked || i.selected) };
        });
        return { success: true, mode: 'state', url: location.href, title: d.title, scrollY: window.scrollY, scrollH: (d.documentElement && d.documentElement.scrollHeight) || 0, inputCount: inputs.length, inputs: inputs.slice(0, 60) };
      }
      if (q.text) {
        const t = (document.body && document.body.innerText) || '';
        return { success: true, mode: 'text', length: t.length, text: t.slice(0, q.maxLen || 20000) };
      }
      if (q.inputs) {
        const ins = Array.prototype.slice.call(document.querySelectorAll('input,textarea,select')).map(function (i) {
          return { tag: i.tagName.toLowerCase(), name: i.name || '', type: i.type || '', value: i.value, checked: !!(i.checked || i.selected), placeholder: i.placeholder || '', label: getLabel(i).slice(0, 60) };
        });
        return { success: true, mode: 'inputs', count: ins.length, inputs: ins.slice(0, 100) };
      }
      if (!q.selector) return { success: false, error: 'evaluate_safe needs selector, inputs:true, text:true, or state:true' };
      const el = document.querySelector(q.selector);
      if (!el) return { success: true, mode: 'query', found: false, selector: q.selector };
      const ex = q.extract || 'text';
      let val;
      if (ex === 'value') val = el.value !== undefined ? el.value : (el.textContent || '');
      else if (ex === 'attrs') { const o = {}; for (let i = 0; i < el.attributes.length; i++) o[el.attributes[i].name] = el.attributes[i].value; val = o; }
      else if (ex === 'html') val = el.outerHTML;
      else val = el.textContent || '';
      if (q.all) {
        const els = document.querySelectorAll(q.selector);
        const arr = [];
        for (let i = 0; i < els.length && i < (q.maxLen || 100); i++) {
          const e = els[i];
          if (ex === 'value') arr.push(e.value !== undefined ? e.value : (e.textContent || ''));
          else if (ex === 'attrs') { const o = {}; for (let k = 0; k < e.attributes.length; k++) o[e.attributes[k].name] = e.attributes[k].value; arr.push(o); }
          else arr.push(e.textContent || '');
        }
        return { success: true, mode: 'query-all', found: true, count: arr.length, results: arr };
      }
      return { success: true, mode: 'query', found: true, value: val };
    } catch (e) { return { success: false, error: String((e && e.message) || e) }; }
  }
  function nativeTypeMany(fields) {
    // Batch-fill: one round trip for N fields. Each field: {ref, text, clearFirst?}
    const results = [];
    if (!Array.isArray(fields)) return { success: false, error: 'fields must be an array' };
    for (const f of fields) {
      try {
        const el = resolveRef(f.ref);
        if (!el) { results.push({ ref: f.ref, success: false, error: 'Element not found' }); continue; }
        const r = nativeType(el, f.text, f.clearFirst !== false);
        results.push({ ref: f.ref, success: r.success, actualValue: r.actualValue });
      } catch (e) {
        results.push({ ref: f.ref, success: false, error: String((e && e.message) || e) });
      }
    }
    return { success: true, filled: results.filter(function (r) { return r.success; }).length, failed: results.filter(function (r) { return !r.success; }).length, results: results };
  }

  // ═══ CATEGORY A: Advanced Native Handlers (ALL CSP-safe) ═══

  function nativeHover(el) {
    if (!el) throw new Error('Element not found');
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
    const rect = el.getBoundingClientRect(); const x = rect.left+rect.width/2; const y = rect.top+rect.height/2;
    const pOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse'};
    const mOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y};
    el.dispatchEvent(new PointerEvent('pointerover',pOpts));
    el.dispatchEvent(new PointerEvent('pointerenter',{...pOpts,bubbles:false}));
    el.dispatchEvent(new MouseEvent('mouseover',mOpts));
    el.dispatchEvent(new MouseEvent('mouseenter',{...mOpts,bubbles:false}));
    el.dispatchEvent(new PointerEvent('pointermove',pOpts));
    el.dispatchEvent(new MouseEvent('mousemove',mOpts));
    return { success: true, label: getLabel(el) };
  }

  function nativeRightClick(el) {
    if (!el) throw new Error('Element not found');
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
    const rect = el.getBoundingClientRect(); const x = rect.left+rect.width/2; const y = rect.top+rect.height/2;
    const pOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse',button:2};
    const mOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,button:2};
    el.dispatchEvent(new PointerEvent('pointerdown',pOpts));
    el.dispatchEvent(new MouseEvent('mousedown',mOpts));
    el.dispatchEvent(new PointerEvent('pointerup',pOpts));
    el.dispatchEvent(new MouseEvent('mouseup',mOpts));
    el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:2}));
    return { success: true };
  }

  function nativePressKeyEnhanced(key, ref, modifiers) {
    modifiers = modifiers || [];
    const target = ref ? resolveRef(ref) : document.activeElement || document.body;
    if (!target) throw new Error('Target not found');
    const opts = { key, bubbles: true, cancelable: true };
    if (modifiers.includes('ctrl')) opts.ctrlKey = true;
    if (modifiers.includes('shift')) opts.shiftKey = true;
    if (modifiers.includes('alt')) opts.altKey = true;
    if (modifiers.includes('meta')) opts.metaKey = true;
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { success: true, key, modifiers };
  }

  function nativeDragDrop(fromEl, toEl) {
    if (!fromEl) throw new Error('Source element not found');
    if (!toEl) throw new Error('Target element not found');
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const fx = fromRect.left+fromRect.width/2, fy = fromRect.top+fromRect.height/2;
    const tx = toRect.left+toRect.width/2, ty = toRect.top+toRect.height/2;
    var dt; try { dt = new DataTransfer(); } catch(_) { dt = { data: {} }; }
    fromEl.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, clientX:fx, clientY:fy, dataTransfer:dt }));
    fromEl.dispatchEvent(new DragEvent('drag', { bubbles:true, cancelable:true, clientX:fx, clientY:fy, dataTransfer:dt }));
    toEl.dispatchEvent(new DragEvent('dragenter', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    toEl.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    toEl.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    fromEl.dispatchEvent(new DragEvent('dragend', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    return { success: true };
  }

  function nativeClickXY(x, y, ref, button) {
    button = button || 'left';
    const btnNum = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
    let clientX = x, clientY = y;
    let targetEl = document.elementFromPoint(clientX, clientY);
    if (ref) { const el = resolveRef(ref); if (el) { const rect = el.getBoundingClientRect(); clientX = rect.left + x; clientY = rect.top + y; targetEl = document.elementFromPoint(clientX, clientY) || el; } }
    if (!targetEl) targetEl = document.body;
    const pOpts = {bubbles:true,cancelable:true,clientX,clientY,pointerType:'mouse',button:btnNum};
    const mOpts = {bubbles:true,cancelable:true,clientX,clientY,button:btnNum};
    targetEl.dispatchEvent(new PointerEvent('pointerover',pOpts));
    targetEl.dispatchEvent(new MouseEvent('mouseover',mOpts));
    targetEl.dispatchEvent(new PointerEvent('pointerdown',pOpts));
    targetEl.dispatchEvent(new MouseEvent('mousedown',mOpts));
    try{targetEl.focus({preventScroll:true});}catch(_){}
    targetEl.dispatchEvent(new PointerEvent('pointerup',pOpts));
    targetEl.dispatchEvent(new MouseEvent('mouseup',mOpts));
    if (button === 'right') targetEl.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX,clientY,button:2}));
    else targetEl.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX,clientY,button:btnNum}));
    return { success: true, x: clientX, y: clientY, target: targetEl.tagName.toLowerCase() };
  }

  function nativeCopyToClipboard(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch(_) {}
    document.body.removeChild(ta);
    return { success: ok };
  }

  function locateFileInput(startEl) {
    if (!startEl) return null;
    if (startEl.tagName === 'INPUT' && startEl.type === 'file') return startEl;
    // search descendants of the clicked/labeled element
    let f = startEl.querySelector && startEl.querySelector('input[type="file"]');
    if (f) return f;
    // search ancestors (e.g. label wrapping the input)
    let p = startEl.parentElement;
    while (p) {
      if (p.tagName === 'INPUT' && p.type === 'file') return p;
      const inner = p.querySelector && p.querySelector('input[type="file"]');
      if (inner) return inner;
      p = p.parentElement;
    }
    // last resort: any hidden file input on the page
    const all = document.querySelectorAll('input[type="file"]');
    return all.length ? all[0] : null;
  }
  // ═══ Upload — multi-strategy + honest confirmation (agentreach pattern) ═══
  // Strategy 1: real <input type=file> via native 'files' setter + events.
  // Strategy 2: drop-zone (no visible input) — DataTransfer drop event on the
  //   upload zone. Confirmation is POSITIVE-ONLY: success:true means the file
  //   landed in the input / drop registered AND (where possible) the page
  //   showed evidence of accepting it. Never claims confirmed without proof.

  function makeFileFromBase64(base64, fileName, mimeType) {
    const bin = atob(base64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], fileName, { type: mimeType || 'application/octet-stream' });
  }

  function isDropZone(el) {
    if (!el) return false;
    const cls = (el.className || '').toString().toLowerCase();
    const testid = (el.getAttribute('data-testid') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (testid.indexOf('upload') !== -1) return true;
    if (cls.indexOf('dropzone') !== -1 || cls.indexOf('drop-zone') !== -1 || cls.indexOf('upload-drop') !== -1 || cls.indexOf('upload-area') !== -1 || cls.indexOf('uploader') !== -1 || cls.indexOf('file-drop') !== -1) return true;
    if (aria.indexOf('upload') !== -1 || aria.indexOf('drop') !== -1) return true;
    return false;
  }

  function findDropZone(startEl) {
    if (startEl) {
      // ancestors + self
      let el = startEl;
      while (el) {
        if (isDropZone(el)) return el;
        el = el.parentElement;
      }
      // descendants
      const inner = startEl.querySelector && startEl.querySelector('[data-testid*="upload"],[class*="dropzone"],[class*="drop-zone"],[class*="upload-area"],[class*="uploader"],[class*="file-drop"],[class*="upload-drop"]');
      if (inner) return inner;
    }
    const all = document.querySelectorAll('[data-testid*="upload"],[class*="dropzone"],[class*="drop-zone"],[class*="upload-area"],[class*="uploader"],[class*="file-drop"],[class*="upload-drop"],[aria-label*="upload"],[aria-label*="drop"]');
    for (let i = 0; i < all.length; i++) if (isDropZone(all[i])) return all[i];
    return null;
  }

  function pageShowsFileName(fileName) {
    // Positive confirmation heuristic: the filename (or its base) appears in
    // visible page text / previews shortly after upload.
    const base = String(fileName || '').replace(/\.[^.]+$/, '').toLowerCase();
    if (!base || base.length < 3) return null; // can't verify reliably
    try {
      const t = (document.body.innerText || '').toLowerCase();
      if (t.indexOf(base) !== -1) return true;
    } catch (_) {}
    return false;
  }

  async function nativeUploadFromBase64(inputEl, base64, fileName, mimeType) {
    const file = makeFileFromBase64(base64, fileName, mimeType);

    // ── Strategy 1: real file input ──
    const realInput = locateFileInput(inputEl);
    if (realInput) {
      const dt = new DataTransfer(); dt.items.add(file);
      try {
        realInput.files = dt.files;
      } catch (_) {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files');
        if (d && d.set) d.set.call(realInput, dt.files);
      }
      realInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      realInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      return {
        success: realInput.files.length > 0,
        method: 'file_input',
        fileCount: realInput.files.length,
        fileName: file.name,
        fileSize: file.size,
        confirmed: realInput.files.length > 0 ? 'input-has-file' : false,
        note: realInput.files.length > 0 ? 'File set on input. Verify the app accepted it before reporting success.' : 'Input rejected the file.',
      };
    }

    // ── Strategy 2: drop-zone (no visible input) ──
    const zone = findDropZone(inputEl);
    if (!zone) throw new Error('No file input or upload drop-zone found for ref');
    const dt2 = new DataTransfer(); dt2.items.add(file);
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    zone.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    // Positive confirmation: wait a beat for the page to render a preview/name.
    // P2 (2026-08-31): MANY apps process the drop asynchronously (upload →
    // XHR → re-render), so a synchronous filename check can return false even
    // though the file LANDED. Re-check after 500ms before declaring
    // 'unconfirmed' — this is the fix for the phantom confirmed:false that
    // made agents retry into duplicates on GitHub's dropzone.
    let shown = pageShowsFileName(fileName);
    if (!shown) {
      await new Promise((r) => setTimeout(r, 500));
      shown = pageShowsFileName(fileName);
    }
    return {
      success: true,
      method: 'dropzone',
      fileName: file.name,
      fileSize: file.size,
      confirmed: shown === true ? 'preview-visible' : 'unconfirmed',
      note: shown === true ? 'Drop dispatched and page shows the filename.' : 'Drop dispatched but no filename preview detected after 500ms — verify visually before claiming success.',
    };
  }

  // ═══ v4 Strategy 3: CLIPBOARD-PASTE into editors (2026-08-31) ═══
  // Rich-text editors (x.com composer, Discord, Slack, Notion) accept images /
  // files via the paste pipeline — no file input, no dropzone. Synthetic
  // ClipboardEvent('paste') carrying the file as a DataTransfer item, with the
  // editor focused. consumed=true (handler called preventDefault) means the
  // editor took it. Positive-only confirmation per PRINCIPLE 5.
  async function nativeUploadPasteIntoEditor(targetEl, base64, fileName, mimeType) {
    try {
      const file = makeFileFromBase64(base64, fileName, mimeType);
      const det = detectEditor(targetEl);
      if (det.kind !== 'editor') {
        return { success: false, refused: 'not-an-editor', note: 'paste-upload targets rich-text editors; use file_input/dropzone strategies for inputs' };
      }
      targetEl.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      const notConsumed = !targetEl.dispatchEvent(ev);
      const consumed = !notConsumed;
      // Editor marks handling asynchronously — give it a beat, then look for
      // ANY evidence the file registered (preview node, filename text, upload chip).
      await new Promise((r) => setTimeout(r, 600));
      const shown = pageShowsFileName(fileName);
      return {
        success: consumed,
        method: 'editor_paste',
        framework: det.framework,
        fileName: file.name,
        fileSize: file.size,
        confirmed: shown === true ? 'preview-visible' : (consumed ? 'consumed-unverified' : 'unconfirmed'),
        note: shown === true ? 'Paste dispatched and page shows the file.'
            : consumed ? 'Paste event was consumed by the editor but no preview detected — verify before claiming success.'
            : 'Editor did not consume the paste event.',
      };
    } catch (e) {
      return { success: false, method: 'editor_paste', error: String(e) };
    }
  }

  // ═══ Network Request Capture ═══
  var networkLog = [];
  var networkCapturing = false;
  function startNetworkCapture() {
    if (networkCapturing) return;
    networkCapturing = true;
    var origFetch = window.fetch;
    window.fetch = function() {
      var url = arguments[0]; var opts = arguments[1] || {};
      var entry = { type:'fetch', url: typeof url==='string'?url:((url&&typeof url==='object'&&url.url)||''), method: opts.method||'GET', timestamp: Date.now() };
      networkLog.push(entry);
      return origFetch.apply(this, arguments).then(function(resp) {
        entry.status = resp.status;
        resp.clone().text().then(function(b) { entry.responseBody = b.slice(0,500); }).catch(function(){});
        return resp;
      });
    };
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) { this._wsMethod = method; this._wsUrl = url; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function() {
      var entry = { type:'xhr', url: this._wsUrl, method: this._wsMethod, timestamp: Date.now() };
      networkLog.push(entry);
      var self = this;
      this.addEventListener('load', function() { entry.status = self.status; try { entry.responseBody = (self.responseText||'').slice(0,500); } catch(_){} });
      return origSend.apply(this, arguments);
    };
  }
  function getNetworkLog(clear, maxEntries) {
    var entries = networkLog.slice(-maxEntries);
    if (clear) networkLog = [];
    return { entries, totalCaptured: networkLog.length, capturing: networkCapturing };
  }

  // ═══ CONSOLE / JS-ERROR CAPTURE (2026-08-30 — parity with Hermes browser_console) ═══
  // Auto-starts on init so page-load JS errors are captured before the first explicit call.
  var consoleCapturing = false;
  var consoleLog = [];
  var _origConsoleLog = null, _origConsoleWarn = null, _origConsoleError = null,
      _origConsoleInfo = null, _origConsoleDebug = null;
  function _pushConsole(type, args) {
    try {
      var text = Array.prototype.map.call(args, function (a) {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }).join(' ');
      consoleLog.push({ type: type, text: text.slice(0, 2000), ts: Date.now() });
      if (consoleLog.length > 300) consoleLog.shift(); // ring buffer
    } catch (_) {}
  }
  function startConsoleCapture() {
    if (consoleCapturing) return;
    consoleCapturing = true;
    _origConsoleLog = console.log; _origConsoleWarn = console.warn;
    _origConsoleError = console.error; _origConsoleInfo = console.info;
    _origConsoleDebug = console.debug;
    console.log = function () { _pushConsole('log', arguments); return _origConsoleLog.apply(console, arguments); };
    console.warn = function () { _pushConsole('warn', arguments); return _origConsoleWarn.apply(console, arguments); };
    console.error = function () { _pushConsole('error', arguments); return _origConsoleError.apply(console, arguments); };
    console.info = function () { _pushConsole('info', arguments); return _origConsoleInfo.apply(console, arguments); };
    console.debug = function () { _pushConsole('debug', arguments); return _origConsoleDebug.apply(console, arguments); };
    window.addEventListener('error', function (e) { _pushConsole('jserror', [String(e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')]); }, true);
    window.addEventListener('unhandledrejection', function (e) { _pushConsole('unhandledrejection', [String((e.reason && e.reason.message) || e.reason || '')]); }, true);
  }
  startConsoleCapture(); // auto-start so page-load errors are captured
  function getConsoleLog(clear, maxEntries) {
    var mainWorld = [];
    try {
      var el = document.getElementById('__ws_console_buffer');
      if (el && el.getAttribute('data-ws')) {
        var parsed = JSON.parse(el.getAttribute('data-ws') || '[]');
        if (Array.isArray(parsed)) mainWorld = parsed;
      }
    } catch (_) {}
    // merge: isolated-world captures first (page-world console in MAIN buffer)
    var all = consoleLog.concat(mainWorld);
    var entries = all.slice(-(maxEntries || 100));
    if (clear) {
      consoleLog = [];
      try { var el2 = document.getElementById('__ws_console_buffer'); if (el2) el2.removeAttribute('data-ws'); } catch (_) {}
    }
    return { entries: entries, totalCaptured: all.length, capturing: consoleCapturing };
  }


  // ═══ Intelligence Tools ═══
  function getDropdownOptions(ref) {
    const el = resolveRef(ref); if(!el) return{error:'Element not found'};
    if(el.tagName==='SELECT') return{ref,tag:'select',label:getLabel(el),options:extractSelectOptions(el),currentValue:el.value};
    const cid = el.getAttribute('aria-controls');
    if(cid){const lb=document.getElementById(cid); if(lb){const opts=Array.from(lb.querySelectorAll('[role="option"],li,.dropdown-item')).filter(isVisible).map((o)=>({value:o.getAttribute('data-value')||o.textContent.trim(),text:o.textContent.trim(),selected:o.getAttribute('aria-selected')==='true'||o.classList.contains('selected')})); return{ref,tag:el.tagName.toLowerCase(),label:getLabel(el),options:opts,currentValue:null,note:'Custom dropdown — click trigger to open, then click option'};}}
    return{error:'Not a dropdown element'};
  }

  function getTabContents(ref) {
    let tablists;
    if(ref){const el=resolveRef(ref); if(!el)return{error:'Element not found'}; const tl=el.getAttribute('role')==='tablist'?el:el.closest('[role="tablist"]'); tablists=tl?[tl]:[];}
    else tablists=Array.from(document.querySelectorAll('[role="tablist"]')).filter(isVisible);
    if(tablists.length===0){const tabs=Array.from(document.querySelectorAll('[data-toggle="tab"],[data-bs-toggle="tab"]')).filter(isVisible); if(tabs.length>0)tablists=[tabs[0].parentElement];}
    return tablists.map((tl)=>{const tabs=Array.from(tl.querySelectorAll('[role="tab"],[data-toggle="tab"],[data-bs-toggle="tab"]')); return{ref:assignRef(tl),label:getLabel(tl).slice(0,50),tabs:tabs.map((t)=>{const pid=t.getAttribute('aria-controls')||t.getAttribute('data-target')||(t.getAttribute('href')||'').replace('#',''); const panel=pid?document.getElementById(pid):null; return{ref:assignRef(t),label:getLabel(t),active:t.getAttribute('aria-selected')==='true'||t.classList.contains('active'),panelRef:pid,contentPreview:panel?(panel.innerText||'').trim().slice(0,200):'[not found]',isHidden:panel?!isVisible(panel):true};})};});
  }

  function getAccordionContents(ref) {
    let sections;
    if(ref){const el=resolveRef(ref); if(!el)return{error:'Element not found'}; sections=[el];}
    else sections=Array.from(document.querySelectorAll('details,[aria-expanded],[data-bs-toggle="collapse"]')).filter(isVisible);
    return sections.map((el)=>{if(el.tagName==='DETAILS'){const s=el.querySelector('summary'); return{ref:assignRef(el),tag:'details',label:s?getLabel(s):getLabel(el),expanded:el.open,contentPreview:(el.innerText||'').trim().slice(0,200)};} const exp=el.getAttribute('aria-expanded')==='true'; const ctrl=el.getAttribute('aria-controls')||el.getAttribute('data-bs-target'); const panel=ctrl?document.getElementById(ctrl.replace('#','')):null; return{ref:assignRef(el),tag:el.tagName.toLowerCase(),label:getLabel(el).slice(0,80),expanded:exp,contentPreview:panel?(panel.innerText||'').trim().slice(0,200):'[not accessible]'};});
  }

  function previewAction(ref) {
    const el=resolveRef(ref); if(!el)return{error:'Element not found'};
    const c=classifyAction(el); const attrs=getAttrs(el); const state=extractState(el); const effect=predictEffect(el,c,attrs);
    const ctx={opensNewTab:attrs.target==='_blank',sameOrigin:c.href?new URL(c.href,location.href).origin===location.origin:null,triggersDownload:attrs.download!==undefined,isFileUpload:el.tagName==='INPUT'&&el.type==='file',acceptedFileTypes:el.accept||null,isReactControlled:detectFramework()==='react'};
    return{ref,classification:c,state,effect,context:ctx};
  }

  function getQuickState() { return{url:window.location.href,title:document.title,readyState:document.readyState,dialogCount:document.querySelectorAll('[role="dialog"][aria-modal="true"],dialog[open]').length,bodyTextHash:(document.body.innerText||'').slice(0,500)}; }

  // page_state for the WS direct-dispatch path (was MISSING — page ops silently
  // fell back to the SW relay; fixed 2026-08-09)
  function getPageState() {
    var isTop = false;
    try { isTop = (window.self === window.top); } catch (_) {}
    var scrollC = null;
    try { scrollC = findScrollContainer() === document.documentElement ? 'window' : 'inner'; } catch (_) { scrollC = 'unknown'; }
    var dialogs = [];
    try { dialogs = WS_DIALOGS.slice(-5).map(function(d){return {type:d.type,message:d.message};}); } catch (_) {}
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      hasModal: !!document.querySelector('[role="dialog"][aria-modal="true"],dialog[open],.modal:not([hidden])'),
      hasCaptcha: !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],.g-recaptcha,#captcha'),
      isLoading: !!document.querySelector('[aria-busy="true"],.loading,.spinner,.loader'),
      pendingDialogs: dialogs,
      hasBeforeUnload: !!WS_HAS_BEFOREUNLOAD,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollPct: Math.round(window.scrollY / Math.max(1, (document.documentElement.scrollHeight || 1) - window.innerHeight) * 100),
      scrollContainer: scrollC,
      isMainFrame: isTop,
    };
  }

  // ═══ Doctor — content-script diagnostics (agentreach doctor pattern) ═══
  function doctorContent() {
    var docCookies = [];
    try {
      document.cookie.split(';').forEach(function (c) {
        var n = (c.split('=')[0] || '').trim();
        if (n) docCookies.push(n);
      });
    } catch (_) {}
    var scrollC = null;
    try { scrollC = findScrollContainer() === document.documentElement ? 'window' : 'inner'; } catch (_) { scrollC = 'unknown'; }
    var isTop = false;
    try { isTop = (window.self === window.top); } catch (_) {}
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      isMainFrame: isTop,
      framework: detectFramework(),
      pageType: extractPageType(),
      quirks: getSiteQuirks(),
      scrollContainer: scrollC,
      scrollY: window.scrollY,
      pendingDialogs: WS_DIALOGS.length,
      hasBeforeUnload: WS_HAS_BEFOREUNLOAD,
      wsBridge: { connecting: !!(window.__WEBSENSE_DEBUG__ || []).length ? 'attempts-logged' : 'silent', debugTail: (window.__WEBSENSE_DEBUG__ || []).slice(-12) },
      docCookieNames: docCookies.slice(0, 50),
      docCookieCount: docCookies.length,
      loaded: window.__WEBSENSE_LOADED__ === true,
    };
  }

  // ═══ Message Handler (SYNC guard + async worker) ═══
  // CRITICAL: the guard must return a REAL synchronous false. An async
  // function's `return false` yields a Promise (truthy) → Chrome keeps the
  // message channel open forever waiting for sendResponse → tabs.sendMessage
  // never settles → the relay hangs until hub timeout. Split so subframes /
  // ad frames close the channel synchronously.
  function handleMessage(message, sender, sendResponse) {
    // NEVER respond from ad iframes — they hijack page ops via the broadcast
    // PAGE_CONTROL relay (chrome.tabs.sendMessage without frameId hits ALL frames).
    if (WS_IS_AD_FRAME) return false;
    // Only the main frame answers untargeted page ops. Subframes answer ONLY
    // when the message explicitly targets them via frameId.
    var isTop = false;
    try { isTop = (window.self === window.top); } catch (_) { isTop = false; }
    if (!isTop && (message.frameId === undefined || message.frameId === 0)) return false;
    // Sync guard passed — hand off to the async worker, keep channel open.
    handleMessageAsync(message, sender, sendResponse);
    return true;
  }

  async function handleMessageAsync(message, sender, sendResponse) {
    const { type, id, ...params } = message;
    let result;
    try {
      switch (type) {
        case 'explore_page': try { result = params.incremental ? await exploreIncremental(params) : await extractActionGraph(params); } catch(e) { result = { success: false, error: 'explore_page failed: ' + e.message, stack: (e.stack||'').slice(0, 500) }; } break;
        case 'discover_actions': { const sag = await extractActionGraph({includeContent:false,full:false,includeHidden:false,maxActions:params.maxActions||250}); result = sag.actions; break; }
        case 'click': { const before=getQuickState(); nativeClick(await resolveRefHealed(params.ref)); result={success:true,ref:params.ref,beforeState:before,afterState:getQuickState()}; break; }
                case 'type_text': { result = await nativeType(await resolveRefHealed(params.ref), params.text, params.clearFirst !== false); result.ref = params.ref; break; }
                case 'select_option': { result=nativeSelect(await resolveRefHealed(params.ref),params.value, params.clearAll); result.ref=params.ref; break; }
                case 'form_special': { result=await nativeSetSpecial(await resolveRefHealed(params.ref), params.value); result.ref=params.ref; break; }
                case 'toggle': { result=nativeToggle(await resolveRefHealed(params.ref)); result.ref=params.ref; break; }
                case 'scroll': result=nativeScroll(params.direction,params.amount||1,params.ref); break;
                case 'scroll_to': result=nativeScrollTo(params.y); break;
                case 'scroll_into_view': result=nativeScrollIntoView(await resolveRefHealed(params.ref)); break;
                case 'press_key': result=nativePressKeyEnhanced(params.key, params.ref, params.modifiers); break;
                case 'evaluate': result=nativeEvaluate(params.script); break;
                case 'evaluate_safe': result=nativeEvaluateSafe(params.query || {}); break;
                case 'type_many': result=nativeTypeMany(params.fields); break;
                case 'hover': result=nativeHover(await resolveRefHealed(params.ref)); break;
                case 'right_click': result=nativeRightClick(await resolveRefHealed(params.ref)); break;
                case 'drag_drop': result=nativeDragDrop(await resolveRefHealed(params.fromRef), await resolveRefHealed(params.toRef)); break;
                case 'click_xy': result=nativeClickXY(params.x, params.y, params.ref, params.button); break;
        case 'copy_to_clipboard': result=nativeCopyToClipboard(params.text); break;
        case 'upload_file': {
          // v4: editor targets get the paste strategy; input/dropzone targets
          // keep the classic strategies.
          const upEl = resolveRefHealed(params.ref);
          const upDet = detectEditor(upEl);
          if (upDet.kind === 'editor') {
            result = await nativeUploadPasteIntoEditor(upEl, params.fileContent, params.fileName, params.mimeType);
          } else {
            result = await nativeUploadFromBase64(upEl, params.fileContent, params.fileName, params.mimeType);
          }
          break;
        }
        case 'network_log': if (!networkCapturing) startNetworkCapture(); result=getNetworkLog(params.clear !== false, params.maxEntries || 50); break;
        case 'console_log': if (!consoleCapturing) startConsoleCapture(); result=getConsoleLog(params.clear !== false, params.maxEntries || 100); break;
        case 'dropdown_options': result=getDropdownOptions(params.ref); break;
        case 'tab_contents': result=getTabContents(params.ref); break;
        case 'accordion_contents': result=getAccordionContents(params.ref); break;
        case 'action_preview': result=previewAction(params.ref); break;
        case 'form_state': { const sag = await extractActionGraph({includeContent:false,full:true}); result=params.formRef?(sag.forms.find((f)=>f.ref===params.formRef)||{error:'Form not found'}):sag.forms; break; }
        case 'page_state': { result={url:window.location.href,title:document.title,readyState:document.readyState,hasModal:!!document.querySelector('[role="dialog"][aria-modal="true"],dialog[open],.modal:not([hidden])'),hasCaptcha:!!document.querySelector('iframe[src*="captcha"],.g-recaptcha,#captcha'),isLoading:!!document.querySelector('[aria-busy="true"],.loading,.spinner'),pendingDialogs:WS_DIALOGS.slice(-5).map(function(d){return {type:d.type,message:d.message};}),hasBeforeUnload:WS_HAS_BEFOREUNLOAD,viewport:{w:window.innerWidth,h:window.innerHeight},scrollPct:Math.round(window.scrollY/Math.max(1,(document.documentElement.scrollHeight||1)-window.innerHeight)*100),wsVersion:'v2-logged',wsDebug:(window.__WEBSENSE_DEBUG__||[]).slice(-30),answerTabId:(sender && sender.tab && sender.tab.id)||null,answerFrameId:(sender&&sender.frameId)||null,answerTop:!!(window.self===window.top)}; break; }
        case 'extract_text': { const sel=params.selector||'body'; const ml=(params.maxLen!==undefined?params.maxLen:(params.max_len!==undefined?params.max_len:4000)); const off=params.offset||0; const el=document.querySelector(sel); const txt=el?fullText(el):''; result=el?txt.slice(off, off+ml):'Element not found for selector: '+sel; result+=(off+ml < txt.length)?'\n...[TRUNCATED — call extract_text again with offset='+(off+ml)+' for the next window]':''; break; }
        case 'read_content': result = readContent(params); break;
        case 'dump_markdown': result = nativeDumpMarkdown(params); break;
        case 'resolve_ref': {
          const el = resolveRef(params.ref);
          if (!el) result = { success: false, error: 'ref not found: ' + params.ref };
          else {
            const loc = buildLocator(el);
            result = { success: true, found: true, ref: params.ref, tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.textContent || '').trim().slice(0, 80),
              value: (el.value != null ? el.value : '').toString().slice(0, 80),
              locator: loc && loc.length ? loc[0] : null, connected: el.isConnected };
          }
          break;
        }
        case 'page_diff': result = getPageDiff(); break;
        case 'find_intent': result = findIntent(params.intent || ''); break;
        case 'geometry': result = getGeometry(params.ref || params.selector || ''); break;
        case 'screen_center': result = screenCenter(params.ref || params.selector || ''); break;
        case 'layout_relation': result = layoutRelation(params.refA || '', params.refB || ''); break;
        case 'get_events': result = getEvents(params.since); break;
        case 'explore_intent': result = exploreIntent(params.goal || ''); break;
        case 'read_selector': {
          try {
            const el = document.querySelector(params.selector);
            if (!el) result = { success: false, error: 'selector not found: ' + params.selector };
            else result = { success: true, selector: params.selector, text: (el.innerText || el.textContent || '').trim().slice(0, 2000), value: (el.value != null ? el.value : null) };
          } catch (e) { result = { success: false, error: e.message }; }
          break;
        }
        case 'write_selector': {
          try {
            const el = document.querySelector(params.selector);
            if (!el) result = { success: false, error: 'selector not found: ' + params.selector };
            else {
              const v = String(params.value == null ? '' : params.value);
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
              const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
              if (setter) setter.call(el, v); else el.value = v;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              result = { success: true, selector: params.selector, set: v, actual: el.value };
            }
          } catch (e) { result = { success: false, error: e.message }; }
          break;
        }
        case 'scroll_and_extract': result = await scrollAndExtract(params); break;
        case 'preload_content': result = await preloadPage(params); break;
        case 'doctor_content': result = doctorContent(); break;
        case 'get_status': result={connected:true,url:window.location.href,title:document.title,wsVersion:'v2-logged',pendingDialogs:WS_DIALOGS.length}; break;
        case 'ping': result={pong:true,url:window.location.href}; break;
        case 'handle_dialog': {
          var idx = (params.index !== undefined && params.index !== null) ? params.index : (WS_DIALOGS.length - 1);
          var dlg = WS_DIALOGS[idx];
          if (!dlg) { result = { success: false, error: 'No pending dialog at index ' + idx }; break; }
          var act = params.action || 'accept';
          // Phase 3 (2026-08-15): clear the auto-resolve timer — the agent is
          // resolving explicitly, so the 30s fallback must not double-fire.
          if (dlg._timer) { try { clearTimeout(dlg._timer); } catch (_) {} }
          if (dlg.type === 'alert') { WS_DIALOGS.splice(idx, 1); result = { success: true, handled: 'alert' }; }
          else if (dlg.type === 'confirm') { var cv = (act === 'dismiss') ? false : true; if (dlg._res) dlg._res(cv); WS_DIALOGS.splice(idx, 1); result = { success: true, handled: 'confirm', value: cv }; }
          else if (dlg.type === 'prompt') { var pv = (act === 'dismiss') ? null : (params.value !== undefined && params.value !== null ? params.value : dlg.defaultValue); if (dlg._res) dlg._res(pv); WS_DIALOGS.splice(idx, 1); result = { success: true, handled: 'prompt', value: pv }; }
          break;
        }
function handleReadClipboard() {
  // navigator.clipboard.readText() needs the document focused AND the
  // clipboardRead permission; in a backgrounded tab it silently returns
  // '' or throws NotAllowedError. Fall back to execCommand('paste')
  // into a hidden textarea, which the extension's clipboardWrite
  // permission allows without document focus.
  return (async () => {
    let txt = null;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        txt = await navigator.clipboard.readText();
      }
    } catch (e) { /* fall through to execCommand path */ }
    if (!txt) {
      try {
        const ta = document.createElement('textarea');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('paste');
        txt = ok ? ta.value : '';
        ta.remove();
      } catch (e2) { txt = ''; }
    }
    return { success: true, text: txt || '' };
  })();
}

        case 'read_clipboard': {
          result = await handleReadClipboard();
          break;
        }
        // P2 (2026-08-31): tab-ops relay fallback — when the offscreen doc is
        // stale/down, hub tab ops fall to a content script which forwards via
        // the SW. cookie_op/download_op/get_active_tab must relay to the SW's
        // handleTabControl instead of hitting the default error.
        case 'cookie_op':
        case 'download_op':
        case 'get_active_tab':
        case 'respawn_offscreen':
        case 'switch_tab':
        case 'close_tab':
        case 'list_frames':
        case 'download_state':
        case 'list_tabs': {
          result = await relayTabControl(type, params);
          break;
        }
        default: result={error:'Unknown action type: '+type};
      }
      sendResponse({type:type+'_result',id,success:true,data:result});
    } catch(err) {
      sendResponse({type:type+'_result',id,success:false,data:err instanceof Error?err.message:String(err)});
    }
    return true;
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  // Re-extract on SPA navigation
  let lastUrl = window.location.href;
  const navObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) { lastUrl = window.location.href; refMap = new Map(); refCounter = 0; locatorByRef.clear(); }
  });
  if (document.body) navObserver.observe(document.body, {childList:true,subtree:true});

  // ═══ A1 (2026-08-10): LIVE DIFF ENGINE ═══
  // A persistent MutationObserver ring buffer. After every action the agent can
  // call page_diff to get ONLY what changed since the last read — instead of a
  // full re-snapshot. This is the biggest token win in the no-vision stack:
  // re-reads cost ~10% of explore_page.
  const diffBuf = [];
  const DIFF_CAP = 200; // ring buffer cap — don't let a heavy SPA OOM the tab
  let diffSince = Date.now();
  let diffObserver = null;

  function startDiffObserver() {
    if (diffObserver || !document.body) return;
    diffObserver = new MutationObserver((muts) => {
      const now = Date.now();
      for (const m of muts) {
        // Coalesce: only record the FIRST mutation touching a given node id
        // per second (avoid flood on frameworks that mutate ancestors + child).
        const key = (m.target && m.target.nodeType === 1 ? m.target.getAttribute('data-websense-ref') : null) || '';
        const nodeInfo = describeMutation(m);
        if (!nodeInfo) continue;
        diffBuf.push({ t: now, type: m.type, node: nodeInfo, key });
        if (diffBuf.length > DIFF_CAP) diffBuf.splice(0, diffBuf.length - DIFF_CAP);
      }
    });
    diffObserver.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  function describeMutation(m) {
    try {
      const el = m.target && m.target.nodeType === 1 ? m.target : (m.target && m.target.parentElement);
      if (!el) return null;
      const tag = el.tagName ? el.tagName.toLowerCase() : '#text';
      const ref = el.getAttribute ? el.getAttribute(REF_ATTR) || assignRef(el) : null;
      const cls = (el.className || '').toString().slice(0, 40);
      const txt = m.type === 'characterData' ? String(m.target.nodeValue || '').slice(0, 60) : '';
      const added = m.addedNodes && m.addedNodes.length ? Array.from(m.addedNodes).slice(0, 3).map(n => {
        return { tag: n.tagName ? n.tagName.toLowerCase() : '#text', id: n.id || '', ref: n.nodeType === 1 ? (n.getAttribute ? n.getAttribute(REF_ATTR) || assignRef(n) : null) : null };
      }) : [];
      const removedCount = m.removedNodes ? m.removedNodes.length : 0;
      return { tag, ref, cls, txt, added, removedCount, attr: m.attributeName || null };
    } catch (_) { return null; }
  }

  function getPageDiff() {
    if (!diffObserver) startDiffObserver();
    const since = diffSince;
    diffSince = Date.now();
    const out = diffBuf.filter((d) => d.t >= since);
    // dedupe by key+type+tag (coalesce framework churn)
    const seen = new Set();
    const unique = [];
    for (const d of out) {
      const k = d.key + '|' + d.type + '|' + (d.node ? d.node.tag + (d.node.attr || '') : '');
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(d);
    }
    const changed = unique.length;
    // Classify: what KIND of change was it (modal appeared? form? text?)
    const modal = unique.some((d) => d.node && d.node.tag && /dialog|modal|popup|overlay/.test(d.node.tag + ' ' + (d.node.cls || '')));
    const form = unique.some((d) => d.node && d.node.tag && /form|input|select|textarea|button/.test(d.node.tag));
    const text = unique.some((d) => d.node && d.node.txt);
    return {
      success: true,
      changed,
      since,
      modal: modal ? 'likely' : 'none',
      form: form ? 'likely' : 'none',
      textChanged: text,
      entries: unique.slice(0, 40), // cap payload — the summary fields carry the signal
      total: diffBuf.length,
      hint: changed === 0 ? 'no changes since last read' : (changed + ' changes — ' + (modal ? 'modal-level, ' : '') + (form ? 'form-level, ' : '') + (text ? 'text' : 'layout')),
    };
  }

  // ═══ A6 (2026-08-10): EVENT STREAM ═══
  // Named, classified events on top of the diff buffer — the agent waits ON
  // the browser ("dialog appeared?", "navigation completed?") instead of blind
  // sleep+poll. dialog_open/dialog_close are detected by MutationObserver;
  // navigation by URL change; network by performance entries.
  const eventBuf = [];
  const EVENT_CAP = 100;
  let lastEventScan = Date.now();

  function scanEvents() {
    // 1. URL change → navigation event
    if (window.location.href !== lastUrl) {
      eventBuf.push({ t: Date.now(), type: 'navigation', detail: lastUrl + ' -> ' + window.location.href });
      lastUrl = window.location.href;
    }
    // 2. Network: collect new resource entries (fetch/XHR/img) since last scan
    try {
      if (window.performance && window.performance.getEntriesByType) {
        const entries = window.performance.getEntriesByType('resource').filter((e) => e.startTime >= lastEventScan - 100);
        if (entries.length) {
          // Summarize: count + top slowest
          const byType = {};
          for (const e of entries.slice(-20)) {
            const kind = (e.initiatorType || 'other');
            byType[kind] = (byType[kind] || 0) + 1;
          }
          eventBuf.push({ t: Date.now(), type: 'network', detail: JSON.stringify(byType), count: entries.length });
        }
      }
    } catch (_) {}
    lastEventScan = Date.now();
    if (eventBuf.length > EVENT_CAP) eventBuf.splice(0, eventBuf.length - EVENT_CAP);
  }

  // Called on every diff read — drains the mutation buffer into named events.
  function drainDiffToEvents() {
    const diff = getPageDiff();
    if (diff.changed === 0) return diff;
    const now = Date.now();
    // dialog_open/close: added/removed nodes with dialog/modal classes
    for (const e of diff.entries) {
      if (!e.node) continue;
      const cls = (e.node.cls || '') + ' ' + (e.node.tag || '');
      if (/dialog|modal|popup|overlay/.test(cls)) {
        if (e.node.added && e.node.added.length) eventBuf.push({ t: now, type: 'dialog_open', detail: e.node.tag + ' ' + e.node.cls, ref: e.node.ref || null });
        if (e.node.removedCount > 0) eventBuf.push({ t: now, type: 'dialog_close', detail: e.node.tag, ref: e.node.ref || null });
      }
      if (e.node.added && e.node.added.length && /form|input|select|textarea|button/.test(e.node.tag)) {
        eventBuf.push({ t: now, type: 'form_update', detail: e.node.tag, ref: e.node.ref || null });
      }
    }
    if (eventBuf.length > EVENT_CAP) eventBuf.splice(0, eventBuf.length - EVENT_CAP);
    return diff;
  }

  function getEvents(since) {
    scanEvents();
    const sinceT = since || Date.now() - 60000; // default: last 60s
    const out = eventBuf.filter((e) => e.t >= sinceT);
    // also drain any pending dialog/form mutations into events
    drainDiffToEvents();
    const out2 = eventBuf.filter((e) => e.t >= sinceT);
    return { success: true, count: out2.length, since: sinceT, events: out2.slice(-30), hint: out2.length ? out2.map((e) => e.type).join(', ') : 'no events since ' + new Date(sinceT).toISOString() };
  }

  window.__WEBSENSE_LOADED__ = true;
})();


