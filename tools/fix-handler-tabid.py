"""fix-handler-tabid.py — forward the caller's tabId in every hub send().

★ LAYER 2 OF 3 (2026-10-01). Declaring tabId in the schema is not enough: the HANDLER has to
put it on the op. type_text's schema now declares tabId, zod passes it, and the handler still
sent `{type:'type_text', ref, text, ...}` with no tabId — so withSessionTab stamped the
SESSION tab (or auto-bound one), and a task aimed at tab 510 executed against a tab opened by
ANOTHER PROCESS (the X Growth cron). The result and the auto-DIFF then describe a page the
caller never named.

Strategy: for every `.send({ type: '...' ... })` object literal, find the enclosing handler's
parameter name (the nearest `async (X) => {` above it) and inject `tabId: X.tabId` if the
literal does not already carry a tabId. Idempotent.
"""
import io
import re
import shutil

PATH = "src/server.js"
src = io.open(PATH, encoding="utf-8", errors="replace").read()
orig = src

# Collect send() literals with their positions, back to front so offsets stay valid.
literals = []
for m in re.finditer(r"\.send\(\s*\{", src):
    i = m.end() - 1
    depth = 0
    j = i
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    literals.append((i, j + 1))   # [start, end) of the literal

# Tab-level ops: they carry their own semantics and must NOT be handed a page tabId.
# This mirrors SESSION_TAB_OPS in server.js (ops that own their tabId).
TAB_LEVEL = {
    "list_tabs", "switch_tab", "close_tab", "list_frames", "download_state", "tab_contents",
    "bind_tab", "transfer_text", "switch_tab_and_read", "list_windows", "focus_window",
    "move_tab_to_window", "get_window_tabs", "get_tab_info", "get_active_tab", "cookie_op",
    "download_op", "respawn_offscreen", "extension_reload", "clear_binding",
}

injected, skipped = [], []

for start, end in reversed(literals):
    body = src[start:end]
    if not re.search(r"type:\s*'", body):
        continue
    op_m = re.search(r"type:\s*'([a-z_0-9]+)'", body)
    opname = op_m.group(1) if op_m else '?'
    if opname in TAB_LEVEL:
        skipped.append(opname + " (tab-level, deliberately left alone)")
        continue
    if re.search(r"\btabId\b", body):
        skipped.append(opname + " (already carried tabId)")
        continue
    # find the nearest enclosing handler param above this literal
    scope = src[max(0, start - 20000):start]
    params = re.findall(r"async \((\w+)\)\s*=>", scope)
    if not params:
        skipped.append(opname + " (no handler param)")
        continue
    p = params[-1]
    inner = body[1:-1].rstrip()
    if not inner.endswith(","):
        inner += ","
    new = "{" + inner + " tabId: " + p + ".tabId }"
    src = src[:start] + new + src[end:]
    injected.append("%-20s (param %s)" % (opname, p))

if src != orig:
    shutil.copyfile(PATH, PATH + ".bak-handlertabid")
    io.open(PATH, "w", encoding="utf-8", newline="\n").write(src)

print("injected tabId into %d send() calls" % len(injected))
for x in injected:
    print("   " + x)
print("\nleft as-is (already carried tabId, or not a tool send): %d" % len(skipped))
for x in skipped[:12]:
    print("   " + x)
