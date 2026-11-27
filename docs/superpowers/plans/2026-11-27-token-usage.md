# Token usage per board run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board runner records every run's raw token counts in a new `board_usage` table through `web-api`, and the
web UI shows them per run and summed per board.

**Architecture:** A migration adds the table, a select policy and two SECURITY DEFINER functions (record, delete).
`web-api` gains `POST /usage`, `GET /usage` and `POST /usage/delete` on a new `PgUsageStore`. The Python runner parses
token counts from transcripts (pure `usage.py`), queues rows durably and sends them with retry (`usage_sender.py`),
and wires that into worker exit, orphans, one-shots and lead turns. The browser fetches `/api/usage` and shows it.

**Tech Stack:** Postgres migrations + pgTAP; Deno/TypeScript Edge Function; Python 3.11 stdlib + `unittest`; plain ES
modules.

**Spec:** `docs/superpowers/specs/2026-11-27-token-usage-design.md`

## Global Constraints

- Raw token counts only: never store, compute or show dollars (`total_cost_usd`, `costUSD` are ignored).
- Schema change is a new migration (`supabase/migrations/20261127120000_board_usage.sql`); it must build from empty with
  `supabase db reset`. SECURITY DEFINER functions use `set search_path = ''`, fully qualified names, execute revoked
  from public and granted to `agent_memory_member`.
- Bind timestamps as text and cast (`${x}::text::timestamptz`).
- Errors reaching a client are user-safe: `Scope '<name>' not found` for an absent or unreadable scope, `No write access
  to scope '<name>'` for a readable one the caller cannot write (the existing store wording); other database errors
  become `Database error`.
- `role` is one of `worker`, `lead`, `start`, `release`. Unique key `(scope_id, board, run_label)`; every write is an
  upsert.
- Limits: board and run label 1–100 chars, outcome ≤ 40, runner model ≤ 100, at most 20 models, model names 1–100
  chars, every count a non-negative integer ≤ 2^53 − 1.
- The runner never reads shared memory. Its only network call is posting or deleting its own usage rows.
- The runner must never crash, block the loop for more than the send timeout (5 s), or slow scheduling because usage
  could not be parsed or sent. `scheduler.py` stays pure and unchanged.
- Sender: drop (with one log line) only on 400, 413, 422; keep and retry everything else, including 401, 403, 404 and
  network errors; backoff doubling from 5 s to at most 300 s; queue cap 10,000 rows, oldest dropped with a warning;
  each distinct failure logged once until a send succeeds.
- Credentials: `AGENT_MEMORY_TOKEN`, and `WEB_API_URL` or `AGENT_MEMORY_URL` with the path segment `agent-memory`
  replaced by `web-api`; from the environment, else from the file named by the optional board-file key
  `usage_env_file` (`KEY=value` lines, `#` comments, optional quotes; `~` expanded). Never log the token.
- Agents never see usage: no MCP tool changes.
- Repo is public: no project ref, company or personal names in committed files.

## Review Focus

1. A transcript cut off mid-line, or with no `result` line, still yields counts from its `assistant` events, each
   message id counted once even when Claude Code writes several lines for one message.
2. A runner started before the hosted migration and redeploy (404 on `/usage`) keeps every row queued and sends it once
   the route exists; a restart in between loses nothing (the queue file survives, rows with the same key coalesce).
3. The lead row is replaced, not added to, after each turn: many turns produce one row per lead label with growing
   totals, and the pending queue holds at most one row per key.
4. A `BOARD-WORK` intent id that is not a uuid, or names a memory that is not an intent of that board, is stored as null
   rather than failing the row.
5. The local web UI and the browser never post usage: `/api/usage` is GET-only through the proxy.

---

### Task 1: The `board_usage` table and its functions

**Files:**
- Create: `supabase/migrations/20261127120000_board_usage.sql`
- Test: `supabase/tests/database/18_board_usage.test.sql`

**Interfaces:**
- Produces (SQL):
  - table `agent_memory.board_usage` with columns as in the spec ("The table"), `check (role in ('worker','lead','start','release'))`,
    count columns `bigint not null default 0 check (>= 0)`, `models jsonb not null default '{}'`,
    unique `(scope_id, board, run_label)`, index on `(scope_id, board)`.
  - policy `board_usage_select` for select to `agent_memory_member` using `agent_memory.can_read(scope_id)`; grant
    select only (no insert/update/delete grants).
  - `agent_memory.record_board_usage(p_scope text, p_board text, p_label text, p_role text, p_intent text,
    p_outcome text, p_runner_model text, p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint,
    p_turns int, p_duration_ms bigint, p_models jsonb, p_started text, p_ended text) returns uuid` — resolves the scope
    by name (absent or unreadable → `Scope '%' not found`; not writable → `No write access to scope '%'`), validates
    every limit, keeps `p_intent` only when it is a uuid naming an undeleted memory in that scope tagged
    `board:<p_board>` and `kind:intent`, upserts on the unique key (updating every value and `updated_at`), and
    returns the row id. `recorded_by` is `agent_memory.current_member_id()`.
  - `agent_memory.delete_board_usage(p_scope text, p_board text) returns int` — same scope checks, deletes the board's
    rows, returns the count.

- [ ] **Step 1: Write the pgTAP test** `18_board_usage.test.sql`, using the fixtures style of `14_memory_claims.test.sql`.
  Assertions: the table, policy and both functions exist with `search_path=''`; a writer records a row and reads it
  back; recording the same `(scope, board, label)` again leaves one row with the new totals; a reader without write
  gets `No write access to scope '…'`; a member with no grant gets `Scope '…' not found` and selects zero rows; a
  negative count, a role `boss`, 21 models and a 101-character label each raise; `p_intent` set to `'not-a-uuid'`, to
  the id of a `kind:fact` memory, and to an intent of another board each store null, while a real intent of the board
  is kept; `delete_board_usage` returns the count and leaves other boards' rows; a member cannot insert into the table
  directly; deleting the scope cascades.
- [ ] **Step 2: Run** `supabase db reset && supabase test db` — expect `18_board_usage` to fail (no table).
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run** `supabase db reset && supabase test db` — all pass.
- [ ] **Step 5: Commit** `feat(db): board_usage table with record and delete functions`.

### Task 2: `web-api` usage routes, store and backup

**Files:**
- Create: `supabase/functions/_shared/usage-store.ts`
- Modify: `supabase/functions/_shared/web-api.ts`, `supabase/functions/web-api/index.ts`, `scripts/backup.ts`
- Test: `tests/unit/web-api.test.ts`, `tests/integration/usage-store.test.ts` (new), `tests/integration/web-api.test.ts`,
  `tests/integration/backup.test.ts`

**Interfaces:**
- Consumes: Task 1's SQL functions.
- Produces:
  - `type UsageRole = 'worker' | 'lead' | 'start' | 'release'`
  - `interface ModelTokens { input: number; output: number; cacheRead: number; cacheWrite: number }`
  - `interface UsageRow { scope: string; board: string; runLabel: string; role: UsageRole; intentId: string | null;
    outcome: string | null; runnerModel: string; tokens: ModelTokens; turns: number | null; durationMs: number | null;
    models: Record<string, ModelTokens>; startedAt: string | null; endedAt: string | null }`
  - `interface UsageStore { record(r: UsageRow): Promise<string>; forBoard(scope: string, board: string):
    Promise<{ runs: (UsageRow & { id: string; recordedBy: string; updatedAt: string })[]; total: ModelTokens;
    more: boolean }>; deleteBoard(scope: string, board: string): Promise<number> }`, implemented by
    `PgUsageStore(sql, memberId)` with the `run`/`withMember` error handling of `PgThreadStore`. `forBoard` returns at
    most 1000 runs, newest `updated_at` first, and `total` summed in SQL over all the board's rows.
  - `routeWebApi(req, store, usage: UsageStore)`: `POST /usage` (JSON body = `UsageRow`, validated in TS with the
    Global Constraints limits → 400 on any violation, `{ id }` on success), `GET /usage?scope=&board=` (both required),
    `POST /usage/delete` (`{ scope, board }` → `{ deleted }`). Same JSON-body and size rules as the other write routes.

- [ ] **Step 1: Unit tests** in `tests/unit/web-api.test.ts` with a fake `UsageStore`: `POST /usage` passes a valid row
  through unchanged; rejects a negative count, `role: 'boss'`, a 21-model map, a missing `runLabel` and a fractional
  count with 400; `GET /usage` without `board` is 400 and with both passes them through; `POST /usage/delete` returns
  `{ deleted }`; a `GET` to `/usage/delete` is 405. Update the existing helpers to pass a fake `UsageStore`.
- [ ] **Step 2: Integration tests** in `tests/integration/usage-store.test.ts`: record, upsert (one row, new totals),
  `forBoard` totals across three rows, `deleteBoard` count, reader sees, `none` member gets `Scope '…' not found`,
  `ro` gets `No write access…`. Add one `web-api` integration test that posts a row and reads it back. Add `board_usage`
  to `backup.test.ts`'s round-trip.
- [ ] **Step 3: Run** `deno task test:unit` and the three integration files — expect failures.
- [ ] **Step 4: Implement** the store, the routes, `index.ts` wiring, and backup/restore of `board_usage` (rows by scope
  name and `recorded_by` member name, timestamps as text, following `memory_claims`).
- [ ] **Step 5: Run** `deno task check && deno task test:unit && deno task test:int` — pass.
- [ ] **Step 6: Commit** `feat(web-api): record, read and delete board usage`.

### Task 3: Runner — token counts from transcripts

**Files:**
- Create: `runner/board_runner/usage.py`
- Test: `runner/tests/test_usage.py`, fixtures under `runner/tests/fixtures/usage/`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Tokens: input: int = 0; output: int = 0; cache_read: int = 0; cache_write: int = 0`
    with `__add__`.
  - `@dataclass(frozen=True) class RunUsage: tokens: Tokens; models: dict[str, Tokens]; turns: int | None;
    duration_ms: int | None`
  - `def run_usage(stdout: str) -> RunUsage | None` — from `claude -p` output (`json` or `stream-json`): the last
    `result` object's `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
    `cache_creation_input_tokens`), `modelUsage` (`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
    `cacheCreationInputTokens`), `num_turns`, `duration_ms`. Without a result object, the sum of `assistant` events'
    `message.usage`, once per `message.id`, models keyed by `message.model`, `turns`/`duration_ms` None. None when
    nothing is found.
  - `def session_usage(transcript: Path) -> RunUsage` — an interactive session's transcript plus every
    `<transcript without .jsonl>/subagents/*.jsonl`: assistant `message.usage` once per `message.id` (per file),
    models by `message.model`, `turns` = number of distinct assistant message ids in the main file, `duration_ms` None.
    Missing or unreadable files count as zero.
  - `def usage_row(*, scope, board, run_label, role, intent_id, outcome, runner_model, usage: RunUsage, started_at,
    ended_at) -> dict` — the JSON body of `POST /usage` (camelCase names of Task 2's `UsageRow`; timestamps ISO-8601 UTC
    strings or None).

- [ ] **Step 1: Tests** with fixtures cut from real transcripts (no names or secrets): a stream-json worker with a result
  line (counts equal its `usage`, models from `modelUsage`, turns and duration set); the same file with the result
  line removed and the last line cut mid-JSON (counts are the per-message sum, a message id repeated over three lines
  counted once); an old `.json` single-object output; a non-Claude model (`glm-5.3:cloud`) whose `costUSD` is ignored;
  an empty file → None; a session transcript with one subagent file → sums both; `usage_row` round-trips through
  `json.dumps` with exactly Task 2's keys.
- [ ] **Step 2: Run** `cd runner && python3 -m unittest tests.test_usage` — fail.
- [ ] **Step 3: Implement** `usage.py`.
- [ ] **Step 4: Run** `cd runner && python3 -m unittest` — pass.
- [ ] **Step 5: Commit** `feat(runner): read token counts from transcripts`.

### Task 4: Runner — durable queue and sender

**Files:**
- Create: `runner/board_runner/usage_sender.py`
- Modify: `runner/board_runner/board_file.py` (optional top-level `usage_env_file`, a path string)
- Test: `runner/tests/test_usage_sender.py`, `runner/tests/test_board_file.py`

**Interfaces:**
- Produces:
  - `def usage_config(env: Mapping[str, str], env_file: Path | None) -> tuple[str, str] | None` — `(usage_url,
    token)`, where `usage_url` ends in `/usage`; None when no token or URL.
  - `class UsageQueue(path: Path, post: Callable[[str, dict], int], clock: Callable[[], float], log: Callable[[str,
    bool], None])` with `add(row: dict) -> None` (appends to the file, replacing a pending row with the same
    `(scope, board, runLabel)`), `flush(now: float) -> None` (sends due rows in order, stops at the first failure),
    `pending() -> int`. `post(path, body)` returns the HTTP status, or 0 for a network error or timeout; `path` is
    `"/usage"` or `"/usage/delete"`.
  - `def http_post(base_url: str, token: str, timeout: float = 5.0) -> Callable[[str, dict], int]` — urllib, JSON,
    `Authorization: Bearer`.
  - `BoardFile.usage_env_file: Path | None`.

- [ ] **Step 1: Tests** with a fake `post` and clock: a 200 removes the row from the file; 400, 413, 422 drop it with one
  log line; 401, 403, 404, 500 and 0 keep it, and the next attempt waits 5, 10, 20 … s capped at 300; a later 200
  resets the backoff and sends the rest in order; the same failure logged once across many retries; adding a row with
  an existing key leaves one pending row with the new totals; 10,001 adds keep 10,000 with a warning; a new
  `UsageQueue` on the same file sees the rows a previous one left; a corrupt line in the file is skipped.
  `usage_config`: env wins over the file; `AGENT_MEMORY_URL` `…/functions/v1/agent-memory` becomes `…/functions/v1/web-api/usage`;
  quotes and comments in the env file; no token → None. Board file: `usage_env_file = "~/x.env"` loads expanded; absent
  → None; a non-string → `BoardFileError`.
- [ ] **Step 2: Run** `cd runner && python3 -m unittest tests.test_usage_sender tests.test_board_file` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd runner && python3 -m unittest` — pass.
- [ ] **Step 5: Commit** `feat(runner): queue and send usage rows with retry`.

### Task 5: Runner — record every run

**Files:**
- Modify: `runner/board_runner/cli.py`, `runner/board_runner/hook.py`, `runner/board_runner/launch.py` (labels for
  one-shots), `runner/README.md`
- Test: `runner/tests/test_cli.py`, `runner/tests/test_hook.py`

**Interfaces:**
- Consumes: Task 3's `run_usage`, `session_usage`, `usage_row`; Task 4's `UsageQueue`, `usage_config`, `http_post`.
- Produces:
  - `Runner(..., usage_post: Callable[[str, dict], int] | None = None, env: Mapping[str, str] = os.environ)`: when
    `usage_post` is None it is built from `usage_config`; with no config, one warning at start ("token usage is queued
    but not sent: set AGENT_MEMORY_TOKEN and WEB_API_URL, or usage_env_file") and rows are still queued. The queue file
    is `<home>/<board>/usage-pending.jsonl`. `flush` runs once per loop tick and once at shutdown.
  - Worker exit (`_poll_workers`): a `worker` row from `run_usage` of the transcript, `intent_id` = the parsed
    `BOARD-WORK` intent, `outcome` = `fact <verdict>` / `partial` / `none` / `stopped` / `lost`, `runner_model` = the
    slot's model, `started_at` from the state's `started_at`, `ended_at` now. No row when `run_usage` is None.
  - `state.json` workers entries gain `path` and `model`; `_kill_orphans` queues a row for each orphan from its
    transcript (`outcome` from `parse_work(claude_result_text(...))`, else `lost`).
  - `start` one-shot: a `start` row from its stdout, label `new_label(board, "start")`. Release one-shots write stdout to
    `<home>/<board>/oneshots/<label>.json` instead of DEVNULL; `_reap_releases` queues a `release` row for each finished
    one, label `new_label(board, "release")`, and deletes the file. `new_label` accepts `"start"` and `"release"`
    (`board-<board>-start-<hex4>`, `board-<board>-release-<hex4>`).
  - `hook_stop` adds `"transcript_path"` to each event. On each lead event the runner queues a `lead` row for the lead
    label from `session_usage(transcript_path)`, `started_at` the runner's start time.
  - New command `board-runner forget-usage <board file>`: posts `/usage/delete` for the board and prints the count;
    exit 1 with the error when it fails.

- [ ] **Step 1: Tests** (fakes as in `test_cli.py`; a fake `usage_post` recording calls): a worker that exits with a
  stream-json transcript queues and sends one `worker` row with its intent id and `fact confirmed`; a worker transcript
  with no result line still sends summed counts; a worker with an empty transcript sends nothing; an orphan in
  `state.json` with a transcript gets a row at start; a `start` and a `release` one-shot each send a row; two lead
  events with a growing transcript send one `lead` key whose second body has the larger totals; `usage_post` returning
  404 leaves the rows in `usage-pending.jsonl` and the runner keeps scheduling; `hook_stop` writes `transcript_path`;
  `forget-usage` posts `{scope, board}` to `/usage/delete`.
- [ ] **Step 2: Run** `cd runner && python3 -m unittest` — fail.
- [ ] **Step 3: Implement**, then update `runner/README.md` (what is recorded, credentials, `usage_env_file`, the queue
  file, `forget-usage`, deploy order).
- [ ] **Step 4: Run** `cd runner && python3 -m unittest` — pass.
- [ ] **Step 5: Commit** `feat(runner): record token usage for workers, lead and one-shots`.

### Task 6: Web UI — show usage

**Files:**
- Create: `web/public/usage.js` (pure, `// @ts-check`, no DOM)
- Modify: `web/lib/proxy.ts` (GET allow-list gains `usage`), `web/public/board.js`, `web/public/drawer.js`,
  `web/public/style.css`, `README.md` (Web UI section)
- Test: `tests/unit/web-public.test.ts`, `tests/unit/web-server.test.ts`

**Interfaces:**
- Consumes: `GET /api/usage?scope=&board=` → Task 2's `forBoard` shape.
- Produces (`usage.js`):
  - `formatTokens(n: number) -> string` — `0`, `999`, `1.2k`, `12k`, `1.2M`, `12M` (one decimal under 10 of a unit).
  - `inputTotal(t) -> number` — input + cache read + cache write.
  - `stripText(total) -> string` — `Tokens 12M in · 310k out`; `Tokens: none yet` when all zero.
  - `runsFor(runs, node) -> runs` — for an intent: runs whose `intentId` is its id; for a fact: runs whose `runLabel`
    is the fact's worker label (from `workerLabel` in `names.js`); for the goal: `lead` runs; else none.

- [ ] **Step 1: Tests**: `formatTokens` for 0, 999, 1000, 1234, 12345, 1234567, 12345678; `stripText` for zero and a
  sample; `runsFor` for an intent, a fact with a `By:` label, the goal and a hint; the proxy forwards `GET
  /api/usage?...` and refuses `POST /api/usage` with 405.
- [ ] **Step 2: Run** `deno task test:unit` — fail.
- [ ] **Step 3: Implement**: board view fetches `/usage` on first load and then at most every 30 s inside the poll loop
  (a failed fetch keeps the last figures); the strip shows `stripText` after the intent limit with a tooltip splitting
  input, cache read, cache write and output exactly; the drawer's Memory tab shows a "Tokens" block for `runsFor` (role,
  runner model, the four counts, turns, run time) with exact figures in tooltips. `textContent` only.
- [ ] **Step 4: Run** `deno task check && deno task test:unit` — pass. Local smoke on the local stack: seed rows with
  `POST /usage` for a toy board and check the strip and drawers.
- [ ] **Step 5: Commit** `feat(web): show token usage per run and per board`.

### Task 7: Docs

**Files:** Modify `CLAUDE.md` (Board runner and Web UI paragraphs: the runner's one write, `board_usage`, credentials,
the deploy order; `forget-usage` in the toy-board test recipe), `docs/superpowers/specs/2026-11-24-board-runner-design.md`
is not edited (the new spec supersedes the board-blind point).

- [ ] **Step 1:** Edit; `deno fmt --check` passes.
- [ ] **Step 2: Commit** `docs: token usage in CLAUDE.md`.

## After merge (not tasks; each needs the person's yes)

1. `supabase db push --remote --dry-run`, a backup, then `supabase db push --remote`.
2. `supabase functions deploy web-api --use-api`.
3. Restart board runners from the updated checkout, with `AGENT_MEMORY_TOKEN` and `WEB_API_URL` (or `usage_env_file`).
