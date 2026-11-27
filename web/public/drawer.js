// The detail drawer: one memory, with Memory, Links and Worker log tabs, sliding in over the right of the page.
import { ApiError, getJson, NOT_SIGNED_IN } from './api.js';
import { h } from './dom.js';
import { roundOf } from './bands.js';
import { builtBefore, citations, foundLine, latestMeasurement, measurementVerdict, progressFields } from './facts.js';
import { writeSection } from './forms.js';
import { createLogView } from './logview.js';
import { kindOf, shortName, verdictOf, workerLabel } from './names.js';

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
 * }} DrawerCtx `scope`, `status` and `pollNow` come only from the Board tab's board view, and turn on the drawer's
 *   shortcuts and the goal's amendments
 * @typedef {'memory' | 'links' | 'log'} TabName
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
    const [k, text] of /** @type {[TabName, string][]} */ ([['memory', 'Memory'], ['links', 'Links'], [
      'log',
      'Worker log',
    ]])
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
  bar.append(tabs.memory, tabs.links, tabs.log);
  body.append(panels.memory, panels.links, panels.log);
  root.append(head, bar, body);
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

/** @param {TabName} k */
function selectTab(k) {
  if (!ui) return;
  if (ui.tabs[k].hidden) k = 'memory';
  for (const n of /** @type {TabName[]} */ (['memory', 'links', 'log'])) {
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
