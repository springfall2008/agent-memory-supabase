// The detail drawer: one memory, with Memory, Links and Worker log tabs, sliding in over the right of the page.
import { ApiError, getJson, NOT_SIGNED_IN } from './api.js';
import { h } from './dom.js';
import { createLogView } from './logview.js';
import { kindOf, shortName, workerLabel } from './names.js';

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').Memory} Memory
 * @typedef {{ board: string | null; nameOf?: (id: string) => string | null }} DrawerCtx
 * @typedef {'memory' | 'links' | 'log'} TabName
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
  stopLog();
  if (ui) ui.root.hidden = true;
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
  ui.panels.memory.replaceChildren(...memoryPanel(memory));
  ui.panels.links.replaceChildren(...linksPanel(memory, ctx));
  ui.tabs.links.textContent = `Links (${(memory.links?.length ?? 0) + (memory.moreLinks ?? 0)})`;
  selectTab(wanted);

  const label = workerLabel(memory) ?? (kindOf(memory.tags) === 'intent' ? await factLabel(memory) : null);
  if (my !== seq || label === null) return;
  const board = logBoard(label, ctx.board, memory.tags);
  ui.tabs.log.hidden = false;
  if (board === null) {
    ui.panels.log.replaceChildren(
      h('p', 'log-label', `Worker ${label}`),
      h('p', 'drawer-message', 'No local log: this label is not a board runner label'),
    );
  } else {
    log = createLogView({ board, label, claimed: memory.claim !== undefined });
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
 * The board whose runner wrote `label`: the shown board or one the memory is tagged with, when the label is that
 * board's runner label (`board-<board>-<hex4>` or `board-<board>-lead-<hex4>`), else null.
 * @param {string} label
 * @param {string | null} shown
 * @param {string[]} tags
 */
function logBoard(label, shown, tags) {
  const candidates = [shown, ...tags.filter((t) => t.startsWith('board:')).map((t) => t.slice(6))];
  for (const b of candidates) {
    if (!b || !label.startsWith(`board-${b}-`)) continue;
    const rest = label.slice(b.length + 7);
    if (HEX4.test(rest) || (rest.startsWith('lead-') && HEX4.test(rest.slice(5)))) return b;
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

/** @param {Memory} m @returns {HTMLElement[]} */
function memoryPanel(m) {
  const out = [];
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
