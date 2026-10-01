import re, io, os

base = r"E:/websense-oss/extension/cs-src"

def case_bodies(path):
    s = io.open(os.path.join(base, path), encoding="utf-8", errors="replace").read()
    # ★ STRIP COMMENTS FIRST. The fix comments NAME the code they removed ("was an inline
    # extractActionGraph({full:true}) + find"), so a raw scan counts the removed call as
    # present and reports a divergence that no longer exists. Same trap as the collector
    # backtick guard — assert against code, never against prose.
    s = re.sub(r"//[^\n]*", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    out = {}
    for m in re.finditer(r"case '([a-z_0-9]+)':(.*?)(?=\n\s*case '|\n\s*default:|\n\s*\})", s, re.S):
        out[m.group(1)] = m.group(2)
    return out

A = case_bodies("00-bridge-and-transport.js")
B = case_bodies("70-capture-and-readers.js")

# The bug class: an async helper called WITHOUT await. Ask the file which helpers are async.
def async_helpers():
    src = ""
    for f in sorted(os.listdir(base)):
        if f.endswith(".js"):
            src += io.open(os.path.join(base, f), encoding="utf-8", errors="replace").read()
    names = set()
    for m in re.finditer(r"async function (\w+)", src):
        names.add(m.group(1))
    for m in re.finditer(r"(?:const|let|var)\s+(\w+)\s*=\s*async\b", src):
        names.add(m.group(1))
    return names

ASYNC = async_helpers()
print("async helpers discovered: %d" % len(ASYNC))
print("  " + ", ".join(sorted(ASYNC))[:600])
print()

def unawaited(body, label):
    hits = []
    for name in ASYNC:
        # a call to an async helper that is NOT preceded by await/return await
        for m in re.finditer(r"(?<!await\s)(?<!await\s\s)\b%s\s*\(" % re.escape(name), body):
            start = max(0, m.start() - 14)
            ctx = body[start:m.start() + len(name) + 1]
            if "await" in ctx:
                continue
            hits.append(name)
    return sorted(set(hits))

print("=== calls to ASYNC helpers WITHOUT await ===")
for op in sorted(set(A) | set(B)):
    if op not in A or op not in B:
        continue
    ha, hb = unawaited(A[op], "A"), unawaited(B[op], "B")
    if ha or hb:
        print("  %-18s A:%s   B:%s" % (op, ha or "-", hb or "-"))
