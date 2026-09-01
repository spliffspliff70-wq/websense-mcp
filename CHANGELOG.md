# Changelog

All notable changes to WebSense MCP are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [1.1.1] — 2026-08-31

### Fixed
- **`screenshot` failed on background tabs** ("image readback failed") — now falls back to
  `chrome.debugger` `Page.captureScreenshot` on the bound tab (mode: `debugger-fallback` in
  the response). The visible-tab path is unchanged and preferred.

### Changed
- README: added a plain-language "What WebSense does" section (Chrome-extension framing made
  explicit) and a Credits section acknowledging design ideas borrowed from agentreach,
  Hermes Agent, the computer-use ecosystem, and Playwright/Puppeteer; Known Limitations
  re-verified via a full 24-tool audit (screenshot limitation fixed, Chrome-only and other
  trade-offs documented).

## [1.1.0] — 2026-08-31

### Fixed
- **Below-fold clicks died with `Element not found`** — refs are now stable across explores
  (`refCounter` no longer resets on re-scan; refs only reset on SPA navigation), and
  `resolveRefHealed` retries resolution with a full SAG rebuild before giving up
- **`explore_page{intent}` returned 0 matches for label-only elements** (e.g. a "LICENSE"
  link with no name/id attribute) — intent matching now also covers element label text + href
- **Stale `pageConnected:false`** in bridge status — on `get_status` probe timeout the
  status now falls back to the session's last-known URL and reports `pageProbe: timeout-fallback`
  instead of a hard false
- **Foreground steals** — auto-climb real-click now refuses to fire when the OS foreground
  window is not Chrome (`GetForegroundWindow` → `Get-Process` name check); breaks the
  "agent clicks into my active app" class
- **`form{action:'state'}` was a dead tool** — `getFormState` was referenced in the message
  switch but never implemented; now implemented (SAG-shape form state, also resolves by form id)
- **Direct-WS bridge parity** — `tab_contents`, `accordion_contents`, `handle_dialog`,
  `get_status`, `ping` were only handled on the SW-relay path; `read_clipboard` now has an
  inline implementation. `reveal{kind:'tabs'|'accordion'}`, `dialog{action}`, and clipboard
  read all work on both relay paths now

### Added
- `pageProbe` field in bridge status (`live` | `timeout-fallback` | `empty` | `none`)

## [1.0.0] — 2026-08-31

Initial open-source release.

- 24-tool consolidated MCP surface (from an original 65-tool surface)
- Semantic Action Graph exploration (full / compact / intent / goal / incremental modes)
- Native-setter typing (React/Vue/Angular controlled inputs) — CSP-safe, isolated world
- Before/after state diff on every click with effect verdicts
  (confirmed / suspected_noop / unverifiable)
- Auto-climb on `suspected_noop` (optional, triple-guarded OS-level real click)
- Goal-aware read summarization, incremental explore diffing
- Session task-stack, cookies manager, downloads manager, offscreen respawn
- Background-only navigation (target=_blank interception, no tab activation)
- MIT license

## [Unreleased] — 2026-09-01

### Documented
- **Reddit composer speed run** (`docs/reddit-speed-run-2026-09-01.md`) — timed E2E on two
  subreddits (r/hermesagent flair-enforced, r/mcp): full composer fill in ~2s. Fast paths:
  title via `main_world` shadow-key on `post-composer-title` (0.02s), flair via
  `r-post-tags-section.handleClick()` + modal radio/apply button IDs (0.03s), submit gate =
  `r-post-form-submit-button.form.isValid`.
- **Hard wall documented:** Lexical editors silently revert ALL `main_world` writes —
  `execCommand('insertText')` and synthetic `ClipboardEvent('paste')` with DataTransfer both
  return undefined with an unchanged editor. The content-script `type_text` paste rung
  (real paste pipeline) is the only accepted path (1.8-2.3s).
- **Per-tab content-script wedge recovery:** if `main_world` and `evaluate` both time out on
  a single tab (other tabs fine), that tab's content script is dead from a killed in-flight
  userScript. Fix: close the tab + open a fresh one — navigate/reload/re-bind do not recover.
- **Platform-agnostic component-automation patterns** (`docs/component-automation-patterns.md`)
  — the 7 transferable patterns behind the Reddit speed run: prototype-walk state discovery,
  shadow-key writes, the Lexical/Draft.js editor wall, synthetic-click escalation ladder,
  shadow-tree BFS modal discovery, per-tab CS wedge recovery, time discipline. Applies to any
  site with shadow-DOM custom elements and modern editors, not just Reddit.
