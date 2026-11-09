# agent-memory-supabase

Shared, hosted memory for AI agents, built on [Supabase](https://supabase.com/). An MCP server, run as a Supabase
Edge Function, gives agents persistent memory they can store into and search, from any machine or cloud session.

Memories live in **scopes** (named memory pools, such as `predbat-devs`). An admin grants each member read-only or
read-write access per scope, and Postgres row-level security enforces it. Several developers and their bots can
share one memory, and no one can read a scope they weren't granted.

If you want to buy me a beer, then please use [Paypal](https://paypal.me/predbat?country.x=GB&locale.x=en_GB) or
[GitHub sponsor](https://github.com/springfall2008)
![image](https://github.com/springfall2008/batpred/assets/48591903/b3a533ef-0862-4e0b-b272-30e254f58467)

## Why

Agents forget everything between sessions. Most memory servers fix that for one person on one machine: a local file or
database that a cloud session, a CI bot or a teammate cannot reach. This project is for a team of people and bots
working on the same code, who should learn from each other: what one session finds, the next one can recall, wherever
it runs.

How it differs from other memory tools:

- **Hosted, but yours.** Hosted memory services such as Mem0 Platform, Supermemory and Zep give a team shared memory,
  but the memories live on their service, and finer access control is often a paid tier. Self-hosted servers such as
  mcp-memory-service, Graphiti and Cognee keep the data with you, but you run the server and database and build the
  team's access rules yourself. This runs in your own Supabase project (the free tier is enough), installs with two
  commands, and has no server to look after. A client needs only a URL and a token, so a cloud session or a bot
  connects as easily as a laptop.
- **Access rules live in the database.** Each memory belongs to a scope, and each member has read or write access per
  scope. Postgres row-level security enforces this, not application code, and the pgTAP and integration tests check it
  against a real database. A bot that answers in public can read a scope without being able to write to it, and a
  private scope is invisible to anyone not granted it.
- **Threads, so agents can work together.** Memories hold what is settled; threads hold the discussion. An agent can
  hand its findings to another, ask a question someone answers later, and catch up with `whats_new`. None of the
  memory servers we compared has an equivalent.
- **No LLM in the loop.** Memories are stored as the agent wrote them and found by hybrid full-text and vector search.
  The embedding model (`gte-small`) runs inside the function. Tools such as Mem0, Graphiti and Cognee call an LLM to
  extract facts or a graph from what you give them. Here there is no model API key, no per-call model cost, and
  nothing rewrites what was stored.
- **Run by a team, not one person.** Admins manage members, grants and tokens from Claude or the shell. Every admin
  action is logged, deletes can be undone for 30 days, and one script backs up the whole install.

It is not a knowledge graph, and it is not a personal assistant's memory. For one person on one machine, the
[reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) or
[agent-memory-mcp](https://github.com/adamrdrew/agent-memory-mcp), which this project builds on, is simpler.

## Tools

The server exposes 22 tools, plus 13 `admin_` tools that only admins see (see [Admins](#admins)). Eleven are the
thread tools (see [Threads and sessions](#threads-and-sessions)). The memory tools are `list_scopes`, `store`, `store_batch`, `search`, `recall`, `find_related`,
`list_recent`, `update`, `delete`, `stats` and `prune`. They match the original server, plus a `scope` argument on the
write tools. Search is hybrid (BM25 full-text plus `gte-small` vector similarity, fused with RRF) with temporal decay.
Its `tags` filter keeps memories with at least one of the tags given; `tags_all` keeps only those with every one, so a
query such as "open work in this repo" (`tags_all: ["repo:<name>", "status:open"]`) needs no client-side filtering.
The two can be combined.
Delete and prune are soft; rows are purged after 30 days.

## Threads and sessions

Memories hold what is known; **threads** hold the discussion around it. A thread lives in one scope, has a title and
numbered posts, and can be linked to memories. Anyone with read access to the scope can read it; write access is
needed to create, post, resolve, reopen or link. `recall` lists the threads linked to each memory it returns, so an
agent that finds a memory also finds the conversation about it.

The thread tools are `create_thread`, `post`, `read_thread`, `list_threads`, `resolve_thread`, `reopen_thread`,
`link_memory`, `unlink_memory`, `subscribe`, `unsubscribe` and `whats_new`.

A **session** is one running agent: a conversation or job, even when several agents share a token. The first call that
needs one (`create_thread`, `post`, `resolve_thread`, `reopen_thread`, `subscribe`) creates it and returns its id;
pass that id as `session` on later calls. If the id is lost, pass the same `session_label` to pick the session up
again. A session is how the server tells your own posts from other agents' posts, and it is recorded on the memories
you store and update.

The `whats_new` loop: subscribe your session to the threads you care about (creating or posting to a thread
subscribes you), call `whats_new` with your session when you resume work and between steps of long work, then
`read_thread` with the session to read the posts you have not seen. Reading marks them seen. Your own posts never
show as new.

Admins can delete a thread with `admin_delete_thread`. From the shell:

```sh
deno run -A scripts/admin.ts delete-thread <thread-id>          # soft delete, recoverable for 30 days
deno run -A scripts/admin.ts restore-thread <thread-id>
deno run -A scripts/admin.ts erase-thread <thread-id>           # shows scope and title, exits 1
deno run -A scripts/admin.ts erase-thread <thread-id> --yes     # hard delete with its posts; not reversible
```

## Quick start

Two commands take an empty Supabase project to a working Claude connection. You need the Supabase CLI 3.x and Deno 2.x.

```sh
cp .env.example .env     # then fill in SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD and SUPABASE_PROJECT_REF
deno run -A scripts/setup.ts --configure-claude
```

`setup.ts` links the project, applies the migrations, deploys the function, creates a scope (`default`) and a member
(your OS user), grants it write access and issues a token. It saves `AGENT_MEMORY_URL`, `AGENT_MEMORY_TOKEN` and
`AGENT_MEMORY_DB_URL` into `.env` (mode 0600; it refuses to write unless git ignores the file) and prints the token once.
`--configure-claude` then runs `claude mcp add` for you. Re-running is safe: nothing is duplicated, and a live token in
`.env` is reused. The member it creates becomes the first admin (see [Admins](#admins)).

Flags: `--env-file <path>` (default `.env`), `--scope <name>` (default `default`), `--member <name>`,
`--email <address>` (optional; only links the member to a Supabase login), `--bot` (a bot member instead of a
human), `--new-token` (issue another token even if `.env` has a live one), `--skip-deploy`, `--configure-claude` and
`--name <server-name>` (default `shared-memory`).

To register an existing token without re-running setup:
`deno run -A scripts/configure-claude.ts [--name shared-memory] [--scope user|project]`. Project scope writes the token
into `.mcp.json`, which is normally committed, so it needs `--yes`; prefer the default `user` scope.

The admin, backup and import scripts read `AGENT_MEMORY_DB_URL` from the environment; load the saved file with
`deno run --env-file=.env -A scripts/admin.ts list-scopes`.

`configure-claude` passes the token to `claude mcp add` as an argument, and Claude Code stores it in `~/.claude.json`,
as with any MCP header.

The manual steps follow, if you prefer to run each yourself.

### Install by hand

You need a Supabase project (the free tier works), **Supabase CLI 3.x** (the commands below use its flags; CI pins
3.0.0) and [Deno](https://deno.com/) 2.x.

```sh
supabase link --project-ref <project-ref>
supabase db push --remote
supabase functions deploy agent-memory --use-api
```

`db push` applies the migrations in `supabase/migrations/`, which create everything: the `agent_memory` schema, row
level security, the search functions and the daily clean-up job. In CLI 3, `db push` targets the local stack unless
you pass `--remote` (the linked project, or `--remote=<project-ref>`). `functions deploy` targets the linked project
(or `--remote=<project-ref>`), and `--use-api` means no Docker is needed to deploy.

The schema `agent_memory` must **not** be listed under Settings, API, Exposed schemas. Access goes only through the
Edge Function; `anon` and `authenticated` have no privileges on it.

Installing by hand, nothing makes you an admin. After creating your own member (see the
[Admin quick-start](#admin-quick-start)), make it the first admin:
`deno run -A scripts/admin.ts set-admin <you> on`.

### Temporal decay

Search scores decay with age, as in the original. The half-life in days is the function secret
`MEMORY_DECAY_HALF_LIFE` (default `30`):

```sh
supabase secrets set MEMORY_DECAY_HALF_LIFE=45
```

A value of `0` or less (or one that is not a number) disables decay. Then `prune` (and `stats.belowPruneThreshold`)
uses only the dormant rule: a memory that was never accessed and is older than `maxDormantDays` (default 90). The
original server instead treated every memory as a candidate when decay was off. Memories tagged `evergreen` or
`never-forget` are never pruned.

## Admin quick-start

The admin scripts connect to the database directly. Set `AGENT_MEMORY_DB_URL` to the session pooler connection string
(Connect in the dashboard, port 5432) and keep it out of version control. Percent-encode any special characters in the
password (for example `@` as `%40`, `/` as `%2F`, `#` as `%23`), or the URL will not parse.

```sh
export AGENT_MEMORY_DB_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres'

deno run -A scripts/admin.ts create-scope my-team --description "Team memory"
deno run -A scripts/admin.ts create-member alice                 # email optional: --email alice@example.com
                                                                 # links a Supabase login if one exists
deno run -A scripts/admin.ts create-member ci-bot --bot
deno run -A scripts/admin.ts grant alice my-team write
deno run -A scripts/admin.ts grant ci-bot my-team read
deno run -A scripts/admin.ts issue-token alice laptop --expires 90d   # shown once
```

Other commands: `list-scopes`, `list-grants`, `list-tokens <member>`, `revoke <member> <scope>` and
`revoke-token <id>`. Tokens look like `amm_…` and only their SHA-256 hash is stored.

### Admins

Some members are admins. An admin can manage the team from Claude, not only from the shell.

- **The first admin** comes from `scripts/setup.ts`: a human member it creates or reuses is made an admin (a `--bot`
  member never is). For an existing install, run `deno run -A scripts/admin.ts set-admin <member> on`.
- **Shell-only commands** (they are not available through Claude): `set-admin <member> on|off`,
  `reactivate <member>` and `admin-log [--since <ISO|Nd>] [--actor <name>] [--limit N]`.
  `delete-scope`, `deactivate` and `list-members` are also shell commands, and admins can do them from Claude too.
  Deactivating a member also drops their admin flag, so a reactivated member is not an admin until `set-admin` is run.
  A scope can only be deleted once it holds no memories, live or soft-deleted.
- **From Claude**, admins can do the rest with the `admin_` tools: `admin_list_scopes`, `admin_create_scope`,
  `admin_delete_scope`, `admin_list_members`, `admin_create_member`, `admin_deactivate_member`, `admin_list_grants`,
  `admin_grant`, `admin_revoke`, `admin_issue_token`, `admin_list_tokens`, `admin_revoke_token` and
  `admin_delete_thread` (a soft delete; `restore-thread` and `erase-thread` are shell-only).
- **Connecting an onboarded member.** The admin issues a token with `admin_issue_token` (or `issue-token`) and gives it
  to the member, who registers it with Claude Code:

  ```sh
  claude mcp add --transport http shared-memory https://<project-ref>.supabase.co/functions/v1/agent-memory \
    --header "Authorization: Bearer <token>" -s user
  ```

  or, with the URL and token in an env file (`AGENT_MEMORY_URL`, `AGENT_MEMORY_TOKEN`),
  `deno run -A scripts/configure-claude.ts [--name shared-memory] [--scope user]`, as in the Quick start.
- **Handle issued tokens with care.** A token issued through `admin_issue_token` passes through the admin's Claude
  transcript, so give it to the member privately (not in a shared channel), and revoke it if it leaks. Do not
  auto-allow the `mcp__<server>__admin_*` tools in Claude Code permissions: admin tools run in sessions that also read
  memories written by other members, so keep the per-call confirmation on.
- **Admin tools never act on another admin.** Changing an admin, or their grants or tokens, is done from the shell.

Every admin action, from the shell or from Claude, is recorded in the admin log. The log never holds a token.

### Undo, and erasing for good

`delete` and `prune` are soft: a deleted memory stays restorable for 30 days, then the daily job purges it. A purge
removes the content from the memory's history as well, so only the fact that it existed remains.

```sh
# What has been deleted, by whom, and when (all filters optional)
deno run -A scripts/admin.ts list-deleted --scope my-team --by ci-bot --since 2026-11-01

# Restore by id (one or several)
deno run -A scripts/admin.ts restore <memory-id> <memory-id>

# Undo a bad bulk prune: without --yes this lists what it would restore and exits 1
deno run -A scripts/admin.ts restore --scope my-team --by ci-bot --since 2026-11-01
deno run -A scripts/admin.ts restore --scope my-team --by ci-bot --since 2026-11-01 --yes

# Erase a memory now (live or deleted), with its history content. Not reversible.
deno run -A scripts/admin.ts erase <memory-id>         # shows id, scope and first line, exits 1
deno run -A scripts/admin.ts erase <memory-id> --yes
```

`--by admin` matches deletions made directly in the database rather than by a member.

### Backup and restore

```sh
deno run -A scripts/backup.ts backup                       # the whole install: scopes, members, grants, memories
deno run -A scripts/backup.ts backup --scope my-team --out backup-my-team.json   # one scope
deno run -A scripts/backup.ts restore-backup backup-<timestamp>.json
```

`backup` exports the whole install by default, including threads, posts, links, sessions and subscriptions; `--scope`
limits it to one scope: that scope's threads and posts, the links to memories in the file, the sessions they reference,
and the members behind all of it. The
file holds memory content: treat it as private. `restore-backup` loads only into an **empty** install (fresh
migrations, no scopes, members or memories) and keeps ids. Access tokens are never exported, so after a restore,
issue new tokens with `issue-token`. Admin flags and deactivation are kept, and backup files written before admin
support, or before threads, still restore (as non-admin, active members, with no threads). The admin log is **not** exported, so it starts empty after a restore.

### Import from a local agent-memory-mcp store

`scripts/import.ts` loads memories exported from a local LanceDB store, re-embedding each one through the function's
`/embed` endpoint. It is a dry run until you pass `--execute`.

```sh
# 1. Export the LanceDB store to JSON (Node 20+). The output is private: memories*.json is gitignored.
(cd scripts/lancedb-export && npm ci) && node scripts/lancedb-export/export.mjs <MEMORY_DB_PATH> > memories.json

# 2. Dry run: choose by tag, review the list, and write the selected ids to a file
deno run -A scripts/import.ts --file memories.json --include-tag repo:batpred --exclude-tag personal \
  --write-ids ids.txt

# 3. Edit ids.txt: delete any line you do not want shared (# starts a comment). Re-run the dry run with it
deno run -A scripts/import.ts --file memories.json --include-tag repo:batpred --exclude-tag personal --ids ids.txt

# 4. Import for real
export AGENT_MEMORY_DB_URL='postgresql://…'                                     # as for the admin CLI
export AGENT_MEMORY_URL=https://<project-ref>.supabase.co/functions/v1/agent-memory
export AGENT_MEMORY_TOKEN=amm_…                                                 # any valid token, used for /embed
deno run -A scripts/import.ts --file memories.json --include-tag repo:batpred --exclude-tag personal --ids ids.txt \
  --scope my-team --as alice --execute
```

A tag filter alone can let private memories through, so review the ids before `--execute`. Re-running is safe:
memories already present are skipped. Content over 20,000 characters is reported as failed and not imported.

> **Warning:** the importer keeps each memory's original id. Re-running `import.ts` from an old export can bring back
> memories that were since erased or purged. Remove those memories from the local export too.

`scripts/smoke.ts` is described under [Smoke test](#smoke-test).

## Connect an agent

```sh
claude mcp add --transport http predbat-memory \
  https://<project-ref>.supabase.co/functions/v1/agent-memory \
  --header "Authorization: Bearer amm_…"
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "predbat-memory": {
      "type": "http",
      "url": "https://<project-ref>.supabase.co/functions/v1/agent-memory",
      "headers": { "Authorization": "Bearer ${AGENT_MEMORY_TOKEN}" }
    }
  }
}
```

Keep the token in an environment variable, not in a committed file.

### Suggested CLAUDE.md wording

[docs/claude-md-sample.md](docs/claude-md-sample.md) is a fuller section to paste into your own `CLAUDE.md` as it
is, filling in the scope table. It covers scopes, keeping work status true, and when and how to use threads and
sessions. The short version:

```markdown
## Shared memory
- Call `list_scopes` first to see which scopes you can use and whether each is read or write.
- Store durable findings into the team scope (`my-team`), not a personal one. Include why, not just what.
- Before storing, `search` for an existing memory on the topic. If there is one, `update` it; do not store a duplicate.
- Never store secrets, tokens or credentials.
```

## Smoke test

```sh
AGENT_MEMORY_URL=https://<project-ref>.supabase.co/functions/v1/agent-memory \
AGENT_MEMORY_TOKEN=amm_… \
  deno run -A scripts/smoke.ts --scope <scope-with-write-access>
```

It runs every tool once through the real endpoint (including a thread created, posted to, read, recalled, followed
with `whats_new` and resolved), then three concurrent searches, prints `PASS` or `FAIL` per tool and
exits non-zero on any failure. It deletes what it stored. An admin token sees the 13 `admin_` tools as well; the smoke
test checks that they are present and uses only `admin_delete_thread`, to remove its thread. With a non-admin token the
thread is left resolved and the smoke test prints its id.

## Development

```sh
supabase start                # local stack
deno task check               # fmt, lint, type-check
deno task test:unit
supabase test db              # pgTAP: schema, RLS, functions, search
deno task test:int            # against the local database
supabase functions serve agent-memory & deno task test:e2e   # needs the model download
```

CI (`.github/workflows/ci.yml`) runs everything except the end-to-end test.

## Known limits

- **Error 546 ("retry once").** Embedding runs inside the Edge Function, which has a CPU budget per worker. If a worker
  is busy and the platform recycles it, a request can fail with `546`/`WORKER_RESOURCE_LIMIT`. Retry once; the retry
  lands on a fresh worker. To stay inside the budget, `store_batch` accepts at most 2 memories and `recall` embeds at
  most 5 topics per call. Details are in the [spike results](docs/superpowers/specs/2026-11-07-embedding-spike-results.md).
- **Size limits.** A memory's content is at most 20,000 characters (`store`, `store_batch`, `update`, import), and
  every result `limit` (`search`, `find_related`, `list_recent`, `recall`) is between 1 and 100.
- **Free-tier pausing.** Free Supabase projects are paused after a period of inactivity. Unpause from the dashboard;
  the first request after that is slow.

## Credits

This project builds on the design and code of
[agent-memory-mcp](https://github.com/adamrdrew/agent-memory-mcp) by Adam Drew, via the
[chalfontchubby fork](https://github.com/chalfontchubby/agent-memory-mcp), which fixes upstream bugs that made the
memory forget records. It keeps their tool set, hybrid BM25 + vector search and temporal decay, and moves the store
from a local LanceDB folder to Supabase (Postgres, pgvector, full-text search) with scoped, shared access.

## License

GPL-3.0-or-later, as the original. See [LICENSE](LICENSE).
