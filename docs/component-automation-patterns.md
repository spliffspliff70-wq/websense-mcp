# Platform-agnostic component-automation patterns (2026-09-01)

Distilled from the Reddit composer speed-run (see `reddit-speed-run-2026-09-01.md`).
The Reddit selectors are site-specific; **these patterns are not.** They apply to any
site built on shadow-DOM custom elements (Lit/Fast/Stencil design systems) with modern
editors (Lexical, Draft.js, ProseMirror, Slate).

Full narrative + code: the `main-world-insider.md` reference in the
websense-browser-automation skill. This file is the OSS-facing summary.

## The 7 patterns

1. **Prototype-walk state discovery (read).** Custom-element forms keep state in
   component internals, not DOM attributes. Walk `Object.getPrototypeOf(host)` for
   getters/methods (`isValid`, `form`, `submitPostForm`, `handleClick`…), then read
   properties directly. One call found the entire Reddit flair gate. Read state BEFORE
   clicking anything.

2. **Shadow-key writes (write, ~0.02s).** When names collide (`[name="title"]` matches
   both a header search box and the composer), locate the semantic shadow HOST, then
   `host.shadowRoot.querySelector(...)`, focus, native prototype setter, dispatch
   `input`+`change` with `bubbles:true`. Never bare `el.value = X`.

3. **The editor wall is per-framework.** Verified across 4 sites (same day):
   - Lexical (Reddit): HARD WALL — reverts both `execCommand('insertText')` and
     synthetic `ClipboardEvent('paste')`. Only the extension's real paste rung works.
   - Draft.js (x.com): ACCEPTS synthetic paste (0.03s). Caveats: same-call DOM reads
     return 0 (async commit — verify in a follow-up call); never `selectAll+delete`
     (corrupts editor state until reload).
   - ProseMirror/tiptap (LinkedIn): ACCEPTS synthetic paste.
   - Gmail compose: ACCEPTS synthetic paste.
   Universal diagnostic: if a main_world write doesn't ENABLE the dependent submit
   (state-truth), the write was reconciled away — don't re-read the DOM, switch strategy.
   
3b. **userScripts.execute does not await async functions.** An `async () => {}` return
   value is silently lost (result `{}`) even though side effects executed. Sync functions
   only; poll with external follow-up calls (each 0.02-0.08s).
   
3c. **Locale-proof matching.** Translated UI breaks aria-label/innerText matching
   (LinkedIn rendered Romanian: "Începeți un anunț" ≠ "Start a post"). Prefer, in order:
   class names (`.tiptap`, `.ProseMirror`, `.ql-editor`), `[data-testid]`, role+structure,
   stem-matched innerText fragments, elementFromPoint last.

4. **Synthetic-click escalation ladder.** main_world `.click()` works on native/Lit
   listeners (radios, checkboxes, plain buttons) but is swallowed by `isTrusted`-guarded
   and reCAPTCHA-armed submits. Ladder: main_world click → verify state changed →
   isolated-world `click` (auto-climbable) → OS-level real click (title-gated). Never
   repeat a rung without reading state between attempts.

5. **Shadow-tree BFS for late-mounted modals.** One generic probe walks every
   `shadowRoot` and returns interactables by `role`/tag — finds ID-addressable children
   (`modal.shadowRoot.getElementById(...)`) that beat text matching after blind
   querySelectorAll fails.

6. **Per-tab content-script wedge.** `main_world` AND `evaluate` timing out on ONE tab
   (others instant) = dead content script from a killed in-flight userScript.
   Navigate/reload/re-bind do NOT recover it — close the tab and open a fresh one.
   Prevention: no unbounded polls inside a single main_world call.

7. **Time discipline.** Per-op cost is milliseconds (writes 0.02s, state reads 0.01s,
   paste rung 1.8-2.3s). Multi-minute fills are round-trip overhead: LLM turns,
   screenshots, redundant probes. Read once → act → verify once; batch independent
   reads into one main_world call returning JSON; no screenshots inside fill loops; but
   also no unbounded mega-scripts — discrete verifiable ops, chained fast.

## Cross-site selector strategy

- Find components by semantic tag prefix (any design system: `faceplate-`, `mat-`,
  `ngt-`, `ix-`…) rather than deep CSS.
- `elementFromPoint` + z-index walk answers "what is intercepting my click".
- `new FormData(form)` cannot see shadow-root fields — don't conclude "empty" from it.
- Framework validity ≠ DOM validity: read the framework's own flag, and know it can lag
  or stick (Reddit's stays "invalid" after a successful paste — value re-read is truth).

## Enablement prerequisite

All of this requires the `main_world` insider path: Chrome 138+ per-extension
"Allow User Scripts" toggle + `userScripts.execute({world:'MAIN', js:[{code}]})`
(param renamed from `jsScripts` in Chrome 152). Full gate documentation in the
skill's `main-world-insider.md`.
