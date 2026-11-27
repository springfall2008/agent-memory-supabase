import { assert, assertEquals } from '@std/assert';
import { kindOf, shortName, stateOf, verdictOf, workerLabel } from '../../web/public/names.js';
import {
  builtBefore,
  citations,
  foundLine,
  isMeasurement,
  latestMeasurement,
  measurementVerdict,
  progressFields,
} from '../../web/public/facts.js';
import { diffGraph } from '../../web/public/diff.js';
import { formatTokens, inputTotal, runsFor, stripText, totalTitle } from '../../web/public/usage.js';
import { parseTranscript } from '../../web/public/transcript.js';
import { connState, nextDelay, POLL_MS, STALE_MS } from '../../web/public/poll.js';
import { boardStatus, parseStatus } from '../../web/public/status.js';
import { applyChunk, emptyLog } from '../../web/public/logbuf.js';
import { boardHash, parseHash, tagHash } from '../../web/public/route.js';
import {
  bandLayout,
  COL_W,
  fitViewport,
  goalLinks,
  roundGroups,
  sameViewport,
  structureChanged,
} from '../../web/public/bands.js';
import {
  ACTION_LABELS,
  amendmentsOf,
  controlActions,
  controlDone,
  FIELD_MAX,
  GIVE_UP_DEFAULT,
  hintLinks,
  intentUsage,
  limitText,
  maxText,
  needsRunAgain,
  offersIntent,
  parseLimit,
  PRODUCE_DEFAULT,
  refusedState,
  TEXT_MAX,
  toolbarOffers,
} from '../../web/public/writes.js';
import * as server from '../../supabase/functions/_shared/board-writes.ts';

// ── names ──────────────────────────────────────────────────────────

Deno.test('shortName cuts an intent to max characters including the ellipsis', () => {
  const n = shortName('Intent: try a faster parser for the config\nWhy: first round');
  assertEquals(n.label, 'try a faster parser for the…');
  assertEquals(n.label.length, 28);
  assertEquals(n.full, 'try a faster parser for the config');
});

Deno.test('shortName removes each template prefix', () => {
  assertEquals(shortName('Fact for intent none: measurement passed').label, 'measurement passed');
  assertEquals(shortName('Fact for intent abc123: it works').full, 'it works');
  assertEquals(shortName('Partial result for intent abc123: half done').full, 'half done');
  assertEquals(shortName('Hint: look at the cache').full, 'look at the cache');
  assertEquals(shortName('Conclusion for board toy: n = 7').label, 'n = 7');
});

Deno.test('shortName gives (empty) for empty text', () => {
  assertEquals(shortName('').label, '(empty)');
  assertEquals(shortName('  \n ').label, '(empty)');
  assertEquals(shortName('Intent:').label, '(empty)');
});

Deno.test('shortName never exceeds max and leaves no space before the ellipsis', () => {
  for (const max of [5, 10, 12, 20, 28]) {
    const n = shortName('Intent: aaa bbb ccc ddd eee fff ggg hhh iii jjj', max);
    assert(n.label.length <= max, `${n.label} > ${max}`);
    assert(!n.label.includes(' …'), n.label);
    assert(n.label.endsWith('…'));
  }
  assertEquals(shortName('short', 28).label, 'short');
});

Deno.test('kindOf reads kind:amendment and shortName strips the Amendment prefix', () => {
  assertEquals(kindOf(['board:toy', 'kind:amendment', 'evergreen']), 'amendment');
  assertEquals(shortName('Amendment: 15% is acceptable\nFrom: someone').full, '15% is acceptable');
  assertEquals(shortName('Amendment:').label, '(empty)');
});

Deno.test('kindOf, verdictOf and stateOf read their tags', () => {
  assertEquals(kindOf(['board:toy', 'kind:intent']), 'intent');
  assertEquals(kindOf(['kind:conclusion']), 'conclusion');
  assertEquals(kindOf(['board:toy']), 'other');
  assertEquals(kindOf(['kind:mystery']), 'other');
  assertEquals(verdictOf(['kind:fact', 'verdict:confirmed']), 'confirmed');
  assertEquals(verdictOf(['verdict:refuted']), 'refuted');
  assertEquals(verdictOf(['verdict:inconclusive']), 'inconclusive');
  assertEquals(verdictOf(['kind:fact']), null);
  assertEquals(stateOf(['state:running', 'kind:goal']), 'running');
  assertEquals(stateOf(['kind:goal']), null);
});

Deno.test('workerLabel reads the last By line', () => {
  assertEquals(workerLabel({ content: 'Fact for intent x: y\nBy: first\nmore\nBy: second' }), 'second');
  assertEquals(workerLabel({ snippet: 'Fact for intent x: y\nBy: w1' }), 'w1');
  assertEquals(workerLabel({ content: 'no by line here', snippet: 'By: from-snippet' }), 'from-snippet');
});

Deno.test('workerLabel falls back to the claim session, then the claim description', () => {
  const description = 'Working on this for board toy (label: w2)';
  assertEquals(workerLabel({ content: 'x', claim: { description, session: { label: 'w3' } } }), 'w3');
  assertEquals(workerLabel({ content: 'x', claim: { description, session: { label: null } } }), 'w2');
  assertEquals(workerLabel({ content: 'x', claim: { description } }), 'w2');
  assertEquals(workerLabel({ content: 'x' }), null);
  assertEquals(workerLabel({ claim: { description: 'no label here' } }), null);
});

// ── diff ───────────────────────────────────────────────────────────

type Node = {
  id: string;
  updatedAt?: string;
  scope: string;
  category: string;
  tags: string[];
  createdAt: string;
  snippet?: string;
  superseded?: true;
  claim?: { by: string; until: string | null; description: string; session?: { id: string; label: string | null } };
};

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  scope: 's',
  category: 'observation',
  tags: ['kind:intent'],
  createdAt: '2026-01-01T00:00:00Z',
  snippet: `Intent: ${id}`,
  ...extra,
});
const graph = (...nodes: Node[]) => ({ nodes, edges: [], truncated: false, total: nodes.length });

Deno.test('diffGraph with no previous graph adds everything', () => {
  assertEquals(diffGraph(null, graph(node('a'), node('b'))), { added: ['a', 'b'], removed: [], changed: [] });
});

Deno.test('diffGraph reports removed nodes and no change for equal graphs', () => {
  assertEquals(diffGraph(graph(node('a'), node('b')), graph(node('a'))), { added: [], removed: ['b'], changed: [] });
  assertEquals(diffGraph(graph(node('a')), graph(node('a'))), { added: [], removed: [], changed: [] });
});

Deno.test('diffGraph sees tags, snippet and superseded changes', () => {
  const prev = graph(node('a'), node('b'), node('c'));
  const next = graph(
    node('a', { tags: ['kind:intent', 'state:done'] }),
    node('b', { snippet: 'Intent: other' }),
    node('c', { superseded: true }),
  );
  assertEquals(diffGraph(prev, next).changed, ['a', 'b', 'c']);
});

Deno.test('diffGraph sees a content edit below the snippet through updatedAt', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const prev = graph(node('a', { updatedAt: at }), node('b'));
  const next = graph(node('a', { updatedAt: '2026-01-01T00:00:05.000Z' }), node('b'));
  assertEquals(diffGraph(prev, next).changed, ['a']);
  assertEquals(diffGraph(prev, graph(node('a', { updatedAt: at }), node('b'))).changed, []);
});

Deno.test('diffGraph sees a claim appear, disappear or move', () => {
  const claim = { by: 'me', until: null, description: 'd', session: { id: '1', label: 'w1' } };
  assertEquals(diffGraph(graph(node('a')), graph(node('a', { claim }))).changed, ['a']);
  assertEquals(diffGraph(graph(node('a', { claim })), graph(node('a'))).changed, ['a']);
  assertEquals(diffGraph(graph(node('a', { claim })), graph(node('a', { claim: { ...claim } }))).changed, []);
  const sameHolderOtherSession = { ...claim, session: { id: '2', label: 'w2' } };
  assertEquals(diffGraph(graph(node('a', { claim })), graph(node('a', { claim: sameHolderOtherSession }))).changed, [
    'a',
  ]);
  assertEquals(diffGraph(graph(node('a', { claim })), graph(node('a', { claim: { ...claim, until: 'x' } }))).changed, [
    'a',
  ]);
});

// ── transcript ─────────────────────────────────────────────────────

Deno.test('parseTranscript maps stream-json lines to steps', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: '/x' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu2',
          content: [{ type: 'text', text: 'one' }, {
            type: 'text',
            text: 'two',
          }],
        }],
      },
    }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'All done.' }),
  ].join('\n');
  assertEquals(parseTranscript(lines), [
    { kind: 'system', text: 'init' },
    { kind: 'text', text: 'Looking.' },
    { kind: 'tool', tool: 'Bash', text: '{"command":"ls"}' },
    { kind: 'result', tool: 'tu1', text: 'a.txt' },
    { kind: 'result', tool: 'tu2', text: 'one\ntwo' },
    { kind: 'result', text: 'All done.' },
  ]);
});

Deno.test('parseTranscript turns anything else into raw and never throws', () => {
  const rate = JSON.stringify({ type: 'rate_limit_event', info: 1 });
  const steps = parseTranscript(`${rate}\n\nnot json at all\n{"type":"assis`);
  assertEquals(steps.length, 3);
  assertEquals(steps[0], { kind: 'raw', text: rate });
  assertEquals(steps[1], { kind: 'raw', text: 'not json at all' });
  assertEquals(steps[2], { kind: 'raw', text: '{"type":"assis' });
  assertEquals(parseTranscript(''), []);
  assertEquals(
    parseTranscript('null\n42\n"s"\n[]\n{"type":"assistant"}\n{"type":"user","message":{"content":5}}').map((s) =>
      s.kind
    ),
    ['raw', 'raw', 'raw', 'raw', 'raw', 'raw'],
  );
});

// ── poll ───────────────────────────────────────────────────────────

Deno.test('nextDelay backs off on failure and resets on success', () => {
  assertEquals(POLL_MS, 3000);
  let d = POLL_MS;
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(d = nextDelay(d, false));
  assertEquals(seen, [6000, 12000, 24000, 30000, 30000, 30000]);
  assertEquals(nextDelay(30000, true), 3000);
  assertEquals(nextDelay(0, false), 3000);
  assertEquals(nextDelay(1000, false), 3000);
});

Deno.test('connState says stale once a live loop has not refreshed for three polls', () => {
  assertEquals(STALE_MS, 3 * POLL_MS);
  const at = new Date('2026-01-01T10:00:00Z');
  const later = (ms: number) => at.getTime() + ms;
  assertEquals(connState('live', at, later(STALE_MS)), 'live');
  assertEquals(connState('live', at, later(STALE_MS + 1)), 'stale');
  assertEquals(connState('live', null, later(STALE_MS + 1)), 'live');
  assertEquals(connState('retrying', at, later(STALE_MS + 1)), 'retrying');
  assertEquals(connState('loading', at, later(STALE_MS + 1)), 'loading');
});

// ── status ─────────────────────────────────────────────────────────

Deno.test('parseStatus reads round, max intents and best result', () => {
  const goal = 'Goal: x\nMax open intents: 3\nMax intents: 12\nClaim minutes: 5';
  const progress = 'Round: 4\nEstablished: nothing yet.\nBest result: none.\nOpen questions: none.';
  assertEquals(parseStatus(goal, progress), { round: 4, maxIntents: 12, best: 'none.' });
  assertEquals(parseStatus('Max intents: none', 'Best result:   a faster parser, 2x  '), {
    round: null,
    maxIntents: 'none',
    best: 'a faster parser, 2x',
  });
  assertEquals(parseStatus('Goal: x', ''), { round: null, maxIntents: null, best: null });
});

Deno.test('boardStatus counts drawn intents and reads the goal state with parseStatus', () => {
  const nodes = [
    { tags: ['kind:goal', 'state:paused'] },
    { tags: ['kind:intent', 'state:open'] },
    { tags: ['kind:intent', 'state:done'] },
    { tags: ['kind:fact'] },
  ];
  assertEquals(boardStatus(nodes, 'Max intents: 5', 'Round: 2'), {
    state: 'paused',
    intents: 2,
    round: 2,
    maxIntents: 5,
    best: null,
  });
  assertEquals(boardStatus([], '', '').state, null);
  assertEquals(boardStatus([], '', '').intents, 0);
});

// ── writes ─────────────────────────────────────────────────────────

Deno.test('writes keeps the server defaults and limits', () => {
  assertEquals(PRODUCE_DEFAULT, server.PRODUCE_DEFAULT);
  assertEquals(GIVE_UP_DEFAULT, server.GIVE_UP_DEFAULT);
  assertEquals(TEXT_MAX, server.TEXT_MAX);
  assertEquals(FIELD_MAX, server.FIELD_MAX);
});

Deno.test('offersIntent: goal and facts, only while running or paused', () => {
  for (const state of ['running', 'paused']) {
    assert(offersIntent(['kind:goal'], state));
    assert(offersIntent(['kind:fact'], state));
    assert(!offersIntent(['kind:intent'], state));
    assert(!offersIntent(['kind:hint'], state));
    assert(!offersIntent(['kind:amendment'], state));
  }
  for (const state of ['stopped', 'done', null]) {
    assert(!offersIntent(['kind:goal'], state));
    assert(!offersIntent(['kind:fact'], state));
  }
});

Deno.test('hintLinks: intents, facts and hints are linked; the rest is board-wide', () => {
  assertEquals(
    ['intent', 'fact', 'hint', 'goal', 'rules', 'progress', 'conclusion', 'amendment'].map((k) =>
      hintLinks([`kind:${k}`])
    ),
    [true, true, true, false, false, false, false, false],
  );
});

Deno.test('controlActions offers only the buttons valid in each state, as the server allows', () => {
  assertEquals(controlActions('running'), ['pause', 'stop']);
  assertEquals(controlActions('paused'), ['resume', 'stop']);
  assertEquals(controlActions('stopped'), ['restart']);
  assertEquals(controlActions('done'), []);
  assertEquals(controlActions(null), []);
  assertEquals(controlActions('mystery'), []);
  for (const state of ['running', 'paused', 'stopped', 'done']) {
    for (const a of server.BOARD_ACTIONS) {
      assertEquals(controlActions(state).includes(a), server.transition(state, a) !== null, `${a} from ${state}`);
    }
  }
  assertEquals(Object.keys(ACTION_LABELS).sort(), [...server.BOARD_ACTIONS].sort());
});

Deno.test('toolbarOffers: controls per state, intents while running or paused, amendments and limit unless done', () => {
  const offers = (state: string | null) => toolbarOffers(state);
  assertEquals(offers('running'), {
    controls: ['pause', 'stop'],
    hint: true,
    intent: true,
    amendment: true,
    limit: true,
  });
  assertEquals(offers('paused'), {
    controls: ['resume', 'stop'],
    hint: true,
    intent: true,
    amendment: true,
    limit: true,
  });
  assertEquals(offers('stopped'), { controls: ['restart'], hint: true, intent: false, amendment: true, limit: true });
  assertEquals(offers('done'), { controls: [], hint: true, intent: false, amendment: false, limit: false });
  assertEquals(offers(null), { controls: [], hint: true, intent: false, amendment: true, limit: true });
  // The toolbar's + Intent follows the same rule as the drawer's intent on the goal.
  for (const state of ['running', 'paused', 'stopped', 'done', null]) {
    assertEquals(offers(state).intent, offersIntent(['kind:goal'], state));
  }
});

Deno.test('maxText names the limit the strip shows', () => {
  assertEquals(maxText(20), '20');
  assertEquals(maxText('none'), 'no limit');
  assertEquals(maxText(null), 'unknown');
});

Deno.test('intentUsage says how many intents of the limit the board has used', () => {
  assertEquals(intentUsage(3, 5), 'This board has used 3 of 5 intents.');
  assertEquals(intentUsage(5, 5), 'This board has used 5 of 5 intents. Yours is still accepted.');
  assertEquals(intentUsage(2, 'none'), 'This board has used 2 intents, no limit.');
  assertEquals(intentUsage(0, null), 'This board has used 0 intents; its limit is unknown.');
});

Deno.test('parseLimit takes a positive whole number or none; limitText shows the goal value', () => {
  assertEquals(parseLimit(' 12 '), { ok: true, value: 12 });
  assertEquals(parseLimit('None'), { ok: true, value: 'none' });
  assertEquals(parseLimit('no limit'), { ok: true, value: 'none' });
  for (const bad of ['', '0', '-1', '2.5', 'ten', '1e3', '99999999999999999999']) assert(!parseLimit(bad).ok, bad);
  assertEquals([limitText(7), limitText('none'), limitText(null)], ['7', 'none', '']);
});

Deno.test('refusedState reads the state from a refused control, and nothing else', () => {
  assertEquals(refusedState('Board is paused'), { state: 'paused' });
  assertEquals(refusedState('Board is stopped'), { state: 'stopped' });
  assertEquals(refusedState('Board is unknown'), { state: null });
  assertEquals(refusedState('Board is not running'), null);
  assertEquals(refusedState('Board b not found'), null);
  assertEquals(refusedState('Database error'), null);
  assertEquals(refusedState('Board is done.'), null);
});

Deno.test('needsRunAgain and controlDone: only stopped to running asks for the runner again', () => {
  assert(needsRunAgain('stopped', 'running'));
  assert(!needsRunAgain('paused', 'running'));
  assert(!needsRunAgain('stopped', 'stopped'));
  assertEquals(controlDone('limit', 'stopped', 'running'), 'Limit raised: the board is running again.');
  assertEquals(controlDone('limit', 'running', 'running'), 'Limit saved.');
  assertEquals(controlDone('limit', 'stopped', 'stopped'), 'Limit saved. The board is stopped.');
  assert(controlDone('pause', 'running', 'paused').startsWith('Paused'));
});

Deno.test('amendmentsOf picks the amendments, oldest first', () => {
  const nodes = [
    mem('a2', 'amendment', 5),
    mem('g', 'goal', 0),
    mem('a1', 'amendment', 1),
    mem('h', 'hint', 2),
  ];
  assertEquals(amendmentsOf(nodes).map((n) => n.id), ['a1', 'a2']);
});

// ── logbuf ─────────────────────────────────────────────────────────

Deno.test('applyChunk appends forward chunks once and ignores a repeat', () => {
  const a = applyChunk(emptyLog(), { start: 0, next: 5, text: 'hello' }, 'forward');
  assertEquals(a, { start: 0, next: 5, text: 'hello' });
  const b = applyChunk(a, { start: 5, next: 7, text: '!!' }, 'forward');
  assertEquals(b, { start: 0, next: 7, text: 'hello!!' });
  assertEquals(applyChunk(b, { start: 5, next: 7, text: '!!' }, 'forward'), b);
  assertEquals(applyChunk(b, { start: 9, next: 10, text: 'x' }, 'forward'), b);
});

Deno.test('applyChunk prepends an earlier chunk only when it ends at the buffer start', () => {
  const buf = { start: 5, next: 7, text: '!!' };
  assertEquals(applyChunk(buf, { start: 0, next: 5, text: 'hello' }, 'earlier'), {
    start: 0,
    next: 7,
    text: 'hello!!',
  });
  assertEquals(applyChunk(buf, { start: 0, next: 4, text: 'hell' }, 'earlier'), buf);
});

Deno.test('applyChunk adopts the first forward chunk wherever the server starts it', () => {
  assertEquals(applyChunk(emptyLog(), { start: 100, next: 103, text: 'abc' }, 'forward'), {
    start: 100,
    next: 103,
    text: 'abc',
  });
});

// ── route ──────────────────────────────────────────────────────────

Deno.test('parseHash reads browse, board and tag routes', () => {
  assertEquals(parseHash(''), { tab: 'browse' });
  assertEquals(parseHash('#browse'), { tab: 'browse' });
  assertEquals(parseHash('#board'), { tab: 'board' });
  assertEquals(parseHash('#board/agent-memory-tool/toy'), { tab: 'board', scope: 'agent-memory-tool', board: 'toy' });
  assertEquals(parseHash('#tag/repo%3Ax'), { tab: 'board', tag: 'repo:x' });
});

Deno.test('parseHash falls back to browse for malformed routes', () => {
  assertEquals(parseHash('#board/only-scope'), { tab: 'browse' });
  assertEquals(parseHash('#board//x'), { tab: 'browse' });
  assertEquals(parseHash('#tag/'), { tab: 'browse' });
  assertEquals(parseHash('#tag/%E0%A4%A'), { tab: 'browse' });
  assertEquals(parseHash('#nonsense'), { tab: 'browse' });
});

Deno.test('boardHash and tagHash round-trip through parseHash, slashes included', () => {
  assertEquals(parseHash(boardHash('a/b', 'x y')), { tab: 'board', scope: 'a/b', board: 'x y' });
  assertEquals(parseHash(tagHash('board:a/b#c')), { tab: 'board', tag: 'board:a/b#c' });
});

// ── bands ──────────────────────────────────────────────────────────

const T0 = Date.parse('2026-01-01T00:00:00Z');
/** A board memory of `kind`, created `min` minutes after T0. */
const mem = (id: string, kind: string, min: number, extra: { tags?: string[]; snippet?: string } = {}) => ({
  id,
  tags: [`kind:${kind}`, ...(extra.tags ?? [])],
  createdAt: new Date(T0 + min * 60_000).toISOString(),
  snippet: extra.snippet ?? `${id}`,
});
type LayoutNode = { id: string; tags: string[]; createdAt: string; snippet?: string };
type Edge = { from: string; to: string; type: string };
const link = (from: string, to: string, type = 'derived-from'): Edge => ({ from, to, type });
const board = (nodes: LayoutNode[], edges: Edge[] = []) => ({ nodes, edges });
const header = () => [mem('goal', 'goal', 0), mem('rules', 'rules', 0.1), mem('progress', 'progress', 0.2)];
const headerLinks = () => [link('rules', 'goal', 'depends-on'), link('progress', 'goal', 'depends-on')];

/** A sample board with untagged rounds, as the old brief gives it. */
function sampleBoard() {
  const nodes = [
    ...header(),
    mem('A', 'intent', 1),
    mem('F1', 'fact', 5),
    mem('B', 'intent', 10),
    mem('C', 'intent', 10.5),
    mem('FB1', 'fact', 14),
    mem('FB2', 'fact', 15),
    mem('HB1', 'hint', 15.5),
    mem('FB3', 'fact', 16),
    mem('HB2', 'hint', 16.5),
    mem('D', 'intent', 20),
    mem('FD', 'fact', 25),
  ];
  const edges = [
    ...headerLinks(),
    link('F1', 'A'),
    link('B', 'F1'),
    link('C', 'F1'),
    link('FB1', 'B'),
    link('FB2', 'B'),
    link('FB3', 'B'),
    link('HB1', 'B', 'relates-to'),
    link('HB2', 'B', 'relates-to'),
    link('D', 'F1'),
    link('D', 'FB1'),
    link('FD', 'D'),
  ];
  return board(nodes, edges);
}

Deno.test('bandLayout puts the goal at the top centre with rules and progress beside it', () => {
  const { positions, bands } = bandLayout(board(header(), headerLinks()));
  assertEquals(positions.goal.x, 0);
  assertEquals(positions.rules.y, positions.goal.y);
  assertEquals(positions.progress.y, positions.goal.y);
  assertEquals([positions.rules.x, positions.progress.x], [COL_W, -COL_W]);
  assertEquals(bands.map((b) => b.label), ['Goal']);
});

Deno.test('bandLayout puts amendments in the header row beside the goal, never in a side lane', () => {
  const g = board(
    [
      ...header(),
      mem('am1', 'amendment', 0.5),
      mem('i1', 'intent', 1, { tags: ['round:1'] }),
      mem('am2', 'amendment', 3),
    ],
    [...headerLinks(), link('am1', 'goal', 'depends-on'), link('am2', 'goal', 'depends-on')],
  );
  const { positions: p, bands } = bandLayout(g);
  assertEquals([p.am1.y, p.am2.y], [p.goal.y, p.goal.y]);
  // Beside the goal, oldest first, alternating right then left after rules and progress.
  assertEquals([p.rules.x, p.progress.x, p.am1.x, p.am2.x], [COL_W, -COL_W, 2 * COL_W, -2 * COL_W]);
  assertEquals(bands.map((b) => b.label), ['Goal', 'Round 1']);
  assert(p.i1.y > p.goal.y);
});

Deno.test('bandLayout gives two tagged rounds two bands in order, intents on each band row', () => {
  const g = board([
    ...header(),
    mem('i1', 'intent', 1, { tags: ['round:1'] }),
    mem('i2', 'intent', 1.2, { tags: ['round:1'] }),
    mem('i3', 'intent', 30, { tags: ['round:2'] }),
    mem('i4', 'intent', 30.1, { tags: ['round:2'] }),
  ], headerLinks());
  const { positions: p, bands } = bandLayout(g);
  assertEquals(bands.map((b) => b.label), ['Goal', 'Round 1', 'Round 2']);
  assertEquals(p.i1.y, p.i2.y);
  assertEquals(p.i3.y, p.i4.y);
  assert(p.goal.y < p.i1.y && p.i1.y < p.i3.y);
  assert(p.i1.y > bands[1].y && p.i1.y < bands[1].y + bands[1].height);
  assert(p.i3.y > bands[2].y && p.i3.y < bands[2].y + bands[2].height);
  assertEquals([p.i1.x, p.i2.x], [-COL_W / 2, COL_W / 2]);
});

Deno.test('bandLayout puts a fact directly below its intent, results stacked in creation order', () => {
  const g = board(
    [
      mem('i1', 'intent', 1),
      mem('f1', 'fact', 2),
      mem('p1', 'hint', 3, { snippet: 'Partial result for intent i1: half done' }),
    ],
    [link('f1', 'i1'), link('p1', 'i1', 'relates-to')],
  );
  const { positions: p } = bandLayout(g);
  assertEquals(p.f1.x, p.i1.x);
  assertEquals(p.p1.x, p.i1.x);
  assert(p.i1.y < p.f1.y && p.f1.y < p.p1.y);
});

Deno.test('bandLayout puts a fact derived from two intents under the earlier one', () => {
  const g = board(
    [mem('i1', 'intent', 1), mem('i2', 'intent', 1.5), mem('f', 'fact', 3)],
    [link('f', 'i2'), link('f', 'i1')],
  );
  const { positions: p } = bandLayout(g);
  assertEquals(p.f.x, p.i1.x);
});

Deno.test('roundGroups splits untagged intents at a gap over 2 minutes and keeps closer ones together', () => {
  const groups = roundGroups([
    mem('a', 'intent', 0),
    mem('b', 'intent', 1.5),
    mem('c', 'intent', 3),
    mem('d', 'intent', 5.5),
  ]);
  assertEquals(groups.map((g) => g.intents.map((n) => n.id)), [['a', 'b', 'c'], ['d']]);
  const { bands } = bandLayout(board([mem('a', 'intent', 0), mem('d', 'intent', 5.5)]));
  assertEquals(bands.map((b) => b.label), ['Batch 1', 'Batch 2']);
});

Deno.test('roundGroups joins an untagged group to a tagged round it is within 2 minutes of, else its own band', () => {
  const groups = roundGroups([
    mem('t1', 'intent', 0, { tags: ['round:1'] }),
    mem('u1', 'intent', 1),
    mem('u2', 'intent', 10),
    mem('t2', 'intent', 20, { tags: ['round:2'] }),
  ]);
  assertEquals(groups.map((g) => [g.round, g.intents.map((n) => n.id)]), [
    [1, ['t1', 'u1']],
    [null, ['u2']],
    [2, ['t2']],
  ]);
  const { bands } = bandLayout(board(groups.flatMap((g) => g.intents)));
  assertEquals(bands.map((b) => b.label), ['Round 1', 'Batch 2', 'Round 2']);
});

Deno.test('bandLayout puts a lead fact for intent none in the side lane of the band its time falls in', () => {
  const g = board([
    ...header(),
    mem('i1', 'intent', 1),
    mem('i2', 'intent', 1.5),
    mem('f1', 'fact', 3),
    mem('lead', 'fact', 4, { snippet: 'Fact for intent none: the cache is cold' }),
    mem('i3', 'intent', 20),
  ], [...headerLinks(), link('f1', 'i1')]);
  const { positions: p } = bandLayout(g);
  assert(p.lead.x > Math.max(p.i1.x, p.i2.x));
  assertEquals(p.lead.y, p.f1.y);
  assert(p.lead.y < p.i3.y);
});

Deno.test('bandLayout puts the conclusion in its own band at the bottom, centred', () => {
  const g = board(
    [...header(), mem('i1', 'intent', 1), mem('f1', 'fact', 2), mem('end', 'conclusion', 3)],
    [...headerLinks(), link('f1', 'i1'), link('end', 'f1')],
  );
  const { positions: p, bands } = bandLayout(g);
  assertEquals(p.end.x, 0);
  assert(Object.entries(p).every(([id, q]) => id === 'end' || q.y < p.end.y));
  assertEquals(bands.at(-1)?.label, 'Conclusion');
});

Deno.test('bandLayout: adding nodes to the newest band leaves earlier bands where they were', () => {
  const before = sampleBoard();
  const after = board(
    [...before.nodes, mem('E', 'intent', 20.5), mem('FD2', 'fact', 26), mem('lead', 'fact', 27)],
    [...before.edges, link('E', 'FB2'), link('FD2', 'D')],
  );
  const a = bandLayout(before).positions;
  const b = bandLayout(after).positions;
  for (const id of ['goal', 'rules', 'progress', 'A', 'F1', 'B', 'C', 'FB1', 'FB2', 'FB3', 'HB1', 'HB2']) {
    assertEquals(b[id], a[id], id);
  }
  assertEquals(bandLayout(after), bandLayout(after));
});

Deno.test('bandLayout lays out a sample board in time bands with no two nodes overlapping', () => {
  const g = sampleBoard();
  const { positions: p, bands } = bandLayout(g);
  assertEquals(bands.map((b) => b.label), ['Goal', 'Batch 1', 'Batch 2', 'Batch 3']);
  assertEquals(Object.keys(p).sort(), g.nodes.map((n) => n.id).sort());
  const pts = Object.values(p);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      assert(Math.abs(pts[i].x - pts[j].x) >= COL_W || Math.abs(pts[i].y - pts[j].y) >= 60, `${i} vs ${j}`);
    }
  }
  // Every child sits below what it links to (rules and progress sit beside the goal), each result under its intent.
  for (const e of g.edges.filter((e) => e.to !== 'goal')) assert(p[e.from].y > p[e.to].y, `${e.from} below ${e.to}`);
  for (const id of ['FB1', 'FB2', 'FB3']) assertEquals(p[id].x, p.B.x);
  assert(p.HB1.x > Math.max(p.B.x, p.C.x), 'free hints go to the side lane');
});

Deno.test('goalLinks links the goal to intents that link to nothing, and none without a goal', () => {
  const g = sampleBoard();
  assertEquals(goalLinks(g), [{ parent: 'goal', child: 'A' }]);
  assertEquals(goalLinks(board([mem('i', 'intent', 0)])), []);
});

Deno.test('structureChanged sees nodes and links come and go, not changed-only polls', () => {
  const e = [link('a', 'b')];
  assertEquals(structureChanged({ added: [], removed: [] }, e, [link('a', 'b')]), false);
  assertEquals(structureChanged({ added: ['c'], removed: [] }, e, e), true);
  assertEquals(structureChanged({ added: [], removed: ['c'] }, e, e), true);
  assertEquals(structureChanged({ added: [], removed: [] }, e, [...e, link('c', 'b')]), true);
  assertEquals(structureChanged({ added: [], removed: [] }, e, [link('a', 'b', 'relates-to')]), true);
});

Deno.test('fitViewport centres the box and never zooms in past maxZoom', () => {
  const opts = { padding: 30, minZoom: 0.2, maxZoom: 1.25 };
  const small = fitViewport({ x1: -50, y1: 0, x2: 50, y2: 100 }, 1000, 600, opts);
  assertEquals(small.zoom, 1.25);
  assertEquals(small.pan, { x: 500, y: 300 - 1.25 * 50 });
  const big = fitViewport({ x1: 0, y1: 0, x2: 1880, y2: 540 }, 1000, 600, opts);
  assertEquals(big.zoom, 0.5);
  assertEquals(fitViewport({ x1: 0, y1: 0, x2: 100000, y2: 10 }, 1000, 600, opts).zoom, 0.2);
  assert(sameViewport(big, { zoom: 0.5, pan: { ...big.pan } }));
  assert(!sameViewport(big, { zoom: 0.5, pan: { x: big.pan.x + 1, y: big.pan.y } }));
});

// ── facts ──────────────────────────────────────────────────────────

Deno.test('foundLine reads the Found line and ignores a missing or empty one', () => {
  assertEquals(
    foundLine('Fact for intent x: n = 7 passes\nDid: ran it\nFound: 7 passes twice\nBy: w'),
    '7 passes twice',
  );
  assertEquals(foundLine('Fact for intent x: n = 7 passes\nBy: w'), null);
  assertEquals(foundLine('Fact for intent x: r\nFound:   \n'), null);
  assertEquals(foundLine('Fact for intent x: Found: not a line'), null);
});

Deno.test('isMeasurement recognises the lead measurement fact by its first line', () => {
  assert(isMeasurement('Fact for intent none: measurement of 7 passed\nEvidence: x'));
  assert(isMeasurement('  Fact for intent none: measurement of abc failed'));
  assert(!isMeasurement('Fact for intent 1234: measurement of 7 passed'));
  assert(!isMeasurement('Fact for intent none: something else'));
  assert(!isMeasurement('Evidence: Fact for intent none: measurement of 7 passed'));
  assert(!isMeasurement(undefined));
});

Deno.test('measurementVerdict maps passed and failed to confirmed and refuted', () => {
  assertEquals(measurementVerdict('Fact for intent none: measurement of 7 passed'), 'confirmed');
  assertEquals(measurementVerdict('Fact for intent none: measurement of 7 failed'), 'refuted');
  assertEquals(measurementVerdict('Fact for intent none: measurement of 7 hung'), null);
  assertEquals(measurementVerdict('Fact for intent 1: n = 7 passes'), null);
});

Deno.test('latestMeasurement takes the newest measurement fact created before the time', () => {
  const node = (id: string, createdAt: string, text: string, tags = ['kind:fact']) => ({
    id,
    createdAt,
    tags,
    snippet: text,
  });
  const nodes = [
    node('a', '2026-01-01T10:00:00Z', 'Fact for intent none: measurement of 3 failed'),
    node('b', '2026-01-01T11:00:00Z', 'Fact for intent none: measurement of 7 passed'),
    node('c', '2026-01-01T12:00:00Z', 'Fact for intent none: measurement of 9 passed'),
    node('d', '2026-01-01T10:30:00Z', 'Fact for intent 1: n = 7 passes'),
    node('e', '2026-01-01T10:45:00Z', 'Fact for intent none: measurement of 5 passed', ['kind:hint']),
  ];
  assertEquals(latestMeasurement(nodes, '2026-01-01T11:30:00Z')?.id, 'b');
  assertEquals(latestMeasurement(nodes, '2026-01-01T10:30:00Z')?.id, 'a');
  assertEquals(latestMeasurement(nodes, '2026-01-01T09:00:00Z'), null);
  assertEquals(latestMeasurement(nodes, null)?.id, 'c');
  assertEquals(latestMeasurement([], null), null);
});

Deno.test('citations keeps outgoing derived-from and relates-to links, once each, and counts the overflow', () => {
  const l = (type: string, direction: string, memoryId: string) => ({ type, direction, memoryId });
  const links = [
    l('derived-from', 'out', 'f1'),
    l('derived-from', 'in', 'fact-of-me'),
    l('relates-to', 'both', 'h1'),
    l('depends-on', 'out', 'rules'),
    l('supersedes', 'out', 'old'),
    l('derived-from', 'out', 'f1'),
    l('derived-from', 'out', 'f2'),
  ];
  assertEquals(citations(links), { ids: ['f1', 'h1', 'f2'], more: 0 });
  const many = Array.from({ length: 8 }, (_, i) => l('derived-from', 'out', `m${i}`));
  assertEquals(citations(many, 5), { ids: ['m0', 'm1', 'm2', 'm3', 'm4'], more: 3 });
  assertEquals(citations(undefined), { ids: [], more: 0 });
});

Deno.test('citations drops memories the graph shows were created after the intent', () => {
  const l = (type: string, direction: string, memoryId: string) => ({ type, direction, memoryId });
  const links = [
    l('derived-from', 'out', 'f1'),
    l('relates-to', 'both', 'later-hint'),
    l('relates-to', 'both', 'unknown'),
    l('derived-from', 'out', 'same-time'),
  ];
  const times: Record<string, string> = {
    f1: '2026-01-01T09:00:00Z',
    'later-hint': '2026-01-01T11:00:00Z',
    'same-time': '2026-01-01T10:00:00Z',
  };
  const time = { before: '2026-01-01T10:00:00Z', createdAt: (id: string) => times[id] ?? null };
  assertEquals(citations(links, 5, time), { ids: ['f1', 'unknown', 'same-time'], more: 0 });
  const many = [
    ...Array.from({ length: 3 }, (_, i) => l('relates-to', 'both', `late${i}`)),
    ...Array.from({ length: 6 }, (_, i) => l('derived-from', 'out', `m${i}`)),
  ];
  const late = (id: string) => id.startsWith('late') ? '2026-01-01T11:00:00Z' : '2026-01-01T09:00:00Z';
  assertEquals(citations(many, 5, { before: '2026-01-01T10:00:00Z', createdAt: late }), {
    ids: ['m0', 'm1', 'm2', 'm3', 'm4'],
    more: 1,
  });
});

Deno.test('builtBefore keeps a cited memory created no later than the intent', () => {
  const intent = { createdAt: '2026-01-01T10:00:00Z' };
  assert(builtBefore({ createdAt: '2026-01-01T09:59:59Z' }, intent));
  assert(builtBefore({ createdAt: '2026-01-01T10:00:00Z' }, intent));
  assert(!builtBefore({ createdAt: '2026-01-01T10:00:01Z' }, intent));
  assert(builtBefore({ createdAt: 'not a time' }, intent));
});

Deno.test('progressFields reads round, best result, established and open questions', () => {
  const text = 'Progress for board b\nRound: 2\nLast round at: x\nEstablished: n = 7 passes (fact 1)\n' +
    'Best result: n = 7 passes\nOpen questions: does 5 pass?\nIntents: 2';
  assertEquals(progressFields(text), {
    round: '2',
    established: 'n = 7 passes (fact 1)',
    best: 'n = 7 passes',
    open: 'does 5 pass?',
  });
  assertEquals(progressFields('nothing'), { round: null, established: null, best: null, open: null });
});

Deno.test('formatTokens shortens with k and M, one decimal under ten', () => {
  assertEquals(
    [0, 999, 1000, 1234, 12345, 999_999, 1_234_567, 12_345_678].map(formatTokens),
    ['0', '999', '1.0k', '1.2k', '12k', '1.0M', '1.2M', '12M'],
  );
});

Deno.test('stripText counts cache in the input; zero says none yet; the title is exact', () => {
  const total = { input: 1000, output: 310_000, cacheRead: 11_000_000, cacheWrite: 1_400_000 };
  assertEquals(inputTotal(total), 12_401_000);
  assertEquals(stripText(total), 'Tokens 12M in · 310k out');
  assertEquals(stripText({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 'Tokens: none yet');
  assertEquals(
    totalTitle(total),
    'Input 1,000 · cache read 11,000,000 · cache write 1,400,000 · output 310,000 (raw tokens, no costs)',
  );
});

Deno.test('runsFor matches an intent by id, a fact by its worker label, the goal to the lead', () => {
  const t = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const run = (runLabel: string, role: string, intentId: string | null) => ({ runLabel, role, intentId, tokens: t });
  const runs = [
    run('board-b-0a1b', 'worker', 'i1'),
    run('board-b-lead-9f9f', 'lead', null),
    run('board-b-0c0c', 'worker', null),
  ];
  assertEquals(runsFor(runs, { id: 'i1', tags: ['kind:intent'] }).map((r) => r.runLabel), ['board-b-0a1b']);
  assertEquals(
    runsFor(runs, { id: 'f1', tags: ['kind:fact'], content: 'Found: x\nBy: board-b-0c0c' }).map((r) => r.runLabel),
    ['board-b-0c0c'],
  );
  assertEquals(runsFor(runs, { id: 'g', tags: ['kind:goal'] }).map((r) => r.runLabel), ['board-b-lead-9f9f']);
  assertEquals(runsFor(runs, { id: 'h', tags: ['kind:hint'] }), []);
  assertEquals(runsFor(runs, { id: 'f2', tags: ['kind:fact'], content: 'no label' }), []);
});
