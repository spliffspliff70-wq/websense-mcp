// reddit-post.cjs — ONE session: bind reddit tab, type title (v4.3 custom-element path),
// type body, click Post, verify. All state in a single MCP session.
const BASE = 'http://127.0.0.1:9222/mcp';
let id = 0;
let sessionId = null;

async function rpc(method, params) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  // streamable HTTP may return SSE; extract the data line
  let payload = null;
  try { payload = JSON.parse(text); }
  catch (_) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) { try { payload = JSON.parse(line.slice(5).trim()); break; } catch (_) {} }
    }
  }
  if (!payload) throw new Error('no payload: ' + text.slice(0, 200));
  if (payload.error) throw new Error(JSON.stringify(payload.error).slice(0, 300));
  return payload.result;
}

async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  const content = r.content && r.content[0] && r.content[0].text;
  let parsed = null;
  try { parsed = JSON.parse(content); } catch (_) { parsed = content; }
  return parsed;
}

const REDDIT_TAB = 328016889;
const TITLE = 'Agents kept getting flagged by bot detection and losing memory between sessions — built two tools that fixed it';
const BODY = `Every agent I ran hit the same two walls. Puppeteer-style automation got fingerprinted (navigator.webdriver, headless markers), and every session started from zero context.

Two things I landed on:

1. Drive the user's real Chrome instead of a headless instance. WebSense is an MCP server + Chrome extension: the agent gets a semantic map of the page (every interactive element typed and ref'd), acts through native DOM events, and the site sees a normal user. No CDP anywhere, so no webdriver flag. Works on LinkedIn and other CSP-strict sites.

2. Store memory locally with timestamps and versioning. MemStore does semantic recall over local storage — the agent picks up where it left off, and everything stays auditable and offline.

I've been running both for a while powering a multi-agent bug bounty setup (9 agents). The stack:

- WebSense (free, open source, MIT): https://github.com/spliffspliff70-wq/websense-mcp
- MemStore ($14.99, one-time): https://github.com/spliffspliff70-wq/memstore

Happy to answer architecture questions — the tricky part was keeping synthetic events CSP-safe. Thanks to this community for the MCP spec work that made tools like this possible.`;

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reddit-post', version: '1.0' } });
  // notify initialized (some servers require it)
  await rpc('notifications/initialized', {}).catch(() => {});

  console.log('1. bind reddit tab');
  console.log(await tool('tabs', { action: 'bind', tabId: REDDIT_TAB }));

  console.log('2. confirm page');
  const probe = await tool('evaluate', { query: { extract: 'text', maxLen: 60, selector: 'title' } });
  console.log('page:', JSON.stringify(probe).slice(0, 140));
  if (!String(JSON.stringify(probe)).includes('Submit to r/mcp')) {
    console.log('!! NOT on reddit submit — aborting (no post will be made)');
    return;
  }

  console.log('3. type title (v4.3 custom-element path)');
  const t1 = await tool('type_text', { ref: 'E64', text: TITLE, clearFirst: true });
  console.log('title result:', JSON.stringify(t1).slice(0, 400));

  console.log('4. verify title validity attr');
  const v = await tool('evaluate', { query: { all: true, extract: 'attrs', maxLen: 40, selector: '[name="title"]' } });
  console.log('title attrs:', JSON.stringify(v).slice(0, 300));

  console.log('5. type body');
  const t2 = await tool('type_text', { ref: '[slot="rte"]', text: BODY });
  console.log('body result:', JSON.stringify(t2).slice(0, 300));

  console.log('6. click Post');
  const c = await tool('click', { ref: '#submit-post-button' });
  console.log('click result:', JSON.stringify(c).slice(0, 400));

  console.log('7. verify landing (url change or post element)');
  await new Promise(r => setTimeout(r, 4000));
  const s = await tool('status', { kind: 'page' });
  console.log('after url:', (s && s.url) || JSON.stringify(s).slice(0, 150));
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
