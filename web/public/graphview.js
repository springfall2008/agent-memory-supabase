// The Cytoscape graph of a board: styling, layout, and applying a diff without re-laying out the whole graph.
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
  { selector: 'node.claimed', style: { 'border-width': 4, 'border-color': '#f9fafb', 'border-style': 'double' } },
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
    },
  },
  { selector: 'edge.type-supersedes', style: { 'line-style': 'dashed' } },
  { selector: 'edge.entering', style: { opacity: 0 } },
  { selector: 'edge.scaffold', style: { display: 'none' } },
];

const FLASH_MS = 1000;
const ROW_GAP = 90;
const SLOT_GAP = 80;

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').GraphNode} GraphNode
 * @typedef {import('../../supabase/functions/_shared/types.ts').GraphEdge} GraphEdge
 * @typedef {import('../../supabase/functions/_shared/types.ts').GraphResult} GraphResult
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
const edgeId = (e) => `${e.from}|${e.to}|${e.type}`;

/** @param {GraphEdge} e */
const edgeEl = (e) => ({
  group: 'edges',
  data: { id: edgeId(e), source: e.from, target: e.to, type: e.type },
  classes: [`type-${e.type}`],
});

/**
 * @param {HTMLElement} container
 * @param {{ onSelect(id: string): void }} opts
 */
export function createGraphView(container, opts) {
  const cytoscape = globalThis.cytoscape;
  if (typeof cytoscape !== 'function') throw new Error('Cytoscape did not load (vendor/cytoscape.min.js)');
  const cy = cytoscape({ container, style: STYLE, minZoom: 0.2, maxZoom: 3 });
  let needsLayout = false;

  cy.on('tap', 'node', (e) => opts.onSelect(e.target.id()));
  cy.on('mouseover', 'node', (e) => {
    container.title = e.target.data('full');
  });
  cy.on('mouseout', 'node', () => container.removeAttribute('title'));

  /**
   * Breadth-first, top down, from the goal. Board links point from child to parent (a fact is `derived-from` its
   * intent, the progress `depends-on` the goal), so the layout walks hidden reversed copies of the links, plus a hidden
   * link from the goal to every node the walk would not otherwise reach. The drawn arrows keep their real direction.
   */
  function layout() {
    if (container.clientWidth === 0 || cy.nodes().length === 0) {
      needsLayout = cy.nodes().length > 0;
      return;
    }
    needsLayout = false;
    const nodes = cy.nodes();
    const goal = nodes.filter((n) => n.data('kind') === 'goal').first();
    /** @type {Map<string, string[]>} */
    const children = new Map();
    const scaffold = [];
    cy.edges().forEach((e) => {
      const parent = e.target().id();
      const child = e.source().id();
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)?.push(child);
      scaffold.push({ parent, child });
    });
    const hasParent = new Set(scaffold.map((s) => s.child));
    /** @type {string[]} */
    const roots = goal.nonempty() ? [goal.id()] : nodes.filter((n) => !hasParent.has(n.id())).map((n) => n.id());
    const reached = new Set();
    /** @param {string} id */
    const walk = (id) => {
      const queue = [id];
      while (queue.length) {
        const cur = /** @type {string} */ (queue.shift());
        if (reached.has(cur)) continue;
        reached.add(cur);
        queue.push(...(children.get(cur) ?? []));
      }
    };
    roots.forEach(walk);
    // Nodes come oldest first: the oldest node still unreached hangs from the goal (or becomes a root), then repeat.
    nodes.forEach((n) => {
      if (reached.has(n.id())) return;
      if (goal.nonempty()) scaffold.push({ parent: goal.id(), child: n.id() });
      else roots.push(n.id());
      walk(n.id());
    });
    const hidden = cy.add(scaffold.map((s, i) => ({
      group: 'edges',
      data: { id: `scaffold-${i}`, source: s.parent, target: s.child },
      classes: ['scaffold'],
    })));
    nodes.union(hidden).layout({
      name: 'breadthfirst',
      directed: true,
      roots: cy.collection(roots.map((id) => cy.getElementById(id))),
      spacingFactor: 1.1,
      nodeDimensionsIncludeLabels: true,
      padding: 30,
      fit: true,
      animate: false,
    }).run();
    hidden.remove();
  }

  /**
   * Place each new node one row below a placed node it links to (its parent), else any placed neighbour, else under
   * the whole graph, in the nearest free slot. Nodes come oldest first, so a new intent is placed before its new fact.
   * @param {any} added the new nodes
   */
  function place(added) {
    const pending = new Set(added.map((/** @type {any} */ n) => n.id()));
    const placed = (/** @type {any} */ n) => !pending.has(n.id());
    added.forEach((/** @type {any} */ node) => {
      const parent = node.outgoers('node').filter(placed).first();
      const near = parent.nonempty() ? parent : node.neighborhood('node').filter(placed).first();
      let anchor;
      if (near.nonempty()) anchor = near.position();
      else {
        const bb = cy.nodes().filter(placed).boundingBox({});
        anchor = Number.isFinite(bb.x1) ? { x: bb.x1, y: bb.y2 } : { x: 0, y: 0 };
      }
      const taken = cy.nodes().filter(placed).map((/** @type {any} */ n) => n.position());
      const y = anchor.y + ROW_GAP;
      let spot = { x: anchor.x, y };
      for (let k = 0; k < 40; k++) {
        const x = anchor.x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * SLOT_GAP;
        if (
          !taken.some((/** @type {any} */ p) => Math.abs(p.x - x) < SLOT_GAP / 2 && Math.abs(p.y - y) < ROW_GAP / 2)
        ) {
          spot = { x, y };
          break;
        }
      }
      node.position(spot);
      pending.delete(node.id());
    });
  }

  /** @param {any} eles */
  function fadeIn(eles) {
    // Next frame, so the opacity transition starts from 0.
    requestAnimationFrame(() => eles.removeClass('entering'));
  }

  return {
    /**
     * Draw `graph`. With no previous drawing (or `diff` null) it lays out everything; otherwise it applies `diff`:
     * new elements fade in near a connected node, changed nodes update and flash, removed ones go.
     * @param {GraphResult} graph
     * @param {Diff | null} diff
     */
    render(graph, diff) {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      if (diff === null || cy.nodes().length === 0) {
        cy.elements().remove();
        cy.add(graph.nodes.map((n) => ({ group: 'nodes', data: nodeData(n), classes: nodeClasses(n) })));
        cy.add(graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map(edgeEl));
        layout();
        return;
      }
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
      const fresh = diff.added.flatMap((id) => {
        const n = byId.get(id);
        return n ? [{ group: 'nodes', data: nodeData(n), classes: [...nodeClasses(n), 'entering'] }] : [];
      });
      const addedNodes = cy.add(fresh);
      const want = new Set(graph.edges.map(edgeId));
      cy.edges().filter((e) => !want.has(e.id())).remove();
      const newEdges = graph.edges.filter((e) =>
        byId.has(e.from) && byId.has(e.to) && cy.getElementById(edgeId(e)).empty()
      );
      const addedEdges = cy.add(newEdges.map((e) => ({ ...edgeEl(e), classes: [`type-${e.type}`, 'entering'] })));
      place(addedNodes);
      fadeIn(addedNodes.union(addedEdges));
    },

    /** Remove everything, for a board switch. */
    clear() {
      cy.elements().remove();
      needsLayout = false;
    },

    /** Call when the container's size changes: a layout skipped while it was hidden runs now. */
    resize() {
      cy.resize();
      if (needsLayout) layout();
    },
  };
}
