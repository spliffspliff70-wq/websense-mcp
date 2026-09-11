"""Call a WebSense MCP tool over HTTP and print the result.

Reusable smoke-test harness (2026-09-11d). The MCP client in the Hermes gateway
caches the tool schema per session, so a freshly-changed server needs this direct
path to be exercised without restarting the gateway.

Usage:
  python tools/mcp_smoke.py <tool> ['{"json":"args"}'] [--timeout 60]

Handshake notes (each cost a debugging cycle):
  * `initialize` MUST be a real JSON-RPC method, not a tools/call name.
  * send `notifications/initialized` (a notification: no id) before any call.
  * the response is SSE, and the first line can be a notification — scan for the
    line whose JSON has our id rather than trusting the first line.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

MCP = "http://127.0.0.1:9222/mcp"
PROTO = "2025-06-18"
BASE = {"Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"}


def _post(payload, sid=None, timeout=60):
    h = dict(BASE)
    if sid:
        h["mcp-session-id"] = sid
    if payload.get("method") != "initialize":
        h["MCP-Protocol-Version"] = PROTO
    req = urllib.request.Request(MCP, data=json.dumps(payload).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            return r.headers.get("mcp-session-id") or sid, body
    except urllib.error.HTTPError as e:
        return sid, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:500]}"


def _pick(body, want_id):
    """SSE body -> the JSON payload whose id matches."""
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        try:
            j = json.loads(line[5:].strip())
        except Exception:
            continue
        if want_id is None or j.get("id") == want_id:
            return j
    return None


def main():
    tool = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].startswith("{") else {}
    timeout = 60
    if "--timeout" in sys.argv:
        timeout = int(sys.argv[sys.argv.index("--timeout") + 1])

    sid, body = _post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": PROTO, "capabilities": {},
                                  "clientInfo": {"name": "smoke", "version": "1"}}})
    _post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid=sid)

    t0 = time.time()
    sid, body = _post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}, sid=sid, timeout=timeout)
    dt = time.time() - t0
    j = _pick(body, 2)
    out = None
    if j:
        res = j.get("result") or {}
        texts = [c.get("text") for c in (res.get("content") or []) if c.get("type") == "text"]
        raw = texts[0] if texts else json.dumps(res)[:2000]
        try:
            out = json.loads(raw)
        except Exception:
            out = raw
    print(f"--- {tool}  ({dt:.2f}s) ---")

    # --save <path>: write a dataUrl payload to disk so an image result can be
    # inspected instead of being lost to the print cap.
    if "--save" in sys.argv and isinstance(out, dict) and isinstance(out.get("dataUrl"), str):
        import base64
        dest = sys.argv[sys.argv.index("--save") + 1]
        payload = out["dataUrl"].split(",", 1)[1]
        with open(dest, "wb") as fh:
            fh.write(base64.b64decode(payload))
        print(f"saved -> {dest} ({os.path.getsize(dest)} bytes)")

    def shrink(o):
        """Redact long strings (base64 dataUrls) so the useful fields are visible
        instead of being pushed past the print cap by one huge value."""
        if isinstance(o, dict):
            return {k: (f"<{len(v)} chars>" if isinstance(v, str) and len(v) > 120 else shrink(v))
                    for k, v in o.items()}
        if isinstance(o, list):
            return [shrink(x) for x in o[:20]]
        return o

    if isinstance(out, str):
        print(out[:3000])
    else:
        print(json.dumps(shrink(out), indent=1)[:3000])


if __name__ == "__main__":
    main()
