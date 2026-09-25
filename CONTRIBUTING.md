# Contributing to WebSense MCP

Thanks for your interest in contributing! 🎉

## How to contribute

1. **Fork** the repo and create your branch from `main`
2. **Install**: `npm install`
3. **Test**: `npm test` — the full suite must pass (currently 133)
4. **Syntax check** your changes: `node --check <file>` for every touched `.js` file
5. **Content-script changes**: edit `extension/cs-src/*.js`, then run `node tools/build-cs.mjs`.
   Never hand-edit `extension/websense-cs.js` — it is generated, and a test fails if the
   committed artifact differs from a fresh build.
6. **Guide changes**: if you edit the `websense_guide` text in `src/server.js`, run
   `node tools/export-guide.mjs` to regenerate `MODEL_PROMPT.md`. A test fails if they drift.
7. **Open a Pull Request** with a clear description of what changed and why

## Before you push: update the docs where the claim lives

A changelog entry is a receipt, not documentation. When behavior changes, update every surface a
reader or an agent can learn from:

- the in-tool guide (`websense_guide` in `src/server.js`) — this is what an agent reads at runtime
  and it outranks everything else
- `README.md` — and check that two sections cannot contradict each other
- tool `description` strings in `src/server.js`
- the skill, if you use WebSense in your own agent work

If a documented "limitation" turns out to be a bug, do not just delete the caveat — state the
measured behavior in its place, with the numbers. A removed caveat reads like a regression.

Keep `CHANGELOG.md` entries short: version, date, and a few one-line bullets. Detail belongs in
the docs.

## Gotcha: line endings will fail your CI silently

The generated `extension/websense-cs.js` is **byte-compared** against a fresh build by the test
suite. That makes it sensitive to line endings, and a Windows checkout with `core.autocrlf=true`
plus a Linux CI runner will disagree — the suite passes locally and fails in CI.

This is not hypothetical: it failed five consecutive pushes in September 2026 before anyone looked
at the badge. The repository now ships a `.gitattributes` pinning LF, and `tools/build-cs.mjs`
normalizes before writing, but the trap can return if either is edited carelessly.

**Before you claim a fix is verified:** run the suite, then confirm in a clean checkout.

```bash
git clone <your-fork> /tmp/verify && cd /tmp/verify
git config core.autocrlf false
npm install && npm test
```

A test that compares bytes across a checkout boundary only passes on the machine that wrote it.
The clean clone is the only thing that reproduces CI.

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
