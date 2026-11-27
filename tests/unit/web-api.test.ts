import { assertEquals } from '@std/assert';
import { routeWebApi, type WebStore } from '../../supabase/functions/_shared/web-api.ts';
import type { UsageRow, UsageStore } from '../../supabase/functions/_shared/usage-store.ts';
import { StoreError } from '../../supabase/functions/_shared/limits.ts';
import { LazyEmbedder } from '../../supabase/functions/_shared/embedder.ts';
import type {
  BrowseFilters,
  BrowsePage,
  GraphFilters,
  GraphResult,
  LinkType,
  Memory,
  ScopeInfo,
  SearchFilters,
  SearchMode,
  SearchResult,
  StoreRequest,
  UpdateRequest,
} from '../../supabase/functions/_shared/types.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const ABSENT = '22222222-2222-4222-8222-222222222222';

function mem(id: string, tags: string[] = [], scope = 's1'): Memory {
  return {
    id,
    scope,
    content: `content ${id}`,
    category: 'observation',
    tags,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'a',
    updatedBy: 'a',
  };
}

const EMPTY_GRAPH: GraphResult = { nodes: [], edges: [], truncated: false, total: 0 };

class Fake implements WebStore {
  calls: { fn: string; args: unknown[] }[] = [];
  page: BrowsePage = { memories: [mem(ID)], hasMore: true };
  ranked: SearchResult[] = [{ memory: mem(ID), score: 1 }];
  scopes: ScopeInfo[] = [{ scope: 's1', description: null, access: 'read', memoryCount: 3 }];
  failWith: Error | undefined;

  private rec(fn: string, ...args: unknown[]) {
    this.calls.push({ fn, args });
    if (this.failWith) throw this.failWith;
  }
  listScopes() {
    this.rec('listScopes');
    return Promise.resolve(this.scopes);
  }
  browse(f: BrowseFilters) {
    this.rec('browse', f);
    return Promise.resolve(this.page);
  }
  search(q: string, mode: SearchMode, f: SearchFilters) {
    this.rec('search', q, mode, f);
    return Promise.resolve(this.ranked);
  }
  get(id: string) {
    this.rec('get', id);
    return Promise.resolve(id === ID ? mem(ID) : null);
  }
  graph(f: GraphFilters) {
    this.rec('graph', f);
    return Promise.resolve(EMPTY_GRAPH);
  }
  memberName() {
    this.rec('memberName');
    return Promise.resolve('pat');
  }
  store(scope: string, r: StoreRequest) {
    this.rec('store', scope, r);
    return Promise.resolve({ ...mem(ID, r.tags, scope), content: r.content });
  }
  relate(from: string, to: string, type: LinkType) {
    this.rec('relate', from, to, type);
    return Promise.resolve();
  }
  update(id: string, u: UpdateRequest) {
    this.rec('update', id, u);
    return Promise.resolve(mem(id));
  }
  delete(id: string) {
    this.rec('delete', id);
    return Promise.resolve();
  }
}

/** Records what the usage routes pass through. */
class UsageFake implements UsageStore {
  calls: { fn: string; args: unknown[] }[] = [];
  record(r: UsageRow) {
    this.calls.push({ fn: 'record', args: [r] });
    return Promise.resolve('33333333-3333-4333-8333-333333333333');
  }
  forBoard(scope: string, board: string) {
    this.calls.push({ fn: 'forBoard', args: [scope, board] });
    return Promise.resolve({ runs: [], total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, more: false });
  }
  deleteBoard(scope: string, board: string) {
    this.calls.push({ fn: 'deleteBoard', args: [scope, board] });
    return Promise.resolve(2);
  }
}
const NO_USAGE = new UsageFake();

const get = (store: WebStore, path: string, usage: UsageStore = NO_USAGE) =>
  routeWebApi(new Request(`http://x/functions/v1/web-api${path}`), store, usage);

Deno.test('GET /scopes returns the scopes', async () => {
  const s = new Fake();
  const r = await get(s, '/scopes');
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { scopes: s.scopes });
});

Deno.test('the path resolves with or without the functions prefix', async () => {
  const s = new Fake();
  for (const url of ['http://x/web-api/scopes', 'http://x/functions/v1/web-api/scopes']) {
    const r = await routeWebApi(new Request(url), s, NO_USAGE);
    assertEquals(r.status, 200);
    await r.json();
  }
});

Deno.test('GET /memories without q browses and passes the filters', async () => {
  const s = new Fake();
  const r = await get(
    s,
    '/memories?scope=a,b&tags=x,y&tags_all=p&category=observation&limit=5&offset=10',
  );
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { memories: s.page.memories, hasMore: true });
  assertEquals(s.calls, [{
    fn: 'browse',
    args: [{
      scopes: ['a', 'b'],
      tags: ['x', 'y'],
      tagsAll: ['p'],
      category: 'observation',
      limit: 5,
      offset: 10,
    }],
  }]);
});

Deno.test('absent and empty values reach the store as undefined', async () => {
  const s = new Fake();
  await (await get(s, '/memories?q=&tags=&scope=')).json();
  const f = s.calls[0].args[0] as BrowseFilters;
  assertEquals(s.calls[0].fn, 'browse');
  assertEquals(f.limit, undefined);
  assertEquals(f.offset, undefined);
  assertEquals(f.tags, undefined);
  assertEquals(f.scopes, undefined);
  assertEquals(f.category, undefined);
});

Deno.test('GET /memories with q runs a hybrid search without touching', async () => {
  const s = new Fake();
  const r = await get(s, '/memories?q=hello&scope=a&limit=7');
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { memories: [mem(ID)], hasMore: false });
  assertEquals(s.calls.length, 1);
  assertEquals(s.calls[0].fn, 'search');
  assertEquals(s.calls[0].args[0], 'hello');
  assertEquals(s.calls[0].args[1], 'hybrid');
  const f = s.calls[0].args[2] as SearchFilters;
  assertEquals(f.touch, false);
  assertEquals(f.scopes, ['a']);
  assertEquals(f.limit, 7);
});

Deno.test('offset with q is a 400', async () => {
  const s = new Fake();
  const r = await get(s, '/memories?q=hello&offset=5');
  assertEquals(r.status, 400);
  assertEquals(await r.json(), { error: 'offset applies to browsing only' });
  assertEquals(s.calls.length, 0);
});

Deno.test('a non-integer limit is passed through for the store to reject', async () => {
  const s = new Fake();
  s.failWith = new StoreError('limit must be between 1 and 400');
  const r = await get(s, '/memories?limit=abc');
  assertEquals(r.status, 400);
  assertEquals(await r.json(), { error: 'limit must be between 1 and 400' });
  assertEquals(Number.isNaN((s.calls[0].args[0] as BrowseFilters).limit), true);
});

Deno.test('a bad category or detail is a 400', async () => {
  const s = new Fake();
  const a = await get(s, '/memories?category=nope');
  assertEquals(a.status, 400);
  await a.json();
  const b = await get(s, '/graph?tags_all=x&detail=huge');
  assertEquals(b.status, 400);
  await b.json();
  assertEquals(s.calls.length, 0);
});

Deno.test('GET /memories/:id returns the memory', async () => {
  const s = new Fake();
  const r = await get(s, `/memories/${ID}`);
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { memory: mem(ID) });
});

Deno.test('a malformed and an absent id give the same 404 body', async () => {
  const s = new Fake();
  const bad = await get(s, '/memories/not-a-uuid');
  const absent = await get(s, `/memories/${ABSENT}`);
  assertEquals(bad.status, 404);
  assertEquals(absent.status, 404);
  const b = await bad.json();
  const a = await absent.json();
  assertEquals(b, { error: 'Memory not-a-uuid not found' });
  assertEquals(a.error.replace(ABSENT, 'not-a-uuid'), b.error);
});

Deno.test('GET /graph requires tags_all and passes the filters', async () => {
  const s = new Fake();
  const none = await get(s, '/graph?scope=a');
  assertEquals(none.status, 400);
  await none.json();
  const r = await get(s, '/graph?tags_all=board:x,kind:goal&scope=a&detail=full');
  assertEquals(r.status, 200);
  assertEquals(await r.json(), EMPTY_GRAPH);
  assertEquals(s.calls, [{
    fn: 'graph',
    args: [{ tagsAll: ['board:x', 'kind:goal'], scopes: ['a'], detail: 'full' }],
  }]);
});

Deno.test('GET /boards lists goals with a board tag and reports more', async () => {
  const s = new Fake();
  s.page = {
    memories: [
      mem('g1', ['kind:goal', 'board:alpha', 'state:active'], 'sa'),
      mem('g2', ['kind:goal'], 'sb'),
      mem('g3', ['kind:goal', 'board:beta'], 'sc'),
    ],
    hasMore: true,
  };
  const r = await get(s, '/boards');
  assertEquals(r.status, 200);
  assertEquals(await r.json(), {
    boards: [
      { scope: 'sa', board: 'alpha', state: 'active', goalId: 'g1' },
      { scope: 'sc', board: 'beta', state: null, goalId: 'g3' },
    ],
    more: true,
  });
  assertEquals(s.calls, [{ fn: 'browse', args: [{ tagsAll: ['kind:goal'], limit: 400 }] }]);
});

Deno.test('a non-store error is a 500 Database error with no raw text', async () => {
  const s = new Fake();
  s.failWith = new Error('relation x does not exist');
  const orig = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    const r = await get(s, '/scopes');
    assertEquals(r.status, 500);
    assertEquals(await r.json(), { error: 'Database error' });
  } finally {
    console.error = orig;
  }
  assertEquals(logged.length, 1);
});

Deno.test('non-GET is 405 and an unknown route is 404', async () => {
  const s = new Fake();
  const p = await routeWebApi(new Request('http://x/web-api/scopes', { method: 'POST' }), s, NO_USAGE);
  assertEquals(p.status, 405);
  await p.json();
  const u = await get(s, '/nope');
  assertEquals(u.status, 404);
  await u.json();
});

Deno.test('LazyEmbedder does not construct until first embed', async () => {
  let made = 0;
  const lazy = new LazyEmbedder(() => {
    made++;
    return {
      embed: (t: string) => Promise.resolve([t.length]),
      embedMany: (ts: string[]) => Promise.resolve(ts.map((t) => [t.length])),
    };
  });
  assertEquals(made, 0);
  assertEquals(await lazy.embed('ab'), [2]);
  assertEquals(await lazy.embedMany(['abc']), [[3]]);
  assertEquals(made, 1);
});

// ── Write routes ───────────────────────────────────────────────────

const GOAL_ID = '33333333-3333-4333-8333-333333333333';
const FACT_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';
const HINT_ID = '66666666-6666-4666-8666-666666666666';
const PROGRESS_ID = '77777777-7777-4777-8777-777777777777';
const RULES_ID = '88888888-8888-4888-8888-888888888888';
const CONCLUSION_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_BOARD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SCOPE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const GOAL_TEXT = 'Goal: g\nDone when: d\nMax open intents: 2\nMax intents: 5\nClaim minutes: 30';

function boardMem(id: string, kind: string, extra: string[] = [], content = `content ${id}`, scope = 's1'): Memory {
  return { ...mem(id, ['board:b', `kind:${kind}`, ...extra, 'evergreen'], scope), content };
}

class BoardFake extends Fake {
  mems: Memory[];
  relateFails: Error | undefined;
  constructor(goalState = 'running', extra: Memory[] = []) {
    super();
    this.mems = [
      boardMem(GOAL_ID, 'goal', [`state:${goalState}`], GOAL_TEXT),
      boardMem(PROGRESS_ID, 'progress', [], 'Progress for board b.\nRound: 3\nLast round at: never'),
      boardMem(RULES_ID, 'rules'),
      boardMem(FACT_ID, 'fact', ['verdict:confirmed']),
      boardMem(INTENT_ID, 'intent', ['state:open', 'round:1']),
      boardMem(HINT_ID, 'hint'),
      boardMem(CONCLUSION_ID, 'conclusion'),
      { ...mem(OTHER_BOARD_ID, ['board:other', 'kind:fact']) },
      boardMem(OTHER_SCOPE_ID, 'fact', [], 'elsewhere', 's2'),
      ...extra,
    ];
  }
  override browse(f: BrowseFilters) {
    this.calls.push({ fn: 'browse', args: [f] });
    const hits = this.mems.filter((m) =>
      (f.tagsAll ?? []).every((t) => m.tags.includes(t)) && (!f.scopes || f.scopes.includes(m.scope))
    );
    return Promise.resolve({ memories: hits.slice(0, f.limit ?? 20), hasMore: hits.length > (f.limit ?? 20) });
  }
  override get(id: string) {
    this.calls.push({ fn: 'get', args: [id] });
    return Promise.resolve(this.mems.find((m) => m.id === id) ?? null);
  }
  override memberName() {
    this.calls.push({ fn: 'memberName', args: [] });
    return Promise.resolve('pat');
  }
  override store(scope: string, r: StoreRequest) {
    this.calls.push({ fn: 'store', args: [scope, r] });
    const m = { ...mem(NEW_ID, r.tags, scope), content: r.content, category: r.category };
    this.mems.push(m);
    return Promise.resolve(m);
  }
  override relate(from: string, to: string, type: LinkType) {
    this.calls.push({ fn: 'relate', args: [from, to, type] });
    if (this.relateFails) return Promise.reject(this.relateFails);
    return Promise.resolve();
  }
  override update(id: string, u: UpdateRequest) {
    this.calls.push({ fn: 'update', args: [id, u] });
    const m = this.mems.find((x) => x.id === id)!;
    Object.assign(m, defined(u));
    return Promise.resolve(m);
  }
  override delete(id: string) {
    this.calls.push({ fn: 'delete', args: [id] });
    return Promise.resolve();
  }
  writes() {
    return this.calls.filter((c) => ['store', 'relate', 'update', 'delete'].includes(c.fn));
  }
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const post = (store: WebStore, path: string, body: unknown, type = 'application/json', usage: UsageStore = NO_USAGE) =>
  routeWebApi(
    new Request(`http://x/functions/v1/web-api${path}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    store,
    usage,
  );

const HINT_TAGS = ['board:b', 'kind:hint', 'evergreen'];

Deno.test('POST /hints stores the skill shape as the caller and returns 201', async () => {
  const s = new BoardFake();
  const r = await post(s, '/hints', { scope: 's1', board: 'b', text: 'the cache\nis cold' });
  assertEquals(r.status, 201);
  const body = await r.json();
  assertEquals(body.memory.id, NEW_ID);
  assertEquals(s.writes(), [{
    fn: 'store',
    args: ['s1', { content: 'Hint: the cache is cold\nFrom: pat', category: 'observation', tags: HINT_TAGS }],
  }]);
  const order = s.calls.map((c) => c.fn);
  assertEquals(order.indexOf('memberName') < order.indexOf('store'), true);
});

Deno.test('POST /hints links relates-to an intent, fact or hint, and nothing else', async () => {
  for (const about of [INTENT_ID, FACT_ID, HINT_ID]) {
    const s = new BoardFake();
    const r = await post(s, '/hints', { scope: 's1', board: 'b', text: 'x', about });
    assertEquals(r.status, 201, about);
    await r.json();
    assertEquals(s.writes().map((c) => c.fn), ['store', 'relate']);
    assertEquals(s.writes()[1].args, [NEW_ID, about, 'relates-to']);
  }
  for (const about of [GOAL_ID, PROGRESS_ID, RULES_ID, CONCLUSION_ID]) {
    const s = new BoardFake();
    const r = await post(s, '/hints', { scope: 's1', board: 'b', text: 'x', about });
    assertEquals(r.status, 201, about);
    await r.json();
    assertEquals(s.writes().map((c) => c.fn), ['store'], about);
  }
});

Deno.test('POST /hints about an absent, off-board or other-scope memory is the store 404 and writes nothing', async () => {
  for (const about of [ABSENT, OTHER_BOARD_ID, OTHER_SCOPE_ID, 'not-a-uuid']) {
    const s = new BoardFake();
    const r = await post(s, '/hints', { scope: 's1', board: 'b', text: 'x', about });
    assertEquals(r.status, 404, about);
    assertEquals(await r.json(), { error: `Memory ${about} not found` });
    assertEquals(s.writes(), []);
  }
});

Deno.test('hints are allowed in any board state', async () => {
  for (const state of ['running', 'paused', 'stopped', 'done']) {
    const s = new BoardFake(state);
    const r = await post(s, '/hints', { scope: 's1', board: 'b', text: 'x' });
    assertEquals(r.status, 201, state);
    await r.json();
  }
});

Deno.test('a board with no goal in the scope is 404 Board <board> not found', async () => {
  const s = new BoardFake();
  for (
    const [path, body] of [
      ['/hints', { scope: 's1', board: 'nope', text: 'x' }],
      ['/intents', { scope: 's1', board: 'nope', text: 'x' }],
      ['/boards/control', { scope: 's1', board: 'nope', action: 'pause' }],
      ['/hints', { scope: 's2', board: 'b', text: 'x' }],
    ] as const
  ) {
    const r = await post(s, path, body);
    assertEquals(r.status, 404, path);
    assertEquals(await r.json(), { error: `Board ${body.board} not found` });
  }
  assertEquals(s.writes(), []);
});

Deno.test('a scope the caller cannot read reads the same as a board with no goal', async () => {
  const s = new BoardFake();
  s.browse = (f: BrowseFilters) => {
    s.calls.push({ fn: 'browse', args: [f] });
    return Promise.reject(new StoreError(`Scope '${f.scopes?.[0]}' not found`));
  };
  const r = await post(s, '/hints', { scope: 'hidden', board: 'b', text: 'x' });
  assertEquals(r.status, 404);
  assertEquals(await r.json(), { error: 'Board b not found' });
});

const AMENDMENT_TAGS = ['board:b', 'kind:amendment', 'evergreen'];

Deno.test('POST /amendments stores the skill shape, linked depends-on the goal, and returns 201', async () => {
  const s = new BoardFake();
  const r = await post(s, '/amendments', { scope: 's1', board: 'b', text: '15% is\nacceptable' });
  assertEquals(r.status, 201);
  assertEquals((await r.json()).memory.id, NEW_ID);
  assertEquals(s.writes(), [
    {
      fn: 'store',
      args: ['s1', {
        content: 'Amendment: 15% is acceptable\nFrom: pat',
        category: 'observation',
        tags: AMENDMENT_TAGS,
      }],
    },
    { fn: 'relate', args: [NEW_ID, GOAL_ID, 'depends-on'] },
  ]);
});

Deno.test('amendments are allowed in any board state but done, which is 409', async () => {
  for (const state of ['running', 'paused', 'stopped']) {
    const s = new BoardFake(state);
    const r = await post(s, '/amendments', { scope: 's1', board: 'b', text: 'x' });
    assertEquals(r.status, 201, state);
    await r.json();
  }
  const s = new BoardFake('done');
  const r = await post(s, '/amendments', { scope: 's1', board: 'b', text: 'x' });
  assertEquals(r.status, 409);
  assertEquals(await r.json(), { error: 'Board is done' });
  assertEquals(s.writes(), []);
});

Deno.test('POST /amendments: unknown board is 404, bad bodies are 400, wrong type 415, GET 405', async () => {
  const s = new BoardFake();
  const nf = await post(s, '/amendments', { scope: 's1', board: 'nope', text: 'x' });
  assertEquals(nf.status, 404);
  assertEquals(await nf.json(), { error: 'Board nope not found' });
  for (
    const body of [
      { board: 'b', text: 'x' },
      { scope: 's1', board: 'B!', text: 'x' },
      { scope: 's1', board: 'b', text: ' \n ' },
      { scope: 's1', board: 'b', text: 'x'.repeat(2001) },
    ]
  ) {
    const r = await post(s, '/amendments', body);
    assertEquals(r.status, 400);
    await r.json();
  }
  const t = await post(s, '/amendments', { scope: 's1', board: 'b', text: 'x' }, 'text/plain');
  assertEquals(t.status, 415);
  await t.json();
  const g = await routeWebApi(new Request('http://x/functions/v1/web-api/amendments'), s, NO_USAGE);
  assertEquals(g.status, 405);
  await g.json();
  assertEquals(s.writes(), []);
});

Deno.test('a failed link after an amendment deletes the stored memory and returns the error', async () => {
  const s = new BoardFake();
  s.relateFails = new StoreError('Memory has too many links');
  const r = await post(s, '/amendments', { scope: 's1', board: 'b', text: 'x' });
  assertEquals(r.status, 400);
  assertEquals(await r.json(), { error: 'Memory has too many links' });
  assertEquals(s.writes().map((c) => c.fn), ['store', 'relate', 'delete']);
});

Deno.test('write routes need a JSON content type, else 415', async () => {
  const s = new BoardFake();
  for (const path of ['/hints', '/intents', '/boards/control']) {
    const r = await post(s, path, { scope: 's1', board: 'b', text: 'x', action: 'pause' }, 'text/plain');
    assertEquals(r.status, 415, path);
    await r.json();
    const none = await routeWebApi(
      new Request(`http://x/web-api${path}`, { method: 'POST', body: '{}' }).clone(),
      s,
      NO_USAGE,
    );
    // A body string defaults to text/plain; still 415.
    assertEquals(none.status, 415, path);
    await none.json();
  }
  const ok = await post(s, '/hints', { scope: 's1', board: 'b', text: 'x' }, 'application/json; charset=utf-8');
  assertEquals(ok.status, 201);
  await ok.json();
});

Deno.test('a malformed body is a 400 and writes nothing', async () => {
  const s = new BoardFake();
  const cases: [string, unknown][] = [
    ['/hints', '{not json'],
    ['/hints', '[]'],
    ['/hints', { board: 'b', text: 'x' }],
    ['/hints', { scope: 's1', board: 'B!', text: 'x' }],
    ['/hints', { scope: 's1', board: 'b' }],
    ['/hints', { scope: 's1', board: 'b', text: ' \n ' }],
    ['/hints', { scope: 's1', board: 'b', text: 'x'.repeat(2001) }],
    ['/hints', { scope: 's1', board: 'b', text: 'x', about: 5 }],
    ['/intents', { scope: 's1', board: 'b', text: 'x', produce: 'p'.repeat(501) }],
    ['/intents', { scope: 's1', board: 'b', text: 'x', giveUp: 'g'.repeat(501) }],
    ['/intents', { scope: 's1', board: 'b', text: 'x', produce: 7 }],
    ['/boards/control', { scope: 's1', board: 'b' }],
    ['/boards/control', { scope: 's1', board: 'b', action: 'explode' }],
  ];
  for (const [path, body] of cases) {
    const r = await post(s, path, body);
    assertEquals(r.status, 400, JSON.stringify(body));
    assertEquals(typeof (await r.json()).error, 'string');
  }
  assertEquals(s.writes(), []);
});

Deno.test('text of exactly 2,000 characters after folding is accepted', async () => {
  const s = new BoardFake();
  const r = await post(s, '/hints', { scope: 's1', board: 'b', text: `  ${'x'.repeat(2000)}\n` });
  assertEquals(r.status, 201);
  await r.json();
});

const INTENT_TAGS = (round?: number) => [
  'board:b',
  'kind:intent',
  'state:open',
  ...(round === undefined ? [] : [`round:${round}`]),
  'evergreen',
];

Deno.test('POST /intents stores the skill shape with the current round', async () => {
  const s = new BoardFake();
  const r = await post(s, '/intents', { scope: 's1', board: 'b', text: 'try the slow path' });
  assertEquals(r.status, 201);
  assertEquals((await r.json()).memory.id, NEW_ID);
  assertEquals(s.writes(), [{
    fn: 'store',
    args: ['s1', {
      content: 'Intent: try the slow path\nWhy: added by pat from the web UI\n' +
        'Produce: a fact reporting what trying this showed\n' +
        "Give up when: it cannot be done within the board's rules; record an inconclusive fact",
      category: 'observation',
      tags: INTENT_TAGS(3),
    }],
  }]);
});

Deno.test('POST /intents with no progress memory leaves the round tag off', async () => {
  const s = new BoardFake();
  s.mems = s.mems.filter((m) => m.id !== PROGRESS_ID);
  const r = await post(s, '/intents', { scope: 's1', board: 'b', text: 't', produce: 'a\nb', giveUp: 'c' });
  assertEquals(r.status, 201);
  await r.json();
  const req = s.writes()[0].args[1] as StoreRequest;
  assertEquals(req.tags, INTENT_TAGS());
  assertEquals(req.content.split('\n').slice(2), ['Produce: a b', 'Give up when: c']);
});

Deno.test('POST /intents from a fact links derived-from it and says so in Why', async () => {
  const s = new BoardFake();
  const r = await post(s, '/intents', { scope: 's1', board: 'b', text: 't', from: FACT_ID });
  assertEquals(r.status, 201);
  await r.json();
  const w = s.writes();
  assertEquals(w.map((c) => c.fn), ['store', 'relate']);
  assertEquals(
    (w[0].args[1] as StoreRequest).content.split('\n')[1],
    `Why: added by pat from the web UI; building on fact ${FACT_ID}`,
  );
  assertEquals(w[1].args, [NEW_ID, FACT_ID, 'derived-from']);
});

Deno.test('POST /intents from a fact uses the stored id, not the request text, in Why and the link', async () => {
  // The database matches a uuid whatever its case; the intent must name the fact as stored.
  const LETTERS_FACT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  class LooseIds extends BoardFake {
    override get(id: string) {
      return Promise.resolve(this.mems.find((m) => m.id === id.toLowerCase()) ?? null);
    }
  }
  const s = new LooseIds('running', [boardMem(LETTERS_FACT, 'fact', ['verdict:confirmed'])]);
  const r = await post(s, '/intents', { scope: 's1', board: 'b', text: 't', from: LETTERS_FACT.toUpperCase() });
  assertEquals(r.status, 201);
  await r.json();
  const w = s.writes();
  assertEquals(
    (w[0].args[1] as StoreRequest).content.split('\n')[1],
    `Why: added by pat from the web UI; building on fact ${LETTERS_FACT}`,
  );
  assertEquals(w[1].args, [NEW_ID, LETTERS_FACT, 'derived-from']);
});

Deno.test('POST /intents from a non-fact is 400; from an off-board memory is 404', async () => {
  const s = new BoardFake();
  const r = await post(s, '/intents', { scope: 's1', board: 'b', text: 't', from: HINT_ID });
  assertEquals(r.status, 400);
  assertEquals(await r.json(), { error: 'from must be a fact on the board' });
  for (const from of [ABSENT, OTHER_BOARD_ID, OTHER_SCOPE_ID]) {
    const x = await post(s, '/intents', { scope: 's1', board: 'b', text: 't', from });
    assertEquals(x.status, 404);
    assertEquals(await x.json(), { error: `Memory ${from} not found` });
  }
  assertEquals(s.writes(), []);
});

Deno.test('POST /intents is 409 unless the board is running or paused', async () => {
  for (const state of ['running', 'paused']) {
    const s = new BoardFake(state);
    const r = await post(s, '/intents', { scope: 's1', board: 'b', text: 't' });
    assertEquals(r.status, 201, state);
    await r.json();
  }
  for (const state of ['stopped', 'done']) {
    const s = new BoardFake(state);
    const r = await post(s, '/intents', { scope: 's1', board: 'b', text: 't' });
    assertEquals(r.status, 409, state);
    assertEquals(await r.json(), { error: 'Board is not running' });
    assertEquals(s.writes(), []);
  }
});

Deno.test('a failed link after the store deletes the stored memory and returns the error', async () => {
  for (
    const [path, body] of [
      ['/hints', { scope: 's1', board: 'b', text: 'x', about: FACT_ID }],
      ['/intents', { scope: 's1', board: 'b', text: 'x', from: FACT_ID }],
    ] as const
  ) {
    const s = new BoardFake();
    s.relateFails = new StoreError('Memory has too many links');
    const r = await post(s, path, body);
    assertEquals(r.status, 400, path);
    assertEquals(await r.json(), { error: 'Memory has too many links' });
    assertEquals(s.writes().map((c) => c.fn), ['store', 'relate', 'delete']);
    assertEquals(s.writes()[2].args, [NEW_ID]);
  }
});

Deno.test('a store write error is returned as is', async () => {
  const s = new BoardFake();
  s.store = () => Promise.reject(new StoreError("No write access to scope 's1'"));
  const r = await post(s, '/hints', { scope: 's1', board: 'b', text: 'x' });
  assertEquals(r.status, 400);
  assertEquals(await r.json(), { error: "No write access to scope 's1'" });
});

const goalTags = (state: string) => ['board:b', 'kind:goal', `state:${state}`, 'evergreen'];

Deno.test('POST /boards/control applies each allowed transition, keeping the other tags', async () => {
  const cases: [string, string, string][] = [
    ['running', 'pause', 'paused'],
    ['paused', 'resume', 'running'],
    ['running', 'stop', 'stopped'],
    ['paused', 'stop', 'stopped'],
    ['stopped', 'restart', 'running'],
  ];
  for (const [from, action, to] of cases) {
    const s = new BoardFake(from);
    const r = await post(s, '/boards/control', { scope: 's1', board: 'b', action });
    assertEquals(r.status, 200, `${from}/${action}`);
    const body = await r.json();
    assertEquals(body.goal.tags, goalTags(to));
    assertEquals(s.writes(), [{ fn: 'update', args: [GOAL_ID, { tags: goalTags(to) }] }]);
  }
});

Deno.test('a disallowed transition is 409 naming the current state', async () => {
  const cases: [string, string][] = [
    ['paused', 'pause'],
    ['running', 'resume'],
    ['running', 'restart'],
    ['stopped', 'stop'],
    ['done', 'restart'],
    ['done', 'stop'],
  ];
  for (const [from, action] of cases) {
    const s = new BoardFake(from);
    const r = await post(s, '/boards/control', { scope: 's1', board: 'b', action });
    assertEquals(r.status, 409);
    assertEquals(await r.json(), { error: `Board is ${from}` });
    assertEquals(s.writes(), []);
  }
});

Deno.test('maxIntents rewrites only the Max intents line', async () => {
  for (const [value, line] of [[9, 'Max intents: 9'], ['none', 'Max intents: none'], [2, 'Max intents: 2']] as const) {
    const s = new BoardFake();
    const r = await post(s, '/boards/control', { scope: 's1', board: 'b', maxIntents: value });
    assertEquals(r.status, 200);
    await r.json();
    assertEquals(s.writes(), [{
      fn: 'update',
      args: [GOAL_ID, { content: GOAL_TEXT.replace('Max intents: 5', line) }],
    }]);
  }
});

Deno.test('maxIntents must be a positive integer or "none"', async () => {
  const s = new BoardFake();
  for (const v of [0, -1, 1.5, 'lots', '5', null, true, 2 ** 53, 1e300]) {
    const r = await post(s, '/boards/control', { scope: 's1', board: 'b', maxIntents: v });
    assertEquals(r.status, 400, String(v));
    await r.json();
  }
  assertEquals(s.writes(), []);
});

const LIMIT_CONCLUSION = (content: string) =>
  boardMem('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'conclusion', [], content);

Deno.test('raising the limit on a board stopped at its limit also sets running', async () => {
  for (const value of [6, 'none'] as const) {
    const s = new BoardFake('stopped', [LIMIT_CONCLUSION('Conclusion.\nStopped: intent limit reached at 5')]);
    const r = await post(s, '/boards/control', { scope: 's1', board: 'b', maxIntents: value });
    assertEquals(r.status, 200);
    const body = await r.json();
    assertEquals(body.goal.tags, goalTags('running'));
    assertEquals(s.writes(), [{
      fn: 'update',
      args: [GOAL_ID, {
        content: GOAL_TEXT.replace('Max intents: 5', `Max intents: ${value}`),
        tags: goalTags('running'),
      }],
    }]);
  }
});

Deno.test('the limit does not restart a board stopped by hand, or when it is not raised', async () => {
  const byHand = new BoardFake('stopped', [LIMIT_CONCLUSION('Stopped by the person.')]);
  const a = await post(byHand, '/boards/control', { scope: 's1', board: 'b', maxIntents: 9 });
  assertEquals(a.status, 200);
  assertEquals((await a.json()).goal.tags, goalTags('stopped'));
  assertEquals(byHand.writes(), [{
    fn: 'update',
    args: [GOAL_ID, { content: GOAL_TEXT.replace('Max intents: 5', 'Max intents: 9') }],
  }]);

  const lower = new BoardFake('stopped', [LIMIT_CONCLUSION('Stopped: intent limit')]);
  const b = await post(lower, '/boards/control', { scope: 's1', board: 'b', maxIntents: 5 });
  assertEquals(b.status, 200);
  assertEquals((await b.json()).goal.tags, goalTags('stopped'));

  const done = new BoardFake('done', [LIMIT_CONCLUSION('Stopped: intent limit')]);
  const c = await post(done, '/boards/control', { scope: 's1', board: 'b', maxIntents: 50 });
  assertEquals(c.status, 200);
  assertEquals((await c.json()).goal.tags, goalTags('done'));
});

Deno.test('action and maxIntents together make one update', async () => {
  const s = new BoardFake('running');
  const r = await post(s, '/boards/control', { scope: 's1', board: 'b', action: 'pause', maxIntents: 8 });
  assertEquals(r.status, 200);
  await r.json();
  assertEquals(s.writes(), [{
    fn: 'update',
    args: [GOAL_ID, { content: GOAL_TEXT.replace('Max intents: 5', 'Max intents: 8'), tags: goalTags('paused') }],
  }]);
});

Deno.test('write routes reject GET and read routes reject POST with 405', async () => {
  const s = new BoardFake();
  for (const path of ['/hints', '/intents', '/boards/control']) {
    const r = await get(s, path);
    assertEquals(r.status, 405, path);
    await r.json();
  }
  const p = await post(s, '/graph', {});
  assertEquals(p.status, 405);
  await p.json();
});

// ── usage ──────────────────────────────────────────────────────────

const ROW: UsageRow = {
  scope: 's1',
  board: 'b',
  runLabel: 'board-b-0a1b',
  role: 'worker',
  intentId: ID,
  outcome: 'fact confirmed',
  runnerModel: 'opus',
  tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 4 },
  turns: 6,
  durationMs: 12345,
  models: { 'claude-opus-5-5': { input: 10, output: 20, cacheRead: 300, cacheWrite: 4 } },
  startedAt: '2026-11-27T08:00:00Z',
  endedAt: '2026-11-27T08:05:00Z',
};

Deno.test('POST /usage passes a valid row through unchanged', async () => {
  const u = new UsageFake();
  const r = await post(new Fake(), '/usage', ROW, 'application/json', u);
  assertEquals(r.status, 201);
  assertEquals(await r.json(), { id: '33333333-3333-4333-8333-333333333333' });
  assertEquals(u.calls, [{ fn: 'record', args: [ROW] }]);
});

Deno.test('POST /usage takes nulls where a run has no intent, turns or times', async () => {
  const u = new UsageFake();
  const row = { ...ROW, role: 'lead', intentId: null, outcome: null, turns: null, durationMs: null, startedAt: null };
  const r = await post(new Fake(), '/usage', row, 'application/json', u);
  assertEquals(r.status, 201);
  await r.json();
  assertEquals(u.calls, [{ fn: 'record', args: [row] }]);
});

Deno.test('POST /usage refuses a row that breaks the limits', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 21 }, (_, i) => [`m${i}`, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]),
  );
  const cases: [string, unknown][] = [
    ['negative count', { ...ROW, tokens: { ...ROW.tokens, input: -1 } }],
    ['fractional count', { ...ROW, tokens: { ...ROW.tokens, output: 1.5 } }],
    ['unknown role', { ...ROW, role: 'boss' }],
    ['21 models', { ...ROW, models: many }],
    ['missing runLabel', { ...ROW, runLabel: undefined }],
    ['long runLabel', { ...ROW, runLabel: 'x'.repeat(101) }],
    ['bad board', { ...ROW, board: 'Not A Board' }],
    ['string count in a model', { ...ROW, models: { m: { input: '1', output: 1, cacheRead: 0, cacheWrite: 0 } } }],
    ['bad startedAt', { ...ROW, startedAt: 'yesterday' }],
  ];
  for (const [name, body] of cases) {
    const u = new UsageFake();
    const r = await post(new Fake(), '/usage', body, 'application/json', u);
    assertEquals(r.status, 400, name);
    await r.json();
    assertEquals(u.calls, [], name);
  }
});

Deno.test('GET /usage needs scope and board and passes them through', async () => {
  const u = new UsageFake();
  const none = await get(new Fake(), '/usage?scope=s1', u);
  assertEquals(none.status, 400);
  await none.json();
  const r = await get(new Fake(), '/usage?scope=s1&board=b', u);
  assertEquals(r.status, 200);
  assertEquals(await r.json(), {
    runs: [],
    total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    more: false,
  });
  assertEquals(u.calls, [{ fn: 'forBoard', args: ['s1', 'b'] }]);
});

Deno.test("POST /usage/delete deletes a board's rows; GET is not allowed", async () => {
  const u = new UsageFake();
  const r = await post(new Fake(), '/usage/delete', { scope: 's1', board: 'b' }, 'application/json', u);
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { deleted: 2 });
  assertEquals(u.calls, [{ fn: 'deleteBoard', args: ['s1', 'b'] }]);
  const g = await get(new Fake(), '/usage/delete?scope=s1&board=b', u);
  assertEquals(g.status, 405);
  await g.json();
});

Deno.test('POST /usage answers 404 and 403 for scope errors, so the runner keeps the row and retries', async () => {
  for (const [message, status] of [["Scope 's1' not found", 404], ["No write access to scope 's1'", 403]] as const) {
    const u = new UsageFake();
    u.record = () => Promise.reject(new StoreError(message));
    const r = await post(new Fake(), '/usage', ROW, 'application/json', u);
    assertEquals(r.status, status, message);
    assertEquals(await r.json(), { error: message });
  }
  const u = new UsageFake();
  u.record = () => Promise.reject(new StoreError('Role must be worker, lead, start or release'));
  const r = await post(new Fake(), '/usage', ROW, 'application/json', u);
  assertEquals(r.status, 400, 'a row the database refuses for its content stays a 400');
  await r.json();
});

Deno.test('POST /usage answers 503 for a database error, so the runner retries instead of dropping the row', async () => {
  const u = new UsageFake();
  u.record = () => Promise.reject(new StoreError('Database error'));
  const r = await post(new Fake(), '/usage', ROW, 'application/json', u);
  assertEquals(r.status, 503);
  assertEquals(await r.json(), { error: 'Database error' });
});
