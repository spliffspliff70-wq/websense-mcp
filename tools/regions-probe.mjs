#!/usr/bin/env node
/**
 * regions-probe — run the REAL regionTree over a saved page_slice dump and print the
 * outline + line count. No MCP round trip, so the naming rules can be iterated fast
 * against measured pages instead of guessed at.
 *
 * Usage: node tools/regions-probe.mjs <dump.txt> [--depth N] [--quiet]
 *
 * The dump is the persisted Hermes tool result: {"result": "<json string>"}.
 */
import { readFileSync } from 'node:fs';
import { regionTree } from '../src/snapshot.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const quiet = args.includes('--quiet');
const di = args.indexOf('--depth');
const opts = di !== -1 ? { depth: parseInt(args[di + 1], 10) } : {};
const si = args.indexOf('--spread');
if (si !== -1) {
  const s = args[si + 1];
  opts.spread = (s === 'inf' || s === 'none') ? Infinity : parseInt(s, 10);
}
if (args.includes('--class')) opts.className = true;
const pi = args.indexOf('--span');
if (pi !== -1) opts.span = parseInt(args[pi + 1], 10);
if (args.includes('--no-passthrough')) opts.passthrough = false;
const wantDebug = args.includes('--debug');
if (wantDebug) opts.debug = true;

if (!path) { console.error('usage: node tools/regions-probe.mjs <dump.txt>'); process.exit(2); }

const raw = JSON.parse(readFileSync(path, 'utf8'));
const d = JSON.parse(raw.result);
const snap = { elements: d.elements };

const t0 = process.hrtime.bigint();
const r = regionTree(snap, opts);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

const lines = r.outline.split('\n');
console.log(`# ${d.url}`);
console.log(`elements=${d.elements.length}  named=${r.named}  regions=${r.regions}  lines=${lines.length}  bytes=${r.outline.length}  ${ms.toFixed(1)}ms`);
console.log('-'.repeat(78));
if (!quiet) console.log(r.outline);
if (wantDebug) {
  console.log('-'.repeat(78));
  console.log('PLACES (name survives the admissibility tests):');
  for (const e of r.debug) {
    if (e.place) console.log(`  i=${String(e.i).padStart(5)}  ${e.tag.padEnd(7)} kids=${String(e.kids).padStart(3)}  ${e.src.padEnd(5)} ${e.name}${e.region ? '' : '   [leaf]'}`);
  }
  console.log('SAMPLE (indices 125..175):');
  for (const e of r.debug) if (e.i >= 125 && e.i <= 175) console.log(`  i=${String(e.i).padStart(5)}  ${e.tag.padEnd(7)} kids=${String(e.kids).padStart(3)}  ${e.src.padEnd(5)} ${e.name || '(unnamed)'}`);
}
