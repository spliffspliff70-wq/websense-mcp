"""Deep probe: characterise explore_page payload composition and cost drivers.

Answers: on a heavy SPA, where do the bytes and the seconds go, and does any
existing flag (compact / maxActions / includeContent:false / incremental)
actually bring the response into a usable size?

Run: python probe_explore.py
"""
import json
import sys
import time
from ws_bench import Mcp

TARGETS = [
    ("HEAVY-SPA  x.com search",
     "https://x.com/search?q=0x18570ea663ec4cc4b1611b11eb10fabf8691e1f7&f=live"),
    ("HEAVY-PAGE wikipedia WWII",
     "https://en.wikipedia.org/wiki/World_War_II"),
]

# variant label -> explore_page args
VARIANTS = [
    ("default",            {}),
    ("includeContent:false", {"includeContent": False}),
    ("compact",            {"compact": True}),
    ("compact+maxActions50", {"compact": True, "maxActions": 50}),
    ("intent=search",      {"intent": "search"}),
    ("incremental",        {"incremental": True}),
]


def key_sizes(pay):
    """Byte size of each top-level key — shows what dominates the payload."""
    if not isinstance(pay, dict):
        return {}
    out = {}
    for k, v in pay.items():
        try:
            out[k] = len(json.dumps(v))
        except Exception:
            out[k] = -1
    return dict(sorted(out.items(), key=lambda kv: -kv[1])[:8])


def count_actions(pay):
    if not isinstance(pay, dict):
        return None
    for k in ("actions", "elements"):
        v = pay.get(k)
        if isinstance(v, list):
            return len(v)
    return None


def main():
    m = Mcp()
    m.init()

    for label, url in TARGETS:
        print(f"\n{'='*78}\n{label}\n{url}\n{'='*78}")
        m.call("navigate", {"url": url, "newTab": False})
        # settle: wait for url match
        for _ in range(60):
            _, _, p, _ = m.call("status", {"kind": "page"})
            d = p.get("data", {}) if isinstance(p, dict) else {}
            if d.get("readyState") == "complete" and \
                    (d.get("url") or "").startswith(url.split("?")[0][:40]):
                break
            time.sleep(0.25)
        time.sleep(2.0)

        for vlabel, args in VARIANTS:
            t0 = time.perf_counter()
            try:
                _, nbytes, pay, err = m.call("explore_page", args, timeout=180)
            except Exception as e:
                print(f"  {vlabel:22s} EXCEPTION {e}")
                continue
            dt = time.perf_counter() - t0
            acts = count_actions(pay)
            ks = key_sizes(pay)
            print(f"  {vlabel:22s} {dt:7.3f}s  {nbytes:>9,d} B  "
                  f"actions={acts}  err={err}")
            if ks:
                print(f"      {'by key: ' + json.dumps(ks)}")
            # a sample action so we can judge 'smartness' of the graph
            if isinstance(pay, dict) and isinstance(pay.get("actions"), list) \
                    and pay["actions"] and vlabel in ("compact+maxActions50",):
                s = pay["actions"][0]
                print(f"      sample action: {json.dumps(s)[:220]}")
            time.sleep(0.5)


if __name__ == "__main__":
    main()
