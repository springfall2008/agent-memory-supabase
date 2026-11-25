# Board runner: design

Status: approved, 2026-11-25.

## Intent

The blackboard skill (`skills/blackboard/`, design `2026-11-23-blackboard-skill-design.md`) lets several Claude Code
sessions work towards one goal through shared memory. On its first real board, pacing failed. All three intents were
finished within 20 minutes. The lead, paced by a self-timed `/loop`, did not plan again for about half an hour, so two
workers sat idle and then gave up. Nothing on the board can wake a session when a fact lands, so the skill alone cannot
fix this.

The **board runner** is a Python program that drives a board from outside the sessions:

- it keeps one lead running as an interactive Claude Code session in tmux, which the person can watch and talk to;
- it starts a fresh headless worker for each piece of work, up to a configured number of slots, each slot with its own
  model;
- it asks the lead for a round exactly when one is needed, because it sees every worker finish.

It is generic, like the skill. The runner and the skill live together in agent-memory-supabase. A project supplies a
**board file** that gives the goal, the measurement criteria and the settings, and the runner runs towards that goal.

## Goals

- `board-runner run <board file>` creates the board if it does not exist, then runs it until the goal is done, stopped or
  unreachable, or the person stops the runner.
- No worker slot is idle while a free intent exists. No free slot waits more than about a minute for a lead round once
  the board has no free intent.
- Slots are configured in the board file, for example one Opus, one Sonnet and one Ollama GLM worker.
- The lead is one long-lived interactive session. `tmux attach` shows the real Claude Code screen, and the person can
  talk to it between rounds.
- Every worker is a fresh `claude -p` process that does one intent and exits.
- Optionally, a `measure` command in the board file confirms "done" independently of the sessions.
- The skill still works without the runner, by hand or under `/loop`.

## Non-goals

- Reading or writing the board from Python. The runner never holds a memory token. It learns what happened only from
  the sessions' output (see the output contract below).
- Running on several machines. One runner drives one board on one machine. Hand-started sessions elsewhere may still
  join the same board, as today.
- A web UI or dashboard. `/blackboard status` and `tmux attach` are the views.
- Any knowledge of a domain (code, branches, benchmarks) in the runner. That lives in the board file's rules and
  `measure` command.
- Pushing, merging or opening PRs. These are forbidden by default, as in the skill.

## Anti-goals: it would fail even if it ran

- The runner types into the lead while the person is typing, or while the lead is mid-turn, and mangles both.
- The runner marks a goal done on the lead's say-so when a configured `measure` disagrees.
- A worker hangs on a permission prompt or runs forever, holding a slot and its claim.
- Killing the runner leaves orphaned workers running, or a lead claim that blocks the next runner with no way out.
- Predbat-specific behaviour creeps into the runner or the skill.

## Constraints

- Python 3.11 or later, standard library only. The board file is TOML, read with `tomllib`, so nothing needs
  installing apart from tmux (`brew install tmux`) and the `claude` CLI.
- The repo is otherwise Deno. CI gains a Python job that runs the runner's unit tests. The tests use fakes for tmux and
  `claude`, so CI needs neither.
- Claude Code 2.1.302 or later. The design relies on `--settings` (for a Stop hook), `--session-id`, `--resume`,
  `-p --output-format json`, `--permission-mode`, `--allowedTools`, `--disallowedTools` and `--model`.
- Ollama models are used the way batpred's `tools/triage_daemon.py` does it: `ANTHROPIC_BASE_URL` set to the local
  Ollama server, `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY` empty, and `--model <name>`. No spend cap is applied
  to Ollama models, because its estimate is priced for Anthropic.
- Workers run with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. A `claude -p` run ends at its last message, and anything it
  backgrounded would be lost. This was learnt in the triage daemon.
- The repo is public: no project refs, customer or personal names in committed files. The Predbat board file lives in
  batpred, not here.
- Commits and pushes happen only when the person asks.

## Approaches

### Where the runner lives and what it is written in

- **Chosen:** Python, in agent-memory-supabase, next to the generic skill. The person asked for Python. The runner is
  generic, so it belongs with the skill rather than in one project.
- Rejected: Deno, to match the repo's tooling. Rejected because the person asked for Python, which also matches the
  triage daemon they already run.
- Rejected: building it into batpred's triage daemon. That daemon is Predbat-specific and runs as a bot in a container
  with its own credentials. Board work needs the developer's own checkout and machine.

### How the lead lives

- **A, chosen: an interactive `claude` session in tmux.** The runner sends `/blackboard lead …` with
  `tmux send-keys`, and learns that a turn has ended from a Stop hook. The person keeps the real screen and can steer.
- B, rejected: a persistent Agent SDK session in Python. It has reliable turn boundaries but no real screen, and adds a
  dependency.
- C, rejected: `claude -p --resume <id>` each round. Simple, but the lead cannot be watched live.
- Also rejected earlier: a fresh lead each round. The person wants the lead's reasoning to carry over between rounds.

### Measurement

- **Chosen: an optional `measure` command, with the lead's judgement as the fallback.** With `measure` set, the lead in
  runner mode proposes a candidate instead of concluding, and the runner runs the command and reports the result to the
  lead, which concludes or carries on. Without it, the lead judges Done when from facts, as today.

## Decisions made with the user

- A runner that launches the lead and then a worker per work item, up to the slot count; workers exit when done and the
  runner starts the next (no worker `/loop`).
- Per-slot models, for example 1 × Opus and 1 × Sonnet.
- Runner and generic skill in agent-memory-supabase, not batpred. The runner takes the goal definition, measurement
  criteria and settings, and runs towards the goal.
- The lead stays running: an interactive session in tmux that the runner sends commands to (approach A).
- Workers are fresh each time.
- Each worker has a configurable runtime limit: per slot, with a board default.
- The project has an overall limit on how many intents it writes, for example 20. Reaching it stops the board, with
  the best result so far.
- The person can raise that limit and resume the board.

Decided by me (Claude), open to correction:

- Python standard library only; the board file is TOML.
- The runner is board-blind and parses output lines instead.
- `measure` is optional, as described above.
- The lead does no intents itself under the runner.

## Board file

A project keeps one TOML file per board, for example `boards/predbat-optimiser.toml` in batpred.

```toml
board = "predbat-optimiser"          # lower-case kebab
scope = "predbat-devs"               # shared-memory scope; must be writable
workspace = "~/predbat/batpred"      # cwd for the lead and every worker

goal = """Make the planning optimiser faster with no plan changes."""
done_when = """Best of three, interleaved with main, at least 40% faster than main on the same machine,
all 20 plans unchanged, kernel parity and pre-commit passing."""
rules = """How to work: …
How to verify: …
Evidence: …
Long output: …
Allowed beyond the base safety rules: …
Never: …"""

max_open_intents = 4                 # defaults as in start.md
claim_minutes = 90
max_intents = 20                     # total intents the board may ever write; optional, default no limit

[measure]                            # optional
command = "./tools/board-measure.sh" # run in workspace, with BOARD_CANDIDATE in its environment
pass_exit_code = 0                   # exit 0 means the candidate meets the goal; stdout is the evidence
timeout_minutes = 30
exclusive = true                     # drain workers before measuring (timings); default false

[lead]
model = "opus"
round_every_minutes = 20             # fallback heartbeat; must be under 30 (the lead claim)

[[worker]]
model = "opus"
timeout_minutes = 120                # this slot's runtime limit per run; default worker_timeout_minutes below
[[worker]]
model = "sonnet"
[[worker]]
model = "ollama:glm-5.3"             # "ollama:" prefix selects the Ollama route

[permissions]                        # applied to workers; the lead gets a fixed set (below)
allow = ["Bash(git worktree*)", "Bash(git commit*)", "Bash(python3 *)", "Edit", "Write", "Read", "Grep", "Glob"]
deny = ["Bash(git push*)"]
max_turns = 200                      # per worker run
max_budget_usd = 20                  # per worker run; Anthropic models only
worker_timeout_minutes = 180         # default runtime limit per worker run; default 2 × claim_minutes
```

- The board file is read once at start. Once the board exists, its goal and rules memories are the truth. If the
  file's goal, Done when or rules differ from the memories, the runner prints the difference (reported by the start run,
  below) and carries on with the board. It never rewrites a running board's memories.
- A `measure` command decides pass or fail by its exit code alone. This keeps the runner free of numbers and units. The
  project's script does the comparison (here, against main) and prints its evidence.

## Processes

```
board-runner (Python, foreground in the person's terminal)
 ├── tmux session  board-<board>   →  claude (interactive lead, --session-id <uuid>, Stop hook → events file)
 ├── worker slot 1  →  claude -p "/blackboard work <board> label=… runner"   (fresh each time)
 ├── worker slot 2  →  …
 └── measure command, when the lead proposes a candidate
```

State lives in `~/.board-runner/<board>/`, outside any repo:

- `runner.log`;
- `events.jsonl`, written by the lead's Stop hook;
- `lead-settings.json`, holding the hook and the lead's permissions;
- `workers/<slot>-<label>.log`, one log per worker run;
- `hold`, a file the person creates to pause sends to the lead;
- `state.json`: the lead's session id and label, and the running workers' process ids. A restarted runner uses it to
  resume the lead and clean up.

## The lead

**Start.** The runner makes the lead label `board-<board>-lead-<4 hex>` and a session uuid, and stores both in
`state.json` so a restart reuses them. It then starts:

```
tmux new-session -d -s board-<board> -c <workspace> \
  claude --session-id <uuid> --model <lead model> --settings <lead-settings.json> \
         "/blackboard lead <board> label=<lead label> runner"
```

If `state.json` holds a session id from an earlier run, the runner uses `--resume <uuid>` instead of `--session-id`, so
the conversation carries on.

**Turn ends.** `lead-settings.json` registers a Stop hook that runs `board-runner hook-stop <board>`. The hook reads the
hook input JSON from stdin, takes the last assistant message from `transcript_path`, and appends
`{time, session_id, last_line}` to `events.jsonl`. The runner tails that file. The lead is idle from a Stop event until
the runner sends the next command.

**Sending a command.** The runner sends only when all of these hold:

- the lead is idle;
- no `hold` file exists;
- the person has not typed in the last 30 seconds. The runner compares two `tmux capture-pane` snapshots of the input
  line before sending, and backs off if they differ or the line is not empty.

It sends the text with `tmux send-keys -l`, then `Enter`. The person's own messages to the lead also end in Stop events.
Those are told apart by having no runner-sent command pending, and the runner ignores them except as "idle".

**Lead permissions.** `lead-settings.json` allows `mcp__shared-memory__*`, `Bash(date*)`, `Bash(openssl rand*)` and
reading the skill directory. Anything else prompts in tmux, where the person can answer. If the lead has been busy for
longer than 15 minutes, the runner prints a warning to attach and look.

**Claim.** The lead's 30-minute claim on the goal is renewed by every round, and the heartbeat
(`round_every_minutes`, under 30) guarantees a round. On start, if the lead's first round is refused because a dead
runner's lead still holds the claim, the runner stops with a message. `board-runner run --takeover` sends the `takeover`
form instead.

## Workers

A worker is one `claude -p` run:

```
claude -p "/blackboard work <board> label=board-<board>-<4 hex> runner" \
  --output-format json --permission-mode dontAsk \
  --allowedTools <allow + mcp__shared-memory__*> --disallowedTools <deny> \
  --max-turns <n> [--max-budget-usd <n>] --model <model>
```

- It runs in `workspace`, with the Ollama environment for an `ollama:` model and
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- Its label is new for each run, which is safe because the worker takes and releases its claim within that one run.
- It may renew its claim during long work, as work.md step 5 says, so the claim does not bound its run time. Its
  runtime limit is its slot's `timeout_minutes`, or the board's `worker_timeout_minutes` (default `2 × claim_minutes`).
  At the limit, the runner kills it.
- After a kill, the runner runs a short headless `claude -p "/blackboard release <board> label=<the killed worker's
  label> minutes=<limit>"`, with the lead's permissions. For each claim the label still holds (`my_claims`, filtered by
  that session), it:
  - stores a hint, `Worker timed out after <limit> minutes on intent <id>`, linked `relates-to` the intent;
  - releases the claim.

  The intent goes straight back to the queue, and the lead sees why. If that run fails, the claim lapses after
  `claim_minutes` as before. The slot's next run starts after a 60-second back-off. *(My call, from the builder check.)*
- The lead drops, or splits into smaller intents, any intent with two timed-out hints, so an intent that is too big
  cannot use up workers for ever. *(My call.)*
- Its JSON `result` text is parsed for the output line below. A run that ends without one, or with a non-zero exit,
  counts as `lost`.

## Output contract

The skill gains a `runner` argument. In runner mode, a round or cycle ends with exactly one machine line as its last
line, after the usual `(label: …)` line.

| Line                                                | Meaning                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `BOARD-WORK fact <verdict> intent=<id>`             | Recorded a fact                                                        |
| `BOARD-WORK none`                                   | No free intent                                                         |
| `BOARD-WORK partial intent=<id>`                    | Claim lapsed; left a partial-result hint                               |
| `BOARD-WORK stopped`                                | Goal not running                                                       |
| `BOARD-LEAD running free=<n> open=<n>`              | Round done; `<n>` free (unclaimed open) intents, `<n>` open in all     |
| `BOARD-LEAD candidate <ref> free=<n> open=<n>`      | (command said `measure`) Done when appears met by `<ref>`; the round also planned as usual |
| `BOARD-LEAD done` / `BOARD-LEAD stopped`            | Goal concluded, or not running                                         |
| `BOARD-LEAD outgrown`                               | The intent list was truncated; the board needs a fresh start           |
| `BOARD-LEAD refused <holder> <until>`               | Another lead holds the goal                                            |
| `BOARD-START created <id>` / `exists` / `resumed` / `not-running` | Result of `start from=` (see Creating the board)          |

**Which side decides whether to measure** *(my call)*. The board file decides. The runner adds the word `measure` to
every lead command when `[measure]` is configured. A lead proposes a candidate only when its command says `measure`,
and concludes on its own otherwise. The goal's `Measure:` line is only for a lead running without the runner. If the
runner sees `BOARD-LEAD done` without having sent a `measured … pass`, it prints a warning: it cannot undo the
conclusion. Since its commands said `measure`, that would be a skill bug.

**A lead turn that ends without a `BOARD-LEAD` line** *(my call)*. This happens when the lead has asked the person
something, or has hit a permission prompt it cannot pass. The runner treats it as "needs the person":

- it stops sending, heartbeats included;
- it prints a loud warning, with the tmux attach command;
- it resumes when a later turn ends with a `BOARD-LEAD` line.

If the lead claim lapses meanwhile, the next round takes it back with the same label.

`<ref>` is whatever the facts name as the result: a branch, commit, path or artifact. The runner passes it to `measure`
as `BOARD_CANDIDATE` without interpreting it.

## Scheduling

The runner is a single-threaded event loop over three sources: Stop events, worker exits and a timer. It keeps
`free_hint`, the `free=` count from the last lead round, minus the workers started since.

- **On start:** create the board if needed, start the lead, and wait for its first round.
- **After a lead round** (`BOARD-LEAD running free=n`): start up to `n` workers in idle slots.
- **When a worker exits with `fact`:**
  - start a new worker in that slot if `free_hint > 0`;
  - mark a lead round as wanted, because new facts may prompt new intents.
- **When a worker exits with `none`:** the slot stays idle, and a lead round is wanted.
- **When a worker exits with `partial` or `lost`:** back off for 60 seconds, then treat it as `none`.
- **When a lead round is wanted:** send `/blackboard lead <board> label=<lead label> runner` as soon as sending is
  allowed. Several wants collapse into one round.
- **Timer:** if no round has been sent for `round_every_minutes`, want one.
- **`BOARD-LEAD candidate <ref> free=n open=n`:** refill slots from `free=` as for any round, then:
  1. Run `measure` with `BOARD_CANDIDATE=<ref>`.
     - With `[measure] exclusive = true`, start no workers until it finishes. Wait for running workers to finish first,
       up to their timeout. This is for timing measurements that busy workers would skew. The default is false.
  2. Send `/blackboard lead <board> label=<lead label> runner measure measured <ref> pass|fail`, followed by the
     command's last 20 lines of output.
  3. On a pass, the lead concludes. On a fail, it records the measurement as a fact and plans on.
  - Heartbeat rounds continue during a measurement, which keeps the lead claim alive. One candidate is measured at a
    time. A candidate proposed while another is being measured is queued, and a `<ref>` already measured is not
    measured again. *(My call, from the builder check.)*
- **`BOARD-LEAD outgrown`:** drain as for `done`, but leave the goal running, and tell the person to start a fresh
  board.
- **`done` or `stopped`, from the lead or from any worker:** start no more workers. Wait for running workers to finish,
  up to their timeout, then send `/exit` to the lead, kill the tmux session and exit.
- **Ctrl-C once:** stop starting workers, finish as for `done`, and leave the board running so another runner can
  continue it. **Ctrl-C twice:** kill the workers now. Their claims lapse after `claim_minutes`.

## Skill changes

The maintained skill moves back to `skills/blackboard/` in this repo. batpred PR #6348 is closed, and its pacing commit
(`a3fd6d9f`) is ported here first. The `~/.claude/skills/blackboard` symlink, which points at a batpred worktree for
now, goes back to this repo's `skills/blackboard/`. On top of that:

- **SKILL.md:**
  - A `label=<label>` argument for `lead` and `work`, used instead of making a label.
  - A `runner` argument that turns on runner mode.
  - `start <project> from=<board file>`, which reads the goal, rules and settings from the file and writes the board
    without asking, since the file is the person's approval.
  - The output contract table.
- **lead.md, in runner mode:**
  - Skip step 7 (no intents of its own) and step 9 (no pacing).
  - End with the `BOARD-LEAD` line.
  - With `measure` configured, "Done" becomes "propose": emit `candidate <ref>` instead of concluding. Conclude only on
    a `measured … pass` command. A `measured … fail` is recorded as a fact, with `verdict:refuted`, `derived-from` the
    facts that named the candidate.
  - The goal memory gains a `Measure: yes|no` line, written by `start from=`, so any lead (with or without the runner)
    knows whether to propose or conclude. A lead running without the runner, on a board with a measure, tells the
    person to run the measure.
- **work.md, in runner mode:** end with the `BOARD-WORK` line and **end the loop** (it is one cycle by construction).
- **lead.md, in runner mode, continued:**
  - The "outgrown" case ends with `BOARD-LEAD outgrown`.
  - A round given `measured <ref> …` handles that result first, then plans as usual.
  - The lead does not propose a `<ref>` it has already had measured.
- **start.md:** the `from=` path, which skips the questions and approval.
- **SKILL.md, a new `release <project> label=<label> minutes=<n>` command:** for every claim that label holds on the
  board's memories, store the timed-out hint and release the claim. The runner uses it after killing a worker.
- **Intent limit:**
  - `start from=` writes `Max intents: <n|none>` into the goal, next to `Max open intents`.
  - The lead counts every intent on the board, in any state, and stops planning at the limit. It does not count a
    split's replacements beyond the limit: a split may only happen while under it.
  - Once the limit is reached and no intent is open, the lead stops the board instead of planning:
    - it stores a conclusion, `Stopped: intent limit of <n> reached`, giving the best result so far and the facts
      behind it;
    - it sets the goal to `state:stopped`;
    - it ends with `BOARD-LEAD stopped`.
  - This works with or without the runner.
- **Raising the limit and resuming.** A new `resume <project> [max_intents=<n>]` command in SKILL.md does this:
  - it checks that the goal is `state:stopped` and that its conclusion starts `Stopped: intent limit`. A board stopped
    for any other reason is reported, not resumed;
  - it raises `Max intents` to `<n>`, which must be higher than the current limit, or removes the limit if no `<n>` is
    given;
  - it sets the goal back to `state:running`.

  The old conclusion stays. The next lead to conclude links its conclusion `supersedes` the old one, and from then on
  readers follow the newest conclusion.
  - With the runner, raise `max_intents` in the board file and run it again. When the start run finds the board stopped
    by its intent limit and the file's `max_intents` is higher, it resumes the board as above and ends with
    `BOARD-START resumed`. This is the only change `start from=` ever makes to an existing board.
- **Timed-out hints:** lead.md's Drop rule gains the rule above, two timed-out hints and the intent is dropped or split.

## Creating the board

The runner cannot look at the board, so on every start it runs one headless
`claude -p "/blackboard start <board> from=<board file path>"`, with the lead's permissions.

- If the board does not exist, that run creates it and ends with `BOARD-START created <goal id>`.
- If it exists, the run writes nothing. It compares the file's goal, Done when and rules with the memories, lists any
  differences, and ends with `BOARD-START exists`. The runner prints those differences.
- If the board was stopped by its intent limit and the file's `max_intents` is higher, the run resumes it (see Skill
  changes) and ends with `BOARD-START resumed`. The runner then carries on as for `exists`.
- If the board exists but is not running for any other reason, it ends with `BOARD-START not-running`, and the runner
  exits.

The runner never writes memories itself.

## Files

- `runner/board_runner.py`: the CLI (`run`, `hook-stop`, `status`) and the event loop.
- `runner/board_file.py`: TOML loading, validation and defaults.
- `runner/launch.py`: command lines and environments for the lead, workers and measure (Ollama route included).
- `runner/tmux.py`: a thin wrapper over the tmux CLI (new-session, send-keys, capture-pane, kill-session).
- `runner/tests/`: unit tests with fake `claude`, tmux and clock.
- `runner/README.md`: install, board file reference and how to watch and steer.
- `runner/examples/toy.toml`: a toy board for testing.
- `.github/workflows/ci.yml`: add a Python job (`python -m unittest` under `runner/`).
- `skills/blackboard/*`: the changes above.
- `README.md` and `CLAUDE.md`: a short runner section.

## Verification

- Unit tests cover:
  - board-file validation and defaults;
  - each output line's parse, including malformed and missing lines, which count as `lost`;
  - the scheduler's transitions as a table (event and state in, actions out), with a fake clock: idle slots refilled
    from `free=`, `none` wanting a round, several wants collapsing into one round, the heartbeat, the candidate → measure
    → send flow, `done` draining, Ctrl-C once and twice;
  - the send guard: no send while busy, while held, or while the input line is non-empty or changing;
  - worker timeout and kill, using the per-slot limit when it is set and the board default otherwise, followed by the
    `release` run and the back-off after `lost`;
  - the Ollama environment and the budget flag being omitted for Ollama models;
  - the Stop hook appending the last line from a sample transcript.
- An end-to-end toy run, the way the skill was tested: a `board:toy-*` board in `agent-memory-tool`, a board file whose
  goal a toy task meets in a few intents (as before, find the smallest n with a property), two cheap worker slots
  (haiku), a Sonnet lead and a toy `measure` script.
  - Check: no slot idles while free intents exist.
  - Check: the board reaches done through `candidate` → measure pass.
  - Check: a forced measure fail leads to more planning.
  - Check: Ctrl-C leaves the board running and a second runner resumes it.
  - Check: a toy board with `max_intents = 3` and a goal it cannot meet stops after 3 intents, with a conclusion giving
    the best result. After `max_intents` is raised to 5 in the board file, a second run resumes it. It plans
    further, and any new conclusion supersedes the first.
  - Check: a slot with `timeout_minutes = 1` on a slow toy intent is killed and released, and leaves a timed-out hint.
  - Delete the board afterwards.
- `/blackboard` by hand and under `/loop` still works. Re-run one hand-driven toy cycle.

## Left to the builder

- The exact transcript format parsing in `hook-stop`, as long as it yields the last assistant text line.
- Polling interval for `events.jsonl` and worker exits (about 1 s is fine).
- Log formats and `status` output.
- How "the person is typing" is detected, within the rule above.
- Whether `runner/` is a package with `python -m runner` or a single entry script, provided `board-runner` is documented
  as one command.
