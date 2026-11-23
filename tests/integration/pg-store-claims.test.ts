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

Deno.test('a claim held by one session refuses another session of the same member', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const m = await rw.store(w.alpha.name, req('a ticket'));
    await rw.claim(m.id, 'first look', {}, { sessionLabel: 's-a' });
    await assertRejects(
      () => rw.claim(m.id, 'second look', {}, { sessionLabel: 's-b' }),
      Error,
      "is claimed by your session 's-a' until",
    );
    await assertRejects(() => rw.claim(m.id, 'no session', {}), Error, "is claimed by your session 's-a' until");
    const same = await rw.claim(m.id, 'third look', {}, { sessionLabel: 's-a' });
    assertEquals(same.overridden, undefined);
  }));

Deno.test('force over an own other session reports it', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const m = await rw.store(w.alpha.name, req('a ticket'));
    await rw.claim(m.id, 'first look', {}, { sessionLabel: 's-a' });
    const forced = await rw.claim(m.id, 'taking over', { force: true }, { sessionLabel: 's-b' });
    assertEquals(forced.overridden?.by, w.rw.name);
    assertEquals(forced.overridden?.session?.label, 's-a');
    assertEquals(typeof forced.overridden?.session?.id, 'string');
    assertEquals('previousSession' in forced, false);
  }));

Deno.test('another member forcing never sees the holder session', () =>
  withWorld(async (w, admin, mk) => {
    const { rw, bw } = await contenders(w, admin, mk);
    const m = await rw.store(w.alpha.name, req('a ticket'));
    await rw.claim(m.id, 'mine', {}, { sessionLabel: 's-a' });
    const forced = await bw.claim(m.id, 'taking over', { force: true });
    assertEquals(forced.overridden?.by, w.rw.name);
    assertEquals(forced.overridden?.session, undefined);
  }));

Deno.test('release with an unknown session label is Session not found and keeps the claim', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const m = await rw.store(w.alpha.name, req('a ticket'));
    await rw.claim(m.id, 'no session claim', {});
    await assertRejects(() => rw.release(m.id, false, { sessionLabel: 'never-made' }), Error, 'Session not found');
    assertEquals((await rw.myClaims()).map((c) => c.memory.id), [m.id]);
  }));

Deno.test('release by another session needs force; the holding session releases', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const m = await rw.store(w.alpha.name, req('a ticket'));
    const n = await rw.store(w.alpha.name, req('another ticket'));
    await rw.claim(m.id, 'first look', {}, { sessionLabel: 's-a' });
    await rw.claim(n.id, 'n look', {}, { sessionLabel: 's-b' });
    await assertRejects(
      () => rw.release(m.id, false, { sessionLabel: 's-b' }),
      Error,
      "claimed by your session 's-a' until",
    );
    await assertRejects(
      () => rw.release(m.id),
      Error,
      'release it from that session, or pass force to release it anyway',
    );
    assertEquals(await rw.release(m.id, true, { sessionLabel: 's-b' }), true);
    assertEquals(await rw.release(n.id, false, { sessionLabel: 's-b' }), true);
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

const intent = (content: string, extra: string[] = []) => ({
  content,
  category: 'other' as const,
  tags: ['kind:intent', 'status:open', ...extra],
});

Deno.test('claimNext returns the oldest free match with its links and claim', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const tag = `q-${crypto.randomUUID().slice(0, 8)}`;
    const a = await rw.store(w.alpha.name, intent('first intent', [tag]));
    const b = await rw.store(w.alpha.name, intent('second intent', [tag]));
    await rw.relate(b.id, a.id, 'depends-on');
    const first = await rw.claimNext({ tagsAll: [tag] }, 'exploring', {}, { sessionLabel: 'worker-1' });
    if (!first.claimed) throw new Error('expected a claim');
    assertEquals(first.memory.id, a.id);
    assertEquals(first.memory.content, 'first intent');
    assertEquals(first.memory.claim?.mine, true);
    assertEquals(first.memory.links?.[0]?.memoryId, b.id);
    assertEquals(Math.round(minutesAhead(first.until)!), 60);
    const second = await rw.claimNext({ tags: [tag] }, 'exploring', { indefinite: true }, { sessionLabel: 'worker-1' });
    if (!second.claimed) throw new Error('expected a claim');
    assertEquals([second.memory.id, second.until], [b.id, null]);
    assertEquals(await rw.claimNext({ tags: [tag] }, 'exploring', {}), { claimed: false });
  }));

Deno.test('claimNext with a new session label creates the session', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const tag = `q-${crypto.randomUUID().slice(0, 8)}`;
    await rw.store(w.alpha.name, intent('only intent', [tag]));
    await rw.claimNext({ tags: [tag] }, 'exploring', {}, { sessionLabel: 'brand-new-worker' });
    assertEquals((await rw.myClaims())[0].session?.label, 'brand-new-worker');
  }));

Deno.test('claimNext validates its arguments', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    await assertRejects(() => rw.claimNext({}, 'x', {}), Error, 'Pass tags or tags_all');
    await assertRejects(() => rw.claimNext({ tags: ['t'] }, ' ', {}), Error, 'Description must be 1-200 characters');
    await assertRejects(
      () => rw.claimNext({ tags: ['t'] }, 'x', { minutes: 5, indefinite: true }),
      Error,
      'Pass minutes or indefinite, not both',
    );
    await assertRejects(() => rw.claimNext({ tags: ['t'], scopes: ['no-such-scope'] }, 'x', {}), Error, 'not found');
  }));

Deno.test('claimNext does not wait for, or take, a memory another caller is claiming', () =>
  withWorld(async (w, admin, mk) => {
    const { bw } = await contenders(w, admin, mk);
    const [rw] = mk(w.rw.id);
    const tag = `q-${crypto.randomUUID().slice(0, 8)}`;
    const a = await rw.store(w.alpha.name, intent('first', [tag]));
    const b = await rw.store(w.alpha.name, intent('second', [tag]));
    const other = connect(LOCAL_DB_URL);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let claimed!: () => void;
      const claimedFirst = new Promise<void>((r) => (claimed = r));
      const held = withMember(other, w.rw.id, async (tx) => {
        const [r] = await tx`select * from agent_memory.claim_next(null, null, ${[
          tag,
        ]}::text[], null, 'A', 60, false, null)`;
        assertEquals(r.memory_id, a.id);
        claimed();
        await gate;
      });
      await claimedFirst;
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('claimNext waited')), 5000));
      const got = await Promise.race([bw.claimNext({ tags: [tag] }, 'B', {}), timeout]);
      release();
      await held;
      if (!got.claimed) throw new Error('expected a claim');
      assertEquals(got.memory.id, b.id);
    } finally {
      await other.end();
    }
  }));

Deno.test('claim_memory waits for claimNext and is then refused', () =>
  withWorld(async (w, admin, mk) => {
    const { bw } = await contenders(w, admin, mk);
    const [rw] = mk(w.rw.id);
    const tag = `q-${crypto.randomUUID().slice(0, 8)}`;
    const a = await rw.store(w.alpha.name, intent('contended', [tag]));
    const other = connect(LOCAL_DB_URL);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let claimed!: () => void;
      const claimedFirst = new Promise<void>((r) => (claimed = r));
      const held = withMember(other, w.rw.id, async (tx) => {
        await tx`select * from agent_memory.claim_next(null, null, ${[tag]}::text[], null, 'A', 60, false, null)`;
        claimed();
        await gate;
      });
      await claimedFirst;
      const b = bw.claim(a.id, 'B', {}).then(() => 'claimed', (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 500));
      release();
      await held;
      assertStringIncludes(await b, `is claimed by ${w.rw.name}`);
    } finally {
      await other.end();
    }
  }));
