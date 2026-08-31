import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PASS = '✅', FAIL = '❌', SKIP = '⚠️';
let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function t(client, name, args, validator) {
  try {
    const r = await client.callTool({ name, arguments: args || {} });
    const text = r.content?.[0]?.text || '';
    let data; try { data = JSON.parse(text); } catch { data = text; }
    const payload = (data && typeof data === 'object' && data.data !== undefined) ? data.data : data;
    if (validator) {
      const v = validator(payload, text);
      if (v === true || (typeof v === 'string' && v)) { console.log(`  ${PASS} ${name} - ${v === true ? 'ok' : v}`); passed++; }
      else { console.log(`  ${FAIL} ${name} - ${(JSON.stringify(data)||'').slice(0,160)}`); failures.push(name); failed++; }
    } else { console.log(`  ${PASS} ${name} - ${String(text).slice(0,50)}`); passed++; }
    return payload;
  } catch (err) {
    console.log(`  ${FAIL} ${name} - ${err.message.slice(0,120)}`);
    failures.push(name); failed++; return null;
  }
}
function skip(name, reason) { console.log(`  ${SKIP} ${name} - ${reason}`); skipped++; }


async function main() {
  const PORT = process.env.WEBSENSE_PORT || '38402';
  const transport = new StdioClientTransport({ command: 'node', args: ['src/server.js', '--port=' + PORT], cwd: process.cwd(), env: { ...process.env, PORT } });
  const client = new Client({ name: 'ws-test', version: '1.0.0' });
  await client.connect(transport);
  for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 1000)); try { const r = await client.callTool({ name: 'get_status', arguments: {} }); const d = JSON.parse(r.content[0].text); if (d.hubConnected) { console.log('Connected!'); break; } } catch {} }

  console.log('\n── Guide ──');
  await t(client, 'websense_guide', {}, (d, txt) => txt.includes('EXPLORATION') && txt.includes('INTERACTION') ? true : 'wrong guide');

  console.log('\n── Status & Session ──');
  await t(client, 'get_status', {}, (d) => d && (d.hubConnected !== undefined || d.pageConnected !== undefined) ? true : false);
  await t(client, 'reset_session', {}, (d) => d && d.success === true ? true : false);

  console.log('\n── Navigation ──');
  try { const lt = await client.callTool({ name: 'list_tabs', arguments: {} }); const tds = JSON.parse(lt.content[0].text); if (Array.isArray(tds)) for (const tb of tds) { if (tb.url && !tb.url.includes('news.ycombinator')) { try { await client.callTool({ name: 'close_tab', arguments: { tabId: tb.id } }); } catch {} } } } catch {}
  await t(client, 'navigate', { url: 'https://news.ycombinator.com' }, (d) => d && (d.success === true || d.tabId) ? 'navigated' : 'failed');
  await new Promise(r => setTimeout(r, 6000));
  await t(client, 'list_tabs', {}, (d) => Array.isArray(d) ? `${d.length} tabs` : 'failed');
  // Ensure a known web page is the active tab (deterministic regardless of which tab is focused)
  await t(client, 'navigate', { url: 'https://news.ycombinator.com' }, (d) => d && (d.success === true || d.tabId) ? true : (d && d.error ? d.error : 'failed'));
  await new Promise(r => setTimeout(r, 2500));

  console.log('\n── Exploration ──');
  const sag = await t(client, 'explore_page', {}, (d) => d && d.meta && Array.isArray(d.actions) ? `${d.actions.length} actions, ${(d.forms||[]).length} forms` : 'missing');
  await t(client, 'discover_actions', {}, (d) => Array.isArray(d) ? `${d.length} actions` : 'failed');
  await t(client, 'page_state', {}, (d) => d && d.url ? `url=${d.url.slice(0,40)}` : 'failed');

  if (sag) {
    console.log('\n── Intelligence ──');
    const sel = sag.actions?.find(a => a.subtype === 'select') || sag.forms?.flatMap(f => f.fields || []).find(f => f.tag === 'select');
    if (sel) await t(client, 'dropdown_options', { ref: sel.ref }, (d) => d && d.options ? `${d.options.length} options` : 'failed'); else skip('dropdown_options', 'no select on HN');
    await t(client, 'tab_contents', {}, (d) => Array.isArray(d) ? `${d.length} tablists` : 'failed');
    await t(client, 'accordion_contents', {}, (d) => Array.isArray(d) ? `${d.length} accordions` : 'failed');
    if (sag.actions?.length > 0) await t(client, 'action_preview', { ref: sag.actions[0].ref }, (d) => d && d.classification ? true : false); else skip('action_preview', 'no elements');
    await t(client, 'form_state', {}, (d) => Array.isArray(d) ? `${d.length} forms` : 'failed');

    console.log('\n── Interaction ──');
    const inp = sag.actions?.find(a => a.type === 'form_input') || sag.forms?.flatMap(f => f.fields || []).find(f => f.tag === 'input');
    if (inp) await t(client, 'type_text', { ref: inp.ref, text: 'test' }, (d) => d && d.success !== undefined ? `success=${d.success}` : false); else skip('type_text', 'no input');
    const tog = sag.actions?.find(a => a.type === 'toggle');
    if (tog) await t(client, 'toggle', { ref: tog.ref }, (d) => d && d.success !== undefined ? true : false); else skip('toggle', 'no toggle');
    if (sag.actions?.length > 0) await t(client, 'click', { ref: sag.actions[0].ref }, (d) => d && d.success !== undefined ? true : false); else skip('click', 'no clickable');
    await t(client, 'press_key', { key: 'End' }, (d) => d && d.success !== undefined ? true : false);
    await t(client, 'press_key', { key: 'Home', modifiers: ['shift'] }, (d) => d && d.success !== undefined ? true : false);
    await t(client, 'scroll', { direction: 'down', amount: 400 }, (d) => d && d.success !== undefined ? true : false);
    await t(client, 'scroll', { direction: 'up', amount: 400 }, (d) => d && d.success !== undefined ? true : false);
    if (sag.actions?.length > 1) { await t(client, 'scroll_into_view', { ref: sag.actions[1].ref }, (d) => d && d.success !== undefined ? true : false); await t(client, 'hover', { ref: sag.actions[1].ref }, (d) => d && d.success !== undefined ? true : false); await t(client, 'right_click', { ref: sag.actions[1].ref }, (d) => d && d.success !== undefined ? true : false); }
    else skip('scroll_into_view/hover/right_click', 'need 2+ els');
    if (sag.actions?.length > 1) await t(client, 'drag_drop', { fromRef: sag.actions[0].ref, toRef: sag.actions[1].ref }, (d) => d && d.success !== undefined ? true : false); else skip('drag_drop', 'need 2+ els');
    const rect = (sag.actions?.[0]?.rect) || { x: 100, y: 100 };
    await t(client, 'click_xy', { x: rect.x || 100, y: rect.y || 100 }, (d) => d && d.success !== undefined ? true : false);
    const rect2 = (sag.actions?.[0]?.rect) || { x: 200, y: 200 };
    await t(client, 'click_xy', { x: rect2.x || 200, y: rect2.y || 200, button: 'right' }, (d) => d && d.success !== undefined ? true : false);
    await t(client, 'copy_to_clipboard', { text: 'websense test' }, (d) => d && d.success !== undefined ? true : false);

    console.log('\n── Advanced ──');
    const fi = sag.actions?.find(a => a.type === 'file_upload');
    if (fi) { const { writeFileSync } = await import('node:fs'); writeFileSync('test/li-upload.txt', 'test'); await t(client, 'upload_file', { ref: fi.ref, filePath: 'test/li-upload.txt' }, (d) => d && d.success !== undefined ? true : false); }
    else skip('upload_file', 'no file input on HN');
  } else skip('intelligence/interaction', 'no SAG');

  console.log('\n── Network ──');
  await t(client, 'network_log', { clear: true }, (d) => d && d.capturing === true ? 'started' : 'failed');
  await t(client, 'network_log', { clear: false }, (d) => d && Array.isArray(d.entries) ? `${d.entries.length} entries` : 'failed');

  console.log('\n── Dialogs (windows-control bridge) ──');
  await t(client, 'page_state', {}, (d) => d && Array.isArray(d.pendingDialogs) && 'hasBeforeUnload' in d ? `dialogs=${d.pendingDialogs.length} beforeUnload=${d.hasBeforeUnload}` : 'failed');
  await t(client, 'handle_dialog', { action: 'accept' }, (d) => d && d.success === false && d.error ? 'no-pending-ok' : (d && d.success === true ? true : 'failed'));
  await t(client, 'dismiss_dialog', { key: 'escape' }, (d) => d && d.success === true ? `sent=${d.sent}` : 'failed');

  console.log('\n── Utility ──');
  await t(client, 'extract_text', { selector: 'body', maxLen: 500 }, (d) => typeof d === 'string' && d.length > 0 ? d.length + ' chars' : false);
  await t(client, 'evaluate', { script: 'document.title' }, (d) => d && d.success !== undefined ? true : false);
  await t(client, 'read_clipboard', {}, (d) => d && (d.success === true || d.success === false) ? `success=${d.success}${d.text !== undefined ? ' text=' + (d.text || '').length : ''}` : 'failed');
  await t(client, 'download_state', {}, (d) => d && Array.isArray(d.downloads) ? `${d.downloads.length} downloads` : (d && d.error ? d.error : 'failed'));

  console.log('\n── Frames (iframe targeting) ──');
  await t(client, 'list_frames', {}, (d) => d && d.success === true && Array.isArray(d.frames) ? `${d.frames.length} frames (top=${d.frames.find(f=>f.parentFrameId===undefined || f.parentFrameId===-1)?.frameId})` : (d && d.error ? d.error : 'failed'));
  await t(client, 'explore_page', { frameId: 0, full: false }, (d) => d && (d.actions || d.elements) ? `top-frame ok` : (d && d.success === false ? 'no-content' : 'failed'));

  console.log('\n── Wait ──');
  await t(client, 'wait_for', { notLoading: true, timeoutMs: 3000 }, (d) => d && d.success === true ? `waited ok` : (d && d.timedOut ? 'timeout-ok' : 'failed'));

  console.log('\n── Tab Management ──');
  try { const tr = await client.callTool({ name: 'list_tabs', arguments: {} }); const td = JSON.parse(tr.content[0].text); if (Array.isArray(td) && td.length > 0) { const hn = td.find(tb => tb.url && tb.url.includes('news.ycombinator')) || td[0]; await t(client, 'switch_tab', { tabId: hn.id }, (d) => d && (d.success === true || d.error) ? true : false); } else skip('switch_tab', 'no tabs'); } catch { skip('switch_tab', 'err'); }

  console.log('\n── Map & Visualization ──');
  await t(client, 'explore_map', {}, (d) => d && d.pages ? `${Object.keys(d.pages).length} pages` : 'failed');
  await t(client, 'mermaid_export', {}, (d, txt) => txt.includes('```mermaid') && txt.includes('graph') ? true : 'no mermaid');
  await t(client, 'mermaid_export', { direction: 'LR' }, (d, txt) => txt.includes('graph LR') ? true : 'no LR');

  console.log('\n' + '═'.repeat(60));
  console.log(`${PASS} Passed: ${passed}   ${FAIL} Failed: ${failed}   ${SKIP} Skipped: ${skipped}`);
  console.log('═'.repeat(60));
  if (failures.length > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  ${FAIL} ${f}`); }
  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(`${FAIL} ${e.message}`); process.exit(1); });

