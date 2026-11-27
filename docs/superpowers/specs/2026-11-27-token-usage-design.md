# Token usage per board run — design

Status: approach agreed in conversation, 2026-11-27; this document awaits the person's approval.

## Why

The person wants to see what a board's work consumes, per worker and summed over the whole board, and may cap it later.
The only figures worth recording are raw token counts: Claude Code's dollar figure is invented for non-Anthropic models
(an ollama `glm-5.3:cloud` worker reports `costBasis: "unknown"` with a made-up USD), so no dollars are stored or shown.
The counts must live in the shared-memory database, because the runner can depend on the database being up but not on
the local web UI being active, and because anyone viewing a board elsewhere should see them.

## Goals

- When a worker exits, the runner records its token counts in a new database table, linked to the board, the worker's
  label and the intent it worked on.
- The lead's tokens are recorded too, so a board's total is its real consumption.
- The web UI shows a worker's counts on its intent and fact, the lead's on the goal, and the board's total in the
  status strip. Adding up happens in the reader (the web UI or anything else that reads the rows).
- Nothing is lost when the database cannot be reached: the runner keeps the rows and sends them later.

## Non-goals

- Dollar costs, price tables, or any estimate of spend.
- A cap. The table is shaped so a later cap can sum it, but no rule stops work on tokens yet.
- Showing counts through the MCP tools. Agents never see the rows, so a board's lead does not pay tokens to read them.
- Counts for sessions the runner did not start (a person running `/blackboard work` by hand).

## Anti-goals

- The runner reading the board. It gains one write (its usage rows) and still never reads shared memory: scheduling
  stays driven by the `BOARD-` lines.
- A database or network failure stopping or slowing a board. Recording is best effort with a durable retry.
- Counting a run twice. A retried or repeated send overwrites the same row.

## Approaches

1. **The runner writes a `board_usage` table through `web-api` (chosen).** The counts are exact, cost no model tokens,
   do not depend on the lead, and a cap can sum them in SQL. The runner needs a member token and stops being
   completely board-blind, for this one write.
2. The runner hands the counts to the lead, which writes them, as measurement results already travel. It keeps the
   runner board-blind and token-free, but every number passes through a model, costs lead tokens, and waits while the
   board is paused. Rejected.
3. One `kind:usage` memory per run. No migration, but each is embedded, takes graph slots (cap 400) and is read by the
   lead and workers in every `graph` call. Rejected for the table.

The person chose 1, and chose the table over memories.

## The table

New migration: `agent_memory.board_usage`, one row per worker run or per lead session.

- `id` uuid primary key; `scope_id` references `scopes` (on delete cascade); `board` text; `run_label` text (the worker
  label `board-<board>-<hex4>`, the lead label, or the one-shot's label); `role` `'worker' | 'lead' | 'start' |
  'release'`; `intent_id` uuid, nullable (no intent
  for `none`, `stopped`, `lost`, or the lead); `outcome` text, nullable (the `BOARD-WORK` kind and verdict, such as
  `fact confirmed`; null for the lead); `runner_model` text (the slot's model string from the board file, such as
  `opus` or `ollama:glm-5.3:cloud`).
- Totals: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` bigint, all `>= 0`; `turns` int,
  nullable; `duration_ms` bigint, nullable.
- `models` jsonb: per model name, the same four counts (from the transcript's `modelUsage`), so a reader can split a
  run that used more than one model. Bounded in size by the write function.
- `started_at`, `ended_at` timestamptz (the lead row's `ended_at` is its latest turn); `recorded_by` member;
  `created_at`, `updated_at`.
- Unique `(scope_id, board, run_label)`: the write is an upsert, so a retry or a lead update replaces the row.
- RLS: a member reads rows of scopes they can read; writes go only through a SECURITY DEFINER function
  `record_board_usage(...)` (`search_path = ''`, execute revoked from public, granted to `agent_memory_member`) that
  requires `can_write` on the scope, validates every value (non-negative, bounded text lengths, at most 20 models), and
  upserts. Following the rule that errors are user-safe, a scope the caller cannot write reads "Scope … not found".
  The intent id is kept only when it names a readable memory tagged `board:<board>` and `kind:intent` in that scope;
  otherwise it is stored as null, so a model's typo in a `BOARD-WORK` line cannot attach a run to the wrong intent.
- Deletion: `delete_board_usage(scope, board)` (SECURITY DEFINER, `can_write` on the scope, the same right that deletes
  the board's memories) removes a board's rows; the toy-board cleanup in the skill's test recipe and the runner docs
  calls it. Scope deletion cascades.
- Backup and restore (`scripts/backup.ts`) include the table.

## The write path

- **web-api** gains `POST /usage` (JSON: scope, board, run label, role, intent id, outcome, runner model, the totals,
  models, started/ended) that calls `record_board_usage` as the caller, and `GET /usage?scope=&board=` that returns the
  board's rows, newest first, with the summed totals. The local web server's allow-list gains `GET /api/usage` only;
  the browser never posts usage.
- **Runner credentials:** the person's own member token, the same one the web UI uses (`recorded_by` is then that
  member). `AGENT_MEMORY_TOKEN` and `WEB_API_URL` (or `AGENT_MEMORY_URL` with `agent-memory` replaced by `web-api`, as
  the web UI does) come from the runner's environment, or from an env file named by a new optional board-file setting
  `usage_env_file` (a path, never the secret itself; `~` expanded). Without them the runner logs one warning at start
  and still queues rows, so a later run that has them sends the backlog. A dedicated bot member is a follow-up.
- **Workers:** when a worker exits, the runner reads the transcript's final `result` line (`usage`, `modelUsage`,
  `num_turns`, `duration_ms`) for the counts. A worker killed before writing one (timeout, Ctrl-C twice) is counted by
  summing its `assistant` events' `message.usage`, once per message id, with `turns` and `duration_ms` left null. Old
  `.json` transcripts (before stream-json) carry the same result object.
- **One-shots:** the `/blackboard start` and `/blackboard release` sessions the runner starts are `claude -p` runs with
  the same result line; each gets a row (`role` `start` or `release`).
- **Orphans:** workers left by a crashed run are killed at start-up without passing through the exit path.
  `state.json` keeps each worker's transcript path, model and start time, and start-up queues a row for each orphan
  from its transcript (intent id from the transcript's final `BOARD-WORK` line if present, else null).
- **Lead:** after each lead turn (the Stop hook's event), the runner sums the lead session's Claude Code transcript —
  every assistant message's usage, once per message id, plus any sub-agent transcripts Claude Code keeps for that
  session (such as the ideas sub-agent) — and upserts the one lead row for that lead label. The hook records the
  transcript path it is given in its event so the runner need not guess it.
- **Sending and retry:** each row is appended to `~/.board-runner/<board>/usage-pending.jsonl` first, then sent;
  a sent row is removed. Sends happen off the scheduling path with a short timeout (5 s) and are retried each loop tick
  with backoff (up to every 5 minutes) until accepted. Only 400, 413 and 422 (a row that can never succeed) are logged
  and dropped. Everything else stays queued, including 401, 403 and 404, which mean a revoked token, a scope the token
  cannot write, or a runner newer than the hosted `web-api`. Each distinct failure is logged once, not every retry. The
  queue keeps at most 10,000 rows, dropping the oldest with a warning. On shutdown the runner makes one last attempt
  and leaves the rest queued.
- **Deploy order:** the migration and the `web-api` redeploy go out before a runner that sends usage is used; the queue
  covers the gap if they do not.

## The web UI

- **Drawer:** an intent or a fact shows the worker run(s) that worked on it (by intent id, else by the fact's worker
  label): role, model, input / output / cache read / cache write, turns, run time. The goal shows the lead's row.
- **Status strip:** "Tokens 12.4M in · 310k out" for the board (input counts include cache reads and writes, shown
  split in a tooltip). Fetched with the graph poll at a slower rate (every 30 s) since it changes only when a worker
  exits or a lead turn ends.
- Large numbers are shortened (k, M) with the exact figure in a tooltip.

## Decided after the builder check (Claude's calls, for the person to check)

- 401, 403 and 404 are retried, not dropped; the queue is capped at 10,000 rows.
- The runner's `start` and `release` one-shots, the lead's sub-agents, and workers orphaned by a crash are all counted,
  so the board's total covers everything the runner started.
- Rows are deleted per board by anyone who can write the scope (`delete_board_usage`), used by toy-board cleanup.
- The runner uses the person's own token, from the environment or a `usage_env_file`.
- A run's intent id is kept only when it names an intent of that board.

## Left to the builder

- Module boundaries in the runner (a `usage.py` alongside `protocol.py`, pure parsing tested with `unittest`, the sender
  isolated so the scheduler stays pure).
- The exact JSON names of the route and the rows, the response shape of `GET /usage`, and the drawer's layout.
- Whether the lead's row is kept per lead label (one per runner start) or per lead session id.
