import type postgres from 'npm:postgres@3.4.5';
import { type Sql, withMember } from './db.ts';
import { isUuid } from './thread-store.ts';
import { applyDecay, importanceMultiplier, isEvergreen, parseDecayHalfLife } from './decay.ts';
import {
  checkBrowseLimit,
  checkClaimMinutes,
  checkContent,
  checkDepth,
  checkLimit,
  checkOffset,
  CLAIM_DEFAULT_MINUTES,
  CLAIM_DESCRIPTION_MAX,
  CLAIM_SNIPPET_CHARS,
  DEFAULT_LIMIT,
  GRAPH_FULL_MAX_NODES,
  GRAPH_MAX_NODES,
  GRAPH_SNIPPET_CHARS,
  LINKS_SHOWN_MAX,
  MY_CLAIMS_MAX,
  NEIGHBOURS_DEFAULT_DEPTH,
  NEIGHBOURS_MAX_RESULTS,
  OVER_FETCH_FACTOR,
  PRUNE_MAX_DORMANT_DAYS_DEFAULT,
  PRUNE_MIN_STRENGTH_DEFAULT,
  snippet,
  STORE_BATCH_MAX,
  StoreError,
} from './limits.ts';
import { LINK_TYPES } from './types.ts';
import type {
  BrowseFilters,
  BrowsePage,
  ClaimNextFilters,
  ClaimNextResult,
  ClaimOptions,
  ClaimResult,
  Embedder,
  GraphEdge,
  GraphFilters,
  GraphNode,
  GraphResult,
  LinkDirection,
  LinkType,
  Memory,
  MemoryCategory,
  MemoryClaim,
  MemoryStats,
  MemoryStore,
  MyClaim,
  Neighbour,
  NeighbourOptions,
  NeighboursResult,
  PruneOptions,
  PruneResult,
  ScopeInfo,
  SearchFilters,
  SearchMode,
  SearchResult,
  SessionRef,
  StoreRequest,
  UpdateRequest,
} from './types.ts';

type Tx = postgres.TransactionSql;
const MS_PER_DAY = 86_400_000;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** Validates a claim's description and duration as the SQL does; minutes is null for an indefinite claim. */
function claimArgs(description: string, o: { minutes?: number; indefinite?: boolean }) {
  const desc = description.trim();
  if (desc.length < 1 || desc.length > CLAIM_DESCRIPTION_MAX) {
    throw new StoreError(`Description must be 1-${CLAIM_DESCRIPTION_MAX} characters`);
  }
  if (o.indefinite && o.minutes !== undefined) throw new StoreError('Pass minutes or indefinite, not both');
  const minutes = o.indefinite ? null : o.minutes ?? CLAIM_DEFAULT_MINUTES;
  if (minutes !== null) checkClaimMinutes(minutes);
  return { desc, minutes };
}

export function rowToMemory(r: Row): Memory {
  const m: Memory = {
    id: r.id,
    scope: r.scope,
    content: r.content,
    category: r.category as MemoryCategory,
    tags: r.tags,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
  if (r.created_session_label != null) m.createdSession = r.created_session_label;
  if (r.updated_session_label != null) m.updatedSession = r.updated_session_label;
  return m;
}

const SEARCH_MODES: readonly string[] = ['hybrid', 'keyword', 'semantic'];
const vec = (e: number[]): string => JSON.stringify(e);
const notFoundMemory = (id: string) => new StoreError(`Memory ${id} not found`);
const noWrite = (scope: string) => new StoreError(`No write access to scope '${scope}'`);

/** A malformed session id fails before any embedding or query. */
function checkSessionId(s?: SessionRef): void {
  if (s?.session !== undefined && !isUuid(s.session)) throw new StoreError('Session not found');
}

export class PgMemoryStore implements MemoryStore {
  constructor(
    private readonly sql: Sql,
    private readonly memberId: string,
    private readonly embedder: Embedder,
    private readonly halfLifeDays: number = parseDecayHalfLife(Deno.env.get('MEMORY_DECAY_HALF_LIFE')),
  ) {}

  /** Run as the member; Postgres errors become friendly messages, never raw driver text. */
  private async run<T>(fn: (tx: Tx) => Promise<T>, onPgError?: (code: string) => Error | undefined): Promise<T> {
    try {
      return await withMember(this.sql, this.memberId, fn);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const code = (e as { code?: string }).code;
      if (code === 'P0001') throw new StoreError((e as Error).message);
      const mapped = code ? onPgError?.(code) : undefined;
      if (mapped) throw mapped;
      console.error('database error', code, (e as Error).message);
      throw new Error('Database error');
    }
  }

  private async scopeAccess(tx: Tx, name: string): Promise<{ id: string; access: 'read' | 'write' } | null> {
    const rows = await tx<Row[]>`
      select s.id, g.access from agent_memory.scopes s
      join agent_memory.scope_grants g on g.scope_id = s.id and g.member_id = ${this.memberId}::uuid
      where s.name = ${name}`;
    return rows[0] ? { id: rows[0].id, access: rows[0].access } : null;
  }

  private async writableScope(tx: Tx, name: string): Promise<string> {
    const s = await this.scopeAccess(tx, name);
    if (!s) throw new StoreError(`Scope '${name}' not found`);
    if (s.access !== 'write') throw noWrite(name);
    return s.id;
  }

  /** Resolves the named session (never creating one) inside the write transaction; null when none was named. */
  private async resolveSession(tx: Tx, s?: SessionRef, create = false): Promise<string | null> {
    if (!s || (s.session === undefined && s.sessionLabel === undefined)) return null;
    if (s.session !== undefined && !isUuid(s.session)) throw new StoreError('Session not found');
    const rows = await tx<Row[]>`
      select id from agent_memory.resolve_session(
        ${s.session ?? null}::uuid, ${s.sessionLabel ?? null}::text, ${create}::boolean)`;
    return rows[0]?.id ?? null;
  }

  /** Adds session labels to search results, which come from functions that do not return them. */
  private async addSessionLabels(tx: Tx, results: SearchResult[]): Promise<void> {
    if (results.length === 0) return;
    const ids = results.map((r) => r.memory.id);
    const rows = await tx<Row[]>`
      select id, created_session_label, updated_session_label from agent_memory.memory_view
      where id = any(${ids}::uuid[])`;
    const byId = new Map(rows.map((x) => [x.id, x]));
    for (const r of results) {
      const x = byId.get(r.memory.id);
      if (x?.created_session_label != null) r.memory.createdSession = x.created_session_label;
      if (x?.updated_session_label != null) r.memory.updatedSession = x.updated_session_label;
    }
  }

  /**
   * Adds each memory's visible links (at most LINKS_SHOWN_MAX, newest first), the count of the rest, and `superseded`
   * when a visible `supersedes` link points at it. One query for the whole set, never one per memory; the database
   * ranks, caps and counts, so a hub memory costs LINKS_SHOWN_MAX rows however many links it has. Memories with no
   * visible links gain no key.
   */
  private async addLinks(tx: Tx, memories: Memory[]): Promise<void> {
    if (memories.length === 0) return;
    const ids = [...new Set(memories.map((m) => m.id))];
    const rows = await tx<Row[]>`
      select memory_id, type, direction, other_id, total, superseded
      from agent_memory.memory_links_for(${ids}::uuid[], ${LINKS_SHOWN_MAX}::int)`;
    if (rows.length === 0) return;
    const byMemory = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byMemory.get(r.memory_id) ?? [];
      list.push(r);
      byMemory.set(r.memory_id, list);
    }
    for (const m of memories) {
      const mine = byMemory.get(m.id);
      if (!mine) continue;
      m.links = mine.map((r) => ({
        type: r.type as LinkType,
        direction: r.direction as LinkDirection,
        memoryId: r.other_id as string,
      }));
      const total = Number(mine[0].total);
      if (total > mine.length) m.moreLinks = total - mine.length;
      if (mine[0].superseded === true) m.superseded = true;
    }
  }

  /**
   * Adds the active claim, if any, to each memory: holder, end and description, plus `mine` and the session only when
   * the caller holds it. One query for the whole set, never one per memory. Memories with no active claim gain no key.
   */
  private async addClaims(tx: Tx, memories: { id: string; claim?: MemoryClaim }[]): Promise<void> {
    if (memories.length === 0) return;
    const ids = [...new Set(memories.map((m) => m.id))];
    const rows = await tx<Row[]>`select * from agent_memory.memory_claims_for(${ids}::uuid[])`;
    if (rows.length === 0) return;
    const byMemory = new Map(rows.map((r) => [r.memory_id as string, r]));
    for (const m of memories) {
      const r = byMemory.get(m.id);
      if (!r) continue;
      const claim: MemoryClaim = {
        by: r.holder,
        until: r.expires_at ? iso(r.expires_at) : null,
        description: r.description,
      };
      if (r.mine === true) {
        claim.mine = true;
        if (r.session_id != null) claim.session = { id: r.session_id, label: r.session_label ?? null };
      }
      m.claim = claim;
    }
  }

  async listScopes(): Promise<ScopeInfo[]> {
    return await this.run(async (tx) => {
      const rows = await tx<Row[]>`
        select s.name, s.description, g.access,
          (select count(*)::int from agent_memory.memories m where m.scope_id = s.id) as n
        from agent_memory.scope_grants g
        join agent_memory.scopes s on s.id = g.scope_id
        where g.member_id = ${this.memberId}::uuid
        order by s.name`;
      return rows.map((r) => ({
        scope: r.name,
        description: r.description,
        access: r.access,
        memoryCount: r.n,
      }));
    });
  }

  /** The caller's own display name, read as the member. */
  async memberName(): Promise<string> {
    return await this.run(async (tx) => {
      const [r] = await tx<Row[]>`select agent_memory.member_name(agent_memory.current_member_id()) as name`;
      return (r?.name as string | null) ?? 'the person';
    });
  }

  async store(scope: string, r: StoreRequest, s?: SessionRef): Promise<Memory> {
    return (await this.storeBatch(scope, [r], s))[0];
  }

  async storeBatch(scope: string, rs: StoreRequest[], s?: SessionRef): Promise<Memory[]> {
    checkSessionId(s);
    if (rs.length > STORE_BATCH_MAX) {
      throw new Error(
        `store_batch accepts at most ${STORE_BATCH_MAX} memories per call on this server; ` +
          `split the batch or call store for each memory.`,
      );
    }
    for (const r of rs) checkContent(r.content);
    // Embed (sequentially) before opening the transaction.
    const embeddings: number[][] = [];
    for (const r of rs) embeddings.push(await this.embedder.embed(r.content));
    return await this.run(async (tx) => {
      const scopeId = await this.writableScope(tx, scope);
      const sessionId = await this.resolveSession(tx, s);
      const ids: string[] = [];
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        const ins = await tx<Row[]>`
          insert into agent_memory.memories (scope_id, content, category, tags, created_by, updated_by, embedding,
            created_session, updated_session)
          values (${scopeId}::uuid, ${r.content}, ${r.category}, ${tx.array(r.tags)}::text[],
            ${this.memberId}::uuid, ${this.memberId}::uuid, ${vec(embeddings[i])}::extensions.vector,
            ${sessionId}::uuid, ${sessionId}::uuid)
          returning id`;
        ids.push(ins[0].id);
      }
      const rows = await tx<Row[]>`select * from agent_memory.memory_view where id = any(${ids}::uuid[])`;
      const byId = new Map(rows.map((x) => [x.id, x]));
      return ids.map((id) => rowToMemory(byId.get(id)!));
    }, (code) => code === '42501' ? noWrite(scope) : undefined);
  }

  /** Visible memory (via RLS), with its write access resolved; throws the two standard errors. */
  private async visibleWritable(tx: Tx, id: string): Promise<Row> {
    let rows: Row[];
    try {
      rows = await tx.savepoint((s) => s<Row[]>`select * from agent_memory.memory_view where id = ${id}::uuid`);
    } catch (e) {
      if ((e as { code?: string }).code === '22P02') throw notFoundMemory(id);
      throw e;
    }
    const row = rows[0];
    if (!row) throw notFoundMemory(id);
    const s = await this.scopeAccess(tx, row.scope);
    if (s?.access !== 'write') throw noWrite(row.scope);
    return row;
  }

  async update(id: string, u: UpdateRequest, s?: SessionRef): Promise<Memory> {
    checkSessionId(s);
    if (u.content !== undefined) checkContent(u.content);
    // Read current state first so we know whether to embed (outside the write transaction).
    const current = await this.run((tx) => this.visibleWritable(tx, id));
    // Content is only written together with its embedding: if no embed is needed, leave the column untouched.
    let embedding: string | null = null;
    let newContent: string | null = null;
    if (u.content !== undefined && u.content !== current.content) {
      embedding = vec(await this.embedder.embed(u.content));
      newContent = u.content;
    }
    return await this.run(async (tx) => {
      await this.visibleWritable(tx, id);
      const sessionId = await this.resolveSession(tx, s);
      const targetScope = u.scope !== undefined ? await this.writableScope(tx, u.scope) : null;
      const upd = await tx<Row[]>`
        update agent_memory.memories set
          content = coalesce(${newContent}::text, content),
          category = coalesce(${u.category ?? null}::text, category),
          tags = coalesce(${u.tags ? tx.array(u.tags) : null}::text[], tags),
          scope_id = coalesce(${targetScope}::uuid, scope_id),
          embedding = coalesce(${embedding}::extensions.vector, embedding),
          updated_by = ${this.memberId}::uuid,
          updated_session = ${sessionId}::uuid,
          updated_at = now()
        where id = ${id}::uuid and deleted_at is null
        returning id`;
      if (upd.length === 0) throw notFoundMemory(id);
      const rows = await tx<Row[]>`select * from agent_memory.memory_view where id = ${id}::uuid`;
      return rowToMemory(rows[0]);
    }, (code) => code === '22P02' ? notFoundMemory(id) : code === '42501' ? noWrite(current.scope) : undefined);
  }

  async delete(id: string): Promise<void> {
    await this.run(async (tx) => {
      await this.visibleWritable(tx, id);
      const res = await tx<{ ids: string[] }[]>`select agent_memory.soft_delete(array[${id}]::uuid[]) as ids`;
      if (res[0].ids.length === 0) throw notFoundMemory(id);
    }, (code) => code === '22P02' ? notFoundMemory(id) : undefined);
  }

  /** The single prune rule, shared by prune and stats. Returns null when the memory is not a candidate. */
  private pruneVerdict(
    row: Row,
    minStrength: number,
    maxDormantDays: number,
  ): { strength: number; reason: string } | null {
    if (isEvergreen(row.tags)) return null;
    const updatedAt = iso(row.updated_at);
    const ageDays = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / MS_PER_DAY);
    // Deliberate deviation from the original server: there, a disabled half-life gave every memory strength 0,
    // so "strength < minStrength" made every non-evergreen memory a prune candidate. Here, with decay disabled
    // (half-life <= 0) nothing decays, strength is 1, and only the dormant criterion applies.
    const decayOn = this.halfLifeDays > 0;
    const strength = decayOn
      ? Math.pow(
        0.5,
        ageDays / (this.halfLifeDays * importanceMultiplier({
          accessCount: row.access_count,
          lastAccessedAt: row.last_accessed_at ? iso(row.last_accessed_at) : null,
          updatedAt,
        })),
      )
      : 1;
    let reason = '';
    if (decayOn && strength < minStrength) reason = `strength ${strength.toFixed(4)} < ${minStrength}`;
    else if (Number(row.access_count) === 0 && ageDays > maxDormantDays) {
      reason = `never accessed, ${Math.floor(ageDays)} days old > ${maxDormantDays}`;
    }
    return reason ? { strength, reason } : null;
  }

  async prune(o: PruneOptions): Promise<PruneResult> {
    const {
      dryRun = true,
      minStrength = PRUNE_MIN_STRENGTH_DEFAULT,
      maxDormantDays = PRUNE_MAX_DORMANT_DAYS_DEFAULT,
    } = o;
    return await this.run(async (tx) => {
      const scopeId = await this.writableScope(tx, o.scope);
      const rows = await tx<Row[]>`
        select id, content, tags, updated_at, access_count, last_accessed_at
        from agent_memory.memories where scope_id = ${scopeId}::uuid`;
      const candidates: PruneResult['candidates'] = [];
      for (const row of rows) {
        const v = this.pruneVerdict(row, minStrength, maxDormantDays);
        if (v) {
          candidates.push({ id: row.id, content: row.content.slice(0, 120), strength: v.strength, reason: v.reason });
        }
      }
      let pruned = 0;
      if (!dryRun && candidates.length > 0) {
        const ids = candidates.map((c) => c.id);
        const res = await tx<{ ids: string[] }[]>`select agent_memory.soft_delete(${ids}::uuid[]) as ids`;
        pruned = res[0].ids.length;
      }
      return { pruned, inspected: rows.length, dryRun, candidates };
    });
  }

  // ── Read half ──────────────────────────────────────────────────

  /** Resolve scope names to ids the member can read. Omitted or empty → every readable scope. */
  private async resolveScopeIds(tx: Tx, names?: string[]): Promise<string[]> {
    if (!names || names.length === 0) {
      const rows = await tx<Row[]>`
        select scope_id as id from agent_memory.scope_grants where member_id = ${this.memberId}::uuid`;
      return rows.map((r) => r.id);
    }
    const unique = [...new Set(names)];
    const rows = await tx<Row[]>`
      select s.id, s.name from agent_memory.scopes s
      join agent_memory.scope_grants g on g.scope_id = s.id and g.member_id = ${this.memberId}::uuid
      where s.name = any(${unique}::text[])`;
    const found = new Set(rows.map((r) => r.name));
    for (const n of unique) if (!found.has(n)) throw new StoreError(`Scope '${n}' not found`);
    return rows.map((r) => r.id);
  }

  private toDecayInputs(rows: Row[]) {
    return rows.map((r) => ({
      memory: rowToMemory(r),
      rawScore: Number(r.raw_score),
      accessCount: Number(r.access_count),
      lastAccessedAt: r.last_accessed_at ? iso(r.last_accessed_at) : null,
    }));
  }

  private async touch(tx: Tx, results: SearchResult[]): Promise<void> {
    if (results.length === 0) return;
    const ids = results.map((r) => r.memory.id);
    await tx`select agent_memory.touch_accessed(${ids}::uuid[])`;
  }

  async search(
    query: string,
    mode: SearchMode,
    f: SearchFilters,
    embedding?: number[] | null,
  ): Promise<SearchResult[]> {
    if (!SEARCH_MODES.includes(mode)) throw new Error('Invalid search mode');
    const limit = f.limit ?? DEFAULT_LIMIT;
    checkLimit(limit);
    for (const d of [f.after, f.before]) {
      if (d !== undefined && Number.isNaN(Date.parse(d))) throw new StoreError('Invalid date filter');
    }
    // null forces keyword-only; otherwise embed (outside the transaction) unless the mode is keyword.
    let effectiveMode: SearchMode = mode;
    let emb: number[] | null = null;
    if (embedding === null) effectiveMode = 'keyword';
    else if (mode !== 'keyword') emb = embedding ?? await this.embedder.embed(query);
    const embArg = emb ? vec(emb) : null;
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, f.scopes);
      if (scopeIds.length === 0) return [];
      const rows = await tx<Row[]>`
        select * from agent_memory.search_memories(
          ${query}::text, ${embArg}::extensions.vector, ${effectiveMode}::text, ${scopeIds}::uuid[],
          ${f.category ?? null}::text, ${f.tags?.length ? tx.array(f.tags) : null}::text[],
          ${f.tagsAll?.length ? tx.array(f.tagsAll) : null}::text[],
          ${f.after ?? null}::timestamptz, ${f.before ?? null}::timestamptz,
          ${limit * OVER_FETCH_FACTOR}::int)`;
      const results = applyDecay(this.toDecayInputs(rows), limit, this.halfLifeDays);
      if (f.touch !== false) await this.touch(tx, results);
      await this.addSessionLabels(tx, results);
      await this.addLinks(tx, results.map((r) => r.memory));
      await this.addClaims(tx, results.map((r) => r.memory));
      return results;
    });
  }

  /**
   * Unranked listing for sweeps: every readable memory matching the filters, newest first (`created_at desc, id`, a
   * total order, so pages never overlap). Paged in SQL; no embedding, no decay, and no access-count bump, so a cleanup
   * scan does not change what prune and decay see. Fetches one extra row to learn `hasMore`.
   */
  async browse(f: BrowseFilters): Promise<BrowsePage> {
    const limit = f.limit ?? DEFAULT_LIMIT;
    const offset = f.offset ?? 0;
    checkBrowseLimit(limit);
    checkOffset(offset);
    for (const d of [f.after, f.before]) {
      if (d !== undefined && Number.isNaN(Date.parse(d))) throw new StoreError('Invalid date filter');
    }
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, f.scopes);
      if (scopeIds.length === 0) return { memories: [], hasMore: false };
      const rows = await tx<Row[]>`
        select * from agent_memory.memory_view
        where scope_id = any(${scopeIds}::uuid[])
          and (${f.category ?? null}::text is null or category = ${f.category ?? null}::text)
          and (${f.tags?.length ? tx.array(f.tags) : null}::text[] is null
               or tags && ${f.tags?.length ? tx.array(f.tags) : null}::text[])
          and (${f.tagsAll?.length ? tx.array(f.tagsAll) : null}::text[] is null
               or tags @> ${f.tagsAll?.length ? tx.array(f.tagsAll) : null}::text[])
          and (${f.after ?? null}::timestamptz is null or created_at >= ${f.after ?? null}::timestamptz)
          and (${f.before ?? null}::timestamptz is null or created_at <= ${f.before ?? null}::timestamptz)
        order by created_at desc, id
        limit ${limit + 1} offset ${offset}`;
      const memories = rows.slice(0, limit).map(rowToMemory);
      await this.addLinks(tx, memories);
      await this.addClaims(tx, memories);
      return { memories, hasMore: rows.length > limit };
    });
  }

  /**
   * One memory with its links, claim and session labels, or null when the id is not a UUID, does not exist, is
   * unreadable to the caller or is soft-deleted (all indistinguishable). Not an access: no `touch_accessed`.
   */
  async get(id: string): Promise<Memory | null> {
    if (!isUuid(id)) return null;
    return await this.run(async (tx) => {
      const rows = await tx<Row[]>`select * from agent_memory.memory_view where id = ${id}::uuid`;
      if (rows.length === 0) return null;
      const memory = rowToMemory(rows[0]);
      await this.addLinks(tx, [memory]);
      await this.addClaims(tx, [memory]);
      return memory;
    });
  }

  async findRelated(id: string, limit: number, scopes?: string[]): Promise<SearchResult[]> {
    checkLimit(limit);
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, scopes);
      let visible: Row[];
      try {
        visible = await tx.savepoint((s) => s<Row[]>`select id from agent_memory.memory_view where id = ${id}::uuid`);
      } catch (e) {
        if ((e as { code?: string }).code === '22P02') throw notFoundMemory(id);
        throw e;
      }
      if (visible.length === 0) throw notFoundMemory(id);
      const rows = await tx<Row[]>`
        select * from agent_memory.related_memories(${id}::uuid, ${scopeIds}::uuid[], ${
        limit * OVER_FETCH_FACTOR
      }::int)`;
      const results = applyDecay(this.toDecayInputs(rows), limit, this.halfLifeDays);
      await this.touch(tx, results);
      await this.addSessionLabels(tx, results);
      await this.addLinks(tx, results.map((r) => r.memory));
      await this.addClaims(tx, results.map((r) => r.memory));
      return results;
    });
  }

  async relate(from: string, to: string, type: LinkType): Promise<void> {
    if (!isUuid(from)) throw notFoundMemory(from);
    if (!isUuid(to)) throw notFoundMemory(to);
    await this.run(async (tx) => {
      await tx`select agent_memory.relate_memories(${from}::uuid, ${to}::uuid, ${type}::text)`;
    });
  }

  async unrelate(from: string, to: string, type: LinkType): Promise<boolean> {
    if (!isUuid(from)) throw notFoundMemory(from);
    if (!isUuid(to)) throw notFoundMemory(to);
    return await this.run(async (tx) => {
      const [r] = await tx<Row[]>`
        select agent_memory.unrelate_memories(${from}::uuid, ${to}::uuid, ${type}::text) as removed`;
      return r.removed === true;
    });
  }

  /** Follows visible links breadth-first from one memory. Navigation, not relevance: it does not count as an access. */
  async neighbours(id: string, o: NeighbourOptions): Promise<NeighboursResult> {
    if (!isUuid(id)) throw notFoundMemory(id);
    const depth = o.depth ?? NEIGHBOURS_DEFAULT_DEPTH;
    checkDepth(depth);
    const direction = o.direction ?? 'both';
    if (!['out', 'in', 'both'].includes(direction)) throw new StoreError('direction must be out, in or both');
    for (const t of o.types ?? []) {
      if (!LINK_TYPES.includes(t)) throw new StoreError(`Invalid link type '${t}'`);
    }
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, o.scopes);
      const start = await tx<Row[]>`select id from agent_memory.memory_view where id = ${id}::uuid`;
      if (start.length === 0) throw notFoundMemory(id);
      // One statement, so the walk and the memories it names come from the same snapshot: a memory deleted or moved
      // while the walk runs drops out of the join instead of leaving a hole in the result.
      const rows = await tx<Row[]>`
        select v.*, n.path as walk_path
        from agent_memory.memory_neighbours(
          ${id}::uuid, ${direction}::text, ${o.types?.length ? tx.array(o.types) : null}::text[], ${depth}::int,
          ${scopeIds}::uuid[], ${NEIGHBOURS_MAX_RESULTS + 1}::int) with ordinality as n(id, depth, path, ord)
        join agent_memory.memory_view v on v.id = n.id
        order by n.ord`;
      const page = rows.slice(0, NEIGHBOURS_MAX_RESULTS);
      const found = page.map((r) => ({ memory: rowToMemory(r), path: r.walk_path as Neighbour['path'] }));
      await this.addLinks(tx, found.map((n) => n.memory));
      await this.addClaims(tx, found.map((n) => n.memory));
      return { neighbours: found, truncated: rows.length > NEIGHBOURS_MAX_RESULTS };
    });
  }

  /**
   * A project's graph: every readable memory matching the filters, oldest first (capped by detail), and every visible
   * link between them. The links policy hides any link whose other end is unreadable or soft-deleted. No access-count
   * bump and no decay, as for browse.
   */
  async graph(f: GraphFilters): Promise<GraphResult> {
    if (!f.tags?.length && !f.tagsAll?.length) throw new StoreError('Pass tags or tags_all');
    const full = f.detail === 'full';
    const cap = full ? GRAPH_FULL_MAX_NODES : GRAPH_MAX_NODES;
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, f.scopes);
      if (scopeIds.length === 0) return { nodes: [], edges: [], truncated: false, total: 0 };
      const rows = await tx<Row[]>`
        select id, scope, category, tags, content, created_at, count(*) over () as total
        from agent_memory.memory_view
        where scope_id = any(${scopeIds}::uuid[])
          and (${f.category ?? null}::text is null or category = ${f.category ?? null}::text)
          and (${f.tags?.length ? tx.array(f.tags) : null}::text[] is null
               or tags && ${f.tags?.length ? tx.array(f.tags) : null}::text[])
          and (${f.tagsAll?.length ? tx.array(f.tagsAll) : null}::text[] is null
               or tags @> ${f.tagsAll?.length ? tx.array(f.tagsAll) : null}::text[])
        order by created_at, id
        limit ${cap}`;
      const total = rows.length ? Number(rows[0].total) : 0;
      const nodes: GraphNode[] = rows.map((r) => {
        const n: GraphNode = {
          id: r.id,
          scope: r.scope,
          category: r.category as MemoryCategory,
          tags: r.tags,
          createdAt: iso(r.created_at),
        };
        if (full) n.content = r.content;
        else n.snippet = snippet(r.content, GRAPH_SNIPPET_CHARS);
        return n;
      });
      if (nodes.length === 0) return { nodes, edges: [], truncated: false, total };
      const ids = nodes.map((n) => n.id);
      const linkRows = await tx<Row[]>`
        select from_id, to_id, type from agent_memory.memory_links
        where from_id = any(${ids}::uuid[]) and to_id = any(${ids}::uuid[])
        order by created_at, from_id, to_id, type`;
      const edges: GraphEdge[] = linkRows.map((r) => ({ from: r.from_id, to: r.to_id, type: r.type as LinkType }));
      const replaced = await tx<Row[]>`
        select distinct to_id from agent_memory.memory_links
        where type = 'supersedes' and to_id = any(${ids}::uuid[])`;
      const superseded = new Set(replaced.map((r) => r.to_id as string));
      for (const n of nodes) if (superseded.has(n.id)) n.superseded = true;
      await this.addClaims(tx, nodes);
      return { nodes, edges, truncated: total > nodes.length, total };
    });
  }

  /** Claim a memory, renewing the caller's own member-and-session claim; see the SQL function claim_memory. */
  async claim(id: string, description: string, o: ClaimOptions, s?: SessionRef): Promise<ClaimResult> {
    if (!isUuid(id)) throw notFoundMemory(id);
    const { desc, minutes } = claimArgs(description, o);
    return await this.run(async (tx) => {
      const sessionId = await this.resolveSession(tx, s, true);
      const [r] = await tx<Row[]>`
        select * from agent_memory.claim_memory(${id}::uuid, ${desc}::text, ${minutes}::int,
          ${o.indefinite === true}::boolean, ${o.force === true}::boolean, ${sessionId}::uuid)`;
      const result: ClaimResult = { claimed: true, until: r.expires_at ? iso(r.expires_at) : null };
      if (r.overridden_by != null) {
        result.overridden = {
          by: r.overridden_by,
          until: r.overridden_until ? iso(r.overridden_until) : null,
          description: r.overridden_description,
        };
        if (r.overridden_session_id != null) {
          result.overridden.session = { id: r.overridden_session_id, label: r.overridden_session_label ?? null };
        }
      }
      return result;
    });
  }

  /** Release a claim held by the caller's member and session (none matches only none); others need force. */
  async release(id: string, force = false, s?: SessionRef): Promise<boolean> {
    if (!isUuid(id)) throw notFoundMemory(id);
    return await this.run(async (tx) => {
      // A named session that does not resolve raises Session not found here; it never becomes "no session".
      const sessionId = await this.resolveSession(tx, s, false);
      const [r] = await tx<Row[]>`
        select agent_memory.release_claim(${id}::uuid, ${force}::boolean, ${sessionId}::uuid) as released`;
      return r.released === true;
    });
  }

  /**
   * Claim the oldest matching memory nobody holds (see the SQL function claim_next) and return it in full, or
   * `{ claimed: false }` when none is free. A new session label creates the session, as `claim` does.
   */
  async claimNext(
    f: ClaimNextFilters,
    description: string,
    o: { minutes?: number; indefinite?: boolean },
    s?: SessionRef,
  ): Promise<ClaimNextResult> {
    if (!f.tags?.length && !f.tagsAll?.length) throw new StoreError('Pass tags or tags_all');
    const { desc, minutes } = claimArgs(description, o);
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, f.scopes);
      if (scopeIds.length === 0) return { claimed: false };
      const sessionId = await this.resolveSession(tx, s, true);
      const [r] = await tx<Row[]>`
        select * from agent_memory.claim_next(${scopeIds}::uuid[], ${f.category ?? null}::text,
          ${f.tags?.length ? tx.array(f.tags) : null}::text[], ${
        f.tagsAll?.length ? tx.array(f.tagsAll) : null
      }::text[],
          ${desc}::text, ${minutes}::int, ${o.indefinite === true}::boolean, ${sessionId}::uuid)`;
      if (!r) return { claimed: false };
      const [row] = await tx<Row[]>`select * from agent_memory.memory_view where id = ${r.memory_id}::uuid`;
      const memory = rowToMemory(row);
      await this.addLinks(tx, [memory]);
      await this.addClaims(tx, [memory]);
      return { claimed: true, until: r.expires_at ? iso(r.expires_at) : null, memory };
    });
  }

  /** The caller's active claims, soonest end first and indefinite last, each with a snippet of its memory. */
  async myClaims(scopes?: string[]): Promise<MyClaim[]> {
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, scopes);
      const rows = await tx<Row[]>`
        select * from agent_memory.my_claims(${scopeIds}::uuid[], ${MY_CLAIMS_MAX}::int)`;
      return rows.map((r) => {
        const c: MyClaim = {
          memory: {
            id: r.memory_id,
            scope: r.scope,
            category: r.category as MemoryCategory,
            tags: r.tags,
            snippet: snippet(r.content, CLAIM_SNIPPET_CHARS),
          },
          description: r.description,
          claimedAt: iso(r.claimed_at),
          until: r.expires_at ? iso(r.expires_at) : null,
        };
        if (r.session_id != null) c.session = { id: r.session_id, label: r.session_label ?? null };
        return c;
      });
    });
  }

  async listRecent(limit: number, category?: MemoryCategory, scopes?: string[]): Promise<Memory[]> {
    checkLimit(limit);
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, scopes);
      const rows = await tx<Row[]>`
        select * from agent_memory.memory_view
        where scope_id = any(${scopeIds}::uuid[]) and (${category ?? null}::text is null or category = ${
        category ?? null
      }::text)
        order by created_at desc, id
        limit ${limit}`;
      const memories = rows.map(rowToMemory);
      await this.addLinks(tx, memories);
      await this.addClaims(tx, memories);
      return memories;
    });
  }

  async stats(scopes?: string[]): Promise<MemoryStats> {
    return await this.run(async (tx) => {
      const scopeIds = await this.resolveScopeIds(tx, scopes);
      const rows = await tx<Row[]>`
        select * from agent_memory.memory_view where scope_id = any(${scopeIds}::uuid[])`;
      const byCategory: Record<string, number> = {};
      const byScope: Record<string, number> = {};
      let neverAccessed = 0;
      let belowPruneThreshold = 0;
      let totalAccess = 0;
      let oldest: number | null = null;
      let newest: number | null = null;
      for (const r of rows) {
        byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
        byScope[r.scope] = (byScope[r.scope] ?? 0) + 1;
        const ac = Number(r.access_count);
        totalAccess += ac;
        if (ac === 0) neverAccessed++;
        const created = new Date(r.created_at).getTime();
        if (oldest === null || created < oldest) oldest = created;
        if (newest === null || created > newest) newest = created;
        if (this.pruneVerdict(r, PRUNE_MIN_STRENGTH_DEFAULT, PRUNE_MAX_DORMANT_DAYS_DEFAULT)) belowPruneThreshold++;
      }
      const mostAccessed = rows
        .map((r) => ({
          id: r.id as string,
          content: (r.content as string).slice(0, 100),
          count: Number(r.access_count),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      return {
        totalMemories: rows.length,
        byCategory,
        byScope,
        oldestMemory: oldest === null ? null : new Date(oldest).toISOString(),
        newestMemory: newest === null ? null : new Date(newest).toISOString(),
        neverAccessed,
        belowPruneThreshold,
        avgAccessCount: rows.length > 0 ? Math.round((totalAccess / rows.length) * 10) / 10 : 0,
        mostAccessed,
      };
    });
  }
}
