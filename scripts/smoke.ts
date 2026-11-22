// Smoke test: runs every tool once through the real MCP endpoint.
//   AGENT_MEMORY_URL=https://<ref>.supabase.co/functions/v1/agent-memory AGENT_MEMORY_TOKEN=amm_... \
//     deno run -A scripts/smoke.ts --scope <name>
// The token's member needs write on the scope. Everything stored is deleted again.
import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import { Client, StreamableHTTPClientTransport } from 'npm:@modelcontextprotocol/client@2.4.0';

// deno-lint-ignore no-explicit-any
type Json = any;

const args = parseArgs(Deno.args, { string: ['scope'] });
const url = Deno.env.get('AGENT_MEMORY_URL');
const token = Deno.env.get('AGENT_MEMORY_TOKEN');
if (!url || !token || !args.scope) {
  console.error(
    'Usage: AGENT_MEMORY_URL=... AGENT_MEMORY_TOKEN=... deno run -A scripts/smoke.ts --scope <name>',
  );
  Deno.exit(2);
}
const scope: string = args.scope;

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

/** Calls a tool; retries once on a 546/503 (the platform recycles a busy worker). */
async function call(name: string, a: Record<string, unknown>): Promise<Json> {
  for (let attempt = 0;; attempt++) {
    try {
      const r: Json = await client.callTool({ name, arguments: a });
      const text: string = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    } catch (e) {
      if (attempt === 0 && /\b(546|503)\b/.test(String(e))) continue;
      throw e;
    }
  }
}

const BASE_TOOLS = [
  'list_scopes',
  'store',
  'store_batch',
  'search',
  'recall',
  'find_related',
  'list_recent',
  'relate_memories',
  'unrelate_memories',
  'neighbours',
  'claim_memory',
  'release_claim',
  'my_claims',
  'update',
  'delete',
  'stats',
  'prune',
  'create_thread',
  'post',
  'read_thread',
  'list_threads',
  'resolve_thread',
  'reopen_thread',
  'link_memory',
  'unlink_memory',
  'subscribe',
  'unsubscribe',
  'whats_new',
];

let failures = 0;
async function step(name: string, fn: () => Promise<void | 'skip'>) {
  const t0 = performance.now();
  try {
    if (await fn() === 'skip') {
      console.log(`SKIP ${name} (no admin tools)`);
      return;
    }
    console.log(`PASS ${name} (${Math.round(performance.now() - t0)} ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}
function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const created: string[] = [];
let id = '';
let sibling = '';
let adminTools = false;
let threadId = '';
let sessionId = '';

await step('tools/list', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const missing = BASE_TOOLS.filter((t) => !names.includes(t));
  ok(missing.length === 0, `missing base tools: ${missing.join(', ')}`);
  const extra = names.filter((t) => !BASE_TOOLS.includes(t));
  const stray = extra.filter((t) => !t.startsWith('admin_'));
  ok(stray.length === 0, `unexpected non-admin tools: ${stray.join(', ')}`);
  adminTools = extra.includes('admin_delete_thread');
  console.log(extra.length ? `  saw base + ${extra.length} admin tools (admin token)` : '  saw base tools only');
});
await step('list_scopes', async () => {
  const r = await call('list_scopes', {});
  const s = r.scopes.find((x: Json) => x.scope === scope);
  ok(s, `scope '${scope}' not listed`);
  ok(s.access === 'write', `expected write access, got ${s.access}`);
});
await step('store', async () => {
  const r = await call('store', {
    scope,
    content: 'smoke test: the quokka prefers eucalyptus',
    category: 'learning',
    tags: ['smoke-test'],
  });
  ok(r.id && r.scope === scope, 'no id or wrong scope');
  id = r.id;
  created.push(id);
});
await step('store_batch', async () => {
  const r = await call('store_batch', {
    scope,
    memories: [
      { content: 'smoke test: eucalyptus leaves are a quokka snack', category: 'learning', tags: ['smoke-test'] },
      { content: 'smoke test: a second batch memory', category: 'other', tags: ['smoke-test'] },
    ],
  });
  ok(r.stored === 2, `stored ${r.stored}`);
  sibling = r.memories[0].id;
  for (const m of r.memories) created.push(m.id);
});
await step('search', async () => {
  const r = await call('search', { query: 'quokka eucalyptus', scopes: [scope] });
  ok(r.results.some((x: Json) => x.memory.id === id), 'stored memory not found');
});
await step('recall', async () => {
  const r = await call('recall', { topics: ['quokka'], scopes: [scope] });
  ok(r.byTopic, 'no byTopic');
});
await step('find_related', async () => {
  const r = await call('find_related', { memory_id: id, scopes: [scope] });
  ok(r.results.some((x: Json) => x.memory.id === sibling), 'sibling not related');
});
await step('relate_memories', async () => {
  const r = await call('relate_memories', { from_id: id, to_id: sibling, type: 'relates-to' });
  ok(r.related === true, 'link not created');
});
await step('neighbours', async () => {
  const r = await call('neighbours', { memory_id: id });
  ok(r.results.some((x: Json) => x.memory.id === sibling), 'linked memory not reached');
  const s = await call('search', { query: 'quokka eucalyptus', scopes: [scope] });
  const hit = s.results.find((x: Json) => x.memory.id === id);
  ok(hit?.memory.links?.some((l: Json) => l.memoryId === sibling), 'search result does not show the link');
});
await step('unrelate_memories', async () => {
  const r = await call('unrelate_memories', { from_id: id, to_id: sibling, type: 'relates-to' });
  ok(r.unrelated === true, 'link not removed');
});
await step('claim_memory', async () => {
  const r = await call('claim_memory', {
    memory_id: id,
    description: 'smoke test claim',
    minutes: 5,
    session_label: 'smoke',
  });
  ok(r.claimed === true && typeof r.until === 'string', 'claim not made');
});
await step('my_claims', async () => {
  const r = await call('my_claims', { scopes: [scope] });
  ok(r.claims.some((c: Json) => c.memory.id === id && c.session?.label === 'smoke'), 'claim not listed');
  const s = await call('search', { query: 'quokka eucalyptus', scopes: [scope] });
  const hit = s.results.find((x: Json) => x.memory.id === id);
  ok(hit?.memory.claim?.mine === true, 'search result does not show the claim');
});
await step('release_claim', async () => {
  const r = await call('release_claim', { memory_id: id });
  ok(r.released === true, 'claim not released');
});
await step('list_recent', async () => {
  const r = await call('list_recent', { limit: 10, scopes: [scope] });
  ok(r.memories.some((m: Json) => m.id === id), 'stored memory not recent');
});
await step('update', async () => {
  const r = await call('update', { id, tags: ['smoke-test', 'updated'] });
  ok(r.tags.includes('updated'), 'tags not updated');
});
await step('stats', async () => {
  const r = await call('stats', { scopes: [scope] });
  ok(r && typeof r === 'object', 'no stats');
});
await step('prune (dry run)', async () => {
  const r = await call('prune', { scope, dryRun: true });
  ok(r.dryRun !== false, 'dry run was not a dry run');
});
await step('search burst x3', async () => {
  const rs = await Promise.all([1, 2, 3].map((i) => call('search', { query: `quokka burst ${i}`, scopes: [scope] })));
  ok(rs.every((r) => Array.isArray(r.results)), 'a burst search failed');
});
await step('create_thread', async () => {
  const r = await call('create_thread', {
    scope,
    title: 'smoke test thread',
    body: 'smoke test: first post',
    memory_ids: [id],
    session_label: 'smoke',
  });
  ok(r.thread?.id, 'no thread id');
  ok(r.session?.id, 'no session id');
  threadId = r.thread.id;
  sessionId = r.session.id;
});
await step('post', async () => {
  const r = await call('post', { thread_id: threadId, body: 'smoke test: second post', session: sessionId });
  ok(r.post?.seq >= 2, `unexpected post seq ${r.post?.seq}`);
});
await step('read_thread', async () => {
  const r = await call('read_thread', { thread_id: threadId, session: sessionId });
  ok(r.posts?.length >= 1, 'no posts');
  ok(r.links?.some((l: Json) => l.memoryId === id), 'linked memory not listed');
});
await step('recall carries the thread', async () => {
  const r = await call('recall', { topics: ['quokka eucalyptus'], scopes: [scope] });
  const hit = Object.values(r.byTopic as Record<string, Json[]>).flat().find((x) => x.memory.id === id);
  ok(hit, 'stored memory not recalled');
  ok(hit.memory.threads?.some((t: Json) => t.id === threadId), 'recalled memory does not list the thread');
});
await step('whats_new', async () => {
  const r = await call('whats_new', { session: sessionId });
  ok(Array.isArray(r.threads), 'no threads array');
});
await step('resolve_thread', async () => {
  const r = await call('resolve_thread', { thread_id: threadId, note: 'smoke test done', session: sessionId });
  ok(r.thread?.status === 'resolved', `status ${r.thread?.status}`);
});
await step('admin_delete_thread', async () => {
  if (!adminTools) {
    return 'skip';
  }
  await call('admin_delete_thread', { thread_id: threadId });
  threadId = '';
});
await step('delete', async () => {
  for (const m of created) {
    await call('delete', { id: m });
  }
  created.length = 0;
});

await client.close();
if (threadId) console.log(`WARNING: thread ${threadId} left behind in '${scope}'`);
if (created.length) console.log(`WARNING: ${created.length} memories left in '${scope}': ${created.join(', ')}`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
Deno.exit(failures ? 1 : 0);
