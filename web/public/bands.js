// @ts-check
// Where each node of a board graph goes: the goal on top, then one band per round in time order (the round's intents
// on a row, each intent's results beneath it), then the conclusion. Also the drawn goal links, whether a poll changed
// the structure, and the fit viewport. Fixed pixel spacing, never relative to the viewport. No DOM.
import { kindOf } from './names.js';

/** Width of one intent column (labels wrap at 150 px). */
export const COL_W = 180;
/** From an intent row down to its first result. */
const ROW_H = 100;
/** Between results stacked under one intent, and between rows of a side lane. */
const RESULT_GAP = 60;
/** From a band's top edge to its first row, leaving room for the band label. */
const BAND_TOP = 45;
/** From a band's last row to its bottom edge, leaving room for that row's labels. */
const BAND_BOTTOM = 50;
/** A side lane wraps into a new column after this many rows, or after the band's deepest result stack if deeper. */
const LANE_MIN_ROWS = 3;
/** The kinds in the header band: the goal, with its rules, progress and amendments beside it. */
const HEADER = ['goal', 'rules', 'progress', 'amendment'];
/** Untagged intents further apart in time than this start a new band. */
export const GAP_MS = 2 * 60 * 1000;

/**
 * @typedef {{ id: string; tags: string[]; createdAt: string; snippet?: string; content?: string }} LayoutNode
 * @typedef {{ from: string; to: string; type: string }} LayoutEdge
 * @typedef {{ nodes: LayoutNode[]; edges: LayoutEdge[] }} LayoutGraph
 * @typedef {{ x: number; y: number }} Point
 * @typedef {{ label: string; y: number; height: number }} Band
 * @typedef {{ round: number | null; intents: LayoutNode[]; start: number; end: number }} Group
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} Box
 * @typedef {{ zoom: number; pan: { x: number; y: number } }} Viewport
 */

/** @param {LayoutNode} n */
const time = (n) => Date.parse(n.createdAt);

/** Oldest first, then by id, so equal times still sort the same way every time. @param {LayoutNode} a @param {LayoutNode} b */
const byTime = (a, b) => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The round an intent's `round:<n>` tag gives, or null.
 * @param {string[]} tags
 * @returns {number | null}
 */
export function roundOf(tags) {
  for (const t of tags) {
    const m = /^round:(\d+)$/.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

/** @param {LayoutNode[]} intents @param {number | null} round @returns {Group} */
const group = (intents, round) => ({
  round,
  intents,
  start: Math.min(...intents.map(time)),
  end: Math.max(...intents.map(time)),
});

/**
 * The intents' bands in time order. A tagged intent goes to its `round:<n>`. Untagged intents, oldest first, start a
 * new group after a gap of more than GAP_MS; a group whose times overlap a tagged round's, or come within GAP_MS of
 * them, joins the nearest such round, else it is a band of its own.
 * @param {LayoutNode[]} intents
 * @returns {Group[]}
 */
export function roundGroups(intents) {
  /** @type {Map<number, LayoutNode[]>} */
  const tagged = new Map();
  /** @type {LayoutNode[]} */
  const untagged = [];
  for (const n of intents) {
    const r = roundOf(n.tags);
    if (r === null) untagged.push(n);
    else tagged.set(r, [...(tagged.get(r) ?? []), n]);
  }
  const rounds = [...tagged].map(([r, list]) => group(list, r));
  /** @type {LayoutNode[][]} */
  const gaps = [];
  for (const n of untagged.sort(byTime)) {
    const last = gaps.at(-1);
    if (last && time(n) - time(/** @type {LayoutNode} */ (last.at(-1))) <= GAP_MS) last.push(n);
    else gaps.push([n]);
  }
  /** @type {Group[]} */
  const own = [];
  /** @type {Map<Group, LayoutNode[]>} */
  const joins = new Map();
  for (const list of gaps) {
    const g = group(list, null);
    let best = null;
    let bestGap = Infinity;
    for (const r of rounds) {
      const gap = Math.max(0, r.start - g.end, g.start - r.end);
      if (gap <= GAP_MS && gap < bestGap) [best, bestGap] = [r, gap];
    }
    if (best) joins.set(best, [...(joins.get(best) ?? []), ...list]);
    else own.push(g);
  }
  const all = [...rounds.map((r) => group([...r.intents, ...(joins.get(r) ?? [])], r.round)), ...own];
  for (const g of all) g.intents.sort(byTime);
  return all.sort((a, b) =>
    a.start - b.start || (a.round ?? Infinity) - (b.round ?? Infinity) || byTime(a.intents[0], b.intents[0])
  );
}

/** @param {LayoutNode} n */
const isPartialResult = (n) => (n.snippet ?? n.content ?? '').trimStart().startsWith('Partial result for intent');

/**
 * Positions for every node, and the bands to draw behind them.
 * 1. Header: the goal at (0, top row), rules, progress, amendments (and any other goal) beside it, oldest first,
 *    right then left.
 * 2. One band per round (`roundGroups`): its intents on one row, centred on x = 0, ordered by the mean x of the
 *    already-placed nodes each cites (`derived-from` / `relates-to`), then the ones citing nothing placed, by time.
 * 3. Under each intent, in creation order: facts `derived-from` it and `Partial result for intent` hints
 *    `relates-to` it. One linked to several intents goes under the earliest.
 * 4. Everything else goes to a side lane right of the intent columns of the last band that started at or before it
 *    was created (the first band if none), starting on the results row and wrapping into further columns.
 * 5. Conclusions in a band of their own at the bottom, centred.
 * With no intents at all (a tag graph, or a board not yet planned), the rest is a square-ish grid in one band.
 * Deterministic. A node added to the newest band moves nothing in earlier bands.
 * @param {LayoutGraph} graph
 * @returns {{ positions: Record<string, Point>; bands: Band[] }}
 */
export function bandLayout(graph) {
  const nodes = [...graph.nodes].sort(byTime);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** @param {string} id */
  const kind = (id) => kindOf(byId.get(id)?.tags ?? []);
  /** @type {Map<string, LayoutEdge[]>} */
  const out = new Map();
  for (const e of graph.edges) {
    if (byId.has(e.from) && byId.has(e.to)) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  }
  /** @type {Record<string, Point>} */
  const positions = {};
  /** @type {Band[]} */
  const bands = [];
  let top = 0;
  /** @param {string} label @param {number} rows how many rows below the band's first */
  const closeBand = (label, rows) => {
    const height = BAND_TOP + (rows > 0 ? ROW_H + (rows - 1) * RESULT_GAP : 0) + BAND_BOTTOM;
    bands.push({ label, y: top, height });
    top += height;
  };

  // 1. Header.
  const goal = nodes.find((n) => kind(n.id) === 'goal');
  const beside = nodes.filter((n) => n !== goal && HEADER.includes(kind(n.id)));
  if (goal || beside.length) {
    if (goal) positions[goal.id] = { x: 0, y: BAND_TOP };
    beside.forEach((n, k) => {
      positions[n.id] = { x: (k % 2 ? -1 : 1) * (Math.floor(k / 2) + 1) * COL_W, y: BAND_TOP };
    });
    closeBand('Goal', 0);
  }

  // 3. Which results sit under which intent.
  /** @type {Map<string, LayoutNode[]>} */
  const under = new Map();
  const isResult = new Set();
  for (const n of nodes) {
    const k = kind(n.id);
    const type = k === 'fact' ? 'derived-from' : k === 'hint' && isPartialResult(n) ? 'relates-to' : null;
    if (!type) continue;
    const parents = (out.get(n.id) ?? []).filter((e) => e.type === type && kind(e.to) === 'intent')
      .map((e) => /** @type {LayoutNode} */ (byId.get(e.to))).sort(byTime);
    if (!parents.length) continue;
    under.set(parents[0].id, [...(under.get(parents[0].id) ?? []), n]);
    isResult.add(n.id);
  }

  // 4. Everything else, to the band whose time it falls in.
  const groups = roundGroups(nodes.filter((n) => kind(n.id) === 'intent'));
  const placedElsewhere = new Set([...HEADER, 'intent', 'conclusion']);
  const rest = nodes.filter((n) => !placedElsewhere.has(kind(n.id)) && !isResult.has(n.id));
  /** @type {LayoutNode[][]} */
  const lanes = groups.map(() => []);
  for (const n of rest) {
    let i = 0;
    groups.forEach((g, j) => {
      if (g.start <= time(n)) i = j;
    });
    lanes[i]?.push(n);
  }

  // 2. The round bands.
  groups.forEach((g, gi) => {
    const rowY = top + BAND_TOP;
    const cited = (/** @type {LayoutNode} */ n) =>
      (out.get(n.id) ?? []).filter((e) => e.type === 'derived-from' || e.type === 'relates-to')
        .map((e) => positions[e.to]).filter(Boolean);
    const keyed = g.intents.map((n) => {
      const xs = cited(n).map((p) => p.x);
      return { n, x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null };
    });
    const order = [
      ...keyed.filter((k) => k.x !== null).sort((a, b) =>
        /** @type {number} */ (a.x) - /** @type {number} */ (b.x) ||
          byTime(a.n, b.n)
      ),
      ...keyed.filter((k) => k.x === null),
    ].map((k) => k.n);
    const colX = (/** @type {number} */ i) => (i - (order.length - 1) / 2) * COL_W;
    let depth = 0;
    order.forEach((n, i) => {
      positions[n.id] = { x: colX(i), y: rowY };
      const results = under.get(n.id) ?? [];
      results.forEach((r, k) => {
        positions[r.id] = { x: colX(i), y: rowY + ROW_H + k * RESULT_GAP };
      });
      depth = Math.max(depth, results.length);
    });
    const lane = lanes[gi];
    const laneRows = Math.max(depth, LANE_MIN_ROWS);
    lane.forEach((n, k) => {
      positions[n.id] = {
        x: colX(order.length - 1) + COL_W * (1 + Math.floor(k / laneRows)),
        y: rowY + ROW_H + (k % laneRows) * RESULT_GAP,
      };
    });
    closeBand(
      g.round !== null ? `Round ${g.round}` : `Batch ${gi + 1}`,
      Math.max(depth, Math.min(lane.length, laneRows)),
    );
  });

  // No intents: the rest as a grid.
  if (!groups.length && rest.length) {
    const cols = Math.ceil(Math.sqrt(rest.length));
    rest.forEach((n, k) => {
      positions[n.id] = {
        x: (k % cols - (cols - 1) / 2) * COL_W,
        y: top + BAND_TOP + Math.floor(k / cols) * RESULT_GAP * 1.5,
      };
    });
    const rows = Math.ceil(rest.length / cols);
    bands.push({ label: 'Other', y: top, height: BAND_TOP + (rows - 1) * RESULT_GAP * 1.5 + BAND_BOTTOM });
    top += bands[bands.length - 1].height;
  }

  // 5. Conclusions.
  const ends = nodes.filter((n) => kind(n.id) === 'conclusion');
  if (ends.length) {
    ends.forEach((n, k) => {
      positions[n.id] = { x: (k - (ends.length - 1) / 2) * COL_W, y: top + BAND_TOP };
    });
    closeBand('Conclusion', 0);
  }
  return { positions, bands };
}

/**
 * A drawn goal link for each intent with no link of its own up to anything (a first-round intent cites nothing), so
 * the board reads as one piece. With no goal there are none.
 * @param {LayoutGraph} graph
 * @returns {{ parent: string; child: string }[]}
 */
export function goalLinks(graph) {
  const goal = [...graph.nodes].sort(byTime).find((n) => kindOf(n.tags) === 'goal');
  if (!goal) return [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const linksUp = new Set(graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => e.from));
  return graph.nodes.filter((n) => kindOf(n.tags) === 'intent' && !linksUp.has(n.id))
    .map((n) => ({ parent: goal.id, child: n.id }));
}

/** @param {LayoutEdge} e */
export const edgeKey = (e) => `${e.from}|${e.to}|${e.type}`;

/**
 * Whether the drawn structure changed: a node added or removed (from `diffGraph`), or a link added or removed. Changed
 * nodes alone (claims, tags, snippets) do not change it, so such a poll moves nothing.
 * @param {{ added: string[]; removed: string[] }} diff
 * @param {LayoutEdge[]} before
 * @param {LayoutEdge[]} after
 * @returns {boolean}
 */
export function structureChanged(diff, before, after) {
  if (diff.added.length || diff.removed.length) return true;
  const a = new Set(before.map(edgeKey));
  const b = new Set(after.map(edgeKey));
  return a.size !== b.size || [...b].some((k) => !a.has(k));
}

/**
 * The viewport that centres `box` in a `width` × `height` view with `padding` on every side, zoomed to fit but never
 * beyond `maxZoom` (a small board keeps a readable size instead of being blown up) nor below `minZoom`.
 * @param {Box} box in model coordinates
 * @param {number} width
 * @param {number} height
 * @param {{ padding: number; minZoom: number; maxZoom: number }} opts
 * @returns {Viewport}
 */
export function fitViewport(box, width, height, opts) {
  const w = Math.max(box.x2 - box.x1, 1);
  const h = Math.max(box.y2 - box.y1, 1);
  const fit = Math.min((width - 2 * opts.padding) / w, (height - 2 * opts.padding) / h);
  const zoom = Math.max(opts.minZoom, Math.min(opts.maxZoom, fit));
  return {
    zoom,
    pan: { x: (width - zoom * (box.x1 + box.x2)) / 2, y: (height - zoom * (box.y1 + box.y2)) / 2 },
  };
}

/**
 * Whether two viewports are the same, to tell whether the person panned or zoomed since the last fit.
 * @param {Viewport} a
 * @param {Viewport} b
 */
export function sameViewport(a, b) {
  const near = (/** @type {number} */ x, /** @type {number} */ y) => Math.abs(x - y) < 1e-6 * Math.max(1, Math.abs(x));
  return near(a.zoom, b.zoom) && near(a.pan.x, b.pan.x) && near(a.pan.y, b.pan.y);
}
