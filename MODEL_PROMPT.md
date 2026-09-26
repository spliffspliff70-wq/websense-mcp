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
WebSense MCP — Guide (31 consolidated tools)
==============================================
Non-vision web automation via Chrome extension. No CDP debug port, no bot detection. CSP-safe. React/Vue/Angular compatible.

THE LOOP: explore_page → pick refs → act (click/type_text/form/scroll) → read result → repeat.

PICK THE RIGHT FIELD — NEVER actions[0]. explore_page returns EVERY interactive element, and a page with a search box puts that search box FIRST. A real measured failure: a 5-tweet thread was typed into [data-testid="SearchBox_Search_Input"] because the code took the first form_input. The tool reported success and confirmed nothing was wrong. So: for a rich-text editor match subtype:"contenteditable" (x.com's composer is {type:"form_input", subtype:"contenteditable", label:"Post text", locator:'[data-testid="tweetTextarea_0"]'}), or target by CSS/locator, or use explore_page{intent:"post"} to get 24 candidates instead of 125. Same rule for every form: pick the field by LABEL/ROLE/TESTID, never by position. type_text reports what it wrote (confirmed:"paste-dom-persisted" is state-truth) but it cannot tell you it hit the wrong box — that check is yours.

UPLOADING A REAL FILE: form action:"upload" takes filePath — an ABSOLUTE path to a file that already exists on this machine. It does NOT accept inline base64; the server reads the file and encodes it. Passing a made-up filePath fails with ENOENT naming the path it tried. After the call, READ THE PAGE before believing it: a successful upload reports success:true with no fileCount, and count==0 is SILENCE, never a rejection (PITFALL 48 asymmetry) — but also never proof. A composer dropzone attaching a realm-local File still needs real_paste to actually upload.

TOKEN COST — MEASURED 2026-09-25, PICK THE CHEAPEST CALL THAT ANSWERS YOUR QUESTION. Real payloads, not estimates: x.com explore{full:true} = 183 KB / 726 ms; Reddit = 147 KB; GitHub = 79 KB. The page_snapshot index for the same pages = 1.5-1.8 KB (53-102x smaller), and one page_slice of 25 records = 8 KB. explore_page{intent:"..."} = ~4 KB in 15-45 ms. So: (1) you know WHAT you want -> explore_page{intent}. (2) you need to MAP the page -> page_snapshot for the index, then page_slice for the part you care about. (3) only when you genuinely need every action AND the page is small (a form, a settings page) -> explore_page{full:true}. On a large SPA, full:true is the single most expensive call in this toolset and is almost never the right first move. The old changelog figure for this was 275 KB for one x.com search; that is the same number, measured then, and it is why the index/slice path exists.

DID IT LAND? Every mutating op (click, type_text, form, press_key, real_click, real_paste, main_world, evaluate, dialog) returns a SECOND block: DELTA (auto, after <op>): {mutated: true|false|null, ...}. Read that instead of spending an extra explore_page{incremental:true} call — it is the same diff, already paid for. mutated:false means NO INTERACTIVE-ELEMENT CHANGE was detected — it is NOT proof the action failed: the diff fingerprints interactive elements only, so text/content changes elsewhere, async handlers that settle after the diff, focus-only clicks, downloads, and new-tab opens all report mutated:false while genuinely landing. Confirm with a real read (status / read{diff} / main_world / the downloads or tabs store) before concluding "not landed". mutated:null means no baseline existed yet on that tab, so that action seeded one and only the NEXT action is verifiable. Pass verify:false to skip the diff on a call you don't need checked.

FULL PAGE MAP vs A SLICE: page_snapshot collects a LOSSLESS inventory of the page (nothing filtered out — not interactive-only, not in-viewport-only) and returns only a small INDEX (counts + the dimensions you can slice by). page_slice then fetches ONE slice (tag/role/region/vp/interactive/query) at full fidelity. Use this when you need the whole page's shape or something the SAG does not show (off-viewport elements, the rest of a long page, a full tag/region inventory). It is also scroll-stable, so its index does not churn the way a viewport-filtered scan does. Cost measured on github.com/nodejs/node: index 690 B vs a 116,573 B explore_page, over 3,842 elements.

THE 31 TOOLS — what each absorbed from the old 65-tool surface:
  websense_guide   this guide
  explore_page     page map (SAG). compact:true = old discover_actions; intent:"submit" = old find_intent; goal:"log in" = old explore_intent; preload:true = lazy-load first; incremental:true = delta since last scan (added/changed/removed, no settle/content — you usually do NOT need this any more: mutating ops return a DELTA block automatically; first call returns full SAG)
  read             page text. format: "text" (extract_text) | "content" (read_content) | "markdown" (dump_markdown) | "diff" (page_diff) | "scrollextract" (scroll_and_extract) | "preload" (preload_content)
  click            click ref (default) | mode:"hover" | mode:"rightclick" | mode:"drag" (fromRef/toRef) | x,y for canvas (old click_xy)
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

WHAT TOUCHES THE FOREGROUND (the complete list — nothing else does): (1) real_activate_tab, real_click, real_paste — OS-input by design, and the ONLY sanctioned ways to take the foreground. (2) tabs action:"focus" / "move". (3) ONE automatic case: if the bound tab's Chrome window is MINIMIZED or COLLAPSED, its viewport is 0x0 and every page read comes back empty, so a page op restores that window to "normal" first and then reports windowRestored:true with a note saying why. It never raises a window that is merely in the background or occluded. If you see a window come to the front during a page op, that is this case — minimized windows cannot be read otherwise. (4) Attaching a REAL file to a composer (form action:"upload" onto a custom dropzone) attaches a realm-local File that never uploads; the working route is real_paste or scripts/real_input.py paste-file, which DO need the foreground. Native file dialogs (OS open/save) and OS-level print/print-preview always need the foreground and have no background path.

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
