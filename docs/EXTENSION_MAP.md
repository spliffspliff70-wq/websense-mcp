# WebSense — Source Map: actions, states, logic

READ-ONLY code audit of `E:/websense-oss` (WebSense MCP v1.4.4, extension manifest v1.4.1).
Every claim below cites `file:line`. Behavior is derived **from code only** (no runtime testing).
Produced by the EXTENSION_MAP audit; external docs/skills are another agent's scope — §5 only
flags **code vs repo-doc** disagreements (README.md / MODEL_PROMPT.md / in-code guide strings).

Line numbers are as of the working tree checked here (2026-09-25).

---

## 0. Layers, files, and the generated content script

```
MCP client ──stdio/HTTP──> src/server.js (McpServer, 31 tools)
                             │  getActiveHub().send() = withSessionTab() stamping  (server.js:50-67, 267-336)
                             ▼
                    src/hub.js  HubServer, ws://0.0.0.0:38401 (plain ws, TLS optional 38411)
                             │  activeClient() routing (hub.js:311-379)
             ┌───────────────┴─────────────────────────────┐
             ▼ (direct, per-tab)                           ▼ (relay / tab-ops)
   content script raw WS  (cs-src/00:186)        offscreen.js WS client (offscreen.js:346)
   source:'content-script'                        source:'offscreen' (offscreen.js:358)
             │                                            │ chrome.runtime.sendMessage
             │                                            ▼
             │                                   background.js (MV3 SW)
             │                                   TAB_CONTROL / PAGE_CONTROL (background.js:360-412)
             ▼                                            │ chrome.tabs.sendMessage(tabId[, frameId])
   websense-cs.js — wsHandle/wsDispatchPage               ▼
   (cs-src/00:298,348)  ◄────────────────────  chrome.runtime.onMessage handleMessage
                                               (cs-src/70:187, 201) ──► live DOM
```

* **`extension/websense-cs.js` (229 KB) is GENERATED.** `tools/build-cs.mjs:36-56` concatenates
  `extension/cs-src/00..80-*.js` in filename order, wraps them in an IIFE with a banner, and stamps
  `__CS_BUILD__` with `v4.6.1-<sha8>` of the pre-substitution body. `test-regressions.mjs` asserts the
  committed artifact is in sync (`build-cs.mjs:9-15`). **This map is written from `cs-src/`**, whose
  banner says "source of truth … DO NOT edit the built file" (`cs-src/10:47-52`).
  There are **two entry points into the same content-script code**:
  * `wsHandle` → `wsDispatchPage` over the CS's own WebSocket (`cs-src/00:298,348`)
  * `handleMessage` → `handleMessageAsync` over `chrome.runtime.onMessage` (SW relay) (`cs-src/70:187,201`)
  They implement **overlapping but not identical** op sets — see §5.
* Server entry: `package.json` `bin: src/server.js`, `scripts.start = node src/server.js`
  (`package.json`). `main()` starts the hub first, then stdio or `--http` (`server.js:1681-1796`);
  `main().catch` → `process.exit(1)` (`server.js:1798`). Health: `GET /health` on the MCP HTTP port
  returns the hub census (`server.js:1706-1721`), and on the hub port (`hub.js:100-103`).
* Tool registration funnel: `reg()` (`server.js:495-511`) → adds `frameId` (except `NO_FRAME`,
  `server.js:359`), adds `verify` to `DELTA_OPS`, wraps in `safeHandler(withDelta(...))`, then
  `installSchemaMinifier()` rewrites the **wire** `tools/list` output only (`server.js:513-536`;
  caps `WEBSENSE_DESC_CAP`=110, `WEBSENSE_PARAM_CAP`=40, `server.js:347-348`).
* `requireArgs()` (`server.js:104-119`) turns a missing action-specific param into a named error with
  `detail.reason='missing-argument'` + `received` keys, because unknown keys are **stripped by the
  zod schema** before handlers run (`server.js:96-103`).

---

## 1. ACTION CATALOG — 31 MCP tools

Legend: **layer** = who executes; `frameId` is auto-added to every tool not in `NO_FRAME`
(`websense_guide, navigate, tabs, status, wait, evaluate, ax, screenshot, dialog, session,
network_log, console_log, clipboard, inspect` — `server.js:359`). `verify:false` is auto-added to the
9 `DELTA_OPS` (`server.js:414-415, 501-509`).

### 1.1 Guide / status

**`websense_guide`** — `server.js:606` · no params.
Server-only: returns a long template string (the in-tool prompt, quoted in §4). No hub call, no state.

**`status`** — `server.js:1030` · `kind:enum[page|bridge|doctor|downloads]` (default `page`).
* `page` → hub `{type:'page_state'}` → CS `getPageState` (`cs-src/70:254`): url, title, readyState,
  hasModal (selector probe), hasCaptcha, isLoading, `pendingDialogs` (last 5 of `WS_DIALOGS`),
  hasBeforeUnload, viewport, scrollPct, `csBuild`, wsDebug tail, `answerTabId/FrameId/Top`.
* `bridge` → `get_status` raced against a **3 s** timeout; on timeout falls back to
  `session.currentUrl` with `pageProbe:'timeout-fallback'` (never a hard false — comment
  `server.js:1049-1053`).
* `doctor` → `doctor_content` and `doctor_sw`, each raced at **8 s**; either may return
  `{error}` and the other still fills (`server.js:1069-1085`). CS side `doctorContent`
  (`cs-src/70:150`); SW side `handleTabControl 'doctor'` (`background.js:824`: alarms, cookie
  **names+expiry only**, extension id).
* `downloads` → `{type:'download_state'}` → `chrome.downloads.search` (`background.js:756`).
Reads session state (`stepCounter`, `pages.size`, `currentUrl`) in `bridge`/`doctor`.

### 1.2 Explore / read

**`explore_page`** — `server.js:677` · `compact,intent,goal,preload,full,includeContent,includeHidden,
maxActions,incremental,contentMaxLen,fresh,settle` (all optional; `maxActions` default 200).
Dispatch precedence: `intent`→`find_intent`; `goal`→`explore_intent`; `compact`→`discover_actions`;
`preload` first does `preload_content{maxSteps:8,settleMs:250,restore:true}` then the main call;
else `{type:'explore_page', …}` (`server.js:695-701`).
CS: `extractActionGraph` (`cs-src/50:215`) or `exploreIncremental` (`cs-src/50:665`).
State: `session.recordPage(url, sag)`; **`session.setLastSnapshot(sag)` only when the result is not
incremental, or is `escalated`** (`server.js:703-707`).
Errors: zero-hit semantic search is annotated "ZERO-HIT … not an empty page"
(`annotateIntentResult`, `server.js:148-172`); hub timeout 90 s (`HEAVY_OPS`, `hub.js:15-16`).

**`read`** — `server.js:712` · `format:enum[text|content|markdown|diff|scrollextract|preload]` (default
text), `selector,maxLen,offset,scrolls,scrollDelay,direction,maxSteps,settleMs,restore,goal,summarizeAt`.
Maps to hub ops: `page_diff | preload_content | scroll_and_extract | dump_markdown | read_content |
extract_text` (`server.js:730-735`). Text path is post-processed by `summarizeRead` when
`goal` set and length > `summarizeAt` (default 8000) — "Only auto-summarize on the TEXT path"
(`server.js:736-743`). `extract_text` returns an explicit `...[TRUNCATED — offset=N]` footer
(`cs-src/70:255`).

### 1.3 Interact

**`click`** — `server.js:748` · `ref,mode:enum[click|hover|rightclick|drag],x,y,button:enum[left|right|
middle],fromRef,toRef,autoClimb`.
Branching (`server.js:764-773`): `x&&y`→`click_xy`; `drag`→`drag_drop`; `hover`→`hover`;
`rightclick`→`right_click`; else `click`. Only the default branch computes
`result.effect = classifyEffect(result)` and, if not `confirmed`, attaches
`escalation.recommended='real_click'` (`server.js:774-777`), then may **auto-climb** (§3f).
CS `nativeClick` (`cs-src/60:51`): refuses `disabled`/`aria-disabled` with
`refused:'disabled-button'` + adjacent-counter hint (`:57-75`); rewrites `a[target=_blank]` into a
**background** tab open via `relayTabControl('open_new_tab',…{active:false})` (`:76-89`);
`scrollIntoViewIfNeeded`, then picks the **deepest element at the click point** ("real-click
semantics", `:92-99`) and calls `el.click()` or dispatches a MouseEvent (`:130-134`).
State: `session.recordAction`, and on URL change `recordNavigation` + `recordPage`
(`server.js:823-827`). CS wraps with `beforeState/afterState = getQuickState()`
(url/title/readyState/dialogCount, `cs-src/70:122`, `cs-src/70:208`).

**`type_text`** — `server.js:832` · `ref,text,clearFirst` (default true) or `fields:[{ref,text,clearFirst?}]`
(batch → `{type:'type_many'}`, ≤50, `server.js:842-846`).
Single-field → `{type:'type_text'}` then persistence check: `persisted = valueSet||verified||success`
→ `effect = failed|confirmed|unverifiable`; non-confirmed attaches
`escalation.recommended='re_read'` (`server.js:847-854`). CS: `nativeType` (§3b).

**`form`** — `server.js:858` · `action:enum[state|select|toggle|special|upload]` **required**,
`formRef,ref,value,clearAll,filePath`.
→ `form_state | select_option | form_special | toggle | upload_file`. `requireArgs` on
`select` (`ref,value`), `special` (`ref,value`), `upload` (`filePath,ref`) (`server.js:871,877,891`).
**Upload is server-side**: `readFileSync(filePath)` → base64 → extension→MIME table (images/video/
audio/documents/archives, `server.js:906-931`) → hub `upload_file{fileContent,fileName,mimeType}`.
Failure of the local read returns `{success:false,error:'Failed to read file: …'}` (`server.js:934-936`).
`upload_file` is in `HubServer.SW_REQUIRED_OPS` (`hub.js:300`) so it is forced through the
offscreen/relay path — the direct CS WS path answers
`upload_file requires the background SW … use the SW relay` (`cs-src/00:441`); the runtime.onMessage
path does the real work (`cs-src/70:225-246` → `nativeUploadFromBase64`/`nativeUploadPasteIntoEditor`).
Comment records the load-bearing `await resolveRefHealed` bug (wrong file input targeted) (`cs-src/70:228-237`).

**`reveal`** — `server.js:940` · `kind:enum[dropdown|tabs|accordion]` required, `ref` optional.
→ `dropdown_options | tab_contents | accordion_contents` (`server.js:947-948`).

**`scroll`** — `server.js:952` · `direction:enum[up|down|left|right],amount,ref,y,intoView`.
`intoView`→`scroll_into_view`; `y!=null`→`scroll_to`; else `scroll` (`server.js:962-964`).

**`press_key`** — `server.js:1283` · `key` **required**, `ref`, `modifiers:[ctrl|shift|alt|meta]`.
→ hub `press_key` → CS `nativePressKeyEnhanced` = dispatch `keydown/keypress/keyup` with modifier
flags on `ref` or `document.activeElement` (`cs-src/60:752-765`). **Pure synthetic** — no OS input.
In `DELTA_OPS`.

### 1.4 Navigate / tabs

**`navigate`** — `server.js:968` · `url` **required**, `newTab`.
Binding op: if the session had no binding, `forceFresh` is set so an unbound session **never**
reuses the shared cursor (`server.js:972-979`). On result it sets `server._wsBoundTabId`,
`claimTab(server, tabId)` and the current ALS store's `boundTabId` (`server.js:980-990`).
Hub classifies `navigate` as a TAB op (`hub.js:349-353`) → offscreen `handleTabOperation 'navigate'`
(`offscreen.js:202`) → SW `open_new_tab` (newTab, `active:false`) or `navigate_current_tab`
(`cs-src/00:309-318`, `background.js:683,691`). SW never activates the tab
("BACKGROUND NAVIGATION … activation is NEVER required", `background.js:702-707`) and **awaits commit**
via `waitForTabCommit` (default 10 s; reports `committed:false + timeout` rather than implying
success, `background.js:278-325,710-722`). `navigate` is **exempt** from the cross-session refusal
(`server.js:300-305`).

**`tabs`** — `server.js:996` · `action:enum[list|switch|close|bind|frames|windows|focus|move|transfer|
switchread]` required, `tabId,windowId,activate,fromTab,toTab,fromSelector,toSelector,useValue,selector`.
Maps: `list_tabs|switch_tab|close_tab|bind_tab|list_frames|list_windows|focus_window|
move_tab_to_window|transfer_text|switch_tab_and_read` (`server.js:1012-1025`).
`switch`/`bind` write `server._wsBoundTabId` (`:1014,1018`). `bind` sets `activate:false` by default;
`activate:true` only for OS input (`:1019`, description `:1002`).
SW: `bind_tab` sets `boundTabId` + `explicitBind=true` (`background.js:558-575,64`);
`switch_to_tab` activates only if `payload.activate` (`background.js:535-557`);
`transfer_text` is the atomic cross-tab read→write→verify compound (`background.js:608-654`);
`switch_tab_and_read` binds without activating and reads in one hop (`background.js:655-672`).

### 1.5 Wait / evaluate / page control

**`wait`** — `server.js:1092` · `urlContains,hasModal,hasCaptcha,notLoading,pendingDialogsGt,selector,
script,event,timeoutMs(default 10000),pollMs(default 400)`.
Event mode: first drains the **hub event ring** (`hub.eventRing`, matches `event` or `'any'`,
`server.js:1115-1127`, `hub.js:227-243`), else polls `{type:'get_events', since:now-30s}` every
250 ms (`server.js:1128-1141`). Condition mode ANDs DOM conditions (via `evaluate` probes with a
CSP-blocked fallback and a `querySelectorAll(...).length` fast-path, `server.js:1150-1195`) with
`page_state` conditions (`:1197-1211`). Returns `{success,timedOut,state}`.

**`evaluate`** — `server.js:1221` · `script` | `query:{selector,extract,all,inputs,text,state,maxLen}`.
`query` → `evaluate_safe` (no-eval reader, `cs-src/60:654`); else `evaluate` →
`new Function('"use strict"; return (async () => { … })();')` — async-aware — with an **automatic
no-eval fallback** `safeDomRead` for `querySelector(All)`-shaped scripts when CSP throws
(`cs-src/60:600-653`). Isolated world.

**`main_world`** — `server.js:1557` · `func` **required**, `args`, `tabId`, `allFrames`.
Tab = `tabId || sessionTabOf()`; no tab → `{success:false,error:'no tab bound …'}` (`server.js:1566-1567`).
→ hub `main_world_exec` (TAB-class, `hub.js:353`) → SW `chrome.userScripts.execute({world:'MAIN'})`
with the function source serialized into an IIFE; comment explains `scripting.executeScript({func})}
was rejected because MV3 SW CSP blocks `new Function` (`background.js:433-473`).
In `DELTA_OPS`. "Ladder position: BEFORE real-input" (`server.js:1549-1556`).

**`screenshot`** — `server.js:1260` · `format:enum[png|jpeg]`, `quality` (default 80).
→ `browser_screenshot` (TAB op) → offscreen `:192` → SW `capture_visible_tab`
(`background.js:474-504`): `chrome.tabs.captureVisibleTab`, falling back to
`chrome.debugger Page.captureScreenshot` on the **bound** tab when the tab is backgrounded
("image readback failed" case). Server normalizes string→object, decodes PNG/JPEG dims from the
data URL (`imageSize`, `server.js:121-146`) and appends `mode=` note about differing heights.

**`dialog`** — `server.js:1293` · `action:enum[accept|dismiss],index,value,keystroke,key`.
JS mode → hub `handle_dialog` → CS: picks `WS_DIALOGS[index ?? last]`, clears the 30 s auto-resolve
timer, resolves alert/confirm/prompt (`cs-src/70:306-317`). Dialogs are **captured and auto-resolved
after 30 s** (`true` / default value) so the page thread never deadlocks (`cs-src/00:19-37`).
`keystroke:true` → **server-local PowerShell `SendKeys`** via `execSync` (12 s timeout,
`server.js:1303-1314`), `escapeSendKeys`/`sendKeysForWindows` (`server.js:539-549`); non-win32 →
honest error. `dialog` is in **both** `NO_FRAME` (no `frameId` param) and `DELTA_OPS` (auto-DELTA).

**`clipboard`** — `server.js:1480` · `action:enum[copy|read]` required, `text`.
`copy`→`copy_to_clipboard` (CS textarea + `execCommand('copy')` path, `cs-src/60:805`);
`read`→`read_clipboard` → CS `handleReadClipboard`: `navigator.clipboard.readText()` first, else
hidden-textarea `execCommand('paste')` (comment: needs focus + `clipboardRead`, else `''`/`NotAllowedError`)
(`cs-src/70:319-351`).

### 1.6 Diagnostics / logs / cookies / extension lifecycle

**`network_log`** — `server.js:1356` · `clear` (default **true**), `maxEntries` (default 50).
`SW_REQUIRED_OPS` (`hub.js:300`) — comment: capture hooks only exist on the relay path
(`hub.js:295-299`). CS: `startNetworkCapture()` on first call, then `getNetworkLog`
(`cs-src/70:9,34`, dispatch `cs-src/70:247`). Direct CS-WS path returns
`{note:'network_log not available from content bridge'}` (`cs-src/00:438`).

**`console_log`** — `server.js:1365` · `clear` (default true), `maxEntries` (default 100).
CS starts capture lazily (`cs-src/70:56`). Source: **MAIN-world hook** `console-hook.js` registered at
`document_start` by the SW (`background.js:8-28`), which mirrors console.* + `error` +
`unhandledrejection` into a 300-entry ring persisted on hidden node `#__ws_console_buffer`
(`console-hook.js:10-47`); isolated world then reads it.

**`cookies`** — `server.js:1377` · `action:enum[list|get|clear|clear_all]` (default list),
`url` **required**, `name`.
→ `cookie_op` (TAB op, `hub.js:353`) → SW `chrome.cookies` (`background.js:789-823`).
`get` **returns values** (session transplant); `list` is metadata-only (`server.js:1374-1376`).

**`respawn_offscreen`** — `server.js:1391` · none. Routed to a **content script**, never the offscreen
("the op kills the offscreen", `hub.js:327-335`) → SW `closeDocument` + `setupOffscreen`
(`background.js:509-520`) so current on-disk `offscreen.js` loads. `NO_FRAME`.

**`extension_reload`** — `server.js:1402` · `timeoutMs` (default 15000).
Route preference offscreen → CS (`hub.js:336-348`, comment: before this, `reloadSent:true` meant only
"the WS send succeeded"). Sequence: census id-snapshot → `send({type:'extension_reload'})` (rejection
treated as sent, `server.js:1424-1431`) → poll census every 400 ms; **`reloadVerified = changed ||
(dropped && back)`** where `changed` = client-id set differs (`server.js:1440-1476`). Failure note
tells the caller the on-disk code may be stale and gives the popup fallback path.
Offscreen does `chrome.runtime.reload()` itself after a 50 ms flush delay (`offscreen.js:218-233`);
SW case at `background.js:521-530` (SW dies mid-call — "the poll is the actual confirmation mechanism").

### 1.7 Inspect / snapshot

**`inspect`** — `server.js:1492` · `kind:enum[element|geometry|relation]` required, `ref,selector,refA,refB`.
→ `geometry | layout_relation | resolve_ref` (`server.js:1502-1504`). CS: `getGeometry`
(`cs-src/30:282`), `screenCenter` (`cs-src/30:248`, multiplies by `devicePixelRatio` per
`server.js:554-555`), `resolve_ref` returns `{found,tag,text,value,locator,connected}`
(`cs-src/70:258-268`).

**`page_snapshot`** — `server.js:1578` · `tabId,fresh`.
Server-side: `getSnapshot(tabId)` cache hit unless `fresh` → returns `handle:'snap:<tabId>:<seq>'`
+ `index`. Miss → hub `main_world_exec` with `COLLECTOR` (`src/snapshot.js:29-136`: `querySelectorAll('*')`,
cap 20 000, per-element `locatorOf/regionOf/nameOf`, `vp` flag). Result shape must be
`{results:[{result}]}` etc., else `{success:false,error:'the collector returned no element inventory'}`
with a 400-char `got` dump (`server.js:1595-1608`). Stored via `putSnapshot` (`snapshot.js:152`).

**`page_slice`** — `server.js:1617` · `tabId,tag,role,region,vp,interactive,query,limit` (default 200,
hard max 2000 — `snapshot.js:207`). Pure server read of the stored snapshot; no snapshot →
`{success:false,error:'no live snapshot for tab …',stats:snapshotStats()}` (`server.js:1631-1638`).

### 1.8 Real-input rung (OS) — `server.js:1507-1547, 1647-1673`

All three shell out: `runRealInput(args)` = `execSync('<python> scripts/real_input.py <args>')`,
30 s timeout, JSON from the last stdout line (`server.js:1517-1521`). Python path
`WEBSENSE_PYTHON` default `C:/Users/Ali/AppData/Local/Programs/Python/Python311/python.exe`
(`server.js:1514`). All three are wrapped in `withEffect()` which captures `page_state` before/after
(+450 ms settle), sets `beforeState/afterState`, `effect=classifyEffect`, and on non-confirmed
attaches `escalation.recommended:'read'` with the explicit caveat that page_state cannot see
modal/DOM-only changes (`server.js:1530-1547`).

**`real_activate_tab`** — `server.js:1647` · `match` **required**, `gate` (default = match).
→ `real_input.py activate-tab` (`scripts/real_input.py:102-139`): pywinauto **UIA** click on the tab
pill; "FINDING vs GATING" — prefer a window already satisfying the gate, else any Chrome window,
activate, then verify the gate (`:105-138`).

**`real_click`** — `server.js:1655` · `x`,`y`,`gate` all **required**, `origin` optional.
→ `click-xy` (`real_input.py:141-162`): `_find_chrome(gate)` gate check → **raise Chrome to
foreground** ("SendInput only reaches the FOREGROUND window") → `pyautogui.moveTo(…,0.25)` +
`click`. Coordinates are **viewport** coords; doc-origin Y auto-measured (`_doc_origin`, `:90`)
unless `--origin` given. `FAILSAFE = False` with the comment "the title gate is the safety" (`:144`).

**`real_paste`** — `server.js:1665` · `x`,`y`,`text`,`gate` all required.
→ `paste-text` (`real_input.py:164-197`): gate → raise → click → clipboard write →
`pyautogui.hotkey('ctrl','v')`. A `paste-file` subcommand exists (`real_input.py:199`) but **no MCP
tool exposes it**.

**Server-side auto-climb click** (`realClickAt`, `server.js:566-586`): PowerShell `user32 mouse_event`
at **physical** screen coords, 12 s timeout, Windows-only guard, plus a **foreground guard** that
refuses if the frontmost process is not Chrome (`server.js:551-565`).

### 1.9 `ax` — `server.js:1241`

`action:enum[state|read|click|type]` **required**, `tabId` **required**, `role,name,nameContains,
match,text`. → `ax_state|ax_read|ax_click|ax_type` (TAB class, `hub.js:352`). Offscreen forwards over a
long-lived `ax-bridge` port because `chrome.debugger.attach` is slow (`offscreen.js:260-270`,
`background.js:414-429`). SW does `axAttach/axSendCommand('Accessibility.getFullAXTree')/axDetach`
(`background.js:892-931,1048`). `axStr()` normalizes AXValue objects — comment: without it
"ax read worked, ax click/type were dead" (`background.js:932-945`). `axRead/axFindNode/axClick/axType`
(`background.js:966-1047`). Uses `chrome.debugger` (extension API), attaches/detaches inside the call.

### Non-tool HTTP surfaces
* `GET /health` (MCP HTTP port) → `{status:'ok', hubConnected, extensionConnected, …census}`
  strictly read-only (`server.js:1701-1721`).
* `GET /health` on hub port → `hub.census()` (`hub.js:100-103`); other paths → friendly one-liner
  (`hub.js:104-108`).

---

## 2. STATE MACHINE / REGISTRIES

| # | State | Where | Written by | Read by |
|---|---|---|---|---|
| S1 | `sessionCtx` ALS store `{boundTabId, autoBound, server}` | `server.js:199` | HTTP request handler seeds it from `session.server._wsBoundTabId` (`:1757-1758`); `navigate` sets `boundTabId` (`:988-990`); auto-bind writes both store and `_wsBoundTabId` (`:322-323`) | `withSessionTab` stamps every hub cmd (`:267`), `sessionTabOf()` (`:231`) for `main_world`/snapshot tabs |
| S2 | `boundTabsBySession: Map<serverObj,{tabId,at}>`, `CLAIM_TTL_MS = 10 min` | `server.js:208,213` | `claimTab` (`:215-217`), refreshed on every stamped send (`:329-333`); deleted on `transport.onclose` (`:1742-1744`) and by TTL eviction inside `liveClaimOwner` (`:224-226`) | `liveClaimOwner` (`:221-230`) — refusal: unbound page op whose cursor tab is owned by another **live** session throws (`:308-312`); `navigate` exempt (`:305`) |
| S3 | `server._wsBoundTabId` (per MCP-server object) | `server.js:981,1014,1018` | `navigate`, `tabs switch/bind` | seeding of next request's store (`:284-287` comment) |
| S4 | Hub `selectedTabId` (GLOBAL routing cursor) | `hub.js:65` | `tab_selected` (`:186-190`), `tab_activated` (`:245-259`), `tab_event activated` (`:218-224`); cleared by `clear_binding` (`:196`) and tab removal (`:207`) | `activeClient` fallback target (`:362`), `_timeoutDiag` (`:392`) |
| S5 | Hub `contentByTab: Map<tabId,ws>` (main-frame only) | `hub.js:64` | `tab_identified` — **newest wins**, stale socket closed 4000 (`:161-184`); deleted on `tab_event removed` (`:204-208`) and ws close (`:279`) | direct page-op routing (`:364-367`) |
| S6 | Hub client roles: `lastClient/contentClient/mainFrameClient/offscreenClient`, `clients: Map<cid,ws>` | `hub.js:53-57` | `ready` (`:146-157`), any message (`:261-267`), close (`:273-281`) | `activeClient` preference order |
| S7 | Hub `pending: Map<id,{resolve,reject,timer,client,type,startedAt}>` (multi-slot, per-client attribution) | `hub.js:41-48` | `_storePending` in `send` (`:610-618`) | `_settlePending` (`:428-…`); close rejects **only** its own pendings unless `_killingZombie` (`:286-290`) |
| S8 | Hub `eventRing` (max 50, `eventSeq`) | `hub.js:68-70` | `page_event` push from CS (`:227-243`) | `wait{event}` ring drain (`server.js:1115-1127`), `stats().eventRing` |
| S9 | SW `boundTabId` + **`explicitBind` latch** | `background.js:51,64` | `explicitBind=true` in `bind_tab` (`:570`), `switch_to_tab` (`:552`), `move_tab_to_window` (`:605`); cleared when the bound tab is removed (`:153`); also written by `navigate_current_tab`/`open_new_tab` paths (`:691-723`) | `getBoundTab`-style reads, `navigate_current_tab` (`:692-700`), offscreen `getActiveTabId` (`offscreen.js:65-73`); **`onActivated` must not overwrite an explicit bind** (`background.js:161-175`) |
| S10 | Offscreen: **no tab cache** (deliberate) | `offscreen.js:18-20,66-73` | — | asks SW each time (`get_bound_tab`), re-syncs hub after reconnect (`:359-365`) |
| S11 | CS `refMap`, `refCounter`, `elementSignatures`, `locatorByRef` | `cs-src/10:53-60` | `assignRef` (`:142`), reset by full `extractActionGraph` (comment `cs-src/50:694-696`), **not** reset by incremental (`cs-src/50:621-622`) | `resolveRef`/`resolveRefHealed` |
| S12 | CS `SCAN_CACHE` (per document; incremental baseline) | `cs-src/50:517` | `exploreIncremental` always advances (`:687-688`), reseeded after escalation (`:698`) | delta diff (`:675-686`); killed by real navigation (comment `:512-513`) |
| S13 | CS `SAG_CACHE_TTL_MS=1500`, `DEFAULT_MAX_ACTIONS=200`, `SCAN_CEILING=8000`, `CURSOR_SWEEP_MAX_ELEMENTS=1800`, `AUTO_COMPACT_CANDIDATES=400`, `CONTENT_MAX_CHARS=6000`, `SETTLE_SKIP_IF_QUIET_MS=150` | `cs-src/00:178-184` | constants | bounds explore cost (measured comment `:167-177`) |
| S14 | Effect verdict inputs: `beforeState/afterState = getQuickState()` (url,title,readyState,dialogCount) | `cs-src/70:122,208` | CS `click` handler | `classifyEffect` (`server.js:79-94`) |
| S15 | `DELTA_OPS` baseline (the per-tab scan cache seen through `explore_page{incremental:true}`) | `server.js:414` + CS `SCAN_CACHE` | seeded by the first mutating op (`summarizeDelta` "no baseline" branch, `:429-435`) | every subsequent mutating op's auto-DELTA (`withDelta` `:472-493`) |
| S16 | Server `SessionManager` (`pages, history, currentUrl, stepCounter, lastSnapshot, task`) | `src/session.js:6-13` | `recordAction/recordPage/recordNavigation/setLastSnapshot/beginTask/…`; cleared by `session{reset}` (`:192-199`) | `status`, `session{map/mermaid}`, `recordNavigation` dedupe |
| S17 | Server snapshot store `Map<tabId,{at,seq,snap,index}>`, TTL 5 min, MAX_TABS 8 | `src/snapshot.js:141-143` | `putSnapshot` + LRU evict (`:145-150`) | `page_snapshot` cache, `page_slice` |
| S18 | Offscreen lifecycle: `offscreenCreating` promise w/ 8 s timeout, zombie probe, `closeDocument` on "only a single offscreen" | `background.js:32-45,192-275` | `setupOffscreen`, keepalive alarm every ≥0.5 min (`:1069-1076`) | every relay op |
| S19 | Offscreen watchdog: self-close if `chrome.runtime.id` gone or WS dead >10 s (2 s interval) | `offscreen.js:399-422` | itself | SW recreates |
| S20 | CS WS backoff: `wsFailStreak`, `WS_MAX_FAIL_STREAK=4`, 3 s→60 s exponential, **give-up** log `WS_GIVEUP: N consecutive failures` | `cs-src/00:158-165,188-191,242-252` | open resets (`:197`), close/error increments (`:193,238`); `wsResetAndRetry` on `visibilitychange` (`:257-295`) | `wsConnect` |
| S21 | Offscreen WS: fixed 3 s retry (`reconnectDelay`), no give-up | `offscreen.js:16,387-393` | close → schedule | connect |
| S22 | Hub timeouts: `REQUEST_TIMEOUT=30000`, `EXPLORE_TIMEOUT=90000`, `HEAVY_OPS={explore_page,discover_actions}` | `hub.js:14-16` | — | `_timeoutDiag` builds a hop-attributing error (`:389-424`) |
| S23 | Captured dialogs `WS_DIALOGS` (+30 s auto-resolve timers), console/network ring buffers | `cs-src/00:8-44`, `cs-src/70:9-110` | override of `window.alert/confirm/prompt`, fetch/XHR hooks, MAIN-world console hook | `status page`, `wait`, `dialog`, `network_log`, `console_log` |

**Visibility / activation gating.** Page ops are routed **by tabId** and explicitly documented as
never needing activation (guide `server.js:661-667`; `tabs` description `:1002`; timeout hints
`hub.js:412-419`). Activation is needed only for OS input (`real_*`, `dialog{keystroke}`,
`ax` optionally). Things that *do* touch activation: `tabs{action:'switch'}` /
`bind{activate:true}` (`background.js:535-557`), `tabs{focus}` (`background.js:590`), the
auto-climb/`real_*` foreground requirements, and the offscreen **0×0 viewport self-heal** which
un-minimizes the window before relaying a page op (`offscreen.js:94-105`).

---

## 3. CORE LOGIC PATHS

### (a) click → ref resolution → dispatch → DELTA diff
1. `click` handler (`server.js:748`) picks branch; default sends `{type:'click', ref, frameId}`
   stamped with the session tab (`withSessionTab`, `server.js:267-336`).
2. `hub.send` (`hub.js:589`) → `activeClient` (`:311`): not a tab-op, not SW-required →
   `targetTab = cmd.tabId ?? selectedTabId` → direct `contentByTab.get(targetTab)` if OPEN,
   else offscreen/mainFrame/any (`:358-377`). Wraps `pending` with 30 s timer.
3. CS `wsHandle` (`cs-src/00:298`) → not in tab-op list → `wsDispatchPage` →
   `case 'click'` (`cs-src/00:357`) = `getQuickState()` → `resolveRefHealed(ref)` → `nativeClick`.
   (Relay path: `handleMessageAsync case 'click'` `cs-src/70:208`.)
4. **Ref resolution** (`cs-src/10:182-235`): live `refMap` hit → else `[data-websense-ref="…"]`
   via `deepQuery` (shadow-piercing) → else **selector-ref** fast path if the string looks like CSS
   (`:171-180`) → else **locator chain** re-resolve (data-testid → id → aria-label → name →
   `:nth-of-type` CSS path → role+text) (`:81-140, 204-215`) → else `resolveRefHealed` re-runs
   `extractActionGraph` once (recursion-guarded) and retries (`:225-235`).
5. `nativeClick` refuses disabled, rewrites `_blank` anchors to a background tab, scrolls into view,
   retargets to the deepest element at the click point, dispatches (`cs-src/60:51-134`).
6. Back in the CS: `{success, ref, beforeState, afterState}` (`cs-src/70:208`); server sets
   `result.effect = classifyEffect(result)` (`server.js:774`) and possibly `escalation`
   (`:775-777`) and the auto-climb block (`:788-821`).
7. **Auto-DELTA**: `withDelta` (`server.js:472-493`) — unless `verify:false` — sends
   `explore_page{incremental:true, includeContent:false}` and appends a **second content block**
   `DELTA (auto, after click): {…}`. `summarizeDelta` (`:421-468`) unwraps the hub envelope
   (`.data`), detects a real delta by `added/changed/removed` arrays, else reports
   `mutated:null, reason:'no scan baseline existed … NOT verifiable'`; `mutated:false` gets the
   "do NOT retry blindly" hint (`:464-466`).
8. `session.recordAction` + navigation/page records (`server.js:823-827`).

### (b) type_text modes and how text lands in React / Draft.js
Server (`server.js:840-855`) → hub `type_text` → CS `nativeType(el, text, clearFirst)`
(`cs-src/60:251-430`):
1. `nativeClick(el)` first; if `clearFirst`, `setNativeValue(el,'')` + `input` event.
2. **Native setter path (React-safe):** `setNativeValue` walks the prototype chain for the
   `value` descriptor and calls that setter, then dispatches `input` + `change`, and for React
   additionally an `InputEvent('beforeinput',{inputType:'insertText'})`
   (`cs-src/60:40-49, 256-258`; `detectFramework` `cs-src/20:8`).
3. **contenteditable (Draft.js/Lexical/ProseMirror/Slate/Quill/TriX/CKEditor/TinyMCE/Google-Docs)**
   detected by `detectEditor` (`cs-src/60:145-203`; Google-Docs → `strategy:'unsupported'`):
   * clear phase: select-all + `execCommand('delete')`, verified (up to 3 tries, else `textContent=''`)
     to prevent the doubling bug (`:281-293`);
   * **RUNG 1 — synthetic paste**: `ClipboardEvent('paste')` with a real `DataTransfer`
     (text/plain + text/html), caret collapsed to end; `consumed = !dispatchEvent(ev)`
     ("v4.2 FIX: the old code inverted this … text inserted TWICE", `:205-234`);
     accept on **text match** after 250 ms → `confirmed:'paste-dom-persisted' |
     'editor-state-synced' | 'dom-synced-state-unsynced'` (`:299-320`).
   * **RUNG 2 — `document.execCommand('insertText')`** at the collapsed range + `input` event,
     then a **detection/self-heal**: if the expected text occurs >1×, wipe and retype once
     (`:322-363`) → `confirmed:'contenteditable-persisted'`.
4. **Value elements — VERIFY-PERSIST**: settle 2 rAF + ~400 ms, re-read, report
   `confirmed:'value-persisted'|'value-persisted-after-settle'` / `reverted:true`; a custom element
   with `faceplate-validity="invalid"` is re-routed through `execCommand('insertText')` so events
   originate inside the shadow tree (v4.3). Comment documents the two removed false-positive paths
   (v4.6.1): the validity attribute may only **downgrade**, and comparing `el.value` (undefined on
   rich editors) was how "value-persisted" was reported on an **empty** Reddit editor (`:365-430`).
5. `checkStateTruth` (`:239-249`) reads the dependent submit button's `disabled` state as the app's
   "source of truth" that the text was registered.
6. Server turns the flags into `effect` + `escalation.recommended='re_read'`
   (`server.js:848-852`). There is **no keystroke-by-keystroke typing** anywhere — `press_key`
   is the only key path and it is synthetic (`cs-src/60:752`).

### (c) Effect verdict + `escalation.recommended`
* `classifyEffect(result)` (`server.js:79-94`): `success:false`→`failed`; no before/after→`unverifiable`;
  URL differs→`confirmed`; else JSON of before/after differs→`confirmed`; else `suspected_noop`.
  Input is only `getQuickState()` (url/title/readyState/dialogCount), so **DOM-only changes are
  invisible** — stated in comments at `server.js:1528-1529` and `:1543`.
* Click: `escalation = {recommended:'real_click', reason:'synthetic click produced no state change —
  React onClick handlers often ignore dispatched events…'}` (`server.js:776`).
* Auto-climb overrides: success → delete `escalation`; failure →
  `recommended:'real_click_manual'` (`server.js:805-808`).
* type_text: `recommended:'re_read'` (`server.js:851`).
* `real_*`: `recommended:'read'` with "does NOT prove the click failed" (`server.js:1541-1544`).
* Programmatic **DELTA** (separate, stronger verdict) is the parallel channel: §3a step 7; the
  motivation comment cites mem 800 ("like registered while effect:unverifiable") (`server.js:394-413`).

### (d) Tab cursor model & shared-cursor conflicts
* Three layers: hub **global** `selectedTabId` (moved by OS activation + explicit selection),
  SW **`boundTabId`** (+ `explicitBind` latch), and per-MCP-session **claims**
  (`boundTabsBySession` + ALS `boundTabId`).
* Every page op is stamped with the session's tab (`withSessionTab`, `server.js:267`); ops in
  `SESSION_TAB_OPS` (`server.js:241-245`) keep their own semantics (they carry explicit ids).
* `navigate` is the binding op: unbound → forced `newTab`, then bind (`server.js:972-990`).
* Conflict handling: if an unbound page op's cursor belongs to another **live** session, the server
  **refuses** with an explanatory error instead of inheriting (`server.js:308-327`); stale claims
  (>10 min without a touch) are evicted so dead Python clients can't cause false refusals
  (`server.js:209-230`).
* Why the cursor moves under you: `tab_event activated` / `tab_activated` from the CS on focus
  (`hub.js:210-224,245-259`), CS re-broadcast on `visibilitychange` (`cs-src/00:272-296`), and
  `activate:true` binds. The SW `explicitBind` latch exists precisely so a user tab switch cannot
  steal an explicit bind (`background.js:53-64,166-175`).
* Unbound fallback hazard documented verbatim: "an unbound third session read session B's example.org
  tab with no error and no signal" (`server.js:276-288`) — fixed by auto-binding the session to the
  tab it is about to use and telling the caller (`withBindingNote`, `server.js:247-265`).

### (e) `real_*` OS-input path
`real_click/real_paste/real_activate_tab` (server) → `withEffect` snapshot →
`runRealInput` `execSync(python scripts/real_input.py …)` (`server.js:1517-1521`) →
`_find_chrome(gate)` (pywinauto Desktop, title substring) → raise Chrome window →
viewport→screen conversion using the **UIA-measured document origin** (`_doc_origin`, default ~121 px)
→ `pyautogui.moveTo(x,y,0.25)` + `click` → (paste) clipboard set + `ctrl+v` → restore prior focus
(`_fg_hwnd`/`_restore_focus`, `real_input.py:22-26`) → JSON result on stdout.
Gate semantics: no matching Chrome window → `{success:false, error:"Gate failed: no Chrome window
containing '…'}"`; `activate-tab` verifies the gate **after** activation and can fail with
"Tab activated but gate failed" (`real_input.py:137-138`). `origin` override exists for
auto-measure failure. Server-side alternative auto-climb uses in-process PowerShell
`mouse_event` at **physical** coords with a Chrome-foreground precondition (`server.js:551-586`);
decision logic is unit-testable in `src/climb.js:15-31`.

### (f) autoClimb rules
`click` default branch, only when `effect==='suspected_noop'` and `ref` present, and enabled by
`autoClimb:true` or `WEBSENSE_AUTOCLIMB=1` (default **off**) (`server.js:788-789`), then
1. `sessionTabOf()` must be non-null (else `autoClimb.attempted:false, reason:'no session-bound tab…'`);
2. hub `get_active_tab` must equal the bound tab (else the "lands on the FRONTMOST window"
   refusal, `server.js:813`); `planAutoClimb` in `src/climb.js` encodes the same guard;
3. hub `screen_center{ref}` must give visible screen coords (else `'element not visible or no screen
   coords'` / `screen_center failed`);
4. `realClickAt(screen.x, screen.y)` → sleep 250 ms → `page_state` → if URL changed, `effect='confirmed'`
   and `escalation` deleted; else `autoClimb.attempted:true, changed:false` +
   `escalation:'real_click_manual'` (`server.js:798-808`). Any thrown error is downgraded to
   `attempted:false, reason:'auto-climb error: …'` (`:818-820`).

### (g) explore_page snapshot → ref pipeline & ref stability
1. `extractActionGraph` (`cs-src/50:215`) → `waitForSettle` (skippable via `settle:false`, or
   skipped if the DOM was quiet ≥150 ms) → element collection bounded by `SCAN_CEILING`/`maxActions`
   → classify (`cs-src/50:417-461`) → `assignRef` each interactive element → optional content/heading
   extraction → SAG cache (1.5 s TTL) (`cs-src/00:178-184`).
2. **Refs are `E<n>`** (`'E' + refCounter++`, `cs-src/10:144`) written to attribute
   `data-websense-ref` (`:53,149`) and indexed in `refMap` + `elementSignatures` (WeakMap) +
   `locatorByRef`. Forms get `F<n>` refs (`cs-src/20:350,378`).
3. **Stability**: a full explore **resets** `refCounter/refMap`, superseding all previously
   handed-out refs (comment `cs-src/50:694-696`); incremental explores do **not** reset them
   (`cs-src/50:621-622`). After a re-render, `resolveRef` re-derives the element from the locator
   chain and re-attaches the attribute (`cs-src/10:204-215`); a total miss triggers one
   re-extraction heal (`:225-235`).
4. **Locator chain** (`cs-src/10:81-115`): `[data-testid="…"]`, `#id`, `[aria-label]`, `[name]`,
   a `:nth-of-type` CSS path climbing ≤8 levels to an id/testid ancestor, then role+text or a
   `//tag[normalize-space(.)="…"]` pseudo-XPath (text-matched manually, `:118-140`). All lookups go
   through `deepQuery`, which **pierces open shadow roots** (light-DOM fast path first, `:34-41`);
   closed roots are explicitly skipped rather than faked (`:9-10`). **No `:has()` selectors** are
   generated anywhere — only `:nth-of-type`, attribute, id and class selectors.
5. **Incremental** (`cs-src/50:665-720`): `collectScanWithRefs` — in-viewport + interactive only
   (dialogs exempt) → identity key (`testid>id>name>aria>ph>pos`, mirror of `src/incr.js:133`) →
   fingerprint over type/subtype/label/href/value/checked/disabled/expanded/selected/pressed/
   visible/required/readOnly (**`inViewport` deliberately excluded**, `cs-src/50:561-566`) →
   diff → `enrichDeltaActions` builds locator+intent **only for delta entries**.
   Escalation: no baseline, or `tracked>20 && changedRatio>0.6` → full SAG with
   `escalated:true` (`:684-701`).

---

## 4. DOCUMENTED-TRUTH QUOTES (exact strings to cross-check docs against)

**In-code guide (`websense_guide` return, `server.js:609-673`):**
* "WebSense MCP — Guide (31 consolidated tools) / Non-vision web automation via Chrome extension. No
  CDP debug port, no bot detection. CSP-safe."
* "THE LOOP: explore_page → pick refs → act (click/type_text/form/scroll) → read result → repeat."
* "DID IT LAND? Every mutating op (click, type_text, form, press_key, real_click, real_paste,
  main_world, evaluate, dialog) returns a SECOND block: DELTA (auto, after <op>): {mutated:
  true|false|null, …} … mutated:false means the action did NOT land … mutated:null means no baseline
  existed yet on that tab … Pass verify:false to skip the diff."
* "page_snapshot collects a LOSSLESS inventory … and returns only a small INDEX … Cost measured on
  github.com/nodejs/node: index 690 B vs a 116,573 B explore_page, over 3,842 elements."
* "PAGE OPS vs OS-INPUT … page ops … route over tabs.sendMessage BY TABID and work on a tab that is
  NOT active. Never activate a tab for these. Measured 2026-09-20: explore_page on an active:false
  tab, no activation, 29 matches."
* "A page op that HANGS is almost never activation. Check in order: (1) Chrome MINIMISED/occluded
  (0×0 window …) (2) a native 'Leave site?' dialog … (3) another process already driving that tab.
  Do NOT 'fix' a hang by activating the tab."
* "real_activate_tab OS-INPUT ONLY — genuinely activates a tab (SendInput) … it exists solely to
  precede real_click/real_paste" (`server.js:649`).
* "TAB DISCIPLINE: reuse tabs (navigate reuses by default). NEVER close the last open tab/window."

**`MODEL_PROMPT.md`:**
* Header warning (lines 7-18): "DRIFT RESOLVED — re-verified 2026-09-21 (source of truth:
  src/server.js). The RUNNING server exposes 31 tools … The prompt text below still contains the
  older **21** string in places — this file only mirrors the src-owned text, so treat src/server.js as
  authoritative." + "`websense_doctor` is **not** a tool … `evaluate_safe` is **not** a tool".
* Body: "TOOLS (21 — consolidated from 65, nothing lost)"; "NO screenshots, NO CDP debug port, NO
  vision model, NO eval"; "TWO CLASSES OF OPERATION … PAGE OPS … OS-INPUT OPS … Do NOT 'fix' a hang
  by activating the tab or reaching for real_click"; ladder "1) real_activate_tab 2)
  inspect{kind:'geometry'} 3) real_click / real_paste … Always gate".
* Old→new absorption table (lines 138-170) — 30 rows mapping the 65-tool surface onto params.

**`README.md`:**
* "Non-vision, AI-native web automation via the Semantic Action Graph. No screenshots, no CDP, no bot
  detection." (line 3); "**Chrome-only.** … there is no Firefox code in this repo." (20-22).
* "**Bridge port:** default 38401 … If the port is already taken, the hub logs a warning and the
  server keeps running (MCP still works)" (15-18).
* "**Count verified 2026-09-21** … **31 tools**. … Anything in these docs that says 20/21/29/43/61
  tools is stale." (40-43).
* "CSP-Safe (30/31 tools) … (`evaluate` is the only eval-based tool …)" (88); "React-Compatible:
  native prototype value setters bypass React's value tracker" (89).
* "`cookies` (list/get/set/clear metadata — never values)" (64).
* Architecture diagram (25-36): `offscreen.js WebSocket client, auto-reconnect`,
  `websense-cs.js … ↔ chrome.runtime.sendMessage`.

**Hub / build comments:**
* `hub.js:115-119`: "Hard fail: do NOT swallow EADDRINUSE … Exiting lets the client's retry bind the
  port cleanly instead of piling up dead nodes."
* `hub.js:496-500`: census "CONTRACT — do not weaken it: * STRICTLY READ-ONLY … * TOTAL. It may not
  throw."
* `hub.js:340-342`: "`reloadSent:true` … only ever meant 'the WS send succeeded'."
* `tools/build-cs.mjs:4-12`: "the modular sources are concatenated in filename order … a hand-edit of
  the built file fails the suite instead of silently being reverted."

---

## 5. DIVERGENCE NOTES (code vs this repo's docs)

1. **Port-in-use behavior.** README:15-18 says a taken port means "the hub logs a warning and the
   server keeps running (MCP still works)". Code: `hub.start()` **rejects** on `EADDRINUSE`
   deliberately (`hub.js:114-122`), `main()` awaits it and `main().catch` calls `process.exit(1)`
   (`server.js:1683,1798`). Server does **not** keep running.
2. **Tool count in the model prompt.** `MODEL_PROMPT.md:43` still says "TOOLS (21 …)" while
   `server.js` registers 31 (verified: 31 `reg(` calls) and README:38-43 says anything saying 20/21/
   29/43/61 is stale. The file self-flags this at lines 7-18, but the embedded prompt is still 21.
3. **`cookies` values.** README:64 — "metadata — never values". Code: `action:'get'` returns the
   cookie **value** by design (`server.js:1374-1376`, SW impl `background.js:814-823`); only `list`
   and `doctor` are metadata-only.
4. **`real_activate_tab` mechanism.** Guide string says "(SendInput)" (`server.js:649`) and the
   MODEL_PROMPT ladder says "UIA + SendInput". Code: it is a **pywinauto UIA `click_input`** on the
   tab pill (`real_input.py:102-139`); only `real_click`/`real_paste` use pyautogui/SendInput. The
   tool's own description correctly says UIA (`server.js:1648`), so the in-repo guide string disagrees
   with the implementation.
5. **"No screenshots / no vision".** README:3 and `package.json` description say "No screenshots, no
   CDP, no bot detection"; `MODEL_PROMPT.md:26` says "NO screenshots, NO vision model". The server
   registers `screenshot` returning `{dataUrl, mime}` "for a vision model" (`server.js:1260-1261`),
   and README itself lists the tool (line 62). Also `ax` uses `chrome.debugger` (a CDP-family API) —
   README:88 and MODEL_PROMPT:116-118 acknowledge the carve-out, but the taglines do not.
6. **Architecture diagram omits the direct content-script WebSocket.** README:25-36 shows only
   `offscreen.js WebSocket client` and `websense-cs.js ↔ chrome.runtime.sendMessage`. In code the CS
   opens its **own** `ws://127.0.0.1:38401` bridge (`cs-src/00:72-92,186`) and is the hub's
   *preferred* page-op route (`hub.js:306-310`), with the offscreen as fallback — i.e. the diagram
   describes only the relay path.
7. **`evaluate` CSP behavior.** README:98 says `evaluate` "uses `new Function` (eval) → blocked by
   strict page CSP … Power-user utility". Code: it is blocked **and then silently falls back** to a
   no-eval `safeDomRead` for `querySelector(All)`-shaped scripts, returning a successful
   `method:'safe-querySelector*'` result (`cs-src/60:611-617,630-653`) — an undocumented fallback
   that changes the "blocked" contract for read-shaped calls.
8. **`websense_guide`'s absorption list is incomplete relative to the schemas.** Guide line 625 lists
   `form` as `state|select|toggle|upload` — the schema also has `action:"special"` with its own
   `requireArgs` (`server.js:858-881`). Guide line 636 lists `session` as `reset|map|mermaid` — the
   schema also has `action:"task"` with `op/goal/steps/step` (`server.js:1320-1347`).
9. **Chrome-only vs cross-browser claim.** README:20-22 "Chrome-only … never been developed or tested
   on [Firefox]" vs README:84-85 "Cross-browser: Chrome / Edge / Opera: load extension/manifest.json".
   No browser-detection code exists either way (manifest has no `browser_specific_settings`), so the
   claim of tested support for Edge/Opera is not backed by code.
10. **`upload_file` routing comment vs hub comment.** `hub.js:295-299` justifies `SW_REQUIRED_OPS`
    with "upload_file needs SW-world DataTransfer"; the actual implementation builds the
    `DataTransfer` in the **content script's isolated world** (`cs-src/60:929-983`, dispatch at
    `cs-src/70:225-246`) and the SW never handles `upload_file` (no case in `background.js`
    `handleTabControl`). The routing still works (offscreen → PAGE_CONTROL → CS), but the stated
    reason is wrong; the CS's *direct WS* path meanwhile returns an error telling the caller to use
    "the SW relay" (`cs-src/00:441`).
11. **README file-structure list is stale.** README:119-136 lists only `server.js, hub.js, session.js,
    mermaid.js` under `src/`; the tree also contains `snapshot.js`, `incr.js`, `climb.js`,
    `summarize.js`, `upload.js`, and the repo root contains `MODEL_PROMPT.md`, `CHANGELOG.md`,
    `test-regressions.mjs`, `tools/build-cs.mjs`.
12. **`reveal`/`network_log` duplication in the guide.** Guide lists `network_log` twice
    (`server.js:637,645`) — cosmetic, but it inflates the "31 tools" walkthrough.

---

### Coverage note
Sections 1-3 were built from: `src/server.js` (all 31 `reg()` sites + preamble `:121-606`),
`src/hub.js`, `src/session.js`, `src/snapshot.js`, `src/incr.js`, `src/climb.js`,
`extension/background.js`, `extension/offscreen.js`, `extension/manifest.json`,
`extension/console-hook.js`, `extension/cs-src/{00,10,50,60,70,80}-*.js` (dispatcher, ref system,
incremental scan, action ladders, runtime.onMessage ops, diff/event buffers),
`scripts/real_input.py`, `tools/build-cs.mjs`, `README.md`, `MODEL_PROMPT.md`.
Not exercised at runtime; `cs-src/20`, `cs-src/30`, `cs-src/40` were indexed but read only at the
symbol level (classification, geometry, site quirks).
