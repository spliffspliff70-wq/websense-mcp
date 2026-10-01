"""add-tabid.py — declare `tabId` on every page-op tool schema.

★ WHY (2026-10-01, found by running a real task on the workbench):
  type_text{ref:'#txt', tabId:328034510} returned "Element not found" and its auto-DIFF came
  back for https://x.com/cryptodreki with 2,660 elements — a DIFFERENT TAB. The tabId param
  was never declared in type_text's inputSchema, so zod stripped it before the handler ran,
  the handler fell back to sessionTabOf(), and the op silently acted on the session's tab.
  A parameter the docs tell you to pass, that the tool accepts without complaint, and that
  does nothing, is worse than no parameter: it makes every page op land somewhere you did not
  choose and report a result you cannot attribute.

Measured with tools/tabid-audit.py: 33 tools, 9 declared tabId, and the page ops below did not.

This edits src/server.js in place: after each named tool's `inputSchema: {`, it inserts the
same field the other tools use. Idempotent — running twice changes nothing.
"""
import io
import re
import shutil
import sys

PATH = "src/server.js"
FIELD = "      tabId: z.number().optional().describe('Target tab (default: session-bound tab)'),\n"

# Page ops the model addresses by tabId. NOT here: websense_guide (no page),
# extension_reload / respawn_offscreen (browser-level, not page), navigate (declares its own).
TARGETS = [
    "click", "type_text", "form", "read", "reveal", "scroll", "press_key", "inspect",
    "wait", "dialog", "screenshot", "network_log", "console_log", "cookies", "clipboard",
    "real_paste", "real_click", "real_activate_tab", "status", "upload",
]

src = io.open(PATH, encoding="utf-8", errors="replace").read()
orig = src

added, already, notfound = [], [], []

for name in TARGETS:
    m = re.search(r"reg\(server,\s*'%s'" % re.escape(name), src)
    if not m:
        notfound.append(name)
        continue
    # find this tool's inputSchema opening brace, within the call
    seg_start = m.end()
    is_m = re.compile(r"inputSchema:\s*\{").search(src, seg_start, seg_start + 20000)
    if not is_m:
        notfound.append(name)
        continue
    # if tabId already appears before the schema closes, skip
    depth = 1
    i = is_m.end()
    while i < len(src) and depth > 0:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    block = src[is_m.end():i]
    if re.search(r"\btabId\s*:", block):
        already.append(name)
        continue
    insert_at = is_m.end()
    src = src[:insert_at] + "\n" + FIELD.rstrip("\n") + src[insert_at:]
    added.append(name)

if src != orig:
    shutil.copyfile(PATH, PATH + ".bak-tabid")
    io.open(PATH, "w", encoding="utf-8", newline="\n").write(src)

print("added tabId to %d tools: %s" % (len(added), ", ".join(added)))
print("already declared (%d): %s" % (len(already), ", ".join(already)))
if notfound:
    print("NOT FOUND (%d): %s" % (len(notfound), ", ".join(notfound)))
sys.exit(0)
