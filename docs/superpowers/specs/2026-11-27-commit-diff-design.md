# Commit diffs in the web UI — design (small change)

Status: approved in conversation, 2026-11-27.

## Why

Board workers commit their work on local branches and write `Commit: <sha> on <branch>` into their facts. The person
wants to see those diffs from the web UI. The SHA is already in the database (in the fact). What a reader elsewhere
lacks is the repository it belongs to; and the commits stay local until someone pushes them.

## What

- **Repository in the database.** A board file may name its GitHub repository: `repo = "owner/name"` (optional). The
  start recipe writes it into the goal as a `Repo: owner/name` line after `Ideas model:`. For an existing board whose
  goal lacks a `Repo:` line, `start from=` adds that one line and changes nothing else: a second narrow exception to
  "from= never edits an existing board", allowed because it is metadata that cannot change what the board does.
  The runner accepts the key (it validates `owner/name`) and does nothing else with it.
- **View on GitHub.** A memory with a `Commit: <sha>` line shows a "View on GitHub (if pushed)" link to
  `https://github.com/<repo>/commit/<sha>` when the board's goal has a `Repo:` line. Shown anywhere, to anyone. No
  GitHub API call checks whether the commit exists.
- **Local Diff tab.** On the same memories, when the web UI runs on the machine with the board's workspace: a Diff tab
  in the drawer with two views, "This commit" (`git show <sha>`, the default) and "All changes vs main"
  (`git diff <base>...<sha>`, with its commit list; `<base>` is the first of `origin/HEAD`, `origin/main`, `main`,
  `master` that exists). Added lines green, removed red, hunk headers blue.
  - The runner records its board's workspace in `state.json` (`workspace`). The local web server reads it from
    `~/.board-runner/<board>/state.json` (or `$BOARD_RUNNER_HOME`), as the worker logs already do. Without it the tab
    says to restart the runner.
  - `GET /diff/<board>/<sha>?view=commit|main` on the local server: the board name and SHA must match strict shapes,
    the workspace must be a directory, the SHA must name a commit (`git cat-file -t`). `git` runs without a shell,
    with `--no-ext-diff --no-textconv` and `-c core.pager=cat`, a 10 s timeout and at most 2 MB of output (marked as
    cut short). `deno task web` gains `--allow-run=git` only.
- Nothing is pushed and nothing about pushing changes; `Commit: none` gets neither link nor tab.

## Approaches

A GitHub link alone needs the branches pushed, which the person does not want by default; a local diff alone is
invisible elsewhere. The person chose both: the repository in the database so the link works anywhere once pushed,
and the local diff for the machine that has the data.

## Left to the builder

Module boundaries (a pure `commitOf` / `githubCommitUrl` in the browser, a `web/lib/diff.ts` beside `logs.ts`), the
JSON shape of `/diff`, and the tab's layout.
