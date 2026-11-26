import { assert, assertEquals } from '@std/assert';
import { kindOf, shortName, stateOf, verdictOf, workerLabel } from '../../web/public/names.js';
import { diffGraph } from '../../web/public/diff.js';
import { parseTranscript } from '../../web/public/transcript.js';
import { nextDelay, POLL_MS } from '../../web/public/poll.js';
import { parseStatus } from '../../web/public/status.js';
import { applyChunk, emptyLog } from '../../web/public/logbuf.js';
import { boardHash, parseHash, tagHash } from '../../web/public/route.js';
import { distanceToSegment, freeSlot } from '../../web/public/placement.js';

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

// ── placement ──────────────────────────────────────────────────────

const EXTENT = { left: 20, top: 12, right: 20, bottom: 30 };
const box = (x: number, y: number) => ({ x1: x - 20, y1: y - 12, x2: x + 20, y2: y + 30 });

Deno.test('distanceToSegment measures to the nearest point, ends included', () => {
  const s = { x1: 0, y1: 0, x2: 0, y2: 100 };
  assertEquals(distanceToSegment({ x: 5, y: 50 }, s), 5);
  assertEquals(distanceToSegment({ x: 0, y: 130 }, s), 30);
  assertEquals(distanceToSegment({ x: 3, y: 4 }, { x1: 0, y1: 0, x2: 0, y2: 0 }), 5);
});

Deno.test('freeSlot goes straight below the anchor when nothing is there', () => {
  const scene = { boxes: [box(0, 0)], segments: [], extent: EXTENT, radius: 11 };
  assertEquals(freeSlot({ x: 0, y: 0 }, scene, { rowGap: 90 }), { x: 0, y: 90 });
});

Deno.test('freeSlot moves sideways off an edge that runs down from the anchor', () => {
  // The anchor's existing child sits two levels down, so its edge passes through the spot one level below.
  const scene = {
    boxes: [box(0, 0), box(0, 180)],
    segments: [{ x1: 0, y1: 180, x2: 0, y2: 0 }],
    extent: EXTENT,
    radius: 11,
  };
  const spot = freeSlot({ x: 0, y: 0 }, scene, { rowGap: 90, step: 40 });
  assertEquals(spot, { x: 40, y: 90 });
  assert(distanceToSegment(spot, scene.segments[0]) >= 11 + 14);
});

Deno.test('freeSlot skips slots whose box overlaps a node, trying +step then -step outwards', () => {
  const scene = { boxes: [box(0, 90), box(40, 90)], segments: [], extent: EXTENT, radius: 11 };
  // 0 and +40 overlap; -40 overlaps the node at 0 (boxes 40 wide, margin 6); +80 overlaps +40; -80 is clear.
  assertEquals(freeSlot({ x: 0, y: 0 }, scene, { rowGap: 90, step: 40 }), { x: -80, y: 90 });
});

Deno.test('freeSlot drops a row when the first row is full, and is deterministic', () => {
  const scene = {
    boxes: [{ x1: -1000, y1: 70, x2: 1000, y2: 110 }],
    segments: [],
    extent: EXTENT,
    radius: 11,
  };
  const a = freeSlot({ x: 0, y: 0 }, scene, { rowGap: 90, step: 40, maxSteps: 10 });
  assertEquals(a, { x: 0, y: 180 });
  assertEquals(freeSlot({ x: 0, y: 0 }, scene, { rowGap: 90, step: 40, maxSteps: 10 }), a);
});
