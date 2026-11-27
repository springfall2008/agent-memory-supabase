# Commit diffs in the web UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a worker's commit as a GitHub link (from a `Repo:` goal line) and as a local diff in the drawer.

**Architecture:** The runner accepts `repo` and records its workspace in `state.json`; the skill's start recipe writes
`Repo:` into the goal; the local web server gains `GET /diff/<board>/<sha>`; the drawer gains the link and a Diff tab.

**Tech Stack:** Python 3.11 stdlib; Markdown skill; Deno server; plain ES modules.

**Spec:** `docs/superpowers/specs/2026-11-27-commit-diff-design.md`

## Global Constraints

- `repo` is `owner/name`: `^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$`, at most 100 characters.
- A commit is the first `^Commit: ([0-9a-f]{7,40})\b` line of a memory's content; `Commit: none` is no commit.
- Link: `https://github.com/<repo>/commit/<sha>`, text "View on GitHub (if pushed)", `rel="noopener noreferrer"`,
  `target="_blank"`.
- `/diff`: board `^[a-z0-9]+(-[a-z0-9]+)*$`, SHA `^[0-9a-f]{7,40}$`, `view` `commit` (default) or `main`; git with no
  shell, `--no-pager`, `-c core.pager=cat`, `--no-ext-diff --no-textconv`, `-C <workspace>`; 10 s timeout; output
  capped at 2 MiB with `truncated: true`. GET only, like `/logs`. Errors: 400 bad shape, 404 no workspace recorded /
  unknown board / not a commit, 504 timeout. `deno task web` adds `--allow-run=git` and nothing else.
- Browser text through `textContent` only; no `innerHTML`.

## Review Focus

1. A SHA or board that is not the exact shape never reaches `git`; `view` other than the two values is 400.
2. A huge diff is cut at 2 MiB without breaking a UTF-8 sequence, and says so.
3. A board whose state has no `workspace` (runner not restarted) shows a clear message, not an error.
4. `Commit: none on …` gives neither link nor tab.

### Task 1: Runner and skill

**Files:** `runner/board_runner/board_file.py` (optional `repo`, validated), `runner/board_runner/cli.py` (`state["workspace"] = str(bf.workspace)` when the state is saved at start), `skills/blackboard/start.md` (goal template `Repo:` line when the file has `repo`; step 4 adds a missing `Repo:` line only), `skills/blackboard/SKILL.md` if it lists goal lines, `runner/README.md` (board file table). Tests: `runner/tests/test_board_file.py`, `runner/tests/test_cli.py`.

- [ ] Tests: `repo = "springfall2008/batpred"` loads; absent → None; `"not a repo"` and a 101-character value → `BoardFileError` naming `repo`; after `run`, `state.json` has `workspace` equal to the board file's workspace.
- [ ] Run `cd runner && python3 -m unittest` — fail; implement; pass.
- [ ] Commit `feat(runner): repo key and the workspace in state.json`, then the skill edit as `feat(skill): Repo line in the goal`.

### Task 2: Local `/diff` route

**Files:** create `web/lib/diff.ts` (`serveDiff(url: URL, runnerHome: string, run?: GitRunner): Promise<Response>`, with `type GitRunner = (cwd: string, args: string[], timeoutMs: number) => Promise<{ code: number; out: Uint8Array; timedOut: boolean }>`), modify `web/server.ts` (route `/diff/`), `deno.json` (`--allow-run=git`). Tests: `tests/unit/web-server.test.ts`.

**Produces:** `GET /diff/<board>/<sha>?view=commit|main` → 200 `{ sha, view, base: string | null, text: string, truncated: boolean }`.

- [ ] Tests with a fake `GitRunner` and a temp runner home: bad board / SHA / view → 400 and the runner is never called; no state file or no `workspace` → 404 `{ error: 'No workspace recorded for this board: restart its board-runner' }`; `cat-file` not `commit` → 404; `view=commit` runs `show --stat --patch` with the safety flags; `view=main` resolves the first existing base and runs `diff --stat --patch <base>...<sha>` plus `log --oneline`; output over 2 MiB is cut at a UTF-8 boundary with `truncated: true`; a timeout → 504; POST → 405.
- [ ] One test against a real temp git repo (two commits) for both views.
- [ ] Run `deno task check && deno task test:unit` — fail; implement; pass.
- [ ] Commit `feat(web): local /diff route for a board's commits`.

### Task 3: Drawer link and Diff tab

**Files:** `web/public/commits.js` (pure: `commitOf(content): { sha: string; branch: string | null } | null`, `githubCommitUrl(repo, sha): string | null` (null unless `repo` matches the shape)), `web/public/status.js` (`parseStatus` gains `repo`), `web/public/drawer.js` (link under the content; a Diff tab with the two views), `web/public/style.css`, `README.md` (Web UI: the Diff tab and the `repo` key). Tests: `tests/unit/web-public.test.ts`.

- [ ] Tests: `commitOf` for `Commit: faf6fed5 on board/x/e98ecb9f`, a 40-char SHA, `Commit: none; branch …` → null, no line → null, uppercase → null; `githubCommitUrl('springfall2008/batpred', 'faf6fed5')`; a bad repo → null; `parseStatus` reads `Repo:`.
- [ ] Run `deno task test:unit` — fail; implement; pass; `deno task check`.
- [ ] Local smoke on the local server: a fact from a live board shows the link and both diff views.
- [ ] Commit `feat(web): GitHub link and local Diff tab for a fact's commit`.
