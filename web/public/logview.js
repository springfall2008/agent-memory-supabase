// The drawer's Worker log tab: one worker transcript from the local server, rendered as steps and followed live.
import { NOT_SIGNED_IN, REQUEST_TIMEOUT_MS } from './api.js';
import { h } from './dom.js';
import { applyChunk, emptyLog } from './logbuf.js';
import { nextDelay, POLL_MS } from './poll.js';
import { parseTranscript } from './transcript.js';

const RESULT_LINES = 5;
const RESULT_CHARS = 1000;
const INPUT_CHARS = 2000;
const FOLLOW_PX = 40;

/**
 * @typedef {{ found: boolean; running: boolean; size: number; start: number; next: number; text: string;
 *   cut: boolean; stderr?: string }} LogChunk
 * @typedef {import('./transcript.js').Step} Step
 */

class LogError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * A request with no answer after `REQUEST_TIMEOUT_MS`, or aborted through `signal`, fails with status 0, as a network
 * error does, so it is retried.
 * @param {string} board
 * @param {string} label
 * @param {string} query
 * @param {AbortSignal} signal aborted when the view is destroyed
 * @returns {Promise<LogChunk>}
 */
async function fetchLog(board, label, query, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const both = AbortSignal.any([signal, timeout]);
  const failed = () =>
    new LogError(
      0,
      timeout.aborted && !signal.aborted
        ? 'Timed out: the local server did not answer'
        : 'Network error: the local server is not reachable',
    );
  let res;
  try {
    res = await fetch(`/logs/${encodeURIComponent(board)}/${encodeURIComponent(label)}?${query}`, {
      headers: { accept: 'application/json' },
      signal: both,
    });
  } catch {
    throw failed();
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // An abort while reading the body is a failed request; otherwise the body is not JSON.
    if (both.aborted) throw failed();
  }
  if (!res.ok) {
    throw new LogError(res.status, body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
  }
  if (body === null) throw new LogError(res.status, 'The server sent a response that is not JSON');
  return body;
}

/** @param {string} text @param {number} max */
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}

/** @param {string} json */
function pretty(json) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** A tool's output, collapsed to a few lines with a toggle. @param {string} text */
function outputStep(text) {
  const box = h('div', 'step step-output');
  const lines = text.split('\n');
  const short = clip(lines.slice(0, RESULT_LINES).join('\n'), RESULT_CHARS);
  const pre = h('pre', 'step-pre', short);
  box.append(h('div', 'step-head', '◂ output'), pre);
  if (short !== text) {
    const more = lines.length > RESULT_LINES ? `${lines.length - RESULT_LINES} more lines` : 'full text';
    const toggle = h('button', 'secondary step-toggle', `expand (${more})`);
    toggle.setAttribute('type', 'button');
    let open = false;
    toggle.addEventListener('click', () => {
      open = !open;
      pre.textContent = open ? text : short;
      toggle.textContent = open ? 'collapse' : `expand (${more})`;
    });
    box.append(toggle);
  }
  return box;
}

/** @param {Step} s @returns {HTMLElement} */
function renderStep(s) {
  switch (s.kind) {
    case 'text':
      return h('div', 'step step-text', s.text);
    case 'tool': {
      const box = h('div', 'step step-tool');
      box.append(
        h('div', 'step-head', `▸ ${s.tool ?? 'tool'}`),
        h('pre', 'step-pre', clip(pretty(s.text), INPUT_CHARS)),
      );
      return box;
    }
    case 'result':
      if (s.tool !== undefined) return outputStep(s.text);
      {
        const box = h('div', 'step step-final');
        box.append(h('div', 'step-head', 'Result'), h('div', 'step-text', s.text));
        return box;
      }
    case 'system':
      return h('div', 'step step-system', `system: ${s.text}`);
    default:
      return h('pre', 'step step-raw', s.text);
  }
}

/**
 * The steps of one chunk. A cut chunk ends inside an over-long line (forward) or starts inside one (earlier).
 * @param {LogChunk} chunk
 * @param {'forward' | 'earlier'} direction
 */
function renderChunk(chunk, direction) {
  const frag = document.createDocumentFragment();
  frag.append(...parseTranscript(chunk.text).map(renderStep));
  if (chunk.cut) {
    const note = h('div', 'step step-note', 'line truncated');
    if (direction === 'earlier') frag.prepend(note);
    else frag.append(note);
  }
  return frag;
}

/**
 * A log viewer for one worker. Nothing is fetched until `setActive(true)`; `destroy()` stops it for good.
 * @param {{ board: string; label: string; claimed: boolean }} opts
 * @returns {{ el: HTMLElement; setActive(on: boolean): void; destroy(): void }}
 */
export function createLogView(opts) {
  const el = h('div', 'logview');
  const head = h('div', 'log-head');
  const state = h('span', 'log-state', '');
  head.append(h('span', 'log-label', `Worker ${opts.label}`), state);
  const earlier = h('button', 'secondary log-earlier', 'Load earlier');
  earlier.setAttribute('type', 'button');
  earlier.hidden = true;
  const message = h('p', 'log-message');
  message.hidden = true;
  const scroller = h('div', 'log-steps');
  const stderr = /** @type {HTMLDetailsElement} */ (h('details', 'log-stderr'));
  stderr.hidden = true;
  const stderrText = h('pre', 'step-pre');
  stderr.append(h('summary', '', 'stderr'), stderrText);
  el.append(head, message, earlier, scroller, stderr);

  let buf = emptyLog();
  let loaded = false;
  /** Whether there is more to fetch: true until the log is finished and read to its end, or a request is refused. */
  let want = true;
  let wasRunning = false;
  let busy = false;
  let active = false;
  let dead = false;
  let timer = 0;
  let delay = POLL_MS;
  /** Aborts any request in flight when the view is destroyed. */
  const ctrl = new AbortController();

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_PX;
  const live = () => active && !dead && document.visibilityState === 'visible';

  /** @param {string} text */
  function say(text) {
    message.textContent = text;
    message.hidden = text === '';
  }

  /** @param {LogChunk} c */
  function showMeta(c) {
    state.textContent = c.running ? 'running' : 'finished';
    state.className = `log-state ${c.running ? 'log-running' : 'log-finished'}`;
    if (c.stderr !== undefined && stderrText.textContent !== c.stderr) stderrText.textContent = c.stderr;
    stderr.hidden = c.stderr === undefined;
  }

  /** Render a forward chunk and decide whether to keep fetching. @param {LogChunk} c */
  function onForward(c) {
    if (!c.found) {
      state.textContent = '';
      say(
        opts.claimed
          ? 'Working on another machine: no local log'
          : 'No local log: this worker did not run on this machine',
      );
      want = false;
      return;
    }
    showMeta(c);
    const next = applyChunk(buf, c, 'forward');
    if (next !== buf) {
      const follow = !loaded || nearBottom();
      buf = next;
      scroller.append(renderChunk(c, 'forward'));
      if (follow) scroller.scrollTop = scroller.scrollHeight;
    }
    loaded = true;
    earlier.hidden = buf.start === 0;
    say(buf.text === '' && !c.running ? 'The log is empty.' : '');
    // When the worker stops, one more fetch picks up anything written after the last poll.
    const stopped = wasRunning && !c.running;
    wasRunning = c.running;
    want = c.running || stopped || c.next < c.size;
  }

  async function tick() {
    timer = 0;
    if (busy || !want || !live()) return;
    busy = true;
    earlier.setAttribute('disabled', '');
    let ok = true;
    try {
      const c = await fetchLog(opts.board, opts.label, loaded ? `from=${buf.next}` : 'tail=1', ctrl.signal);
      if (dead) return;
      onForward(c);
    } catch (e) {
      if (dead) return;
      const err = /** @type {LogError} */ (e);
      ok = false;
      say(err.status === 401 ? NOT_SIGNED_IN : `Log: ${err.message}`);
      // A refused request (bad name, not signed in) will not succeed on retry; a network or server error might.
      if (err.status >= 400 && err.status < 500) want = false;
    } finally {
      busy = false;
      earlier.removeAttribute('disabled');
    }
    if (dead || !want) return;
    delay = nextDelay(delay, ok);
    // A finished log still behind its end catches up at once; a running one waits a poll.
    timer = setTimeout(tick, ok && !wasRunning ? 0 : delay);
  }

  earlier.addEventListener('click', async () => {
    if (busy || dead || !loaded) return;
    busy = true;
    earlier.setAttribute('disabled', '');
    try {
      const c = await fetchLog(opts.board, opts.label, `before=${buf.start}`, ctrl.signal);
      if (dead) return;
      const next = applyChunk(buf, c, 'earlier');
      if (next !== buf) {
        buf = next;
        const height = scroller.scrollHeight;
        scroller.prepend(renderChunk(c, 'earlier'));
        scroller.scrollTop += scroller.scrollHeight - height;
      }
      earlier.hidden = buf.start === 0;
      say('');
    } catch (e) {
      if (!dead) say(`Log: ${/** @type {Error} */ (e).message}`);
    } finally {
      busy = false;
      earlier.removeAttribute('disabled');
      resume();
    }
  });

  /** Fetch now if the log is on screen, has more to fetch, and no request or timer is pending. */
  function resume() {
    if (live() && want && !busy && !timer) tick();
  }
  document.addEventListener('visibilitychange', resume);

  return {
    el,
    setActive(on) {
      active = on;
      if (on) resume();
    },
    destroy() {
      dead = true;
      ctrl.abort();
      clearTimeout(timer);
      timer = 0;
      document.removeEventListener('visibilitychange', resume);
    },
  };
}
