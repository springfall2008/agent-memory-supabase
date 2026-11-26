// Times the web UI's graph poll against a deployed or locally served web-api.
//   AGENT_MEMORY_TOKEN=amm_... deno run -A scripts/measure-web-graph.ts \
//     --url https://<ref>.supabase.co/functions/v1/web-api --tag board:<x> [--scope <s>] [--n 20]
// Sequential requests, one second apart. Wall time includes the network, so it is an upper bound on Edge Function
// CPU; the budget is about 1 s of CPU per request. The token is read from AGENT_MEMORY_TOKEN and never printed.
//
// Local-only helpers (the fixed local database, never AGENT_MEMORY_DB_URL or .env):
//   deno run -A scripts/measure-web-graph.ts --seed-local <scope>   400 memories tagged board:measure-web-graph
//   deno run -A scripts/measure-web-graph.ts --clean-local          delete them again, with their links
import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import postgres from 'npm:postgres@3.4.5';
import { LOCAL_DB_URL } from '../tests/helpers/fixtures.ts';

const SEED_COUNT = 400;
const USAGE = `Usage:
  AGENT_MEMORY_TOKEN=... deno run -A scripts/measure-web-graph.ts --url <web-api url> --tag board:<x> [--scope <s>] [--n 20]
  deno run -A scripts/measure-web-graph.ts --seed-local <scope>   (local database only; 400 memories, board:measure-web-graph)
  deno run -A scripts/measure-web-graph.ts --clean-local          (local database only)`;

function fail(message: string): never {
  console.error(message);
  Deno.exit(2);
}

/** Inserts SEED_COUNT memories into an existing scope of the local database, chained by derived-from links. */
async function seedLocal(scope: string): Promise<void> {
  const sql = postgres(LOCAL_DB_URL, { max: 1, prepare: false });
  try {
    const [s] = await sql`select id from agent_memory.scopes where name = ${scope}`;
    if (!s) fail(`Scope '${scope}' does not exist in the local database`);
    // links need a created_by member: use a member that can write the scope.
    const [m] = await sql`
      select member_id from agent_memory.scope_grants where scope_id = ${s.id} and access = 'write' limit 1`;
    if (!m) fail(`Scope '${scope}' has no member with write access; grant one first`);
    const [{ n }] = await sql`
      select count(*)::int as n from agent_memory.memories where tags @> array['board:measure-web-graph']`;
    if (n > 0) fail(`${n} seeded rows already exist; run --clean-local first`);

    const vec = `[${Array.from({ length: 384 }, (_, i) => Math.sin(i) / 10).join(',')}]`;
    await sql.begin(async (tx) => {
      await tx`
        insert into agent_memory.memories (scope_id, content, category, tags, created_by, updated_by, embedding)
        select ${s.id}, 'Measurement fact ' || g || ': a representative board memory of a few lines, long enough to '
            || 'resemble a real finding rather than a stub, repeated so the response size is realistic. '
            || 'Measurement fact ' || g || ' ends here.',
          'observation',
          array['board:measure-web-graph', 'kind:fact', 'seq:' || g],
          ${m.member_id}, ${m.member_id}, ${vec}::extensions.vector
        from generate_series(1, ${SEED_COUNT}) g`;
      // Chain each memory to the previous one, and tie every tenth to the first.
      await tx`
        insert into agent_memory.memory_links (from_id, to_id, type, created_by)
        select cur.id, prev.id, 'derived-from', ${m.member_id}
        from agent_memory.memories cur
        join agent_memory.memories prev
          on prev.tags @> array['board:measure-web-graph']
          and (prev.tags[3])::text = 'seq:' || ((substring(cur.tags[3] from 5))::int - 1)
        where cur.tags @> array['board:measure-web-graph']`;
      await tx`
        insert into agent_memory.memory_links (from_id, to_id, type, created_by)
        select cur.id, root.id, 'depends-on', ${m.member_id}
        from agent_memory.memories cur
        join agent_memory.memories root
          on root.tags @> array['board:measure-web-graph'] and root.tags[3] = 'seq:1'
        where cur.tags @> array['board:measure-web-graph']
          and (substring(cur.tags[3] from 5))::int % 10 = 0`;
    });
    const [c] = await sql`
      select (select count(*)::int from agent_memory.memories where tags @> array['board:measure-web-graph']) as memories,
        (select count(*)::int from agent_memory.memory_links l join agent_memory.memories x on x.id = l.from_id
          where x.tags @> array['board:measure-web-graph']) as links`;
    console.log(`Seeded ${c.memories} memories and ${c.links} links into local scope '${scope}'`);
  } finally {
    await sql.end();
  }
}

/** Deletes the seeded rows (literal tag), their links (cascade) and the history rows the delete trigger writes. */
async function cleanLocal(): Promise<void> {
  const sql = postgres(LOCAL_DB_URL, { max: 1, prepare: false });
  try {
    const gone = await sql`
      delete from agent_memory.memories where tags @> array['board:measure-web-graph'] returning id`;
    // The history trigger writes a 'purge' row on delete, so clear history after the memories.
    await sql`delete from agent_memory.memory_history where memory_id = any(${gone.map((r) => r.id)}::uuid[])`;
    console.log(`Deleted ${gone.length} seeded memories from the local database`);
  } finally {
    await sql.end();
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function measure(url: string, tag: string, scope: string | undefined, n: number): Promise<void> {
  const token = Deno.env.get('AGENT_MEMORY_TOKEN');
  if (!token) fail(`AGENT_MEMORY_TOKEN is not set.\n${USAGE}`);
  const target = new URL(url.replace(/\/+$/, '') + '/graph');
  target.searchParams.set('tags_all', tag);
  if (scope) target.searchParams.set('scope', scope);

  const times: number[] = [];
  let bytes = 0;
  let nodes = 0;
  let edges = 0;
  let truncated = false;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    const t0 = performance.now();
    const res = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
    const body = new Uint8Array(await res.arrayBuffer());
    times.push(performance.now() - t0);
    if (!res.ok) {
      // The body is an error object from web-api, never the token; still cap what we echo.
      fail(`GET /graph returned ${res.status}: ${new TextDecoder().decode(body).slice(0, 200)}`);
    }
    bytes = body.length;
    const g = JSON.parse(new TextDecoder().decode(body));
    nodes = g.nodes.length;
    edges = g.edges.length;
    truncated = g.truncated;
    total = g.total;
  }
  const sorted = [...times].sort((a, b) => a - b);
  const ms = (v: number) => `${v.toFixed(0)} ms`;
  console.log(`GET ${target.pathname}?tags_all=${tag}${scope ? `&scope=${scope}` : ''}  (${n} requests, 1 s apart)`);
  console.log(
    `nodes ${nodes} (total ${total}${truncated ? ', truncated' : ''}), edges ${edges}, response ${bytes} bytes`,
  );
  console.log(`first (cold) ${ms(times[0])}, p50 ${ms(percentile(sorted, 0.5))}, p95 ${ms(percentile(sorted, 0.95))}`);
  console.log(`min ${ms(sorted[0])}, max ${ms(sorted[sorted.length - 1])}`);
  console.log('Wall time includes the network, so it is an upper bound on Edge Function CPU (budget: about 1 s).');
}

const args = parseArgs(Deno.args, { string: ['url', 'tag', 'scope', 'n', 'seed-local'], boolean: ['clean-local'] });

if (args['clean-local']) {
  await cleanLocal();
} else if (args['seed-local'] !== undefined) {
  if (!args['seed-local']) fail(`--seed-local needs a scope name.\n${USAGE}`);
  await seedLocal(args['seed-local']);
} else {
  if (!args.url || !args.tag) fail(USAGE);
  const n = args.n === undefined ? 20 : Number(args.n);
  if (!Number.isInteger(n) || n < 1) fail(`--n must be a positive integer.\n${USAGE}`);
  await measure(args.url, args.tag, args.scope, n);
}
