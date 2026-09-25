# WebSense MCP

> Non-vision, AI-native web automation via the Semantic Action Graph. No screenshots, no CDP, no bot detection.

## Quick Start

1. `npm install` in `E:\local_memstore\websense`
2. Load the extension: `chrome://extensions` → Developer mode → Load unpacked → select `E:\local_memstore\websense\extension`. It auto-connects to the WebSocket hub (no launcher page).
3. Register the MCP server in your client. **Cline** (`C:\Users\Ali\.cline\cline_mcp_settings.json`):
```json
{ "mcpServers": { "websense": { "command": "node", "args": ["E:/local_memstore/websense/src/server.js"], "env": { "PORT": "38401" } } } }
```
4. Call any tool (e.g. `explore_page`). Flow: `MCP → WS → Extension → Content Script → DOM`.

**Bridge port:** default `38401`. Override with `--port <n>` (server) and the matching
`PORT` constant in `extension/offscreen.js` (extension). If the port is already taken, the
hub logs a warning and the server keeps running (MCP still works) — the bridge just isn't
claimed. Run multiple isolated servers with different `--port` values.

> **Chrome-only.** WebSense is built, tested and supported on Chrome / Chromium (MV3, offscreen
> WS bridge). It has never been developed or tested on Firefox, and there is no Firefox code in
> this repo. Do not expect it to work there.

## Architecture
```
MCP Client (Claude / Cline / Cursor / Hermes)
    ↔ stdio
WebSense MCP Server (src/server.js)
    ↔ WebSocket localhost:38401
Chrome Extension (extension/)
    ├── background.js    service worker, tab management
    ├── offscreen.js     WebSocket client, auto-reconnect
    └── websense-cs.js   SAG extraction + native DOM interaction (CSP-safe)
    ↔ chrome.runtime.sendMessage
Live DOM
```

## Tools (31) — call `websense_guide` first

> **Count verified 2026-09-21** by `tools/list` against the RUNNING server
> (`POST http://127.0.0.1:9222/mcp`, streamable HTTP JSON-RPC): **31 tools**.
> The same 31 `reg(server, …)` names are in `src/server.js`. Anything in these
> docs that says 20/21/29/43/61 tools is stale.

### Guide & Status
`websense_guide` · `status` (kind:page|bridge|doctor|downloads)
### Exploration
`explore_page` (compact:list, intent:find, goal:goal-filter, preload:lazy, incremental:delta-since-last-scan)
### Page Map (lossless, addressable)
`page_snapshot` (LOSSLESS inventory of the page held server-side; returns only the small INDEX — counts + sliceable dimensions. Nothing is cut: not interactive-only, not in-viewport-only, and it is scroll-stable) · `page_slice` (fetch ONE slice at full fidelity: tag|role|region|vp|interactive|query — every record carries a usable locator)
### Read
`read` (format:text|content|markdown|diff|scrollextract|preload)
### Interact
`click` (ref|xy, mode:click|hover|rightclick|drag) · `type_text` (ref+text|fields:[]) · `form` (state|select|toggle|upload) · `scroll` (direction|y|intoView) · `press_key`
### Element Intel
`reveal` (kind:dropdown|tabs|accordion) · `inspect` (kind:element|geometry|relation)
### Tabs & Navigation
`navigate` · `tabs` (list|switch|close|bind|frames|windows|focus|move|transfer|switchread)
### Wait
`wait` (conditions ANDed | event mode)
### Page Control
`evaluate` (script|query) · `main_world` (compiled fn in the page MAIN world — F12-insider path for reads/writes the isolated world can't do) · `screenshot` · `dialog` (accept|dismiss|keystroke)
### Session & Network
`session` (reset|map|mermaid) · `network_log` · `console_log` (captured console + JS errors) · `cookies` (list/get/set/clear metadata — never values) · `clipboard` (copy|read)
### AX Bridge
`ax` (state|read|click|type) — for canvas SPAs & chrome:// pages
### REAL Input (genuine OS-level, for synthetic-ignoring widgets)
`real_activate_tab` (UIA tab-pill click) · `real_click` (SendInput at viewport x,y) · `real_paste` (OS click + clipboard + Ctrl+V)
### Extension maintenance
`respawn_offscreen` (recreate the offscreen doc so current on-disk code loads) · `extension_reload` (chrome.runtime.reload + reconnect wait)

> **Each tool absorbed 2-10 old one-verb tools.** Full absorption table in `websense_guide`. All 65 original capabilities are callable — just through the consolidated tool with a `mode`/`format`/`action`/`kind` parameter instead of a separate tool name.

## Dialog handling
- **DOM modals** (`[role=dialog]`, most in-app modals): the reliable surface. Close them by
  ref, and note `status` reports `hasModal` / `dialogCount` from a **visibility-blind** scan
  (a hidden modal still counts).
- **JS dialogs** (`alert` / `confirm` / `prompt`) are **not reliably captured**: the page's own
  `window.alert` bypasses the content-script override and does not block, so `pendingDialogs`
  usually stays empty. Don't build a flow that depends on catching them. `dialog
  action:"accept"|"dismiss"` still exists for anything that *does* land in the queue.
- **OS-level dialogs** (HTTP basic-auth, proxy-auth, print): can't be intercepted by JS. `dialog keystroke:true key:"enter"|"escape"` injects a global keystroke through Windows control (PowerShell `SendKeys`). This is the windows-control bridge.
- **File picker:** handled by `form action:"upload"` (DataTransfer API) — no OS dialog.

## Iframes / frames (the other gap vs. a human — now closed)
- `tabs action:"frames"` returns every frame in the target tab (pass `tabId`; omit it and you
  get your bound tab) with its `frameId` and URL.
- Pass `frameId` to any element tool (`explore_page({frameId})`, `click({ref, frameId})`, `type_text({ref, frameId})`, …) to target a specific iframe. This unlocks **Gmail compose**, **Notion**, **Figma**, and any site that renders key UI inside child frames.
- `read` (format:"text") and element labels now include CSS `::before`/`::after` content (icon-font glyphs, counters) that `innerText` misses.

## Cross-browser
- **Chrome / Edge / Opera:** load `extension/manifest.json` (MV3, offscreen WS bridge).

## Key Features
- **CSP-Safe (30/31 tools):** native DOM functions in the content script's isolated world. No eval, no string-to-code. Works on LinkedIn, GitHub, Google — any strict-CSP site. (`evaluate` is the only eval-based tool — and its `script` mode is blocked by the extension's own MV3 CSP on *every* page, so use its `query` mode or `main_world`; `dialog keystroke:true` is a Windows-control keystroke, and `main_world` uses Chrome's userScripts MAIN-world path which is CSP-proof by design.)
- **React-Compatible:** native prototype value setters bypass React's value tracker, then `input`/`change` events are dispatched.
- **No Bot Detection:** real Chrome profile, cookies, fingerprint. No CDP, no `navigator.webdriver`, no headless.
- **No Vision:** all structured JSON; no screenshots, no vision model.
- **Action-Typed Elements:** every element classified by action type with predicted effects.
- **Exploration Graph:** persistent navigation map with Mermaid export.
- **Frame-Aware:** targets iframes via `frameId`; no DOM region is unreachable.

## Known limitations
- **JS dialogs** (`alert`/`confirm`/`prompt`) are not reliably captured — the page's own
  `window.alert` bypasses the content-script override. Use DOM `[role=dialog]` modals, or
  `dialog keystroke:true` for OS-level dialogs. (`dialog action:"accept"|"dismiss"` still
  handles anything that reaches the queue.)
- **`evaluate` script mode** uses `new Function` (eval) and is blocked by the **extension's own
  MV3 CSP on every page** — not only strict sites. Use `evaluate{query:{…}}` (no-eval reads) or
  `main_world{func}` for arbitrary JS.
- **Refs drift:** `E#` refs renumber on every full `explore_page` (viewport order) and can rot
  across re-renders; healing is op-inconsistent. Prefer CSS-selector refs (`#id`) for anything
  long-lived, and re-explore after a re-render.
- **One profile, per-tab isolation:** concurrent jobs share one Chrome profile (no cookie/storage
  isolation) and a global session history. Scope work with `tabs action:"bind"` + explicit
  `tabId`; `session action:"reset"` clears *everyone's* history.
- **Logged-in sites (LinkedIn etc.):** must already be authenticated in that Chrome profile; `navigate` opens a fresh tab that needs an existing session cookie.
- **Canvas/WebGL content** (Telegram web, TradingView, chrome:// pages): use `ax action:"read"` to see the native accessibility tree, then `ax action:"click"|"type"` to interact. Fallback: `screenshot` + vision.
- **`ax` tool uses chrome.debugger** — stable Chrome compatible, shows a warning banner while attached. Requires explicit tabId.

## v1.4.5 (2026-09-25) — twelve defects, three of them false promises
- **Truth fixes:** the action `effect` verdict was `unverifiable` for every relayed action (it never
  unwrapped the relay envelope); it no longer recommends a real OS click for a merely unmeasurable
  action; and the DELTA block no longer claims `mutated:false` means the action failed (it only
  means no *interactive-element* fingerprint changed).
- **Now working (previously never did):** `network_log` captures real page traffic (MAIN-world
  hook), `wait{selector}` succeeds, `reveal kind:"dropdown"` resolves, `status kind:"doctor"`
  reports a live service worker, `navigate`/`tabs frames` honor `tabId`, batch `type_text` counts
  are honest, `extension_reload` really reloads, and `respawn_offscreen` stops reporting false
  failures.
- **Privacy:** password/OTP values are masked on every surface that can echo them.
- **Docs:** the in-tool guide, `MODEL_PROMPT.md` (now generated from the guide, with a test that
  fails on drift) and this README all state the measured behavior. See `CHANGELOG.md` for the
  full list.

## v2.1-latchproof (2026-08-15)
- **Multi-slot concurrency** (`hub.js`): request correlator is now `Map<id,entry>` — concurrent sessions no longer clobber each other.
- **Latch-proof routing** (`background.js`): `chrome.tabs.onActivated/onRemoved` events keep the tab registry live; 0×0 viewport self-heal.
- **Honest interaction** (`websense-cs.js`): `type_text` verify-persist — reports `confirmed`/`reverted` instead of phantom success.
- **AX bridge** (`offscreen.js`): `ax` tool (`state`/`read`/`click`/`type`) via `chrome.debugger` (CDP Accessibility domain). Stable Chrome compatible, no dev-channel flags.
- **windows-control DPI-aware** (`uia_common.py`): physical→logical coordinate scaling fixes clicks on scaled displays.

## Testing
```bash
# Regression suite (127 tests: hub, delta, guide-truth guards — no Chrome needed)
npm test

# Full end-to-end live test (needs Chrome + extension loaded)
node test/mcp-client-test.js

# Keep MODEL_PROMPT.md in sync with the in-tool guide (runs inside npm test)
node tools/export-guide.mjs --check
```

## File Structure
```
websense/
├── package.json
├── src/
│   ├── server.js       # MCP server with 31 consolidated tools
│   ├── hub.js          # WebSocket hub
│   ├── session.js      # Exploration map + diff engine
│   └── mermaid.js      # Mermaid export
├── extension/
│   ├── manifest.json   # Chrome MV3
│   ├── background.js    # Service worker (tab mgmt, offscreen lifecycle)
│   ├── offscreen.js     # WebSocket client (auto-reconnect)
│   ├── offscreen.html
│   └── websense-cs.js   # SAG extraction + native DOM interaction
└── test/
    └── mcp-client-test.js   # End-to-end MCP client test
```

