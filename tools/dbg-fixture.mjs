import { regionTree } from '../src/snapshot.js';
const mk = (i, tag, attrs, p) => { const r = { i, tag }; if (attrs) { r.attrs = attrs; r.attrNames = Object.keys(attrs); } if (p != null) r.p = p; return r; };
const snap = { elements: [
  mk(0, 'html', null, null), mk(1, 'body', null, 0),
  mk(2, 'header', { role: 'banner' }, 1), mk(3, 'nav', { 'aria-label': 'Primary' }, 2),
  mk(4, 'a', { 'aria-label': 'Home' }, 3), mk(5, 'main', { role: 'main' }, 1),
  mk(6, 'div', { 'data-testid': 'primaryColumn' }, 5),
  mk(7, 'div', { 'aria-label': 'Home timeline' }, 6),
  mk(8, 'article', { 'data-testid': 'cell' }, 7),
  mk(9, 'span', { 'aria-label': 'inner' }, 8), mk(10, 'span', { 'aria-label': 'meta' }, 8),
  mk(11, 'article', { 'data-testid': 'cell' }, 7),
  mk(12, 'span', { 'aria-label': 'inner' }, 11), mk(13, 'span', { 'aria-label': 'meta' }, 11),
  mk(14, 'article', { 'data-testid': 'cell' }, 7),
  mk(15, 'span', { 'aria-label': 'inner' }, 14), mk(16, 'span', { 'aria-label': 'meta' }, 14),
  mk(17, 'div', { 'data-testid': 'composer' }, 6),
  mk(18, 'span', { 'aria-label': 'What is happening' }, 17), mk(19, 'span', { 'aria-label': 'Post' }, 17),
  mk(20, 'div', { 'data-testid': 'sidebarColumn' }, 5),
  mk(21, 'div', { 'aria-label': 'Trending' }, 20),
  mk(22, 'span', { 'aria-label': 'topic' }, 21), mk(23, 'span', { 'aria-label': 'topic two' }, 21),
  mk(24, 'div', { 'aria-label': 'Search' }, 20),
  mk(25, 'span', { 'aria-label': 'Search box' }, 24),
] };
console.log(regionTree(snap).outline);
