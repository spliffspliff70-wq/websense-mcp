// THE DIFF CACHE (2026-10-01). Ali: "The composer-close dif it's huge if that ends up in your
// context. Isn't it better to be registered in cache and just show you specifically what changed?"
//
// Measured on x.com: closing the composer produced an 88.8 KB diff for a change a person would
// describe in one line. 32.5 KB of it was `loc` strings naming elements that no longer exist, and
// 39.9 KB was a list of 2,975 inventory indices that moved. The FACTS are small; the membership
// lists are not.
//
// So the whole delta is kept under a handle, the block carries the facts, and any part is one
// page_slice{diff:handle, part:...} away.

const CACHE = new Map();
const CACHE_MAX = 25;

export function cacheDiff(tabId, delta) {
  const handle = 'diff:' + (tabId || 0) + ':' + Date.now().toString(36);
  CACHE.set(handle, delta);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return handle;
}

export function getDiff(handle) {
  return CACHE.get(handle) || null;
}

const len = (v) => (Array.isArray(v) ? v.length : 0);

export function summariseDelta(delta) {
  if (!delta || typeof delta !== 'object') return delta;
  const out = {};
  for (const k of ['mutated', 'reason', 'note']) if (k in delta) out[k] = delta[k];
  if (delta.structure) {
    const s = delta.structure;
    out.structure = {
      added: len(s.added),
      removed: len(s.removed),
      changed: Array.isArray(s.changed) ? s.changed.length : (s.count || 0),
    };
  }
  // CONTENT STAYS WHOLE. It is the answer to "did my input land" and it is already small: a field
  // VALUE is exact, text ships as a 120-char preview plus its true length.
  if (delta.content) out.content = delta.content;
  if (delta.visual) out.visual = { changed: len(delta.visual.changed) };
  if (delta.viewport) {
    const v = delta.viewport;
    out.viewport = v.scrolled
      ? { scrolled: v.scrolled, moved: v.moved, enumerated: !!v.enumerated }
      : { moved: v.moved, shifts: (v.shifts || []).map((s) => ({ dx: s.dx, dy: s.dy, count: s.count })) };
  }
  return out;
}
