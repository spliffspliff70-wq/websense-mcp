/**
 * WebSense — Incremental explore diff (P1, 2026-08-31)
 *
 * Canonical semantics for the CS-side scan diff. The content script mirrors
 * this logic inline (content scripts can't import ESM); the unit tests in
 * test-regressions.mjs pin the behavior HERE, so any change to the CS copy
 * must keep both in lockstep. Keep this file dependency-free and pure.
 *
 * Identity model:
 *   key  — semantic identity of an element (data-testid / id / name /
 *          aria-label / placeholder / positional fallback). Survives
 *          re-renders when any semantic attribute survives.
 *   fp   — fingerprint string of the action-relevant fields (type, subtype,
 *          label, href, value, checked, disabled, expanded, selected,
 *          pressed, visible, inViewport, required, readOnly). Same key +
 *          same fp = unchanged. Password values never enter the fp.
 */

/**
 * Diff the previous scan cache against the current scan.
 *
 * @param {Map|null} prev  key -> { fp, ref, label } from the last scan
 *                         (null = no baseline; caller should do a full scan)
 * @param {Map} curr       key -> { fp, ref, label, action }
 * @param {object} [opts]
 * @param {number} [opts.escalateRatio=0.6]  changed fraction above which the
 *        caller should fall back to a full explore
 * @param {number} [opts.escalateMin=20]     minimum tracked elements before
 *        the escalate ratio is applied (tiny pages always return the delta)
 * @returns {{
 *   added: Array, changed: Array, removed: Array,
 *   unchangedCount: number, prevCount: number, currCount: number,
 *   changedRatio: number, escalate: boolean
 * }}
 */
export function diffScan(prev, curr, opts) {
  const o = opts || {};
  const escalateRatio = typeof o.escalateRatio === 'number' ? o.escalateRatio : 0.6;
  const escalateMin = typeof o.escalateMin === 'number' ? o.escalateMin : 20;

  const added = [];
  const changed = [];
  const removed = [];
  let unchangedCount = 0;

  if (!prev || prev.size === 0) {
    // No baseline: everything is "added"; the caller decides to escalate.
    for (const [key, e] of curr) added.push(e.action || { key });
    const total = curr.size;
    return {
      added, changed, removed,
      unchangedCount: 0, prevCount: prev ? prev.size : 0, currCount: total,
      changedRatio: total > 0 ? 1 : 0,
      escalate: total > escalateMin,
    };
  }

  // Pass 1: current elements — added or changed (or unchanged).
  for (const [key, e] of curr) {
    const p = prev.get(key);
    if (!p) {
      added.push(e.action || { key, label: e.label });
    } else if (p.fp !== e.fp) {
      changed.push({
        action: e.action || { key, label: e.label },
        changes: fieldChanges(p.fpo, e.fpo),
      });
    } else {
      unchangedCount++;
    }
  }

  // Pass 2: previous elements gone from the page.
  for (const [key, p] of prev) {
    if (!curr.has(key)) removed.push({ key, ref: p.ref || null, label: p.label || '' });
  }

  const totalTracked = Math.max(prev.size, curr.size);
  const deltaCount = added.length + removed.length + changed.length;
  const changedRatio = totalTracked > 0 ? deltaCount / totalTracked : 0;
  const escalate = totalTracked > escalateMin && changedRatio > escalateRatio;

  return {
    added, changed, removed,
    unchangedCount, prevCount: prev.size, currCount: curr.size,
    changedRatio, escalate,
  };
}

/**
 * Per-field change list between two fingerprint objects (plain objects of
 * scalar fields). Values are truncated to keep the delta payload small.
 *
 * @param {object|null} prevFpo
 * @param {object|null} currFpo
 * @param {number} [maxLen=40]
 * @returns {Array<{field: string, from: string, to: string}>}
 */
export function fieldChanges(prevFpo, currFpo, maxLen) {
  const ml = maxLen || 40;
  const out = [];
  if (!prevFpo || !currFpo) return out;
  const keys = new Set([...Object.keys(prevFpo), ...Object.keys(currFpo)]);
  for (const k of keys) {
    const a = prevFpo[k];
    const b = currFpo[k];
    if (a !== b) {
      out.push({
        field: k,
        from: String(a == null ? '' : a).slice(0, ml),
        to: String(b == null ? '' : b).slice(0, ml),
      });
    }
  }
  return out;
}

/**
 * Build the semantic identity key from plain attribute data.
 * (CS passes the already-extracted attribute snapshot; kept pure here so the
 * key-building rules are pinned by tests too.)
 *
 * Priority: data-testid/data-test > id > name(+type) > aria-label >
 * placeholder > positional fallback (tag:type:label:href).
 *
 * @param {object} a attribute snapshot:
 *   { tag, id, testid, name, type, ariaLabel, placeholder, label, href }
 * @returns {string}
 */
export function identityKey(a) {
  if (a.testid) return 'tid:' + a.testid;
  if (a.id) return 'id:' + a.id;
  if (a.name) return 'name:' + a.tag + ':' + a.name + (a.type ? ':' + a.type : '');
  if (a.ariaLabel) return 'aria:' + a.ariaLabel.slice(0, 60);
  if (a.placeholder) return 'ph:' + a.placeholder.slice(0, 60);
  return 'pos:' + a.tag + (a.type ? ':' + a.type : '') + ':' + (a.label || '').slice(0, 40) + (a.href ? ':' + String(a.href).slice(0, 40) : '');
}

/**
 * Disambiguate duplicate identity keys by appending occurrence order.
 * Mutates nothing; returns a NEW array of [key, entry] pairs where duplicate
 * keys get ':k0', ':k1', ... suffixes in the given (DOM) order.
 *
 * @param {Array<[string, object]>} pairs
 * @returns {Map}
 */
export function disambiguate(pairs) {
  const seen = new Map();
  const out = new Map();
  for (const [key, entry] of pairs) {
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    out.set(n === 0 ? key : key + ':k' + n, entry);
  }
  return out;
}
