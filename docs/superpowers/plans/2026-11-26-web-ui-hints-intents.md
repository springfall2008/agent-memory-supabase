# Web UI hints, intents and run controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the board view, a person can add hints and intents and pause, resume, stop, restart and re-limit a run — all through the database, so it works for a board run on any machine.

**Architecture:** Write routes on the `web-api` Edge Function build the blackboard skill's exact templates server-side and store/update as the caller (RLS decides). The local proxy admits exactly those POSTs with same-origin checks. The browser drawer gains forms; the goal's drawer gains a controls panel. The skill and runner learn a new goal state, `state:paused`: the lead plans nothing, workers carry on with open intents, the runner checks every 2 minutes.

**Tech Stack:** Deno 2 (edge function, local server, tests), `npm:postgres`, vanilla JS ES modules, Python 3.11 stdlib for the runner.

**Spec:** `docs/superpowers/specs/2026-11-26-web-ui-hints-intents-design.md` (builds on `2026-11-26-web-ui-design.md`).

## Global Constraints

- The browser sends only text, ids and an action; the server builds every word of a template, every tag and every link.
- Hint text: `Hint: <text>` / `From: <member name>`; tags `board:<board>`, `kind:hint`, `evergreen`.
- Intent text: `Intent: <text>` / `Why: added by <member name> from the web UI[; building on fact <id>]` /
  `Produce: <produce or "a fact reporting what trying this showed">` / `Give up when: <giveUp or "it cannot be done within the board's rules; record an inconclusive fact">`;
  tags `board:<board>`, `kind:intent`, `state:open`, `round:<n>` (omitted when no progress `Round:`), `evergreen`.
- A person's intent is marked by a `Why:` line starting exactly `Why: added by `.
- Newlines (`\r`, `\n`) in `text`, `produce`, `giveUp` fold to single spaces; `text` 1–2,000 chars after trimming,
  `produce` / `giveUp` ≤ 500 each.
- Goal states: `state:running`, `state:paused`, `state:stopped`, `state:done`. Intents allowed while running or paused.
- Runner line: `BOARD-LEAD paused free=<n> open=<m>`; paused heartbeat 120 s.
- Errors reaching a client are user-safe; "not found" uses the store's wording (`Memory <id> not found`) for absent and
  unreadable alike.
- Every write runs as the caller through `withMember`; no migration.
- Proxy: POSTs need `Content-Type: application/json` and `Sec-Fetch-Site: same-origin` (or, when absent, an `Origin`
  equal to the request's own origin); body ≤ 16 KiB; upstream timeout 30 s for POSTs (15 s for GETs stays).
- Browser: `textContent` only; never `window`; pure modules `// @ts-check`, no DOM.
- Skill changes keep every existing `BOARD-*` line unchanged; the skill is instructions only.
- Hosted `web-api` redeploy and any hosted toy-board run need the person's yes for that run.
- Repo is public: neutral test strings; literal-name cleanup.

## Review Focus

1. **Forged template lines.** A hint or intent text containing `\nWhy: added by …` or `\nBOARD-LEAD …` must land on
   one line. (Task 3 tests.)
2. **Cross-site write.** A page on another origin POSTing to `localhost:8787/api/intents` must get 403 with no upstream
   call, including a `text/plain` "simple request". (Task 4 tests.)
3. **Control on the wrong state.** Pause on a stopped board, Restart on a done board, Resume on a running board → 409
   naming the current state, goal unchanged. (Task 3 tests.)
4. **A paused board left behind.** A runner restarted on a paused board must keep running and keep checking, not exit
   or treat it as not-running. (Tasks 1, 2.)
5. **Limit edit losing content.** Rewriting `Max intents:` must keep every other goal line byte for byte, and add the
   line if absent. (Task 3 tests.)

---

### Task 1: Runner understands a paused lead

**Files:** Modify `runner/board_runner/protocol.py`, `runner/board_runner/scheduler.py`, `runner/README.md`.
Test: `runner/tests/test_protocol.py`, `runner/tests/test_scheduler.py`.

**Interfaces:** Produces `LeadKind` gains `"paused"`; `parse_lead("BOARD-LEAD paused free=2 open=3")` →
`LeadResult("paused", free=2, open=3)`. Scheduler: a `paused` result fills slots from `free` exactly like `running`;
while the last lead result is `paused`, the heartbeat interval is `PAUSED_HEARTBEAT_SECONDS = 120` instead of
`round_every_minutes * 60`; any non-paused result restores it. The "no turn end for 2 heartbeats" warning uses the
active interval.

- [ ] Step 1: failing tests — parse paused (and malformed `BOARD-LEAD paused` → `none`); scheduler: paused result
  starts workers for `free`; next round sent after 120 s while paused, after `round_every_minutes` after a running
  result; draining not set by paused.
- [ ] Step 2: run `cd runner && python3 -m unittest discover -s tests` — new cases FAIL.
- [ ] Step 3: implement. README: one line on `paused` under Use.
- [ ] Step 4: runner tests PASS. Step 5: commit `feat(runner): a paused lead keeps the run alive and is checked every 2 minutes`.

### Task 2: Skill — paused state, new commands, drop protection

**Files:** Modify `skills/blackboard/SKILL.md`, `lead.md`, `work.md`, `start.md`.

**Interfaces:** Produces:
- SKILL.md: goal states include `state:paused`; commands `pause <project>` (running → paused), `resume-lead <project>`
  (paused → running), `intent <project> <text>` (the Global Constraints intent shape with `Why: added by <the person> from a Claude session`, linked `derived-from` any fact id named in the text, refused unless running or paused). `stop` unchanged.
- lead.md: right after the claim renewal, if the goal is `state:paused`: read intents for counts as usual, write
  nothing (no intents, candidates, conclusion or progress rewrite), end with `(label: …)` then
  `BOARD-LEAD paused free=<n> open=<m>`; in runner mode list this line with the others. Drop rule: never drop as
  pointless an open intent whose `Why:` starts `Why: added by `.
- work.md step 1: continue when the goal is `state:running` or `state:paused`.
- start.md: a `state:paused` board counts as existing (`BOARD-START exists`).

- [ ] Step 1: edit, in each file's voice.
- [ ] Step 2: `deno task check` PASS; `grep -n "BOARD-" skills/blackboard/*.md` shows every old line unchanged.
- [ ] Step 3: commit `feat(skill): pause and resume the lead; person intents; drop protection`.
- Behavioural check happens in Task 6's toy run.

### Task 3: `web-api` write routes

**Files:** Create `supabase/functions/_shared/board-writes.ts` (pure: templates, folding, goal-line edit,
transition table). Modify `supabase/functions/_shared/web-api.ts`, `supabase/functions/_shared/pg-store.ts`
(`memberName()`), `supabase/functions/web-api/index.ts` if needed. Test: `tests/unit/board-writes.test.ts`,
`tests/unit/web-api.test.ts`, `tests/integration/web-api.test.ts`.

**Interfaces:**
- `PgMemoryStore.memberName(): Promise<string>` — the caller's name via `agent_memory.member_name(<caller id>)` run as
  the member (verify the member role can execute it; no migration).
- `WebStore` adds `memberName`, `store(scope, req)`, `relate(from, to, type)`, `update(id, u)`, `delete(id)` (real
  `PgMemoryStore` signatures).
- Pure (`board-writes.ts`): `fold(s: string): string`; `hintContent(text, name): string`;
  `intentContent({ text, name, produce?, giveUp?, fromFact? }): string`; `withMaxIntents(goal: string, n: number | 'none'): string`;
  `transition(state: string, action: 'pause' | 'resume' | 'stop' | 'restart'): string | null` (pause: running→paused;
  resume: paused→running; stop: running|paused→stopped; restart: stopped→running; else null).
- Routes (POST, JSON only else 415):
  - `POST /hints` `{ scope, board, text, about? }` → 201 `{ memory }`. `about` on an intent, fact or hint → `relates-to`
    from the hint; on goal / progress / rules / conclusion → no link.
  - `POST /intents` `{ scope, board, text, produce?, giveUp?, from? }` → 201 `{ memory }`; `from` must be a `kind:fact`
    on the board; link `derived-from` it. 409 `Board is not running` unless running or paused. `round:<n>` from the
    board's `kind:progress` `Round:` line.
  - `POST /boards/control` `{ scope, board, action?, maxIntents? }` (at least one) → 200 `{ goal }`. `action` applies
    `transition` (409 `Board is <state>` when null); `maxIntents` (positive integer or `"none"`) rewrites the line;
    raising it on a goal that is `state:stopped` with a conclusion containing `Stopped: intent limit` also sets
    `state:running`. Tag updates keep every other tag.
  - Goal = the board's `kind:goal` memory in `scope` (browse by `tagsAll`); none → 404 `Memory <board> not found`-style
    wording consistent with the store. `about` / `from` must be readable and tagged `board:<board>`, else 404.
  - If `relate` throws after `store`, `delete` the stored memory, then return the error.
- Only these routes build the embedder (reads stay lazy).

- [ ] Step 1: failing unit tests for the pure module: Review Focus 1 (folding, forged lines), marker prefix exactness,
  defaults, `withMaxIntents` keeps other lines byte for byte and adds a missing line (Review Focus 5), every
  `transition` pair (Review Focus 3). Route unit tests with a fake `WebStore`: shapes, 415, 409s, `about` link rules,
  rollback on relate failure, limit-resume.
- [ ] Step 2: integration tests (`withWorld`): `rw` adds a hint and an intent to a fresh board and they come back with
  the right content, tags and links; `ro` gets the store's write error; `none` gets 404; pause/resume/stop/restart
  round-trip the goal's tags.
- [ ] Step 3: run both — FAIL. Step 4: implement. Step 5: `deno task check && deno task test:unit && deno task test:int` PASS.
- [ ] Step 6: commit `feat(web-api): add hints, intents and board controls`.

### Task 3b: Amendments, and the worker no-steering rule (added in conversation)

Requirements: `.superpowers/sdd/2026-11-26-web-ui-hints-intents/task-3b-brief.md` is the working brief; in short:
`POST /amendments` and `amendmentContent` (server), `kind:amendment` + `amend` command + lead read/fallback rule +
worker step-1 read + the worker no-steering rule (skill), proxy allow-list entry, and Task 5's Add amendment form and
header-band placement. Spec section "Amendments". Commit `feat: amendments to a board's goal, and a worker no-steering rule`.

### Task 4: Proxy admits the write routes

**Files:** Modify `web/lib/proxy.ts`. Test: `tests/unit/web-server.test.ts`.

**Interfaces:** `proxyApi` allows `POST` for exactly `hints`, `intents`, `boards/control`; GET allow-list unchanged;
any other method/path pair 405/404 as now. POST checks per Global Constraints (403 `cross-site request refused`; 415
for a non-JSON content type; 413 over 16 KiB); forwards the body with `content-type: application/json`; 30 s timeout.

- [ ] Step 1: failing tests: Review Focus 2 (cross-site, missing headers with foreign `Origin`, `text/plain`), body cap,
  POST to a GET route 405, GET to a POST route 405, body forwarded byte for byte, token added.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS + `deno task check`. Step 5: commit `feat(web): proxy the write routes`.

### Task 5: Browser — forms and controls

**Files:** Modify `web/public/api.js` (`postJson(path, body, signal?)` throwing `ApiError`), `drawer.js`,
`board.js` (`pollNow()` on the object `mountBoard` returns; strip shows `paused`), `app.js` (pass scope/board and
`pollNow` in the drawer ctx), `style.css`. A pure helper module if logic warrants it (tested in
`tests/unit/web-public.test.ts`).

**Interfaces / behaviour:**
- Board tab only (ctx has scope and board). Memory tab, below the content:
  - **Add hint** (textarea + Add) on every node; `about` = the node id.
  - **Add intent** ("Try …", optional "Done when", optional "Give up when") on the goal and on facts (`from` = the
    fact); shown only while the board is running or paused; shows "this board has used <n> of <max> intents" (or "no
    limit") before submitting.
  - Truncated board → a warning that the new node may not appear.
- Goal drawer: **Controls** — Pause lead / Resume lead / Stop (confirm first, in-page, no browser dialog) / Restart
  (stopped boards, not done), and the intent limit box with Save and the note about the board file. After Restart or a
  limit-resume: "Now run `board-runner run <board file>` again."
- Every form: disabled while in flight; success clears it, says "Added — it will appear in the graph shortly", calls
  `pollNow()`; failure shows the server's error text. `textContent` only.

- [ ] Step 1: implement. Step 2: `deno task check && deno task test:unit` PASS.
- [ ] Step 3: local smoke (local stack only, member/scope per `scripts/seed-web-toy.ts`, own server on `WEB_PORT=8788`):
  add a hint and an intent, pause/resume, set the limit; the graph shows the new nodes and the strip shows `paused`.
- [ ] Step 4: commit `feat(web): add hints, intents and run controls from the drawer`.

### Task 6: Deploy, end-to-end, docs

**Files:** Modify `README.md` (Web UI section), `CLAUDE.md` (Web UI paragraph: no longer read-only), `runner/README.md`,
the design doc (status, builder's calls).

- [ ] Step 1: **ask the person** to redeploy `web-api`; only on a yes: `supabase functions deploy web-api --use-api --project-ref <ref> --yes`.
- [ ] Step 2: **ask the person** for a toy-board run on hosted (`agent-memory-tool`, skill link pointed at the worktree
  for the run, restored after). Check: the lead's `round:<n>` tags increase by one per round; Pause → lead ends
  `BOARD-LEAD paused`, workers finish open intents, runner checks every ~2 min; a person intent added while paused is
  claimed by a worker; Resume → planning continues; a hint appears and the lead's next round mentions weighing it;
  lowering the limit stops the board; raising it resumes. Delete the toy board afterwards.
- [ ] Step 3: run everything (check, unit, int, pgTAP, runner) — PASS.
- [ ] Step 4: docs. Step 5: commit `docs: web UI writes and run controls`.

## Self-review

- Spec coverage: shapes (T3), routes and validation (T3), proxy (T4), browser forms, controls, warnings (T5), skill
  commands, paused branch, drop protection, start/work changes (T2), runner paused line and heartbeat (T1), redeploy
  consent and toy check (T6), builder-check decisions (Global Constraints, T3, T5).
- Types: `transition` actions match the route's `action`; `LeadKind "paused"` matches lead.md's line; `pollNow` from
  T5's board.js is what the drawer calls.
