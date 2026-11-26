// The Cytoscape graph of a board: styling, the band layout (`bands.js`) applied with the preset layout, and applying a
// diff, moving nodes only when the structure changed.
import { bandLayout, COL_W, edgeKey, fitViewport, goalLinks, sameViewport, structureChanged } from './bands.js';
import { kindOf, shortName, verdictOf, workerLabel } from './names.js';

const COLOUR = {
  goal: '#a855f7',
  intent: '#3b82f6',
  confirmed: '#22c55e',
  refuted: '#ef4444',
  inconclusive: '#9ca3af',
  fact: '#64748b',
  hint: '#f59e0b',
  conclusion: '#14b8a6',
  rules: '#4b5563',
  progress: '#4b5563',
  other: '#4b5563',
};

const STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': COLOUR.other,
      label: 'data(label)',
      color: '#e5e7eb',
      'font-size': 10,
      'text-valign': 'bottom',
      'text-margin-y': 4,
      'text-wrap': 'wrap',
      'text-max-width': '150px',
      width: 22,
      height: 22,
      'transition-property': 'opacity',
      'transition-duration': '600ms',
      'z-index-compare': 'manual',
      'z-index': 10,
    },
  },
  ...['goal', 'intent', 'fact', 'hint', 'conclusion'].map((k) => ({
    selector: `node.kind-${k}`,
    style: { 'background-color': COLOUR[k] },
  })),
  { selector: 'node.kind-goal', style: { width: 32, height: 32, 'font-size': 12, 'font-weight': 'bold' } },
  ...['confirmed', 'refuted', 'inconclusive'].map((v) => ({
    selector: `node.verdict-${v}`,
    style: { 'background-color': COLOUR[v] },
  })),
  { selector: 'node.claimed', style: { 'border-width': 4, 'border-color': '#fbbf24' } },
  { selector: 'node.superseded', style: { opacity: 0.35 } },
  { selector: 'node.entering', style: { opacity: 0 } },
  {
    selector: 'node.flash',
    style: { 'underlay-color': '#fde68a', 'underlay-opacity': 0.6, 'underlay-padding': 8, 'underlay-shape': 'ellipse' },
  },
  { selector: 'node:selected', style: { 'overlay-color': '#e5e7eb', 'overlay-opacity': 0.25, 'overlay-padding': 6 } },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': '#6b7280',
      'target-arrow-color': '#6b7280',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
      'transition-property': 'opacity',
      'transition-duration': '600ms',
      'z-index-compare': 'manual',
      'z-index': 5,
    },
  },
  { selector: 'edge.type-supersedes', style: { 'line-style': 'dashed' } },
  // A drawn goal link to an intent that links to nothing: faint, dashed, straight, no arrow.
  {
    selector: 'edge.scaffold',
    style: {
      width: 1,
      'line-style': 'dashed',
      'line-dash-pattern': [4, 4],
      'curve-style': 'straight',
      'target-arrow-shape': 'none',
      opacity: 0.45,
    },
  },
  { selector: 'edge.entering', style: { opacity: 0 } },
  // Band separators and labels: behind everything, and transparent to the mouse, so a drag on them pans.
  {
    selector: 'node.band',
    style: { events: 'no', 'text-events': 'no', 'z-index': 0, 'transition-property': 'none', 'background-opacity': 0 },
  },
  {
    selector: 'node.band-line',
    style: {
      shape: 'rectangle',
      width: 'data(w)',
      height: 1,
      label: '',
      'background-color': '#374151',
      'background-opacity': 1,
    },
  },
  {
    selector: 'node.band-label',
    style: { width: 1, height: 1, color: '#6b7280', 'font-size': 11, 'text-valign': 'center', 'text-halign': 'right' },
  },
];

const FLASH_MS = 1000;
/** How long nodes take to move to their new places after a structural change. */
const MOVE_MS = 300;
/** Fit padding and zoom bounds. A fit never zooms in past `maxZoom`, so a small board keeps a readable size. */
const FIT = { padding: 30, minZoom: 0.2, maxZoom: 1.25 };
/** How long a new element waits for an animation frame before its fade-in is started from a timer instead. */
const FADE_FALLBACK_MS = 100;

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').GraphNode} GraphNode
 * @typedef {import('../../supabase/functions/_shared/types.ts').GraphEdge} GraphEdge
 * @typedef {import('../../supabase/functions/_shared/types.ts').GraphResult} GraphResult
 * @typedef {import('./bands.js').Band} Band
 * @typedef {import('./bands.js').Point} Point
 * @typedef {import('./bands.js').Viewport} Viewport
 * @typedef {{ added: string[]; removed: string[]; changed: string[] }} Diff
 */

/** @param {GraphNode} n */
function nodeData(n) {
  const { label, full } = shortName(n.snippet ?? n.content ?? '');
  const holder = n.claim ? (workerLabel(n) ?? n.claim.by) : null;
  return { id: n.id, label: holder ? `${label}\n⟳ ${holder}` : label, full, kind: kindOf(n.tags) };
}

/** @param {GraphNode} n */
function nodeClasses(n) {
  const out = [`kind-${kindOf(n.tags)}`];
  const verdict = verdictOf(n.tags);
  if (verdict) out.push(`verdict-${verdict}`);
  if (n.claim) out.push('claimed');
  if (n.superseded) out.push('superseded');
  return out;
}

/** @param {GraphEdge} e */
const edgeEl = (e) => ({
  group: 'edges',
  data: { id: edgeKey(e), source: e.from, target: e.to, type: e.type },
  classes: [`type-${e.type}`],
});

/**
 * @param {HTMLElement} container
 * @param {{ onSelect(id: string): void }} opts
 */
export function createGraphView(container, opts) {
  const cytoscape = globalThis.cytoscape;
  if (typeof cytoscape !== 'function') throw new Error('Cytoscape did not load (vendor/cytoscape.min.js)');
  const cy = cytoscape({ container, style: STYLE, minZoom: FIT.minZoom, maxZoom: 3 });
  /**
   * The viewport the last fit set, or null until the board's first fit. While the view still equals it, the person
   * has not panned or zoomed, so a re-layout or a resize fits again.
   * @type {Viewport | null}
   */
  let fitted = null;
  /** A fit skipped because the container had no size; the next resize does it. */
  let needsFit = false;
  /** The edges of the graph last drawn, to tell a structural change from a changed-only poll. @type {GraphEdge[]} */
  let lastEdges = [];
  /** Ends a move still running, putting every node at its final place at once. @type {(() => void) | null} */
  let finishMove = null;

  cy.on('tap', 'node', (e) => opts.onSelect(e.target.id()));
  cy.on('mouseover', 'node', (e) => {
    container.title = e.target.data('full');
  });
  cy.on('mouseout', 'node', () => container.removeAttribute('title'));

  /** The memories: every node but the band separators and labels. */
  const memNodes = () => cy.nodes().not('.band');
  const userMoved = () => fitted !== null && !sameViewport({ zoom: cy.zoom(), pan: cy.pan() }, fitted);

  /** Fit the whole graph, never zoomed in past FIT.maxZoom, set at once (no animation frame needed). */
  function fit() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (memNodes().empty()) return;
    if (w === 0 || h === 0) {
      needsFit = true;
      return;
    }
    needsFit = false;
    cy.resize();
    cy.viewport(fitViewport(cy.elements().boundingBox({}), w, h, FIT));
    fitted = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  }

  /**
   * Replace the band separators and labels: a faint line across the graph at the top of each band after the first,
   * and the band's name at its top left. They are nodes, so they pan and zoom with the graph.
   * @param {Band[]} bands
   * @param {Record<string, Point>} positions
   */
  function drawBands(bands, positions) {
    cy.remove(cy.nodes('.band'));
    const xs = Object.values(positions).map((p) => p.x);
    if (!xs.length) return;
    const x1 = Math.min(...xs) - COL_W / 2;
    const x2 = Math.max(...xs) + COL_W / 2;
    const common = { group: 'nodes', selectable: false, grabbable: false, locked: true };
    cy.add(bands.flatMap((b, i) => [
      ...(i > 0
        ? [{
          ...common,
          data: { id: `band-line|${i}`, w: x2 - x1 },
          position: { x: (x1 + x2) / 2, y: b.y },
          classes: ['band', 'band-line'],
        }]
        : []),
      {
        ...common,
        data: { id: `band-label|${i}`, label: b.label },
        position: { x: x1, y: b.y + 16 },
        classes: ['band', 'band-label'],
      },
    ]));
  }

  /**
   * Put every node where `bandLayout` says, with the preset layout. `animate` moves the nodes that were already drawn
   * over MOVE_MS while new ones appear in place; with the page hidden it does not animate. A timer finishes the move
   * if the layout's stop never comes (an occluded window may run no animation frames). Afterwards it fits, unless the
   * person has panned or zoomed since the last fit.
   * @param {GraphResult} graph
   * @param {boolean} animate
   */
  function arrange(graph, animate) {
    finishMove?.();
    const { positions, bands } = bandLayout(graph);
    drawBands(bands, positions);
    const refit = !userMoved();
    const nodes = memNodes();
    const at = (/** @type {any} */ n) => positions[n.id()] ?? n.position();
    let timer = 0;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      finishMove = null;
      nodes.stop(true);
      nodes.forEach((/** @type {any} */ n) => {
        if (!n.removed()) n.position(at(n));
      });
      // Not if the person panned or zoomed while the nodes slid.
      if (refit && !userMoved()) fit();
    };
    if (!animate || document.visibilityState !== 'visible') {
      nodes.layout({ name: 'preset', positions: at, fit: false, animate: false }).run();
      end();
      return;
    }
    finishMove = end;
    timer = setTimeout(end, MOVE_MS + 200);
    nodes.layout({
      name: 'preset',
      positions: at,
      fit: false,
      animate: true,
      animationDuration: MOVE_MS,
      animateFilter: (/** @type {any} */ n) => !n.hasClass('entering'),
      stop: end,
    }).run();
  }

  /**
   * Draw a goal link to each intent that links to nothing (`goalLinks`) and drop those no longer needed. They carry
   * the class `scaffold`: the diff sync never touches them, and the drawer reads the memory's own links instead.
   * @param {GraphResult} graph
   * @returns {any} the goal links added
   */
  function syncGoalLinks(graph) {
    const want = new Map(goalLinks(graph).map((s) => [`goal-link|${s.parent}|${s.child}`, s]));
    cy.edges('.scaffold').filter((/** @type {any} */ e) => !want.has(e.id())).remove();
    return cy.add(
      [...want].filter(([id]) => cy.getElementById(id).empty()).map(([id, s]) => ({
        group: 'edges',
        data: { id, source: s.parent, target: s.child },
        classes: ['scaffold'],
      })),
    );
  }

  /** @param {any} eles */
  function fadeIn(eles) {
    if (eles.empty()) return;
    // Next frame, so the opacity transition starts from 0. A timer too: an occluded window may never run a frame, and
    // the new elements must not stay invisible. Whichever comes second does nothing.
    const show = () => eles.removeClass('entering');
    requestAnimationFrame(show);
    setTimeout(show, FADE_FALLBACK_MS);
  }

  return {
    /**
     * Draw `graph`. With no previous drawing (or `diff` null) it lays out everything and fits; otherwise it applies
     * `diff`: changed nodes update and flash, and when nodes or links were added or removed, new elements fade in and
     * every node moves to its new place. A poll that only changed nodes moves nothing.
     * @param {GraphResult} graph
     * @param {Diff | null} diff
     */
    render(graph, diff) {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
      const shape = { ...graph, edges };
      if (diff === null || memNodes().empty()) {
        finishMove?.();
        cy.elements().remove();
        cy.add(graph.nodes.map((n) => ({ group: 'nodes', data: nodeData(n), classes: nodeClasses(n) })));
        cy.add(edges.map(edgeEl));
        syncGoalLinks(shape);
        lastEdges = edges;
        fitted = null;
        arrange(shape, false);
        return;
      }
      const structural = structureChanged(diff, lastEdges, edges);
      lastEdges = edges;
      cy.batch(() => {
        for (const id of diff.removed) cy.getElementById(id).remove();
        for (const id of diff.changed) {
          const n = byId.get(id);
          const el = cy.getElementById(id);
          if (!n || el.empty()) continue;
          el.data(nodeData(n));
          el.classes([...nodeClasses(n), 'flash']);
          setTimeout(() => el.removeClass('flash'), FLASH_MS);
        }
      });
      if (!structural) return;
      const fresh = diff.added.flatMap((id) => {
        const n = byId.get(id);
        return n ? [{ group: 'nodes', data: nodeData(n), classes: [...nodeClasses(n), 'entering'] }] : [];
      });
      const addedNodes = cy.add(fresh);
      const want = new Set(edges.map(edgeKey));
      cy.edges().not('.scaffold').filter((/** @type {any} */ e) => !want.has(e.id())).remove();
      const newEdges = edges.filter((e) => cy.getElementById(edgeKey(e)).empty());
      const addedEdges = cy.add(newEdges.map((e) => ({ ...edgeEl(e), classes: [`type-${e.type}`, 'entering'] })));
      const addedLinks = syncGoalLinks(shape).addClass('entering');
      arrange(shape, true);
      fadeIn(addedNodes.union(addedEdges).union(addedLinks));
    },

    /** Remove everything and reset zoom and pan, for a board switch. */
    clear() {
      finishMove?.();
      cy.elements().remove();
      cy.viewport({ zoom: 1, pan: { x: 0, y: 0 } });
      fitted = null;
      needsFit = false;
      lastEdges = [];
    },

    /** Call when the container's size changes: fit again unless the person has panned or zoomed since the last fit. */
    resize() {
      cy.resize();
      finishMove?.();
      if (needsFit || !userMoved()) fit();
    },
  };
}
