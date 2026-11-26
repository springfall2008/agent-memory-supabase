// The board run controls' building blocks, for the Board tab's toolbar (`toolbar.js`): Stop's in-page confirmation
// and sending one control (Pause lead, Resume lead, Stop, Restart or the intent limit). Each acts on the goal memory
// through `POST /boards/control`, so it reaches a board run on any machine.
import { postJson } from './api.js';
import { h } from './dom.js';
import { stateOf } from './names.js';
import { runWrite, say } from './sending.js';
import { parseStatus } from './status.js';
import { controlDone, needsRunAgain, refusedState, RUN_AGAIN } from './writes.js';

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').Memory} Memory
 * @typedef {import('./sending.js').Hooks} Hooks
 * @typedef {import('./sending.js').Control} Control
 * @typedef {import('./writes.js').Action} Action
 * @typedef {{ scope: string; board: string; pollNow(): Promise<void> }} ControlCtx
 * @typedef {{ kind: 'done'; state: string | null; max: number | 'none' | null; polled: Promise<void> }
 *   | { kind: 'refused'; state: string | null }
 *   | { kind: 'failed' }
 *   | { kind: 'gone' }} ControlOutcome `done` carries the goal as the server left it; `refused` the state the server
 *   named, after the graph was re-read; `gone` means the caller moved on and nothing was said
 */

/**
 * @param {string} text
 * @param {string} [className]
 */
export function button(text, className = '') {
  const b = /** @type {HTMLButtonElement} */ (h('button', className, text));
  b.type = 'button';
  return b;
}

/** The "run the runner again" sentence, its command set as code. */
function runAgain() {
  return [RUN_AGAIN[0], h('code', '', RUN_AGAIN[1]), RUN_AGAIN[2]];
}

/**
 * Stop's confirmation: the question, Stop board and Cancel. The caller focuses Cancel when it shows it, so a repeated
 * or reflexive Enter on "Stop…" does not confirm it.
 * @returns {{ el: HTMLElement; stopNow: HTMLButtonElement; cancel: HTMLButtonElement }}
 */
export function stopConfirm() {
  const el = h('div', 'controls-confirm');
  const stopNow = button('Stop board', 'danger');
  const cancel = button('Cancel', 'secondary');
  const row = h('div', 'controls-buttons');
  row.append(stopNow, cancel);
  el.append(
    h(
      'p',
      '',
      'Stop this board? Workers end at their next step, and the runner lets running workers finish, then exits.',
    ),
    row,
  );
  return { el, stopNow, cancel };
}

/**
 * Send one control with `controls` disabled, and say on `line` what happened. When the server refuses it because the
 * board moved on since the page last looked (another tab, the lead, a person elsewhere), the graph is re-read first,
 * so the caller can offer what is valid now.
 * @param {{ action?: Action; maxIntents?: number | 'none' }} body
 * @param {Action | 'limit'} what
 * @param {string | null} before the goal's state the caller showed
 * @param {Control[]} controls
 * @param {HTMLElement} line
 * @param {Hooks} hooks
 * @param {ControlCtx} ctx
 * @returns {Promise<ControlOutcome>}
 */
export async function sendControl(body, what, before, controls, line, hooks, ctx) {
  const r = await runWrite(
    controls,
    line,
    hooks,
    ctx,
    () => postJson('/boards/control', { scope: ctx.scope, board: ctx.board, ...body }),
  );
  if (!hooks.live()) return { kind: 'gone' };
  if (!r.ok) {
    const refused = refusedState(r.error);
    if (refused) {
      await ctx.pollNow();
      if (!hooks.live()) return { kind: 'gone' };
    }
    say(line, 'error', r.error);
    return refused ? { kind: 'refused', state: refused.state } : { kind: 'failed' };
  }
  const g = /** @type {{ goal: Memory }} */ (r.result).goal;
  const state = stateOf(g.tags);
  const text = controlDone(what, before, state);
  if (needsRunAgain(before, state)) say(line, 'ok', `${text} `, ...runAgain());
  else say(line, 'ok', text);
  return { kind: 'done', state, max: parseStatus(g.content, '').maxIntents, polled: r.polled };
}
