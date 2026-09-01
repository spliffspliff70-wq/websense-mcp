# WebSense — Model Prompt (what `websense_guide` returns)

This is the instruction text the AI model receives when it calls `websense_guide` — the
entry point for every WebSense session. It is kept here as documentation and as the single
source of truth for the in-tool prompt.

---

```
WebSense MCP — Model Guide
============================
Non-vision web automation. You drive a real Chrome (your profile, cookies, no bot detection)
via a Semantic Action Graph. NO screenshots, NO CDP, NO vision model, NO eval. Everything is
structured JSON. Works on LinkedIn, GitHub, Google — any strict-CSP site — including
React/Vue/Angular apps.

THE LOOP (autonomous):
1. explore_page → returns every interactive element with a ref (E0, E1…), its action type,
   predicted effect, forms (F0…), and page content. Use this as your map.
2. Read the graph. Pick the element whose label / predicted-effect matches your goal.
3. Act by ref:
     click("E7")                 open / submit / navigate (mode:"hover"|"rightclick"|"drag")
     type_text("E3","text")      fill an input (native setter — React/Vue/Angular-safe)
     form action:"select"|"toggle"|"upload"  dropdowns, checkboxes, file uploads
4. Inspect the RESULT. Every action returns before/after state + effect verdict
   (confirmed / suspected_noop / unverifiable). Use it to decide the next step.
5. Repeat until done. status kind:"page" confirms state (URL, modal, captcha, loading);
   session action:"map"|"mermaid" track multi-page journeys.

TOOLS (21 — consolidated from 65, nothing lost):
  Guide    websense_guide
  Explore  explore_page (compact:list | intent:find | goal:goal-filter | preload:lazy)
  Read     read (format:"text"|"content"|"markdown"|"diff"|"scrollextract"|"preload")
  Interact click, type_text, form, scroll (direction|y|intoView), press_key
  Intel    reveal (kind:"dropdown"|"tabs"|"accordion"), inspect (kind:"element"|"geometry"|"relation")
  Tabs     navigate, tabs (list|switch|close|bind|frames|windows|focus|move|transfer|switchread)
  Wait     wait (conditions ANDed | event:"dialog_open|navigation|…")
  Control  evaluate (script|query), screenshot, dialog (accept|dismiss|keystroke)
  Session  session (reset|map|mermaid), network_log, clipboard (copy|read)
  AX       ax (state|read|click|type) — canvas SPAs & chrome:// pages (needs tabId)
  Real     real_activate_tab, real_click, real_paste — GENUINE OS input (UIA + SendInput)

KEY PATTERNS:
- Forms:    form action:"state" → fill with type_text / form action:"select" → click submit ref
- Select:   reveal kind:"dropdown"("E5") → see values → form action:"select"("E5", value)
- Hover:    click mode:"hover"("E2") → explore_page again to catch revealed menus
- Keys:     press_key("c",["ctrl"]) = Ctrl+C; press_key("Tab",["shift"]) = Shift+Tab
- Canvas:   click(x,y) to click at viewport coordinates (ref optional origin)
- Upload:   form action:"upload"("E9", "C:/path/file.pdf") — DataTransfer, no OS picker
- APIs:     network_log() → act → network_log() again to see XHR/fetch calls
- Multi-page: session action:"map" shows the journey; session action:"mermaid" draws it
- Iframes:  tabs action:"frames" → match frameId by URL → explore_page({frameId})
            / click({ref, frameId}) / type_text({ref, frameId}). Unlocks Gmail compose,
            Notion, Figma (any site with child frames)
- Wait:     wait({urlContains, hasModal, notLoading, pendingDialogsGt}) instead of manual
            poll loops after async loads
- Pseudo-text: read format:"text" and element labels include CSS ::before/::after content
            (icon-font glyphs, counters) that innerText misses
- Effect verdict: after click/type_text, if effect:"suspected_noop" do NOT retry blind —
            escalate (OS-level click via windows-control) or try an alternate path
- REAL INPUT (synthetic events ignored): if click returns effect:"unverifiable" with
            escalation.recommended="real_click" on a React/Lit/CustomElement submit
            (shreddit, Lexical/Draft.js/ProseMirror editors, faceplate), climb the ladder:
            1) real_activate_tab({match}) to foreground the tab (cold-background-tab fix)
            2) inspect{kind:"geometry"} on the target → viewport center (x,y)
            3) real_click({x, y, gate:"<expected tab title>"}) OR
               real_paste({x, y, text, gate}) for rich-text editors that revert
               synthetic paste — genuine OS click + clipboard + Ctrl+V
            Always gate: the active-tab title must match or the click is refused
            (multi-agent tab churn protection).

NATIVE DIALOGS (the one thing DOM can't reach — handled here):
- JS dialogs (alert/confirm/prompt): captured, NOT blocking. status kind:"page" shows
  pendingDialogs → resolve with dialog action:"accept"|"dismiss" (index?, value?)
- OS dialogs (HTTP basic-auth, proxy-auth, print): not interceptable by JS.
  dialog keystroke:true key:"enter"|"escape" injects a global keystroke via Windows
  control. Type credentials first with dialog keystroke:true value:"user:pass"
- Always call status kind:"page" after any action that might pop a dialog

CROSS-BROWSER: Chrome/Edge/Opera load extension/manifest.json (MV3, offscreen WS bridge).

TIPS / ANTI-PATTERNS:
- Do NOT use screenshots, vision, or CDP — unnecessary and may trigger bot detection.
  WebSense IS the interface.
- Do NOT guess button labels. Read them from the SAG (explore_page / inspect).
- Do NOT use evaluate for routine work — it runs eval and is blocked by strict CSP
  (LinkedIn, HN). Use the native tools.
- After a click that navigates, read the result (urlChanged) before the next step.
- If an action seems to do nothing, call status kind:"page" — a modal / captcha / dialog
  may be up.
- type_text uses a native value setter, so it works on React/Vue/Angular controlled inputs.
- Tab discipline: navigate reuses the tab by default; never close the last open tab/window.
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
- **No vision / no CDP / no eval** is the core principle: the model navigates from the
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
