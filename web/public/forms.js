// The drawer's write forms, on the Board tab only: Add hint on every node, Add intent on the goal and on facts while
// the board runs, and on the goal its amendments, Add amendment and the board controls (`controls.js`). Every form is
// disabled while its request is in flight; success clears it and polls the graph at once; failure shows the server's
// text. All text goes in through textContent.
import { postJson } from './api.js';
import { goalControls } from './controls.js';
import { h } from './dom.js';
import { kindOf, shortName, stateOf } from './names.js';
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
 * A form box: a title, its fields, an optional note, a submit button and a status line. `body` gives the request
 * body from the trimmed values, or a reason to send nothing.
 * @param {{
 *   title: string;
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
  form.append(h('h3', 'write-title', spec.title), ...spec.fields.map((f) => f.el), ...(spec.notes ?? []));
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

/** @param {Memory} m @param {WriteCtx} ctx @param {Hooks} hooks */
function hintForm(m, ctx, hooks) {
  const text = textField('Hint', { multiline: true, max: TEXT_MAX, placeholder: 'something the workers should know' });
  const where = hintLinks(m.tags)
    ? `Linked to this ${kindOf(m.tags)}.`
    : 'Board-wide: on this memory a hint links to nothing.';
  return writeForm(
    {
      title: 'Add hint',
      fields: [text],
      notes: [h('p', 'note', where)],
      submit: 'Add hint',
      path: '/hints',
      body: ([t]) => (t ? { scope: ctx.scope, board: ctx.board, text: t, about: m.id } : EMPTY),
    },
    ctx,
    hooks,
  );
}

/** @param {Memory} m @param {WriteCtx} ctx @param {Hooks} hooks */
function intentForm(m, ctx, hooks) {
  const onFact = kindOf(m.tags) === 'fact';
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
  if (onFact) notes.unshift(h('p', 'note', 'It builds on this fact.'));
  const form = writeForm(
    {
      title: 'Add intent',
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
          ...(onFact ? { from: m.id } : {}),
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

/** @param {WriteCtx} ctx @param {Hooks} hooks */
function amendmentForm(ctx, hooks) {
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

/** The board's amendments from the shown graph, each opening in the drawer. @param {WriteCtx} ctx @param {Hooks} hooks */
function amendmentList(ctx, hooks) {
  const box = h('section', 'drawer-amendments');
  box.append(h('h3', 'write-title', 'Amendments'));
  const list = amendmentsOf(ctx.nodes());
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
  return box;
}

/**
 * The write forms for a memory of the shown board, below its content; none for a memory of another scope or board.
 * @param {Memory} m
 * @param {WriteCtx} ctx
 * @param {Hooks} hooks
 * @returns {HTMLElement[]}
 */
export function writeSection(m, ctx, hooks) {
  if (m.scope !== ctx.scope || !m.tags.includes(`board:${ctx.board}`)) return [];
  const out = [];
  if (ctx.status()?.truncated) out.push(h('p', 'notice', TRUNCATED));
  const kind = kindOf(m.tags);
  if (kind === 'goal') {
    const intent = intentForm(m, ctx, hooks);
    const amend = amendmentForm(ctx, hooks);
    /** @param {string | null} state */
    const show = (state) => {
      intent.hidden = !offersIntent(m.tags, state);
      amend.hidden = state === 'done';
    };
    show(stateOf(m.tags));
    out.push(amendmentList(ctx, hooks), goalControls(m, ctx, hooks, show), intent, amend);
  } else if (kind === 'fact' && offersIntent(m.tags, ctx.status()?.state ?? null)) {
    out.push(intentForm(m, ctx, hooks));
  }
  out.push(hintForm(m, ctx, hooks));
  return out;
}
