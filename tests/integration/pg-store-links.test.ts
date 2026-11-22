import { assert, assertEquals, assertRejects } from '@std/assert';
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

const pick = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((m) => m.id === id);
  if (!found) throw new Error(`memory ${id} missing from results`);
  return found;
};

Deno.test('search, browse, findRelated and listRecent all carry links and the superseded flag', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const old = await s.store(w.alpha.name, req('quokka field notes old'));
    const fresh = await s.store(w.alpha.name, req('quokka field notes new'));
    const other = await s.store(w.alpha.name, req('quokka field notes other'));
    await s.relate(fresh.id, old.id, 'supersedes');
    await s.relate(fresh.id, other.id, 'relates-to');

    const lists = {
      search: (await s.search('quokka', 'keyword', {})).map((r) => r.memory),
      browse: (await s.browse({})).memories,
      findRelated: (await s.findRelated(other.id, 5)).map((r) => r.memory),
      listRecent: await s.listRecent(10),
    };
    for (const [name, list] of Object.entries(lists)) {
      const o = pick(list, old.id);
      assertEquals(o.superseded, true, `${name}: old is flagged`);
      assertEquals(o.links, [{ type: 'supersedes', direction: 'in', memoryId: fresh.id }], `${name}: old links`);
      if (name !== 'findRelated') {
        const f = pick(list, fresh.id);
        assertEquals(f.superseded, undefined, `${name}: fresh is not flagged`);
        assertEquals(f.links, [
          { type: 'relates-to', direction: 'both', memoryId: other.id },
          { type: 'supersedes', direction: 'out', memoryId: old.id },
        ], `${name}: fresh links, newest first`);
      }
    }
  }));

Deno.test('a memory with 12 links shows 10 and moreLinks 2', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const hub = await s.store(w.alpha.name, req('hub memory'));
    for (let i = 0; i < 12; i++) {
      const t = await s.store(w.alpha.name, req(`spoke ${i}`));
      await s.relate(hub.id, t.id, 'depends-on');
    }
    const h = pick(await s.listRecent(50), hub.id);
    assertEquals(h.links?.length, 10);
    assertEquals(h.moreLinks, 2);
    assertEquals(h.superseded, undefined);
  }));

Deno.test('links the caller cannot see are not shown', () =>
  withWorld(async (w, admin, mk) => {
    await admin`insert into agent_memory.scope_grants (scope_id, member_id, access)
      values (${w.beta.id}, ${w.rw.id}, 'write')`;
    const [s] = mk(w.rw.id);
    const [ro] = mk(w.ro.id);
    const a = await s.store(w.alpha.name, req('alpha side'));
    const c = await s.store(w.beta.name, req('beta side'));
    await s.relate(a.id, c.id, 'supersedes');
    assertEquals(pick(await s.listRecent(10), a.id).links?.length, 1);
    const seen = pick(await ro.listRecent(10), a.id);
    assertEquals('links' in seen, false);
    assertEquals('superseded' in seen, false);
  }));

Deno.test('relates-to shows as both on both ends', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('first'));
    const b = await s.store(w.alpha.name, req('second'));
    await s.relate(a.id, b.id, 'relates-to');
    const all = await s.listRecent(10);
    assertEquals(pick(all, a.id).links, [{ type: 'relates-to', direction: 'both', memoryId: b.id }]);
    assertEquals(pick(all, b.id).links, [{ type: 'relates-to', direction: 'both', memoryId: a.id }]);
  }));

Deno.test('a result set of 20 memories gets each memory its own links', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const chain = [];
    for (let i = 0; i < 20; i++) chain.push(await s.store(w.alpha.name, req(`chain ${i}`)));
    for (let i = 0; i < 19; i++) await s.relate(chain[i].id, chain[i + 1].id, 'depends-on');
    const all = await s.listRecent(20);
    for (let i = 0; i < 20; i++) {
      const expected = [];
      if (i < 19) expected.push({ type: 'depends-on', direction: 'out', memoryId: chain[i + 1].id });
      if (i > 0) expected.push({ type: 'depends-on', direction: 'in', memoryId: chain[i - 1].id });
      const got = pick(all, chain[i].id).links ?? [];
      const key = (l: { direction: string }) => l.direction;
      assertEquals(
        [...got].sort((x, y) => key(x).localeCompare(key(y))),
        expected.sort((x, y) => key(x).localeCompare(key(y))),
      );
    }
  }));

Deno.test('soft-deleting the other end drops the link from results', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('keeps'));
    const b = await s.store(w.alpha.name, req('goes'));
    await s.relate(a.id, b.id, 'derived-from');
    assertEquals(pick(await s.listRecent(10), a.id).links?.length, 1);
    await s.delete(b.id);
    assertEquals('links' in pick(await s.listRecent(10), a.id), false);
  }));

Deno.test('neighbours stays fast on a densely linked graph', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    // 100 memories, every pair linked once (4950 links): a path-enumerating walk would build about a million rows
    await admin`insert into agent_memory.memories (scope_id, content, category, created_by, updated_by, embedding)
      select ${w.alpha.id}, 'dense ' || i, 'other', ${w.rw.id}, ${w.rw.id},
             array_fill(0.1::real, array[384])::extensions.vector from generate_series(1, 100) i`;
    await admin`insert into agent_memory.memory_links (from_id, to_id, type, created_by)
      select a.id, b.id, 'depends-on', ${w.rw.id} from agent_memory.memories a
      join agent_memory.memories b on a.id < b.id and b.scope_id = ${w.alpha.id}
      where a.scope_id = ${w.alpha.id}`;
    const [{ id }] = await admin`select id from agent_memory.memories where scope_id = ${w.alpha.id} limit 1`;
    const started = performance.now();
    const r = await s.neighbours(id, { depth: 3 });
    const ms = performance.now() - started;
    assertEquals(r.neighbours.length, 99);
    assertEquals(r.truncated, false);
    assert(ms < 1500, `neighbours took ${Math.round(ms)} ms`);
  }));

Deno.test('a hub keeps its superseded flag and true count when the supersedes link is beyond the first 10', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const [{ id: hub }] = await admin`insert into agent_memory.memories
      (scope_id, content, category, created_by, updated_by, embedding)
      values (${w.alpha.id}, 'zebracorn hub memory', 'other', ${w.rw.id}, ${w.rw.id},
              array_fill(0.1::real, array[384])::extensions.vector) returning id`;
    await admin`insert into agent_memory.memories (scope_id, content, category, created_by, updated_by, embedding)
      select ${w.alpha.id}, 'filler ' || i, 'other', ${w.rw.id}, ${w.rw.id},
             array_fill(0.1::real, array[384])::extensions.vector from generate_series(1, 150) i`;
    const fillers = await admin`select id, content from agent_memory.memories
      where scope_id = ${w.alpha.id} and content like 'filler %'`;
    for (const [i, f] of fillers.entries()) {
      // the oldest link (largest i) is the only supersedes link
      await admin`insert into agent_memory.memory_links (from_id, to_id, type, created_by, created_at)
        values (${f.id}, ${hub}, ${i === fillers.length - 1 ? 'supersedes' : 'depends-on'}, ${w.rw.id},
                now() - (${i} || ' minutes')::interval)`;
    }
    const found = (await s.search('zebracorn', 'keyword', {})).map((r) => r.memory);
    const h = pick(found, hub);
    assertEquals(h.links?.length, 10);
    assertEquals(h.moreLinks, 140);
    assertEquals(h.superseded, true);
  }));

Deno.test('neighbours results carry links and the superseded flag', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const a = await s.store(w.alpha.name, req('start here'));
    const b = await s.store(w.alpha.name, req('followed memory'));
    const c = await s.store(w.alpha.name, req('newer replacement'));
    await s.relate(a.id, b.id, 'relates-to');
    await s.relate(c.id, b.id, 'supersedes');
    const r = await s.neighbours(a.id, {});
    const reached = pick(r.neighbours.map((n) => n.memory), b.id);
    assertEquals(reached.superseded, true);
    assertEquals(reached.links?.length, 2);
  }));

Deno.test('neighbours follows several hops and filters by type and direction', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const [ma, mb, mc, md] = [
      await s.store(w.alpha.name, req('chain a')),
      await s.store(w.alpha.name, req('chain b')),
      await s.store(w.alpha.name, req('chain c')),
      await s.store(w.alpha.name, req('chain d')),
    ];
    await s.relate(ma.id, mb.id, 'depends-on');
    await s.relate(mb.id, mc.id, 'supersedes');
    await s.relate(mc.id, md.id, 'depends-on');

    const two = await s.neighbours(ma.id, { direction: 'out', depth: 2 });
    assertEquals(ids(two), [mb.id, mc.id]);
    assertEquals(two.neighbours[1].path.map((p) => [p.type, p.memoryId]), [
      ['depends-on', mb.id],
      ['supersedes', mc.id],
    ]);
    assertEquals(ids(await s.neighbours(ma.id, { direction: 'out', depth: 3 })), [mb.id, mc.id, md.id]);
    // the supersedes link in the middle blocks a depends-on-only walk
    assertEquals(ids(await s.neighbours(ma.id, { direction: 'out', depth: 3, types: ['depends-on'] })), [mb.id]);
    assertEquals(
      ids(await s.neighbours(ma.id, { direction: 'out', depth: 3, types: ['depends-on', 'supersedes'] })),
      [mb.id, mc.id, md.id],
    );
    // walking backwards from the end reaches the same chain, nearest first
    assertEquals(ids(await s.neighbours(md.id, { direction: 'in', depth: 2 })), [mc.id, mb.id]);
    assertEquals(ids(await s.neighbours(md.id, { direction: 'out', depth: 3 })), []);
  }));
