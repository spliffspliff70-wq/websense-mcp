# WebSense MCP

**Non-vision, AI-native web automation** via the Semantic Action Graph. Drive a real Chrome
from any MCP client — **no screenshots, no CDP, no bot detection, no headless**.

Built to be the browser tool an AI agent actually *wants*: every element is classified by
action type with a predicted effect, every form is fully introspected, every click returns a
before/after state diff. Works on LinkedIn, GitHub, Google, Gmail — any strict-CSP site,
including React/Vue/Angular SPAs.

---

## Why WebSense

| | WebSense | CDP / Puppeteer | Vision-based (computer-use) |
|---|---|---|---|
| **Bot detection** | None (real profile) | Often flagged | None |
| **Screenshots / vision model** | No — pure structured JSON | No | Yes (expensive, error-prone) |
| **CSP-strict sites** | ✅ Native setters in isolated world | ✅ | ✅ |
| **React controlled inputs** | ✅ Native prototype setters + event dispatch | Partial | ✅ |
| **`navigator.webdriver`** | Never set | Set | Never |
| **What the agent sees** | Typed actions, forms, states, diffs | Raw DOM/JS | Pixels |
| **Cost per read** | ~0 tokens (summarized, incremental) | Full DOM dump | 1 vision call |

---

## How it works

```
MCP Client (Claude / Cline / Cursor / any MCP host)
    ↔ stdio or HTTP (StreamableHTTP)
WebSense MCP Server (src/server.js)
    ↔ WebSocket localhost:38401
Chrome Extension (extension/)
    ├── background.js    service worker, tab management, binding
    ├── offscreen.js     WebSocket client, auto-reconnect
    └── websense-cs.js   Semantic Action Graph extraction + native DOM interaction
    ↔ chrome.runtime.sendMessage
Live DOM
```

The content script extracts a **Semantic Action Graph (SAG)** — every interactive element with a
stable ref (`E0`, `E1`, …), action type (`navigation`, `form_input`, `form_submit`, `toggle`, …),
predicted effect, and live state (`value`, `checked`, `disabled`, `expanded`, …). The agent
plans against the graph, then acts by ref. No coordinates, no pixels, no eval.

---

## Quick start

### Prerequisites
- Node.js **18+**
- Chrome / Edge / Opera (the extension is MV3)

### 1. Install & load the extension
```bash
npm install
```
Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select the
`extension/` folder. The extension auto-connects to the WebSocket hub — no launcher page needed.

### 2. Register the MCP server in your client

**Claude Desktop** (`claude_desktop_config.json`):
```json
{ "mcpServers": { "websense": { "command": "node", "args": ["/path/to/websense-mcp/src/server.js"], "env": { "PORT": "38401" } } } }
```

**Cline** / **Cursor** / any stdio MCP client: same shape — point `args` at
`src/server.js` with `PORT=38401`.

**Multiple clients at once** (Hermes + Cline + Cursor simultaneously):
```bash
node src/server.js --http --http-port 9222
```
then point each client at `http://localhost:9222/mcp` (StreamableHTTP, multi-session).

### 3. Call any tool
Start with `websense_guide` — it returns the full usage guide. The core loop:

```
explore_page → pick a ref → click/type/form by ref → read the before/after diff → repeat
```

---

## Tools

`websense_guide` first. 24 consolidated tools covering the whole surface:

| Area | Tools |
|---|---|
| **Guide & Status** | `websense_guide`, `status` (bridge/page/doctor/downloads) |
| **Exploration** | `explore_page` (compact / intent / goal / preload / **incremental**) |
| **Read** | `read` (text / content / markdown / diff / scrollextract / preload) |
| **Interact** | `click` (click/hover/rightclick/drag, auto-climb), `type_text`, `form` (state/select/toggle/upload), `scroll`, `press_key` |
| **Element Intel** | `reveal` (dropdown/tabs/accordion), `inspect` (element/geometry/relation) |
| **Tabs & Navigation** | `navigate`, `tabs` (list/switch/close/bind/frames/windows/focus/move/transfer) |
| **Wait** | `wait` (conditions ANDed, event mode) |
| **Page Control** | `evaluate`, `screenshot`, `dialog`, `session` (reset/map/mermaid/task), `console_log`, `network_log` |
| **Clipboard & AX** | `clipboard`, `ax` (canvas SPAs, chrome:// pages), `cookies`, `downloads` |

**Highlights**
- **`explore_page {incremental:true}`** — after any action, returns *only* what changed
  (added/changed/removed with per-field diffs) instead of re-dumping the whole page. Refs stay
  stable across incremental calls.
- **`click` auto-climb** — if a synthetic click produces no state change (stubborn React
  submits), it can escalate to a genuine OS-level click. *Windows-only enhancement, off by
  default* (`WEBSENSE_AUTOCLIMB=1` env or `autoClimb:true`).
- **`read {format:"diff"}`** — only the text that changed since the last read.

---

## Platform support

| Feature | Windows | macOS / Linux |
|---|---|---|
| Core browsing (explore/read/click/type/form/tabs/wait) | ✅ | ✅ |
| OS-level dialog keystroke (`dialog keystroke:true`) | ✅ (PowerShell SendKeys) | ❌ (graceful error) |
| Auto-climb real-click | ✅ (PowerShell user32) | ❌ (graceful error) |
| `scripts/native_upload.py` (native file picker) | ✅ (pywinauto + cua-driver) | ❌ |

Everything marked ❌ degrades gracefully — the tool returns an honest error message, never
crashes. Core browsing is fully cross-platform.

---

## Security & privacy

- **Runs in YOUR Chrome profile** — your cookies, sessions, and fingerprint. It never leaves
  your machine: everything is localhost.
- **Manifest permissions**: `tabs`, `offscreen`, `scripting`, `webNavigation`, `downloads`,
  `clipboardRead/Write`, `cookies`, `activeTab`, `debugger` (used only by the optional `ax`
  tool for canvas SPAs), plus `<all_urls>` host access.
- **`cookies` tool** can read/clear cookie *values* for the current tab — treat it as
  sensitive; it exists for session-transplant workflows.
- **No telemetry. No network calls** from the server other than the localhost WebSocket hub.

---

## Known limitations

- **Logged-in sites** must already be authenticated in the Chrome profile the extension runs in
  (`navigate` opens a fresh tab that uses existing session cookies).
- **`evaluate`** uses `new Function` (eval) → blocked by strict page CSP (LinkedIn, HN). It's a
  power-user utility; the rest of the surface is CSP-safe.
- **Canvas / WebGL content** (Telegram web, TradingView): use the `ax` tool (native accessibility
  tree via `chrome.debugger`) or `screenshot` + vision.
- **Native OS dialogs** (basic-auth, print): `dialog keystroke:true` (Windows) or your platform's
  native automation.

---

## Development

```bash
# Regression suite (hub-level, no Chrome needed)
node test-regressions.mjs

# Full end-to-end live test (needs Chrome + extension loaded)
node test/mcp-client-test.js
```

### File structure
```
websense-mcp/
├── src/
│   ├── server.js       # MCP server, 24 consolidated tools
│   ├── hub.js          # WebSocket hub (multi-slot, latch-proof)
│   ├── session.js      # Exploration map + task state machine
│   ├── incr.js         # Incremental explore diff engine
│   ├── climb.js        # Auto-climb decision logic (pure)
│   ├── summarize.js    # Goal-aware read summarization (pure)
│   ├── upload.js       # Upload verdict logic (pure)
│   └── mermaid.js      # Mermaid journey export
├── extension/
│   ├── manifest.json   # Chrome MV3
│   ├── background.js   # Service worker
│   ├── offscreen.js    # WS client, auto-reconnect, watchdog
│   └── websense-cs.js  # SAG extraction + native interaction
├── scripts/
│   ├── native_upload.py    # Windows native-file-picker helper (optional)
│   └── kill-server.ps1     # Windows dev utility (optional)
└── test/               # Regression + E2E + fixture pages
```

---

## License & support

**MIT** — use it, fork it, ship it. If WebSense saves you hours, a coffee is appreciated ☕

[GitHub Sponsors](https://github.com/sponsors/spliffspliff70-wq) · [Ko-fi](https://ko-fi.com/spliffspliff70)
