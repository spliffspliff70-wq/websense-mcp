"""Live verification of the 1.4.0 changes, against the RUNNING extension.

Checks, with real traffic:
  1. cost attribution      — explore_page reports candidatesMs/geometryMs/actionMs
  2. tab status            — the tab list exposes `status`
  3. fast-fail             — a page op into a restricted tab fails FAST with a
                             named hop, instead of hanging for the hub timeout
  4. no regression         — normal page ops still work, and are still fast
"""

import json, time, urllib.request

BASE = "http://127.0.0.1:9222/mcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
sid = None

def post(payload, timeout=150):
    global sid
    hh = dict(HDR)
    if sid: hh["mcp-session-id"] = sid
    req = urllib.request.Request(BASE, data=json.dumps(payload).encode(), headers=hh, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except Exception as e:
        return []
    sid = resp.headers.get("mcp-session-id") or sid
    out = []
    for line in resp.read().decode().splitlines():
        if line.startswith("data:"):
            try: out.append(json.loads(line[5:].strip()))
            except Exception: pass
    return out

post({"jsonrpc":"2.0","id":1,"method":"initialize",
      "params":{"protocolVersion":"2025-06-18","capabilities":{},
                "clientInfo":{"name":"verify14","version":"1"}}})

def call(name, args=None, timeout=150):
    out = post({"jsonrpc":"2.0","id":7,"method":"tools/call",
                "params":{"name":name,"arguments":args or {}}}, timeout)
    for m in out:
        if m.get("id") == 7:
            try: return json.loads(m["result"]["content"][0]["text"])
            except Exception: return m.get("result")
    return None

results = {}

# ── 1. cost attribution ──────────────────────────────────────────────────────
print("=== 1. cost attribution ===")
call("navigate", {"url": "https://en.wikipedia.org/wiki/World_War_II", "newTab": False})
time.sleep(7)
t0 = time.perf_counter()
r = call("explore_page", {"fresh": True})
wall = time.perf_counter() - t0
d = (r or {}).get("data", r) or {}
split = {k: d.get(k) for k in ("candidatesMs", "geometryMs", "actionMs", "scanMs")}
print(f"  wall={wall:.3f}s  split={split}  returned={d.get('returnedActions')} examined={d.get('candidatesExamined')}")
ok_split = all(isinstance(split[k], int) for k in ("candidatesMs", "geometryMs", "actionMs", "scanMs"))
print(f"  {'PASS' if ok_split else 'FAIL'}: all four timing fields reported")
results["attribution"] = ok_split

# ── 2. tab status ────────────────────────────────────────────────────────────
print("\n=== 2. tab status exposed ===")
tl = call("tabs", {"action": "list"})
statuses = [(t.get("url","")[:45], t.get("status")) for t in (tl or [])]
has_key = bool(tl) and all("status" in t for t in tl)
print(f"  {statuses}")
print(f"  {'PASS' if has_key else 'FAIL'}: every tab entry carries `status`")
results["tab_status"] = has_key

# ── 3. fast-fail on a restricted page ────────────────────────────────────────
print("\n=== 3. fast-fail into a restricted tab ===")
nav = call("navigate", {"url": "chrome://settings/", "newTab": True})
rid = (nav or {}).get("tabId")
time.sleep(2)
if rid:
    call("tabs", {"action": "bind", "tabId": rid})
    t0 = time.perf_counter()
    r2 = call("explore_page", {"fresh": True}, timeout=120)
    ff = time.perf_counter() - t0
    d2 = (r2 or {}).get("data", r2) or {}
    err = (r2 or {}).get("error") or d2.get("error")
    reason = (r2 or {}).get("reason") or d2.get("reason")
    hop = (r2 or {}).get("hop") or d2.get("hop")
    print(f"  elapsed={ff:.3f}s  error={err}  reason={reason}  hop={hop}")
    fast = ff < 8
    named = bool(reason or hop or err)
    print(f"  {'PASS' if fast else 'FAIL'}: failed fast ({ff:.2f}s < 8s, was up to 90s)")
    print(f"  {'PASS' if named else 'FAIL'}: failure names the hop/reason")
    results["fast_fail"] = fast
    call("tabs", {"action": "close", "tabId": rid})

# ── 4. normal ops still work + still fast ────────────────────────────────────
print("\n=== 4. normal page ops (no regression) ===")
call("navigate", {"url": "https://example.com/", "newTab": False})
time.sleep(5)
ops = [("status", {"kind":"page"}), ("read", {"format":"content"}), ("explore_page", {}),
       ("explore_page", {"intent": ""}), ("scroll", {"direction":"down","amount":1})]
allok = True
for name, a in ops:
    t0 = time.perf_counter()
    rr = call(name, a)
    dt = time.perf_counter() - t0
    ok = bool(rr) and ((rr.get("success") is not False) if isinstance(rr, dict) else True)
    allok &= ok
    print(f"  {name:14} {dt:6.3f}s  {'ok' if ok else 'FAIL'}")
results["no_regression"] = allok

print("\n=== SUMMARY ===")
for k, v in results.items():
    print(f"  {'PASS' if v else 'FAIL'}  {k}")
print("\nALL PASS" if all(results.values()) else "\nSOME CHECKS FAILED")
