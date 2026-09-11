"""Click a point, then press a key combo with genuine OS input (SendInput).

Usage: python press_at.py --x 1119 --y 304 --keys "ctrl+enter" [--gate "Google Chrome"] [--wait 6]
"""
import argparse
import json
import sys
import time

import pyautogui

from real_input import _find_chrome, _doc_origin, _fg_hwnd, _restore_focus


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--x", type=int, required=True)
    ap.add_argument("--y", type=int, required=True)
    ap.add_argument("--keys", required=True, help='e.g. "ctrl+enter" or "ctrl+s"')
    ap.add_argument("--gate", default="Google Chrome")
    ap.add_argument("--wait", type=float, default=6.0)
    a = ap.parse_args()

    pyautogui.FAILSAFE = False
    chrome = _find_chrome(a.gate)
    if not chrome:
        print(json.dumps({"success": False, "error": "no Chrome window"}))
        sys.exit(1)
    saved = _fg_hwnd()
    try:
        chrome.set_focus()
    except Exception:
        pass
    time.sleep(0.5)

    ox, oy = _doc_origin(chrome)
    sx, sy = ox + a.x, oy + a.y
    pyautogui.moveTo(sx, sy, duration=0.2)
    time.sleep(0.25)
    pyautogui.click(sx, sy)
    time.sleep(0.6)

    parts = [p.strip() for p in a.keys.split("+") if p.strip()]
    if len(parts) == 1:
        pyautogui.press(parts[0])
    else:
        pyautogui.hotkey(*parts)
    time.sleep(a.wait)

    restored = _restore_focus(saved) if saved else False
    print(json.dumps({"success": True, "keys": a.keys, "at": [sx, sy],
                      "focus_restored": bool(restored)}))


if __name__ == "__main__":
    main()
