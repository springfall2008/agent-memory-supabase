# Memory Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-expiring (or indefinite) per-member claims on memories, three tools to claim, release and list them, and a `claim` field on every memory a read tool returns.

**Architecture:** One new migration adds `memory_claims`, its row-level security, a holder-state helper and four SQL functions (`claim_memory`, `release_claim`, `memory_claims_for`, `my_claims`). `PgMemoryStore` gains `claim`, `release`, `myClaims` and `addClaims` (one batched query per result set). `tools.ts` registers the three tools. Backup, restore, smoke, e2e and docs follow.

**Tech Stack:** Postgres (plpgsql, RLS, pgTAP), Deno, `postgres.js`, zod, the MCP server SDK pinned in the repo.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-claims-design.md`. Executors read it with this plan. Work on a branch `feat/memory-claims` cut from `docs/memory-claims-design`. PR #12 (`neighbours` detail) touches `handleNeighbours`; if it merges first, rebase and keep both changes (short mode must keep the `claim` field, which it does by keeping every key but `content`).

## Global Constraints

- New migration `supabase/migrations/20261122200000_memory_claims.sql`, built from empty with `supabase db reset`. Tasks 1 and 2 both add to it; it has never been applied anywhere hosted. Never edit an older migration.
- Every SQL function: `set search_path = ''`, fully qualified names, `revoke execute ... from public`, `grant execute ... to agent_memory_member`. Members get `select` only on `memory_claims`.
- A claim is **active** when `expires_at is null or expires_at > now()`, its memory is not soft-deleted, and its holder member is not deactivated.
- The holder is the **member**. The session is recorded for information only and shown **only to the holder**.
- `minutes`: integer 1 to 5,256,000, default 60 (applied in TypeScript). `indefinite: true` means `expires_at` null and cannot be combined with `minutes`. Description: 1 to 200 characters after trimming, stored trimmed.
- Claim, release and force need read on the memory and write on its scope. "Not found" reads the same for absent and unreadable ids. Claims are advisory: nothing here may block `update` or `delete`.
- Repo is public: no project refs, company, customer or personal names in committed files. Build and test locally only; hosted deploy (backup with the pre-claims script, migration first, then function) is a separate step needing the maintainer's yes.

## Review Focus

1. **Leaks.** A claim on a memory the caller cannot read never appears; an absent and an unreadable id give the same error; another member's session never appears in any result (Tasks 1, 2, 4).
2. **Expiry boundaries.** An expired claim is free: another member claims it without `force`, it is not shown on reads, and `my_claims` omits it; an indefinite claim never expires (Tasks 1, 2, 3).
3. **Deactivated holder.** Their claim is inactive everywhere: free to claim, absent from reads and `my_claims` (Tasks 1, 2).
4. **Concurrency.** Two simultaneous claims on one memory: exactly one wins, the other gets the "already claimed" failure (Task 3).
5. **Renewal from another session.** Same member, different session renews without `force` and the result carries `previousSession`; a different member gets the conflict (Tasks 1, 3).

---

## File Structure

- Create `supabase/migrations/20261122200000_memory_claims.sql`.
- Create `supabase/tests/database/14_memory_claims.test.sql` (writes, rules) and `15_memory_claims_read.test.sql` (batched lookup, `my_claims`).
- Modify `supabase/functions/_shared/limits.ts`, `types.ts`, `pg-store.ts`, `tools.ts`.
- Create `tests/integration/pg-store-claims.test.ts`; modify `tests/unit/tools.test.ts`, `tests/unit/links-limits.test.ts` (or add `tests/unit/claims-limits.test.ts`).
- Modify `scripts/backup.ts` (+ `tests/integration/backup.test.ts`), `scripts/smoke.ts`, `tests/e2e/function.test.ts`, `README.md`, `CLAUDE.md`, `docs/claude-md-sample.md`.

pgTAP fixtures for Tasks 1 and 2 (insert style as in `12_memory_links.test.sql`): scopes `s1`, `s2`; members `w` (write s1, s2), `w2` (write s1), `r` (read s1), `o` (no grants), `d` (write s1, set `deactivated_at` later in the file where a case needs it); memories `m1`, `m2`, `m3` in `s1`, `m4` in `s2`; sessions `w-a` and `w-b` for `w`, `w2-a` for `w2`.

---

### Task 1: Table, policy and write functions

**Files:** Create the migration; Test `supabase/tests/database/14_memory_claims.test.sql`.

**Interfaces — Produces (SQL):**
- table `agent_memory.memory_claims(memory_id uuid primary key references memories(id) on delete cascade, member_id uuid not null references members(id), session_id uuid null references agent_sessions(id) on delete set null, description text not null, claimed_at timestamptz not null default now(), expires_at timestamptz null)`, checks: `pg_catalog.length(description) between 1 and 200`, `expires_at is null or expires_at > claimed_at`.
- `agent_memory.claim_holder_active(p_member uuid) returns boolean` (security definer, stable): true unless that member is deactivated. Needed because the members policy may hide rows from the caller.
- policy `memory_claims_select`: `exists (select 1 from agent_memory.memories m where m.id = memory_id)`.
- `agent_memory.claim_memory(p_memory uuid, p_description text, p_minutes int, p_indefinite boolean, p_force boolean, p_session uuid) returns table (expires_at timestamptz, overridden_by text, overridden_until timestamptz, overridden_description text, overridden_indefinite boolean, previous_session_id uuid, previous_session_label text)` (security definer). Exactly one row.
- `agent_memory.release_claim(p_memory uuid, p_force boolean) returns boolean` (security definer).
- Exact messages (P0001): `Description must be 1-200 characters`; `Pass minutes or indefinite, not both`; `minutes must be between 1 and 5256000`; `Memory <id> not found` (via `require_memory_readable`); `No write access to scope '<name>'`; `Memory <id> is claimed by <name> until <YYYY-MM-DDTHH:MI:SSZ>: <description>` or, for an indefinite claim, `Memory <id> is claimed by <name> indefinitely: <description>`; `Memory <id> is claimed by <name>; pass force to release another member's claim`.

- [ ] **Step 1: Write the failing pgTAP file** with these assertions (as each member via `set_config('agent_memory.member_id', ...)` + `set local role agent_memory_member`):
  - Privileges: `anon` cannot execute `claim_memory(uuid, text, int, boolean, boolean, uuid)` or `release_claim(uuid, boolean)`; a member `insert into memory_claims` throws `42501`.
  - Validation as `w`: description `'   '` and a 201-character one throw `Description must be 1-200 characters`; `p_minutes = 5` with `p_indefinite = true` throws `Pass minutes or indefinite, not both`; `0` and `5256001` throw `minutes must be between 1 and 5256000`.
  - Access: `r` claiming `m1` throws `No write access to scope 's1'`; `o` claiming `m1` throws `Memory <m1> not found`, identical in form for a random uuid.
  - `w` (session `w-a`) claims `m1` for 60 minutes: one row, `expires_at` about now + 60 minutes, `overridden_by` null, stored description trimmed.
  - `w2` claims `m1` → throws `Memory <m1> is claimed by w until ...: <description>` (assert with `throws_like` on the prefix and description).
  - `w` (session `w-b`) claims `m1` again → succeeds, new description stored, `previous_session_label = 'w-a'`; the row's `session_id` is now `w-b`.
  - `w` claims `m1` with no session → succeeds, `previous_session_label = 'w-b'`, stored `session_id` null.
  - `w2` claims `m1` with `p_force = true` → succeeds; `overridden_by = 'w'`, `overridden_description` is the last description; the row's `member_id` is `w2`.
  - Indefinite: `w` claims `m2` with `p_indefinite = true` → `expires_at` null; `w2` then gets `Memory <m2> is claimed by w indefinitely: ...`.
  - Expiry: as postgres set `m1`'s claim to `claimed_at = now() - '2 hours', expires_at = now() - '1 hour'`; `w` claims `m1` without force → succeeds (expired counts as free).
  - Deactivated holder: `d` claims `m3`; as postgres set `d`'s `deactivated_at`; `w` claims `m3` without force → succeeds.
  - Release: `w2` releasing `w`'s active claim on `m2` throws `Memory <m2> is claimed by w; pass force to release another member's claim`; with `p_force = true` → `true`; releasing again → `false`; `w` releasing its own claim on `m1` → `true`.
  - Visibility: with `w` holding `m1`, `r` sees 1 row in `memory_claims`; `o` sees 0; after soft-deleting `m1` as postgres, `r` sees 0.
  - Cascade: `agent_memory.erase(m3)` leaves no claim row; a memory soft-deleted 31 days ago is removed by `purge_tombstones()` with its claim.
  - Advisory: with `w` holding `m2`, `w2` can still `update agent_memory.memories set content = ...` on `m2` (no exception).
  - Rights change: `w2` holds `m3`; as postgres revoke `w2`'s grant on `s1`; `w` claiming `m3` without force still throws `is claimed by w2` (the claim outlives the holder's access); with force it succeeds.

- [ ] **Step 2: Run to verify failure.** Run: `supabase db reset && supabase test db`. Expected: `14_memory_claims.test.sql` fails with `relation "agent_memory.memory_claims" does not exist`.

- [ ] **Step 3: Write the table, helper, policy and grants.** As in Interfaces. Index on `(member_id, expires_at)` for `my_claims`.

- [ ] **Step 4: Write `claim_memory` and `release_claim`.** Order in `claim_memory`: validate description (trim), the minutes/indefinite pair, `require_memory_readable`, `can_write` on the memory's scope, then `pg_advisory_xact_lock(hashtextextended('claim:' || p_memory::text, 0))`, then read the existing row and decide: free (no row, expired, holder deactivated) → upsert; same member → upsert and report the previous session (id and label) when it differs from `p_session`; other member → fail unless `p_force`, else upsert and report the overridden claim. Upsert sets `member_id = current_member_id()`, `session_id = p_session`, `claimed_at = now()`, `expires_at` (null or `now() + p_minutes minutes`). `release_claim`: readable, writable, lock, then delete per the rules; an inactive leftover row is deleted and returns `false`.

- [ ] **Step 5: Run to verify it passes.** Run: `supabase db reset && supabase test db`. Expected: all files pass.

- [ ] **Step 6: Commit** `feat(claims): memory_claims table, policy and claim/release functions`

---

### Task 2: Read functions

**Files:** Modify the migration; Test `supabase/tests/database/15_memory_claims_read.test.sql`.

**Interfaces — Produces (security invoker, stable):**
- `agent_memory.memory_claims_for(p_ids uuid[]) returns table (memory_id uuid, holder text, expires_at timestamptz, description text, mine boolean, session_id uuid, session_label text)`: one row per **active** claim on a visible memory in `p_ids`. `holder` via `member_name`. `mine` is `member_id = current_member_id()`. `session_id` and `session_label` are null unless `mine`.
- `agent_memory.my_claims(p_scope_ids uuid[], p_limit int) returns table (memory_id uuid, scope text, category text, tags text[], content text, description text, claimed_at timestamptz, expires_at timestamptz, session_id uuid, session_label text)`: the caller's active claims on visible memories in `p_scope_ids` (null = any), ordered `expires_at nulls last, memory_id`, at most `p_limit`.

- [ ] **Step 1: Write the failing pgTAP file.** Fixtures: `w` holds `m1` (session `w-a`, 60 min) and `m2` (indefinite); `w2` holds `m3`; an expired claim by `w` on `m4`; `d` holds one memory and is deactivated. Assert:
  - `memory_claims_for(array[m1,m2,m3,m4])` as `w`: three rows (m4 expired is absent); `m1` row has `mine = true`, `session_label = 'w-a'`; `m3` row has `mine = false`, `holder = 'w2'`, null session.
  - As `w2`: the `m1` row has null `session_id` and `session_label`.
  - As `r` (reads s1 only): no row mentions `m4`'s scope; claims on readable memories show.
  - The deactivated holder's claim appears in neither function.
  - `my_claims(null, 100)` as `w`: `m1` then `m2` (indefinite last); with `p_scope_ids` of only `s2`, none; with `p_limit = 1`, only `m1`.
  - `anon` cannot execute either function.

- [ ] **Step 2: Run to verify failure.** Run: `supabase db reset && supabase test db`. Expected: `15_memory_claims_read.test.sql` fails with `function agent_memory.memory_claims_for(uuid[]) does not exist`.

- [ ] **Step 3: Implement both functions** in the migration; revoke from public, grant to `agent_memory_member`.

- [ ] **Step 4: Run to verify it passes.** Same command; all files pass.

- [ ] **Step 5: Commit** `feat(claims): batched claim lookup and my_claims`

---

### Task 3: Store methods

**Files:** Modify `limits.ts`, `types.ts`, `pg-store.ts`; Test `tests/unit/claims-limits.test.ts`, `tests/integration/pg-store-claims.test.ts`.

**Interfaces — Produces:**
- `limits.ts`: `CLAIM_DEFAULT_MINUTES = 60`, `CLAIM_MAX_MINUTES = 5_256_000`, `CLAIM_DESCRIPTION_MAX = 200`, `MY_CLAIMS_MAX = 100`, `CLAIM_SNIPPET_CHARS = 160`; `checkClaimMinutes(n: number): void` throws `StoreError('minutes must be between 1 and 5256000')` unless an integer in range.
- `types.ts`:
  - `export interface ClaimSession { id: string; label: string | null }`
  - `export interface MemoryClaim { by: string; until: string | null; description: string; mine?: true; session?: ClaimSession }`; `Memory` gains `claim?: MemoryClaim`.
  - `export interface ClaimOptions { minutes?: number; indefinite?: boolean; force?: boolean }`
  - `export interface ClaimResult { claimed: true; until: string | null; overridden?: { by: string; until: string | null; description: string }; previousSession?: ClaimSession }`
  - `export interface MyClaim { memory: { id: string; scope: string; category: MemoryCategory; tags: string[]; snippet: string }; description: string; claimedAt: string; until: string | null; session?: ClaimSession }`
  - `MemoryStore` gains `claim(id: string, description: string, o: ClaimOptions, s?: SessionRef): Promise<ClaimResult>`, `release(id: string, force?: boolean): Promise<boolean>`, `myClaims(scopes?: string[]): Promise<MyClaim[]>`.
- `pg-store.ts`: `resolveSession(tx, s, create = false)` gains the `create` flag (claims pass `true`, like the thread tools).

- [ ] **Step 1: Write failing tests.** Unit: `checkClaimMinutes` accepts 1 and 5,256,000, rejects 0, 5,256,001, 1.5, NaN. Integration (copy `withWorld` from `pg-store-links.test.ts`):
  - `claim then a second member is refused, and force takes over` (names the holder in the error; `overridden.by` set).
  - `renewal from another session reports previousSession` (labels `s-a` then `s-b`).
  - `minutes defaults to 60 and indefinite has no end` (`until` about 60 minutes ahead; `until: null`).
  - `minutes and indefinite together are refused` and `a 201-character description is refused` before any query.
  - `absent and unreadable ids give the same error`; a non-uuid id gives `Memory x not found`.
  - `release rules` (own → true, again → false, another's without force → error, with force → true).
  - `myClaims lists only my active claims, soonest first, indefinite last, with session id and label, snippet not content`.
  - `two concurrent claims on one memory: exactly one wins` (deterministic: hold transaction A open after its claim via `withMember`, start B, release A after 500 ms, assert B failed with `is claimed by` — the same shape as the links concurrency test).

- [ ] **Step 2: Run to verify failure.** Run: `deno task test:unit && deno test -A tests/integration/pg-store-claims.test.ts`. Expected: type errors (methods and types missing).

- [ ] **Step 3: Implement constants and types**, and minimal stubs for `claim`/`release`/`myClaims` in the unit-test `mockStore` so `deno task check` stays green (Task 5 replaces them).

- [ ] **Step 4: Implement `claim`, `release`, `myClaims`.** `claim` validates the id (`isUuid`), the description length after trim, `minutes` (default `CLAIM_DEFAULT_MINUTES`, `checkClaimMinutes`) and the minutes/indefinite pair before opening a transaction; resolves the session with `create = true`; calls `claim_memory`; maps timestamps with `iso`. `myClaims` resolves scopes, calls `my_claims(..., MY_CLAIMS_MAX)` and builds the snippet (`…` only when cut).

- [ ] **Step 5: Run to verify it passes.** Run: `deno task check && deno task test:unit && deno task test:int`. Expected: all pass.

- [ ] **Step 6: Commit** `feat(claims): store methods for claim, release and myClaims`

---

### Task 4: Claims on read results

**Files:** Modify `pg-store.ts`; Test `tests/integration/pg-store-claims.test.ts`.

**Interfaces:** Consumes `memory_claims_for` and `MemoryClaim`. Produces `private async addClaims(tx: Tx, memories: Memory[]): Promise<void>`: one `memory_claims_for` call for all ids; sets `claim` only on memories with an active claim; `mine: true` and `session` only when `mine`.

- [ ] **Step 1: Write failing tests:**
  - `search, browse, findRelated, listRecent and neighbours carry the claim` (a claimed memory shows `claim.by`, `until`, `description`; an unclaimed one has no `claim` key).
  - `the holder sees mine and the session; another member sees neither`.
  - `an expired claim is not shown` (age it with admin SQL).
- [ ] **Step 2: Run to verify failure.** Run: `deno test -A tests/integration/pg-store-claims.test.ts`. Expected: the three fail (no `claim` key).
- [ ] **Step 3: Implement `addClaims`** and call it next to every `addLinks` call (ranked search, browse, `findRelated`, `listRecent`, `neighbours`).
- [ ] **Step 4: Run to verify it passes.** Run: `deno task check && deno task test:unit && deno task test:int`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(claims): show active claims on read results`

---

### Task 5: The three tools

**Files:** Modify `tools.ts`; Test `tests/unit/tools.test.ts`.

**Interfaces:** Consumes the store methods. Produces `handleClaim`, `handleRelease`, `handleMyClaims`, registered as `claim_memory` (`memory_id`, `description`, `minutes?`, `indefinite?`, `force?`, plus `...sessionShape`), `release_claim` (`memory_id`, `force?`), `my_claims` (`scopes?`). Results: the `ClaimResult`; `{ released }`; `{ count, claims }`. Failure prefixes `Claim failed`, `Release failed`, `My claims failed`.

- [ ] **Step 1: Write failing unit tests** (extend `mockStore` with recording `claim`, `release`, `myClaims`): arguments pass through including the session; an empty `scopes` array becomes undefined; error prefixes; the registered schema rejects a non-boolean `force`; `registerTools registers exactly 17 tools` with `claim_memory`, `my_claims`, `release_claim` added; the `claim_memory` description states that claims are advisory, the default of 60 minutes and the `indefinite` option.
- [ ] **Step 2: Run to verify failure.** Run: `deno task test:unit`. Expected: missing handlers and the count.
- [ ] **Step 3: Implement handlers and registrations** following `handleRelate`. The `search` and `recall` descriptions gain one clause: memories show `claim` when someone is working on them.
- [ ] **Step 4: Run to verify it passes.** Run: `deno task check && deno task test:unit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(claims): claim_memory, release_claim and my_claims tools`

---

### Task 6: Backup, restore, smoke and e2e

**Files:** Modify `scripts/backup.ts`, `scripts/smoke.ts`, `tests/e2e/function.test.ts`; Test `tests/integration/backup.test.ts`.

**Interfaces:** Backup file gains `memoryClaims?: { memoryId: string; member: string; sessionId: string | null; description: string; claimedAt: string; expiresAt: string | null }[]` (member as display name). Only active claims are written; their sessions are added to `sessions` and their members to `members`. Restore reads `data.memoryClaims ?? []`, skips claims already expired at restore time, and writes a null session when the id is not in the file. The "Wrote"/"Restored" summaries gain `, N memory claims`. `BACKUP_VERSION` does not change.

- [ ] **Step 1: Write failing tests:** `backup round-trips active memory claims` (one timed, one indefinite, one expired that is not written; summaries include `2 memory claims`; restore reproduces both rows, including the session); `a scoped backup includes the sessions its claims reference`.
- [ ] **Step 2: Run to verify failure.** Run: `deno test -A tests/integration/backup.test.ts`. Expected: the new tests fail (no `memoryClaims`).
- [ ] **Step 3: Implement backup and restore.**
- [ ] **Step 4: Smoke and e2e.** `scripts/smoke.ts`: add the three tool names to `BASE_TOOLS`; steps `claim_memory` (on `id`, 5 minutes), `my_claims` (lists it), a search showing `claim.mine`, `release_claim` (true). `tests/e2e/function.test.ts`: member counts 25 → 28 (four assertions), admin 38 → 41, and a step where `rw` claims a memory, sees `claim.mine` on a search result and the claim in `my_claims`, then releases it and the `claim` key is gone.
- [ ] **Step 5: Run to verify it passes.** Run: `deno task check && deno task test:int`. Expected: pass. Do not run `smoke.ts` (hosted).
- [ ] **Step 6: Commit** `feat(claims): back up and restore claims; smoke and e2e cover the new tools`

---

### Task 7: Docs and full verification

**Files:** `README.md`, `CLAUDE.md`, `docs/claude-md-sample.md`, the spec's status line.

- [ ] **Step 1: Docs.** README: 25 → 28 tools, the three tool names, a short "Claims" section (per member, session recorded and shown only to the holder, minutes default 60 with no fixed maximum, `indefinite`, `force`, advisory). CLAUDE.md: 14 → 17 memory tools, 25 → 28 per member, a **Claims** architecture paragraph (`memory_claims`, `claim_holder_active`, the advisory lock, `addClaims`), and the pre-migration backup note (use the pre-claims backup script). Sample: when to claim (before starting work on a status memory, with a reason; release when done or parking it; check `my_claims` at session start). Spec status → `implemented (local build and tests; not yet deployed)`.
- [ ] **Step 2: Full run from empty.** Run: `supabase db reset && deno task check && deno task test:unit && supabase test db && deno task test:int`. Expected: all pass.
- [ ] **Step 3: e2e.** `supabase functions serve agent-memory`, then `deno task test:e2e`. Expected: pass with 28 and 41.
- [ ] **Step 4: Commit** `docs: describe memory claims`
- [ ] **Step 5: Stop.** No push or deploy; report what passed.
