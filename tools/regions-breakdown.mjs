#!/usr/bin/env node
/**
 * regions-breakdown — where do the bytes of a `regions` block actually go?
 * Reads a page_slice dump, runs the real regionTree, and reports totals plus the
 * longest lines and the per-top-level-branch split.
 *
 * Usage: node tools/regions-breakdown.mjs <dump.json> [--tail 6]
 */
import { readFileSync } from 'node:fs';
import { regionTree } from '../src/snapshot.js';

const path = process.argv[2];
const ti = process.argv.indexOf('--tail');
const tail = ti !== -1 ? parseInt(process.argv[ti + 1], 10) : 6;

const d = JSON.parse(JSON.parse(readFileSync(path, 'utf8')).result);
const r = regionTree({ elements: d.elements });
const L = r.outline.split('\n');

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const total = bytes(r.outline);
console.log(`${d.url}`);
console.log(`elements=${d.elements.length}  lines=${L.length}  bytes=${total}  kB=${(total / 1024).toFixed(1)}  regions=${r.regions}`);

// top-level branches (indent 0) own everything that follows them
const branches = [];
L.forEach((l, i) => {
  const indent = l.length - l.replace(/^\s+/, '').length;
  if (indent === 0 && !l.startsWith('^')) branches.push({ line: i, text: l });
});
console.log(`\nTOP-LEVEL BRANCHES (${branches.length}):`);
branches.forEach((b, k) => {
  const end = k + 1 < branches.length ? branches[k + 1].line : L.length;
  const span = L.slice(b.line, end);
  const bsum = span.reduce((a, s) => a + bytes(s) + 1, 0);
  console.log(`  ${String(bsum).padStart(6)} B  ${String(span.length).padStart(4)} lines  ${b.text.slice(0, 90)}`);
});

console.log(`\nLONGEST LINES:`);
L.map((l, i) => ({ i, n: bytes(l), l })).sort((a, b) => b.n - a.n).slice(0, tail)
  .forEach((x) => console.log(`  ${String(x.n).padStart(6)} B  #${x.i}  ${x.l.trim().slice(0, 150)}`));

console.log(`\nSPLIT BY INDENT DEPTH:`);
const byDepth = {};
L.forEach((l) => {
  const dep = (l.length - l.replace(/^\s+/, '').length) / 2;
  const key = l.startsWith('^') ? 'repeat-notes' : 'depth ' + dep;
  byDepth[key] = byDepth[key] || { n: 0, b: 0 };
  byDepth[key].n++;
  byDepth[key].b += bytes(l) + 1;
});
Object.keys(byDepth).sort().forEach((k) => {
  const v = byDepth[k];
  console.log(`  ${String(v.b).padStart(6)} B  ${String(v.n).padStart(4)} lines  ${k}`);
});
