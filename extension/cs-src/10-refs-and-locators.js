/* ═══ SHADOW-DOM PIERCING (2026-09-11d) ═══
 * document.querySelector() cannot see into a shadow root, so any control a site
 * builds as a web component (Lit / Stencil / FAST / faceplate — Reddit's composer,
 * shoelace widgets) is invisible to selector resolution even though the candidate
 * scan ALREADY pierces shadow roots (_collectShadowHits). That mismatch is what
 * forced a fallback to pixel guessing: `inspect kind:"geometry"` answered
 * "element not found" for Reddit's Post button, which lives in a shadow root, so
 * the caller had nothing to click and had to estimate coordinates from a picture.
 * These walk OPEN shadow roots only. A CLOSED root is unreachable by design from
 * any script, so it is skipped rather than faked.
 */
  function deepQueryAll(selector, root) {
    const start = root || document;
    const out = [];
    const queue = [start];
    while (queue.length) {
      const node = queue.shift();
      try {
        const hits = node.querySelectorAll(selector);
        for (let i = 0; i < hits.length; i++) out.push(hits[i]);
      } catch (_) { /* selector invalid for this root */ }
      let all = null;
      try { all = node.querySelectorAll('*'); } catch (_) {}
      if (all) {
        for (let j = 0; j < all.length; j++) {
          const sr = all[j] && all[j].shadowRoot;
          if (sr) queue.push(sr);
        }
      }
    }
    return out;
  }

  function deepQuery(selector, root) {
    if (!selector) return null;
    // Light-DOM fast path: identical behaviour on pages with no shadow roots, so
    // this cannot regress the common case; the walk only runs on a miss.
    try { const hit = (root || document).querySelector(selector); if (hit) return hit; } catch (_) {}
    const all = deepQueryAll(selector, root);
    return all.length ? all[0] : null;
  }

  function isInShadow(el) {
    try { return !!(el && el.getRootNode && el.getRootNode() !== document); } catch (_) { return false; }
  }

/* Ref/locator system: assign, resolve, heal, locator build
 * Part 01 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
  const REF_ATTR = 'data-websense-ref';
  let refMap = new Map();
  const elementSignatures = new WeakMap();
  // A2: ref → locator chain (a plain Map — WeakMap is not iterable, so the
  // resolveRef fallback can't scan elementSignatures; keep the locator
  // indexed by ref for O(1) re-resolution after re-render).
  const locatorByRef = new Map();
  let refCounter = 0;

  function elementSignature(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const name = el.getAttribute('name') || '';
    const role = el.getAttribute('role') || '';
    const type = el.getAttribute('type') || '';
    const cls = (el.className || '').toString().slice(0, 50);
    let posIdx = -1;
    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
      posIdx = siblings.indexOf(el);
    }
    return [tag, id, name, role, type, cls, posIdx].join('|');
  }

  // A2 (2026-08-10): semantic locator chain — a STABLE address that survives
  // re-render. Priority: data-testid → id → aria-label → name → stable CSS
  // path → role+text. `resolveRef` falls back through this when the element
  // is removed from the DOM (React/Angular re-renders kill the REF_ATTR node).
  function buildLocator(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const chain = [];
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testid) chain.push('[data-testid="' + CSS.escape(testid) + '"]');
    if (el.id) chain.push('#' + CSS.escape(el.id));
    const aria = el.getAttribute('aria-label');
    if (aria) chain.push('[aria-label="' + CSS.escape(aria) + '"]');
    const name = el.getAttribute('name');
    if (name) chain.push('[name="' + CSS.escape(name) + '"]');
    // Stable CSS path: climb to a stable ancestor (id/testid/body), record
    // :nth-of-type indices — survives shallow re-renders.
    let css = '';
    let node = el;
    let guard = 0;
    while (node && node.nodeType === Node.ELEMENT_NODE && guard++ < 8) {
      const tag = node.tagName.toLowerCase();
      if (node.id) { css = '#' + CSS.escape(node.id) + ' ' + css; break; }
      if (node.getAttribute('data-testid')) { css = '[data-testid="' + CSS.escape(node.getAttribute('data-testid')) + '"] ' + css; break; }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        const idx = sameTag.indexOf(node);
        css = tag + (sameTag.length > 1 ? ':nth-of-type(' + (idx + 1) + ')' : '') + (css ? ' > ' + css : '');
      } else { css = tag + (css ? ' > ' + css : ''); }
      node = parent;
    }
    if (css) chain.push(css);
    // role+text — the most semantic, last resort
    const role2 = el.getAttribute('role');
    const txt = (el.innerText || el.textContent || '').trim().slice(0, 40);
    if (role2 && txt) chain.push('[role="' + CSS.escape(role2) + '"][aria-label="' + CSS.escape(txt) + '"]');
    else if (txt) chain.push('//' + el.tagName.toLowerCase() + '[normalize-space(.)="' + txt.replace(/"/g, '\\"') + '"]');
    return chain.length ? chain : null;
  }

  // Resolve a locator chain against the live DOM (CSP-safe, no eval).
  function resolveLocator(chain) {
    if (!Array.isArray(chain)) return null;
    for (const sel of chain) {
      try {
        if (sel.startsWith('//')) {
          // XPath-ish fallback (text match) — querySelector can't do text.
          const m = sel.match(/^\/([a-z]+)\[normalize-space\(\.\)="([^"]*)"\]$/);
          if (m) {
            const els = Array.from(document.getElementsByTagName(m[1]));
            for (const e of els) {
              if ((e.innerText || e.textContent || '').trim().slice(0, 40) === m[2]) return e;
            }
          }
          continue;
        }
        // deepQuery: the locator chain is the SELF-HEAL path, so it must pierce
        // shadow roots too — otherwise a re-rendered web-component never rebinds.
        const el = deepQuery(sel);
        if (el) return el;
      } catch (_) { /* try next */ }
    }
    return null;
  }

  function assignRef(el) {
    if (elementSignatures.has(el)) return elementSignatures.get(el).ref;
    const ref = 'E' + refCounter++;
    const loc = buildLocator(el);
    elementSignatures.set(el, { ref, sig: elementSignature(el), locator: loc });
    refMap.set(ref, el);
    if (loc && loc.length) locatorByRef.set(ref, loc);
    try { el.setAttribute(REF_ATTR, ref); } catch (_) {}
    return ref;
  }

  // v4 (2026-08-31): quote-safe [data-websense-ref="<ref>"] lookup + selector
  // fast-path. Escapes backslashes and double quotes before embedding the ref
  // into an attribute selector, so refs containing quotes can never crash
  // querySelector again.
  function resolveAttrRef(ref) {
    if (typeof ref !== 'string' || !ref) return null;
    try {
      const esc = ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // deepQuery: a REF assigned to a shadow-hosted control (createElement/refs
      // on web components) is unreachable via document.querySelector, so
      // resolveRef returned null and every tool answered "Element not found"
      // for an element the candidate scan had ALREADY found and ref'd.
      return deepQuery('[' + REF_ATTR + '="' + esc + '"]') || null;
    } catch (_) { return null; }
  }

  // SELECTOR-REF fast path (v4): if the ref looks like a CSS selector, try it
  // directly before falling back to the locator chain.
  function resolveSelectorRef(ref) {
    if (typeof ref !== 'string') return null;
    if (!/^[\[\]#\.>\+~,:*='"\w\-()%|\s]+$/.test(ref)) return null;
    if (!(ref.startsWith('[') || ref.startsWith('#') || ref.startsWith('.') || ref.includes(' > ') || ref.includes('>') || ref.includes('~') || /^[a-zA-Z][\w-]*([\[.:])/.test(ref))) return null;
    try {
      // deepQuery: accept a shadow-hosted selector as a ref (Reddit's Post button,
      // any Lit/FAST widget) instead of failing and forcing coordinate guessing.
      return deepQuery(ref) || null;
    } catch (_) { return null; }
  }

  function resolveRef(ref) {
    if (refMap.has(ref)) {
      const el = refMap.get(ref);
      if (el && el.isConnected) return el;
      refMap.delete(ref);
    }
    // v4 (2026-08-31): attribute-lookup with QUOTE-SAFE escaping. A ref/selector
    // containing double quotes (e.g. [data-testid="tweetTextarea_0"]) crashed
    // the naive string concat with "not a valid selector". Also fast-path:
    // a well-formed selector ref goes straight to querySelector.
    const el = resolveAttrRef(ref);
    if (el) { refMap.set(ref, el); return el; }
    // SELECTOR REFS (2026-08-13): accept CSS selectors directly
    // so tools like geometry()'s returned refs ("[aria-label='X']", "#id",
    // ".class > span") can be clicked without an E# SAG entry. v4 (2026-08-31):
    // wrapped in resolveAttrRef() which QUOTE-ESCAPES the attribute value —
    // selectors containing double quotes (e.g. [data-testid="tweetTextarea_0"])
    // previously crashed querySelector with "not a valid selector".
    {
      const selEl = resolveSelectorRef(ref);
      if (selEl) { refMap.set(ref, selEl); return selEl; }
    }
    // A2 (2026-08-10): the ref node died (re-render). Re-resolve via the
    // semantic locator chain — data-testid → id → aria-label → name → CSS
    // path → role+text. Re-binds the ref to the re-rendered element.
    const loc = locatorByRef.get(ref);
    if (loc) {
      const found = resolveLocator(loc);
      if (found) {
        refMap.set(ref, found);
        try { found.setAttribute(REF_ATTR, ref); } catch (_) {}
        return found;
      }
    }
    return null;
  }

  // SELF-HEAL RESOLVE (2026-08-31, OSS smoke-test finding): async wrapper —
  // ref was assigned in a scan BEFORE a full/compact explore rebuilt refMap,
  // or the element is below fold / viewport-filtered / slow-render, and the
  // sync DOM-walk resolution missed. Rebuild the graph ONCE, then retry —
  // beats a hard "Element not found" and lets callers climb honestly.
  // Guarded against recursion (extractActionGraph itself never calls this).
  async function resolveRefHealed(ref) {
    const first = resolveRef(ref);
    if (first) return first;
    if (resolveRefHealed._healing) return null;
    try {
      resolveRefHealed._healing = true;
      await extractActionGraph({ includeContent: false, full: false, includeHidden: false });
    } catch (_) { /* heal failed — return null below */ }
    finally { resolveRefHealed._healing = false; }
    return resolveRef(ref);
  }

  // ═══ Framework Detection ═══
