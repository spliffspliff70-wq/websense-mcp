#!/usr/bin/env python3
"""
LIVE MULTI-SESSION ISOLATION TEST for WebSense.

Ali's design intent (2026-09-20): "each instance of websense to be attributed to
1 tab to 1 caller/agent so they can work in parallel no matter how many + no
foreground."

This connects TWO (and optionally three) INDEPENDENT MCP sessions to the live
server at http://127.0.0.1:9222/mcp and asserts that each session's page ops stay
on ITS OWN tab. It is a live integration test, not a unit test: it needs the
websense server + the Chrome extension.

Run:  python test/live-isolation-test.py
Env:  WEBSENSE_MCP=http://127.0.0.1:9222/mcp
Exit: 0 = isolation holds, 1 = isolation broken (the bug Ali described).

Why this exists: the August isolation script was lost, and the failure mode it
guards is silent -- a hijacked tab reads as a wrong-but-plausible page, not as an
error. Test the property directly instead of inferring it from symptoms.
"""

import json
import os
import sys
import urllib.request

URL = os.environ.get("WEBSENSE_MCP", "http://127.0.0.1:9222/mcp")
ACCEPT = "application/json, text/event-stream"

FAILURES = []
NOTES = []


def _parse(body):
    """Streamable-HTTP responses may be SSE; pull JSON out of either shape."""
    out = []
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            try:
                out.append(json.loads(line[5:].strip()))
            except Exception:
                pass
    if not out:
        try:
            out.append(json.loads(body))
        except Exception:
            pass
    return out


class Session:
    """One independent MCP session = one 'caller/agent'."""

    def __init__(self, label):
        self.label = label
        self.sid = None
        self._post({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": label, "version": "1"}},
        })
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        self._id = 1

    def _post(self, payload):
        h = {"Content-Type": "application/json", "Accept": ACCEPT}
        if self.sid:
            h["mcp-session-id"] = self.sid
        req = urllib.request.Request(URL, data=json.dumps(payload).encode(),
                                     headers=h, method="POST")
        r = urllib.request.urlopen(req, timeout=60)
        got = r.headers.get("mcp-session-id")
        if got:
            self.sid = got
        return r.read().decode("utf-8", "replace"), payload.get("id")

    def call(self, tool, args=None):
        """tools/call -> the parsed WebSense payload (textResult unwrapped)."""
        self._id += 1
        body, want = self._post({
            "jsonrpc": "2.0", "id": self._id, "method": "tools/call",
            "params": {"name": tool, "arguments": args or {}},
        })
        for m in _parse(body):
            if m.get("id") != want:
                continue
            if "error" in m:
                return {"_error": m["error"]}
            content = (m.get("result") or {}).get("content") or []
            self.last_blocks = [c.get("text") for c in content if isinstance(c, dict)]
            text = content[0].get("text") if content else None
            if text is None:
                return {"_raw": m.get("result")}
            try:
                return json.loads(text)
            except Exception:
                return {"_text": text}
        return {"_error": "no matching response"}

    def _page_url_once(self):
        r = self.call("status", {"kind": "page"})
        d = r.get("data") if isinstance(r, dict) else None
        if isinstance(d, dict) and d.get("url"):
            return d["url"]
        if isinstance(r, dict) and r.get("url"):
            return r["url"]
        return None

    def page_url(self, retries=8, delay=0.75):
        """Read this session's tab URL, waiting for the content script to inject.

        A freshly created tab legitimately answers 'Restricted page: ' or
        'no-receiving-end' until its content script is live -- that is readiness,
        NOT an isolation breach. Retry so the test measures isolation, not timing.
        """
        import time as _t
        last = None
        for _ in range(retries):
            u = self._page_url_once()
            if u:
                return u
            last = self.call("status", {"kind": "page"})
            _t.sleep(delay)
        return "?" + json.dumps(last)[:180]

    def bind(self, tab_id):
        return self.call("tabs", {"action": "bind", "tabId": int(tab_id)})


def check(label, cond, detail=""):
    # detail explains a FAILURE; printing it on PASS reads as a contradiction.
    print(("  PASS  " if cond else "  FAIL  ") + label + ((("  -- " + detail) if detail else "") if not cond else ""))
    if not cond:
        FAILURES.append(label + (("  -- " + detail) if detail else ""))


def note(msg):
    NOTES.append(msg)
    print("  note  " + msg)


def main():
    print("=" * 78)
    print("LIVE MULTI-SESSION ISOLATION TEST  ->  " + URL)
    print("=" * 78)

    A = Session("session-A")
    B = Session("session-B")
    print("\nA sid=%s\nB sid=%s\n" % (A.sid, B.sid))

    tabs = []
    try:
        # ── 1. Each session creates its OWN tab ──────────────────────────────
        print("[1] each session opens a tab")
        ra = A.call("navigate", {"url": "https://example.com", "newTab": True})
        rb = B.call("navigate", {"url": "https://example.org", "newTab": True})
        tA, tB = ra.get("tabId"), rb.get("tabId")
        print("    A navigate -> tabId=%s reused=%s" % (tA, ra.get("reused")))
        print("    B navigate -> tabId=%s reused=%s" % (tB, rb.get("reused")))
        for t in (tA, tB):
            if t:
                tabs.append(int(t))
        check("navigate returned a tabId for both sessions", bool(tA) and bool(tB))
        check("the two sessions got DIFFERENT tabs", tA != tB, "A=%s B=%s" % (tA, tB))

        # ── 2. Interleaved reads must not cross over ─────────────────────────
        print("\n[2] interleaved status reads (4 rounds)")
        for i in range(4):
            ua, ub = A.page_url(), B.page_url()
            ok_a = "example.com" in ua
            ok_b = "example.org" in ub
            check("round %d: A reads its own tab" % (i + 1), ok_a, ua)
            check("round %d: B reads its own tab" % (i + 1), ok_b, ub)

        # ── 3. A re-navigates WITHOUT newTab: B must be untouched ────────────
        print("\n[3] A navigates again (reuse, no newTab) -> must not steal B")
        ra2 = A.call("navigate", {"url": "https://example.com/?round=2"})
        ub_after = B.page_url()
        check("A's re-navigate reused its OWN tab", ra2.get("tabId") == tA,
              "reused tabId=%s (A=%s B=%s)" % (ra2.get("tabId"), tA, tB))
        check("B is still on its own page after A navigated", "example.org" in ub_after, ub_after)
        if ra2.get("tabId") == tB:
            note("*** LEAK 1 CONFIRMED: A's navigate landed on B's tab (%s) ***" % tB)

        # ── 4. Explicit bind, then re-check ─────────────────────────────────
        print("\n[4] explicit bind, then re-read")
        A.bind(tA)
        B.bind(tB)
        check("A still reads its tab after bind", "example.com" in A.page_url())
        check("B still reads its tab after bind", "example.org" in B.page_url())

        # ── 5. A fresh, UNBOUND session ─────────────────────────────────────
        print("\n[5] a fresh UNBOUND session (the cron-worker case)")
        C = Session("session-C-unbound")
        uc = C.page_url()
        blocks = "\n".join(b or "" for b in getattr(C, "last_blocks", []))
        warned = "SESSION WAS UNBOUND" in blocks
        print("    C (never bound, never navigated) sees: %s" % uc)
        print("    caller was WARNED about the auto-bind: %s" % warned)
        if "example.com" in uc or "example.org" in uc:
            note("C was auto-bound to an EXISTING session's tab (expected pre-fix behaviour; "
                 "post-fix this must be paired with the WARNING above so it is not silent)")
        # The fix's observable signature: unbound -> pinned + warned, never silent.
        check("an unbound session is auto-bound AND told about it (not silent)", warned,
              "no WARNING block reached the caller")
        # And the pin must stick: a second op from C stays on the same tab.
        u2 = C.page_url()
        check("C's binding persisted across calls (no re-fallback)", u2 == uc,
              "first=%s second=%s" % (uc, u2))

        # ── 6. Same tab, two sessions: reads must agree (sanity, not isolation)
        print("\n[6] sanity: two sessions bound to the SAME tab agree")
        B.bind(tA)
        check("B bound to A's tab now reads A's page", "example.com" in B.page_url())

    finally:
        print("\n[cleanup] closing test tabs: %s" % tabs)
        for t in tabs:
            try:
                A.call("tabs", {"action": "close", "tabId": t})
            except Exception as e:
                print("    close %s failed: %s" % (t, e))

    print("\n" + "=" * 78)
    if NOTES:
        print("FINDINGS / LEAKS OBSERVED:")
        for n in NOTES:
            print("  - " + n)
        print()
    print("%d failure(s)" % len(FAILURES))
    for f in FAILURES:
        print("  FAIL  " + f)
    print("VERDICT:", "ISOLATION HOLDS" if not FAILURES else "ISOLATION BROKEN")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
