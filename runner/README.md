# Board runner

The board runner drives a [blackboard](../skills/blackboard/SKILL.md) board from a board file:

- It keeps one **lead** running as an interactive Claude Code session in tmux, which you can watch and talk to.
- It starts a fresh headless **worker** (`claude -p`) for each piece of work, up to one per configured slot. Each slot
  has its own model.
- It asks the lead for a round exactly when one is needed: as soon as a worker finishes or finds nothing to do, and at
  least every `round_every_minutes`.

The runner never reads or writes shared memory itself. It learns what happened from the `BOARD-` line that every
runner-mode session ends with. Design: `docs/superpowers/specs/2026-11-24-board-runner-design.md`.

## Install

- Python 3.11 or later; standard library only.
- tmux: `brew install tmux`.
- Claude Code 2.1.302 or later, with the `shared-memory` MCP server registered at user scope.
- The skill: `ln -s <this repo>/skills/blackboard ~/.claude/skills/blackboard`.
- Optionally, put `runner/board-runner` on your PATH or alias it.
- For `ollama:` models: a local `ollama serve` (and `ollama signin` for `:cloud` models). `OLLAMA_BASE_URL` overrides
  the default `http://localhost:11434`.

## Use

```sh
runner/board-runner run boards/my-board.toml          # create the board if needed, then run it
runner/board-runner run boards/my-board.toml --takeover   # the previous lead is dead but still holds the lead claim
runner/board-runner status boards/my-board.toml
```

- **Watch the lead:** `tmux attach -t board-<board>`, and detach with Ctrl-b d. You can talk to the lead between rounds.
  The runner only sends a command after your input box has been empty for 30 seconds.
- **Pause commands to the lead:** `touch ~/.board-runner/<board>/hold`. Delete the file to resume.
- **Ctrl-C once:** start no more workers, let the running ones finish, then exit. The board stays running, so a later
  `run` carries on with it. **Ctrl-C twice:** kill the workers now; their claims lapse after `claim_minutes`.
- **The lead needs you:** if a lead turn ends without a `BOARD-LEAD` line, for example because the lead asked you
  something, the runner stops sending and prints the attach command. It carries on after the lead's next proper round.
- **Raise the intent limit:** a board that reaches `max_intents` stops, and its conclusion gives the best result so far.
  Raise `max_intents` in the file and `run` again. The board resumes.

Runner state lives in `~/.board-runner/<board>/`, or under `$BOARD_RUNNER_HOME`:

- `runner.log`;
- `events.jsonl`, one line per lead turn, written by the lead's Stop hook;
- `workers/<slot>-<label>.jsonl` and `.err`, one pair per worker run: the `.jsonl` is the worker's `stream-json` transcript, written live, and the newest 200 runs are kept;
- `measure/<n>.log`, one per measurement;
- `state.json`, the lead's session and label plus the running workers, used to resume after a restart;
- the `lead-settings.json` and `oneshot-settings.json` the runner generates.

## Board file

TOML. Unknown keys are errors, so a typo is never silently ignored. See `examples/toy.toml`.

| Key                                    | Default                  | Meaning                                                                          |
| -------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `board`                                | required                 | Lower-case kebab name; the board's memories are tagged `board:<board>`           |
| `scope`                                | required                 | Shared-memory scope for the board; it must be writable                           |
| `workspace`                            | required                 | Working directory for the lead and every worker (`~` expanded)                   |
| `goal`, `done_when`, `rules`           | required                 | Written into the board's goal and rules memories when it is created              |
| `max_open_intents`                     | 4                        | At least one more than the number of workers                                     |
| `claim_minutes`                        | 60                       | How long a worker's claim lasts before it lapses                                 |
| `max_intents`                          | none                     | Total intents the board may write before it stops with its best result           |
| `[measure] command`                    | none                     | Run in `workspace` with `BOARD_CANDIDATE` set when the lead proposes a candidate |
| `[measure] pass_exit_code`             | 0                        | The exit code that means the candidate meets the goal                            |
| `[measure] timeout_minutes`            | 30                       | A measurement that runs longer fails                                             |
| `[measure] exclusive`                  | false                    | Let running workers finish, and start none, while measuring, for timings         |
| `[lead] model`                         | opus                     | Any `--model` value, or `ollama:<name>`                                          |
| `[lead] round_every_minutes`           | 20                       | Heartbeat round interval; 1 to 29, since the lead claim lasts 30                 |
| `[lead] ideas_model`                   | inherit                  | Model of the sub-agent the lead asks for ideas when stuck: inherit, name, none   |
| `[[worker]] model`                     | required                 | One table per slot                                                               |
| `[[worker]] timeout_minutes`           | `worker_timeout_minutes` | This slot's runtime limit per run                                                |
| `[permissions] allow`                  | none                     | Workers' `--allowedTools`; shared-memory tools are always added                  |
| `[permissions] deny`                   | none                     | Workers' `--disallowedTools`; `Bash(git push*)` is always added                  |
| `[permissions] max_turns`              | 200                      | Per run                                                                          |
| `[permissions] max_budget_usd`         | none                     | Per run, Anthropic models only                                                   |
| `[permissions] worker_timeout_minutes` | 2 × `claim_minutes`      | Default runtime limit per worker run                                             |

When a worker passes its runtime limit, the runner kills it and runs `/blackboard release`. That frees its claim and
leaves a "worker timed out" hint, and the lead drops or splits an intent that has timed out twice.

## Tests

```sh
cd runner && python3 -m unittest discover -s tests -t . -v
```

The tests use fakes for tmux, `claude`, processes and the clock. To test the whole system, run a copy of
`examples/toy.toml` with its board renamed to `toy-<hex>`, then delete the board's memories afterwards.
