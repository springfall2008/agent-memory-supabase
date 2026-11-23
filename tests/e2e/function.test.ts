// End-to-end test of the deployed-shape Edge Function over real MCP.
// Requires, in other shells:  `supabase start`  and  `supabase functions serve agent-memory`.
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from 'npm:@modelcontextprotocol/client@2.4.0';
import { adminSql, makeWorld, type World } from '../helpers/fixtures.ts';
import { generateToken, hashToken } from '../../supabase/functions/_shared/tokens.ts';
import { setAdmin } from '../../scripts/lib/admin-db.ts';

const URL_ = Deno.env.get('FUNCTION_URL') ?? 'http://127.0.0.1:54321/functions/v1/agent-memory';

async function connect(token: string, extra: Record<string, string> = {}) {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...extra } },
  });
  await client.connect(transport);
  return client;
}

// deno-lint-ignore no-explicit-any
const parse = (r: any) => JSON.parse(r.content[0].text);
// deno-lint-ignore no-explicit-any
const text = (r: any): string => r.content[0].text;

async function post(headers: Record<string, string>, path = '', body: unknown = {}) {
  const res = await fetch(URL_ + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const out = await res.text();
  return { status: res.status, body: out };
}

/** What a caller sees when it calls a tool: the thrown protocol error, or the tool-error text. */
async function callOutcome(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const r = await c.callTool({ name, arguments: args });
    return `result:${r.isError ? 'error:' : ''}${text(r)}`;
  } catch (e) {
    return `thrown:${e instanceof Error ? e.message : e}`;
  }
}

Deno.test('edge function end-to-end over MCP', async () => {
  const sql = adminSql();
  let w: World | undefined;
  const issue = async (memberId: string) => {
    const t = generateToken();
    const [r] = await sql`
      insert into agent_memory.access_tokens (member_id, name, token_hash)
      values (${memberId}, 'e2e', ${await hashToken(t)}) returning id`;
    return { token: t, id: r.id as string };
  };
  const clients: Client[] = [];
  const open = async (token: string, extra?: Record<string, string>) => {
    const c = await connect(token, extra);
    clients.push(c);
    return c;
  };
  const sfx = crypto.randomUUID().slice(0, 8);
  const adminName = `e2e-admin-${sfx}`;
  const newName = `e2e-new-${sfx}`;
  const newScope = `e2e-scope-${sfx}`;
  try {
    const world = await makeWorld(sql);
    w = world;
    const rw = await issue(world.rw.id);
    const ro = await issue(world.ro.id);
    const none = await issue(world.none.id);

    await t('tools/list returns 30 tools', async () => {
      const c = await open(rw.token);
      assertEquals((await c.listTools()).tools.length, 30);
    });

    await t('store, search, update, find_related, delete as rw', async () => {
      const c = await open(rw.token);
      const stored = parse(
        await c.callTool({
          name: 'store',
          arguments: {
            scope: world.alpha.name,
            content: 'the quokka prefers eucalyptus',
            category: 'learning',
            tags: ['e2e'],
          },
        }),
      );
      assertEquals(stored.scope, world.alpha.name);
      assertEquals(stored.createdBy, world.rw.name);

      const other = parse(
        await c.callTool({
          name: 'store',
          arguments: {
            scope: world.alpha.name,
            content: 'quokkas eat eucalyptus leaves',
            category: 'learning',
            tags: [],
          },
        }),
      );

      const found = parse(await c.callTool({ name: 'search', arguments: { query: 'quokka eucalyptus' } }));
      assert(
        found.results.some((r: { memory: { id: string } }) => r.memory.id === stored.id),
        'search finds the stored memory',
      );

      const updated = parse(await c.callTool({ name: 'update', arguments: { id: stored.id, tags: ['e2e', 'x'] } }));
      assertEquals(updated.tags, ['e2e', 'x']);

      const related = parse(await c.callTool({ name: 'find_related', arguments: { memory_id: stored.id } }));
      assert(
        related.results.some((r: { memory: { id: string } }) => r.memory.id === other.id),
        'find_related finds the sibling',
      );

      await c.callTool({ name: 'delete', arguments: { id: stored.id } });
      const gone = await c.callTool({ name: 'update', arguments: { id: stored.id, tags: [] } });
      assertEquals(gone.isError, true);
    });

    await t('link two memories, follow the link, see it in search, remove it', async () => {
      const c = await open(rw.token);
      const store = async (content: string) =>
        parse(
          await c.callTool({
            name: 'store',
            arguments: { scope: world.alpha.name, content, category: 'learning', tags: ['e2e-links'] },
          }),
        );
      const older = await store('okapi migration plan, first draft');
      const newer = await store('okapi migration plan, revised after review');

      const related = parse(
        await c.callTool({
          name: 'relate_memories',
          arguments: { from_id: newer.id, to_id: older.id, type: 'supersedes' },
        }),
      );
      assertEquals(related, { related: true });

      const walked = parse(await c.callTool({ name: 'neighbours', arguments: { memory_id: newer.id } }));
      assertEquals(walked.count, 1);
      assertEquals(walked.truncated, false);
      assertEquals(walked.results[0].memory.id, older.id);
      assertEquals(walked.results[0].memory.superseded, true);
      assertEquals(walked.results[0].path, [{ type: 'supersedes', direction: 'out', memoryId: older.id }]);

      const brief = parse(
        await c.callTool({ name: 'neighbours', arguments: { memory_id: newer.id, detail: 'short' } }),
      );
      assertEquals(brief.results[0].memory.id, older.id);
      assertEquals(brief.results[0].memory.snippet, 'okapi migration plan, first draft');
      assertEquals('content' in brief.results[0].memory, false);

      const found = parse(await c.callTool({ name: 'search', arguments: { query: 'okapi migration plan' } }));
      const hit = found.results.find((r: { memory: { id: string } }) => r.memory.id === older.id);
      assertEquals(hit.memory.superseded, true);
      assertEquals(hit.memory.links, [{ type: 'supersedes', direction: 'in', memoryId: newer.id }]);

      const removed = parse(
        await c.callTool({
          name: 'unrelate_memories',
          arguments: { from_id: newer.id, to_id: older.id, type: 'supersedes' },
        }),
      );
      assertEquals(removed, { unrelated: true });
      const after = parse(await c.callTool({ name: 'neighbours', arguments: { memory_id: newer.id } }));
      assertEquals(after.count, 0);

      const denied = await c.callTool({
        name: 'relate_memories',
        arguments: { from_id: newer.id, to_id: older.id, type: 'nope' },
      });
      assertEquals(denied.isError, true);
    });

    await t('claim a memory, see the claim in search and my_claims, release it', async () => {
      const c = await open(rw.token);
      const m = parse(
        await c.callTool({
          name: 'store',
          arguments: { scope: world.alpha.name, content: 'tapir ticket to pick up', category: 'learning', tags: [] },
        }),
      );
      const claimed = parse(
        await c.callTool({
          name: 'claim_memory',
          arguments: { memory_id: m.id, description: 'picking it up', indefinite: true, session_label: 'e2e' },
        }),
      );
      assertEquals(claimed, { claimed: true, until: null });
      const found = parse(await c.callTool({ name: 'search', arguments: { query: 'tapir ticket' } }));
      const hit = found.results.find((r: { memory: { id: string } }) => r.memory.id === m.id);
      assertEquals(hit.memory.claim.mine, true);
      assertEquals(hit.memory.claim.description, 'picking it up');
      assertEquals(hit.memory.claim.session.label, 'e2e');
      const mine = parse(await c.callTool({ name: 'my_claims', arguments: {} }));
      assert(mine.claims.some((x: { memory: { id: string } }) => x.memory.id === m.id), 'my_claims lists it');
      const otherSession = await c.callTool({
        name: 'claim_memory',
        arguments: { memory_id: m.id, description: 'me too', session_label: 'e2e-b' },
      });
      assertEquals(otherSession.isError, true);
      assertStringIncludes(
        (otherSession.content as { text: string }[])[0].text,
        "is claimed by your session 'e2e' indefinitely",
      );
      const wrongRelease = await c.callTool({ name: 'release_claim', arguments: { memory_id: m.id } });
      assertEquals(wrongRelease.isError, true);
      const released = parse(
        await c.callTool({ name: 'release_claim', arguments: { memory_id: m.id, session_label: 'e2e' } }),
      );
      assertEquals(released, { released: true });
      const again = parse(await c.callTool({ name: 'search', arguments: { query: 'tapir ticket' } }));
      const after = again.results.find((r: { memory: { id: string } }) => r.memory.id === m.id);
      assertEquals('claim' in after.memory, false);
    });

    await t('claim_next takes the oldest free intent; graph returns the nodes and the link', async () => {
      const c = await open(rw.token);
      const tag = `e2e-next-${crypto.randomUUID().slice(0, 8)}`;
      const store = async (content: string) =>
        parse(
          await c.callTool({
            name: 'store',
            arguments: { scope: world.alpha.name, content, category: 'other', tags: [tag, 'status:open'] },
          }),
        );
      const older = await store('first intent to explore');
      const newer = await store('second intent to explore');
      await c.callTool({
        name: 'relate_memories',
        arguments: { from_id: newer.id, to_id: older.id, type: 'depends-on' },
      });
      const next = async () =>
        parse(
          await c.callTool({
            name: 'claim_next',
            arguments: { description: 'exploring', tags_all: [tag, 'status:open'], session_label: 'e2e-worker' },
          }),
        );
      const first = await next();
      assertEquals([first.claimed, first.memory.id, first.memory.content], [true, older.id, 'first intent to explore']);
      assertEquals((await next()).memory.id, newer.id);
      assertEquals(await next(), { claimed: false });
      const g = parse(await c.callTool({ name: 'graph', arguments: { tags: [tag] } }));
      assertEquals(g.nodes.map((n: { id: string }) => n.id), [older.id, newer.id]);
      assertEquals(g.edges, [{ from: newer.id, to: older.id, type: 'depends-on' }]);
      assertEquals([g.total, g.truncated], [2, false]);
      assertEquals(g.nodes[0].claim.mine, true);
    });

    await t('spoofing a member id changes nothing', async () => {
      const c = await open(rw.token, { 'X-Member-Id': world.ro.id });
      const m = parse(
        await c.callTool({
          name: 'store',
          arguments: {
            scope: world.alpha.name,
            content: 'spoof attempt',
            category: 'other',
            tags: [],
            member_id: world.ro.id,
          },
        }),
      );
      assertEquals(m.createdBy, world.rw.name);
    });

    await t('bad tokens get 401', async () => {
      const revoked = await issue(world.rw.id);
      await sql`update agent_memory.access_tokens set revoked_at = now() where id = ${revoked.id}`;
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      const cases: Record<string, string>[] = [
        {},
        { authorization: 'Bearer amm_garbage' },
        { authorization: 'Bearer nope' },
        { authorization: `Bearer ${revoked.token}` },
      ];
      for (const headers of cases) {
        const r = await post(headers, '', body);
        assertEquals(r.status, 401);
        assertEquals(JSON.parse(r.body), { error: 'invalid or missing token' });
      }
    });

    await t('read-only token cannot store', async () => {
      const c = await open(ro.token);
      const r = await c.callTool({
        name: 'store',
        arguments: { scope: world.alpha.name, content: 'nope', category: 'other', tags: [] },
      });
      assertEquals(r.isError, true);
      assertStringIncludes(text(r), 'No write access');
    });

    await t('token with no grants sees no scopes', async () => {
      const c = await open(none.token);
      assertEquals(parse(await c.callTool({ name: 'list_scopes', arguments: {} })), { count: 0, scopes: [] });
    });

    await t('admin token sees 43 tools; non-admin and bot see the 30 non-admin tools', async () => {
      const [a] = await sql`
        insert into agent_memory.members (display_name, kind) values (${adminName}, 'human') returning id`;
      await setAdmin(sql, adminName, true);
      const admin = await issue(a.id);
      const names = async (tok: string) => (await (await open(tok)).listTools()).tools.map((x) => x.name);
      const adminTools = await names(admin.token);
      assertEquals(adminTools.length, 43);
      assertEquals(adminTools.filter((n) => n.startsWith('admin_')).length, 13);
      const base = await names(rw.token);
      assertEquals(base.length, 30);
      assert(!base.some((n) => n.startsWith('admin_')));
      assertEquals(await names(none.token), base);
      const bot = await issue(world.bw.id);
      assertEquals(await names(bot.token), base);
      assertEquals(adminTools.slice(0, 30), base);
    });

    await t('two clients on one token trade a question and answer', async () => {
      const c1 = await open(rw.token);
      const c2 = await open(rw.token);
      const names = (await c1.listTools()).tools.map((x) => x.name);
      for (
        const n of [
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
        ]
      ) assert(names.includes(n), n);
      assert(!names.includes('admin_delete_thread'));

      const created = parse(
        await c1.callTool({
          name: 'create_thread',
          arguments: {
            scope: world.alpha.name,
            title: 'e2e question',
            body: 'what do quokkas eat?',
            session_label: 'asker',
          },
        }),
      );
      assertEquals(created.session.created, true);
      assertEquals(created.note?.startsWith('New agent session.'), true);
      const threadId = created.thread.id as string;

      const answered = parse(
        await c2.callTool({
          name: 'post',
          arguments: { thread_id: threadId, body: 'eucalyptus', session_label: 'answerer' },
        }),
      );
      assertEquals(answered.threadId, threadId);
      assertEquals(answered.post.sessionLabel, 'answerer');

      const news = parse(await c1.callTool({ name: 'whats_new', arguments: { session_label: 'asker' } }));
      assertEquals(news.threads.length, 1);
      assertEquals(news.threads[0].threadId, threadId);
      assertEquals(news.threads[0].newPosts, 1);

      const read = parse(
        await c1.callTool({ name: 'read_thread', arguments: { thread_id: threadId, session_label: 'asker' } }),
      );
      const reply = read.posts.find((p: { body: string }) => p.body === 'eucalyptus');
      assertEquals(reply.new, true);

      const again = parse(await c1.callTool({ name: 'whats_new', arguments: { session_label: 'asker' } }));
      assertEquals(again.threads, []);

      const bad = await c1.callTool({ name: 'post', arguments: { thread_id: 'nope', body: 'x' } });
      assertEquals(bad.isError, true);
      assertEquals(text(bad), 'Thread nope not found');
    });

    await t('non-admin calling admin_create_scope gets the unknown-tool error', async () => {
      const c = await open(rw.token);
      const a = await callOutcome(c, 'admin_create_scope', { name: newScope });
      const b = await callOutcome(c, 'no_such_tool', { name: newScope });
      assertEquals(a.replace('admin_create_scope', 'X'), b.replace('no_such_tool', 'X'));
      const [row] = await sql`select 1 from agent_memory.scopes where name = ${newScope}`;
      assertEquals(row, undefined);
    });

    await t('admin onboards a member over MCP; deactivation ends their access', async () => {
      const [a] = await sql`select id from agent_memory.members where display_name = ${adminName}`;
      const admin = await open((await issue(a.id)).token);
      const ok = async (name: string, args: Record<string, unknown>) => {
        const r = await admin.callTool({ name, arguments: args });
        assert(!r.isError, `${name}: ${text(r)}`);
        return parse(r);
      };
      await ok('admin_create_member', { name: newName, kind: 'human' });
      await ok('admin_grant', { member: newName, scope: world.alpha.name, access: 'read' });
      const issued = await ok('admin_issue_token', { member: newName, name: 'e2e' });
      assert(typeof issued.token === 'string' && issued.token.startsWith('amm_'));

      const nc = await open(issued.token);
      const scopes = parse(await nc.callTool({ name: 'list_scopes', arguments: {} }));
      assertEquals(scopes.count, 1);
      assertEquals(scopes.scopes[0].scope, world.alpha.name);
      assertEquals(scopes.scopes[0].access, 'read');
      assertEquals((await nc.listTools()).tools.length, 30);

      await ok('admin_deactivate_member', { name: newName });
      const r = await post({ authorization: `Bearer ${issued.token}` }, '', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      });
      assertEquals(r.status, 401);
    });

    await t('/embed rejects oversize and malformed bodies', async () => {
      const auth = { authorization: `Bearer ${rw.token}` };
      const big = await post(auth, '/embed', { text: 'x'.repeat(20_001) });
      assertEquals(big.status, 413);
      assertEquals(JSON.parse(big.body), { error: 'text too large' });
      assertEquals((await post(auth, '/embed', { text: 'x'.repeat(70_000) })).status, 413);
      const res = await fetch(URL_ + '/embed', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{not json',
      });
      assertEquals(res.status, 400);
      await res.body?.cancel();
      assertEquals((await post(auth, '/embed', { text: 5 })).status, 400);
    });

    await t('/embed returns a 384-length vector, and needs a token', async () => {
      const r = await post({ authorization: `Bearer ${rw.token}` }, '/embed', { text: 'hello world' });
      assertEquals(r.status, 200);
      assertEquals(JSON.parse(r.body).embedding.length, 384);
      assertEquals((await post({}, '/embed', { text: 'hi' })).status, 401);
    });
  } finally {
    try {
      for (const c of clients) await c.close().catch(() => {});
      // Members this test created (the admin and the onboarded one), with their tokens, grants and log rows.
      const created = await sql`select id from agent_memory.members where display_name in (${adminName}, ${newName})`;
      const ids = created.map((r) => r.id as string);
      await sql`delete from agent_memory.admin_log
        where actor_member_id = any(${ids}::uuid[]) or target in (${adminName}, ${newName}, ${newScope})
          or details->>'member' in (${adminName}, ${newName})`;
      await sql`delete from agent_memory.access_tokens where member_id = any(${ids}::uuid[])`;
      await sql`delete from agent_memory.scope_grants where member_id = any(${ids}::uuid[])`;
      await sql`delete from agent_memory.members where id = any(${ids}::uuid[])`;
      await w?.cleanup();
    } finally {
      await sql.end();
    }
  }
});

async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    throw new Error(`${name}: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
}
