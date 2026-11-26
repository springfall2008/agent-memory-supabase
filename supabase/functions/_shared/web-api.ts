import { MAX_BROWSE_LIMIT, StoreError } from './limits.ts';
import {
  type BrowseFilters,
  type BrowsePage,
  type GraphFilters,
  type GraphResult,
  type Memory,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type ScopeInfo,
  type SearchFilters,
  type SearchMode,
  type SearchResult,
} from './types.ts';

/** The read-only slice of the store the web UI uses. `PgMemoryStore` satisfies it. */
export interface WebStore {
  listScopes(): Promise<ScopeInfo[]>;
  browse(f: BrowseFilters): Promise<BrowsePage>;
  search(q: string, mode: SearchMode, f: SearchFilters): Promise<SearchResult[]>;
  get(id: string): Promise<Memory | null>;
  graph(f: GraphFilters): Promise<GraphResult>;
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** The route is the path after the first `web-api` segment (the whole path when there is none). */
function routeOf(url: URL): string[] {
  const parts = url.pathname.split('/').filter((p) => p !== '');
  const at = parts.indexOf('web-api');
  return at === -1 ? parts : parts.slice(at + 1);
}

/** A comma-separated list; absent or empty means absent. */
function list(p: URLSearchParams, key: string): string[] | undefined {
  const items = (p.get(key) ?? '').split(',').filter((s) => s !== '');
  return items.length ? items : undefined;
}

/** Absent or empty is `undefined`; anything else goes through `Number` for the store's own check to reject. */
function num(p: URLSearchParams, key: string): number | undefined {
  const raw = p.get(key);
  return raw === null || raw === '' ? undefined : Number(raw);
}

/** Only defined keys, so a store sees "absent" as absent. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const tagValue = (tags: string[], prefix: string): string | undefined =>
  tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);

export async function routeWebApi(req: Request, store: WebStore): Promise<Response> {
  if (req.method !== 'GET') return bad('Method not allowed', 405);
  const url = new URL(req.url);
  const route = routeOf(url);
  const p = url.searchParams;
  try {
    if (route.length === 1 && route[0] === 'scopes') {
      return Response.json({ scopes: await store.listScopes() });
    }

    if (route.length === 1 && route[0] === 'memories') {
      const category = p.get('category') || undefined;
      if (category !== undefined && !(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
        return bad('Invalid category');
      }
      const q = p.get('q') ?? '';
      const filters = {
        category: category as MemoryCategory | undefined,
        tags: list(p, 'tags'),
        tagsAll: list(p, 'tags_all'),
        limit: num(p, 'limit'),
        scopes: list(p, 'scope'),
      };
      const offset = num(p, 'offset');
      if (q === '') {
        const page = await store.browse(defined({ ...filters, offset }));
        return Response.json({ memories: page.memories, hasMore: page.hasMore });
      }
      if (offset !== undefined) return bad('offset applies to browsing only');
      const results = await store.search(q, 'hybrid', defined({ ...filters, touch: false }));
      return Response.json({ memories: results.map((r) => r.memory), hasMore: false });
    }

    if (route.length === 2 && route[0] === 'memories') {
      let id = route[1];
      try {
        id = decodeURIComponent(id);
      } catch {
        // keep the raw segment; the store treats it as not found
      }
      const memory = await store.get(id);
      return memory ? Response.json({ memory }) : bad(`Memory ${id} not found`, 404);
    }

    if (route.length === 1 && route[0] === 'graph') {
      const tagsAll = list(p, 'tags_all');
      if (!tagsAll) return bad('tags_all is required');
      const detail = p.get('detail') || undefined;
      if (detail !== undefined && detail !== 'short' && detail !== 'full') return bad('Invalid detail');
      return Response.json(
        await store.graph(defined({
          tagsAll,
          scopes: list(p, 'scope'),
          detail: detail as 'short' | 'full' | undefined,
        })),
      );
    }

    if (route.length === 1 && route[0] === 'boards') {
      const page = await store.browse({ tagsAll: ['kind:goal'], limit: MAX_BROWSE_LIMIT });
      const boards = page.memories.flatMap((m) => {
        const board = tagValue(m.tags, 'board:');
        if (board === undefined) return [];
        return [{ scope: m.scope, board, state: tagValue(m.tags, 'state:') ?? null, goalId: m.id }];
      });
      return Response.json({ boards, more: page.hasMore });
    }

    return bad('Not found', 404);
  } catch (e) {
    if (e instanceof StoreError) return bad(e.message);
    console.error('web-api error', e);
    return bad('Database error', 500);
  }
}
