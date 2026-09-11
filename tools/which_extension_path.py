"""Report the on-disk path Chrome actually loads the WebSense extension from.

Why this exists (2026-09-11d): editing extension/websense-cs.js and reloading the
extension appeared to work (reload reported reconnected) while the RUNNING content
script was still the old code — so the fix under test looked like it had failed.
Knowing the loaded directory settles "is my edit live?" in one call.

Usage: python tools/which_extension_path.py [extension-id]
"""
import json
import os
import sys

ID = sys.argv[1] if len(sys.argv) > 1 else "gdcpfjhkeenecahgeokhichelbdhnono"
PROFILE = os.path.join(os.environ["LOCALAPPDATA"], "Google", "Chrome", "User Data", "Default")

found = False
for fname in ("Secure Preferences", "Preferences"):
    p = os.path.join(PROFILE, fname)
    if not os.path.exists(p):
        continue
    try:
        d = json.load(open(p, encoding="utf-8"))
    except Exception as e:
        print(f"{fname}: read failed ({e})")
        continue
    settings = ((d.get("extensions") or {}).get("settings")) or {}
    print(f"--- {fname}: {len(settings)} entr(ies) ---")
    for eid, v in settings.items():
        path = v.get("path") or ""
        name = ((v.get("manifest") or {}).get("name") or "")
        if eid == ID or "websense" in path.lower() or "websense" in name.lower():
            found = True
            loc = v.get("location")
            # location 4 == unpacked/LOAD_UNPACKED, 5 == command line
            kind = {4: "unpacked", 5: "command-line"}.get(loc, f"loc={loc}")
            print(f"  id    : {eid}")
            print(f"  name  : {name!r}")
            print(f"  kind  : {kind}   state={v.get('state')}")
            print(f"  path  : {path}")
            cs = os.path.join(path, "extension", "websense-cs.js")
            if os.path.exists(cs):
                st = os.stat(cs)
                print(f"  cs    : {cs}")
                print(f"          {st.st_size} bytes, mtime={st.st_mtime:.0f}")
            else:
                alt = os.path.join(path, "websense-cs.js")
                if os.path.exists(alt):
                    st = os.stat(alt)
                    print(f"  cs    : {alt}  ({st.st_size} bytes)")

if not found:
    print(f"extension {ID} not found in the Chrome profile's stored settings.")
