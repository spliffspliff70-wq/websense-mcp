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

// ★ ONE BOUND, ONE PLACE (2026-10-01). The grouped DIFF already ships content as a readable
// preview PLUS the true length, and the record stays addressable by index. The outline's
// name printer needs the same kind of bound when it has nothing on the page to measure a
// data-* value against (a single carrier: no family), so it uses this one rather than
// growing a second magic number of its own. Whatever is not printed here is still in the
// inventory — `page_slice{indices:[i]}` returns it verbatim.
export const CONTENT_PREVIEW = 120;

// ★ RENDERING-ONLY ATTRIBUTES, DEFINED ONCE (2026-10-01).
// Two places need the same vocabulary, and they had it twice:
//   - the COLLECTOR's locator builder, because a locator must identify an element, and an SVG
//     drawing attribute is not an identity — it is a paint instruction. Measured on x.com: the
//     auto-DIFF after a type_text was 340 KB, of which 199 KB (59%) was LOCATOR STRINGS, because
//     icons carried locators like path[d="M14.1 2.5c1.103 0 1.991-.001 ..."] at ~1,200 chars each.
//   - the DIFF's presentation filter, where a change to one of these is a repaint, not a
//     structural change (that fix is what stopped a scroll from reporting 89 "structure" changes).
// Kept in ONE array and interpolated into both templates: divergence between two copies of the
// same idea is the defect this codebase has hit most often.
export const PRESENTATION_ATTRS = [
  'class', 'style', 'dir', 'lang',
  'd', 'points', 'transform', 'viewBox',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'fill-opacity', 'stroke-opacity', 'opacity',
  'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'preserveAspectRatio',
];
const PRESENTATION_ATTRS_JSON = JSON.stringify(PRESENTATION_ATTRS);

export const COLLECTOR = `() => {
  var RENDER_ATTRS = ${PRESENTATION_ATTRS_JSON};
  // ★ NO CAP (2026-10-01, Ali: "Agreed no capping no filtering implement and test").
  // This used to be MAX = 20000 with an early break. Removed: the
  // inventory is meant to be LOSSLESS, and a cap on it is exactly the silent cut the
  // snapshot exists to avoid. The cost of removing it is server memory, not
  // correctness — and the index now carries 'dropped' (must be 0) so a future cut
  // cannot hide.
  var out = [];
  // ★ SHADOW ROOTS ARE PART OF THE PAGE (2026-10-01). This was one
  // document.querySelectorAll('*'), which CANNOT see into a shadow root — so on the repo's own
  // shadow fixture the inventory held 22 light-DOM elements and NONE of the marked controls, and
  // the same would be true of any Lit/FAST/Stencil/faceplate site (the fixture names those as the
  // production pattern). Measured absent: shadow-btn, deep-shadow-btn (two roots deep),
  // shadow-input and shadow-file. The fixture's own comment says a plain selector sees an "empty"
  // page while the real controls are present — it was written to catch exactly this.
  // Walk the document and every OPEN shadow root under it, in order. A shadow child has no
  // parentElement of its own, so its logical parent is the HOST element; that is what keeps the
  // branch pointer walking up into the light DOM above it, and what lets a shadow control report
  // the region it lives in.
  var all = [];
  var domParent = new Map();   // element -> logical parent element (the host, for shadow children)
  (function walkShadow(root, host) {
    var list;
    try { list = root.querySelectorAll('*'); } catch (e) { return; }
    for (var li = 0; li < list.length; li++) {
      var le = list[li];
      all.push(le);
      domParent.set(le, le.parentElement || host);
      if (le.shadowRoot) walkShadow(le.shadowRoot, le);
    }
  })(document, null);
  var total = all.length;
  function parentOf(el) {
    var pp = domParent.get(el);
    return pp !== undefined ? pp : (el.parentElement || null);
  }
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
    // ★ THE ID MUST BE ESCAPED, AND AN ESCAPED ID IS A LAST RESORT (found 2026-10-01 by
    // simulating a task on bbc.com/news). React's useId() mints ids like ":R35tbdm:", and
    // '#' + id is NOT valid CSS — a colon starts a pseudo-class — so find and page_slice handed
    // out a locator that no act could ever resolve, and the failure reads as "the control is
    // broken" rather than "the locator is broken".
    // Escaping fixes the CSS, but a backslash does not survive this pipeline end to end: measured
    // by running the page's own querySelector, the error was
    //   "Failed to execute 'querySelector' on 'Document': '#:R35tbdm:' is not a valid selector"
    // — the escapes had been consumed in transport — while getElementById(':R35tbdm:') worked and
    // the element's own data-testid was reachable. So a CLEAN id is still the best locator and is
    // used exactly as before; an id that needs escaping is only used when the element offers
    // nothing better, and a unique attribute wins over it.
    var cleanId = null;
    if (el.id) { try { cleanId = CSS.escape(el.id); } catch (e) { cleanId = null; } }
    if (cleanId && cleanId === el.id) return '#' + cleanId;
    var at = el.attributes;
    if (at && attrCount) {
      for (var i = 0; i < at.length; i++) {
        var an = at[i].name;
        // ★ A RENDERING ATTRIBUTE IS NOT AN IDENTITY (2026-10-01). Measured: 199 KB of a 340 KB
        // diff was locator strings, because SVG icons carry path[d="M14.1 2.5c1.103 0 ..."] at
        // ~1,200 characters each. It is not stable, not something anyone acts on, and it pushed
        // out everything that matters.
        if (an === 'data-websense-ref' || RENDER_ATTRS.indexOf(an) >= 0) continue;
        if (attrCount[an + '=' + at[i].value] === 1) {
          // ★ QUOTE-ESCAPE AN ATTRIBUTE VALUE, DO NOT CSS.escape IT (2026-10-01). Measured on
          // bbc.com/news: CSS.escape is for IDENTIFIERS, and inside a quoted attribute value it
          // over-escapes — for an id of ":R35tbdm:" it emitted input[id=":R35tbdm:"] with
          // backslashes added, and a backslash does not survive this pipeline end to end, so the
          // locator silently stopped resolving. The quoted form needs only a quote and a
          // backslash escaped.
          // ★ AND THE BACKSLASH IS BUILT, NOT WRITTEN, because this function is a TEMPLATE
          // LITERAL shipped to the page: a literal \\ in here collapses to \ when the string is
          // evaluated on the server and the page receives a syntactically broken regex (caught
          // by the collector-compiles test). String.fromCharCode(92) sidesteps the escaping
          // entirely. Verified live: input[id=":R35tbdm:"] resolves and reaches the
          // disabled-target guard, where every backslash-bearing form does not.
          var BS = String.fromCharCode(92);
          var vv = String(at[i].value).split(BS).join(BS + BS).split('"').join(BS + '"');
          try { return el.tagName.toLowerCase() + '[' + an + '="' + vv + '"]'; } catch (e) {}
        }
      }
    }
    if (cleanId) return '#' + cleanId;      // escaped id, only now — still beats a 5-deep path
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'html') break;
      var p = node.parentNode, idx = 1, sib = node;
      while (sib && sib.previousElementSibling) { sib = sib.previousElementSibling; idx++; }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      if (node.id) {
        try { parts[0] = '#' + CSS.escape(node.id); } catch (e) { parts[0] = '#' + node.id; }
        break;
      }
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
    // a shadow child has no parentElement — start from its HOST, so a control inside a shadow root
    // still reports the region it lives in (2026-10-01)
    var node = parentOf(el), hops = 0;
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
    var pn = parentOf(el), hops = 0;
    while (pn && hops < 200 && !idxOf.has(pn)) { pn = parentOf(pn); hops++; }
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
// ★ THE PAGE AS A MODEL SHOULD SEE IT: the containers the PAGE ITSELF named, nested, with NO
// counts (2026-10-01, Ali: "center feed is 1 element for me ... If there is 1 central feed why
// does it need to show 1617?").
//
// WHY THIS AND NOT A DOM TREE. A DOM tree of x.com is 2,535 nodes. The page's OWN names for
// its regions are ~10-20 things — which is the model a human holds, and it is already in the
// inventory. The names are the page's words (role / aria-label / a data-* hook / id); we
// invent nothing. The subtree COUNT is bookkeeping for SELECTION (deciding which named things
// are regions) and must never be printed — a human does not count the feed's elements.
//
// A REGION = a named element that CONTAINS another named element. That one fact separates a
// region (primaryColumn, which holds "Home timeline") from a control (a named link, which
// holds nothing named) — no vocabulary of ours, and no size threshold.
//
// The two collapses are the same two facts proven on Hacker News, and they are properties of
// the tree, not thresholds: a single-child chain carries no information, and identical
// siblings are repetition.
export function regionTree(snap, opts = {}) {
  const els = (snap && snap.elements) || [];
  const maxDepth = opts.depth || Infinity;   // no cap — a depth limit is a truncation

  // ★ WHOSE WORDS, DECIDED FROM THE PAGE (2026-10-01). Measured across the sample: pages that
  // name their containers with ids/roles/hooks need nothing from their classes — x.com's outline
  // was 242 lines of which 187 were CSS-in-JS hashes (.css-g5y9jx, .css-146c3p1), and MDN's went
  // from 7 useful lines to ~50. But a page that names its layout ONLY with classes has no map at
  // all without them (books.toscrape: div.page > article.product_pod, one line of nothing).
  //
  // So the choice is per-page and derived from the page: run with its structural words first,
  // and consult classes only when that produced no structure whatsoever — not even one container
  // holding another. This is NOT a filter: the classes are in the inventory and in page_slice
  // either way, and nothing is dropped from the record. It decides what the MAP is made of.
  if (opts.className === undefined && opts.classFallback !== false) {
    const plain = regionTree(snap, { ...opts, className: false, classFallback: false });
    if (plain.regions > 1) return plain;
    return regionTree(snap, { ...opts, className: true, classFallback: false });
  }

  // ── ADMISSIBILITY: a name must identify a PLACE ───────────────────────────────────
  // ★ MEASURED 2026-10-01. The page's own words are the only vocabulary we use — but a
  // page REUSES words, and the same word in many different places names a component,
  // not a place. BBC News puts data-testid="anchor-inner-wrapper" on 157 elements that
  // sit under 113 DIFFERENT parents, "...=internal-link" on 71/71, "...=external-anchor"
  // on 62/62; those three plus their card-part siblings accounted for most of a
  // 117-line outline in which 941 of 1,424 elements counted as "named".
  //
  // A genuine repeated region sits under ONE parent — its grid or list. Measured on the
  // same page: data-testid="contentlink-li" 16 carriers / 1 parent,
  // "mainNavigationItemStyled" 13 / 1. So the cut is structural, not a size threshold:
  //   carriers share a parent  → one repeated run, or a single element → a place.
  //   carriers spread across many parents → a component marker → names nothing.
  //
  // The SAME test is what makes `class` usable as a LAST-RESORT name. Utility and
  // framework classes are spread by construction (Tailwind "p-4 flex", styled-components
  // "sc-bdVaJa iHZvIS"), so they fail the test and never reach the outline; a class that
  // names a component tends to be carried by one repeated run.
  //
  // WebSense's OWN bookkeeping is never the page's words: our attributes are on the page
  // because we put them there, and one of them ("data-ws-dialogs=[]") surfaced as the
  // top region on a page that named nothing else.
  const OWN_ATTR = (k) => k === 'data-websense-ref' || k === 'data-ws' || k.lastIndexOf('data-ws-', 0) === 0;
  // ★ NO FILTERING BY DEFAULT (Ali, 2026-10-01): "there shall be no hard coding, filtering,
  // truncating, grouping limiting rules ... everything must be done dynamically with the full
  // data available from the page". Every word the page uses is KEPT. The admissibility
  // machinery below still exists and is still measurable (tools/regions-probe.mjs --spread N),
  // but it is OFF unless a caller explicitly asks for it — dropping the page's own names is a
  // cut, not an organisation, and it was the wrong way to make the outline shorter.
  const spread = opts.spread == null ? Infinity : opts.spread;

  const carriers = new Map();                                // signature -> Set(position shape)
  const slots = new Map();                                   // kind|key|shape -> Set(value present there)
  const hookMax = new Map();                                 // data-* attr -> longest value on the page
  const hookN = new Map();                                   // data-* attr -> how many elements carry it
  const sigOf = (kind, k, v) => kind + '|' + k + '|' + v;
  // ★ HOW THE ADMISSIBILITY TEST IS MEASURED (2026-10-01, third iteration).
  // "Several distinct parents" was the wrong measure, and so was "look N levels up": both
  // depend on the depth at which a repetition happens to sit. books.toscrape proved it —
  // the 20 article.product_pod sit under 20 different <li>, one <ol>; their inner
  // div.image_container sits under 20 different <article>. A run is real at BOTH levels,
  // but each level has a different parent count, so a fixed span admits one and rejects
  // the other and the whole grid collapses.
  //
  // The measure that does not depend on depth is the POSITION SHAPE: the tag-path from
  // the document root. A name is a place-name when its carriers all sit at structurally
  // IDENTICAL positions — the page is using one word for one kind of place, however
  // deeply nested. bbc.com's data-testid="anchor-inner-wrapper" covers 157 elements
  // sitting at wildly different paths (header, nav, cards, footer) → not a place.
  // books.toscrape's ".product_pod" covers 20 elements all at ol>li>article → a place.
  //
  // Pure tree fact, no threshold, no magic depth.
  const pathCache = new Array(els.length);
  const pathOf = (i) => {
    if (pathCache[i] !== undefined) return pathCache[i];
    const stack = [];
    let j = i;
    while (j != null && els[j] && pathCache[j] === undefined) { stack.push(j); j = els[j].p; }
    let base = (j != null && els[j] && pathCache[j] !== undefined) ? pathCache[j] : '';
    while (stack.length) {
      const k = stack.pop();
      base = base ? base + '>' + els[k].tag : els[k].tag;
      pathCache[k] = base;
    }
    return pathCache[i];
  };
  const note = (i, kind, k, v) => {
    const sh = pathOf(i);
    const sig = sigOf(kind, k, v);
    let s = carriers.get(sig);
    if (!s) { s = new Set(); carriers.set(sig, s); }
    s.add(sh);
    const sl = kind + '|' + k + '|' + sh;
    let t = slots.get(sl);
    if (!t) { t = { n: 0, vals: new Set() }; slots.set(sl, t); }
    t.n++;
    t.vals.add(v);
  };
  const wantClass = !!opts.className;   // decided per-page above, not fixed here
  // ★ THE COLLECTION LOOP IS NOT PART OF THE FILTER (2026-10-01). It used to run only when
  // the spread filter was on (`Number.isFinite(spread) ? els.length : 0`), so switching the
  // filter off meant carriers/slots were EMPTY — and every test built on them, including the
  // per-instance value test, silently answered "no". Collecting what the page wrote is not a
  // cut. Only REJECTING on it is, and that stays opt-in.
  for (let i = 0; i < els.length; i++) {
    const e = els[i], a = e.attrs;
    if (!a) continue;
    for (const k in a) {
      const v = a[k];
      if (v == null || v === '') continue;
      if (k === 'role') {
        note(i, 'r', 'role', v);
        if (a['aria-label']) note(i, 'r', 'role+label', v + '\u0000' + a['aria-label']);
      } else if (k === 'aria-label') {
        note(i, 'a', 'aria-label', v);
      } else if (k === 'id') {
        note(i, 'i', 'id', v);
      } else if (k.lastIndexOf('data-', 0) === 0) {
        if (k.length > 5 && !OWN_ATTR(k)) {
          note(i, 'h', k, v);
          // ★ THE BOUND FOR A HOOK VALUE COMES FROM THE PAGE, NOT FROM A CONSTANT (2026-10-01).
          // A data-* attribute used as a LABEL carries one of a family of comparable tokens
          // (data-testid: primaryColumn beside sidebarColumn beside cellInnerDiv). An attribute
          // that appears on the whole page with ONE value is either a flag or a blob, and a
          // blob is a payload, not a name. So the cap is the longest value the SAME attribute
          // takes on the page — and only when the attribute has no family at all (a single
          // carrier, nothing to compare against) does it fall back to CONTENT_PREVIEW, the one
          // bound the grouped DIFF already uses to ship content as a preview plus its exact
          // length. Same contract, same number, one place.
          const L = String(v).length;
          if (!((hookMax.get(k) || 0) >= L)) hookMax.set(k, L);
          hookN.set(k, (hookN.get(k) || 0) + 1);
        }
      } else if (wantClass && k === 'class') {
        for (const tok of String(v).split(/\s+/)) if (tok) note(i, 'c', 'class', tok);
      }
    }
  }
  // ★ THE MIRROR OF THE SPREAD TEST (2026-10-01, found on the live x.com feed).
  // The spread test asks "does this word appear in many DIFFERENT places?" — that catches a
  // component marker. This one asks the opposite question about the SLOT: "does this place
  // get many DIFFERENT words?" — and that catches a PER-INSTANCE value.
  //
  // Measured on the x.com feed: every tweet carries a React-generated id
  // (#id__kaz8g4cuhrn, #id__nhffana1zz, #id__uyjanmr0dmf …) and a role="group" whose
  // accessible name is its own engagement count ("1 reply, 2 likes, 2 bookmarks, 65
  // views"). Each value is unique, so the spread test passes it happily — but neither tells
  // you WHERE anything is, and together they buried the timeline under ~40 lines of
  // per-tweet noise.
  //
  // The test is NOT "does this slot hold several values" — books.toscrape has three <p> in
  // every product card (price_color, instock availability, star-rating) and they are
  // perfectly good names for three different elements. The test is whether the value is
  // DIFFERENT ON EVERY OCCURRENCE, which is what an instance identifier does.
  //
  // And it applies to `id` ONLY. An id is unique PER ELEMENT by the HTML spec, so a page
  // showing 9 distinct ids at one position is minting an identifier per instance — that is
  // React's #id__kaz8g4cuhrn. Author-chosen words are the opposite: x.com's primaryColumn
  // and sidebarColumn are SIBLINGS at one position with two different data-testids, and an
  // earlier version of this test deleted both of them.
  // ★ TWO TESTS LIVED IN ONE FUNCTION AND THEY ARE NOT THE SAME TEST (split 2026-10-01).
  // They shared one guard, so switching the spread filter off silently switched this off
  // too — which is why x.com's engagement counts and 16 React-minted ids (#id__nhffana1zz)
  // came BACK into the outline after the no-filtering change.
  //
  //   spreadReject  — "the page uses this word in many DIFFERENT places" ⇒ a component
  //                   marker. DROPS the word. Opt-in only (Ali: no filtering).
  //   perInstance   — "this slot holds a DIFFERENT value on every occurrence" ⇒ the value
  //                   is DATA, not a name. RE-TYPES it; never drops it. Always on, because
  //                   re-typing is not a cut — and because a structure map must not carry
  //                   the page's content. That is the whole point of the outline.
  const spreadReject = (kind, k, v) => {
    if (!Number.isFinite(spread)) return false;
    const s = carriers.get(sigOf(kind, k, v));
    return !!(s && s.size > spread);
  };
  const perInstance = (kind, k, v, shape) => {
    const t = slots.get(kind + '|' + k + '|' + shape);
    return !!t && t.n > 1 && t.vals.size === t.n;                // a fresh value every time
  };
  // ★ A VALUE IS RE-TYPED, NEVER RENAMED, AND NEVER INVENTED (2026-10-01).
  // The first cut of this tried to DERIVE a name from the invariant part of the occurrences
  // ("42 Replies. Reply" / "1 Reply. Reply" ⇒ "Reply. Reply"). It read well on the buttons and
  // was WRONG everywhere else: x.com's data-testid=primaryColumn and data-testid=sidebarColumn
  // share the suffix "Column", so the feed and the rail were reported as ONE place called
  // "Column", and #layers' GrokDrawer/chat-drawer-root collapsed to "r". A name that the page
  // did not write is a name I invented. So a datum is reported AS a datum: its kind, and the
  // true size of the text it holds. The text itself stays in the inventory, one
  // page_slice{indices:[i]} away — the same contract the DIFF already uses for content.
  const datum = (v) => '\u27EA' + String(v).length + ' chars\u27EB';   // ⟪N chars⟫
  const labelName = (prefix, v, kind, k, shape) => {
    const src = kind === 'a' ? 'aria' : 'role';
    if (spreadReject(kind, k, v)) return prefix ? { n: prefix, src } : null;
    return { n: prefix ? prefix + ' "' + v + '"' : '"' + v + '"', src };
  };

  // ★ WHAT KIND OF WORD IS IT? A `role` or `aria-label` is a name the page wrote FOR A
  // READER ("navigation \"Footer navigation\""). A `data-*` hook is written for the
  // page's own code, and it lands on layout wrappers a human never perceives. That
  // distinction is what the pass-through test below uses.
  const nameParts = (e, i) => {
    const a = e.attrs;
    if (!a) return null;
    const sh = pathOf(i);
    if (a.role) {
      if (a['aria-label']) return labelName(a.role, a['aria-label'], 'r', 'role+label', sh);
      return { n: a.role, src: 'role' };
    }
    if (a['aria-label']) {
      const viaLabel = labelName(null, a['aria-label'], 'a', 'aria-label', sh);
      if (viaLabel) return viaLabel;
    }
    if (e.attrNames) {
      for (const k of e.attrNames) {
        if (k.length > 5 && k.lastIndexOf('data-', 0) === 0 && !OWN_ATTR(k)) {
          // ★ AN ATTRIBUTE NAME IS IDENTITY; ITS VALUE IS SOMETIMES A PAYLOAD (2026-10-01).
          // Measured on x.com: data-at-shortcutkeys holds the ENTIRE keyboard-shortcut map
          // (~1.5 KB) and it landed in the outline. A short value IS the identity
          // (data-testid=primaryColumn); a long one is reported by name only.
          //
          // ★ THE BOUND IS NOW DERIVED, NOT A LENGTH CONSTANT (2026-10-01). A hook value is
          // written for the page's own code, so it is meant to be a TOKEN; whitespace in it
          // means it is prose that happens to live in an attribute. That is a property of the
          // value, not a magic 40. (The old `v.length <= 40` was the same kind of constant as
          // the LABEL_MAX that once demoted a carried-over post to "page content".)
          const v = a[k];
          if (v == null || v === '') continue;
          if (spreadReject('h', k, v)) continue;             // component marker, not a place
          const cap = (hookN.get(k) || 0) > 1 ? hookMax.get(k) : CONTENT_PREVIEW;
          if (/\s/.test(v) || String(v).length > cap) return { n: k, src: 'hook', value: true };
          return { n: k + '=' + v, src: 'hook' };
        }
      }
    }
    if (a.id && !perInstance('i', 'id', a.id, sh) && !spreadReject('i', 'id', a.id)) return { n: '#' + a.id, src: 'id' };
    if (wantClass && a.class) {
      // last resort — the page named this container only with a class, which some pages
      // do for their entire layout (books.toscrape: div.page > article.product_pod).
      for (const tok of String(a.class).split(/\s+/)) {
        if (tok && !spreadReject('c', 'class', tok) && !perInstance('c', 'class', tok, sh)) return { n: '.' + tok, src: 'class' };
      }
    }
    return null;
  };
  const baseName = (e, i) => { const p = nameParts(e, i); return p ? p.n : ''; };

  const kids = [];
  for (let i = 0; i < els.length; i++) kids.push([]);
  for (let i = 0; i < els.length; i++) {
    const p = els[i] ? els[i].p : null;
    if (p != null && kids[p]) kids[p].push(i);
  }

  // ★ A LABEL THAT SUMMARISES ITS OWN CHILDREN IS A DATUM, NOT A NAME (2026-10-01).
  // This is the test that actually separates the two kinds of aria-label on a live page, and
  // it was found by MEASURING which labels I had wrongly demoted. The first attempt used "the
  // slot holds a different value on every occurrence" — and that is FALSE for a real page:
  // x.com's aside "Subscribe to Premium" (#2002) and aside "Who to follow" (#2530) sit at the
  // SAME tag path (…>div>aside) under different parents, so two genuinely different places
  // looked like one per-instance value. Same for button "Previous"/"Next" and "Grok"/"Chat".
  // Author-chosen words must never be demoted because two of them share a position.
  //
  // The fact that does hold: an element whose label is a SUMMARY of what it contains is not
  // naming itself, it is reporting its contents. The tweet's engagement group carries
  // "2 replies, 1 repost, 25 likes, 6 bookmarks, 164617 views" and sits directly above the
  // buttons that each say one of those things. So the label is compared against the names of
  // the element's own children: if two or more distinct words of the label are words of the
  // children, the label is derived from them, and it is content.
  //
  // Words are matched across inflection (reply/replies, view/views) because English inflects
  // and the page writes both forms — that is a property of the words, not a length constant.
  const stem = (x) => String(x).toLowerCase().replace(/(ies|es|s)$/, '').replace(/(ing|ed)$/, '');
  const sameWord = (a, b) => {
    const x = stem(a), y = stem(b);
    if (!x || !y) return false;
    const s = x.length <= y.length ? x : y;
    const l = x.length <= y.length ? y : x;
    return s.length >= 3 && l.indexOf(s) === 0;
  };
  const words = (s) => String(s).toLowerCase().match(/[a-z]{3,}/g) || [];
  const restates = (i, label) => {
    const lw = words(label);
    if (!lw.length) return false;
    let hits = 0;
    const stack = kids[i].slice();
    while (stack.length) {
      const c = stack.pop();
      const cn = baseName(els[c], c);
      if (cn) {
        if (words(cn).some((x) => lw.some((y) => sameWord(x, y))) && ++hits > 1) return true;
        continue;                 // a named descendant is a place — its insides are its own
      }
      for (const g of kids[c]) stack.push(g);
    }
    return false;
  };
  const nameOf = (e, i) => {
    const p = nameParts(e, i);
    if (!p) return '';
    const label = e.attrs && e.attrs['aria-label'];
    if ((p.src === 'role' || p.src === 'aria') && label && restates(i, label)) {
      const pre = p.src === 'role' ? e.attrs.role : '';
      return (pre ? pre + ' ' : '') + datum(label);
    }
    return p.n;
  };

  const named = els.map((e, i) => !!nameParts(e, i));
  // ★ A PASS-THROUGH IS NOT A PLACE (2026-10-01, measured).
  // An element whose whole content is ONE child holds nothing of its own — a human sees the
  // same box, one level in. That is the anatomy of the bbc.com flood: data-testid=
  // "anchor-inner-wrapper" wraps a single <a> and appears 157 times, and with it the page
  // ran to 116 lines with 941 of 1,424 elements counted as "named".
  //
  // BUT "one child" alone was too blunt, and the live x.com feed proved it: primaryColumn
  // holds exactly ONE child div — which itself holds the composer, the toolbar and the
  // timeline. Testing the immediate child count deleted the page's own name for the feed
  // (and sidebarColumn for the rail). The honest shape of the rule is about the whole
  // SUBTREE: a single child is only a pass-through when nothing below it splits. A wrapper
  // around a link stays a wrapper; a column that opens into a feed does not.
  //
  // role / aria-label / id are exempt, because those are words the page wrote for a reader
  // rather than test hooks on a wrapper — `nav :: navigation "Footer navigation"` holds one
  // <ul> and is still a place worth naming.
  //
  // The name itself is NOT thrown away: it stays in the inventory, in `find`, and in the
  // collapsed chain line. It simply does not CREATE a region.
  const hasSplit = new Array(els.length).fill(false);
  for (let i = els.length - 1; i >= 0; i--) {
    if (kids[i].length > 1) { hasSplit[i] = true; continue; }
    for (const c of kids[i]) if (hasSplit[c]) { hasSplit[i] = true; break; }
  }
  const passthrough = opts.passthrough === true;   // opt-in only — OFF by default
  const place = els.map((e, i) => {
    const p = nameParts(e, i);
    if (!p) return false;
    if (!passthrough) return true;
    if (p.src === 'role' || p.src === 'aria' || p.src === 'id') return true;   // deliberate
    return hasSplit[i];        // a hook/class must open into more than one thing, anywhere below
  });
  // hasNamedDesc[i] — does i contain a PLACE anywhere below it?
  const hasNamedDesc = new Array(els.length).fill(false);
  for (let i = els.length - 1; i >= 0; i--) {
    for (const c of kids[i]) {
      if (place[c] || hasNamedDesc[c]) { hasNamedDesc[i] = true; break; }
    }
  }
  const isRegion = els.map((e, i) => place[i] && hasNamedDesc[i]);
  const regionChild = [];   // region children of each region
  for (let i = 0; i < els.length; i++) regionChild.push([]);
  for (let i = 0; i < els.length; i++) {
    if (!isRegion[i]) continue;
    let p = els[i].p, hops = 0;
    while (p != null && hops < 400) { if (isRegion[p]) { regionChild[p].push(i); break; } p = els[p].p; hops++; }
  }

  // shape of a region for the repetition test — see the note below.
  // ★ A REPEAT IS THE SAME SHAPE AGAIN — compared as the WHOLE SUBTREE's tag structure,
  // recursively, and NOT by name. Both halves of that were forced by live pages (2026-10-01):
  //   - old.reddit's 25 posts are div[data-fullname=t3_…]; the VALUE differs per post, so any
  //     name-sensitive comparison refuses to collapse the listing (~175 lines of posts);
  //   - x.com's primaryColumn beside sidebarColumn have different names AND different subtrees,
  //     so a structure-only comparison correctly refuses to merge them — an earlier version
  //     merged them on their name KIND and printed one with a count, HIDING the other entirely.
  // Where the collapsed members carry different names the line says so, rather than implying
  // they are identical.
  // ★ THE SHAPE OF A REGION, USED ONLY AS PART OF ITS IDENTITY (2026-10-01).
  // tag + which name-kind it carries + the tags of its immediate region children. Back, after a
  // day of trying to do without it: keying a run on the NAME alone merged books.toscrape's two
  // div.page_inner boxes, and adding the parent's identity or its tag then broke bbc/stripe,
  // where a real list wraps every item in its own single-child element (bbc's level2-navigation
  // is ELEVEN li, each holding one anchor-inner-wrapper). Measured across six pages, name+shape
  // is the identity rule that holds everywhere; what was actually broken was the GROUPING MODEL
  // below it (a contiguous-period scan), not the identity. See the run loop in emit.
  const shapeCache = new Array(els.length);
  const shapeOf = (i) => {
    if (shapeCache[i] !== undefined) return shapeCache[i];
    const a = els[i].attrs || {};
    const kinds = [];
    if (a.role) kinds.push('role');
    else if (a['aria-label']) kinds.push('aria');
    else if (a.id) kinds.push('id');
    else if (a.class) kinds.push('class');
    else kinds.push('data');
    const s = els[i].tag + '|' + kinds.join(',') + '|' + regionChild[i].map((c) => els[c].tag).join(',');
    shapeCache[i] = s;
    return s;
  };

  const lines = [];
  const seenRep = [];
  const emit = (i, d) => {
    if (d > maxDepth) return;
    const ind = '  '.repeat(d);
    // single-child chain — walk it into the child, one line, no information lost
    // Collapse a run of named regions that nest one-to-one, but KEEP EVERY NAME: the page's
    // hook (primaryColumn) and its label ("Home timeline") are different facts about the same
    // place, and dropping either loses information. This is a collapse of the LINE, not of the
    // names.
    let cur = i, chain = els[i].tag, names = [nameOf(els[i], i)];
    while (regionChild[cur].length === 1) {
      const only = regionChild[cur][0];
      if (regionChild[only].length === 0) break;   // keep a leaf-ish region visible
      chain += ' > ' + els[only].tag;
      names.push(nameOf(els[only], only));
      cur = only;
    }
    lines.push(ind + chain + ' :: ' + names.filter(Boolean).join('  /  '));
    // ★ A REPEAT MUST MATCH BY NAME AT THE SAME PHASE, not merely by shape. The shape says the
    // subtree looks the same; the name says it IS the same thing. Merging on shape alone hid
    // x.com's rail: primaryColumn and sidebarColumn are two DIFFERENT places that happen to have
    // one region child each, so they matched, and the collapse printed the feed with a count and
    // never showed the rail at all. The old `>= 3` rule masked this by refusing to collapse a
    // pair — but that number was load-bearing for the wrong reason, and it also blocked real
    // runs. Comparing phase-aligned names fixes the cause: identical names still collapse at any
    // length, an alternating run still collapses (each phase keeps its own name), and two
    // differently-named places never merge.
    const rc = regionChild[cur];
    // ★ THE GROUPING MODEL WAS THE REAL DEFECT, NOT THE IDENTITY RULE (2026-10-01).
    //
    // This looked for the longest CONTIGUOUS periodic run (period p: rest[j] === rest[j-p]) and
    // emitted one template per phase. A page whose children interleave does not have a periodic
    // run, so the scan fragmented: on x.com/home the timeline's children came out as
    //   [A, B, A, A, A, A, A]        (A = six posts, B = one post behind an extra wrapper)
    // the best it could find was period 3 spanning 4, which made it print THREE full post
    // templates to describe five items, then look again from index 4. 137 lines / 7,013 B for a
    // feed in which every child is data-testid=cellInnerDiv.
    //
    // Four rules were tried against six real pages before this one (all recorded in git):
    //   (a) name + shape, contiguous scan   -> books ok, bbc ok, x.com 137 lines. Fragmentation.
    //   (b) name alone                      -> merged books' two div.page_inner boxes. 17->3 lines.
    //   (c) name + same DOM parent          -> fixed books, broke bbc/stripe (193 vs 149 lines)
    //                                          because bbc wraps each nav item in its own <li>.
    //   (d) name + parent-tag shape         -> books ok, x.com 61 lines, bbc 166 (worse), stripe 83.
    // (e) <- SHIPPED. Keep the identity rule that held on every page (name + shape) and GROUP BY
    // IT across the whole child list instead of demanding contiguity. A feed does not need to be
    // periodic to be a feed. Order is preserved by insertion: first appearance decides position.
    // A group's members share the key, so they share the name by construction — the collapsed
    // name list that used to be needed is now vacuous, and nothing can be hidden by a collapse.
    const groups = new Map();
    for (const c of rc) {
      const k = shapeOf(c) + '\u0000' + nameOf(els[c], c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    for (const list of groups.values()) {
      emit(list[0], d + 1);
      if (list.length > 1) {
        lines.push('  '.repeat(d + 1) + '^ the block above REPEATS x' + list.length);
        seenRep.push(list.length);
      }
    }
  };

  // roots = regions with no region ancestor
  const roots = [];
  for (let i = 0; i < els.length; i++) {
    if (!isRegion[i]) continue;
    let p = els[i].p, hops = 0, hasParentRegion = false;
    while (p != null && hops < 400) { if (isRegion[p]) { hasParentRegion = true; break; } p = els[p].p; hops++; }
    if (!hasParentRegion) roots.push(i);
  }
  for (const r of roots) emit(r, 0);

  if (opts.debug) {
    return {
      regions: lines.filter((l) => l.indexOf('REPEATS') < 0).length,
      named: named.filter(Boolean).length,
      outline: lines.join('\n'),
      debug: els.map((e, i) => {
        const p = nameParts(e, i);
        return { i, tag: e.tag, kids: kids[i].length, name: p ? p.n : '', src: p ? p.src : '', place: place[i], region: isRegion[i] };
      }),
    };
  }

  return {
    regions: lines.filter((l) => l.indexOf('REPEATS') < 0).length,
    named: named.filter(Boolean).length,
    outline: lines.join('\n'),
  };
}

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
