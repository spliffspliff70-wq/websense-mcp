#!/usr/bin/env node
/**
 * why-no-collapse — print the exact key regionTree compares for the region children of a
 * given region, so a failed collapse is explainable rather than guessed.
 *
 * The key is: shapeOf(child) + \0 + nameOf(child)
 *   shapeOf = tag | which name-kinds it carries | the tags of its region children
 *   nameOf  = the page's own word for it, or ''
 *
 * Usage: node tools/why-no-collapse.mjs <dump.json> <regionIndexOr-1>
 */
import { readFileSync } from 'node:fs';
import { regionTree } from '../src/snapshot.js';

const d = JSON.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')).result);
const els = d.elements;
const r = regionTree({ elements: els }, { debug: true });
const dbg = r.debug;
const byI = new Map(dbg.map((x) => [x.i, x]));

const kids = els.map(() => []);
els.forEach((e, i) => { if (e && e.p != null && kids[e.p]) kids[e.p].push(i); });

// region children, exactly as regionTree builds them (nearest region ancestor)
const regionChild = els.map(() => []);
els.forEach((e, i) => {
  if (!byI.get(i)?.region) return;
  let p = e.p, hops = 0;
  while (p != null && hops < 400) { if (byI.get(p)?.region) { regionChild[p].push(i); break; } p = els[p].p; hops++; }
});

const kindsOf = (i) => {
  const a = els[i].attrs || {};
  if (a.role) return 'role';
  if (a['aria-label']) return 'aria';
  if (a.id) return 'id';
  if (a.class) return 'class';
  return 'data';
};
const shapeOf = (i) => els[i].tag + '|' + kindsOf(i) + '|' + regionChild[i].map((c) => els[c].tag).join(',');

// find the region whose outline line mentions "Home timeline" or the timeline section
let target = Number(process.argv[3]);
if (!Number.isFinite(target) || target < 0) {
  target = dbg.find((x) => x.region && /Your Home Timeline/.test(x.name))?.i
        ?? dbg.find((x) => x.region && regionChild[x.i].length > 5)?.i;
}
const t = byI.get(target);
console.log(`region #${target}  <${els[target].tag}>  name=${JSON.stringify(t?.name)}  regionChildren=${regionChild[target].length}\n`);
const rc = regionChild[target];
const keys = new Map();
rc.slice(0, 40).forEach((c, idx) => {
  const k = shapeOf(c) + '\u0000' + (byI.get(c)?.name || '');
  if (!keys.has(k)) keys.set(k, []);
  keys.get(k).push(idx);
  console.log(`  [${String(idx).padStart(2)}] #${String(c).padStart(5)} shape=${shapeOf(c).padEnd(34)} name=${JSON.stringify(byI.get(c)?.name || '').slice(0, 46)}`);
});
console.log(`\n${rc.length} children → ${keys.size} distinct keys:`);
[...keys.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([k, v]) => {
  console.log(`  x${String(v.length).padStart(2)}  ${k.replace('\u0000', '  ::  ').slice(0, 120)}`);
});
