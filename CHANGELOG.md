# Changelog

All notable changes to WebSense MCP are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [1.4.0] — 2026-09-11

Closes out the "remaining issues" list from the 1.3.x audit. Every claim below was
verified against the RUNNING extension and hub, not just the source.

### Added

- **`GET /health` on the hub is now a REAL client census** (it was a stub one-liner).
  Returns: hub uptime; every registered client with id / type
  (offscreen | content-script) / isMainFrame / url / tabId / readyState / connectedAt;
  the `contentByTab` registry; which client each tab routes to; the currently selected
  main-frame client; and every in-flight request with its op and age. Strictly
  read-only — it never sends on a socket and never mutates a map. Sample:

  ```json
  { "status": "ok", "hub": { "uptime": "00m 15s" }, "clientsRegistered": 2,
    "clients": [ { "id": "c1", "type": "offscreen", "readyStateName": "OPEN" },
                 { "id": "c2", "type": "content-script", "isMainFrame": true,
                   "tabId": 328024153, "connectedForMs": 13052 } ],
    "contentTabs": 1, "selectedTabId": 328024153, "inFlightCount": 0 }
  ```

- **Failure payloads keep their structured detail.** See "Fixed" — this one change
  improves the diagnosis of EVERY failing tool call in the project.

- **`status` on every tab in the tab list** — attribution for "why hasn't the content
  script registered yet".

- **Modular content-script sources** — `extension/websense-cs.js` (3,767 lines) is now
  built from nine files under `extension/cs-src/`, in filename order:

  ```
  00-bridge-and-transport.js   453 lines   bridge, wsLog, connect/backoff, dispatch
  10-refs-and-locators.js      177         ref assignment, locators, self-healing
  20-dom-semantics.js          442         visibility, interactivity, classify, intent
  30-content-and-geometry.js   416         markdown dump, scroll+extract, geometry
  40-site-quirks-and-sections.js 111       per-site quirks, sections, page type
  50-candidates.js             710         candidate collection + shadow DOM
  60-native-actions.js         937         SAG build + every native* action primitive
  70-capture-and-readers.js    363         network/console capture, readers, state
  80-op-dispatch-and-boot.js   147         the op dispatcher, diff/event observers
  ```

  `node tools/build-cs.mjs` regenerates the shipped file; `node tools/build-cs.mjs --check`
  fails if the two are out of sync, and the test suite asserts they match — so a
  hand-edit of the built file fails loudly instead of being silently reverted.

  **Why a build step and not several manifest `js:` entries:** each content-script
  file is parsed independently, so splitting the runtime across files would stop
  function declarations being hoisted ACROSS files, and any top-level statement calling
  a function declared in a later file would break at load. The shipped artifact stays a
  single IIFE. A test asserts the manifest still lists exactly one file.

- **`tools/reload-extension.py`** — reloads the extension in the background with no
  human click. See "Fixed" for the three bugs that made this necessary.

- **`bench/curve_now.py`, `bench/probe_sweep.py`, `bench/gen_heavycss.py`,
  `bench/verify_140.py`** — the benchmark/verification harnesses behind the numbers in
  `bench/BENCH_REPORT.md`.

### Fixed

- **Structured failure detail was destroyed at the hub boundary — for every tool.**
  `hub._settlePending()` rejected a failed op with a bare
  `new Error(msg.data.error)`, discarding every other field; `server.safeHandler()` then
  returned only `{success:false, error}`. So a failure that carefully named its hop,
  reason, hint and tabId arrived at the caller as one anonymous string. That is the same
  attribution loss the hop-naming timeout work set out to fix, reintroduced one layer up.
  A failing call now returns the whole payload:

  ```json
  { "success": false, "error": "content-script-not-ready", "tabId": 328024472,
    "url": "https://chromewebstore.google.com/", "status": "complete",
    "reason": "restricted-url", "hop": "bg->chrome.tabs",
    "hint": "Content scripts never run on … Navigate to an http(s) page first." }
  ```

  Additive — existing consumers still read `error`.

- **`real_input.py activate-tab` could never activate the tab it was asked for.**
  It required the `--gate` string to already be in the Chrome window title in order to
  FIND the window — circular, because the gate only matches AFTER activation. So
  `activate-tab --match popup.html --gate popup.html` always failed with
  "Chrome window not found" while the tab sat there backgrounded. It now prefers a window
  already satisfying the gate, falls back to any Chrome window, activates, then verifies
  (as its own docstring always said).

- **`chrome.tabs.sendMessage` rejections no longer escape as unhandled promises** in the
  service worker. A rejection is recognised (`isNoReceivingEnd`) and converted into a
  structured, hop-naming object (`sendMsgError`); every call site is now awaited inside
  try/catch or has `.catch()`.

- **Fast-fail pre-flight for page ops.** One `chrome.tabs.get` (no injection, no poll)
  rejects a page op in ~1ms with a named hop when the target tab is gone or on a URL
  where a content script can never run — instead of hanging for the hub's 30s (90s for
  heavy ops) timeout. Deliberately uses `tabs.get`, not `tabs.query`, which has been
  observed to throw "Extension context invalidated" after a service-worker context loss.

  **Deliberately does NOT hard-fail on `tab.status !== 'complete'`.** A tab reports
  `loading` until its load event, and a page with long-polling/streaming/never-finishing
  subresources can sit at `loading` indefinitely while its content script is perfectly
  usable. Blocking there would turn working ops into failures, so the load state is
  carried as a warning and surfaced only if the sendMessage actually fails.

- **`healthCheck()` no longer calls `activeClient()` with no argument**, and
  `activeClient()` normalises `cmd` so a no-arg call can never throw
  `Cannot read properties of undefined (reading 'tabId')` again. Evidence: `hub.log`
  contains 4,981 occurrences of exactly that error and it is the log's last line;
  4,981 × the 30s health interval ≈ 41.5 hours, consistent with a ping that threw on
  every tick and was swallowed by `process.on('uncaughtException')`. Which revision
  carried the unguarded read is NOT verified — the immediately preceding revision already
  guarded it, so this is hardening against a regression.

- **Content script: one full-DOM query instead of two.** `_collectSelectorHits()` did a
  `querySelectorAll('*')` walk for shadow-host discovery, and the caller then did the same
  walk again just to count elements. The document-level walk now happens once and is
  reused for both; shadow subtrees keep their own recursion (`_collectShadowHits`) so
  nested shadow roots still work.

- **Content script: explore cost is now attributed.** `scanMs` alone conflated candidate
  collection, geometry and per-action semantic work, and only the last of those scales
  with `maxActions` — which made the earlier profiling misleading. Now reported separately
  as `candidatesMs` / `geometryMs` / `actionMs` alongside the total.

### Measured

Live, over the MCP transport (no LLM overhead), against the running extension:

| page | elements | before | after |
|---|---|---|---|
| Wikipedia *World War II* | 13,187 | **TIMEOUT, 4/4 runs @ 90s** | **0.084–0.107s**, 87–108 actions |
| x.com search | 2,374 | 23.3s, 1,006,657 B | **0.023s**, 75,024 B |
| example.com | ~30 | 0.653s | 0.017s |

Wikipedia cost split: `candidates 9ms / geometry 18ms / action 23ms = scan 50ms`, with
~57ms of transport — 5,402 candidates examined, 108 returned.

**IntersectionObserver geometry batching was evaluated and REJECTED.** The measurement
says the remaining cost is the per-accepted-action semantic work (~0.65ms each), not
geometry (~0.02ms/element): on a page with 3,000 in-viewport links, `maxActions=50`
costs 78ms and `maxActions=1000` costs 824ms, while the geometry pass is a small
fraction. An async IO rewrite would add real complexity for a gain that does not
materialise. This is recorded so it is not re-attempted on a hunch.

### Notes

- Docs corrected: the runtime exposes **29 tools** (was documented as 21, and elsewhere
  as 43/61). `websense_doctor` is **not** a tool — it is `status kind:"doctor"`;
  `evaluate_safe` is **not** a tool — it is `evaluate {query:{…}}`. Eight tools
  (`console_log`, `cookies`, `main_world`, `real_activate_tab`, `real_click`,
  `real_paste`, `respawn_offscreen`, `extension_reload`) were undocumented.
- MV3 service workers re-read their script from disk on restart, so **service-worker
  changes go live without an extension reload** — content-script changes do not. Worth
  knowing when testing.
- Tests: **79** (was 42 at the start of the day), 0 failing.

## [1.3.1] — 2026-09-11

### Fixed

- **`ax` click/type NEVER WORKED — the name matcher threw on every real page.**
  CDP AX values arrive either as a plain string or as an `AXValue` object
  (`{type:'computedString', value:'…', sources:[…]}`). The matcher used
  `v.value || v`, which returned the **object** whenever `value` was the empty
  string, so `.toLowerCase()` threw
  `"(n.name.value || n.name || \"\").toLowerCase is not a function"` and
  matching aborted on the first name-less node — which every page has many of.
  `ax read`/`state` worked (they never called the matcher), so the breakage was
  invisible until a click was attempted. Fixed with an `axStr()` extractor used
  by `axNodeToObj`, `axRead` and `axFindNode`.
  *Side effect of the bug: `ax state` emitted objects instead of strings for
  every node whose computed name was empty.*

- **`extension_reload` could never reach the handler that performs it.**
  The service worker has had an `extension_reload` case since 2026-08-31 that
  calls `chrome.runtime.reload()`. But the SW is not a WebSocket client, and
  nothing forwarded the op to it — `offscreen.js` only relays `ax_*`, and
  `SW_REQUIRED_OPS` contains only `upload_file`/`network_log`. So the command
  fell through every client and silently did nothing, while the tool still
  reported `reloadSent: true` (that flag only ever meant "the WS send
  succeeded"). Routing added for the offscreen doc and the content script, plus
  explicit hub routing.

### Verified live (2026-09-11, real Chrome, no CDP)

Measured over the MCP transport directly, so the numbers are pure tool latency
with no LLM turn overhead. "Before" = pre-1.3.0 code.

| page | elements | before | after | notes |
|---|---|---|---|---|
| Wikipedia *World War II* | 13,187 total | **TIMEOUT, 4/4 runs @ 90 s** | **0.084 s** (87 actions) | the common case: default `explore_page` on a big page |
| x.com search | 2,374 total | 23.3 s, **1,006,657 B** | **0.023 s**, 75,024 B | ≈1,000× faster, 13× smaller |
| example.com | ~30 | 0.653 s, 2,058 B | 0.017 s, 1,907 B | light page |

Per-scan detail after the fix:

```
Wikipedia: scanMs=70   totalElements=13187  candidatesExamined=3502  viewportCandidates=87   returnedActions=87
x.com:     scanMs=13   totalElements=2374   candidatesExamined=192   viewportCandidates=61   returnedActions=61
```

`viewportCandidates` is the tell: viewport-first collection locates the handful
of actionable elements directly instead of crossing the whole document to find
them. Before this release the same scan cost ~5 ms **per element** (2,206
elements ≈ 11 s) because per-element `getBoundingClientRect()` interleaved with
`getComputedStyle()` thrashed layout.

**Kill-test:** the same fix was verified to be a real result, not a
short-circuit — the Wikipedia response returns 87 actions with genuine labels
("Search Wikipedia", "Donate", "View the content page [c]") and 8,770 chars of
content.

## [1.3.0] — 2026-09-11

### Why this release exists

A live benchmark of the MCP transport (no LLM overhead) found the DOM work
itself was fine but the **defaults routed every call into an unbounded scan**,
and that the extension could not reload itself. Measured before this release:

| page | explore_page default | payload |
|---|---|---|
| example.com (~30 els) | 0.65s | 2 KB |
| x.com search | 14.6–23.3s (max 90s) | **1,006,657 B** (~275k tokens) |
| Wikipedia WWII | **TIMEOUT 90s, 4/4 runs** | error |

Scaling law: 556 els = 0.44s · 2,206 els = **11.0s** · 5,506 els = **90s timeout**
· 11,006 els = **90s timeout**. That is ~5 ms per element — the signature of
forced synchronous layout, not of a slow relay.

### Fixed — the defaults were the bug

- **`maxActions` never bounded WORK, only output.** The loop broke when it had
  *accepted* N actions, so on a page with few in-viewport interactives it never
  broke and walked the entire DOM. **Proven:** on the same 2,206-element page,
  `maxActions=5` and `maxActions=200` both cost **11.0s** — a 40× change in the
  cap produced 0% change in time.
- **The default call had NO cap at all.** `explore_page` passed no `maxActions`,
  so the code fell to `options.maxActions || 0` = unbounded. `DEFAULT_MAX_ACTIONS`
  is now 200 and the legacy sync path is bounded too. `maxActions:0` still means
  unbounded for anyone who wants the old behaviour.
- **Two forced-layout reads and one computed-style resolution per element.** The
  old loop ran `isVisible` (→ `getComputedStyle` + `getBoundingClientRect`) then
  `isInViewport` (→ `getBoundingClientRect` again) for every element, in document
  order. Each rect is now read exactly once and passed forward; visibility uses
  native `checkVisibility()` where available instead of `getComputedStyle`.

### Changed — performance

- **Candidates come from a selector, not a walk of every node.** `getAllElements`
  pushed *every* element; an `INTERACTIVE_SELECTOR` list (tags, roles, tabindex,
  contenteditable, aria-haspopup…) plus shadow-root recursion replaces it. The
  `cursor:pointer` sweep — the single most expensive check — is kept for DOMs
  under `CURSOR_SWEEP_MAX_ELEMENTS` (1,800) and skipped above, where it cost more
  than it found; when skipped, the result says `cursorSweepSkipped: true`.
- **Viewport-first ordering.** Old traversal was document order, so the elements
  an agent actually needs could sit hundreds of entries down the list. In-viewport
  elements now sort first, then top-to-bottom.
- **Hard `SCAN_CEILING`** (8,000 elements examined) bounds the worst case even
  when nothing else does.
- **Settle is skipped when the DOM is already quiet.** `waitForSettle` always
  paid a 400 ms quiet window; it now only waits if a mutation happened within
  `SETTLE_SKIP_IF_QUIET_MS` (150 ms). `settle:false` skips it entirely.
- **Unchanged-DOM reuse.** A `MutationObserver` maintains a DOM version; a repeat
  call with identical options inside `SAG_CACHE_TTL_MS` (1.5 s) returns the
  previous map with `cached: true`. Our own `data-websense-ref` writes are
  excluded from the filter so bookkeeping never invalidates the cache.
  `fresh: true` forces a real scan.
- **Content is trimmed on big pages** (`CONTENT_MAX_CHARS`, 6,000) — the other
  half of the 1 MB payload problem.

### Fixed — the extension could not reload itself

- **`extension_reload` had no handler in the offscreen document.** Only the
  service worker had one, but the hub routes an op to whichever client is live —
  and on strict-CSP sites the direct content-script bridge is dead, so the
  *offscreen* is the client that receives it. The message fell through the switch
  and nothing happened, while the tool still reported `reloadSent: true` — a flag
  that only ever meant "the WS send succeeded". All three clients handle it now,
  and the hub routes it explicitly (preferring the offscreen, which calls
  `chrome.runtime.reload()` directly and never dies mid-request).

### Fixed — two correctness bugs found along the way

- **`navigate` did not wait for the navigation to commit.** `chrome.tabs.update`
  resolves when navigation *starts*, so a read issued immediately after returned
  the **old page** — which reads as a flaky tool and provokes retries. `navigate`
  now waits for the tab to reach `complete` on the requested URL (bounded,
  default 10 s) and reports `committed` / `committedUrl`, or `timeout: true` when
  it did not, instead of implying success.
- **The style cache was never cleared.** A module-level `WeakMap` meant a style
  read during one call could be reused in a later one after the element changed —
  an element inside a modal that had since been shown stayed `display:none`
  forever, so dialog controls never appeared in the map. Now rebuilt per
  extraction.

### Added
- `explore_page` exposes `contentMaxLen`, `fresh` and `settle`; `maxActions` is
  actually forwarded (it used to be dropped on the default path).
- Results carry `truncated`, `returnedActions`, `viewportCandidates`,
  `candidatesExamined`, `candidatesFound`, `totalElements`, `scanMs`, and
  `cached`/`cacheAgeMs` when reuse occurred.
- Regression tests: **49 → 60**. The new ones lock the bounded default, the scan
  ceiling, selector-based collection, viewport-first order, single-geometry-read,
  style-cache clearing, settle skipping, versioned reuse, the reload path across
  all three clients + hub routing, and the navigation-commit wait.

### Notes
- **`maxActions` is now a real bound.** A caller who wants the old
  walk-everything behaviour must pass `maxActions: 0` explicitly.
- **A module split of `websense-cs.js` (3,400+ lines, 130+ op branches) was
  deliberately NOT done in this release.** Bundling a mechanical refactor of that
  size with behaviour changes makes a regression unattributable — and there is no
  build step, so a split has to be done with care around how MV3 content scripts
  load. It deserves its own commit with the suite green on both sides.

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
