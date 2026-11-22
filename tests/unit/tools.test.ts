import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import {
  handleFindRelated,
  handleListRecent,
  handleNeighbours,
  handleRecall,
  handleRelate,
  handleSearch,
  handleStats,
  handleStore,
  handleStoreBatch,
  handleUnrelate,
  handleUpdate,
  registerTools,
} from '../../supabase/functions/_shared/tools.ts';
import { STORE_BATCH_MAX } from '../../supabase/functions/_shared/limits.ts';
import type {
  Embedder,
  Memory,
  MemoryStore,
  Neighbour,
  SearchFilters,
} from '../../supabase/functions/_shared/types.ts';

const mem = (id: string, scope = 's'): Memory => ({
  id,
  scope,
  content: 'c',
  category: 'other',
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: 'a',
  updatedBy: 'a',
});

// deno-lint-ignore no-explicit-any
type Calls = Record<string, any[][]>;

function mockStore(
  opts: {
    storeError?: Error;
    browsePage?: Memory[];
    browseHasMore?: boolean;
    relateError?: Error;
    unrelated?: boolean;
    neighbours?: Neighbour[];
    truncated?: boolean;
  } = {},
): { store: MemoryStore; calls: Calls } {
  const calls: Calls = {};
  const rec = (n: string, ...a: unknown[]) => (calls[n] ??= []).push(a);
  const store: MemoryStore = {
    listScopes: () => Promise.resolve([]),
    store: (scope, r, ...s) => {
      rec('store', scope, r, ...s);
      if (opts.storeError) return Promise.reject(opts.storeError);
      return Promise.resolve(mem('1', scope));
    },
    storeBatch: (scope, rs) => {
      rec('storeBatch', scope, rs);
      if (rs.length > STORE_BATCH_MAX) {
        return Promise.reject(new Error(`store_batch accepts at most ${STORE_BATCH_MAX} memories per call`));
      }
      return Promise.resolve(rs.map((_, i) => mem(String(i), scope)));
    },
    search: (q, mode, f, e) => {
      rec('search', q, mode, f, e);
      return Promise.resolve([]);
    },
    browse: (f) => {
      rec('browse', f);
      return Promise.resolve({ memories: opts.browsePage ?? [], hasMore: opts.browseHasMore ?? false });
    },
    relate: (from, to, type) => {
      rec('relate', from, to, type);
      if (opts.relateError) return Promise.reject(opts.relateError);
      return Promise.resolve();
    },
    unrelate: (from, to, type) => {
      rec('unrelate', from, to, type);
      return Promise.resolve(opts.unrelated ?? true);
    },
    neighbours: (id, o) => {
      rec('neighbours', id, o);
      return Promise.resolve({ neighbours: opts.neighbours ?? [], truncated: opts.truncated ?? false });
    },
    findRelated: (id, limit, scopes) => {
      rec('findRelated', id, limit, scopes);
      return Promise.resolve([]);
    },
    listRecent: (limit, category, scopes) => {
      rec('listRecent', limit, category, scopes);
      return Promise.resolve([]);
    },
    update: (id, u, ...s) => {
      rec('update', id, u, ...s);
      return Promise.resolve(mem(id));
    },
    delete: () => Promise.resolve(),
    stats: (scopes) => {
      rec('stats', scopes);
      return Promise.resolve({
        totalMemories: 0,
        byCategory: {},
        byScope: {},
        oldestMemory: null,
        newestMemory: null,
        neverAccessed: 0,
        belowPruneThreshold: 0,
        avgAccessCount: 0,
        mostAccessed: [],
      });
    },
    prune: () => Promise.reject(new Error('unused')),
  };
  return { store, calls };
}

const noThreads = { linkedThreads: () => Promise.resolve({}) };

function mockEmbedder(): { embedder: Embedder; manyCalls: string[][] } {
  const manyCalls: string[][] = [];
  return {
    manyCalls,
    embedder: {
      embed: (t) => Promise.resolve([t.length]),
      embedMany: (ts) => {
        manyCalls.push(ts);
        return Promise.resolve(ts.map((t) => [t.length]));
      },
    },
  };
}

Deno.test('handleStore passes scope through and returns the memory JSON', async () => {
  const { store, calls } = mockStore();
  const r = await handleStore(store)({ scope: 'work', content: 'x', category: 'other', tags: ['t'] });
  assertEquals(calls.store[0], ['work', { content: 'x', category: 'other', tags: ['t'] }]);
  assertEquals(JSON.parse(r.content[0].text).scope, 'work');
  assert(!('isError' in r));
});

Deno.test('handleStore store error becomes isError with prefix', async () => {
  const { store } = mockStore({ storeError: new Error("No write access to scope 'work'") });
  const r = await handleStore(store)({ scope: 'work', content: 'x', category: 'other', tags: [] });
  assertEquals((r as { isError?: boolean }).isError, true);
  assertEquals(r.content[0].text, "Failed to store memory: No write access to scope 'work'");
});

Deno.test('handleStoreBatch with 3 memories is an error mentioning the cap', async () => {
  const { store } = mockStore();
  const m = { content: 'x', category: 'other' as const, tags: [] };
  const r = await handleStoreBatch(store)({ scope: 's', memories: [m, m, m] });
  assertEquals((r as { isError?: boolean }).isError, true);
  assertStringIncludes(r.content[0].text, 'at most 2');
  assertStringIncludes(r.content[0].text, 'Failed to store batch: ');
});

Deno.test('handleRecall embeds first 5 topics once; the rest are keyword-only', async () => {
  const { store, calls } = mockStore();
  const { embedder, manyCalls } = mockEmbedder();
  const topics = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
  const r = await handleRecall(store, embedder, noThreads)({ topics });
  assertEquals(manyCalls, [topics.slice(0, 5)]);
  const searches = calls.search;
  assertEquals(searches.length, 7);
  for (let i = 0; i < 5; i++) assertEquals(searches[i][3], [2]);
  assertEquals(searches[5][3], null);
  assertEquals(searches[6][3], null);
  const body = JSON.parse(r.content[0].text);
  assertEquals(body.keywordOnlyTopics, ['t6', 't7']);
  assertEquals(Object.keys(body.byTopic).length, 7);
});

Deno.test('handleRecall with 2 topics has no keywordOnlyTopics key', async () => {
  const { store } = mockStore();
  const { embedder } = mockEmbedder();
  const r = await handleRecall(store, embedder, noThreads)({ topics: ['a', 'b'] });
  const body = JSON.parse(r.content[0].text);
  assert(!('keywordOnlyTopics' in body));
  assert('recent' in body);
});

Deno.test('empty scopes array means all readable scopes', async () => {
  const { store, calls } = mockStore();
  const { embedder } = mockEmbedder();
  await handleSearch(store)({ query: 'q', scopes: [] });
  assertEquals((calls.search[0][2] as SearchFilters).scopes, undefined);
  await handleRecall(store, embedder, noThreads)({ topics: ['a'], scopes: [] });
  assertEquals((calls.search[1][2] as SearchFilters).scopes, undefined);
  assertEquals(calls.listRecent[0][2], undefined);
  await handleListRecent(store)({ scopes: [] });
  assertEquals(calls.listRecent[1][2], undefined);
  await handleFindRelated(store)({ memory_id: 'x', scopes: [] });
  assertEquals(calls.findRelated[0][2], undefined);
  await handleStats(store)({ scopes: [] });
  assertEquals(calls.stats[0][0], undefined);
});

Deno.test('non-empty scopes are passed through', async () => {
  const { store, calls } = mockStore();
  await handleSearch(store)({ query: 'q', scopes: ['a'] });
  assertEquals((calls.search[0][2] as SearchFilters).scopes, ['a']);
});

Deno.test('handleSearch passes tags and tags_all through as separate filters', async () => {
  const { store, calls } = mockStore();
  await handleSearch(store)({ query: 'q', tags: ['a', 'b'], tags_all: ['c', 'd'] });
  const f = calls.search[0][2] as SearchFilters;
  assertEquals(f.tags, ['a', 'b']);
  assertEquals(f.tagsAll, ['c', 'd']);
});

Deno.test('the registered search tool accepts tags_all', () => {
  const { store } = mockStore();
  const { embedder } = mockEmbedder();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, store, embedder, noThreads as never);
  const registered =
    (server as unknown as { _registeredTools: Record<string, { inputSchema: { parse: (v: unknown) => unknown } }> })
      ._registeredTools;
  const parsed = registered.search.inputSchema.parse({ query: 'q', tags: ['a'], tags_all: ['b', 'c'] }) as Record<
    string,
    unknown
  >;
  assertEquals(parsed.tags_all, ['b', 'c']);
  assertEquals(parsed.tags, ['a']);
});

Deno.test('handleSearch without a query browses: filters, offset and limit go to store.browse, not store.search', async () => {
  const { store, calls } = mockStore({ browsePage: [mem('m1'), mem('m2')], browseHasMore: true });
  const r = await handleSearch(store)({
    tags_all: ['cleanup'],
    category: 'other',
    after: '2026-01-01',
    offset: 40,
    limit: 20,
    scopes: ['a'],
  });
  assertEquals(calls.search, undefined);
  const f = calls.browse[0][0];
  assertEquals(f.tagsAll, ['cleanup']);
  assertEquals(f.category, 'other');
  assertEquals(f.after, '2026-01-01');
  assertEquals(f.offset, 40);
  assertEquals(f.limit, 20);
  assertEquals(f.scopes, ['a']);
  const body = JSON.parse(r.content[0].text);
  assertEquals(body.count, 2);
  assertEquals(body.has_more, true);
  assertEquals(body.offset, 40);
  assertEquals(body.results.map((x: { memory: Memory }) => x.memory.id), ['m1', 'm2']);
  assert(body.results.every((x: Record<string, unknown>) => !('score' in x)));
});

Deno.test('handleSearch treats an empty or whitespace query as browse', async () => {
  const { store, calls } = mockStore();
  await handleSearch(store)({ query: '' });
  await handleSearch(store)({ query: '   ' });
  assertEquals(calls.search, undefined);
  assertEquals(calls.browse.length, 2);
  assertEquals(calls.browse[0][0].offset, undefined);
});

Deno.test('handleSearch with a query still ranks and has no has_more', async () => {
  const { store, calls } = mockStore();
  const r = await handleSearch(store)({ query: 'q' });
  assertEquals(calls.browse, undefined);
  assertEquals(calls.search.length, 1);
  assert(!('has_more' in JSON.parse(r.content[0].text)));
});

Deno.test('handleSearch rejects offset together with a query and does not touch the store', async () => {
  const { store, calls } = mockStore();
  const r = await handleSearch(store)({ query: 'q', offset: 10 });
  assertEquals((r as { isError?: boolean }).isError, true);
  assertStringIncludes(r.content[0].text, 'offset is only supported without a query');
  assertEquals(calls.search, undefined);
  assertEquals(calls.browse, undefined);
});

Deno.test('the registered search tool makes query optional and accepts offset', () => {
  const { store } = mockStore();
  const { embedder } = mockEmbedder();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, store, embedder, noThreads as never);
  const registered =
    (server as unknown as { _registeredTools: Record<string, { inputSchema: { parse: (v: unknown) => unknown } }> })
      ._registeredTools;
  const parsed = registered.search.inputSchema.parse({ tags_all: ['a'], offset: 5 }) as Record<string, unknown>;
  assertEquals(parsed.offset, 5);
  assertEquals(parsed.query, undefined);
});

Deno.test('handleUpdate with only tags passes only tags', async () => {
  const { store, calls } = mockStore();
  await handleUpdate(store)({ id: 'i', tags: ['x'] });
  assertEquals(calls.update[0][0], 'i');
  assertEquals(Object.keys(calls.update[0][1]), ['tags']);
});

Deno.test('registerTools registers exactly 14 tools', () => {
  const { store } = mockStore();
  const { embedder } = mockEmbedder();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, store, embedder, noThreads as never);
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assertEquals(
    Object.keys(registered).sort(),
    [
      'delete',
      'find_related',
      'list_recent',
      'list_scopes',
      'neighbours',
      'prune',
      'recall',
      'relate_memories',
      'search',
      'stats',
      'store',
      'store_batch',
      'unrelate_memories',
      'update',
    ],
  );
});

Deno.test('handleRecall with include_recent 0 returns recent [] without listing', async () => {
  const { store, calls } = mockStore();
  const { embedder } = mockEmbedder();
  for (const n of [0, -1]) {
    const r = await handleRecall(store, embedder, noThreads)({ topics: ['a'], include_recent: n });
    assert(!('isError' in r));
    assertEquals(JSON.parse(r.content[0].text).recent, []);
  }
  assertEquals(calls.listRecent, undefined);
});

Deno.test('handleRecall rejects a bad limit_per_topic before embedding', async () => {
  const { store, calls } = mockStore();
  const { embedder, manyCalls } = mockEmbedder();
  for (const n of [0, 101]) {
    const r = await handleRecall(store, embedder, noThreads)({ topics: ['a', 'b'], limit_per_topic: n });
    assertEquals((r as { isError?: boolean }).isError, true);
    assertEquals(r.content[0].text, 'Recall failed: limit must be between 1 and 100');
  }
  const r = await handleRecall(store, embedder, noThreads)({ topics: ['a'], include_recent: 101 });
  assertEquals(r.content[0].text, 'Recall failed: limit must be between 1 and 100');
  assertEquals(manyCalls, []);
  assertEquals(calls.search, undefined);
});

Deno.test('store_batch description states the per-call cap', () => {
  const { store } = mockStore();
  const { embedder } = mockEmbedder();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, store, embedder, noThreads as never);
  const registered = (server as unknown as { _registeredTools: Record<string, { description?: string }> })
    ._registeredTools;
  assertStringIncludes(
    registered.store_batch.description ?? '',
    `at most ${STORE_BATCH_MAX} memories per call on this server; split larger batches.`,
  );
});

Deno.test('recall attaches linked threads only where present', async () => {
  const { store } = mockStore();
  store.listRecent = () => Promise.resolve([mem('m1'), mem('m2')]);
  store.search = () => Promise.resolve([{ memory: mem('m1'), score: 1 }, { memory: mem('m2'), score: 1 }]);
  const thread = { id: 't', title: 'T', scope: 's', status: 'open' as const, lastPostAt: '2026-01-01T00:00:00Z' };
  const { embedder } = mockEmbedder();
  const r = await handleRecall(store, embedder, { linkedThreads: () => Promise.resolve({ m1: [thread] }) })({
    topics: ['a'],
  });
  const body = JSON.parse(r.content[0].text);
  assertEquals(body.byTopic.a[0].memory.threads, [thread]);
  assertEquals('threads' in body.byTopic.a[1].memory, false);
  assertEquals(body.recent[0].threads, [thread]);
  assertEquals('threads' in body.recent[1], false);
});

Deno.test('store, store_batch and update pass the session through only when given', async () => {
  const { store, calls } = mockStore();
  await handleStore(store)({ scope: 'w', content: 'x', category: 'other', tags: [], session_label: 'L' });
  assertEquals(calls.store[0][2], { sessionLabel: 'L' });
  await handleUpdate(store)({ id: 'i', tags: ['x'], session: 'u' });
  assertEquals(calls.update[0][2], { session: 'u' });
  assertEquals(Object.keys(calls.update[0][1]), ['tags']);
});

Deno.test('handleRelate passes ids and type to the store and returns related: true', async () => {
  const { store, calls } = mockStore();
  const r = await handleRelate(store)({ from_id: 'a', to_id: 'b', type: 'supersedes' });
  assertEquals(calls.relate[0], ['a', 'b', 'supersedes']);
  assertEquals(JSON.parse(r.content[0].text), { related: true });
});

Deno.test('handleRelate with a store error is an isError result prefixed Relate failed', async () => {
  const { store } = mockStore({ relateError: new Error('Memory a not found') });
  const r = await handleRelate(store)({ from_id: 'a', to_id: 'b', type: 'relates-to' });
  assertEquals((r as { isError?: boolean }).isError, true);
  assertEquals(r.content[0].text, 'Relate failed: Memory a not found');
});

Deno.test("handleUnrelate returns the store's boolean", async () => {
  const { store, calls } = mockStore({ unrelated: false });
  const r = await handleUnrelate(store)({ from_id: 'a', to_id: 'b', type: 'depends-on' });
  assertEquals(calls.unrelate[0], ['a', 'b', 'depends-on']);
  assertEquals(JSON.parse(r.content[0].text), { unrelated: false });
});

Deno.test('handleNeighbours passes its options through and an empty scopes array becomes undefined', async () => {
  const { store, calls } = mockStore();
  await handleNeighbours(store)({
    memory_id: 'm',
    direction: 'out',
    types: ['supersedes'],
    depth: 2,
    scopes: ['s'],
  });
  assertEquals(calls.neighbours[0], ['m', { direction: 'out', types: ['supersedes'], depth: 2, scopes: ['s'] }]);
  await handleNeighbours(store)({ memory_id: 'm', scopes: [] });
  assertEquals(calls.neighbours[1][1].scopes, undefined);
});

Deno.test('handleNeighbours returns count, truncated and results', async () => {
  const path = [{ type: 'depends-on' as const, direction: 'out' as const, memoryId: 'm2' }];
  const { store } = mockStore({ neighbours: [{ memory: mem('m2'), path }], truncated: true });
  const body = JSON.parse((await handleNeighbours(store)({ memory_id: 'm1' })).content[0].text);
  assertEquals(body.count, 1);
  assertEquals(body.truncated, true);
  assertEquals(body.results[0].path, path);
  assertEquals(body.results[0].memory.id, 'm2');
});

Deno.test('the registered link tools reject an unknown link type', () => {
  const { store } = mockStore();
  const { embedder } = mockEmbedder();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, store, embedder, noThreads as never);
  const registered =
    (server as unknown as { _registeredTools: Record<string, { inputSchema: { parse: (v: unknown) => unknown } }> })
      ._registeredTools;
  for (const tool of ['relate_memories', 'unrelate_memories']) {
    assertThrows(() => registered[tool].inputSchema.parse({ from_id: 'a', to_id: 'b', type: 'nope' }));
    registered[tool].inputSchema.parse({ from_id: 'a', to_id: 'b', type: 'supersedes' });
  }
});

Deno.test('search and recall descriptions say that results carry links and a superseded flag', () => {
  const { store } = mockStore();
  const { embedder } = mockEmbedder();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, store, embedder, noThreads as never);
  const registered = (server as unknown as { _registeredTools: Record<string, { description?: string }> })
    ._registeredTools;
  for (const tool of ['search', 'recall']) {
    const d = registered[tool].description ?? '';
    assertStringIncludes(d, 'links', `${tool} mentions links`);
    assertStringIncludes(d, 'superseded', `${tool} mentions superseded`);
    assertStringIncludes(d, 'neighbours', `${tool} points at neighbours`);
  }
});
