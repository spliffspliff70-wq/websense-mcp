#!/usr/bin/env node
/**
 * precheck-backticks — runs BEFORE test-regressions.mjs, because the in-suite guard cannot
 * save us on its own: test-regressions.mjs imports the collectors, so a stray backtick makes
 * the module fail to PARSE and the whole suite dies before any guard can report anything.
 *
 * A backtick inside a collector template literal closes the literal early and the module never
 * loads. This has now happened seven times, and the seventh cost a full debug cycle because the
 * symptom (SyntaxError at import) looks nothing like the cause (a comment I had just written).
 *
 * The scan is precise: it isolates the TEMPLATE BODY between the opening delimiter and the
 * first closing one, and looks for a backtick strictly inside it. Comments and delimiters
 * elsewhere in the file are irrelevant and must not be flagged.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0, checked = 0;

for (const dir of ['src']) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const path = join(dir, f);
    const src = readFileSync(path, 'utf8');
    const re = /export const \w+ = `([\s\S]*?)`;/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      checked++;
      const body = m[1];
      const i = body.indexOf('`');
      if (i === -1) continue;
      const line = src.slice(0, m.index + m[0].indexOf('`') + 1 + i).split('\n').length;
      console.error(`${path}:${line}: BACKTICK inside a collector template body -> the module will not parse`);
      console.error('  ' + body.slice(Math.max(0, i - 40), i + 40).replace(/\n/g, ' '));
      bad++;
    }
  }
}

if (bad) {
  console.error(`\n${bad} stray backtick(s). Use double quotes inside collector bodies and their comments.`);
  process.exit(1);
}
console.log(`precheck: ${checked} collector template(s) scanned, backtick-clean`);
