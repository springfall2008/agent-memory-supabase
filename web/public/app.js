// The app shell: the Browse | Board tabs, hash routing, and the shared node/row selection.
import { mountBoard } from './board.js';
import { mountBrowse } from './browse.js';
import { parseHash, tagHash } from './route.js';

const tabs = {
  browse: /** @type {HTMLElement} */ (document.getElementById('tab-browse')),
  board: /** @type {HTMLElement} */ (document.getElementById('tab-board')),
};
const panels = {
  browse: /** @type {HTMLElement} */ (document.getElementById('panel-browse')),
  board: /** @type {HTMLElement} */ (document.getElementById('panel-board')),
};

/** The board or tag the Board tab shows, so selection and the Board tab button know it. */
let boardContext = /** @type {{ scope: string; board: string } | { tag: string } | null} */ (null);
let lastBoardHash = '#board';
let shownKey = '';

/**
 * Seam for the detail drawer (next task: `openDrawer(id, { board })` from drawer.js replaces this body).
 * @param {string} id
 */
function onSelect(id) {
  document.body.dataset.selected = id;
  console.log('selected', id, boardContext);
}

const browse = { mounted: false };
const board = mountBoard(panels.board, { onSelect });

/** @param {'browse' | 'board'} which */
function showTab(which) {
  for (const k of /** @type {const} */ (['browse', 'board'])) {
    panels[k].hidden = k !== which;
    tabs[k].setAttribute('aria-selected', String(k === which));
  }
  if (which === 'browse' && !browse.mounted) {
    browse.mounted = true;
    mountBrowse(panels.browse, { onSelect, onGraphTag: (tag) => (location.hash = tagHash(tag)) });
  }
}

function route() {
  const r = parseHash(location.hash);
  if (r.tab === 'browse') {
    showTab('browse');
    return;
  }
  showTab('board');
  if ('scope' in r || 'tag' in r) lastBoardHash = location.hash;
  // Only a different board restarts the poll; flipping tabs keeps the live graph.
  const key = 'scope' in r ? `b\n${r.scope}\n${r.board}` : 'tag' in r ? `t\n${r.tag}` : shownKey;
  if (key === shownKey) return;
  shownKey = key;
  if ('scope' in r) {
    boardContext = { scope: r.scope, board: r.board };
    board.showBoard(r.scope, r.board);
  } else if ('tag' in r) {
    boardContext = { tag: r.tag };
    board.showTag(r.tag);
  }
}

tabs.browse.addEventListener('click', () => (location.hash = '#browse'));
tabs.board.addEventListener('click', () => (location.hash = lastBoardHash));
globalThis.addEventListener('hashchange', route);
route();
