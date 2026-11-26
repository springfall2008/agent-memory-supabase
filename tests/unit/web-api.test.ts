import { assertEquals } from '@std/assert';
import { routeWebApi, type WebStore } from '../../supabase/functions/_shared/web-api.ts';
import { StoreError } from '../../supabase/functions/_shared/limits.ts';
import type {
  BrowseFilters,
  BrowsePage,
  GraphFilters,
  GraphResult,
  Memory,
  ScopeInfo,
  SearchFilters,
  SearchMode,
  SearchResult,
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
}

const get = (store: WebStore, path: string) => routeWebApi(new Request(`http://x/functions/v1/web-api${path}`), store);

Deno.test('GET /scopes returns the scopes', async () => {
  const s = new Fake();
  const r = await get(s, '/scopes');
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { scopes: s.scopes });
});

Deno.test('the path resolves with or without the functions prefix', async () => {
  const s = new Fake();
  for (const url of ['http://x/web-api/scopes', 'http://x/functions/v1/web-api/scopes']) {
    const r = await routeWebApi(new Request(url), s);
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
  const p = await routeWebApi(new Request('http://x/web-api/scopes', { method: 'POST' }), s);
  assertEquals(p.status, 405);
  await p.json();
  const u = await get(s, '/nope');
  assertEquals(u.status, 404);
  await u.json();
});
