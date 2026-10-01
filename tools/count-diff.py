import io, sys

p = sys.argv[1]
raw = io.open(p, encoding="utf-8", errors="replace").read()
m = raw.find("DIFF (auto, after ")
tail = raw[m:].replace('\\"', '"')

def region(text, key):
    k = text.find('"%s":' % key)
    if k < 0: return None
    s = text.find("{", k)
    d = 0; instr = False; esc = False
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
            if d == 0: return text[s:j+1]
    return None

print("total tool result chars:", len(raw))
for key in ("structure", "content", "visual", "viewport"):
    body = region(tail, key)
    if body is None:
        print(" %-9s ABSENT" % key); continue
    n_items = body.count('{"i":')
    print(" %-9s chars=%-8d  entries=%d" % (key, len(body), n_items))
    if n_items and key in ("structure", "content", "visual"):
        print("            avg chars/entry=%.0f" % (len(body) / max(1, n_items)))
    # how much of it is a single long locator? find the longest quoted string
    longest = 0
    i = 0
    while True:
        a = body.find('"', i)
        if a < 0: break
        b = body.find('"', a + 1)
        if b < 0: break
        if b - a > longest: longest = b - a
        i = b + 1
    print("            longest single string in it: %d chars" % longest)
