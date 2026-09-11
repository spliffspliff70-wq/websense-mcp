"""Measure the CURRENT (1.3.1) cost curve on the synthetic pages.

Compares against the pre-fix baseline recorded in BENCH_REPORT.md:
    556 els -> 0.44s | 2,206 -> 11.0s (exact, x6) | 5,506 -> 90s TIMEOUT | 11,006 -> 90s TIMEOUT
"""

import json, time, urllib.request

BASE = "http://127.0.0.1:9222/mcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}

def post(payload, sid=None, timeout=120):
    hh = dict(HDR)
    if sid:
        hh["mcp-session-id"] = sid
    r = urllib.request.Request(BASE, data=json.dumps(payload).encode(), headers=hh, method="POST")
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
    except Exception as e:
        return [], sid
    sid = resp.headers.get("mcp-session-id") or sid
    body = resp.read().decode()
    out = []
    for line in body.splitlines():
        if line.startswith("data:"):
            try:
                out.append(json.loads(line[5:].strip()))
            except Exception:
                pass
    return out, sid

def call(name, args, sid, timeout=120):
    out, sid = post({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                     "params": {"name": name, "arguments": args}}, sid, timeout)
    for m in out:
        if m.get("id") == 7:
            try:
                return json.loads(m["result"]["content"][0]["text"]), sid
            except Exception:
                return m.get("result"), sid
    return None, sid

_, sid = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                          "clientInfo": {"name": "curve", "version": "1"}}})

PAGES = [
    ("synth_50_500",   "synth_50_500.html",   556),
    ("synth_200_2000", "synth_200_2000.html", 2206),
    ("synth_500_5000", "synth_500_5000.html", 5506),
    ("synth_1000_10000","synth_1000_10000.html", 11006),
]

print(f"{'page':18} {'els':>6} {'wall':>8} {'scanMs':>7} {'examined':>9} {'geo':>6} {'acts':>5}  status")
print("-" * 82)

for label, fname, els in PAGES:
    url = f"http://127.0.0.1:3940/pages/{fname}"
    call("navigate", {"url": url, "newTab": False}, sid)
    time.sleep(6)  # content script + DOM ready

    t0 = time.perf_counter()
    res, sid = call("explore_page", {"fresh": True}, sid, timeout=120)
    wall = time.perf_counter() - t0

    d = (res or {}).get("data", res) or {}
    if (res or {}).get("success") is False or d.get("error"):
        err = (res or {}).get("error") or d.get("error")
        print(f"{label:18} {els:>6} {wall:>7.3f}s {'-':>7} {'-':>9} {'-':>6} {'-':>5}  FAIL: {str(err)[:40]}")
        continue

    print(f"{label:18} {els:>6} {wall:>7.3f}s {d.get('scanMs','-'):>7} "
          f"{d.get('candidatesExamined','-'):>9} {d.get('viewportCandidates','-'):>6} "
          f"{d.get('returnedActions','-'):>5}  ok")
