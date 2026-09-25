# websense_guide (system prompt, 31 tools) — CROSS-CHECK vs code + live tests
2026-09-25. Sources: guide text (websense_guide tool), EXTENSION_MAP.md,
LIVE_TEST_RESULTS.md (60 live verdicts), direct source reads.
Legend: ✅ correct · ⚠️ understated/missing caveat · ❌ false on this box

## Correct (keep as-is)
- THE LOOP (explore → refs → act → read → repeat). ✅
- page_snapshot LOSSLESS index + page_slice full fidelity, cost numbers, scroll-stable claim ✅ (live: 98 elements, query = substring-text).
- DELTA block exists on the listed mutating ops, verify:false skip ✅ (scroll correctly NOT listed).
- main_world = "COMPILED function expression … CSP-proof escape hatch" ✅ (wording even hints at the expression requirement).
- ax via chrome.debugger is not a debug port ✅ (live: 226-node tree on inactive tab).
- PAGE OPS work on a tab that is NOT active — never activate for them ✅ (measured + repeated live).
- Hang checklist (minimised/occluded → parked native dialog → another driver; never "fix" by activating) ✅ — matches the parked-beforeunload incident.
- TAB DISCIPLINE / never close last tab ✅.
- real_click/real_paste = FRONTMOST window, OS-input only ✅ (recipe-proven today: caret deletes + addButton).
- console_log works ✅ (MAIN-world hook). form upload (ref,filePath) ✅.

## FALSE on this box (fix the guide)
1. **DID IT LAND section: "mutated:false means the action did NOT land"** —
   FALSE. Four proven false-negative classes: non-action bodyText changes,
   async handlers (post-op promise), focus-only clicks, first-op seed.
   DELTA fingerprints only interactive elements. Must say: fingerprints-only;
   confirm text/focus/async via bodyText/oracle.
2. **"On suspected_noop … escalate (OS-level click)"** — the escalation trap.
   suspected_noop/unverifiable accompanied LANDED work in every observed case
   (fetch/XHR/download/_blank/focus/async). OS-level escalation on that signal
   = focus steal for nothing. Rule must be: oracle re-read FIRST; OS-input only
   after a page op provably failed on an element a page op cannot reach.
3. **"NATIVE DIALOGS: JS alert/confirm/prompt are captured (dialog{action})"** —
   false: WS_DIALOGS override lives in the isolated world; page alerts bypass it;
   on this box alert() neither captured (pendingDialogs always []) nor blocking.
   DOM [role=dialog] modals are the real surface (hasModal ✓ but visibility-blind).
4. **wait selector/script conditions** — FIXED 2026-09-25 (was genuinely broken).
   The selector branch sent an EVAL probe (`!!document.querySelector(...)`),
   expected it back CSP-blocked, and only then sent the no-eval safe-query form.
   That dependency never held: the extension's own CSP blocks the probe on every
   page, so the fallback never ran — measured 1 evaluate send/poll and a clean
   timeout for a selector `evaluate{query}` proves exists. Now the no-eval form
   is asked FIRST. Live-verified all four modes: existing→success, missing→
   timeout, script qS→success, urlContains→success. (The earlier "envelope vs
   data.success" explanation in this file was wrong — the hub resolves fine; the
   fallback simply never got sent.) wait{event} remains degraded on https/strict
   tabs and dialog_open never fires (item 3).
5. **network_log "the page's own API responses (often cleaner…)"** — BROKEN:
   fetch/XHR hooks patch the isolated world → page traffic never seen
   (4 tight runs =0 entries while oracles proved traffic). console got the
   MAIN-world fix; network never did.
6. **reveal kind:"dropdown"** — double-resolve on the direct-WS path
   (cs-src/00:377 passes resolveRef(ref) into a reader that resolves again) →
   "Element not found" for every ref on http/localhost tabs. Works only via
   the relay path (strict-CSP tabs). accordion/tab kinds: ref-less scan OK.
7. **evaluate "CSP-blocked on strict sites"** — understated: blocked on ALL
   sites (extension's own MV3 CSP governs new Function — proven on two
   no-CSP pages; block string carries chrome-extension://13879262-… =
   WebSense's real current id). Only the safeDomRead qSA fallback runs.
   query mode = the real read path ✅.

## MISSING (add)
8. **Scoping model**: which ops carry tabId (explicit, cursor-independent) vs
   which are CURSOR-scoped (status/wait/scroll/evaluate/reveal/inspect/session/
   dialog/clipboard/console_log/network_log/read/frames). No guide section on
   selectedTabId/bind — yet cursor scope + concurrent agents was the top
   operational hazard (reveal failures, batch splits, shared session history
   showing another agent reusing my tab via navigate{reused:true}).
9. **navigate ignores tabId** (reuses the CURSOR tab; newTab:true for fresh) —
   guide says "reuses the tab" but not "your tabId argument is dropped".
10. **tabs{action:"frames"} follows the browser-active tab**, ignoring tabId.
11. **press_key = synthetic events only** (no trusted defaults: Ctrl+A, text
    insertion never happen; only page JS handlers fire). Guide lists it flat.
12. **Ref lifecycle**: full explore renumbers E-refs by in-viewport order;
    refs rot across re-renders op-inconsistently (click heals via locators,
    type_text/inspect do not); CSS-selector refs are the stable form.
13. **explore default = viewport-scoped actions** (full:true = offscreen) —
    guide implies SAG completeness (only claims losslessness for snapshot, so
    mostly ✅, but worth one explicit line).
14. **session is SHARED across agents** — session{action:"reset"} wipes
    everyone's map/history; history contains full typed texts (privacy).
15. **main_world func must be an EXPRESSION**; statement bodies return
    result:null with success:true (silent). Also correct: async supported.
16. **type_text batch reports filled:0/failed:false-negatives** — fills land;
    trust DELTA/main_world read-back, not the batch counters.
17. **status{kind:doctor} serviceWorker section is always an error**
    ("Unknown content action: doctor_sw"); network_log totalCaptured is
    post-clear (always 0 with clear:true).
18. **escalation on FAILED type_text ("re_read", re-explore + clearFirst) is
    good** — distinguish this from the noisy success-path escalation.
19. Guide lists **network_log twice** (cosmetic).
20. cookies: guide's list = metadata-only ✅ (README's "never values" is the
    wrong claim for action:get — get returns values per code).

## File-vs-behavior mysteries (both sides disagree with the running server)
- classifyEffect (server.js:79): file says any quickState divergence →
  confirmed / identical → suspected_noop; live returns `unverifiable` for both
  shapes (rerender with differing bodyText; identical states).
- wait selector r2-fallback: RESOLVED 2026-09-25 — it DOES execute. Direct
  retest: existing→success first poll, missing→clean timeout; the old "8
  sends/3s = 1/iter" log read misattributed the envelope's `success:true`
  (top-level) to `data.success`. Only classifyEffect remains a live mystery.
Server PID 3672 started 2026-09-25 00:45 (after file mtime 2026-09-21) → not
version skew; an unseen layer or config. Spec = observed behavior until
resolved. → FIX LIST for Ali (with the code bugs in EXTENSION_MAP.md §8).
