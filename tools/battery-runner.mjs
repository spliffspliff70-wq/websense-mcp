#!/usr/bin/env node
/**
 * battery-runner — the live batteries, on a schedule, as a WATCHDOG.
 *
 * Why: the 167 unit tests cover the source, but nothing covered BEHAVIOUR ON A REAL PAGE — and every
 * real bug this month (the diff lying, shadow DOM invisible, the locator that could never resolve,
 * a click reported as a no-op) was found by a live battery and by nothing else. They were manual. A
 * manual check is a check that stops happening, so this runs them and says nothing when they pass.
 *
 * SILENCE MEANS HEALTHY: an empty stdout is the success signal (the cron is configured to deliver
 * stdout verbatim and stay quiet when there is none). Anything printed is a thing to look at.
 *
 * The stack it needs:
 *   - the WebSense server on :9222 and Chrome with the extension connected
 *   - a static server on :8099 for the repo's own fixtures (started here if it is not already up)
 */

import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REPO = 'E:/websense-oss';
const FIXTURE_PORT = 8099;
const NIGHTLY_TIMEOUT_MS = 300000;   // 5 min per battery

const stablePages = [
  'https://books.toscrape.com/',
  'https://news.ycombinator.com/',
  'https://developer.mozilla.org/en-US/',
  'https://en.wikipedia.org/wiki/Main_Page',
  'https://example.com/',
];

// x.com is deliberately NOT in the nightly set: it needs a live logged-in session, and a stale
// session would report failures that have nothing to do with the tool. Run it by hand.
const BATTERIES = [
  { name: 'bloat-fix-check',    args: ['tools/bloat-fix-check.mjs'],    fixture: true },
  { name: 'keyboard-fix-check', args: ['tools/keyboard-fix-check.mjs'], fixture: true },
  { name: 'fixture-battery',    args: ['tools/fixture-battery.mjs'],    fixture: true },
  { name: 'click-fingerprint',  args: ['tools/click-fingerprint.mjs'],  fixture: true },
  { name: 'crosstab-check',     args: ['tools/crosstab-check.mjs'],     fixture: false },
  { name: 'realpage-key-check', args: ['tools/realpage-key-check.mjs'], fixture: false },
  { name: 'task-battery',       args: ['tools/task-battery.mjs'],       fixture: false },
  { name: 'task-sweep',         args: ['tools/task-sweep.mjs', ...stablePages], fixture: false },
];

const failures = [];
const notes = [];

// --only <name>[,<name>] runs a subset — for iterating on one battery without paying for eight, and
// for running a single one by hand when the report names it.
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 && process.argv[onlyArg + 1]
  ? String(process.argv[onlyArg + 1]).split(',').map((s) => s.trim())
  : null;
const selected = only ? BATTERIES.filter((b) => only.indexOf(b.name) >= 0) : BATTERIES;
if (only && selected.length === 0) {
  console.log('--only matched no battery. Known: ' + BATTERIES.map((b) => b.name).join(', '));
  process.exit(1);
}

// ── is the stack even up? A battery that cannot run is worth one line, not eight mysteries.
const health = spawnSync('bash', ['-lc',
  'curl -s -m 6 http://127.0.0.1:38401/health | grep -o \'"connected": *[a-z]*\' | head -1'],
  { encoding: 'utf8', timeout: 20000 });
const healthOut = String(health.stdout || '').trim();
if (!/true/.test(healthOut)) {
  console.log('WebSense battery: the hub is not reachable or reports no connected client (' +
    (healthOut || 'no output') + ') — the batteries did NOT run. Check that the server is up on :9222 ' +
    'and that Chrome has the extension loaded.');
  process.exit(1);
}

// ── the fixture server (only the fixture batteries need it, and starting it is harmless)
const probe = spawnSync('bash', ['-lc',
  'curl -s -m 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:' + FIXTURE_PORT + '/bench/click_fingerprint.html'],
  { encoding: 'utf8', timeout: 15000 });
if (String(probe.stdout || '').trim() !== '200') {
  const child = spawn('python', ['-m', 'http.server', String(FIXTURE_PORT), '--bind', '127.0.0.1'],
    { cwd: REPO, detached: true, stdio: 'ignore' });
  child.unref();
  const waited = spawnSync('bash', ['-lc', 'sleep 3'], { timeout: 10000 });
  notes.push('started the fixture server on :' + FIXTURE_PORT + ' (it was not running)');
}

// ── run them
for (const b of selected) {
  const started = Date.now();
  const r = spawnSync('node', b.args, { cwd: REPO, encoding: 'utf8', timeout: NIGHTLY_TIMEOUT_MS });
  const ms = Date.now() - started;
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status !== 0) {
    // Keep the signal, drop the noise: the FAIL lines and the last line are what matter.
    const lines = out.split('\n').filter((l) => /FAIL|Error|error:|not a function|undefined/.test(l));
    const tail = out.split('\n').filter((l) => l.trim()).slice(-3).join(' | ');
    failures.push({ name: b.name, ms, status: r.status,
      detail: (lines.slice(0, 6).join('\n      ') || tail || '(no output)').slice(0, 1200) });
  }
}

// ── report: nothing to say when everything passed
if (failures.length === 0) {
  if (notes.length) console.log('WebSense battery: all ' + BATTERIES.length + ' live batteries passed. ' + notes.join('; '));
  process.exit(0);   // silent tick
}

const lines = [];
lines.push('WebSense live batteries — ' + failures.length + ' of ' + BATTERIES.length + ' FAILED');
for (const f of failures) {
  lines.push('');
  lines.push('✗ ' + f.name + '  (exit ' + f.status + ', ' + Math.round(f.ms / 1000) + 's)');
  lines.push('      ' + f.detail.replace(/\n/g, '\n      '));
}
if (notes.length) lines.push('\nnotes: ' + notes.join('; '));
lines.push('\nReproduce: cd ' + REPO + ' && node tools/<name>.mjs');
console.log(lines.join('\n'));
process.exit(1);
