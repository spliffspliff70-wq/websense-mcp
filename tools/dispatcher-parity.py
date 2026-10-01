import io, os, re, sys

BASE = os.environ.get("WS_CS_SRC", r"E:/websense-oss/extension/cs-src")

# Ops where a divergence between the two FILES is known and intentional, with the reason.
# After the 2026-10-01b unification the relay declares NO page-op cases at all — it delegates
# every page op to wsDispatchPage() in 00 — so in practice this map is now EMPTY: any
# duplicated op must agree, full stop. It is kept as a safety valve, not a general escape.
INTENTIONAL = {}


def case_bodies(path):
    s = io.open(os.path.join(BASE, path), encoding="utf-8", errors="replace").read()
    out = {}
    for m in re.finditer(r"case '([a-z_0-9]+)':(.*?)(?=\n\s*case '|\n\s*default:)", s, re.S):
        out[m.group(1)] = m.group(2)
    return out


# Which async/native helpers an op calls, and which params it reads. Statement form
# (return X vs result = X; break;) is deliberately ignored — that is not a behaviour.
HELPER = re.compile(r"\b(native[A-Z]\w*|extractActionGraph|exploreIncremental|resolveRefHealed|getQuickState|getPageState|readContent|preloadPage|scrollAndExtract|readMainWorldDialogs|WS_DIALOGS|detectEditor)\b")
PARAM = re.compile(r"params\.(\w+)")


def semantics(body):
    body = re.sub(r"//[^\n]*", "", body)
    return (tuple(sorted(set(HELPER.findall(body)))), tuple(sorted(set(PARAM.findall(body)))))


A = case_bodies("00-bridge-and-transport.js")
B = case_bodies("70-capture-and-readers.js")
shared = sorted(set(A).intersection(B))

print("A (00, direct WS) case labels     :", len(A))
print("B (70, offscreen relay) case labels:", len(B), "->", ", ".join(sorted(B)) or "(none)")
print("duplicated ops:", len(shared))

if not shared:
    # The structural invariant the unification established: ONE implementation per op.
    bsrcc = io.open(os.path.join(BASE, "70-capture-and-readers.js"), encoding="utf-8", errors="replace").read()
    if re.search(r"result\s*=\s*await\s+wsDispatchPage\(message,\s*\{\s*sender:\s*sender\s*\}\)", bsrcc):
        print("\nOK — ZERO duplicated ops: the relay path DELEGATES every page op to the one")
        print("     dispatcher (wsDispatchPage in 00), keeping only its tab-relay cases.")
    else:
        print("\n!!! ZERO duplicated ops but NO delegation call found in 70 — the relay may have")
        print("    silently dropped the page ops instead of delegating them.")
        sys.exit(1)
    sys.exit(0)

bad = []
checked = 0
for op in shared:
    if op in INTENTIONAL:
        continue
    checked += 1
    sa, sb = semantics(A[op]), semantics(B[op])
    if sa != sb:
        bad.append((op, sa, sb))

print("checked: %d | intentional divergences skipped: %d" % (checked, len(INTENTIONAL)))
if bad:
    print("\n!!! SEMANTIC DIVERGENCES REMAIN !!!")
    for op, a, b in bad:
        print("  %s\n     A: %s\n     B: %s" % (op, a, b))
    sys.exit(1)
print("\nOK — every non-intentional duplicated op agrees on helpers + params.")
for op, why in INTENTIONAL.items():
    print("  %-14s intentional: %s" % (op, why))
