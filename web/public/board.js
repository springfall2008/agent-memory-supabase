// The Board tab: the board picker, the status strip, the board toolbar (`toolbar.js`), and the live graph of one board
// or one tag.
import { ApiError, getJson, NOT_SIGNED_IN } from './api.js';
import { diffGraph } from './diff.js';
import { clock, h, option } from './dom.js';
import { createGraphView } from './graphview.js';
import { kindOf, shortName, stateOf } from './names.js';
import { connState, nextDelay, POLL_MS, STALE_MS } from './poll.js';
import { boardHash } from './route.js';
import { boardStatus } from './status.js';
import { createToolbar } from './toolbar.js';
import { stripText, totalTitle } from './usage.js';

/**
 * @typedef {{ kind: 'board'; scope: string; board: string } | { kind: 'tag'; tag: string }} Target
 * @typedef {{ scope: string; board: string; state: string | null; goalId: string }} BoardInfo
 * @typedef {{
 *   target: Target;
 *   ctrl: AbortController;
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
 *   again: boolean;
 *   waiters: (() => void)[];
 *   usage: { runs: import('./usage.js').Run[]; total: import('./usage.js').Tokens } | null;
 *   usageAt: number;
 * }} Loop
 * @typedef {import('./status.js').BoardStatus & { truncated: boolean }} ShownStatus
 */

/** How often the board's token usage is re-read: it changes only when a run ends or a lead turn does. */
const USAGE_MS = 30_000;

/** Goal states the strip colours. */
const STATES = ['running', 'paused', 'stopped', 'done'];

/**
 * @param {Element} el
 * @param {{ onSelect(id: string): void; onPoll?(): void }} opts `onPoll` runs after each graph poll that lands
 * @returns {{ showBoard(scope: string, board: string): void; showTag(tag: string): void;
 *   nameOf(id: string): string | null; nodes(): any[]; progressText(): string; status(): ShownStatus | null;
 *   usage(): import('./usage.js').Run[]; pollNow(): Promise<void> }}
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
  const notices = h('div', 'notices');
  // Only the notices are announced: the strip changes its refresh time on every poll.
  notices.setAttribute('aria-live', 'polite');
  const graphEl = h('div', 'graph');
  const toolbar = createToolbar({
    pollNow: () => pollNow(),
    status: () => shownStatus(),
    nodes: () => loop?.prev?.nodes ?? [],
  });
  el.replaceChildren(bar, strip, toolbar.el, notices, graphEl);

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

  /**
   * Put `parts` in the strip. The toolbar's intent limit item stays where it is rather than being taken out and put
   * back, so the limit box keeps focus while the strip redraws around it on each poll.
   * @param {Node[]} parts
   */
  function placeStrip(parts) {
    const i = parts.indexOf(toolbar.limit);
    if (i < 0 || toolbar.limit.parentNode !== strip) {
      strip.replaceChildren(...parts);
      return;
    }
    for (const c of [...strip.childNodes]) if (c !== toolbar.limit) c.remove();
    toolbar.limit.before(...parts.slice(0, i));
    toolbar.limit.after(...parts.slice(i + 1));
  }

  /** @param {Loop} me */
  function renderStrip(me) {
    const t = me.target;
    const nodes = me.prev?.nodes ?? [];
    const parts = [];
    if (t.kind === 'board') {
      const status = boardStatus(nodes, me.goalText, me.progressText);
      const state = status.state ?? 'unknown';
      // The toolbar draws "Intents n of max" itself, with the limit as a button that edits it.
      toolbar.update(me.prev ? { ...status, truncated: !!me.prev.truncated } : null);
      parts.push(
        item(`${t.board} · ${t.scope}`, 'name'),
        item(`State: ${state}`, STATES.includes(state) ? `state state-${state}` : 'state'),
        item(`Round ${status.round ?? 'unknown'}`),
        toolbar.limit,
        item(`Best: ${status.best ?? 'unknown'}`, 'best'),
      );
      if (me.usage) {
        const tokens = item(stripText(me.usage.total), 'tokens');
        tokens.title = totalTitle(me.usage.total);
        parts.push(tokens);
      }
    } else {
      parts.push(item(`Tag ${t.tag}`, 'name'), item(`${nodes.length} memories`));
    }
    if (me.refreshed) parts.push(item(`refreshed ${clock(me.refreshed)}`));
    parts.push(connItem(connState(me.conn, me.refreshed, Date.now())));
    placeStrip(parts);

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

  /** @param {'loading' | 'live' | 'stale' | 'retrying' | 'signed-out'} conn */
  function connItem(conn) {
    const text = {
      loading: 'loading',
      live: 'live',
      stale: 'stale',
      retrying: 'retrying',
      'signed-out': 'not signed in',
    }[conn];
    return item(text, `conn conn-${conn}`);
  }

  /** Stop a loop for good: no further polls, and any request in flight is aborted. @param {Loop} me */
  function cancel(me) {
    me.cancelled = true;
    clearTimeout(me.timer);
    me.ctrl.abort();
    settle(me);
  }

  /** Resolve every `pollNow` promise waiting on this loop. @param {Loop} me */
  function settle(me) {
    for (const done of me.waiters.splice(0)) done();
  }

  function signOut() {
    signedOut = true;
    if (loop) cancel(loop);
    // Nothing more can be written; the toolbar goes, and the strip's limit becomes plain text.
    toolbar.show(null);
    strip.replaceChildren(...[...strip.children].filter((c) => !c.classList.contains('conn')), connItem('signed-out'));
    notices.replaceChildren(h('p', 'notice error', NOT_SIGNED_IN));
  }

  // ── polling ──────────────────────────────────────────────────────

  /** @param {Loop} me */
  async function pollOnce(me) {
    const t = me.target;
    const q = new URLSearchParams({ tags_all: t.kind === 'board' ? `board:${t.board}` : t.tag });
    if (t.kind === 'board') q.set('scope', t.scope);
    const graph = /** @type {any} */ (await getJson(`/graph?${q}`, me.ctrl.signal));
    if (me.cancelled) return;
    if (t.kind === 'board' && Date.now() - me.usageAt >= USAGE_MS) {
      me.usageAt = Date.now();
      try {
        const u = new URLSearchParams({ scope: t.scope, board: t.board });
        me.usage = /** @type {any} */ (await getJson(`/usage?${u}`, me.ctrl.signal));
      } catch {
        // Usage is extra: a failed read keeps the last figures and never stops the graph.
      }
      if (me.cancelled) return;
    }
    const diff = diffGraph(me.prev, graph);
    if (t.kind === 'board') {
      const touched = new Set([...diff.added, ...diff.changed]);
      const goal = graph.nodes.find((/** @type {any} */ n) => kindOf(n.tags) === 'goal');
      const progress = graph.nodes.findLast((/** @type {any} */ n) => kindOf(n.tags) === 'progress');
      // Full content, fetched on first load and whenever the graph says the memory changed.
      if ((goal?.id ?? null) !== me.goalId || (goal && touched.has(goal.id))) {
        me.goalText = goal ? await contentOf(goal.id, me.ctrl.signal) : '';
        if (me.cancelled) return;
        me.goalId = goal?.id ?? null;
      }
      if ((progress?.id ?? null) !== me.progressId || (progress && touched.has(progress.id))) {
        me.progressText = progress ? await contentOf(progress.id, me.ctrl.signal) : '';
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

  /** @param {string} id @param {AbortSignal} signal */
  async function contentOf(id, signal) {
    const res = /** @type {{ memory: { content: string } }} */ (
      await getJson(`/memories/${encodeURIComponent(id)}`, signal)
    );
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
    // A request that hangs leaves the strip saying live: redraw it once the last refresh is old enough to say stale.
    const stale = setTimeout(() => {
      if (!me.cancelled) renderStrip(me);
    }, STALE_MS + 100);
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
      clearTimeout(stale);
      me.busy = false;
    }
    if (me.cancelled) return;
    me.conn = ok ? 'live' : 'retrying';
    if (ok) me.error = null;
    me.delay = nextDelay(me.delay, ok);
    // A throw in the strip, the toolbar or the poll hook must not stop the loop or leave `pollNow` waiters hanging.
    try {
      renderStrip(me);
      if (ok) opts.onPoll?.();
    } catch {
      console.error('Board strip update failed');
    }
    // A write landed while this poll was in flight, so it may predate the write: poll again at once.
    const again = me.again;
    me.again = false;
    if (!again) settle(me);
    me.timer = setTimeout(() => tick(me), again ? 0 : me.delay);
  }

  /**
   * Poll the shown graph now, after a write: the pending timer is dropped and a poll starts, or, while one is in
   * flight, another follows it at once. Never two at a time. While the graph is hidden the poll waits for it to show.
   * @returns {Promise<void>} settles once a poll that started after this call has finished, or the loop has stopped
   */
  function pollNow() {
    const me = loop;
    if (!me || me.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      me.waiters.push(resolve);
      if (me.busy) me.again = true;
      else if (!me.paused) {
        clearTimeout(me.timer);
        tick(me);
      }
    });
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
    if (loop) cancel(loop);
    // A panel or Stop confirmation open for the old board closes, and the new board's toolbar is built afresh.
    toolbar.show(target.kind === 'board' ? { scope: target.scope, board: target.board } : null);
    view?.clear();
    /** @type {Loop} */
    const me = {
      target,
      ctrl: new AbortController(),
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
      again: false,
      waiters: [],
      usage: null,
      usageAt: 0,
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

  /** @returns {ShownStatus | null} */
  function shownStatus() {
    if (!loop?.prev || loop.target.kind !== 'board') return null;
    return { ...boardStatus(loop.prev.nodes, loop.goalText, loop.progressText), truncated: !!loop.prev.truncated };
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
    /** The nodes of the shown graph, for the drawer's "where the board stood" context. */
    nodes: () => loop?.prev?.nodes ?? [],
    /** The full content of the shown board's progress memory, or '' when it is not loaded. */
    progressText: () => loop?.progressText ?? '',
    /** The strip's numbers for the shown board, or null for a tag graph or before the first poll. */
    status: () => shownStatus(),
    /** The shown board's runs with their token counts, or none for a tag graph or before the first read. */
    usage: () => (loop?.target.kind === 'board' ? loop.usage?.runs ?? [] : []),
    pollNow,
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
