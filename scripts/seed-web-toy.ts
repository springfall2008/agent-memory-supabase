// Seeds a small blackboard, tagged board:toy-ui, for checking the web UI by eye. Local database only: it always uses
// the fixed local URL, never AGENT_MEMORY_DB_URL or .env.
//   deno run -A scripts/seed-web-toy.ts --seed <scope>              goal, rules, progress, two round:1 intents (one
//                                                                   claimed), a fact, a lead measurement fact
//                                                                   and a hint: 8 memories
//   deno run -A scripts/seed-web-toy.ts --seed <scope> --goal-only  the goal alone ("No intents yet.")
//   deno run -A scripts/seed-web-toy.ts --advance                   a live change: a refuted fact appears, intent 1 is
//                                                                   done, and a round:2 intent cites the first fact
//   deno run -A scripts/seed-web-toy.ts --clean                     delete every board:toy-ui memory, with links and claims
// The scope must exist and have a member with write access (the seeded rows are created by, and claimed for, that
// member).
import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import postgres from 'npm:postgres@3.4.5';
import { LOCAL_DB_URL } from '../tests/helpers/fixtures.ts';

const TAG = 'board:toy-ui';
const USAGE = `Usage (local database only):
  deno run -A scripts/seed-web-toy.ts --seed <scope> [--goal-only]
  deno run -A scripts/seed-web-toy.ts --advance
  deno run -A scripts/seed-web-toy.ts --clean`;
const VEC = `[${Array.from({ length: 384 }, (_, i) => Math.cos(i) / 10).join(',')}]`;

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

function fail(message: string): never {
  console.error(message);
  Deno.exit(2);
}

async function insert(tx: Tx, scopeId: string, member: string, content: string, tags: string[], ageMin: number) {
  const [r] = await tx`
    insert into agent_memory.memories (scope_id, content, category, tags, created_by, updated_by, embedding, created_at,
      updated_at)
    values (${scopeId}, ${content}, 'observation', ${[TAG, ...tags]}, ${member}, ${member}, ${VEC}::extensions.vector,
      now() - make_interval(mins => ${ageMin}), now() - make_interval(mins => ${ageMin}))
    returning id`;
  return r.id as string;
}

const link = (tx: Tx, from: string, to: string, type: string, member: string) =>
  tx`insert into agent_memory.memory_links (from_id, to_id, type, created_by) values (${from}, ${to}, ${type}, ${member})`;

async function seed(sql: Sql, scope: string, goalOnly: boolean): Promise<void> {
  const [s] = await sql`select id from agent_memory.scopes where name = ${scope}`;
  if (!s) fail(`Scope '${scope}' does not exist in the local database`);
  const [m] = await sql`
    select member_id from agent_memory.scope_grants where scope_id = ${s.id} and access = 'write' limit 1`;
  if (!m) fail(`Scope '${scope}' has no member with write access; grant one first`);
  const [{ n }] = await sql`select count(*)::int as n from agent_memory.memories where tags @> array[${TAG}]`;
  if (n > 0) fail(`${n} ${TAG} rows already exist; run --clean first`);
  const who = m.member_id as string;

  await sql.begin(async (tx) => {
    const goal = await insert(
      tx,
      s.id,
      who,
      'Goal: find the smallest toy number that passes the check\nMax intents: 5\nMax open intents: 2',
      ['kind:goal', 'state:running'],
      60,
    );
    if (goalOnly) return;
    const rules = await insert(tx, s.id, who, 'Rules for board toy-ui\nCheck: run the toy check', ['kind:rules'], 59);
    await link(tx, rules, goal, 'depends-on', who);
    const progress = await insert(
      tx,
      s.id,
      who,
      'Progress for board toy-ui\nRound: 2\nBest result: n = 7 passes the check',
      ['kind:progress'],
      58,
    );
    await link(tx, progress, goal, 'depends-on', who);
    const i1 = await insert(tx, s.id, who, 'Intent: measure whether n = 7 passes the check\nWhy: round 1', [
      'kind:intent',
      'state:open',
      'round:1',
    ], 50);
    const fact = await insert(
      tx,
      s.id,
      who,
      `Fact for intent ${i1}: n = 7 passes the check\nDid: ran the check twice\nFound: n = 7 passes, both times\nEvidence: ran it twice\nBy: board-toy-ui-ab12`,
      ['kind:fact', 'verdict:confirmed'],
      40,
    );
    await link(tx, fact, i1, 'derived-from', who);
    // The lead's measurement fact, created between the two intents.
    await insert(
      tx,
      s.id,
      who,
      'Fact for intent none: measurement of 7 passed\nEvidence: the check printed OK\nBy: board-toy-ui-lead-ef56',
      ['kind:fact', 'verdict:confirmed'],
      35,
    );
    const i2 = await insert(tx, s.id, who, 'Intent: try n = 5 with the faster parser\nWhy: the fact above', [
      'kind:intent',
      'state:open',
      'round:1',
    ], 30);
    await link(tx, i2, fact, 'derived-from', who);
    await tx`
      insert into agent_memory.memory_claims (memory_id, member_id, description, expires_at)
      values (${i2}, ${who}, 'Working on this for board toy-ui (label: board-toy-ui-cd34)', now() + interval '1 day')`;
    const hint = await insert(tx, s.id, who, 'Hint: the parser caches its config, so clear it between runs', [
      'kind:hint',
    ], 20);
    await link(tx, hint, i2, 'relates-to', who);
  });
  console.log(`Seeded ${goalOnly ? 'a goal-only' : 'a'} ${TAG} board into local scope '${scope}'`);
}

async function advance(sql: Sql): Promise<void> {
  const intents = await sql`
    select id, scope_id, created_by from agent_memory.memories
    where tags @> array[${TAG}, 'kind:intent'] and deleted_at is null order by created_at`;
  if (intents.length < 2) fail(`Seed a full ${TAG} board first`);
  if (intents.length > 2) fail(`The ${TAG} board was already advanced; run --clean and --seed first`);
  const [i1, i2] = intents;
  await sql.begin(async (tx) => {
    const fact = await insert(
      tx,
      i2.scope_id,
      i2.created_by,
      `Fact for intent ${i2.id}: n = 5 fails the check\nBy: board-toy-ui-cd34`,
      ['kind:fact', 'verdict:refuted'],
      0,
    );
    await link(tx, fact, i2.id, 'derived-from', i2.created_by);
    await tx`delete from agent_memory.memory_claims where memory_id = ${i2.id}`;
    await tx`
      update agent_memory.memories set tags = array_replace(tags, 'state:open', 'state:done'), updated_at = now()
      where id = ${i1.id}`;
    const [first] = await tx`
      select l.from_id from agent_memory.memory_links l
      where l.to_id = ${i1.id} and l.type = 'derived-from' limit 1`;
    const i3 = await insert(
      tx,
      i2.scope_id,
      i2.created_by,
      'Intent: check n = 6 under the same parser\nWhy: the first fact',
      ['kind:intent', 'state:open', 'round:2'],
      0,
    );
    if (first) await link(tx, i3, first.from_id, 'derived-from', i2.created_by);
  });
  console.log(
    'Added a refuted fact for intent 2, released its claim, marked intent 1 done, and added a round 2 intent',
  );
}

/** Deletes the seeded rows by the literal tag; links and claims cascade, then the history the trigger writes. */
async function clean(sql: Sql): Promise<void> {
  const gone = await sql`delete from agent_memory.memories where tags @> array['board:toy-ui'] returning id`;
  await sql`delete from agent_memory.memory_history where memory_id = any(${gone.map((r) => r.id)}::uuid[])`;
  console.log(`Deleted ${gone.length} ${TAG} memories from the local database`);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ['seed'], boolean: ['goal-only', 'advance', 'clean', 'help'] });
  const modes = [args.seed !== undefined, args.advance, args.clean].filter(Boolean).length;
  if (args.help || modes !== 1 || (args.seed !== undefined && args.seed === '')) {
    console.error(USAGE);
    Deno.exit(args.help ? 0 : 2);
  }
  const sql = postgres(LOCAL_DB_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    if (args.seed !== undefined) await seed(sql, args.seed, args['goal-only']);
    else if (args.advance) await advance(sql);
    else await clean(sql);
  } finally {
    await sql.end();
  }
}
