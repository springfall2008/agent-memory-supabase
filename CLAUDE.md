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
- **MCP server:** a fresh, stateless McpServer is built per request. `registerTools` (`_shared/tools.ts`) adds the 11
  memory tools, and `registerThreadTools` (`_shared/thread-tools.ts`) the 11 thread tools, so every member gets 22.
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
