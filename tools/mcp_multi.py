"""Persistent MCP client that maintains session across multiple commands."""
import json, sys, time, urllib.request, threading

MCP = "http://127.0.0.1:9222/mcp"
PROTO = "2025-06-18"
SID = [None]
_lock = threading.Lock()

def post(payload, timeout=120):
    h = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTO,
    }
    if SID[0]:
        h["mcp-session-id"] = SID[0]
    req = urllib.request.Request(MCP, data=json.dumps(payload).encode(), headers=h, method="POST")
    r = urllib.request.urlopen(req, timeout=timeout)
    sid = r.headers.get("mcp-session-id")
    if sid:
        SID[0] = sid
    raw = r.read().decode("utf-8", "replace")
    out = None
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict) and ("result" in obj or "error" in obj):
                out = obj
        except:
            pass
    return out

def init():
    post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": PROTO, "capabilities": {},
                     "clientInfo": {"name": "websense-test", "version": "1"}}})
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})

def call(tool, args, timeout=120):
    req_id = int(time.time() * 1000) % 10000 + 10
    resp = post({"jsonrpc": "2.0", "id": req_id, "method": "tools/call",
                 "params": {"name": tool, "arguments": args}}, timeout=timeout)
    result = resp.get("result") or {}
    if resp.get("error"):
        print(f"ERROR: {resp['error']}")
        return None
    content = result.get("content") or []
    for c in content:
        t = c.get("text")
        if t is not None:
            try:
                parsed = json.loads(t)
                return parsed
            except:
                return t
    if result:
        return result
    return None

def main():
    init()
    # Commands as pipe-delimited: tool|json_args|timeout
    # or pass as lines: TOOL json_args
    lines = sys.stdin.read().strip().split("\n")
    for line in lines:
        if not line.strip():
            continue
        parts = line.split(None, 1)
        tool = parts[0]
        args = json.loads(parts[1]) if len(parts) > 1 else {}
        print(f"\n>>> {tool} {args}")
        result = call(tool, args)
        if isinstance(result, dict):
            print(json.dumps(result, indent=2, ensure_ascii=False)[:5000])
        elif result is not None:
            print(result[:3000])

if __name__ == "__main__":
    main()
