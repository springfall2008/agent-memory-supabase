// @ts-check
// Pure helpers for reading facts, the lead's measurement facts and the progress memory. No DOM.
import { kindOf } from './names.js';
import { field } from './status.js';

/**
 * @typedef {import('./names.js').Verdict} Verdict
 * @typedef {{ type: string; direction: string; memoryId: string }} Link
 * @typedef {{ id: string; createdAt: string; tags: string[]; snippet?: string; content?: string }} Node
 */

/** How many cited memories the drawer fetches and lists. */
export const CITATIONS_MAX = 5;

const MEASURED = /^Fact for intent none: measurement of /;

/**
 * @param {string | undefined} text
 * @returns {boolean} true when the first line is a lead measurement fact
 */
export function isMeasurement(text) {
  return text !== undefined && MEASURED.test(text.trimStart());
}

/**
 * @param {string} text
 * @returns {Verdict | null} `passed` reads as confirmed and `failed` as refuted, for facts that carry no verdict tag
 */
export function measurementVerdict(text) {
  if (!isMeasurement(text)) return null;
  const first = text.trimStart().split(/\r?\n/, 1)[0].trimEnd();
  if (first.endsWith(' passed')) return 'confirmed';
  if (first.endsWith(' failed')) return 'refuted';
  return null;
}

/**
 * @param {string} text
 * @returns {string | null} the rest of the `Found:` line of a fact, or null when there is none or it is empty
 */
export function foundLine(text) {
  const f = field(text, 'Found');
  return f === '' ? null : f;
}

/**
 * The newest measurement fact in `nodes` created before `before`.
 * @template {Node} N
 * @param {N[]} nodes
 * @param {string | null} before an ISO time, or null for the newest of all
 * @returns {N | null}
 */
export function latestMeasurement(nodes, before) {
  const limit = before === null ? Infinity : Date.parse(before);
  /** @type {N | null} */
  let best = null;
  for (const n of nodes) {
    if (kindOf(n.tags) !== 'fact' || !isMeasurement(n.snippet ?? n.content)) continue;
    const t = Date.parse(n.createdAt);
    if (!(t < limit)) continue;
    if (best === null || t > Date.parse(best.createdAt)) best = n;
  }
  return best;
}

/**
 * The memories an intent cites: its outgoing `derived-from` links and its `relates-to` links, each once.
 * @param {Link[] | undefined} links
 * @param {number} [max]
 * @returns {{ ids: string[]; more: number }}
 */
export function citations(links, max = CITATIONS_MAX) {
  const seen = new Set();
  for (const l of links ?? []) {
    const cites = (l.type === 'derived-from' && l.direction === 'out') || l.type === 'relates-to';
    if (cites) seen.add(l.memoryId);
  }
  const all = [...seen];
  return { ids: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/**
 * @param {string} text the progress memory's content
 * @returns {{ round: string | null; established: string | null; best: string | null; open: string | null }}
 */
export function progressFields(text) {
  const get = (/** @type {string} */ label) => {
    const v = field(text, label);
    return v === '' ? null : v;
  };
  return {
    round: get('Round'),
    established: get('Established'),
    best: get('Best result'),
    open: get('Open questions'),
  };
}
