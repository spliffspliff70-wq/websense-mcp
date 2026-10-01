// ═══ PAGE SNAPSHOT + ADDRESSABLE INDEX + SLICE ═══════════════════════════════════
// Ali's architecture (2026-09-21), stated as a requirement:
//   "why can't the structuring not cut anything out but simply map or index the webpage
//    for agentic use... models don't read webpages like humans so we don't have to
//    constrain them to"  +  "implement fully and wire locally and test end to end".
//
// THE THREE PARTS:
//   1. SNAPSHOT — a LOSSLESS point-in-time inventory of the page's elements, held
//      server-side. Nothing is dropped, so nothing has to be re-fetched.
//   2. INDEX    — a small, always-affordable summary (counts + addressable dimensions)
//      that is what an agent actually reads.
//   3. SLICE    — full-fidelity records for ONE slice of the snapshot, fetched by key.
//
// WHY NOT reuse the existing per-tab scan cache: it is NOT lossless. Measured in
// extension/websense-cs.js collectScan():
//     if (!isInteractive(el)) continue;
//     if (!isInViewport(el) && !el.closest('[role="dialog"],[aria-modal="true"]')) continue;
// so it holds only INTERACTIVE + IN-VIEWPORT elements. Consequence: anything below the
// fold is invisible to it, and (because the set changes as you scroll) SCROLLING POLLUTES
// THE DIFF — mem records a scroll producing changedRatio 1.038 with 12 added / 40 removed,
// which is viewport churn being reported as page mutation. A snapshot that is
// viewport-INDEPENDENT is therefore a correctness fix, not just a feature.
//
// COLLECTION PATH: main_world (a compiled function in the page MAIN world) — CSP-immune,
// fully background, and requires NO extension change, so this can be wired and tested
// without an extension reload.

// ── The collector. Runs IN the page. Must be self-contained (no outer-scope refs). ──
export const COLLECTOR = `() => {
  // ★ NO CAP (2026-10-01, Ali: "Agreed no capping no filtering implement and test").
  // This used to be MAX = 20000 with an early break. Removed: the
  // inventory is meant to be LOSSLESS, and a cap on it is exactly the silent cut the
  // snapshot exists to avoid. The cost of removing it is server memory, not
  // correctness — and the index now carries 'dropped' (must be 0) so a future cut
  // cannot hide.
  var out = [];
  var all;
  try { all = document.querySelectorAll('*'); } catch (e) { all = []; }
  var total = all.length;
  var truncated = false;
  var nonRenderable = 0;   // counted, NOT dropped — see the no-filter note below
  var vw = window.innerWidth, vh = window.innerHeight;

  function short(s, n) {
    // n is retained for call-site compatibility but NO LONGER TRUNCATES.
    // ★ NO FILTER: name/href/value/region-heading were cut at 90/120/80/50 chars,
    // which is the same mistake as the LABEL_MAX=40 delta bug — it destroys meaning
    // mid-string and makes a stored record unreadable. The snapshot is stored
    // server-side and never shipped whole; only slices leave. Store it raw.
    return (s == null ? '' : String(s)).replace(/\\s+/g, ' ').trim();
  }

  // A usable CSS locator: prefer stable identity, else an nth-of-type chain.
  function locatorOf(el) {
    if (el.id) {
      try { if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id; } catch (e) {}
    }
    var a = el.getAttribute && el.getAttribute('data-testid');
    if (a) { try { if (document.querySelectorAll('[data-testid="' + a + '"]').length === 1) return '[data-testid="' + a + '"]'; } catch (e) {} }
    var nm = el.getAttribute && el.getAttribute('name');
    if (nm) return el.tagName.toLowerCase() + '[name="' + nm + '"]';
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'html') break;
      var p = node.parentNode, idx = 1, sib = node;
      while (sib && sib.previousElementSibling) { sib = sib.previousElementSibling; idx++; }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      if (node.id) { parts[0] = '#' + node.id; break; }
      node = p; depth++;
    }
    return parts.join(' > ');
  }

  function nameOf(el) {
    var v = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || el.getAttribute('title') || el.getAttribute('alt'));
    if (v) return short(v, 90);
    var id = el.id;
    if (id) {
      try {
        var lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return short(lab.textContent, 90);
      } catch (e) {}
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      var p = el.closest && el.closest('label');
      if (p) return short(p.textContent, 90);
    }
    // own text only (leaf-ish), so parents do not absorb all descendants' text
    var kids = el.children ? el.children.length : 0;
    if (kids === 0) return short(el.textContent, 90);
    return '';
  }

  function regionOf(el) {
    var node = el.parentElement, hops = 0;
    while (node && hops < 12) {
      var t = node.tagName ? node.tagName.toLowerCase() : '';
      if (t === 'form') return 'form:' + (node.getAttribute('name') || node.id || 'anonymous');
      if (t === 'header') return 'header';
      if (t === 'nav') return 'nav';
      if (t === 'main') return 'main';
      if (t === 'footer') return 'footer';
      if (t === 'aside') return 'aside';
      if (t === 'section' || t === 'article') {
        var h = node.querySelector && node.querySelector('h1,h2,h3');
        return t + ':' + short(h ? h.textContent : (node.getAttribute('aria-label') || ''), 50);
      }
      var role = node.getAttribute && node.getAttribute('role');
      if (role === 'dialog') return 'dialog';
      if (role === 'region') return 'region:' + short(node.getAttribute('aria-label') || '', 40);
      node = node.parentElement; hops++;
    }
    return 'body';
  }

  for (var i = 0; i < all.length; i++) {
    // ★ NO CAP: the early-break on MAX that used to sit here is gone.
    var el = all[i];
    var t = (el.tagName || '').toLowerCase();
    // ★ NO FILTER: this used to skip script/style/meta/link/head/title/base with a
    // continue. That made elements (2719) disagree with domTotal (2774) while truncated
    // still read FALSE — a silent 55-element cut the index could not report, which is
    // worse than the cut. Every element is recorded now; slice them out by tag.
    if (t === 'script' || t === 'style' || t === 'meta' || t === 'link' || t === 'head' || t === 'title' || t === 'base') nonRenderable++;
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    var inVp = !!(r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
      && r.top < vh && r.left < vw);
    var role = el.getAttribute && el.getAttribute('role');
    var rec = { i: i, tag: t, loc: locatorOf(el), region: regionOf(el) };
    if (role) rec.role = role;
    var ty = el.getAttribute && el.getAttribute('type');
    if (ty) rec.type = ty;
    var nm = nameOf(el);
    if (nm) rec.name = nm;
    var hr = el.getAttribute && el.getAttribute('href');
    if (hr) rec.href = short(hr, 120);
    if (inVp) rec.vp = 1;
    if (el.disabled) rec.dis = 1;
    if (el.checked) rec.chk = 1;
    var val = el.value;
    if (typeof val === 'string' && val) rec.value = short(val, 80);
    if (r) { rec.x = Math.round(r.left); rec.y = Math.round(r.top); }
    out.push(rec);
  }
  return { url: location.href, title: document.title, total: total, truncated: truncated,
           nonRenderable: nonRenderable, vw: vw, vh: vh, count: out.length, elements: out };
}`;

// ── Server-side snapshot store: one entry per tab, TTL + LRU bounded. ──
// The snapshot is the lossless artifact; it is NEVER shipped whole. Only the index and
// explicit slices leave the server.
const TTL_MS = Number(process.env.WEBSENSE_SNAP_TTL_MS || 5 * 60 * 1000);
const MAX_TABS = Number(process.env.WEBSENSE_SNAP_MAX_TABS || 8);
const store = new Map(); // tabId -> { at, seq, snap, index }

function evictIfNeeded() {
  if (store.size <= MAX_TABS) return;
  let oldest = null;
  for (const [k, v] of store) if (!oldest || v.at < oldest[1].at) oldest = [k, v];
  if (oldest) store.delete(oldest[0]);
}

export function putSnapshot(tabId, snap) {
  const prev = store.get(tabId);
  const seq = prev ? prev.seq + 1 : 1;
  const index = buildIndex(snap);
  store.set(tabId, { at: Date.now(), seq, snap, index });
  evictIfNeeded();
  return { seq, index };
}

export function getSnapshot(tabId) {
  const e = store.get(tabId);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { store.delete(tabId); return null; }
  return e;
}

export function snapshotStats() {
  return { tabs: store.size, ttlMs: TTL_MS, maxTabs: MAX_TABS };
}

// ── The INDEX: what an agent always reads. Small by construction. ──
export function buildIndex(snap) {
  const els = (snap && snap.elements) || [];
  const byTag = {}, byRole = {}, byRegion = {};
  let interactive = 0, inViewport = 0, withName = 0, offViewport = 0;
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'option']);
  for (const e of els) {
    byTag[e.tag] = (byTag[e.tag] || 0) + 1;
    const r = e.role || '(none)';
    byRole[r] = (byRole[r] || 0) + 1;
    if (e.name) withName++;
    if (e.vp) inViewport++;
    else offViewport++;
    if (INTERACTIVE.has(e.tag) || e.role === 'button' || e.role === 'link' || e.role === 'textbox'
      || e.role === 'checkbox' || e.role === 'combobox' || e.role === 'tab' || e.role === 'menuitem') {
      interactive++;
    }
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const byTagAll = top(byTag), byRoleAll = top(byRole);
  return {
    url: snap.url, title: snap.title,
    elements: els.length, domTotal: snap.total, truncated: !!snap.truncated,
    // ★ COMPLETENESS PROOF (2026-10-01, no capping / no filtering). `dropped` must be
    // 0. Before this, a tag filter cut 55 elements and `truncated` still read false, so
    // the index could not tell you the map was incomplete — a silent loss is worse than
    // a declared one. `nonRenderable` counts script/style/meta/link/head/title/base,
    // which are RECORDED (not dropped) and sliceable by tag.
    dropped: Math.max(0, Number(snap.total || 0) - els.length),
    nonRenderable: Number(snap.nonRenderable || 0),
    interactive, inViewport, offViewport, named: withName,
    // FULL lists, no top-N cut — the caller slices what it wants.
    topTags: byTagAll, topRoles: byRoleAll,
    tagCount: byTagAll.length, roleCount: byRoleAll.length,
    // Addressable dimensions — the keys a slice can be taken by.
    addressableBy: ['tag', 'role', 'region', 'vp', 'interactive', 'query'],
  };
}

// ── SLICE: full-fidelity records for one dimension. ──
export function sliceSnapshot(snap, filter = {}) {
  const els = (snap && snap.elements) || [];
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'option']);
  const q = filter.query ? String(filter.query).toLowerCase() : null;
  // ★ NO CAP (2026-10-01): this was `Math.min(Number(filter.limit) || 200, 2000)` — a
  // DEFAULT of 200 with a hard ceiling of 2000, so asking for everything silently got
  // you 2000. A slice now returns ALL matches unless the caller explicitly passes
  // `limit`, which is then honoured exactly (no clamp) and reported via
  // truncatedByLimit. Nothing is cut without the caller asking for the cut.
  const hasLimit = filter.limit != null && filter.limit !== '';
  const limit = hasLimit ? Number(filter.limit) : Infinity;
  const out = [];
  let matched = 0;
  for (const e of els) {
    if (filter.tag && e.tag !== filter.tag) continue;
    if (filter.role && (e.role || '') !== filter.role) continue;
    if (filter.region && !String(e.region || '').includes(filter.region)) continue;
    if (filter.vp === true && !e.vp) continue;
    if (filter.vp === false && e.vp) continue;
    if (filter.interactive === true
      && !(INTERACTIVE.has(e.tag) || ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem'].includes(e.role))) continue;
    if (q) {
      const hay = ((e.name || '') + ' ' + (e.loc || '') + ' ' + (e.tag || '')).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    matched++;
    if (out.length < limit) out.push(e);
  }
  return { matched, returned: out.length, truncatedByLimit: matched > out.length, total: els.length, elements: out };
}
