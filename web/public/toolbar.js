// The Board tab's toolbar, a row under the status strip on a board view (never a tag view): the run controls valid for
// the goal's state, Stop confirmed in the page with focus on Cancel; + Hint, + Intent and + Amendment, each opening its
// form in the one panel under the row; and the strip's intent limit, which edits in place. A hint or intent added here
// is board-wide. Every part is built afresh for each board, so nothing drawn for one board can send for another.
import { button, sendControl, stopConfirm } from './controls.js';
import { h } from './dom.js';
import { amendmentForm, focusForm, hintForm, intentForm } from './forms.js';
import { say, statusLine } from './sending.js';
import { ACTION_LABELS, LIMIT_NOTE, limitText, maxText, parseLimit, toolbarOffers, TRUNCATED } from './writes.js';

/**
 * @typedef {import('./board.js').ShownStatus} ShownStatus
 * @typedef {import('./writes.js').AmendmentNode} AmendmentNode
 * @typedef {import('./writes.js').Action} Action
 * @typedef {'hint' | 'intent' | 'amendment' | 'stop'} PanelName
 * @typedef {{
 *   el: HTMLElement;
 *   update(status: ShownStatus | null): void;
 *   end(): void;
 * }} Session one board's toolbar; `end` makes it inert for good
 */

/**
 * @param {{ pollNow(): Promise<void>; status(): ShownStatus | null; nodes(): AmendmentNode[] }} board the Board tab's
 *   shown graph
 * @returns {{
 *   el: HTMLElement;
 *   limit: HTMLElement;
 *   show(target: { scope: string; board: string } | null): void;
 *   update(status: ShownStatus | null): void;
 * }} `el` goes under the strip and `limit` in it; `show` starts a board (or none), closing anything open, and
 *   `update` takes the strip's numbers after each poll (null before the first)
 */
export function createToolbar(board) {
  const el = h('div', 'toolbar');
  el.hidden = true;
  const limit = h('span', 'item limit');
  /** @type {Session | null} */
  let current = null;

  /** @param {{ scope: string; board: string } | null} target */
  function show(target) {
    current?.end();
    current = target ? session(target.scope, target.board, el, limit, board) : null;
    el.replaceChildren(...(current ? [current.el] : []));
    el.hidden = true;
  }

  return { el, limit, show, update: (status) => current?.update(status) };
}

/**
 * @param {string} scope
 * @param {string} name the board
 * @param {HTMLElement} outer the toolbar row's container, shown once the first poll has landed
 * @param {HTMLElement} limit the strip's "Intents n of max" item
 * @param {{ pollNow(): Promise<void>; status(): ShownStatus | null; nodes(): AmendmentNode[] }} board
 * @returns {Session}
 */
function session(scope, name, outer, limit, board) {
  let live = true;
  const hooks = { live: () => live, open: () => {} };
  // Once this board is no longer shown, nothing here polls or reads the next board's graph.
  const ctx = {
    scope,
    board: name,
    pollNow: () => (live ? board.pollNow() : Promise.resolve()),
    status: () => (live ? board.status() : null),
    nodes: () => (live ? board.nodes() : []),
  };

  /** The goal's state and limit as this toolbar shows them, and the strip's numbers. */
  let state = /** @type {string | null} */ (null);
  let max = /** @type {number | 'none' | null} */ (null);
  let intents = 0;
  let truncated = false;
  let known = false;
  /** Controls sent whose follow-up poll has not landed: a poll that began before one may still say the old state. */
  let hold = 0;
  /** The state the buttons were drawn for, so a poll that changes nothing leaves focus where it is. */
  let drawn = /** @type {string | null | undefined} */ (undefined);
  /** @type {PanelName | null} */
  let open = null;
  let editing = false;
  let saving = false;

  const el = h('div', 'toolbar-box');
  const row = h('div', 'toolbar-row');
  const controls = h('div', 'toolbar-group');
  const adds = h('div', 'toolbar-group');
  const line = statusLine();
  /** @type {HTMLButtonElement | null} */
  let stopButton = null;

  /** @param {string} text @param {PanelName} panel */
  const toggle = (text, panel) => {
    const b = button(text, 'secondary');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => (open === panel ? close() : openPanel(panel)));
    return b;
  };
  const toggles = {
    hint: toggle('+ Hint', 'hint'),
    intent: toggle('+ Intent', 'intent'),
    amendment: toggle('+ Amendment', 'amendment'),
  };
  adds.append(toggles.hint, toggles.intent, toggles.amendment);
  row.append(controls, adds, line);

  const confirm = stopConfirm();
  const forms = {
    hint: hintForm(null, ctx, hooks),
    intent: intentForm(null, ctx, hooks),
    amendment: amendmentForm(ctx, hooks),
  };
  const panels = { ...forms, stop: confirm.el };
  const notice = h('p', 'notice', TRUNCATED);
  const panelBox = h('div', 'toolbar-panel');
  panelBox.append(notice, ...Object.values(panels));
  el.append(row, panelBox);

  const limitPrefix = document.createTextNode('');
  const limitButton = button('', 'limit-button');
  limitButton.title = `Change the intent limit. ${LIMIT_NOTE}`;
  const limitInput = /** @type {HTMLInputElement} */ (h('input', 'limit-input'));
  limitInput.type = 'text';
  limitInput.inputMode = 'numeric';
  limitInput.size = 6;
  limitInput.placeholder = 'none';
  limitInput.title = LIMIT_NOTE;
  limitInput.setAttribute('aria-label', 'Max intents');

  /** Every run control there is now, so a control in flight disables them all. */
  const controlEls = () => /** @type {import('./sending.js').Control[]} */ ([
    ...controls.querySelectorAll('button'),
    confirm.stopNow,
    confirm.cancel,
    limitButton,
    limitInput,
  ]);

  // ── panels ───────────────────────────────────────────────────────

  function drawPanels() {
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== open;
    notice.hidden = !truncated || open === null || open === 'stop';
    panelBox.hidden = open === null;
    for (const [k, b] of Object.entries(toggles)) b.setAttribute('aria-expanded', String(k === open));
    stopButton?.setAttribute('aria-expanded', String(open === 'stop'));
  }

  /** @param {PanelName} panel */
  function openPanel(panel) {
    open = panel;
    drawPanels();
    if (panel === 'stop') confirm.cancel.focus();
    else focusForm(forms[panel]);
  }

  /** @param {boolean} [refocus] put focus back on the button that opened the panel */
  function close(refocus = false) {
    const was = open;
    open = null;
    drawPanels();
    if (!refocus || was === null) return;
    const b = was === 'stop' ? stopButton : toggles[was];
    if (b?.isConnected && !b.hidden) b.focus();
  }

  // Escape anywhere in the toolbar closes the open panel, or cancels Stop.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || open === null) return;
    e.preventDefault();
    // The drawer closes on Escape too; this one is the toolbar's.
    e.stopPropagation();
    close(true);
  });
  confirm.cancel.addEventListener('click', () => close(true));
  confirm.stopNow.addEventListener('click', () => sendCtl({ action: 'stop' }, 'stop'));

  // ── run controls ─────────────────────────────────────────────────

  function draw() {
    const offers = toolbarOffers(state);
    if (drawn !== state) {
      drawn = state;
      stopButton = null;
      controls.replaceChildren(
        ...offers.controls.map((a) => {
          const b = button(ACTION_LABELS[a]);
          if (a === 'stop') {
            stopButton = b;
            b.addEventListener('click', () => (open === 'stop' ? close() : openPanel('stop')));
          } else b.addEventListener('click', () => sendCtl({ action: a }, a));
          return b;
        }),
      );
      if (offers.controls.length === 0) {
        controls.append(h('span', 'note', state === 'done' ? 'This board is done.' : 'No controls for this state.'));
      }
      toggles.intent.hidden = !offers.intent;
      toggles.amendment.hidden = !offers.amendment;
      // A panel the new state does not offer closes.
      if (
        (open === 'stop' && !offers.controls.includes('stop')) || (open === 'intent' && !offers.intent) ||
        (open === 'amendment' && !offers.amendment)
      ) close();
      else drawPanels();
    } else drawPanels();
    drawLimit();
  }

  /**
   * @param {{ action?: Action; maxIntents?: number | 'none' }} body
   * @param {Action | 'limit'} what
   */
  async function sendCtl(body, what) {
    hold++;
    const out = await sendControl(body, what, state, controlEls(), line, hooks, ctx);
    if (out.kind === 'gone') return;
    try {
      settleControl(out, what);
    } finally {
      // The button pressed may have gone with the old state, or been disabled while it sent: keep focus in the bar.
      if (document.activeElement === document.body && what !== 'limit') {
        /** @type {HTMLElement | null} */ (controls.querySelector('button'))?.focus();
      }
    }
  }

  /**
   * @param {import('./controls.js').ControlOutcome} out
   * @param {Action | 'limit'} what
   */
  function settleControl(out, what) {
    if (open === 'stop') close();
    if (out.kind === 'done') {
      state = out.state;
      max = out.max;
      if (what === 'limit') endEdit(true);
      draw();
      // Until the poll that follows lands, a poll begun before the write could draw the old state back.
      out.polled.finally(() => {
        hold--;
        if (live) update(board.status());
      });
      return;
    }
    hold--;
    if (out.kind === 'refused') {
      // The board moved on and the graph has been re-read: offer what is valid now.
      state = out.state;
      const shown = board.status();
      if (shown && shown.state === state) max = shown.maxIntents;
      if (what === 'limit') endEdit(true);
      draw();
    } else if (what === 'limit' && editing) limitInput.focus();
  }

  // ── intent limit, in the strip ───────────────────────────────────

  function drawLimit() {
    // A poll that shows a state with no limit to edit closes an open editor, unless its value is being saved.
    if (editing && !saving && !(live && known && toolbarOffers(state).limit)) editing = false;
    if (editing) return;
    limitPrefix.textContent = `Intents ${intents} of `;
    const text = maxText(max);
    if (live && known && toolbarOffers(state).limit) {
      limitButton.textContent = text;
      if (limit.lastChild !== limitButton || limit.firstChild !== limitPrefix) {
        limit.replaceChildren(limitPrefix, limitButton);
      }
    } else limit.replaceChildren(`Intents ${intents} of ${text}`);
  }

  function startEdit() {
    if (editing || !live) return;
    editing = true;
    limitInput.value = limitText(max);
    limit.replaceChildren(limitPrefix, limitInput);
    limitInput.focus();
    limitInput.select();
  }

  /** @param {boolean} refocus */
  function endEdit(refocus) {
    if (!editing) return;
    editing = false;
    drawLimit();
    if (refocus && limitButton.isConnected) limitButton.focus();
  }

  limitButton.addEventListener('click', startEdit);
  limitInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!saving) endEdit(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // A held Enter repeats: it must not open the editor from the button and then save it.
      if (e.repeat || saving || limitInput.disabled) return;
      const v = parseLimit(limitInput.value);
      if (!v.ok) {
        say(line, 'error', v.error);
        return;
      }
      saving = true;
      sendCtl({ maxIntents: v.value }, 'limit').finally(() => (saving = false));
    }
  });
  // Leaving the box cancels, except while its value is being saved.
  limitInput.addEventListener('blur', () => {
    if (!saving) endEdit(false);
  });

  // ── poll results ─────────────────────────────────────────────────

  /** @param {ShownStatus | null} status */
  function update(status) {
    if (!live) return;
    if (status) {
      known = true;
      intents = status.intents;
      truncated = status.truncated;
      if (hold === 0) {
        state = status.state;
        max = status.maxIntents;
      }
    }
    outer.hidden = !known;
    if (known) draw();
    else drawLimit();
  }

  function end() {
    live = false;
    editing = false;
    open = null;
    drawLimit();
  }

  drawPanels();
  return { el, update, end };
}
