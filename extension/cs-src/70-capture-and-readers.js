/* Network/console capture, dropdown/accordion/tab readers, page state
 * Part 07 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
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
    var max = maxEntries || 50;
    // MAIN-world entries (2026-09-25): network-hook.js patches the PAGE's
    // fetch/XHR, which is the only place real page traffic ever goes. The
    // isolated-world patch above still catches calls made BY the content script
    // (e.g. its own probes) — keep both, main first (it is the real traffic).
    var mainWorld = [];
    try {
      var el = document.getElementById('__ws_net_buffer');
      if (el) {
        var parsed = JSON.parse(el.getAttribute('data-ws-net') || '[]');
        if (Array.isArray(parsed)) mainWorld = parsed;
      }
    } catch (_) {}
    var all = mainWorld.concat(networkLog);
    var entries = all.slice(-max);
    // totalCaptured must be read BEFORE clearing (2026-09-25): the old code
    // cleared the array first and then reported networkLog.length, so every
    // clear:true call reported totalCaptured:0 — a permanent "nothing was ever
    // captured" lie that hid real traffic from the agent.
    var total = all.length;
    if (clear) {
      networkLog = [];
      try { var el2 = document.getElementById('__ws_net_buffer'); if (el2) el2.removeAttribute('data-ws-net'); } catch (_) {}
    }
    return { entries: entries, totalCaptured: total, capturing: networkCapturing || mainWorld.length > 0,
             cleared: !!clear, mainWorldEntries: mainWorld.length, isolatedWorldEntries: networkLog.length };
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
    // 2026-09-25: include the MAIN-world queue. The page's own alert/confirm/
    // prompt never touch the isolated-world WS_DIALOGS, so without this every
    // status reported pendingDialogs:[] even while a confirm() was blocking the
    // page — a silent-wrong-outcome class.
    try { dialogs = dialogs.concat(readMainWorldDialogs().slice(-5)); } catch (_) {}
    var recent = [];
    try { recent = readRecentMainWorldDialogs().slice(-8); } catch (_) {}
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      hasModal: !!document.querySelector('[role="dialog"][aria-modal="true"],dialog[open],.modal:not([hidden])'),
      hasCaptcha: !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],.g-recaptcha,#captcha'),
      isLoading: !!document.querySelector('[aria-busy="true"],.loading,.spinner,.loader'),
      pendingDialogs: dialogs,
      recentDialogs: recent,
      hasBeforeUnload: !!WS_HAS_BEFOREUNLOAD,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollPct: Math.round(window.scrollY / Math.max(1, (document.documentElement.scrollHeight || 1) - window.innerHeight) * 100),
      scrollContainer: scrollC,
      isMainFrame: isTop,
      // ★ ONE FRESHNESS TRUTH (2026-10-01). The relay copy used to report a HARDCODED
      // wsVersion:'v4.6.0', which was both a hardcoded value and stale — the real build was
      // v4.6.1. The build stamp is substituted here at build time and encodes BOTH the
      // version and the source hash, so reporting it is the only freshness claim that
      // cannot rot. Reported from one place so both dispatchers agree.
      csBuild:'__CS_BUILD__',
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
        // ── Ops ONLY this route can serve. These need the offscreen document or the
        //    service worker (tab/cookie/download control), which a page script has no
        //    API for — so they stay here as a routing table, not an implementation.
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
        // ── EVERY page op: DELEGATE. This path used to carry a hand-maintained SECOND
        //    copy of 48 ops (2026-10-01 audit: 48 in both switches, and already drifted —
        //    action_preview called a function that exists nowhere, extract_text/ping/
        //    get_status answered different shapes). There is now ONE implementation,
        //    wsDispatchPage() in 00-bridge-and-transport.js; it is declared in the FIRST
        //    file of the concatenation, so it is hoisted and visible here. `ctx` carries
        //    only the sender identity this route alone knows.
        default:
          result = await wsDispatchPage(message, { sender: sender });
      }
      sendResponse({type:type+'_result',id,success:true,data:result});
    } catch(err) {
      sendResponse({type:type+'_result',id,success:false,data:err instanceof Error?err.message:String(err)});
    }
    return true;
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  // Re-extract on SPA navigation
