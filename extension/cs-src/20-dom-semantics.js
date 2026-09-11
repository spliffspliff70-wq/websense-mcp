/* Framework detect, visibility, interactivity, labels, classify, intent
 * Part 02 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
  let _framework = null;
  function detectFramework() {
    if (_framework) return _framework;
    try {
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) _framework = 'react';
      else if (document.querySelector('[data-reactroot], [data-reactid], div[id^="__next"]')) _framework = 'react';
      else if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) _framework = 'vue';
      else if (window.ng || document.querySelector('[ng-version]')) _framework = 'angular';
      else if (document.querySelector('[data-svelte]')) _framework = 'svelte';
      else _framework = 'vanilla';
    } catch (_) { _framework = 'vanilla'; }
    return _framework;
  }

  // ═══ Visibility Helpers ═══
  function isVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = cachedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function isInViewport(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // Element is "in viewport" if any part intersects the viewport
    const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    // Also treat zero-size interactive elements (inputs hidden by CSS but present) as in-viewport
    // so they aren't dropped from the graph when offscreen scan is off.
    return inView || (rect.width === 0 && rect.height === 0 && isVisible(el));
  }


  // ═══ Interactive Element Detection ═══
  const INTERACTIVE_TAGS = new Set(['a','button','input','select','textarea','details','summary','label','option','optgroup']);
  const INTERACTIVE_ROLES = new Set(['button','link','menuitem','menuitemradio','menuitemcheckbox','radio','checkbox','tab','switch','option','combobox','searchbox','textbox','slider','spinbutton','treeitem']);
  const INTERACTIVE_CURSORS = new Set(['pointer','move','text','grab','grabbing','cell','copy','alias','context-menu','crosshair','zoom-in','zoom-out']);

  function isInteractive(el, pre) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    // `pre` may carry visibility already computed by the caller's single geometry
    // pass (2026-09-11). Without it we would force layout again here — the old
    // code read getBoundingClientRect twice per element (once in isVisible, once
    // in isInViewport) which is a large part of the ~5ms/element cost.
    if (pre && pre.vis !== undefined) { if (!pre.vis) return false; }
    else if (!isVisible(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('inert') !== null) return false;
    if (el.isContentEditable) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    if (INTERACTIVE_TAGS.has(tag)) {
      if (tag === 'input' && el.getAttribute('type') === 'hidden') return false;
      return true;
    }
    const role = el.getAttribute('role') || '';
    if (INTERACTIVE_ROLES.has(role)) return true;
    const style = cachedStyle(el);
    if (style.cursor && INTERACTIVE_CURSORS.has(style.cursor)) return true;
    if (el.getAttribute('aria-haspopup') || el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle') || el.classList.contains('dropdown-toggle')) return true;
    if (el.tabIndex !== null && el.tabIndex >= 0) return true;
    return false;
  }

  // ═══ Element Classification ═══
  function getLabel(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return (l.innerText||l.textContent||'').trim(); }
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim();
    if (el.getAttribute('title')) return el.getAttribute('title').trim();
    if (el.getAttribute('alt')) return el.getAttribute('alt').trim();
    const text = fullText(el);
    if (text) return text.slice(0, 100);
    if (el.value && el.tagName !== 'SELECT') return String(el.value).slice(0, 50);
    return '';
  }

  // ═══ Pseudo-element / CSS content text (innerText misses ::before/::after) ═══
  function pseudoContent(el) {
    try {
      var parts = [];
      ['::before', '::after'].forEach(function (p) {
        var c = window.getComputedStyle(el, p).content;
        if (c && c !== 'none' && c !== 'normal' && c !== '""' && c !== "''") parts.push(String(c).replace(/^["']|["']$/g, ''));
      });
      return parts.join(' ');
    } catch (_) { return ''; }
  }
  function fullText(el) {
    var t = (el.innerText || el.textContent || '').trim();
    var p = pseudoContent(el);
    if (p && t.indexOf(p) === -1) t = (t + ' ' + p).trim();
    return t;
  }

  function getAttrs(el) {
    const attrs = {};
    const names = el.getAttributeNames ? el.getAttributeNames() : [];
    for (const name of names) { const v = el.getAttribute(name); if (v !== null) attrs[name] = v; }
    return attrs;
  }

  function classifyAction(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = getAttrs(el);
    const role = attrs.role || '';
    const type = attrs.type || '';
    const style = window.getComputedStyle(el);

    if (tag === 'a' && attrs.href) return { type:'navigation', subtype:'link', href:attrs.href, target:attrs.target||'_self' };
    if (tag === 'a') return { type:'action', subtype:'anchor_button' };
    if (tag === 'input' || tag === 'textarea') {
      if (type === 'checkbox') return { type:'toggle', subtype:'checkbox' };
      if (type === 'radio') return { type:'toggle', subtype:'radio' };
      if (type === 'submit' || type === 'image') { const f = el.closest('form'); return { type:'form_submit', subtype:'input_submit', formRef: f?assignRef(f):null }; }
      if (type === 'file') return { type:'file_upload', subtype:'file' };
      if (type === 'button') return { type:'action', subtype:'input_button' };
      return { type:'form_input', subtype: type||'text' };
    }
    if (tag === 'select') return { type:'form_input', subtype:'select' };
    if (el.isContentEditable || attrs.contenteditable === 'true') return { type:'form_input', subtype:'contenteditable' };
    if (attrs['aria-haspopup'] === 'dialog' || attrs['aria-haspopup'] === 'true' || attrs['data-toggle'] === 'modal' || attrs['data-bs-toggle'] === 'modal')
      return { type:'modal_trigger', subtype: tag==='button'?'button':role||'element', target: attrs['aria-controls']||(attrs['data-target']||'').replace('#','') };
    if (attrs['aria-haspopup'] === 'menu' || attrs['data-toggle'] === 'dropdown' || attrs['data-bs-toggle'] === 'dropdown' || el.classList.contains('dropdown-toggle'))
      return { type:'dropdown_trigger', subtype: tag==='button'?'button':role||'element', target: attrs['aria-controls']||'' };
    if (role === 'tab' || attrs['data-toggle'] === 'tab' || attrs['data-bs-toggle'] === 'tab')
      return { type:'tab_trigger', subtype:'tab', target: attrs['aria-controls']||'', selected: attrs['aria-selected']==='true' };
    if (tag === 'summary' || (role === 'button' && attrs['aria-expanded'] !== undefined))
      return { type:'expand_collapse', subtype:'button', expanded: attrs['aria-expanded']==='true' };
    if (tag === 'details') return { type:'expand_collapse', subtype:'details', expanded: el.open };
    if (role === 'switch' || attrs['aria-pressed'] !== undefined)
      return { type:'toggle', subtype: role==='switch'?'switch':'button', pressed: attrs['aria-pressed']==='true' };
    if (tag === 'button') {
      if (type === 'submit') { const f = el.closest('form'); return { type:'form_submit', subtype:'button', formRef: f?assignRef(f):null }; }
      const f = el.closest('form');
      if (f) { const btns = f.querySelectorAll('button[type="submit"], button:not([type])'); if (btns.length === 1 && btns[0] === el) return { type:'form_submit', subtype:'button', formRef: assignRef(f) }; }
      return { type:'action', subtype:'button' };
    }
    if (INTERACTIVE_ROLES.has(role)) return { type:'action', subtype:role };
    if (style.cursor === 'pointer') return { type:'action', subtype:'clickable' };
    return { type:'unknown', subtype:tag };
  }

  // ═══ A3 (2026-08-10): INTENT DETECTION ═══
  // Pure-JS heuristics that tag an element with its SEMANTIC PURPOSE —
  // "submit login form", "enter password", "search", "cancel modal". No LLM on
  // the page. The agent can then find elements by INTENT, not just by type.
  const INTENT_BUTTON_TEXT = {
    'submit': ['submit','send','save','ok','confirm','create','add','update','continue','next','done','apply','register','sign up','signup','get started'],
    'login': ['login','log in','sign in','signin','enter','authenticate'],
    'search': ['search','find','lookup','query','go'],
    'cancel': ['cancel','close','dismiss','back','never mind','x'],
    'delete': ['delete','remove','trash','discard','clear'],
    'logout': ['logout','log out','sign out','signout'],
    'accept': ['accept','agree','allow','yes','approve'],
    'reject': ['reject','deny','decline','no thanks','no'],
  };
  const INTENT_INPUT_TYPE = { 'password':'enter password', 'email':'enter email', 'search':'search', 'tel':'enter phone', 'number':'enter number', 'url':'enter url', 'date':'pick date', 'file':'attach file' };
  const INTENT_AUTOCOMPLETE = { 'current-password':'enter password', 'new-password':'set password', 'email':'enter email', 'username':'enter username', 'tel':'enter phone', 'one-time-code':'enter OTP' };
  const INTENT_PLACEHOLDER = { 'password':'enter password', 'email':'enter email', 'search':'search', 'username':'enter username', 'phone':'enter phone', 'otp':'enter OTP', 'code':'enter code' };

  function detectIntent(el, c) {
    try {
      const tag = el.tagName.toLowerCase();
      const attrs = getAttrs(el);
      const label = (getLabel(el) || '').toLowerCase().trim();
      const ph = (attrs.placeholder || '').toLowerCase().trim();
      const auto = (attrs.autocomplete || '').toLowerCase().trim();
      const txt = (el.innerText || el.textContent || '').toLowerCase().trim().slice(0, 30);

      // Inputs: type > autocomplete > placeholder > label
      if (tag === 'input' || tag === 'textarea') {
        const t = (attrs.type || 'text').toLowerCase();
        if (INTENT_INPUT_TYPE[t]) return INTENT_INPUT_TYPE[t];
        if (INTENT_AUTOCOMPLETE[auto]) return INTENT_AUTOCOMPLETE[auto];
        if (INTENT_PLACEHOLDER[ph]) return INTENT_PLACEHOLDER[ph];
        for (const [kw, intent] of Object.entries(INTENT_PLACEHOLDER)) { if (label.includes(kw)) return intent; }
        if (c && c.type === 'form_input') return 'enter ' + (label || t || 'value');
        return 'enter text';
      }
      // Buttons/links: text match against intent tables
      if (tag === 'button' || tag === 'a' || (c && (c.type === 'form_submit' || c.type === 'action'))) {
        const hay = txt + ' ' + label;
        for (const [intent, kws] of Object.entries(INTENT_BUTTON_TEXT)) {
          for (const kw of kws) { if (hay.includes(kw)) return intent; }
        }
        if (c && c.type === 'form_submit') return 'submit';
        return 'action';
      }
      if (c && c.type === 'modal_trigger') return 'open dialog';
      if (c && c.type === 'dropdown_trigger') return 'open menu';
      if (c && c.type === 'tab_trigger') return 'switch view';
      if (c && c.type === 'expand_collapse') return (c.expanded ? 'collapse' : 'expand');
      if (c && c.type === 'toggle') return 'toggle';
      if (c && c.type === 'file_upload') return 'attach file';
      if (c && c.type === 'navigation') return 'navigate';
      return 'unknown';
    } catch (_) { return 'unknown'; }
  }

  // A3: find elements by intent — returns refs matching a semantic intent.
  function findIntent(intentQuery) {
    const q = (intentQuery || '').toLowerCase().trim();
    if (!q) return { success: false, error: 'intent required (e.g. "submit", "password", "search")' };
    const all = Array.from(deepQueryAll('button, a, input, textarea, select, [role="button"], [role="tab"], [role="dialog"]'));
    const matches = [];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const c = classifyAction(el);
      const intent = detectIntent(el, c);
      const labelText = (getLabel(el) || '').toLowerCase();
      const hrefText = ((c.href || '') + '').toLowerCase();
      if (intent.includes(q) || q.includes(intent) || (el.getAttribute('name')||'').toLowerCase().includes(q) || (el.getAttribute('id')||'').toLowerCase().includes(q) || labelText.includes(q) || hrefText.includes(q)) {
        matches.push({ ref: assignRef(el), intent, type: c.type, subtype: c.subtype, label: getLabel(el).slice(0, 60), locator: (buildLocator(el)||[])[0] || null });
      }
    }
    return { success: true, query: q, count: matches.length, matches: matches.slice(0, 15) };
  }

  // ═══ A7 (2026-08-10): NO-DUMP CONTRACT ═══
  // explore_intent(goal): given a natural-language goal, return ONLY the
  // elements relevant to that goal — filtered in the content script, not in
  // the agent's context. Combines A3 intent tags with goal-keyword matching.
  // This is the anti-explore_page: no 125KB dump, just the handful of elements
  // that matter for the task at hand.
  const GOAL_ALIASES = {
    'submit': ['submit','send','save','confirm','ok','done','apply','continue','next','create','add','update','register','sign up'],
    'login': ['login','log in','sign in','signin','authenticate','password','username','email'],
    'search': ['search','find','lookup','query'],
    'password': ['password','pass','secret'],
    'email': ['email','mail','e-mail'],
    'cancel': ['cancel','close','dismiss','back'],
    'delete': ['delete','remove','trash','discard'],
    'upload': ['upload','attach','file','choose file'],
    'download': ['download','export','save as'],
    'filter': ['filter','sort','category'],
    'chat': ['chat','message','send','composer','reply','dm'],
    'comment': ['comment','reply','post'],
    'settings': ['settings','preferences','options','config'],
  };

  function exploreIntent(goal) {
    const g = (goal || '').toLowerCase().trim();
    if (!g) return { success: false, error: 'goal required (e.g. "submit the form", "log in", "search")' };
    // Expand the goal into keywords: goal words + aliases for matched intents
    const keywords = new Set(g.split(/\s+/).filter((w) => w.length > 2));
    for (const [intent, aliases] of Object.entries(GOAL_ALIASES)) {
      if (g.includes(intent)) { for (const a of aliases) keywords.add(a); }
      else { for (const a of aliases) { if (g.includes(a)) { for (const a2 of aliases) keywords.add(a2); break; } } }
    }
    const all = Array.from(deepQueryAll('button, a, input, textarea, select, [role="button"], [role="tab"], [role="dialog"], form'));
    const relevant = [];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const c = classifyAction(el);
      const intent = detectIntent(el, c);
      const label = (getLabel(el) || '').toLowerCase();
      const name = (el.getAttribute('name') || '').toLowerCase();
      const id = (el.getAttribute('id') || '').toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const hay = intent + ' ' + label + ' ' + name + ' ' + id + ' ' + ph;
      // Score: how many goal keywords does this element touch?
      let score = 0;
      for (const kw of keywords) { if (hay.includes(kw)) score++; }
      // An intent match on a goal keyword is the strongest signal
      if (score > 0 || Array.from(keywords).some((kw) => intent.includes(kw))) {
        relevant.push({ ref: assignRef(el), intent, type: c.type, subtype: c.subtype, label: getLabel(el).slice(0, 60), score, locator: (buildLocator(el)||[])[0] || null });
      }
    }
    relevant.sort((a, b) => b.score - a.score);
    return { success: true, goal: g, keywords: Array.from(keywords), count: relevant.length, matches: relevant.slice(0, 12),
      hint: relevant.length ? relevant.slice(0, 5).map((m) => m.intent + ' (' + m.label + ')').join(' | ') : 'no goal-relevant elements found' };
  }

  // ═══ State Detection ═══
  function detectDisabledReason(el) {
    if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') return null;
    const form = el.closest('form');
    if (form) { const req = form.querySelectorAll('input[required],textarea[required],select[required]'); for (const f of req) { if (!f.value && f.type!=='checkbox' && f.type!=='radio') return 'required_fields_empty'; } }
    if (el.getAttribute('aria-disabled') === 'true') return 'aria_disabled';
    return 'disabled';
  }

  function extractState(el) {
    const a = getAttrs(el);
    return {
      disabled: el.disabled||a['aria-disabled']==='true', disabledReason: detectDisabledReason(el),
      checked: el.checked||a['aria-checked']==='true', expanded: a['aria-expanded']==='true',
      selected: a['aria-selected']==='true', pressed: a['aria-pressed']==='true',
      required: el.required||a.required!==undefined, readOnly: el.readOnly||a.readonly!==undefined,
      valid: el.validity?el.validity.valid:null, error: el.validationMessage||null,
      value: el.value!==undefined?el.value:null, visible: isVisible(el), inViewport: isInViewport(el),
    };
  }

  function resolveUrl(href) { try { return new URL(href, window.location.href).href; } catch(_) { return href; } }

  function predictEffect(el, c, attrs) {
    switch (c.type) {
      case 'navigation': return 'navigate_to:'+resolveUrl(c.href);
      case 'form_submit': { const f=el.closest('form'); return 'submit_form:'+(f?(f.getAttribute(REF_ATTR)||'?'):'?')+' -> '+(f?(f.method||'GET').toUpperCase():'GET')+' '+(f?f.action:'current'); }
      case 'modal_trigger': return 'open_modal:#'+(c.target||'unknown');
      case 'dropdown_trigger': return 'open_dropdown:#'+(c.target||'unknown');
      case 'tab_trigger': return 'switch_tab:#'+(c.target||'unknown');
      case 'toggle': return 'toggle:'+(attrs.name||'state')+' -> '+(c.pressed||attrs['aria-checked']==='true'?'off':'on');
      case 'expand_collapse': return (c.expanded?'collapse':'expand')+':'+getLabel(el).slice(0,30);
      case 'file_upload': return 'file_upload:open_file_dialog';
      default: return 'click:unknown_effect';
    }
  }

  // ═══ Form Extraction ═══
  function findFieldLabel(input) {
    if (input.id) { const l = document.querySelector('label[for="'+CSS.escape(input.id)+'"]'); if (l) return (l.innerText||l.textContent||'').trim(); }
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label').trim();
    const lb = input.getAttribute('aria-labelledby'); if (lb) { const el = document.getElementById(lb); if (el) return (el.innerText||el.textContent||'').trim(); }
    if (input.placeholder) return input.placeholder.trim();
    const pl = input.closest('label'); if (pl) { const t = (pl.innerText||pl.textContent||'').trim(); if (t && t !== input.value) return t.slice(0,100); }
    if (input.getAttribute('title')) return input.getAttribute('title').trim();
    return '';
  }
  function findSubmitButton(form) {
    const s = form.querySelector('button[type="submit"],input[type="submit"]'); if (s) return s;
    const btns = form.querySelectorAll('button,input[type="button"]');
    for (const b of btns) { const t=(b.innerText||b.value||b.textContent||'').toLowerCase(); if (t.includes('submit')||t.includes('apply')||t.includes('send')||t.includes('save')||t.includes('next')) return b; }
    return null;
  }
  function isFormSubmittable(form) {
    const req = form.querySelectorAll('[required]');
    for (const f of req) { if (f.type==='checkbox'&&!f.checked) return false; if (f.type==='radio') { if (!form.querySelector('input[type="radio"][name="'+CSS.escape(f.name)+'"]:checked')) return false; continue; } if (!f.value||!f.value.trim()) return false; }
    return true;
  }
  function extractSelectOptions(sel) { return Array.from(sel.options).map((o)=>({value:o.value,text:(o.textContent||'').trim(),selected:o.selected})); }
  function extractForms() {
    return Array.from(document.querySelectorAll('form')).filter(isVisible).map((form) => {
      const formRef = assignRef(form);
      const fields = Array.from(form.querySelectorAll('input,select,textarea')).filter((el)=>el.type!=='hidden').map((input) => {
        const tag = input.tagName.toLowerCase();
        return { ref:assignRef(input), tag, type:input.type||(tag==='select'?'select':tag), name:input.name||'', label:findFieldLabel(input), placeholder:input.placeholder||'', value:input.value||'', required:input.required, valid:input.validity?input.validity.valid:null, error:input.validationMessage||null, checked:input.checked||false, disabled:input.disabled, options:tag==='select'?extractSelectOptions(input):undefined };
      });
      const sb = findSubmitButton(form); const sub = isFormSubmittable(form);
      return { ref:formRef, id:form.id||'', method:(form.method||'get').toLowerCase(), action:form.action||'', fields, submitRef:sb?assignRef(sb):null, submitLabel:sb?getLabel(sb):'', submitEnabled:sb?!sb.disabled&&sub:false, submitDisabledReason:sb?(sb.disabled?detectDisabledReason(sb):(!sub?'required_fields_not_met':null)):null };
    });
  }

  // getFormState (2026-08-31 full-tool sweep): the form{action:"state"} tool
  // hit "getFormState is not defined" — the function was referenced in the
  // message switch but NEVER implemented (dead tool since the 65→20 merge).
  // One-form variant of extractForms: resolves the formRef (E# or selector),
  // returns the SAME shape as a form entry in the SAG so agents can diff
  // form{state} against explore_page output directly.
  function getFormState(formRef, frameId) {
    const el = formRef ? resolveRef(formRef) : null;
    if (!el || el.tagName !== 'FORM') return { success: false, error: el ? 'ref ' + formRef + ' is not a <form> (got ' + el.tagName + ')' : 'form ref not found: ' + (formRef || '(none)') };
    const all = extractForms();
    const found = all.find((f) => f.ref === formRef) || extractForms().find((f) => f.id === (formRef||'').replace(/^#/,''));
    if (found) return { success: true, form: found };
    // Fallback: rebuild for just this form (extractForms may skip hidden forms)
    const fields = Array.from(el.querySelectorAll('input,select,textarea')).filter((i)=>i.type!=='hidden').map((input) => {
      const tag = input.tagName.toLowerCase();
      return { ref:assignRef(input), tag, type:input.type||(tag==='select'?'select':tag), name:input.name||'', label:findFieldLabel(input), placeholder:input.placeholder||'', value:input.value||'', required:input.required, valid:input.validity?input.validity.valid:null, error:input.validationMessage||null, checked:input.checked||false, disabled:input.disabled, options:tag==='select'?extractSelectOptions(input):undefined };
    });
    const sb = findSubmitButton(el); const sub = isFormSubmittable(el);
    return { success: true, form: { ref: formRef, id: el.id||'', method:(el.method||'get').toLowerCase(), action:el.action||'', fields, submitRef:sb?assignRef(sb):null, submitLabel:sb?getLabel(sb):'', submitEnabled:sb?!sb.disabled&&sub:false, submitDisabledReason:sb?(sb.disabled?detectDisabledReason(sb):(!sub?'required_fields_not_met':null)):null } };
  }

  // ═══ Content Intelligence: read_content + scroll_and_extract ═══

  function readContent(params) {
    // Smart content extraction for heavy SPA pages.
    // Tries multiple heuristics to find the main content, skipping nav/ads/sidebar.
    var maxLen = (params && params.maxLen) || 12000;
    var selector = params && params.selector;
    var result = { text: '', method: '', elements: 0, url: location.href, title: document.title };

    // Method 1: Explicit selector
    if (selector) {
      var els = document.querySelectorAll(selector);
      var texts = [];
      els.forEach(function (el) { var t = (el.innerText || el.textContent || '').trim(); if (t) texts.push(t); });
      result.text = texts.join('\n\n').slice(0, maxLen);
      result.method = 'selector:' + selector;
      result.elements = els.length;
      if (result.text.length > 0) return result;
    }

    // Method 2: Main content containers (high priority) — site quirks first, then generic
    var mainSelectors = siteContentSelectors().concat([
      'article', 'main', '[role="main"]',
      '.post-content', '.entry-content', '.article-content',
      '.product-description', '.description',
      '.markdown-body', '.prose',
      '[data-testid="tweetText"]', // x.com tweets
      '[data-testid="cellInnerDiv"]', // x.com timeline
    ]);
    for (var i = 0; i < mainSelectors.length && result.text.length < 200; i++) {
      var elements = document.querySelectorAll(mainSelectors[i]);
      result.elements += elements.length;
      var parts = [];
      elements.forEach(function (el) {
        var t = (el.innerText || el.textContent || '').trim();
        if (t.length > 30) parts.push(t);
      });
      if (parts.length > 0) {
        result.text = parts.join('\n\n').slice(0, maxLen);
        result.method = 'main:' + mainSelectors[i];
      }
    }
    if (result.text.length > 200) return result;

    // Method 3:段落 and list items extraction (good for structured content)
    var paraTexts = [];
    var paras = document.querySelectorAll('p, li, h1, h2, h3, blockquote, td, [role="text"], [data-testid]');
    paras.forEach(function (el) {
      if (!isVisible(el)) return;
      var t = (el.innerText || el.textContent || '').trim();
      if (t.length > 10 && t.length < 2000) paraTexts.push(t);
    });
    if (paraTexts.length > 5) {
      result.text = paraTexts.join('\n').slice(0, maxLen);
      result.method = 'paragraphs';
      result.elements = paraTexts.length;
      if (result.text.length > 200) return result;
    }

    // Method 4: Full body text via smarter walk (including span, a, button text)
    result.text = extractBodyText(maxLen);
    result.method = 'body-walk';
    return result;
  }

  // ── dump_markdown (borrowed from Lightpanda's --dump markdown, 2026-08-10) ──
  // Convert a page (or a selector's subtree) to clean Markdown. CSP-safe: pure
  // DOM walk, no eval. Reuses readContent's container detection for the default.
