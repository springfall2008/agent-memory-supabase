# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A hosted MCP memory server on Supabase: the agent-memory-mcp tool set plus **scopes** (named memory pools) with
per-member read/write grants enforced by Postgres row-level security, and **admin** members who manage scopes, members,
grants and tokens through `admin_` MCP tools. The design docs are the source of truth for intent:
`docs/superpowers/specs/` (and their implementation plans in `docs/superpowers/plans/`). `spike/` is a throwaway CPU
measurement, not product code.

## Commands

```sh
supabase start                     # local stack (Docker); DB at postgresql://postgres:postgres@127.0.0.1:54322/postgres
supabase db reset                  # rebuild the local DB from supabase/migrations/ (do this after editing a migration)
deno task check                    # deno fmt --check, deno lint, deno check
deno task test:unit                # tests/unit — no database
supabase test db                   # pgTAP: supabase/tests/database/*.test.sql (rolled back, needs the local stack)
deno task test:int                 # tests/integration — against the local DB
supabase functions serve agent-memory   # then, in another shell:
deno task test:e2e                 # real MCP over the local function (downloads the gte-small model first time)
```

Run one Deno test file or test: `deno test -A tests/integration/pg-store-read.test.ts --filter "<test name>"`.

CI (`.github/workflows/ci.yml`, Supabase CLI pinned at 3.0.0) runs check, unit, `supabase db start`, pgTAP and
integration. E2E is local only. After editing function code, restart `supabase functions serve`: a running server can
boot a half-written file and fail with BOOT_ERROR or "Unexpected eof".

## Architecture

**Request path.** `supabase/functions/agent-memory/index.ts`:

- **Authentication:** the Bearer token is resolved by `resolveCaller` (`_shared/db.ts`) through the SQL function
  `resolve_member`, which hashes the token and requires an unrevoked, unexpired token of a non-deactivated member. It
  returns `{ memberId, isAdmin }`. Identity comes only from the token; nothing in the request body or headers can name a
  member.
- **MCP server:** a fresh, stateless McpServer is built per request. `registerTools` (`_shared/tools.ts`) adds the 19
  memory tools, and `registerThreadTools` (`_shared/thread-tools.ts`) the 11 thread tools, so every member gets 30.
  `registerAdminTools` (`_shared/admin-tools.ts`) adds the 13 `admin_` tools for admins only.
- **`/embed`:** `POST …/embed` returns a gte-small vector for the importer.

**Running as a member.** `PgMemoryStore` (`_shared/pg-store.ts`), `PgThreadStore` (`_shared/thread-store.ts`) and
`PgAdminStore` (`_shared/admin-store.ts`) run every query through `withMember`. That opens a transaction with
`set local role agent_memory_member` and a transaction-local `agent_memory.member_id`, so RLS and the SECURITY DEFINER
functions see the caller. The function connects as `postgres`, but no member work runs as postgres.

**Where the rules live: Postgres, not TypeScript.** Migrations in `supabase/migrations/` hold the schema, RLS policies,
member column-level grants and every SECURITY DEFINER function (`search_path = ''`, fully qualified names, execute
revoked from public). Admin power has two layers:

- `adm_*`: postgres-only core functions that do each action and write `admin_log`. The shell scripts call these.
- `admin_*`: member-callable wrappers. Each calls `require_admin()` first, refuses to act on any other admin, then calls
  `adm_*`. Promoting or demoting admins (`adm_set_admin`) and reactivation are shell-only.

**Search.** `search_memories` / `related_memories` (SQL) combine full-text rank and **exact** pgvector cosine distance
with RRF (k = 60), filtered inside each arm, and return at most `p_limit` rows. The TS store passes
`limit × OVER_FETCH_FACTOR`, applies temporal decay (`_shared/decay.ts`, ported from the original), then trims to
`limit`. There is deliberately no ANN index: post-filtering an HNSW index under RLS gave short pages and leaked result
counts.

**Browse.** `search` with no query calls `PgMemoryStore.browse`, which skips `search_memories`, decay and
`touch_accessed` entirely: a plain filtered `select` on `memory_view` ordered by `created_at desc, id`, paged in SQL
with `limit`/`offset` (cap `MAX_BROWSE_LIMIT` = 400, versus 100 for ranked reads). Ranked search has no offset, because
decay re-sorts after SQL.

**Links.** `memory_links(from_id, to_id, type)` holds typed one-way links between memories. A link is visible only to a
member who can read both ends and while neither is soft-deleted (the select policy, like `thread_links`), so no error or
count may hint at a link the caller can't see (accepted exception: the 100-outgoing-link cap error, which only a writer
of the memory's scope can trigger, because `relates-to` is stored from the end the caller can write). Writes go through
`relate_memories` / `unrelate_memories` (per-type write rules, a cap of 100 outgoing links per memory);
`memory_neighbours` (breadth-first walk) and `memory_links_for` run as the caller. `PgMemoryStore.addLinks` attaches
`links`, `moreLinks` and `superseded` to search, browse, `find_related` and `list_recent` results with one batched query
per result set. A superseded memory is flagged, not demoted. Design:
`docs/superpowers/specs/2026-11-22-memory-links-design.md`.

**Claims.** `memory_claims` holds at most one claim per memory (primary key `memory_id`): member, optional session,
reason, `claimed_at`, `expires_at` (null = indefinite). A claim is active while unexpired, its memory is readable and
undeleted (the select policy), and `claim_holder_active` says its member is not deactivated. `claim_memory` and
`release_claim` take an advisory lock per memory, so two callers cannot both find it free. The holder is the pair
(member, session), with a null session equal only to null: another session of the same member is refused unless `force`,
and refusals come from `claim_held_message`. A named session that does not resolve is `Session not found`, never "no
session". `claim_next` scans candidates oldest first and takes each one's lock with `pg_try_advisory_xact_lock`,
skipping a locked one rather than waiting, then re-checks it under the lock; being security definer, it applies
`can_read`, `can_write`, soft delete and "not superseded by a readable memory" itself. `PgMemoryStore.addClaims`
attaches `claim` next to every `addLinks` call, from one batched `memory_claims_for` query. Claims never block `update`
or `delete`. A pre-migration backup must use the pre-claims `backup.ts`, because the new one reads `memory_claims`.
Design: `docs/superpowers/specs/2026-11-22-memory-claims-design.md` and
`docs/superpowers/specs/2026-11-23-claims-by-session-graph-claim-next-design.md`.

**Graph.** `PgMemoryStore.graph` needs no SQL function: it runs as the member, selects `memory_view` with the search
filters (tags or tags_all required) oldest first, capped at `GRAPH_MAX_NODES` (400) or `GRAPH_FULL_MAX_NODES` (100) for
full content, with `count(*) over ()` as `total`, then reads `memory_links` between those ids (the links policy hides
unreadable or deleted ends), the superseded set, and the batched claims. No decay and no `touch_accessed`.

**Blackboard skill.** `skills/blackboard/` is a Claude Code skill, made of instructions only, that runs shared-goal
boards on these tools: graph, claim_next, claims, links and search browse. It has no server code of its own. The design
is in `docs/superpowers/specs/2026-11-23-blackboard-skill-design.md`. Test a change to it the way the plan
`docs/superpowers/plans/2026-11-23-blackboard-skill.md` did: subagents run single cycles on a throwaway `board:toy-*`
board in `agent-memory-tool`, and the board is deleted afterwards. This repo holds the maintained copy; projects keep
only their board files.

**Board runner.** `runner/` is Python 3.11+, standard library only, with `unittest` tests (CI job `runner`). It drives a
board from a TOML board file. Design: `docs/superpowers/specs/2026-11-24-board-runner-design.md`.

- **Processes:** it keeps the lead as an interactive `claude` session in tmux, and starts one fresh `claude -p` worker
  per intent, per configured slot.
- **Board-blind:** it never touches shared memory. Sessions run the skill in `runner` mode and end with a `BOARD-WORK`,
  `BOARD-LEAD` or `BOARD-START` line, which `protocol.py` parses. A Stop hook (`hook.py`) appends each lead turn to
  `events.jsonl`.
- **Scheduler:** `scheduler.py` is pure, with events in and actions out, so every scheduling rule is unit-tested with a
  fake clock. `cli.py` is the I/O loop around it.
- **Tests:** change the scheduler test-first. Test runner-mode skill changes with subagents on toy boards, as above.

**Web UI.** `web/` is a local, read-only app started with `deno task web`: a Deno server (`web/server.ts`, helpers in
`web/lib/`) and a plain ES-module browser app with vendored Cytoscape (`web/public/`, no build step). Design:
`docs/superpowers/specs/2026-11-26-web-ui-design.md`.

- **Data:** the server talks only to the `web-api` Edge Function (`supabase/functions/web-api/index.ts`, routes in
  `_shared/web-api.ts`), never to Postgres. It adds the token from `.env` and forwards only an allow-list of GET routes
  (`/api/scopes`, `boards`, `graph`, `memories`, `memories/:id`), so the token never reaches the browser. It binds to
  `127.0.0.1` and checks `Host`.
- **web-api:** read-only routes on `PgMemoryStore` as the caller, with the embedder built lazily so only text search
  loads it. Browse and ranked search from here do not count as an access. There is no history route.
- **Worker logs:** `/logs/<board>/<label>` reads the runner's `workers/<slot>-<label>.jsonl` from `~/.board-runner` (or
  `$BOARD_RUNNER_HOME`). The label is untrusted text from a `By:` line, so it must match the shape `new_label` makes,
  and the real path must stay inside that board's `workers/`. The server picks the byte offsets, so the browser never
  splits a UTF-8 sequence.
- **Live:** the browser polls `/graph` every `POLL_MS` (3 s) while the tab is visible and diffs each result. Hosted
  `/graph` takes about 0.3 s whatever the board's size, mostly network and auth.
- **Tests:** pure helpers are split from DOM modules so they run under `deno task test:unit`. `deno task check`
  type-checks `web/lib` and `web/server.ts`. The browser modules are checked by hand against a toy board.

**CPU budget.** Edge Function CPU is counted per worker, so a request should stay under about 1 s. Embedding is
sequential, `store_batch` is capped at 2 memories, and `recall` embeds at most 5 topics. Limits are in
`_shared/limits.ts`. A 546 means the platform recycled a busy worker: retry once.

**Scripts** (`scripts/`) are Deno CLIs that connect as postgres via `AGENT_MEMORY_DB_URL`: `setup.ts` (one-command
install; its human member becomes the first admin), `admin.ts` (on `scripts/lib/admin-db.ts`), `backup.ts`, `import.ts`
(with the Node `lancedb-export/` exporter), `smoke.ts` and `configure-claude.ts`. They import the shared code from
`supabase/functions/_shared/` by relative path.

## Rules that bite

- **Schema changes are always a new migration.** Every migration on `main` is already applied to production: never edit
  one. A change must build from empty with `supabase db reset`. Scripts only read and write rows.
- **Imports under `supabase/functions/` are inline pinned specifiers** (`npm:postgres@3.4.5`,
  `npm:@modelcontextprotocol/server@2.4.0`, `npm:zod@4.6.7`). The `no-import-prefix` lint rule is disabled for this,
  because the Edge bundler resolves them without an import map. Tests use the `@std/assert` import-map entry.
- **Errors reaching a client are user-safe.** `StoreError` text is returned as is; any other database error is logged
  and becomes `Database error`. "Memory/Scope … not found" must read the same whether the thing is absent or just
  unreadable.
- **postgres.js turns `timestamptz` parameters into JS Dates and drops the microseconds.** Bind timestamps as text and
  cast (`${x}::text::timestamptz`) wherever they must round-trip, as in backup, restore and import.
- **Hosted changes need the user's own consent for each run.** `supabase db push --remote` and
  `supabase functions deploy agent-memory --use-api` refuse in agent mode without `--yes`. Only add it once the user has
  said yes to that run. Run `--dry-run` first, and take a backup
  (`deno run --env-file=.env -A scripts/backup.ts backup --out <private path>`) before a migration.
- **Credentials live in the gitignored `.env`** (`.env.example` lists the keys). Load it with `set -a; . ./.env; set +a`
  or `deno run --env-file=.env`. Use its `SUPABASE_ACCESS_TOKEN` instead of `supabase login`: the machine's global CLI
  login may be a different account. Never print `.env` values.
- **The repo is public:** no project ref, company, customer or personal names in committed files. Docs use
  `<project-ref>`.
- **Clean up test rows with fixed or suffixed literal names.** Delete commands built from shell variables are blocked by
  the safety check. Integration tests create uniquely suffixed fixtures (`tests/helpers/fixtures.ts`) and clean up in
  `finally`.

## Shared memory for this project

When the `shared-memory` MCP tools are available, store this project's development memories in scope
**`agent-memory-tool`**, tagged `repo:agent-memory-supabase` and exactly one `status:open|in-review|blocked|done`, plus
`pr:<n>` where relevant. Search it before investigating, and `update` an existing memory rather than storing a
duplicate.
