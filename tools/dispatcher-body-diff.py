import re, io, os

base = r"E:/websense-oss/extension/cs-src"

def body(path, op):
    """Extract the handler text for a case label, up to the next case."""
    s = io.open(os.path.join(base, path), encoding="utf-8", errors="replace").read()
    m = re.search(r"case '%s':(.*?)(?=\n\s*case '|\n\s*default:)" % re.escape(op), s, re.S)
    return m.group(1) if m else None

def norm(t):
    if t is None: return None
    t = re.sub(r"//[^\n]*", "", t)          # comments
    t = re.sub(r"\s+", " ", t)              # whitespace
    t = t.replace("result =", "R=").replace("result=", "R=")
    t = re.sub(r"break;", "", t)
    return t.strip()

ops = ["click", "type_text", "press_key", "scroll", "explore_page", "evaluate", "page_state", "upload_file"]
print("=== do the TWO copies of each duplicated op still DISAGREE? ===\n")
same = diff = missing = 0
for op in ops:
    a, b = norm(body("00-bridge-and-transport.js", op)), norm(body("70-capture-and-readers.js", op))
    if a is None or b is None:
        print("  %-14s MISSING in %s" % (op, "00" if a is None else "70")); missing += 1; continue
    if a == b:
        print("  %-14s IDENTICAL (%d chars)" % (op, len(a))); same += 1
    else:
        # find the first point of divergence for a useful report
        n = min(len(a), len(b)); i = 0
        while i < n and a[i] == b[i]: i += 1
        print("  %-14s *** DIFFERENT ***  A=%d chars  B=%d chars" % (op, len(a), len(b)))
        print("       A: ...%s" % a[max(0,i-40):i+90].replace("\n", " "))
        print("       B: ...%s" % b[max(0,i-40):i+90].replace("\n", " "))
        diff += 1
print("\n  identical=%d  different=%d  missing=%d" % (same, diff, missing))
