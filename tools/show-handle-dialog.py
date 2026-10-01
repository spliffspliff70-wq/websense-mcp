import io, os, re

BASE = r"E:/websense-oss/extension/cs-src"

def case_bodies(path):
    s = io.open(os.path.join(BASE, path), encoding="utf-8", errors="replace").read()
    out = {}
    for m in re.finditer(r"case '([a-z_0-9]+)':(.*?)(?=\n\s*case '|\n\s*default:)", s, re.S):
        out[m.group(1)] = m.group(2).strip()
    return out

A = case_bodies("00-bridge-and-transport.js")
B = case_bodies("70-capture-and-readers.js")
print("################ A (00 direct WS) — handle_dialog ################")
print(A["handle_dialog"])
print()
print("################ B (70 relay) — handle_dialog ################")
print(B["handle_dialog"])
