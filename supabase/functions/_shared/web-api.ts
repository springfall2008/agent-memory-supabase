import { MAX_BROWSE_LIMIT, StoreError } from './limits.ts';
import {
  amendmentContent,
  BOARD_ACTIONS,
  BOARD_NAME,
  BOARD_NAME_MAX,
  type BoardAction,
  FIELD_MAX,
  fold,
  hintContent,
  intentContent,
  isRaise,
  type MaxIntents,
  maxIntentsOf,
  roundOf,
  TEXT_MAX,
  transition,
  withMaxIntents,
  withState,
} from './board-writes.ts';
import {
  type BrowseFilters,
  type BrowsePage,
  type GraphFilters,
  type GraphResult,
  type LinkType,
  type Memory,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type ScopeInfo,
  type SearchFilters,
  type SearchMode,
  type SearchResult,
  type StoreRequest,
  type UpdateRequest,
} from './types.ts';
import { type ModelTokens, USAGE_ROLES, type UsageRole, type UsageRow, type UsageStore } from './usage-store.ts';

/** The slice of the store the web UI uses. `PgMemoryStore` satisfies it. */
export interface WebStore {
  listScopes(): Promise<ScopeInfo[]>;
  browse(f: BrowseFilters): Promise<BrowsePage>;
  search(q: string, mode: SearchMode, f: SearchFilters): Promise<SearchResult[]>;
  get(id: string): Promise<Memory | null>;
  graph(f: GraphFilters): Promise<GraphResult>;
  /** The caller's own display name. */
  memberName(): Promise<string>;
  store(scope: string, r: StoreRequest): Promise<Memory>;
  relate(from: string, to: string, type: LinkType): Promise<void>;
  update(id: string, u: UpdateRequest): Promise<Memory>;
  delete(id: string): Promise<void>;
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** A refusal decided by the route itself, with its status. */
class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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

// ── Write routes ───────────────────────────────────────────────────

type Body = Record<string, unknown>;

async function jsonBody(req: Request): Promise<Body> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new Refusal(415, 'Content-Type must be application/json');
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new Refusal(400, 'Invalid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Refusal(400, 'The body must be a JSON object');
  }
  return body as Body;
}

function optionalString(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Refusal(400, `${key} must be a string`);
  return v;
}

function requiredString(b: Body, key: string): string {
  const v = optionalString(b, key);
  if (v === undefined || v === '') throw new Refusal(400, `${key} is required`);
  return v;
}

/** scope and board, which every write route takes. */
function boardOf(b: Body): { scope: string; board: string } {
  const scope = requiredString(b, 'scope');
  const board = requiredString(b, 'board');
  if (board.length > BOARD_NAME_MAX || !BOARD_NAME.test(board)) throw new Refusal(400, 'Invalid board name');
  return { scope, board };
}

/** The person's text, folded onto one line: 1 to TEXT_MAX characters. */
function textOf(b: Body): string {
  const text = fold(optionalString(b, 'text') ?? '');
  if (text.length < 1 || text.length > TEXT_MAX) throw new Refusal(400, `text must be 1 to ${TEXT_MAX} characters`);
  return text;
}

function fieldOf(b: Body, key: string): string | undefined {
  const v = optionalString(b, key);
  if (v !== undefined && fold(v).length > FIELD_MAX) {
    throw new Refusal(400, `${key} must be at most ${FIELD_MAX} characters`);
  }
  return v;
}

/** The board's goal in `scope`; absent, an unreadable scope and an unknown scope all read the same. */
async function goalOf(store: WebStore, scope: string, board: string): Promise<Memory> {
  let goal: Memory | undefined;
  try {
    goal = (await store.browse({ tagsAll: [`board:${board}`, 'kind:goal'], scopes: [scope], limit: 1 })).memories[0];
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
  }
  if (!goal) throw new Refusal(404, `Board ${board} not found`);
  return goal;
}

/** A readable memory of this board, in the store's own not-found wording otherwise. */
async function boardMemory(store: WebStore, id: string, scope: string, board: string): Promise<Memory> {
  const m = await store.get(id);
  if (!m || m.scope !== scope || !m.tags.includes(`board:${board}`)) throw new Refusal(404, `Memory ${id} not found`);
  return m;
}

/** Stores, then links; a failed link deletes the memory it just stored and rethrows. */
async function storeLinked(
  store: WebStore,
  scope: string,
  r: StoreRequest,
  link?: { to: string; type: LinkType },
): Promise<Memory> {
  const memory = await store.store(scope, r);
  if (link) {
    try {
      await store.relate(memory.id, link.to, link.type);
    } catch (e) {
      try {
        await store.delete(memory.id);
      } catch (d) {
        console.error('web-api rollback failed', memory.id, d);
      }
      throw e;
    }
  }
  return memory;
}

/** Kinds a hint links to with `relates-to`; a hint on any other node is board-wide. */
const HINT_LINKS = ['intent', 'fact', 'hint'];

async function addHint(req: Request, store: WebStore): Promise<Response> {
  const b = await jsonBody(req);
  const { scope, board } = boardOf(b);
  const text = textOf(b);
  const about = optionalString(b, 'about');
  await goalOf(store, scope, board);
  const target = about === undefined ? undefined : await boardMemory(store, about, scope, board);
  const name = await store.memberName();
  const linked = target && HINT_LINKS.includes(tagValue(target.tags, 'kind:') ?? '');
  const memory = await storeLinked(
    store,
    scope,
    { content: hintContent(text, name), category: 'observation', tags: [`board:${board}`, 'kind:hint', 'evergreen'] },
    linked ? { to: target.id, type: 'relates-to' } : undefined,
  );
  return Response.json({ memory }, { status: 201 });
}

async function addAmendment(req: Request, store: WebStore): Promise<Response> {
  const b = await jsonBody(req);
  const { scope, board } = boardOf(b);
  const text = textOf(b);
  const goal = await goalOf(store, scope, board);
  if (tagValue(goal.tags, 'state:') === 'done') throw new Refusal(409, 'Board is done');
  const name = await store.memberName();
  const memory = await storeLinked(
    store,
    scope,
    {
      content: amendmentContent(text, name),
      category: 'observation',
      tags: [`board:${board}`, 'kind:amendment', 'evergreen'],
    },
    { to: goal.id, type: 'depends-on' },
  );
  return Response.json({ memory }, { status: 201 });
}

async function addIntent(req: Request, store: WebStore): Promise<Response> {
  const b = await jsonBody(req);
  const { scope, board } = boardOf(b);
  const text = textOf(b);
  const produce = fieldOf(b, 'produce');
  const giveUp = fieldOf(b, 'giveUp');
  const from = optionalString(b, 'from');
  const goal = await goalOf(store, scope, board);
  const state = tagValue(goal.tags, 'state:');
  if (state !== 'running' && state !== 'paused') throw new Refusal(409, 'Board is not running');
  // The fact's id as stored, not the request's text, goes in the Why line and the link.
  let fromFact: string | undefined;
  if (from !== undefined) {
    const fact = await boardMemory(store, from, scope, board);
    if (!fact.tags.includes('kind:fact')) throw new Refusal(400, 'from must be a fact on the board');
    fromFact = fact.id;
  }
  const progress = (await store.browse({
    tagsAll: [`board:${board}`, 'kind:progress'],
    scopes: [scope],
    limit: 1,
  })).memories[0];
  const round = progress ? roundOf(progress.content) : undefined;
  const name = await store.memberName();
  const tags = [`board:${board}`, 'kind:intent', 'state:open', ...(round === undefined ? [] : [`round:${round}`])];
  const memory = await storeLinked(
    store,
    scope,
    {
      content: intentContent({ text, name, produce, giveUp, fromFact }),
      category: 'observation',
      tags: [...tags, 'evergreen'],
    },
    fromFact === undefined ? undefined : { to: fromFact, type: 'derived-from' },
  );
  return Response.json({ memory }, { status: 201 });
}

/** The marker the lead writes in a conclusion when a board stops at its intent limit. */
const LIMIT_STOP = 'Stopped: intent limit';

async function controlBoard(req: Request, store: WebStore): Promise<Response> {
  const b = await jsonBody(req);
  const { scope, board } = boardOf(b);
  const action = b.action;
  if (action !== undefined && !(BOARD_ACTIONS as readonly unknown[]).includes(action)) {
    throw new Refusal(400, 'Invalid action');
  }
  const max = b.maxIntents;
  if (max !== undefined && max !== 'none' && !(typeof max === 'number' && Number.isSafeInteger(max) && max >= 1)) {
    throw new Refusal(400, 'maxIntents must be a positive integer or "none"');
  }
  if (action === undefined && max === undefined) throw new Refusal(400, 'Give an action or maxIntents');

  const goal = await goalOf(store, scope, board);
  const state = tagValue(goal.tags, 'state:') ?? 'unknown';
  let next: string | undefined;
  if (action !== undefined) {
    const to = transition(state, action as BoardAction);
    if (to === null) throw new Refusal(409, `Board is ${state}`);
    next = to;
  }
  const u: UpdateRequest = {};
  if (max !== undefined) {
    const content = withMaxIntents(goal.content, max as MaxIntents);
    if (content !== goal.content) u.content = content;
    // Raising the limit of a board that stopped at it is the skill's `resume`.
    if (next === undefined && state === 'stopped' && isRaise(maxIntentsOf(goal.content), max as MaxIntents)) {
      const conclusions = await store.browse({
        tagsAll: [`board:${board}`, 'kind:conclusion'],
        scopes: [scope],
        limit: 20,
      });
      if (conclusions.memories.some((m) => m.content.includes(LIMIT_STOP))) next = 'running';
    }
  }
  if (next !== undefined) u.tags = withState(goal.tags, next);
  if (u.content === undefined && u.tags === undefined) return Response.json({ goal });
  return Response.json({ goal: await store.update(goal.id, u) });
}

// ── Usage (written by the board runner) ────────────────────────────

const USAGE_TEXT_MAX = 100;
const USAGE_OUTCOME_MAX = 40;
const USAGE_MODELS_MAX = 20;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function countOf(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Refusal(400, `${key} must be a whole number from 0`);
  }
  return v;
}

function tokensIn(v: unknown, key: string): ModelTokens {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Refusal(400, `${key} must be an object`);
  const t = v as Body;
  return {
    input: countOf(t.input, `${key}.input`),
    output: countOf(t.output, `${key}.output`),
    cacheRead: countOf(t.cacheRead, `${key}.cacheRead`),
    cacheWrite: countOf(t.cacheWrite, `${key}.cacheWrite`),
  };
}

function boundedText(b: Body, key: string, max: number, nullable: boolean): string | null {
  const v = b[key];
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > max) {
    throw new Refusal(400, `${key} must be 1 to ${max} characters`);
  }
  return v;
}

function nullableCount(b: Body, key: string): number | null {
  return b[key] === null ? null : countOf(b[key], key);
}

function timeOf(b: Body, key: string): string | null {
  const v = b[key];
  if (v === null) return null;
  if (typeof v !== 'string' || !ISO_TIME.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Refusal(400, `${key} must be an ISO-8601 time or null`);
  }
  return v;
}

/** A usage row from the body, every field checked; the SQL function checks them again. */
function usageRowOf(b: Body): UsageRow {
  const { scope, board } = boardOf(b);
  const role = b.role;
  if (!(USAGE_ROLES as readonly unknown[]).includes(role)) throw new Refusal(400, 'Invalid role');
  const models = b.models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Refusal(400, 'models must be an object');
  }
  const entries = Object.entries(models as Body);
  if (entries.length > USAGE_MODELS_MAX) throw new Refusal(400, `At most ${USAGE_MODELS_MAX} models`);
  const byModel: Record<string, ModelTokens> = {};
  for (const [name, t] of entries) {
    if (name.length < 1 || name.length > USAGE_TEXT_MAX) throw new Refusal(400, 'Invalid model name');
    byModel[name] = tokensIn(t, `models.${name}`);
  }
  return {
    scope,
    board,
    runLabel: boundedText(b, 'runLabel', USAGE_TEXT_MAX, false) as string,
    role: role as UsageRole,
    intentId: boundedText(b, 'intentId', USAGE_TEXT_MAX, true),
    outcome: boundedText(b, 'outcome', USAGE_OUTCOME_MAX, true),
    runnerModel: boundedText(b, 'runnerModel', USAGE_TEXT_MAX, false) as string,
    tokens: tokensIn(b.tokens, 'tokens'),
    turns: nullableCount(b, 'turns'),
    durationMs: nullableCount(b, 'durationMs'),
    models: byModel,
    startedAt: timeOf(b, 'startedAt'),
    endedAt: timeOf(b, 'endedAt'),
  };
}

async function recordUsage(req: Request, _store: WebStore, usage: UsageStore): Promise<Response> {
  const row = usageRowOf(await jsonBody(req));
  try {
    return Response.json({ id: await usage.record(row) }, { status: 201 });
  } catch (e) {
    // The runner drops a row on 400 (it can never succeed) and retries anything else. A scope the token cannot reach
    // yet may become writable, so say 404 or 403 rather than 400.
    // Plain string tests: the edge runtime's parser fails on a regex literal holding a quote here.
    const m = e instanceof StoreError ? e.message : '';
    if (m.startsWith("Scope '") && m.endsWith("' not found")) throw new Refusal(404, m);
    if (m.startsWith('No write access to scope ')) throw new Refusal(403, m);
    throw e;
  }
}

async function deleteUsage(req: Request, _store: WebStore, usage: UsageStore): Promise<Response> {
  const { scope, board } = boardOf(await jsonBody(req));
  return Response.json({ deleted: await usage.deleteBoard(scope, board) });
}

type WriteRoute = (req: Request, store: WebStore, usage: UsageStore) => Promise<Response>;

const WRITE_ROUTES = new Map<string, WriteRoute>([
  ['hints', addHint],
  ['intents', addIntent],
  ['amendments', addAmendment],
  ['boards/control', controlBoard],
  ['usage', recordUsage],
  ['usage/delete', deleteUsage],
]);

export async function routeWebApi(req: Request, store: WebStore, usage: UsageStore): Promise<Response> {
  const url = new URL(req.url);
  const route = routeOf(url);
  const p = url.searchParams;
  const path = route.join('/');
  const write = WRITE_ROUTES.get(path);
  // `/usage` takes both: a GET reads a board's runs, a POST records one.
  const method = path === 'usage'
    ? req.method === 'GET' || req.method === 'POST'
    : req.method === (write ? 'POST' : 'GET');
  if (!method) return bad('Method not allowed', 405);
  try {
    if (write && req.method === 'POST') return await write(req, store, usage);

    if (path === 'usage') {
      const scope = p.get('scope');
      const board = p.get('board');
      if (!scope || !board) return bad('scope and board are required');
      return Response.json(await usage.forBoard(scope, board));
    }

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
    if (e instanceof Refusal) return bad(e.message, e.status);
    if (e instanceof StoreError) return bad(e.message);
    console.error('web-api error', e);
    return bad('Database error', 500);
  }
}
