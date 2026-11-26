# Web UI: hints, intents and run controls — design

Status: implemented on branch `feat/web-ui-writes`, 2026-11-26. `web-api` is deployed to hosted. The skill's paused
branch, the amendment fallback and the `round:<n>` wording have **not** been run on a real board: the person chose to
skip the hosted toy-board run, so that check is still open. Approved in conversation, 2026-11-26. Builds on `2026-11-26-web-ui-design.md` (the read-only web UI).

## Intent

While watching a board, the person often knows something the agents don't, or has an idea worth trying. Today they
have to open a Claude session and run `/blackboard hint`, or write a memory by hand. They want to do it from the board
view, on the node it is about:

- **Add hint:** "here is something useful" — advice the lead weighs at its next round.
- **Add intent:** "try doing X" — a new piece of work that a worker picks up, without waiting for the lead to think of
  it.

## Goals

- An **Add hint** box in the drawer of every board node.
- An **Add intent** form in the drawer of the goal and of facts.
- Both write exactly the shapes the blackboard skill already writes, so the lead and workers need no new reading rules.
- **Board controls** on the goal's drawer: pause and resume the lead, stop, restart after a stop, and raise or lower
  the intent limit — all through the database, so they work for a board run on any machine.
- A person in any Claude session can do the same through the skill: `/blackboard hint` already exists, and a new
  `/blackboard intent <project> <text>` matches the button.

## Non-goals

- Editing or deleting memories from the UI, dropping intents, or changing the rules or the goal's text (amendments
  add to the goal instead) (the only goal
  changes are its state and its `Max intents` line, under Board controls).
- Hints that go straight to a worker. The person chose to keep hints as they are: advice for the lead.
- Writes from the Browse tab outside a board.

## Anti-goals

- A browser that can write arbitrary memories. The browser sends only text and the node it is about; the server builds
  every word of the template, every tag and every link.
- A write the person cannot see landing: the new node must appear in the graph on the next poll, or the form says why
  it failed.
- An intent the person added being quietly dropped by the lead.

## Approaches

1. **Dedicated write routes in `web-api` (chosen).** `POST /hints` and `POST /intents`. The server builds the skill's
   templates, tags and links, and checks the board is running for intents. Narrow, and the templates live in one place
   on the server.
2. **A generic "store a memory" route, with the browser building the text.** Less code, but the browser could write
   any memory and the templates would drift from the skill's. Rejected.
3. **Add intent stores a "suggested intent" hint for the lead to turn into an intent.** Keeps the lead in charge of
   wording and limits, but it is not direct — it waits a round and the lead may decline it. Rejected: the person asked
   for direct intents.

## What gets built

### Shapes (match the skill exactly)

- **Hint:**
  ```
  Hint: <text>
  From: <the caller's member name>
  ```
  Tags `board:<board>`, `kind:hint`, `evergreen`. Linked `relates-to` the node it was added on when that node is an
  intent, fact or hint; none when added on the goal (board-wide).
- **Intent:**
  ```
  Intent: <text>
  Why: added by <member name> from the web UI<; building on fact <id> when added on a fact>
  Produce: <the person's "Done when" text, or "a fact reporting what trying this showed">
  Give up when: <the person's text, or "it cannot be done within the board's rules; record an inconclusive fact">
  ```
  Tags `board:<board>`, `kind:intent`, `state:open`, `round:<n>`, `evergreen`, where `<n>` is the progress memory's
  current `Round:` (so it sits in the current round's band). Linked `derived-from` the fact it was added on, if any.
- Both are stored in the board's scope (the goal's scope), as the caller, category `observation`.

### `web-api`

- `POST /hints` body `{ scope, board, text, about? }`; `POST /intents` body `{ scope, board, text, produce?, giveUp?,
  from? }` (`about` / `from` are memory ids). JSON only; anything else 415.
- Validation: `text` 1–2,000 characters after trimming, single-line for the first line of the template (newlines in
  `text` are folded to spaces); `produce` / `giveUp` at most 500 each. `board` must match the board-name shape. The
  goal is found as the board's `kind:goal` memory in `scope`; none → 404 in the store's not-found wording. `about` /
  `from` must be a readable memory tagged `board:<board>` (else the same 404); `from` must be a `kind:fact`.
- Intents only while the goal has `state:running` or `state:paused` (else 409 `Board is not running`).
- Store as the member through `PgMemoryStore.store`, then `relate`. A scope the caller can't write gives the store's
  own error (user-safe). Response 201 `{ memory }`.
- Uses the embedder (store embeds content), so these routes construct it; reads still don't.
- The member name for `From:` / `Why:` comes from the caller's own identity, looked up before storing, so the content
  is right on first store (no store-then-update). The builder picks the cleanest member-readable lookup.

### Local server

- The proxy allows exactly `POST /api/hints`, `POST /api/intents` and the board-control route(s) in addition to the
  GET allow-list.
- Each POST must carry `Content-Type: application/json` and `Sec-Fetch-Site: same-origin` (or `Origin` equal to the
  page's own origin when that header is absent); else 403. Body forwarded as is, at most 16 KiB.

### Browser

- Drawer, Memory tab, below the content: **Add hint** (textarea + button) on every node of a board. On the goal and on
  facts, also **Add intent** ("Try …" line, optional "Done when", optional "Give up when").
- Only shown on the Board tab (the drawer knows the board and scope there). Disabled while a request is in flight. On
  success: clear the form, say "Added — it will appear in the graph shortly", and trigger an immediate graph poll. On
  failure: show the server's error text.
- All text rendered with `textContent`.

### Skill

- `SKILL.md`: a new `intent <project> <text>` command next to `hint`, writing the same intent shape (with `Why: added
  by <the person> …`), linked `derived-from` any fact id named in the text.
- `lead.md` Drop rule: never drop an intent whose `Why:` says it was added by a person; only a fact closes it. It still
  counts toward `Max intents` and the open-intent limit.

## Board controls (added in the same conversation)

The person wants to steer a run from the UI, and it must work for a board run on any machine, so every control is a
change to the goal memory in the database, never a local file.

- **Pause lead / Resume lead.** Pause swaps the goal's `state:running` for `state:paused`; Resume swaps it back.
  - While paused, the lead plans nothing new, proposes no candidates and writes no conclusion. It keeps renewing its
    claim on the goal, and ends its round with `BOARD-LEAD paused free=<n> open=<m>`.
  - Workers carry on: they finish what they hold and keep taking intents that are already open, including ones the
    person adds. Once the open intents are done, no new work is issued until Resume.
  - The runner keeps running. On `paused` it fills worker slots from `free` as for `running`, and asks the lead for a
    round every 2 minutes instead of `round_every_minutes`, so Resume is seen within about 2 minutes. The runner stays
    board-blind; the lead reads the state.
- **Stop.** The existing `/blackboard stop`: `state:stopped`. Workers end at their next step, the runner drains (lets
  running workers finish) and exits. The UI asks for confirmation first.
- **Restart** (shown on a board stopped by hand): sets `state:stopped` back to `state:running` and says "now run
  `board-runner run <board file>` again". Not offered when the goal is `state:done`.
- **Intent limit.** A number box showing the goal's `Max intents` (or "no limit"), with Save.
  - Saving rewrites the goal's `Max intents:` line, keeping every other line.
  - Raising it on a board stopped at its limit (a conclusion contains `Stopped: intent limit`) is the skill's
    `resume`: the new limit and `state:running` again, then the same "run `board-runner run` again" note.
  - Lowering it on a running board makes the lead stop once the count reaches the new number. A lower limit than the
    intents already written is allowed (the lead stops at its next round).
  - A higher `max_intents` in the board file raises it again on the next `board-runner run` (existing start
    behaviour); the UI says so in a hint line under the box.

Where the rules change:

- `SKILL.md`: `state:paused` added to the goal's states; new commands `pause <project>` and `resume-lead <project>`
  (names to fit the existing command table), and `stop` unchanged.
- `lead.md`: a paused branch at the top of the round (after renewing the claim): read the board as usual for counts,
  write nothing, end with `BOARD-LEAD paused free=<n> open=<m>`.
- `work.md` step 1: a goal that is `state:running` **or** `state:paused` lets the worker continue.
- `start.md`: a `state:paused` board on `board-runner run` counts as existing (`BOARD-START exists`).
- Runner: `protocol.py` parses `BOARD-LEAD paused free=<n> open=<m>`; `scheduler.py` treats it like `running` for
  filling slots and switches the heartbeat to 2 minutes until a `running` result; tests first, as CLAUDE.md asks.
- `web-api`: `POST /boards/control` body `{ scope, board, action: 'pause' | 'resume' | 'stop' | 'restart', maxIntents? }`
  (or one route per action — builder's call), acting on the goal as the caller through `update`; state transitions
  allowed only from the states above (else 409 with the current state named). The status strip shows `paused`.

## Amendments (added in the same conversation)

Rather than editing the goal, the person can add an **amendment**: a sub-goal or fallback such as "if 20% is out of
reach, 15% is acceptable, as long as X is unchanged". The original goal stays intact and each change is its own step.

- Shape: `Amendment: <text>` / `From: <member name>`; tags `board:<board>`, `kind:amendment`, `evergreen`; linked
  `depends-on` the goal. Added from the goal's drawer (`POST /amendments`) or with `/blackboard amend <project> <text>`.
  Allowed in any state but `done`. Shown in the graph's header band with rules and progress.
- The lead reads every amendment with the goal each round; the newer wins a conflict. A fallback target applies only
  once the goal's own target is out of reach (Unreachable, or the intent limit with nothing open). Without `measure`
  that concludes the board done, citing the amendment. With `measure` the runner's measurement stays the arbiter, so
  the lead stops with `Stopped: amended target met (amendment <id>)` instead.
- Workers read amendments with the goal and rules; their constraints bind the work.
- **Anti-cheat, for now a rule:** workers never change the goal, the rules or an amendment, and never write one; their
  writes are their fact, their claim and tag changes on their own intent, and hints about their intent's work. The
  lead honours only amendments whose `From:` names a person and reports any other as a breach.
- **Follow-up:** a separate bot member for agents, with a database rule that bot members cannot write
  `kind:amendment`, `kind:goal` or `kind:rules` or edit the goal — enforcement instead of a rule.

## Constraints

- Hosted: `web-api` must be redeployed; ask the person first (per CLAUDE.md).
- CPU: each write embeds once (well under 1 s); reads unchanged.
- Repo is public; tests use neutral strings.

## Decided after the builder check

- **Limits:** the person chose to accept a person's intent regardless of `Max intents`; the form shows "this board has
  used <n> of <max> intents" before submitting.
- **Drop protection** covers only the lead's "pointless" Drop rule. Done and Unreachable still close every open intent
  at board end; an intent that times out twice may be split by the lead into smaller intents linked `derived-from` it.
- **Marker:** a person's intent has a `Why:` line starting exactly `Why: added by `; the lead's rule matches that
  prefix, and a test pins the server's text to it.
- **Folding:** newlines are folded to spaces in `text`, `produce` and `giveUp`, so no field can forge a template line.
- **Truncated boards** (over 400 nodes): the form warns that the new node may not appear in the graph.
- **Board-wide hints:** a hint on the goal, conclusion, progress or rules node has no link. Hints are allowed in any
  board state; Add intent only while the board is running or paused.
- **Partial failure:** if linking fails after the store, the route deletes the memory it stored and returns the error.
- **Round tag:** read from the progress memory's `Round:`; when there is none, the intent gets no `round:` tag and the
  time-gap grouping places it. An intent added mid-round joins that round.
- **Timeouts and duplicates:** POSTs get a 30 s proxy timeout; a duplicate from a retry after a timeout is accepted.

## Left to the builder

- How to get the caller's member name (see above).
- Exact error wording beyond the ones named.
- Form layout and styling in the drawer.

## Builder's calls

Decisions made while building, where this design was silent or the plan contradicted it:

- **Stop from paused:** the spec's transition table wins over the plan's "stop unchanged": `stop` is allowed from
  `running` and `paused`.
- **Missing goal:** a board with no readable goal is a 404 reading `Board <board> not found`, the same whether it is
  absent or unreadable.
- **Amendments** were added after Task 3, with their server and skill parts first, the proxy allow-list in the proxy
  task and the browser parts (form, list, header band) in the browser task.
- **Measure mode:** an amendment's fallback cannot make a measured board Done, because the measure threshold lives in
  the board file. The lead stops with `Stopped: amended target met (amendment <id>)` instead. Cost if wrong: a person
  expects Done on a measured board.
- **Honouring amendments:** the lead honours only an amendment whose `From:` names a person, not a session label. This
  is weak; the real guard is the bot-member follow-up. Cost if wrong: a forged `From:` line passes.
- **Planning toward a fallback:** once the goal's own target is out of reach and the intent limit allows, the lead
  aims at the newest honoured fallback. With measure, a result that meets only the fallback is proposed as a candidate
  before stopping, so the measurement records it. Cost if wrong: intents spent on a fallback the person did not want
  pursued.
- **Stop confirmation:** the page's confirmation focuses Cancel, so a repeated Enter cannot stop a board.

Open follow-ups:

- Run a toy board on hosted to check the paused branch, the amendment fallback and the `round:<n>` tags.
- A bot member for agents with a database rule against writing `kind:amendment`, `kind:goal` or `kind:rules`.
- Minor review items deferred from the tasks (limit validation, a stale-state re-read after a 409, the amendment list
  not refreshing on a poll) are recorded in the build ledger, not fixed here.
