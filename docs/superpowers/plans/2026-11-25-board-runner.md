# Board Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Python board runner that keeps a blackboard lead running in tmux, starts a fresh headless worker per intent
up to the configured slots, and asks the lead for a round exactly when one is needed, with the skill changes it relies
on.

**Architecture:** The scheduler is pure: events go in and actions come out, with a fake clock in tests. Around it are
thin I/O modules for tmux, `claude` command lines, the Stop hook, and parsing the sessions' `BOARD-*` lines. The runner
never touches shared memory. The skill (`skills/blackboard/`) gains a runner mode, `label=`, `start from=`, `release`,
`resume` and an intent limit. Skill changes are tested as before, with subagents on throwaway `board:toy-*` boards.

**Tech Stack:** Python 3.11 or later, standard library only (`tomllib`, `subprocess`, `unittest`); tmux; Claude Code
CLI 2.1.302 or later; the shared-memory MCP tools.

**Spec:** `docs/superpowers/specs/2026-11-24-board-runner-design.md`. Read it in full first. The skill being changed
is described in `docs/superpowers/specs/2026-11-23-blackboard-skill-design.md`.

## Global Constraints

- Python 3.11+, standard library only. The board file is TOML, read with `tomllib`.
- Tests use `unittest`. Run them with `cd runner && python3 -m unittest discover -s tests -t .`. They use no real tmux,
  `claude`, network or shared memory.
- The runner never reads or writes shared memory, and never holds a memory token.
- Workers run `claude -p … --output-format json --permission-mode dontAsk`, with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- An `ollama:<name>` model means `--model <name>`, `ANTHROPIC_BASE_URL=$OLLAMA_BASE_URL` (default
  `http://localhost:11434`), `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY=""`, and no `--max-budget-usd`.
- `Bash(git push*)` is always in the workers' deny list, whatever the board file says.
- Runner state lives in `$BOARD_RUNNER_HOME/<board>/`, default `~/.board-runner/<board>/`, never inside a repo.
- Timings from the spec:
  - lead claim 30 min, so `round_every_minutes` must be 1–29 (default 20);
  - typing guard 30 s;
  - lead-busy warning after 15 min;
  - 60 s back-off after `partial` or `lost`;
  - `worker_timeout_minutes` defaults to `2 × claim_minutes`;
  - a measurement sends its output's last 20 lines.
- The repo is public: no project refs, customer or personal names. The Predbat board file goes in batpred, not here.
- Skill board memories use `state:` and `verdict:`, never `status:`. Every skill change keeps the existing behaviour
  when `runner` is absent.
- Commit after each task. Never push. Opening the PR is the person's call.

## Review Focus

1. **A Stop hook given garbage stdin, a missing transcript, or a transcript with no assistant text** must append
   nothing, or an event with empty text, and always exit 0. A crashing or exit-2 hook would block the lead from
   stopping. (Task 5)
2. **A worker's stdout that is empty, truncated, not JSON, or JSON with `is_error: true` and no `BOARD-WORK` line**
   (killed, crashed, over budget) gives `WorkResult("lost")` and never raises. (Task 3)
3. **The runner restarting while the lead's tmux session is still alive** must reuse that session. It must not start a
   second lead or kill the person's session. (Task 7)
4. **A PID in `state.json` reused by an unrelated process** after a reboot must not be killed. Only a process whose
   command line contains `/blackboard work <board>` is killed. (Task 7)
5. **A board file with a mistyped key** (`max_open_intent`), **an empty `ollama:` model**, or **no `[[worker]]`**
   fails with a `BoardFileError` naming the key. It never silently uses a default. (Task 2)

---

### Task 1: Skill runner mode: port the pacing fix, `label=`, `runner`, output lines

**Files:**
- Modify: `skills/blackboard/SKILL.md`, `skills/blackboard/lead.md`, `skills/blackboard/work.md`,
  `skills/blackboard/start.md`
- Symlink: `~/.claude/skills/blackboard` → `<repo>/skills/blackboard`

**Interfaces:**
- Produces, as the skill text Tasks 3 and 8 rely on:
  - `/blackboard lead <p> label=<l> runner [measure] [takeover] [measured <ref> pass|fail output=<path>]`
  - `/blackboard work <p> label=<l> runner`
  - the last-line forms `BOARD-WORK fact <verdict> intent=<id>` | `BOARD-WORK none` |
    `BOARD-WORK partial intent=<id>` | `BOARD-WORK stopped`
  - `BOARD-LEAD running free=<n> open=<n>` | `BOARD-LEAD candidate <ref> free=<n> open=<n>` | `BOARD-LEAD done` |
    `BOARD-LEAD stopped` | `BOARD-LEAD outgrown` | `BOARD-LEAD refused <holder> <until>`
- Ruling, recorded here so later tasks use it: measurement output goes in a file, and the lead command carries
  `output=<path>`. The spec's "last 20 lines" cannot follow the command, because a newline sent through tmux would
  submit the message early. The lead reads the file.

- [ ] **Step 1: Port the pacing fix.** Apply batpred commit `a3fd6d9f` to `skills/blackboard/`:
  `git -C ~/predbat/batpred show a3fd6d9f -- .claude/skills/blackboard`. Apply only the content changes, not the
  markdownlint heading and fence changes. Point the symlink back:
  `ln -sfn "$PWD/skills/blackboard" ~/.claude/skills/blackboard`.
- [ ] **Step 2: RED.** Create a toy board `toy-<hex>` in `agent-memory-tool` with a sonnet subagent running `start`. The
  goal: find the smallest n where n² ends in 444. Done when a fact confirms n and that no smaller n works. Max open
  intents 2. Then dispatch a haiku subagent with the skill path, told to run
  `/blackboard work toy-<hex> label=board-toy-<hex>-aaaa runner`.
  Expected: it makes its own label or ignores `runner`, and its last line is not a `BOARD-WORK` line. Record the
  output.
- [ ] **Step 3: Write the changes.**
  - **SKILL.md:**
    - the `label=` and `runner` arguments, with an explicit label overriding label-making;
    - the output-contract table (lines as above);
    - in runner mode, the line is the very last line, after `(label: …)`.
  - **work.md, in runner mode:**
    - end with the `BOARD-WORK` line matching the outcome (step 3 → `none`, step 6 refusal → `partial`, step 1 not
      running → `stopped`, step 7/8 → `fact`);
    - end the loop.
  - **lead.md, in runner mode:**
    - skip step 7 and step 9;
    - end with a `BOARD-LEAD` line: `free` counts open intents with no claim after this round's writes, and `open`
      counts all open intents;
    - step 3 refusal → `refused`;
    - step 4 truncated → `outgrown`;
    - Done or Unreachable → `done` or `stopped`.
  - **lead.md, with `measure` in the command:** Done becomes "propose":
    - emit `candidate <ref>`, where `<ref>` is what the proving facts name as the result;
    - never propose a `<ref>` already given a `measured` result;
    - on `measured <ref> pass output=<path>`: read the file, store a `verdict:confirmed` fact citing it and
      `derived-from` the facts naming `<ref>`, then do Done as today, with the conclusion also `derived-from` that
      fact;
    - on `fail`: store a `verdict:refuted` fact the same way, then plan.
  - **Goal template (start.md):** add a `Measure: yes|no` line. A lead whose goal says `Measure: yes`, when its command
    lacks `measure`, tells the person to run the measure instead of concluding.
- [ ] **Step 4: GREEN.** Rerun the step 2 worker with the skill. Expected:
  - it uses the given label for `claim_next`, which `my_claims` or the intent's claim shows;
  - its last line is `BOARD-WORK fact confirmed intent=<id>` (or `refuted`/`inconclusive`), or `BOARD-WORK none`.

  Then a sonnet lead `L1` runs `/blackboard lead toy-<hex> label=board-toy-<hex>-lead-bbbb runner measure`, a haiku
  worker does the rest, and `L1` runs again. Expected:
  - `BOARD-LEAD running free=<n> open=<n>` with counts matching `graph`;
  - then `BOARD-LEAD candidate <ref> …` and no conclusion;
  - after `… measured <ref> fail output=<file saying "fail: too slow">`, a refuted fact and further planning, with no
    conclusion;
  - after `pass`, `BOARD-LEAD done`, with a conclusion `derived-from` the confirmed measurement fact.

  Fix the text and rerun until all of these hold. Record each change in the ledger.
- [ ] **Step 5: Hand-mode regression.** A haiku worker runs `/blackboard work toy-<hex>` with no `runner`. Expected: it
  makes its own label and ends with `(label: …)` and no `BOARD-` line.
- [ ] **Step 6: Commit.** `git add skills/blackboard && git commit -m "feat(skill): runner mode, label= and BOARD- output lines"`.
  Keep the toy board for Task 2.

### Task 2: Skill board lifecycle: `start from=`, intent limit, `release`, `resume`, timed-out hints

**Files:**
- Modify: `skills/blackboard/SKILL.md`, `start.md`, `lead.md`
- Create: `runner/examples/toy.toml`, the spec's board file schema filled in for the toy goal (scope
  `agent-memory-tool`, two haiku slots, a sonnet lead, `max_intents = 3`, `[measure] command = "./measure.sh"`), plus
  `runner/examples/measure.sh`, which exits 0 when `BOARD_CANDIDATE` is the right n.

**Interfaces:**
- Consumes: the Task 1 output lines.
- Produces:
  - `/blackboard start <p> from=<path>` → `BOARD-START created <goal id>` | `exists` | `resumed` | `not-running`,
    printing any differences between the file and the memories before the line;
  - `/blackboard release <p> label=<l> minutes=<n>`;
  - `/blackboard resume <p> [max_intents=<n>]`;
  - a `Max intents: <n|none>` goal line;
  - the conclusion prefix `Stopped: intent limit of <n> reached`.

- [ ] **Step 1: RED.** A sonnet subagent runs `/blackboard start toy2-<hex> from=runner/examples/toy.toml`.
  Expected: it asks questions, or does not end with a `BOARD-START` line.
- [ ] **Step 2: Write the changes** as listed in the spec's Skill changes (start from=, Intent limit, Raising the limit
  and resuming, release, Timed-out hints).
  - `start from=` reads the TOML with the Read tool and maps `board, scope, goal, done_when, rules, max_open_intents,
    claim_minutes, max_intents, measure` into the templates, with `Measure: yes` when `[measure]` is present.
  - The only change `start from=` ever makes to an existing board is the `resumed` path.
- [ ] **Step 3: GREEN, all with subagents on `toy2-<hex>`:**
  - `start from=` → `BOARD-START created <id>`, and the goal shows `Max intents: 3` and `Measure: yes`. Run again →
    `BOARD-START exists`. Edit `done_when` in a copy of the file and run it → the difference is printed, then `exists`.
  - Change the goal to need more than 3 intents (n² ends in 4444, with max open intents 1). Leads and haiku workers run
    until the lead ends with `BOARD-LEAD stopped`. Expected:
    - exactly 3 intents;
    - a conclusion starting `Stopped: intent limit of 3 reached` that names the best result;
    - the goal `state:stopped`.
  - Set `max_intents = 5` in the copy and run `start from=` → `BOARD-START resumed`, with the goal `Max intents: 5`
    and `state:running`. A further lead round plans. Running `resume` on a board stopped by `stop` is reported and not
    resumed.
  - A worker claims an intent with label `board-toy2-<hex>-dead` and stops before storing anything (tell it to stop
    after claiming). Then `/blackboard release toy2-<hex> label=board-toy2-<hex>-dead minutes=1` →
    - the claim is gone;
    - a hint `Worker timed out after 1 minutes on intent <id>` `relates-to` that intent.

    Repeat once more on the same intent. The next lead round drops or splits it.
- [ ] **Step 4: Clean up and commit.** Delete both toy boards: browse with `tags_all ["board:toy-<hex>"]`, delete every
  result, and repeat for `toy2`. Then
  `git add skills/blackboard runner/examples && git commit -m "feat(skill): start from a board file, intent limit, release and resume"`.

### Task 3: `runner/board_runner/protocol.py`: parse sessions' output

**Files:**
- Create: `runner/board_runner/__init__.py` (empty), `runner/board_runner/protocol.py`,
  `runner/tests/__init__.py`, `runner/tests/test_protocol.py`

**Interfaces:**
- Produces:
  - `WorkResult(kind: Literal["fact","none","partial","stopped","lost"], verdict: str | None = None, intent: str | None = None)`
  - `LeadResult(kind: Literal["running","candidate","done","stopped","outgrown","refused","none"], free: int | None = None, open: int | None = None, ref: str | None = None, holder: str | None = None, until: str | None = None)`
  - `StartResult(kind: Literal["created","exists","resumed","not-running","lost"], goal_id: str | None = None, text: str = "")`
  - `claude_result_text(stdout: str) -> str | None`: the `result` field of `-p --output-format json` output, or `None`
    for anything unparsable.
  - `parse_work(text: str | None) -> WorkResult`, `parse_lead(text: str | None) -> LeadResult`,
    `parse_start(text: str | None) -> StartResult`.
  - All frozen dataclasses. Parsing scans lines bottom-up and uses the first line that starts with that parser's
    prefix (`BOARD-WORK`, `BOARD-LEAD`, `BOARD-START`).
- Ruling: the spec says "last line". Accepting the lowest prefixed line tolerates a model adding a trailing sentence,
  which would otherwise waste a run as `lost`.

- [ ] **Step 1: Write the failing tests** in `test_protocol.py`:
  - `parse_work("did it\n(label: x)\nBOARD-WORK fact confirmed intent=abc")` → `WorkResult("fact", "confirmed", "abc")`.
  - `"BOARD-WORK none"` → `none`; `"BOARD-WORK partial intent=abc"` → `partial`, intent `abc`; `"BOARD-WORK stopped"` →
    `stopped`.
  - `parse_work(None)`, `""`, `"no line"`, `"BOARD-WORK fact"` (no verdict), `"BOARD-WORK fact maybe intent=x"`
    (verdict not confirmed/refuted/inconclusive), `"BOARD-WORK banana"` → all `lost`.
  - A trailing sentence after the line still parses.
  - `parse_lead("BOARD-LEAD running free=2 open=3")` → `("running", free=2, open=3)`.
  - `"BOARD-LEAD candidate board/x/1a2b free=0 open=1"` → `candidate`, ref `board/x/1a2b`.
  - `done`, `stopped` and `outgrown` parse.
  - `"BOARD-LEAD refused me 2026-11-25T10:00:00Z"` → `refused`, with holder and until.
  - `"BOARD-LEAD running free=x"` and no line → `LeadResult("none")`.
  - `parse_start("diff: rules differ\nBOARD-START exists")` → `exists`, with `text` containing `rules differ`.
  - `created <id>`, `resumed` and `not-running` parse; no line → `lost`.
  - `claude_result_text('{"type":"result","result":"hi","is_error":false}')` → `"hi"`.
  - Each of these → `None`: `""`, `"{"`, `"[]"`, `'{"is_error":true}'`, `'{"result":5}'`.
- [ ] **Step 2: Run, expect failure.** `cd runner && python3 -m unittest tests.test_protocol -v` → `ModuleNotFoundError`
  or `ImportError`.
- [ ] **Step 3: Implement** with one compiled regex per line form.
- [ ] **Step 4: Run, expect pass.** Same command → OK.
- [ ] **Step 5: Commit** `feat(runner): parse BOARD- output lines`.

### Task 4: `runner/board_runner/board_file.py`: load and validate the board file

**Files:**
- Create: `runner/board_runner/board_file.py`, `runner/tests/test_board_file.py`

**Interfaces:**
- Produces:
  - `WorkerSlot(model: str, timeout_minutes: int)`
  - `Measure(command: str, pass_exit_code: int, timeout_minutes: int, exclusive: bool)`
  - `BoardFile(path: Path, board: str, scope: str, workspace: Path, goal: str, done_when: str, rules: str,
    max_open_intents: int, claim_minutes: int, max_intents: int | None, measure: Measure | None, lead_model: str,
    round_every_minutes: int, workers: tuple[WorkerSlot, ...], allow: tuple[str, ...], deny: tuple[str, ...],
    max_turns: int, max_budget_usd: float | None, worker_timeout_minutes: int)`. All frozen.
  - `class BoardFileError(ValueError)`.
  - `load_board_file(path: Path) -> BoardFile`.
- Defaults:
  - `max_open_intents = 4`, `claim_minutes = 60`, `max_intents = None`;
  - `lead.model = "opus"`, `lead.round_every_minutes = 20`;
  - `worker_timeout_minutes = 2 × claim_minutes`, and a slot's `timeout_minutes` defaults to that;
  - `max_turns = 200`, `max_budget_usd = None`;
  - `measure.pass_exit_code = 0`, `measure.timeout_minutes = 30`, `measure.exclusive = False`.
- Validation:
  - `board` matches `^[a-z0-9]+(-[a-z0-9]+)*$`;
  - `scope`, `goal`, `done_when` and `rules` are required non-empty strings;
  - `workspace` is expanded with `~` and must be an existing directory;
  - at least one `[[worker]]`;
  - model is non-empty, and `ollama:` needs a name after it;
  - integers are at least 1;
  - `round_every_minutes` is 1–29;
  - an unknown key, at the top level or in any table, gives `BoardFileError` naming it;
  - `deny` always gets `"Bash(git push*)"` added once.

- [ ] **Step 1: Write the failing tests**, building TOML strings in a temp dir:
  - the full spec example loads, with each field equal to the spec's values and `workspace` resolved;
  - a minimal file (required keys and one worker) gets every default above, including a slot timeout of 120 when
    `claim_minutes = 60`;
  - `[[worker]] timeout_minutes = 5` keeps 5;
  - `deny` has exactly one `Bash(git push*)` whether or not the file lists it;
  - each of these raises `BoardFileError` with the named key in the message:
    - `max_open_intent = 3` → `max_open_intent`;
    - `[lead] modle = "x"` → `modle`;
    - `model = "ollama:"` → `model`;
    - no workers → `worker`;
    - `round_every_minutes = 30` → `round_every_minutes`;
    - `board = "Bad_Name"` → `board`;
    - a missing workspace → `workspace`;
    - `claim_minutes = 0` → `claim_minutes`;
  - invalid TOML raises `BoardFileError`.
- [ ] **Step 2: Run, expect failure.** `python3 -m unittest tests.test_board_file -v`.
- [ ] **Step 3: Implement** `load_board_file`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(runner): board file loading and validation`.

### Task 5: `launch.py`, `tmux.py` and `hook.py`: commands, tmux and the Stop hook

**Files:**
- Create: `runner/board_runner/launch.py`, `runner/board_runner/tmux.py`, `runner/board_runner/hook.py`,
  `runner/tests/test_launch.py`, `runner/tests/test_tmux.py`, `runner/tests/test_hook.py`

**Interfaces:**
- Consumes: `BoardFile`, `WorkerSlot` (Task 4).
- Produces, in `launch.py`:
  - `new_label(board: str, role: Literal["lead", "worker"]) -> str`: `board-<board>-lead-<4 hex>` or
    `board-<board>-<4 hex>`.
  - `model_args_env(model: str, base_env: Mapping[str, str]) -> tuple[list[str], dict[str, str]]`: the `--model` args
    and a copied env with the Ollama overrides when the model is `ollama:`.
  - `worker_argv(bf: BoardFile, slot: WorkerSlot, label: str) -> list[str]`, and
    `worker_env(slot: WorkerSlot, base_env: Mapping[str, str]) -> dict[str, str]`, which always sets
    `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
  - `lead_prompt(board: str, label: str, *, measure: bool, takeover: bool = False, measured: tuple[str, bool, Path] | None = None) -> str`,
    a single line.
  - `lead_argv(bf: BoardFile, session_id: str, resume: bool, settings_path: Path, first_prompt: str) -> list[str]`.
  - `lead_settings(hook_argv: list[str] | None, runner_home: Path) -> dict`: a
    `{"permissions": {"allow": LEAD_ALLOW}, "hooks": {"Stop": [...]}}` settings object.
    - With `hook_argv=None` there is no `hooks` key. That form is written as `oneshot-settings.json` for the start and
      release one-shots.
    - The Stop hook must never fire for a one-shot: its events would be read as lead turns.
  - `LEAD_ALLOW: list[str]`: `mcp__shared-memory__*`, `Bash(date*)`, `Bash(openssl rand*)`,
    `Read(~/.claude/skills/blackboard/**)`, and `Read(<runner_home>/**)` added by `lead_settings`.
  - `oneshot_argv(bf: BoardFile, prompt: str, settings_path: Path) -> list[str]`, for `start from=` and `release`.
- Produces, in `tmux.py`: `class Tmux(run: Callable = subprocess.run)` with `has_session(name) -> bool`,
  `new_session(name, cwd: Path, argv: list[str]) -> None`, `send_line(name, text) -> None` (`send-keys -t name -l text`,
  then `send-keys -t name Enter`), `capture(name) -> str` (`capture-pane -p -t name`) and `kill_session(name) -> None`.
  Also `input_line(capture: str) -> str`, a module function: the text after the Claude Code prompt marker on the
  input box's line, or `""`. How the marker is found is the builder's call. Test it against two pane fixtures captured
  from a real `claude` session.
- Produces, in `hook.py`: `last_assistant_text(transcript_path: Path) -> str` and
  `hook_stop(events_path: Path, stdin_text: str, now: Callable[[], str]) -> None`. The latter appends one JSON line,
  `{"time", "session_id", "text"}`, with `text` capped at 4000 characters. It never raises.

- [ ] **Step 1: Write the failing tests.**
  - `worker_argv` for an Anthropic slot contains, in order of appearance:
    - `-p`;
    - `/blackboard work b label=L runner`;
    - `--output-format json`, `--permission-mode dontAsk`, `--allowedTools`;
    - the allow list joined with `,`, plus `mcp__shared-memory__*`;
    - `--disallowedTools`, `--max-turns 200` and `--model sonnet`;
    - `--max-budget-usd 20` when set.
  - For `ollama:glm-5.3`: `--model glm-5.3`, no `--max-budget-usd`, and an env with `ANTHROPIC_BASE_URL` (default, or
    `OLLAMA_BASE_URL` when set), `ANTHROPIC_AUTH_TOKEN=ollama` and `ANTHROPIC_API_KEY=""`.
  - `worker_env` always sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, and does not mutate `base_env`.
  - `lead_prompt("b", "L", measure=True, measured=("ref1", False, Path("/x/m.log")))` ==
    `"/blackboard lead b label=L runner measure measured ref1 fail output=/x/m.log"`. With no options: `/blackboard
    lead b label=L runner`. `takeover=True` adds ` takeover`. The result never contains a newline.
  - `lead_argv(resume=False)` has `--session-id <id>`, and `resume=True` has `--resume <id>`. Both have `--settings`
    and `--model`, with the prompt last.
  - `new_label` matches its regex.
  - `lead_settings` puts the hook argv under `hooks.Stop[0].hooks[0].command` as a shell-quoted string.
  - `Tmux` calls are asserted on a recording fake `run`:
    - `send_line` makes the two `send-keys` calls above;
    - `has_session` is True on return code 0;
    - `input_line` gives `""` for the empty-prompt fixture and `"hello"` for the typed fixture.
  - `hook_stop`:
    - given stdin `{"session_id":"s","transcript_path":"<tmp>/t.jsonl"}` and a transcript whose last assistant message
      text is `"x\nBOARD-LEAD done"`, it appends one line with `text` ending `BOARD-LEAD done`;
    - given stdin `"not json"`, `{}`, a missing transcript file, or a transcript with only user lines, it does not raise,
      and appends at most one line with `text == ""`.
- [ ] **Step 2: Run, expect failure.** `python3 -m unittest tests.test_launch tests.test_tmux tests.test_hook -v`.
- [ ] **Step 3: Implement.**
  - `last_assistant_text` reads the JSONL bottom-up, finds the last `type == "assistant"` record, and joins its
    `message.content` items of `type == "text"`.
  - For the pane fixtures, run `claude` in tmux once, capture it empty and with typed text, and save both under
    `runner/tests/fixtures/`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(runner): claude command lines, tmux wrapper and Stop hook`.

### Task 6: `runner/board_runner/scheduler.py`: the pure scheduler

**Files:**
- Create: `runner/board_runner/scheduler.py`, `runner/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `BoardFile`, `WorkResult`, `LeadResult`.
- Produces:
  - **Events:**
    - `LeadTurn(result: LeadResult)`;
    - `WorkerExit(slot: int, result: WorkResult)`;
    - `MeasureDone(ref: str, passed: bool, output: Path)`;
    - `Tick()`;
    - `Interrupt()`.
  - **Actions:**
    - `StartWorker(slot: int)`;
    - `KillWorker(slot: int)`;
    - `Release(label: str, minutes: int)`;
    - `RunMeasure(ref: str)`;
    - `Warn(message: str)`;
    - `Shutdown(kill_workers: bool)`.

    All are frozen dataclasses.
  - `class Scheduler(bf: BoardFile, now: float)`:
    - `on_event(event, now: float) -> list[Action]`;
    - `poll_send(now: float) -> str | None`: the lead prompt to send now, or None;
    - `sent(now: float) -> None`;
    - `worker_started(slot: int, label: str, now: float) -> None`.
  - The runner calls `poll_send` only when the hold file is absent and the typing guard passes. It then sends, and
    calls `sent`.
- Rules: implement the spec's Scheduling section and the "Which side decides whether to measure" and "lead turn that
  ends without a line" paragraphs.
  - The lead is idle after any `LeadTurn`, and pending between `sent` and the next `LeadTurn`.
  - A `LeadTurn` while not pending, and not needing the person, only marks the lead idle.
  - `none` while pending sets `needs_person`. After that, a `LeadTurn` with a line is processed as a round and clears
    it.
  - `free_hint` comes from `free=`, minus the workers started since.
  - `poll_send` returns a prompt only if:
    - the lead is idle, `needs_person` is false, and no shutdown is under way;
    - and either a round is wanted, or `now - last_sent ≥ round_every_minutes × 60`, or a measurement result is
      waiting to be sent.

    A waiting result goes first, as `measured …`.
  - The first prompt is sent by the runner as the lead's start prompt. The scheduler starts pending.
  - Startable slots are idle with `not_before ≤ now`. Slots are filled lowest index first.

- [ ] **Step 1: Write the failing tests.** Each test builds a `BoardFile` with 2 slots, `round_every_minutes = 20`,
  `claim_minutes = 60` and slot timeouts of 120, and drives events with explicit `now` values.
  - `LeadTurn(running free=1 open=2)` → `[StartWorker(0)]`, and `free=5` → `[StartWorker(0), StartWorker(1)]`.
  - `WorkerExit(0, fact)` with `free_hint` 1 → `StartWorker(0)`, and `poll_send` returns the round prompt. With
    `free_hint` 0 there is no start, but the round is still wanted.
  - `WorkerExit(0, none)` → no start; a round is wanted.
  - `WorkerExit(0, lost)` at t → slot 0 is not startable before t+60. After the next round with `free=1` at t+30 there
    is no start; at the `Tick` at t+61 → `StartWorker(0)`.
  - **Wants collapse:** two `fact` exits and a heartbeat while pending give no prompt. After `LeadTurn`, `poll_send`
    gives exactly one prompt, then `None` after `sent`.
  - **Heartbeat:** idle, nothing wanted; `poll_send` is `None` at last_sent+1199 and a prompt at last_sent+1200.
  - **Pending:** `poll_send` is `None` until a `LeadTurn` arrives.
  - **Needs the person:** a pending `LeadTurn(none)` → a `Warn`; heartbeats are suppressed (`poll_send` stays `None`
    even 30 min later). A later `LeadTurn(running free=1 …)` → `StartWorker` and sends resume.
  - **The person's own turn:** a `LeadTurn(running free=3 …)` while not pending and not needing the person → no
    `StartWorker`.
  - **Timeout:** a worker started at 0 in a slot with timeout 120 → at `Tick` 7199 nothing; at 7200
    `[KillWorker(0), Release(label, 120)]`.
  - **Candidate, not exclusive:** `LeadTurn(candidate r free=1 …)` → `StartWorker(0)` and `RunMeasure("r")`.
    `MeasureDone("r", False, p)` → `poll_send` gives `… runner measure measured r fail output=p`. A second
    `candidate r` → no `RunMeasure`. A `candidate s` while `r` is being measured → queued, with `RunMeasure("s")` after
    `MeasureDone("r")`.
  - **Candidate, exclusive, with a worker busy:** `LeadTurn(candidate r free=1)` → no `StartWorker` and no
    `RunMeasure`. `WorkerExit` of the last busy worker → `RunMeasure("r")`. Workers start again after `MeasureDone`.
  - **Measure flag:** with no `[measure]`, prompts lack ` measure`. A `LeadTurn(candidate …)` → `Warn` and no
    `RunMeasure`. With `[measure]` set, a `LeadTurn(done)` with no pass sent → `Warn`.
  - **Drain:** `done`, `stopped`, `outgrown` or `WorkerExit(stopped)` → no further `StartWorker`. When no worker is
    busy → `Shutdown(kill_workers=False)`. `outgrown` gives a `Warn` mentioning a fresh board.
  - **Refused:** `LeadTurn(refused …)` → a `Warn` naming the holder, then `Shutdown(False)` once drained.
  - **Interrupt:** a first `Interrupt` acts like drain. A second → `[KillWorker(i) for busy i] + [Shutdown(True)]`.
  - **Lead busy:** pending for 15 min → one `Warn`, not repeated on later ticks of the same turn.
- [ ] **Step 2: Run, expect failure.** `python3 -m unittest tests.test_scheduler -v`.
- [ ] **Step 3: Implement** `Scheduler`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(runner): pure event-driven scheduler`.

### Task 7: `runner/board_runner/cli.py` and `runner/board-runner`: the run loop

**Files:**
- Create: `runner/board_runner/cli.py`, `runner/board_runner/__main__.py`, `runner/board-runner` (executable; adds its
  directory to `sys.path` and calls `cli.main()`), `runner/tests/test_cli.py`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `main(argv: list[str] | None = None) -> int`, with subcommands:
    - `run <board file> [--takeover]`;
    - `hook-stop <board>`, which reads stdin and calls `hook_stop` on `<home>/<board>/events.jsonl`;
    - `status <board file>`, which prints `state.json` and whether the tmux session exists.
  - `class Runner(bf: BoardFile, home: Path, tmux: Tmux, popen: Callable, clock: Callable[[], float], sleep: Callable)`,
    with `run(takeover: bool) -> int`.
  - `state.json`: `{"lead_session_id", "lead_label", "workers": {"<slot>": {"pid", "label", "started_at"}}}`.

- `run(takeover)` does this, in order:
  1. **Check tmux.** If `tmux` is missing, exit 2 with `install tmux (brew install tmux)`.
  2. **Write the settings files.** Write `lead-settings.json` with
     `lead_settings([<abs runner/board-runner>, "hook-stop", board], home)`, and `oneshot-settings.json` with
     `lead_settings(None, home)`. Note the current size of `events.jsonl`, and read only lines appended after it, so
     an earlier run's events are never replayed.
  3. **Clean up workers from an earlier run.** For each PID in `state.json`, kill it only if
     `ps -p <pid> -o command=` contains `/blackboard work <board>`.
  4. **Make sure the board exists.** Run the start one-shot (`oneshot_argv` with `/blackboard start <board> from=<abs
     path>`, cwd workspace) and `parse_start` its result. Print `text`. If the result is `not-running` or `lost`, exit 1.
  5. **Start the lead,** unless `has_session("board-<board>")` is true:
     - load the lead id and label from `state.json`, or create them and save them;
     - `new_session` with `lead_argv`. Its first prompt comes from `lead_prompt(…, takeover=takeover)`, and `resume` is
       true when the id was loaded.

     If the tmux session is already alive, reuse it: send a round when the lead is idle, which is the first
     `poll_send` after the first event or heartbeat.
  6. **Loop every 1 s:**
     - read new lines of `events.jsonl` → `LeadTurn(parse_lead(text))`;
     - poll each worker → `WorkerExit(parse_work(claude_result_text(stdout file)))`;
     - poll the measure → `MeasureDone(passed = exit code == pass_exit_code, killed on timeout = fail)`;
     - `Tick`;
     - if the hold file is absent and the typing guard passes, `poll_send`, then `send_line` and `sent`;
     - carry out the actions:
       - `StartWorker`: Popen with `worker_argv` and `worker_env`, cwd the workspace, stdout to `workers/<slot>-<label>.json`
         and stderr to `.err`, then `worker_started` and save `state.json`;
       - `KillWorker`: terminate, then kill after 10 s;
       - `Release`: run the one-shot `/blackboard release …`;
       - `RunMeasure`: Popen `["bash", "-c", command]` with `BOARD_CANDIDATE`, output to `measure/<n>.log`;
       - `Warn`: print to stderr and `runner.log`;
       - `Shutdown`: send `/exit` to the lead, `kill_session`, clear `workers` in `state.json`, and return 0.
  7. **Signals:** SIGINT → an `Interrupt` event, so a second Ctrl-C reaches the scheduler too.

- The typing guard passes when `input_line(capture())` is `""` twice in a row, 30 s apart, with the earlier capture
  taken by the loop. It is not a blocking sleep.

- [ ] **Step 1: Write the failing tests** with a fake `Tmux`, a fake `popen` returning scripted process objects, and a
  fake clock:
  - **Happy path:**
    1. The start one-shot gives `BOARD-START created g1`.
    2. `new_session` is called once, with `--session-id`.
    3. An appended event `BOARD-LEAD running free=2 open=2` gives two worker Popens, with argv containing `label=` and
       `runner`.
    4. Both workers exit with `BOARD-WORK fact confirmed intent=i` JSON.
    5. One lead send is made after the guard passes.
    6. An event `BOARD-LEAD done` gives `/exit` sent, `kill_session`, and a return of 0.
  - **Review Focus 3:** with `has_session` true and a saved `state.json`, there is no `new_session` and no
    `kill_session` before shutdown.
  - **Restart without a tmux session:** a saved `state.json` with an id leads to `lead_argv` with `--resume <id>`.
  - **Review Focus 4:**
    - a `state.json` PID whose `ps` command line is `/usr/bin/vim` is not killed;
    - one whose command line contains `claude -p /blackboard work b label=…` is killed.
  - **Start one-shot results:** `not-running` exits 1 without starting tmux; no `BOARD-START` line also exits 1.
  - **Old events:** an `events.jsonl` that already holds `BOARD-LEAD done` from an earlier run causes no shutdown.
  - **One-shot settings:** the start and release one-shot argv's `--settings` is the hook-free `oneshot-settings.json`.
  - **Hold file:** while it exists, no `send_line` happens. After it is removed, a send happens.
  - **Typing guard:** while the input line is non-empty, there is no send.
  - **Exit codes:** with tmux missing (`has_session` raises `FileNotFoundError`), `run` returns 2.
  - **Ctrl-C:** two `Interrupt`s (signal handler called twice) → workers killed and a return of 0.
- [ ] **Step 2: Run, expect failure.** `python3 -m unittest tests.test_cli -v`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all runner tests.** `cd runner && python3 -m unittest discover -s tests -t . -v` → OK.
- [ ] **Step 5: Commit** `feat(runner): run loop, state file and CLI`.

### Task 8: CI, docs and an end-to-end toy run

**Files:**
- Modify: `.github/workflows/ci.yml`. Add a `runner` job: `actions/setup-python@v5` with `python-version: "3.11"`,
  then `cd runner && python -m unittest discover -s tests -t . -v`.
- Create: `runner/README.md`, covering:
  - install: tmux, the symlink, the PATH or alias for `runner/board-runner`;
  - the board file reference, every key with its default;
  - watching (`tmux attach -t board-<board>`, detach with Ctrl-b d), hold (`touch ~/.board-runner/<board>/hold`), and
    Ctrl-C once and twice;
  - raising `max_intents` and re-running;
  - logs.
- Modify: `README.md`, with a short "Board runner" section that links `runner/README.md`. Also say that
  `skills/blackboard/` is the maintained skill and that a project keeps only its board file.
- Modify: `CLAUDE.md`, with a "Board runner" paragraph under Architecture: the pure scheduler, board-blind design,
  output lines, and the toy-run test method.
- Modify: the spec's status line, to `implemented`, noting the builder's calls from the ledger.

- [ ] **Step 1: CI and docs.** Write them, then check: `deno task check` passes, and the `runner` job command passes
  locally.
- [ ] **Step 2: Install tmux.** Ask the person before `brew install tmux`, because it changes their machine.
- [ ] **Step 3: End-to-end toy run.** Copy `runner/examples/toy.toml` to the scratchpad with `board = "toy-<hex>"`,
  then `runner/board-runner run <copy>` in a background shell. Check each spec Verification item:
  - no slot idles for more than about a minute while the lead's last `free=` was above 0 (check `runner.log` times);
  - done is reached through `candidate`, then a measure pass;
  - with `measure.sh` edited to fail for the first candidate, a refuted fact and further planning follow;
  - Ctrl-C (SIGINT to the runner) leaves the goal `state:running`, and a second `run` resumes the same tmux lead, or
    resumes it with `--resume`;
  - the `max_intents` stop and resume (a 3-intent limit on the 4444 goal, then 5);
  - a slot with `timeout_minutes = 1` is killed, its claim released, and a timed-out hint left.

  Use haiku workers and a sonnet lead. Afterwards, delete every `board:toy-*` memory and `~/.board-runner/toy-*`.
- [ ] **Step 4: Hand-mode regression.** One `/blackboard work` cycle by hand on a fresh toy board still ends with
  `(label: …)` and no `BOARD-` line. Delete the board.
- [ ] **Step 5: Commit** `docs: board runner README, CI job and architecture notes`.

## Finish (after the final review)

- Close batpred PR #6348 with a comment saying the maintained skill lives in agent-memory-supabase. Remove its
  worktree. Ask the person first, because it is outward-facing.
- Offer to add `boards/predbat-optimiser.toml` to batpred, built from the current goal and rules memories, plus a
  `measure` script. That is a separate batpred PR.
- Update the shared-memory status memories: `fdfa526d` in `agent-memory-tool`, and `4afcc533` in `predbat-devs`, which
  becomes `status:done` once #6348 is closed. Store a new `status:in-review` memory for this branch's PR when it is
  opened.
