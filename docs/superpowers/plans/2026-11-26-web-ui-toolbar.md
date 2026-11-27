# Web UI board toolbar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the board actions (pause/resume/stop/restart, intent limit, add hint/intent/amendment) from the goal's drawer to a toolbar on the Board tab, leaving only node-specific shortcuts in the drawer.

**Architecture:** Browser only. A new `web/public/toolbar.js` mounted by `board.js` under the status strip reuses the form and control building blocks from `forms.js` / `controls.js` and the pure rules in `writes.js`. The strip's intent limit becomes an inline editor. No server or skill change.

**Tech Stack:** plain ES modules, Deno for lint/format/unit tests.

**Spec:** `docs/superpowers/specs/2026-11-26-web-ui-toolbar-design.md`

## Global Constraints

- Same routes and payloads as today (`POST /api/hints`, `/intents`, `/amendments`, `/boards/control`); toolbar hints and intents send no `about` / `from`.
- Controls shown only when valid for the goal's state (`controlActions` in `writes.js`); Stop confirms inline with focus on Cancel; no browser dialogs.
- After a successful write: clear the form, say "Added — it will appear in the graph shortly", `pollNow()`. After a 409 from a control: re-read state and re-render.
- Never `window`; never `innerHTML` with untrusted text; pure modules `// @ts-check`, no DOM; `deno task check` lints/formats `web/public`.
- Board view only (not a tag view, not Browse).

## Review Focus

1. Switching boards while a toolbar panel or Stop confirmation is open must close it and never send for the old board.
2. A write from the toolbar and a write from a drawer shortcut in flight at once must each report on their own form.
3. The inline limit editor: Enter saves once; Escape and blur cancel; an invalid value shows the existing message without sending.

### Task 1: Board toolbar

**Files:** Create `web/public/toolbar.js`. Modify `web/public/board.js` (mount the toolbar under the strip; make the
strip's limit an inline editor; close panels on board switch), `web/public/drawer.js` / `forms.js` / `controls.js`
(goal drawer read-only; drawer keeps only the two collapsed shortcuts), `web/public/style.css`, `README.md` (Web UI
section: where the controls are now). Tests: `tests/unit/web-public.test.ts` for any new pure helper.

- [ ] Step 1: implement per the spec.
- [ ] Step 2: `deno task check && deno task test:unit` PASS.
- [ ] Step 3: local smoke (local stack only; your own server on `WEB_PORT=8788`): each toolbar action and both drawer shortcuts post the expected body; a board switch closes an open panel.
- [ ] Step 4: commit `feat(web): board toolbar for hints, intents, amendments and run controls`.
