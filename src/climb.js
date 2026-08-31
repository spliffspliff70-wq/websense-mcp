/**
 * WebSense — Auto-Climb planner (P0#3, 2026-08-31)
 * ==================================================
 * Side-effect-free decision logic for the "suspected_noop → genuine OS click"
 * auto-climb. Kept OUT of server.js so unit tests can import it without
 * starting the hub / MCP server.
 *
 * A synthetic DOM click frequently no-ops on React-controlled submits. The
 * fix is a REAL OS-level click (user32 mouse_event) — but only when it is
 * SAFE: a real click lands on whatever window is frontmost, so in the
 * multi-agent factory it must never fire while the target tab is NOT the
 * OS-active tab (mem 385: real input landing on a sibling worker's tab is the
 * #1 wrong-click source).
 */
export function planAutoClimb(opts) {
  const { bound, activeId, geo } = opts || {};
  if (bound == null) return { climb: false, screen: null, reason: 'no session-bound tab — bind/switch to a tab first' };
  if (activeId == null) return { climb: false, screen: null, reason: 'could not resolve OS-active tab' };
  if (Number(activeId) !== Number(bound)) {
    return { climb: false, screen: null, reason: `target tab not OS-active (active=${activeId} bound=${bound}) — activate it first or auto-climb would click the wrong window` };
  }
  if (!geo || !geo.success) return { climb: false, screen: null, reason: (geo && geo.error) ? geo.error : 'screen_center failed' };
  if (!geo.screen || geo.screen.x == null || geo.screen.y == null || geo.visible === false) {
    return { climb: false, screen: null, reason: 'element not visible or no screen coords' };
  }
  return { climb: true, screen: { x: geo.screen.x, y: geo.screen.y }, reason: null };
}

export function isActiveTabResult(activeResult) {
  return !!(activeResult && activeResult.success && activeResult.tab && activeResult.tab.id != null);
}
