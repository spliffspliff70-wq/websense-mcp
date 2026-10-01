import io

lines = io.open("extension/websense-cs.js", encoding="utf-8", errors="replace").read().split("\n")

def depth_at(target):
    """Rough brace depth, ignoring strings/comments, up to the given 1-based line."""
    depth = 0
    for i, ln in enumerate(lines[:target - 1], start=1):
        # strip line comments and quotes crudely
        s = ln
        s = s.split("//")[0]
        s = s.replace('\\"', "").replace("\\'", "")
        in_s = None
        out = []
        for ch in s:
            if in_s:
                if ch == in_s:
                    in_s = None
                continue
            if ch in "\"'`":
                in_s = ch
                continue
            out.append(ch)
        s = "".join(out)
        depth += s.count("{") - s.count("}")
    return depth

for label, ln in [
    ("IIFE open (line 6)", 6),
    ("00 get_status call (428)", 428),
    ("00 handle_dialog call (442)", 442),
    ("70 page_state call (3875)", 3875),
    ("70 get_status call (4078)", 4078),
    ("70 handle_dialog call (4085)", 4085),
    ("DEFINITION (4117)", 4117),
    ("file end (4382)", 4382),
]:
    print("%-32s depth=%d" % (label, depth_at(ln)))

print()
print("definition indent:", repr(lines[4116][:40]))
print("70's handler indent:", repr(lines[4084][:40]))
print("00's handler indent:", repr(lines[441][:40]))
