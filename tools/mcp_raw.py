"""Call a WebSense MCP tool and print the FULL result, no truncation.

Usage: python mcp_raw.py <tool> '<json-args>' [--timeout N]
"""
import json, sys, urllib.request, urllib.error, time, re

MCP = "http://127.0.0.1:9222/mcp"
HDR = {"Content-Type": "application/json",
       "Accept": "application/json, text/event-stream"}
PROTO = "2025-06-18"
SID = [None]


def _parse(raw):
    txt = raw or ""
    out = None
    for line in txt.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict) and ("result" in obj or "error" in obj):
            out = obj
    return out


def post(payload, timeout=60):
    h = dict(HDR)
    if SID[0]:
        h["mcp-session-id"] = SID[0]
    h["MCP-Protocol-Version"] = PROTO
    req = urllib.request.Request(MCP, data=json.dumps(payload).encode(), headers=h, method="POST")
    r = urllib.request.urlopen(req, timeout=timeout)
    sid = r.headers.get("mcp-session-id")
    if sid:
        SID[0] = sid
    return _parse(r.read().decode("utf-8", "replace"))


def main():
    tool = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].startswith("{") else {}
    to = 60
    if "--timeout" in sys.argv:
        to = int(sys.argv[sys.argv.index("--timeout") + 1])

    post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": PROTO, "capabilities": {},
                     "clientInfo": {"name": "raw", "version": "1"}}})
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    t0 = time.time()
    try:
        resp = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                     "params": {"name": tool, "arguments": args}}, timeout=to)
    except Exception as e:
        print(f"HTTP/transport error after {time.time()-t0:.2f}s: {e!r}")
        return
    dt = time.time() - t0
    print(f"--- {tool} ({dt:.2f}s) ---")
    res = (resp or {}).get("result") or {}
    for c in res.get("content") or []:
        t = c.get("text")
        print(t if t is not None else json.dumps(c))
    if res.get("isError"):
        print("isError: true")


main()
