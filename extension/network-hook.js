// ═══ NETWORK-HOOK.js — MAIN-world fetch/XHR capture (2026-09-25) ═══
// Same problem the console hook already solved: the ISOLATED-world content
// script patches its OWN copy of window.fetch / XMLHttpRequest.prototype.
// Page code runs in the MAIN world and never touches those copies, so
// network_log stayed permanently empty on every real page (measured 2026-09-25:
// 4 capture runs → 0 entries while main_world fetch/XHR oracles both succeeded).
//
// This file is injected at document_start into the MAIN world through the same
// chrome.scripting.registerContentScripts({world:'MAIN'}) registration the
// console hook uses. Entries land on a hidden DOM node's data-ws-net attribute;
// the content script merges them into its isolated-world log on read.
//
// Design notes:
//  - Output is a DOM attribute, NOT chrome.storage / runtime messaging: the
//    MAIN world has no extension APIs, and the attribute survives the CS not
//    being injected yet (a navigation race costs nothing, unlike a WS push).
//  - Cap the buffer (MAX) and the serialized attribute (ATTR_CAP) — this is
//    a text node read on every network_log call, and 500-char response bodies
//    make unbounded growth expensive.
//  - Header capture is opt-in via wsNetHeaders() (set by the CS when the tool
//    asks), so normal operation stores no request headers at all.
(() => {
  try {
    if (window.__WS_NETWORK_HOOKED__) return;
    window.__WS_NETWORK_HOOKED__ = true;
    const MAX = 200;
    const ATTR_CAP = 120000; // ~120KB attribute; slice from the front if exceeded
    const elId = '__ws_net_buffer';
    const buf = (window.__WS_NETWORK__ = []);
    let captureHeaders = false;
    window.__WS_NET_HOOK_SET_HEADERS__ = function (on) { captureHeaders = !!on; };

    function persist() {
      try {
        let el = document.getElementById(elId);
        if (!el) {
          el = document.createElement('div');
          el.id = elId;
          el.style.display = 'none';
          (document.documentElement || document.body || document).appendChild(el);
        }
        let payload = JSON.stringify(buf);
        if (payload.length > ATTR_CAP) payload = payload.slice(payload.length - ATTR_CAP);
        el.setAttribute('data-ws-net', payload);
      } catch (_) {}
    }
    function push(entry) {
      try {
        buf.push(entry);
        if (buf.length > MAX) buf.splice(0, buf.length - MAX);
        persist();
      } catch (_) {}
    }
    function urlOf(u) {
      if (typeof u === 'string') return u;
      if (u && typeof u.url === 'string') return u.url;
      try { return String(u); } catch (_) { return ''; }
    }
    function headersToObject(h) {
      if (!captureHeaders) return undefined;
      const out = {};
      try { (h && h.forEach ? h : []).forEach((v, k) => { out[k] = v; }); } catch (_) {}
      return Object.keys(out).length ? out : undefined;
    }

    // ── fetch ──────────────────────────────────────────────────────────────
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        const args = arguments;
        const input = args[0];
        const opts = args[1] || {};
        const entry = {
          type: 'fetch',
          url: urlOf(input),
          method: opts.method || (input && input.method) || 'GET',
          timestamp: Date.now(),
        };
        try { if (captureHeaders) entry.requestHeaders = headersToObject(opts.headers || (input && input.headers)); } catch (_) {}
        push(entry);
        let p;
        try { p = origFetch.apply(this, args); } catch (e) { entry.error = String((e && e.message) || e); throw e; }
        return Promise.resolve(p).then(function (resp) {
          try {
            entry.status = resp && resp.status;
            if (resp && resp.headers) entry.responseHeaders = headersToObject(resp.headers);
            if (resp && typeof resp.clone === 'function') {
              resp.clone().text().then(function (b) { entry.responseBody = String(b).slice(0, 500); }).catch(function () {});
            }
          } catch (_) {}
          return resp;
        });
      };
    }

    // ── XMLHttpRequest ─────────────────────────────────────────────────────
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this._wsMethod = method;
        this._wsUrl = urlOf(url);
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        const entry = { type: 'xhr', url: this._wsUrl, method: this._wsMethod, timestamp: Date.now() };
        try { if (captureHeaders) entry.requestHeaders = headersToObject(this._wsHeaders); } catch (_) {}
        push(entry);
        const xhr = this;
        // Fill status/body when the request completes. `send()` can be called
        // once per XHR, so no listener-leak bookkeeping is needed.
        xhr.addEventListener('load', function () {
          try {
            entry.status = xhr.status;
            if (captureHeaders && xhr.getAllResponseHeaders) entry.responseHeaders = xhr.getAllResponseHeaders().slice(0, 1000);
            if (!xhr.responseType || xhr.responseType === 'text') entry.responseBody = String(xhr.responseText || '').slice(0, 500);
          } catch (_) {}
        });
        return origSend.apply(this, arguments);
      };
      // Remember headers set via setRequestHeader for the entry written at send().
      const origSetHeader = XHR.prototype.setRequestHeader;
      XHR.prototype.setRequestHeader = function (name, value) {
        try { (this._wsHeaders = this._wsHeaders || {})[name] = value; } catch (_) {}
        return origSetHeader.apply(this, arguments);
      };
    }
  } catch (_) {}
})();
