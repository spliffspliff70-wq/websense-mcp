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

  // A usable CSS locator, built from whatever THIS element actually carries.
  // ★ DERIVED, NOT DECLARED (2026-10-01): the old version preferred a hardcoded
  // 'data-testid' (a React convention) and then 'name'. Now: id first, then whichever
  // of the element's OWN attributes is unique in this document. No framework
  // convention is assumed. Uniqueness is a MAP LOOKUP against a single pre-pass
  // (attrCount) rather than a document-wide query per attribute — the naive version
  // is O(elements x attributes) document scans, which is how a page like x.com turns
  // a locator into a multi-second stall.
  function locatorOf(el, attrCount) {
    if (el.id) return '#' + el.id;
    var at = el.attributes;
    if (at && attrCount) {
      for (var i = 0; i < at.length; i++) {
        var an = at[i].name;
        if (an === 'style' || an === 'class' || an === 'data-websense-ref') continue;
        if (attrCount[an + '=' + at[i].value] === 1) {
          try { return el.tagName.toLowerCase() + '[' + an + '="' + CSS.escape(at[i].value) + '"]'; } catch (e) {}
        }
      }
    }
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
    // ★ DERIVED, NOT DECLARED: scan the element's OWN attributes for a name-ish one by
    // PATTERN (label/title/alt/placeholder/name), rather than testing a fixed list of
    // attribute names. Then fall back to the element's own visible text when it is a
    // leaf (so parents never absorb their descendants' text).
    var at = el.attributes;
    if (at) {
      var best = '';
      for (var i = 0; i < at.length; i++) {
        var an = at[i].name;
        if (an === 'class' || an === 'style' || an === 'id') continue;
        if (/label|title|alt|placeholder|name/i.test(an)) {
          var v = at[i].value;
          if (v && v.replace(/\\s+/g, '')) { best = short(v); break; }
        }
      }
      if (best) return best;
    }
    var id = el.id;
    if (id) {
      try {
        var lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return short(lab.textContent);
      } catch (e) {}
    }
    var kids = el.children ? el.children.length : 0;
    if (kids === 0) return short(el.textContent);
    return '';
  }

  // REGION — derived from the page's OWN vocabulary.
  // ★ NO HARDCODED NAMES (2026-10-01, Ali: "any value or names should be dynamically
  // parsed by the script"). The old version named form/header/nav/main/footer/aside/
  // section/article — a hand-written list of tags, so a page that structures itself
  // with custom elements or ARIA roles got no region at all. The region key is now
  // whatever the PAGE says: the nearest ancestor that carries a role, or an accessible
  // name (aria-label / aria-labelledby). Nothing here is a fixed vocabulary.
  function regionOf(el) {
    var node = el.parentElement, hops = 0;
    while (node && hops < 12) {
      var role = node.getAttribute && node.getAttribute('role');
      var label = node.getAttribute && (node.getAttribute('aria-label')
        || (node.getAttribute('aria-labelledby')
             ? (function (ids) {
                 var t = [];
                 for (var k = 0; k < ids.length; k++) {
                   var r = document.getElementById(ids[k]);
                   if (r) t.push(r.textContent);
                 }
                 return t.join(' ');
               })(String(node.getAttribute('aria-labelledby')).split(/\\s+/))
             : ''));
      var tag = (node.tagName || '').toLowerCase();
      if (role) return 'role:' + role + (label ? ':' + short(label, 60) : '');
      if (label) return tag + ':' + short(label, 60);
      node = node.parentElement; hops++;
    }
    return 'body';
  }

  // ONE pre-pass: count every attribute-name=value occurrence in the document, so a
  // per-element uniqueness test is a map lookup instead of a document-wide query.
  var attrCount = Object.create(null);
  for (var pi = 0; pi < all.length; pi++) {
    var pat = all[pi].attributes;
    if (!pat) continue;
    for (var pj = 0; pj < pat.length; pj++) {
      var pk = pat[pj].name + '=' + pat[pj].value;
      attrCount[pk] = (attrCount[pk] || 0) + 1;
    }
  }

  // Element -> index, so a record can carry a PARENT POINTER. With that, "where is
  // this and which branch does it belong to" is an O(1) walk up the array instead of a
  // rendered diagram — the branch is data, not a picture (2026-10-01).
  var idxOf = new Map();
  for (var q = 0; q < all.length; q++) { try { idxOf.set(all[q], q); } catch (_) {} }

  for (var i = 0; i < all.length; i++) {
    // ★ NO CAP: the early-break on MAX that used to sit here is gone.
    // ★ NO FILTER / NO HARDCODED NAMES: the old line skipped script/style/meta/link/
    //   head/title/base (a hand-written tag list) and the record below read a fixed set
    //   of attribute names. Both are gone — see the attribute capture, which records
    //   EVERY attribute the page wrote, so the vocabulary belongs to the page.
    var el = all[i];
    var t = (el.tagName || '').toLowerCase();
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    var inVp = !!(r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
      && r.top < vh && r.left < vw);
    var rec = { i: i, tag: t, loc: locatorOf(el, attrCount), region: regionOf(el) };
    // Branch pointer: the nearest ancestor that is itself in this inventory. Document
    // order means that is nearly always the immediate parent, so this is O(1) amortised.
    var pn = el.parentElement, hops = 0;
    while (pn && hops < 200 && !idxOf.has(pn)) { pn = pn.parentElement; hops++; }
    if (pn && idxOf.has(pn)) rec.p = idxOf.get(pn);
    var nm = nameOf(el);
    if (nm) rec.name = nm;

    // EVERY ATTRIBUTE, verbatim. The page decides the field names: data-offset-*,
    // data-contents, data-block, data-testid, hooks, bespoke names — all of it. The
    // caller can then group or slice by whatever THIS site calls things.
    var at = el.attributes;
    if (at && at.length) {
      var attrs = {};
      for (var a = 0; a < at.length; a++) {
        var an = at[a].name;
        if (an === 'data-websense-ref') continue;   // our bookkeeping, not page truth
        attrs[an] = at[a].value;
      }
      var akeys = [];
      for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) akeys.push(k);
      if (akeys.length) { rec.attrs = attrs; rec.attrNames = akeys; }
    }

    // State read from the PLATFORM's own IDL, not from a name table.
    if (el.tabIndex >= 0) rec.focusable = 1;
    if (el.disabled) rec.dis = 1;
    if (el.checked) rec.chk = 1;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') rec.field = 1;
    var val = el.value;
    if (typeof val === 'string' && val) rec.value = val;
    if (inVp) rec.vp = 1;
    if (r) { rec.x = Math.round(r.left); rec.y = Math.round(r.top); }
    out.push(rec);
  }
  return { url: location.href, title: document.title, total: total, truncated: truncated,
           nonRenderable: nonRenderable, vw: vw, vh: vh, count: out.length,
           sx: (window.scrollX || 0), sy: (window.scrollY || 0), elements: out };
}`;

// ── Server-side snapshot store: ONE entry per tab, and it lives until something REAL ──
// ★ NO CLOCK EXPIRY (2026-10-01, Ali: "we should not have stale snapshots... if no action
// is taken there is nothing to expire and if it does and a page event happens the dif
// should pick them up and update cache. No?").
// He is right and the old TTL was a design error: it made the MODEL of the page vanish
// while the page was still open, so a plain `find` failed with "no live snapshot" on a tab
// that was sitting right there, unchanged. A wall clock is not an invalidation event.
//
// THE LIFECYCLE NOW:
//   born       at browse / first navigation
//   kept       by every action — each action runs the full page-side differ, so the page
//              baseline is updated continuously (the server copy is refreshed on read)
//   dirty      marked by every performed action and by any navigation to a new URL
//   dies       only when the tab closes, or the page legitimately navigates elsewhere
// Nothing expires for being idle. A page left untouched keeps its map indefinitely.
const MAX_TABS = Number(process.env.WEBSENSE_SNAP_MAX_TABS || 8);
const store = new Map(); // tabId -> { at, seq, snap, index, actionsSinceCollect }

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
  store.set(tabId, { at: Date.now(), seq, snap, index, actionsSinceCollect: 0 });
  evictIfNeeded();
  return { seq, index };
}

// An action happened -> the server's copy MAY now differ from the page. It is not thrown
// away (that is what the old TTL effectively did); it is marked so the next READ refreshes
// it. Actions are the only thing that makes it stale, and every action already ran the
// page-side differ, so nothing here is a guess.
export function markSnapshotDirty(tabId) {
  const e = tabId != null && store.get(Number(tabId));
  if (e) e.actionsSinceCollect = (e.actionsSinceCollect || 0) + 1;
}

export function dropSnapshot(tabId) { store.delete(Number(tabId)); }

export function getSnapshot(tabId) {
  const e = store.get(Number(tabId));
  if (!e) return null;
  return e;   // ★ no TTL: age alone never invalidates
}

export function snapshotStats() {
  const out = { tabs: store.size, maxTabs: MAX_TABS, expiry: 'none (invalidated by URL change or tab close)' };
  for (const [k, v] of store) out[k] = { actionsSinceCollect: v.actionsSinceCollect || 0, url: v.snap && v.snap.url, at: v.at };
  return out;
}

// ── The INDEX: what an agent always reads. Small by construction. ──
export function buildIndex(snap) {
  const els = (snap && snap.elements) || [];
  const byTag = {}, byRole = {}, byRegion = {};
  let interactive = 0, inViewport = 0, withName = 0, offViewport = 0;
  for (const e of els) {
    byTag[e.tag] = (byTag[e.tag] || 0) + 1;
    const r = (e.attrs && e.attrs.role) || '(none)';
    byRole[r] = (byRole[r] || 0) + 1;
    if (e.name) withName++;
    if (e.vp) inViewport++;
    else offViewport++;
    if (isInteractiveRec(e)) interactive++;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const byTagAll = top(byTag), byRoleAll = top(byRole);
  return {
    url: snap.url, title: snap.title,
    elements: els.length, domTotal: snap.total, truncated: !!snap.truncated,
    // ★ COMPLETENESS PROOF (2026-10-01, no capping / no filtering). `dropped` must be
    // 0. Before this, a tag filter cut 55 elements and `truncated` still read false, so
    // the index could not tell you the map was incomplete — a silent loss is worse than
    // a declared one.
    dropped: Math.max(0, Number(snap.total || 0) - els.length),
    interactive, inViewport, offViewport, named: withName,
    // FULL lists, no top-N cut — the caller slices what it wants.
    topTags: byTagAll, topRoles: byRoleAll,
    tagCount: byTagAll.length, roleCount: byRoleAll.length,
    // Addressable dimensions — the keys a slice can be taken by.
    addressableBy: ['tag', 'role', 'region', 'vp', 'interactive', 'field', 'focusable', 'attr', 'query'],
  };
}

// ★ INTERACTIVE — DERIVED, NOT DECLARED (2026-10-01, Ali: "any value or names should
// be dynamically parsed by the script").
// This used to be two hardcoded tables — a tag set (a/button/input/select/textarea/
// summary/details/option) and an ARIA widget-role set — applied in buildIndex AND in
// sliceSnapshot. A component-library control (<faceplate-button>, a custom element with
// role="none") matched neither table and was silently classed non-interactive.
// Now it is read off the element's own platform state:
//   focusable  — el.tabIndex >= 0, i.e. the BROWSER's own focusability computation
//   field      — the platform says it is a form control
//   role       — the PAGE asserts a semantic for it (any role it chose to write)
// Nothing in this predicate is a vocabulary we invented.
export function isInteractiveRec(e) {
  if (!e) return false;
  if (e.focusable || e.field) return true;
  return !!(e.attrs && e.attrs.role);
}

// ★ THE BRANCH an element sits in, resolved from the parent pointers in the inventory
// (2026-10-01). This is why no mermaid diagram is needed: "where is this and which branch
// does it belong to" is a bounded walk up the stored records, not a rendered picture —
// so it costs bytes, not tokens, and cannot drift from the inventory it describes.
//
// ★ AND IT SKIPS THE ANONYMOUS (measured 2026-10-01). The first version took the N nearest
// ancestors, and on x.com that produced five identical entries of
// "div:nth-of-type(1) > div:nth-of-type(1) > ..." — which tells a reader NOTHING and cannot
// answer Ali's actual question ("this New is New-tweet, that New is News"). A human reads
// the nearest ancestors that CARRY MEANING and ignores the layout wrappers, so that is what
// this does: it walks up until it has collected `depth` ancestors that say something —
// a role, an accessible name, an id, or any data-* attribute (metadata by definition) — and
// silently steps over bare divs and spans.
// If the page labels NOTHING on the whole path, it returns the nearest ancestors rather
// than an empty chain, so the branch is never blank — it just honestly reports that the
// page gave it nothing to go on.
export function branchChain(snap, rec, depth = 5) {
  const els = (snap && snap.elements) || [];
  const chain = [];
  const anonymous = [];
  let cur = rec, wanted = 0, hops = 0;
  while (cur && hops < 500) {
    const p = cur.p;
    if (p == null || !els[p]) break;
    const pr = els[p];
    hops++;
    const a = pr.attrs || {};
    const role = a.role || '';
    const named = a['aria-label'] || a['aria-labelledby'] || '';
    let hook = '';
    for (const k in a) {
      if (k.length > 5 && k.lastIndexOf('data-', 0) === 0) {
        // ★ THE ATTRIBUTE NAME IS IDENTITY; ITS VALUE IS NOT ALWAYS (measured 2026-10-01).
        // This carried the raw value, and x.com's data-at-shortcutkeys is ~1.5 KB of JSON —
        // one ancestor inflated every find result by that much. A value is included only
        // when it is short enough to BE a name; otherwise the name and the true length are
        // reported, which is exact and costs nothing. (Same rule as the diff's content
        // preview: the long text is in the inventory if it is ever genuinely needed.)
        const v = String(a[k]);
        hook = v.length <= 40 ? (k + '="' + v + '"') : (k + ' [value ' + v.length + ' chars]');
        break;
      }
    }
    const id = (pr.loc && pr.loc.charAt(0) === '#') ? pr.loc.slice(1) : '';
    const entry = {
      i: pr.i, tag: pr.tag, loc: pr.loc, region: pr.region,
      role: role || undefined, name: pr.name || undefined,
      id: id || undefined, hook: hook || undefined,
      ariaLabel: named || undefined,
    };
    const meaningful = !!(role || named || hook || id || (pr.name && pr.name.length < 80));
    if (meaningful) { chain.push(entry); wanted++; }
    else anonymous.push(entry);
    if (wanted >= depth) break;
    cur = pr;
  }
  if (chain.length) return chain;
  return anonymous.slice(0, depth);   // the page labelled nothing — say so honestly
}

// ── SLICE: full-fidelity records for one dimension. ──
export function sliceSnapshot(snap, filter = {}) {
  const els = (snap && snap.elements) || [];
  const q = filter.query ? String(filter.query).toLowerCase() : null;
  // indices:[i,...] — fetch exact records by their inventory index. This is the companion
  // to the DIFF, which names what changed by index precisely so the caller can pull the
  // detail on demand instead of the diff shipping a copy of it.
  const wantIdx = Array.isArray(filter.indices) ? new Set(filter.indices.map(Number)) : null;
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
    if (wantIdx && !wantIdx.has(Number(e.i))) continue;
    if (filter.tag && e.tag !== filter.tag) continue;
    // role now lives with every other attribute (rec.attrs), because the page decides
    // the field names — so accept either a bare rec.role for callers that pass it or
    // the attribute the collector actually recorded.
    const eRole = (e.attrs && e.attrs.role) || e.role || '';
    if (filter.role && eRole !== filter.role) continue;
    if (filter.region && !String(e.region || '').includes(filter.region)) continue;
    if (filter.vp === true && !e.vp) continue;
    if (filter.vp === false && e.vp) continue;
    if (filter.field === true && !e.field) continue;
    if (filter.focusable === true && !e.focusable) continue;
    // ★ DERIVED, NOT DECLARED: was a hardcoded tag set + ARIA widget-role list.
    if (filter.interactive === true && !isInteractiveRec(e)) continue;
    // Filter by ANY attribute the page wrote, e.g. attr:{name:"data-offset", value:"3"}
    // or attr:"data-contents" (name only). No fixed vocabulary is involved.
    if (filter.attr) {
      const aName = typeof filter.attr === 'string' ? filter.attr : filter.attr.name;
      const aVal = typeof filter.attr === 'string' ? undefined : filter.attr.value;
      const has = e.attrs && aName != null
        && Object.prototype.hasOwnProperty.call(e.attrs, aName)
        && (aVal === undefined || e.attrs[aName] === aVal);
      if (!has) continue;
    }
    if (q) {
      const hay = ((e.name || '') + ' ' + (e.loc || '') + ' ' + (e.tag || '') + ' '
        + (e.region || '') + ' ' + (e.attrNames ? e.attrNames.join(' ') : '')).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    matched++;
    if (out.length < limit) out.push(e);
  }
  return { matched, returned: out.length, truncatedByLimit: matched > out.length, total: els.length, elements: out };
}
