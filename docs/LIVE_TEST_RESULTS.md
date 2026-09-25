# WebSense — LIVE TEST RESULTS (2026-09-25)

Empirical test of every MCP action on controlled pages, paired with the code map
(`EXTENSION_MAP.md`). Test surfaces:
- **Workbench** (new, comprehensive): `E:/websense-oss/test/pages/workbench.html` served at
  `http://127.0.0.1:38498/pages/workbench.html` (python http.server, dir `E:/websense-oss/test`).
  Covers: buttons, delayed/async work, console, fetch/XHR, form controls incl. contenteditable +
  React-tracker-sim input, file upload, downloads, clipboard, DOM modal, alerts, hash/page/new-tab
  links, outer+inner scroll containers, hover/drag/canvas, iframe, re-render/ticker mutation,
  details/tabs/zero-height. Oracle: `#status` div + main_world reads.
- Existing fixtures: `test/pages/*.html`, `test/harness/editors.html` (harness serve.cjs = port
  38499, root = harness/ only).
- Throwaway tab on https://example.com for cross-origin probes.

Legend: ✅ works as documented · ⚠️ works with caveat · ❌ broken/unusable · 🔍 untested-yet

---

## Core results

| # | Tool | Verdict | Evidence / quirk |
|---|------|---------|------------------|
| 1 | `navigate` | ✅ | `newTab:true` opens background tab (active:false, never activates); reuse by url; binding op per map (unbound session forced fresh tab). Workbench + example.com both opened correctly. |
| 2 | `tabs list` | ✅ | Shows id/url/title/active/status. **Shared cursor discovered on another agent's tab (Ali's chat.z.ai active:true) — my X tab had been hijacked by a concurrent agent (URL changed to an X search).** |
| 3 | `tabs bind` | ✅ | `{action:"bind",tabId}` returns success; subsequent cursor-scoped ops land on that tab. |
| 4 | `tabs switch activate:true` | ✅ | Tab activation (in-window), does not require window focus. |
| 5 | `explore_page` | ✅ | 34 refs E0–E33 in 9 ms scan; locators, predictedEffect, state fields, form/nav split. QUIRKS: `intent` mislabels — "Console x3"→`cancel`, "XHR"→`cancel`, "No-op link"→`reject`; label resolution: inputs show placeholder/value as label (password label "" until filled, then **label = plaintext password — DELTA/label LEAKS password text**); wrapping labels become `type:"unknown"`; `forms:[]` honest (no <form>); `scroll.maxY/pagesBelow` present; hidden `[role=dialog]` counts toward dialogs. |
| 6 | `click` (ref) | ✅ | `dispatchedOn:"resolved"`, beforeState/afterState with full bodyText. Oracle flips verified (READY→CLICK 1). Deepest-element semantics per map (`nativeClick`). |
| 7 | `click` effect verdict | ⚠️ **FALSE-NEGATIVES (4 classes found)** | `classifyEffect` = url/title/readyState/dialogCount only. Classes: (a) **non-action text change** (status div → `LOGGED`) → `effect:confirmed` (bodyText diff caught it) but **DELTA `mutated:false` + panic hint "NOTHING changed / NOT LANDED"** — DELTA fingerprints only interactive elements; (b) **async work** (fetch/XHR handlers) → afterState races promise → `suspected_noop` + `escalation.recommended:'real_click'` + DELTA false; later read = landed (`FETCH_OK len=293`, `XHR_OK 200`); (c) **focus-only click** → all three verdicts blind (focus not fingerprinted, no bodyText change); (d) first-op DELTA = `mutated:null` "no baseline" (honest, seeds next). **Rule: trust oracle/main_world re-read over effect/DELTA for text/focus/async changes; DELTA true-negatives are reliable only for interactive-element fingerprints.** |
| 8 | `escalation.recommended` | ⚠️ **MISLEADING** | On every async/focus/text-false-noop it recommends `real_click` with "React onClick handlers often ignore dispatched events" — **wrong in all4 observed cases** (the synthetic click HAD dispatched; React wasn't involved; the work landed ms later). Guide prose says "read the DELTA" but the escalation text undercuts it. Code: `server.js:776` attaches on any non-confirmed. |
| 9 | `type_text` (single) | ✅ | `confirmed:"value-persisted"`, expected==actual, `reverted:false`; DELTA `fields:["value"]` ✓. |
| 10 | `type_text` (batch `fields[]`) | ⚠️ **false-negative report** | Result: `filled:0, failed:2` — but main_world truth: BOTH landed (`pw:"pw-secret-1"`, `num:"42"`). Batch result block unreliable; DELTA/DOM are truth. Password: fingerprint `value` masked to `null` in DELTA while **label carries plaintext**. |
| 11 | `type_text` (React-tracker input) | ✅ **mechanism verified** | Prototype-setter write bypasses instance tracker by design: proto-backing = `"react native setter ok"`, instance getter = `""` (stale tracker), input event fired. type_text's own read-back used proto getter → correct `value-persisted`. Real React re-syncs tracker on render. |
| 12 | `type_text` (contenteditable) | ✅ | `confirmed:"contenteditable-persisted"`, `execCommandOk:true`, rung ladder visible: `[{paste: dispatched, consumed:false}, {insertText: ok}]` + `framework:"contenteditable"`; `stateTruth` nulls (fill when submit-state probe applies). |
| 13 | `press_key` | ⚠️ **synthetic-only (by design)** | Code: dispatches `keydown/keypress/keyup` KeyboardEvents on ref/activeElement (`cs-src/60:752-765`). **No trusted default actions**: Ctrl+A did NOT select (selection stayed [11,11]), plain `x` did NOT insert (value unchanged). Only fires page JS handlers. Result `{success:true}` regardless of page effect + honest `mutated:false`. Safe (no cross-tab OS risk — has tabId). |
| 14 | `evaluate{script}` | ❌ **blocked everywhere (extension CSP)** | `new Function` in isolated world. Blocked on NO-CSP pages (workbench + b2-destination, `curl -I` = zero CSP headers) with CSP string containing `chrome-extension://13879262-737d-46d9-babd-3079457c51b1/` (⇒ extension's own id — **memory's id `gdcpf…` is stale**). Blocked on x.com too (its script-src has nonces, no unsafe-eval). Code comment claims "blocked by strict page CSP (LinkedIn, HN, H1)" — **understates: current Chrome blocks it universally**; only the `safeDomRead` fallback (scripts shaped `querySelector(All)('…').prop`) succeeds, returning `method:"safe-querySelector*"`. |
| 15 | `evaluate{query}` | ✅ **the CSP-proof read** | `mode:"state"` returned inputCount:10 + all values (incl. password plaintext), scrollH, checked states. DELTA attached (correct `mutated:false` when nothing fingerprint changed). |
| 16 | `main_world` | ✅ **the arbitrary-JS path** | `chrome.userScripts.execute({world:'MAIN'})` — works on http + https, async, JSON-serialized. **Pitfall: `func` must be a FUNCTION EXPRESSION (`() => …`); statement bodies (`return …`/`try{…}`) return `result:null` SILENTLY (success:true!)** — two nulls before the arrow worked. |
| 17 | `console_log` | ✅ **rich** | MAIN-world hook (console-hook.js, registered via `registerContentScripts world:'MAIN'` at document_start) — sees page console.* correctly. Returns `{type,text,ts}` entries incl. WebSense's own `[WEBSENSE] EAG:` pipeline logs (scan timings, settle decisions, WS events) + `totalCaptured`, `capturing`. `clear` default true. |
| 18 | `network_log` | ❌ **BROKEN for page traffic** | Root-caused in code: `startNetworkCapture()` patches `window.fetch` / `XMLHttpRequest.prototype` **in the content script's ISOLATED world** (`cs-src/70:9-47`) — page (main-world) fetch/XHR never pass through it. Test: 4 tight runs (bind→clear→click→read, zero parallel calls) on same-origin fetch AND XHR = `entries:[], totalCaptured:0, capturing:true` while status oracle proved both landed. Also: `totalCaptured` reports post-clear length (always 0 when clear:true) — `getNetworkLog` clears before counting. Console got the MAIN-world fix (background.js:8-28 comment: "the isolated content script can't see it") — **network never did.** |
| 19 | `status{kind:page}` | ✅ with quirks | Full page_state. **`pendingDialogs` from WS_DIALOGS = always [] (see dialogs)**; `hasModal`/`dialogCount` are **visibility-blind** (`[role="dialog"][aria-modal="true"]` matches hidden modals → workbench reports hasModal:true even when closed); `wsDebug` tail shows WS health (1006 churn + `WS_GIVEUP: 4 consecutive failures — not retrying until the tab is activated again` observed on https tabs); `answerTabId:null` when answered via relay path. |
| 20 | JS dialogs (`alert`) | ❌ **neither captured nor blocking** | WS_DIALOGS capture lives in the ISOLATED world (`window.alert = …` override, `cs-src/00:15`) — page-origin alerts bypass it (world isolation, same class as network_log). Empirically on this box **alert() returns instantly, does NOT block the renderer, does NOT appear in pendingDialogs** — for page-origin (click E2), injected main_world origin, tab active or background (example.com + workbench). No dialog flags found in Chrome cmdline. `dialog{action:…}` JS path therefore untestable → treat as moot; **DOM `[role=dialog]` modals are the reliable dialog surface** (hasModal ✓). beforeunload (native) historically parks — distinct path. |
| 21 | `read` (schemas) | 🔍 | formats text/content/markdown/diff/scrollextract/preload; goal+summarizeAt on text path only (per map). |

---

## Tab/cursor/concurrency findings
- **3 tab layers** (map §2): hub global `selectedTabId` + SW `boundTabId`(+explicitBind latch) + per-session claims (TTL 10 min). Cursor moves on OS activation, `tab_event activated`, visibilitychange broadcasts.
- Observed live: cursor on Ali's chat.z.ai; my older X tab hijacked by a concurrent agent (URL rewritten to an X search). `navigate`/`bind` re-home the cursor; ops without tabId follow cursor (`evaluate`, `network_log`, `console_log`, `status`, `read`, `scroll`(?), `wait` — NO tabId in schema → cursor-scoped). **Bind before batches; keep mutations sequential.**
- CS direct WS (`ws://127.0.0.1:38401`) works on http/localhost pages (observed `WS_OPEN` on workbench) but **fails on https pages** (1006×4 → GIVEUP): x.com's CSP `connect-src` proven not to allow it (header capture); example.com (no CSP) also failed (cause unconfirmed — mixed-content/ws policy). Ops still work via relay path (offscreen→SW→tabs.sendMessage). **Degradation: `pushPageEvent` requires `wsReady` → `wait{event:…}` ring stays empty on strict/https pages — use selector/script/url conditions there.**
- `answerTabId:null` = answered via relay, not direct CS.

## Verdict-stack doctrine (emergent, for the how-to)
1. **Op result block** (confirmed/persisted/refused) — best-effort, high quality for value-fills.
2. **DELTA** — reliable ONLY for interactive-element fingerprint changes; misses bodyText/focus/async; `mutated:false` hint text is overstated ("NOT LANDED").
3. **effect + escalation** — weakest; url/title/readyState/dialogCount only; escalation recommends `real_click` even on success-path false-noops.
4. **Ground truth**: `main_world` oracle read / `#status` / external state. Always for text/focus/async.

## Known-good rungs (as of today)
- Deletion chain on x.com: caret by CSS ref (`article:has(a[href*="ID"]) [data-testid="caret"]`) → menuitem → confirm — all synthetic `click`, zero foreground (2026-09-25, 5/5 posts).
- Multi-slot composer: `form upload` → `real_click addButton` (fresh rect each time; synthetic = wipes composer — documented exception) → `type_text` slots → single `[data-testid="tweetButton"]` ("Post all").
- `real_click` schema: `{x,y,gate}`; gate = active-tab title substring; raises Chrome, viewport coords + auto doc-origin (~121 px); focus restored.

## Batch 2 findings (scroll/reveal/wait/refs — 2026-09-25, code-root-caused)

| # | Tool | Verdict | Evidence / quirk |
|---|------|---------|------------------|
| 21 | `scroll` direction+amount | ✅ | Tick mode (1 tick ≈ 80% vh), window or ref's scrollable ancestor (clamped to max: outer 340). |
| 22 | `scroll` y | ⚠️ | **`ref` IGNORED** — server.js:963 `y` branch fires before ref handling; target = `findScrollContainer()`/documentElement (window went 773→150 while `#innerScroll` stayed 0). |
| 23 | `scroll` intoView | ⚠️ | success:true but **NO movement (×2)** — `nativeScrollIntoView` = `scrollIntoView({behavior:'smooth'})` (60-native:550); animation suspended on occluded tabs. Instant paths work backgrounded. Verify with a rect read. |
| 24 | `page_snapshot` | ✅ | handle `snap:328031300:1`,98 elements (off-viewport included), dims (interactive40/inViewport57/named68), addressableBy tag/role/region/vp/interactive/query. |
| 25 | `page_slice` ×4 | ✅ | `tag:"button"`→19; `query:"Increment"`→**1 (substring TEXT search, NOT CSS)**; `role:"dialog"`→hidden modal (visibility-blind); `interactive:true`→40. Compact records {i,tag,loc,region,name,x,y,dis,role}. |
| 26 | `inspect geometry` | ✅ | viewport box (y=-50 offscreen), container+absolute pos, scroll context, zDepth, position, text. |
| 27 | `inspect relation` | ✅ | verdict "above" + both boxes + hint. |
| 28 | `inspect element` | ✅ | resolve: found/value/locator/connected. |
| 29 | `reveal` dropdown (ref) | ❌ | **Double-resolve bug: cs-src/00-bridge:377 `getDropdownOptions(resolveRef(ref))` — reader re-resolves (string map) → element in → null → "Element not found".** Direct-WS path only; relay path (70-capture:249) passes raw ref. Failed for `#sel`, `E18`, `#custdd`, live `E52`. |
| 30 | `reveal` accordion (no ref) | ✅ | Document scan works even on direct path (ref undefined skips bug) — found `<details>` + injected combobox. |
| 31 | `wait` urlContains | ✅ | success + page_state payload (url/hasModal/hasCaptcha/isLoading/pendingDialogs). |
| 32 | `wait` selector | ✅ **FIXED 2026-09-25 — was genuinely broken.** Root cause: the branch sent an EVAL probe first, expected it CSP-blocked, then sent the no-eval safe-query form. That dependency never held (the extension's own CSP blocks the probe on EVERY page), so the fallback never ran — log showed exactly **1** evaluate send/poll, and `#txt` timed out although `evaluate{query}` proved it present. Fix: ask the no-eval path FIRST. Live-verified after: existing→`success:true, timedOut:false`; missing `#nope_never`→`timedOut:true`; `wait{script}` and `wait{urlContains}` also green. Two earlier accounts of this bug were wrong (first "hub rejects r1", then "it always worked") — both discarded. |
| 33 | `wait` script qSA-shaped | ✅ | selM branch (server.js:1180-1184) works: found gate honored; `#nope_never` → timedOut:true after full3s (8 polls, 1/iter ✓). |
| 34 | `wait` script arbitrary JS | ❌(by design) | CSP → `ok=false` every poll (line1189 requires !isCspBlocked). |
| 35 | Ref renumbering | ⚠️ | Full explore renumbers by **in-viewport order**: E7=btn-delayed@scroll0 → **E7=input@scroll150** (clicked wrong element; delayedFlag never appeared). Post-heal refs reached E52. CSS selectors immune. |
| 36 | CSS ref on click | ✅ | `#btn-delayed` → dispatchedOn:"resolved", landed (DELAYED_OK after600ms). Auto-scroll-into-view by nativeClick re-adds off-viewport elements to DELTA (added:6). |
| 37 | `evaluate` query/state | ✅ | mode:"state", inputCount+all values (password plaintext echoes — label/value surfaces leak fills), scrollH, url. |
| 38 | main_world userScripts vs evaluate | ✅/❌ | `func` = expression (arrows); statement bodies → silent null. `evaluate{script}` new Function = **CSP-blocked on every page** (governing CSP = extension's own; block string contains `chrome-extension://13879262-737d-46d9-babd-3079457c51b1` = WebSense's real current ID — `gdcpf...` memory id is STALE); safeDomRead rescues only `querySelector('...')` shapes (+ optional .textContent/.value/checked/href/src/options property). |

### Additional durable lessons
- **hub.send contract (hub.js:437-438): resolves on the TOP-LEVEL `msg.success` (the envelope); `data.success:false` still RESOLVES.** Only transport failures and falsy top-level `success` reject. Correction to an earlier note here: this was wrongly read as "r1 rejects, so wait's r2 is dead code" — the hub resolves fine. The real wait bug was different: the branch only sent r2 if r1 *came back cspBlocked*, and the extension's own CSP made r1 unusable, so r2 was never sent (1 send/poll, measured).
- **JS `alert()` on this box**: neither captured (WS_DIALOGS empty) nor blocking (page + injected, active + inactive). `dialogCount`/`hasModal` = visibility-blind DOM scans. DOM `[role=dialog]` modals = the reliable dialog surface; `hasModal:true` counted a HIDDEN modal.
- **WS-GIVEUP**: content script's own `ws://127.0.0.1:38401` fails on https pages (x.com `connect-src` provably lacks loopback; example.com fails too) → ops fall back to relay (work) but **page_event pushes (wait{event} on strict sites) depend on wsReady → degraded**; http/localhost pages connect directly (WS_OPEN in console).
- **`totalCaptured` in network_log is post-clear** (always 0 when clear:true).
- Parallel cursor-scoped op batches can split across cursor changes; chat.z.ai being Ali's active tab does NOT itself move `selectedTabId` (bind persists) — reveal's failures were the double-resolve bug, not the cursor; the batch-race risk remains for no-tabId ops.

## Batch 3 findings (forms/modes/nav/read/diagnostics/heal — 2026-09-25)

| # | Tool | Verdict | Evidence / quirk |
|---|------|---------|------------------|
| 39 | `form{action:upload}` | ✅ | **`ref` required** (structured error lists missing args). `{ref:E24,file:...png}` → fileName/size77782/`method:"file_input"`/`confirmed:"preview-visible"`/`realmReadbackUnreliable:false` + DELTA value `C:\fakepath\...`. Oracle: page handler → `FILE:ornith_table.png`. SW-routed (upload_file). |
| 40 | `clipboard copy/read` | ✅ both directions | Tool→system (`WB_CLIP_TOOL`) + system→tool (read returned it). **Page-side `navigator.clipboard` on an INACTIVE tab: readText → `NotAllowedError`; writeText did not land** (platform focus rule, not a WebSense bug). |
| 41 | `click mode:hover` | ✅ | `{success,label}` + auto-scroll side effects visible in DELTA (30 removed/8 added from the scroll jump). |
| 42 | `click mode:rightclick` | ✅ | Synthetic — does NOT open the native context menu (safe, no wedge). |
| 43 | `click mode:drag` | ✅ **DnD works synthetic** | `fromRef/toRef` → my drop handler fired → `status:"DROPPED"` (oracle). |
| 44 | hash/SPA link click | ✅ | url → `#section-2` + status flip → `effect:"confirmed"` (url = strongest classifier input). |
| 45 | `target=_blank` click | ✅ | `background:true, blankTarget:true, tabId:328031309` — opened in BACKGROUND (never activates); verdict `suspected_noop` noise (page unchanged). |
| 46 | download link click | ✅ | verdict `suspected_noop` BUT `status{kind:downloads}` top entry = `wb.txt, complete,26 bytes, endTime=now` → landed (downloads store = the oracle; also exposes FULL download history). |
| 47 | `read format:text` | ✅ | Clean section text via selector. |
| 48 | `read format:diff` | ✅ | `{changed,since,modal,form,textChanged,entries,hint:"no changes since last read"}` — per-tab read-state based. |
| 49 | `cookies list` | ✅ | `{success,domain,cookies[]}` (empty on loopback as expected). |
| 50 | `session map` | ✅ **forensic goldmine** | pages graph (title/visits/outgoingActions with leadsTo) + **shared global step history across ALL agents** (100 steps: my workbench ops interleaved with another agent's chat.z.ai typing + x.com searches). Proves `navigate{reused:true}` tab-steal mechanism. `session reset` = wipes shared state — avoid while others work. |
| 51 | `ax state` | ✅ | chrome.debugger-backed: nodeCount226, roles/names/states (focusable, checked, valuetext, hasPopup, expanded, **focused**, editable) — works on inactive tab via attach path. Rich non-vision read. |
| 52 | rerender heal | ⚠️ **op-inconsistent** | After DOM replace: `click E0` → SUCCESS (locator-chain rebuild path), but `type_text E0` → "Element not found" (keyboard path = refMap-only, no heal) and `inspect E0` → "ref not found". **Rule: re-explore after any re-render before typing/inspecting; click may succeed through locators and mask ref rot.** |
| 53 | explore `full:true` | ⚠️ documented | DEFAULT explore = **viewport-scoped actions** (34@scroll0 vs28 after scroll); `full:true` = include offscreen. compact ≈ same rich records minus content/forms. |
| 54 | explore `intent` | ⚠️ keyword-matching | `"download a file"`→0 (great zero-hit note); `"download"`→2 with locators. Short keywords only. `intent` field itself mislabels (`cancel` on Console/XHR, `enter text` on checkboxes) — labels/locators authoritative. |
| 55 | `tabs frames` | ⚠️ **ignores passed tabId** | `frames{tabId:workbench}` returned **chat.z.ai's frames** (browser-active tab). Frames listing = active-tab scoped. |
| 56 | `navigate{tabId}` | ⚠️ **tabId silently ignored** | `{tabId:spare,url:a2}` → **reused the CURSOR tab** (my workbench hijacked by my own call). Move the cursor first (`tabs bind`) or `navigate{newTab:true}`. |
| 57 | `status{kind:doctor}` | ⚠️ rich but SW section broken | clients/session/framework/quirks/wsDebug ✓ — but **`serviceWorker.error:"Unknown content action: doctor_sw"`** (SW handler lacks the action → always structured error). |
| 58 | `respawn_offscreen` | ✅ | `{success,message:"offscreen respawned"}`; page ops worked immediately after; `status{kind:bridge}` showed transient `pageConnected:false, pageProbe:"empty"` (recovers). |
| 59 | effect verdicts live | ⚠️ **classifyEffect behaves unlike `server.js:79-94`** | Current file says: any quickState divergence → `confirmed`, identical → `suspected_noop`. Observed: rerender with **bodyText differing** → `unverifiable`; identical states → `unverifiable` (file: suspected_noop). Same server (PID3672 started today00:45 > file mtime Sep21) → **unseen input/layer in live classification**. Combined with wait-selector (batch2 #32): **two file-vs-behavior mismatches → treat behavior as spec, add to fix list.** |
| 60 | escalation on FAILED type_text | ⚠️ | `effect:"failed"` + `recommended:"re_read"` ("re-explore and re-type clearFirst:true before OS-level") — this one is GOOD advice (failed-path escalation is sensible; success-path escalation is the noisy one). |
