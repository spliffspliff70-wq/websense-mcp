import io, os, re, sys

BASE = os.environ.get("WS_CS_SRC", r"E:/websense-oss/extension/cs-src")

# Ops where a divergence is KNOWN AND INTENTIONAL, with the reason. Everything else in the
# duplicated set must agree semantically, or the two dispatchers are two behaviours.
INTENTIONAL = {
    "page_state": "both read the SAME canonical getPageState(); the relay copy adds two "
                  "fields only it can know (answerTabId/answerFrameId from the sender)",
    "explore_page": "same extractActionGraph call; the relay copy wraps it in try/catch to "
                    "return a structured failure instead of throwing",
}

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

def call_args(body):
    """The option keys passed to the primary call, if it is an object literal."""
    body = re.sub(r"//[^\n]*", "", body)
    keys = set()
    for m in re.finditer(r"\{([^{}]*)\}", body):
        for k in re.findall(r"(\w+)\s*:", m.group(1)):
            keys.add(k)
    return tuple(sorted(keys))

A = case_bodies("00-bridge-and-transport.js")
B = case_bodies("70-capture-and-readers.js")
shared = sorted(set(A).intersection(B))

bad = []
checked = 0
for op in shared:
    if op in INTENTIONAL:
        continue
    checked += 1
    sa, sb = semantics(A[op]), semantics(B[op])
    if sa != sb:
        bad.append((op, "helpers/params", sa, sb))

print("duplicated ops: %d | checked: %d | intentional divergences skipped: %d"
      % (len(shared), checked, len(INTENTIONAL)))
if bad:
    print("\n!!! SEMANTIC DIVERGENCES REMAIN !!!")
    for op, what, a, b in bad:
        print("  %s (%s)\n     A: %s\n     B: %s" % (op, what, a, b))
    sys.exit(1)
print("\nOK — every non-intentional duplicated op agrees on helpers + params.")
for op, why in INTENTIONAL.items():
    print("  %-14s intentional: %s" % (op, why))
