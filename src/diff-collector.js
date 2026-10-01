import { COLLECTOR } from './snapshot.js';

// ── THE AUTO-DIFF (2026-10-01) ───────────────────────────────────────────────
// Run AFTER EVERY MUTATING OP, page-side, against a baseline the PAGE holds. It returns
// ONLY the grouped difference — so the payload is the CHANGE, never the page.
//
// THE BASELINE FOR ANY PAGE IS THE FIRST COLLECTION AFTER IT LOADED (Ali, 2026-10-01:
// "the baseline for any page is initial navigation to that page"). It lives in the page,
// so navigating clears it for free: a new document genuinely gets a new baseline and a
// stale baseline can never be diffed against a page it never saw.
//
// THREE GROUPS — and the distinction is the entire point:
//   structure — the page's SHAPE changed: elements added/removed, or tag/role/name/attrs
//               changed. This is page truth; the page really changed.
//   content   — the SAME element's value/text changed and its shape did not. The page
//               answered you (a field took your text, a counter incremented).
//   viewport  — the ONLY differences are vp/x/y. This is scroll/layout churn, NOT a
//               mutation. It used to be reported as one: the old diff compared the
//               interactive+in-viewport SUBSET, which changes as you scroll, and measured
//               a scroll as changedRatio 1.038 with "12 added / 40 removed".
//
// Deliberately uncapped: every changed element is reported, and the counts tell the
// caller the size before it decides to read further.
export const DIFF_COLLECTOR = `() => {
  var collect = ${COLLECTOR};
  var KEY = '__wsBaseline_v1';
  var now = collect();
  var prev = window[KEY];

  // ★ FINGERPRINT MUST BE IDENTITY, NOT CONTEXT (found by measuring the diff live,
  // 2026-10-01). The first version included region, and region is CONTEXTUAL — it is
  // derived from whichever ancestor the page has labelled, so it flips as the page
  // re-renders (observed: "role:button:Grok" -> "role:button:Chat" on the same node).
  // That reported ~1,049 phantom changes on a 1,049-element page and produced a 103 KB
  // diff for a NO-OP. Identity is the tag plus the element's OWN attributes. Region,
  // position and viewport state are reported as CONTEXT on a change, never as the
  // reason for one.
  // ★ WHAT IS IDENTITY, AND WHAT IS PAINT? (2026-10-01)
  // A change is STRUCTURAL only if it affects what the element IS, DOES or HOLDS. A change
  // to how it is PAINTED, or to the framework's own bookkeeping, is VISUAL. Measured: a
  // 972px scroll on x.com produced 609 structure.changed entries whose differences were
  // class/style, class/data-testid/style, class/dir/style — 98,441 chars of repaint and
  // React churn masquerading as page structure.
  // NOT a site vocabulary: data-* attributes are metadata BY DEFINITION in HTML, and
  // class/style/dir only ever describe rendering. Everything else — role, id, disabled,
  // checked, value, aria-*, href, placeholder — is identity, state or semantics, and a
  // change to any of those IS structural.
  function isPresentationAttr(n) {
    if (n === 'class' || n === 'style' || n === 'dir' || n === 'lang') return true;
    if (n.length > 5 && n.lastIndexOf('data-', 0) === 0) return true;
    // ★ SVG GEOMETRY IS RENDERING TOO (found live 2026-10-01). A scroll on x.com reported
    // mutated:true with 89 "structure" changes, and the bulk of them were icons redrawing
    // their path data (the SVG d attribute) plus points/transform on other shapes. Nothing
    // about the page's STRUCTURE had changed; a spinner span did what it was told. These are
    // the SVG spec's drawing attributes, not a site vocabulary, and a change to one is a
    // repaint in exactly the way a style change is.
    // (NOTE: no backticks anywhere in this file — it is a template literal. Wrap names in
    // double quotes, never backticks, or the module will not parse at all.)
    if (n === 'd' || n === 'points' || n === 'transform' || n === 'viewBox'
      || n === 'fill' || n === 'stroke' || n === 'stroke-width' || n === 'stroke-linecap'
      || n === 'stroke-linejoin' || n === 'stroke-dasharray' || n === 'stroke-dashoffset'
      || n === 'fill-opacity' || n === 'stroke-opacity' || n === 'opacity'
      || n === 'cx' || n === 'cy' || n === 'r' || n === 'rx' || n === 'ry'
      || n === 'x1' || n === 'y1' || n === 'x2' || n === 'y2'
      || n === 'offset' || n === 'stop-color' || n === 'stop-opacity'
      || n === 'gradientUnits' || n === 'preserveAspectRatio') return true;
    return false;
  }

  function fingerprint(r) {
    var a = r.attrs || {};
    var parts = [];
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      if (isPresentationAttr(k)) continue;
      parts.push(k + '=' + a[k]);
    }
    parts.sort();
    return (r.tag || '') + '|' + parts.join('&');
  }
  function geom(r) { return (r.x == null ? '' : r.x) + ',' + (r.y == null ? '' : r.y) + ',' + (r.vp ? 1 : 0); }
  // ★ THE DIFF IS AN INDEX OF THE CHANGE, NOT A COPY OF THE PAGE (measured 2026-10-01).
  // The first version shipped each changed element's FULL attrs and its name. On a page
  // that hydrated 138 -> 2,401 elements that produced a 1,285,618-character DIFF — worse
  // than the 160 KB SAG it exists to replace. The cause is duplication, not size: every
  // byte of those attrs is ALREADY in the stored inventory, and name on a style/script
  // tag is that tag's entire source text.
  // So the diff names WHAT changed and where, and the caller slices the inventory for
  // detail — the same principle as the index/slice split, applied to time.
  function ident(r) {
    var o = { i: r.i, tag: r.tag, loc: r.loc };
    var role = (r.attrs && r.attrs.role) || '';
    if (role) o.role = role;
    return o;
  }
  function fieldsDiffer(a, b) {
    var out = [], k;
    var aa = a.attrs || {}, bb = b.attrs || {};
    for (k in aa) if (Object.prototype.hasOwnProperty.call(aa, k) && aa[k] !== bb[k]) out.push(k);
    for (k in bb) if (Object.prototype.hasOwnProperty.call(bb, k) && aa[k] !== bb[k]) {
      if (out.indexOf(k) === -1) out.push(k);
    }
    if ((a.name || '') !== (b.name || '')) out.push('name');
    return out;
  }

  var out = { url: now.url, title: now.title, docElements: now.count,
              baselineAt: prev ? prev.at : null, at: now.count, seq: (prev ? (prev.seq + 1) : 0) };

  if (!prev) {
    window[KEY] = { url: now.url, at: now.count, seq: 0, els: now.elements, byLoc: null, sx: now.sx, sy: now.sy };
    out.first = true;
    out.note = 'baseline seeded from this navigation — the NEXT op on this page is diffable';
    return out;
  }

  // Same-document guard: if the URL changed, the baseline belongs to another page.
  if (prev.url !== now.url) {
    window[KEY] = { url: now.url, at: now.count, seq: 0, els: now.elements, byLoc: null, sx: now.sx, sy: now.sy };
    out.first = true;
    out.navigatedFrom = prev.url;
    out.note = 'URL changed — baseline re-seeded (the old page is not this page)';
    return out;
  }

  // ★ A LOCATOR IS NOT AN IDENTITY — IT IS A KIND OF PLACE (found 2026-10-01 by inspecting a
  // real diff on news.ycombinator.com). The baseline was keyed by loc alone. On HN every one of
  // the 30 story rows carries the locator
  // 'td:nth-of-type(3) > span:nth-of-type(1) > span:nth-of-type(2) > a:nth-of-type(1) > span:nth-of-type(1)'
  // because locatorOf walks at most 5 ancestors relative to the element, so later entries simply
  // OVERWROTE earlier ones in the map and 29 of the 30 rows were compared against ONE arbitrary
  // baseline record. Measured: every diff on that static page reported the same 29
  // 'content changed' entries with wasNameLen 6 and nameLen 12-25, so mutated was permanently
  // true on a page that had not changed at all — and a scroll looked like a page mutation.
  //
  // The key is the locator PLUS THE ORDINAL WITHIN IT: the k-th element carrying a locator
  // matches the k-th baseline element carrying it. Still stable when elements appear or vanish
  // under a DIFFERENT locator, and now one-to-one where it used to be lossy. The suffix is
  // always a bare integer after the final '#', so it cannot collide with a locator that itself
  // contains a '#'.
  function keyed(list) {
    var n = Object.create(null), out = new Array(list.length);
    for (var k = 0; k < list.length; k++) {
      var L = list[k].loc || ('@' + list[k].i);
      var o = n[L] || 0; n[L] = o + 1;
      out[k] = L + '#' + o;
    }
    return out;
  }
  var oldKeys = keyed(prev.els);
  var newKeys = keyed(now.elements);
  var oldBy = Object.create(null);
  for (var a = 0; a < prev.els.length; a++) oldBy[oldKeys[a]] = prev.els[a];
  var newBy = Object.create(null);
  for (var b = 0; b < now.elements.length; b++) newBy[newKeys[b]] = now.elements[b];

  var addedIdx = [];   // indices only — see ident() above
  var structure = { removed: [], changed: [] };
  var content = { changed: [] };
  var visual = { changed: [] };   // presentation-only (class/style) — repaint, not a change
  var viewport = { moved: [] };

  for (var c = 0; c < now.elements.length; c++) {
    var nr = now.elements[c], or = oldBy[newKeys[c]];
    if (!or) {
      // Indices only for adds: on a hydrate this is thousands of elements and their attrs
      // are already stored. The caller slices the inventory for any index it wants.
      addedIdx.push(nr.i);
      continue;
    }
    var fsame = fingerprint(nr) === fingerprint(or);
    var gsame = geom(nr) === geom(or);
    var nameSame = (nr.name || '') === (or.name || '');
    var valSame = (nr.value == null ? '' : nr.value) === (or.value == null ? '' : or.value);
    // Which attributes differ, and are they ONLY presentation (class/style)?
    var attrsDiff = fieldsDiffer(nr, or);
    var presentOnly = [];
    for (var pd = 0; pd < attrsDiff.length; pd++) {
      if (isPresentationAttr(attrsDiff[pd])) presentOnly.push(attrsDiff[pd]);
    }
    // Only presentation differs => this is a REPAINT, whatever else changed alongside it.
    var onlyPresentation = attrsDiff.length > 0 && presentOnly.length === attrsDiff.length;
    if (fsame && nameSame && valSame) {
      if (!gsame) viewport.moved.push({ i: nr.i, loc: nr.loc, was: { x: or.x, y: or.y, vp: or.vp }, now: { x: nr.x, y: nr.y, vp: nr.vp } });
      // ★ VISUAL, not structural (2026-10-01). The element was REPAINTED and nothing about
      // it changed identity. This is reported so nothing is hidden, but it is not a page
      // change — on x.com these alone were 98 KB of a 367 KB diff.
      else if (onlyPresentation) visual.changed.push({ i: nr.i, loc: nr.loc, changed: presentOnly });
      continue;
    }
    if (!fsame) {
      // WHICH fields changed, not their values — the values are in the inventory.
      var o2 = ident(nr);
      o2.changed = attrsDiff;
      structure.changed.push(o2);
      continue;
    }
    // identity same, presentation same -> whatever moved is content, and geometry-only is viewport
    if (!valSame || !nameSame) {
      // ★ CONTENT CARRIES A READABLE PREVIEW + THE LENGTH, NOT THE WHOLE TEXT (measured
      // 2026-10-01). This group was 227,703 of a 271,713-char diff (84%), because the
      // derived name on a style tag is that tag's ENTIRE CSS SOURCE — and on a hydrating
      // page hundreds of them change. The full text is already in the stored inventory, so shipping it
      // here duplicated 227 KB for nothing.
      // A FIELD VALUE is different: it is short and it IS the answer to "did my input land", so
      // it stays exact. Text is previewed and its true length reported; the caller pulls
      // the full text with find{indices:[i]} if it needs it.
      var cc = { i: nr.i, loc: nr.loc };
      if (!valSame) { cc.value = nr.value; cc.wasValue = or.value; }
      if (!nameSame) {
        var nm = nr.name == null ? '' : String(nr.name);
        cc.name = nm.length > 120 ? nm.slice(0, 120) : nm;
        cc.nameLen = nm.length;
        cc.wasNameLen = (or.name == null ? '' : String(or.name)).length;
        if (nm.length > 120) cc.namePreview = true;
      }
      content.changed.push(cc);
    }
    else if (onlyPresentation) visual.changed.push({ i: nr.i, loc: nr.loc, changed: presentOnly });
    else if (!gsame) viewport.moved.push({ i: nr.i, loc: nr.loc, was: { x: or.x, y: or.y, vp: or.vp }, now: { x: nr.x, y: nr.y, vp: nr.vp } });
  }
  for (var d = 0; d < prev.els.length; d++) {
    var pr = prev.els[d];
    // keyed the same way as the live pass, or a shared locator makes one survivor stand in for
    // all of them and the removals are never reported
    if (!newBy[oldKeys[d]]) structure.removed.push(ident(pr));
  }

  window[KEY] = { url: now.url, at: now.count, seq: (prev.seq + 1), els: now.elements, byLoc: null, sx: now.sx, sy: now.sy };

  var structN = addedIdx.length + structure.removed.length + structure.changed.length;
  var contentN = content.changed.length;

  // ★ A SCROLL IS ONE FACT, NOT N THOUSANDS (measured 2026-10-01).
  // Scrolling an already-hydrated x.com page enumerated 2,525 element movements — 300,769
  // chars, 77% of a 379 KB diff — to say "the page scrolled 972px". The document's own
  // scroll position is the discriminator (see below).
  var moved = viewport.moved;
  var viewportN = moved.length;
  // ★ IS THIS A SCROLL OR A RELAYOUT? (2026-10-01) The document's own scroll position
  // decides — not a guess from the element deltas. The uniform-delta test was tried first
  // and is WRONG on a virtualized list: x.com recycles nodes, so a 972px scroll left 2,525
  // elements moving by DIFFERENT deltas, and the test did not fire (measured: 300,769 chars
  // of viewport enumeration, 77% of a 379 KB diff).
  // A scroll is ONE fact — "the page moved dy" — and the per-element positions are already
  // in the inventory, so enumerating them is repetition, exactly like attrs and text. A
  // movement with the scroll position UNCHANGED is a real relayout, where each element's
  // movement is its own fact, and that still enumerates.
  var scrolled = (Number(prev.sx) !== Number(now.sx)) || (Number(prev.sy) !== Number(now.sy));
  out.structure = { added: addedIdx, removed: structure.removed, changed: structure.changed, count: structN };
  out.content = { changed: content.changed, count: contentN };
  // VISUAL: reported, but never a mutation. On x.com a scroll repaints thousands of nodes.
  out.visual = { changed: visual.changed, count: visual.changed.length };
  if (scrolled) {
    out.viewport = {
      scrolled: { dx: Number(now.sx) - Number(prev.sx), dy: Number(now.sy) - Number(prev.sy) },
      moved: viewportN,
      enumerated: false,
      note: 'the page SCROLLED. Per-element positions are in the inventory (find{indices:[...]}); enumerating them would repeat one fact ' + viewportN + ' times. Not a mutation.',
    };
  } else if (viewportN) {
    out.viewport = { moved: moved, count: viewportN,
      note: 'elements moved while the scroll position did NOT change — this is a LAYOUT change, so each movement is its own fact and is listed.' };
  } else {
    out.viewport = { moved: [], count: 0 };
  }
  out.mutated = structN > 0 || contentN > 0;
  out.hint = out.mutated
    ? 'STRUCTURE and/or CONTENT moved — the page really changed. visual (repaint) and viewport (scroll/layout) are context, NOT mutations.'
    : ((visual.changed.length || viewportN)
        ? 'NOTHING structural changed. The page was only repainted and/or scrolled — treat this action as NOT LANDED.'
        : 'NOTHING on the page changed at all. Treat this action as NOT LANDED — do not retry blind.');
  return out;
}`;
