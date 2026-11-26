// @ts-check
// Chooses where a new graph node goes without re-running the layout. No DOM.

/**
 * @typedef {{ x: number; y: number }} Point
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} Box
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} Segment
 * @typedef {{ left: number; top: number; right: number; bottom: number }} Extent how far a node's box (label included)
 *   reaches from its position
 */

/**
 * @param {Point} p
 * @param {Segment} s
 * @returns {number}
 */
export function distanceToSegment(p, s) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2));
  return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy));
}

/**
 * The first free spot below `anchor`: one row down, trying x offsets 0, +step, -step, +2·step, -2·step…, then the next
 * row. A spot is free when the new node's box (its `extent` around the spot, plus `margin`) overlaps no existing box,
 * and the node itself (`radius`, plus `clearance`) is not on an existing edge segment. Deterministic.
 * @param {Point} anchor
 * @param {{ boxes: Box[]; segments: Segment[]; extent: Extent; radius: number }} scene
 * @param {{ rowGap?: number; step?: number; margin?: number; clearance?: number; maxSteps?: number; maxRows?: number }}
 *   [opts]
 * @returns {Point}
 */
export function freeSlot(anchor, scene, opts = {}) {
  const { rowGap = 90, step = 40, margin = 6, clearance = 14, maxSteps = 40, maxRows = 3 } = opts;
  const { boxes, segments, extent, radius } = scene;
  /** @param {Point} p */
  const free = (p) => {
    const b = { x1: p.x - extent.left, y1: p.y - extent.top, x2: p.x + extent.right, y2: p.y + extent.bottom };
    const hitsBox = boxes.some((o) =>
      b.x1 < o.x2 + margin && b.x2 > o.x1 - margin && b.y1 < o.y2 + margin && b.y2 > o.y1 - margin
    );
    return !hitsBox && !segments.some((s) => distanceToSegment(p, s) < radius + clearance);
  };
  for (let row = 1; row <= maxRows; row++) {
    const y = anchor.y + row * rowGap;
    for (let k = 0; k <= maxSteps; k++) {
      const x = anchor.x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
      if (free({ x, y })) return { x, y };
    }
  }
  return { x: anchor.x, y: anchor.y + rowGap };
}
