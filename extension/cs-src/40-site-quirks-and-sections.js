/* Per-site quirks, section/heading/bodyText/pageType extraction
 * Part 04 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
  var WS_SITE_QUIRKS = [
    { host: /(^|\.)x\.com$/, quirks: { name: 'x.com', scrollMode: 'auto', contentSelectors: ['[data-testid="tweetText"]', '[data-testid="cellInnerDiv"]', 'article'] } },
    { host: /(^|\.)twitter\.com$/, quirks: { name: 'twitter', scrollMode: 'auto', contentSelectors: ['[data-testid="tweetText"]', '[data-testid="cellInnerDiv"]', 'article'] } },
    { host: /(^|\.)lemonsqueezy\.com$/, quirks: { name: 'lemonsqueezy', scrollMode: 'auto', contentSelectors: ['.product-description', '.description', 'main', 'article'] } },
    { host: /(^|\.)youtube\.com$/, quirks: { name: 'youtube', scrollMode: 'window', contentSelectors: ['#description', '#comments', 'ytd-watch-metadata'] } },
    { host: /(^|\.)github\.com$/, quirks: { name: 'github', scrollMode: 'auto', contentSelectors: ['article.markdown-body', '.comment-body', 'main'] } },
    { host: /(^|\.)linkedin\.com$/, quirks: { name: 'linkedin', scrollMode: 'auto', contentSelectors: ['.feed-shared-update-v2', '.jobs-description__content', 'main'] } },
    { host: /(^|\.)reddit\.com$/, quirks: { name: 'reddit', scrollMode: 'auto', contentSelectors: ['shreddit-post', '[data-testid="post-container"]', 'main'] } },
  ];
  function getSiteQuirks() {
    var h = location.hostname || '';
    for (var i = 0; i < WS_SITE_QUIRKS.length; i++) {
      if (WS_SITE_QUIRKS[i].host.test(h)) return WS_SITE_QUIRKS[i].quirks;
    }
    return { name: h, scrollMode: 'auto', contentSelectors: [] };
  }
  function siteContentSelectors() {
    return getSiteQuirks().contentSelectors || [];
  }

  // ═══ End Content Intelligence ═══
  function detectSections(actions) {
    const sections = []; const sectionMap = new Map();
    function addSection(el, name) { if (!el||!isVisible(el)) return null; const ref='S'+sections.length; sections.push({ref,name,elements:[],description:getLabel(el).slice(0,80)||''}); sectionMap.set(el,ref); return ref; }
    document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]').forEach((d)=>{ if(isVisible(d)) addSection(d,'modal'); });
    const h = document.querySelector('header,[role="banner"]'); if (h) addSection(h,'header');
    document.querySelectorAll('nav,[role="navigation"]').forEach((n)=>{ if(isVisible(n)) addSection(n,'navigation'); });
    const m = document.querySelector('main,[role="main"]'); if (m) addSection(m,'main');
    document.querySelectorAll('aside,[role="complementary"]').forEach((a)=>{ if(isVisible(a)) addSection(a,'sidebar'); });
    const f = document.querySelector('footer,[role="contentinfo"]'); if (f) addSection(f,'footer');
    for (const action of actions) { const el = resolveRef(action.ref); if (el) { let found=false; for (const [se,sr] of sectionMap) { if (se.contains(el)) { action.section=sr; const s=sections.find((x)=>x.ref===sr); if(s) s.elements.push(action.ref); found=true; break; } } if(!found) action.section=null; } }
    return sections;
  }

  // ═══ Content Extraction ═══
  function extractHeadings() {
    const h = []; document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el)=>{ if(isVisible(el)){const t=(el.innerText||el.textContent||'').trim(); if(t)h.push(t);} }); return h.slice(0,20);
  }
  function extractBodyText(maxLen) {
    const max = maxLen || 8000;
    // Strategy: try common content containers first, then fall back to body walk.
    // This works for React/Vue/Angular SPAs where the content is in a specific
    // container, and also for vanilla pages where body has the content.
    var text = '';

    // 1. Try article/main content containers (site quirks first, then generic)
    var contentHosts = siteContentSelectors().concat([
      'article', 'main', '[role="main"]',
      '#content', '.content', '.main-content',
      '[data-testid="tweetText"]', // x.com
      '.timeline', '.stream',
      '.post-content', '.entry-content',
      '.product-description', '.description', // e-commerce
      '[data-testid]', // generic test-id containers
    ]);
    for (var i = 0; i < contentHosts.length && text.length < max; i++) {
      var els = document.querySelectorAll(contentHosts[i]);
      for (var j = 0; j < els.length && text.length < max; j++) {
        var t = (els[j].innerText || els[j].textContent || '').trim();
        if (t.length > 50) { // only meaningful text
          text += t + '\n\n';
        }
      }
    }

    // 2. If content containers didn't yield enough, do the full body walk
    if (text.length < 200) {
      text = '';
      function walk(n) {
        if (text.length >= max) return;
        if (n.nodeType === Node.TEXT_NODE) { const s = n.textContent.trim(); if (s) text += s + ' '; return; }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const tag = n.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'svg', 'template', 'head'].includes(tag)) return;
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return;
        const style = cachedStyle(n);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (/^(div|p|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|main|aside|blockquote|pre|ul|ol|table|form|fieldset|span|a|button|label)$/i.test(tag)) text += '\n';
        for (const c of n.childNodes) walk(c);
        if (/^(div|p|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|main|aside|blockquote|pre|ul|ol|table|form|fieldset)$/i.test(tag)) text += '\n';
      }
      walk(document.body);
    }

    text = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
    if (text.length > max) text = text.slice(0, max) + '...(truncated)';
    return text;
  }
  function extractPageType() {
    const url=window.location.href.toLowerCase(), title=(document.title||'').toLowerCase();
    if(url.includes('login')||title.includes('log in')||title.includes('sign in'))return'auth';
    if(url.includes('register')||url.includes('signup')||title.includes('sign up'))return'auth';
    if(url.includes('search')||title.includes('search'))return'search';
    if(url.includes('dashboard')||title.includes('dashboard'))return'app';
    if(url.includes('settings')||url.includes('profile'))return'settings';
    if(document.querySelector('article,.article,.post,.blog-post'))return'article';
    return'generic';
  }

  // ═══ Shadow DOM + Iframe Traversal ═══
  // ═══ Candidate collection + DOM versioning (2026-09-11) ═══
  // The old path called getAllElements(document.body) — pushing EVERY element
  // node — then per element ran isInteractive (→ isVisible → getComputedStyle +
  // getBoundingClientRect) and isInViewport (→ getBoundingClientRect AGAIN).
  // Two forced-layout reads and one full computed-style resolution per element
  // in DOCUMENT ORDER. Measured ~5ms/element, so 2,206 elements ≈ 11s and
  // >5,000 elements blew the 90s budget.
  //
  // Fixes here: (1) narrow the candidate set with a selector instead of walking
  // every node; (2) one native checkVisibility() call instead of getComputedStyle;
  // (3) read each rect exactly once and pass it forward.
