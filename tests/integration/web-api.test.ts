import { assertEquals } from '@std/assert';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { PgMemoryStore } from '../../supabase/functions/_shared/pg-store.ts';
import { routeWebApi } from '../../supabase/functions/_shared/web-api.ts';
import { adminSql, LOCAL_DB_URL, makeWorld, type World } from '../helpers/fixtures.ts';
import { FakeEmbedder } from '../helpers/fake-embedder.ts';

type Admin = ReturnType<typeof adminSql>;
// deno-lint-ignore no-explicit-any
type Call = (memberId: string, path: string) => Promise<{ status: number; body: any }>;

async function withWorld(fn: (w: World, admin: Admin, call: Call) => Promise<void>) {
  const admin = adminSql();
  const sql = connect(LOCAL_DB_URL);
  const w = await makeWorld(admin);
  const call: Call = async (memberId, path) => {
    const store = new PgMemoryStore(sql, memberId, new FakeEmbedder(), 30);
    const r = await routeWebApi(new Request(`http://x/functions/v1/web-api${path}`), store);
    return { status: r.status, body: await r.json() };
  };
  try {
    await fn(w, admin, call);
  } finally {
    await w.cleanup();
    await sql.end();
    await admin.end();
  }
}

const fresh = () => crypto.randomUUID().slice(0, 8);

async function seed(admin: Admin, w: World, content: string, tags: string[]): Promise<string> {
  const [r] = await admin`
    insert into agent_memory.memories (scope_id, content, category, tags, created_by, updated_by, embedding)
    values (${w.alpha.id}, ${content}, 'other', ${tags}::text[], ${w.rw.id}, ${w.rw.id},
            array_fill(0.1::real, array[384])::extensions.vector)
    returning id`;
  return r.id as string;
}

Deno.test('rw and ro see alpha memories and graph; none sees empty lists', () =>
  withWorld(async (w, admin, call) => {
    const tag = `board:${fresh()}`;
    const id = await seed(admin, w, 'visible one', [tag]);
    for (const m of [w.rw, w.ro]) {
      const list = await call(m.id, `/memories?tags_all=${tag}`);
      assertEquals(list.status, 200);
      assertEquals(list.body.memories.map((x: { id: string }) => x.id), [id]);
      const g = await call(m.id, `/graph?tags_all=${tag}`);
      assertEquals(g.status, 200);
      assertEquals(g.body.nodes.map((x: { id: string }) => x.id), [id]);
    }
    const none = await call(w.none.id, `/memories?tags_all=${tag}`);
    assertEquals(none.body, { memories: [], hasMore: false });
    const g = await call(w.none.id, `/graph?tags_all=${tag}`);
    assertEquals(g.body.nodes, []);
    assertEquals(g.body.total, 0);
  }));

Deno.test('an unreadable memory reads the same as an absent one', () =>
  withWorld(async (w, admin, call) => {
    const id = await seed(admin, w, 'hidden', [`t:${fresh()}`]);
    const absent = '33333333-3333-4333-8333-333333333333';
    const hidden = await call(w.none.id, `/memories/${id}`);
    const gone = await call(w.none.id, `/memories/${absent}`);
    assertEquals(hidden.status, 404);
    assertEquals(hidden.status, gone.status);
    assertEquals(JSON.stringify(hidden.body).replaceAll(id, 'ID'), JSON.stringify(gone.body).replaceAll(absent, 'ID'));
    const ok = await call(w.ro.id, `/memories/${id}`);
    assertEquals(ok.status, 200);
    assertEquals(ok.body.memory.id, id);
  }));

Deno.test('/boards lists a running goal for a reader and not for none', () =>
  withWorld(async (w, admin, call) => {
    const board = fresh();
    const id = await seed(admin, w, 'goal', ['kind:goal', `board:${board}`, 'state:running']);
    const rw = await call(w.rw.id, '/boards');
    assertEquals(rw.status, 200);
    const hit = rw.body.boards.filter((b: { board: string }) => b.board === board);
    assertEquals(hit, [{ scope: w.alpha.name, board, state: 'running', goalId: id }]);
    const none = await call(w.none.id, '/boards');
    assertEquals(none.body.boards.filter((b: { board: string }) => b.board === board), []);
  }));

Deno.test('a ranked q leaves access_count at 0', () =>
  withWorld(async (w, admin, call) => {
    const word = `zebra${fresh()}`;
    const id = await seed(admin, w, `about ${word}`, [`t:${fresh()}`]);
    const r = await call(w.rw.id, `/memories?q=${word}`);
    assertEquals(r.status, 200);
    assertEquals(r.body.memories.map((x: { id: string }) => x.id), [id]);
    const [row] = await admin`select access_count from agent_memory.memories where id = ${id}`;
    assertEquals(row.access_count, 0);
  }));
