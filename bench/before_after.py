"""Before/after comparison for WebSense 1.3.0.

Measures the same page/op matrix that produced the "before" numbers in
BENCH_REPORT.md, so the two are directly comparable.

Run:  python bench/before_after.py
"""
import json, time, urllib.request, sys

BASE = "http://127.0.0.1:9222/mcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


def post(payload, sid=None):
    hh = dict(HDR)
    if sid:
        hh["Mcp-Session-Id"] = sid
    req = urllib.request.Request(BASE, data=json.dumps(payload).encode(),
                                headers=hh, method="POST")
    r = urllib.request.urlopen(req, timeout=180)
    return r.headers.get("Mcp-Session-Id"), r.read().decode("utf-8", "replace")


def parse(t):
    for line in t.splitlines():
        if line.startswith("data:"):
            try:
                return json.loads(line[5:].strip())
            except Exception:
                pass
    try:
        return json.loads(t)
    except Exception:
        return None


sid, _ = post({"jsonrpc": "2.0", "id": 0, "method": "initialize",
               "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                          "clientInfo": {"name": "bench", "version": "1"}}})
post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)


def call(name, args, timeout_s=180):
    _, t = post({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                 "params": {"name": name, "arguments": args}}, sid)
    d = parse(t)
    return ((d.get("result") or {}).get("content") or [{}])[0].get("text") or ""


def timed(name, args):
    t0 = time.perf_counter()
    raw = call(name, args)
    dt = time.perf_counter() - t0
    ok = '"success": true' in raw
    err = ""
    if not ok:
        try:
            err = (json.loads(raw).get("error") or "")[:90]
        except Exception:
            err = raw[:90]
    return dt, len(raw), ok, err


def settle(tab, want, tries=30):
    for _ in range(tries):
        time.sleep(0.5)
        try:
            st = json.loads(call("status", {"kind": "page"}))
            d = st.get("data", {})
            if d.get("url", "").startswith(want) and d.get("readyState") == "complete":
                return d
        except Exception:
            pass
    return {}


def run_page(label, url, want, ops):
    r = json.loads(call("navigate", {"url": url, "newTab": True}))
    tab = r.get("tabId")
    settle(tab, want)
    time.sleep(1.5)
    print(f"\n=== {label}  [{url}]")
    for opname, args in ops:
        a = dict(args)
        a.setdefault("tabId", tab)
        dt, nbytes, ok, err = timed(opname.split(" ")[0], a)
        flag = "OK " if ok else "FAIL"
        print(f"  {flag} {opname:<34} {dt:8.3f}s  {nbytes:>9,} B  {err}")


xcom = "https://x.com/search?q=0x18570ea663ec4cc4b1611b11eb10fabf8691e1f7&f=live"

# --- the case that failed 4/4 at 90s before ---------------------------------
run_page("HEAVY / content page (was 4/4 TIMEOUT @90s)", 
         "https://en.wikipedia.org/wiki/World_War_II", "https://en.wikipedia.org/wiki/World_War_II",
         [("explore_page (default)", {}),
          ("explore_page compact50", {"compact": True, "maxActions": 50}),
          ("explore_page intent", {"intent": "search"})])

# --- heavy SPA: was 14.6-23.3s / 1,006,657 B --------------------------------
run_page("HEAVY / SPA (was 23.3s, 1,006,657 B)",
         xcom, "https://x.com/search",
         [("explore_page (default)", {}),
          ("explore_page compact", {"compact": True, "maxActions": 50}),
          ("explore_page incremental", {"incremental": True}),
          ("explore_page intent", {"intent": "search"}),
          ("read(content)", {"format": "content"})])

# --- light page ------------------------------------------------------------
run_page("LIGHT / static (was 0.653s, 2,058 B)",
         "https://example.com/", "https://example.com/",
         [("explore_page (default)", {}),
          ("status(page)", {"kind": "page"}),
          ("read(content)", {"format": "content"})])
