#!/usr/bin/env python
"""diff-groups.py — measure the size of each group in a live auto-DIFF block.

MERGED 2026-10-01 from count-diff.py + measure-diff.py, which did the same job.

WHY THIS EXISTS: the diff's SIZE was the whole problem. Measuring it by group is how the
real figures were found instead of guessed —
  - structure.changed  609 entries / 98,441 chars  (repaint churn, before the visual group)
  - content            227,703 chars of ONE <script> tag's text (194,305 chars)
  - viewport           230,879-300,769 chars enumerating 1,782-2,525 moved elements
After the fixes the same page reads: content ~700 chars, viewport ONE line, whole diff inline.

USAGE:
  python tools/diff-groups.py <path-to-a-persisted-tool-result>
  python tools/diff-groups.py <path> --raw       # the file IS the diff block, not a wrapped result

The tool result wraps the DIFF block in a JSON string, so quotes arrive ESCAPED (\\") —
this unescapes before matching, which is the bug the first version of this script hit.
"""
import io
import sys


def unescape(t):
    return t.replace('\\"', '"').replace('\\n', '\n')


def region(text, key):
    """Bracket-match the value of "key": {...} so nested objects do not truncate it."""
    k = text.find('"%s":' % key)
    if k < 0:
        return None
    s = text.find("{", k)
    if s < 0:
        return None
    depth = 0
    instr = False
    esc = False
    for j in range(s, len(text)):
        c = text[j]
        if instr:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                instr = False
            continue
        if c == '"':
            instr = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[s:j + 1]
    return None


def longest_string(body):
    longest = 0
    i = 0
    while True:
        a = body.find('"', i)
        if a < 0:
            break
        b = body.find('"', a + 1)
        if b < 0:
            break
        longest = max(longest, b - a)
        i = b + 1
    return longest


def main():
    if len(sys.argv) < 2 or "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return 0
    path = sys.argv[1]
    raw = io.open(path, encoding="utf-8", errors="replace").read()

    if "--raw" in sys.argv:
        tail = raw
    else:
        m = raw.find("DIFF (auto, after ")
        if m < 0:
            print("no DIFF block found in %s" % path)
            print("(if this file IS the diff block, re-run with --raw)")
            return 1
        tail = unescape(raw[m:])

    total = len(raw)
    print("tool result chars: %d" % total)
    print("DIFF block chars : %d%s" % (
        len(tail), "   <-- INLINE (usable)" if total < 100000 else "   <-- PERSISTED (evicted from context)"))
    print()

    grand = 0
    for key in ("structure", "content", "visual", "viewport"):
        body = region(tail, key)
        if body is None:
            print("  %-9s absent" % key)
            continue
        n = body.count('{"i":')
        grand += len(body)
        print("  %-9s chars=%-7d entries=%-5d longest string=%d" % (
            key, len(body), n, longest_string(body)))
        if key in ("structure", "content", "visual"):
            # For a plain index list (added), count integers instead of objects.
            if n == 0:
                lst = region(tail, key)
                n_int = lst.count(",") if lst else 0
                print("            (index list: ~%d integers, no per-element objects)" % n_int)
            else:
                print("            avg %.0f chars/entry" % (len(body) / n))
    print()
    print("  groups total: %d chars" % grand)
    return 0


if __name__ == "__main__":
    sys.exit(main())
