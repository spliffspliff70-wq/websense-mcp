import io, re

s = io.open("src/server.js", encoding="utf-8", errors="replace").read()


def blocks(src):
    """Yield (tool_name, full reg(...) call text) by brace-matching from each reg(server, 'x'."""
    out = []
    for m in re.finditer(r"reg\(server,\s*'([a-z_0-9]+)'", src):
        name = m.group(1)
        i = m.end()
        # walk to the end of the call: balance parens
        depth = 1
        j = i
        while j < len(src) and depth > 0:
            c = src[j]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            j += 1
        out.append((name, src[m.start():j]))
    return out


B = blocks(s)
print("registered tools found: %d\n" % len(B))

PAGE_HINT = re.compile(
    r"tabId|sessionTabOf|PAGE_OPS|page op|ref:|params\.ref|main_world_exec", re.I)

missing_decl = []
declared = []
for name, body in B:
    schema_decl = re.search(r"\btabId\s*:", body) is not None
    # does the handler look like it targets a page (vs a server/tab-level op)?
    pagey = bool(PAGE_HINT.search(body))
    if schema_decl:
        declared.append(name)
    elif pagey:
        missing_decl.append(name)

print("DECLARE tabId (%d): %s" % (len(declared), ", ".join(declared)))
print()
print("DO NOT declare tabId but look like PAGE ops (%d):" % len(missing_decl))
for n in missing_decl:
    print("   " + n)
