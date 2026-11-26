/**
 * Pure helpers for the web UI's board writes: the blackboard skill's hint and intent templates, the goal's
 * `Max intents:` line and its state transitions. The server builds every word of a template here; the browser sends
 * only text, which is folded onto one line so it cannot forge another template line.
 */

/** The board-name shape (`release-notes`, `toy-1a2b`). */
export const BOARD_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const BOARD_NAME_MAX = 100;
export const TEXT_MAX = 2000;
export const FIELD_MAX = 500;

export const PRODUCE_DEFAULT = 'a fact reporting what trying this showed';
export const GIVE_UP_DEFAULT = "it cannot be done within the board's rules; record an inconclusive fact";
/** The lead recognises a person's intent by a `Why:` line starting exactly with this. */
export const PERSON_INTENT_MARKER = 'Why: added by ';

export type BoardAction = 'pause' | 'resume' | 'stop' | 'restart';
export const BOARD_ACTIONS: readonly BoardAction[] = ['pause', 'resume', 'stop', 'restart'];
export type MaxIntents = number | 'none';

/** Every line break (with the spaces around it) becomes one space; the ends are trimmed. */
export function fold(s: string): string {
  return s.replace(/[ \t]*[\r\n\v\f\u0085\u2028\u2029]+[ \t]*/g, ' ').trim();
}

export function hintContent(text: string, name: string): string {
  return `Hint: ${fold(text)}\nFrom: ${fold(name)}`;
}

/** A person's amendment to the goal: a sub-goal or fallback, written by a person and never by a worker. */
export function amendmentContent(text: string, name: string): string {
  return `Amendment: ${fold(text)}\nFrom: ${fold(name)}`;
}

export interface IntentFields {
  text: string;
  name: string;
  produce?: string;
  giveUp?: string;
  /** The id of the fact the intent was added on. */
  fromFact?: string;
}

export function intentContent(f: IntentFields): string {
  const building = f.fromFact ? `; building on fact ${fold(f.fromFact)}` : '';
  const produce = fold(f.produce ?? '') || PRODUCE_DEFAULT;
  const giveUp = fold(f.giveUp ?? '') || GIVE_UP_DEFAULT;
  return [
    `Intent: ${fold(f.text)}`,
    `${PERSON_INTENT_MARKER}${fold(f.name)} from the web UI${building}`,
    `Produce: ${produce}`,
    `Give up when: ${giveUp}`,
  ].join('\n');
}

const MAX_LINE = /^Max intents:(.*)$/;

/** The goal's `Max intents` value: a number, `none`, or undefined when the line is absent or unreadable. */
export function maxIntentsOf(goal: string): MaxIntents | undefined {
  for (const line of goal.split('\n')) {
    const m = MAX_LINE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const v = m[1].trim();
    if (v === 'none') return 'none';
    return /^\d+$/.test(v) ? Number(v) : undefined;
  }
  return undefined;
}

/** True when `next` allows more intents than a numeric `current`. */
export function isRaise(current: MaxIntents | undefined, next: MaxIntents): boolean {
  if (typeof current !== 'number') return false;
  return next === 'none' || next > current;
}

/**
 * Rewrites every `Max intents:` line, keeping every other byte. A goal without one gains it after its
 * `Max open intents:` line, or at the end.
 */
export function withMaxIntents(goal: string, n: MaxIntents): string {
  const value = `Max intents: ${n}`;
  const lines = goal.split('\n');
  let found = false;
  const out = lines.map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';
    if (!MAX_LINE.test(line.slice(0, line.length - cr.length))) return line;
    found = true;
    return value + cr;
  });
  if (found) return out.join('\n');
  const open = lines.findIndex((l) => l.startsWith('Max open intents:'));
  if (open !== -1) {
    const cr = lines[open].endsWith('\r') ? '\r' : '';
    lines.splice(open + 1, 0, value + cr);
    return lines.join('\n');
  }
  if (goal.endsWith('\n')) return `${goal}${value}\n`;
  return goal === '' ? value : `${goal}\n${value}`;
}

const TRANSITIONS: Record<BoardAction, Record<string, string>> = {
  pause: { running: 'paused' },
  resume: { paused: 'running' },
  stop: { running: 'stopped', paused: 'stopped' },
  restart: { stopped: 'running' },
};

/** The goal's next state, or null when the action is not allowed from `state`. */
export function transition(state: string, action: BoardAction): string | null {
  return Object.hasOwn(TRANSITIONS[action], state) ? TRANSITIONS[action][state] : null;
}

/** Replaces the first `state:` tag in place (dropping any others), or appends one; every other tag is kept. */
export function withState(tags: string[], state: string): string[] {
  const out: string[] = [];
  let placed = false;
  for (const t of tags) {
    if (!t.startsWith('state:')) out.push(t);
    else if (!placed) {
      out.push(`state:${state}`);
      placed = true;
    }
  }
  if (!placed) out.push(`state:${state}`);
  return out;
}

/** The progress memory's `Round:` number, or undefined when there is none. */
export function roundOf(progress: string): number | undefined {
  const m = /^Round:[ \t]*(\d+)[ \t]*\r?$/m.exec(progress);
  return m ? Number(m[1]) : undefined;
}
