"""find-missing-tabid.py — which hub send() calls drop the caller's tabId?

★ THE THREE-LAYER BUG (found 2026-10-01 by running a task on the workbench):
   1. schema     — tabId not declared -> zod strips it (fixed for 19 tools)
   2. handler    — the tool handler does not pass `tabId: o.tabId` into send()  <-- THIS
   3. routing    — withSessionTab only stamps when cmd.tabId is ABSENT (already correct)
Any of the three being broken makes the caller's tab choice silently inert, and the op lands
on the session's tab — reporting a result for a page the caller never named.

This lists every `send({ type: ... })` literal that has a `tabId` available in scope (the
handler param is `o`) but does not forward it.
"""
import io
import re

src = io.open("src/server.js", encoding="utf-8", errors="replace").read()

# All send({ ... }) object literals, brace-balanced.
calls = []
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
    body = src[i:j + 1]
    line = src[:m.start()].count("\n") + 1
    calls.append((line, body))

print("send() object literals found: %d\n" % len(calls))

missing = []
for line, body in calls:
    if not re.search(r"type:\s*'([a-z_0-9]+)'", body):
        continue
    op = re.search(r"type:\s*'([a-z_0-9]+)'", body).group(1)
    has = re.search(r"\btabId\b", body) is not None
    if not has:
        # does the surrounding handler have `o` in scope? look back ~600 chars
        start = max(0, src.find(body) - 800)
        scope = src[start:src.find(body)]
        uses_o = re.search(r"async \(o\)", scope) is not None
        missing.append((line, op, uses_o))

print("%-6s %-22s %s" % ("line", "op", "handler has `o` in scope (so tabId was available)"))
for line, op, uses_o in missing:
    print("%-6d %-22s %s" % (line, op, "YES  <-- DROPS IT" if uses_o else "no"))
print()
print("total send() calls that never forward tabId: %d" % len(missing))
