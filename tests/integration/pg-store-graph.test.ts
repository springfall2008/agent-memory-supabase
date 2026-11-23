import { assertEquals, assertRejects } from '@std/assert';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { PgMemoryStore } from '../../supabase/functions/_shared/pg-store.ts';
import { adminSql, LOCAL_DB_URL, makeWorld, type World } from '../helpers/fixtures.ts';
import { FakeEmbedder } from '../helpers/fake-embedder.ts';

type Admin = ReturnType<typeof adminSql>;

async function withWorld(fn: (w: World, admin: Admin, mk: (memberId: string) => PgMemoryStore) => Promise<void>) {
  const admin = adminSql();
  const sql = connect(LOCAL_DB_URL);
  const w = await makeWorld(admin);
  try {
    await fn(w, admin, (id) => new PgMemoryStore(sql, id, new FakeEmbedder(), 30));
  } finally {
    await w.cleanup();
    await sql.end();
    await admin.end();
  }
}

const req = (content: string, tags: string[]) => ({ content, category: 'other' as const, tags });
const freshTag = () => `cairn:${crypto.randomUUID().slice(0, 8)}`;

/** Inserts n memories directly (no embedding call), oldest first, all tagged tag. */
async function bulk(admin: Admin, w: World, tag: string, n: number, content = (i: number) => `bulk ${i}`) {
  for (let i = 0; i < n; i++) {
    await admin`
      insert into agent_memory.memories (scope_id, content, category, tags, created_by, updated_by, embedding, created_at)
      values (${w.alpha.id}, ${content(i)}, 'other', ${[tag]}::text[], ${w.rw.id}, ${w.rw.id},
              array_fill(0.1::real, array[384])::extensions.vector, now() - make_interval(secs => ${n - i}))`;
  }
}

Deno.test('graph returns matching nodes oldest first with every link among them', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const tag = freshTag();
    const origin = await s.store(w.alpha.name, req('origin', [tag, 'kind:origin']));
    const intent = await s.store(w.alpha.name, req('intent', [tag, 'kind:intent']));
    const fact = await s.store(w.alpha.name, req('fact', [tag, 'kind:fact']));
    const hint = await s.store(w.alpha.name, req('hint', [tag, 'kind:hint']));
    const stray = await s.store(w.alpha.name, req('not in the project', []));
    await s.relate(intent.id, origin.id, 'depends-on');
    await s.relate(fact.id, intent.id, 'derived-from');
    await s.relate(hint.id, intent.id, 'relates-to');
    await s.relate(stray.id, origin.id, 'relates-to');
    const g = await s.graph({ tags: [tag] });
    assertEquals(g.nodes.map((n) => n.id), [origin.id, intent.id, fact.id, hint.id]);
    assertEquals([g.total, g.truncated], [4, false]);
    const key = (e: { from: string; to: string; type: string }) => `${e.from}>${e.to}:${e.type}`;
    assertEquals(
      g.edges.map(key).sort(),
      [
        key({ from: intent.id, to: origin.id, type: 'depends-on' }),
        key({ from: fact.id, to: intent.id, type: 'derived-from' }),
        key({ from: hint.id, to: intent.id, type: 'relates-to' }),
      ].sort(),
    );
    const n = g.nodes[1];
    assertEquals([n.scope, n.category, n.snippet, n.content], [w.alpha.name, 'other', 'intent', undefined]);
    assertEquals(n.tags.includes('kind:intent'), true);
    assertEquals(typeof n.createdAt, 'string');
  }));

Deno.test('graph short gives 160-character snippets; full gives content and caps at 100', () =>
  withWorld(async (w, admin, mk) => {
    const s = mk(w.rw.id);
    const tag = freshTag();
    await bulk(admin, w, tag, 101, (i) => `${i} ${'x'.repeat(300)}`);
    const short = await s.graph({ tagsAll: [tag] });
    assertEquals([short.nodes.length, short.total, short.truncated], [101, 101, false]);
    assertEquals(short.nodes[0].snippet, `0 ${'x'.repeat(158)}…`);
    assertEquals(short.nodes[0].content, undefined);
    const full = await s.graph({ tagsAll: [tag], detail: 'full' });
    assertEquals([full.nodes.length, full.total, full.truncated], [100, 101, true]);
    assertEquals(full.nodes[0].content, `0 ${'x'.repeat(300)}`);
    assertEquals(full.nodes[0].snippet, undefined);
  }));

Deno.test('graph caps short detail at 400 nodes', () =>
  withWorld(async (w, admin, mk) => {
    const tag = freshTag();
    await bulk(admin, w, tag, 401);
    const g = await mk(w.rw.id).graph({ tags: [tag] });
    assertEquals([g.nodes.length, g.total, g.truncated], [400, 401, true]);
    assertEquals(g.nodes[0].snippet, 'bulk 0');
  }));

Deno.test('graph never shows a link to an unreadable or soft-deleted memory', () =>
  withWorld(async (w, admin, mk) => {
    const s = mk(w.rw.id);
    const tag = freshTag();
    const a = await s.store(w.alpha.name, req('a', [tag]));
    const b = await s.store(w.alpha.name, req('b', [tag]));
    const gone = await s.store(w.alpha.name, req('soon deleted', [tag]));
    const hidden = await mk(w.bw.id).store(w.beta.name, req('in beta, tagged the same', [tag]));
    await s.relate(b.id, a.id, 'depends-on');
    await s.relate(gone.id, a.id, 'derived-from');
    await admin`insert into agent_memory.memory_links (from_id, to_id, type, created_by)
      values (${hidden.id}, ${a.id}, 'supersedes', ${w.bw.id})`;
    await s.delete(gone.id);
    const g = await s.graph({ tags: [tag] });
    assertEquals(g.nodes.map((n) => n.id), [a.id, b.id]);
    assertEquals(g.total, 2);
    assertEquals(g.edges, [{ from: b.id, to: a.id, type: 'depends-on' }]);
    assertEquals(g.nodes[0].superseded, undefined);
    const c = await s.store(w.alpha.name, req('c replaces b', [tag]));
    await s.relate(c.id, b.id, 'supersedes');
    const g2 = await s.graph({ tags: [tag] });
    assertEquals(g2.nodes.find((n) => n.id === b.id)?.superseded, true);
  }));

Deno.test('graph shows active claims, needs tags or tags_all, and does not bump access counts', () =>
  withWorld(async (w, admin, mk) => {
    const s = mk(w.rw.id);
    const tag = freshTag();
    const a = await s.store(w.alpha.name, req('claimed one', [tag]));
    await s.claim(a.id, 'working on it', {}, { sessionLabel: 'g-1' });
    await admin`update agent_memory.memories set updated_at = now() - interval '2 hours' where id = ${a.id}`;
    const g = await s.graph({ tags: [tag] });
    assertEquals([g.nodes[0].claim?.description, g.nodes[0].claim?.mine], ['working on it', true]);
    const [row] = await admin`select access_count from agent_memory.memories where id = ${a.id}`;
    assertEquals(row.access_count, 0);
    await assertRejects(() => s.graph({}), Error, 'Pass tags or tags_all');
    await assertRejects(() => s.graph({ tags: [] }), Error, 'Pass tags or tags_all');
  }));
