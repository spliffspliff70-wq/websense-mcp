# WebSense — Model Prompt (MIRROR of what `websense_guide` returns)

`src/server.js` is the **single source of truth** for the in-tool prompt. The
block below is generated from it, so this file can never drift into teaching an
agent something the running server does not say.

To regenerate after changing the guide text in `src/server.js`:

```
node tools/export-guide.mjs        # rewrites the fenced block below
```

> **What changed on 2026-09-25.** This file used to be a hand-maintained copy of
> a 21-tool guide that the server had long since replaced with a 31-tool one —
> a mirror of a deleted document, with its own stale claims (mutated:false means
> "not landed", JS dialogs "captured, NOT blocking", evaluate blocked only on
> "strict sites", escalate to real_click on unverifiable). It is now generated
> from the live text, and three regression tests assert the mirror is fresh so
> the drift cannot come back.

> Also note: `websense_doctor` is **not** a tool (it is `status kind:"doctor"`), and
> `evaluate_safe` is **not** a tool (it is `evaluate {query:{…}}`).

---

```
WebSense MCP — Guide (7 listed / 37 registered)
==============================================
Non-vision web automation via Chrome extension. No CDP debug port, no bot detection. CSP-safe. React/Vue/Angular compatible.

START HERE: browse{url} — ONE call that navigates, seeds the page's diff baseline, stores a lossless inventory and returns only the small INDEX + the vocabulary this page actually uses. Then find{query} to locate a control (it tells you WHERE it is — region, position, and the branch it sits in — and WHAT it is, from the page's own role/name/attributes), page_slice to load just that branch at full fidelity, then act.

DID IT LAND? Every mutating op (click, type_text, form, press_key, real_click, real_paste, main_world, evaluate, dialog) returns a SECOND block: DIFF (auto, after <op>) — the change since your browse baseline, grouped so you cannot confuse churn with truth:
  structure — the page's SHAPE changed (elements added/removed, tag/role/name/attrs changed). Page truth.
  content   — the SAME element's value/text changed and its shape did not. The page answered you.
  viewport  — ONLY vp/x/y differ. This is scroll/layout churn and is NOT a mutation. It used to be reported as one (a scroll measured changedRatio 1.038, "12 added / 40 removed") because the old diff compared the interactive+in-viewport subset, which changes as you scroll.
mutated is true when structure or content moved. The baseline for any page is the first collection after that page loaded, and it is held BY THE PAGE, so navigating gives you a fresh one automatically. Pass verify:false to skip the diff on a call you don't need checked.
A NAVIGATION IS THE STRONGEST CONFIRMATION AND IT IS NOT IN THE GROUPS: when click or press_key (Enter/Space) replaces the document, the result carries effect:"confirmed" plus a navigation {from,to} — and the DIFF line says so explicitly, because a diff taken across a navigation compares two different documents and its groups are meaningless. Measured: clicking HN's "newest" and books.toscrape's "next" both navigated while the old code answered suspected_noop + mutated:false, i.e. it told you a click that worked had done nothing. Also: an untrusted synthetic Enter runs NO default action, so press_key Enter on a form field now calls form.requestSubmit() for you and reports defaultAction when it does.

FULL PAGE MAP vs A SLICE: browse / page_snapshot collect a LOSSLESS inventory of the page (nothing filtered out — not interactive-only, not in-viewport-only) and return only a small INDEX (counts + the dimensions you can slice by). find and page_slice then fetch only what you ask for, at full fidelity. The inventory is scroll-stable: it does not churn the way a viewport-filtered scan does, because it is not a subset that changes as you scroll — which is also why the DIFF can tell viewport churn from real mutation. Elements carry a parent pointer, so the BRANCH an element sits in is data you can walk, not a diagram you have to render. Cost measured on github.com/nodejs/node: index 690 B vs a 116,573 B explore_page, over 3,842 elements.

THE 7 LISTED TOOLS — what each absorbed from the old 65-tool surface:
  act              DO something: action=click|hover|rightclick|drag|type|key|form|upload|scroll|dialog. how="trusted" goes through the browser's own input pipeline (a real isTrusted event, default actions run); how="os" is OS-level input and needs the tab in front. This is the one to reach for.
  debug            WebSense itself + raw reads: op=status|session|logs|cookies|clipboard|screenshot|ax|evaluate|main_world|explore_page|reload|respawn|guide. Reach for it when something is wrong.
  websense_guide   this guide
  browse           TOOL 1 — go to a page and map it in one call: navigate (or bind) + seed the diff baseline + store the inventory + return ONLY the index + the vocabulary. Replaces navigate+page_snapshot+map read.
  find             TOOL 2 — search the stored inventory; each hit gives WHERE (region, position, branch chain resolved from parent pointers) and WHAT (the page's own role/name/attrs/state). Returns ALL matches.
THE REMAINING 30 — registered and callable by name, but NOT listed, so a model does not have to choose between them. The listed ones (page_slice, tabs) also appear here:
  explore_page     quick look at a page's actions (SAG). compact:true = old discover_actions; intent:"submit" = old find_intent; goal:"log in" = old explore_intent; preload:true = lazy-load first; incremental:true = delta since last scan (you usually do NOT need this any more: every mutating op returns a grouped DIFF automatically; for a full page map use browse + find instead — explore_page is the quick look, not the map)
  read             page text. format: "text" (extract_text) | "content" (read_content) | "markdown" (dump_markdown) | "diff" (page_diff) | "scrollextract" (scroll_and_extract) | "preload" (preload_content)
  click            click ref (default) | mode:"hover" | mode:"rightclick" | mode:"drag" (fromRef/toRef) | x,y for canvas (old click_xy)
  trusted_click    click through the BROWSER'S OWN input pipeline (chrome.debugger + Input.dispatchMouseEvent) instead of dispatching an event. The page receives exactly what a real mouse produces — click isTrusted:true, detail:1, the real clientX/Y, and the move that precedes the press applies :hover and feeds mousemove — and default actions run the way the browser runs them. Still background: no OS focus, no window activation, no bring-to-front. Measured on bench/click_fingerprint.html across a button, a checkbox, a link and an input: every one reports isTrusted=true/detail=1/real coordinates, and every one's default action fires. Reach for it when a page checks isTrusted, reads detail/coordinates/buttons, is a canvas or a custom control, or when click reports success and the page ignores it. Pass ref — it resolves the element box itself.
  trusted_key      type and/or press a key through the BROWSER'S OWN input pipeline (chrome.debugger + Input.dispatchKeyEvent) instead of dispatching a KeyboardEvent. The page receives trusted key events and the BROWSER runs the DEFAULT ACTION — an Enter in a form SUBMITS it, Tab moves focus — instead of us guessing at it with form.requestSubmit(). Still background: no OS focus, no window activation, no bring-to-front. One call does a fill AND a submit: text types a string key by key, key presses one key after it (the usual fill-then-Enter). Pass ref to focus the target first — the reply carries the focus outcome, because a key with no focus goes to body and lands nowhere, which looks exactly like "the key did nothing". Reach for it where press_key lands nothing silently, where a key must trigger a page behaviour, or where the page checks isTrusted. Measured: a fill+Enter on the fixture reports isTrusted:true and the form's submit EVENT fires.

CLICK FIDELITY — measured on bench/click_fingerprint.html, field by field, so you know which to reach for:
  Both paths RUN DEFAULT ACTIONS. That was worth measuring: click finishes with
  HTMLElement.click(), which performs activation behaviour, so it DOES toggle a checkbox, follow a
  link and focus an input. (I had written the opposite here before measuring — it was wrong.)
  What click cannot do is produce a TRUSTED event, and that is the whole difference:
                              click (dispatchEvent)        trusted_click (browser input pipeline)
    click.isTrusted           false                        true
    click.detail              0                            1
    click.clientX / clientY   0 / 0                        the real point (e.g. 83, 147)
    pointermove/mousemove     absent — no move before press present, as a mouse does
    events a real click has   adds pointerenter/mouseenter  exactly the browser's own sequence
                              (visible to capture listeners)
  So: use click for the great majority of React/Vue apps, which listen for the event and never
  inspect its trust. Reach for trusted_click when the page checks isTrusted, reads
  detail/coordinates/buttons, is a canvas or a custom control, or behaves differently between a
  real event and a dispatched one — and when a default action matters and you want it produced the
  way the browser produces it.
  COST: measured ~140-990ms per call (chrome.debugger attach is ~2-3ms and is REUSED for 25s, so a
  burst pays it once; the rest is the page's own handling). While attached Chrome shows its
  "debugging this browser" infobar. No OS focus, no window activation, no bring-to-front — the tab
  stays in the background and YOUR active tab is never touched.
  HOW IT REACHES A BACKGROUND TAB AT ALL: the browser drops input into a renderer that reports
  itself hidden. Measured: without the two emulation calls below, mouseMoved took 5,080ms and the
  PRESS WAS DROPPED ENTIRELY — no pointerdown/mousedown/click reached the page. trusted_click
  therefore sends Emulation.setFocusEmulationEnabled(true) and Page.setWebLifecycleState('active')
  first, which make a background renderer behave as a focused, active page. Same click afterwards:
  151ms and a full trusted sequence.
  Real OS input (real_click) remains the last rung: it is a genuine OS event, needs the window
  visible and foregrounded, and is the only path that survives a page which rejects programmatic
  input outright.
  type_text        fill one input (React-safe native setter) — or fields:[{ref,text},...] for batch (old type_many). Batch fills are SEQUENTIAL with a persistence check per field, so a 50-field batch takes ~50s; it reports filled/failed from the verified result, not from whether the write was dispatched. Password/OTP values are never echoed back.
  form             action:"state" (form_state) | "select" (ref,value) | "toggle" | "upload" (ref,filePath)
  reveal           pre-extract hidden content without opening it: kind:"dropdown" (ref = the trigger → its options) | "tabs" (ref optional → tab panels) | "accordion" (ref optional → details/summary). Works with E# or CSS refs.
  scroll           direction+amount (ticks, 1 tick ≈ 80% viewport) | y:<px> absolute (scroll_to) | intoView:"E5" (scroll_into_view)
  tabs             action:"list" | "switch" | "close" | "bind" (no focus) | "windows" | "focus" | "move" | "transfer" (cross-tab copy/paste) | "switchread"
  status           kind:"page" (page_state) | "bridge" (get_status) | "doctor" (diagnostics) | "downloads"
  wait             poll until conditions met (urlContains/hasModal/hasCaptcha/notLoading/pendingDialogsGt/selector/script/timeoutMs/pollMs) — old wait_for; or event:"dialog_open|navigation|network|..." — old wait_for_event
  evaluate         script:<js> runs and RETURNS ITS VALUE. The isolated-world path uses new Function, which the extension's own MV3 CSP blocks — so on a CSP block it transparently re-routes through the MAIN world (chrome.userScripts, no eval) and reports via:"main_world". Works on every page. query:{selector,extract,all,inputs,text,state} is the no-eval read path (preferred for plain reads). Password/OTP values are always masked.
  ax               native accessibility tree via chrome.debugger (Chrome's EXTENSION API — ALLOWED, unlike a CDP debug port): action:"state"|"read"|"click"|"type" + tabId (+ match/role/name). For canvas SPAs & chrome:// pages
  screenshot       captureVisibleTab → PNG/JPEG dataUrl for a vision model
  press_key        key + modifiers ["ctrl","shift","alt","meta"], optional ref target. SYNTHETIC KeyboardEvents only — it does NOT perform default browser actions: ctrl+a does not select, letter keys do not insert text. It fires page JS key handlers and nothing else. Use type_text for text entry.
  dialog           JS dialogs: action:"accept"|"dismiss" + value (prompt). CAPTURES THE PAGE'S OWN alert/confirm/prompt via a MAIN-world hook — status lists them in pendingDialogs (waiting) and recentDialogs (already fired); the answer reaches the page's promise. Check recentDialogs after any destructive-looking click. DOM [role=dialog] modals: close by ref (hasModal/dialogCount are visibility-BLIND). keystroke:true + key for OS-level dialogs (enter|escape|tab|f5|ctrl+c)
  session          action:"reset" (clears YOUR map + history only — since 1.4.7 each MCP session has its own SessionManager, so it no longer wipes other jobs) | "map" (exploration graph) | "mermaid" (flowchart export). History stores the text you typed.
  network_log      captured fetch/XHR since last call (clear, maxEntries) — see the fuller note below the tool list
  clipboard        action:"copy" (text) | "read"
  inspect          resolve a ref / one element: kind:"element" (resolve_ref — is this ref alive?) | "geometry" (bounding box, z-depth, scroll-container-aware) | "relation" (refA vs refB: above/below/overlaps)
  navigate         navigate a tab to a URL. Pass tabId to target a specific tab; omit it to reuse your BOUND tab (no tab spam). newTab:true forces a fresh tab. An UNBOUND session gets its OWN tab automatically (it never inherits another session's tab)
  main_world       run a COMPILED function EXPRESSION in the page MAIN world (F12-insider view) — CSP-proof, the escape hatch when evaluate is blocked. func must be an EXPRESSION (() => …, async () => …); a statement body returns null with success:true and does nothing. This is the reliable way to READ what a click/type actually did
  page_snapshot    LOSSLESS inventory of the page, held server-side; returns only the INDEX (counts + sliceable dimensions + handle). Nothing is cut: not interactive-only, not in-viewport-only. Scroll-stable. fresh:true re-collects
  page_slice       fetch ONE slice of the snapshot at full fidelity: by tag / role / region / vp / interactive / query (+limit). Every record carries a usable locator, so you can act on what you fetch
  console_log      captured browser console + JS errors since last call (the page telling you WHY something failed) — a MAIN-world hook, so page logs ARE captured
  network_log      captured PAGE fetch/XHR since last call (clear, maxEntries). A MAIN-world hook captures real page traffic; totalCaptured is the count BEFORE clearing, so a clear:true call still tells you what it just flushed. Header capture is off unless asked.
  cookies          cookie session manager: action:"list" (metadata for a url — names/expiry, NEVER values) | "get" (returns values for a named cookie) | "clear"
  respawn_offscreen  force-close + recreate the offscreen document so the extension reloads fresh code (MV3 trap: the offscreen does NOT reload with the extension card)
  extension_reload   reload the WebSense extension itself
  real_activate_tab  OS-INPUT ONLY — genuinely activates a tab (SendInput). Page ops NEVER need this; it exists solely to precede real_click/real_paste
  real_click       GENUINE OS-level click (SendInput) at VIEWPORT coords (x,y) — for canvases/raw-input surfaces a page op cannot reach. Lands on the FRONTMOST window
  real_paste       GENUINE paste (Ctrl+V) into a focused editor at viewport coords — the working route for attaching a real file/image to a composer

TAB SCOPING MODEL (read this before running concurrent jobs): this is ONE Chrome profile with ONE extension — jobs do NOT get separate profiles, and nothing here gives you cookie/storage isolation from another job. Isolation is per-TAB. Ops that take an explicit tabId (navigate, tabs switch/close/bind/frames, form, ax, screenshot, real_*) target that tab and ignore the cursor. CURSOR-SCOPED ops (status, wait, scroll, evaluate, reveal, inspect, session, dialog, clipboard, console_log, network_log, read, explore_page, click, type_text) follow the session's BOUND tab, NOT the OS-frontmost tab. An unbound session is pinned to a tab automatically and WARNS you — it never silently inherits the shared global cursor (which is what made tabs appear "hijacked" between concurrent agents). tabs{action:"bind", tabId} sets the target WITHOUT focusing. session state (map/history) is PER-SESSION since v1.4.7: each MCP session gets its own SessionManager, so session{action:"reset"} clears only YOUR history and one job's steps never appear in another's map. (Before 1.4.7 it was a process-wide singleton and reset wiped everyone — that is fixed.)

REF LIFECYCLE: E# refs are assigned in VIEWPORT order on the FIRST scan, then held by ELEMENT IDENTITY (a per-element cache plus a data-websense-ref attribute), so they are STABLE across re-explores, scrolls, and framework re-renders. MEASURED 2026-09-25: 41/41 refs unchanged across a full re-explore, 0 changed after a scroll, 0 after a re-render, and a stale ref correctly HEALED onto a replacement node with an identical label and no id/class (the click landed on the NEW node). A ref only dies if its element leaves the DOM with nothing to heal from — re-explore if a call reports the element not found. CSS-selector refs (#id, .class) remain the safest choice for anything long-lived or across navigations.

KEY PATTERNS:
- Forms: form{action:"state", formRef:"F0"} → type_text/select via form{action:"select"} → click submit ref
- After every action: read the before/after + effect verdict (confirmed / suspected_noop / unverifiable). Verdicts are WEAK evidence, not proof: suspected_noop means the measured state was identical (re-read the real outcome first — async work, downloads, new tabs all measure as identical), and unverifiable means the effect could not be measured at all. NEVER escalate straight to OS-level input (real_click) on suspected_noop/unverifiable: re-read the page first, and only use real_click when a page op provably cannot reach the element (canvas/raw-input/native surface).
- Iframes: status{kind:"frames"}? No — list_frames lives under tabs{action:"frames"}; pass frameId to any element tool
- Waits: wait{urlContains:"/dashboard"} beats manual poll loops; wait{event:"dialog_open"} after clicks that pop dialogs
- Anti-patterns: no screenshots/vision for routine work; no CDP *debug port* (bot detection) — note chrome.debugger via the ax tool is NOT that and is allowed; no evaluate for routine reads (CSP); don't guess labels — read them from explore_page

TAB DISCIPLINE: reuse tabs (navigate reuses by default). NEVER close the last open tab/window of an app.
PAGE OPS vs OS-INPUT (do not conflate — the #1 source of wasted calls):
  page ops (navigate/explore_page/read/click{ref}/type_text/form/scroll/inspect/main_world/status/wait)
    route over tabs.sendMessage BY TABID and work on a tab that is NOT active. Never activate
    a tab for these. Measured 2026-09-20: explore_page on an active:false tab, no activation, 29 matches.
  OS-input ops (real_click/real_paste/real_activate_tab/dialog{keystroke}/computer_use) use SendInput,
    which hits the FRONTMOST window — those need the target active first, and they steal the
    user's focus. Use them only when a page op genuinely cannot work.
  A page op that HANGS is almost never activation. Check in order: (1) Chrome MINIMISED/occluded
    (0x0 window — restore it: tabs{action:"windows"} then tabs{action:"focus", windowId};
    an unrendered tab stops answering and every call then
    burns the 90s timeout), (2) a native "Leave site?" dialog parked over Chrome (dismiss it),
    (3) another process already driving that tab. Do NOT "fix" a hang by activating the tab.
NATIVE DIALOGS: JS alert/confirm/prompt are captured (dialog{action}); OS dialogs need dialog{keystroke:true}.
```

---

## Old→new tool map (compatibility)

Every capability from the 65-tool surface still works — either as a consolidated tool's
parameter, or (for legacy skill files) as a server-side alias. When writing NEW code, use
the 21 consolidated names:

| Old name(s) | New home |
|---|---|
| `discover_actions` | `explore_page {compact:true}` |
| `find_intent` | `explore_page {intent:"submit"}` |
| `explore_intent` | `explore_page {goal:"log in"}` |
| `extract_text` | `read {format:"text"}` |
| `read_content` | `read {format:"content"}` |
| `dump_markdown` | `read {format:"markdown"}` |
| `page_diff` | `read {format:"diff"}` |
| `scroll_and_extract` | `read {format:"scrollextract"}` |
| `preload_content` | `read {format:"preload"}` |
| `click_xy` | `click {x, y}` |
| `hover` | `click {mode:"hover", ref}` |
| `right_click` | `click {mode:"rightclick", ref}` |
| `drag_drop` | `click {mode:"drag", fromRef, toRef}` |
| `type_many` | `type_text {fields:[…]}` |
| `form_state` | `form {action:"state"}` |
| `select_option` | `form {action:"select"}` |
| `toggle` | `form {action:"toggle"}` |
| `upload_file` | `form {action:"upload"}` |
| `dropdown_options` / `tab_contents` / `accordion_contents` | `reveal {kind:"dropdown"|"tabs"|"accordion"}` |
| `scroll_to` | `scroll {y}` |
| `scroll_into_view` | `scroll {intoView:"E5"}` |
| `list_tabs` / `switch_tab` / `close_tab` / `bind_tab` / `list_frames` / `list_windows` / `focus_window` / `move_tab_to_window` / `transfer_text` / `switch_tab_and_read` | `tabs {action:…}` |
| `page_state` / `get_status` / `websense_doctor` / `download_state` | `status {kind:"page"|"bridge"|"doctor"|"downloads"}` |
| `wait_for` / `wait_for_event` | `wait {…conditions} / wait {event:…}` |
| `evaluate_safe` | `evaluate {query:{…}}` |
| `ax_state` / `ax_read` / `ax_click` / `ax_type` | `ax {action:"state"|"read"|"click"|"type"}` |
| `browser_screenshot` | `screenshot` |
| `handle_dialog` / `dismiss_dialog` | `dialog {action:…} / dialog {keystroke:true}` |
| `reset_session` / `explore_map` / `mermaid_export` | `session {action:"reset"|"map"|"mermaid"}` |
| `copy_to_clipboard` / `read_clipboard` | `clipboard {action:"copy"|"read"}` |
| `resolve_ref` / `geometry` / `layout_relation` | `inspect {kind:"element"|"geometry"|"relation"}` |

## Why this prompt (design notes)
- **No vision / no CDP debug port / no eval** is the core principle: the model navigates from the
  Semantic Action Graph (structured JSON), which is immune to bot-detection and works on
  strict-CSP SPAs (LinkedIn, GitHub, Google).
- **21 tools instead of 65** (2026-08-30 consolidation): every old tool became a
  `mode`/`format`/`action`/`kind` parameter on a consolidated parent. Smaller schema on the
  wire, same capabilities — the model picks one tool + one dispatcher arg instead of
  memorizing 65 names.
- The **autonomous loop** (explore → read → act → inspect → repeat) is explicit so the model
  treats WebSense as its eyes/hands rather than reaching for screenshots.
- **Dialog handling** is called out because native browser dialogs are the one thing DOM
  automation cannot reach — `dialog` (JS) and `dialog keystroke:true` (OS, via Windows
  control) close that gap.
- **Anti-patterns** tell the model what NOT to do, preventing the exact failures seen in
  earlier LinkedIn/Easy-Apply attempts (guessing labels, using vision, eval on CSP sites).
