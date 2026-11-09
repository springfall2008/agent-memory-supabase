import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import {
  handleFindRelated,
  handleListRecent,
  handleRecall,
  handleSearch,
  handleStats,
  handleStore,
  handleStoreBatch,
  handleUpdate,
  registerTools,
} from '../../supabase/functions/_shared/tools.ts';
import { STORE_BATCH_MAX } from '../../supabase/functions/_shared/limits.ts';
import type { Embedder, Memory, MemoryStore, SearchFilters } from '../../supabase/functions/_shared/types.ts';

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

function mockStore(opts: { storeError?: Error } = {}): { store: MemoryStore; calls: Calls } {
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

Deno.test('handleUpdate with only tags passes only tags', async () => {
  const { store, calls } = mockStore();
  await handleUpdate(store)({ id: 'i', tags: ['x'] });
  assertEquals(calls.update[0][0], 'i');
  assertEquals(Object.keys(calls.update[0][1]), ['tags']);
});

Deno.test('registerTools registers exactly 11 tools', () => {
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
      'prune',
      'recall',
      'search',
      'stats',
      'store',
      'store_batch',
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
