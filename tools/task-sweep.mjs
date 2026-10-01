#!/usr/bin/env node
/**
 * task-sweep — drive the REAL MCP server through a realistic agent cycle on each page in a
 * sample, the way the tools are meant to be used, and report compactly:
 *
 *   browse (navigate + settle + re-collect)  -> the index + the regions block
 *   find{interactive:true}                   -> locate a control, with its region and branch
 *   page_slice{indices:[i]}                  -> load that record at full fidelity
 *   scroll                                   -> read the auto-DIFF; viewport churn must land in
 *                                               `viewport`, NOT in `structure`
 *
 * Usage: node tools/task-sweep.mjs [url...]
 */
const BASE = 'http://127.0.0.1:9222/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const B = (s) => Buffer.byteLength(String(s), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rpc = async (b, s) => {
  const r = await fetch(BASE, { method: 'POST', headers: s ? { ...H, 'mcp-session-id': s } : H, body: JSON.stringify(b) });
  return { t: await r.text(), s: r.headers.get('mcp-session-id') };
};
const parse = (t) => { const l = t.split('\n').find((x) => x.startsWith('data: ')); return JSON.parse(l ? l.slice(6) : t); };

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sweep', version: '1' } } });
const S = init.s;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);

async function call(name, args) {
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, S);
  const j = parse(c.t);
  if (j.error) return { __error: JSON.stringify(j.error).slice(0, 240) };
  const blocks = (j.result && j.result.content) || [];
  const texts = blocks.map((b) => b.text || '');
  const head = texts[0] || '';
  // ★ THE AUTO-DIFF ARRIVES AS A SECOND CONTENT BLOCK, not inside the JSON body —
  // 'DIFF (auto, after <op>): {...}'. Reading only content[0] silently reports "no diff".
  const diffLine = texts.find((t) => t.indexOf('DIFF (auto') === 0) || '';
  let out;
  try { out = JSON.parse(head); } catch { out = { __raw: String(head).slice(0, 300) }; }
  if (diffLine) {
    try { out.__diff = JSON.parse(diffLine.slice(diffLine.indexOf(': ') + 2)); }
    catch { out.__diffRaw = diffLine.slice(0, 300); }
  }
  return out;
}

const urls = process.argv.slice(2);
const tabs = [];
for (const url of urls) {
  const out = { url, notes: [] };
  try {
    const first = await call('browse', { url });
    if (first.tabId) tabs.push(first.tabId);
    const tabId = first.tabId;
    await sleep(13000);
    const j = await call('browse', { fresh: true, tabId });
    const reg = j.regions || '';
    out.elements = j.index ? j.index.elements : '?';
    out.regions = { lines: reg.split('\n').length, bytes: B(reg), repeats: (reg.match(/REPEATS x\d+/g) || []).length, idLeaks: (reg.match(/id__/g) || []).length, datums: (reg.match(/\u27EA/g) || []).length };

    const f = await call('find', { tabId, interactive: true, limit: 400 });
    const hits = f.hits || [];
    out.find = { interactiveHits: hits.length, matched: f.matched, returned: f.returned };
    const pick = hits.find((h) => /#|\[/.test(h.loc || '')) || hits[0];
    if (pick) {
      out.find.first = { i: pick.i, tag: pick.tag, loc: String(pick.loc).slice(0, 46), region: String(pick.region || '').slice(0, 40), branch: (pick.branch || []).length, name: String(pick.name || '').slice(0, 30) };
      const s = await call('page_slice', { tabId, indices: [pick.i] });
      out.slice = { returned: s.returned, matched: s.matched, hasAttrs: !!(s.elements && s.elements[0] && s.elements[0].attrs) };
      // type into a real FORM FIELD (a link can never accept text — that would be my harness
      // failing, not the tool)
      const fields = await call('find', { tabId, field: true, limit: 20 });
      const fld = (fields.hits || []).find((h) => h.loc && !/password/i.test(h.loc));
      if (fld) {
        const act = await call('type_text', { tabId, ref: fld.loc, text: 'websense sweep', clearFirst: true });
        out.type = { on: String(fld.loc).slice(0, 34), effect: act.effect, success: act.success, escalation: act.escalation ? act.escalation.recommended : undefined };
      } else out.type = { skipped: 'no form field on this page' };
    }
    const sc = await call('scroll', { tabId, direction: 'down', amount: 2 });
    const d = sc.__diff || {};
    const g = d.groups || d;
    const cnt = (x) => (Array.isArray(x) ? x.length : (x && typeof x === 'object' ? Object.keys(x).length : 0));
    out.scroll = {
      mutated: d.mutated,
      structure: cnt(g.structure && (g.structure.changed || g.structure)),
      content: cnt(g.content && (g.content.changed || g.content)),
      viewport: g.viewport && (g.viewport.enumerated === false ? 'collapsed (not enumerated)' : cnt(g.viewport)),
      diffPresent: !!sc.__diff,
      diffKeys: Object.keys(d).slice(0, 10),
    };
  } catch (e) {
    out.notes.push('ERROR ' + String(e.message).slice(0, 160));
  }
  console.log(JSON.stringify(out));
}

for (let i = 1; i < tabs.length; i++) { try { await call('tabs', { action: 'close', tabId: tabs[i] }); } catch { /* ignore */ } }
if (tabs.length) console.error('[kept tab ' + tabs[0] + ', closed ' + (tabs.length - 1) + ']');
