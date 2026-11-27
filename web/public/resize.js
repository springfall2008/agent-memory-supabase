// @ts-check
// Limits for the drawer's width when the person drags its edge. No DOM.

/** The narrowest the drawer goes, in pixels. */
export const DRAWER_MIN = 300;
/** How much of the page the drawer leaves uncovered for the graph or list, in pixels. */
export const GRAPH_MIN = 240;
/** How far one arrow key moves the edge, in pixels. */
export const KEY_STEP = 32;
/** Where the chosen width is kept between visits. */
export const WIDTH_KEY = 'agent-memory.drawer-width';

/**
 * The drawer width to use for a wanted width, on a page `total` pixels wide.
 * @param {number} px
 * @param {number} total
 * @returns {number}
 */
export function clampDrawerWidth(px, total) {
  const upper = Math.max(DRAWER_MIN, total - GRAPH_MIN);
  return Math.min(Math.round(Math.min(Math.max(px, DRAWER_MIN), upper)), Math.round(total));
}

/**
 * A stored width, or null when there is none or it is not a positive whole number.
 * @param {string | null} text
 * @returns {number | null}
 */
export function parseStoredWidth(text) {
  return text !== null && /^[1-9]\d*$/.test(text) ? Number(text) : null;
}
