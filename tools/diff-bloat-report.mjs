#!/usr/bin/env node
/**
 * diff-bloat-report — where the bytes in a real auto-DIFF actually go.
 *
 * Ali asked "about the dif bloat". This reads the 388KB result of a real type_text on x.com
 * (saved to disk by the client because it blew the inline budget) and breaks it down by group,
 * by entry, and by KEY inside the entries — so the answer is where the bytes are, not a guess.
 */
import { readFileSync } from 'fs';

const F = process.argv[2];
const raw = readFileSync(F, 'utf8');

// The client saved {"result":"<the tool JSON, WITH the DIFF line embedded and escaped>"}.
// So the DIFF line lives INSIDE an escaped string — unescape via JSON.parse first, or the
// regex matches escaped text and JSON.parse then throws a 388KB error message.
let text = raw;
try {
  const env = JSON.parse(raw);
  if (env && typeof env.result === 'string') text = env.result;
} catch { /* not an envelope — work on the raw text */ }

const i = text.indexOf('DIFF (auto, after ');
const envelope = i > 0 ? text.slice(0, i) : text;
const diffText = i > 0 ? text.slice(i) : '';

const kB = (n) => (n / 1024).toFixed(1) + ' KB';

console.log('=== THE RESULT AS THE CLIENT RECEIVED IT ===');
console.log('  total                     ' + kB(raw.length));
console.log('  the tool payload (before the DIFF line)  ' + kB(envelope.length));
console.log('  the DIFF line appended by the wrapper    ' + kB(diffText.length));
console.log('  → the DIFF is ' + (100 * diffText.length / raw.length).toFixed(1) + '% of everything');

// Pull the diff JSON out of its line.
const m = diffText.match(/^DIFF \(auto, after [^)]+\):\s*(\{[\s\S]*)$/);
if (!m) { console.log('\n(no diff JSON found in that file)'); process.exit(0); }
let diff;
try { diff = JSON.parse(m[1].trim()); } catch (e) {
  // Never print the input in the failure — it is hundreds of KB.
  const cut = m[1].lastIndexOf('}');
  try { diff = JSON.parse(m[1].slice(0, cut + 1)); }
  catch { console.log('\n(could not parse the diff JSON: ' + e.message.slice(0, 80) + ')'); process.exit(0); }
}

console.log('\n=== THE DIFF, GROUP BY GROUP ===');
const rows = [];
for (const g of ['structure', 'content', 'visual', 'viewport']) {
  const v = diff[g];
  if (!v) { rows.push([g, 'absent', '', '']); continue; }
  const bytes = JSON.stringify(v).length;
  const parts = [];
  for (const k of ['added', 'removed', 'changed', 'moved', 'count']) {
    if (v[k] === undefined) continue;
    const val = v[k];
    parts.push(k + '=' + (Array.isArray(val) ? val.length : JSON.stringify(val)));
  }
  rows.push([g, bytes, parts.join(' '), v.count === undefined ? '' : ('count=' + v.count)]);
}
for (const [g, bytes, parts] of rows) {
  console.log('  ' + String(g).padEnd(10) + String(bytes === '' ? '' : kB(bytes)).padStart(10) + '   ' + parts);
}
console.log('  repeat-meta  ' + kB(JSON.stringify(diff).length) + ' total in the diff object');

// What actually costs the bytes: the biggest single entries.
console.log('\n=== THE BIGGEST ENTRIES IN THE DIFF ===');
const flat = [];
for (const g of ['structure', 'content', 'visual', 'viewport']) {
  const v = diff[g];
  if (!v) continue;
  for (const k of ['added', 'removed', 'changed', 'moved']) {
    if (!Array.isArray(v[k])) continue;
    v[k].forEach((entry, idx) => flat.push({ g, k, idx, entry, bytes: JSON.stringify(entry).length }));
  }
}
flat.sort((a, b) => b.bytes - a.bytes);
for (const f of flat.slice(0, 5)) {
  console.log('  ' + kB(f.bytes).padStart(9) + '  ' + f.g + '.' + f.k + '[' + f.idx + ']  ' +
    JSON.stringify(f.entry).slice(0, 150));
}
console.log('  entries listed: ' + flat.length);

// Which KEYS inside the entries carry the weight? That is what a fix has to address.
console.log('\n=== WHERE THE BYTES ARE, BY FIELD NAME ===');
const byKey = new Map();
const add = (k, n) => byKey.set(k, (byKey.get(k) || 0) + n);
const walk = (v, path) => {
  if (v === null || v === undefined) return;
  if (typeof v === 'string') { add('(a string value: ' + path.split('.').slice(-1)[0] + ')', v.length + 4); return; }
  if (typeof v !== 'object') { add('(a number/bool: ' + path.split('.').slice(-1)[0] + ')', 6); return; }
  if (Array.isArray(v)) { v.forEach((x) => walk(x, path)); return; }
  for (const k of Object.keys(v)) { add(k, 6 + k.length); walk(v[k], path ? path + '.' + k : k); }
};
for (const g of ['structure', 'content', 'visual', 'viewport']) if (diff[g]) walk(diff[g], g);
[...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, n]) => console.log('  ' + kB(n).padStart(9) + '  ' + k));

// The single most bloating value type: verbatim strings (locators, names, classes).
console.log('\n=== THE STRINGS THAT DOMINATE (longest first) ===');
const strs = [];
const collect = (v) => {
  if (typeof v === 'string') { strs.push(v); return; }
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) { v.forEach(collect); return; }
  Object.values(v).forEach(collect);
};
for (const g of ['structure', 'content', 'visual', 'viewport']) if (diff[g]) collect(diff[g]);
strs.sort((a, b) => b.length - a.length);
const totalStr = strs.reduce((s, x) => s + x.length, 0);
console.log('  ' + strs.length + ' strings, ' + kB(totalStr) + ' of characters total');
console.log('  longest: ' + strs.length + ' strings; the top 10 alone are ' + kB(strs.slice(0, 10).reduce((s, x) => s + x.length, 0)));
strs.slice(0, 3).forEach((s) => console.log('    ' + s.length + ' chars: ' + JSON.stringify(s.slice(0, 90))));
