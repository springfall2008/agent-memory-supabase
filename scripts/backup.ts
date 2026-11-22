import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import { connect } from '../supabase/functions/_shared/db.ts';
import type { Sql } from '../supabase/functions/_shared/db.ts';

export const BACKUP_FORMAT = 'agent-memory-supabase-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  scopes: { id: string; name: string; description: string | null; createdAt: string }[];
  members: {
    id: string;
    displayName: string;
    kind: string;
    email: string | null;
    authUserId: string | null;
    createdAt: string;
    /** Absent in version-1 files written before admin support; read as false. */
    isAdmin?: boolean;
    /** Absent in older files; read as null. */
    deactivatedAt?: string | null;
  }[];
  grants: { scope: string; member: string; access: string; grantedAt: string; grantedBy: string | null }[];
  memories: {
    id: string;
    content: string;
    category: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    scope: string;
    createdBy: string | null;
    updatedBy: string | null;
    accessCount: number;
    lastAccessedAt: string | null;
    deletedAt: string | null;
    embedding: number[];
    /** Absent in files written before threads; read as null. */
    createdSession?: string | null;
    updatedSession?: string | null;
  }[];
  /** The thread sections are absent in files written before threads. `member` and the author fields are display names. */
  sessions?: { id: string; member: string; label: string | null; createdAt: string; lastSeenAt: string }[];
  threads?: {
    id: string;
    scope: string;
    title: string;
    status: string;
    createdBy: string;
    createdSession: string | null;
    createdAt: string;
    lastPostAt: string;
    postCount: number;
    resolvedAt: string | null;
    resolvedBy: string | null;
    deletedAt: string | null;
  }[];
  threadPosts?: {
    threadId: string;
    seq: number;
    kind: string;
    body: string;
    author: string;
    sessionId: string | null;
    createdAt: string;
  }[];
  threadLinks?: { threadId: string; memoryId: string; linkedBy: string; linkedAt: string }[];
  subscriptions?: { sessionId: string; threadId: string; lastSeenSeq: number; subscribedAt: string }[];
  /** Absent in files written before memory links. `createdBy` is a display name. */
  memoryLinks?: { fromId: string; toId: string; type: string; createdBy: string; createdAt: string }[];
}

const USAGE = `Usage: deno run -A scripts/backup.ts <command> ...
  backup [--scope <name>] [--out <file>]   (default file: backup-<UTC timestamp>.json)
  restore-backup <file>                    (only into an empty install)
Requires AGENT_MEMORY_DB_URL (direct or session-pooler connection string).
Access token hashes are never exported.`;

// Timestamps travel as text so microsecond precision survives the round trip.
const TS = (col: string) => `to_char(${col} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Read everything except token hashes. With `scope`, only that scope's memories, grants and threads (with their posts,
 * the links to memories in the backup, and subscriptions), the sessions those reference, and the members behind it all.
 */
export function exportBackup(sql: Sql, scope?: string): Promise<Backup> {
  // One repeatable-read snapshot, so a backup taken while writers are active is point-in-time consistent.
  return sql.begin('isolation level repeatable read read only', (tx) => exportSnapshot(tx, scope)) as Promise<Backup>;
}

async function exportSnapshot(sql: Sql, scope?: string): Promise<Backup> {
  const scopeRows = await sql`
    select id, name, description, ${sql.unsafe(TS('created_at'))} as "createdAt"
    from agent_memory.scopes where ${scope === undefined ? sql`true` : sql`name = ${scope}`} order by name`;
  if (scope !== undefined && scopeRows.length === 0) throw new Error(`Scope '${scope}' not found`);
  const names = scopeRows.map((s) => s.name as string);

  const grants = await sql`
    select s.name as scope, m.display_name as member, g.access,
           ${sql.unsafe(TS('g.granted_at'))} as "grantedAt", g.granted_by as "grantedBy"
    from agent_memory.scope_grants g
    join agent_memory.scopes s on s.id = g.scope_id
    join agent_memory.members m on m.id = g.member_id
    where s.name = any(${names}::text[]) order by s.name, m.display_name`;

  const memories = await sql`
    select mem.id, mem.content, mem.category, mem.tags,
           ${sql.unsafe(TS('mem.created_at'))} as "createdAt", ${sql.unsafe(TS('mem.updated_at'))} as "updatedAt",
           s.name as scope, cb.display_name as "createdBy", ub.display_name as "updatedBy",
           mem.access_count as "accessCount", ${sql.unsafe(TS('mem.last_accessed_at'))} as "lastAccessedAt",
           ${sql.unsafe(TS('mem.deleted_at'))} as "deletedAt", mem.embedding::text as embedding,
           mem.created_session as "createdSession", mem.updated_session as "updatedSession"
    from agent_memory.memories mem
    join agent_memory.scopes s on s.id = mem.scope_id
    left join agent_memory.members cb on cb.id = mem.created_by
    left join agent_memory.members ub on ub.id = mem.updated_by
    where s.name = any(${names}::text[]) order by mem.created_at, mem.id`;

  const threads = await sql`
    select t.id, s.name as scope, t.title, t.status, cb.display_name as "createdBy",
           t.created_session as "createdSession", ${sql.unsafe(TS('t.created_at'))} as "createdAt",
           ${sql.unsafe(TS('t.last_post_at'))} as "lastPostAt", t.post_count as "postCount",
           ${sql.unsafe(TS('t.resolved_at'))} as "resolvedAt", rb.display_name as "resolvedBy",
           ${sql.unsafe(TS('t.deleted_at'))} as "deletedAt"
    from agent_memory.threads t
    join agent_memory.scopes s on s.id = t.scope_id
    join agent_memory.members cb on cb.id = t.created_by
    left join agent_memory.members rb on rb.id = t.resolved_by
    where s.name = any(${names}::text[]) order by t.created_at, t.id`;
  const threadIds = threads.map((t) => t.id as string);

  const threadPosts = await sql`
    select p.thread_id as "threadId", p.seq, p.kind, p.body, a.display_name as author,
           p.session_id as "sessionId", ${sql.unsafe(TS('p.created_at'))} as "createdAt"
    from agent_memory.thread_posts p join agent_memory.members a on a.id = p.author_id
    where p.thread_id = any(${threadIds}::uuid[]) order by p.thread_id, p.seq`;

  // Only links whose memory is in this backup, so a scoped file never mentions a memory outside it.
  const memoryIds = memories.map((m) => m.id as string);
  const threadLinks = await sql`
    select l.thread_id as "threadId", l.memory_id as "memoryId", lb.display_name as "linkedBy",
           ${sql.unsafe(TS('l.linked_at'))} as "linkedAt"
    from agent_memory.thread_links l join agent_memory.members lb on lb.id = l.linked_by
    where l.thread_id = any(${threadIds}::uuid[]) and l.memory_id = any(${memoryIds}::uuid[])
    order by l.thread_id, l.memory_id`;

  // Only links whose both ends are in this backup, so a scoped file never mentions a memory outside it.
  const memoryLinks = await sql`
    select l.from_id as "fromId", l.to_id as "toId", l.type, cb.display_name as "createdBy",
           ${sql.unsafe(TS('l.created_at'))} as "createdAt"
    from agent_memory.memory_links l join agent_memory.members cb on cb.id = l.created_by
    where l.from_id = any(${memoryIds}::uuid[]) and l.to_id = any(${memoryIds}::uuid[])
    order by l.from_id, l.to_id, l.type`;

  const subscriptions = await sql`
    select sub.session_id as "sessionId", sub.thread_id as "threadId", sub.last_seen_seq as "lastSeenSeq",
           ${sql.unsafe(TS('sub.subscribed_at'))} as "subscribedAt"
    from agent_memory.thread_subscriptions sub
    where sub.thread_id = any(${threadIds}::uuid[]) order by sub.session_id, sub.thread_id`;

  // A session is kept when anything in the backup points at it.
  const sessionIds = new Set<string>();
  const addSession = (id: string | null) => {
    if (id) sessionIds.add(id);
  };
  for (const p of threadPosts) addSession(p.sessionId);
  for (const t of threads) addSession(t.createdSession);
  for (const m of memories) {
    addSession(m.createdSession);
    addSession(m.updatedSession);
  }
  for (const x of subscriptions) addSession(x.sessionId);
  const sessions = await sql`
    select se.id, m.display_name as member, se.label, ${sql.unsafe(TS('se.created_at'))} as "createdAt",
           ${sql.unsafe(TS('se.last_seen_at'))} as "lastSeenAt"
    from agent_memory.agent_sessions se join agent_memory.members m on m.id = se.member_id
    where ${scope === undefined ? sql`true` : sql`se.id = any(${[...sessionIds]}::uuid[])`}
    order by se.created_at, se.id`;

  const wanted = new Set<string>();
  for (const g of grants) wanted.add(g.member);
  for (const m of memories) {
    if (m.createdBy) wanted.add(m.createdBy);
    if (m.updatedBy) wanted.add(m.updatedBy);
  }
  for (const se of sessions) wanted.add(se.member);
  for (const t of threads) {
    wanted.add(t.createdBy);
    if (t.resolvedBy) wanted.add(t.resolvedBy);
  }
  for (const p of threadPosts) wanted.add(p.author);
  for (const l of threadLinks) wanted.add(l.linkedBy);
  for (const l of memoryLinks) wanted.add(l.createdBy);
  const members = await sql`
    select id, display_name as "displayName", kind, email, auth_user_id as "authUserId",
           ${sql.unsafe(TS('created_at'))} as "createdAt", is_admin as "isAdmin",
           ${sql.unsafe(TS('deactivated_at'))} as "deactivatedAt"
    from agent_memory.members
    where ${scope === undefined ? sql`true` : sql`display_name = any(${[...wanted]}::text[])`}
    order by display_name`;

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    scopes: [...scopeRows] as unknown as Backup['scopes'],
    members: [...members] as unknown as Backup['members'],
    grants: [...grants] as unknown as Backup['grants'],
    memories: memories.map((m) => ({ ...m, embedding: JSON.parse(m.embedding) })) as Backup['memories'],
    sessions: [...sessions] as unknown as NonNullable<Backup['sessions']>,
    threads: [...threads] as unknown as NonNullable<Backup['threads']>,
    threadPosts: [...threadPosts] as unknown as NonNullable<Backup['threadPosts']>,
    threadLinks: [...threadLinks] as unknown as NonNullable<Backup['threadLinks']>,
    subscriptions: [...subscriptions] as unknown as NonNullable<Backup['subscriptions']>,
    memoryLinks: [...memoryLinks] as unknown as NonNullable<Backup['memoryLinks']>,
  };
}

/** Load a backup into an empty install, in one transaction, preserving ids. */
export async function restoreBackup(sql: Sql, data: Backup): Promise<void> {
  if (data?.format !== BACKUP_FORMAT || data.version !== BACKUP_VERSION) {
    throw new Error(`Not an ${BACKUP_FORMAT} version ${BACKUP_VERSION} file`);
  }
  await sql.begin(async (tx) => {
    const [c] = await tx`
      select (select count(*) from agent_memory.scopes) + (select count(*) from agent_memory.members)
           + (select count(*) from agent_memory.memories) as n`;
    if (Number(c.n) !== 0) throw new Error('restore-backup needs an empty install');

    // Timestamps are bound as text then cast: typed as timestamptz, postgres.js routes them through a JS Date
    // and drops the microseconds.
    const memberIds = new Map<string, string>();
    for (const m of data.members) {
      memberIds.set(m.displayName, m.id);
      await tx`
        insert into agent_memory.members
          (id, display_name, kind, email, auth_user_id, created_at, is_admin, deactivated_at)
        values (${m.id}, ${m.displayName}, ${m.kind}, ${m.email}, ${m.authUserId}, (${m.createdAt}::text)::timestamptz,
                ${m.isAdmin ?? false}, (${m.deactivatedAt ?? null}::text)::timestamptz)`;
    }
    const memberId = (name: string | null) => {
      if (name === null) return null;
      const id = memberIds.get(name);
      if (!id) throw new Error(`Backup references unknown member '${name}'`);
      return id;
    };
    for (const se of data.sessions ?? []) {
      await tx`
        insert into agent_memory.agent_sessions (id, member_id, label, created_at, last_seen_at)
        values (${se.id}, ${memberId(se.member)}, ${se.label}, (${se.createdAt}::text)::timestamptz,
                (${se.lastSeenAt}::text)::timestamptz)`;
    }
    const scopeIds = new Map<string, string>();
    for (const s of data.scopes) {
      const [r] = await tx`
        insert into agent_memory.scopes (id, name, description, created_at)
        values (${s.id}, ${s.name}, ${s.description}, (${s.createdAt}::text)::timestamptz) returning id`;
      scopeIds.set(s.name, r.id);
    }
    const scopeId = (name: string) => {
      const id = scopeIds.get(name);
      if (!id) throw new Error(`Backup references unknown scope '${name}'`);
      return id;
    };
    for (const g of data.grants) {
      await tx`
        insert into agent_memory.scope_grants (scope_id, member_id, access, granted_at, granted_by)
        values (${scopeId(g.scope)}, ${
        memberId(g.member)
      }, ${g.access}, (${g.grantedAt}::text)::timestamptz, ${g.grantedBy})`;
    }
    for (const m of data.memories) {
      await tx`
        insert into agent_memory.memories
          (id, scope_id, content, category, tags, created_at, updated_at, created_by, updated_by,
           access_count, last_accessed_at, deleted_at, embedding, created_session, updated_session)
        values (${m.id}, ${scopeId(m.scope)}, ${m.content}, ${m.category}, ${tx.array(m.tags, 1009)},
                (${m.createdAt}::text)::timestamptz, (${m.updatedAt}::text)::timestamptz, ${memberId(m.createdBy)},
                ${memberId(m.updatedBy)}, ${m.accessCount}, (${m.lastAccessedAt}::text)::timestamptz,
                (${m.deletedAt}::text)::timestamptz, ${JSON.stringify(m.embedding)}::extensions.vector,
                ${m.createdSession ?? null}, ${m.updatedSession ?? null})`;
    }
    for (const t of data.threads ?? []) {
      await tx`
        insert into agent_memory.threads
          (id, scope_id, title, status, created_by, created_session, created_at, last_post_at, post_count,
           resolved_at, resolved_by, deleted_at)
        values (${t.id}, ${scopeId(t.scope)}, ${t.title}, ${t.status}, ${memberId(t.createdBy)}, ${t.createdSession},
                (${t.createdAt}::text)::timestamptz, (${t.lastPostAt}::text)::timestamptz, ${t.postCount},
                (${t.resolvedAt}::text)::timestamptz, ${memberId(t.resolvedBy)}, (${t.deletedAt}::text)::timestamptz)`;
    }
    for (const p of data.threadPosts ?? []) {
      await tx`
        insert into agent_memory.thread_posts (thread_id, seq, kind, body, author_id, session_id, created_at)
        values (${p.threadId}, ${p.seq}, ${p.kind}, ${p.body}, ${memberId(p.author)}, ${p.sessionId},
                (${p.createdAt}::text)::timestamptz)`;
    }
    for (const l of data.threadLinks ?? []) {
      await tx`
        insert into agent_memory.thread_links (thread_id, memory_id, linked_by, linked_at)
        values (${l.threadId}, ${l.memoryId}, ${memberId(l.linkedBy)}, (${l.linkedAt}::text)::timestamptz)`;
    }
    for (const l of data.memoryLinks ?? []) {
      await tx`
        insert into agent_memory.memory_links (from_id, to_id, type, created_by, created_at)
        values (${l.fromId}, ${l.toId}, ${l.type}, ${memberId(l.createdBy)}, (${l.createdAt}::text)::timestamptz)`;
    }
    for (const x of data.subscriptions ?? []) {
      await tx`
        insert into agent_memory.thread_subscriptions (session_id, thread_id, last_seen_seq, subscribed_at)
        values (${x.sessionId}, ${x.threadId}, ${x.lastSeenSeq}, (${x.subscribedAt}::text)::timestamptz)`;
    }
  });
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, { string: ['scope', 'out'] });
  const [cmd, ...p] = args._.map(String);
  if (!cmd) {
    console.log(USAGE);
    return;
  }
  if (cmd !== 'backup' && cmd !== 'restore-backup') throw new Error(`Unknown command '${cmd}'\n${USAGE}`);
  if (cmd === 'backup' && p.length) throw new Error(`Usage: backup [--scope <name>] [--out <file>]`);
  if (cmd === 'restore-backup' && p.length !== 1) throw new Error('Usage: restore-backup <file>');
  const url = Deno.env.get('AGENT_MEMORY_DB_URL');
  if (!url) {
    throw new Error('AGENT_MEMORY_DB_URL is not set. Export the database connection string and retry.');
  }
  const sql = connect(url);
  try {
    if (cmd === 'backup') {
      const data = await exportBackup(sql, args.scope);
      const out = args.out ?? `backup-${stamp()}.json`;
      try {
        await Deno.writeTextFile(out, JSON.stringify(data, null, 2) + '\n', { createNew: true, mode: 0o600 });
      } catch (e) {
        if (e instanceof Deno.errors.AlreadyExists) throw new Error(`${out} already exists`);
        throw e;
      }
      console.log(
        `Wrote ${out}: ${data.scopes.length} scopes, ${data.members.length} members, ` +
          `${data.grants.length} grants, ${data.memories.length} memories, ${data.threads?.length ?? 0} threads`,
      );
    } else {
      const data = JSON.parse(await Deno.readTextFile(p[0])) as Backup;
      await restoreBackup(sql, data);
      console.log(
        `Restored ${data.scopes.length} scopes, ${data.members.length} members, ` +
          `${data.grants.length} grants, ${data.memories.length} memories, ${data.threads?.length ?? 0} threads`,
      );
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
