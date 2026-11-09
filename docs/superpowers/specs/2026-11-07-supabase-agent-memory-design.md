# Supabase-hosted agent memory — design

Date: 2026-11-07
Status: approved

## 1. Intent

[agent-memory-mcp](https://github.com/adamrdrew/agent-memory-mcp) (Adam Drew, `@adamrdrew/agent-memory-mcp`) gives AI
agents persistent memory: a stdio MCP server writing to a LanceDB folder on one machine, with local ONNX embeddings.
This project builds on the [chalfontchubby fork](https://github.com/chalfontchubby/agent-memory-mcp), which fixes
upstream bugs that made the memory forget records. It works well for one person on one machine, but:

1. **It depends on one machine.** Cloud sessions, bots and other machines can't reach it.
2. **It can't be shared.** The PredBat open-source maintainers and their bot should share one development memory,
   so what one learns, the others see.
3. **It should be reusable.** The same code should be installable into any other Supabase project that wants a
   shared memory pool for its own agent bots.

This project is a hosted memory service on Supabase that keeps the existing tools (`store`, `search`, `recall`, …)
and adds **scopes** (named memory pools) with **per-member, per-scope access** enforced by Postgres row-level
security.

## 2. Decisions

- **New project, not a fork.** Public repo under the `springfall2008` GitHub account. Licence GPL-3.0 (inherited —
  it reuses design and code from agent-memory-mcp). The README credits Adam Drew's agent-memory-mcp and links it.
- **Hosted on Supabase.** A new free Supabase project for PredBat open source. It is the long-term home of the
  open-source memory, not just a test bed. Development and testing happen with the PredBat open-source bot.
- **The MCP server is a Supabase Edge Function.** Clients connect with a URL and a personal token; nothing is
  installed locally.
- **Each human member has a Supabase login and a long-lived token.** Bots are members too.
- **Everything lives in an `agent_memory` schema**, so it can be installed into an existing project without
  colliding with its tables.
- **Scopes.** Every memory belongs to exactly one scope (e.g. `predbat-devs`).
- **Access per member per scope is read-only or read-write.** Only an admin creates scopes and grants/revokes access.
- **Enforcement is RLS**, not just server code.
- **Moving a memory between scopes needs write on both.**
- **Read-only members still bump access counts** (access tracking is not a content change), but can't change
  content, category, tags or scope.
- **Admin is a script to start with.** A web UI may come later.
- **`list_scopes`** shows the caller's scopes and access level. Read tools search all readable scopes by default or
  only named ones. `store` and `update` take a scope.
- **Tokens are our own**: issued by the admin script and stored hashed in the project. This needs only a table and
  the Edge Function, so it works on the free tier.
- **A backup script.**
- **Embedding**: one embedding per Edge Function call for normal calls.
- **One-off import** of a maintainer's existing local LanceDB memories, by script — **open-source material only**.
  Which memories qualify is chosen at import time, with a reviewed dry run.

## 3. Goals

1. The maintainers and the open-source bot all read and write `predbat-devs` from any machine or cloud session
   using only an MCP URL and a token.
2. The tool surface stays compatible with agent-memory-mcp, so existing agent instructions (e.g. `repo:` /
   `status:` tag conventions, "update, don't store a duplicate") keep working with only a scope added.
3. A member can never read a scope they weren't granted, nor change a scope they only have read on — proven by tests
   that run against real Postgres RLS, not mocks.
4. Nothing blocks a later install into a different, existing Supabase project from the same code: no
   project-specific names, and nothing that assumes the members are that project's `auth.users`.
5. Search quality comparable to the original: hybrid keyword + semantic with RRF, temporal decay, evergreen
   exemption.

## 4. Non-goals

- A web UI for admin or browsing (possible later).
- Installing into any other project, or migrating memory that isn't open-source material.
- A local/offline mode or keeping a LanceDB backend.
- Syncing with the old local store after the one-off import.

## 5. Anti-goals (a failure even if it "works")

- **Any cross-scope leak**, including via search ranking, `find_related`, `stats`, error messages or IDs.
- **Silent data loss.** A partial update — tags only, category only, scope only — changes just those fields and
  never loses the memory.
- **Less reliable than the local store** in day-to-day use.
- **Secrets in the repo.** The repo is public; service-role keys and tokens live only in Supabase/GitHub secrets.
- **Private or third-party personal data in the open-source memory**, whether by import or by later use. The bot
  reads public GitHub input, so anything in its readable scopes may end up in a public comment.

## 6. Constraints

- **Supabase free tier**: the project pauses after ~7 days without activity; 500 MB database; an Edge Function
  CPU-time limit per request and invocation quotas. See §7.8 for how embedding fits inside it.
- **Embeddings**: Supabase's built-in `gte-small` (384 dimensions) in the Edge Runtime — no external API or key.
  It is a different model from the original's MiniLM, so imported memories are re-embedded, not copied.
- **Edge Functions run on Deno.** The original is Node/TypeScript; reuse logic (tool schemas, decay maths, result
  shapes), not the LanceDB store.
- **Installs are independent.** Two projects running this share code only.

## 7. Shape of the system

```
MCP client (Claude Code, bot)
   │  HTTPS, MCP streamable-HTTP, Authorization: Bearer <personal token>
   ▼
Edge Function `agent-memory`
   ├─ resolve token → member id (reject revoked/expired/unknown)
   ├─ embed text with gte-small
   └─ run queries *as that member*, so RLS applies
   ▼
Postgres schema `agent_memory`  (pgvector + full-text search + RLS)
```

### 7.1 Data model (outline — builder finalises columns and indexes)

- `scopes` — `id`, `name` (unique slug, e.g. `predbat-devs`), `description`, `created_at`.
- `members` — the principals of this memory: `id`, `display_name`, `kind` (`human` | `bot`), optional
  `auth_user_id` (→ `auth.users`). Human members get a Supabase login linked here; bots need no `auth.users` row.
  A host project's `auth.users` may carry its own signup triggers, so the `agent_memory` schema adds **no**
  triggers to `auth.users` and never requires a row there.
- `scope_grants` — `scope_id`, `member_id`, `access` (`read` | `write`), `granted_at`, `granted_by`.
  One row per member per scope. `write` implies read.
- `memories` — `id` (uuid), `scope_id`, `content`, `category` (the 12 original categories), `tags` (`text[]`),
  `created_at`, `updated_at`, `created_by`, `updated_by` (→ `members`), `access_count`, `last_accessed_at`,
  `deleted_at`, `embedding vector(384)`, generated full-text column.
- `memory_history` — a row per change (insert, update, move, delete, restore): who, when, and the previous
  content/category/tags/scope.
- `access_tokens` — `id`, `member_id`, `name` (e.g. "laptop", "open-source bot"), token **hash only**,
  `created_at`, `last_used_at`, optional `expires_at`, `revoked_at`.

### 7.2 Access rules (RLS)

- Read a memory ⇔ caller has any grant on its scope.
- Insert ⇔ `write` grant on the target scope.
- Update ⇔ `write` on the current scope **and** (`WITH CHECK`) `write` on the resulting scope.
- Delete ⇔ `write` on its scope.
- Access tracking (`access_count`, `last_accessed_at`) goes through one narrow function that can touch only those
  two columns, on memories the caller can read. Keep the original "count at most once per hour" behaviour.
- `scopes` and `scope_grants`: members see only their own grants and the scopes they cover. Writes are admin-only
  (service role via the admin script).
- `access_tokens`: never readable by clients; validated server-side only.

**Requirement on the mechanism:** the function executes member operations under a member identity that RLS
evaluates and that clients cannot set themselves, never as a role that bypasses RLS. Because members aren't
necessarily `auth.users`, policies key on the **member id**, not `auth.uid()`. The suggested mechanism is a
dedicated non-`BYPASSRLS` database role used only by the function, with the member id set transaction-locally after
token validation; the builder verifies it against current Supabase docs. The `agent_memory` schema is **not**
exposed through the PostgREST/Data API, so a Supabase login alone can't reach the tables. A test proves a client
can't spoof another member.

**Tokens**: opaque long-lived tokens issued by the admin script and stored hashed in `access_tokens`. Supabase's own
session JWTs expire hourly and MCP clients handle refresh badly, so they aren't used as the MCP credential.

### 7.3 Tools

All original tools keep their names and argument shapes, plus scope handling. Every returned memory includes
`scope` and `created_by`/`updated_by` (member display name).

| Tool | Change |
|------|--------|
| `list_scopes` | **New.** Scopes the caller can access, with `read`/`write` and a memory count. |
| `store` | Adds required `scope`. Needs `write`. |
| `store_batch` | Adds required top-level `scope` for the batch. Needs `write`. Capped (§7.8). |
| `search` | Adds optional `scopes: string[]`; default = all readable. Naming an unreadable scope is an error. |
| `recall` | Adds optional `scopes`, same default. |
| `find_related` | Adds optional `scopes`; default = all readable. Never returns memories outside them. |
| `list_recent` | Adds optional `scopes`. |
| `update` | Adds optional `scope` (move). Omitted fields are left untouched. |
| `delete` | Needs `write` on the memory's scope. Soft delete (§7.7). |
| `stats` | Adds optional `scopes`; breakdown per scope as well as per category. |
| `prune` | Requires `scope`; needs `write`. Dry run by default, as in the original. |

There is no default scope: `store` always names one. Error messages never reveal whether a memory exists in a scope
the caller can't read ("not found" either way).

### 7.4 Search

Port the original behaviour onto Postgres:

- **Hybrid** = Postgres full-text rank + pgvector cosine, fused with RRF (k = 60), with over-fetch then filter.
- **Keyword** and **semantic** modes.
- Filters: category, tags (any-of), tags_all (every one; added later as a 10-argument `search_memories`), before/after,
  limit, scopes.
- **Temporal decay**: half-life 30 days default (configurable), the original importance multiplier (access
  frequency and recency stretch the half-life, range 1–3×), and the `evergreen` / `never-forget` exemption.
  Re-sort after decay.

Where to compute decay (SQL vs TypeScript) is the builder's call; port the original `temporal-decay.test.ts`.

### 7.5 Admin script

A CLI run by an admin with the service-role key (from an env var, never committed):

- `create-scope <name> [--description]`, `list-scopes`
- `create-member <name> --human <email> | --bot`, `grant <member> <scope> read|write`, `revoke <member> <scope>`,
  `list-grants`
- `issue-token <member> <name> [--expires]` — prints the token **once**; only the hash is stored.
  `list-tokens <member>`, `revoke-token <id>`
- `restore <memory-id>` (undo a soft delete)

### 7.6 Import script

One-off: read an existing LanceDB database (or its hardcopy JSON) and load memories into a named scope through the
same code path as `store`, re-embedding with `gte-small`, **one memory per Edge Function call**. Preserve `id`,
`created_at`, `updated_at`, `access_count`, `last_accessed_at`, category and tags. Dry run by default: lists every
memory it would import (first line, category, tags) plus counts, so a maintainer reviews the selection before a real
run. Selection is by include/exclude tag filters (e.g. include `repo:batpred`) plus an optional explicit ID list,
because a tag filter alone may let private memories through.

### 7.7 Undo and backup

Several members and bots will hold `write`, which allows `delete` and `prune` on everyone's memories, and the free
tier has no downloadable backups. So:

- `delete` and `prune` are **soft** (set `deleted_at`). Soft-deleted rows are invisible to every tool. The admin
  `restore` brings one back. Tombstones are hard-deleted after 30 days by a scheduled job.
- `memory_history` records every change with the member who made it, so a bad bot run can be traced and reversed.
- **Backup script**: `backup [--scope]` writes every live and soft-deleted memory, plus scopes, grants and members
  (never token hashes), to a local JSON file in the original hardcopy shape plus scope. `restore-backup` loads one
  into an empty install. Scheduling it, and where the files are kept, is decided later — not in this public repo.

### 7.8 Embedding limits

Design rule: **one embedding per Edge Function call** wherever possible.

- `store`, `update` (when content changes) and `search`: one embedding each.
- `store_batch`: kept for compatibility, but capped at what the spike shows fits in one call. Over the cap it
  returns a clear error telling the agent to split the batch. The importer doesn't use it.
- `recall` with several topics needs one embedding per topic. It batches them in a single model call and caps the
  topic count at what the spike shows fits, falling back to keyword-only for the extra topics rather than failing.
- `find_related` reuses the stored vector, so it needs no embedding.
- `gte-small` reads at most 512 tokens. Longer memories are embedded from their leading text, while keyword search
  still covers the full content.

The first task is a spike on the free project measuring CPU per single embed, per multi-embed and per hybrid
search. If even a single embed doesn't fit the free-tier CPU limit, work stops for a maintainer decision rather than
quietly switching to a paid plan or an external API.

### 7.9 Connecting a client

The README documents the `.mcp.json` / `claude mcp add` entry: an HTTP MCP server with the function URL and an
`Authorization: Bearer` header, plus suggested CLAUDE.md wording for which scope to store into. It recommends a
server name other than `agent-memory` (e.g. `predbat-memory`), so it can run alongside a local agent-memory-mcp.

## 8. Testing and delivery

- **Local**: Supabase CLI local stack for migrations, RLS and SQL search tests. RLS tests run as real members
  (read-only, read-write, ungranted, spoof attempts), not with the service role.
- **Unit**: tool handlers and decay maths with mocks, as the original does.
- **End-to-end**: deploy to the free project; a smoke test runs every tool through the real MCP endpoint with a
  test token.
- **CI**: GitHub Actions runs lint, unit tests and the local-stack RLS tests on every PR. Deploying to the free
  project is the builder's call (manual or on `main`).

### Rollout

1. Repo, migrations and function deployed to the free project.
2. Admin script creates `predbat-devs`; the maintainers and the open-source bot get `write`.
3. Import the reviewed open-source memories (dry run → maintainer checks the list → real run).
4. The open-source bot switches over; maintainers add the hosted server alongside any local one.

## 9. Left to the builder

- Package layout (one repo holding `supabase/` migrations and functions, plus `scripts/`).
- MCP library on Deno (official TS SDK vs a lighter one) and stateless vs session transport.
- Tool count: the original has 10 tools (its README lists 9); keep all 10 plus `list_scopes`.
- Exact schema, indexes (HNSW vs IVFFlat — at this size either), full-text configuration.
- RLS mechanism details within §7.2's requirement.
- Token format (a prefix such as `amm_…` makes a leaked token recognisable).
- `store_batch` and `recall` topic caps, from the spike's measurements.
