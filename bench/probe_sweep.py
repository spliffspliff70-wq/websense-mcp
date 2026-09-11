"""Isolate the cursor-sweep cost on a heavy-stylesheet page.

Compares explore_page default (sweep runs) vs includeCursorSweep:false.
If the delta is large, the sweep is the remaining hot spot.
"""

import json, time, statistics, urllib.request

BASE = "http://127.0.0.1:9222/mcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}

def post(payload, sid=None, timeout=120):
    hh = dict(HDR)
    if sid:
        hh["mcp-session-id"] = sid
    r = urllib.request.Request(BASE, data=json.dumps(payload).encode(), headers=hh, method="POST")
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
    except Exception:
        return [], sid
    sid = resp.headers.get("mcp-session-id") or sid
    out = []
    for line in resp.read().decode().splitlines():
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
                          "clientInfo": {"name": "sweep", "version": "1"}}})

URL = "http://127.0.0.1:3940/pages/heavyviewport.html"
call("navigate", {"url": URL, "newTab": False}, sid)
time.sleep(6)

def run(label, args, reps=4):
    times, info = [], None
    for _ in range(reps):
        t0 = time.perf_counter()
        res, _s = call("explore_page", args, sid, timeout=150)
        dt = time.perf_counter() - t0
        d = (res or {}).get("data", res) or {}
        if (res or {}).get("success") is False or d.get("error"):
            return label, None, None, (res or {}).get("error") or d.get("error")
        times.append(dt)
        info = d
    return label, times, info, None

print(f"target: {URL}\n")
print(f"{'variant':34} {'p50':>8} {'min':>8} {'totalEls':>9} {'scanMs':>7} {'examined':>9} {'sweepSkipped':>13}")

for label, args in [
    ("default (maxActions=200)", {"fresh": True}),
    ("maxActions=50", {"fresh": True, "maxActions": 50}),
    ("maxActions=1000", {"fresh": True, "maxActions": 1000}),
    ("sweep:false", {"fresh": True, "includeCursorSweep": False}),
]:
    label, times, info, err = run(label, args)
    if err:
        print(f"{label:34} FAIL: {str(err)[:50]}")
        continue
    print(f"{label:34} {statistics.median(times):>7.3f}s {min(times):>7.3f}s "
          f"{info.get('totalElements','-'):>9} {info.get('scanMs','-'):>7} "
          f"{info.get('candidatesExamined','-'):>9} {str(info.get('cursorSweepSkipped', False)):>13}")
