# Memory claims — design

Date: 2026-11-22
Status: draft (builder check done; awaiting the maintainer's approval of the whole document)
Builds on: [memory links](2026-11-22-memory-links-design.md) (section 7 left room for this step) and
[discussion threads](2026-11-07-threads-design.md) (agent sessions)

## 1. Intent

A status memory can say that a piece of work is open, but nothing says someone is already doing it. When two agents, or
an agent and a person, work from the same set of open memories, they can pick up the same task. A **claim** is a short,
self-expiring "I'm working on this" attached to a memory: who holds it, until when, and why. Anyone who reads the memory
sees the claim, so a second agent sees the task is taken before starting it.

A claim is advisory coordination. It does not lock the memory: anyone with write access can still update or delete it.

## 2. Decisions (the maintainer's)

- **A claim is made on a memory, for a period, with a short description of why.**
- **Claiming something that is already claimed fails.**
- **A `force` option on claiming overrides someone else's claim.**
- **A release removes the claim.**
- **A "claimed by me" listing shows the claims I hold.**
- **A claim belongs to the member, not the session.** The session, when the caller gives one, is recorded on the claim
  and shown in listings, so the member can tell which session made a claim and spot stale sessions.
- **The maintainer approved the shape in conversation ("sounds good").** Calls Claude made without being asked are
  marked "(Claude's call)" so they can be checked; they are collected in section 9.

## 3. The data

A new table, added by a new migration (never by editing an old one):

`memory_claims(memory_id, member_id, session_id, description, claimed_at, expires_at)`

- `memory_id` is the primary key and references `memories` with `on delete cascade`, so a memory has at most one claim
  row, and a permanent purge or erase removes it.
- `member_id` references `members`. `session_id` references `agent_sessions` with `on delete set null` and may be null.
- `description` is the reason: 1 to 200 characters after trimming. `expires_at` is null for an **indefinite** claim;
  otherwise `expires_at > claimed_at` is a check.
- A claim is **active** while `expires_at` is null or after the database clock (`now()`), its memory is not soft-deleted
  and its holder is not a deactivated member (so a deactivated bot cannot block everyone until its claim runs out). An
  inactive row counts as no claim: it is ignored by every read and replaced by the next claim. There is no background
  job. (Claude's call)
- **Rights changes.** A claim is not tied to the holder's access. If the holder later loses write access to the scope,
  or the memory moves to another scope, the claim stays active until it expires or is released, and anyone with write
  access can `force`. (Claude's call)
- **Visibility.** A member sees a claim if they can read its memory (the select policy follows the memories policy, as
  `memory_links_select` does). A claim is not secret: it is shown to everyone who can read the memory. Members get
  `select` only; every write goes through a `SECURITY DEFINER` function with `search_path = ''`, execute revoked from
  public and granted to `agent_memory_member`.

**Who the holder is.** The holder is the **member**. Any session of that member can renew or release the claim, and two
agents that share one token are one holder, which is a documented limit. The claim also records the agent session that
made or last renewed it (null when the caller gave none), purely as information: it never decides who may do what. If that
session is later deleted the column becomes null. Sessions are private to their member in this codebase, so the session
is shown **only to the holder**: in `my_claims`, and on a memory's `claim` when it is the caller's own. Other members see
the holder's name, the end time and the description, never a session. (Claude's call)

## 4. The tools

Every member gets three more tools: memory tools go from 14 to 17, member tools from 25 to 28, admin tools from 38 to 41.
The two write tools take the same optional `session` / `session_label` arguments the thread tools take, and create the
session if the label is new.

- **`claim_memory(memory_id, description, minutes?, force?)`** needs read and write access to the memory's scope. An id
  that is absent and one the caller cannot read give the same "Memory not found" error.
  - No active claim: the claim is created.
  - An active claim by the same member (from any session): it is renewed, which sets a new `expires_at` and a new
    description and records the caller's session as the latest. When the session differs from the one recorded, the
    result also carries `previousSession` (its id and label), so the member can notice that a different session was
    working on it. (Claude's call)
  - An active claim by someone else: it fails with a plain message naming the holder, the time it ends and the
    description, for example `Memory <id> is claimed by <name> until <time>: <description>`. With `force: true` the
    caller takes it over, and the result says who held it before (name, until, description).
  - `minutes` is a whole number of at least 1 with **no upper limit** short of a sanity bound of 10 years (5,256,000), so
    "a week" is `10080`. It defaults to 60 when omitted. (The default is Claude's call.)
  - `indefinite: true` makes a claim with no end, for work that may pause for an unknown time. It cannot be combined
    with `minutes`. An indefinite claim stays until it is released, forced, or its holder is deactivated.
  - The result is `{ claimed: true, until, overridden?, previousSession? }`, where `until` is null for an indefinite
    claim.
- **`release_claim(memory_id, force?)`** needs the same access. The holder releases their own claim. Releasing another
  holder's active claim fails unless `force: true`. Releasing a memory with no active claim is not an error. The result
  is `{ released: boolean }`.
- **`my_claims(scopes?)`** lists the active claims held by the calling **member**, across every readable scope (or the
  named ones), soonest expiry first with indefinite claims last, at most 100. Each entry has the memory in short form (id, scope, category, tags and
  a 160-character snippet), the description, `claimedAt`, `until` and the session that made or last renewed the claim, if
  any, as its id and label (a session without a label is identified by its id), so the member can see which sessions
  hold claims and which of those sessions are stale. The result is `{ count, claims }`.
- Two simultaneous claims on one memory are serialised in the database, so exactly one wins and the other gets the
  "already claimed" failure.

**Showing claims.** Every read tool that returns memories (`search` ranked and browse, `find_related`, `list_recent`,
`recall` and `neighbours`) adds `claim: { by, until, description, mine?, session? }` to a memory with an active claim,
and nothing otherwise. `by` is the member's display name, and `mine: true` and `session` (id and label) appear only when
the caller holds the claim. The claims for
a whole result set come from one batched query, never one per memory. Without this, nobody would know a task was taken,
which is why threads went unused.

## 5. What else must change

- **Backup, restore and import.** `scripts/backup.ts` handles `memory_links` and must do the same for `memory_claims`
  (the member as a display name, the session as an id, timestamps as text). Only claims that are active when the backup is
  taken are written, and the sessions they reference are added to the file's `sessions` (as thread sessions are), so a
  scoped backup restores. Restore reads the section as optional so older files still restore, skips any claim that has
  already expired, and leaves the session empty if it is not in the file. A pre-migration backup must use the pre-claims script, because the new one reads a table
  production will not have yet.
- **Tests.** pgTAP: permissions, holder matching with and without sessions, expiry, force, release, soft delete and
  restore, erase and purge cascade, visibility, and a deterministic concurrency test. Unit tests for the three tools and
  the new tool count. Integration tests for the store and the batched claim lookup. An e2e step over real MCP.
  `scripts/smoke.ts` must exercise the new tools.
- **Docs.** README, the architecture note in `CLAUDE.md`, and `docs/claude-md-sample.md`, which should say when to claim.

## 6. Non-goals and anti-goals

Non-goals: a heartbeat tool (renew by claiming again), queues or waiting lists, claim history or an audit log, a
notification when a claim expires or is forced, claiming threads or scopes, admin tools to list or clear claims, and any
automatic claim when a memory's status changes.

Anti-goals, which would make this a failure even if it technically works:

- a claim blocking anyone from reading, updating or deleting the memory (claims are advisory);
- a claim, or an error about one, revealing a memory the caller cannot read;
- a stale "claimed" showing after the claim has expired;
- ranked search getting noticeably slower: showing claims costs one extra query per result set.

## 7. Constraints

- Schema changes are a new migration that builds from empty with `supabase db reset`.
- Errors that reach a client are user-safe, and "not found" reads the same for absent and unreadable ids.
- The repo is public: no project refs, company, customer or personal names in committed files.
- Deploying needs the migration pushed first, after a backup, then the function, because the function calls the new SQL.
  Each hosted run needs the maintainer's own yes.

## 8. Left to the builder

The SQL (the atomic claim function and its lock, the batched lookup, indexes), exact function names and error texts
beyond those given, the JSON shape of results beyond the fields above, and the test layout.

## 9. Calls to check

- **Session privacy, renewal notice, holder state and backup** are as in sections 3, 4 and 5: sessions shown only to the
  holder, `previousSession` on a renewal from a different session, a deactivated holder's claim is inactive, and only
  active claims are backed up.
- **Force** is allowed to anyone with write access to the memory's scope. The alternative is admins only.
- Duration defaults to 60 minutes when omitted, with no cap beyond a 10-year sanity bound, and `indefinite: true` for a
  claim with no end (the maintainer asked that the maximum not be short or fixed; the explicit indefinite option is my
  reading of "could be undefined"). A stuck indefinite claim is cleared with `force` or by its holder, and `my_claims`
  lists it. The description is at most 200 characters, advisory only, lazy expiry, and
  the latest renewing session being the one recorded.
