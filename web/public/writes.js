// @ts-check
// The rules of the board toolbar, the drawer's shortcuts and the board controls: which are offered when, and their
// fixed wording. No DOM.
import { kindOf } from './names.js';

/** @typedef {'pause' | 'resume' | 'stop' | 'restart'} Action */

/** Said when a hint, intent or amendment is stored. */
export const ADDED = 'Added — it will appear in the graph shortly';
/** Said when a board is running again after Restart, or after raising the limit it stopped at. */
export const RUN_AGAIN = ['Now run ', 'board-runner run <board file>', ' again to restart the workers.'];
/** Shown above the forms on a board the graph does not draw in full. */
export const TRUNCATED =
  'The graph shows only the oldest nodes of this board, so what you add here may not appear in it.';
/** The server's text for an intent's `Produce:` and `Give up when:` when the form leaves them empty. */
export const PRODUCE_DEFAULT = 'a fact reporting what trying this showed';
export const GIVE_UP_DEFAULT = "it cannot be done within the board's rules; record an inconclusive fact";
/** The server's limits on a form's text, in characters after trimming. */
export const TEXT_MAX = 2000;
export const FIELD_MAX = 500;

/** The intent limit editor's tooltip. */
export const LIMIT_NOTE =
  'A whole number, or none. A higher max_intents in the board file raises it again on the next board-runner run.';

/** Kinds a hint is linked to; a hint on any other node is board-wide. */
const HINT_LINKS = ['intent', 'fact', 'hint'];

/** Each control's button text, in the order they are shown. */
export const ACTION_LABELS = /** @type {const} */ ({
  pause: 'Pause lead',
  resume: 'Resume lead',
  stop: 'Stop…',
  restart: 'Restart',
});

/**
 * Whether Add intent is offered: on the goal and on facts, while the board is running or paused.
 * @param {string[]} tags the memory's tags
 * @param {string | null} state the goal's state
 */
export function offersIntent(tags, state) {
  const kind = kindOf(tags);
  return (kind === 'goal' || kind === 'fact') && (state === 'running' || state === 'paused');
}

/**
 * Whether a hint added on a memory with these tags is linked to it, rather than board-wide.
 * @param {string[]} tags
 */
export function hintLinks(tags) {
  return HINT_LINKS.includes(kindOf(tags));
}

/**
 * The control buttons valid in a goal state: Pause while running, Resume while paused, Stop while running or paused,
 * Restart once stopped. None on a done board, nor in a state this page does not know.
 * @param {string | null} state
 * @returns {Action[]}
 */
export function controlActions(state) {
  if (state === 'running') return ['pause', 'stop'];
  if (state === 'paused') return ['resume', 'stop'];
  if (state === 'stopped') return ['restart'];
  return [];
}

/**
 * What the Board tab's toolbar offers in a goal state: the controls valid in it, + Hint always, + Intent while running
 * or paused, + Amendment and the intent limit editor in any state but done.
 * @param {string | null} state
 * @returns {{ controls: Action[]; hint: boolean; intent: boolean; amendment: boolean; limit: boolean }}
 */
export function toolbarOffers(state) {
  return {
    controls: controlActions(state),
    hint: true,
    intent: state === 'running' || state === 'paused',
    amendment: state !== 'done',
    limit: state !== 'done',
  };
}

/**
 * The strip's text for the goal's `Max intents`, which the limit editor opens on.
 * @param {number | 'none' | null} max
 */
export function maxText(max) {
  return max === 'none' ? 'no limit' : max === null ? 'unknown' : String(max);
}

/**
 * The line above Add intent, with the status strip's own counts.
 * @param {number} used intents the graph draws
 * @param {number | 'none' | null} max the goal's `Max intents`
 */
export function intentUsage(used, max) {
  if (max === 'none') return `This board has used ${used} intents, no limit.`;
  if (max === null) return `This board has used ${used} intents; its limit is unknown.`;
  const over = used >= max ? ' Yours is still accepted.' : '';
  return `This board has used ${used} of ${max} intents.${over}`;
}

/**
 * What the intent limit box shows for the goal's `Max intents`.
 * @param {number | 'none' | null} max
 */
export function limitText(max) {
  return max === null ? '' : String(max);
}

/**
 * The limit box's text as a `maxIntents` value: a positive whole number, or `none` (also "no limit").
 * @param {string} text
 * @returns {{ ok: true; value: number | 'none' } | { ok: false; error: string }}
 */
export function parseLimit(text) {
  const t = text.trim().toLowerCase();
  if (t === 'none' || t === 'no limit') return { ok: true, value: 'none' };
  if (/^\d+$/.test(t) && Number(t) > 0 && Number.isSafeInteger(Number(t))) return { ok: true, value: Number(t) };
  return { ok: false, error: 'Give a whole number above 0, or none for no limit.' };
}

/**
 * Whether a control left the workers to be started again: the board went from stopped to running.
 * @param {string | null} before
 * @param {string | null} after
 */
export function needsRunAgain(before, after) {
  return before === 'stopped' && after === 'running';
}

/**
 * What a control did, in a sentence.
 * @param {Action | 'limit'} what
 * @param {string | null} before the goal's state before
 * @param {string | null} after the goal's state afterwards
 */
export function controlDone(what, before, after) {
  if (what === 'pause') return 'Paused: the lead plans nothing new until you resume it. Workers finish what is open.';
  if (what === 'resume') return 'Resumed: the lead plans again at its next round.';
  if (what === 'stop') return 'Stopped: workers end at their next step, and the runner lets them finish and exits.';
  if (what === 'restart') return 'Restarted: the board is running again.';
  if (needsRunAgain(before, after)) return 'Limit raised: the board is running again.';
  return after === 'running' ? 'Limit saved.' : `Limit saved. The board is ${after ?? 'in an unknown state'}.`;
}

/**
 * The goal's state named by a control the server refused because the board had moved on (`Board is <state>`), or
 * null for any other error. `unknown` is the server's word for a goal with no state tag.
 * @param {string} error
 * @returns {{ state: string | null } | null}
 */
export function refusedState(error) {
  const m = /^Board is ([a-z][a-z-]*)$/.exec(error);
  if (!m) return null;
  return { state: m[1] === 'unknown' ? null : m[1] };
}

/**
 * @typedef {{ id: string; tags: string[]; createdAt: string; snippet?: string; content?: string }} AmendmentNode
 */

/**
 * The board's amendments among the drawn nodes, oldest first.
 * @param {AmendmentNode[]} nodes
 * @returns {AmendmentNode[]}
 */
export function amendmentsOf(nodes) {
  return nodes.filter((n) => kindOf(n.tags) === 'amendment')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
}
