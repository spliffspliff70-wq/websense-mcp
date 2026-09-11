# WebSense live benchmark — 2026-09-11

Measured over the MCP HTTP transport (`:9222/mcp`) directly from Python, so the
numbers are pure tool latency with **no LLM turn overhead** in the measurement.

Harness: `bench/ws_bench.py` (battery), `bench/probe_explore.py` (payload
composition), `bench/gen_synth.py` (synthetic pages with known element counts).

## Build under test

| component | version | note |
|---|---|---|
| content script | `csBuild: v4.3.1-bg-raf-fix` | **pre-1.2.0** — the reload that would load v4.4.0 did not land |
| hub / MCP server | PID 12884, started 2026-09-09 06:53 | long-lived manual process; `_timeoutDiag` on disk but **not loaded** |

So this is the **pre-fix baseline**, which is the correct thing to measure first.
1.2.0 is on disk and on GitHub but inert in the running browser.

## 1. Latency by op — light page (example.com, ~30 elements)

| op | p50 | max | bytes |
|---|---|---|---|
| status(page) | 0.024s | 0.060s | 797 |
| status(bridge) | 0.004s | 0.009s | 306 |
| read(content) | 0.007s | 0.017s | 491 |
| read(text) | 0.009s | 0.009s | 337 |
| explore(full) | 0.653s | 1.285s | 2,058 |
| explore(compact) | 0.636s | 0.661s | 980 |
| explore(incremental) | 0.007s | 0.655s | 596 |
| screenshot | 0.088s | 30.002s | 27,044 |
| scroll(down,2) | 0.017s | 0.035s | 288 |

**Verdict: the light path is genuinely good.** Everything sub-second, payloads
tiny. The transport itself costs ~5–25 ms per call — the 5-hop relay is not the
bottleneck when the page is small.

## 2. Latency by op — heavy SPA (x.com search)

| op | p50 | max | bytes |
|---|---|---|---|
| status(page) | 0.028s | 0.033s | 836 |
| read(content) | 0.025s | 0.026s | 1,459 |
| read(text) | 0.006s | 0.022s | 3,009 |
| **explore(full)** | **23.320s** | **90.020s** | **1,106,837** |
| explore(compact) | 0.652s | 1.215s | 178,178 |
| explore(incremental) | 0.103s | 90.004s | 1,484 |
| screenshot | 0.163s | 0.734s | 453,540 |
| scroll(down,2) | 0.006s | 0.007s | 291 |

`explore(full)` returns **1.1 MB** (~275k tokens). Unusable as agent context even
when it succeeds.

## 3. Payload composition — where the bytes go (x.com)

| variant | time | bytes | latency vs default |
|---|---|---|---|
| default | 14.561s | 1,006,657 | 1× |
| includeContent:false | 22.468s | 996,928 | no help |
| compact | 1.420s | 178,332 | 10× faster, 5.6× smaller |
| compact + maxActions:50 | 0.486s | 35,238 | **30× faster, 28× smaller** |
| intent=search | **0.022s** | **4,200** | **662× faster, 240× smaller** |
| incremental | 90.036s | 181 | timed out |

`includeContent:false` does **not** reduce the payload — the bulk is the action
graph under `data`, not body text.

## 4. The hard failure: `explore_page` default on a heavy content page

Wikipedia *World War II*, default `explore_page`, fresh navigation each time:

```
default #1   90.013s  180B  ok=False  Request timeout (90s) for explore_page
default #2   90.004s  180B  ok=False  Request timeout (90s) for explore_page
default #3   90.009s  180B  ok=False  Request timeout (90s) for explore_page
default #4   90.007s  180B  ok=False  Request timeout (90s) for explore_page
includeContent:false  90.010s FAIL
```

**4/4 reproducible failure.** The default call an agent makes on any big page
costs 90 seconds and then errors. `{"success": false, "error": "Request timeout
(90s) for explore_page"}` — with no hop named, which is what 1.2.0's
`_timeoutDiag` fixes.

### The cliff (`compact`, maxActions ladder, Wikipedia)

| maxActions | time | bytes | result |
|---|---|---|---|
| 20 | 0.680s | 14,762 | ok |
| 50 | 0.976s | 35,482 | ok |
| 100 | 4.971s | 75,091 | ok |
| 150 | 7.018s | 114,928 | ok |
| 200 | 8.003s | 155,061 | ok |
| **250** | **90.004s** | 185 | **FAIL — `Request timeout (90s) for discover_actions`** |

Two things fall out of this:
1. **The default `maxActions` is 250** (`params.maxActions || 250` at
   `websense-cs.js:334` and `:3172`) — the server default sits **exactly at or
   past the failure cliff.**
2. The error names `discover_actions`, a legacy inner op — the timeout is
   attributed to a name the caller never invoked.
3. Superlinear: 50→100 actions is 2× output for 5× the time.

## 5. Scaling law (`explore_page` default, synthetic pages)

Pages with known element counts, 5s settle so the content script is ready:

| total elements | default | compact+200 | intent |
|---|---|---|---|
| 556 | 0.44s (1/2 runs) | 0.99s | 0.00s |
| 2,206 | **10.99s** | **10.99s** | 0.04s |
| 5,506 | TIMEOUT 90s | TIMEOUT 90s | 0.20s |
| 11,006 | **TIMEOUT 90s** | **TIMEOUT 90s** | **0.55s** |

2,206 elements → ~11s is reproducible (10.55 / 10.99 / 11.00 / 11.04 / 11.006 /
10.998). That is **~5 ms per element scanned** — far too slow for a DOM walk, and
the signature of **forced synchronous layout** per element.

## 6. The mechanism — `maxActions` bounds OUTPUT, not WORK

On the 2,206-element page (where every variant costs ~11s):

```
maxActions=  5   11.042s    98B  returned []   <- same cost
maxActions= 20   10.998s    98B  returned []   <- same cost
maxActions= 60   11.006s    98B  returned []   <- same cost
maxActions=200   10.998s    98B  returned []   <- same cost
```

A 40× change in the cap produces **0% change in time**. Proof that the cap does
not bound the work.

The reason, from `extractActionGraph` (`websense-cs.js:1642-1714`):

```js
const maxActions = options.maxActions || 0;          // default 0 = UNBOUNDED
...
if (maxActions > 0 && actions.length >= maxActions) break;   // breaks on ACCEPTED count
...
if (!options.includeHidden && !isInViewport(el) && !options.full) continue;  // rejects
```

The loop only breaks when it has **accepted** `maxActions` elements. On a page
where few elements pass `isInViewport`, it can never reach the cap, so it walks
**the entire DOM** regardless of the cap. My synthetic page has all its links
below 2,000 divs → zero in-viewport interactives → the cap never engages → full
walk → 11s and an empty result.

Per candidate element the code calls, in document order:
`isInteractive(el)` → `isVisible(el)` → `cachedStyle(el)` → `getComputedStyle(el)`
→ `isInViewport(el)` → **`getBoundingClientRect()`**.

`getBoundingClientRect()` interleaved with `getComputedStyle()` is textbook
**layout thrashing**: each geometry read after any style read forces a fresh
layout of the entire document. Cost grows with document complexity, which is why
556 elements ≈ 0.4s but 2,206 ≈ 11s and 11,006 > 90s.

Also: `waitForSettle(2500, 400)` adds a **mandatory ~400 ms** to every explore
even when the DOM is already quiet (it resolves on a 400 ms quiet timer; it does
not skip).

## 7. What is genuinely good

- **The transport is not the bottleneck on light pages** — 5–25 ms per call
  through 5 async hops is respectable.
- **`intent=` is excellent**: 0.02–0.78s and ~3–4 KB **regardless of page size**,
  and the *only* variant that works on the 11,006-element page (0.55s). It is
  275–662× faster than the default and ~240× smaller.
- **`incremental`** returned 1,484 bytes in 0.103s on x.com — a 740× size
  reduction vs default.
- **`read`/`status`/`scroll`** are consistently sub-30 ms and small.
- `explore(compact, maxActions:50)` — 30× faster and 28× smaller than default on
  x.com, with a real action list.

The capabilities are all there. **The defaults are pointed at the worst
configuration.**

## 8. Measurement caveats (honest)

- One run showed a 556-element page timing out at 90s where another run measured
  0.44s. Cause not proven; hypothesis is content-script readiness / first-call
  warm-up after navigation. Two early battery runs were also non-monotonic for
  the same reason. The **2,206 → 11s** and **11,006 → timeout** results are
  reproducible and are what the conclusions rest on.
- An early harness bug reported `navigate` as 167s; that was a field mix-up in my
  own script (bytes read as seconds). `navigate` is actually **~0.01s**.
- `navigate` returns **before the navigation commits**, so a read issued
  immediately after can still see the previous page. This is real and worth
  fixing (see below), and it accounted for one confusing result.
- Benchmarks ran against the same live extension/hub as the interactive session,
  so contention is possible.

## 9. Ranked optimisations (not yet implemented)

| # | change | evidence | expected gain | risk |
|---|---|---|---|---|
| 1 | **Bound the default `maxActions`** (0/unbounded → ~100) and make the default `compact` on large DOMs | default fails 4/4 at 90s; 250 fails, 200 takes 8s | turns a 90s failure into ~1–5s success | very low — a default change |
| 2 | **Reorder to viewport-first.** The default filters to in-viewport elements but enumerates in document order, so it walks everything to find a few visible ones. Use `IntersectionObserver`, or `document.elementsFromPoint` over a viewport grid, to enumerate visible interactives directly | 2,206 elements / 0 in-viewport interactives → 11s walk for an empty result | 10–100× on pages with few visible interactives | medium |
| 3 | **Batch the geometry.** Collect candidates first, then read rects in one pass — or better, replace per-element `getBoundingClientRect()` with a single `IntersectionObserver` pass | ~5 ms/element; superlinear on larger DOMs | removes the layout-thrash term entirely | medium |
| 4 | **Pre-filter candidates.** `getAllElements(document.body)` pushes *every* element node; a `querySelectorAll` over an interactive selector list cuts the scan set by ~10–50× | 11,006 elements walked for ~1,000 interactive | large, cheap | low |
| 5 | **Add a scan ceiling** — cap *elements scanned*, not just actions accepted. Never walk more than N candidates | `maxActions` 5 vs 200 → identical 11s | guarantees bounded worst case | low |
| 6 | **Fail fast when the content script is not ready** instead of blocking 90s | first-call-after-navigate timeouts | 90s → <1s to a clear error | low |
| 7 | **Make `navigate` await commit** (or return `pending:true`) | immediate read after navigate sees the old page | removes a whole class of agent retries | low |
| 8 | **Warm up / cache the element list** across calls with a mutation counter | repeat explores re-walk the DOM | 2–10× on repeat explores | medium |
| 9 | **Skip `waitForSettle` when the DOM is already quiet** | +400 ms on every call | 400 ms per call | very low |
| 10 | **Split `websense-cs.js`** (3,413 lines, 131 case branches) into modules | nothing independently testable | enables 1–9 safely | large, mechanical |

Items 1, 5, 6, 7 and 9 are small, low-risk and independently verifiable.
Items 2–4 attack the root cause and are where the order-of-magnitude lives.
