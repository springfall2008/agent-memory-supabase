import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { PgMemoryStore } from '../../supabase/functions/_shared/pg-store.ts';
import { adminSql, LOCAL_DB_URL, makeWorld, type World } from '../helpers/fixtures.ts';
import { FakeEmbedder } from '../helpers/fake-embedder.ts';

type Admin = ReturnType<typeof adminSql>;

async function withWorld(
  fn: (
    w: World,
    admin: Admin,
    mk: (memberId: string, halfLife?: number) => [PgMemoryStore, FakeEmbedder],
  ) => Promise<void>,
) {
  const admin = adminSql();
  const sql = connect(LOCAL_DB_URL);
  const w = await makeWorld(admin);
  try {
    await fn(w, admin, (id, halfLife = 30) => {
      const e = new FakeEmbedder();
      return [new PgMemoryStore(sql, id, e, halfLife), e];
    });
  } finally {
    await w.cleanup();
    await sql.end();
    await admin.end();
  }
}

const req = (content: string, tags: string[] = [], category: 'other' | 'learning' = 'other') => ({
  content,
  category,
  tags,
});
const setUpdated = (admin: Admin, id: string, ago: string) =>
  admin`update agent_memory.memories set updated_at = now() - ${ago}::interval where id = ${id}`;

Deno.test('hybrid, keyword and semantic each find a memory by its words', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const m = await s.store(w.alpha.name, req('zebracorn migration playbook'));
    await s.store(w.alpha.name, req('completely unrelated gardening notes'));
    for (const mode of ['hybrid', 'keyword', 'semantic'] as const) {
      const r = await s.search('zebracorn playbook', mode, {});
      assertEquals(r[0].memory.id, m.id, mode);
      assertEquals(r[0].memory.scope, w.alpha.name);
      assertEquals(r[0].memory.createdBy, w.rw.name);
    }
  }));

Deno.test('keyword mode does not embed; explicit null embedding forces keyword', () =>
  withWorld(async (w, _a, mk) => {
    const [s, e] = mk(w.rw.id);
    await s.store(w.alpha.name, req('zebracorn thing'));
    const before = e.calls;
    assertEquals((await s.search('zebracorn', 'keyword', {})).length, 1);
    assertEquals((await s.search('zebracorn', 'hybrid', {}, null)).length, 1);
    assertEquals(e.calls, before);
    await s.search('zebracorn', 'hybrid', {});
    assertEquals(e.calls, before + 1);
  }));

Deno.test('filters exclude non-matching memories', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const [bs] = mk(w.bw.id);
    const a = await s.store(w.alpha.name, req('quokka report', ['t1'], 'learning'));
    const b = await s.store(w.alpha.name, req('quokka report extra', ['t2'], 'other'));
    const c = await bs.store(w.beta.name, req('quokka report beta'));
    await admin`update agent_memory.memories set created_at = now() - interval '10 days' where id = ${b.id}`;
    const ids = async (f: Parameters<PgMemoryStore['search']>[2], st = s) =>
      (await st.search('quokka report', 'keyword', f)).map((r) => r.memory.id).sort();
    assertEquals(await ids({}), [a.id, b.id].sort());
    assertEquals(await ids({ category: 'learning' }), [a.id]);
    assertEquals(await ids({ tags: ['t2', 'zzz'] }), [b.id]);
    const cut = new Date(Date.now() - 5 * 86_400_000).toISOString();
    assertEquals(await ids({ after: cut }), [a.id]);
    assertEquals(await ids({ before: cut }), [b.id]);
    const [multi] = mk(w.rw.id);
    await admin`insert into agent_memory.scope_grants (scope_id, member_id, access) values (${w.beta.id}, ${w.rw.id}, 'read')`;
    assertEquals(await ids({}, multi), [a.id, b.id, c.id].sort());
    assertEquals(await ids({ scopes: [w.beta.name] }, multi), [c.id]);
  }));

Deno.test('decay: fresh beats old; evergreen is exempt', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const fresh = await s.store(w.alpha.name, req('okapi handbook'));
    const old = await s.store(w.alpha.name, req('okapi handbook'));
    await setUpdated(admin, old.id, '90 days');
    let r = await s.search('okapi handbook', 'keyword', {});
    assertEquals(r.map((x) => x.memory.id), [fresh.id, old.id]);
    // Evergreen is exempt from decay: an equally old evergreen memory must outrank its decayed twin.
    const eg = await s.store(w.alpha.name, req('okapi handbook', ['evergreen']));
    await setUpdated(admin, eg.id, '90 days');
    r = await s.search('okapi handbook', 'keyword', {});
    const score = (id: string) => r.find((x) => x.memory.id === id)!.score;
    assert(r.findIndex((x) => x.memory.id === eg.id) < r.findIndex((x) => x.memory.id === old.id));
    assert(score(eg.id) > score(old.id) * 2);
  }));

Deno.test('permissions: ro searches alpha, none gets [], unreadable scope not found', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    await rw.store(w.alpha.name, req('wombat secrets'));
    const [ro] = mk(w.ro.id);
    assertEquals((await ro.search('wombat', 'keyword', {})).length, 1);
    const [none] = mk(w.none.id);
    assertEquals(await none.search('wombat', 'keyword', {}), []);
    assertEquals(await none.search('wombat', 'hybrid', {}), []);
    await assertRejects(
      () => rw.search('wombat', 'keyword', { scopes: [w.beta.name] }),
      Error,
      `Scope '${w.beta.name}' not found`,
    );
    await assertRejects(
      () => rw.search('wombat', 'keyword', { scopes: [`nope-${w.beta.name}`] }),
      Error,
      `Scope 'nope-${w.beta.name}' not found`,
    );
  }));

Deno.test('invalid mode or limit never surfaces driver text', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    await assertRejects(() => s.search('x', 'bogus' as never, {}), Error, 'Invalid search mode');
    await assertRejects(() => s.search('x', 'keyword', { limit: 0 }), Error, 'limit must be between 1 and 100');
  }));

Deno.test('access tracking: once per hour, updated_at untouched', () =>
  withWorld(async (w, admin, mk) => {
    const [rw] = mk(w.rw.id);
    const m = await rw.store(w.alpha.name, req('pangolin diary'));
    await setUpdated(admin, m.id, '2 hours');
    const [{ u }] = await admin`select updated_at as u from agent_memory.memories where id = ${m.id}`;
    const [ro] = mk(w.ro.id);
    await ro.search('pangolin', 'keyword', {});
    const get = async () =>
      (await admin`select access_count, updated_at from agent_memory.memories where id = ${m.id}`)[0];
    assertEquals((await get()).access_count, 1);
    await ro.search('pangolin', 'keyword', {});
    const after = await get();
    assertEquals(after.access_count, 1);
    assertEquals(after.updated_at.getTime(), u.getTime());
  }));

Deno.test('findRelated: excludes source, scoped, unreadable id not found, no embed', () =>
  withWorld(async (w, _a, mk) => {
    const [rw, e] = mk(w.rw.id);
    const [bw] = mk(w.bw.id);
    const src = await rw.store(w.alpha.name, req('lemur habitat study'));
    const near = await rw.store(w.alpha.name, req('lemur habitat survey'));
    const far = await bw.store(w.beta.name, req('lemur habitat study'));
    const calls = e.calls;
    const r = await rw.findRelated(src.id, 5);
    const ids = r.map((x) => x.memory.id);
    assert(ids.includes(near.id));
    assert(!ids.includes(src.id));
    assert(!ids.includes(far.id));
    assertEquals(e.calls, calls);
    await assertRejects(() => rw.findRelated(far.id, 5), Error, `Memory ${far.id} not found`);
    await assertRejects(() => rw.findRelated('not-a-uuid', 5), Error, 'Memory not-a-uuid not found');
    await assertRejects(() => rw.findRelated(src.id, 0), Error, 'limit must be between 1 and 100');
  }));

Deno.test('stats: scoped counts, byScope, none gets zeros', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const [bw] = mk(w.bw.id);
    await rw.store(w.alpha.name, req('one', [], 'learning'));
    await rw.store(w.alpha.name, req('two'));
    await bw.store(w.beta.name, req('three'));
    const st = await rw.stats();
    assertEquals(st.totalMemories, 2);
    assertEquals(st.byScope, { [w.alpha.name]: 2 });
    assertEquals(st.byCategory, { learning: 1, other: 1 });
    assertEquals(st.neverAccessed, 2);
    assertEquals(st.avgAccessCount, 0);
    assertEquals(st.mostAccessed.length, 2);
    await assertRejects(() => rw.stats([w.beta.name]), Error, `Scope '${w.beta.name}' not found`);
    const [none] = mk(w.none.id);
    assertEquals(await none.stats(), {
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
  }));

Deno.test('stats truncates mostAccessed content to 100 chars', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    await rw.store(w.alpha.name, req('x'.repeat(300)));
    assertEquals((await rw.stats()).mostAccessed[0].content.length, 100);
  }));

Deno.test('listRecent orders newest first, filters category and scope', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const a = await rw.store(w.alpha.name, req('first', [], 'learning'));
    const b = await rw.store(w.alpha.name, req('second'));
    assertEquals((await rw.listRecent(10)).map((m) => m.id), [b.id, a.id]);
    assertEquals((await rw.listRecent(1)).map((m) => m.id), [b.id]);
    assertEquals((await rw.listRecent(10, 'learning')).map((m) => m.id), [a.id]);
    assertEquals((await rw.listRecent(10, undefined, [w.alpha.name])).length, 2);
    assertEquals(await mk(w.none.id)[0].listRecent(10), []);
    await assertRejects(() => rw.listRecent(0), Error, 'limit must be between 1 and 100');
  }));

Deno.test('soft-deleted memories are invisible to every read', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const src = await rw.store(w.alpha.name, req('civet logbook'));
    const gone = await rw.store(w.alpha.name, req('civet logbook'));
    await rw.delete(gone.id);
    for (const mode of ['hybrid', 'keyword', 'semantic'] as const) {
      assertEquals((await rw.search('civet logbook', mode, {})).map((r) => r.memory.id), [src.id]);
    }
    assertEquals((await rw.findRelated(src.id, 5)).length, 0);
    assertEquals((await rw.listRecent(10)).map((m) => m.id), [src.id]);
    assertEquals((await rw.stats()).totalMemories, 1);
    await assertRejects(() => rw.findRelated(gone.id, 5), Error, `Memory ${gone.id} not found`);
  }));

Deno.test('tagsAll requires every tag, and combines with tags', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('okapi status', ['status:open', 'owner:me']));
    const b = await s.store(w.alpha.name, req('okapi status two', ['status:done', 'owner:me']));
    await s.store(w.alpha.name, req('okapi status three', ['status:open']));
    const ids = async (f: Parameters<PgMemoryStore['search']>[2]) =>
      (await s.search('okapi status', 'keyword', f)).map((r) => r.memory.id).sort();
    assertEquals(await ids({ tagsAll: ['status:open', 'owner:me'] }), [a.id]);
    assertEquals(await ids({ tags: ['status:open', 'status:done'], tagsAll: ['owner:me'] }), [a.id, b.id].sort());
    assertEquals(await ids({ tagsAll: ['owner:nobody'] }), []);
    assertEquals((await ids({ tagsAll: [] })).length, 3);
  }));

Deno.test('empty tags filter means no filter', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    await s.store(w.alpha.name, req('tapir notes', ['x']));
    await s.store(w.alpha.name, req('tapir notes two'));
    const none = await s.search('tapir', 'keyword', {});
    const empty = await s.search('tapir', 'keyword', { tags: [] });
    assertEquals(none.length, 2);
    assertEquals(empty.map((r) => r.memory.id).sort(), none.map((r) => r.memory.id).sort());
  }));

Deno.test('garbage date filters are rejected with a friendly error', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    await assertRejects(() => s.search('x', 'keyword', { after: 'garbage' }), Error, 'Invalid date filter');
    await assertRejects(() => s.search('x', 'keyword', { before: 'garbage' }), Error, 'Invalid date filter');
  }));

Deno.test('stats.belowPruneThreshold equals a default prune dry-run', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const olds = [await s.store(w.alpha.name, req('dormant one')), await s.store(w.alpha.name, req('dormant two'))];
    await s.store(w.alpha.name, req('fresh one'));
    const eg = await s.store(w.alpha.name, req('old but evergreen', ['evergreen']));
    for (const m of [...olds, eg]) await setUpdated(admin, m.id, '200 days');
    const dry = await s.prune({ scope: w.alpha.name, dryRun: true });
    assertEquals(dry.candidates.length, 2);
    assertEquals((await s.stats()).belowPruneThreshold, dry.candidates.length);
  }));

Deno.test('stats and prune agree when decay is disabled', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id, 0);
    const a = await s.store(w.alpha.name, req('recent accessed one'));
    await s.store(w.alpha.name, req('recent two'));
    await s.store(w.alpha.name, req('recent evergreen', ['evergreen']));
    const dormant = await s.store(w.alpha.name, req('old never accessed'));
    const oldEvergreen = await s.store(w.alpha.name, req('old evergreen', ['evergreen']));
    await admin`update agent_memory.memories set access_count = 5, last_accessed_at = now() where id = ${a.id}`;
    for (const m of [dormant, oldEvergreen]) await setUpdated(admin, m.id, '200 days');
    const dry = await s.prune({ scope: w.alpha.name, dryRun: true });
    // Decay disabled: only the dormant rule applies (never accessed and older than 90 days), and stats agrees.
    assertEquals(dry.candidates.map((c) => c.id), [dormant.id]);
    assertStringIncludes(dry.candidates[0].reason, 'never accessed');
    assertEquals((await s.stats()).belowPruneThreshold, 1);
  }));

Deno.test('limits above 100 are rejected on every read; 100 is accepted', () =>
  withWorld(async (w, _a, mk) => {
    const [s, e] = mk(w.rw.id);
    const src = await s.store(w.alpha.name, req('okapi field notes'));
    const calls = e.calls;
    const msg = 'limit must be between 1 and 100';
    await assertRejects(() => s.search('okapi', 'hybrid', { limit: 101 }), Error, msg);
    assertEquals(e.calls, calls);
    await assertRejects(() => s.search('okapi', 'keyword', { limit: 2.5 }), Error, msg);
    await assertRejects(() => s.findRelated(src.id, 101), Error, msg);
    await assertRejects(() => s.listRecent(101), Error, msg);
    assertEquals((await s.search('okapi', 'keyword', { limit: 100 })).length, 1);
    assertEquals((await s.findRelated(src.id, 100)).length, 0);
    assertEquals((await s.listRecent(100)).length, 1);
  }));

Deno.test('decay disabled: a recent memory is not a prune candidate', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id, 0);
    await s.store(w.alpha.name, req('brand new, never accessed'));
    const dry = await s.prune({ scope: w.alpha.name, dryRun: true });
    assertEquals(dry.candidates, []);
    assertEquals((await s.stats()).belowPruneThreshold, 0);
  }));

Deno.test('search results carry session labels', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const [{ id: sid }] = await admin`
      insert into agent_memory.agent_sessions (member_id, label) values (${w.rw.id}, 'read-sess') returning id`;
    const m = await s.store(w.alpha.name, req('quokkaflux labelled memory'), { session: sid });
    await s.store(w.alpha.name, req('quokkaflux unlabelled sibling'));
    const r = await s.search('quokkaflux', 'keyword', {});
    const hit = r.find((x) => x.memory.id === m.id)!;
    assertEquals(hit.memory.createdSession, 'read-sess');
    const bare = r.find((x) => x.memory.id !== m.id)!;
    assertEquals('createdSession' in bare.memory, false);
    const rel = await s.findRelated(m.id, 5);
    assert(rel.length > 0);
    const recent = await s.listRecent(10);
    assertEquals(recent.find((x) => x.id === m.id)!.createdSession, 'read-sess');
  }));
