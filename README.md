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

## Tools (29) — call `websense_guide` first

> **Count verified 2026-09-11** by `tools/list` against the RUNNING server
> (`POST http://127.0.0.1:9222/mcp`, streamable HTTP JSON-RPC): **29 tools**.
> The same 29 `reg(server, …)` names are in `src/server.js`. Anything in these
> docs that says 21/43/61 tools is stale.

### Guide & Status
`websense_guide` · `status` (kind:page|bridge|doctor|downloads)
### Exploration
`explore_page` (compact:list, intent:find, goal:goal-filter, preload:lazy, incremental:delta-since-last-scan)
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

## Native dialog handling (the one gap vs. a human — now closed)
- **JS dialogs** (`alert` / `confirm` / `prompt`): the content script overrides `window.alert/confirm/prompt` and captures them into a queue. `status` reports `pendingDialogs`; resolve them programmatically with `dialog action:"accept"|"dismiss"` — CSP-safe, no OS interaction.
- **OS-level dialogs** (HTTP basic-auth, proxy-auth, print): can't be intercepted by JS. `dialog keystroke:true key:"enter"|"escape"` injects a global keystroke through Windows control (PowerShell `SendKeys`). This is the windows-control bridge.
- **File picker:** handled by `form action:"upload"` (DataTransfer API) — no OS dialog.

## Iframes / frames (the other gap vs. a human — now closed)
- `tabs action:"frames"` returns every frame in the active tab with its `frameId` and URL.
- Pass `frameId` to any element tool (`explore_page({frameId})`, `click({ref, frameId})`, `type_text({ref, frameId})`, …) to target a specific iframe. This unlocks **Gmail compose**, **Notion**, **Figma**, and any site that renders key UI inside child frames.
- `read` (format:"text") and element labels now include CSS `::before`/`::after` content (icon-font glyphs, counters) that `innerText` misses.

## Cross-browser
- **Chrome / Edge / Opera:** load `extension/manifest.json` (MV3, offscreen WS bridge).

## Key Features
- **CSP-Safe (28/29 tools):** native DOM functions in the content script's isolated world. No eval, no string-to-code. Works on LinkedIn, GitHub, Google — any strict-CSP site. (`evaluate` is the only eval-based tool; `dialog keystroke:true` is a Windows-control keystroke, and `main_world` uses Chrome's userScripts MAIN-world path.)
- **React-Compatible:** native prototype value setters bypass React's value tracker, then `input`/`change` events are dispatched.
- **No Bot Detection:** real Chrome profile, cookies, fingerprint. No CDP, no `navigator.webdriver`, no headless.
- **No Vision:** all structured JSON; no screenshots, no vision model.
- **Action-Typed Elements:** every element classified by action type with predicted effects.
- **Exploration Graph:** persistent navigation map with Mermaid export.
- **Frame-Aware:** targets iframes via `frameId`; no DOM region is unreachable.

## Known limitations
- **Native browser dialogs** (alert/confirm, OS file picker): captured/resolved via `dialog action:"accept"|"dismiss"` (JS) and `dialog keystroke:true` (OS, Windows-control keystroke). Not a blocker.
- **`evaluate`** uses `new Function` (eval) → blocked by strict page CSP (LinkedIn, HN). Power-user utility; not for CSP sites.
- **Logged-in sites (LinkedIn etc.):** must already be authenticated in that Chrome profile; `navigate` opens a fresh tab that needs an existing session cookie.
- **Canvas/WebGL content** (Telegram web, TradingView, chrome:// pages): use `ax action:"read"` to see the native accessibility tree, then `ax action:"click"|"type"` to interact. Fallback: `screenshot` + vision.
- **`ax` tool uses chrome.debugger** — stable Chrome compatible, shows a warning banner while attached. Requires explicit tabId.

## v2.1-latchproof (2026-08-15)
- **Multi-slot concurrency** (`hub.js`): request correlator is now `Map<id,entry>` — concurrent sessions no longer clobber each other.
- **Latch-proof routing** (`background.js`): `chrome.tabs.onActivated/onRemoved` events keep the tab registry live; 0×0 viewport self-heal.
- **Honest interaction** (`websense-cs.js`): `type_text` verify-persist — reports `confirmed`/`reverted` instead of phantom success.
- **AX bridge** (`offscreen.js`): `ax` tool (`state`/`read`/`click`/`type`) via `chrome.debugger` (CDP Accessibility domain). Stable Chrome compatible, no dev-channel flags.
- **windows-control DPI-aware** (`uia_common.py`): physical→logical coordinate scaling fixes clicks on scaled displays.

## Testing
```bash
# Regression suite (hub-level, no Chrome needed)
node test-regressions.mjs

# Full end-to-end live test (needs Chrome + extension loaded)
node test/mcp-client-test.js
```

## File Structure
```
websense/
├── package.json
├── src/
│   ├── server.js       # MCP server with 29 consolidated tools
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

