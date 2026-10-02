# WEBSENSE 30-TOOL ACCOUNTING (2026-10-02)

7 on the wire (WIRE_SURFACE): browse, find, act, page_slice, tabs, debug, websense_guide
37 registered. 30 registered-but-unlisted. This is the per-tool decision.

METHOD: a tool is "REMOVE" only if (a) nothing on the wire calls it by name,
(b) no test calls it over the wire, (c) its capability is fully absorbed by a
listed tool. Otherwise it is KEEP (load-bearing) or KEEP-AS-RUNG (a rung the
listed `act` facade dispatches to).

## CATEGORY A — RUNGS THE LISTED `act`/`debug` FACADES DISPATCH TO (KEEP, load-bearing)
These are called by callTool() inside the listed tools. Removing them breaks act/debug.
- click          → act{action:"click", how:"auto"} default rung (synthetic dispatchEvent). act self-escalates to trusted_click on no-op. TESTS: 21 wire calls.
- type_text      → act{action:"type", how:"auto"} default rung. act self-escalates to trusted_key on refusal. TESTS: 5.
- press_key      → act{action:"key", how:"auto"} rung (synthetic KeyboardEvent). TESTS: 6.
- form           → act{action:"form"} + act{action:"upload"}. TESTS: 3.
- scroll         → act{action:"scroll"}. TESTS: 3.
- dialog         → act{action:"dialog"}. TESTS: 3.
- trusted_click  → act{action:"click", how:"trusted"}. THE background trusted-input rung. TESTS: 1 + 4-layer wiring test.
- trusted_key    → act{action:"type"/"key", how:"trusted"}. TESTS: 2 + wiring test.
- real_click     → act{action:"click", how:"os"}. OS-level SendInput. TESTS: 2.
- real_paste     → act{action:"type", how:"os"}. TESTS: 2.
- main_world     → act drag(trusted) box measurement + debug{op:"main_world"}. TESTS: 2.
- evaluate       → debug{op:"evaluate"}. CSP-safe DOM read. TESTS: 2.
- explore_page   → debug{op:"explore_page"}. quick look (SAG). TESTS: (used by read flows).
- ax             → debug{op:"ax"}. native a11y tree via chrome.debugger (NOT a CDP port). TESTS: 3.
- screenshot     → debug{op:"screenshot"}. TESTS: 3.
- session        → debug{op:"session"}. TESTS: (reset used in recovery).
- status         → debug{op:"status"}. TESTS: 2.
- cookies        → debug{op:"cookies"}. TESTS: 1.
- clipboard      → debug{op:"clipboard"}. TESTS: 1.
- console_log    → debug{op:"console_log"}. TESTS: 1.
- network_log    → debug{op:"network_log"}. TESTS: 7.
- read           → debug{op? no — direct}. page text formats. TESTS: 2.
- inspect        → element introspection / geometry. TESTS: 1.
- reveal         → hidden content pre-extract. TESTS: 1.
- wait           → condition poll / page event. TESTS: 1.
- navigate       → tab navigation (browse wraps it). TESTS: 3.
- page_snapshot  → browse wraps it (collect + index). TESTS: 2.
- extension_reload → maintenance. TESTS: 5.
- respawn_offscreen → maintenance. TESTS: 1.
- real_activate_tab → OS rung prerequisite (before real_click/real_paste). TESTS: 3.

## CATEGORY B — ABSORBED, REMOVABLE (none found)
Every one of the 30 is either (a) a rung act/debug dispatches to, or (b) a
direct read the listed surface exposes via debug{op:...}. NONE is dead.

## CONCLUSION
The 30 are NOT "old tools replaced by better ones." They are the IMPLEMENTATION
LAYER the 7 listed tools dispatch into. The listed tools are FURNACES; the 30 are
the engines. Removing the 30 removes the capability the 7 advertise.

MEASURED PRODUCTION vs TEST-ONLY (grep -c, src/ + extension/ vs test/):
- 26 of 30 have PRODUCTION callers (the rungs act/debug dispatch to): click(32),
  form(28), navigate(23), evaluate(22), main_world(18), respawn_offscreen(16),
  trusted_click(13), trusted_key(13), press_key(12), dialog(12), scroll(12),
  type_text(10), read(10), network_log(9), status(8), console_log(8),
  screenshot(6), session(6), clipboard(6), ax(6), real_click(6), cookies(4),
  real_paste(4), page_snapshot(2), inspect(2), wait(2).
- ONLY 2 are test-only: reveal(0), real_activate_tab(0).
  - real_activate_tab is the documented OS-input prerequisite (the guide says
    "before real_click/real_paste"), so it is a user rung, not dead code.
  - reveal (pre-extract hidden dropdown/accordion/tab content) is a real user
    capability, not test scaffolding.

WHAT IS ACTUALLY WRONG (and what to fix): the split is a MODEL-VISIBILITY problem,
not a redundancy problem. The model sees 7 tools but the rung ladder (auto/trusted/os)
lives inside `act`'s `how` parameter, and nothing tells the model WHICH rung a given
control needs. The fix is NOT removal — it is (done in this session) self-escalation:
act{how:"auto"} tries the cheap synthetic rung and automatically retries through the
trusted pipeline when the page ignores it, so the model stops having to know.
