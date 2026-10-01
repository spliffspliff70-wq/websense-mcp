import io, re

p = r"C:/Users/Ali/AppData/Local/hermes/cache/terminal/hermes-results/call_00_ET_aTuGuO4AOuSLtwM1WBoX1983.txt"
raw = io.open(p, encoding="utf-8", errors="replace").read()
print("total tool result chars:", len(raw))

m = raw.find("DIFF (auto, after scroll): ")
if m < 0:
    print("no DIFF marker"); raise SystemExit(0)
tail = raw[m:]
# The DIFF block sits inside the tool result wrapper, so its quotes are ESCAPED.
tail = tail.replace('\\"', '"')

def region(text, key):
    """Return the char length of the value of "key":{...} by bracket matching."""
    k = text.find('"%s":' % key)
    if k < 0:
        return None, None
    s = text.find("{", k)
    if s < 0:
        return None, None
    d = 0
    instr = False
    esc = False
    for j in range(s, len(text)):
        c = text[j]
        if instr:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': instr = False
            continue
        if c == '"': instr = True
        elif c == "{": d += 1
        elif c == "}":
            d -= 1
            if d == 0:
                return j + 1 - s, text[s:j + 1]
    return None, None

tot = 0
for key in ("structure", "content", "viewport"):
    n, body = region(tail, key)
    if n is None:
        print(" %-9s NOT FOUND" % key); continue
    tot += n
    print(" %-9s chars=%d" % (key, n))
    if body:
        # count the list items in each sub-key by counting elements crudely
        for sub in ("added", "removed", "changed", "moved"):
            sk = body.find('"%s":' % sub)
            if sk < 0: continue
            ss = body.find("[", sk)
            se = body.find("]", ss)
            # first 120 chars of the sub-array tells us the shape
            print("      %-8s starts: %s" % (sub, body[ss:ss + 110].replace("\n", " ")))
print(" sum of the three groups:", tot)
