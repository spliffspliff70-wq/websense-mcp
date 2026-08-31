/**
 * WebSense MCP — Mermaid Export
 * Generates Mermaid flowchart from the exploration map.
 */
export function exportMermaid(explorationMap, options = {}) {
  const direction = options.direction || 'TD';
  const detail = options.detail || 'pages_actions';
  const lines = [`graph ${direction}`];

  // Helper to create safe node IDs from URLs
  function urlToId(url) {
    try {
      const u = new URL(url);
      return 'P_' + u.pathname.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30) || 'P_root';
    } catch {
      return 'P_' + url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    }
  }

  // Node definitions
  const pages = explorationMap.pages || {};
  for (const [url, page] of Object.entries(pages)) {
    const id = urlToId(url);
    const label = (page.title || url).replace(/"/g, "'").slice(0, 50);
    lines.push(`    ${id}["${label}"]`);
  }

  // Edges
  if (detail === 'pages' || detail === 'pages_actions' || detail === 'full') {
    for (const [url, page] of Object.entries(pages)) {
      const fromId = urlToId(url);
      for (const action of (page.outgoingActions || [])) {
        const toId = urlToId(action.leadsTo);
        if (toId && toId !== fromId) {
          if (detail === 'pages') {
            lines.push(`    ${fromId} --> ${toId}`);
          } else {
            const label = (action.label || action.ref || '').replace(/"/g, "'").slice(0, 30);
            lines.push(`    ${fromId} -->|${label}| ${toId}`);
          }
        }
      }
    }
  }

  // Highlight current page
  if (explorationMap.currentPage) {
    const currId = urlToId(explorationMap.currentPage);
    lines.push(`    style ${currId} fill:#e8f5e9,stroke:#4caf50,stroke-width:2px`);
  }

  return lines.join('\n');
}
