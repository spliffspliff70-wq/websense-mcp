"""OLD vs NEW, same page, one session. Numbers only."""

import json, sys, time, urllib.request, urllib.error

MCP = "http://127.0.0.1:9222/mcp"

from importlib.util import spec_from_file_location, module_from_spec
_spec = spec_from_file_location("mcpraw", r"E:/websense-oss/tools/mcp_raw.py")
_mpr = module_from_spec(_spec); _spec.loader.exec_module(_mpr)
post, _parse, SID = _mpr.post, _mpr._parse, _mpr.SID

def call(name, args, sid=None):
    # returns the parsed MCP envelope; sid is tracked inside the shared module
    return post({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                 "params": {"name": name, "arguments": args}}, timeout=120)

def unwrap(res):
    if isinstance(res, tuple):
        res = res[0]
    d = (res or {}).get("result") or {}
    if isinstance(d.get("content"), list) and d["content"]:
        t = d["content"][0].get("text", "")
        try: return json.loads(t)
        except Exception: return {"text": t[:120]}
    return d

def sz(o):
    try: return len(json.dumps(o, ensure_ascii=False).encode())
    except Exception: return 0

def count(res):
    d = unwrap(res)
    return len(d.get("actions") or [])

def nav(url):
    _h = {"Content-Type": "application/json",
          "Accept": "application/json, text/event-stream"}
    _r = urllib.request.Request(MCP, data=json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "ovn", "version": "1"}}}).encode(), headers=_h, method="POST")
    _resp = urllib.request.urlopen(_r, timeout=60)
    SID[0] = _resp.headers.get("mcp-session-id") or SID[0]
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=30)
    d = unwrap(call("navigate", {"url": url}))
    return d.get("tabId")

def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://github.com/nodejs/node"
    tab = nav(url)
    time.sleep(3)
    print("page:", url, "tab:", tab)

    # ---------- OLD WAY ----------
    t0 = time.time(); old_explore = call("explore_page", {}); t_old_explore = time.time() - t0
    d_old = unwrap(old_explore); b_old_explore = sz(d_old)
    n_old = len(d_old.get("actions") or [])

    # pick a text field to type into (same target for both ways)
    target = None
    for a in (d_old.get("actions") or []):
        if a.get("type") == "form_input" and a.get("subtype") in ("text", "search", None):
            target = a.get("ref"); break
    if not target:
        for a in (d_old.get("actions") or []):
            if a.get("type") in ("form_input", "search"): target = a.get("ref"); break

    # OLD verify = a SECOND explore call (incremental)
    t0 = time.time(); old_verify = call("explore_page", {"incremental": True}); t_old_verify = time.time() - t0
    d_ov = unwrap(old_verify); b_old_verify = sz(d_ov)

    # ---------- NEW WAY ----------
    t0 = time.time(); snap = call("page_snapshot", {}); t_snap = time.time() - t0
    d_snap = unwrap(snap); b_snap = sz(d_snap)
    idx = d_snap if isinstance(d_snap, dict) else {}
    if "index" in idx: idx = idx["index"] or {}
    b_index = sz(idx)
    n_snap = idx.get("elements") or idx.get("domTotal") or 0

    # NEW verify = the DELTA block already riding on the action result (0 extra calls)
    t0 = time.time(); act = call("press_key", {"keys": "shift"}); t_act = time.time() - t0
    d_act = unwrap(act); b_act = sz(d_act)
    delta = d_act.get("delta") or d_act.get("mutated") or {}
    if isinstance(delta, bool): delta = {"mutated": delta}

    print()
    print("=" * 62)
    print("OLD WAY  (explore -> act -> explore{incremental})")
    print("  explore_page      %8d B   %.2fs   %d actions" % (b_old_explore, t_old_explore, n_old))
    print("  verify call       %8d B   %.2fs" % (b_old_verify, t_old_verify))
    print("  TOTAL             %8d B   %.2fs   2 calls" % (b_old_explore + b_old_verify, t_old_explore + t_old_verify))
    print()
    print("NEW WAY  (page_snapshot index -> act, DELTA rides along)")
    print("  page_snapshot     %8d B   %.2fs   (index only, inventory stored)" % (b_snap, t_snap))
    print("    of which index  %8d B          %d elements mapped" % (b_index, n_snap))
    print("  action result     %8d B   %.2fs   delta already on it" % (b_act, t_act))
    print("  TOTAL             %8d B   %.2fs   1 call" % (b_snap + b_act, t_snap + t_act))
    print()
    if b_old_explore + b_old_verify:
        ratio = (b_old_explore + b_old_verify) / max(1, (b_snap + b_act))
        print("SHRINK: %.1fx smaller, %d call(s) instead of %d" % (ratio, 1, 2))
    print("COVERAGE: old saw %d actions; snapshot maps %d elements" % (n_old, n_snap))
    print("DELTA on the action result: mutated=%s changed=%s" % (delta.get("mutated"), delta.get("changed")))

main()
