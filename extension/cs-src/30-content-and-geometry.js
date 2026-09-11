/* Markdown dump, scroll+extract, geometry, preload, eager
 * Part 03 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
  function nativeDumpMarkdown(params) {
    var maxLen = (params && params.maxLen) || 20000;
    var selector = params && params.selector;
    var root = null;
    var method = '';

    if (selector) {
      root = document.querySelector(selector);
      method = 'selector:' + selector;
      if (!root) return { success: true, markdown: '', title: document.title, url: location.href, elements: 0, method: method + ' (no match)' };
    } else {
      // Reuse readContent's main-container detection.
      var mainSelectors = siteContentSelectors().concat([
        'article', 'main', '[role="main"]',
        '.post-content', '.entry-content', '.article-content',
        '.markdown-body', '.prose',
        '[data-testid="tweetText"]',
      ]);
      for (var i = 0; i < mainSelectors.length; i++) {
        var els = document.querySelectorAll(mainSelectors[i]);
        if (els.length) {
          var best = null, bestLen = 0;
          for (var j = 0; j < els.length; j++) {
            var t = (els[j].innerText || els[j].textContent || '').trim();
            if (t.length > bestLen) { bestLen = t.length; best = els[j]; }
          }
          if (best && bestLen > 30) { root = best; method = 'main:' + mainSelectors[i]; break; }
        }
      }
      if (!root) { root = document.body; method = 'body'; }
    }

    var parts = [];
    var st = { count: 0 };
    var elementCount = 0;
    walkMarkdown(root, parts, 0, st);
    elementCount = st.count;
    var md = parts.join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (md.length > maxLen) md = md.slice(0, maxLen) + '\n\n...[TRUNCATED — raise maxLen or pass a narrower selector]';

    return {
      success: true,
      markdown: md,
      title: document.title,
      url: location.href,
      elements: elementCount,
      method: method,
    };

    function walkMarkdown(node, out, depth, st) {
      if (!node || !node.tagName) return;
      var tag = node.tagName.toLowerCase();
      if (node.nodeType === 3) { // text node
        var tx = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (tx) out[out.length - 1] = (out[out.length - 1] || '') + tx;
        return;
      }
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'iframe' || tag === 'svg' || tag === 'canvas' || tag === 'template' || tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'form' || tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'label' || tag === 'aside' || tag === 'figure') return;
      if (!isVisible(node)) return;

      // Skip empty containers quickly.
      var ownText = (node.innerText || node.textContent || '').trim();
      if (!ownText && tag !== 'img' && tag !== 'br' && tag !== 'hr' && tag !== 'table') return;

      var block = ['p','div','section','article','li','blockquote','pre','td','th','tr','table','ul','ol','h1','h2','h3','h4','h5','h6','dl','dt','dd','hr','br'].indexOf(tag) >= 0;
      if (block) {
        var prev = out.length ? out[out.length - 1] : '';
        if (prev !== '' && !/^\n+$/.test(prev)) out.push('');
      }

      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
          var lvl = parseInt(tag[1], 10);
          var ht = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (ht) { out.push(Array(lvl + 1).join('#') + ' ' + ht); st.count++; }
          return;
        }
        case 'img': {
          var src = node.getAttribute('src') || '';
          var alt = node.getAttribute('alt') || '';
          if (src) { out.push('![' + alt + '](' + src + ')'); st.count++; }
          return;
        }
        case 'a': {
          var href = node.getAttribute('href') || '';
          var at = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (at && href && href.indexOf('javascript:') !== 0) { out.push('[' + at + '](' + href + ')'); st.count++; return; }
          if (at) { out.push(at); st.count++; return; }
          break;
        }
        case 'br': out.push(''); return;
        case 'hr': out.push('---'); return;
        case 'ul': case 'ol': {
          var items = node.children;
          for (var i2 = 0; i2 < items.length; i2++) {
            var li = items[i2];
            if (li.tagName && li.tagName.toLowerCase() === 'li') {
              var lt = (li.innerText || li.textContent || '').replace(/\s+/g, ' ').trim();
              if (lt) { out.push((tag === 'ol' ? (i2 + 1) + '. ' : '- ') + lt); st.count++; }
            }
          }
          return;
        }
        case 'blockquote': {
          var qt = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (qt) { out.push('> ' + qt); st.count++; }
          return;
        }
        case 'pre': case 'code': {
          var ct = (node.innerText || node.textContent || '');
          if (ct.trim()) { out.push('```\n' + ct.replace(/\n{3,}/g, '\n\n').trim() + '\n```'); st.count++; }
          return;
        }
        case 'table': {
          var rows = node.querySelectorAll('tr');
          for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].querySelectorAll('th, td');
            var rowMd = [];
            for (var c = 0; c < cells.length; c++) rowMd.push(' ' + (cells[c].innerText || '').replace(/\s+/g, ' ').trim() + ' ');
            if (rowMd.length) out.push('|' + rowMd.join('|') + '|');
          }
          if (rows.length > 1) {
            var headerCells = rows[0].querySelectorAll('th, td');
            out.push('|' + Array(headerCells.length + 1).join(' --- |'));
          }
          st.count += rows.length;
          return;
        }
      }

      // Recurse into children for generic containers.
      var kids = node.children || [];
      for (var k = 0; k < kids.length; k++) walkMarkdown(kids[k], out, depth + 1, st);
    }
  }

  async function scrollAndExtract(params) {
    // Scroll the page N times, collecting new content after each scroll.
    // Great for infinite scroll pages (x.com timeline, lemonsqueezy product grids).
    var scrolls = (params && params.scrolls) || 5;
    var scrollDelay = (params && params.scrollDelay) || 1500; // ms between scrolls
    var maxLen = (params && params.maxLen) || 20000;
    var direction = (params && params.direction) || 'down';
    var selector = params && params.selector;
    var seenText = new Set();
    var allChunks = [];
    var result = { chunks: [], totalText: '', scrollCount: 0, url: location.href, title: document.title, finalScrollY: 0 };

    for (var s = 0; s < scrolls; s++) {
      // Scroll
      nativeScroll(direction, 500, null);
      result.scrollCount++;

      // Wait for lazy content to load
      await new Promise(function (r) { setTimeout(r, scrollDelay); });

      // Extract visible content
      var content = readContent({ selector: selector, maxLen: maxLen });
      var text = content.text || '';

      // Only keep new content we haven't seen before
      var lines = text.split('\n').filter(function (l) {
        var lt = l.trim();
        if (lt.length < 5) return false;
        if (seenText.has(lt)) return false;
        seenText.add(lt);
        return true;
      });

      if (lines.length > 0) {
        var chunk = lines.join('\n');
        allChunks.push({ scroll: s + 1, lines: lines.length, preview: chunk.slice(0, 200) });
        result.chunks.push({ scroll: s + 1, text: chunk });
      }
    }

    result.totalText = result.chunks.map(function (c) { return c.text; }).join('\n\n').slice(0, maxLen);
    result.finalScrollY = window.scrollY;
    result.totalLines = result.totalText.split('\n').length;
    return result;
  }

  // ═══ Lazy-load defeat + real scroll container ═══
  // Research-verified: x.com scrolls an INNER div — window.scrollTo is a silent
  // no-op there. Find the real scroll container, then force-eager every lazy
  // resource so explore/read see everything without manual scrolling.

  function findScrollContainer() {
    // 1. The documentElement if IT scrolls
    var de = document.documentElement;
    if (de.scrollHeight > de.clientHeight + 50) return de;
    // 2. Walk body ancestors for the tallest overflow-auto/scroll container
    var candidates = [];
    var el = document.body;
    while (el && el !== document.documentElement) {
      try {
        var st = window.getComputedStyle(el);
        var oy = st.overflowY;
        if (/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 50) {
          candidates.push({ el: el, h: el.scrollHeight - el.clientHeight });
        }
      } catch (_) {}
      el = el.parentElement;
    }
    if (candidates.length) {
      candidates.sort(function (a, b) { return b.h - a.h; });
      return candidates[0].el;
    }
    // 3. Fallback: any element with a big scrollHeight
    var all = document.querySelectorAll('div, main, section');
    var best = null, bestH = 0;
    for (var i = 0; i < all.length && i < 2000; i++) {
      var e = all[i];
      var h = e.scrollHeight - e.clientHeight;
      if (h > bestH) { bestH = h; best = e; }
    }
    return best || de;
  }

  function scrollContainerY(container) {
    if (!container) return 0;
    return (container === document.documentElement) ? window.scrollY : container.scrollTop;
  }

  // ═══ A5 (2026-08-10): GEOMETRY ANSWERS ═══
  // Spatial reasoning without vision: bounding boxes, z-order, and layout
  // relations computed against the REAL scroll container (PITFALL 31 —
  // x.com scrolls an inner div, not window). Answers "is the modal over the
  // form?", "what's above X?" from data, not pixels.
  // P0#3 (2026-08-31): convert a ref's viewport center to PHYSICAL SCREEN
  // coordinates for a genuine OS-level click. A real OS click needs screen
  // pixels, not viewport CSS pixels. Formula:
  //   screenX = window.screenX + chromeLeftX + viewportCenterX
  //   screenY = window.screenY + chromeTopY + viewportCenterY
  // where the chrome offsets are the difference between window and inner
  // (viewport) edges — tab strip + toolbar on top, scrollbar/rounding on
  // left. devicePixelRatio converts CSS px to physical px on HiDPI (the
  // caller sends these coords to the OS, which thinks in physical pixels).
  function screenCenter(refOrSelector) {
    let el = null;
    if (refOrSelector && /^E\d+$/.test(refOrSelector)) el = resolveRef(refOrSelector);
    if (!el && refOrSelector) { try { el = document.querySelector(refOrSelector); } catch (_) {} }
    if (!el) return { success: false, error: 'element not found: ' + (refOrSelector || '?') };
    const rect = el.getBoundingClientRect();
    // viewport center (CSS px)
    const vx = rect.left + rect.width / 2;
    const vy = rect.top + rect.height / 2;
    // window chrome offsets: window outer edge vs inner viewport edge
    const chromeLeft = (window.outerWidth - window.innerWidth) / 2 || 0;
    const chromeTop = (window.outerHeight - window.innerHeight) || 0;
    const screenX = (window.screenX || 0) + chromeLeft + vx;
    const screenY = (window.screenY || 0) + chromeTop + vy;
    const dpr = window.devicePixelRatio || 1;
    return {
      success: true,
      ref: refOrSelector,
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      // viewport CSS px center (what the CS/nativeClickXY uses)
      viewport: { x: Math.round(vx), y: Math.round(vy) },
      // physical screen px center (what a real OS click needs)
      screen: { x: Math.round(screenX * dpr), y: Math.round(screenY * dpr) },
      dpr: dpr,
      chrome: { left: Math.round(chromeLeft), top: Math.round(chromeTop) },
      text: (el.innerText || el.textContent || '').trim().slice(0, 60),
    };
  }

  function getGeometry(refOrSelector) {
    let el = null;
    if (refOrSelector && /^E\d+$/.test(refOrSelector)) el = resolveRef(refOrSelector);
    if (!el && refOrSelector) { try { el = document.querySelector(refOrSelector); } catch (_) {} }
    if (!el) return { success: false, error: 'element not found: ' + (refOrSelector || '?') };
    const sc = findScrollContainer();
    const rect = el.getBoundingClientRect();
    const srect = sc.getBoundingClientRect();
    // z-order: walk ancestors counting positioned elements
    let z = 0, node = el;
    while (node && node !== document.body) {
      try { const st = window.getComputedStyle(node); if (st.position !== 'static') z++; } catch (_) {}
      node = node.parentElement;
    }
    const st = window.getComputedStyle(el);
    return {
      success: true,
      ref: refOrSelector,
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      viewport: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      // Coordinates relative to the REAL scroll container (x.com inner div)
      container: { tag: sc.tagName ? sc.tagName.toLowerCase() : 'window', id: sc.id || '', cls: (sc.className || '').toString().slice(0, 40) },
      containerPos: { x: Math.round(rect.x - srect.x), y: Math.round(rect.y - srect.y + scrollContainerY(sc)), w: Math.round(rect.width), h: Math.round(rect.height) },
      scroll: { containerY: Math.round(scrollContainerY(sc)), containerMaxY: Math.round((sc.scrollHeight || 0) - (sc.clientHeight || 0)) },
      zDepth: z,
      position: st.position,
      zIndex: st.zIndex && st.zIndex !== 'auto' ? st.zIndex : null,
      text: (el.innerText || el.textContent || '').trim().slice(0, 60),
    };
  }

  // A5: layout relations — above / below / covers / overlaps
  function layoutRelation(refA, refB) {
    const a = getGeometry(refA);
    const b = getGeometry(refB);
    if (!a.success || !b.success) return { success: false, error: 'one or both elements not found' };
    const ar = a.viewport, br = b.viewport;
    const aBottom = ar.y + ar.h, bBottom = br.y + br.h;
    let relation = 'separate';
    if (ar.x < br.x + br.w && ar.x + ar.w > br.x && ar.y < bBottom && aBottom > br.y) {
      relation = 'overlaps';
      // covers: A fully contains B in both axes AND is on top (later DOM/z)
      if (ar.x <= br.x && ar.x + ar.w >= br.x + br.w && ar.y <= br.y && aBottom >= bBottom) {
        relation = (a.zDepth >= b.zDepth) ? 'covers' : 'covered_by';
      }
    } else if (aBottom <= br.y) relation = 'above';
    else if (ar.y >= bBottom) relation = 'below';
    return { success: true, relation, a: a.ref || a.tag, b: b.ref || b.tag,
      aBox: ar, bBox: br, hint: relation === 'above' ? a.tag + ' is above ' + b.tag : relation === 'covers' ? a.tag + ' covers ' + b.tag + ' (modal?)' : relation };
  }

  function forceEagerAll() {
    // (a) Native lazy loading: attribute rewrite re-triggers fetch immediately.
    var imgs = document.querySelectorAll('img[loading="lazy"]');
    var lazyCount = 0;
    for (var i = 0; i < imgs.length; i++) { imgs[i].loading = 'eager'; lazyCount++; }
    // (b) data-src / data-srcset framework loaders (lozad, vanilla-lazyload...)
    var ds = document.querySelectorAll('[data-src], [data-srcset], [data-original]');
    var dataCount = 0;
    for (var j = 0; j < ds.length; j++) {
      var d = ds[j];
      if (d.getAttribute('data-src') && !d.getAttribute('src')) { d.setAttribute('src', d.getAttribute('data-src')); dataCount++; }
      if (d.getAttribute('data-srcset') && !d.getAttribute('srcset')) { d.setAttribute('srcset', d.getAttribute('data-srcset')); }
      if (d.getAttribute('data-original') && !d.getAttribute('src')) { d.setAttribute('src', d.getAttribute('data-original')); dataCount++; }
    }
    // (c) content-visibility:auto subtrees render lazily — force visible.
    var cv = document.querySelectorAll('[style*="content-visibility"], [style*="content-visibility"]');
    var cvCount = 0;
    var cvAll = document.querySelectorAll('*');
    for (var k = 0; k < cvAll.length && k < 5000; k++) {
      try {
        var cvs = window.getComputedStyle(cvAll[k]).contentVisibility;
        if (cvs === 'auto') { cvAll[k].style.contentVisibility = 'visible'; cvCount++; }
      } catch (_) {}
    }
    // (d) synthetic resize + scroll nudge to trigger IO callbacks
    try {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
    } catch (_) {}
    return { lazy: lazyCount, dataSrc: dataCount, contentVisibility: cvCount };
  }

  async function preloadPage(params) {
    // Combined lazy-load defeat: attribute pass → scroll sweep (real container)
    // → straggler prefetch → restore scroll. Returns stats + per-step notes.
    var maxSteps = (params && params.maxSteps) || 25;
    var settleMs = (params && params.settleMs) || 250;
    var restore = (params && params.restore) !== false;
    var stats = { eager: null, steps: 0, loadedNew: 0, finalY: 0, restored: false, container: 'window' };
    var startY = window.scrollY;

    // 1. Attribute pass — free, no scroll
    stats.eager = forceEagerAll();

    // 2. Scroll sweep on the REAL container
    var container = findScrollContainer();
    if (container !== document.documentElement) stats.container = 'inner';
    var lastH = container.scrollHeight || 0;
    var plateau = 0;
    for (var s = 0; s < maxSteps; s++) {
      var before = (container.scrollHeight || 0);
      if (container === document.documentElement) window.scrollBy(0, window.innerHeight * 0.8);
      else container.scrollTop += window.innerHeight * 0.8;
      stats.steps++;
      await new Promise(function (r) { setTimeout(r, settleMs); });
      // Re-run attribute pass each step (new lazy items appear)
      var st = forceEagerAll();
      stats.loadedNew += st.lazy + st.dataSrc;
      var now = container.scrollHeight || 0;
      if (now <= lastH + 5) { plateau++; if (plateau >= 3) break; } else plateau = 0;
      lastH = now;
      if (before === now && s > 2) { /* content stopped growing; one more try then bail */ if (plateau >= 2) break; }
    }

    // 3. Straggler prefetch (safe: new Image() uses <img> creds, no CORS issue)
    var pending = [];
    var allImgs = document.querySelectorAll('img');
    for (var p = 0; p < allImgs.length && p < 500; p++) {
      var im = allImgs[p];
      if (im.complete && im.naturalWidth === 0) continue; // broken/blocked — skip
      if (!im.src && im.getAttribute('data-src')) continue; // already handled
      if (im.src && im.complete) continue;
      if (im.src) pending.push(im.src);
    }
    var prefetched = 0;
    for (var q = 0; q < pending.length && q < 100; q++) {
      try { var img = new Image(); img.fetchPriority = 'low'; img.src = pending[q]; prefetched++; } catch (_) {}
    }
    stats.prefetched = prefetched;

    // 4. Restore scroll
    if (restore) {
      if (container === document.documentElement) window.scrollTo(0, startY);
      else { container.scrollTop = startY; window.scrollTo(0, startY); }
      stats.restored = true;
    }
    stats.finalY = container === document.documentElement ? window.scrollY : container.scrollTop;
    return stats;
  }

  // ═══ Site-quirks registry (borrowed from agentreach driver-per-platform) ═══
  // Per-site tuning without code changes: content selectors, scroll behavior,
  // label priorities. Matching is by hostname regex.
