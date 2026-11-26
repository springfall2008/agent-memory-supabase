// The Board tab: the board picker, the status strip, and the live graph of one board or one tag.
import { ApiError, getJson, NOT_SIGNED_IN } from './api.js';
import { diffGraph } from './diff.js';
import { clock, h, option } from './dom.js';
import { createGraphView } from './graphview.js';
import { kindOf, shortName, stateOf } from './names.js';
import { nextDelay, POLL_MS } from './poll.js';
import { boardHash } from './route.js';
import { parseStatus } from './status.js';

/**
 * @typedef {{ kind: 'board'; scope: string; board: string } | { kind: 'tag'; tag: string }} Target
 * @typedef {{ scope: string; board: string; state: string | null; goalId: string }} BoardInfo
 * @typedef {{
 *   target: Target;
 *   cancelled: boolean;
 *   busy: boolean;
 *   paused: boolean;
 *   timer: number;
 *   delay: number;
 *   prev: any;
 *   goalId: string | null;
 *   progressId: string | null;
 *   goalText: string;
 *   progressText: string;
 *   conn: 'loading' | 'live' | 'retrying';
 *   error: string | null;
 *   refreshed: Date | null;
 * }} Loop
 */

/**
 * @param {Element} el
 * @param {{ onSelect(id: string): void }} opts
 * @returns {{ showBoard(scope: string, board: string): void; showTag(tag: string): void;
 *   nameOf(id: string): string | null }}
 */
export function mountBoard(el, opts) {
  const picker = /** @type {HTMLSelectElement} */ (h('select', 'board-picker'));
  picker.setAttribute('aria-label', 'Board');
  const reload = h('button', 'secondary', 'Refresh list');
  reload.setAttribute('type', 'button');
  const more = h('span', 'note');
  const bar = h('div', 'board-bar');
  bar.append(picker, reload, more);

  const strip = h('div', 'status-strip');
  strip.setAttribute('aria-live', 'polite');
  const notices = h('div', 'notices');
  const graphEl = h('div', 'graph');
  el.replaceChildren(bar, strip, notices, graphEl);

  let view = null;
  let viewError = '';
  try {
    view = createGraphView(graphEl, { onSelect: (id) => opts.onSelect(id) });
  } catch (e) {
    viewError = errorText(e);
    notices.replaceChildren(h('p', 'notice error', viewError));
  }

  /** @type {BoardInfo[]} */
  let boards = [];
  /** @type {Loop | null} */
  let loop = null;
  /** Set by any 401; polling stays stopped until the page reloads. */
  let signedOut = false;

  const shown = () => document.visibilityState === 'visible' && graphEl.clientWidth > 0;

  function syncPicker() {
    const t = loop?.target;
    const i = t?.kind === 'board' ? boards.findIndex((b) => b.scope === t.scope && b.board === t.board) : -1;
    picker.value = i < 0 ? '' : String(i);
  }

  async function loadBoards() {
    reload.setAttribute('disabled', '');
    try {
      const res = /** @type {{ boards: BoardInfo[]; more: boolean }} */ (await getJson('/boards'));
      boards = res.boards;
      const placeholder = option('', boards.length ? 'Choose a board…' : 'No boards found');
      placeholder.disabled = true;
      picker.replaceChildren(placeholder, ...boards.map((b, i) => option(String(i), boardLabel(b))));
      more.textContent = res.more ? 'More boards exist than this list shows.' : '';
      syncPicker();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signOut();
      more.textContent = e instanceof ApiError && e.status === 401 ? NOT_SIGNED_IN : `Boards: ${errorText(e)}`;
    } finally {
      reload.removeAttribute('disabled');
    }
  }

  /**
   * Keep the picker's text for the shown board in step with its goal's `state:` tag, so a board that finished stops
   * saying "(running)" without a list refresh.
   * @param {Target} t
   * @param {string | null} state
   */
  function syncPickerState(t, state) {
    if (t.kind !== 'board') return;
    const i = boards.findIndex((b) => b.scope === t.scope && b.board === t.board);
    if (i < 0 || boards[i].state === state) return;
    boards[i] = { ...boards[i], state };
    const opt = [...picker.options].find((o) => o.value === String(i));
    if (opt) opt.textContent = boardLabel(boards[i]);
  }

  picker.addEventListener('change', () => {
    const b = boards[Number(picker.value)];
    // The hash change routes back here through showBoard, so a reload keeps the board.
    if (b) location.hash = boardHash(b.scope, b.board);
  });
  reload.addEventListener('click', () => loadBoards());

  // ── status strip ─────────────────────────────────────────────────

  /** @param {string} text @param {string} [cls] */
  const item = (text, cls) => h('span', cls ? `item ${cls}` : 'item', text);

  /** @param {Loop} me */
  function renderStrip(me) {
    const t = me.target;
    const nodes = me.prev?.nodes ?? [];
    const parts = [];
    if (t.kind === 'board') {
      const goal = nodes.find((/** @type {any} */ n) => kindOf(n.tags) === 'goal');
      const status = parseStatus(me.goalText, me.progressText);
      const intents = nodes.filter((/** @type {any} */ n) => kindOf(n.tags) === 'intent').length;
      const max = status.maxIntents === 'none' ? 'no limit' : status.maxIntents ?? 'unknown';
      parts.push(
        item(`${t.board} · ${t.scope}`, 'name'),
        item(`State: ${(goal && stateOf(goal.tags)) ?? 'unknown'}`),
        item(`Round ${status.round ?? 'unknown'}`),
        item(`Intents ${intents} of ${max}`),
        item(`Best: ${status.best ?? 'unknown'}`, 'best'),
      );
    } else {
      parts.push(item(`Tag ${t.tag}`, 'name'), item(`${nodes.length} memories`));
    }
    if (me.refreshed) parts.push(item(`refreshed ${clock(me.refreshed)}`));
    parts.push(connItem(me.conn));
    strip.replaceChildren(...parts);

    const msgs = viewError ? [viewError] : [];
    if (me.prev && t.kind === 'board' && !nodes.some((/** @type {any} */ n) => kindOf(n.tags) === 'intent')) {
      msgs.push(nodes.length ? 'No intents yet.' : 'This board has no memories that you can read.');
    }
    if (me.prev && t.kind === 'tag' && nodes.length === 0) msgs.push('No memories that you can read carry this tag.');
    if (me.prev?.truncated) {
      msgs.push(`Showing the oldest ${nodes.length} of ${me.prev.total} nodes: newer work is not drawn.`);
    }
    if (me.conn === 'retrying' && me.error) msgs.push(`Last request failed: ${me.error}`);
    notices.replaceChildren(...msgs.map((m) => h('p', 'notice', m)));
  }

  /** @param {'loading' | 'live' | 'retrying' | 'signed-out'} conn */
  function connItem(conn) {
    const text = { loading: 'loading', live: 'live', retrying: 'retrying', 'signed-out': 'not signed in' }[conn];
    return item(text, `conn conn-${conn}`);
  }

  function signOut() {
    signedOut = true;
    if (loop) {
      loop.cancelled = true;
      clearTimeout(loop.timer);
    }
    strip.replaceChildren(...[...strip.children].filter((c) => !c.classList.contains('conn')), connItem('signed-out'));
    notices.replaceChildren(h('p', 'notice error', NOT_SIGNED_IN));
  }

  // ── polling ──────────────────────────────────────────────────────

  /** @param {Loop} me */
  async function pollOnce(me) {
    const t = me.target;
    const q = new URLSearchParams({ tags_all: t.kind === 'board' ? `board:${t.board}` : t.tag });
    if (t.kind === 'board') q.set('scope', t.scope);
    const graph = /** @type {any} */ (await getJson(`/graph?${q}`));
    if (me.cancelled) return;
    const diff = diffGraph(me.prev, graph);
    if (t.kind === 'board') {
      const touched = new Set([...diff.added, ...diff.changed]);
      const goal = graph.nodes.find((/** @type {any} */ n) => kindOf(n.tags) === 'goal');
      const progress = graph.nodes.findLast((/** @type {any} */ n) => kindOf(n.tags) === 'progress');
      // Full content, fetched on first load and whenever the graph says the memory changed.
      if ((goal?.id ?? null) !== me.goalId || (goal && touched.has(goal.id))) {
        me.goalText = goal ? await contentOf(goal.id) : '';
        if (me.cancelled) return;
        me.goalId = goal?.id ?? null;
      }
      if ((progress?.id ?? null) !== me.progressId || (progress && touched.has(progress.id))) {
        me.progressText = progress ? await contentOf(progress.id) : '';
        if (me.cancelled) return;
        me.progressId = progress?.id ?? null;
      }
    }
    view?.render(graph, me.prev === null ? null : diff);
    me.prev = graph;
    const goal = graph.nodes.find((/** @type {any} */ n) => kindOf(n.tags) === 'goal');
    if (goal) syncPickerState(t, stateOf(goal.tags));
    me.refreshed = new Date();
  }

  /** @param {string} id */
  async function contentOf(id) {
    const res = /** @type {{ memory: { content: string } }} */ (await getJson(`/memories/${encodeURIComponent(id)}`));
    return res.memory.content;
  }

  /** @param {Loop} me */
  async function tick(me) {
    me.timer = 0;
    if (me.cancelled || me.busy) return;
    if (!shown()) {
      me.paused = true;
      return;
    }
    me.busy = true;
    let ok = true;
    try {
      await pollOnce(me);
    } catch (e) {
      if (me.cancelled) return;
      if (e instanceof ApiError && e.status === 401) {
        signOut();
        return;
      }
      ok = false;
      me.error = errorText(e);
    } finally {
      me.busy = false;
    }
    if (me.cancelled) return;
    me.conn = ok ? 'live' : 'retrying';
    if (ok) me.error = null;
    me.delay = nextDelay(me.delay, ok);
    renderStrip(me);
    me.timer = setTimeout(() => tick(me), me.delay);
  }

  function resume() {
    if (loop && loop.paused && !loop.cancelled && shown()) {
      loop.paused = false;
      tick(loop);
    }
  }
  document.addEventListener('visibilitychange', resume);
  new ResizeObserver(() => {
    view?.resize();
    resume();
  }).observe(graphEl);

  /** @param {Target} target */
  function start(target) {
    if (loop) {
      loop.cancelled = true;
      clearTimeout(loop.timer);
    }
    view?.clear();
    /** @type {Loop} */
    const me = {
      target,
      cancelled: false,
      busy: false,
      paused: false,
      timer: 0,
      delay: POLL_MS,
      prev: null,
      goalId: null,
      progressId: null,
      goalText: '',
      progressText: '',
      conn: 'loading',
      error: null,
      refreshed: null,
    };
    loop = me;
    syncPicker();
    renderStrip(me);
    if (signedOut) {
      signOut();
      return;
    }
    tick(me);
  }

  loadBoards();
  strip.replaceChildren(item('Choose a board to watch it live.'));

  return {
    showBoard: (scope, board) => start({ kind: 'board', scope, board }),
    showTag: (tag) => start({ kind: 'tag', tag }),
    /** The graph label of a node on the shown graph, or null when it is not drawn. */
    nameOf: (id) => {
      const n = loop?.prev?.nodes.find((/** @type {any} */ x) => x.id === id);
      return n ? shortName(n.snippet ?? n.content ?? '').label : null;
    },
  };
}

/** @param {BoardInfo} b */
function boardLabel(b) {
  return `${b.board} · ${b.scope}${b.state ? ` (${b.state})` : ''}`;
}

/** @param {unknown} e */
function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}
