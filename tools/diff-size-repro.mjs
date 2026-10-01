#!/usr/bin/env node
/**
 * diff-size-repro — reproduce the exact event that produced the 333 KB diff and measure it.
 *
 * The event: on x.com/home the composer is CLOSED, so opening it mounts the editor and pushes the
 * timeline down. That is a LAYOUT change with the scroll position unchanged — the branch that used
 * to enumerate 2,023 element movements at 165 bytes each.
 *
 * BEFORE  the diff line was 340.0 KB (viewport group 333.5 KB, moved=2023)
 * AFTER   expect the same event to report a handful of DISTINCT shifts with their indices
 *
 * Writes the raw result to a file so tools/diff-bloat-report.mjs can break it down.
 */
import { writeFileSync } from 'fs';

const B = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let S = null;
const rpc = async (b, s) => {
  const r = await fetch(B, { method: 'POST', headers: s ? Object.assign({}, H, { 'mcp-session-id': s }) : H, body: JSON.stringify(b) });
  const sid = r.headers.get('mcp-session-id'); if (sid) S = sid;
  const t = await r.text();
  return t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('') || t;
};
const parse = (t) => { try { return JSON.parse(t); } catch { return { __raw: t }; } };
async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c);
  if (j.error) return { __error: j.error.message };
  const blocks = ((j.result && j.result.content) || []).map((x) => x.text || '');
  const first = parse(blocks[0] || '');
  first.__all = blocks.join('\n');
  return first;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'repro', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);

const b = await call('navigate', { url: 'https://x.com/home' });
if (!b.tabId) {
  console.log('navigate did not return a tabId — raw reply:');
  console.log(JSON.stringify(b).slice(0, 400));
  console.log('session id captured:', !!S);
  process.exit(1);
}
const tabId = b.tabId;
console.log('navigated -> tab', tabId, '| reusing:', b.reused);
await sleep(15000);

// Confirm the composer is CLOSED (the editor must not exist yet) — that is the precondition for
// this layout change.
const pre = parse((await call('main_world', { func: '() => ({ editor: !!document.querySelector(\'div[data-testid="tweetTextarea_0"]\'), rows: document.querySelectorAll(\'[data-testid^="tweetTextarea_"]\').length })', verify: false })).results?.[0]?.result
  ? JSON.stringify((await call('main_world', { func: '() => ({ editor: !!document.querySelector(\'div[data-testid="tweetTextarea_0"]\'), rows: document.querySelectorAll(\'[data-testid^="tweetTextarea_"]\').length })', verify: false })).results[0].result)
  : '{}');
console.log('before the click:', JSON.stringify(pre));

// THE EVENT: open the composer through the trusted pipeline (this is what shifted the timeline).
const clk = await call('trusted_click', { selector: 'div[data-testid="tweetTextarea_0RichTextInputContainer"]', verify: false });
const raw = clk.__all || '';
writeFileSync('/tmp/after-diff.txt', raw);

const diffIdx = raw.indexOf('DIFF (auto, after ');
const diffLine = diffIdx > 0 ? raw.slice(diffIdx) : '';
console.log('click ->', JSON.stringify({ effect: clk.effect, box: clk.clicked && clk.clicked.box }));
console.log('TOTAL result bytes now : ' + raw.length);
console.log('DIFF line bytes now    : ' + diffLine.length);
console.log('was 340.0 KB (348,160 bytes) — that is the number to beat');
try {
  const dm = diffLine.match(/^DIFF \(auto, after [^)]+\):\s*([\s\S]*)$/);
  const d = JSON.parse(dm[1]);
  const vp = d.viewport || {};
  console.log('viewport group         : ' + JSON.stringify(vp).length + ' bytes');
  console.log('  moved                : ' + vp.moved);
  console.log('  shifts               : ' + (vp.shifts ? vp.shifts.length : '(none)'));
  if (vp.shifts) {
    for (const s of vp.shifts.slice(0, 4)) {
      console.log('    dx=' + s.dx + ' dy=' + s.dy + ' count=' + s.count + ' indices=' + s.i.length +
        (s.vp ? ' vp ' + JSON.stringify(s.vp) : ''));
    }
  }
  console.log('structure count        : ' + (d.structure && d.structure.count));
  console.log('mutated                : ' + d.mutated);
} catch (e) { console.log('(diff parse failed: ' + e.message.slice(0, 60) + ')'); }
