# Claims by session, `graph` and `claim_next` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A claim is held by member and session together; a new `graph` tool returns a project's nodes and links in one
call; a new `claim_next` tool atomically claims the oldest free matching memory.

**Architecture:** One new migration replaces `claim_memory` and `release_claim` (holder = member + session, null equals
null, refusal text from one shared helper) and adds `claim_next` (security definer, try-lock loop). `graph` needs no SQL:
it is three store queries running as the member under RLS. Each feature then gets store, tool, unit, integration, e2e and
smoke coverage, then docs, then the bot PR update.

**Tech Stack:** Supabase Postgres (plpgsql, pgTAP), Deno, postgres.js 3.4.5, `@modelcontextprotocol/server` 2.4.0, zod 4.

**Spec:** `docs/superpowers/specs/2026-11-23-claims-by-session-graph-claim-next-design.md`

## Global Constraints

- Schema changes go in **one new migration**, `supabase/migrations/20261123120000_claims_by_session_graph_claim_next.sql`;
  never edit an existing migration. `supabase db reset` must build it from empty.
- Security definer functions: `set search_path = ''`, fully qualified names, `revoke execute ... from public`, grant to
  `agent_memory_member` only for member-callable functions.
- A security definer function bypasses RLS: it must check `can_read`, `can_write` and `deleted_at is null` itself.
- Errors reaching a client are user-safe; "Memory <id> not found" is identical for absent and unreadable ids.
- Imports under `supabase/functions/` are inline pinned specifiers.
- The repo is public: no project refs, company, customer or personal names in committed files.
- Claims: description 1-200 characters after trimming; `minutes` 1..5,256,000, default 60; `indefinite` not with
  `minutes`; advisory lock key `hashtextextended('claim:' || memory_id::text, 0)`.
- Limits: `GRAPH_MAX_NODES = 400` (short), `GRAPH_FULL_MAX_NODES = 100` (full), `GRAPH_SNIPPET_CHARS = 160`.
- Tool counts after this work: 19 memory tools, 30 per member, 43 for admins.
- Commit only on the feature branch `feat/claims-by-session-graph-claim-next`; hosted deploys only with the maintainer's
  yes for that run.

## Review Focus

1. **A named session that does not resolve on release** must give `Session not found` and must never become "no session"
   and match a session-less claim (pinned in Task 2).
2. **`claim_next` racing `claim_next`**: two open transactions get different memories and the second does not wait
   (pinned in Task 4's deterministic concurrency test).
3. **`claim_next` racing `claim_memory` on the same memory**: `claim_memory` blocks on the lock, then refuses because
   `claim_next` won (pinned in Task 4).
4. **`graph` link visibility**: a link whose other end is unreadable, soft-deleted or outside the filtered set never
   appears, and `superseded` is set only by a readable superseding memory (pinned in Task 5).
5. **A leftover inactive claim row** (expired, or by a deactivated holder) does not stop `claim_next` choosing that
   memory, and is replaced, not duplicated (pinned in Task 3).

---

### Task 1: Migration — claims held by member and session

**Files:**
- Create: `supabase/migrations/20261123120000_claims_by_session_graph_claim_next.sql` (section 1 of it)
- Modify: `supabase/tests/database/14_memory_claims.test.sql` (calls to the old signatures, the two
  `previous_session_label` assertions, the release refusal wording, the plan count)
- Create: `supabase/tests/database/16_claims_by_session.test.sql`

**Interfaces:**
- Produces: `agent_memory.claim_memory(p_memory uuid, p_description text, p_minutes int, p_indefinite boolean,
  p_force boolean, p_session uuid) returns table (expires_at timestamptz, overridden_by text, overridden_until
  timestamptz, overridden_description text, overridden_indefinite boolean, overridden_session_id uuid,
  overridden_session_label text)` — same arguments, new return columns (the two `previous_session_*` columns are gone).
- Produces: `agent_memory.release_claim(p_memory uuid, p_force boolean, p_session uuid) returns boolean`. The two-argument
  version is dropped.
- Produces: `agent_memory.claim_held_message(p_claim agent_memory.memory_claims, p_me uuid) returns text` — internal,
  security definer, execute revoked from public and not granted to members.

- [ ] **Step 1: Write `16_claims_by_session.test.sql`** with the fixture style of `14_memory_claims.test.sql` (member w
  with sessions w-a and w-b, member w2 with w2-a, one scope both write). Assertions, in order:
  - w claims m1 with w-a; w renewing with w-a succeeds and `overridden_by` is null.
  - w claiming m1 with w-b throws `throws_like` `Memory <m1> is claimed by your session 'w-a' until %: <desc>`.
  - w claiming m1 with no session throws the same `your session 'w-a'` message.
  - w claiming m1 with w-b and `p_force` succeeds; `overridden_session_label = 'w-a'`, `overridden_by = 'w'`.
  - w claims m2 with no session; w renewing m2 with no session succeeds; w claiming m2 with w-a throws
    `Memory <m2> is claimed by you without a session until %: <desc>`.
  - an indefinite claim held by w-a refused to w-b reads `... claimed by your session 'w-a' indefinitely: <desc>`.
  - a claim held by a session with no label is named by its id in the message.
  - w2 claiming m1 (held by w) still throws `Memory <m1> is claimed by w until %: <desc>` and `overridden_session_id` is
    null when w2 forces it (another member's session is never shown).
  - `release_claim(m1, false, <w-b>)` while w-a holds it throws `... claimed by your session 'w-a' until %: <desc>; pass
    force to release it`; with `p_force` it returns true.
  - `release_claim` with the holder's own session returns true; with null on a null-session claim returns true.
  - w2 releasing w's claim without force throws `Memory <m> is claimed by w until %: <desc>; pass force to release it`.
  - releasing an expired leftover row with any session returns false and removes the row.
  - `has_function_privilege('agent_memory_member', 'agent_memory.claim_held_message(agent_memory.memory_claims, uuid)',
    'execute')` is false; anon cannot execute the new `release_claim(uuid, boolean, uuid)`.
- [ ] **Step 2: Run it to see it fail.** Run: `supabase test db` · Expected: 16 fails (function signature / wording).
- [ ] **Step 3: Write section 1 of the migration.** `drop function` both old functions, create `claim_held_message`
  (formats the three refusal shapes from spec section 3: another member `claimed by <name>`, own other session
  `claimed by your session '<label or id>'`, own session-less claim `claimed by you without a session`; each followed by
  ` until <YYYY-MM-DDTHH24:MI:SSZ>: <desc>` or ` indefinitely: <desc>`), then recreate `claim_memory` and `release_claim`
  from the 20261122200000 bodies with the holder test `v_old.member_id = v_me and v_old.session_id is not distinct from
  p_session`, and `p_session` ownership checked with `owns_session` in both. Release refusals append
  `; pass force to release it`. Re-issue revoke/grant for both.
- [ ] **Step 4: Update `14_memory_claims.test.sql`** to the new signatures and wording: the two `previous_session_label`
  assertions become a refusal (`w-b` renewing a `w-a` claim) and a force (`overridden_session_label = 'w-a'`); keep every
  other assertion; fix `plan(n)`.
- [ ] **Step 5: Run.** Run: `supabase db reset && supabase test db` · Expected: all files pass.
- [ ] **Step 6: Commit.** `git add supabase/migrations/20261123120000_claims_by_session_graph_claim_next.sql
  supabase/tests/database/14_memory_claims.test.sql supabase/tests/database/16_claims_by_session.test.sql` ·
  `git commit -m "feat(claims): hold a claim by member and session"`

### Task 2: Store and tools — claims held by member and session

**Files:**
- Modify: `supabase/functions/_shared/types.ts` (`ClaimResult`, `MemoryStore.release`)
- Modify: `supabase/functions/_shared/pg-store.ts` (`claim`, `release`)
- Modify: `supabase/functions/_shared/tools.ts` (`handleRelease`, `claim_memory` and `release_claim` registrations)
- Modify: `tests/integration/pg-store-claims.test.ts`, `tests/unit/tools.test.ts`

**Interfaces:**
- Consumes: Task 1's `claim_memory` return columns and `release_claim(uuid, boolean, uuid)`.
- Produces: `ClaimResult = { claimed: true; until: string | null; overridden?: { by: string; until: string | null;
  description: string; session?: ClaimSession } }` (no `previousSession`).
- Produces: `MemoryStore.release(id: string, force?: boolean, s?: SessionRef): Promise<boolean>`.
- Produces: `release_claim` tool args `{ memory_id, force?, session?, session_label? }` (the existing `sessionShape`).

- [ ] **Step 1: Write the failing tests.**
  - Integration, replacing `renewal from another session reports previousSession`:
    - `a claim held by one session refuses another session of the same member` asserts the rejection text includes
      `is claimed by your session 's-a'`.
    - `force over an own other session reports it` asserts `overridden.session.label === 's-a'`.
  - Integration: `release with an unknown session label is Session not found and keeps the claim`. Claim without a
    session, then call `release(id, false, { sessionLabel: 'never-made' })`, then assert the rejection text is
    `Session not found` and that `myClaims()` still lists the claim.
  - Integration: `release by another session needs force`. The call without `force` rejects with
    `pass force to release it`; the call with `force` returns true.
  - Unit:
    - `handleRelease passes the session`: `{ memory_id, session_label: 'x' }` produces the store call
      `release(id, false, { sessionLabel: 'x' })`.
    - The `claim_memory` description test drops `'share a token'` and `'previousSession'` and adds `'session'`.
    - The mock store's `release` has the new signature.
- [ ] **Step 2: Run them to see them fail.**
  - Run: `deno test -A tests/integration/pg-store-claims.test.ts && deno task test:unit`
  - Expected: the new tests fail, and the type check fails on `release`.
- [ ] **Step 3: Implement the changes.**
  - `release(id, force = false, s?)` resolves the session with `this.resolveSession(tx, s, false)` and passes it to
    the new SQL. `resolve_session` already raises `Session not found` for a named session it cannot resolve; keep that
    path.
  - `claim` maps `overridden_session_id` and `overridden_session_label` into `overridden.session`. Drop the
    `previous_session` mapping.
  - Rewrite the `claim_memory` description so it says that a claim belongs to your member and session together. A
    different session of yours, or another member, is refused unless `force` is set, so always pass your session.
    Remove the shared-token caveat.
  - The `release_claim` description says to pass the same session you claimed with.
- [ ] **Step 4: Run the tests.**
  - Run: `deno task check && deno task test:unit && deno test -A tests/integration/pg-store-claims.test.ts`
  - Expected: pass.
- [ ] **Step 5: Commit.**
  - `git commit -am "feat(claims): release by session, report the overridden session"`

### Task 3: Migration — `claim_next`

**Files:**
- Modify: `supabase/migrations/20261123120000_claims_by_session_graph_claim_next.sql` (section 2), which is not yet on
  `main`, so editing it is allowed.
- Create: `supabase/tests/database/17_claim_next.test.sql`

**Interfaces:**
- Produces: `agent_memory.claim_next(p_scope_ids uuid[], p_category text, p_tags text[], p_tags_all text[],
  p_description text, p_minutes int, p_indefinite boolean, p_session uuid)`.
  - It returns `table (memory_id uuid, expires_at timestamptz)`: no rows when nothing is free, otherwise one row.
  - It is security definer and granted to `agent_memory_member`.

- [ ] **Step 1: Write `17_claim_next.test.sql`.**
  - **Fixtures:**
    - Scopes s1, where w writes and r reads, and s2, which w can only read.
    - Memories m1 to m6, created at distinct times, tagged `status:open` unless noted.
    - m1 is in s2, so it is not writable. m2 is soft-deleted. m3 is superseded by m6 (a `supersedes` link from m6 to
      m3).
    - m4 is the oldest free memory, m5 the next, m6 the newest.
    - m7 carries an expired leftover claim by w2.
  - **Assertions:**
    - The validation errors match `claim_memory`'s text (description length, minutes range, minutes together with
      indefinite).
    - A call with both `p_tags` and `p_tags_all` null throws `Pass tags or tags_all`.
    - w's first call returns m4, and its claim row has w's session and the given description.
    - The second call returns m5. Once m5 is claimed, m3 is skipped as superseded, m2 as deleted and m1 as not
      writable, so the next call returns m7 (replacing the leftover row, one row per memory). The call after that
      returns m6.
    - With everything claimed, the call returns zero rows.
    - Member o, who has no grants, gets zero rows even though matching memories exist, so nothing is revealed.
    - The `category` and `p_tags_all` filters narrow the choice.
    - A memory w already holds is never returned.
    - A superseding memory in a scope w cannot read does not make its target "superseded".
- [ ] **Step 2: Run it to see it fail.**
  - Run: `supabase test db`
  - Expected: 17 fails because the function does not exist.
- [ ] **Step 3: Write section 2 of the migration.**
  - Validate the arguments as `claim_memory` does, then `owns_session`.
  - Loop over the candidates:
    - Select from `agent_memory.memories m` where `m.scope_id = any(p_scope_ids)`, `can_read(m.scope_id)`,
      `can_write(m.scope_id)` and `m.deleted_at is null`.
    - Apply the category and tag filters.
    - Exclude memories with an active claim, using the active definition from 20261122200000, which includes
      `claim_holder_active`.
    - Exclude memories superseded by a readable, undeleted memory.
    - Order by `m.created_at, m.id`.
  - For each candidate:
    - If `pg_try_advisory_xact_lock(...)` fails, continue to the next candidate.
    - Under the lock, re-read the claim row. If it is active, continue.
    - Otherwise insert, or `on conflict (memory_id) do update` to replace a leftover row, and return the row.
  - Revoke and grant.
- [ ] **Step 4: Run the database tests.**
  - Run: `supabase db reset && supabase test db`
  - Expected: all pass.
- [ ] **Step 5: Commit.**
  - `git commit -am "feat(claims): claim_next takes the oldest free matching memory"`

### Task 4: Store and tool — `claim_next`

**Files:**
- Modify: `supabase/functions/_shared/types.ts`, `pg-store.ts`, `tools.ts`
- Modify: `tests/integration/pg-store-claims.test.ts`, `tests/unit/tools.test.ts`

**Interfaces:**
- Consumes: Task 3's `claim_next` SQL function.
- Produces:
  - `interface ClaimNextFilters { scopes?: string[]; category?: MemoryCategory; tags?: string[]; tagsAll?: string[] }`
  - `type ClaimNextResult = { claimed: true; until: string | null; memory: Memory } | { claimed: false }`
  - `MemoryStore.claimNext(f: ClaimNextFilters, description: string, o: { minutes?: number; indefinite?: boolean },
    s?: SessionRef): Promise<ClaimNextResult>`
  - The `claim_next` tool, with args `{ description, scopes?, category?, tags?, tags_all?, minutes?, indefinite?,
    session?, session_label? }`.

- [ ] **Step 1: Write the failing tests.**
  - Integration: `claim_next returns the oldest free match with links and its claim`.
    - Make three memories tagged `kind:intent` and `status:open`, then link the second `depends-on` the first.
    - The first call returns the oldest. Its `memory.claim.mine` is true and its `memory.links` is present.
    - The second call returns the next.
  - Integration: `claim_next with a new session label creates the session`.
    - After the call, `myClaims()[0].session.label` is the new label.
  - Integration: `claim_next returns claimed false when nothing is free`.
  - Integration, the deterministic concurrency test `claim_next does not wait for, or take, a memory another caller
    is claiming`:
    - Inside `withMember(sql, rw.id, ...)` run `select * from agent_memory.claim_next(...)` and hold the transaction
      open.
    - From a second store, as another writer, call `claimNext`. It resolves (wrap it in a 5-second timeout) with the
      second memory, not the first.
    - Then let the first transaction commit.
  - Integration: `claim_memory waits for claim_next and is then refused`.
    - Hold a `claim_next` transaction open, start `claim_memory` on the same memory, then commit.
    - `claim_memory` rejects with `is claimed by`.
  - Unit:
    - `handleClaimNext maps tags_all and the session`.
    - `the claim_next description says oldest, free, and tags or tags_all`.
    - The mock store gets `claimNext`.
    - `registerTools registers exactly 18 tools`, with `claim_next` in the name list.
- [ ] **Step 2: Run them to see them fail.**
  - Run: `deno task test:unit && deno test -A tests/integration/pg-store-claims.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Validation:** use the same validation as `claim`. If neither `tags` nor `tagsAll` is given, throw
    `StoreError('Pass tags or tags_all')`.
  - **Store:**
    - Resolve scopes with `resolveScopeIds`, and the session with `resolveSession(tx, s, true)`.
    - Call the SQL in the same transaction.
    - On a row, load the memory from `memory_view`, then call `addLinks` and `addClaims`.
  - **Tool:** register `claim_next` after `claim_memory`, with `sessionShape`. The description covers:
    - It claims the oldest matching memory that nobody holds and that you can write.
    - It skips superseded memories.
    - It needs `tags` or `tags_all`.
    - It returns `claimed: false` when nothing is free.
    - It never waits for another caller.
- [ ] **Step 4: Run the full test set.**
  - Run: `deno task check && deno task test:unit && deno task test:int`
  - Expected: pass.
- [ ] **Step 5: Commit.**
  - `git commit -am "feat(claims): claim_next tool"`

### Task 5: `graph`

**Files:**
- Modify: `supabase/functions/_shared/limits.ts`, `types.ts`, `pg-store.ts`, `tools.ts`
- Create: `tests/integration/pg-store-graph.test.ts`
- Modify: `tests/unit/tools.test.ts`

**Interfaces:**
- Produces:
  - `GRAPH_MAX_NODES = 400`, `GRAPH_FULL_MAX_NODES = 100`, `GRAPH_SNIPPET_CHARS = 160`
  - `interface GraphFilters { scopes?; category?; tags?; tagsAll?; detail?: 'short' | 'full' }`
  - `interface GraphNode { id: string; scope: string; category: MemoryCategory; tags: string[]; createdAt: string;
    snippet?: string; content?: string; superseded?: true; claim?: MemoryClaim }`
  - `interface GraphEdge { from: string; to: string; type: LinkType }`
  - `interface GraphResult { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; total: number }`
  - `MemoryStore.graph(f: GraphFilters): Promise<GraphResult>`
  - The `graph` tool, with args `{ scopes?, category?, tags?, tags_all?, detail? }`.
- Ruling to carry: `graph` is store queries under RLS, not a SQL function, as the spec allows (section 11). The spec's
  "pgTAP for graph visibility" is therefore an integration test here.

- [ ] **Step 1: Write the failing tests in `pg-store-graph.test.ts`.**
  - `graph returns matching nodes oldest first with every link among them`.
    - Make four `cairn:p1` memories with `depends-on`, `derived-from` and `relates-to` links, plus one untagged
      memory linked to one of them.
    - The untagged memory and its link are absent.
    - `relates-to` appears once.
    - `total` is 4 and `truncated` is false.
  - `graph short gives 160-char snippets; full gives content and caps at 100`.
    - Store 101 matches, inserting them directly with `admin` for speed.
    - `full` returns 100 nodes, `truncated` true and `total` 101.
  - `graph never shows a link to an unreadable or soft-deleted memory`.
    - Use the `World` scope a member cannot read. Soft-delete one end.
    - `superseded` comes only from a readable superseding memory.
  - `graph needs tags or tags_all`: the call rejects with `Pass tags or tags_all`.
  - `graph does not bump access counts`: `access_count` is unchanged afterwards.
  - Unit:
    - `handleGraph maps tags_all and detail`.
    - The `graph` description mentions `nodes`, `edges`, `400` and `tags_all`.
    - `registerTools registers exactly 19 tools`, with `graph` in the name list.
- [ ] **Step 2: Run them to see them fail.**
  - Run: `deno test -A tests/integration/pg-store-graph.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement `graph`.** It runs four queries in one `run`.
  1. **Nodes.** Query `memory_view` with browse's filters (no dates). Select `count(*) over ()` as `total`, order by
     `created_at, id`, and limit to the cap for `detail`.
  2. **Edges.** Query `select from_id, to_id, type from agent_memory.memory_links where from_id = any($ids) and
     to_id = any($ids)`. The RLS policy hides unreadable or deleted ends.
  3. **Superseded.** Query `select distinct to_id from agent_memory.memory_links where type = 'supersedes' and
     to_id = any($ids)`.
  4. **Claims.** Reuse `addClaims`, or call `memory_claims_for` directly.
  - The tool is registered after `neighbours`.
- [ ] **Step 4: Measure.**
  - Seed 400 nodes and about 600 links locally.
  - Time 20 `graph` calls in a scratch script in the scratchpad, not committed.
  - Ledger the median.
  - Expected: well under 300 ms each against the local DB. If it isn't, stop and investigate before continuing.
- [ ] **Step 5: Run the checks.**
  - Run: `deno task check && deno task test:unit && deno task test:int`
  - Expected: pass.
- [ ] **Step 6: Commit.**
  - `git commit -am "feat(graph): graph tool returns a project's nodes and links"`

### Task 6: Counts, e2e and smoke

**Files:**
- Modify: `tests/e2e/function.test.ts` (28→30, 41→43, `slice(0, 30)`), `scripts/smoke.ts`

- [ ] **Step 1: Update the counts and write the new e2e steps.**
  - **Session-bound claims:** claim with `session_label: 'e2e-a'`.
    - With `'e2e-b'`, the claim is refused with `your session`.
    - Releasing with `'e2e-a'` returns `released: true`.
  - **`claim_next`:** store two memories tagged with a unique `e2e-next-<suffix>`.
    - `claim_next` returns the older one, then the newer one, then `claimed: false`.
  - **`graph`:** on the same tag, it returns 2 nodes and the link made between them.
  - **Smoke:**
    - Pass `session_label: 'smoke'` to the existing `release_claim` step. Without it the release now fails.
    - Add the `graph` and `claim_next` steps, and add both names to the expected tool list.
- [ ] **Step 2: Run the tests.**
  - Run: `deno task test:unit`, then `supabase functions serve agent-memory` in another shell, then
    `deno task test:e2e`.
  - Expected: pass. Restart `serve` after any function edit.
- [ ] **Step 3: Commit.**
  - `git commit -am "test: e2e and smoke for session claims, graph and claim_next"`

### Task 7: Docs

**Files:**
- Modify: `README.md` (Claims section, the two new tools, counts), `CLAUDE.md` (Claims note, counts 19/30/43, a Graph
  note), `docs/claude-md-sample.md` (pass your session to claim and release; `claim_next` for queues; `graph` for a
  project view; drop `previousSession`), `docs/superpowers/specs/2026-11-22-memory-claims-design.md` (a note at "Who the
  holder is" pointing to the new spec), and the new spec's status line ("implemented (local build and tests; not yet
  deployed)").

- [ ] **Step 1: Edit the docs.** Afterwards, `grep -rn "previousSession\|share a token\|28 tools\|41 tools" README.md
  CLAUDE.md docs/claude-md-sample.md` should show nothing stale.
- [ ] **Step 2: Run the checks.** Run: `deno task check`. Expected: pass, including `deno fmt --check` on Markdown.
- [ ] **Step 3: Commit.** Run `git commit -am "docs: session-held claims, graph and claim_next"`.

### Task 8: batpred #6328

**Files** (in the scratch clone `.../scratchpad/batpred-memory`, branch `feat/bot-memory-links-claims`):
- Modify: `.claude/skills/issue-pr/SKILL.md`, `.claude/skills/pr-cleanup/SKILL.md`, `CLAUDE.md`

- [ ] **Step 1: Confirm today's server ignores the extra argument.** Run `supabase functions serve agent-memory`
  on `main`'s code, from a `git worktree` at `origin/main`. Then call `release_claim` with an extra `session_label`
  through a scratch MCP client. Expected: it succeeds and does not raise a validation error. If it is rejected, the bot
  change must merge **after** the deploy, not before. Ledger which it is.
- [ ] **Step 2: Edit the skills and the bot's `CLAUDE.md`.**
  - Each skill's release step passes the same session label it claimed with.
  - "another member holds" becomes "another member or session holds".
  - The bot's `CLAUDE.md` Claim bullet says the same.
- [ ] **Step 3: Run the checks.** Run `cd tools && python3 -m unittest test_triage_daemon` and the repo's cspell
  pre-commit hook on the changed files. Expected: 378 tests OK and the spelling check clean.
- [ ] **Step 4: Commit and push to the PR branch.** This needs the maintainer's yes, because the branch is shared.
  Commit message: `"feat(triage): release claims with the session that made them"`.

### Task 9: Release (each hosted step only with the maintainer's yes)

- [ ] **Step 1: Open the PR, and merge it once CI is green.** The maintainer merges it.
- [ ] **Step 2: Back up production with the current `scripts/backup.ts`.** `memory_claims` is unchanged, so the
  current script works. Then dry-run the push: `supabase db push --remote --dry-run`. Expected: only
  `20261123120000_...`.
- [ ] **Step 3: Push the migration, then deploy the function straight away.** This is the release window from spec
  section 9.
- [ ] **Step 4: Run the live checks.** Run `scripts/smoke.ts` against production. Then run a scratch live script for
  session refusal, `claim_next` order, `claimed: false` and `graph` edges. Clean up its rows with fixed literal names.
- [ ] **Step 5: Update `~/.claude/CLAUDE.md` Claims.**
  - Drop "agents that share a token count as one member".
  - Add that a claim belongs to your member and session, and that you pass your session label to `claim_memory`,
    `claim_next` and `release_claim`.
  - Add a `graph` line under Links.
- [ ] **Step 6: Update the shared-memory status memory.** Use tags `repo:agent-memory-supabase` and `status:done`,
  with the PR number. Link it with `derived-from` to c21c49f1.
