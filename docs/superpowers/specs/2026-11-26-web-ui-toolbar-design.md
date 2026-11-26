# Web UI: board toolbar — design (small change)

Status: approved in conversation, 2026-11-26. Changes where the controls from
`2026-11-26-web-ui-hints-intents-design.md` live; no server change.

## Why

The person found Add hint, Add intent, Add amendment and the run controls buried: they sat in the goal node's drawer
below the progress block and goal text, and Add hint at the bottom of every node's drawer. They are board actions, so
they belong on the Board tab's bar, where the person is already looking.

## What changes

- **Toolbar** on the Board tab, a row directly under the status strip, shown only for a board view (not a tag view):
  - State controls valid for the goal's state: **Pause lead** (running) or **Resume lead** (paused); **Stop…**
    (running or paused), confirmed inline under the toolbar with focus on Cancel; **Restart** (stopped, not done),
    followed by "Now run `board-runner run <board file>` again to restart the workers."
  - **+ Hint**, **+ Intent** (running or paused), **+ Amendment** (not done). Each opens its form in one panel under the
    toolbar; only one panel is open at a time; Escape or the same button closes it. A hint or intent added here is
    board-wide (no `about` / `from`).
- **Intent limit** in the status strip: "Intents 14 of 20" — the limit is a button; clicking it turns it into a small
  input (number or `none`) with Enter to save, Escape to cancel, and the note about the board file's `max_intents` as a
  tooltip. A done board shows it as plain text.
- **Drawer** keeps only node-specific shortcuts, at the bottom of the Memory tab, collapsed to one line each until
  clicked: "Hint about this node" on any board node (`about` = node), and "Try next from this fact" on facts (an intent
  with `from` = the fact) while running or paused.
- **Goal drawer** becomes read-only again: progress block, goal text, the amendments list. Its Controls, Add intent and
  Add amendment move to the toolbar.
- Everything else is unchanged: same routes and payloads, same pure rules in `writes.js`, same `pollNow()` after a
  write, same 409 handling (re-read state, re-render), same in-flight disabling, `textContent` only, no browser dialogs.

## Approaches

The person picked the toolbar over keeping the forms in the drawer; a separate "Board" drawer tab was not considered
needed. One sensible way.

## Left to the builder

Toolbar styling and wrapping at narrow widths; module boundaries (a `toolbar.js` reusing `forms.js` / `controls.js`
building blocks is expected).
