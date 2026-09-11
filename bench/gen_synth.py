"""Generate synthetic pages with KNOWN element counts to measure the scaling
law of explore_page's extraction (the default path walks the entire DOM).

Writes E:/local_memstore/websense/bench/pages/synth_<links>_<divs>.html
"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pages")
os.makedirs(OUT, exist_ok=True)

CASES = [
    # (links, divs, extra content chars per div)
    (50, 500, 40),
    (200, 2000, 40),
    (500, 5000, 40),
    (1000, 10000, 40),
]

TMPL = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>synth {links} links / {divs} divs</title>
<style>body{{font-family:sans-serif}} .c{{padding:2px;margin:2px;border:1px solid #eee}}</style>
</head><body>
<h1>synthetic page: {links} links, {divs} divs (total elements ~{total}</h1>
<div id="wrap">
{divs_html}
</div>
<div id="links">
{links_html}
</div>
</body></html>
"""

DIV = '<div class="c">item {i} lorem ipsum dolor sit amet consectetur adipiscing</div>'
LINK = '<a href="/link/{i}" title="link {i}">anchor text {i}</a>'


for links, divs, _ in CASES:
    divs_html = "\n".join(DIV.format(i=i) for i in range(divs))
    links_html = "\n".join(LINK.format(i=i) for i in range(links))
    total = links + divs + 6
    path = os.path.join(OUT, f"synth_{links}_{divs}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(TMPL.format(links=links, divs=divs, total=total,
                            divs_html=divs_html, links_html=links_html))
    print(f"wrote {path}  (~{total:,} elements, {links} links)")
