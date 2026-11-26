import { assertEquals } from '@std/assert';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { PgMemoryStore } from '../../supabase/functions/_shared/pg-store.ts';
import { routeWebApi } from '../../supabase/functions/_shared/web-api.ts';
import { adminSql, LOCAL_DB_URL, makeWorld, type World } from '../helpers/fixtures.ts';
import { FakeEmbedder } from '../helpers/fake-embedder.ts';

type Admin = ReturnType<typeof adminSql>;
// deno-lint-ignore no-explicit-any
type Call = (memberId: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** A GET without a body; a JSON POST with one. */
async function withWorld(fn: (w: World, admin: Admin, call: Call) => Promise<void>) {
  const admin = adminSql();
  const sql = connect(LOCAL_DB_URL);
  const w = await makeWorld(admin);
  const call: Call = async (memberId, path, body) => {
    const store = new PgMemoryStore(sql, memberId, new FakeEmbedder(), 30);
    const init: RequestInit = body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const r = await routeWebApi(new Request(`http://x/functions/v1/web-api${path}`, init), store);
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

// ── Write routes ───────────────────────────────────────────────────

const GOAL_TEXT = 'Goal: g\nDone when: d\nMax open intents: 2\nMax intents: 5\nClaim minutes: 30';

/** A fresh board in alpha: goal, progress at round 2, one fact. */
async function seedBoard(admin: Admin, w: World, state = 'running') {
  const board = `toy-${fresh()}`;
  const goal = await seed(admin, w, GOAL_TEXT, [`board:${board}`, 'kind:goal', `state:${state}`, 'evergreen']);
  await seed(admin, w, 'Progress for board x.\nRound: 2\nLast round at: never', [
    `board:${board}`,
    'kind:progress',
    'evergreen',
  ]);
  const fact = await seed(admin, w, 'Fact: it works', [
    `board:${board}`,
    'kind:fact',
    'verdict:confirmed',
    'evergreen',
  ]);
  return { board, goal, fact };
}

const boardRows = (admin: Admin, board: string) =>
  admin`select id from agent_memory.memories where tags @> ${[`board:${board}`]}::text[]`;

Deno.test('rw adds a hint and an intent that read back with the skill content, tags and links', () =>
  withWorld(async (w, admin, call) => {
    const { board, fact } = await seedBoard(admin, w);
    const hint = await call(w.rw.id, '/hints', { scope: w.alpha.name, board, text: 'look\nhere', about: fact });
    assertEquals(hint.status, 201);
    const h = await call(w.rw.id, `/memories/${hint.body.memory.id}`);
    assertEquals(h.body.memory.content, `Hint: look here\nFrom: ${w.rw.name}`);
    assertEquals(h.body.memory.tags, [`board:${board}`, 'kind:hint', 'evergreen']);
    assertEquals(h.body.memory.category, 'observation');
    assertEquals(h.body.memory.scope, w.alpha.name);
    assertEquals(h.body.memory.links, [{ type: 'relates-to', direction: 'both', memoryId: fact }]);

    const intent = await call(w.rw.id, '/intents', {
      scope: w.alpha.name,
      board,
      text: 'try it',
      produce: 'a number',
      from: fact,
    });
    assertEquals(intent.status, 201);
    const i = await call(w.rw.id, `/memories/${intent.body.memory.id}`);
    assertEquals(
      i.body.memory.content,
      `Intent: try it\nWhy: added by ${w.rw.name} from the web UI; building on fact ${fact}\n` +
        "Produce: a number\nGive up when: it cannot be done within the board's rules; record an inconclusive fact",
    );
    assertEquals(i.body.memory.tags, [`board:${board}`, 'kind:intent', 'state:open', 'round:2', 'evergreen']);
    assertEquals(i.body.memory.links, [{ type: 'derived-from', direction: 'out', memoryId: fact }]);
    assertEquals(i.body.memory.createdBy, w.rw.name);
  }));

Deno.test('rw adds an amendment linked depends-on the goal; a done board refuses it', () =>
  withWorld(async (w, admin, call) => {
    const { board, goal } = await seedBoard(admin, w);
    const a = await call(w.rw.id, '/amendments', { scope: w.alpha.name, board, text: '15% is\nenough' });
    assertEquals(a.status, 201);
    const m = await call(w.rw.id, `/memories/${a.body.memory.id}`);
    assertEquals(m.body.memory.content, `Amendment: 15% is enough\nFrom: ${w.rw.name}`);
    assertEquals(m.body.memory.tags, [`board:${board}`, 'kind:amendment', 'evergreen']);
    assertEquals(m.body.memory.category, 'observation');
    assertEquals(m.body.memory.links, [{ type: 'depends-on', direction: 'out', memoryId: goal }]);

    await admin`update agent_memory.memories set tags = array_replace(tags, 'state:running', 'state:done')
      where id = ${goal}`;
    const done = await call(w.rw.id, '/amendments', { scope: w.alpha.name, board, text: 'x' });
    assertEquals(done.status, 409);
    assertEquals(done.body, { error: 'Board is done' });
  }));

Deno.test('ro gets the store write error and nothing is written', () =>
  withWorld(async (w, admin, call) => {
    const { board, goal } = await seedBoard(admin, w);
    const noWrite = { error: `No write access to scope '${w.alpha.name}'` };
    const hint = await call(w.ro.id, '/hints', { scope: w.alpha.name, board, text: 'x' });
    assertEquals(hint.status, 400);
    assertEquals(hint.body, noWrite);
    const intent = await call(w.ro.id, '/intents', { scope: w.alpha.name, board, text: 'x' });
    assertEquals(intent.body, noWrite);
    const amend = await call(w.ro.id, '/amendments', { scope: w.alpha.name, board, text: 'x' });
    assertEquals(amend.body, noWrite);
    const control = await call(w.ro.id, '/boards/control', { scope: w.alpha.name, board, action: 'pause' });
    assertEquals(control.status, 400);
    assertEquals(control.body, noWrite);
    assertEquals((await boardRows(admin, board)).length, 3);
    const [g] = await admin`select tags from agent_memory.memories where id = ${goal}`;
    assertEquals(g.tags.includes('state:running'), true);
  }));

Deno.test('none gets the same 404 as a board that does not exist', () =>
  withWorld(async (w, admin, call) => {
    const { board } = await seedBoard(admin, w);
    const absent = `toy-${fresh()}`;
    for (
      const [path, extra] of [['/hints', { text: 'x' }], ['/intents', { text: 'x' }], ['/boards/control', {
        action: 'stop',
      }]] as const
    ) {
      const hidden = await call(w.none.id, path, { scope: w.alpha.name, board, ...extra });
      const gone = await call(w.rw.id, path, { scope: w.alpha.name, board: absent, ...extra });
      const noScope = await call(w.none.id, path, { scope: `nope-${fresh()}`, board, ...extra });
      assertEquals(hidden.status, 404);
      assertEquals(gone.status, 404);
      assertEquals(noScope.status, 404);
      assertEquals(hidden.body, { error: `Board ${board} not found` });
      assertEquals(noScope.body, hidden.body);
      assertEquals(gone.body.error.replace(absent, board), hidden.body.error);
    }
    assertEquals((await boardRows(admin, board)).length, 3);
  }));

Deno.test('an about memory on another board is the not-found 404', () =>
  withWorld(async (w, admin, call) => {
    const { board } = await seedBoard(admin, w);
    const other = await seedBoard(admin, w);
    const r = await call(w.rw.id, '/hints', { scope: w.alpha.name, board, text: 'x', about: other.fact });
    assertEquals(r.status, 404);
    assertEquals(r.body, { error: `Memory ${other.fact} not found` });
    assertEquals((await boardRows(admin, board)).length, 3);
  }));

Deno.test('pause, resume, stop and restart round-trip the goal tags; maxIntents rewrites its line', () =>
  withWorld(async (w, admin, call) => {
    const { board, goal } = await seedBoard(admin, w);
    const ctl = (body: Record<string, unknown>) =>
      call(w.rw.id, '/boards/control', { scope: w.alpha.name, board, ...body });
    const tags = (state: string) => [`board:${board}`, 'kind:goal', `state:${state}`, 'evergreen'];
    for (
      const [action, state] of [['pause', 'paused'], ['resume', 'running'], ['stop', 'stopped'], [
        'restart',
        'running',
      ]]
    ) {
      const r = await ctl({ action });
      assertEquals(r.status, 200, action);
      assertEquals(r.body.goal.id, goal);
      assertEquals(r.body.goal.tags, tags(state));
      const [row] = await admin`select tags from agent_memory.memories where id = ${goal}`;
      assertEquals(row.tags, tags(state));
    }
    const again = await ctl({ action: 'restart' });
    assertEquals(again.status, 409);
    assertEquals(again.body, { error: 'Board is running' });

    const limit = await ctl({ maxIntents: 9 });
    assertEquals(limit.status, 200);
    const [row] = await admin`select content, tags from agent_memory.memories where id = ${goal}`;
    assertEquals(row.content, GOAL_TEXT.replace('Max intents: 5', 'Max intents: 9'));
    assertEquals(row.tags, tags('running'));
  }));

Deno.test('raising the limit on a board stopped at its limit sets it running', () =>
  withWorld(async (w, admin, call) => {
    const { board, goal } = await seedBoard(admin, w, 'stopped');
    await seed(admin, w, 'Conclusion.\nStopped: intent limit (5)', [`board:${board}`, 'kind:conclusion', 'evergreen']);
    const r = await call(w.rw.id, '/boards/control', { scope: w.alpha.name, board, maxIntents: 'none' });
    assertEquals(r.status, 200);
    const [row] = await admin`select content, tags from agent_memory.memories where id = ${goal}`;
    assertEquals(row.content, GOAL_TEXT.replace('Max intents: 5', 'Max intents: none'));
    assertEquals(row.tags, [`board:${board}`, 'kind:goal', 'state:running', 'evergreen']);
  }));
