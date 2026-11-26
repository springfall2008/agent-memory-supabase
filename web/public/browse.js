// The Browse tab: search or browse memories, with scope, tag and category filters.
import { ApiError, getJson, NOT_SIGNED_IN } from './api.js';
import { h, option } from './dom.js';

// Matches MEMORY_CATEGORIES in supabase/functions/_shared/types.ts; web-api rejects anything else.
const CATEGORIES = [
  'code-solution',
  'bug-fix',
  'architecture',
  'learning',
  'tool-usage',
  'debugging',
  'performance',
  'security',
  'observation',
  'personal',
  'relationship',
  'other',
];
const PAGE_SIZES = [25, 50, 100, 400];
const DEFAULT_PAGE = 50;
const RANKED_MAX = 100;
const EXCERPT_CHARS = 160;

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').Memory} Memory
 */

/** @param {string} label @param {HTMLElement} control */
function labelled(label, control) {
  const l = h('label', 'field');
  l.append(h('span', 'field-label', label), control);
  return l;
}

/**
 * @param {string} cls
 * @param {[string, string][]} options
 * @returns {HTMLSelectElement}
 */
function select(cls, options) {
  const s = /** @type {HTMLSelectElement} */ (h('select', cls));
  s.append(...options.map(([v, t]) => option(v, t)));
  return s;
}

/**
 * @param {Element} el
 * @param {{ onSelect(id: string): void; onGraphTag(tag: string): void }} opts
 */
export function mountBrowse(el, opts) {
  const form = /** @type {HTMLFormElement} */ (h('form', 'browse-controls'));
  const q = /** @type {HTMLInputElement} */ (h('input', 'search'));
  q.type = 'search';
  q.placeholder = 'Search text (empty: newest first)';
  q.setAttribute('aria-label', 'Search');
  const scope = select('scope', [['', 'All scopes']]);
  const tags = /** @type {HTMLInputElement} */ (h('input', 'tags'));
  tags.placeholder = 'tag, tag';
  const tagMode = select('tag-mode', [['any', 'any'], ['all', 'all']]);
  const category = select('category', [
    ['', 'Any category'],
    ...CATEGORIES.map((c) => /** @type {[string, string]} */ ([c, c])),
  ]);
  const pageSize = select('page-size', PAGE_SIZES.map((n) => /** @type {[string, string]} */ ([String(n), String(n)])));
  pageSize.value = String(DEFAULT_PAGE);
  const go = h('button', '', 'Search');
  go.setAttribute('type', 'submit');
  form.append(
    labelled('Search', q),
    labelled('Scope', scope),
    labelled('Tags', tags),
    labelled('Match', tagMode),
    labelled('Category', category),
    labelled('Page size', pageSize),
    go,
  );

  const message = h('p', 'message');
  const table = h('table', 'results');
  const head = h('thead');
  const headRow = h('tr');
  headRow.append(...['Created', 'Scope', 'Category', 'Tags', 'Memory'].map((t) => h('th', '', t)));
  head.append(headRow);
  const body = h('tbody');
  table.append(head, body);
  const moreBtn = h('button', 'secondary more', 'Load more');
  moreBtn.setAttribute('type', 'button');
  moreBtn.hidden = true;
  el.replaceChildren(form, message, table, moreBtn);

  /** Each request gets a number; a response for an older one is dropped. */
  let seq = 0;
  /** What the rows on screen came from: the query, the limit asked for, and (browse) the rows loaded. */
  let state = { text: '', limit: DEFAULT_PAGE, loaded: 0 };

  function params() {
    const p = new URLSearchParams();
    if (scope.value) p.set('scope', scope.value);
    const list = tags.value.split(',').map((t) => t.trim()).filter((t) => t !== '').join(',');
    if (list) p.set(tagMode.value === 'all' ? 'tags_all' : 'tags', list);
    if (category.value) p.set('category', category.value);
    return p;
  }

  /**
   * @param {{ append: boolean }} how append a browse page at the current offset, or replace the rows
   */
  async function run(how) {
    const my = ++seq;
    const size = Number(pageSize.value);
    const p = params();
    const text = how.append ? state.text : q.value.trim();
    if (text) {
      p.set('q', text);
      p.set('limit', String(how.append ? Math.min(state.limit + size, RANKED_MAX) : Math.min(size, RANKED_MAX)));
    } else {
      p.set('limit', String(size));
      if (how.append) p.set('offset', String(state.loaded));
    }
    message.textContent = 'Loading…';
    moreBtn.setAttribute('disabled', '');
    try {
      const res = /** @type {{ memories: Memory[]; hasMore: boolean }} */ (await getJson(`/memories?${p}`));
      if (my !== seq) return;
      const limit = Number(p.get('limit'));
      // Ranked "show more" asks again with a bigger limit, so it replaces the rows.
      const appending = how.append && !text;
      if (!appending) body.replaceChildren();
      body.append(...res.memories.map(row));
      state = { text, limit, loaded: (appending ? state.loaded : 0) + res.memories.length };
      if (text) {
        moreBtn.textContent = 'Show more';
        moreBtn.hidden = false;
        if (limit < RANKED_MAX && res.memories.length >= limit) moreBtn.removeAttribute('disabled');
      } else {
        moreBtn.textContent = 'Load more';
        moreBtn.hidden = !res.hasMore;
        moreBtn.removeAttribute('disabled');
      }
      message.textContent = state.loaded ? '' : 'No memories match.';
    } catch (e) {
      if (my !== seq) return;
      message.textContent = e instanceof ApiError && e.status === 401
        ? NOT_SIGNED_IN
        : `Error: ${e instanceof Error ? e.message : String(e)}`;
      moreBtn.removeAttribute('disabled');
    }
  }

  /** @param {Memory} m */
  function row(m) {
    const tr = h('tr', 'row');
    tr.tabIndex = 0;
    tr.dataset.id = m.id;
    const created = h('td', 'created', new Date(m.createdAt).toLocaleString());
    created.title = m.createdAt;
    const chips = h('td', 'tags');
    for (const t of m.tags) {
      const chip = h('span', 'chip');
      const graph = h('button', 'chip-graph', 'Graph');
      graph.setAttribute('type', 'button');
      graph.title = `Show the graph of ${t}`;
      graph.dataset.tag = t;
      chip.append(h('span', 'chip-text', t), graph);
      chips.append(chip);
    }
    const first = m.content.trimStart().split(/\r?\n/, 1)[0];
    const excerpt = first.length > EXCERPT_CHARS ? `${first.slice(0, EXCERPT_CHARS - 1)}…` : first;
    tr.append(created, h('td', 'scope', m.scope), h('td', 'category', m.category), chips, h('td', 'excerpt', excerpt));
    return tr;
  }

  body.addEventListener('click', (e) => {
    const target = /** @type {Element} */ (e.target);
    const graph = target.closest('.chip-graph');
    if (graph instanceof HTMLElement && graph.dataset.tag) {
      opts.onGraphTag(graph.dataset.tag);
      return;
    }
    const tr = target.closest('tr.row');
    if (tr instanceof HTMLElement && tr.dataset.id) opts.onSelect(tr.dataset.id);
  });
  body.addEventListener('keydown', (e) => {
    const target = /** @type {Element} */ (e.target);
    if (e.key === 'Enter' && target instanceof HTMLElement && target.matches('tr.row') && target.dataset.id) {
      opts.onSelect(target.dataset.id);
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run({ append: false });
  });
  for (const s of [scope, tags, tagMode, category, pageSize]) {
    s.addEventListener('change', () => run({ append: false }));
  }
  moreBtn.addEventListener('click', () => run({ append: true }));

  getJson('/scopes').then((res) => {
    const scopes = /** @type {{ scopes: { scope: string; memoryCount: number }[] }} */ (res).scopes;
    scope.append(...scopes.map((s) => option(s.scope, `${s.scope} (${s.memoryCount})`)));
  }).catch((e) => {
    if (e instanceof ApiError && e.status === 401) message.textContent = NOT_SIGNED_IN;
  });
  run({ append: false });
}
