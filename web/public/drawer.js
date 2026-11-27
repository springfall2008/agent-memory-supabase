// The detail drawer: one memory, with Memory, Links, Worker log and Diff tabs, sliding in over the right of the page.
import { ApiError, getJson, NOT_SIGNED_IN } from './api.js';
import { h, option } from './dom.js';
import { roundOf } from './bands.js';
import { builtBefore, citations, foundLine, latestMeasurement, measurementVerdict, progressFields } from './facts.js';
import { writeSection } from './forms.js';
import { createLogView } from './logview.js';
import { kindOf, shortName, verdictOf, workerLabel } from './names.js';
import { commitOf, githubCommitUrl } from './commits.js';
import { parsePatch } from './diffparse.js';
import { clampDrawerWidth, DRAWER_MIN, KEY_STEP, parseStoredWidth, WIDTH_KEY } from './resize.js';
import { formatTokens, inputTotal, runsFor } from './usage.js';

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').Memory} Memory
 * @typedef {{
 *   board: string | null;
 *   scope?: string;
 *   nameOf?: (id: string) => string | null;
 *   nodes?: () => import('./facts.js').Node[];
 *   progressText?: () => string;
 *   status?: () => import('./board.js').ShownStatus | null;
 *   pollNow?: () => Promise<void>;
 *   usage?: () => import('./usage.js').Run[];
 * }} DrawerCtx `scope`, `status` and `pollNow` come only from the Board tab's board view, and turn on the drawer's
 *   shortcuts and the goal's amendments
 * @typedef {'memory' | 'links' | 'log' | 'diff'} TabName
 * @typedef {import('./names.js').Verdict} Verdict
 */

const ARROW = { out: '→', in: '←', both: '↔' };
const HEX4 = /^[0-9a-f]{4}$/;
/** How many inbound derived-from links of a done intent are fetched to find the fact that names its worker. */
const FACT_LOOKUPS = 5;

/** Short names of memories this page has fetched, for link buttons. */
const names = new Map();

/** @type {{ root: HTMLElement; title: HTMLElement; tabs: Record<TabName, HTMLElement>; panels: Record<TabName, HTMLElement> } | null} */
let ui = null;
/** Each open bumps the sequence, so a reply for an earlier memory is dropped. */
let seq = 0;
/** The tab the person last chose; the Memory tab stands in while that one is hidden. @type {TabName} */
let wanted = 'memory';
/** @type {{ el: HTMLElement; setActive(on: boolean): void; destroy(): void } | null} */
let log = null;
/** What the shown memory redraws after each graph poll, such as the goal's amendments; each open starts it empty. */
let onGraph = /** @type {(() => void)[]} */ ([]);

function build() {
  const root = h('aside', 'drawer');
  root.hidden = true;
  root.setAttribute('aria-label', 'Memory details');
  const head = h('div', 'drawer-head');
  const title = h('h2', 'drawer-title');
  const close = h('button', 'secondary drawer-close', '✕');
  close.setAttribute('type', 'button');
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close (Escape)';
  close.addEventListener('click', closeDrawer);
  head.append(title, close);

  const bar = h('nav', 'drawer-tabs');
  bar.setAttribute('role', 'tablist');
  const body = h('div', 'drawer-body');
  /** @type {Record<TabName, HTMLElement>} */
  const tabs = /** @type {any} */ ({});
  /** @type {Record<TabName, HTMLElement>} */
  const panels = /** @type {any} */ ({});
  for (
    const [k, text] of /** @type {[TabName, string][]} */ ([
      ['memory', 'Memory'],
      ['links', 'Links'],
      ['log', 'Worker log'],
      ['diff', 'Diff'],
    ])
  ) {
    const b = h('button', '', text);
    b.setAttribute('type', 'button');
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      wanted = k;
      selectTab(k);
    });
    tabs[k] = b;
    panels[k] = h('div', `drawer-panel panel-${k}`);
    panels[k].setAttribute('role', 'tabpanel');
  }
  bar.append(tabs.memory, tabs.links, tabs.log, tabs.diff);
  body.append(panels.memory, panels.links, panels.log, panels.diff);
  root.append(resizer(root), head, bar, body);
  (document.querySelector('main') ?? document.body).append(root);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || root.hidden) return;
    const t = /** @type {Element} */ (e.target);
    // Escape in a field outside the drawer belongs to that field.
    if (t instanceof Element && t.matches('input, select, textarea') && !root.contains(t)) return;
    // Escape in a drawer form with something typed leaves the field rather than throwing the text away.
    if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && root.contains(t) && t.value !== '') {
      t.blur();
      return;
    }
    closeDrawer();
  });
  return { root, title, tabs, panels };
}

/** localStorage, or null where the browser refuses it (private mode, blocked storage). */
function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * The drawer's left edge, which drags to change its width. Arrow keys move it too, a double-click goes back to the
 * default width, and the chosen width is kept for the next visit.
 * @param {HTMLElement} root the drawer
 */
function resizer(root) {
  const grip = h('div', 'drawer-resize');
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', 'Resize the details panel');
  grip.tabIndex = 0;
  grip.title = 'Drag to resize. Double-click for the default width.';
  /** The width the person chose, or null for the default. */
  let chosen = parseStoredWidth(storage()?.getItem(WIDTH_KEY) ?? null);
  const total = () => (root.parentElement ?? document.body).clientWidth;

  function apply() {
    if (chosen === null) {
      root.style.removeProperty('width');
      root.style.removeProperty('min-width');
    } else {
      // The stylesheet's minimum is for the default width; a chosen one has its own limits.
      root.style.minWidth = '0';
      root.style.width = `${clampDrawerWidth(chosen, total())}px`;
    }
    grip.setAttribute('aria-valuemin', String(DRAWER_MIN));
    grip.setAttribute('aria-valuemax', String(clampDrawerWidth(Infinity, total())));
    grip.setAttribute('aria-valuenow', String(Math.round(root.getBoundingClientRect().width)));
  }

  /** @param {number | null} px */
  function choose(px) {
    chosen = px === null ? null : clampDrawerWidth(px, total());
    apply();
    try {
      if (chosen === null) storage()?.removeItem(WIDTH_KEY);
      else storage()?.setItem(WIDTH_KEY, String(chosen));
    } catch {
      // A full or blocked store only means the width is not kept for next time.
    }
  }

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    chosen = clampDrawerWidth(root.getBoundingClientRect().right - e.clientX, total());
    apply();
  });
  /** @param {PointerEvent} e */
  const end = (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    grip.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    choose(chosen);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('lostpointercapture', () => document.body.classList.remove('resizing'));
  grip.addEventListener('dblclick', () => choose(null));
  grip.addEventListener('keydown', (e) => {
    // The drawer is on the right, so moving its edge left makes it wider.
    const step = { ArrowLeft: KEY_STEP, ArrowRight: -KEY_STEP }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    choose(root.getBoundingClientRect().width + step);
  });
  // A smaller window shrinks a chosen width to fit; the choice itself stays for a wider one.
  globalThis.addEventListener('resize', () => {
    if (!root.hidden) apply();
  });
  // Opening the drawer draws the chosen width and the separator's numbers.
  new MutationObserver(() => {
    if (!root.hidden) apply();
  }).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  return grip;
}

/** @param {TabName} k */
function selectTab(k) {
  if (!ui) return;
  if (ui.tabs[k].hidden) k = 'memory';
  for (const n of /** @type {TabName[]} */ (['memory', 'links', 'log', 'diff'])) {
    ui.panels[n].hidden = n !== k;
    ui.tabs[n].setAttribute('aria-selected', String(n === k));
  }
  log?.setActive(k === 'log');
}

function stopLog() {
  log?.destroy();
  log = null;
}

/** Close the drawer and stop any log polling. */
export function closeDrawer() {
  seq++;
  onGraph = [];
  stopLog();
  if (ui) ui.root.hidden = true;
}

/** Redraw what the shown memory draws from the graph, after a graph poll. */
export function refreshDrawer() {
  for (const refresh of onGraph) refresh();
}

/**
 * Show one memory in the drawer, replacing whatever it showed.
 * @param {string} id
 * @param {DrawerCtx} ctx `board` is the board the Board tab shows, or null from Browse and tag views
 * @returns {Promise<void>}
 */
export async function openDrawer(id, ctx) {
  ui ??= build();
  const my = ++seq;
  onGraph = [];
  stopLog();
  ui.root.hidden = false;
  ui.root.dataset.id = id;
  ui.title.textContent = 'Loading…';
  ui.title.title = id;
  ui.tabs.log.hidden = true;
  ui.panels.log.replaceChildren();
  ui.tabs.diff.hidden = true;
  ui.panels.diff.replaceChildren();
  ui.root.classList.remove('drawer-wide');
  ui.panels.links.replaceChildren();
  ui.panels.memory.replaceChildren(h('p', 'drawer-message', 'Loading…'));
  ui.tabs.links.textContent = 'Links';
  selectTab(wanted);

  let memory;
  try {
    memory = /** @type {{ memory: Memory }} */ (await getJson(`/memories/${encodeURIComponent(id)}`)).memory;
  } catch (e) {
    if (my !== seq) return;
    const text = e instanceof ApiError && e.status === 401
      ? NOT_SIGNED_IN
      : e instanceof ApiError && e.status === 404
      ? 'This memory was not found: it may have been deleted, or you cannot read it.'
      : `Error: ${e instanceof Error ? e.message : String(e)}`;
    ui.title.textContent = id;
    ui.panels.memory.replaceChildren(h('p', 'drawer-message error', text));
    selectTab('memory');
    return;
  }
  if (my !== seq) return;
  const name = shortName(memory.content);
  names.set(memory.id, name.label);
  ui.title.textContent = name.full;
  ui.panels.memory.replaceChildren(...memoryPanel(memory, ctx, my));
  ui.panels.links.replaceChildren(...linksPanel(memory, ctx));
  ui.tabs.links.textContent = `Links (${(memory.links?.length ?? 0) + (memory.moreLinks ?? 0)})`;
  const commit = commitOf(memory.content);
  const commitBoard = memory.tags.find((t) => t.startsWith('board:'))?.slice(6);
  if (commit && commitBoard) {
    ui.tabs.diff.hidden = false;
    // A conclusion's commit ends the winning branch: open on everything it adds to main.
    const first = kindOf(memory.tags) === 'conclusion' ? 'main' : 'commit';
    ui.panels.diff.replaceChildren(diffPanel(commitBoard, commit, my, first));
  }
  selectTab(wanted);

  const label = workerLabel(memory) ?? (kindOf(memory.tags) === 'intent' ? await factLabel(memory) : null);
  if (my !== seq || label === null) return;
  const runner = logBoard(label, ctx.board, memory.tags);
  ui.tabs.log.hidden = false;
  if (runner === null) {
    ui.panels.log.replaceChildren(
      h('p', 'log-label', `Worker ${label}`),
      h('p', 'drawer-message', 'No local log: this label is not a board runner label'),
    );
  } else if (runner.lead) {
    // The lead runs interactively in tmux and writes no worker log.
    ui.panels.log.replaceChildren(
      h('p', 'log-label', `Lead ${label}`),
      h('p', 'drawer-message', `The lead runs in the runner's tmux session: tmux attach -t board-${runner.board}`),
    );
  } else {
    log = createLogView({ board: runner.board, label, claimed: memory.claim !== undefined });
    ui.panels.log.replaceChildren(log.el);
  }
  selectTab(wanted);
}

/** A file with more rows than this starts folded: open it from its header. */
const FOLD_ROWS = 400;

/** @typedef {'commit' | 'main'} DiffView */
/** @typedef {'3' | '10' | 'all'} DiffContext */

/**
 * A commit as a side-by-side diff from the board's workspace on this machine, like GitHub's split view: the message
 * (or commit list) on top, then one card per file. "This commit" is the commit alone; "All changes vs main" is
 * everything on top of the base branch, which a conclusion opens on, since its commit ends the winning branch.
 * @param {string} board
 * @param {{ sha: string; branch: string | null }} commit
 * @param {number} my the drawer sequence this panel belongs to
 * @param {DiffView} first the view it opens on
 */
function diffPanel(board, commit, my, first) {
  const el = h('div', 'diff-panel');
  const head = h('div', 'diff-head');
  head.append(h('span', 'diff-sha', commit.sha), commit.branch ? h('span', 'note', ` on ${commit.branch}`) : '');
  const bar = h('div', 'diff-views');
  const message = h('p', 'drawer-message', 'Loading…');
  const out = h('div', 'diff-out');
  /** @type {Record<DiffView, HTMLElement>} */
  const views = {
    commit: h('button', 'secondary', 'This commit'),
    main: h('button', 'secondary', 'All changes vs main'),
  };
  const context = /** @type {HTMLSelectElement} */ (h('select', 'diff-context'));
  context.setAttribute('aria-label', 'Lines of context');
  context.append(option('3', '3 lines of context'), option('10', '10 lines of context'), option('all', 'Whole file'));
  context.value = '10';
  const wide = h('button', 'secondary diff-wide', 'Full width');
  let view = first;
  let request = 0;

  async function load() {
    for (const [k, b] of Object.entries(views)) b.setAttribute('aria-pressed', String(k === view));
    const mine = ++request;
    message.hidden = false;
    message.className = 'drawer-message';
    message.textContent = 'Loading…';
    out.replaceChildren();
    let body;
    try {
      const q = new URLSearchParams({ view, context: context.value });
      const res = await fetch(`/diff/${encodeURIComponent(board)}/${commit.sha}?${q}`);
      body = await res.json();
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
    } catch (e) {
      if (mine !== request || my !== seq) return;
      message.className = 'drawer-message error';
      message.textContent = `${e instanceof Error ? e.message : String(e)}. Diffs come from the board's workspace on ` +
        'the machine that runs it.';
      return;
    }
    if (mine !== request || my !== seq) return;
    message.hidden = !body.truncated;
    message.textContent = body.truncated
      ? 'Cut short: the diff is larger than 2 MB, so the last file is incomplete.'
      : '';
    out.replaceChildren(...splitDiff(body.text));
  }

  for (const [k, b] of Object.entries(views)) {
    b.setAttribute('type', 'button');
    b.addEventListener('click', () => {
      view = /** @type {DiffView} */ (k);
      load();
    });
  }
  context.addEventListener('change', () => load());
  wide.setAttribute('type', 'button');
  wide.setAttribute('aria-pressed', String(!!ui?.root.classList.contains('drawer-wide')));
  wide.addEventListener('click', () => {
    const on = !ui?.root.classList.contains('drawer-wide');
    ui?.root.classList.toggle('drawer-wide', on);
    wide.setAttribute('aria-pressed', String(on));
    wide.textContent = on ? 'Back to my width' : 'Full width';
  });
  bar.append(views.commit, views.main, context, wide);
  el.append(head, bar, message, out);
  load();
  return el;
}

/**
 * The patch as GitHub's split view: the head text (message, commit list, stat), then a card per file.
 * @param {string} text
 * @returns {HTMLElement[]}
 */
function splitDiff(text) {
  const { head, files } = parsePatch(text);
  const nodes = [];
  if (head.trim()) nodes.push(h('pre', 'diff-head-text', head));
  if (files.length === 0) nodes.push(h('p', 'drawer-message', 'No file changes.'));
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  if (files.length) {
    nodes.push(
      h('p', 'diff-summary', `${files.length} file${files.length === 1 ? '' : 's'} changed, +${adds} −${dels}`),
    );
  }
  for (const f of files) nodes.push(fileCard(f));
  return nodes;
}

/** @param {import('./diffparse.js').DiffFile} f */
function fileCard(f) {
  const card = h('section', 'diff-card');
  const header = h('button', 'diff-card-head');
  header.setAttribute('type', 'button');
  const rows = f.hunks.reduce((n, hk) => n + hk.rows.length + 1, 0);
  let open = rows <= FOLD_ROWS;
  const arrow = h('span', 'diff-arrow', open ? '▾' : '▸');
  const path = f.status === 'renamed' && f.oldPath !== f.newPath
    ? `${f.oldPath} → ${f.newPath}`
    : f.newPath ?? f.oldPath ?? '(unknown file)';
  const badge = f.status === 'modified' ? '' : f.status;
  header.append(
    arrow,
    h('span', 'diff-path', path),
    badge ? h('span', `diff-badge diff-badge-${f.status}`, badge) : '',
    h('span', 'diff-count diff-count-add', `+${f.adds}`),
    h('span', 'diff-count diff-count-del', `−${f.dels}`),
  );
  const body = h('div', 'diff-card-body');
  const fill = () => {
    if (body.childElementCount) return;
    if (f.status === 'binary') body.append(h('p', 'note', 'Binary file: not shown.'));
    else if (f.hunks.length === 0) body.append(h('p', 'note', 'No line changes.'));
    else body.append(splitTable(f));
    if (f.incomplete) body.append(h('p', 'drawer-message error', 'This file is cut short.'));
  };
  if (open) fill();
  else body.hidden = true;
  if (!open) header.title = `${rows} lines: open to show`;
  header.addEventListener('click', () => {
    open = !open;
    if (open) fill();
    body.hidden = !open;
    arrow.textContent = open ? '▾' : '▸';
  });
  card.append(header, body);
  return card;
}

/** @param {import('./diffparse.js').DiffFile} f */
function splitTable(f) {
  const table = h('table', 'diff-split');
  const tbody = h('tbody');
  for (const hk of f.hunks) {
    const sep = h('tr', 'diff-hunk-row');
    const td = h('td', '', hk.header);
    td.setAttribute('colspan', '4');
    sep.append(td);
    tbody.append(sep);
    for (const r of hk.rows) {
      const tr = h('tr');
      tr.append(...cells(r.left, 'left'), ...cells(r.right, 'right'));
      tbody.append(tr);
    }
  }
  table.append(tbody);
  return table;
}

/**
 * A side's line number and text cells; an empty side is a blank pair.
 * @param {import('./diffparse.js').Cell | null} c
 * @param {'left' | 'right'} side
 */
function cells(c, side) {
  if (!c) return [h('td', `diff-n diff-empty diff-${side}`), h('td', `diff-code diff-empty diff-${side}`)];
  const kind = c.kind === 'context' ? '' : ` diff-${c.kind}`;
  const code = h('td', `diff-code diff-${side}${kind}`);
  if (c.parts) {
    code.append(...c.parts.map((p) => h('span', p.changed ? 'diff-word' : '', p.text)));
  } else code.textContent = c.text;
  return [h('td', `diff-n diff-${side}${kind}`, String(c.n)), code];
}

/**
 * The worker of a done intent, from the `By:` line of a fact that derives from it.
 * @param {Memory} intent
 * @returns {Promise<string | null>}
 */
async function factLabel(intent) {
  const inbound = (intent.links ?? []).filter((l) => l.type === 'derived-from' && l.direction === 'in');
  for (const l of inbound.slice(0, FACT_LOOKUPS)) {
    try {
      const fact = /** @type {{ memory: Memory }} */ (await getJson(`/memories/${encodeURIComponent(l.memoryId)}`))
        .memory;
      names.set(fact.id, shortName(fact.content).label);
      const label = kindOf(fact.tags) === 'fact' ? workerLabel(fact) : null;
      if (label) return label;
    } catch {
      // an unreadable fact names no worker
    }
  }
  return null;
}

/**
 * The board whose runner made `label`: the shown board or one the memory is tagged with, when the label is that
 * board's worker label (`board-<board>-<hex4>`) or lead label (`board-<board>-lead-<hex4>`), else null.
 * @param {string} label
 * @param {string | null} shown
 * @param {string[]} tags
 * @returns {{ board: string; lead: boolean } | null}
 */
function logBoard(label, shown, tags) {
  const candidates = [shown, ...tags.filter((t) => t.startsWith('board:')).map((t) => t.slice(6))];
  for (const b of candidates) {
    if (!b || !label.startsWith(`board-${b}-`)) continue;
    const rest = label.slice(b.length + 7);
    if (HEX4.test(rest)) return { board: b, lead: false };
    if (rest.startsWith('lead-') && HEX4.test(rest.slice(5))) return { board: b, lead: true };
  }
  return null;
}

/** @param {string} iso */
function when(iso) {
  return new Date(iso).toLocaleString();
}

/**
 * @param {string} label
 * @param {Node | string} value
 */
function row(label, value) {
  const r = h('div', 'kv');
  const v = h('dd');
  v.append(value);
  r.append(h('dt', '', label), v);
  return r;
}

/** @param {number} n */
function exact(n) {
  return n.toLocaleString('en-GB');
}

/** @param {number} ms */
function runTime(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * A count shortened, with the exact figure as its tooltip.
 * @param {number} n
 */
function count(n) {
  const el = h('span', '', formatTokens(n));
  el.title = exact(n);
  return el;
}

/**
 * The token counts of the runs that worked on this memory: raw counts only.
 * @param {import('./usage.js').Run[]} runs
 */
function tokensBlock(runs) {
  const box = h('div', 'drawer-tokens');
  box.append(h('div', 'drawer-tokens-head', runs.length === 1 ? 'Tokens' : `Tokens (${runs.length} runs)`));
  for (const r of runs) {
    const t = r.tokens;
    const meta = h('dl', 'drawer-meta');
    meta.append(
      row('Run', `${r.role} ${r.runLabel}${r.runnerModel ? ` · ${r.runnerModel}` : ''}`),
      row('In', count(inputTotal(t))),
      row('Fresh input', count(t.input)),
      row('Cache read', count(t.cacheRead)),
      row('Cache write', count(t.cacheWrite)),
      row('Out', count(t.output)),
    );
    if (r.turns != null) meta.append(row('Turns', String(r.turns)));
    if (r.durationMs != null) meta.append(row('Run time', runTime(r.durationMs)));
    box.append(meta);
  }
  return box;
}

/**
 * @param {Memory} m
 * @param {DrawerCtx} ctx
 * @param {number} my the drawer sequence this panel belongs to
 * @returns {HTMLElement[]}
 */
function memoryPanel(m, ctx, my) {
  const out = [];
  const context = contextFor(m, ctx, my);
  if (context) out.push(context);
  if (m.superseded) out.push(h('p', 'notice', 'Superseded: a newer memory replaces this one.'));
  const tags = h('span', 'drawer-tags');
  tags.append(...m.tags.map((t) => h('span', 'chip chip-plain', t)));
  const meta = h('dl', 'drawer-meta');
  meta.append(
    row('Scope', m.scope),
    row('Category', m.category),
    row('Tags', m.tags.length ? tags : '(none)'),
    row('Created', `${when(m.createdAt)} by ${m.createdBy}${m.createdSession ? ` (${m.createdSession})` : ''}`),
    row('Updated', `${when(m.updatedAt)} by ${m.updatedBy}${m.updatedSession ? ` (${m.updatedSession})` : ''}`),
    row('ID', m.id),
  );
  out.push(meta);
  if (m.claim) {
    const c = m.claim;
    const holder = workerLabel({ claim: c }) ?? c.by;
    const box = h('div', 'drawer-claim');
    box.append(
      h(
        'div',
        'drawer-claim-head',
        `Claimed by ${holder}${holder !== c.by ? ` (${c.by})` : ''}${c.mine ? ', you' : ''}`,
      ),
      h('div', 'note', c.until ? `until ${when(c.until)}` : 'indefinitely'),
      h('div', 'drawer-claim-desc', c.description),
    );
    out.push(box);
  }
  out.push(h('div', 'drawer-content', m.content));
  const commit = commitOf(m.content);
  const url = commit ? githubCommitUrl(ctx.status?.()?.repo ?? null, commit.sha) : null;
  if (commit && url) {
    const a = /** @type {HTMLAnchorElement} */ (h('a', 'github-link', 'View on GitHub (if pushed)'));
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = `${commit.sha} on GitHub: it shows once the branch has been pushed`;
    const line = h('p', 'drawer-github');
    line.append(a);
    out.push(line);
  }
  const runs = ctx.usage ? runsFor(ctx.usage(), m) : [];
  if (runs.length) out.push(tokensBlock(runs));
  const { board, scope, nodes, status, pollNow } = ctx;
  if (board && scope && nodes && status && pollNow) {
    const hooks = {
      live: () => my === seq,
      open: (/** @type {string} */ id) => openDrawer(id, ctx),
      onGraph: (/** @type {() => void} */ refresh) => onGraph.push(() => my === seq && refresh()),
    };
    out.push(...writeSection(m, { board, scope, nodes, status, pollNow }, hooks));
  }
  return out;
}

/** @param {Memory} m @param {DrawerCtx} ctx @returns {HTMLElement[]} */
function linksPanel(m, ctx) {
  const links = m.links ?? [];
  if (links.length === 0) return [h('p', 'drawer-message', 'No links that you can see.')];
  const list = h('div', 'drawer-links');
  for (const l of links) {
    const b = h('button', 'secondary drawer-link');
    b.setAttribute('type', 'button');
    const name = ctx.nameOf?.(l.memoryId) ?? names.get(l.memoryId) ?? l.memoryId.slice(0, 8);
    b.append(
      h('span', 'link-dir', ARROW[l.direction]),
      h('span', 'link-type', l.type),
      h('span', 'link-name', name),
    );
    b.title = `${l.direction === 'in' ? 'From' : l.direction === 'out' ? 'To' : 'With'} ${l.memoryId}`;
    b.addEventListener('click', () => openDrawer(l.memoryId, ctx));
    list.append(b);
  }
  const out = [list];
  if (m.moreLinks) out.push(h('p', 'note', `+${m.moreLinks} more`));
  return out;
}

// ── where the board stood ─────────────────────────────────────────

/** @param {Verdict | null} v */
function dot(v) {
  const d = h('span', `verdict-dot dot-${v ?? 'none'}`);
  d.setAttribute('aria-hidden', 'true');
  return d;
}

/** @param {string} id @returns {Promise<Memory | null>} null when the memory cannot be read */
async function fetchMemory(id) {
  try {
    const m = /** @type {{ memory: Memory }} */ (await getJson(`/memories/${encodeURIComponent(id)}`)).memory;
    names.set(m.id, shortName(m.content).label);
    return m;
  } catch {
    return null;
  }
}

/**
 * The verdict of a fact or measurement: its tag, else read from a measurement's "passed"/"failed".
 * @param {string[]} tags
 * @param {string} text
 */
function verdictFor(tags, text) {
  return verdictOf(tags) ?? measurementVerdict(text);
}

/**
 * A button that opens another memory in the drawer: a verdict dot, the one-line result, and an optional second line.
 * @param {string} id
 * @param {Verdict | null} verdict
 * @param {string} result
 * @param {string | null} detail
 * @param {DrawerCtx} ctx
 */
function jump(id, verdict, result, detail, ctx) {
  const b = h('button', 'secondary drawer-cite');
  b.setAttribute('type', 'button');
  const text = h('span', 'cite-text');
  text.append(h('span', 'cite-result', result));
  if (detail) text.append(h('span', 'cite-detail', detail));
  b.append(dot(verdict), text);
  b.title = id;
  b.addEventListener('click', () => openDrawer(id, ctx));
  return b;
}

/** @param {string} label @param {HTMLElement[]} body */
function contextRow(label, body) {
  const r = h('div', 'context-row');
  r.append(h('div', 'context-label', label), ...body);
  return r;
}

/**
 * The block above the Memory tab's details that says where the board stood: the starting point of an intent, the
 * result of a fact, the progress of a goal. Null for any other memory. Fetches fill it in after it is returned, and
 * only while the drawer still shows this memory.
 * @param {Memory} m
 * @param {DrawerCtx} ctx
 * @param {number} my
 * @returns {HTMLElement | null}
 */
function contextFor(m, ctx, my) {
  const kind = kindOf(m.tags);
  if (kind === 'fact') return factResult(m);
  if (kind === 'intent') return intentStart(m, ctx, my);
  if (kind === 'goal') return goalProgress(m, ctx, my);
  return null;
}

/** @param {Memory} m */
function factResult(m) {
  const verdict = verdictFor(m.tags, m.content);
  const box = h('div', `drawer-context result-${verdict ?? 'none'}`);
  const found = foundLine(m.content);
  box.append(
    h('div', 'context-label', verdict ? `Result: ${verdict}` : 'Result'),
    h('div', 'result-first', shortName(m.content).full),
  );
  if (found) box.append(h('div', 'result-found', found));
  return box;
}

/**
 * @param {Memory} m
 * @param {DrawerCtx} ctx
 * @param {number} my
 */
function intentStart(m, ctx, my) {
  const box = h('div', 'drawer-context');
  box.append(h('div', 'context-title', 'Starting point'));
  // Times from the drawn graph leave out, before any fetch, a memory made after the intent (such as a later hint).
  const drawn = new Map((ctx.nodes?.() ?? []).map((n) => [n.id, n.createdAt]));
  const cited = citations(m.links, undefined, { before: m.createdAt, createdAt: (id) => drawn.get(id) ?? null });
  const builds = h('div', 'context-body');
  const nothing = () =>
    h(
      'p',
      'note',
      m.moreLinks
        ? 'Builds on: not shown.'
        : roundOf(m.tags) === 1
        ? 'First round: built on nothing earlier.'
        : 'Cites nothing earlier.',
    );
  if (cited.ids.length === 0) {
    builds.append(nothing());
  } else {
    builds.append(h('p', 'note', 'Loading what it builds on…'));
    Promise.all(cited.ids.map(fetchMemory)).then((found) => {
      if (my !== seq) return;
      const rows = found.flatMap((f, i) => {
        if (f === null) return [h('p', 'note', `${cited.ids[i].slice(0, 8)}: not readable`)];
        // A memory not drawn on the graph is checked once its time is known.
        if (!builtBefore(f, m)) return [];
        return [jump(f.id, verdictFor(f.tags, f.content), shortName(f.content).full, foundLine(f.content), ctx)];
      });
      if (cited.more > 0) rows.push(h('p', 'note', `+${cited.more} more`));
      builds.replaceChildren(...(rows.length ? rows : [nothing()]));
    });
  }
  box.append(contextRow('Builds on', [builds]));
  if (ctx.nodes) box.append(contextRow('Measured before this', [measuredBefore(ctx, m.createdAt)]));
  return box;
}

/**
 * @param {DrawerCtx} ctx
 * @param {string | null} before
 */
function measuredBefore(ctx, before) {
  const n = latestMeasurement(ctx.nodes?.() ?? [], before);
  if (n === null) {
    return h('p', 'note', before === null ? 'Nothing measured yet.' : 'Nothing measured before this intent.');
  }
  const text = n.snippet ?? n.content ?? '';
  return jump(n.id, verdictFor(n.tags, text), shortName(text).full, `measured ${when(n.createdAt)}`, ctx);
}

/**
 * @param {Memory} m
 * @param {DrawerCtx} ctx
 * @param {number} my
 */
function goalProgress(m, ctx, my) {
  const box = h('div', 'drawer-context');
  box.append(h('div', 'context-title', 'Progress'));
  const body = h('div', 'context-body');
  box.append(body);
  /** @param {string} text */
  const show = (text) => {
    const p = progressFields(text);
    const rows = /** @type {[string, string | null][]} */ ([
      ['Round', p.round],
      ['Best result', p.best],
      ['Established', p.established],
      ['Open questions', p.open],
    ]).map(([k, v]) => contextRow(k, [h('div', 'context-value', v ?? 'unknown')]));
    const last = ctx.nodes ? [contextRow('Latest measurement', [measuredBefore(ctx, null)])] : [];
    body.replaceChildren(...rows, ...last);
  };
  const known = ctx.progressText?.() ?? '';
  if (known !== '') {
    show(known);
    return box;
  }
  body.append(h('p', 'note', 'Loading progress…'));
  // The Board tab has not loaded the progress memory (Browse, or the first poll): find it through the goal's links.
  const ids = (m.links ?? []).filter((l) => l.type === 'depends-on' && l.direction === 'in').slice(0, FACT_LOOKUPS);
  Promise.all(ids.map((l) => fetchMemory(l.memoryId))).then((found) => {
    if (my !== seq) return;
    const progress = found.find((f) => f !== null && kindOf(f.tags) === 'progress');
    if (progress) show(progress.content);
    else body.replaceChildren(h('p', 'note', 'No progress memory that you can read.'));
  });
  return box;
}
