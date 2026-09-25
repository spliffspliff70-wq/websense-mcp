#!/usr/bin/env node
// Export the live websense_guide text out of src/server.js into MODEL_PROMPT.md.
//
// MODEL_PROMPT.md used to be a HAND-MAINTAINED mirror of a 21-tool guide the
// server had already replaced. It silently kept teaching agents claims the
// running server contradicted (mutated:false = "not landed", JS dialogs
// "captured, NOT blocking", evaluate blocked only on "strict sites", escalate
// to real_click on unverifiable). A mirror nobody regenerates is a second
// source of truth that rots — the exact failure mode this removes.
//
// Usage:  node tools/export-guide.mjs          (rewrite the block)
//         node tools/export-guide.mjs --check  (exit 1 if stale; used by tests)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRV = join(root, 'src', 'server.js');
const MD = join(root, 'MODEL_PROMPT.md');

// The guide literal in src/server.js already begins with its own title line
// ("WebSense MCP — Guide (31 consolidated tools)"), so the fence adds only the
// markers. Adding a prefix here duplicated the title on every regeneration.
const START = '```\n';
const END = '\n```';

// Pull the guide literal out of the websense_guide handler. It is a plain
// template literal in a return textResult(`…`) call.
function extractGuide(src) {
  const anchor = src.indexOf("reg(server, 'websense_guide'");
  if (anchor < 0) throw new Error("websense_guide registration not found in src/server.js");
  const open = src.indexOf('`', src.indexOf('textResult(', anchor));
  if (open < 0) throw new Error('guide template literal start not found');
  // Walk to the matching unescaped backtick.
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') break;
    i += 1;
  }
  if (i >= src.length) throw new Error('unterminated guide template literal');
  return src.slice(open + 1, i);
}

// 2026-09-25: normalize EOLs before comparing or writing. This repo had no
// .gitattributes and ran with core.autocrlf=true, so on Windows the guide
// literal and MODEL_PROMPT.md were both CRLF (comparison passed) while a clean
// LF checkout produced LF — and the committed mirror was stale, failing CI with
// "MODEL_PROMPT.md is STALE". Byte-comparing platform-dependent line endings is
// the bug; compare the normalized text and always write LF.
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');

const guide = normalizeEol(extractGuide(readFileSync(SRV, 'utf8')));
const md = normalizeEol(readFileSync(MD, 'utf8'));
const force = process.argv.includes('--force');

// The guide block is the fence whose FIRST line starts with "WebSense MCP".
// Matching on the title (not a fixed offset) lets the tool survive edits to the
// surrounding prose, and gives a clear error when the fence itself is disturbed.
const fences = [...md.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)];
const block = fences.find((f) => /^\s*WebSense MCP/.test(f[1]));
if (!block) {
  if (!force) {
    console.error('MODEL_PROMPT.md no longer contains a fenced block starting with "WebSense MCP".');
    console.error('The generated block was disturbed. Repair with:  node tools/export-guide.mjs --force');
    process.exit(1);
  }
  // --force rebuilds: drop everything from the first fence on and re-emit.
  const firstFence = md.indexOf('```');
  const head = firstFence >= 0 ? md.slice(0, firstFence) : md;
  writeFileSync(MD, head + START + guide + END + '\n', 'utf8');
  console.log('MODEL_PROMPT.md guide block rebuilt from src/server.js (' + guide.length + ' chars).');
  process.exit(0);
}
const begin = block.index;
const finish = begin + block[0].length;

const current = block[1];
const desired = guide;

// Integrity of the WHOLE file, not just the fenced block: prose appended after
// the fence is drift too (an editor adding notes under a "generated" banner
// silently becomes part of the mirror nobody regenerates).
const tail = md.slice(finish);
if (/^\s*(?:-|[A-Za-z*#])/m.test(tail) && /generated|single source of truth/i.test(md)) {
  // Only flag prose that is NOT part of the documented structure below the
  // block (the old→new tool map, the closing notes), which this project keeps.
  const proseStart = tail.search(/\n(?=[-A-Za-z*#])/);
  if (proseStart >= 0) {
    const prose = tail.slice(proseStart);
    if (!/old tool|renamed|absorbed|no longer a tool|replaced by|deprecated|historical|was\b/i.test(prose)) {
      console.error('MODEL_PROMPT.md has prose after the generated block that the exporter does not manage.');
      console.error('Either fold it into src/server.js or move it above the fence.');
      if (!force) process.exit(1);
    }
  }
}

if (process.argv.includes('--check')) {
  if (current !== desired) {
    console.error('MODEL_PROMPT.md is STALE — it no longer mirrors the live guide in src/server.js.');
    console.error('Regenerate with:  node tools/export-guide.mjs');
    process.exit(1);
  }
  console.log('MODEL_PROMPT.md is in sync with the live websense_guide text.');
  process.exit(0);
}

const head = md.slice(0, begin);
const tailText = md.slice(finish);
writeFileSync(MD, head + START + desired + END + tailText, 'utf8');
console.log('MODEL_PROMPT.md rewritten from src/server.js (' + desired.length + ' chars of guide text).');
