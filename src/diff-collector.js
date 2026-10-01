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

  function fingerprint(r) {
    var a = r.attrs || {};
    var parts = [];
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) parts.push(k + '=' + a[k]);
    parts.sort();
    return (r.tag || '') + '|' + (r.region || '') + '|' + parts.join('&');
  }
  function geom(r) { return (r.x == null ? '' : r.x) + ',' + (r.y == null ? '' : r.y) + ',' + (r.vp ? 1 : 0); }
  function brief(r) {
    var o = { i: r.i, tag: r.tag, loc: r.loc, region: r.region };
    if (r.name) o.name = r.name;
    if (r.attrs && r.attrs.role) o.role = r.attrs.role;
    if (r.value != null) o.value = r.value;
    if (r.x != null) { o.x = r.x; o.y = r.y; }
    if (r.vp) o.vp = 1;
    return o;
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

  var structure = { added: [], removed: [], changed: [] };
  var content = { changed: [] };
  var viewport = { moved: [] };

  for (var c = 0; c < now.elements.length; c++) {
    var nr = now.elements[c], or = oldBy[nr.loc];
    if (!or) { structure.added.push(brief(nr)); continue; }
    var fsame = fingerprint(nr) === fingerprint(or);
    var gsame = geom(nr) === geom(or);
    var nameSame = (nr.name || '') === (or.name || '');
    var valSame = (nr.value == null ? '' : nr.value) === (or.value == null ? '' : or.value);
    if (fsame && nameSame && valSame) {
      if (!gsame) viewport.moved.push({ i: nr.i, loc: nr.loc, was: { x: or.x, y: or.y, vp: or.vp }, now: { x: nr.x, y: nr.y, vp: nr.vp } });
      continue;
    }
    if (!fsame) {
      var o2 = brief(nr);
      o2.was = { tag: or.tag, region: or.region, role: (or.attrs && or.attrs.role) || undefined };
      structure.changed.push(o2);
      continue;
    }
    // shape identical -> whatever moved is content, and geometry-only is viewport
    if (!valSame || !nameSame) content.changed.push({ i: nr.i, loc: nr.loc, name: nr.name, value: nr.value, was: { name: or.name, value: or.value } });
    else if (!gsame) viewport.moved.push({ i: nr.i, loc: nr.loc, was: { x: or.x, y: or.y, vp: or.vp }, now: { x: nr.x, y: nr.y, vp: nr.vp } });
  }
  for (var d = 0; d < prev.els.length; d++) {
    var pr = prev.els[d];
    if (!newBy[pr.loc]) structure.removed.push(brief(pr));
  }

  window[KEY] = { url: now.url, at: now.count, seq: (prev.seq + 1), els: now.elements, byLoc: null };

  var structN = structure.added.length + structure.removed.length + structure.changed.length;
  var contentN = content.changed.length;
  var viewportN = viewport.moved.length;
  out.structure = { added: structure.added, removed: structure.removed, changed: structure.changed, count: structN };
  out.content = { changed: content.changed, count: contentN };
  out.viewport = { moved: viewport.moved, count: viewportN };
  out.mutated = structN > 0 || contentN > 0;
  out.hint = out.mutated
    ? 'STRUCTURE and/or CONTENT moved. viewport.moved is scroll/layout churn and is NOT a mutation.'
    : (viewportN > 0
        ? 'NOTHING structural changed — the page was only scrolled/relaid out. Treat this action as NOT LANDED.'
        : 'NOTHING on the page changed at all. Treat this action as NOT LANDED — do not retry blind.');
  return out;
}`;
