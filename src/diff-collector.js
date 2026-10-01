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
  function fingerprint(r) {
    var a = r.attrs || {};
    var parts = [];
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      // ★ PRESENTATION IS NOT IDENTITY (measured 2026-10-01). class and style are how the
      // element is PAINTED, and on a CSS-in-JS site they flip constantly: a 972px scroll on
      // x.com reported 98,441 chars of structure.changed entries whose only difference was
      // class/style. Those are VISUAL changes — Ali's own three groups say so ("content/
      // scroll visual difs") — so identity excludes them and they are classified as visual.
      if (k === 'class' || k === 'style') continue;
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
    window[KEY] = { url: now.url, at: now.count, seq: 0, els: now.elements, byLoc: null };
    out.first = true;
    out.note = 'baseline seeded from this navigation — the NEXT op on this page is diffable';
    return out;
  }

  // Same-document guard: if the URL changed, the baseline belongs to another page.
  if (prev.url !== now.url) {
    window[KEY] = { url: now.url, at: now.count, seq: 0, els: now.elements, byLoc: null };
    out.first = true;
    out.navigatedFrom = prev.url;
    out.note = 'URL changed — baseline re-seeded (the old page is not this page)';
    return out;
  }

  // Match by locator: stable across index shifts when elements are added/removed.
  var oldBy = Object.create(null);
  for (var a = 0; a < prev.els.length; a++) oldBy[prev.els[a].loc] = prev.els[a];
  var newBy = Object.create(null);
  for (var b = 0; b < now.elements.length; b++) newBy[now.elements[b].loc] = now.elements[b];

  var addedIdx = [];   // indices only — see ident() above
  var structure = { removed: [], changed: [] };
  var content = { changed: [] };
  var visual = { changed: [] };   // presentation-only (class/style) — repaint, not a change
  var viewport = { moved: [] };

  for (var c = 0; c < now.elements.length; c++) {
    var nr = now.elements[c], or = oldBy[nr.loc];
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
      if (attrsDiff[pd] === 'class' || attrsDiff[pd] === 'style') presentOnly.push(attrsDiff[pd]);
    }
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
    if (!newBy[pr.loc]) structure.removed.push(ident(pr));
  }

  window[KEY] = { url: now.url, at: now.count, seq: (prev.seq + 1), els: now.elements, byLoc: null };

  var structN = addedIdx.length + structure.removed.length + structure.changed.length;
  var contentN = content.changed.length;

  // ★ A UNIFORM MOVE IS ONE FACT, NOT N THOUSANDS (measured 2026-10-01).
  // Scrolling an already-hydrated x.com page listed 2,525 individual "moved" elements —
  // 230,879 chars, 68% of a 367 KB diff — to say "the page scrolled 972px", because every
  // element had moved by the SAME delta. Reporting that N times is not completeness, it is
  // repetition. A uniform translation is fully and exactly described by its delta plus the
  // count, so that is what it now reports, and the per-element list is kept only when the
  // movements DIFFER (a genuine relayout, where each element's movement is its own fact).
  var moved = viewport.moved;
  var viewportN = moved.length;
  var uniform = null;
  if (viewportN > 1) {
    uniform = { dx: null, dy: null };
    var u = moved[0].now.x - moved[0].was.x;
    var v = moved[0].now.y - moved[0].was.y;
    for (var mi = 1; mi < viewportN; mi++) {
      if ((moved[mi].now.x - moved[mi].was.x) !== u || (moved[mi].now.y - moved[mi].was.y) !== v) {
        uniform = null;
        break;
      }
    }
    if (uniform) { uniform.dx = u; uniform.dy = v; }
  }
  out.structure = { added: addedIdx, removed: structure.removed, changed: structure.changed, count: structN };
  out.content = { changed: content.changed, count: contentN };
  // VISUAL: reported, but never a mutation. On x.com a scroll repaints thousands of nodes.
  out.visual = { changed: visual.changed, count: visual.changed.length };
  if (uniform) {
    out.viewport = {
      scroll: { dx: uniform.dx, dy: uniform.dy },
      moved: viewportN,
      uniform: true,
      note: 'every moved element moved by the same delta — this is a SCROLL, not a layout change',
    };
  } else {
    out.viewport = { moved: moved, count: viewportN };
  }
  out.mutated = structN > 0 || contentN > 0;
  out.hint = out.mutated
    ? 'STRUCTURE and/or CONTENT moved — the page really changed. visual (repaint) and viewport (scroll/layout) are context, NOT mutations.'
    : ((visual.changed.length || viewportN)
        ? 'NOTHING structural changed. The page was only repainted and/or scrolled — treat this action as NOT LANDED.'
        : 'NOTHING on the page changed at all. Treat this action as NOT LANDED — do not retry blind.');
  return out;
}`;
