import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { connect, withMember } from '../../supabase/functions/_shared/db.ts';
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

const req = (content: string) => ({ content, category: 'other' as const, tags: [] as string[] });
const minutesAhead = (iso: string | null) => iso === null ? null : (Date.parse(iso) - Date.now()) / 60_000;

/** rw writes alpha; bw is granted write on alpha too, so two members can contend for one memory. */
async function contenders(w: World, admin: Admin, mk: Parameters<Parameters<typeof withWorld>[0]>[2]) {
  await admin`insert into agent_memory.scope_grants (scope_id, member_id, access)
    values (${w.alpha.id}, ${w.bw.id}, 'write')`;
  const [rw] = mk(w.rw.id);
  const [bw] = mk(w.bw.id);
  return { rw, bw };
}

Deno.test('claim then a second member is refused, and force takes over', () =>
  withWorld(async (w, admin, mk) => {
    const { rw, bw } = await contenders(w, admin, mk);
    const m = await rw.store(w.alpha.name, req('the parser rewrite'));
    const first = await rw.claim(m.id, 'rewriting the parser', {});
    assertEquals(first.claimed, true);
    await assertRejects(() => bw.claim(m.id, 'me too', {}), Error, `is claimed by ${w.rw.name} until`);
    const forced = await bw.claim(m.id, 'taking over', { force: true });
    assertEquals(forced.overridden?.by, w.rw.name);
    assertEquals(forced.overridden?.description, 'rewriting the parser');
    await assertRejects(() => rw.claim(m.id, 'back again', {}), Error, `is claimed by ${w.bw.name} until`);
  }));

Deno.test('renewal from another session reports previousSession', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const m = await rw.store(w.alpha.name, req('a ticket'));
    await rw.claim(m.id, 'first look', {}, { sessionLabel: 's-a' });
    const again = await rw.claim(m.id, 'second look', {}, { sessionLabel: 's-b' });
    assertEquals(again.previousSession?.label, 's-a');
    assertEquals(typeof again.previousSession?.id, 'string');
    const same = await rw.claim(m.id, 'third look', {}, { sessionLabel: 's-b' });
    assertEquals(same.previousSession, undefined);
  }));

Deno.test('minutes defaults to 60 and indefinite has no end', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const a = await rw.store(w.alpha.name, req('one'));
    const b = await rw.store(w.alpha.name, req('two'));
    const c = await rw.store(w.alpha.name, req('three'));
    const ahead = minutesAhead((await rw.claim(a.id, 'default', {})).until)!;
    assertEquals(Math.round(ahead), 60);
    assertEquals((await rw.claim(b.id, 'on a break', { indefinite: true })).until, null);
    assertEquals(Math.round(minutesAhead((await rw.claim(c.id, 'a week', { minutes: 10080 })).until)!), 10080);
  }));

Deno.test('claim arguments are validated', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const m = await rw.store(w.alpha.name, req('one'));
    await assertRejects(
      () => rw.claim(m.id, 'x', { minutes: 5, indefinite: true }),
      Error,
      'Pass minutes or indefinite, not both',
    );
    await assertRejects(() => rw.claim(m.id, 'x'.repeat(201), {}), Error, 'Description must be 1-200 characters');
    await assertRejects(() => rw.claim(m.id, '   ', {}), Error, 'Description must be 1-200 characters');
    await assertRejects(() => rw.claim(m.id, 'x', { minutes: 0 }), Error, 'minutes must be between 1 and 5256000');
  }));

Deno.test('absent and unreadable ids give the same error', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const [none] = mk(w.none.id);
    const m = await rw.store(w.alpha.name, req('one'));
    await assertRejects(() => none.claim(m.id, 'x', {}), Error, `Memory ${m.id} not found`);
    const ghost = crypto.randomUUID();
    await assertRejects(() => rw.claim(ghost, 'x', {}), Error, `Memory ${ghost} not found`);
    await assertRejects(() => rw.claim('x', 'x', {}), Error, 'Memory x not found');
    await assertRejects(() => rw.release('x'), Error, 'Memory x not found');
  }));

Deno.test('release rules', () =>
  withWorld(async (w, admin, mk) => {
    const { rw, bw } = await contenders(w, admin, mk);
    const m = await rw.store(w.alpha.name, req('one'));
    await rw.claim(m.id, 'mine', {});
    await assertRejects(() => bw.release(m.id), Error, 'pass force to release');
    assertEquals(await rw.release(m.id), true);
    assertEquals(await rw.release(m.id), false);
    await rw.claim(m.id, 'mine again', {});
    assertEquals(await bw.release(m.id, true), true);
  }));

Deno.test('myClaims lists only my active claims, soonest first, indefinite last, with a snippet', () =>
  withWorld(async (w, admin, mk) => {
    const { rw, bw } = await contenders(w, admin, mk);
    const a = await rw.store(w.alpha.name, req('a'.repeat(300)));
    const b = await rw.store(w.alpha.name, req('indefinite one'));
    const c = await rw.store(w.alpha.name, req('hour one'));
    const theirs = await bw.store(w.alpha.name, req('not mine'));
    await rw.claim(a.id, 'soon', { minutes: 10 }, { sessionLabel: 's-a' });
    await rw.claim(b.id, 'whenever', { indefinite: true });
    await rw.claim(c.id, 'in an hour', { minutes: 60 });
    await bw.claim(theirs.id, 'theirs', {});
    const mine = await rw.myClaims();
    assertEquals(mine.map((x) => x.memory.id), [a.id, c.id, b.id]);
    assertEquals(mine[0].session?.label, 's-a');
    assertEquals(mine[0].memory.snippet, 'a'.repeat(160) + '…');
    assertEquals('content' in mine[0].memory, false);
    assertEquals(mine[2].until, null);
    assertEquals(mine[1].session, undefined);
    assertEquals(await rw.myClaims([w.beta.name]).catch((e) => e.message), `Scope '${w.beta.name}' not found`);
  }));

Deno.test('two concurrent claims on one memory: exactly one wins', () =>
  withWorld(async (w, admin, mk) => {
    const { rw, bw } = await contenders(w, admin, mk);
    const m = await rw.store(w.alpha.name, req('contended'));
    const other = connect(LOCAL_DB_URL);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let claimed!: () => void;
      const claimedFirst = new Promise<void>((r) => (claimed = r));
      // Transaction A (rw) claims and stays open, so B (bw) cannot see the claim yet.
      const a = withMember(other, w.rw.id, async (tx) => {
        await tx`select * from agent_memory.claim_memory(${m.id}::uuid, 'A', 60, false, false, null)`;
        claimed();
        await gate;
      });
      await claimedFirst;
      const b = bw.claim(m.id, 'B', {}).then(() => 'claimed', (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 500));
      release();
      await a;
      assertStringIncludes(await b, `is claimed by ${w.rw.name}`);
    } finally {
      await other.end();
    }
  }));

const pick = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((m) => m.id === id);
  if (!found) throw new Error(`memory ${id} missing from results`);
  return found;
};

Deno.test('search, browse, findRelated, listRecent and neighbours carry the claim', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const a = await rw.store(w.alpha.name, req('quokka field notes claimed'));
    const b = await rw.store(w.alpha.name, req('quokka field notes free'));
    await rw.claim(a.id, 'working on it', {});
    await rw.relate(b.id, a.id, 'relates-to');
    const lists = {
      search: (await rw.search('quokka', 'keyword', {})).map((r) => r.memory),
      browse: (await rw.browse({})).memories,
      findRelated: (await rw.findRelated(b.id, 5)).map((r) => r.memory),
      listRecent: await rw.listRecent(10),
      neighbours: (await rw.neighbours(b.id, {})).neighbours.map((n) => n.memory),
    };
    for (const [name, list] of Object.entries(lists)) {
      const claimed = pick(list, a.id);
      assertEquals(claimed.claim?.by, w.rw.name, `${name}: holder`);
      assertEquals(claimed.claim?.description, 'working on it', `${name}: description`);
      assertEquals(Math.round((Date.parse(claimed.claim!.until!) - Date.now()) / 60_000), 60, `${name}: until`);
      if (name !== 'findRelated' && name !== 'neighbours') {
        assertEquals('claim' in pick(list, b.id), false, `${name}: an unclaimed memory has no claim key`);
      }
    }
  }));

Deno.test('the holder sees mine and the session; another member sees neither', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const [ro] = mk(w.ro.id);
    const a = await rw.store(w.alpha.name, req('a claimed note'));
    await rw.claim(a.id, 'mine', { indefinite: true }, { sessionLabel: 's-a' });
    const own = pick(await rw.listRecent(10), a.id).claim!;
    assertEquals(own.mine, true);
    assertEquals(own.session?.label, 's-a');
    assertEquals(own.until, null);
    const seen = pick(await ro.listRecent(10), a.id).claim!;
    assertEquals(seen.by, w.rw.name);
    assertEquals('mine' in seen, false);
    assertEquals('session' in seen, false);
  }));

Deno.test('an expired claim is not shown', () =>
  withWorld(async (w, admin, mk) => {
    const [rw] = mk(w.rw.id);
    const a = await rw.store(w.alpha.name, req('an old claim'));
    await rw.claim(a.id, 'stale', {});
    await admin`update agent_memory.memory_claims
      set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where memory_id = ${a.id}`;
    assertEquals('claim' in pick(await rw.listRecent(10), a.id), false);
    assertEquals(await rw.myClaims(), []);
  }));
