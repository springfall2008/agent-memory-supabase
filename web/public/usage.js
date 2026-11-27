// @ts-check
// Token usage of a board's runs, as web-api's GET /usage returns it: raw counts only, never costs. No DOM.
import { kindOf, workerLabel } from './names.js';

/**
 * @typedef {{ input: number; output: number; cacheRead: number; cacheWrite: number }} Tokens
 * @typedef {{
 *   runLabel: string;
 *   role: string;
 *   intentId: string | null;
 *   tokens: Tokens;
 *   runnerModel?: string;
 *   turns?: number | null;
 *   durationMs?: number | null;
 *   models?: Record<string, Tokens>;
 * }} Run
 */

/**
 * @param {number} v a count in thousands or millions
 * @param {string} unit
 */
function scaled(v, unit) {
  return `${v < 9.95 ? v.toFixed(1) : String(Math.round(v))}${unit}`;
}

/**
 * A count in a few characters: 999, 1.2k, 12k, 1.2M, 12M.
 * @param {number} n
 */
export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (Math.round(n / 1000) < 1000) return scaled(n / 1000, 'k');
  return scaled(n / 1_000_000, 'M');
}

/**
 * Everything the model read: fresh input plus cache reads and writes.
 * @param {Tokens} t
 */
export function inputTotal(t) {
  return t.input + t.cacheRead + t.cacheWrite;
}

/** @param {Tokens} t */
export function stripText(t) {
  if (inputTotal(t) === 0 && t.output === 0) return 'Tokens: none yet';
  return `Tokens ${formatTokens(inputTotal(t))} in · ${formatTokens(t.output)} out`;
}

/**
 * The exact figures behind a shortened total.
 * @param {Tokens} t
 */
export function totalTitle(t) {
  const n = (/** @type {number} */ x) => x.toLocaleString('en-GB');
  return `Input ${n(t.input)} · cache read ${n(t.cacheRead)} · cache write ${n(t.cacheWrite)} · output ${
    n(t.output)
  } (raw tokens, no costs)`;
}

/**
 * The runs that belong to a memory in the drawer: an intent's by its id, a fact's by the worker label that wrote it,
 * the goal's the lead's.
 * @template {Run} R
 * @param {R[]} runs
 * @param {{ id: string; tags: string[]; content?: string; snippet?: string; claim?: any }} memory
 * @returns {R[]}
 */
export function runsFor(runs, memory) {
  const kind = kindOf(memory.tags);
  if (kind === 'intent') return runs.filter((r) => r.intentId === memory.id);
  if (kind === 'goal') return runs.filter((r) => r.role === 'lead');
  if (kind === 'fact') {
    const label = workerLabel(memory);
    return label ? runs.filter((r) => r.runLabel === label) : [];
  }
  return [];
}
