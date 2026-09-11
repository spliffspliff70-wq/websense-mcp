# Changelog

All notable changes to WebSense MCP are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [1.2.0] — 2026-09-11

### Why this release exists

A transport audit found that the extension was doing three things that made
the bridge feel unreliable to drive, even though the DOM layer was sound:
opening a WebSocket that could never connect, holding hub slots that could
never be used, and reporting failures that named no hop. The third one is the
expensive one — a bare `Request timeout (30s) for page_state` is
indistinguishable from a dead relay, a backgrounded tab, a minimized window, a
CSP block, or a genuinely slow page, so the only rational response is to retry
or guess. This release removes the first two and fixes the third.

### Added
- **Timeout errors now name the failing hop.** `hub._timeoutDiag()` reports the
  op, the client the request was routed through (id + type + readyState), the
  target tab, the full client census (registered / offscreen / mainFrameCS /
  contentTabs), the in-flight count, and a likely-cause line specific to the
  hop that was used. `Extension not connected` carries the same census.
- **Regression tests for all of the above** — `test-regressions.mjs` grew from
  42 to 49 tests: three cover the diagnostics, four are static guards on the
  content script (the CS needs a DOM, so its invariants are asserted against
  source to keep the failure loops from silently returning).

### Changed — behaviour
- **The direct content-script WebSocket bridge is now main-frame-only.**
  It is skipped in ad frames (pre-existing) AND in subframes. Verified against
  the hub's own routing: `handleMessage` only writes `contentByTab` on
  `if (msg.tabId && msg.isMainFrame)`, so a subframe client can never be
  selected for a page op, and frame-targeted delivery goes through
  `chrome.tabs.sendMessage(tabId, msg, {frameId})`. Subframe sockets only
  inflated hub membership (measured peak: 24 concurrent clients, 664
  disconnects in a single log) and widened the wrong-client/hijack surface.
- **Reconnect now backs off exponentially and gives up**, instead of retrying
  a doomed socket every 3 seconds forever. Delays are 3s → 6s → 12s → 24s
  (ceiling 60s) and it stops after 4 consecutive failures. A real state change
  resets the streak and retries once: when the tab becomes visible again, the
  content script resets and reconnects — the one honest reason to try again.
- **`wsVersion` / `csBuild` markers bumped to `v4.4.0` / `v4.4.0-bridge-gate`**
  so a live tab can be checked against the on-disk build (`page_state` reports
  `csBuild`). This is how you tell whether an extension reload actually landed.

### Notes
- **Not gated on `https`.** An early draft of this fix assumed Chrome's
  mixed-content rule blocks plain `ws://` from every https page. That is
  false — content-script clients were observed connecting as MAIN on
  `https://hackerone.com` tabs. What actually blocks the socket is the *site's*
  own CSP `connect-src` (x.com and LinkedIn are strict; many sites are not),
  which a content script cannot know in advance. That case is handled by
  backoff + give-up, not by a protocol guess that would have disabled working
  sites. A regression test asserts the gate never consults `location.protocol`.
- **After editing any extension file, the extension must be reloaded** for the
  change to reach already-open tabs. Content scripts re-inject on the next
  navigation; an SPA route change does *not* re-inject them, so verify a
  cross-origin navigation before concluding a reload failed.

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
- **Cross-platform verification (4 sites, same day):** the component-automation patterns
  were validated beyond Reddit — x.com/Draft.js (fill 0.06s), LinkedIn/ProseMirror-tiptap
  (1.6s), Gmail compose (1.09s). Refinements: the main_world editor wall is per-framework
  (only Lexical reverts synthetic paste — Draft.js/ProseMirror/Gmail accept it);
  userScripts.execute does not await async functions (sync functions + external polling);
  Draft.js same-call reads return 0 (async commit) and selectAll+delete corrupts its state;
  locale-proof element matching (LinkedIn Romanian UI defeated aria-label matching).
