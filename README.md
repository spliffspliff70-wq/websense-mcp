# WebSense MCP

[![Release](https://img.shields.io/github/release/spliffspliff70-wq/websense-mcp?display_name=tag)](https://github.com/spliffspliff70-wq/websense-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](extension/manifest.json)

> Non-vision, AI-native web automation via a Chrome extension. No screenshots, no debug port, no bot detection — the model reads structured JSON and acts through the browser's own input pipeline.

WebSense gives an AI agent hands on a real, logged-in Chrome profile. The agent gets a **lossless, addressable map** of the page, acts on it **by reference**, and is told — with a grouped diff — whether the page actually changed. No vision model, no headless browser, no remote-debugging port.

---

## Requirements

- **Node.js ≥ 18**
- **Google Chrome / Chromium** (Manifest V3, offscreen WebSocket bridge). Chrome-only: there is no Firefox code in this repo.
- **OS-level input is Windows-only.** Everything else (browse / find / act, trusted input, frames, diffs) is cross-platform. `act{how:"os"}`, `real_click`, `real_paste`, `real_activate_tab` and `dialog{keystroke}` use Windows `SendInput` / PowerShell.
- **`main_world`** (the CSP-proof MAIN-world read path) needs **Chrome 138+** with the per-extension **"Allow User Scripts"** toggle enabled.

## Install

```bash
git clone https://github.com/spliffspliff70-wq/websense-mcp
cd websense-mcp
npm install
```

**1. Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder. It connects to the WebSocket hub on `ws://127.0.0.1:38401` automatically — there is no launcher page. (For `main_world`, open the extension's **Details** and enable **Allow User Scripts**.)

**2. Register the MCP server** with your client.

stdio — one client per server process:

```json
{ "mcpServers": { "websense": { "command": "node", "args": ["src/server.js"] } } }
```

streamable HTTP — one server, many clients:

```bash
node src/server.js --http --http-port 9222
# then point each client at http://localhost:9222/mcp
```

**3. Call `websense_guide`** (or just `browse`). The guide is the runtime source of truth and documents every tool.

**Bridge port.** Default `38401`, plain `ws://` on `127.0.0.1` (loopback is exempt from mixed-content blocking, so it works from HTTPS pages). Override with `--port <n>` on the server and the matching `PORT` constant in `extension/offscreen.js`. If the port is already taken the hub logs a warning and the server keeps running — MCP still works, the bridge just isn't claimed. Run isolated servers with different `--port` values.

## The model's surface: 7 listed tools

A model sees exactly seven tools. The rest stay callable by name but are not listed, so a model never has to choose between a wall of one-verb tools.

| tool | what it does |
|---|---|
| `browse` | **TOOL 1** — open (or bind) a tab and map it in one call: navigate, seed the diff baseline, collect a lossless inventory, and return only the INDEX + the page's vocabulary + a region outline. |
| `find` | **TOOL 2** — search the stored inventory. Every hit answers **WHERE** (region + branch chain, resolved from parent pointers) and **WHAT** (role / name / attrs / state). |
| `act` | Do something: `click · hover · rightclick · drag · type · key · form · upload · scroll · dialog`. Add `how:"trusted"` for the browser's own input pipeline. |
| `page_slice` | Full-fidelity records for one slice of the inventory (`tag / role / region / vp / interactive / query`), or any cached part of a diff. |
| `tabs` | Tab/window ops: `list · switch · close · bind · frames · windows · focus · move · transfer · switchread`. |
| `debug` | WebSense itself + raw reads: `status · session · logs · cookies · clipboard · screenshot · ax · evaluate · main_world · explore_page · reload · respawn · guide`. |
| `websense_guide` | Start here — returns the full in-tool guide. |

**37 tools are registered; 30 of them are unlisted but callable by name.** The listable extras are summarised under [Other registered tools](#other-registered-tools).

## Quick start — the loop

1. **`browse {url}`** — one call that navigates (or binds), seeds the diff baseline, stores a **lossless** inventory of every element (nothing filtered, capped or truncated) and returns the small INDEX + a region outline. The full records stay server-side, addressable by index.
2. **`find {query}`** — locate the control. Each hit tells you WHERE it is and WHAT it is, so five controls called "New" are distinguishable.
3. **`act {action, ref, ...}`** — do it. Reach for `how:"trusted"` when the page checks `isTrusted`, reads coordinates, or a default action must run. Works in a background tab — no focus steal.
4. **Read the diff** the reply carries.

### The diff (did it land?)

Every mutating action returns a second block: a grouped **DIFF** against your `browse` baseline.

- **structure** — the page's *shape* changed (elements added/removed; tag/role/name/attrs changed). Page truth.
- **content** — the *same* element's value/text changed and its shape did not. The page answered you.
- **viewport** — only `vp`/`x`/`y` differ. That is scroll/layout churn and is **not** a mutation.

`mutated` is true only when structure or content moved — viewport churn can never make an action look landed. The reply ends with a `FULL DIFF: <handle>` line; fetch any part with `page_slice{diff:"<handle>", part:"structure|content|visual|viewport"}`. The full delta is cached because it can be hundreds of KB for one action — the summary is what changed, the handle is the rest. Pass `verify:false` to skip the diff on a call you don't need checked.

**A navigation is the strongest confirmation and is not in the groups:** when a `click` or `press_key` (Enter/Space) replaces the document, the result carries `effect:"confirmed"` plus a `navigation {from,to}`, and the diff line says so explicitly — a diff across a navigation compares two different documents, so its groups are meaningless.

### Verdicts, and when they are wrong

`effect` is derived from `page_state` — **url, title, readyState, scroll**. That is a deliberately weak signal, and an action that only changes the DOM does not move any of them. Two rules make that honest:

- **The diff can upgrade the verdict.** When the page-side differ measures a real structure/content move (`mutated:true`), an `unverifiable` or `suspected_noop` verdict is upgraded to `confirmed` and carries `effectSource:"page_diff"`, and its stale escalation advice is removed with it. Measured on x.com: every trusted `type` into the thread composer used to answer `unverifiable` while the same reply said `mutated:true` — a verdict contradicting its own evidence, which reads as "no proof" and makes a caller re-run an action that already worked. **It only ever upgrades:** a `failed` verdict (the action layer refused — disabled, read-only) stays `failed`. The measurement happened; `classifyEffect` simply could not see it.
- **An ambiguous selector is refused, not guessed.** `querySelector` returns the *first* match with no word, so a selector matching two elements silently drove the wrong one. Measured on x.com's `/compose/post`: `[data-testid="tweetTextarea_0"]` matches **twice** — the dialog's real composer and the empty page-level inline composer. You now get a refusal naming the count and the tag (`ambiguous selector … matches 2 elements — refusing to pick one silently`). **Scope it and retry:** `[role="dialog"] [data-testid="tweetTextarea_0"]`, or any selector that is unique on that page. This is also why `find` returns **all** matches with no cap — a cap would hide the second element and make the ambiguity invisible.

`effect` remains weak evidence for everything else: `confirmed` means "the page measurably moved", never "the app accepted and persisted it". Re-read the field or the page when the outcome matters.

### Trusted input — `act{how:"trusted"}`

`how:"trusted"` drives `chrome.debugger` + `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, so the page receives **`isTrusted`** events and **the browser itself runs the default action** (a link navigates, an Enter submits, a checkbox toggles, an arrow key moves a slider) instead of the tool guessing. It works in a **background tab** — no focus steal, no window activation. Chrome shows its "debugging this browser" infobar while attached.

Off-screen targets are scrolled into view first. Measured: a trusted click aimed at `y=1727` below the fold hit nothing; after the fix it re-aimed at `y=938` and the page recorded the click.

`how:"os"` is the OS-level rung (Windows `SendInput`) — reach for it only when a page rejects programmatic input outright, or for a raw-input / canvas surface. It lands on the frontmost window and so steals focus.

## Dialog handling

- **JS dialogs, by type — this is measured behavior, not a blanket rule.** The MAIN-world hook shadows **`alert` only** (its return is undefined, so nothing can branch on it) — it is captured into `pendingDialogs` and auto-dismisses after 30s, matching what Chrome itself does in a background tab. **`confirm`/`prompt` stay NATIVE**: a hooked confirm returns a Promise (always truthy), so every `if(confirm(...))` would take the TRUE branch regardless of the answer — the auto-answer-after-30s behavior was a bug, not a safety net, and it is gone. A native `confirm`/`prompt` blocks the page; answer it **on request** with `dialog{native:true, action:"accept"|"dismiss", value:promptText}` — that goes through `Page.handleJavaScriptDialog` (chrome.debugger), so the page's own branch follows the agent's real choice, on a background tab, with no focus steal. Nothing ever auto-answers a decision the agent did not make.
- **DOM modals** (`[role=dialog]`, most in-app modals) are closed by ref; `status.hasModal` / `dialogCount` come from a **visibility-blind** scan (a hidden modal still counts).
- **OS-level dialogs** (HTTP basic-auth, proxy-auth, print) cannot be intercepted by JS. `dialog{keystroke:true, key:"enter"|"escape"}` injects a global keystroke through Windows control (PowerShell `SendKeys`) — Windows-only.
- **File picker:** handled by `form{action:"upload"}` (DataTransfer API) — no OS dialog.

## Iframes / frames

**Same-origin iframes are walked and clickable** — verified: the frame echoes the click. List them with `tabs{action:"frames"}` (pass `tabId`; omit it for your bound tab) and pass `frameId` to any element tool — this unlocks **Gmail compose**, **Notion**, **Figma** and any site that renders key UI inside child frames. **Cross-origin frames are skipped**: nothing in the page can read them and no click can be aimed inside them.

## Other registered tools

These are registered and callable by name — the standalone forms that `act` / `debug` absorbed are noted inline:

- `explore_page` — quick look at a page's actions (SAG). `compact:true`, `intent:"submit"`, `goal:"log in"`, `preload:true`, `incremental:true`. For a full page map use `browse` + `find` instead.
- `read` — page text: `text · content · markdown · diff · scrollextract · preload`.
- `click` — click a ref (default) `· mode:"hover" · "rightclick" · "drag" (fromRef/toRef) · x,y` for canvas.
- `trusted_click` · `trusted_key` — the standalone trusted mouse / keyboard paths.
- `press_key` — **synthetic** key events only; runs no default action. Use `trusted_key` / `act{how:"trusted"}` when the default matters.
- `type_text` — fill one input (React-safe native setter) or `fields:[{ref,text},…]` for a verified batch.
- `form` — `state · select · toggle · special · upload`.
- `reveal` — pre-extract hidden content: `dropdown · tabs · accordion`.
- `scroll` — `direction`+`amount` (ticks) · `y` absolute · `intoView`.
- `status` — `page · bridge · doctor · downloads`.
- `wait` — poll conditions (ANDed) until met, or wait for an event.
- `evaluate` — run JS and return its value (auto-reroutes through the MAIN world on a CSP block) or a no-eval `query` DOM read.
- `main_world` — run a compiled function in the page's MAIN world (CSP-proof; needs "Allow User Scripts").
- `ax` — native accessibility tree via `chrome.debugger` (for canvas SPAs and `chrome://` pages).
- `screenshot` — `captureVisibleTab` → PNG/JPEG dataUrl, for a vision model.
- `dialog` — `accept | dismiss` (+ `value`); captures the page's own JS `alert`/`confirm`/`prompt`.
- `session` — `reset · map · mermaid`.
- `network_log` · `console_log` — captured page fetch/XHR · console + JS errors.
- `cookies` — `list · get · clear` (values are masked on other surfaces).
- `clipboard` — `copy · read`.
- `inspect` — `element · geometry · relation`.
- `navigate` — navigate a tab (reuses your bound tab; no tab spam).
- `page_snapshot` — collect / return the lossless inventory index directly.
- `respawn_offscreen` · `extension_reload` — extension maintenance (MV3 traps).
- `real_activate_tab` · `real_click` · `real_paste` — Windows OS-level input; the last rung.

## Architecture

```
MCP Client (Claude / Cline / Cursor / Hermes)
    ↔ stdio or streamable HTTP
WebSense MCP Server (src/server.js)
    ↔ WebSocket  ws://127.0.0.1:38401
Chrome Extension (extension/)
    ├── background.js    service worker, tab management, binding
    ├── offscreen.js     WebSocket client, auto-reconnect
    └── websense-cs.js   SAG extraction + native DOM interaction (CSP-safe)
    ↔ chrome.runtime.sendMessage / chrome.debugger (trusted input)
Live DOM
```

## What's new in 2.0

- **A 7-tool listed surface** — `browse · find · act · page_slice · tabs · debug · websense_guide`. `act` and `debug` are facades that dispatch to the real handlers, so the 30 unlisted tools remain callable by name with identical behaviour.
- **`browse` → `find` → `act` → read the diff** replaces `explore_page → click/type` as the primary loop. `browse` returns an INDEX over a lossless inventory; `find` returns WHERE + WHAT per hit; `page_slice` loads one branch at full fidelity.
- **A grouped auto-diff after every mutating action**, with `mutated` derived from structure + content only (viewport churn cannot fake a landing), a summary in the reply, and the full delta cached behind `FULL DIFF: <handle>`.
- **Trusted input**: `act{how:"trusted"}` runs through `chrome.debugger` + `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, so the page sees `isTrusted` events and the browser performs the default action — in a background tab. Off-screen targets are scrolled into view first.
- **Same-origin iframes** are walked and clickable.

## Known limitations (honest)

- **Trusted drag works end-to-end** (verified on the fixture): `act{action:"drag", how:"trusted"}` produces trusted `dragstart`/`dragenter`/`dragover` **and a real `drop`**, from a background tab, with both ends scrolled into view automatically. The drop only fires if the **target accepts drops** (`preventDefault()` on `dragover`) — a non-zone target correctly gets `dragleave`, exactly as a real mouse would, so check the target before blaming the driver. The plain `drag` mode still fires the whole sequence but its events are **not** trusted — use `how:"trusted"` when the page checks `isTrusted`.
- **OS-click equivalence is unproven.** `act{how:"trusted"}` is the browser's own input pipeline; it is not proven byte-identical to a real OS click. `real_click` (Windows `SendInput`) is the only genuinely OS-level path.
- **Canvas / WebGL: coordinate clicks are TRUSTED** (fixed 2026-10-02 — this line said "not trusted" and was stale). `act{action:"click", how:"trusted", x, y}` drives `Input.dispatchMouseEvent` at the raw viewport point, so a canvas that inspects `isTrusted` now sees a real one. The untrusted form still exists as `how:"auto"` and lands within 1px; prefer `how:"trusted"` on canvas/WebGL, which is exactly the surface class that checks the flag.
- **Chrome-only.** MV3 + offscreen WebSocket bridge; no Firefox code.
- **OS-level input is Windows-only** (`real_*`, `dialog{keystroke}`).
- **OS-level input additionally needs Python 3 with `pyautogui` + `pywinauto`** (Windows only). Everything else — the whole `browse`/`find`/`act` loop, trusted input, frames, diffs — needs neither Python nor Windows. The server discovers an interpreter (`py` → `python` → `python3`); override with `WEBSENSE_PYTHON=/path/to/python`. If none is found the error says so instead of failing as a mysterious page problem (fixed 2026-10-02 — the interpreter path was previously hard-coded to the maintainer's machine, so OS input could not work for anyone else).
- **`main_world` requires the "Allow User Scripts" toggle** (Chrome 138+). Without it the CSP-proof MAIN-world path is unavailable.
- **`evaluate{script}`** runs your JS and returns its value; the isolated-world `new Function` path is blocked by the extension's own MV3 CSP, so it transparently re-routes through the MAIN world (`chrome.userScripts`, no eval) and reports `via:"main_world"`. `evaluate{query:{…}}` remains the lighter path for plain DOM reads.
- **A JS dialog raised while the tab is hidden can be auto-dismissed by Chrome before anyone sees it** — act fast: `dialog{native:true, action, value}` answers a *still-pending* native confirm/prompt via `Page.handleJavaScriptDialog` on the background tab (no activation needed). A hooked `alert` is still recorded (`status.recentDialogs`); native `confirm`/`prompt` are NOT in the hook's queue (they are never shadowed), so check `status` and answer immediately if the branch matters.
- **`ax` attaches `chrome.debugger`** and shows Chrome's warning banner while attached; it requires an explicit `tabId`.
- **One profile, per-tab isolation.** Concurrent jobs share one Chrome profile — there is no cookie/storage isolation between them. Scope work with `tabs{action:"bind", tabId}` + an explicit `tabId`. Session state (map/history) *is* per-session: `session{action:"reset"}` clears only your own history.
- **Logged-in sites (LinkedIn, etc.)** must already be authenticated in that Chrome profile; `navigate` opens a fresh tab that needs an existing session cookie.
- **Refs are stable** — `E#` refs are assigned in viewport order on the first scan, then **held by element identity** (a per-element cache + a `data-websense-ref` attribute), so they survive re-explores, scrolls and framework re-renders. A ref dies only when its element leaves the DOM with nothing to heal from. CSS-selector refs (`#id`) remain the safest choice for anything long-lived or across navigations.

## Testing

```bash
# Regression suite — no Chrome needed (hub, diff, snapshot, trusted-input,
# guide-truth and doc-drift guards). Currently 170 tests.
npm test

# Print the LISTED surface from a running server (tools/list is filtered to it)
node tools/tools-list.mjs          # names-only preflight
node tools/tools-list.mjs --full   # name + one-line description

# End-to-end MCP client test (needs Chrome + the extension loaded)
node test/mcp-client-test.js

# Keep MODEL_PROMPT.md in sync with the in-tool guide (also enforced inside npm test)
node tools/export-guide.mjs --check
```

## File structure

```
websense-mcp/
├── src/
│   ├── server.js          # MCP server: tool registration, the 7-tool listed surface, facades
│   ├── hub.js             # WebSocket hub on ws://127.0.0.1:38401
│   ├── session.js         # exploration map + per-session state
│   ├── snapshot.js        # lossless page inventory (collector + slicer)
│   ├── diff-cache.js      # cached grouped diffs behind FULL DIFF handles
│   ├── diff-collector.js  # in-page diff collection
│   └── climb.js, incr.js, upload.js, summarize.js, mermaid.js
├── extension/
│   ├── manifest.json      # Chrome MV3
│   ├── background.js      # service worker (tab mgmt, offscreen lifecycle)
│   ├── offscreen.js       # WebSocket client (auto-reconnect)
│   ├── websense-cs.js     # built content script (generated — do not hand-edit)
│   └── cs-src/            # content-script sources (edit here; build with tools/build-cs.mjs)
├── test/
│   └── mcp-client-test.js # end-to-end MCP client test
└── tools/                 # build + measurement scripts (build-cs, export-guide, tools-list…)
```

## License

MIT — see [LICENSE](LICENSE).
