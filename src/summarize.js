/**
 * WebSense — Goal-aware read summarizer (P1#2, 2026-08-31)
 * =========================================================
 * Side-effect-free: when a `read` returns too much text, keep the agent's
 * context budget sane by extracting the segments most relevant to the task
 * goal (keyword overlap scoring — no LLM, no eval, works under CSP).
 *
 * Borrowed pattern: browser automation reference implementations's SNAPSHOT_SUMMARIZE_THRESHOLD +
 * _extract_relevant_content (snapshot summarization for ariaSnapshot). This
 * is the WebSense-native version for text/markdown reads.
 */
const DEFAULT_THRESHOLD = 8000;      // chars above which we summarize
const DEFAULT_KEEP = 4000;           // max chars to keep in the summary window
const SEGMENT_RE = /([^\n]{40,}(?:\n|$))+/g; // paragraph-ish chunks

function goalTokens(goal) {
  if (!goal) return [];
  return String(goal)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2)
    .slice(0, 24); // cap — no unbounded goals
}

function scoreSegment(seg, tokens) {
  if (!tokens.length) return 0;
  const low = seg.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (low.includes(t)) score += t.length; // longer tokens = more specific
  }
  return score;
}

/**
 * Summarize `text` when it exceeds `threshold` chars. Keeps the top-scoring
 * segments (by goal-term overlap) plus a head/tail anchor so the agent keeps
 * page-context continuity. Deterministic — same input → same output.
 *
 * Returns:
 *   { summarized:false, text }                      — under threshold
 *   { summarized:true, text, totalChars, keptChars,
 *     droppedSegments, goal }                       — over threshold
 */
export function summarizeRead(text, goal, opts = {}) {
  const threshold = opts.threshold || DEFAULT_THRESHOLD;
  const keep = opts.keep || DEFAULT_KEEP;
  if (!text || text.length <= threshold) return { summarized: false, text: text || '' };
  if (!goal) {
    // No goal: still respect the budget — keep head+tail, drop the middle.
    const head = text.slice(0, Math.floor(keep / 2));
    const tail = text.slice(text.length - Math.floor(keep / 2));
    return {
      summarized: true,
      text: head + '\n\n…[auto-summarized: no goal — middle ' + (text.length - keep) + ' chars dropped; call read with goal:"…" for goal-aware extraction]…\n\n' + tail,
      totalChars: text.length,
      keptChars: head.length + tail.length,
      droppedSegments: 1,
      goal: null,
    };
  }
  const tokens = goalTokens(goal);
  // Split into segments (paragraphs / long lines)
  const rawSegs = String(text).split(/\n{2,}|\n(?=[A-Z0-9])/);
  const segs = rawSegs.map((s) => s.trim()).filter((s) => s.length > 20);
  if (!segs.length) return { summarized: false, text }; // can't chunk — pass through

  const scored = segs
    .map((seg) => ({ seg, score: scoreSegment(seg, tokens) }))
    .sort((a, b) => b.score - a.score);

  let kept = '';
  let keptChars = 0;
  const keptSegs = [];
  for (const { seg, score } of scored) {
    if (keptChars >= keep) break;
    if (score === 0) continue; // zero-relevance segments never kept
    keptSegs.push(seg);
    keptChars += seg.length;
    if (keptChars >= keep) break;
  }
  // Always anchor with the page's opening (title/context) if not already kept
  const first = segs[0];
  if (first && !keptSegs.includes(first) && keptChars < keep) {
    keptSegs.unshift(first);
    keptChars += first.length;
  }
  kept = keptSegs.join('\n\n');
  const dropped = segs.length - keptSegs.length;
  return {
    summarized: true,
    text: kept + (dropped > 0 ? `\n\n…[auto-summarized: ${dropped} of ${segs.length} segments dropped as irrelevant to "${goal}"; total ${text.length} chars → ${keptChars}]…` : ''),
    totalChars: text.length,
    keptChars,
    droppedSegments: dropped,
    goal,
  };
}
