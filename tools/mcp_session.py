"""Persistent MCP client that keeps the session across calls."""
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
    with _lock:
        t0 = time.time()
        resp = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                     "params": {"name": tool, "arguments": args}}, timeout=timeout)
        dt = time.time() - t0
        result = resp.get("result") or {}
        if resp.get("error"):
            print(f"ERROR: {resp['error']}")
            return None
        content = result.get("content") or []
        for c in content:
            t = c.get("text")
            if t is not None:
                print(f"--- {tool} ({dt:.2f}s) ---")
                print(t)
                return t
        # If no text, print raw
        if result:
            print(f"--- {tool} ({dt:.2f}s) ---")
            print(json.dumps(result, indent=2)[:2000])
        return result

if __name__ == "__main__":
    init()
    # Parse args: first arg = tool name, second arg = json
    if len(sys.argv) > 1:
        tool = sys.argv[1]
        args = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].startswith("{") else {}
        timeout = int(sys.argv[3]) if len(sys.argv) > 3 and "--t" in sys.argv[2] else 120
        call(tool, args, timeout)
