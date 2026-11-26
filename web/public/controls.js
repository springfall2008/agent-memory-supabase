// The goal drawer's board controls: Pause lead, Resume lead, Stop (confirmed in the page first) and Restart, each
// offered only in a state it is valid from, and the intent limit box. Each acts on the goal memory through
// `POST /boards/control`, so it reaches a board run on any machine.
import { postJson } from './api.js';
import { h } from './dom.js';
import { stateOf } from './names.js';
import { runWrite, say, statusLine } from './sending.js';
import { parseStatus } from './status.js';
import {
  ACTION_LABELS,
  controlActions,
  controlDone,
  limitText,
  needsRunAgain,
  parseLimit,
  refusedState,
  RUN_AGAIN,
} from './writes.js';

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').Memory} Memory
 * @typedef {import('./sending.js').Hooks} Hooks
 * @typedef {import('./writes.js').Action} Action
 * @typedef {import('./board.js').ShownStatus} ShownStatus
 * @typedef {{ scope: string; board: string; pollNow(): Promise<void>; status(): ShownStatus | null }} ControlCtx
 */

/** States the state line colours. */
const STATES = ['running', 'paused', 'stopped', 'done'];

/**
 * @param {string} text
 * @param {string} [className]
 */
function button(text, className = '') {
  const b = /** @type {HTMLButtonElement} */ (h('button', className, text));
  b.type = 'button';
  return b;
}

/** The "run the runner again" sentence, its command set as code. */
function runAgain() {
  return [RUN_AGAIN[0], h('code', '', RUN_AGAIN[1]), RUN_AGAIN[2]];
}

/**
 * @param {Memory} goal
 * @param {ControlCtx} ctx
 * @param {Hooks} hooks
 * @param {(state: string | null) => void} onState told the goal's state after each control that changed it
 * @returns {HTMLElement}
 */
export function goalControls(goal, ctx, hooks, onState) {
  let state = stateOf(goal.tags);
  let max = parseStatus(goal.content, '').maxIntents;

  const box = h('section', 'write-box controls');
  const stateLine = h('p', 'controls-state');
  const buttons = h('div', 'controls-buttons');
  const confirm = h('div', 'controls-confirm');
  confirm.hidden = true;
  const stopNow = button('Stop board', 'danger');
  const cancel = button('Cancel', 'secondary');
  const confirmRow = h('div', 'controls-buttons');
  confirmRow.append(stopNow, cancel);
  confirm.append(
    h(
      'p',
      '',
      'Stop this board? Workers end at their next step, and the runner lets running workers finish, then exits.',
    ),
    confirmRow,
  );

  const limit = /** @type {HTMLFormElement} */ (h('form', 'controls-limit'));
  const input = /** @type {HTMLInputElement} */ (h('input'));
  input.type = 'text';
  input.inputMode = 'numeric';
  input.size = 6;
  input.placeholder = 'none';
  input.setAttribute('aria-label', 'Max intents');
  const save = button('Save');
  save.type = 'submit';
  const limitRow = h('div', 'controls-buttons');
  limitRow.append(h('span', 'write-label', 'Intent limit'), input, save);
  limit.append(
    limitRow,
    h(
      'p',
      'note',
      'A whole number, or none. A higher max_intents in the board file raises it again on the next board-runner run.',
    ),
  );

  const line = statusLine();
  box.append(h('h3', 'write-title', 'Controls'), stateLine, buttons, confirm, limit, line);

  /** Every control the box has now, so a request disables them all. */
  const all = () => /** @type {import('./sending.js').Control[]} */ ([...box.querySelectorAll('button, input')]);

  function render() {
    const known = state !== null && STATES.includes(state);
    stateLine.replaceChildren(
      'State: ',
      h('span', known ? `state state-${state}` : 'state', state ?? 'unknown'),
    );
    const actions = controlActions(state);
    buttons.replaceChildren(
      ...actions.map((a) => {
        const b = button(ACTION_LABELS[a]);
        b.addEventListener('click', () => (a === 'stop' ? askStop() : send({ action: a }, a)));
        return b;
      }),
    );
    if (actions.length === 0) {
      buttons.append(h('p', 'note', state === 'done' ? 'This board is done.' : 'No controls for this state.'));
    }
    buttons.hidden = false;
    confirm.hidden = true;
    limit.hidden = state === 'done';
    input.value = limitText(max);
  }

  function askStop() {
    buttons.hidden = true;
    confirm.hidden = false;
    // Cancel, not Stop board: a repeated or reflexive Enter on "Stop…" must not confirm it.
    cancel.focus();
  }

  cancel.addEventListener('click', () => {
    confirm.hidden = true;
    buttons.hidden = false;
  });
  stopNow.addEventListener('click', () => send({ action: 'stop' }, 'stop'));

  limit.addEventListener('submit', (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const v = parseLimit(input.value);
    if (!v.ok) say(line, 'error', v.error);
    else send({ maxIntents: v.value }, 'limit');
  });

  /**
   * @param {{ action?: Action; maxIntents?: number | 'none' }} body
   * @param {Action | 'limit'} what
   */
  async function send(body, what) {
    const before = state;
    const r = await runWrite(
      all(),
      line,
      hooks,
      ctx,
      () => postJson('/boards/control', { scope: ctx.scope, board: ctx.board, ...body }),
    );
    if (!hooks.live()) return;
    if (!r.ok) {
      // A refused Stop leaves the confirmation open; put the buttons back.
      confirm.hidden = true;
      buttons.hidden = false;
      const refused = refusedState(r.error);
      if (refused) {
        // The board moved on since this drawer was drawn (another tab, the lead, a person elsewhere): re-read it so
        // the buttons offer what is valid now.
        await ctx.pollNow();
        if (!hooks.live()) return;
        state = refused.state;
        const shown = ctx.status();
        if (shown && shown.state === state) max = shown.maxIntents;
        render();
        onState(state);
      }
      say(line, 'error', r.error);
      return;
    }
    const g = /** @type {{ goal: Memory }} */ (r.result).goal;
    state = stateOf(g.tags);
    max = parseStatus(g.content, '').maxIntents;
    render();
    onState(state);
    const text = controlDone(what, before, state);
    if (needsRunAgain(before, state)) say(line, 'ok', `${text} `, ...runAgain());
    else say(line, 'ok', text);
  }

  render();
  return box;
}
