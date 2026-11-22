# Memory Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typed, directional links between memories, three tools to create, remove and follow them, and a compact `links` summary on every memory a read tool returns.

**Architecture:** One new migration adds `memory_links`, its row-level security and four SQL functions (`relate_memories`, `unrelate_memories`, `memory_neighbours`, `memory_links_for`). `PgMemoryStore` gains `relate`, `unrelate` and `neighbours`, and attaches links to results with one batched query per result set. `tools.ts` registers the three tools. Backup, restore, smoke test and docs follow.

**Tech Stack:** Postgres (plpgsql, RLS, pgTAP), Deno, `postgres.js`, zod, the MCP server SDK pinned in the repo.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-links-design.md`. Executors read it with this plan. Work on a branch `feat/memory-links` cut from `docs/memory-links-design`.

## Global Constraints

- Schema changes are a **new migration**: `supabase/migrations/20261122120000_memory_links.sql`. It builds from empty with `supabase db reset`. Tasks 1 and 2 both add to this one file, which is allowed because it has never been applied anywhere hosted. Never edit an older migration.
- Every SQL function is `SECURITY DEFINER` (or `SECURITY INVOKER` where stated) with `set search_path = ''`, fully qualified names, `revoke execute ... from public`, then `grant execute ... to agent_memory_member`.
- Members get `select` only on `memory_links`; every write goes through a function.
- Link types: `relates-to`, `supersedes`, `derived-from`, `depends-on`. `type` is `text` with a check constraint, not an enum. Primary key `(from_id, to_id, type)`. `from_id <> to_id` is a check.
- A link is visible only if the caller can read **both** ends and neither is soft-deleted.
- A memory has at most **100 outgoing** links. Incoming links are not capped at write time.
- Results show at most **10** links per memory plus a `moreLinks` count. `neighbours`: `depth` 1 to 3 (default 1), at most **100** memories, breadth-first, `truncated` flag.
- Permissions: `supersedes` needs write on both scopes. `derived-from` and `depends-on` need write on the `from` scope and read on `to`. `relates-to` needs write on either scope. Removal needs write on either scope. All need read on both.
- "Not found" reads the same for an absent id and an unreadable id. Errors that reach a client are user-safe.
- The repo is public: no project refs, company, customer or personal names in committed files.
- Imports under `supabase/functions/` are inline pinned specifiers. `deno task check` must stay clean.
- Hosted deploy order is migration first (after a backup), then the function. Each hosted run needs the maintainer's own yes. This plan builds and tests locally only and never touches hosted.

## Review Focus

1. **Existence leaks.** A caller who can read only one end of a link must see no link, no entry in `links`, and no path through it in `neighbours`; an absent id and an unreadable id must give the identical error text (Tasks 1, 2, 3, 4).
2. **Soft delete, restore and scope move.** Soft-deleting either end hides the link, restore brings it back, and moving a memory to a scope the viewer can read makes its links appear (Tasks 1, 2).
3. **Cycles and duplicates.** `A→B→A` must terminate in `neighbours`; `relate(a,b,'relates-to')` followed by `relate(b,a,'relates-to')` is one row, and `unrelate(b,a,'relates-to')` removes it (Tasks 1, 2).
4. **Link-heavy memories.** A memory with more than 10 links shows 10 and a `moreLinks` count; a walk that hits 100 results sets `truncated`; the 101st outgoing link is refused with a plain message (Tasks 1, 2, 3, 4).
5. **`superseded` on every read path.** Ranked search, browse, `find_related` and `list_recent` (and so `recall`) all flag a memory that a visible `supersedes` link points at, and `neighbours` does not bump `access_count` (Tasks 3, 4).

---

## File Structure

- Create `supabase/migrations/20261122120000_memory_links.sql`: table, policy, grants, four functions.
- Create `supabase/tests/database/12_memory_links.test.sql` (write rules and visibility) and `13_memory_links_read.test.sql` (`memory_neighbours`, `memory_links_for`).
- Modify `supabase/functions/_shared/limits.ts` and `types.ts`: constants and types.
- Modify `supabase/functions/_shared/pg-store.ts`: `relate`, `unrelate`, `neighbours`, `addLinks`.
- Modify `supabase/functions/_shared/tools.ts`: three handlers and registrations.
- Create `tests/integration/pg-store-links.test.ts`; modify `tests/unit/tools.test.ts`; create `tests/unit/links-limits.test.ts`.
- Modify `scripts/backup.ts` (+ `tests/integration/backup.test.ts`), `scripts/smoke.ts`, `tests/e2e/function.test.ts`.
- Modify `README.md`, `CLAUDE.md`, `docs/claude-md-sample.md`.

pgTAP fixtures for Tasks 1 and 2 (copy the insert style from `supabase/tests/database/08_threads_schema.test.sql`): scopes `s1`, `s2`; members `w` (write s1, s2), `a` (write s1, read s2), `b` (read s1, write s2), `r` (read s1 only), `o` (no grants); memories `m1`, `m2` in `s1` and `m3` in `s2`, each with the 384-dim embedding `array_fill(0.1::real, array[384])::extensions.vector`. Run each assertion as the member via the same role and `agent_memory.member_id` setting the existing tests use.

---

### Task 1: Table, visibility and write functions

**Files:**
- Create: `supabase/migrations/20261122120000_memory_links.sql`
- Test: `supabase/tests/database/12_memory_links.test.sql`

**Interfaces:**
- Produces (SQL):
  - table `agent_memory.memory_links(from_id uuid, to_id uuid, type text, created_by uuid, created_at timestamptz)`
  - `agent_memory.relate_memories(p_from uuid, p_to uuid, p_type text) returns void` (security definer)
  - `agent_memory.unrelate_memories(p_from uuid, p_to uuid, p_type text) returns boolean` (security definer; true if a row was removed)
  - User-visible failures use plain `raise exception` (code `P0001`), which the store already turns into a `StoreError`.

- [ ] **Step 1: Write the failing pgTAP file `12_memory_links.test.sql`** with the fixtures above and these assertions (message text exact):
  - As `a`: `relate_memories(m1, m3, 'supersedes')` throws `No write access to scope 's2'`. As `w` it succeeds.
  - As `a`: `relate_memories(m1, m3, 'derived-from')` succeeds. As `b`: the same call throws `No write access to scope 's1'`; `relate_memories(m1, m3, 'relates-to')` succeeds; `relate_memories(m3, m1, 'depends-on')` succeeds.
  - As `r`: `relate_memories(m1, m2, 'relates-to')` throws `No write access to scope 's1'`. As `o`: it throws `Memory <m1 id> not found`, and a call with a random uuid throws the same sentence with that uuid.
  - Self link throws `A memory cannot be linked to itself`. Type `'nope'` throws `Invalid link type 'nope'`.
  - Calling `relate_memories(m1, m2, 'depends-on')` twice leaves one row. `relate_memories(m1, m2, 'relates-to')` then `relate_memories(m2, m1, 'relates-to')` leaves one `relates-to` row, and `unrelate_memories(m2, m1, 'relates-to')` returns true and leaves none.
  - Cap: use a fresh memory `m6` in `s1` so earlier links don't count. As postgres insert 100 outgoing links from `m6` to 100 extra memories; as `w` a 101st `relate_memories(m6, ...)` throws `Memory <m6 id> already has 100 outgoing links`. Incoming links to `m6` are never refused.
  - Removal: with a `m1→m3 supersedes` link, `b` (write s2, read s1) and `a` (write s1, read s2) each get `true` from `unrelate_memories` (recreate between calls); `r` throws `Memory <m3 id> not found` (cannot read `s2`).
  - Visibility on a `m1→m3` link: `w` sees 1 row in `memory_links`, `r` sees 0, `o` sees 0. After `update memories set deleted_at = now() where id = m3`, `w` sees 0; after setting `deleted_at = null`, 1 again. After moving `m3` to scope `s1` (`update ... set scope_id`), `r` sees 1.
  - Purge: `delete from memories where id = m3` as postgres leaves 0 link rows.
  - Members cannot write directly: `insert into agent_memory.memory_links ...` as `w` throws `42501`. `anon` has no execute on `relate_memories(uuid, uuid, text)`.

- [ ] **Step 2: Run to verify failure**

Run: `supabase db reset && supabase test db`
Expected: `12_memory_links.test.sql` fails with `relation "agent_memory.memory_links" does not exist`.

- [ ] **Step 3: Write the table, policy and grants in the migration.** Columns as in Interfaces; `from_id` and `to_id` reference `agent_memory.memories (id) on delete cascade`; `created_by` references `agent_memory.members (id)`; `type` check against the four types; index on `(to_id, type)`; a unique index on `(least(from_id, to_id), greatest(from_id, to_id)) where type = 'relates-to'` so a symmetric pair is one row. Enable RLS; select policy `memory_links_select` for `agent_memory_member` using `exists (select 1 from agent_memory.memories m where m.id = from_id) and exists (select 1 from agent_memory.memories m where m.id = to_id)`, the same shape as `thread_links_select` at `20261107180000_threads.sql:247`. `grant select` only.

- [ ] **Step 4: Write `relate_memories` and `unrelate_memories`.** Order of checks in `relate_memories`: validate type and self-link, then `require_memory_readable` for both ids (so absent and unreadable read the same), then the type's write rule using `agent_memory.can_write` on each memory's `scope_id` (the error names the first scope the caller lacks write on, `from` first), then the outgoing cap against `MEMORY_LINKS_OUT_MAX = 100`, then insert with `created_by = agent_memory.current_member_id()`. Duplicates, including the reversed `relates-to` pair, are a silent no-op (`on conflict do nothing`). `unrelate_memories` requires both readable, then write on either scope, and for `relates-to` deletes the row in either orientation. Revoke from public and grant to `agent_memory_member`.

- [ ] **Step 5: Run to verify it passes**

Run: `supabase db reset && supabase test db`
Expected: every pgTAP file passes, including `12_memory_links.test.sql`.

- [ ] **Step 6: Commit** `feat(links): memory_links table, visibility policy and write functions`

---

### Task 2: Reading functions

**Files:**
- Modify: `supabase/migrations/20261122120000_memory_links.sql`
- Test: `supabase/tests/database/13_memory_links_read.test.sql`

**Interfaces:**
- Produces (both `security invoker`, `stable`, so RLS decides what is visible):
  - `agent_memory.memory_neighbours(p_id uuid, p_direction text, p_types text[], p_depth int, p_scope_ids uuid[], p_limit int) returns table (id uuid, depth int, path jsonb)`. `p_direction` is `'out'`, `'in'` or `'both'`. `p_types` null means all. `path` is a JSON array, one object per step, `{"type": text, "direction": "out"|"in"|"both", "memoryId": uuid}`, where `memoryId` is the memory that step reached. Rows are ordered by `depth`, then the reaching link's `created_at` descending, then `id`, and there are at most `p_limit`. The start memory is never returned.
  - `agent_memory.memory_links_for(p_ids uuid[]) returns table (memory_id uuid, type text, direction text, other_id uuid, created_at timestamptz)`: one row per visible link end for each id in `p_ids`. `direction` is `'out'` where the id is `from_id`, `'in'` where it is `to_id`, and `'both'` for every `relates-to` link.

- [ ] **Step 1: Write the failing pgTAP file `13_memory_links_read.test.sql`.** Use the same fixtures, plus memories `m4` in `s1` and `m5` in `s2`, and links `m1→m2 depends-on`, `m2→m3 depends-on`, `m3→m1 derived-from`, `m3→m4 relates-to`, `m5→m1 depends-on`. As `w` (p_limit 100):
  - `memory_neighbours(m1, 'out', null, 1, scopes, 100)` returns exactly `m2` with path `[{"type":"depends-on","direction":"out","memoryId":m2}]`.
  - `(m1, 'both', null, 3, ...)` returns `m2, m3, m4, m5` once each, never `m1`, despite the `m3→m1` cycle.
  - `(m1, 'in', null, 1, ...)` returns `m3` and `m5`.
  - `(m1, 'out', array['depends-on'], 3, ...)` returns `m2` at depth 1 and `m3` at depth 2 with a two-step path, and not `m4`.
  - `(m4, 'out', null, 1, ...)` returns `m3` with direction `"both"` (a `relates-to` matches every direction filter).
  - With `p_scope_ids` set to only `s1`'s id, `m3` and `m5` are absent and nothing beyond `m3` is reached.
  - With `p_limit = 1`, exactly one row comes back and it is a depth-1 row.
  - As `r` (reads only `s1`): the `m1→m2` link is walkable, but `m3`, `m5` and any path through them never appear. After soft-deleting `m2` as postgres, `w` no longer reaches `m2` or `m3` from `m1` over `depends-on` out.
  - `memory_links_for(array[m1, m3])` as `w` returns, for `m1`: `m2 out`, `m3 in`, `m5 in`; for `m3`: `m2 in`, `m1 out`, `m4 both`. As `r`, rows involving `m3` or `m5` are absent. An empty array returns no rows.

- [ ] **Step 2: Run to verify failure**

Run: `supabase db reset && supabase test db`
Expected: `13_memory_links_read.test.sql` fails with `function agent_memory.memory_neighbours(...) does not exist`.

- [ ] **Step 3: Implement both functions** in the migration. `memory_neighbours` is a breadth-first recursive query over `memory_links`: expand only through memories whose `scope_id = any(p_scope_ids)` (the start memory is always allowed), keep each memory at its shallowest depth, carry the `path`, stop at `p_depth`, and join `agent_memory.memories` so soft-deleted or unreadable memories end the walk. Cycles must terminate. `memory_links_for` unions the `from_id` side (`out`, or `both` for `relates-to`) and the `to_id` side (`in`, or `both`). Revoke from public, grant to `agent_memory_member`.

- [ ] **Step 4: Run to verify it passes**

Run: `supabase db reset && supabase test db`
Expected: all pgTAP files pass.

- [ ] **Step 5: Commit** `feat(links): neighbour walk and per-memory link listing functions`

---

### Task 3: Store methods

**Files:**
- Modify: `supabase/functions/_shared/limits.ts`, `supabase/functions/_shared/types.ts`, `supabase/functions/_shared/pg-store.ts`
- Test: `tests/unit/links-limits.test.ts`, `tests/integration/pg-store-links.test.ts`

**Interfaces:**
- Produces in `limits.ts`:
  - `MEMORY_LINKS_OUT_MAX = 100` (comment: mirrored by the SQL function), `LINKS_SHOWN_MAX = 10`, `NEIGHBOURS_MAX_DEPTH = 3`, `NEIGHBOURS_DEFAULT_DEPTH = 1`, `NEIGHBOURS_MAX_RESULTS = 100`
  - `checkDepth(n: number): void` throws `StoreError('depth must be between 1 and 3')` unless `n` is an integer in 1..3
- Produces in `types.ts`:
  - `export const LINK_TYPES = ['relates-to', 'supersedes', 'derived-from', 'depends-on'] as const; export type LinkType = (typeof LINK_TYPES)[number]`
  - `export type LinkDirection = 'out' | 'in' | 'both'`
  - `export interface MemoryLink { type: LinkType; direction: LinkDirection; memoryId: string }`
  - `Memory` gains optional `links?: MemoryLink[]`, `moreLinks?: number`, `superseded?: true`
  - `export interface NeighbourOptions { direction?: LinkDirection; types?: LinkType[]; depth?: number; scopes?: string[] }`
  - `export interface Neighbour { memory: Memory; path: MemoryLink[] }`
  - `export interface NeighboursResult { neighbours: Neighbour[]; truncated: boolean }`
  - `MemoryStore` gains `relate(from: string, to: string, type: LinkType): Promise<void>`, `unrelate(from: string, to: string, type: LinkType): Promise<boolean>`, `neighbours(id: string, o: NeighbourOptions): Promise<NeighboursResult>`

- [ ] **Step 1: Write failing tests.**
  - `tests/unit/links-limits.test.ts`: `checkDepth(1)`, `checkDepth(3)` pass; `0`, `4`, `1.5`, `NaN` throw `depth must be between 1 and 3`.
  - `tests/integration/pg-store-links.test.ts` (copy the `withWorld` helper from `tests/integration/pg-store-read.test.ts:7-27`; use `rw` write alpha, `ro` read alpha, `none`, `bw` write beta, and make `rw` also write beta for cross-scope cases through `admin` grants):
    - `relate then neighbours finds the link both ways`: `relate(a, b, 'depends-on')` then `neighbours(a, {direction:'out'})` returns `[b]` with path `[{type:'depends-on', direction:'out', memoryId: b}]`, and `neighbours(b, {direction:'in'})` returns `[a]`.
    - `relate refuses absent and unreadable ids with the same sentence`: `none.relate(a, b, 'relates-to')` and `rw.relate(a, <random uuid>, 'relates-to')` both reject with `Memory <that id> not found` (substituting each id), and a non-uuid id rejects with `Memory x not found`.
    - `relate enforces the permission rules through the store`: `ro.relate(a, b, 'relates-to')` rejects with `No write access to scope`.
    - `relating past 100 outgoing links is refused`: after 100 links from `a`, the 101st rejects with `already has 100 outgoing links`.
    - `neighbours validates and reports`: `depth: 4` rejects `depth must be between 1 and 3`; a walk over 101 reachable memories returns 100 and `truncated: true`; a start id that is absent rejects `Memory <id> not found`.
    - `neighbours does not count as an access`: age the fixture two hours (`setUpdated` style from `pg-store-read.test.ts`) and assert `access_count` stays 0 after `neighbours`.
    - `unrelate returns whether a link was removed`: true, then false.

- [ ] **Step 2: Run to verify failure**

Run: `deno task test:unit && deno task test:int`
Expected: type errors and failures, because `relate`, `unrelate`, `neighbours`, `checkDepth` and the types do not exist.

- [ ] **Step 3: Implement the constants and types** exactly as listed in Interfaces.

- [ ] **Step 4: Implement `PgMemoryStore.relate`, `unrelate` and `neighbours`** in `pg-store.ts`. `relate` and `unrelate` check ids with `isUuid` (rejecting with `notFoundMemory(id)`), call the SQL functions through `this.run`, and `unrelate` returns the boolean. `neighbours` defaults `direction` to `'both'` and `depth` to `NEIGHBOURS_DEFAULT_DEPTH`, calls `checkDepth`, resolves `scopes` with `resolveScopeIds`, confirms the start memory is visible in `memory_view` (else `notFoundMemory`), asks `memory_neighbours` for `NEIGHBOURS_MAX_RESULTS + 1` rows, sets `truncated` when it got the extra row, loads the memories from `memory_view` with `rowToMemory`, and returns them in the SQL order with their `path`. No `touch`.

- [ ] **Step 5: Run to verify it passes**

Run: `deno task check && deno task test:unit && deno task test:int`
Expected: all pass.

- [ ] **Step 6: Commit** `feat(links): store methods for relate, unrelate and neighbours`

---

### Task 4: Links in read results

**Files:**
- Modify: `supabase/functions/_shared/pg-store.ts`
- Test: `tests/integration/pg-store-links.test.ts`

**Interfaces:**
- Consumes: `memory_links_for` (Task 2), `Memory.links`, `moreLinks`, `superseded` and `LINKS_SHOWN_MAX` (Task 3).
- Produces: `private async addLinks(tx: Tx, memories: Memory[]): Promise<void>` on `PgMemoryStore`. It makes **one** `memory_links_for` call for all ids, sorts each memory's rows newest first then by `other_id`, sets `links` to the first `LINKS_SHOWN_MAX` as `MemoryLink[]`, sets `moreLinks` to the remainder when positive, and sets `superseded: true` when any row is `type = 'supersedes'` with `direction = 'in'`. Memories with no visible links gain no key at all.

- [ ] **Step 1: Write failing tests** in `pg-store-links.test.ts`:
  - `search, browse, findRelated and listRecent all carry links and the superseded flag`: with `new supersedes old` and `new relates-to other`, `rw.search`, `rw.browse`, `rw.findRelated(old)` (include a similar third memory so results are non-empty) and `rw.listRecent` each return `old` with `superseded === true` and `links` containing `{type:'supersedes', direction:'in', memoryId: new.id}`; `new` has `links` with `direction:'out'` and no `superseded` key.
  - `a memory with 12 links shows 10 and moreLinks 2`.
  - `links the caller cannot see are not shown`: `ro` (reads alpha only) sees no link from an alpha memory to a beta memory, and the memory has no `links` key.
  - `relates-to appears as both`: both ends list the link with `direction: 'both'`.
  - `a result set of 20 memories gets its links correctly`: each memory's `links` match what was created, so batching did not mix them up.
  - `soft-deleting the other end drops the link from results`.

- [ ] **Step 2: Run to verify failure**

Run: `deno task test:int`
Expected: the new tests fail because results carry no `links`.

- [ ] **Step 3: Implement `addLinks`** and call it inside the transaction in `search` (ranked, after `addSessionLabels`), `browse`, `findRelated` and `listRecent`, passing the result memories.

- [ ] **Step 4: Run to verify it passes**

Run: `deno task check && deno task test:unit && deno task test:int`
Expected: all pass, including every pre-existing store test.

- [ ] **Step 5: Commit** `feat(links): show links and a superseded flag in read results`

---

### Task 5: The three tools

**Files:**
- Modify: `supabase/functions/_shared/tools.ts`
- Test: `tests/unit/tools.test.ts`

**Interfaces:**
- Consumes: `MemoryStore.relate`, `unrelate`, `neighbours` and `LINK_TYPES` (Task 3).
- Produces in `tools.ts`: `handleRelate(store: MemoryStore)`, `handleUnrelate(store: MemoryStore)`, `handleNeighbours(store: MemoryStore)`, registered by `registerTools` as `relate_memories`, `unrelate_memories`, `neighbours`.
  - `relate_memories` args `{ from_id: string; to_id: string; type: LinkType }`, result `{ related: true }`.
  - `unrelate_memories` same args, result `{ unrelated: boolean }`.
  - `neighbours` args `{ memory_id: string; direction?: LinkDirection; types?: LinkType[]; depth?: number; scopes?: string[] }`, result `{ count, truncated, results: [{ memory, path }] }`. An empty `scopes` array means all readable scopes, as elsewhere.
  - Failure prefixes: `Relate failed`, `Unrelate failed`, `Neighbours failed`. The `type` argument is a zod enum of `LINK_TYPES`.

- [ ] **Step 1: Write failing unit tests** (extend `mockStore` in `tests/unit/tools.test.ts` with `relate`, `unrelate`, `neighbours` that record calls):
  - `handleRelate passes ids and type to the store and returns related: true`.
  - `handleRelate with a store error is an isError result prefixed Relate failed`.
  - `handleUnrelate returns the store's boolean`.
  - `handleNeighbours passes direction, types, depth and scopes through, and an empty scopes array becomes undefined`.
  - `handleNeighbours returns count, truncated and results`.
  - `the registered tools reject an unknown link type`: `registered.relate_memories.inputSchema.parse({from_id:'a', to_id:'b', type:'nope'})` throws.
  - Update `registerTools registers exactly 11 tools` to `exactly 14 tools` with the sorted names including `neighbours`, `relate_memories`, `unrelate_memories`.

- [ ] **Step 2: Run to verify failure**

Run: `deno task test:unit`
Expected: type errors (the handlers do not exist) and the count test failing.

- [ ] **Step 3: Implement the handlers and registrations** following `handleFindRelated` and the `link_memory` registration style. Descriptions say what each does in a sentence and, for `relate_memories`, state the four types and what each means (`supersedes`: from replaces to; `derived-from`: from was concluded from to; `depends-on`: from only holds if to does; `relates-to`: loosely associated) and the permission rules in one line. Invalid ids are rejected in the store, not here.

- [ ] **Step 4: Run to verify it passes**

Run: `deno task check && deno task test:unit`
Expected: all pass.

- [ ] **Step 5: Commit** `feat(links): relate_memories, unrelate_memories and neighbours tools`

---

### Task 6: Backup, restore, smoke and e2e counts

**Files:**
- Modify: `scripts/backup.ts`, `scripts/smoke.ts`, `tests/e2e/function.test.ts`
- Test: `tests/integration/backup.test.ts`

**Interfaces:**
- Consumes: the `memory_links` table (Task 1).
- Produces: a `memoryLinks` array in the backup file with items `{ fromId, toId, type, createdBy, createdAt }` (`createdBy` is the member's display name, as `linkedBy` is for thread links). `BACKUP_VERSION` does not change; restore reads `data.memoryLinks ?? []` so older files still restore.

- [ ] **Step 1: Write failing tests** in `tests/integration/backup.test.ts`, next to the thread test at line 264:
  - `backup round-trips memory links`: create one link of each of the four types, back up, restore into a clean state, and assert all four rows exist with the same `type`, ends and `created_by`.
  - `scoped backup drops links to memories outside the scope`: a link from an in-scope memory to a memory in another scope is absent from the file and from the restore (mirror the test at line 299).

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A tests/integration/backup.test.ts`
Expected: the new tests fail because links are not backed up.

- [ ] **Step 3: Implement.** In the backup query only links whose **both** ends are in the backup's memory set, as the thread-link query at `scripts/backup.ts:139` does; in restore insert them after the memories, converting `createdAt` with `(${x}::text)::timestamptz` per the repo's timestamp rule.

- [ ] **Step 4: Update the smoke script and e2e counts.** In `scripts/smoke.ts` add the three tool names to `BASE_TOOLS` and add steps after `find_related`: `relate_memories` (`id` to `sibling`, `relates-to`), `neighbours` (finds `sibling` from `id`), `unrelate_memories` (returns `unrelated: true`). In `tests/e2e/function.test.ts` change the member tool counts from 22 to 25 and the admin count from 35 to 38 (lines 72-74, 174, 283).

- [ ] **Step 5: Run to verify it passes**

Run: `deno task check && deno task test:int`
Expected: all pass. Do not run `smoke.ts`: it targets the hosted function.

- [ ] **Step 6: Commit** `feat(links): back up and restore links; smoke and e2e cover the new tools`

---

### Task 7: Docs and full verification

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/claude-md-sample.md`, `docs/superpowers/specs/2026-11-22-memory-links-design.md`

- [ ] **Step 1: Update the docs.**
  - `README.md:49`: "22 tools" becomes 25 and the memory tool list gains `relate_memories`, `unrelate_memories` and `neighbours`; add a short "Links" paragraph covering the four types, the permission rules, `neighbours`, and that results show `links` and `superseded`.
  - `CLAUDE.md:40-41`: 11 memory tools becomes 14, "every member gets 22" becomes 25; add a **Links** paragraph under Architecture naming `memory_links`, the two-ends visibility rule, the 100-outgoing cap and `addLinks`'s single batched query.
  - `docs/claude-md-sample.md`: a short section on when to link: `supersedes` for a newer memory that replaces an older one both worth keeping, `derived-from` for a conclusion and its evidence, `depends-on` for prerequisites, `relates-to` otherwise; the rule "update a memory, never store a second one" stays.
  - Set the spec's `Status:` line to `implemented`.

- [ ] **Step 2: Run the full suite from empty**

Run: `supabase db reset && deno task check && deno task test:unit && supabase test db && deno task test:int`
Expected: every command passes; `supabase db reset` completes, proving the migration builds from empty.

- [ ] **Step 3: Run the e2e suite locally**

Run: `supabase functions serve agent-memory` in one shell, then `deno task test:e2e` in another.
Expected: pass, including the 25 and 38 tool counts.

- [ ] **Step 4: Commit** `docs: describe memory links`

- [ ] **Step 5: Stop.** Do not push a deploy. Report what passed, and leave the hosted steps to the maintainer: backup, `supabase db push --remote --dry-run`, push, function deploy, `smoke.ts`, each with their yes.
