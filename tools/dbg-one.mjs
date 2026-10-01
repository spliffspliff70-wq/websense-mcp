import { readFileSync } from 'node:fs';
import { regionTree } from '../src/snapshot.js';

const p = process.argv[2];
const d = JSON.parse(JSON.parse(readFileSync(p, 'utf8')).result);
const r = regionTree({ elements: d.elements }, { debug: true });

// parent<child ordering is what the bottom-up passes assume
let bad = 0;
for (const e of d.elements) if (e.p != null && e.p >= e.i) bad++;
console.log('parent>=child violations:', bad);

const want = process.argv.slice(3).map(Number);
for (const i of want) {
  const e = r.debug.find((x) => x.i === i);
  const el = d.elements[i];
  console.log(`i=${i} tag=${el.tag} kids=${e.kids} name=${JSON.stringify(e.name)} src=${e.src} place=${e.place} region=${e.region}`);
  console.log(`   attrs=${JSON.stringify(Object.fromEntries(Object.entries(el.attrs || {}).filter(([k]) => k !== 'class' && k !== 'style')))}`);
}
