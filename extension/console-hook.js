// ═══ CONSOLE-HOOK.js — MAIN-world console/JS-error capture (2026-08-30) ═══
// Injected at document_start into the MAIN world (page context) via
// chrome.scripting.registerContentScripts({world:'MAIN'}). The isolated-world
// content script CANNOT see page console.* — only a main-world hook can.
// Output: JSON array persisted on a hidden DOM node the content script reads.
(() => {
  try {
    if (window.__WS_CONSOLE_HOOKED__) return;
    window.__WS_CONSOLE_HOOKED__ = true;
    const MAX = 300;
    const buf = (window.__WS_CONSOLE__ = []);
    const elId = '__ws_console_buffer';
    function persist() {
      try {
        let el = document.getElementById(elId);
        if (!el) {
          el = document.createElement('div');
          el.id = elId;
          el.style.display = 'none';
          (document.documentElement || document.body || document).appendChild(el);
        }
        el.setAttribute('data-ws', JSON.stringify(buf.slice(-120)));
      } catch (_) {}
    }
    function push(type, args) {
      try {
        const text = Array.prototype.map.call(args, function (a) {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (_) { return String(a); }
        }).join(' ').slice(0, 2000);
        buf.push({ type: type, text: text, ts: Date.now() });
        if (buf.length > MAX) buf.splice(0, buf.length - MAX);
        persist();
      } catch (_) {}
    }
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    console.log   = function () { push('log', arguments); return orig.log.apply(console, arguments); };
    console.warn  = function () { push('warn', arguments); return orig.warn.apply(console, arguments); };
    console.error = function () { push('error', arguments); return orig.error.apply(console, arguments); };
    console.info  = function () { push('info', arguments); return orig.info.apply(console, arguments); };
    console.debug = function () { push('debug', arguments); return orig.debug.apply(console, arguments); };
    window.addEventListener('error', function (e) {
      push('jserror', [String((e && e.message) || '') + ' @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || '')]);
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      push('unhandledrejection', [String((e && e.reason && e.reason.message) || (e && e.reason) || '')]);
    }, true);
  } catch (_) {}
})();
