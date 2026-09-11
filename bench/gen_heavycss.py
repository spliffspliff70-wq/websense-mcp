"""Generate a page with MANY elements and a HEAVY stylesheet.

Rationale: getComputedStyle cost depends on selector matching against the
page's CSS, not just element count. The synthetic pages shipped so far are
plain HTML with almost no CSS, so they massively UNDERSTATE real-page cost.
This one simulates a real page: ~1,400 elements and thousands of CSS rules,
which is the regime where the cursor sweep (getComputedStyle per element)
gets expensive — and it sits JUST UNDER the 1,800-element skip threshold,
so the sweep still runs.

Writes bench/pages/heavycss.html
"""

import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pages", "heavycss.html")

N_DIVS = 480           # each div contains a span -> ~960 elements
N_LINKS = 140          # interactive, all below the fold (so geometry stays cheap)
N_RULES = 3000         # CSS rules to make style matching expensive

rules = []
for i in range(N_RULES):
    rules.append(
        f".r{i} .child-{i % 37} > span[data-k='{i % 53}']:not(.x{i % 11}) "
        f"{{ color: #{(i*7919) % 0xFFFFFF:06x}; margin-left: {i % 7}px; "
        f"padding: {i % 5}px; transition: all {i % 3}ms linear; }}"
    )
css = "\n".join(rules)

divs = "\n".join(f'<div class="r{i % N_RULES}"><span class="child-{i % 37}" data-k="{i % 53}">d{i}</span></div>'
                 for i in range(N_DIVS))
links = "\n".join(f'<a class="r{i % N_RULES}" href="#l{i}">link {i}</a>' for i in range(N_LINKS))

html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>heavy css probe</title>
<style>
{css}
body {{ font-family: sans-serif; }}
#pad {{ height: 3000px; }}
</style></head>
<body>
<h1>heavy stylesheet probe</h1>
<div id="pad"></div>
{links}
{divs}
</body></html>
"""

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

total_els = 1 + 1 + 1 + N_DIVS + 2 * N_DIVS + N_LINKS + 2  # rough
print(f"wrote {OUT}")
print(f"  css rules   : {N_RULES}")
print(f"  divs        : {N_DIVS}")
print(f"  links       : {N_LINKS} (below the fold)")
print(f"  ~elements   : {total_els}  (skip threshold is 1800)")
print(f"  bytes       : {len(html):,}")
