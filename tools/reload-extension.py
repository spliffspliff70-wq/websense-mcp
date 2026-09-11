"""Reload the WebSense Chrome extension in the background — no human click needed.

WHY THIS IS NON-TRIVIAL (all verified 2026-09-11):
  * `extension_reload` over MCP is handled by the service worker, but the hub
    routes the op to whichever client is live. Before 1.3.1 the offscreen had no
    handler, so the op fell through and did nothing while the tool still reported
    `reloadSent: true`.
  * A *pre-fix* extension cannot reload itself — the fix that makes reloading work
    cannot load itself. So this uses the one path that always exists: the popup's
    own "Reconnect" button (popup.js calls chrome.runtime.reload()).
  * The popup prints the ACTIVE TAB's title. When the popup page is itself the
    active tab, that title is a long chrome-extension:// URL which WRAPS and pushes
    the button down by ~18px. So: screenshot, measure, click — in ONE script, with
    the popup active.
  * Vision models mis-reported this button's box twice (off by 17px; and reported
    1914x900 for a 1784x871 image). A 4px miss lands on background and does
    NOTHING, silently. So the button is measured with PIL by finding the solid
    green band (rows with >150 green pixels) — that threshold separates the button
    from the green heading TEXT, which is the same colour.

Usage:  python tools/reload-extension.py [--extension-id ID] [--verify-url URL]
Exits 0 on success and prints the csBuild before/after.
"""

import argparse
import base64
import io
import json
import os
import struct
import sys
import time
import urllib.request

DEFAULT_EXT_ID = "gdcpfjhkeenecahgeokhichelbdhnono"
MCP = "http://127.0.0.1:9222/mcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


class Mcp:
    def __init__(self):
        self.sid = None
        self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": "reload-ext", "version": "1"}}})

    def _post(self, payload, timeout=120):
        hh = dict(HDR)
        if self.sid:
            hh["mcp-session-id"] = self.sid
        req = urllib.request.Request(MCP, data=json.dumps(payload).encode(),
                                     headers=hh, method="POST")
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
        except Exception as e:
            print(f"  ! MCP request failed: {e}")
            return []
        self.sid = resp.headers.get("mcp-session-id") or self.sid
        out = []
        for line in resp.read().decode().splitlines():
            if line.startswith("data:"):
                try:
                    out.append(json.loads(line[5:].strip()))
                except Exception:
                    pass
        return out

    def call(self, name, args=None):
        out = self._post({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                          "params": {"name": name, "arguments": args or {}}})
        for m in out:
            if m.get("id") == 7:
                try:
                    return json.loads(m["result"]["content"][0]["text"])
                except Exception:
                    return m.get("result")
        return None


def png_size(raw):
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", raw[16:24])
    return w, h


def find_green_button(png_bytes):
    """Return (cx, cy) of the solid green button, measured from pixels."""
    from PIL import Image
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = im.size
    px = im.load()

    def is_green(c):
        r, g, b = c
        return g > 120 and g > r + 40 and g > b + 20

    rows = []
    for y in range(h):
        n = 0
        for x in range(w):
            if is_green(px[x, y]):
                n += 1
        rows.append(n)

    # The button is a solid band: many green pixels in a row. Heading TEXT is green
    # too but sparse, so a threshold well above the text density isolates the button.
    best = [y for y, n in enumerate(rows) if n > 150]
    if not best:
        return None, (w, h)
    top, bot = min(best), max(best)
    # horizontal extent within the band
    left, right = w, 0
    for y in range(top, bot + 1):
        for x in range(w):
            if is_green(px[x, y]):
                left = min(left, x)
                right = max(right, x)
    cx = (left + right) // 2
    cy = (top + bot) // 2
    return (cx, cy), (w, h), (left, top, right, bot)


def get_build(mcp):
    st = mcp.call("status", {"kind": "page"})
    d = (st or {}).get("data", st) or {}
    return d.get("csBuild"), d.get("wsVersion"), d.get("url")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extension-id", default=DEFAULT_EXT_ID)
    ap.add_argument("--verify-url", default="https://example.com/")
    args = ap.parse_args()

    mcp = Mcp()
    before, _, _ = get_build(mcp)
    print(f"csBuild BEFORE: {before}")

    popup_url = f"chrome-extension://{args.extension_id}/popup.html"
    print(f"opening popup: {popup_url}")
    nav = mcp.call("navigate", {"url": popup_url, "newTab": True})
    tab_id = (nav or {}).get("tabId")
    if not tab_id:
        print("! could not open the popup tab:", nav)
        return 2
    time.sleep(2.0)

    # The popup must be the OS-FRONTMOST active tab, not merely bound: real_click
    # gates on the Chrome WINDOW TITLE (which reflects the active tab) and refuses
    # otherwise. `tabs{action:"switch"}` binds the tab but does NOT raise it, so use
    # the purpose-built real_activate_tab, which OS-clicks the tab pill via UIA.
    # popup.html has no <title>, so its tab title is the URL — hence "popup.html".
    act = mcp.call("real_activate_tab", {"match": "popup.html", "gate": "popup.html"})
    print("activate popup ->", json.dumps(act)[:200] if act else act)
    time.sleep(1.5)

    shot = mcp.call("screenshot", {})
    d = (shot or {}).get("data", shot) or {}
    data_url = d.get("dataUrl") or d.get("dataURL") or d.get("screenshot") or ""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url) if data_url else b""
    if not raw:
        print("! no screenshot data; keys were:", list(d.keys())[:12])
        return 2

    measured = find_green_button(raw)
    if not measured or not measured[0]:
        print("! could not locate the green Reconnect button")
        return 2
    (cx, cy), (iw, ih), box = measured
    print(f"screenshot {iw}x{ih}; button box={box} center=({cx},{cy})")

    res = mcp.call("real_click", {"x": cx, "y": cy, "gate": "popup.html"})
    print("click ->", json.dumps(res)[:200] if res else res)

    # chrome.runtime.reload() tears the extension down; give it a moment, then
    # force a fresh document so a NEW content script is injected and reports.
    time.sleep(6)
    mcp.call("navigate", {"url": args.verify_url, "newTab": False})
    time.sleep(7)

    after, wsv, url = get_build(mcp)
    print(f"csBuild AFTER : {after}   (wsVersion={wsv}, url={url})")
    if after and before and after != before:
        print("✅ RELOADED")
        return 0
    print("❌ build unchanged — reload did not take effect")
    return 1


if __name__ == "__main__":
    sys.exit(main())
