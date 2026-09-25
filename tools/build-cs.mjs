/**
 * Build extension/websense-cs.js from extension/cs-src/*.js
 *
 * The content script ships as ONE file (manifest.json declares a single entry), so
 * the modular sources are concatenated in filename order, wrapped in the same IIFE
 * that was used before the split. The original order is encoded in the filenames,
 * which is why they are numbered 00..80.
 *
 * Guardrail: after writing, this re-reads the file and reports whether the result
 * is deterministic. `node test-regressions.mjs` asserts the committed artifact is
 * in sync — so a hand-edit of the built file fails the suite instead of silently
 * being reverted by the next build.
 *
 * Usage:  node tools/build-cs.mjs [--check]
 *           --check : do not write; exit 1 if the artifact is out of date
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ARTIFACT = join(ROOT, 'extension', 'websense-cs.js');
const SRCDIR = join(ROOT, 'extension', 'cs-src');

// 2026-09-25: emit LF unconditionally. This builder hardcoded CRLF, so the
// artifact it produced never byte-matched a fresh build on a checkout that used
// LF — which is why the "artifact is IN SYNC" guard failed in CI on every push
// while passing on Windows. Normalize both the banner and the concatenated body
// so the output is identical on every platform.
const NL = '\n';
const BANNER = [
  '/**',
  ' * WebSense MCP \u2014 Enhanced Content Script',
  " * Runs in Chrome's isolated world (NOT subject to page CSP).",
  ' * All operations are native DOM manipulation \u2014 NO eval, NO string-to-code.',
  ' */',
].join(NL);

export function build() {
  const files = readdirSync(SRCDIR).filter(f => f.endsWith('.js')).sort();
  if (!files.length) throw new Error('no sources in ' + SRCDIR);
  // Normalize each part: the build hash and the artifact bytes must not depend
  // on whether the checkout converted line endings.
  const chunks = files.map((f) => readFileSync(join(SRCDIR, f), 'utf8').split(/\r\n|\r|\n/).join(NL));
  let body = chunks.join('');
  // BUILD STAMP (2026-09-11d). csBuild used to be a hand-written constant, so it
  // was useless for the one question that matters: "is the content script running
  // the code I just wrote?" It happily reported an unchanged string while the
  // running copy was stale. Stamp the SOURCE HASH into the artifact instead, so
  // the live csBuild names the exact build. Deterministic: the hash is taken
  // before substitution, and the placeholder is fixed-width-free.
  const stamp = 'v4.6.1-' + sha(body).slice(0, 8);
  body = body.split('__CS_BUILD__').join(stamp);
  return BANNER + NL +
    '(function () {' + NL +
    "  'use strict';" + NL +
    NL +
    body +
    '})();' + NL;
}

export function sha(s) { return createHash('sha256').update(s).digest('hex'); }

// Only run the CLI when invoked directly — test-regressions.mjs imports build()
// to assert the committed artifact is in sync, and importing must not write.
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check');
  const built = build();
  const current = readFileSync(ARTIFACT, 'utf8');

  if (checkOnly) {
    if (sha(built) === sha(current)) {
      console.log('cs-src and extension/websense-cs.js are IN SYNC (' + sha(built).slice(0, 12) + ')');
      process.exit(0);
    }
    console.error('OUT OF SYNC — built artifact differs from extension/websense-cs.js');
    console.error('  run: node tools/build-cs.mjs');
    process.exit(1);
  }

  if (sha(built) === sha(current)) {
    console.log('already up to date (' + sha(built).slice(0, 12) + ', ' + built.length + ' bytes)');
  } else {
    writeFileSync(ARTIFACT, built, 'utf8');
    console.log('built extension/websense-cs.js (' + built.length + ' bytes, sha ' + sha(built).slice(0, 12) + ')');
  }
}
