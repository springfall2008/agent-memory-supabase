// @ts-check
// Reads the board's headline numbers from the goal and progress memories. No DOM.
import { kindOf, stateOf } from './names.js';

/**
 * @param {string} text
 * @param {string} label
 * @returns {string | null} the trimmed rest of the first `<label>: ` line, or null when there is none
 */
export function field(text, label) {
  const m = new RegExp(`^${label}:[ \\t]*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

/**
 * @param {string} goal the goal memory's content
 * @param {string} progress the progress memory's content
 * @returns {{ round: number | null; maxIntents: number | 'none' | null; best: string | null; repo: string | null }}
 */
export function parseStatus(goal, progress) {
  const round = field(progress, 'Round');
  const max = field(goal, 'Max intents');
  const best = field(progress, 'Best result');
  const repo = field(goal, 'Repo');
  return {
    round: round !== null && /^\d+$/.test(round) ? Number(round) : null,
    maxIntents: max === null ? null : max.toLowerCase() === 'none' ? 'none' : /^\d+$/.test(max) ? Number(max) : null,
    best: best === '' ? null : best,
    repo: repo === '' ? null : repo,
  };
}

/**
 * @typedef {{ tags: string[] }} StatusNode
 * @typedef {{
 *   state: string | null;
 *   intents: number;
 *   round: number | null;
 *   maxIntents: number | 'none' | null;
 *   best: string | null;
 *   repo: string | null;
 * }} BoardStatus
 */

/**
 * The status strip's numbers for a board graph: the goal's `state:` tag, how many intents the graph draws, and
 * `parseStatus` of the goal and progress memories.
 * @param {StatusNode[]} nodes
 * @param {string} goal the goal memory's content
 * @param {string} progress the progress memory's content
 * @returns {BoardStatus}
 */
export function boardStatus(nodes, goal, progress) {
  const g = nodes.find((n) => kindOf(n.tags) === 'goal');
  return {
    state: g ? stateOf(g.tags) : null,
    intents: nodes.filter((n) => kindOf(n.tags) === 'intent').length,
    ...parseStatus(goal, progress),
  };
}
