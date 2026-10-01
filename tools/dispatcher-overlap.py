import re, io, os

base = r"E:/websense-oss/extension/cs-src"

def cases(p):
    s = io.open(os.path.join(base, p), encoding="utf-8", errors="replace").read()
    return set(re.findall(r"case '([a-z_0-9]+)'", s))

a = cases("00-bridge-and-transport.js")   # direct WS dispatcher
b = cases("70-capture-and-readers.js")    # offscreen relay dispatcher

print("path A (00, direct WS)     cases:", len(a))
print("path B (70, offscreen relay) cases:", len(b))

both = sorted(a.intersection(b))
print()
print("IN BOTH -> the duplication risk (mem 994):", len(both))
for i in range(0, len(both), 6):
    print("   " + ", ".join(both[i:i+6]))

print()
print("only in A (%d): %s" % (len(a.difference(b)), ", ".join(sorted(a.difference(b)))))
print()
print("only in B (%d): %s" % (len(b.difference(a)), ", ".join(sorted(b.difference(a)))))

print()
print("=== the ops an agent actually uses ===")
for op in ["explore_page", "evaluate", "click", "type_text", "press_key", "scroll",
           "read", "page_state", "form", "upload_file", "main_world_exec", "main_world"]:
    where = []
    if op in a: where.append("00")
    if op in b: where.append("70")
    tag = " + ".join(where) if where else "NEITHER dispatcher (handled offscreen/background)"
    flag = "  <-- DUPLICATED" if len(where) == 2 else ""
    print("  %-16s -> %s%s" % (op, tag, flag))
