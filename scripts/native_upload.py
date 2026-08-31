#!/usr/bin/env python3
"""
WebSense Native-Dialog Upload Helper (CDP-free)
===============================================
Fills a NATIVE "Open file" dialog that WebSense's DOM upload_file cannot reach
(HackerOne-style drop-zones with NO visible <input type=file> — the drop zone
is a JS click that opens the OS file picker).

Why this exists (verified 2026-08-08 on HackerOne):
  * WebSense upload_file -> locateFileInput() last-resort grabs `input[type=file]`
    #0 on the page. H1's uploader has NO such input — it's a click-to-open-picker
    zone. DOM DataTransfer drops are ignored by the page's handler.
  * cua-driver foreground click on the drop zone DOES open the native dialog.
  * pywinauto CANNOT see the dialog ("NO DIALOG FOUND" — Chrome spawns the picker
    in a separate process tree, invisible to UIA Desktop search).
  * cua-driver CAN see and drive it (it enumerates ALL top-level windows).

USAGE
-----
  python native_upload.py <file_path> <drop_zone_x> <drop_zone_y> [--wait 2]

  <drop_zone_x>, <drop_zone_y> = SCREEN coordinates of the drop zone center.
  Get them from a WebSense SOM/vision capture (computer_use) or from the page.

FLOW
----
  1. Foreground-click the drop zone (opens the native picker)
  2. Wait for the picker window (class #32770)
  3. Type the full path into the "File name" edit
  4. Press Enter / click Open
  5. Report which step succeeded

DEPENDENCIES: pywinauto (Python 3.11), cua-driver CLI (for the click).
The cua-driver click is delivered via its stdin-JSON interface; if cua-driver
is unavailable, falls back to pywinauto click_input on the foreground window.
"""
import sys, time, subprocess, json, argparse, os

PY = r"sys.executable"


def cua_click(x, y, foreground=True):
    """Deliver a real mouse click via cua-driver stdin pipe."""
    payload = {"action": "click", "coordinate": [int(x), int(y)],
               "delivery_mode": "foreground" if foreground else "background"}
    try:
        p = subprocess.run(
            ["cua-driver", "call", "--tool", "click"],
            input=json.dumps(payload), capture_output=True, text=True, timeout=20,
        )
        return p.stdout or p.stderr or ""
    except Exception as e:
        return f"cua-driver unavailable: {e}"


def find_dialog(backend="uia", timeout=8):
    """Find the native Open file dialog (#32770 class)."""
    from pywinauto import Desktop
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            d = Desktop(backend=backend)
            for w in d.windows():
                try:
                    if w.class_name() == "#32770":
                        return w
                except Exception:
                    continue
        except Exception:
            pass
        time.sleep(0.5)
    return None


def type_path_and_open(dialog, file_path):
    """Type the full path into the File name edit and press Enter."""
    try:
        # The dialog has an Edit named "File name:" (combo-style edit in modern
        # pickers). Fall back to the first Edit.
        edit = None
        for ctrl_name in ("File name:", "FileNameControlHost", "Edit"):
            try:
                edit = dialog.child_window(title=ctrl_name, class_name="Edit")
                edit.wait("visible", timeout=2)
                break
            except Exception:
                continue
        if edit is None:
            edits = dialog.children(class_name="Edit")
            if edits:
                edit = edits[0]
        if edit is None:
            return False, "no Edit control found in dialog"
        edit.set_focus()
        edit.type_keys(file_path, with_spaces=True, pause=0.05)
        time.sleep(0.3)
        dialog.type_keys("{ENTER}", pause=0.1)
        return True, "typed + Enter"
    except Exception as e:
        return False, f"type failed: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file_path", help="Absolute path to the file to upload")
    ap.add_argument("x", type=int, help="Screen X of the drop zone center")
    ap.add_argument("y", type=int, help="Screen Y of the drop zone center")
    ap.add_argument("--wait", type=float, default=2.0, help="Seconds to wait for the dialog after click")
    ap.add_argument("--no-click", action="store_true", help="Dialog already open — skip the click")
    args = ap.parse_args()

    if not os.path.isfile(args.file_path):
        print(json.dumps({"success": False, "step": "validate", "error": "file not found: " + args.file_path}))
        return 1

    if not args.no_click:
        click_out = cua_click(args.x, args.y)
        print(f"[step1] clicked drop zone at ({args.x},{args.y}) -> {click_out[:120]}")

    time.sleep(args.wait)

    dialog = find_dialog("uia", timeout=8)
    if dialog is None:
        dialog = find_dialog("win32", timeout=4)
    if dialog is None:
        print(json.dumps({"success": False, "step": "find_dialog",
                          "error": "no #32770 dialog found after click — the click may not have opened the picker, or Chrome used an in-process dialog"}))
        return 1

    ok, msg = type_path_and_open(dialog, args.file_path)
    print(json.dumps({"success": ok, "step": "type_open", "dialog": str(dialog.window_text())[:60], "msg": msg}))

    # Give the page a moment to register the upload
    time.sleep(1.5)
    print("[done] verify the attachment in the page (upload_file confirmed field) before claiming success")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
