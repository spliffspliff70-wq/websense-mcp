#!/usr/bin/env python
"""dispatcher-show.py — print a duplicated op's handler side by side, from both dispatchers.

MERGED 2026-10-01 from show-divergences.py + show-handle-dialog.py (same job, one took a
hardcoded list of ops and the other a single op).

WHY THIS EXISTS: WebSense has TWO content-script dispatchers sharing 48 ops —
  00-bridge-and-transport.js  wsDispatchPage     (direct WS)
  70-capture-and-readers.js   handleMessageAsync (offscreen relay)
Seeing the two bodies next to each other is how each of the eleven 2026-10-01 divergences was
diagnosed. dispatcher-parity.py reports DRIFT; this shows you WHAT drifted.

USAGE:
  python tools/dispatcher-show.py                    # the ops that historically diverged
  python tools/dispatcher-show.py click type_text    # specific ops
  python tools/dispatcher-show.py --all              # every shared op (long)
"""
import io
import os
import re
import sys

BASE = os.environ.get("WS_CS_SRC", r"E:/websense-oss/extension/cs-src")
A_FILE = "00-bridge-and-transport.js"
B_FILE = "70-capture-and-readers.js"

# The ops that have actually diverged at least once. A useful default; --all for everything.
HISTORIC = ["upload_file", "network_log", "handle_dialog", "get_status", "page_state",
            "form_state", "drag_drop", "discover_actions", "explore_page", "click", "type_many"]


def bodies(fname):
    src = io.open(os.path.join(BASE, fname), encoding="utf-8", errors="replace").read()
    out = {}
    for m in re.finditer(r"case '([a-z_0-9]+)':(.*?)(?=\n\s*case '|\n\s*default:)", src, re.S):
        out[m.group(1)] = m.group(2).strip()
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    A, B = bodies(A_FILE), bodies(B_FILE)
    shared = sorted(set(A).intersection(B))

    if "--all" in sys.argv:
        ops = shared
    elif args:
        ops = args
    else:
        ops = [o for o in HISTORIC if o in A and o in B]

    print("shared ops: %d | showing: %d\n" % (len(shared), len(ops)))
    for op in ops:
        if op not in A or op not in B:
            print("=" * 96)
            print("OP: %s  -- present in only ONE dispatcher (%s)" % (
                op, "A/00" if op in A else "B/70"))
            continue
        print("=" * 96)
        print("OP: %s" % op)
        print("--- A (00, direct WS) ---")
        print("  " + A[op].replace("\n", "\n  ")[:900])
        print("--- B (70, offscreen relay) ---")
        print("  " + B[op].replace("\n", "\n  ")[:900])
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
