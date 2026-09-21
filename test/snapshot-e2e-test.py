"""END-TO-END: lossless page snapshot + addressable index + slice.

Assertions:
  [1] page_snapshot returns a SMALL index and stores a much larger inventory
  [2] the snapshot sees elements the SAG/scan-cache CANNOT (off-viewport + non-interactive)
  [3] page_slice fetches one slice at full fidelity, with a usable locator per record
  [4] THE CORRECTNESS FIX: scrolling does NOT change the snapshot index
      (the scan cache is viewport-filtered, so a scroll pollutes its diff)
  [5] a slice with no live snapshot fails cleanly instead of returning junk

Usage: python test/snapshot-e2e-test.py [url]
Exit 0 = all assertions pass.
"""
import json, os, sys, time, urllib.request

URL = os.environ.get("WEBSENSE_MCP", "http://127.0.0.1:9222/mcp")
PAGE = sys.argv[1] if len(sys.argv) > 1 else "https://github.com/nodejs/node"
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
        self.blocks = []
        self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": label, "version": "1"}}})
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._id = 1

    def _post(self, p):
        h = {"Content-Type": "application/json",
             "Accept": "application/json, text/event-stream",
             "MCP-Protocol-Version": "2025-06-18"}
        if self.sid:
            h["mcp-session-id"] = self.sid
        r = urllib.request.urlopen(urllib.request.Request(
            URL, data=json.dumps(p).encode(), headers=h, method="POST"), timeout=180)
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
            self.blocks = [c.get("text") for c in content if isinstance(c, dict)]
            t = self.blocks[0] if self.blocks else None
            try:
                j = json.loads(t)
            except Exception:
                return {"_text": t}
            # page-op replies are WRAPPED {type,id,success,data:{...}} — unwrap.
            return j.get("data") if isinstance(j, dict) and isinstance(j.get("data"), dict) else j
        return {"_error": "no response"}


def b(o):
    return len(json.dumps(o).encode("utf-8"))


def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  [" + str(detail) + "]") if not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    print("=" * 78)
    print("SNAPSHOT + INDEX + SLICE — END TO END")
    print("page: " + PAGE)
    print("=" * 78)
    A = Sess("snap-e2e")
    nav = A.call("navigate", {"url": PAGE})
    print("navigate -> tabId=%s success=%s" % (nav.get("tabId"), nav.get("success")))
    time.sleep(3)

    # ── [1] snapshot + index
    print("\n[1] page_snapshot -> index")
    t0 = time.time()
    snap = A.call("page_snapshot", {})
    dt = time.time() - t0
    print("    took %.2fs" % dt)
    if not snap.get("success"):
        print("    FAILED:", json.dumps(snap)[:400])
        return 1
    idx = snap.get("index") or {}
    print("    index bytes=%d | elements=%s domTotal=%s interactive=%s inViewport=%s offViewport=%s"
          % (b(idx), idx.get("elements"), idx.get("domTotal"), idx.get("interactive"),
             idx.get("inViewport"), idx.get("offViewport")))
    print("    topTags:", idx.get("topTags")[:5])
    print("    addressableBy:", idx.get("addressableBy"))
    check("snapshot stored a real inventory", (idx.get("elements") or 0) > 50, idx.get("elements"))
    check("the index is SMALL (< 4000 B) while the inventory is large",
          b(idx) < 4000, "%d B" % b(idx))

    # ── [2] sees what the filtered extractor cannot
    print("\n[2] does the snapshot see what explore_page cannot?")
    ex = A.call("explore_page", {})
    exb = b(ex)
    ex_actions = len((ex.get("actions") or []))
    off = A.call("page_slice", {"vp": False, "limit": 2000})
    on = A.call("page_slice", {"vp": True, "limit": 2000})
    print("    explore_page: %d actions, %d B" % (ex_actions, exb))
    print("    snapshot: %s elements | in-viewport %s | OFF-viewport %s"
          % (idx.get("elements"), on.get("matched"), off.get("matched")))
    check("snapshot covers more elements than the SAG returns",
          (idx.get("elements") or 0) > ex_actions,
          "snapshot=%s sag=%s" % (idx.get("elements"), ex_actions))
    check("off-viewport elements are visible to the snapshot (the scan cache cannot see these)",
          (off.get("matched") or 0) > 0, off.get("matched"))

    # ── [3] slice at full fidelity, with an actionable locator
    print("\n[3] page_slice — one branch at full fidelity")
    sl = A.call("page_slice", {"tag": "a", "limit": 5})
    print("    matched=%s returned=%s bytes=%d" % (sl.get("matched"), sl.get("returned"), b(sl)))
    if sl.get("elements"):
        print("    sample:", json.dumps(sl["elements"][0])[:220])
    check("a tag slice returns records", (sl.get("returned") or 0) > 0)
    check("records carry a usable locator",
          bool(sl.get("elements") and sl["elements"][0].get("loc")), json.dumps(sl.get("elements"))[:200])
    check("a slice is cheaper than reading the whole page",
          b(sl) < exb, "slice=%d explore=%d" % (b(sl), exb))

    # ── [4] THE CORRECTNESS FIX: scroll must not change the snapshot
    print("\n[4] scroll -> the snapshot index must NOT change (viewport-independence)")
    A.call("scroll", {"direction": "down", "amount": 3})
    time.sleep(1.5)
    idx2 = (A.call("page_snapshot", {}) or {}).get("index") or {}
    same = json.dumps(idx2, sort_keys=True) == json.dumps(idx, sort_keys=True)
    print("    before: elements=%s inViewport=%s offViewport=%s"
          % (idx.get("elements"), idx.get("inViewport"), idx.get("offViewport")))
    print("    after : elements=%s inViewport=%s offViewport=%s"
          % (idx2.get("elements"), idx2.get("inViewport"), idx2.get("offViewport")))
    check("the snapshot did NOT churn on scroll (the scan cache does churn here)", same)

    # ── [5] no snapshot for an unknown tab -> clean failure
    print("\n[5] slice with no snapshot must fail cleanly")
    bad = A.call("page_slice", {"tabId": 999999999})
    check("missing snapshot reports an error, not junk",
          bad.get("success") is False and "snapshot" in str(bad.get("error", "")), json.dumps(bad)[:200])

    print("\n" + "=" * 78)
    print("%d failure(s)" % len(FAILS))
    if FAILS:
        for f in FAILS:
            print("  - " + f)
        return 1
    print("VERDICT: lossless snapshot + addressable index + slice all work end to end.")
    return 0


sys.exit(main())
