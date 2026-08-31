/**
 * WebSense MCP — Regression Suite (B0)
 *
 * Locks in every error class fixed across sessions (2026-08-10 inventory):
 *   B0.1  switch_tab/close_tab arg-type coercion (snake_case vs camelCase, string vs int)
 *   B0.2  active-tab binding (offscreen must not cache stale currentTabId)
 *   B0.3  selectedTabId=null after restart → "No active tab"/tab=- routing
 *   B0.4  FIN_WAIT_2/CLOSE_WAIT half-connections (offscreen WS watchdog)
 *   B0.5  "Receiving end does not exist" after extension reload (reinject path)
 *   B0.6  EADDRINUSE duplicate server (single listener, hard-fail not swallow)
 *   B0.7  Ad-iframe hijack (main-frame-only routing)
 *   B0.8  Envelope-shape divergence (direct vs offscreen relay → innerOf normalize)
 *   B0.9  MV3 CSP blocks eval everywhere (safeDomRead no-eval fallback)
 *   B0.10 page_state 0×0 on minimized window (viewport guard)
 *   B0.11 navigate spawns 0×0 background tabs (activation)
 *   B0.12 Restricted page guard (chrome:// never touched)
 *
 * Two layers:
 *   LAYER 1 (headless): spawns server on port 38409, asserts tool registration,
 *   arg coercion paths, response-shape normalization helpers.
 *   LAYER 2 (static guards): greps the source for the exact fix strings — these
 *   guards protect extension-side behaviors that need real Chrome to e2e-test.
 *
 * Usage:  node test/test-regressions.js
 * Exit:   0 = all pass, 1 = any fail. Run TWICE consecutively for the gate.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[36mINFO\x1b[0m';
let passed = 0, failed = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ${PASS} ${msg}`); passed++; } else { console.log(`  ${FAIL} ${msg}`); failed++; } };

const ROOT = process.cwd();
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };

// ─── LAYER 2: static source guards (run FIRST — no server spawn needed) ───
function staticGuards() {
  console.log(`\n${INFO} LAYER 2 — static source guards\n`);
  const server = read('src/server.js');
  const hub = read('src/hub.js');
  const offscreen = read('extension/offscreen.js');
  const cs = read('extension/websense-cs.js');
  const bg = read('extension/background.js');

  // B0.1: tabId coercion — parseInt on tab_id||tabId in offscreen tab ops
  assert(/message\.tab_id\s*\|\|\s*message\.tabId/.test(offscreen),
    'B0.1 offscreen coerces tab_id||tabId via parseInt');
  assert(/parseInt\(\w+, 10\)/.test(offscreen), 'B0.1 offscreen uses radix 10');

  // B0.2: no stale currentTabId cache — B1 REPLACED the offscreen cache with
  // the SW boundTabId single source (asserted below). The old guards asserted
  // cache-clear behavior; the new architecture has no cache to clear.
  assert(!/var currentTabId/.test(offscreen), 'B0.2 offscreen no longer declares a currentTabId cache (B1)');

  // B0.3: hub selectedTabId handling + "No active tab" guard
  assert(/selectedTabId = Number\(msg\.tabId\)/.test(hub), 'B0.3 hub sets selectedTabId from tab_selected');
  assert(/No active tab/.test(offscreen), 'B0.3 "No active tab" guard present');

  // B0.4: offscreen WS watchdog (self-close when dead >10s)
  assert(/watchdog|self-close|self\.close\(\)/.test(offscreen), 'B0.4 offscreen watchdog present');
  assert(/10\s*000|10000|10_000/.test(offscreen), 'B0.4 watchdog threshold ~10s');

  // B0.5: content-script reinject on navigation (content_scripts matches all URLs)
  const manifest = read('extension/manifest.json');
  assert(/"content_scripts"/.test(manifest), 'B0.5 manifest has content_scripts');
  assert(/<all_urls>/.test(manifest), 'B0.5 content scripts match all URLs');

  // B0.6: EADDRINUSE hard-fail (not swallowed) in hub
  assert(/EADDRINUSE/.test(hub), 'B0.6 hub surfaces EADDRINUSE');

  // B0.7: ad-iframe hijack guard — main-frame-only routing
  assert(/isMainFrame/.test(cs) || /isMainFrame/.test(bg), 'B0.7 isMainFrame flag present');
  assert(/safeframe|googlesyndication|doubleclick/.test(cs), 'B0.7 ad-frame URL patterns present');

  // B0.8: envelope-shape normalization (innerOf) in server wait_for
  assert(/innerOf/.test(server), 'B0.8 server normalizes direct-vs-relay response shapes');

  // B0.9: MV3 CSP — safeDomRead no-eval fallback present
  assert(/safeDomRead|safe-querySelector/.test(cs), 'B0.9 safeDomRead no-eval fallback present');
  assert(/cspBlocked/.test(cs) || /CSP blocked/.test(cs), 'B0.9 cspBlocked detection present');

  // B0.10: viewport guard — page_state must return w/h (0×0 detectable)
  assert(/viewport/.test(cs), 'B0.10 viewport reported in page_state');

  // B0.11: navigate activates the tab (not background-spawn)
  assert(/active: true|active:true/.test(bg) || /activate/.test(offscreen), 'B0.11 navigate activates tab');

  // B0.12: restricted page guard
  assert(/Restricted page/.test(offscreen) || /Restricted page/.test(cs), 'B0.12 chrome:// guard present');

  // ═══ B1 guards: binding state machine ═══
  // SW single source of truth — boundTabId declared in background
  assert(/let boundTabId = null/.test(bg), 'B1 SW declares boundTabId (single source of truth)');
  assert(/boundTabId = tabId/.test(bg), 'B1 SW binds on switch/navigate/open');
  assert(/boundTabId = null/.test(bg), 'B1 SW invalidates binding');
  assert(/chrome\.tabs\.onRemoved\.addListener/.test(bg), 'B1 SW invalidates binding on tab close');
  // get_bound_tab sub-ms read path
  assert(/case 'get_bound_tab'/.test(bg), 'B1 SW has get_bound_tab state read');
  assert(/case 'bind_tab'/.test(bg), 'B1 SW has bind_tab handler');
  // offscreen dropped the cache — NO currentTabId writes remain
  assert(!/currentTabId = /.test(offscreen), 'B1 offscreen has no currentTabId cache writes');
  assert(/get_bound_tab/.test(offscreen), 'B1 offscreen queries SW bound tab');
  // reconnect re-sync: hub selectedTabId restored after restart
  assert(/notifyTabSelected\(bound\.tabId\)/.test(offscreen), 'B1 offscreen re-syncs hub binding on reconnect');
  // server exposes bind_tab tool
  assert(/reg\(server, 'bind_tab'/.test(server), 'B1 server registers bind_tab tool');

  // ═══ A2 guards: semantic locators ═══
  assert(/function buildLocator/.test(cs), 'A2 content script has buildLocator');
  assert(/data-testid/.test(cs) && /aria-label/.test(cs) && /nth-of-type/.test(cs), 'A2 locator chain uses testid→aria→CSS path');
  assert(/function resolveLocator/.test(cs), 'A2 content script has resolveLocator (CSP-safe re-resolve)');
  assert(/locator: loc/.test(cs), 'A2 assignRef stores the locator chain');
  assert(/locatorByRef\.get\(ref\)/.test(cs), 'A2 resolveRef falls back through the locator chain');
  assert(/action\.locator = loc\[0\]/.test(cs), 'A2 explore exposes locator per action');
  assert(/const locatorByRef = new Map\(\)/.test(cs), 'A2 locatorByRef plain Map (WeakMap not iterable — live bug caught)');
  assert(/locatorByRef\.set\(ref, loc\)/.test(cs), 'A2 assignRef indexes locator by ref');
  assert(/locatorByRef\.get\(ref\)/.test(cs), 'A2 resolveRef looks up locator by ref');
  assert(/locatorByRef\.clear\(\)/.test(cs), 'A2 locatorByRef cleared on explore reset');
  assert(/reg\(server, 'resolve_ref'/.test(server), 'A2 server registers resolve_ref tool');

  // ═══ A1 guards: live diff engine ═══
  assert(/LIVE DIFF ENGINE/.test(cs), 'A1 diff engine present in content script');
  assert(/const diffBuf = \[\]/.test(cs), 'A1 ring buffer declared');
  assert(/diffObserver\.observe\(document\.body/.test(cs), 'A1 MutationObserver observes body');
  assert(/function getPageDiff/.test(cs), 'A1 getPageDiff defined');
  assert(/changed === 0/.test(cs), 'A1 no-change hint present');
  assert(/case 'page_diff'/.test(cs), 'A1 page_diff in content dispatch');
  assert(/reg\(server, 'page_diff'/.test(server), 'A1 server registers page_diff tool');

  // ═══ A3 guards: intent detection ═══
  assert(/INTENT DETECTION/.test(cs), 'A3 intent detection section present');
  assert(/function detectIntent/.test(cs), 'A3 detectIntent defined');
  assert(/INTENT_BUTTON_TEXT/.test(cs), 'A3 button-text intent table');
  assert(/INTENT_INPUT_TYPE/.test(cs), 'A3 input-type intent table');
  assert(/function findIntent/.test(cs), 'A3 findIntent defined');
  assert(/action\.intent = detectIntent/.test(cs), 'A3 explore actions carry intent tag');
  assert(/case 'find_intent'/.test(cs), 'A3 find_intent in content dispatch');
  assert(/reg\(server, 'find_intent'/.test(server), 'A3 server registers find_intent tool');

  // ═══ A5 guards: geometry answers ═══
  assert(/GEOMETRY ANSWERS/.test(cs), 'A5 geometry section present');
  assert(/function getGeometry/.test(cs), 'A5 getGeometry defined');
  assert(/function layoutRelation/.test(cs), 'A5 layoutRelation defined');
  assert(/findScrollContainer\(\)/.test(cs), 'A5 uses real scroll container');
  assert(/zDepth/.test(cs), 'A5 z-depth computed');
  assert(/case 'geometry'/.test(cs), 'A5 geometry in content dispatch');
  assert(/reg\(server, 'geometry'/.test(server), 'A5 server registers geometry tool');
  assert(/reg\(server, 'layout_relation'/.test(server), 'A5 server registers layout_relation tool');

  // ═══ A6 guards: event stream ═══
  assert(/EVENT STREAM/.test(cs), 'A6 event stream section present');
  assert(/const eventBuf = \[\]/.test(cs), 'A6 event buffer declared');
  assert(/function scanEvents/.test(cs), 'A6 scanEvents defined (nav + network)');
  assert(/function drainDiffToEvents/.test(cs), 'A6 drainDiffToEvents defined');
  assert(/dialog_open/.test(cs), 'A6 dialog_open event classified');
  assert(/function getEvents/.test(cs), 'A6 getEvents defined');
  assert(/case 'get_events'/.test(cs), 'A6 get_events in content dispatch');
  assert(/reg\(server, 'wait_for_event'/.test(server), 'A6 server registers wait_for_event tool');

  // ═══ A7 guards: no-dump contract ═══
  assert(/NO-DUMP CONTRACT/.test(cs), 'A7 no-dump section present');
  assert(/GOAL_ALIASES/.test(cs), 'A7 goal-alias table present');
  assert(/function exploreIntent/.test(cs), 'A7 exploreIntent defined');
  assert(/relevant\.sort/.test(cs), 'A7 relevance scoring + sort');
  assert(/case 'explore_intent'/.test(cs), 'A7 explore_intent in content dispatch');
  assert(/reg\(server, 'explore_intent'/.test(server), 'A7 server registers explore_intent tool');

  // ═══ B2 guards: compound cross-tab ops ═══
  assert(/case 'transfer_text'/.test(bg), 'B2 SW has transfer_text handler');
  assert(/read_selector/.test(bg), 'B2 SW reads via content read_selector');
  assert(/write_selector/.test(bg), 'B2 SW writes via content write_selector');
  assert(/verified: ok/.test(bg), 'B2 transfer_text verifies the paste');
  assert(/elapsedMs/.test(bg), 'B2 transfer_text reports elapsed time');
  assert(/case 'switch_tab_and_read'/.test(bg), 'B2 SW has switch_tab_and_read');
  assert(/case 'transfer_text'/.test(offscreen), 'B2 offscreen relays transfer_text');
  assert(/reg\(server, 'transfer_text'/.test(server), 'B2 server registers transfer_text tool');
  assert(/reg\(server, 'switch_tab_and_read'/.test(server), 'B2 server registers switch_tab_and_read tool');

  // ═══ B2 routing guard: v2 tab ops must route to the offscreen (hub.js isTabOp) ═══
  assert(/transfer_text/.test(hub), 'B2 hub routes transfer_text (isTabOp)');
  assert(/switch_tab_and_read/.test(hub), 'B2 hub routes switch_tab_and_read (isTabOp)');
  assert(/list_windows/.test(hub), 'B3 hub routes list_windows (isTabOp)');
  assert(/ax_state/.test(hub), 'A4 hub routes ax_state (isTabOp)');

  // ═══ A4 guards: AX-tree state reads (KILLED 2026-08-11) ═══
  // chrome.automation is an EXPERIMENTAL API (dev-channel only, per Chrome docs)
  // — not exposed in stable-Chrome MV3 offscreen/SW contexts. Kill-if-blocked
  // clause fired on the live probe. Permission removed; handler keeps the
  // honest kill message so the tool fails clean instead of hanging.
  assert(!/"automation"/.test(manifest), 'A4 KILL: automation permission removed from manifest');
  assert(/kill: true/.test(offscreen), 'A4 kill-if-blocked clause present (fires on stable Chrome)');

  // ═══ B3 guards: window-level ops ═══
  assert(/case 'list_windows'/.test(bg), 'B3 SW has list_windows');
  assert(/chrome\.windows\.getAll/.test(bg), 'B3 uses chrome.windows.getAll');
  assert(/case 'focus_window'/.test(bg), 'B3 SW has focus_window');
  assert(/chrome\.windows\.update/.test(bg), 'B3 focuses via chrome.windows.update');
  assert(/case 'move_tab_to_window'/.test(bg), 'B3 SW has move_tab_to_window');
  assert(/chrome\.tabs\.move/.test(bg), 'B3 moves via chrome.tabs.move');
  assert(/case 'list_windows'/.test(offscreen), 'B3 offscreen relays list_windows');
  assert(/reg\(server, 'list_windows'/.test(server), 'B3 server registers list_windows tool');
  assert(/reg\(server, 'focus_window'/.test(server), 'B3 server registers focus_window tool');
  assert(/reg\(server, 'move_tab_to_window'/.test(server), 'B3 server registers move_tab_to_window tool');
}

// ─── LAYER 1: headless server-layer tests ───
async function serverLayer() {
  console.log(`\n${INFO} LAYER 1 — headless server-layer\n`);
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['src/server.js'],
    cwd: ROOT,
    env: { ...process.env, PORT: '38409' },
  });
  const client = new Client({ name: 'websense-regression', version: '1.0.0' });
  try { await client.connect(transport); } catch (e) { console.log(`${FAIL} connect: ${e.message}`); failed++; return; }

  // Tools present (incl. new v1.2.1)
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert(tools.includes('dump_markdown'), 'tool dump_markdown registered');
  assert(tools.includes('wait_for'), 'tool wait_for registered');
  assert(tools.includes('switch_tab') && tools.includes('close_tab'), 'tab tools registered');
  assert(tools.includes('bind_tab'), 'tool bind_tab registered (B1)');
  assert(tools.includes('resolve_ref'), 'tool resolve_ref registered (A2)');
  assert(tools.includes('page_diff'), 'tool page_diff registered (A1)');
  assert(tools.includes('find_intent'), 'tool find_intent registered (A3)');
  assert(tools.includes('geometry'), 'tool geometry registered (A5)');
  assert(tools.includes('layout_relation'), 'tool layout_relation registered (A5)');
  assert(tools.includes('wait_for_event'), 'tool wait_for_event registered (A6)');
  assert(tools.includes('explore_intent'), 'tool explore_intent registered (A7)');
  assert(tools.includes('transfer_text'), 'tool transfer_text registered (B2)');
  assert(tools.includes('switch_tab_and_read'), 'tool switch_tab_and_read registered (B2)');
  assert(tools.includes('ax_state'), 'tool ax_state registered (A4)');
  assert(tools.includes('list_windows'), 'tool list_windows registered (B3)');
  assert(tools.includes('focus_window'), 'tool focus_window registered (B3)');
  assert(tools.includes('move_tab_to_window'), 'tool move_tab_to_window registered (B3)');

  // wait_for schema: selector + script params exist
  const wf = (await client.listTools()).tools.find(t => t.name === 'wait_for');
  const wfProps = wf && wf.inputSchema && wf.inputSchema.properties ? Object.keys(wf.inputSchema.properties) : [];
  assert(wfProps.includes('selector'), 'wait_for accepts selector');
  assert(wfProps.includes('script'), 'wait_for accepts script');
  assert(wfProps.includes('timeoutMs'), 'wait_for accepts timeoutMs');

  // dump_markdown schema: selector optional
  const dm = (await client.listTools()).tools.find(t => t.name === 'dump_markdown');
  assert(dm && dm.inputSchema && dm.inputSchema.properties, 'dump_markdown has input schema');

  // get_status reports hubConnected false (no extension on 38409)
  const st = JSON.parse((await client.callTool({ name: 'get_status', arguments: {} })).content[0].text);
  assert(st.hubConnected === false, 'hubConnected false on isolated port');

  // guide present + substantive (no hard ceiling — it grows with tool count)
  const guide = (await client.callTool({ name: 'websense_guide', arguments: {} })).content[0].text;
  assert(guide.length > 800, 'guide substantive (≥800 chars)');

  await client.close();
}

// ─── run ───
staticGuards();
await serverLayer();
console.log(`\n${'='.repeat(60)}`);
console.log(`${INFO} Passed: ${passed}  ${failed > 0 ? FAIL : PASS} Failed: ${failed}`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
