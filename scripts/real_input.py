#!/usr/bin/env python3
"""real_input.py — UIA-based real-input rung for WebSense v4.4.

Subcommands: activate-tab, click-xy, paste-text
All gate on the Chrome window title matching the expected active tab, and
auto-measure the page Document origin (Chrome UIA Document control) so
callers pass VIEWPORT coordinates (same space as WebSense inspect geometry).

Usage:
  python real_input.py activate-tab --match "Submit to r/mcp" [--gate "expected title"]
  python real_input.py click-xy   --x 1442 --y 1098 --gate "expected title" [--origin 121]
  python real_input.py paste-text --x 1255 --y 1273 --gate "expected title" --text "..."
  python real_input.py paste-text --x 1255 --y 1273 --gate "expected title" --from-stdin

Each subcommand returns JSON: {"success":true/false, "title":"...", "error":"..."}
"""
import sys, json, time, subprocess, argparse
import ctypes

_user32 = ctypes.windll.user32

def _fg_hwnd():
    return _user32.GetForegroundWindow()

def _restore_focus(hwnd):
    """Best-effort focus restore after a real-input op (co-work politeness).
    SetForegroundWindow is blocked for background PIDs (Windows foreground
    lock) — the AttachThreadInput trick bypasses it: attach our thread to the
    CURRENT foreground thread (Chrome, post-input), then restore is allowed."""
    if not hwnd:
        return
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        # 1. AttachThreadInput to the current foreground thread
        fg = user32.GetForegroundWindow()
        fg_thread = user32.GetWindowThreadProcessId(fg, None)
        this_thread = kernel32.GetCurrentThreadId()
        attached = False
        if fg_thread and fg_thread != this_thread:
            attached = bool(user32.AttachThreadInput(this_thread, fg_thread, True))
        try:
            # 2. ALT-key trick: a synthetic ALT press grants foreground rights
            user32.keybd_event(0x12, 0, 0, 0)   # ALT down
            ok = bool(user32.SetForegroundWindow(hwnd))
            user32.keybd_event(0x12, 0, 2, 0)   # ALT up
            # 3. fallback: SwitchToThisWindow (force)
            if not ok:
                user32.SwitchToThisWindow(hwnd, True)
            # 4. fallback: AppActivate via WScript.Shell — Explorer owns
            #    foreground rights, so delegation succeeds where direct
            #    SetForegroundWindow from a background PID is locked out
            if not ok or user32.GetForegroundWindow() != hwnd:
                try:
                    import win32gui  # optional
                except ImportError:
                    pass
                try:
                    pid = ctypes.c_ulong()
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                    ps = ["powershell", "-NoProfile", "-Command",
                          f"(New-Object -ComObject WScript.Shell).AppActivate({pid.value})"]
                    subprocess.run(ps, check=False, timeout=5,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
                except Exception:
                    pass
        finally:
            if attached:
                user32.AttachThreadInput(this_thread, fg_thread, False)
        # honesty: report ACTUAL restore result, not intent
        try:
            return user32.GetForegroundWindow() == hwnd
        except Exception:
            return False
    except Exception:
        return False  # restore is best-effort; the input already landed

def _find_chrome(gate=None):
    """Chrome window whose active-tab title contains `gate`. Returns pywinauto window or None."""
    from pywinauto import Desktop
    for w in Desktop(backend='uia').windows():
        t = w.window_text()
        if not t.endswith('Google Chrome'):
            continue
        if gate and gate not in t:
            continue
        return w
    return None

def _doc_origin(chrome):
    """Page Document origin in screen coords via the Chrome UIA Document control.
    Falls back to window top + 121 (measured chrome UI height) if UIA tree is empty."""
    try:
        for d in chrome.descendants(control_type="Document"):
            r = d.rectangle()
            return (r.left, r.top)
    except Exception:
        pass
    r = chrome.rectangle()
    return (r.left, r.top + 121)

def cmd_activate_tab(args):
    """Activate a Chrome tab by matching its title substring; gate after."""
    from pywinauto import Desktop
    chrome = None
    for w in Desktop(backend='uia').windows():
        t = w.window_text()
        if t.endswith('Google Chrome') and (not args.gate or args.gate in t):
            chrome = w
            break
    if not chrome:
        return {"success": False, "error": f"Chrome window not found (gate: {args.gate})"}
    tabs = chrome.descendants(control_type="TabItem")
    target = None
    for t in tabs:
        if args.match in t.window_text():
            target = t
            break
    if not target:
        return {"success": False, "error": f"Tab not found: {args.match}"}
    target.click_input()
    time.sleep(2.0)
    title = chrome.window_text()
    if args.gate and args.gate not in title:
        return {"success": False, "error": f"Tab activated but gate failed: {title}"}
    return {"success": True, "title": title}

def cmd_click_xy(args):
    """Real OS click at VIEWPORT coords (x,y), title-gated, doc-origin offset."""
    import pyautogui
    pyautogui.FAILSAFE = False  # headless helper: explicit move-to-coords; the title gate is the safety
    chrome = _find_chrome(args.gate)
    if args.gate and not chrome:
        return {"success": False, "error": f"Gate failed: no Chrome window containing '{args.gate}'"}
    # SendInput only reaches the FOREGROUND window — raise Chrome first
    if chrome:
        try: chrome.set_focus()
        except Exception: pass
        time.sleep(0.4)
    ox, oy = (args.origin, 121) if args.origin is not None else (_doc_origin(chrome) if chrome else (0, 121))
    if args.origin is not None:
        ox, oy = 0, args.origin
    sx, sy = ox + args.x, oy + args.y
    saved = None if args.no_restore else _fg_hwnd()
    pyautogui.moveTo(sx, sy, duration=0.25)
    time.sleep(0.3)
    pyautogui.click(sx, sy)
    restored = _restore_focus(saved) if saved else False
    return {"success": True, "clicked_at": [sx, sy], "viewport": [args.x, args.y], "focus_restored": bool(restored)}

def cmd_paste_text(args):
    """Click into the editor at VIEWPORT (x,y), set clipboard, real Ctrl+V."""
    import pyautogui
    pyautogui.FAILSAFE = False  # headless helper: explicit move-to-coords; the title gate is the safety
    chrome = _find_chrome(args.gate)
    if args.gate and not chrome:
        return {"success": False, "error": f"Gate failed: no Chrome window containing '{args.gate}'"}
    # SendInput only reaches the FOREGROUND window — raise Chrome first
    if chrome:
        try: chrome.set_focus()
        except Exception: pass
        time.sleep(0.4)
    ox, oy = _doc_origin(chrome) if chrome else (0, 121)
    sx, sy = ox + args.x, oy + args.y
    saved = None if args.no_restore else _fg_hwnd()
    # 1. click into the editor
    pyautogui.moveTo(sx, sy, duration=0.25)
    time.sleep(0.3)
    pyautogui.click(sx, sy)
    time.sleep(0.6)
    # 2. set clipboard (stdin-piped Set-Clipboard — robust, no arg quoting issues)
    text = args.text or sys.stdin.read()
    ps = ["powershell", "-NoProfile", "-Command", "$input | Set-Clipboard"]
    subprocess.run(ps, input=text, check=True, text=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    time.sleep(0.5)
    # 3. real Ctrl+V (SendInput — trusted paste)
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(1.0)
    if saved:
        restored = _restore_focus(saved)
    else:
        restored = False
    return {"success": True, "pasted_len": len(text), "target": [sx, sy], "focus_restored": bool(restored)}

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='command')
    # activate-tab
    at = sub.add_parser('activate-tab')
    at.add_argument('--match', required=True, help='Tab title substring to match')
    at.add_argument('--gate', default=None)
    at.set_defaults(func=cmd_activate_tab)
    # click-xy (viewport coords)
    cx = sub.add_parser('click-xy')
    cx.add_argument('--x', type=int, required=True)
    cx.add_argument('--y', type=int, required=True)
    cx.add_argument('--gate', default=None)
    cx.add_argument('--origin', type=int, default=None, help='Override doc origin Y (default: measured)')
    cx.add_argument('--no-restore', action='store_true', help='Skip focus restore after input')
    cx.set_defaults(func=cmd_click_xy)
    # paste-text (viewport coords)
    pt = sub.add_parser('paste-text')
    pt.add_argument('--x', type=int, required=True)
    pt.add_argument('--y', type=int, required=True)
    pt.add_argument('--gate', default=None)
    pt.add_argument('--text', default=None)
    pt.add_argument('--from-stdin', action='store_true')
    pt.add_argument('--no-restore', action='store_true', help='Skip focus restore after input')
    pt.set_defaults(func=cmd_paste_text)
    args = p.parse_args()
    if not args.command:
        p.print_help(); sys.exit(1)
    result = args.func(args)
    print(json.dumps(result))
    sys.exit(0 if result.get('success') else 1)

if __name__ == '__main__':
    main()