// ═══ DIALOG-HOOK.js — MAIN-world alert/confirm/prompt capture (2026-09-25) ═══
// WHY THIS FILE EXISTS
// The content script overrides window.alert/confirm/prompt in its ISOLATED
// world. Page code runs in the MAIN world and never touches those copies, so a
// page's own alert() was invisible: measured 2026-09-25, a real alert() on the
// workbench left pendingDialogs:[] and dialogCount stuck at 1. Worse, in a
// BACKGROUND tab Chrome auto-dismisses the native dialog silently, so the page
// simply continued — the agent saw "action succeeded" for a step the user would
// have been asked about. That is a silent-wrong-outcome class, the worst kind.
//
// This is the same fix pattern as console-hook.js and network-hook.js: inject
// at document_start into the MAIN world, shadow the three functions, and
// publish to a DOM attribute the isolated-world CS can read (the MAIN world has
// no extension APIs, and a DOM attribute survives the CS not being injected yet).
//
// RESOLUTION: a dialog that nobody answers must not wedge the page. confirm/
// prompt get an auto-answer (true / the default) after AUTO_MS, exactly like
// the isolated-world path already does. The response box is a small promise
// registry the CS resolves via __wsResolveDialog from the isolated world.
(() => {
  try {
    if (window.__WS_DIALOG_HOOKED__) return;
    window.__WS_DIALOG_HOOKED__ = true;
    const MAX = 50;
    const ATTR_CAP = 20000;
    const AUTO_MS = 30000;
    const pending = (window.__WS_DIALOG_PENDING__ = []);
    let seq = 0;

    const recent = (window.__WS_DIALOG_RECENT__ = []);

    const publish = () => {
      try {
        // Only UNRESOLVED dialogs belong in the pending list. Publishing
        // resolved ones left them visible forever (they stayed in `pending`
        // with done:true), so page_state reported stale dialogs indefinitely.
        const view = pending.filter((d) => !d.done).map((d) => ({
          id: d.id, type: d.type, message: d.message,
          defaultValue: d.defaultValue, ts: d.ts, auto: !!d.auto,
        }));
        let s = JSON.stringify(view);
        if (s.length > ATTR_CAP) s = s.slice(s.length - ATTR_CAP);
        document.documentElement.setAttribute('data-ws-dialogs', s);

        // RECENT history, including dialogs already resolved or auto-answered.
        // This is what closes the silent-outcome hole: an alert() is
        // synchronous, so the page continues the instant it is raised and the
        // dialog can never still be "pending" by the time an agent looks. The
        // agent needs to see THAT one fired, even though it is already gone.
        let rs = JSON.stringify(recent);
        if (rs.length > ATTR_CAP) rs = rs.slice(rs.length - ATTR_CAP);
        document.documentElement.setAttribute('data-ws-dialogs-recent', rs);
      } catch (_) { /* never let reporting break the page */ }
    };

    const remember = (d, outcome) => {
      recent.push({
        id: d.id, type: d.type, message: d.message, ts: d.ts,
        auto: !!d.auto, outcome: outcome,
      });
      while (recent.length > MAX) recent.shift();
    };

    const auto = (d, value) => {
      if (d.done) return;
      d.done = true; d.auto = true;
      d.resolve(value);
      const i = pending.indexOf(d);
      if (i >= 0) pending.splice(i, 1);
      remember(d, value === undefined ? 'auto' : value);
      publish();
    };

    // Called from the ISOLATED world by the CS via a CustomEvent detail. A
    // direct call would not work: the isolated world has its own `window`, so
    // window.__wsResolveDialog here is a different binding than the one the CS
    // sees. Events cross the boundary in both directions.
    window.__wsResolveDialog = function (id, action, value) {
      const d = pending.find((x) => x.id === id);
      if (!d || d.done) return { success: false, error: 'dialog not pending' };
      d.done = true;
      let out;
      if (d.type === 'alert') out = undefined;
      else if (d.type === 'confirm') out = (action === 'dismiss') ? false : true;
      else out = (action === 'dismiss') ? null : (value != null ? String(value) : d.defaultValue);
      d.resolve(out);
      const i = pending.indexOf(d);
      if (i >= 0) pending.splice(i, 1);
      remember(d, out === undefined ? 'handled' : out);
      publish();
      return { success: true, handled: d.type };
    };

    document.addEventListener('__wsResolveDialog', function (e) {
      const det = (e && e.detail) || {};
      const reply = window.__wsResolveDialog(det.id, det.action, det.value);
      try {
        if (det.replyAttr) {
          document.documentElement.setAttribute(det.replyAttr, JSON.stringify(reply || {}));
        }
      } catch (_) {}
    });

    const install = (name, type) => {
      const orig = window[name];
      if (typeof orig !== 'function') return;
      window[name] = function (msg, def) {
        const d = {
          id: 'd' + (++seq),
          type,
          message: String(msg == null ? '' : msg),
          defaultValue: type === 'prompt' ? String(def == null ? '' : def) : undefined,
          ts: Date.now(), done: false, auto: false,
          resolve: null,
        };
        if (type === 'alert') {
          // alert is synchronous in the page API. We cannot block the page
          // thread (that would hang the page), so the dialog is RECORDED and
          // the page continues — which matches what Chrome itself does in a
          // background tab, minus the surprise.
          pending.push(d); publish();
          setTimeout(() => auto(d, undefined), 0);
          return undefined;
        }
        const p = new Promise((r) => { d.resolve = r; });
        pending.push(d); publish();
        setTimeout(() => auto(d, type === 'confirm' ? true : d.defaultValue), AUTO_MS);
        return p;
      };
      // Keep the original callable (some pages feature-detect toString/name).
      try { Object.defineProperty(window[name], 'name', { value: name }); } catch (_) {}
    };

    install('alert', 'alert');
    install('confirm', 'confirm');
    install('prompt', 'prompt');

    publish();
    document.documentElement.setAttribute('data-ws-dialog-hook', '1');
  } catch (_) { /* never let the hook break the page */ }
})();
