// Sending one write from the toolbar or the drawer: its controls disabled while in flight, a status line saying what happened, and
// an immediate graph poll once it lands.
import { ApiError, NOT_SIGNED_IN } from './api.js';
import { h } from './dom.js';

/**
 * @typedef {{ live(): boolean; open(id: string): void; onGraph?(refresh: () => void): void }} Hooks `live` is false
 *   once the drawer shows something else, or the toolbar another board; `onGraph`, where given, runs `refresh` after
 *   each graph poll while `live`
 * @typedef {HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement} Control
 * @typedef {{ ok: true; result: any; polled: Promise<void> } | { ok: false; error: string }} Outcome `polled` settles
 *   once the graph poll that follows the write has finished
 */

/**
 * The text to show for a failed write: the server's own error, or why no answer came.
 * @param {unknown} e
 */
export function errorMessage(e) {
  if (e instanceof ApiError && e.status === 401) return NOT_SIGNED_IN;
  return e instanceof Error ? e.message : String(e);
}

/** The line under a form that says what happened. */
export function statusLine() {
  const p = h('p', 'write-status');
  p.setAttribute('role', 'status');
  return p;
}

/**
 * @param {HTMLElement} line
 * @param {'ok' | 'error' | 'busy'} tone
 * @param {(string | Node)[]} parts
 */
export function say(line, tone, ...parts) {
  line.className = `write-status ${tone}`;
  line.replaceChildren(...parts);
}

/**
 * Send one write with `controls` disabled until it settles, saying so on `line`. Controls come back on only while the
 * drawer or toolbar still shows what they belong to; a finished write polls the graph either way.
 * @param {Control[]} controls
 * @param {HTMLElement} line
 * @param {Hooks} hooks
 * @param {{ pollNow(): Promise<void> }} ctx
 * @param {() => Promise<unknown>} send
 * @returns {Promise<Outcome>}
 */
export async function runWrite(controls, line, hooks, ctx, send) {
  for (const c of controls) c.disabled = true;
  say(line, 'busy', 'Sending…');
  try {
    const result = await send();
    return { ok: true, result, polled: ctx.pollNow() };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  } finally {
    if (hooks.live()) { for (const c of controls) c.disabled = false; }
  }
}
