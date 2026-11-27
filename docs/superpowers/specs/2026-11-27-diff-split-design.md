# Side-by-side diffs and the conclusion's commit — design (small change)

Status: approved in conversation, 2026-11-27. Builds on `2026-11-27-commit-diff-design.md`.

## Why

The person found the plain patch hard to read and wants GitHub's "Files changed" view: scroll through every file, old
and new side by side, with context. And a board's goal-met conclusion showed no diff, because the conclusion template
has no `Commit:` line; its final change is the whole winning branch, not one commit.

## What

- **Conclusion commit.** The skill's conclusion template gains `Commit: <sha> on <branch>`, copied from the proving
  fact, when the answer is a commit. The predbat-memory conclusion is backfilled with that one line. In the drawer, a
  conclusion's Diff tab opens on "All changes vs main"; other memories still open on "This commit".
- **Side-by-side view.** The Diff tab renders the patch as GitHub does: the commit message (or the commit list) at the
  top, then one card per file down the page. Each card has a header with the path (old → new for a rename), its +/−
  counts and a fold toggle, and a two-column table: old line numbers and text on the left, new on the right, removed
  rows red and added rows green, a changed pair aligned on one row with the changed words marked, hunk headers as
  separator rows. A binary file says so. Long lines scroll within the card.
- **Context.** A selector of 3, 10 (default) or whole file. `/diff` takes `context=3|10|all` (`all` is `-U100000`);
  anything else is 400. The 2 MiB cap stays; a cut diff says so and its last file is marked incomplete.
- **Width.** A "Full width" button on the Diff tab widens the drawer to the page (less the graph's minimum), and again
  back to the person's width.

## Approaches

The person chose side-by-side over a single-column view. Rendering is done in the browser from git's unified patch, so
the server keeps one simple route; a server-side split would need a second format for no gain.

## Left to the builder

The parser's shape (a pure `diffparse.js`), the word-level algorithm (common prefix and suffix is enough), and styling.
