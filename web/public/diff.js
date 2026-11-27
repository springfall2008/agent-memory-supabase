// @ts-check
// Compares two board graphs by node id. No DOM.

/**
 * @typedef {{ id: string; label: string | null }} Session
 * @typedef {{ by: string; until: string | null; description: string; mine?: true; session?: Session }} Claim
 * @typedef {{
 *   id: string;
 *   tags: string[];
 *   snippet?: string;
 *   updatedAt?: string;
 *   superseded?: true;
 *   claim?: Claim;
 * }} GraphNode
 * @typedef {{ nodes: GraphNode[] }} GraphResult
 */

/**
 * @param {Claim | undefined} c
 * @returns {string}
 */
function claimKey(c) {
  if (!c) return '';
  return JSON.stringify([c.by, c.until, c.description, c.session?.id ?? null, c.session?.label ?? null]);
}

/**
 * @param {GraphNode} n
 * @returns {string}
 */
function nodeKey(n) {
  return JSON.stringify([
    [...n.tags].sort(),
    n.snippet ?? null,
    n.updatedAt ?? null,
    n.superseded === true,
    claimKey(n.claim),
  ]);
}

/**
 * Which node ids appeared, vanished or changed (tags, snippet, updatedAt, superseded or the whole claim) between two
 * graphs. updatedAt is what shows an edit past the snippet, such as the goal's `Max intents:` line.
 * @param {GraphResult | null} prev
 * @param {GraphResult} next
 * @returns {{ added: string[]; removed: string[]; changed: string[] }}
 */
export function diffGraph(prev, next) {
  const before = new Map((prev?.nodes ?? []).map((n) => [n.id, nodeKey(n)]));
  const added = [];
  const changed = [];
  const seen = new Set();
  for (const n of next.nodes) {
    seen.add(n.id);
    const was = before.get(n.id);
    if (was === undefined) added.push(n.id);
    else if (was !== nodeKey(n)) changed.push(n.id);
  }
  const removed = [...before.keys()].filter((id) => !seen.has(id));
  return { added, removed, changed };
}
