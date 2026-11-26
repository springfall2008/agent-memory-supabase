// The write forms: Add hint, Add intent and Add amendment, opened from the Board tab's toolbar (`toolbar.js`) for the
// whole board, and the drawer's two shortcuts, "Hint about this node" and "Try next from this fact", with the goal
// drawer's list of amendments. Every form is disabled while its request is in flight; success clears it and polls the
// graph at once; failure shows the server's text. All text goes in through textContent.
import { postJson } from './api.js';
import { h } from './dom.js';
import { kindOf, shortName } from './names.js';
import { runWrite, say, statusLine } from './sending.js';
import { field } from './status.js';
import {
  ADDED,
  amendmentsOf,
  FIELD_MAX,
  GIVE_UP_DEFAULT,
  hintLinks,
  intentUsage,
  offersIntent,
  PRODUCE_DEFAULT,
  TEXT_MAX,
  TRUNCATED,
} from './writes.js';

/**
 * @typedef {import('../../supabase/functions/_shared/types.ts').Memory} Memory
 * @typedef {import('./board.js').ShownStatus} ShownStatus
 * @typedef {import('./writes.js').AmendmentNode} AmendmentNode
 * @typedef {{
 *   scope: string;
 *   board: string;
 *   pollNow(): Promise<void>;
 *   status(): ShownStatus | null;
 *   nodes(): AmendmentNode[];
 * }} WriteCtx
 * @typedef {import('./sending.js').Hooks} Hooks
 */

/**
 * @param {string} label
 * @param {{ multiline?: boolean; max: number; placeholder?: string }} opts
 * @returns {{ el: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement }}
 */
function textField(label, opts) {
  const el = h('label', 'write-field');
  const input = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (h(opts.multiline ? 'textarea' : 'input'));
  if (input instanceof HTMLTextAreaElement) input.rows = 3;
  else input.type = 'text';
  input.maxLength = opts.max;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  el.append(h('span', 'write-label', label), input);
  return { el, input };
}

/**
 * A form box: an optional title, its fields, an optional note, a submit button and a status line. `body` gives the request
 * body from the trimmed values, or a reason to send nothing.
 * @param {{
 *   title?: string;
 *   fields: { el: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement }[];
 *   notes?: HTMLElement[];
 *   submit: string;
 *   path: string;
 *   body(values: string[]): object | string;
 *   after?(polled: Promise<void>): void;
 * }} spec
 * @param {WriteCtx} ctx
 * @param {Hooks} hooks
 */
function writeForm(spec, ctx, hooks) {
  const form = /** @type {HTMLFormElement} */ (h('form', 'write-box'));
  const button = /** @type {HTMLButtonElement} */ (h('button', '', spec.submit));
  button.type = 'submit';
  const line = statusLine();
  if (spec.title) form.append(h('h3', 'write-title', spec.title));
  form.append(...spec.fields.map((f) => f.el), ...(spec.notes ?? []));
  const row = h('div', 'write-actions');
  row.append(button, line);
  form.append(row);
  const inputs = spec.fields.map((f) => f.input);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    const body = spec.body(inputs.map((i) => i.value.trim()));
    if (typeof body === 'string') {
      say(line, 'error', body);
      return;
    }
    const r = await runWrite([...inputs, button], line, hooks, ctx, () => postJson(spec.path, body));
    if (!hooks.live()) return;
    // Disabling the form while it sent dropped the focus; put it back in the form, so Escape and typing still reach it.
    if (!form.contains(document.activeElement) && document.activeElement === document.body) focusForm(form);
    if (!r.ok) {
      say(line, 'error', r.error);
      return;
    }
    for (const i of inputs) i.value = '';
    say(line, 'ok', ADDED);
    spec.after?.(r.polled);
  });
  // Ctrl/Cmd+Enter sends from a text box, where Enter is a new line.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target instanceof HTMLTextAreaElement) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  return form;
}

const EMPTY = 'Write something first.';

/**
 * Add hint: about a node from the drawer's shortcut, or for the whole board from the toolbar.
 * @param {Memory | null} about the node, or null for a board-wide hint with no `about`
 * @param {WriteCtx} ctx
 * @param {Hooks} hooks
 */
export function hintForm(about, ctx, hooks) {
  const text = textField('Hint', { multiline: true, max: TEXT_MAX, placeholder: 'something the workers should know' });
  const where = about === null
    ? 'Board-wide: advice for the lead, read at its next round.'
    : hintLinks(about.tags)
    ? `Linked to this ${kindOf(about.tags)}.`
    : 'Board-wide: on this memory a hint links to nothing.';
  return writeForm(
    {
      ...(about === null ? { title: 'Add hint' } : {}),
      fields: [text],
      notes: [h('p', 'note', where)],
      submit: 'Add hint',
      path: '/hints',
      body: ([t]) => {
        if (!t) return EMPTY;
        return { scope: ctx.scope, board: ctx.board, text: t, ...(about === null ? {} : { about: about.id }) };
      },
    },
    ctx,
    hooks,
  );
}

/**
 * Add intent: from a fact through the drawer's "Try next from this fact", or for the whole board from the toolbar.
 * @param {Memory | null} from the fact it builds on, or null for an intent with no `from`
 * @param {WriteCtx} ctx
 * @param {Hooks} hooks
 */
export function intentForm(from, ctx, hooks) {
  const fields = [
    textField('Try', { multiline: true, max: TEXT_MAX, placeholder: 'what a worker should try' }),
    textField('Done when (optional)', { max: FIELD_MAX, placeholder: PRODUCE_DEFAULT }),
    textField('Give up when (optional)', { max: FIELD_MAX, placeholder: GIVE_UP_DEFAULT }),
  ];
  const usage = h('p', 'note');
  const refresh = () => {
    const s = ctx.status();
    usage.textContent = s ? intentUsage(s.intents, s.maxIntents) : '';
  };
  refresh();
  const notes = [usage];
  if (from) notes.unshift(h('p', 'note', 'It builds on this fact.'));
  const form = writeForm(
    {
      ...(from ? {} : { title: 'Add intent' }),
      fields,
      notes,
      submit: 'Add intent',
      path: '/intents',
      body: ([text, produce, giveUp]) => {
        if (!text) return EMPTY;
        return {
          scope: ctx.scope,
          board: ctx.board,
          text,
          ...(produce ? { produce } : {}),
          ...(giveUp ? { giveUp } : {}),
          ...(from ? { from: from.id } : {}),
        };
      },
      // The count moves once the poll that follows the write has drawn the new intent.
      after: (polled) => polled.then(() => hooks.live() && refresh()),
    },
    ctx,
    hooks,
  );
  form.addEventListener('focusin', refresh);
  return form;
}

/** Add amendment, from the toolbar. @param {WriteCtx} ctx @param {Hooks} hooks */
export function amendmentForm(ctx, hooks) {
  const text = textField('Amendment', {
    multiline: true,
    max: TEXT_MAX,
    placeholder: 'a sub-goal or fallback, such as a lower target that is acceptable if the goal is out of reach',
  });
  return writeForm(
    {
      title: 'Add amendment',
      fields: [text],
      notes: [h('p', 'note', 'The goal stays as it is; the lead reads every amendment with it, the newer winning.')],
      submit: 'Add amendment',
      path: '/amendments',
      body: ([t]) => (t ? { scope: ctx.scope, board: ctx.board, text: t } : EMPTY),
    },
    ctx,
    hooks,
  );
}

/**
 * The board's amendments from the shown graph, each opening in the drawer. It redraws after each graph poll that
 * changes the list, so an amendment added from the toolbar or by a session elsewhere appears here.
 * @param {WriteCtx} ctx
 * @param {Hooks} hooks
 * @returns {HTMLElement}
 */
function amendmentList(ctx, hooks) {
  const box = h('section', 'drawer-amendments');
  let drawn = '';
  const refresh = () => {
    const list = amendmentsOf(ctx.nodes());
    const key = list.map((n) => `${n.id}\n${n.snippet ?? n.content ?? ''}`).join('\n\n');
    if (key === drawn && box.childElementCount) return;
    drawn = key;
    box.replaceChildren(h('h3', 'write-title', 'Amendments'));
    if (list.length === 0) box.append(h('p', 'note', 'None yet.'));
    for (const n of list) {
      const text = n.snippet ?? n.content ?? '';
      const b = h('button', 'secondary drawer-cite');
      b.setAttribute('type', 'button');
      const parts = h('span', 'cite-text');
      const from = field(text, 'From');
      parts.append(
        h('span', 'cite-result', shortName(text).full),
        h('span', 'cite-detail', `${from ? `From ${from} · ` : ''}${new Date(n.createdAt).toLocaleString()}`),
      );
      b.append(parts);
      b.title = n.id;
      b.addEventListener('click', () => hooks.open(n.id));
      box.append(b);
    }
  };
  refresh();
  hooks.onGraph?.(refresh);
  return box;
}

/**
 * Focus a form's first text box.
 * @param {HTMLFormElement} form
 */
export function focusForm(form) {
  const box = /** @type {HTMLElement | null} */ (form.querySelector('textarea, input'));
  box?.focus();
}

/**
 * One drawer shortcut: a line that opens to its form, focusing the form's first box.
 * @param {string} label
 * @param {HTMLFormElement} form
 */
function shortcut(label, form) {
  const box = /** @type {HTMLDetailsElement} */ (h('details', 'drawer-shortcut'));
  box.append(h('summary', '', label), form);
  box.addEventListener('toggle', () => {
    if (box.open) focusForm(form);
  });
  return box;
}

/**
 * What the Memory tab adds below a memory of the shown board: on the goal, its amendments (the goal drawer is
 * otherwise read-only; the board's actions are on the toolbar); on any other node, "Hint about this node", and on a
 * fact while the board is running or paused, "Try next from this fact". Nothing for a memory of another scope or board.
 * @param {Memory} m
 * @param {WriteCtx} ctx
 * @param {Hooks} hooks
 * @returns {HTMLElement[]}
 */
export function writeSection(m, ctx, hooks) {
  if (m.scope !== ctx.scope || !m.tags.includes(`board:${ctx.board}`)) return [];
  const kind = kindOf(m.tags);
  if (kind === 'goal') return [amendmentList(ctx, hooks)];
  const out = [];
  if (ctx.status()?.truncated) out.push(h('p', 'notice', TRUNCATED));
  out.push(shortcut('Hint about this node', hintForm(m, ctx, hooks)));
  if (kind === 'fact' && offersIntent(m.tags, ctx.status()?.state ?? null)) {
    out.push(shortcut('Try next from this fact', intentForm(m, ctx, hooks)));
  }
  return out;
}
