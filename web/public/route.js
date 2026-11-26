// @ts-check
// Hash routes, so a reload keeps the page's place. No DOM.

/**
 * @typedef {{ tab: 'browse' } | { tab: 'board' } | { tab: 'board'; scope: string; board: string } |
 *   { tab: 'board'; tag: string }} Route
 */

/**
 * @param {string} s
 * @returns {string | null}
 */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Reads `#browse`, `#board`, `#board/<scope>/<board>` or `#tag/<tag>`, each part URL-encoded. Anything else is Browse.
 * @param {string} hash
 * @returns {Route}
 */
export function parseHash(hash) {
  const parts = hash.replace(/^#/, '').split('/').map(decode);
  if (parts.some((p) => p === null)) return { tab: 'browse' };
  const [head, a, b] = /** @type {string[]} */ (parts);
  if (head === 'board' && parts.length === 1) return { tab: 'board' };
  if (head === 'board' && parts.length === 3 && a !== '' && b !== '') return { tab: 'board', scope: a, board: b };
  if (head === 'tag' && parts.length === 2 && a !== '') return { tab: 'board', tag: a };
  return { tab: 'browse' };
}

/**
 * @param {string} scope
 * @param {string} board the board name, without `board:`
 * @returns {string}
 */
export function boardHash(scope, board) {
  return `#board/${encodeURIComponent(scope)}/${encodeURIComponent(board)}`;
}

/**
 * @param {string} tag
 * @returns {string}
 */
export function tagHash(tag) {
  return `#tag/${encodeURIComponent(tag)}`;
}
