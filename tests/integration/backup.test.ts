// Wipes the shared local test database (truncate ... cascade) to prove a restore into an empty install.
// To stay safe it snapshots everything first and puts it back afterwards (access tokens are not
// restorable by design, so tokens in the local DB are lost). Keep this in its own file: deno test
// runs files sequentially, so no other integration file overlaps it.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert';
import { exportBackup, restoreBackup } from '../../scripts/backup.ts';
import { adminSql, LOCAL_DB_URL } from '../helpers/fixtures.ts';

const sql = adminSql();
let keepDir = false; // set when a safety restore failed, so the snapshot file survives
const dir = await Deno.makeTempDir({ prefix: 'backup-test-' });

const vec = (seed: number) => `[${Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) / 10).join(',')}]`;

async function truncateAll() {
  await sql`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
    agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
}

async function cli(...args: string[]) {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', 'scripts/backup.ts', ...args],
    env: { AGENT_MEMORY_DB_URL: LOCAL_DB_URL },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

async function snapshotRows() {
  const mem = await sql`select id, scope_id, content, category, tags, created_at::text, updated_at::text,
    created_by, updated_by, access_count, last_accessed_at::text, deleted_at::text, embedding::text
    from agent_memory.memories order by id`;
  const grants = await sql`select scope_id, member_id, access, granted_at::text, granted_by
    from agent_memory.scope_grants order by member_id`;
  const members = await sql`select id, display_name, kind, email, auth_user_id, created_at::text,
      is_admin, deactivated_at::text from agent_memory.members order by id`;
  const scopes = await sql`select id, description, created_at::text, name from agent_memory.scopes order by name`;
  return { mem, grants, members, scopes };
}

Deno.test('backup and restore-backup round trip', async () => {
  const original = await exportBackup(sql); // whatever the local DB holds now, put back at the end
  const originalFile = `${dir}/original-local-db.json`;
  await Deno.writeTextFile(originalFile, JSON.stringify(original), { mode: 0o600 });
  let safe = false;
  try {
    await truncateAll();
    const [a] =
      await sql`insert into agent_memory.scopes (name, description) values ('bk-alpha', 'first') returning id`;
    const [b] = await sql`insert into agent_memory.scopes (name) values ('bk-beta') returning id`;
    const [ann] = await sql`insert into agent_memory.members (display_name, kind, email, auth_user_id)
      values ('bk-ann', 'human', 'ann@example.test', gen_random_uuid()) returning id`;
    const [bot] =
      await sql`insert into agent_memory.members (display_name, kind) values ('bk-bot', 'bot') returning id`;
    await sql`insert into agent_memory.members (display_name, kind, is_admin) values ('bk-root', 'human', true)`;
    await sql`insert into agent_memory.members (display_name, kind, deactivated_at)
      values ('bk-gone', 'human', '2026-01-02 03:04:05.678901+00')`;
    await sql`insert into agent_memory.scope_grants (scope_id, member_id, access, granted_by)
      values (${a.id}, ${ann.id}, 'write', 'tester'), (${b.id}, ${bot.id}, 'read', 'tester')`;
    const mk = async (scope: string, content: string, seed: number, by: string, extra = sql`null`) => {
      const [r] = await sql`insert into agent_memory.memories
        (scope_id, content, category, tags, created_by, updated_by, access_count, last_accessed_at, deleted_at, embedding)
        values (${scope}, ${content}, 'learning', ${sql.array(['x', 'y,z', 'q"uote'], 1009)}, ${by}, ${by}, ${seed},
                now(), ${extra}, ${vec(seed)}::extensions.vector) returning id`;
      return r.id as string;
    };
    const live = await mk(a.id, 'live memory', 3, ann.id);
    const dead = await mk(a.id, 'deleted memory', 4, ann.id, sql`now()`);
    await mk(b.id, 'other scope memory', 5, bot.id);
    // a token whose hash must never appear
    await sql`insert into agent_memory.access_tokens (member_id, name, token_hash)
      values (${ann.id}, 'laptop', ${'f'.repeat(64)})`;

    // --- backup file
    const full = `${dir}/full.json`;
    const r1 = await cli('backup', '--out', full);
    assertEquals(r1.code, 0, r1.err);
    assertEquals((await Deno.stat(full)).mode! & 0o777, 0o600);
    const again = await cli('backup', '--out', full);
    assertEquals(again.code, 1);
    assertStringIncludes(again.err, `${full} already exists`);
    const text = await Deno.readTextFile(full);
    assert(!text.includes('token_hash'));
    assert(!text.includes('amm_'));
    assert(!text.includes('f'.repeat(64)));
    const data = JSON.parse(text);
    assertEquals(data.format, 'agent-memory-supabase-backup');
    assertEquals(data.version, 1);
    assertEquals(data.memories.length, 3);
    const bkRoot = data.members.find((m: { displayName: string }) => m.displayName === 'bk-root');
    assertEquals(bkRoot.isAdmin, true);
    assertEquals(bkRoot.deactivatedAt, null);
    assertEquals(
      data.members.find((m: { displayName: string }) => m.displayName === 'bk-gone').deactivatedAt,
      '2026-01-02T03:04:05.678901Z',
    );
    assertEquals(data.memories.find((m: { id: string }) => m.id === dead).deletedAt !== null, true);
    assertEquals(data.memories.find((m: { id: string }) => m.id === live).deletedAt, null);
    assertEquals(data.memories.find((m: { id: string }) => m.id === live).createdBy, 'bk-ann');
    assertEquals(data.memories[0].embedding.length, 384);

    // --- --scope limits memories, grants and members
    const only = `${dir}/only.json`;
    const r2 = await cli('backup', '--scope', 'bk-alpha', '--out', only);
    assertEquals(r2.code, 0, r2.err);
    const sc = JSON.parse(await Deno.readTextFile(only));
    assertEquals(sc.scopes.map((s: { name: string }) => s.name), ['bk-alpha']);
    assertEquals(sc.memories.length, 2);
    assertEquals(sc.grants.map((g: { member: string }) => g.member), ['bk-ann']);
    assertEquals(sc.members.map((m: { displayName: string }) => m.displayName), ['bk-ann']);
    const r3 = await cli('backup', '--scope', 'nope', '--out', `${dir}/nope.json`);
    assertEquals(r3.code, 1);
    assertStringIncludes(r3.err, "Scope 'nope' not found");

    // --- wipe, restore, compare
    const before = await snapshotRows();
    await truncateAll();
    const r4 = await cli('restore-backup', full);
    assertEquals(r4.code, 0, r4.err);
    const after = await snapshotRows();
    assertEquals(after.scopes.length, 2);
    assert(before.members.some((m) => m.auth_user_id !== null));
    assertEquals(after.members, before.members); // incl. auth_user_id, created_at, is_admin, deactivated_at
    const flags = new Map(after.members.map((m) => [m.display_name, m]));
    assertEquals(flags.get('bk-root')!.is_admin, true);
    assertEquals(flags.get('bk-ann')!.is_admin, false);
    assertEquals(flags.get('bk-gone')!.deactivated_at, '2026-01-02 03:04:05.678901+00');
    assertEquals(flags.get('bk-root')!.deactivated_at, null);
    assertEquals(after.scopes, before.scopes); // ids preserved
    assertEquals(after.mem, before.mem); // includes embedding::text and microsecond timestamps
    assertEquals(after.grants, before.grants);
    const hist = await sql`select action, member_id from agent_memory.memory_history`;
    assertEquals(hist.length, 3);
    assert(hist.every((h) => h.action === 'insert' && h.member_id === null));
    assertEquals((await sql`select count(*)::int as n from agent_memory.access_tokens`)[0].n, 0);

    // --- a version-1 file without the admin fields still loads (isAdmin false, deactivatedAt null)
    await truncateAll();
    const old = JSON.parse(text);
    for (const m of old.members) {
      delete m.isAdmin;
      delete m.deactivatedAt;
    }
    await restoreBackup(sql, old);
    assertEquals(
      (await sql`select count(*)::int as n from agent_memory.members where is_admin or deactivated_at is not null`)[0]
        .n,
      0,
    );
    await truncateAll();
    await restoreBackup(sql, data);

    // --- refuses into a non-empty install
    const r5 = await cli('restore-backup', full);
    assertEquals(r5.code, 1);
    assertStringIncludes(r5.err, 'restore-backup needs an empty install');
    assertNotEquals(r5.out.includes('Restored'), true);
    assertEquals((await sql`select count(*)::int as n from agent_memory.memories`)[0].n, 3);
  } finally {
    try {
      await truncateAll();
      await restoreBackup(sql, original);
      safe = true;
    } catch (e) {
      console.error(
        `Safety restore failed (${(e as Error).message}); the local DB snapshot is kept at ${originalFile}`,
      );
    } finally {
      await sql.end();
    }
    if (!safe) keepDir = true;
  }
});

type DbSql = ReturnType<typeof adminSql>;

/** Empties the shared local DB for `fn`, then puts back what was there (as the test above does). */
async function withEmptyDb(fn: (db: DbSql) => Promise<void>) {
  const db = adminSql();
  const original = await exportBackup(db);
  const originalFile = `${dir}/original-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(originalFile, JSON.stringify(original), { mode: 0o600 });
  let safe = false;
  try {
    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    await fn(db);
  } finally {
    try {
      await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
        agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
      await restoreBackup(db, original);
      safe = true;
    } catch (e) {
      console.error(`Safety restore failed (${(e as Error).message}); the snapshot is kept at ${originalFile}`);
    }
    await db.end();
    if (safe) await Deno.remove(originalFile);
    else keepDir = true;
  }
}

/** Two scopes, two members, sessions, threads (one soft-deleted), posts, links and subscriptions. */
async function seedThreads(db: DbSql) {
  const [a] = await db`insert into agent_memory.scopes (name) values ('th-alpha') returning id`;
  const [b] = await db`insert into agent_memory.scopes (name) values ('th-beta') returning id`;
  const [ann] = await db`insert into agent_memory.members (display_name, kind) values ('th-ann', 'human') returning id`;
  const [bot] = await db`insert into agent_memory.members (display_name, kind) values ('th-bot', 'bot') returning id`;
  const [cat] = await db`insert into agent_memory.members (display_name, kind) values ('th-cat', 'human') returning id`;
  await db`insert into agent_memory.scope_grants (scope_id, member_id, access)
    values (${a.id}, ${ann.id}, 'write'), (${b.id}, ${bot.id}, 'write')`;
  const [s1] = await db`insert into agent_memory.agent_sessions (member_id, label, created_at, last_seen_at)
    values (${ann.id}, 'one', '2026-02-03 04:05:06.123456+00', '2026-02-03 04:05:07.654321+00') returning id`;
  const [s2] = await db`insert into agent_memory.agent_sessions (member_id, label)
    values (${bot.id}, null) returning id`;
  const [s3] = await db`insert into agent_memory.agent_sessions (member_id, label)
    values (${cat.id}, 'unrelated') returning id`;
  const mem = async (scope: string, content: string, seed: number, by: string, cs: string | null, us: string | null) =>
    (await db`insert into agent_memory.memories
      (scope_id, content, category, tags, created_by, updated_by, created_session, updated_session, embedding)
      values (${scope}, ${content}, 'learning', ${db.array(['t'], 1009)}, ${by}, ${by}, ${cs}, ${us},
              ${vec(seed)}::extensions.vector) returning id`)[0].id as string;
  const mA = await mem(a.id, 'alpha memory', 1, ann.id, s1.id, s1.id);
  const mB = await mem(b.id, 'beta memory', 2, bot.id, null, null);
  const [tA] = await db`insert into agent_memory.threads
    (scope_id, title, status, created_by, created_session, created_at, last_post_at, post_count, resolved_at, resolved_by)
    values (${a.id}, 'alpha thread', 'resolved', ${ann.id}, ${s1.id}, '2026-03-01 00:00:00.111111+00',
            '2026-03-02 00:00:00.222222+00', 2, '2026-03-02 00:00:00.222222+00', ${ann.id}) returning id`;
  const [tB] = await db`insert into agent_memory.threads
    (scope_id, title, created_by, created_session, deleted_at, post_count)
    values (${b.id}, 'beta thread', ${bot.id}, ${s2.id}, '2026-04-01 00:00:00.333333+00', 1) returning id`;
  await db`insert into agent_memory.thread_posts (thread_id, seq, kind, body, author_id, session_id, created_at)
    values (${tA.id}, 1, 'post', 'first', ${ann.id}, ${s1.id}, '2026-03-01 00:00:00.111111+00'),
           (${tA.id}, 2, 'resolve', 'done', ${ann.id}, null, '2026-03-02 00:00:00.222222+00'),
           (${tB.id}, 1, 'post', 'beta post', ${bot.id}, ${s2.id}, now())`;
  await db`insert into agent_memory.thread_links (thread_id, memory_id, linked_by, linked_at)
    values (${tA.id}, ${mA}, ${ann.id}, '2026-03-01 00:00:01.444444+00'),
           (${tA.id}, ${mB}, ${ann.id}, '2026-03-01 00:00:02.555555+00'),
           (${tB.id}, ${mB}, ${bot.id}, now())`;
  await db`insert into agent_memory.thread_subscriptions (session_id, thread_id, last_seen_seq, subscribed_at)
    values (${s1.id}, ${tA.id}, 2, '2026-03-01 00:00:03.666666+00'), (${s2.id}, ${tB.id}, 0, now()),
           (${s3.id}, ${tB.id}, 0, now())`;
  return { tA: tA.id as string, tB: tB.id as string, mA, mB, s1: s1.id as string, s2: s2.id as string };
}

async function threadRows(db: DbSql) {
  return {
    sessions: await db`select id, member_id, label, created_at::text, last_seen_at::text
      from agent_memory.agent_sessions order by id`,
    threads: await db`select id, scope_id, title, status, created_by, created_session, created_at::text,
      last_post_at::text, post_count, resolved_at::text, resolved_by, deleted_at::text
      from agent_memory.threads order by id`,
    posts: await db`select thread_id, seq, kind, body, author_id, session_id, created_at::text
      from agent_memory.thread_posts order by thread_id, seq`,
    links: await db`select thread_id, memory_id, linked_by, linked_at::text
      from agent_memory.thread_links order by thread_id, memory_id`,
    subs: await db`select session_id, thread_id, last_seen_seq, subscribed_at::text
      from agent_memory.thread_subscriptions order by session_id, thread_id`,
    memSessions: await db`select id, created_session, updated_session from agent_memory.memories order by id`,
  };
}

Deno.test('backup round-trips threads, posts, links, sessions and subscriptions', () =>
  withEmptyDb(async (db) => {
    await seedThreads(db);
    const before = await threadRows(db);
    assertEquals(before.threads.length, 2);
    const file = `${dir}/threads.json`;
    const r1 = await cli('backup', '--out', file);
    assertEquals(r1.code, 0, r1.err);
    const data = JSON.parse(await Deno.readTextFile(file));
    assertEquals(data.sessions.length, 3);
    assertEquals(data.threads.length, 2);
    assertEquals(data.threadPosts.length, 3);
    assertEquals(data.threadLinks.length, 3);
    assertEquals(data.subscriptions.length, 3);
    assertEquals(data.version, 1);

    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    const r2 = await cli('restore-backup', file);
    assertEquals(r2.code, 0, r2.err);
    assertEquals(await threadRows(db), before);

    // a file written before threads existed still restores
    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    for (const k of ['sessions', 'threads', 'threadPosts', 'threadLinks', 'subscriptions']) delete data[k];
    for (const m of data.memories) {
      delete m.createdSession;
      delete m.updatedSession;
    }
    await restoreBackup(db, data);
    assertEquals((await db`select count(*)::int as n from agent_memory.memories`)[0].n, 2);
    assertEquals((await db`select count(*)::int as n from agent_memory.threads`)[0].n, 0);
  }));

Deno.test('scoped backup drops links to memories outside the scope', () =>
  withEmptyDb(async (db) => {
    const ids = await seedThreads(db);
    const file = `${dir}/scoped.json`;
    const r = await cli('backup', '--scope', 'th-alpha', '--out', file);
    assertEquals(r.code, 0, r.err);
    const d = JSON.parse(await Deno.readTextFile(file));
    assertEquals(d.threads.map((t: { id: string }) => t.id), [ids.tA]);
    assertEquals(d.threadPosts.length, 2);
    assertEquals(d.threadLinks.map((l: { memoryId: string }) => l.memoryId), [ids.mA]);
    assertEquals(d.sessions.map((s: { id: string }) => s.id), [ids.s1]);
    assertEquals(d.subscriptions.map((s: { sessionId: string }) => s.sessionId), [ids.s1]);
    assertEquals(d.members.map((m: { displayName: string }) => m.displayName), ['th-ann']);
    const mem = d.memories[0];
    assertEquals([mem.createdSession, mem.updatedSession], [ids.s1, ids.s1]);

    // it restores into an empty install
    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    await restoreBackup(db, d);
    assertEquals((await db`select count(*)::int as n from agent_memory.thread_links`)[0].n, 1);
  }));

const linkRows = (db: DbSql) =>
  db`select from_id, to_id, type, created_by, created_at::text from agent_memory.memory_links
    order by from_id, to_id, type`;

Deno.test('backup round-trips memory links', () =>
  withEmptyDb(async (db) => {
    const ids = await seedThreads(db);
    const [ann] = await db`select id from agent_memory.members where display_name = 'th-ann'`;
    const [bot] = await db`select id from agent_memory.members where display_name = 'th-bot'`;
    await db`insert into agent_memory.memory_links (from_id, to_id, type, created_by, created_at) values
      (${ids.mA}, ${ids.mB}, 'supersedes', ${ann.id}, '2026-05-01 00:00:01.123456+00'),
      (${ids.mA}, ${ids.mB}, 'depends-on', ${ann.id}, '2026-05-01 00:00:02.234567+00'),
      (${ids.mA}, ${ids.mB}, 'relates-to', ${bot.id}, '2026-05-01 00:00:03.345678+00'),
      (${ids.mB}, ${ids.mA}, 'derived-from', ${bot.id}, '2026-05-01 00:00:04.456789+00')`;
    const before = await linkRows(db);
    assertEquals(before.length, 4);
    const file = `${dir}/links.json`;
    const r1 = await cli('backup', '--out', file);
    assertEquals(r1.code, 0, r1.err);
    assertStringIncludes(r1.out, '4 memory links');
    const data = JSON.parse(await Deno.readTextFile(file));
    assertEquals(data.memoryLinks.length, 4);
    assertEquals(data.memoryLinks.map((l: { type: string }) => l.type).sort(), [
      'depends-on',
      'derived-from',
      'relates-to',
      'supersedes',
    ]);

    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    const r2 = await cli('restore-backup', file);
    assertEquals(r2.code, 0, r2.err);
    assertStringIncludes(r2.out, '4 memory links');
    assertEquals(await linkRows(db), before);

    // a file written before links existed still restores
    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    delete data.memoryLinks;
    await restoreBackup(db, data);
    assertEquals((await db`select count(*)::int as n from agent_memory.memories`)[0].n, 2);
    assertEquals((await db`select count(*)::int as n from agent_memory.memory_links`)[0].n, 0);
  }));

Deno.test('scoped backup drops memory links to memories outside the scope', () =>
  withEmptyDb(async (db) => {
    const ids = await seedThreads(db);
    const [ann] = await db`select id from agent_memory.members where display_name = 'th-ann'`;
    const [bot] = await db`select id from agent_memory.members where display_name = 'th-bot'`;
    const [alpha] = await db`select id from agent_memory.scopes where name = 'th-alpha'`;
    const [mA2] = await db`insert into agent_memory.memories
      (scope_id, content, category, tags, created_by, updated_by, embedding)
      values (${alpha.id}, 'second alpha memory', 'learning', ${db.array(['t'], 1009)}, ${ann.id}, ${ann.id},
              ${vec(9)}::extensions.vector) returning id`;
    // one link inside th-alpha (made by a member with no grant there), one across to th-beta
    await db`insert into agent_memory.memory_links (from_id, to_id, type, created_by) values
      (${ids.mA}, ${mA2.id}, 'relates-to', ${bot.id}),
      (${ids.mA}, ${ids.mB}, 'depends-on', ${ann.id})`;
    const file = `${dir}/links-scoped.json`;
    const r = await cli('backup', '--scope', 'th-alpha', '--out', file);
    assertEquals(r.code, 0, r.err);
    const d = JSON.parse(await Deno.readTextFile(file));
    assertEquals(d.memoryLinks.length, 1);
    assertEquals(d.memoryLinks[0].type, 'relates-to');
    assertEquals(d.memoryLinks[0].createdBy, 'th-bot');
    assert(d.members.some((m: { displayName: string }) => m.displayName === 'th-bot'), 'the link author is included');

    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    await restoreBackup(db, d);
    assertEquals((await db`select count(*)::int as n from agent_memory.memory_links`)[0].n, 1);
  }));

const claimRows = (db: DbSql) =>
  db`select memory_id, member_id, session_id, description, claimed_at::text, expires_at::text
    from agent_memory.memory_claims order by memory_id`;

Deno.test('backup round-trips active memory claims', () =>
  withEmptyDb(async (db) => {
    const ids = await seedThreads(db);
    const [ann] = await db`select id from agent_memory.members where display_name = 'th-ann'`;
    const [bot] = await db`select id from agent_memory.members where display_name = 'th-bot'`;
    const [alpha] = await db`select id from agent_memory.scopes where name = 'th-alpha'`;
    const [old] = await db`insert into agent_memory.memories
      (scope_id, content, category, tags, created_by, updated_by, embedding)
      values (${alpha.id}, 'an old ticket', 'learning', ${db.array(['t'], 1009)}, ${ann.id}, ${ann.id},
              ${vec(7)}::extensions.vector) returning id`;
    await db`insert into agent_memory.memory_claims (memory_id, member_id, session_id, description, claimed_at, expires_at)
      values (${ids.mA}, ${ann.id}, ${ids.s1}, 'timed claim', '2026-05-01 00:00:01.123456+00', now() + interval '1 day'),
             (${ids.mB}, ${bot.id}, null, 'indefinite claim', '2026-05-01 00:00:02.234567+00', null),
             (${old.id}, ${ann.id}, null, 'expired claim', now() - interval '2 hours', now() - interval '1 hour')`;
    const active = (await claimRows(db)).filter((r) => r.memory_id !== old.id);
    assertEquals(active.length, 2);
    const file = `${dir}/claims.json`;
    const r1 = await cli('backup', '--out', file);
    assertEquals(r1.code, 0, r1.err);
    assertStringIncludes(r1.out, '2 memory claims');
    const data = JSON.parse(await Deno.readTextFile(file));
    assertEquals(data.memoryClaims.length, 2, 'the expired claim is not written');

    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    const r2 = await cli('restore-backup', file);
    assertEquals(r2.code, 0, r2.err);
    assertStringIncludes(r2.out, '2 memory claims');
    assertEquals([...(await claimRows(db))], active);

    // a claim that has expired by restore time is skipped, and an unknown session is left empty
    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    data.memoryClaims[0].expiresAt = '2020-01-01T00:00:00.000000Z';
    data.memoryClaims[1].sessionId = crypto.randomUUID();
    await restoreBackup(db, data);
    const back = await claimRows(db);
    assertEquals(back.length, 1);
    assertEquals(back[0].session_id, null);
  }));

Deno.test('a scoped backup includes the sessions and members its claims reference', () =>
  withEmptyDb(async (db) => {
    const ids = await seedThreads(db);
    const [cat] = await db`select id from agent_memory.members where display_name = 'th-cat'`;
    const [s3] = await db`select id from agent_memory.agent_sessions where label = 'unrelated'`;
    await db`insert into agent_memory.memory_claims (memory_id, member_id, session_id, description, expires_at)
      values (${ids.mA}, ${cat.id}, ${s3.id}, 'cat is on it', now() + interval '1 day')`;
    const file = `${dir}/claims-scoped.json`;
    const r = await cli('backup', '--scope', 'th-alpha', '--out', file);
    assertEquals(r.code, 0, r.err);
    const d = JSON.parse(await Deno.readTextFile(file));
    assertEquals(d.memoryClaims.length, 1);
    assert(d.sessions.some((x: { id: string }) => x.id === s3.id), 'the claim session is in the file');
    assert(
      d.members.some((m: { displayName: string }) => m.displayName === 'th-cat'),
      'the claim holder is in the file',
    );

    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    await restoreBackup(db, d);
    const back = await claimRows(db);
    assertEquals(back.length, 1);
    assertEquals(back[0].session_id, s3.id);
  }));

const usageRows = (db: DbSql) =>
  db`select s.name as scope, u.board, u.run_label, u.role, u.intent_id, u.outcome, u.runner_model, u.input_tokens::text,
       u.output_tokens::text, u.cache_read_tokens::text, u.cache_write_tokens::text, u.turns, u.duration_ms::text,
       u.models, u.started_at::text, u.ended_at::text, m.display_name as recorder, u.created_at::text, u.updated_at::text
    from agent_memory.board_usage u join agent_memory.scopes s on s.id = u.scope_id
    join agent_memory.members m on m.id = u.recorded_by order by u.run_label`;

Deno.test('backup round-trips board usage, and a scoped backup keeps only its scope and the recorder', () =>
  withEmptyDb(async (db) => {
    await seedThreads(db);
    const [ann] = await db`select id from agent_memory.members where display_name = 'th-ann'`;
    const [cat] = await db`select id from agent_memory.members where display_name = 'th-cat'`;
    const [alpha] = await db`select id from agent_memory.scopes where name = 'th-alpha'`;
    const [beta] = await db`select id from agent_memory.scopes where name = 'th-beta'`;
    await db`insert into agent_memory.board_usage (scope_id, board, run_label, role, intent_id, outcome, runner_model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns, duration_ms, models, started_at,
        ended_at, recorded_by, created_at, updated_at)
      values (${alpha.id}, 'b', 'board-b-0001', 'worker', null, 'fact confirmed', 'opus', 9007199254740991, 2, 3, 4, 5,
              6000, '{"opus": {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4}}',
              '2026-05-01 00:00:01.123456+00', '2026-05-01 00:00:02.234567+00', ${cat.id},
              '2026-05-01 00:00:03.345678+00', '2026-05-01 00:00:04.456789+00'),
             (${beta.id}, 'b', 'board-b-lead-0002', 'lead', null, null, 'fable', 1, 1, 1, 1, null, null, '{}', null, null,
              ${ann.id}, now(), now())`;
    const before = [...(await usageRows(db))];
    const file = `${dir}/usage.json`;
    const r1 = await cli('backup', '--out', file);
    assertEquals(r1.code, 0, r1.err);
    assertStringIncludes(r1.out, '2 usage rows');
    await db`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
      agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
    const r2 = await cli('restore-backup', file);
    assertEquals(r2.code, 0, r2.err);
    assertStringIncludes(r2.out, '2 usage rows');
    assertEquals([...(await usageRows(db))], before);

    const scoped = `${dir}/usage-scoped.json`;
    assertEquals((await cli('backup', '--scope', 'th-alpha', '--out', scoped)).code, 0);
    const d = JSON.parse(await Deno.readTextFile(scoped));
    assertEquals(d.boardUsage.length, 1);
    assertEquals(d.boardUsage[0].recordedBy, 'th-cat');
    assert(d.members.some((m: { displayName: string }) => m.displayName === 'th-cat'), 'the recorder is included');
  }));

Deno.test('remove the backup test directory', async () => {
  if (!keepDir) await Deno.remove(dir, { recursive: true });
});
