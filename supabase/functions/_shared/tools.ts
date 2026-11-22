import { z } from 'npm:zod@4.6.7';
import type { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import type { PgThreadStore } from './thread-store.ts';
import {
  checkLimit,
  NEIGHBOUR_SNIPPET_CHARS,
  RECALL_EMBED_TOPICS_MAX,
  snippet,
  STORE_BATCH_MAX,
  StoreError,
} from './limits.ts';
import {
  type Embedder,
  LINK_TYPES,
  type LinkDirection,
  type LinkType,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryStore,
  type SearchMode,
  type SearchResult,
  type SessionRef,
  type StoreRequest,
  type UpdateRequest,
} from './types.ts';

// ── Zod schemas ────────────────────────────────────────────────────

const categorySchema = z.enum(MEMORY_CATEGORIES);

const tagsSchema = z.array(z.string()).describe('Free-form tags for organisation');

const scopesSchema = z.array(z.string()).optional().describe('Scopes to search; default all you can read');

const filtersShape = {
  category: categorySchema.optional().describe('Filter by category'),
  tags: z.array(z.string()).optional().describe('Filter: memory must have at least one of these tags'),
  tags_all: z.array(z.string()).optional().describe('Filter: memory must have every one of these tags'),
  after: z.string().optional().describe('Filter: created after this ISO 8601 date'),
  before: z.string().optional().describe('Filter: created before this ISO 8601 date'),
  limit: z.number().optional().describe(
    'Max results to return (default 10). With a query the cap is 100; without a query (browse mode) it is 400',
  ),
};

const modeSchema = z
  .enum(['hybrid', 'keyword', 'semantic'])
  .optional()
  .describe('Search mode: hybrid (default), keyword-only, or semantic-only');

// ── Tool result helpers ────────────────────────────────────────────

export function success(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** A failure result whose text is the error message alone (admin rule texts are returned verbatim). */
export function failure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function error(prefix: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `${prefix}: ${message}` }], isError: true };
}

/** An empty scopes array means "all readable scopes". */
function scopesOrUndefined(scopes?: string[]): string[] | undefined {
  return scopes && scopes.length > 0 ? scopes : undefined;
}

const sessionShape = {
  session: z.string().optional().describe('Your agent session id from a thread tool (optional)'),
  session_label: z.string().optional().describe('Your agent session label (optional)'),
};

/** Only the keys the caller supplied; undefined when neither was. */
function sessionRef(a: { session?: string; session_label?: string }): SessionRef | undefined {
  if (a.session === undefined && a.session_label === undefined) return undefined;
  const s: SessionRef = {};
  if (a.session !== undefined) s.session = a.session;
  if (a.session_label !== undefined) s.sessionLabel = a.session_label;
  return s;
}

type SessionArgs = { session?: string; session_label?: string };
type MemoryInput = { content: string; category: MemoryCategory; tags: string[] };

// ── Handler factories ──────────────────────────────────────────────

export function handleListScopes(store: MemoryStore) {
  return async () => {
    try {
      const scopes = await store.listScopes();
      return success({ count: scopes.length, scopes });
    } catch (err) {
      return error('List scopes failed', err);
    }
  };
}

export function handleStore(store: MemoryStore) {
  return async (args: { scope: string } & MemoryInput & SessionArgs) => {
    try {
      const { scope, content, category, tags } = args;
      const req = { content, category, tags };
      const s = sessionRef(args);
      return success(
        s ? await store.store(scope, req as StoreRequest, s) : await store.store(scope, req as StoreRequest),
      );
    } catch (err) {
      return error('Failed to store memory', err);
    }
  };
}

export function handleStoreBatch(store: MemoryStore) {
  return async (args: { scope: string; memories: MemoryInput[] } & SessionArgs) => {
    try {
      const s = sessionRef(args);
      const memories = s
        ? await store.storeBatch(args.scope, args.memories as StoreRequest[], s)
        : await store.storeBatch(args.scope, args.memories as StoreRequest[]);
      return success({ stored: memories.length, memories });
    } catch (err) {
      return error('Failed to store batch', err);
    }
  };
}

export function handleSearch(store: MemoryStore) {
  return async (args: {
    query?: string;
    mode?: SearchMode;
    category?: MemoryCategory;
    tags?: string[];
    tags_all?: string[];
    after?: string;
    before?: string;
    limit?: number;
    offset?: number;
    scopes?: string[];
  }) => {
    try {
      // No query means no ranking: list everything matching the filters, newest first, and allow paging.
      if (!args.query?.trim()) {
        const page = await store.browse({
          category: args.category,
          tags: args.tags,
          tagsAll: args.tags_all,
          after: args.after,
          before: args.before,
          limit: args.limit,
          offset: args.offset,
          scopes: scopesOrUndefined(args.scopes),
        });
        return success({
          count: page.memories.length,
          offset: args.offset ?? 0,
          has_more: page.hasMore,
          results: page.memories.map((memory) => ({ memory })),
        });
      }
      if (args.offset !== undefined) throw new StoreError('offset is only supported without a query');
      const results = await store.search(args.query, args.mode ?? 'hybrid', {
        category: args.category,
        tags: args.tags,
        tagsAll: args.tags_all,
        after: args.after,
        before: args.before,
        limit: args.limit,
        scopes: scopesOrUndefined(args.scopes),
      });
      return success({ count: results.length, results });
    } catch (err) {
      return error('Search failed', err);
    }
  };
}

export function handleRecall(
  store: MemoryStore,
  embedder: Embedder,
  threads: Pick<PgThreadStore, 'linkedThreads'>,
) {
  return async (args: {
    topics: string[];
    include_recent?: number;
    limit_per_topic?: number;
    scopes?: string[];
  }) => {
    try {
      const limit = args.limit_per_topic ?? 5;
      const includeRecent = args.include_recent ?? 5;
      const scopes = scopesOrUndefined(args.scopes);
      // Validate before embedding, so a bad argument costs no CPU.
      checkLimit(limit);
      if (includeRecent > 0) checkLimit(includeRecent);

      const embedTopics = args.topics.slice(0, RECALL_EMBED_TOPICS_MAX);
      const keywordOnlyTopics = args.topics.slice(RECALL_EMBED_TOPICS_MAX);
      // One sequential embedMany call; searches also run sequentially (CPU budget).
      const vectors = embedTopics.length > 0 ? await embedder.embedMany(embedTopics) : [];

      const byTopic: Record<string, SearchResult[]> = {};
      for (let i = 0; i < embedTopics.length; i++) {
        byTopic[embedTopics[i]] = await store.search(embedTopics[i], 'hybrid', { limit, scopes }, vectors[i]);
      }
      for (const topic of keywordOnlyTopics) {
        byTopic[topic] = await store.search(topic, 'hybrid', { limit, scopes }, null);
      }

      // include_recent <= 0 means no recent memories, as in the original server.
      const recent = includeRecent > 0 ? await store.listRecent(includeRecent, undefined, scopes) : [];

      // One lookup for every returned memory; only memories with links gain a threads key.
      const all = [...Object.values(byTopic).flat().map((r) => r.memory), ...recent];
      const linked = await threads.linkedThreads([...new Set(all.map((m) => m.id))]);
      for (const m of all) if (linked[m.id]?.length) m.threads = linked[m.id];
      return success(keywordOnlyTopics.length > 0 ? { byTopic, recent, keywordOnlyTopics } : { byTopic, recent });
    } catch (err) {
      return error('Recall failed', err);
    }
  };
}

export function handleFindRelated(store: MemoryStore) {
  return async (args: { memory_id: string; limit?: number; scopes?: string[] }) => {
    try {
      const results = await store.findRelated(args.memory_id, args.limit ?? 5, scopesOrUndefined(args.scopes));
      return success({ count: results.length, results });
    } catch (err) {
      return error('Find related failed', err);
    }
  };
}

export function handleRelate(store: MemoryStore) {
  return async (args: { from_id: string; to_id: string; type: LinkType }) => {
    try {
      await store.relate(args.from_id, args.to_id, args.type);
      return success({ related: true });
    } catch (err) {
      return error('Relate failed', err);
    }
  };
}

export function handleUnrelate(store: MemoryStore) {
  return async (args: { from_id: string; to_id: string; type: LinkType }) => {
    try {
      return success({ unrelated: await store.unrelate(args.from_id, args.to_id, args.type) });
    } catch (err) {
      return error('Unrelate failed', err);
    }
  };
}

export function handleNeighbours(store: MemoryStore) {
  return async (args: {
    memory_id: string;
    direction?: LinkDirection;
    types?: LinkType[];
    depth?: number;
    scopes?: string[];
    detail?: 'short' | 'full';
  }) => {
    try {
      const r = await store.neighbours(args.memory_id, {
        direction: args.direction,
        types: args.types,
        depth: args.depth,
        scopes: scopesOrUndefined(args.scopes),
      });
      // 'short' swaps each memory's content for a snippet, so a wide walk costs little context.
      const results = args.detail === 'short'
        ? r.neighbours.map(({ memory, path }) => {
          const { content, ...rest } = memory;
          return { memory: { ...rest, snippet: snippet(content, NEIGHBOUR_SNIPPET_CHARS) }, path };
        })
        : r.neighbours;
      return success({ count: r.neighbours.length, truncated: r.truncated, results });
    } catch (err) {
      return error('Neighbours failed', err);
    }
  };
}

export function handleListRecent(store: MemoryStore) {
  return async (args: { limit?: number; category?: MemoryCategory; scopes?: string[] }) => {
    try {
      const memories = await store.listRecent(args.limit ?? 10, args.category, scopesOrUndefined(args.scopes));
      return success({ count: memories.length, memories });
    } catch (err) {
      return error('List recent failed', err);
    }
  };
}

export function handleUpdate(store: MemoryStore) {
  return async (
    args: {
      id: string;
      content?: string;
      category?: MemoryCategory;
      tags?: string[];
      scope?: string;
    } & SessionArgs,
  ) => {
    try {
      // Only pass the keys the caller supplied.
      const u: UpdateRequest = {};
      if (args.content !== undefined) u.content = args.content;
      if (args.category !== undefined) u.category = args.category;
      if (args.tags !== undefined) u.tags = args.tags;
      if (args.scope !== undefined) u.scope = args.scope;
      const s = sessionRef(args);
      return success(s ? await store.update(args.id, u, s) : await store.update(args.id, u));
    } catch (err) {
      return error('Update failed', err);
    }
  };
}

export function handleDelete(store: MemoryStore) {
  return async (args: { id: string }) => {
    try {
      await store.delete(args.id);
      return success({ deleted: true, id: args.id });
    } catch (err) {
      return error('Delete failed', err);
    }
  };
}

export function handleStats(store: MemoryStore) {
  return async (args: { scopes?: string[] } = {}) => {
    try {
      return success(await store.stats(scopesOrUndefined(args.scopes)));
    } catch (err) {
      return error('Stats failed', err);
    }
  };
}

export function handlePrune(store: MemoryStore) {
  return async (args: { scope: string; dryRun?: boolean; minStrength?: number; maxDormantDays?: number }) => {
    try {
      return success(
        await store.prune({
          scope: args.scope,
          dryRun: args.dryRun,
          minStrength: args.minStrength,
          maxDormantDays: args.maxDormantDays,
        }),
      );
    } catch (err) {
      return error('Prune failed', err);
    }
  };
}

// ── Registration ───────────────────────────────────────────────────

export function registerTools(
  server: McpServer,
  store: MemoryStore,
  embedder: Embedder,
  threads: PgThreadStore,
): void {
  server.registerTool('list_scopes', {
    description: 'List the memory scopes you can access, with your access level (read or write) and memory count.',
    inputSchema: z.object({}),
  }, handleListScopes(store));

  server.registerTool('store', {
    description: 'Store a single memory with content, category, and tags. Returns the stored memory with its ID.',
    inputSchema: z.object({
      scope: z.string().describe('Scope to store the memory in (you need write access)'),
      content: z.string().describe('The memory content — what you learnt, observed, or want to remember'),
      category: categorySchema.describe('Memory category'),
      tags: tagsSchema,
      ...sessionShape,
    }),
  }, handleStore(store));

  server.registerTool('store_batch', {
    description:
      `Store multiple memories in one call. Use at end-of-session to capture everything learnt. Returns all stored memories. Accepts at most ${STORE_BATCH_MAX} memories per call on this server; split larger batches.`,
    inputSchema: z.object({
      scope: z.string().describe('Scope to store the memories in (you need write access)'),
      memories: z.array(z.object({
        content: z.string().describe('The memory content'),
        category: categorySchema,
        tags: tagsSchema,
      })).describe('Array of memories to store'),
      ...sessionShape,
    }),
  }, handleStoreBatch(store));

  server.registerTool('search', {
    description:
      'Search memories by meaning and/or keywords. Default mode is hybrid (BM25 + vector). Returns ranked results with relevance scores. ' +
      'Each memory shows its `links` to other memories and `superseded: true` when a newer memory replaces it; call `neighbours` to follow links. ' +
      'Omit the query to browse instead: every memory matching the filters, newest first, with no ranking, paged by limit and offset ' +
      '(has_more says whether another page follows). Browsing does not count as access, so use it to sweep for cleanup. ' +
      'Offsets shift if you delete or add memories while paging; after deleting, re-fetch from the same offset or page from the end.',
    inputSchema: z.object({
      query: z.string().optional().describe(
        'What to search for — a concept, phrase, or question. Omit (or leave empty) to browse without ranking',
      ),
      mode: modeSchema,
      ...filtersShape,
      offset: z.number().optional().describe(
        'Browse mode only (no query): number of matches to skip, for paging (default 0)',
      ),
      scopes: scopesSchema,
    }),
  }, handleSearch(store));

  server.registerTool('recall', {
    description:
      'Multi-topic contextual recall — the morning coffee tool. Searches multiple topics and includes recent memories. Use at session start to restore context efficiently. Returned memories show their `links` to other memories and `superseded: true` when a newer memory replaces them; call `neighbours` to follow links.',
    inputSchema: z.object({
      topics: z.array(z.string()).describe('List of topics to search for'),
      include_recent: z.number().optional().describe('Number of recent memories to include (default 5)'),
      limit_per_topic: z.number().optional().describe('Max results per topic (default 5)'),
      scopes: scopesSchema,
    }),
  }, handleRecall(store, embedder, threads));

  server.registerTool('find_related', {
    description:
      'Find memories similar to a specific memory. Use for associative exploration — "what else do I know that connects to this?"',
    inputSchema: z.object({
      memory_id: z.string().describe('ID of the memory to find relatives of'),
      limit: z.number().optional().describe('Max related memories to return (default 5)'),
      scopes: scopesSchema,
    }),
  }, handleFindRelated(store));

  const linkTypeSchema = z.enum(LINK_TYPES).describe(
    'relates-to: loosely associated (no direction); supersedes: from replaces to, so to is out of date; ' +
      'derived-from: from was concluded from to; depends-on: from only holds, or can only be done, if to does',
  );
  const linkRules =
    'You need read access to both memories. supersedes needs write access to both scopes; derived-from and ' +
    "depends-on need write access to the from memory's scope; relates-to needs write access to either. A memory " +
    'can have at most 100 outgoing links.';

  server.registerTool('relate_memories', {
    description:
      `Link two memories so an agent can find one from the other without a text search. Links point from one memory to another and show up in search, recall and list results. Use supersedes when a newer memory replaces an older one you want to keep, derived-from for a conclusion and the evidence behind it, depends-on for a prerequisite. ${linkRules}`,
    inputSchema: z.object({
      from_id: z.string().describe('ID of the memory the link starts at'),
      to_id: z.string().describe('ID of the memory the link points to'),
      type: linkTypeSchema,
    }),
  }, handleRelate(store));

  server.registerTool('unrelate_memories', {
    description:
      "Remove a link between two memories. You need read access to both and write access to either one's scope. For relates-to the order of the two ids does not matter. Returns whether a link was removed.",
    inputSchema: z.object({
      from_id: z.string().describe('ID of the memory the link starts at'),
      to_id: z.string().describe('ID of the memory the link points to'),
      type: linkTypeSchema,
    }),
  }, handleUnrelate(store));

  server.registerTool('neighbours', {
    description:
      'Follow links from a memory to find connected memories without a text search. Returns each memory reached once, with the path of links that led to it, nearest first, at most 100 (truncated says when more exist). Does not count as an access.',
    inputSchema: z.object({
      memory_id: z.string().describe('ID of the memory to start from'),
      direction: z.enum(['out', 'in', 'both']).optional().describe(
        'out: links it points to; in: links pointing at it; both (default). relates-to matches every direction',
      ),
      types: z.array(z.enum(LINK_TYPES)).optional().describe('Only follow these link types (default all)'),
      depth: z.number().optional().describe('How many links to follow, 1 to 3 (default 1)'),
      detail: z.enum(['short', 'full']).optional().describe(
        `full (default): each memory's whole content. short: id, scope, category, tags, links and a ${NEIGHBOUR_SNIPPET_CHARS}-character snippet instead of the content, for wide walks`,
      ),
      scopes: scopesSchema,
    }),
  }, handleNeighbours(store));

  server.registerTool('list_recent', {
    description:
      'List most recent memories, optionally filtered by category. Use to see what you have been learning lately.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Max memories to return (default 10)'),
      category: categorySchema.optional().describe('Filter by category'),
      scopes: scopesSchema,
    }),
  }, handleListRecent(store));

  server.registerTool('update', {
    description:
      'Update an existing memory — change its content, category, or tags. If content changes, the embedding is regenerated automatically.',
    inputSchema: z.object({
      id: z.string().describe('ID of the memory to update'),
      content: z.string().optional().describe('New content (triggers re-embedding)'),
      category: categorySchema.optional().describe('New category'),
      tags: tagsSchema.optional().describe('New tags (replaces existing)'),
      scope: z.string().optional().describe('Move the memory to this scope (needs write on both)'),
      ...sessionShape,
    }),
  }, handleUpdate(store));

  server.registerTool('delete', {
    description: 'Delete a memory by ID (soft delete; an admin can restore it for 30 days).',
    inputSchema: z.object({
      id: z.string().describe('ID of the memory to delete'),
    }),
  }, handleDelete(store));

  server.registerTool('stats', {
    description:
      'Get memory database statistics: total count, breakdown by category, oldest and newest timestamps, access patterns, and prune-eligible counts.',
    inputSchema: z.object({ scopes: scopesSchema }),
  }, handleStats(store));

  server.registerTool('prune', {
    description:
      'Prune low-strength and dormant memories. Dry-run by default — shows candidates without deleting. Set dryRun: false to actually prune. Evergreen memories are always preserved.',
    inputSchema: z.object({
      scope: z.string().describe('Scope to prune (you need write access)'),
      dryRun: z.boolean().optional().default(true).describe(
        'Preview mode — show what would be pruned without deleting',
      ),
      minStrength: z.number().optional().default(0.05).describe('Prune memories with strength below this value'),
      maxDormantDays: z.number().optional().default(90).describe(
        'Prune never-accessed memories older than this many days',
      ),
    }),
  }, handlePrune(store));
}
