/* Interactive candidate collection (selector prefilter + shadow)
 * Part 05 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'details', 'summary',
    'label', 'option', 'optgroup',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]', '[role="radio"]', '[role="checkbox"]', '[role="tab"]',
    '[role="switch"]', '[role="option"]', '[role="combobox"]', '[role="searchbox"]',
    '[role="textbox"]', '[role="slider"]', '[role="spinbutton"]', '[role="treeitem"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]', '[onclick]',
    '[aria-haspopup]', '[data-toggle]', '[data-bs-toggle]', '.dropdown-toggle'
  ].join(',');

  var _domVersion = 0;
  var _lastMutationTs = Date.now();
  var _domObserver = null;
  var _sagCache = null;

  // One always-on observer per tab. Counting mutations is what lets us (a) skip
  // the settle wait on a quiet DOM and (b) reuse a previous SAG when nothing
  // changed — both otherwise-free savings on every call.
  // attributeFilter deliberately EXCLUDES data-websense-ref: assignRef() writes
  // that attribute on every element it touches, and watching it would make our
  // own bookkeeping look like a page mutation and defeat the cache.
  function ensureDomObserver() {
    if (_domObserver) return;
    try {
      _domObserver = new MutationObserver(function () {
        _domVersion++;
        _lastMutationTs = Date.now();
      });
      _domObserver.observe(document.documentElement || document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'disabled', 'hidden', 'style',
                          'aria-expanded', 'aria-hidden', 'aria-disabled']
      });
    } catch (_) { _domObserver = null; }
  }

  // Selector hits only — no full-subtree walk.
  // 2026-09-11: the document-level `*` walk used to live IN here, so it ran twice
  // per call (once for shadow-host discovery, once again just to count elements) —
  // two full-DOM queries on every explore. The document-level walk now happens
  // once in collectInteractiveCandidates and is reused for both purposes.
  function _collectSelectorHits(root, out, seen) {
    try {
      const hits = root.querySelectorAll(INTERACTIVE_SELECTOR);
      for (let i = 0; i < hits.length; i++) {
        if (!seen.has(hits[i])) { seen.add(hits[i]); out.push(hits[i]); }
      }
    } catch (_) {}
  }

  // Shadow subtrees still need their own walk to find NESTED shadow hosts.
  function _collectShadowHits(root, out, seen) {
    _collectSelectorHits(root, out, seen);
    try {
      const all = root.querySelectorAll('*');
      for (let j = 0; j < all.length; j++) {
        if (all[j] && all[j].shadowRoot) _collectShadowHits(all[j].shadowRoot, out, seen);
      }
    } catch (_) {}
  }

  function collectInteractiveCandidates(options) {
    options = options || {};
    const out = [];
    const seen = new Set();
    // ONE full-DOM query, reused for the element count AND shadow-host discovery.
    let all = null;
    let totalElements = 0;
    try { all = document.querySelectorAll('*'); totalElements = all.length; } catch (_) { all = null; }
    _collectSelectorHits(document, out, seen);
    if (all) {
      for (let i = 0; i < all.length; i++) {
        if (all[i] && all[i].shadowRoot) _collectShadowHits(all[i].shadowRoot, out, seen);
      }
    }
    const selectorHits = out.length;

    let cursorSweepSkipped = false;
    let cursorScanned = 0;
    if (options.includeCursorSweep !== false) {
      if (totalElements > CURSOR_SWEEP_MAX_ELEMENTS) {
        // getComputedStyle per element is the single most expensive thing in the
        // old loop. Above this size the cursor sweep costs more than it finds,
        // and on such pages the old code simply timed out — so declining it is
        // strictly better, and the result says so rather than hiding it.
        cursorSweepSkipped = true;
      } else {
        try {
          const all = document.querySelectorAll('*');
          for (let i = 0; i < all.length && cursorScanned < SCAN_CEILING; i++) {
            const el = all[i];
            cursorScanned++;
            if (seen.has(el)) continue;
            let cur = '';
            try { cur = cachedStyle(el).cursor || ''; } catch (_) { cur = ''; }
            if (cur && INTERACTIVE_CURSORS.has(cur)) { seen.add(el); out.push(el); }
          }
        } catch (_) {}
      }
    }

    let capped = false;
    if (out.length > SCAN_CEILING) { out.length = SCAN_CEILING; capped = true; }
    return {
      nodes: out, totalElements: totalElements, selectorHits: selectorHits,
      cursorScanned: cursorScanned, cursorSweepSkipped: cursorSweepSkipped, capped: capped,
    };
  }

  // Visibility using one native checkVisibility() call when available (Chrome
  // 105+), falling back to computed style. Takes an already-read rect so we
  // never call getBoundingClientRect twice for the same element.
  function _isVisibleRect(el, rect) {
    try {
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } else {
        const s = cachedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      }
    } catch (_) {
      try {
        const s2 = cachedStyle(el);
        if (s2.display === 'none' || s2.visibility === 'hidden' || s2.opacity === '0') return false;
      } catch (_) {}
    }
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden) return false;
    const r = rect || el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }

  function getAllElements(root) {
    // Phase 4 (2026-08-15): OPTIONAL iframe recursion. With all_frames:true
    // every frame runs its own content script, but the model can't always
    // target frames by frameId, so the main-frame explore_page now ALSO walks
    // into SAME-ORIGIN iframes and tags each element with its frameId. Cross-
    // origin iframes (and ad frames) are skipped — they're not reachable from
    // here and have their own bridge. This makes explore_page return the FULL
    // interactive surface in one call instead of missing in-frame controls.
    const elements = [];
    function walk(node, frameId) {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        node.__wsFrameId = frameId;
        elements.push(node);
        if (node.shadowRoot) { for (const c of node.shadowRoot.children) walk(c, frameId); }
      }
      if (node.children) { for (const c of node.children) walk(c, frameId); }
    }
    walk(root || document.body, 0);
    // Recurse into same-origin iframes (top-level = frameId 0 already done).
    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(function (f, idx) {
        if (f.src && /^(https?:)?\/\//.test(f.src) && !sameOrigin(f.src)) return; // cross-origin: skip
        if (WS_IS_AD_FRAME) return; // never recurse ad frames
        try {
          const fd = f.contentDocument;
          if (fd && fd.body) walk(fd.body, idx + 1);
        } catch (_) { /* cross-origin or not ready — skip */ }
      });
    } catch (_) {}
    return elements;
  }

  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (_) { return false; }
  }

  // ═══ Main SAG Extraction (chunked + async for heavy DOMs) ═══
  // Process elements in batches with yield-between to avoid blocking the
  // main thread and to stay within the WebSocket response window.
  const BATCH_SIZE = 150; // elements per chunk
  const CHUNK_YIELD_MS = 0; // setTimeout(0) yield between chunks

  // Wait for the DOM to stop mutating (SPA hydration settle) before extraction.
  // React/Vue apps render progressively; exploring mid-hydration gives a
  // half-empty SAG. Default: wait up to 2.5s for a 400ms quiet window.
  function waitForSettle(maxWaitMs, quietMs) {
    return new Promise(function (resolve) {
      var maxWait = maxWaitMs || 2500;
      var quiet = quietMs || 400;
      var deadline = Date.now() + maxWait;
      var timer = null;
      function arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          observer.disconnect();
          resolve();
        }, quiet);
      }
      var observer = new MutationObserver(function () {
        if (Date.now() > deadline) { observer.disconnect(); if (timer) clearTimeout(timer); resolve(); return; }
        arm();
      });
      try { observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (_) { resolve(); return; }
      arm();
    });
  }

  async function extractActionGraph(options) {
    options = options || {};
    // P1 (2026-08-31): incremental path — cheap scan + diff vs last scan,
    // full-SAG fallback on first call / churn (see exploreIncremental).
    if (options.incremental) return await exploreIncremental(options);
    wsLog('EAG:start opts=', JSON.stringify(options));

    ensureDomObserver();

    // ── 0. Reuse the last SAG when the DOM provably has not changed ──────────
    // Only for the cheap (viewport-only) shape, identical options, and inside a
    // short TTL. The TTL is the backstop for the one case the mutation counter
    // cannot see: a layout change driven by JS/canvas with no DOM mutation.
    // {fresh:true} forces a real scan.
    const cheapShape = !options.full && !options.includeHidden;
    const cacheKey = [!!options.full, options.includeContent !== false,
                      !!options.includeHidden, options.maxActions || '',
                      options.contentMaxLen || ''].join('|');
    if (cheapShape && !options.fresh && _sagCache &&
        _sagCache.key === cacheKey && _sagCache.domVersion === _domVersion &&
        (Date.now() - _sagCache.ts) < SAG_CACHE_TTL_MS) {
      wsLog('EAG:cache HIT age=' + (Date.now() - _sagCache.ts) + 'ms');
      const hit = Object.assign({}, _sagCache.sag);
      hit.cached = true;
      hit.cacheAgeMs = Date.now() - _sagCache.ts;
      return hit;
    }

    const scanStart = Date.now();

    // REF STABILITY (2026-08-31, OSS smoke-test finding): refCounter is NOT
    // reset here. Resetting it made refs from a previous explore silently
    // re-point at DIFFERENT elements after a re-scan (silent wrong-click
    // hazard) or die with "Element not found" (below-fold elements). Refs
    // are only reset on SPA navigation (navObserver) — within one page they
    // are stable for the tab's lifetime. refMap is still rebuilt (bounded).
    refMap = new Map(); locatorByRef.clear();
    _styleCacheClear();

    // ── 1. Settle — only when the page actually changed recently ────────────
    // The old code always paid a full 400ms quiet window even on a page that had
    // been idle for minutes. That is pure added latency on every call.
    const sinceMutation = Date.now() - _lastMutationTs;
    if (options.settle !== false && sinceMutation < SETTLE_SKIP_IF_QUIET_MS) {
      await waitForSettle(options.settleMs || 2500, options.quietMs || 200);
    }
    wsLog('EAG:settle skipped=' + (sinceMutation >= SETTLE_SKIP_IF_QUIET_MS) +
          ' sinceMutation=' + sinceMutation + 'ms');

    // ── 2. Candidates: selector prefilter instead of walking every node ─────
    const cand = collectInteractiveCandidates(options);
    const tCand = Date.now();
    wsLog('EAG:candidates=' + cand.nodes.length + ' selectorHits=' + cand.selectorHits +
          ' totalEls=' + cand.totalElements +
          (cand.cursorSweepSkipped ? ' CURSOR_SWEEP_SKIPPED' : ''));

    // ── 3. Cheap attribute pass (property reads only — never forces layout) ──
    const pass1 = [];
    for (let i = 0; i < cand.nodes.length && pass1.length < SCAN_CEILING; i++) {
      const el = cand.nodes[i];
      if (el.disabled) continue;
      if (el.getAttribute('aria-disabled') === 'true') continue;
      if (el.getAttribute('inert') !== null) continue;
      if (el.tagName === 'INPUT' && el.getAttribute('type') === 'hidden') continue;
      pass1.push(el);
    }

    // ── 4. ONE geometry + visibility pass; each rect read exactly once ───────
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const wantOffscreen = !!options.full || !!options.includeHidden;
    const geo = [];
    for (let i = 0; i < pass1.length; i++) {
      const el = pass1[i];
      let rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { continue; }
      const vis = _isVisibleRect(el, rect);
      if (options.includeHidden === false && !vis) continue;
      const inVp = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      if (!wantOffscreen && !inVp) continue;
      geo.push({ el: el, rect: rect, vis: vis, inVp: inVp });
    }

    // ── 5. Viewport-first order ─────────────────────────────────────────────
    // Old traversal was document order, so on a long page the elements the agent
    // actually needs (near the viewport, or in an open dialog) could sit hundreds
    // of entries down the list. In-viewport first, then top-to-bottom.
    geo.sort(function (a, b) {
      if (a.inVp !== b.inVp) return a.inVp ? -1 : 1;
      return a.rect.top - b.rect.top;
    });

    // ── 6. Enrich ONLY what we will return ──────────────────────────────────
    // classify/label/locator/intent/predictEffect are the expensive per-element
    // work, so the cap is applied AFTER geometry + viewport filtering where it
    // finally bounds real work. DEFAULT_MAX_ACTIONS also means the *default* call
    // is bounded — it used to be 0 (unbounded), which is why explore_page's
    // default hard-stalled at 90s on any page over ~5,000 elements.
    //
    // Measured 2026-09-11: this loop costs ~0.65ms per accepted action and is the
    // dominant term once a page has many in-viewport interactives (3,000 links:
    // 190ms wall, ~130ms of it here). Geometry is cheap by comparison
    // (~0.02ms/element) — which is why an IntersectionObserver rewrite was
    // measured and REJECTED as not worth the async complexity.
    const tGeo = Date.now();
    const maxActions = options.maxActions > 0 ? options.maxActions : DEFAULT_MAX_ACTIONS;
    const actions = [];
    for (let i = 0; i < geo.length; i++) {
      if (actions.length >= maxActions) break;
      const el = geo[i].el;
      if (!isInteractive(el, geo[i])) continue;
      try {
        const ref = assignRef(el);
        const classification = _cachedClassify(el);
        const attrs = getAttrs(el);
        const state = extractState(el);
        const label = getLabel(el);
        const effect = predictEffect(el, classification, attrs);
        // 2026-09-25 PRIVACY: `...state` spread the RAW el.value into every
        // explore_page action, so a filled password appeared in the action list
        // (and in any delta/session snapshot of it). Mask it for sensitive
        // fields, keeping the has-a-value signal.
        if (isSensitiveValueField(el)) state.value = '';
        const action = { ref, type: classification.type, subtype: classification.subtype, label, predictedEffect: effect, ...state };
        // Phase 4 (2026-08-15): surface frameId from explore_page iframe recursion.
        if (el.__wsFrameId != null && el.__wsFrameId !== 0) action.frameId = el.__wsFrameId;
        // A2 (2026-08-10): expose the semantic locator so the agent can
        // re-target after re-render (locator survives; ref E# may die).
        const loc = buildLocator(el);
        if (loc && loc.length) action.locator = loc[0];
        // A3 (2026-08-10): intent tag — the element's semantic purpose.
        action.intent = detectIntent(el, classification);
        if (classification.href) action.href = classification.href;
        if (classification.target) action.target = classification.target;
        if (classification.formRef) action.formRef = classification.formRef;
        if (classification.expanded !== undefined) action.expanded = classification.expanded;
        if (classification.selected !== undefined) action.selected = classification.selected;
        if (classification.pressed !== undefined) action.pressed = classification.pressed;
        actions.push(action);
      } catch (_) { /* skip broken element */ }
    }
    wsLog('EAG:loop done, ' + actions.length + ' actions (geo=' + geo.length + ')');
    const tAct = Date.now();

    const truncated = geo.length > actions.length;

    // Trim content extraction on big pages unless the caller asked for more —
    // the other half of the payload problem (explore_page on x.com returned
    // 1,006,657 bytes ≈ 275k tokens, unusable as agent context).
    const opt2 = Object.assign({}, options);
    if (actions.length >= AUTO_COMPACT_CANDIDATES && options.contentMaxLen === undefined) {
      opt2.contentMaxLen = CONTENT_MAX_CHARS;
    }

    const sag = _buildSAG(actions, opt2);
    sag.truncated = truncated;
    sag.returnedActions = actions.length;
    sag.viewportCandidates = geo.length;
    sag.candidatesExamined = pass1.length;
    sag.candidatesFound = cand.nodes.length;
    sag.totalElements = cand.totalElements;
    if (cand.cursorSweepSkipped) sag.cursorSweepSkipped = true;
    if (cand.capped) sag.candidateCeilingHit = true;
    sag.scanMs = tAct - scanStart;
    // Split attribution (2026-09-11). `scanMs` alone was misleading: it conflated
    // candidate collection, geometry and the per-action semantic work, and only the
    // last of those scales with maxActions. Reported separately so a slow call can
    // be attributed without guessing.
    sag.candidatesMs = tCand - scanStart;
    sag.geometryMs = tGeo - tCand;
    sag.actionMs = tAct - tGeo;
    wsLog('EAG:scanMs=' + sag.scanMs + ' (cand=' + sag.candidatesMs + ' geo=' + sag.geometryMs + ' act=' + sag.actionMs + ') returned=' + actions.length + ' geo=' + geo.length);

    if (cheapShape && !options.fresh) {
      _sagCache = { key: cacheKey, domVersion: _domVersion, ts: Date.now(), sag: sag };
    }
    return sag;
  }

  // Style cache — prevents calling getComputedStyle multiple times per element.
  // NOTE (2026-09-11): this used to be a module-level WeakMap that was NEVER
  // cleared, so a cached style from an earlier call could be reused after the
  // element's style had changed — e.g. an element inside a modal that has since
  // been shown stayed "display:none" forever, and dialog controls never appeared
  // in the SAG. It is now rebuilt at the start of every extraction.
  let _styleCache = new WeakMap();
  function _styleCacheClear() { _styleCache = new WeakMap(); }
  function cachedStyle(el) {
    if (_styleCache.has(el)) return _styleCache.get(el);
    var s;
    try { s = window.getComputedStyle(el); } catch (_) { s = { display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' }; }
    _styleCache.set(el, s);
    return s;
  }
  function _cachedClassify(el) {
    // Re-use cached style instead of calling getComputedStyle again
    const tag = el.tagName.toLowerCase();
    const attrs = getAttrs(el);
    const role = attrs.role || '';
    const type = attrs.type || '';
    const style = cachedStyle(el);

    if (tag === 'a' && attrs.href) return { type: 'navigation', subtype: 'link', href: attrs.href, target: attrs.target || '_self' };
    if (tag === 'a') return { type: 'action', subtype: 'anchor_button' };
    if (tag === 'input' || tag === 'textarea') {
      if (type === 'checkbox') return { type: 'toggle', subtype: 'checkbox' };
      if (type === 'radio') return { type: 'toggle', subtype: 'radio' };
      if (type === 'submit' || type === 'image') { const f = el.closest('form'); return { type: 'form_submit', subtype: 'input_submit', formRef: f ? assignRef(f) : null }; }
      if (type === 'file') return { type: 'file_upload', subtype: 'file' };
      if (type === 'button') return { type: 'action', subtype: 'input_button' };
      return { type: 'form_input', subtype: type || 'text' };
    }
    if (tag === 'select') return { type: 'form_input', subtype: 'select' };
    if (el.isContentEditable || attrs.contenteditable === 'true') return { type: 'form_input', subtype: 'contenteditable' };
    if (attrs['aria-haspopup'] === 'dialog' || attrs['aria-haspopup'] === 'true' || attrs['data-toggle'] === 'modal' || attrs['data-bs-toggle'] === 'modal')
      return { type: 'modal_trigger', subtype: tag === 'button' ? 'button' : role || 'element', target: attrs['aria-controls'] || (attrs['data-target'] || '').replace('#', '') };
    if (attrs['aria-haspopup'] === 'menu' || attrs['data-toggle'] === 'dropdown' || attrs['data-bs-toggle'] === 'dropdown' || el.classList.contains('dropdown-toggle'))
      return { type: 'dropdown_trigger', subtype: tag === 'button' ? 'button' : role || 'element', target: attrs['aria-controls'] || '' };
    if (role === 'tab' || attrs['data-toggle'] === 'tab' || attrs['data-bs-toggle'] === 'tab')
      return { type: 'tab_trigger', subtype: 'tab', target: attrs['aria-controls'] || '', selected: attrs['aria-selected'] === 'true' };
    if (tag === 'summary' || (role === 'button' && attrs['aria-expanded'] !== undefined))
      return { type: 'expand_collapse', subtype: 'button', expanded: attrs['aria-expanded'] === 'true' };
    if (tag === 'details') return { type: 'expand_collapse', subtype: 'details', expanded: el.open };
    if (role === 'switch' || attrs['aria-pressed'] !== undefined)
      return { type: 'toggle', subtype: role === 'switch' ? 'switch' : 'button', pressed: attrs['aria-pressed'] === 'true' };
    if (tag === 'button') {
      if (type === 'submit') { const f = el.closest('form'); return { type: 'form_submit', subtype: 'button', formRef: f ? assignRef(f) : null }; }
      const f = el.closest('form');
      if (f) { const btns = f.querySelectorAll('button[type="submit"], button:not([type])'); if (btns.length === 1 && btns[0] === el) return { type: 'form_submit', subtype: 'button', formRef: assignRef(f) }; }
      return { type: 'action', subtype: 'button' };
    }
    if (INTERACTIVE_ROLES.has(role)) return { type: 'action', subtype: role };
    if (style.cursor === 'pointer') return { type: 'action', subtype: 'clickable' };
    return { type: 'unknown', subtype: tag };
  }

  // Synchronous extraction for small DOMs
  function _doExtractFromList(allElements, options) {
    const actions = [];
    let step = 'loop-start';
    try {
      // Bounded default here too (2026-09-11) — the legacy sync path had the same
      // `|| 0` unbounded default, so a caller reaching it could still walk a
      // whole page. Consistency matters more than the micro-difference.
      const maxActions = options.maxActions > 0 ? options.maxActions : DEFAULT_MAX_ACTIONS;
      for (const el of allElements) {
        if (maxActions > 0 && actions.length >= maxActions) break;
        step = 'isInteractive';
        if (!isInteractive(el)) continue;
        if (options.includeHidden === false && !isVisible(el)) continue;
        if (!options.includeHidden && !isInViewport(el) && !options.full) continue;
        step = 'assignRef';
        const ref = assignRef(el);
        step = 'classifyAction';
        const classification = _cachedClassify(el);
        step = 'getAttrs';
        const attrs = getAttrs(el);
        step = 'extractState';
        const state = extractState(el);
        step = 'getLabel';
        const label = getLabel(el);
        step = 'predictEffect';
        const effect = predictEffect(el, classification, attrs);
        step = 'build-action';
        // 2026-09-25 PRIVACY: same masking as the async path above — never
        // spread a password/OTP value into a published action.
        if (isSensitiveValueField(el)) state.value = '';
        const action = { ref, type: classification.type, subtype: classification.subtype, label, predictedEffect: effect, ...state };
        // Phase 4 (2026-08-15): surface frameId from explore_page iframe recursion.
        if (el.__wsFrameId != null && el.__wsFrameId !== 0) action.frameId = el.__wsFrameId;
        // A2: expose the semantic locator (sync loop — discover_actions path)
        const loc2 = buildLocator(el);
        if (loc2 && loc2.length) action.locator = loc2[0];
        // A3: intent tag (sync loop)
        action.intent = detectIntent(el, classification);
        if (classification.href) action.href = classification.href;
        if (classification.target) action.target = classification.target;
        if (classification.formRef) action.formRef = classification.formRef;
        if (classification.expanded !== undefined) action.expanded = classification.expanded;
        if (classification.selected !== undefined) action.selected = classification.selected;
        if (classification.pressed !== undefined) action.pressed = classification.pressed;
        actions.push(action);
      }
      wsLog('EAG:loop done (sync), ' + actions.length + ' actions');
      return _buildSAG(actions, options);
    } catch (e) {
      wsLog('EAG:CRASH at step=' + step + ' | ' + e.message + ' | ' + (e.stack || '').slice(0, 600));
      throw e;
    }
  }

  function _doExtract(options, _unused) {
    const allElements = getAllElements(document.body);
    return _doExtractFromList(allElements, options);
  }

  // ═══ P1 INCREMENTAL EXPLORE (2026-08-31) ═══
  // The full SAG path re-pays settle(≤2.5s) → full classify → content/bodyText
  // extraction on EVERY call — expensive on heavy DOMs when the agent only
  // needs to know WHAT CHANGED after its last action. The incremental path
  // walks the DOM (no settle, no content extraction), compares each
  // interactive element against the LAST SCAN, and returns only the delta:
  // added / changed (with per-field changes) / removed.
  //
  // SCAN_CACHE: key(semantic identity) -> { fp, fpo, ref, label, action }.
  // Per-document — a real navigation kills the CS and wipes it automatically;
  // same-document SPA soft-navs keep it (which is the point).
  // Semantics are CANONICAL in src/incr.js (diffScan/fieldChanges/
  // identityKey/disambiguate) and unit-pinned in test-regressions.mjs. The
  // inline mirrors below must stay in lockstep with src/incr.js.
  let SCAN_CACHE = new Map();

  // MIRROR of incr.js identityKey — priority: testid > id > name > aria > ph > pos.
  function wsIdentityKey(a) {
    if (a.testid) return 'tid:' + a.testid;
    if (a.id) return 'id:' + a.id;
    if (a.name) return 'name:' + a.tag + ':' + a.name + (a.type ? ':' + a.type : '');
    if (a.ariaLabel) return 'aria:' + a.ariaLabel.slice(0, 60);
    if (a.placeholder) return 'ph:' + a.placeholder.slice(0, 60);
    return 'pos:' + a.tag + (a.type ? ':' + a.type : '') + ':' + (a.label || '').slice(0, 40) + (a.href ? ':' + String(a.href).slice(0, 40) : '');
  }

  // MIRROR of incr.js fieldChanges — per-field diff, values truncated.
  function wsFieldChanges(prevFpo, currFpo, maxLen) {
    var ml = maxLen || 40;
    var out = [];
    if (!prevFpo || !currFpo) return out;
    var keys = Object.keys(Object.assign({}, prevFpo, currFpo));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (prevFpo[k] !== currFpo[k]) {
        out.push({
          field: k,
          from: String(prevFpo[k] == null ? '' : prevFpo[k]).slice(0, ml),
          to: String(currFpo[k] == null ? '' : currFpo[k]).slice(0, ml),
        });
      }
    }
    return out;
  }

  // Fingerprint of the action-relevant fields. Password values NEVER enter
  // the fingerprint (privacy — mirrors the full path, which also masks them
  // nowhere but they only surface in explicit form extraction).
  function scanFingerprintOf(attrs, classification, label, state) {
    var t = attrs.__tag;
    var sensitive = t === 'input' && (attrs.type === 'password' || (attrs.type === 'text' && attrs.autocomplete === 'current-password'));
    var value = sensitive ? '' : (state.value == null ? '' : String(state.value));
    return {
      fp: [
        classification.type, classification.subtype, label,
        classification.href || '', classification.target || '', value,
        String(state.checked), String(state.disabled), String(state.disabledReason || ''),
        String(state.expanded), String(state.selected), String(state.pressed),
        // inViewport is DELIBERATELY NOT in the fingerprint (2026-09-21).
        // Whether an element sits inside the viewport is a SCROLL artifact, not a
        // page mutation. Including it flipped the fingerprint of every element
        // crossing the fold, so a scroll was reported as a page change (measured:
        // changedRatio 1.038 — 12 added / 40 removed — read as "the page changed").
        // state.inViewport is still recorded in fpo below for informational use.
        String(state.visible), String(state.required), String(state.readOnly),
      ].join('|'),
      fpo: {
        type: classification.type, subtype: classification.subtype, label: label,
        href: classification.href || '', target: classification.target || '', value: value,
        checked: state.checked, disabled: state.disabled,
        expanded: state.expanded, selected: state.selected, pressed: state.pressed,
        visible: state.visible, inViewport: state.inViewport,
        required: state.required, readOnly: state.readOnly,
      },
    };
  }

  // Cheap pass: walk elements, extract identity + fingerprint + a lean action
  // object. NO settle wait, NO extractHeadings/extractBodyText, NO chunked
  // yields. Dialog elements are scanned even when offscreen-viewport (the
  // modal is usually what changed).
  function collectScan() {
    const allElements = getAllElements(document.body);
    const pairs = [];
    for (const el of allElements) {
      if (!isInteractive(el)) continue;
      if (!isInViewport(el) && !el.closest('[role="dialog"],[aria-modal="true"]')) continue;
      const attrs = getAttrs(el);
      const t = el.tagName.toLowerCase();
      attrs.__tag = t;
      const classification = _cachedClassify(el);
      const label = getLabel(el);
      const state = extractState(el);
      const fp = scanFingerprintOf(attrs, classification, label, state);
      const key = wsIdentityKey({
        tag: t,
        id: attrs.id || '',
        testid: attrs['data-testid'] || attrs['data-test'] || '',
        name: attrs.name || '',
        type: attrs.type || '',
        ariaLabel: (attrs['aria-label'] || '').slice(0, 60),
        placeholder: (attrs.placeholder || '').slice(0, 60),
        label: (label || '').slice(0, 40),
        href: classification.href ? String(classification.href).slice(0, 40) : '',
      });
      pairs.push([key, { fp: fp.fp, fpo: fp.fpo, ref: null, label: String(label || '').slice(0, 60), el: el }]);
    }
    // MIRROR of incr.js disambiguate — duplicate keys get ':k<n>' in DOM order.
    const seen = new Map();
    const out = new Map();
    for (const [key, entry] of pairs) {
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      out.set(n === 0 ? key : key + ':k' + n, entry);
    }
    return out;
  }

  // STABLE REFS: incremental explores do NOT reset refCounter/refMap, so refs
  // from previous explores stay valid. Only NEW elements get fresh refs.
  // NOTE: locator/intent are NOT built here — that's the expensive part, and
  // they're only needed for the DELTA (added/changed). Enriched post-diff.
  function collectScanWithRefs() {
    const scan = collectScan();
    for (const entry of scan.values()) {
      const existing = elementSignatures.get(entry.el);
      entry.ref = existing ? existing.ref : assignRef(entry.el);
      // Lean action object — enriched with locator/intent for delta entries only.
      entry.action = {
        ref: entry.ref,
        type: entry.fpo.type,
        subtype: entry.fpo.subtype,
        label: entry.label,
        value: entry.fpo.value === '' ? null : entry.fpo.value,
        checked: entry.fpo.checked,
        disabled: entry.fpo.disabled,
        expanded: entry.fpo.expanded,
        selected: entry.fpo.selected,
      };
      if (entry.fpo.href) entry.action.href = entry.fpo.href;
    }
    return scan;
  }

  // Post-diff enrichment: build locator + intent ONLY for delta entries (the
  // agent needs to act on those; unchanged elements already have locators
  // from previous full SAGs).
  function enrichDeltaActions(delta) {
    const need = [].concat(delta.added, delta.changed.map(function (c) { return c.action; }));
    for (const action of need) {
      if (!action || !action.ref) continue;
      const el = resolveRef(action.ref);
      if (!el) continue;
      const cls = _cachedClassify(el);
      const loc = buildLocator(el);
      if (loc && loc.length) action.locator = loc[0];
      action.intent = detectIntent(el, cls);
      if (cls.href) action.href = cls.href;
    }
    return delta;
  }

  async function exploreIncremental(options) {
    wsLog('INCR:start');
    // NO settle wait — hydration settled long ago by the time an agent calls
    // incrementally; waiting would only make the delta stale.
    const scan = collectScanWithRefs();
    const hadBaseline = SCAN_CACHE.size > 0;
    const prev = SCAN_CACHE;
    // ── Inline diff (MIRROR of incr.js diffScan) ──
    const added = [], changed = [], removed = [];
    let unchangedCount = 0;
    for (const [key, e] of scan) {
      const p = prev.get(key);
      if (!p) added.push(e.action);
      else if (p.fp !== e.fp) changed.push({ action: e.action, changes: wsFieldChanges(p.fpo, e.fpo) });
      else unchangedCount++;
    }
    for (const [key, p] of prev) {
      if (!scan.has(key)) removed.push({ key: key, ref: p.ref || null, label: p.label || '' });
    }
    const totalTracked = Math.max(prev.size, scan.size);
    const changedRatio = totalTracked > 0 ? (added.length + removed.length + changed.length) / totalTracked : 0;
    const escalate = hadBaseline && totalTracked > 20 && changedRatio > 0.6;
    // Always advance the baseline — next call diffs against THIS scan.
    SCAN_CACHE = scan;

    const meta = { url: location.href, title: document.title, readyState: document.readyState };

    if (!hadBaseline || (escalate && options.full !== false)) {
      // No baseline (first call) or >60% churn → FULL extraction fallback.
      // NOTE: extractActionGraph resets refCounter/refMap — the complete SAG
      // it returns supersedes all previously handed-out refs (same contract
      // as a normal full explore). Seed the scan baseline from the result.
      const sag = await extractActionGraph(Object.assign({}, options, { incremental: undefined }));
      try { SCAN_CACHE = collectScanWithRefs(); } catch (_) {}
      sag.incremental = true;
      sag.escalated = hadBaseline; // true = churn fallback, false = first call
      return sag;
    }

    // Locator/intent only for the delta — the scan itself stays cheap.
    enrichDeltaActions({ added: added, changed: changed });

    return {
      incremental: true,
      escalated: false,
      added: added,
      changed: changed,
      removed: removed,
      unchangedCount: unchangedCount,
      changedRatio: changedRatio,
      forms: extractForms(),
      meta: meta,
      elementCount: added.length + changed.length,
      timestamp: Date.now(),
    };
  }

  // Build the full SAG result from collected actions + page metadata
