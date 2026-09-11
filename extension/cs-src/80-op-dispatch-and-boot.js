/* handleMessage op dispatcher, diff/event observers, boot
 * Part 08 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
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
