"""LIVE test: does every mutating op flag its own DOM diff? (Ali directive 2026-09-21)

Asserts:
  [1] first action on a fresh tab reports mutated:null (baseline seeded, honestly unknown)
  [2] a REAL mutation reports mutated:true with the changed element
  [3] a NO-OP reports mutated:false  <-- the money case: "it did NOT land"
  [4] verify:false suppresses the delta block entirely

Usage: python test/action-delta-test.py
Exit 0 = all assertions pass.
"""
import json, os, re, sys, time, urllib.request

URL = os.environ.get("WEBSENSE_MCP", "http://127.0.0.1:9222/mcp")
ACCEPT = "application/json, text/event-stream"
PAGE = os.environ.get("DELTA_TEST_PAGE", "https://httpbin.org/forms/post")
FAILS = []


def _parse(raw):
    out = []
    for line in (raw or "").split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


class Sess:
    def __init__(self, label):
        self.sid = None
        self.last_blocks = []
        self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": label, "version": "1"}}})
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._id = 1

    def _post(self, p):
        h = {"Content-Type": "application/json", "Accept": ACCEPT,
             "MCP-Protocol-Version": "2025-06-18"}
        if self.sid:
            h["mcp-session-id"] = self.sid
        r = urllib.request.urlopen(urllib.request.Request(
            URL, data=json.dumps(p).encode(), headers=h, method="POST"), timeout=120)
        s = r.headers.get("mcp-session-id")
        if s:
            self.sid = s
        return r.read().decode("utf-8", "replace")

    def call(self, tool, args=None):
        self._id += 1
        body = self._post({"jsonrpc": "2.0", "id": self._id, "method": "tools/call",
                           "params": {"name": tool, "arguments": args or {}}})
        for m in _parse(body):
            if m.get("id") != self._id:
                continue
            content = (m.get("result") or {}).get("content") or []
            self.last_blocks = [c.get("text") for c in content if isinstance(c, dict)]
            t = self.last_blocks[0] if self.last_blocks else None
            try:
                return json.loads(t)
            except Exception:
                return {"_text": t}
        return {"_error": "no response"}

    def delta(self):
        """Extract the DELTA block, or None if absent."""
        for b in self.last_blocks[1:]:
            if b and b.startswith("DELTA"):
                m = re.search(r"DELTA \(auto, after ([a-z_]+)\): (\{.*\})", b, re.S)
                if not m:
                    return {"_op": "?", "_unparsed": b}
                d = json.loads(m.group(2))
                d["_op"] = m.group(1)
                return d
        return None


def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    print("=" * 74)
    print("ACTION-DELTA LIVE TEST  ->  " + URL)
    print("page: " + PAGE)
    print("=" * 74)
    A = Sess("delta-test")
    r = A.call("navigate", {"url": PAGE})
    tab = (r or {}).get("tabId")
    print("navigate -> tabId=%s success=%s" % (tab, (r or {}).get("success")))
    time.sleep(2.5)

    ex = A.call("explore_page", {})
    # Responses are WRAPPED: {"type":..., "success":true, "data":{...}} — the SAG lives
    # under .data. Reading .actions off the top level silently yields 0 actions.
    exd = (ex or {}).get("data") or ex or {}
    acts = exd.get("actions") or []
    print("explore_page -> %d actions" % len(acts))
    target = None
    for a in acts:
        loc = str(a.get("locator") or "")
        if "custname" in loc or "Customer name" in str(a.get("label") or ""):
            target = a
            break
    if not target:
        print("  !! could not find the customer-name field; got refs:",
              [a.get("ref") for a in acts[:12]])
        print("FAILED: test could not locate its target field")
        return 1
    print("target field: ref=%s label=%s locator=%s"
          % (target.get("ref"), target.get("label"), target.get("locator")))

    # ── [1] first action on a fresh tab: must be honest that it cannot tell
    print("\n[1] FIRST action (no baseline yet)")
    ts = int(time.time())
    A.call("type_text", {"ref": target["ref"], "text": "DELTA-A-%d" % ts})
    d1 = A.delta()
    print("    delta:", json.dumps(d1))
    check("first action reports a DELTA block at all", d1 is not None)
    check("first action honestly reports mutated:null (baseline seeded)",
          d1 is not None and d1.get("mutated") is None, json.dumps(d1))

    # ── [2] a real mutation must be flagged true
    print("\n[2] REAL mutation (second type into the same field)")
    A.call("type_text", {"ref": target["ref"], "text": "DELTA-B-%d" % ts})
    d2 = A.delta()
    print("    delta:", json.dumps(d2))
    check("real mutation flagged mutated:true", d2 is not None and d2.get("mutated") is True,
          json.dumps(d2))
    check("the changed element is named", bool(d2 and d2.get("elements")), json.dumps(d2))

    # ── [3] THE MONEY CASE: a no-op must be flagged false
    print("\n[3] NO-OP action (must be flagged as NOT landed)")
    A.call("press_key", {"key": "shift"})
    d3 = A.delta()
    print("    delta:", json.dumps(d3))
    check("no-op flagged mutated:false (this is the 'did it land' negative)",
          d3 is not None and d3.get("mutated") is False, json.dumps(d3))
    check("no-op carries the do-not-retry hint", bool(d3 and d3.get("hint")), json.dumps(d3))

    # ── [4] opt-out must work
    print("\n[4] verify:false must suppress the block")
    A.call("type_text", {"ref": target["ref"], "text": "DELTA-C-%d" % ts, "verify": False})
    d4 = A.delta()
    blocks = len(A.last_blocks or [])
    print("    blocks=%d delta=%s" % (blocks, json.dumps(d4)))
    check("verify:false suppressed the DELTA block", d4 is None, "blocks=%d" % blocks)

    print("\n" + "=" * 74)
    print("%d failure(s)" % len(FAILS))
    if FAILS:
        for f in FAILS:
            print("  - " + f)
        return 1
    print("VERDICT: the diff is flagged programmatically — the model does not need a second call.")
    return 0


sys.exit(main())
