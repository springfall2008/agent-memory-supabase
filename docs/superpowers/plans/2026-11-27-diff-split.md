# Side-by-side diffs and the conclusion's commit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub-style side-by-side diff in the drawer, with context control, and a conclusion that carries its commit.

**Architecture:** `/diff` gains `context`; a pure `web/public/diffparse.js` turns git's patch into files, hunks and
paired rows; `drawer.js` renders them; the skill's conclusion template gains `Commit:`.

**Tech Stack:** Deno server, plain ES modules, Markdown skill.

**Spec:** `docs/superpowers/specs/2026-11-27-diff-split-design.md`

## Global Constraints

- `context` is `3`, `10` (default) or `all` (`-U100000`); anything else 400 before git runs.
- Text only through `textContent`; no `innerHTML`.
- Pure modules `// @ts-check`, no DOM, tested under `deno task test:unit`.

## Review Focus

1. A rename, a new file, a deleted file and a binary file each render with the right header and no crash.
2. A patch cut at 2 MiB mid-hunk parses without throwing, and the last file is marked incomplete.
3. Removed and added runs of different lengths pair row by row, the leftovers alone.

### Task 1: Server context and the skill's conclusion `Commit:`

**Files:** `web/lib/diff.ts` (`context` param → `-U<n>` on `show` and `diff`), `tests/unit/web-diff.test.ts`,
`skills/blackboard/lead.md` (conclusion template line `Commit: <sha> on <branch>` "when the answer is a commit, copied
from the proving fact").

- [ ] Tests: `context=3|10|all` pass `-U3`, `-U10`, `-U100000`; default `-U10`; `context=5` and `context=all;x` → 400
  with git never run.
- [ ] Fail, implement, pass; `deno task check`.
- [ ] Commit `feat(web): diff context` and `feat(skill): a conclusion names its commit`.

### Task 2: Patch parser

**Files:** create `web/public/diffparse.js`: `parsePatch(text: string) -> { head: string; files: DiffFile[] }`,
`DiffFile = { oldPath: string | null; newPath: string | null; status: 'modified' | 'added' | 'deleted' | 'renamed' |
'binary'; adds: number; dels: number; hunks: Hunk[]; incomplete: boolean }`, `Hunk = { header: string; rows: Row[] }`,
`Row = { left: Cell | null; right: Cell | null }`, `Cell = { n: number; text: string; kind: 'context' | 'del' | 'add';
parts?: { text: string; changed: boolean }[] }`; `wordParts(a: string, b: string)` → the two sides' parts (common
prefix and suffix unchanged, the middle changed). Tests in `tests/unit/web-public.test.ts`.

- [ ] Tests: a modified file with one hunk (line numbers from `@@ -a,b +c,d @@`); 2 removed + 3 added lines pair as 2
  rows with both sides and 1 add-only row; a context row has the same text both sides; `--stat` and the commit message
  before the first `diff --git` go to `head`; a rename (`rename from`/`rename to`), `new file mode`, `deleted file
  mode`, `Binary files … differ`; `\ No newline at end of file` ignored; a patch cut mid-hunk → last file
  `incomplete: true`; `wordParts('a = 1', 'a = 2')` marks only `1`/`2`.
- [ ] Fail, implement, pass.
- [ ] Commit `feat(web): parse a patch into side-by-side rows`.

### Task 3: Render, context selector, full width, conclusion default; backfill

**Files:** `web/public/drawer.js` (render from `parsePatch`; context selector; conclusion opens on `main`; Full width),
`web/public/style.css`, `README.md` (Commits section). Data: add `Commit: faf6fed5 on board/predbat-memory/e98ecb9f`
to the predbat-memory conclusion after its first line (one-line update, as the `Repo:` backfill).

- [ ] `deno task check && deno task test:unit` pass; view in a browser where possible.
- [ ] Commit `feat(web): side-by-side diff with context and full width`.
