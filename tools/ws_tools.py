"""Which build is the live websense server running?

Usage: python tools/ws_tools.py [tool_name_to_inspect]

Prints the tool count, whether today's features are present (page_snapshot /
page_slice / the DELTA verify param on click), and optionally one tool's params.
This exists because telling builds apart kept costing whole round-trips.
"""
import json, sys, urllib.request

U = "http://127.0.0.1:9222/mcp"
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
     "MCP-Protocol-Version": "2025-06-18"}
S = [None]


def post(p, to=45):
    h = dict(H)
    if S[0]:
        h["mcp-session-id"] = S[0]
    r = urllib.request.urlopen(urllib.request.Request(
        U, data=json.dumps(p).encode(), headers=h, method="POST"), timeout=to)
    s = r.headers.get("mcp-session-id")
    if s:
        S[0] = s
    return r.read().decode("utf-8", "replace")


def parse(t):
    for line in t.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if isinstance(o, dict) and o.get("result"):
            return o
    return None


def main():
    post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                     "clientInfo": {"name": "ws_tools", "version": "1"}}})
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    o = parse(post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}))
    tools = {t["name"]: t for t in o["result"]["tools"]}
    names = sorted(tools)
    print("TOOL COUNT: %d" % len(names))
    print("page_snapshot present : %s" % ("page_snapshot" in tools))
    print("page_slice present    : %s" % ("page_slice" in tools))
    click = (tools.get("click") or {}).get("inputSchema", {}).get("properties", {})
    print("click has verify param: %s   (True => the DELTA build)" % ("verify" in click))
    print("build guess: %s" % (
        "DEV (snapshot + delta)" if "page_snapshot" in tools and "verify" in click
        else "COMMITTED-ONLY (delta, no snapshot)" if "verify" in click
        else "OLDER BUILD (neither)"))
    if len(sys.argv) > 1:
        t = tools.get(sys.argv[1])
        if not t:
            print("no such tool: %s" % sys.argv[1])
        else:
            print("\n%s params: %s" % (sys.argv[1],
                  list(t.get("inputSchema", {}).get("properties", {}).keys())))
            print("%s desc: %s" % (sys.argv[1], (t.get("description") or "")[:160]))


main()
