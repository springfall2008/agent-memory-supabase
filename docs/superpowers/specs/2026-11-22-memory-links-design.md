# Memory links — design

Date: 2026-11-22
Status: implemented (local build and tests; not yet deployed)
Builds on: [the hosted memory design](2026-11-07-supabase-agent-memory-design.md) and
[discussion threads](2026-11-07-threads-design.md)

## 1. Intent

Search finds memories by their words. An agent that already holds one memory has no way to ask "what is this connected
to?" without guessing a new query. `find_related` only finds memories that read similarly, which is not the same as
being connected: a decision and the evidence behind it may share no vocabulary, and an old status memory and the newer
one that replaced it look almost identical, so search returns both and the agent can't tell which to believe.

A **memory link** is an explicit, typed, directional relationship between two memories, written by an agent or a
person. Agents can follow links to find related concepts without a text query, and they see at a glance when a memory
has been replaced.

The idea came from looking at an open-source agent knowledge-graph project (Cairn), which models findings as nodes and
declared lines of work as edges. We take the idea of explicit links, not its model: our memories are long-lived,
cross-repo, scoped and mutable, and its graph is a per-project, append-only search towards one goal.

This is the first of two steps. Step two (claimable work, so two agents don't pick up the same task) is out of scope
here, but this design must not get in its way (section 7).

## 2. Decisions (the maintainer's)

- **Links are the first step; claimable work comes second.**
- **The point is navigation by relationship, not by text.** An agent holding one memory can find the memories connected
  to it without running another search.
- **Links are typed memory-to-memory relationships,** with the four types in section 3, and they point one way.
- **Three new MCP tools**, to create a link, remove a link and follow links (section 4). Search results show a memory's
  links, and a replaced memory is flagged.
- **Who may create and remove a link** (decided after the builder check):
  - `supersedes` needs write access to the scopes of **both** memories: you can only declare something replaced if you
    could edit it yourself.
  - `derived-from` and `depends-on` need write access to the `from` memory's scope and read access to the `to` memory.
  - `relates-to` has no direction, so it needs write access to **either** memory's scope, plus read access to the
    other.
  - Removing a link of any type needs write access to **either** end's scope, so whoever owns a memory can always
    remove a link pointing at it.
- **The maintainer approved the proposal in sections 3 to 6 in conversation.** Calls Claude made without being asked
  are marked "(Claude's call)" so they can be checked.

## 3. The data

A new table, added by a new migration (never by editing an old one):

`memory_links(from_id, to_id, type, created_by, created_at)`

- `from_id` and `to_id` reference `memories` with `on delete cascade`. `created_by` references `members`.
- The primary key is `(from_id, to_id, type)`. `from_id <> to_id` is a check: no self-links.
- `type` is `text` with a check constraint, not an enum, so a later migration can add a type by replacing the
  constraint. The first four types:
  - `relates-to`: a loose association. It has no direction in meaning, so there is at most one `relates-to` row per
    pair of memories, whichever order they were given in, and `neighbours` treats it as pointing both ways.
  - `supersedes`: `from` replaces `to`; `to` is out of date.
  - `derived-from`: `from` was concluded from `to` (a decision from its evidence).
  - `depends-on`: `from` only holds, or can only be done, if `to` does.
- Cycles are allowed. There is no DAG rule. (Claude's call)
- The two ends may be in different scopes. (Claude's call)
- A memory has at most 100 **outgoing** links (rows where it is `from_id`). Incoming links are not capped at write time.
  Capping the `from` side keeps the limit in the hands of whoever can write that memory, so nobody can fill another
  scope's memory with incoming links to block its owners, and the "too many links" error cannot hint at links the
  caller can't see. A `relates-to` link is stored from whichever end the caller can write, so someone who can only read a
  memory's scope can never charge that memory's cap. The one accepted leak: a writer of a memory's scope who hits the cap
  learns the memory has 100 outgoing links, and that count may include links to memories they cannot read. Reads stay bounded anyway: results show at most 10 links per memory and `neighbours` returns at
  most 100 memories. The cap lives in `_shared/limits.ts` and the SQL function enforces it. (Claude's call)

**Visibility.** A member sees a link only if they can read both ends, and only while neither memory is soft-deleted.
The select policy follows the `thread_links` precedent: a member sees a link if both of its memories are visible to them
under the memories policy. A member who can read only one end gets no sign that the link exists, so a link can never
reveal an unreadable memory. Members get `select` only. Every write goes through a `SECURITY DEFINER` function with
`search_path = ''`, execute revoked from public and granted to `agent_memory_member`, as for thread links.

**Lifecycle.** Soft-deleting either end hides the link, and restoring that memory brings it back. A permanent purge
deletes the link through the foreign key. Moving a memory to another scope keeps its links, and their visibility is
then judged against the new scope. There is no link history table; `created_by` and `created_at` are enough.
(Claude's call)

## 4. The tools

Every member gets three more tools, so memory tools go from 11 to 14 and member tools from 22 to 25. The names avoid
the existing `link_memory` and `unlink_memory`, which link a memory to a *thread*.

- **`relate_memories(from, to, type)`** creates a link, under the permission rules in section 2. The caller must be
  able to read both memories. It is idempotent: repeating it is not an error. It refuses a memory that already has 100
  outgoing links and refuses a self-link, each with a plain message. An id that is absent and an id the caller cannot
  read give the same "Memory not found" error, as everywhere else. A caller who can read both memories but lacks the
  write access the type needs gets a plain permission error naming the missing access.
- **`unrelate_memories(from, to, type)`** removes a link, under the removal rule in section 2: write access to either
  end's scope. For `relates-to` the order of `from` and `to` does not matter. It reports whether a link was removed.
- **`neighbours(memory_id, direction?, types?, depth?, scopes?)`** follows links from a memory.
  - `direction` is `out`, `in` or `both` (default `both`). `types` filters by link type, default all. `depth` is 1 to
    3, default 1. `scopes` narrows as it does on `search`.
  - `scopes` limits the whole traversal, not just the output: a memory outside the given scopes is neither returned nor
    walked through, so a path that would pass through one is not followed. (Claude's call)
  - It returns the memories reached, each with the path that reached it (the link type and direction at each step),
    de-duplicated and unranked, at most 100 in total. Cycles must terminate.
  - The walk is breadth-first, so nearer memories win when the 100 cap cuts the result. Within a hop, order is newest
    link first, then id. If the cap cut anything off, the response says `truncated: true`. (Claude's call)
  - It does not count as an access, like browse, because it is deliberate navigation, not a relevance signal.
    (Claude's call)

**Showing links in results.** `search` (ranked and browse), `recall`, `find_related` and `list_recent` return, with each
memory, a compact `links` list of `{type, direction, memory_id}` for the links the caller can see: ids and types only,
at most 10 per memory (newest link first, then id), plus a `more` count when there are extras. A memory that a visible `supersedes` link points at
also carries `superseded: true`. The links for a whole result set come from one batched query, never one per memory,
to stay inside the CPU budget. Ranking is unchanged: a superseded memory is flagged, not demoted. (Claude's call)

## 5. What else must change

- **Backup, restore and import.** `scripts/backup.ts` handles `thread_links` explicitly, resolving member names, and
  must do the same for `memory_links`. A backup and restore round trip must preserve every link. The importer has no
  links to bring in.
- **Admin and erase.** Scope deletion, the erase path and the purge cron must leave no orphan links. The foreign keys
  should cover this; a test must prove it.
- **Tests.** pgTAP for the visibility rules (one unreadable end, soft delete, restore, cross-scope, scope move, the
  permission rules for every link type, creating and removing, and the cap). Unit tests for the three tools and the new tool count. Integration tests for the store.
  `scripts/smoke.ts` must list and exercise the new tools.
- **Docs.** The README tool list and counts, the architecture note in `CLAUDE.md`, and `docs/claude-md-sample.md`,
  which should say when to link. The rule "update a memory, never store a second one" stays. `supersedes` is for the
  rarer case of two memories that are both worth keeping.

## 6. Non-goals and anti-goals

Non-goals for this step: automatic links from similarity, link weights or free-text labels, a graph view, ranking search
results by their links, expanding search results with their neighbours, and anything about claims or tasks.

Anti-goals, which would make this a failure even if it technically works:

- a link revealing that an unreadable memory exists, or who linked it;
- ranked search getting noticeably slower: showing links costs one extra query per result set, not one per memory;
- the new tools going unused because nothing shows agents the links exist, which is what happened to threads.

## 7. Room for step two

Claimable work will probably be a lease (who holds it, a heartbeat, a conclusion) on a status memory, or its own table
that references memories. Nothing here assumes links are the only structure between memories. Link types can grow
(`blocks`, for example) by replacing one check constraint. The `neighbours` tool and the `links` field in results are
the places a claim's state could later appear.

## 8. Constraints

- Schema changes are a new migration that builds from empty with `supabase db reset`.
- Errors that reach a client are user-safe, and "not found" reads the same for absent and unreadable.
- The repo is public: no project refs, company, customer or personal names in committed files.
- Deploying needs the migration pushed first, with a backup beforehand, then the function. Each hosted run needs the
  maintainer's own yes.

## 9. Left to the builder

The SQL for `neighbours` (recursive query, cycle handling), exact function names and error texts, the JSON shape of
results beyond the fields above, index choices, how `relates-to` pairs are normalised, and the test layout.
