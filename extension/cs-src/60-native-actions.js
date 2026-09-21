/* SAG build, native value setters, and every native* action primitive
 * Part 06 of 9 — source of truth for extension/websense-cs.js.
 * DO NOT edit the built file; edit here and run `node tools/build-cs.mjs`.
 * Split out 2026-09-11 (was one 3,7xx-line file). The code below is copied
 * VERBATIM from the pre-split file; only this banner is added.
 */
  function _buildSAG(actions, options) {
    wsLog('EAG:buildSAG actions=' + actions.length);
    try {
      wsLog('EAG:extractForms...');
      const forms = extractForms();
      wsLog('EAG:detectSections...');
      const sections = detectSections(actions);
      wsLog('EAG:extractContent...');
      const content = options.includeContent === false ? null : { headings: extractHeadings(), bodyText: extractBodyText(options.contentMaxLen || 8000) };
      wsLog('EAG:pageState...');
      const pageState = { url: window.location.href, title: document.title, readyState: document.readyState, pageType: extractPageType(), framework: detectFramework(), viewport: { w: window.innerWidth, h: window.innerHeight }, scroll: { y: window.scrollY, maxY: Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight), pagesBelow: Math.max(0, Math.ceil(((document.documentElement.scrollHeight || 0) - window.innerHeight - window.scrollY) / window.innerHeight)) } };
      wsLog('EAG:dialogs...');
      const dialogs = [];
      document.querySelectorAll('[role="dialog"][aria-modal="true"],dialog[open],.modal:not([hidden]),.ReactModal__Overlay--after-open').forEach(function (d) { if (isVisible(d)) dialogs.push({ ref: assignRef(d), label: getLabel(d).slice(0, 80) }); });
      wsLog('EAG:captcha...');
      const hasCaptcha = !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],.g-recaptcha,#captcha,[class*="captcha"]');
      const isLoading = !!document.querySelector('[aria-busy="true"],.loading,.spinner,.loader,[data-loading]');
      wsLog('EAG:navigation...');
      const navigation = actions.filter(function (a) { return a.type === 'navigation'; }).map(function (a) { return { ref: a.ref, label: a.label, target: a.href }; });
      wsLog('EAG:done successfully');
      return { meta: pageState, forms, actions, sections, navigation, content, dialogs, alerts: [], captcha: hasCaptcha, loading: isLoading, elementCount: actions.length, timestamp: Date.now() };
    } catch (e) {
      wsLog('EAG:buildSAG CRASH | ' + e.message + ' | ' + (e.stack || '').slice(0, 600));
      throw e;
    }
  }

  // ═══ Native Action Handlers (ALL CSP-safe — NO eval) ═══
  // Phase 3 (2026-08-15): walk the FULL prototype chain for the 'value' setter.
  // Custom-element inputs (Lit, Stencil, Ionic, React-controlled web components)
  // define value on a MIDDLE prototype, not the immediate one — the old
  // Object.getPrototypeOf(element) only check missed them and silently fell back
  // to el.value = value (which React/custom-elements revert on next render).
  function getNativeValueSetter(element) {
    let proto = Object.getPrototypeOf(element);
    while (proto) {
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) return d;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
  function setNativeValue(element, value) { const d = getNativeValueSetter(element); if (d&&d.set) d.set.call(element, value); else element.value = value; }

  async function nativeClick(el) {
    if (!el) throw new Error('Element not found');
    // v4 DISABLED DIAGNOSIS (2026-08-31, x.com Post-button lesson): a disabled
    // button silently "absorbs" clicks — the agent then retries blindly. Refuse
    // with a REASON instead. Checks: [disabled] attr, aria-disabled, and
    // disabled-class heuristics (X uses r-icoktb / r-3pj75a on disabled buttons).
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
      // Why is it disabled? Look for an adjacent char counter / required hint.
      let hint = null;
      try {
        const scope = el.closest('[role="dialog"], form, [data-testid]') || el.parentElement;
        const counter = scope && (scope.querySelector('[data-testid$="counter"], [class*="counter"], [aria-live]'));
        if (counter) hint = (counter.textContent || '').trim().slice(0, 40);
      } catch (_) {}
      return {
        success: false,
        refused: 'disabled-button',
        disabled: true,
        ariaDisabled: el.getAttribute('aria-disabled') === 'true',
        label: (el.textContent || '').trim().slice(0, 40),
        hint,
        reason: hint ? 'button disabled — adjacent counter says: ' + hint
                     : 'button disabled — a prerequisite (text/validation) is not satisfied; typing/clicking it cannot work',
      };
    }
    // BACKGROUND BLANK-TARGET (2026-08-13): <a target="_blank">
    // clicks make Chrome open a new ACTIVE tab, raising the OS window — the
    // remaining foreground-steal path (Bugcrowd "Submit report" is one).
    // Intercept: open the href in a BACKGROUND tab via the SW instead.
    let anchor = null;
    if (el.tagName === 'A' && (el.target === '_blank' || el.target === '_new')) anchor = el;
    else if (el.closest) { const a = el.closest('a[target="_blank"], a[target="_new"]'); if (a) anchor = a; }
    if (anchor && anchor.href && !anchor.download) {
      try {
        const href = anchor.href;
        const r = await relayTabControl('open_new_tab', { url: href, active: false });
        if (r && !r.error) return { success: true, background: true, tabId: r.tabId, blankTarget: true };
      } catch (_) { /* fall through to normal click */ }
    }
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
    const rect = el.getBoundingClientRect(); const x = rect.left+rect.width/2; const y = rect.top+rect.height/2;
    // REAL-CLICK SEMANTICS (2026-08-13, Ali directive — Bugcrowd VRT lesson):
    // a genuine mouse click lands on the TOPMOST element at the cursor, not on
    // the resolved container. React trees like Bugcrowd's VRT dropdown close on
    // container (li) clicks but expand on the inner span/button. If the resolved
    // element is a container, find the deepest clickable descendant at the point
    // and dispatch there — identical to what elementFromPoint would give a user.
    let targetEl = el;
    try {
      const top = document.elementFromPoint(x, y);
      if (top && top !== el && el.contains(top)) {
        // Walk down from the hit element to the deepest interactive child
        // (button/span/a/input/label or the deepest leaf) — mirrors a real
        // click's event target.
        let deepest = top;
        while (deepest.children && deepest.children.length > 0) {
          let hit = null;
          for (const c of deepest.children) {
            const r = c.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { hit = c; break; }
          }
          if (!hit) break;
          deepest = hit;
        }
        targetEl = deepest;
      }
    } catch (_) { targetEl = el; }
    const pOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse'};
    const mOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,button:0};
    targetEl.dispatchEvent(new PointerEvent('pointerover',pOpts)); targetEl.dispatchEvent(new PointerEvent('pointerenter',{...pOpts,bubbles:false}));
    targetEl.dispatchEvent(new MouseEvent('mouseover',mOpts)); targetEl.dispatchEvent(new MouseEvent('mouseenter',{...mOpts,bubbles:false}));
    targetEl.dispatchEvent(new PointerEvent('pointerdown',pOpts)); targetEl.dispatchEvent(new MouseEvent('mousedown',mOpts));
    try{targetEl.focus({preventScroll:true});}catch(_){}
    targetEl.dispatchEvent(new PointerEvent('pointerup',pOpts)); targetEl.dispatchEvent(new MouseEvent('mouseup',mOpts));
    targetEl.click();
    return { success: true, target: targetEl.tagName.toLowerCase(), dispatchedOn: targetEl === el ? 'resolved' : 'deepest' };
  }

  // ═══ v4 EDITOR FRAMEWORK DETECTOR (2026-08-31) ═══
  // Classifies any text-entry element so nativeType can pick the right strategy.
  // Returns { kind, framework, strategy, stateControl }.
  //   kind: input | textarea | select | editor | unknown
  //   framework: draftjs | lexical | prosemirror | slate | quill | trix |
  //              ckeditor | tinymce | google-docs | contenteditable | null
  //   strategy: value | paste | insertText | beforeinput | iframe | unsupported
  //   stateControl: selector of the dependent submit button, if discoverable
  function detectEditor(el) {
    if (!el || el.nodeType !== 1) return { kind: 'unknown', framework: null, strategy: 'none', stateControl: null };
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return { kind: 'textarea', framework: null, strategy: 'value', stateControl: null };
    if (tag === 'SELECT') return { kind: 'select', framework: null, strategy: 'select', stateControl: null };
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      // value-settable types
      if (!['checkbox','radio','file','range','color','submit','button','image','reset'].includes(t))
        return { kind: 'input', framework: null, strategy: 'value', stateControl: null };
      return { kind: 'input', framework: null, strategy: 'none', stateControl: null, inputType: t };
    }
    if (!el.isContentEditable) return { kind: 'unknown', framework: null, strategy: 'none', stateControl: null };

    // ---- contenteditable: identify the editor framework ----
    const cls = el.className || '';
    const d = (sel) => !!el.querySelector(sel);
    const up = (sel) => { let p = el.parentElement; while (p) { if (p.matches && p.matches(sel)) return true; p = p.parentElement; } return false; };

    let framework = 'contenteditable';
    let strategy = 'paste';           // default best bet for editors
    if (d('.public-DraftEditor-content') || el.hasAttribute('data-offset-key') || d('[data-offset-key]') || up('.DraftEditor-root')) framework = 'draftjs';
    else if (el.hasAttribute('data-lexical-editor') || d('[data-lexical-editor]')) framework = 'lexical';
    else if (el.classList.contains('ProseMirror') || d('.ProseMirror')) framework = 'prosemirror';
    else if (el.hasAttribute('data-slate-editor') || d('[data-slate-editor]')) framework = 'slate';
    else if (el.classList.contains('ql-editor') || up('.ql-editor') || d('.ql-editor')) framework = 'quill';
    else if (tag === 'TRIX-EDITOR' || up('trix-editor') || d('trix-editor')) framework = 'trix';
    else if (el.classList.contains('ck-editor__editable') || el.classList.contains('ck-content') || d('.ck-editor__editable')) framework = 'ckeditor';
    else if (up('.tox-edit-area') || d('.tox-edit-area')) framework = 'tinymce';
    else if (up('#docs-editor') || d('.kix-appview-editor')) { framework = 'google-docs'; strategy = 'unsupported'; }

    // iframe-hosted editor (CKEditor/TinyMCE inline frames)
    let inIframe = false;
    try { inIframe = (window.self !== window.top); } catch (_) { inIframe = true; }

    // state control: a submit-ish sibling — the "source of truth" that proves
    // the app REGISTERED our text. Walk up to the form-ish container, look for
    // button[type=submit], [data-testid*=submit], or a button mentioning post/send/submit.
    let stateControl = null;
    try {
      let scope = el.parentElement;
      for (let i = 0; i < 6 && scope && !stateControl; i++) {
        const btns = scope.querySelectorAll('button, [role="button"]');
        for (const b of btns) {
          const lbl = ((b.textContent || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
          const isSubmitish = b.getAttribute('type') === 'submit' || /submit|post|send|reply|tweet|publish|comment/.test(lbl);
          if (isSubmitish) { stateControl = b; break; }
        }
        scope = scope.parentElement;
      }
    } catch (_) {}
    const scInfo = stateControl ? {
      disabled: stateControl.disabled || stateControl.getAttribute('aria-disabled') === 'true',
      testid: stateControl.getAttribute('data-testid'),
      text: (stateControl.textContent || '').trim().slice(0, 30),
    } : null;

    return { kind: 'editor', framework, strategy, inIframe, stateControl: scInfo };
  }

  // SYNTHETIC PASTE (v4): the strategy Draft.js/Lexical/ProseMirror/Slate/Quill
  // actually honor — a ClipboardEvent with a real DataTransfer, dispatch on the
  // focused editor. CSP-safe (no eval). Returns true if a handler preventDefault()ed
  // (i.e. an editor consumed it).
  function syntheticPaste(el, text) {
    try {
      el.focus();
      // caret to end
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      dt.setData('text/html', text
        .split('\n')
        .map((l) => l.trim() === '' ? '<br>' : '<div>' + l.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>')
        .join(''));
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      // v4.2 FIX: dispatchEvent returns FALSE when a handler calls
      // preventDefault() (i.e. the editor CONSUMED it) and TRUE when the event
      // went unhandled. The old code inverted this — a consuming editor was
      // reported as not-consumed, the ladder fell through to insertText, and
      // the text was inserted TWICE (observed live 2026-08-31).
      const consumed = !el.dispatchEvent(ev);
      return { dispatched: true, consumed, text: dt.getData('text/plain') };
    } catch (e) {
      return { dispatched: false, consumed: false, error: String(e) };
    }
  }

  // STATE-TRUTH CHECK (v4): after typing, verify the app REGISTERED the text by
  // inspecting the dependent submit control. DOM text present + submit still
  // disabled = editor state didn't sync = strategy failed.
  function checkStateTruth(el) {
    try {
      const det = el.__wsEditorDetect || detectEditor(el);
      if (det.stateControl) {
        const b = det.stateControl;
        const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
        return { synced: !disabled, submitDisabled: disabled, submitLabel: det.stateControl.text };
      }
    } catch (_) {}
    return { synced: null, submitDisabled: null, submitLabel: null };
  }

  async function nativeType(el, text, clearFirst) {
    if (!el) throw new Error('Element not found');
    var cf = (typeof clearFirst !== 'undefined') ? clearFirst : true;
    nativeClick(el);
    if (cf!==false) { setNativeValue(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); }
    setNativeValue(el, text);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    if (detectFramework()==='react') el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,data:text,inputType:'insertText'}));
    // CONTENTEDITABLE SUPPORT (2026-08-31, marketing-campaign need): Draft.js /
    // Lexical editors (x.com, LinkedIn, Reddit composers) are contenteditable
    // DIVs — they have no .value, so the value-setter path above is a no-op and
    // nativeType "succeeded" while typing nothing. For these, focus + select-all
    // + document.execCommand('insertText') — CSP-safe (no eval), fires the
    // beforeinput/input events Draft.js and Lexical actually listen to, and
    // works multi-line. Verify by reading textContent instead of .value.
    if (el.isContentEditable) {
      // ═══ v4 STRATEGY LADDER (2026-08-31) ═══
      // Detect the framework, then try: synthetic paste → execCommand insertText.
      // Verify against the app's STATE TRUTH (dependent submit control), not the DOM.
      const det = detectEditor(el);
      el.__wsEditorDetect = det;
      el.focus();
      const sel = window.getSelection();
      const results = { framework: det.framework, attempts: [] };

      // CLEAR phase (shared): select-all + delete + settle ticks
      // v4.1: VERIFY the clear actually emptied the editor before inserting.
      // A framework that swallows execCommand('delete') leaves old content →
      // insertText then APPENDS (doubling bug, observed live 2026-08-31).
      // Retry up to 2x, then fall back to direct textContent wipe.
      if (cf !== false) {
        const readBackNow = () => (el.innerText || el.textContent || '').trim();
        for (let i = 0; i < 3 && readBackNow() !== ''; i++) {
          const rAll = document.createRange();
          rAll.selectNodeContents(el);
          sel.removeAllRanges(); sel.addRange(rAll);
          document.execCommand('delete', false, null);
          if (readBackNow() !== '') { el.textContent = ''; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 120));
          await new Promise((r) => setTimeout(r, 80));
        }
      }

      const readBack = () => (el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      const expected = String(text).trim();
      const textMatches = () => { const v = readBack(); return v === expected || v.replace(/\n/g, '') === expected.replace(/\n/g, ''); };

      // RUNG 1: synthetic ClipboardEvent paste (the strategy editors consume).
      // v4.2: accept on TEXT MATCH as primary signal — some editors consume the
      // event without preventDefault, and a second insertText would double it.
      const p = syntheticPaste(el, text);
      results.attempts.push({ rung: 'paste', dispatched: p.dispatched, consumed: p.consumed });
      await new Promise((r) => setTimeout(r, 250));
      if (p.dispatched && textMatches()) {
        const truth = checkStateTruth(el);
        results.attempts.push({ rung: 'verify', truth });
        return new Promise(function(resolve) {
          setTimeout(function() {
            resolve({
              success: true,
              confirmed: truth.synced === false ? 'dom-synced-state-unsynced' : (truth.synced === true ? 'editor-state-synced' : 'paste-dom-persisted'),
              actualValue: readBack().slice(0, 200),
              reverted: false,
              expected: expected.slice(0, 200),
              ...results,
            });
          }, 300);
        });
      }

      // RUNG 2: execCommand insertText (plain contenteditable fallback)
      // v4.2.1 SELF-HEAL: if the final text contains the expected text
      // MORE THAN ONCE (the doubling signature: paste inserted it AND
      // insertText appended it — observed across Chrome CS re-injection
      // races), wipe and retype once cleanly.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      const ok = document.execCommand('insertText', false, text);
      results.attempts.push({ rung: 'insertText', ok });
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(function(resolve) {
        setTimeout(function() {
          let finalVal = readBack();
          const occurrence = finalVal.split(expected.replace(/\n/g, '')).length - 1;
          if (expected.length > 0 && occurrence > 1) {
            // doubling detected — wipe (hard) and retype once
            el.textContent = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            const r3 = document.createRange();
            r3.selectNodeContents(el); r3.collapse(false);
            sel.removeAllRanges(); sel.addRange(r3);
            document.execCommand('insertText', false, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            finalVal = readBack();
            results.attempts.push({ rung: 'self-heal-retype', detected: 'doubling' });
          }
          const matches = finalVal === expected || finalVal.replace(/\n/g,'') === expected.replace(/\n/g,'');
          const truth = checkStateTruth(el);
          resolve({
            success: matches,
            confirmed: matches ? (truth.synced === false ? 'dom-synced-state-unsynced' : 'contenteditable-persisted') : false,
            actualValue: finalVal.slice(0, 200),
            reverted: !matches,
            expected: expected.slice(0, 200),
            execCommandOk: ok,
            stateTruth: truth,
            ...results,
          });
        }, 500);
      });
    }
    // Phase 3 (2026-08-15): VERIFY-PERSIST. React/custom-elements frequently
        // DISCARD the programmatic value on the next render (value shows transiently
        // then snaps back to the controlled value). The old code reported
        // success:true from the immediate el.value read — a phantom success. Now we
        // wait 2 rAF + ~400ms settle, re-read el.value, and only report success if
        // the FINAL value actually equals what we set. `confirmed` = the app persisted
        // it; `reverted` = the framework threw it away (caller must retry or report).
        // v4.3 (2026-09-01): CUSTOM-ELEMENT SHADOW INPUT strategy. Form-associated
        // custom elements (faceplate, Lit, Stencil) keep their ACTUAL input inside a
        // shadow root — the value property setter works from this world but faceplate's
        // validation state (faceplate-validity) only updates on events originating
        // INSIDE the shadow tree. execCommand('insertText') on the focused host routes
        // into the shadow input, firing proper beforeinput/input with composedPath
        // containing the host. Verified on Reddit r/mcp submit.
        return new Promise(function(resolve) {
          // v4.3: if this is a form-associated custom element and the value-setter
          // path wrote the property but the element still shows an *-validity=invalid
          // attribute, re-route via execCommand insertText to trigger shadow-DOM events.
          const isCustomElement = el.tagName.includes('-');
          const hasValidityIssue = isCustomElement && el.getAttribute('faceplate-validity') === 'invalid';
          if (hasValidityIssue) {
            try {
              el.focus();
              document.execCommand('selectAll');
              document.execCommand('delete');
              document.execCommand('insertText', false, text);
            } catch (_) {}
          }
          // v4.6.1 CONFIRMATION INTEGRITY (2026-09-11d). Two false-positive paths removed:
          //  (1) `success: matches || hasValidityIssue` granted SUCCESS from the
          //      faceplate-validity ATTRIBUTE alone, with no evidence the text was present.
          //      An attribute is not evidence — hasValidityIssue now only ever DOWNGRADES
          //      the verdict, it can never upgrade it.
          //  (2) `matches` compared el.value, which is UNDEFINED for a rich-text editor
          //      (Lexical/Draft.js/ProseMirror keep the text in child nodes). Comparing a
          //      meaningless property is how a write was reported "value-persisted" on
          //      Reddit while the editor was EMPTY. Read rendered text when there is no
          //      usable value property.
          // Also: one early match is not persistence — Lexical wipes DOM text it did not
          // author, so re-read once after a settle and trust the LAST read.
          var readBack = function(pass) {
            var isEditorEl = el.isContentEditable === true || el.getAttribute('contenteditable') === 'true';
            var hasVal = (typeof el.value === 'string' && el.value.length > 0) || (!isEditorEl && el.value !== undefined);
            var finalVal = hasVal ? String(el.value) : String(el.innerText || el.textContent || '');
            var matches = (finalVal === text) || (finalVal === String(text));
            var validity = isCustomElement ? el.getAttribute('faceplate-validity') : null;
            if (matches && pass < 2) {
              setTimeout(function() { readBack(pass + 1); }, 500);
              return;
            }
            resolve({
              success: matches,
              confirmed: matches ? (pass >= 2 ? 'value-persisted-after-settle' : 'value-persisted')
                : (hasValidityIssue ? 'unconfirmed-shadow-input-text-missing' : false),
              actualValue: finalVal.slice(0, 200),
              reverted: !matches,
              expected: String(text).slice(0, 200),
              validity,
              framework: hasValidityIssue ? 'custom-element' : undefined,
              note: matches
                ? (pass >= 2 ? 'Text still present on a second read 500ms later.' : 'Text present on first read.')
                : 'Text is NOT present at read time, so this is NOT a success. '
                  + (hasValidityIssue ? 'The custom element also reports faceplate-validity=invalid. ' : 'The framework discarded the value. ')
                  + 'Use real_paste (genuine Ctrl+V) or scripts/real_input.py paste-text for this editor.',
            });
          };
          // v4.3.1 CRITICAL FIX (2026-09-01): rAF NEVER FIRES IN BACKGROUND
          // TABS (Chrome throttles to 0 when hidden) — type_text deadlocked
          // 30s on every backgrounded tab (Reddit, LinkedIn all hit this).
          // setTimeout DOES fire when throttled (~1s), so the verify completes.
          var raf2 = function() { setTimeout(readBack, 400); };
          setTimeout(raf2, 0);
        });
  }

  function nativeSelect(el, value, clearAll) {
    if (!el) throw new Error('Element not found');
    if (el.tagName!=='SELECT') { let p=el.parentElement; while(p&&p.tagName!=='SELECT')p=p.parentElement; if(p)el=p; else throw new Error('Not a select'); }
    // v4 (2026-08-31): multi-select support — value can be a string or an array
    // (also JSON-encoded array string). Toggling option.selected fires the
    // change event React/Naive selects listen to.
    if (el.multiple) {
      let wanted = Array.isArray(value) ? value.map(String)
        : (() => { try { const j = JSON.parse(value); return Array.isArray(j) ? j.map(String) : [String(value)]; } catch (_) { return [String(value)]; } })();
      let matchedAny = false;
      const clearRest = typeof clearAll === 'boolean' ? clearAll : true;
      for (const opt of el.options) {
        const match = wanted.some((w) => opt.value === w || (opt.textContent || '').trim() === w || (opt.label || '') === w);
        if (match) { opt.selected = true; matchedAny = true; }
        else if (clearRest) { opt.selected = false; }
      }
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: matchedAny, value: [].map.call(el.selectedOptions, (o) => o.value), multi: true };
    }
    let matched=false;
    for (const opt of el.options) { if (opt.value===value||(opt.textContent||'').trim()===value||(opt.label||'')===value) { const d=getNativeValueSetter(el); if(d&&d.set)d.set.call(el,opt.value); else el.value=opt.value; matched=true; break; } }
    if (matched) { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    return { success:matched, value:el.value };
  }

  // v4 (2026-08-31): special input types — the value-setter path is wrong or
  // insufficient for these. One entry point: form_special(ref, kind, value).
  //   range    → set .value AsNumber within min/max/step + input/change
  //   color    → set .value as #rrggbb + input/change
  //   date     → set .valueAsDate (YYYY-MM-DD) + input/change
  //   time     → set .value (HH:MM, HH:MM:SS) + input/change
  //   number   → set .value via native setter (float-safe) + input/change
  //   checkbox → .checked = !!value + change (no click — idempotent set)
  //   radio    → .checked = true on the matching radio in its group + change
  async function nativeSetSpecial(el, value) {
    if (!el || el.tagName !== 'INPUT') throw new Error('Not an input');
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const set = (v) => { const d = getNativeValueSetter(el); if (d && d.set) d.set.call(el, v); else el.value = v; };
    switch (t) {
      case 'range': {
        const num = Number(value);
        if (isNaN(num)) return { success: false, refused: 'range-needs-number' };
        const min = el.min === '' ? 0 : Number(el.min);
        const max = el.max === '' ? 100 : Number(el.max);
        const step = el.step && el.step !== 'any' ? Number(el.step) : 1;
        let v = Math.min(max, Math.max(min, num));
        // snap to step
        v = min + Math.round((v - min) / step) * step;
        v = Math.min(max, Math.max(min, v));
        set(String(v)); fire();
        return { success: true, value: el.value, min, max, step };
      }
      case 'color': {
        let v = String(value).trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
          // accept #rgb or rgb() and normalize
          if (/^#[0-9a-fA-F]{3}$/.test(v)) v = '#' + v.slice(1).split('').map((c) => c + c).join('');
          else { const m = v.match(/rgb\((\d+)[,\s]+(\d+)[,\s]+(\d+)\)/); if (m) v = '#' + [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join(''); else return { success: false, refused: 'color-needs-hex' }; }
        }
        set(v); fire();
        return { success: true, value: el.value };
      }
      case 'date': case 'datetime-local': case 'month': case 'week': {
        const v = String(value).trim();
        set(v); fire();
        // verify the browser accepted it (invalid dates keep value '')
        return { success: el.value === v, value: el.value, note: el.value === v ? undefined : 'browser rejected the value format for type=' + t };
      }
      case 'time': {
        const v = String(value).trim();
        set(v); fire();
        return { success: el.value === v, value: el.value };
      }
      case 'number': {
        const num = Number(value);
        if (isNaN(num)) return { success: false, refused: 'number-needs-number' };
        set(String(num)); fire();
        return { success: el.value !== '' && !isNaN(Number(el.value)), value: el.value };
      }
      case 'checkbox': {
        el.checked = !!value && value !== 'false' && value !== '0';
        fire();
        return { success: true, checked: el.checked };
      }
      case 'radio': {
        // value may be 'true' (just check this one) or a value of the radio in its group
        const name = el.name;
        if (value === true || value === 'true' || value === '') {
          el.checked = true; fire();
          return { success: el.checked, checked: el.checked };
        }
        const group = name ? Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(name) + '"]')) : [el];
        const target = group.find((r) => r.value === String(value)) || (group.find((r) => (r.labels || [])[0] && (r.labels[0].textContent || '').trim() === String(value)));
        if (!target) return { success: false, refused: 'radio-not-found', group: group.map((r) => r.value) };
        target.checked = true; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, checked: true, value: target.value };
      }
      default:
        return { success: false, refused: 'not-special', inputType: t };
    }
  }

  function nativeToggle(el) {
    if (!el) throw new Error('Element not found');
    if (el.tagName==='INPUT'&&(el.type==='checkbox'||el.type==='radio')) { nativeClick(el); return {success:true,checked:el.checked}; }
    if (el.getAttribute('aria-pressed')!==null||el.getAttribute('role')==='switch') { nativeClick(el); return {success:true,pressed:el.getAttribute('aria-pressed')==='true'}; }
    nativeClick(el); return {success:true};
  }

  function nativeScrollIntoView(el) { if(!el)throw new Error('Element not found'); el.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'}); return{success:true}; }
  function nativeScroll(direction, amount, ref) {
    let target = document.documentElement;
    if (ref) {
      const el = resolveRef(ref);
      if (el) {
        let c = el;
        while (c && c !== document.body) {
          const st = window.getComputedStyle(c);
          if (/(auto|scroll|overlay)/.test(st.overflowY) && c.scrollHeight > c.clientHeight) { target = c; break; }
          c = c.parentElement;
        }
      }
    } else {
      // No ref: find the REAL page scroll container. x.com scrolls an inner div —
      // window.scrollBy is a silent no-op there. Fall back to documentElement.
      const sc = findScrollContainer();
      if (sc) target = sc;
    }
    // amount semantics: NEW server sends TICKS (default 1); OLD server sent raw
    // pixels (default 500). Rule: amount <= 20 → ticks (1 tick ≈ 80% viewport);
    // amount > 20 → legacy raw pixels. This keeps a running OLD server safe
    // until it restarts with the new code, and makes ticks work immediately.
    var raw = (typeof amount === 'number' && !isNaN(amount)) ? amount : 1;
    var sa;
    if (raw > 20) {
      sa = raw * (direction === 'down' || direction === 'right' ? 1 : -1);
    } else {
      var ticks = raw > 0 ? raw : 1;
      var px = Math.round(ticks * window.innerHeight * 0.8);
      if (direction === 'left' || direction === 'right') px = Math.round(ticks * window.innerWidth * 0.8);
      sa = px * (direction === 'down' || direction === 'right' ? 1 : -1);
    }
    if (direction === 'down' || direction === 'up') {
      if (target === document.documentElement) window.scrollBy({ top: sa, behavior: 'auto' });
      else target.scrollTop += sa;
    } else {
      if (target === document.documentElement) window.scrollBy({ left: sa, behavior: 'auto' });
      else target.scrollLeft += sa;
    }
    return { success: true, scrolledPx: sa, scrollY: target === document.documentElement ? window.scrollY : target.scrollTop, scrollX: target === document.documentElement ? window.scrollX : target.scrollLeft };
  }
  function nativeScrollTo(y) {
    const sc = findScrollContainer();
    const target = sc || document.documentElement;
    if (target === document.documentElement) window.scrollTo({ top: y, behavior: 'auto' });
    else target.scrollTop = y;
    return { success: true, scrollY: target === document.documentElement ? window.scrollY : target.scrollTop };
  }
  function nativePressKey(key, ref) { const t=ref?resolveRef(ref):document.activeElement||document.body; if(!t)throw new Error('Target not found'); t.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); t.dispatchEvent(new KeyboardEvent('keypress',{key,bubbles:true})); t.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true})); return{success:true}; }
  function nativeEvaluate(script) {
    // Supports both expressions and statements. Async-aware: a script whose
    // last expression is a Promise is awaited and its resolved value returned.
    try {
      const fn = new Function('"use strict"; return (async () => { ' + script + ' })();');
      const p = fn();
      if (p && typeof p.then === 'function') {
        return p.then(function (r) { return { success: true, result: serializeEvalResult(r) }; })
                .catch(function (e) { return { success: false, error: String((e && e.message) || e) }; });
      }
      return { success: true, result: serializeEvalResult(p) };
    } catch (err) {
      // new Function can be blocked by strict page CSP (LinkedIn, HN, H1).
      // Fall back to a NON-EVAL DOM reader for the common read cases.
      const msg = String((err && err.message) || err);
      const readFallback = safeDomRead(script);
      if (readFallback !== undefined) return readFallback;
      return { success: false, error: 'CSP blocked eval: ' + msg + ' — use evaluate_safe (no-eval DOM queries) or native tools', cspBlocked: true };
    }
  }
  function serializeEvalResult(r) {
    if (r === undefined) return 'undefined';
    if (r === null) return 'null';
    const t = typeof r;
    if (t === 'string' || t === 'number' || t === 'boolean') return r;
    if (r instanceof Element) return '<' + r.tagName.toLowerCase() + (r.id ? '#' + r.id : '') + (r.className && typeof r.className === 'string' ? '.' + r.className.split(/\s+/).join('.') : '') + '>';
    try { return JSON.stringify(r); } catch (_) { return String(r); }
  }
  // CSP-proof read-only DOM queries that need NO eval. Called as an automatic
  // fallback when new Function is blocked, and directly by the evaluate_safe tool.
  function safeDomRead(expr) {
    var q = String(expr || '').trim();
    if (!q) return undefined;
    var m = q.match(/^querySelector(?:All)?\((['"])(.*?)\1\)(?:\.(textContent|innerText|value|checked|href|src|options))?$/);
    if (!m) return undefined;
    var sel = m[2], kind = m[3];
    try {
      if (q.indexOf('querySelectorAll') === 0) {
        // deepQueryAll: a shadow-hosted match must be visible to the safe-query
        // path, otherwise the same selector answers found:false here while
        // explore_page lists it as an action.
        var all = deepQueryAll(sel);
        var out = [];
        for (var i = 0; i < all.length && i < 50; i++) {
          var e = all[i];
          out.push(e && e[kind] !== undefined && kind ? e[kind] : (e ? e.textContent || '' : ''));
        }
        return { success: true, method: 'safe-querySelectorAll', count: all.length, results: out };
      }
      var el = deepQuery(sel);
      if (!el) return { success: true, method: 'safe-querySelector', found: false };
      return { success: true, method: 'safe-querySelector', found: true, value: kind ? el[kind] : (el.textContent || '') };
    } catch (e) { return { success: false, error: String((e && e.message) || e) }; }
  }
  function nativeEvaluateSafe(query) {
    // Structured, no-eval DOM reader for strict-CSP pages. Modes:
    //   {selector:"input[name=email]", extract:"value"}          → single
    //   {selector:".item", extract:"text", all:true}             → array
    //   {inputs:true}                                            → all form controls
    //   {text:true}                                              → body innerText (capped)
    //   {state:true}                                             → page state snapshot
    try {
      const q = query || {};
      if (q.state) {
        const d = document;
        const inputs = Array.prototype.slice.call(deepQueryAll('input,textarea,select')).map(function (i) {
          return { tag: i.tagName.toLowerCase(), name: i.name || '', type: i.type || '', value: i.value, checked: !!(i.checked || i.selected) };
        });
        return { success: true, mode: 'state', url: location.href, title: d.title, scrollY: window.scrollY, scrollH: (d.documentElement && d.documentElement.scrollHeight) || 0, inputCount: inputs.length, inputs: inputs.slice(0, 60) };
      }
      if (q.text) {
        const t = (document.body && document.body.innerText) || '';
        return { success: true, mode: 'text', length: t.length, text: t.slice(0, q.maxLen || 20000) };
      }
      if (q.inputs) {
        const ins = Array.prototype.slice.call(deepQueryAll('input,textarea,select')).map(function (i) {
          return { tag: i.tagName.toLowerCase(), name: i.name || '', type: i.type || '', value: i.value, checked: !!(i.checked || i.selected), placeholder: i.placeholder || '', label: getLabel(i).slice(0, 60) };
        });
        return { success: true, mode: 'inputs', count: ins.length, inputs: ins.slice(0, 100) };
      }
      if (!q.selector) return { success: false, error: 'evaluate_safe needs selector, inputs:true, text:true, or state:true' };
      const el = deepQuery(q.selector);
      if (!el) return { success: true, mode: 'query', found: false, selector: q.selector,
        note: 'not found in the light DOM or in any OPEN shadow root. If the site uses a CLOSED shadow root no script can reach it — use explore_page refs or real_click at coordinates.' };
      const ex = q.extract || 'text';
      let val;
      if (ex === 'value') val = el.value !== undefined ? el.value : (el.textContent || '');
      else if (ex === 'attrs') { const o = {}; for (let i = 0; i < el.attributes.length; i++) o[el.attributes[i].name] = el.attributes[i].value; val = o; }
      else if (ex === 'html') val = el.outerHTML;
      else val = el.textContent || '';
      if (q.all) {
        const els = deepQueryAll(q.selector);
        const arr = [];
        for (let i = 0; i < els.length && i < (q.maxLen || 100); i++) {
          const e = els[i];
          if (ex === 'value') arr.push(e.value !== undefined ? e.value : (e.textContent || ''));
          else if (ex === 'attrs') { const o = {}; for (let k = 0; k < e.attributes.length; k++) o[e.attributes[k].name] = e.attributes[k].value; arr.push(o); }
          else arr.push(e.textContent || '');
        }
        return { success: true, mode: 'query-all', found: true, count: arr.length, results: arr };
      }
      return { success: true, mode: 'query', found: true, inShadow: isInShadow(el), value: val };
    } catch (e) { return { success: false, error: String((e && e.message) || e) }; }
  }
  function nativeTypeMany(fields) {
    // Batch-fill: one round trip for N fields. Each field: {ref, text, clearFirst?}
    const results = [];
    if (!Array.isArray(fields)) return { success: false, error: 'fields must be an array' };
    for (const f of fields) {
      try {
        const el = resolveRef(f.ref);
        if (!el) { results.push({ ref: f.ref, success: false, error: 'Element not found' }); continue; }
        const r = nativeType(el, f.text, f.clearFirst !== false);
        results.push({ ref: f.ref, success: r.success, actualValue: r.actualValue });
      } catch (e) {
        results.push({ ref: f.ref, success: false, error: String((e && e.message) || e) });
      }
    }
    return { success: true, filled: results.filter(function (r) { return r.success; }).length, failed: results.filter(function (r) { return !r.success; }).length, results: results };
  }

  // ═══ CATEGORY A: Advanced Native Handlers (ALL CSP-safe) ═══

  function nativeHover(el) {
    if (!el) throw new Error('Element not found');
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
    const rect = el.getBoundingClientRect(); const x = rect.left+rect.width/2; const y = rect.top+rect.height/2;
    const pOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse'};
    const mOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y};
    el.dispatchEvent(new PointerEvent('pointerover',pOpts));
    el.dispatchEvent(new PointerEvent('pointerenter',{...pOpts,bubbles:false}));
    el.dispatchEvent(new MouseEvent('mouseover',mOpts));
    el.dispatchEvent(new MouseEvent('mouseenter',{...mOpts,bubbles:false}));
    el.dispatchEvent(new PointerEvent('pointermove',pOpts));
    el.dispatchEvent(new MouseEvent('mousemove',mOpts));
    return { success: true, label: getLabel(el) };
  }

  function nativeRightClick(el) {
    if (!el) throw new Error('Element not found');
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
    const rect = el.getBoundingClientRect(); const x = rect.left+rect.width/2; const y = rect.top+rect.height/2;
    const pOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse',button:2};
    const mOpts = {bubbles:true,cancelable:true,clientX:x,clientY:y,button:2};
    el.dispatchEvent(new PointerEvent('pointerdown',pOpts));
    el.dispatchEvent(new MouseEvent('mousedown',mOpts));
    el.dispatchEvent(new PointerEvent('pointerup',pOpts));
    el.dispatchEvent(new MouseEvent('mouseup',mOpts));
    el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:2}));
    return { success: true };
  }

  function nativePressKeyEnhanced(key, ref, modifiers) {
    modifiers = modifiers || [];
    const target = ref ? resolveRef(ref) : document.activeElement || document.body;
    if (!target) throw new Error('Target not found');
    const opts = { key, bubbles: true, cancelable: true };
    if (modifiers.includes('ctrl')) opts.ctrlKey = true;
    if (modifiers.includes('shift')) opts.shiftKey = true;
    if (modifiers.includes('alt')) opts.altKey = true;
    if (modifiers.includes('meta')) opts.metaKey = true;
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { success: true, key, modifiers };
  }

  function nativeDragDrop(fromEl, toEl) {
    if (!fromEl) throw new Error('Source element not found');
    if (!toEl) throw new Error('Target element not found');
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const fx = fromRect.left+fromRect.width/2, fy = fromRect.top+fromRect.height/2;
    const tx = toRect.left+toRect.width/2, ty = toRect.top+toRect.height/2;
    var dt; try { dt = new DataTransfer(); } catch(_) { dt = { data: {} }; }
    fromEl.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, clientX:fx, clientY:fy, dataTransfer:dt }));
    fromEl.dispatchEvent(new DragEvent('drag', { bubbles:true, cancelable:true, clientX:fx, clientY:fy, dataTransfer:dt }));
    toEl.dispatchEvent(new DragEvent('dragenter', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    toEl.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    toEl.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    fromEl.dispatchEvent(new DragEvent('dragend', { bubbles:true, cancelable:true, clientX:tx, clientY:ty, dataTransfer:dt }));
    return { success: true };
  }

  function nativeClickXY(x, y, ref, button) {
    button = button || 'left';
    const btnNum = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
    let clientX = x, clientY = y;
    let targetEl = document.elementFromPoint(clientX, clientY);
    if (ref) { const el = resolveRef(ref); if (el) { const rect = el.getBoundingClientRect(); clientX = rect.left + x; clientY = rect.top + y; targetEl = document.elementFromPoint(clientX, clientY) || el; } }
    if (!targetEl) targetEl = document.body;
    const pOpts = {bubbles:true,cancelable:true,clientX,clientY,pointerType:'mouse',button:btnNum};
    const mOpts = {bubbles:true,cancelable:true,clientX,clientY,button:btnNum};
    targetEl.dispatchEvent(new PointerEvent('pointerover',pOpts));
    targetEl.dispatchEvent(new MouseEvent('mouseover',mOpts));
    targetEl.dispatchEvent(new PointerEvent('pointerdown',pOpts));
    targetEl.dispatchEvent(new MouseEvent('mousedown',mOpts));
    try{targetEl.focus({preventScroll:true});}catch(_){}
    targetEl.dispatchEvent(new PointerEvent('pointerup',pOpts));
    targetEl.dispatchEvent(new MouseEvent('mouseup',mOpts));
    if (button === 'right') targetEl.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX,clientY,button:2}));
    else targetEl.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX,clientY,button:btnNum}));
    return { success: true, x: clientX, y: clientY, target: targetEl.tagName.toLowerCase() };
  }

  function nativeCopyToClipboard(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch(_) {}
    document.body.removeChild(ta);
    return { success: ok };
  }

  function locateFileInput(startEl) {
    if (!startEl) return null;
    if (startEl.tagName === 'INPUT' && startEl.type === 'file') return startEl;
    // search descendants of the clicked/labeled element
    let f = startEl.querySelector && startEl.querySelector('input[type="file"]');
    if (f) return f;
    // search ancestors (e.g. label wrapping the input)
    let p = startEl.parentElement;
    while (p) {
      if (p.tagName === 'INPUT' && p.type === 'file') return p;
      const inner = p.querySelector && p.querySelector('input[type="file"]');
      if (inner) return inner;
      p = p.parentElement;
    }
    // Last resort: the file input NEAREST to startEl — NOT simply the first one
    // on the page.
    //
    // BUG (found 2026-09-21, measured on LemonSqueezy): this returned all[0].
    // On any form with an image/avatar file input BEFORE the document input —
    // which is most storefronts and CMSes — an upload silently targeted the WRONG
    // field, while still reporting success:true / fileCount:1 /
    // confirmed:"preview-visible". A .zip was repeatedly attached to the
    // product-IMAGE input while the file input stayed empty.
    //
    // deepQueryAll: a file input built by a web component (common in rich
    // composers) lives in a shadow root — missing it made upload fall through to
    // the drop-zone strategy and report a false negative.
    const all = deepQueryAll('input[type="file"]');
    if (!all.length) return null;
    if (all.length === 1) return all[0];
    let best = all[0];
    let bestScore = -1;
    for (let i = 0; i < all.length; i++) {
      const score = domCloseness(startEl, all[i]);
      if (score > bestScore) { bestScore = score; best = all[i]; }
    }
    return best;
  }

  // Higher = more closely related: the depth of the deepest shared ancestor, so a
  // sibling/child input outranks an unrelated one in another form section.
  function domCloseness(a, b) {
    if (!a || !b) return 0;
    const chain = (el) => {
      const out = [];
      let c = el;
      while (c) { out.push(c); c = c.parentElement || (c.getRootNode && c.getRootNode().host) || null; }
      return out;
    };
    const A = chain(a);
    const inB = new Set(chain(b));
    for (let i = 0; i < A.length; i++) {
      if (inB.has(A[i])) return A.length - i;
    }
    return 0;
  }
  // ═══ Upload — multi-strategy + honest confirmation (agentreach pattern) ═══
  // Strategy 1: real <input type=file> via native 'files' setter + events.
  // Strategy 2: drop-zone (no visible input) — DataTransfer drop event on the
  //   upload zone. Confirmation is POSITIVE-ONLY: success:true means the file
  //   landed in the input / drop registered AND (where possible) the page
  //   showed evidence of accepting it. Never claims confirmed without proof.

  function makeFileFromBase64(base64, fileName, mimeType) {
    const bin = atob(base64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], fileName, { type: mimeType || 'application/octet-stream' });
  }

  function isDropZone(el) {
    if (!el) return false;
    const cls = (el.className || '').toString().toLowerCase();
    const testid = (el.getAttribute('data-testid') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (testid.indexOf('upload') !== -1) return true;
    if (cls.indexOf('dropzone') !== -1 || cls.indexOf('drop-zone') !== -1 || cls.indexOf('upload-drop') !== -1 || cls.indexOf('upload-area') !== -1 || cls.indexOf('uploader') !== -1 || cls.indexOf('file-drop') !== -1) return true;
    if (aria.indexOf('upload') !== -1 || aria.indexOf('drop') !== -1) return true;
    return false;
  }

  function findDropZone(startEl) {
    if (startEl) {
      // ancestors + self
      let el = startEl;
      while (el) {
        if (isDropZone(el)) return el;
        el = el.parentElement;
      }
      // descendants
      const inner = startEl.querySelector && startEl.querySelector('[data-testid*="upload"],[class*="dropzone"],[class*="drop-zone"],[class*="upload-area"],[class*="uploader"],[class*="file-drop"],[class*="upload-drop"]');
      if (inner) return inner;
    }
    const all = deepQueryAll('[data-testid*="upload"],[class*="dropzone"],[class*="drop-zone"],[class*="upload-area"],[class*="uploader"],[class*="file-drop"],[class*="upload-drop"],[aria-label*="upload"],[aria-label*="drop"]');
    for (let i = 0; i < all.length; i++) if (isDropZone(all[i])) return all[i];
    return null;
  }

  function pageShowsFileName(fileName) {
    // Positive confirmation heuristic: the filename (or its base) appears in
    // visible page text / previews shortly after upload.
    const base = String(fileName || '').replace(/\.[^.]+$/, '').toLowerCase();
    if (!base || base.length < 3) return null; // can't verify reliably
    try {
      const t = (document.body.innerText || '').toLowerCase();
      if (t.indexOf(base) !== -1) return true;
    } catch (_) {}
    return false;
  }

  async function nativeUploadFromBase64(inputEl, base64, fileName, mimeType) {
    const file = makeFileFromBase64(base64, fileName, mimeType);

    // ── Strategy 1: real file input ──
    const realInput = locateFileInput(inputEl);
    if (realInput) {
      const dt = new DataTransfer(); dt.items.add(file);
      try {
        realInput.files = dt.files;
      } catch (_) {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files');
        if (d && d.set) d.set.call(realInput, dt.files);
      }
      realInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      realInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      // v4.6.1 UPLOAD FALSE-NEGATIVE FIX (2026-09-11d). `realInput.files.length` is read
      // back in the ISOLATED world, where the File/DataTransfer are realm-local. On
      // strict-CSP pages Chrome reports an EMPTY FileList even when the file DID attach,
      // so this reading produced "Input rejected the file" for uploads that had in fact
      // succeeded — three copies of one video landed on a post the tool insisted had
      // failed. NEVER assert failure from it: prefer page-side evidence, and otherwise
      // report UNCONFIRMED rather than wrong.
      const realmCount = realInput.files ? realInput.files.length : 0;
      await new Promise((r) => setTimeout(r, 700));   // let the app render a preview
      let shown = false;
      try { shown = pageShowsFileName(file.name) === true; } catch (_) {}
      // The read-back is ASYMMETRIC, and that asymmetry is the whole fix:
      //   count > 0  => the file IS on the input (positive evidence)
      //   count == 0 => proves NOTHING (see above) — never a rejection
      // Measured on bench/shadow_fixture.html 2026-09-11d: a matching AND a
      // mismatched file both read back 1, so Chrome does NOT filter a
      // programmatically-assigned FileList by the input's `accept`. The
      // read-back is therefore never grounds for asserting failure.
      const attached = shown === true || realmCount > 0;
      return {
        success: attached,
        method: 'file_input',
        fileCount: realmCount,
        fileName: file.name,
        fileSize: file.size,
        confirmed: shown === true ? 'preview-visible'
          : (realmCount > 0 ? 'input-has-file' : 'unconfirmed-realm-readback'),
        realmReadbackUnreliable: realmCount === 0,
        note: shown === true
          ? 'File attached — the page shows it.'
          : (realmCount > 0
            ? 'File is on the input (read-back confirms ' + realmCount + '), but no page preview yet — the widget may not have processed it.'
            : 'The isolated-world read-back returned 0, which is NOT evidence of failure on a strict-CSP page (the File is realm-local). Check the page/preview directly, or use real_paste (genuine CF_HDROP) / scripts/real_input.py paste-file.'),
      };
    }

    // ── Strategy 2: drop-zone (no visible input) ──
    const zone = findDropZone(inputEl);
    if (!zone) throw new Error('No file input or upload drop-zone found for ref');
    const dt2 = new DataTransfer(); dt2.items.add(file);
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    zone.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    // Positive confirmation: wait a beat for the page to render a preview/name.
    // P2 (2026-08-31): MANY apps process the drop asynchronously (upload →
    // XHR → re-render), so a synchronous filename check can return false even
    // though the file LANDED. Re-check after 500ms before declaring
    // 'unconfirmed' — this is the fix for the phantom confirmed:false that
    // made agents retry into duplicates on GitHub's dropzone.
    let shown = pageShowsFileName(fileName);
    if (!shown) {
      await new Promise((r) => setTimeout(r, 500));
      shown = pageShowsFileName(fileName);
    }
    return {
      success: true,
      method: 'dropzone',
      fileName: file.name,
      fileSize: file.size,
      confirmed: shown === true ? 'preview-visible' : 'unconfirmed',
      note: shown === true ? 'Drop dispatched and page shows the filename.' : 'Drop dispatched but no filename preview detected after 500ms — verify visually before claiming success.',
    };
  }

  // ═══ v4 Strategy 3: CLIPBOARD-PASTE into editors (2026-08-31) ═══
  // Rich-text editors (x.com composer, Discord, Slack, Notion) accept images /
  // files via the paste pipeline — no file input, no dropzone. Synthetic
  // ClipboardEvent('paste') carrying the file as a DataTransfer item, with the
  // editor focused. consumed=true (handler called preventDefault) means the
  // editor took it. Positive-only confirmation per PRINCIPLE 5.
  async function nativeUploadPasteIntoEditor(targetEl, base64, fileName, mimeType) {
    try {
      const file = makeFileFromBase64(base64, fileName, mimeType);
      const det = detectEditor(targetEl);
      if (det.kind !== 'editor') {
        return { success: false, refused: 'not-an-editor', note: 'paste-upload targets rich-text editors; use file_input/dropzone strategies for inputs' };
      }
      targetEl.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      // v4.2 FIX: dispatchEvent false == handler consumed (preventDefault)
      const consumed = !targetEl.dispatchEvent(ev);
      // Editor marks handling asynchronously — give it a beat, then look for
      // ANY evidence the file registered (preview node, filename text, upload chip).
      await new Promise((r) => setTimeout(r, 600));
      const shown = pageShowsFileName(fileName);
      return {
        success: consumed,
        method: 'editor_paste',
        framework: det.framework,
        fileName: file.name,
        fileSize: file.size,
        confirmed: shown === true ? 'preview-visible' : (consumed ? 'consumed-unverified' : 'unconfirmed'),
        note: shown === true ? 'Paste dispatched and page shows the file.'
            : consumed ? 'Paste event was consumed by the editor but no preview detected — verify before claiming success.'
            : 'Editor did not consume the paste event.',
      };
    } catch (e) {
      return { success: false, method: 'editor_paste', error: String(e) };
    }
  }

  // ═══ Network Request Capture ═══
