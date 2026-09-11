"""Open the WebSense extension popup in a Chrome tab, then load the page.

WHY (2026-09-11): the SW relay wedge kills every WebSense page op AND the popup
automation that reload-extension.py depends on (it measures the button through
WebSense). OS-level input has no such dependency: focus Chrome, Ctrl+L, type the
chrome-extension:// URL, Enter. After that the popup is a normal tab and its
known button position can be clicked with real_click.

Usage:  python goto_url.py "<url>" [--gate "Google Chrome"]
"""
import argparse
import json
import subprocess
import sys
import time

import pyautogui

from real_input import _find_chrome, _doc_origin, _fg_hwnd, _restore_focus


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--gate", default="Google Chrome")
    ap.add_argument("--wait", type=float, default=3.0)
    a = ap.parse_args()

    pyautogui.FAILSAFE = False
    chrome = _find_chrome(a.gate)
    if not chrome:
        print(json.dumps({"success": False, "error": f"no Chrome window matching {a.gate!r}"}))
        sys.exit(1)

    saved = _fg_hwnd()
    try:
        chrome.set_focus()
    except Exception:
        pass
    time.sleep(0.5)

    # Ctrl+L focuses the omnibox; typing replaces its contents; Enter navigates.
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.4)
    pyautogui.write(a.url, interval=0.01)
    time.sleep(0.4)
    pyautogui.press("enter")
    time.sleep(a.wait)

    restored = _restore_focus(saved) if saved else False
    print(json.dumps({"success": True, "url": a.url, "focus_restored": bool(restored)}))


if __name__ == "__main__":
    main()
