// @ts-check
// Reads the board's headline numbers from the goal and progress memories. No DOM.

/**
 * @param {string} text
 * @param {string} label
 * @returns {string | null} the trimmed rest of the first `<label>: ` line, or null when there is none
 */
function field(text, label) {
  const m = new RegExp(`^${label}:[ \\t]*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

/**
 * @param {string} goal the goal memory's content
 * @param {string} progress the progress memory's content
 * @returns {{ round: number | null; maxIntents: number | 'none' | null; best: string | null }}
 */
export function parseStatus(goal, progress) {
  const round = field(progress, 'Round');
  const max = field(goal, 'Max intents');
  const best = field(progress, 'Best result');
  return {
    round: round !== null && /^\d+$/.test(round) ? Number(round) : null,
    maxIntents: max === null ? null : max.toLowerCase() === 'none' ? 'none' : /^\d+$/.test(max) ? Number(max) : null,
    best: best === '' ? null : best,
  };
}
