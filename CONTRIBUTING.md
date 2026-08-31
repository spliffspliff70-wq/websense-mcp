# Contributing to WebSense MCP

Thanks for your interest in contributing! 🎉

## How to contribute

1. **Fork** the repo and create your branch from `main`
2. **Install**: `npm install`
3. **Test**: `node test-regressions.mjs` — all tests must pass (currently 42)
4. **Syntax check** your changes: `node --check <file>` for every touched `.js` file
5. **Open a Pull Request** with a clear description of what changed and why

## Ground rules

- **No CDP** — this project's core principle is no DevTools protocol, no `navigator.webdriver`, no debug ports. PRs introducing CDP will be declined.
- **Background-first** — page operations must never steal the user's foreground. Never set `active:true` on tab opens; never add unguarded OS-level input paths.
- **Honest verdicts** — tool results must never fake success. If an effect can't be confirmed, return `suspected_noop`/`unverifiable` with an escalation hint, never a silent `success:true`.
- **CSP-safe** — content-script operations use native DOM setters in the isolated world. No `eval`, no string-to-code.
- **Test coverage** — new behavior needs a regression test in `test-regressions.mjs` (pure-function tests preferred — see the existing pattern).

## Architecture orientation

```
src/server.js          MCP server (tool registration, inputSchema)
src/hub.js             WebSocket hub on ws://localhost:38401
extension/background.js  service worker — tab management, binding
extension/offscreen.js   WebSocket client, auto-reconnect
extension/websense-cs.js Semantic Action Graph extraction + native DOM interaction
test-regressions.mjs   regression suite (pure functions)
```

The message flow: MCP tool call → server → hub → (offscreen WS | content script WS) → content script → DOM → response back with before/after state.

## Reporting bugs

Open an issue with:
- What you did (exact tool + args)
- What you expected vs what happened (verbatim error text)
- Page/site where it happened (public URL or a minimal repro HTML)
- Whether the bound tab was OS-active at the time

## Feature requests

Open an issue tagged `enhancement` describing the workflow you're trying to accomplish — "what the agent is trying to do" matters more than the specific solution.
