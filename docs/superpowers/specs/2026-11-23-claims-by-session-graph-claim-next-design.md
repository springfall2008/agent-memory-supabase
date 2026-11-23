# Claims held by session, `graph` and `claim_next` — design

Date: 2026-11-23
Status: implemented (local build and tests; not yet deployed)
Builds on: [memory claims](2026-11-22-memory-claims-design.md) (this changes its "who the holder is" rule) and
[memory links](2026-11-22-memory-links-design.md)

## 1. Intent

The next step is a skill that runs a Cairn-style search on top of agent memory: a shared board of **facts** (confirmed
findings), **intents** (directions not yet explored) and **hints** (human steers), linked into a graph that grows from an
origin towards a goal. A dispatcher reasons over the whole graph, writes new intents, and hands each intent to a worker
that explores it and reports one fact. Three things in the server stand in its way:

1. **A claim does not keep two sessions of one member apart.** A claim belongs to the member, so a second session of the
   same member "renews" it silently. Parallel workers sharing a token, or the bot's runs, can all win the same intent.
   The maintainer sees this as a hole in the claims design, not a documented limit to live with.
2. **No read returns a whole project's graph.** Browse returns full content and at most 10 links per memory and pages;
   `neighbours` stops at depth 3 and 100 nodes and misses anything not yet linked to its start. The dispatcher's reason
   step needs every node and every edge of a project in one call.
3. **A worker cannot take "the next free intent".** It must browse open intents and try `claim_memory` on each, and with
   several workers most attempts collide.

This design fixes all three in one server PR. The skill is designed separately, after this is live.

## 2. Decisions (the maintainer's)

- **A claim belongs to the member and the session together.** The same member and the same session renews. The same
  member from a different session fails like any other held claim, unless `force` is passed. Another member: unchanged.
- **`previousSession` goes away**, because the case it reported can no longer succeed quietly.
- **No session is its own identity.** A claim made without a session can be renewed or released without force only by a
  call from the same member that also gives no session. A session-less call never matches a claim made with a session,
  and the reverse.
- **`release_claim` follows the same rule** and gains the `session` / `session_label` arguments.
- **A new `graph` tool** (approach A, section 6) and **a new `claim_next` tool** (approach A, section 6), in the same PR as
  the claims change.
- **The bot's PR (batpred #6328), not yet merged, is updated** to pass its session label to `release_claim` and to say
  "another member or session" where it says "another member".
- Calls Claude made without being asked are marked "(Claude's call)" and collected in section 10.

## 3. Claims held by member and session

**Holder identity** is the pair (member, session), where the session may be null and null equals only null (`is not
distinct from`). Everything else about claims (advisory, lazy expiry, active = unexpired + memory readable and undeleted +
holder not deactivated, one row per memory, the advisory lock per memory) is unchanged.

**A named session that does not exist.** `claim_memory` and `claim_next` create a session for a new label, as
`claim_memory` does today, so a new worker's first call can be `claim_next`. `release_claim` never creates one: a session
id or label that does not resolve to one of the caller's sessions is the error `Session not found`. A named session must
never be treated as "no session", or it would match a session-less claim. (Claude's call. `resolve_session` with
`create = false` already raises `Session not found` for an unknown id or label and returns no row only when no session was
named; the new paths must keep that distinction and never map a named session to null.)

**`claim_memory`**, on an active claim:

| Held by | Result without `force` | With `force` |
|---|---|---|
| caller's member, same session (both null counts) | renewed, as today | renewed |
| caller's member, different session | fails: `Memory <id> is claimed by your session <label or id> until <time>: <description>` (indefinite: `... indefinitely: ...`; a session-less holder reads `without a session`) | taken over; `overridden` names it |
| another member | fails as today | taken over; `overridden` names it, as today |

The result is `{ claimed: true, until, overridden? }`. `overridden` is `{ by, until, description }` as today, plus
`session: { id, label }` when the overridden claim was the caller's own member's (the session is shown only to its
member, as everywhere else). `previousSession` is removed from the result, the `ClaimResult` type, the tool text and the
docs.

**`release_claim(memory_id, force?, session?, session_label?)`**: an active claim held by the caller's member and same
session (null equals null) is released. One held by another session of the caller's member, or by another member, needs
`force`, and fails otherwise with the same wording as `claim_memory`'s refusal, ending `; pass force to release it`. No
active claim: removes any leftover row and returns `{ released: false }`, as today.

**Read side, unchanged:** `claim.mine` still means "my member holds it" and `claim.session` is still shown only to the
holder's member, so an agent can tell its own session's claim from another of its sessions'. `my_claims` still lists every
claim of the member across sessions, which is how stale sessions are found.

**Existing claims** in production keep their member and session. A claim made before this change from a session the
member no longer uses now needs `force` (or must expire) before another session can take it: that is the intended fix.

## 4. `graph`

`graph(scopes?, category?, tags?, tags_all?, detail?)` returns the memories matching the filters and every link between
them, in one call.

- **Filters** are the existing search filters with the existing meaning: `tags` matches any, `tags_all` needs all,
  `category`, `scopes` (default: every readable scope). Dates are not needed (Claude's call). At least one of `tags` or
  `tags_all` is required, so a missing filter cannot return the oldest 400 memories of everything. (Claude's call)
- **Nodes:** oldest first (`created_at, id`), so the origin of a project comes first. Each node is
  `{ id, scope, category, tags, createdAt, snippet, superseded?, claim? }` with a 160-character snippet in
  `detail: 'short'` (the default): at most 400 nodes. With `detail: 'full'` the full content replaces the snippet and at
  most 100 nodes are returned, the ranked-read cap, because a memory can hold 20,000 characters and 400 of them would be
  megabytes. (Claude's call) `claim` is the usual
  active claim shape. `superseded: true` as on other reads.
- **Edges:** every link `{ from, to, type }` whose both ends are among the returned nodes. Links to memories outside the
  node set are not returned (the caller widened or narrowed the set by its filters). Link visibility is the existing
  `memory_links` select policy, so a link is never shown unless both ends are readable.
- **Result:** `{ nodes, edges, truncated, total }`, where `total` is how many memories matched and `truncated` is
  `total > nodes.length`. The count reveals nothing: the caller can read every memory it counts.
- **It is a read:** no `touch_accessed`, no decay, no ranking. It costs at most one query for nodes, one for edges and one
  each for the batched claims and superseded lookups, never one per node. It must stay well inside the about-1-second
  function budget at 400 nodes.

## 5. `claim_next`

`claim_next(description, scopes?, category?, tags?, tags_all?, minutes?, indefinite?, session?, session_label?)` claims
the oldest matching memory that is free and returns it.

- **Candidates:** memories that match the filters (same meaning as `graph`; at least one of `tags` or `tags_all` is
  required), that are readable and not soft-deleted, that are in a scope the caller can **write**, that are not
  `superseded`, and that have **no active claim** by anyone, the caller included. (Claude's call: a superseded intent is
  stale work; a memory the caller already holds is not "next".)
- **Order:** oldest first (`created_at, id`).
- **Concurrency:** taking a candidate uses the same per-memory advisory lock as `claim_memory` (`'claim:' || id`) so the
  two tools serialise with each other, but a candidate whose lock another transaction holds is **skipped**, not waited on
  (try-lock), and its claim state is re-checked under the lock before claiming. Two callers asking at once get different
  memories, and neither waits for the other.
- **The claim** is made with exactly the rules and arguments of `claim_memory` (description 1-200 characters, `minutes`
  default 60 up to 5,256,000, or `indefinite`, not both, the caller's session created from a new label as
  `claim_memory` does).
- **Result:** `{ claimed: true, until, memory }` where `memory` is the full memory as `search` returns it (content, tags,
  `links`, `moreLinks`, `superseded`, and the new `claim`), or `{ claimed: false }` when nothing matching is free.
- The SQL function is `SECURITY DEFINER`, so it must apply the read, write and soft-delete rules itself (as
  `claim_memory` does with `require_memory_readable` and `can_write`) and never reveal or claim a memory the caller
  cannot read.

## 6. Approaches considered

**Graph read.**

- **A. A new `graph` tool (chosen).** Filters in, every short node and every link among them out, up to 400 nodes. The
  reason step reads a whole project in one call, including intents and hints not yet linked to anything.
- B. A short mode on browse that also returns all links. It reuses a tool, but browse pages, and a link between two pages
  would be lost.
- C. Raise the limits on `neighbours`. A walk from the origin misses unlinked memories, which are often the new intent or
  stray hint that matters, and a wide walk is expensive.

**Claim-next.**

- **A. One database function (chosen).** It picks the oldest free match and claims it in one transaction, skipping
  memories another caller is claiming at that moment.
- B. No new tool: browse open intents and `claim_memory` each until one succeeds. Free to build, but every worker pays the
  browse-and-retry cost and collisions grow with the number of workers.

**Session-exclusive claims** were first proposed as an opt-in flag on `claim_memory`. The maintainer chose to change the
default instead (section 3), because member-only holding was a hole, not a feature.

## 7. What else must change

- **A new migration** (never an edit to the claims migration). `claim_memory`'s return columns change and
  `release_claim`'s arguments change, so both are dropped and recreated, with execute revoked from public and granted to
  `agent_memory_member`. Plus the new `graph` read (or the queries the store runs; left to the builder) and the
  `claim_next` function. It must build from empty with `supabase db reset`.
- **Store, tools and types:** `MemoryStore` gains `graph` and `claimNext`; `release` takes a session; `ClaimResult` loses
  `previousSession` and its `overridden` gains `session?`. The `claim_memory` description drops the shared-token caveat
  and says a claim belongs to the member and the session. New limits in `_shared/limits.ts`. Member tools go from 28 to 30
  (memory tools 17 to 19), admin tools from 41 to 43.
- **Tests,** test-first, at every layer the existing claims and links features have: pgTAP for the session holder rules
  (same session, other session, null against null, null against a session, unknown session on release, a new label on
  `claim_next` creating its session, force over an own other session), for `claim_next` (filters, writable-only, superseded and claimed
  skipped, oldest first, nothing free, a memory the caller cannot read never chosen) and for graph visibility (a link to an
  unreadable memory never appears); integration tests for the store, including a deterministic concurrency test that
  holds one `claim_next` transaction open and shows a second caller gets a different memory without waiting; unit tests
  for the tool handlers and counts; an e2e round trip over real MCP; `scripts/smoke.ts` steps for both new tools.
- **Backup:** `memory_claims` is unchanged, so `backup.ts` needs no change. Verify that with the existing round-trip test.
- **Docs:** README (claims, the two tools, tool counts), `CLAUDE.md` (the claims and tool-count notes), `docs/claude-md-sample.md`
  (pass your session label to claim and release; use `claim_next` for queues), a pointer from the claims design's
  section 3 to this document, and the Claims section of the maintainer's global `~/.claude/CLAUDE.md` (outside the repo,
  so it is a separate edit, not a commit).
- **batpred #6328:** the two skills that claim pass the same session label to `release_claim`, and "another member"
  becomes "another member or session" in the skills and in that repo's `CLAUDE.md`. This is a task in the plan, pushed to
  the PR's branch, and should merge **before** the server deploys: today's server ignores the extra release argument, but
  after the deploy a session-less release of a claim made with a session fails. The plan checks that today's server does
  accept and ignore the argument. (Claude's call)
- **The global `~/.claude/CLAUDE.md`** edit is also a task in the plan, done after the deploy so it never describes
  behaviour that is not live.

## 8. Non-goals and anti-goals

Non-goals: the Cairn skill itself (designed next), priorities or weights on intents, `claim_next` across several memories
at once, a graph tool with paging, admin tools for claims or links, and any change to how claims are shown on reads.

Anti-goals, which would make this a failure even if it technically works:

- two sessions of one member, or two `claim_next` callers, both holding the same memory;
- an unknown session label silently matching a session-less claim;
- `graph` or `claim_next` revealing, counting or claiming a memory the caller cannot read, or a link to one;
- `claim_next` blocking on another caller's in-flight claim;
- `graph` at 400 nodes taking a noticeable share of the function's CPU budget, or one query per node.

## 9. Constraints

- Schema changes are a new migration that builds from empty with `supabase db reset`; every migration on `main` is
  already in production.
- Errors that reach a client are user-safe; "Memory not found" reads the same for absent and unreadable ids.
- The repo is public: no project refs, company, customer or personal names in committed files.
- **Deploy order** is migration, then function, each with the maintainer's own yes, after a backup. Between the two, the
  running function still calls the two-argument `release_claim`, which the migration drops, so releases fail for that
  window: run the function deploy straight after the push. (Claude's call: a short known window instead of keeping a
  compatibility overload to drop later.)

## 10. Calls to check

- An unknown named session is `Session not found` on release, never "no session"; `claim_next` creates a session for a
  new label, as `claim_memory` does (section 3).
- `graph` with `detail: 'full'` returns at most 100 nodes, against 400 for `short` (section 4).
- The batpred #6328 update and the global CLAUDE.md edit are plan tasks: the bot change merges before the server deploy,
  and the CLAUDE.md edit lands after it (section 7).
- `overridden.session` is shown when forcing over one's own other session (section 3).
- `graph` and `claim_next` both require `tags` or `tags_all`, and neither takes date filters (sections 4, 5).
- `graph` returns only links among its nodes, oldest nodes first, and `total` with `truncated` (section 4).
- `claim_next` skips superseded memories and memories the caller already holds, and returns the full memory (section 5).
- The deploy window instead of a compatibility overload (section 9).

## 11. Left to the builder

The SQL shape (whether `graph` is a SQL function or store queries, the try-lock loop in `claim_next`), exact error text
beyond the patterns given, the names of new limits, the test layout, and the JSON of results beyond the fields above.
