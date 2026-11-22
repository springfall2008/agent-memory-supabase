import { assertEquals, assertRejects } from '@std/assert';
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

const req = (content: string, tags: string[] = []) => ({ content, category: 'other' as const, tags });
const setUpdated = (admin: Admin, id: string, ago: string) =>
  admin`update agent_memory.memories set updated_at = now() - ${ago}::interval where id = ${id}`;
const ids = (r: { neighbours: { memory: { id: string } }[] }) => r.neighbours.map((n) => n.memory.id);

Deno.test('relate then neighbours finds the link both ways', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('link source'));
    const b = await s.store(w.alpha.name, req('link target'));
    await s.relate(a.id, b.id, 'depends-on');
    const out = await s.neighbours(a.id, { direction: 'out' });
    assertEquals(ids(out), [b.id]);
    assertEquals(out.truncated, false);
    assertEquals(out.neighbours[0].path, [{ type: 'depends-on', direction: 'out', memoryId: b.id }]);
    assertEquals(ids(await s.neighbours(b.id, { direction: 'in' })), [a.id]);
    assertEquals(ids(await s.neighbours(a.id, { direction: 'in' })), []);
  }));

Deno.test('relate refuses absent and unreadable ids with the same sentence', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const [none] = mk(w.none.id);
    const a = await s.store(w.alpha.name, req('one'));
    const b = await s.store(w.alpha.name, req('two'));
    await assertRejects(() => none.relate(a.id, b.id, 'relates-to'), Error, `Memory ${a.id} not found`);
    const ghost = crypto.randomUUID();
    await assertRejects(() => s.relate(a.id, ghost, 'relates-to'), Error, `Memory ${ghost} not found`);
    await assertRejects(() => s.relate('x', b.id, 'relates-to'), Error, 'Memory x not found');
    await assertRejects(() => s.relate(a.id, b.id, 'nope' as never), Error, "Invalid link type 'nope'");
  }));

Deno.test('relate enforces the permission rules through the store', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const [ro] = mk(w.ro.id);
    const a = await s.store(w.alpha.name, req('one'));
    const b = await s.store(w.alpha.name, req('two'));
    await assertRejects(() => ro.relate(a.id, b.id, 'relates-to'), Error, 'No write access to scope');
  }));

Deno.test('scopes limit the walk across scopes', () =>
  withWorld(async (w, admin, mk) => {
    await admin`insert into agent_memory.scope_grants (scope_id, member_id, access)
      values (${w.beta.id}, ${w.rw.id}, 'write')`;
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('alpha memory'));
    const c = await s.store(w.beta.name, req('beta memory'));
    await s.relate(a.id, c.id, 'derived-from');
    assertEquals(ids(await s.neighbours(a.id, {})), [c.id]);
    assertEquals(ids(await s.neighbours(a.id, { scopes: [w.alpha.name] })), []);
  }));

/** Stores `n + 1` memories and returns the first as the source and the rest as targets. */
async function fan(w: World, mk: Parameters<Parameters<typeof withWorld>[0]>[2], n: number) {
  const [s] = mk(w.rw.id);
  const all = [];
  for (let i = 0; i <= n; i++) all.push(await s.store(w.alpha.name, req(`fan memory ${i}`)));
  return { s, src: all[0], targets: all.slice(1) };
}
const linkAll = (admin: Admin, w: World, src: string, targets: { id: string }[]) =>
  admin`insert into agent_memory.memory_links (from_id, to_id, type, created_by)
    select ${src}, t, 'depends-on', ${w.rw.id} from unnest(${targets.map((t) => t.id)}::uuid[]) t`;

Deno.test('relating past 100 outgoing links is refused', () =>
  withWorld(async (w, admin, mk) => {
    const { s, src, targets } = await fan(w, mk, 101);
    await linkAll(admin, w, src.id, targets.slice(0, 100));
    await assertRejects(
      () => s.relate(src.id, targets[100].id, 'depends-on'),
      Error,
      'already has 100 outgoing links',
    );
    // an existing link repeated at the cap is still a no-op, and incoming links are not capped
    await s.relate(src.id, targets[0].id, 'depends-on');
    await s.relate(targets[100].id, src.id, 'depends-on');
  }));

Deno.test('neighbours validates and reports truncation', () =>
  withWorld(async (w, admin, mk) => {
    const { s, src, targets } = await fan(w, mk, 101);
    await assertRejects(() => s.neighbours(src.id, { depth: 4 }), Error, 'depth must be between 1 and 3');
    const ghost = crypto.randomUUID();
    await assertRejects(() => s.neighbours(ghost, {}), Error, `Memory ${ghost} not found`);
    await assertRejects(() => s.neighbours(src.id, { direction: 'up' as never }), Error, 'direction must be');
    await linkAll(admin, w, src.id, targets);
    const r = await s.neighbours(src.id, { direction: 'out' });
    assertEquals(r.neighbours.length, 100);
    assertEquals(r.truncated, true);
  }));

Deno.test('neighbours does not count as an access', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('left'));
    const b = await s.store(w.alpha.name, req('right'));
    await s.relate(a.id, b.id, 'relates-to');
    for (const m of [a, b]) await setUpdated(admin, m.id, '2 hours');
    await s.neighbours(a.id, {});
    const rows = await admin`select access_count from agent_memory.memories where id = any(${[a.id, b.id]}::uuid[])`;
    assertEquals(rows.map((r) => r.access_count), [0, 0]);
  }));

Deno.test('unrelate returns whether a link was removed', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('one'));
    const b = await s.store(w.alpha.name, req('two'));
    await s.relate(a.id, b.id, 'supersedes');
    assertEquals(await s.unrelate(a.id, b.id, 'supersedes'), true);
    assertEquals(await s.unrelate(a.id, b.id, 'supersedes'), false);
  }));
