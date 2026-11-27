// The app shell: the Browse | Board tabs, hash routing, and the shared node/row selection.
import { mountBoard } from './board.js';
import { mountBrowse } from './browse.js';
import { closeDrawer, openDrawer, refreshDrawer } from './drawer.js';
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
 * Open the drawer from the Board graph, which knows the shown board and the short names of its nodes. On a board
 * view (not a tag view) the drawer also gets what its shortcuts need.
 * @param {string} id
 */
function onBoardSelect(id) {
  const shown = boardContext && 'board' in boardContext ? boardContext : null;
  openDrawer(id, {
    board: shown?.board ?? null,
    nameOf: (other) => board.nameOf(other),
    nodes: () => board.nodes(),
    progressText: () => board.progressText(),
    usage: () => board.usage(),
    // Only a board view writes: a tag view has no one board to add to.
    ...(shown ? { scope: shown.scope, status: () => board.status(), pollNow: () => board.pollNow() } : {}),
  });
}

const browse = { mounted: false };
// After each graph poll the drawer redraws what it takes from the graph, such as the goal's list of amendments.
const board = mountBoard(panels.board, { onSelect: onBoardSelect, onPoll: refreshDrawer });

/** @param {'browse' | 'board'} which */
function showTab(which) {
  for (const k of /** @type {const} */ (['browse', 'board'])) {
    panels[k].hidden = k !== which;
    tabs[k].setAttribute('aria-selected', String(k === which));
  }
  if (which === 'browse' && !browse.mounted) {
    browse.mounted = true;
    mountBrowse(panels.browse, {
      onSelect: (id) => openDrawer(id, { board: null }),
      onGraphTag: (tag) => (location.hash = tagHash(tag)),
    });
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
  // The drawer shows a memory from before the switch; close it rather than leave it over the new graph.
  closeDrawer();
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
