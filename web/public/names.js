// @ts-check
// Pure helpers for naming and classifying board memories. No DOM.

/**
 * @typedef {'goal' | 'rules' | 'progress' | 'intent' | 'fact' | 'hint' | 'conclusion' | 'other'} Kind
 * @typedef {'confirmed' | 'refuted' | 'inconclusive'} Verdict
 * @typedef {{ label: string | null }} ClaimSession
 * @typedef {{ description: string; session?: ClaimSession }} NamedClaim
 * @typedef {{ content?: string; snippet?: string; claim?: NamedClaim }} Labelled
 */

const PREFIX = /^(?:Intent:|Fact for intent \S+:|Partial result for intent \S+:|Hint:|Conclusion for board \S+:)/;
const EMPTY = '(empty)';

/**
 * A short graph label and the full one-line name of a memory.
 * `full` is the first line without its template prefix; `label` is `full` cut to at most `max` characters, the
 * trailing ellipsis included.
 * @param {string} text
 * @param {number} [max]
 * @returns {{ label: string; full: string }}
 */
export function shortName(text, max = 28) {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0];
  const full = firstLine.replace(PREFIX, '').trim();
  if (full === '') return { label: EMPTY, full: EMPTY };
  const chars = Array.from(full);
  if (chars.length <= max) return { label: full, full };
  const head = chars.slice(0, Math.max(0, max - 1)).join('').trimEnd();
  return { label: `${head}…`, full };
}

/**
 * @param {string[]} tags
 * @param {string} prefix
 * @returns {string | null}
 */
function tagValue(tags, prefix) {
  for (const t of tags) if (t.startsWith(prefix)) return t.slice(prefix.length);
  return null;
}

const KINDS = ['goal', 'rules', 'progress', 'intent', 'fact', 'hint', 'conclusion'];

/**
 * @param {string[]} tags
 * @returns {Kind}
 */
export function kindOf(tags) {
  const k = tagValue(tags, 'kind:');
  return /** @type {Kind} */ (k !== null && KINDS.includes(k) ? k : 'other');
}

/**
 * @param {string[]} tags
 * @returns {Verdict | null}
 */
export function verdictOf(tags) {
  const v = tagValue(tags, 'verdict:');
  return v === 'confirmed' || v === 'refuted' || v === 'inconclusive' ? v : null;
}

/**
 * @param {string[]} tags
 * @returns {string | null}
 */
export function stateOf(tags) {
  return tagValue(tags, 'state:');
}

/**
 * @param {string | undefined} text
 * @returns {string | null}
 */
function lastBy(text) {
  if (!text) return null;
  const all = [...text.matchAll(/^By: (\S+)\r?$/gm)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * Who worked on a memory: the last `By:` line of its content or snippet, else the claim's session label, else the
 * `(label: x)` in the claim description.
 * @param {Labelled} memory
 * @returns {string | null}
 */
export function workerLabel(memory) {
  const by = lastBy(memory.content) ?? lastBy(memory.snippet);
  if (by) return by;
  const claim = memory.claim;
  if (!claim) return null;
  if (claim.session?.label) return claim.session.label;
  return /\(label: ([^)]+)\)/.exec(claim.description)?.[1] ?? null;
}
