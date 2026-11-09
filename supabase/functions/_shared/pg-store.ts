import type postgres from 'npm:postgres@3.4.5';
import { type Sql, withMember } from './db.ts';
import { isUuid } from './thread-store.ts';
import { applyDecay, importanceMultiplier, isEvergreen, parseDecayHalfLife } from './decay.ts';
import {
  checkContent,
  checkLimit,
  DEFAULT_LIMIT,
  OVER_FETCH_FACTOR,
  PRUNE_MAX_DORMANT_DAYS_DEFAULT,
  PRUNE_MIN_STRENGTH_DEFAULT,
  STORE_BATCH_MAX,
  StoreError,
} from './limits.ts';
import type {
  Embedder,
  Memory,
  MemoryCategory,
  MemoryStats,
  MemoryStore,
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
  private async resolveSession(tx: Tx, s?: SessionRef): Promise<string | null> {
    if (!s || (s.session === undefined && s.sessionLabel === undefined)) return null;
    if (s.session !== undefined && !isUuid(s.session)) throw new StoreError('Session not found');
    const rows = await tx<Row[]>`
      select id from agent_memory.resolve_session(${s.session ?? null}::uuid, ${s.sessionLabel ?? null}::text, false)`;
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
      await this.touch(tx, results);
      await this.addSessionLabels(tx, results);
      return results;
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
      return results;
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
      return rows.map(rowToMemory);
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
