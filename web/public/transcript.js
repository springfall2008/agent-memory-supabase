// @ts-check
// Parses `claude -p --output-format stream-json --verbose` output into display steps. No DOM.

/**
 * One displayable step.
 * - `text`: assistant prose.
 * - `tool`: an assistant tool call; `tool` is the tool name, `text` the JSON of its input.
 * - `result`: with `tool` set, a tool's output (`tool` is the `tool_use_id` it answers, or `unknown`); with no
 *   `tool`, the final `result` line of the run.
 * - `system`: an init or hook line; `text` is its subtype.
 * - `raw`: any other or unparsable line, or content block, shown as is.
 * @typedef {{ kind: 'text' | 'tool' | 'result' | 'system' | 'raw'; text: string; tool?: string }} Step
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} content a tool_result `content`: a string or a list of blocks
 * @returns {string}
 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  return content.map((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b))
    .join('\n');
}

/**
 * @param {Record<string, unknown>} ev
 * @returns {Step[] | null} null when the line is not a shape this parser knows
 */
function fromEvent(ev) {
  const message = ev.message;
  switch (ev.type) {
    case 'system':
      return [{ kind: 'system', text: typeof ev.subtype === 'string' ? ev.subtype : 'system' }];
    case 'assistant':
    case 'user': {
      if (!isObject(message) || !Array.isArray(message.content)) return null;
      /** @type {Step[]} */
      const steps = [];
      for (const b of message.content) {
        if (!isObject(b)) steps.push({ kind: 'raw', text: JSON.stringify(b) });
        else if (ev.type === 'assistant' && b.type === 'text' && typeof b.text === 'string') {
          steps.push({ kind: 'text', text: b.text });
        } else if (ev.type === 'assistant' && b.type === 'tool_use') {
          steps.push({ kind: 'tool', tool: String(b.name ?? 'unknown'), text: JSON.stringify(b.input ?? {}) });
        } else if (ev.type === 'user' && b.type === 'tool_result') {
          steps.push({ kind: 'result', tool: String(b.tool_use_id ?? 'unknown'), text: resultText(b.content) });
        } else steps.push({ kind: 'raw', text: JSON.stringify(b) });
      }
      return steps;
    }
    case 'result':
      return typeof ev.result === 'string' ? [{ kind: 'result', text: ev.result }] : null;
    default:
      return null;
  }
}

/**
 * Parse a transcript, one JSON event per line. Never throws: a blank line is skipped and any other line that is
 * unparsable (including a truncated last line) or not understood becomes a `raw` step.
 * @param {string} text
 * @returns {Step[]}
 */
export function parseTranscript(text) {
  /** @type {Step[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    /** @type {Step[] | null} */
    let steps = null;
    try {
      const ev = JSON.parse(trimmed);
      if (isObject(ev)) steps = fromEvent(ev);
    } catch {
      // fall through to raw
    }
    if (steps) out.push(...steps);
    else out.push({ kind: 'raw', text: trimmed });
  }
  return out;
}
