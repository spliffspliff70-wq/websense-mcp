#!/usr/bin/env node
/**
 * name-audit — of the bytes in a `regions` outline, how much is IDENTITY (a word that
 * names a place) and how much is VALUE (the page's content wearing a name)?
 *
 * Two dynamic signals, both pure tree facts — no length constant anywhere:
 *   RESTATES  — the name contains the names of >=2 of its own descendants. A label that
 *               summarizes its own children is a VALUE (x.com's engagement group ships
 *               "42 replies, 60 reposts, 455 likes, 227 bookmarks, 29750 views" directly
 *               above the four buttons that each say one of those numbers again).
 *   VARIES    — the same attribute slot at the same position shape holds a DIFFERENT value
 *               on every occurrence: a per-instance value, not a name for a place.
 *
 * Usage: node tools/name-audit.mjs <dump.json>
 */
import { readFileSync } from 'node:fs';
import { regionTree } from '../src/snapshot.js';

const d = JSON.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')).result);
const els = d.elements;
const B = (s) => Buffer.byteLength(s, 'utf8');

const r = regionTree({ elements: els }, { debug: true });
const dbg = r.debug;
const byI = new Map(dbg.map((x) => [x.i, x]));

// kids
const kids = els.map(() => []);
els.forEach((e, i) => { if (e && e.p != null && kids[e.p]) kids[e.p].push(i); });

// descendants (skip large subtrees for speed)
const descNames = (i) => {
  const out = [];
  const stack = [...kids[i]];
  let guard = 0;
  while (stack.length && guard++ < 4000) {
    const j = stack.pop();
    const n = byI.get(j)?.name;
    if (n) out.push(n);
    for (const c of kids[j]) stack.push(c);
  }
  return out;
};

const named = dbg.filter((x) => x.name && (x.place || x.region));
let totB = 0, restB = 0, varyB = 0;
const restList = [], varyList = [];
const slotKey = (x) => (x.src || '?');
// VARIES: same src + same tag holding many distinct names
const slot = new Map();
for (const x of named) {
  const k = slotKey(x) + '|' + x.tag;
  if (!slot.has(k)) slot.set(k, new Set());
  slot.get(k).add(x.name);
}
for (const x of named) {
  const b = B(x.name) + 1;
  totB += b;
  const dn = descNames(x.i);
  // a name is restating when >=2 of its own descendants' names are contained in it
  const contained = dn.filter((n) => n.length > 2 && x.name.indexOf(n) >= 0).length;
  const restates = contained >= 2;
  const vs = slot.get(slotKey(x) + '|' + x.tag);
  const varies = vs && vs.size > 1 && vs.size === new Set(named.filter((y) => slotKey(y) === slotKey(x) && y.tag === x.tag).map((y) => y.name)).size && vs.size >= 3;
  if (restates) { restB += b; restList.push({ b, name: x.name, i: x.i, src: x.src, contained }); }
  else if (varies) { varyB += b; varyList.push({ b, name: x.name, i: x.i, src: x.src, distinct: vs.size }); }
}

const outlineB = B(r.outline);
console.log(`${d.url}`);
console.log(`outline ${outlineB} B (${(outlineB / 1024).toFixed(1)} kB) | named places ${named.length} | name bytes ${totB} B`);
console.log(`  RESTATES its own descendants : ${restB} B  (${restB / outlineB * 100 | 0}% of outline)`);
console.log(`  VARIES per instance (a value) : ${varyB} B  (${varyB / outlineB * 100 | 0}% of outline)`);
console.log(`  → value-like total             : ${restB + varyB} B  (${(restB + varyB) / outlineB * 100 | 0}% of outline)`);

const top = (arr, t) => { console.log(`\nTOP ${t}:`); arr.sort((a, b) => b.b - a.b).slice(0, 8).forEach((x) => console.log(`  ${String(x.b).padStart(5)} B #${x.i} ${x.src} ${JSON.stringify(x.name).slice(0, 130)}`)); };
top(restList, 'RESTATES');
top(varyList, 'VARIES');
