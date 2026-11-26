# Web UI: design

Status: implemented, 2026-11-26. See "Builder's calls" at the end for what was decided while building.

## Intent

A person should be able to look at the memory store and at a running board without driving an agent to do it.

- **Browse:** find memories by text or by walking the newest first, in a table, and see how they connect.
- **Watch a board live:** see a blackboard board as a graph that updates as workers claim intents and record facts,
  and click any node to see what was done.

Today the only views are `/blackboard status`, `tmux attach` and MCP tool output, which show one slice at a time and
cannot show how results derive from each other.

The first version is a **local** app for one person on their own machine. It is built so that the same browser code
can later be hosted behind a login.

## Goals

- A **Browse** tab. A search box takes text. With the box empty it browses newest first and returns N at a time, like
  `search` with no query on the MCP. Filters: scope, tags (any / all), category. A table of results, and a detail
  drawer for the selected memory.
- A **Board** tab. A board picker, then a graph of that board (the memories tagged `board:<project>`), with a status
  strip: goal state, round, intents used of the limit, the lead's latest progress line.
- **Live:** the board view updates every few seconds without a reload. A new node appears, a changed node (claim taken
  or released, state tag changed) flashes, and the page shows when it last refreshed and whether the connection is
  working.
- **Labels on nodes** in the graph: an intent shows its `Intent:` line, a fact shows the one-line result from
  `Fact for intent <id>: <result>`, a hint its first words. Trimmed to about 28 characters, full text on hover.
  Colours show kind (goal, intent, fact, hint, conclusion). Fact colour shows the verdict. A ring shows an active
  claim, and the holder's label.
- **Click a node** and a drawer opens with tabs: **Memory** (full content, tags, scope, category), **Links** (in and
  out, click through), and **Worker log** (see below).
- **Worker log:** for an intent that a worker did or is doing, the local server shows that worker's full transcript:
  what it said, each tool it called, and each result, with long results collapsed. While the worker is running, the
  log follows it live, so the person sees what the agent is doing now, not only the fact it recorded at the end. This
  needs a small runner change (see "Runner change").
- The same drawer works from the Browse table and from the graph. A "Graph" button on any tag shows that tag's graph.

## Non-goals

- **Writing.** The first version is read-only: no hints, no stopping a board, no edits. These come later as a separate
  decision.
- **Hosting and login.** Not in this version. The design only has to leave the door open (see Later).
- **A History tab.** Members cannot read `memory_history` (row-level security is on and no policy grants access), so
  it needs a new migration and a function that decides what a member may see of a changed or moved memory. It is
  deferred by the person's decision, and there is no history route.
- **Controlling the runner**, or starting boards.
- **Admin screens** (members, scopes, grants, tokens).
- **Push.** Live means short polling. Supabase Realtime cannot apply row-level security to members, who authenticate
  with bearer tokens and not Supabase Auth.
- Mobile layouts.

## Anti-goals: it would fail even if it ran

- A poll every few seconds exhausts the Edge Function CPU budget (about 1 s per request) or hits platform rate limits,
  so the live view stalls.
- The UI shows something the signed-in member cannot read, or reveals by error text or counts that something exists
  that they cannot read.
- The page looks live but is quietly stale, with no sign of it.
- The token ends up in the browser, in a URL, or in a committed file.
- Worker logs from one board, or any file outside the runner's folder, become readable through the log route.
- A transcript so large that it freezes the page, or that grows without limit on disk.
- Domain knowledge of one project (Predbat, an optimiser) leaks into the UI. It must work for any board.

## Constraints

- **The web server talks only to Supabase edge functions.** It never connects to Postgres. New edge functions may be
  added. (The person's decision.)
- Every request is authenticated by the existing bearer token (`resolveCaller`) and runs as that member through
  `withMember`, so scope grants and row-level security apply as they do for MCP.
- Edge Function CPU stays under about 1 s per request. Graph polling must not load the embedding model. Only text
  search needs it. An early task measures the CPU of `/graph` on a board of about 400 nodes. If it is too heavy,
  the fallback is a cheap change check (a fingerprint route the app polls, fetching the graph only when it changes),
  and a longer interval. Several tabs poll independently, so the app polls only while its tab is visible. *(My
  call.)*
- The app shows whatever the token's member can read, including scope names. It is a local single-user tool, and
  the scope filter is there to narrow the view. There is no screen-share mode in this version. *(My call.)*
- `graph` returns at most 400 short nodes (a 160-character snippet each) or 100 full ones. Browse returns at most 400
  rows per page. Ranked search returns at most 100 rows and has **no offset**, because decay re-sorts after SQL. For
  text search, "N at a time" is therefore a "show more" button that raises the limit up to 100, not true paging.
- Graph nodes carry no `updatedAt` and no session of the author, only `createdAt`, tags, claim and `superseded`.
  Change detection in the browser therefore compares tags, claim and the superseded flag between polls.
- Memories on a board are stored without a session, so a fact does not say which worker wrote it. See "Skill change".
- **Hosted changes need the person's consent for each run.** Deploying the new function uses
  `supabase functions deploy web-api --use-api`, which needs `--yes` and the person's own approval. No schema change
  is planned. If one proves necessary, it is a new migration and a backup first.
- The repo is public: no project refs, company or personal names in committed files. Docs use `<project-ref>`.
- Tests: Deno unit and integration tests as elsewhere (`deno task check`, `test:unit`, `test:int`). The browser app
  has no build step, so nothing new runs in CI beyond these.

## Approaches

How the local server gets its data:

1. **Local server connects to Postgres directly.** It reuses the stores with no deploy, but it holds a database URL
   and bypasses token authentication. Rejected by the person, who wants the web server to talk to edge functions only.
2. **Local server calls the existing `agent-memory` MCP endpoint with a member token.** Nothing to deploy, but there is
   no cheap batched read of one memory with its links. Polling builds a fresh MCP server on every
   request on a function with a 1 s CPU budget. Kept only as a way to prototype.
3. **Chosen: a new `web-api` edge function with plain read-only HTTP routes, called by a thin local server.**
   - It shares `_shared/` code with `agent-memory`, so the rules stay in one place.
   - It is a separate function so that polling does not boot the embedder, and so that its routes and any later
     CORS and login handling are independent of the MCP endpoint.
   - The local server adds the token, so the browser never holds it (see Local server).

Why a local server at all, if the function holds the data: it keeps the token out of the browser, serves the app and
the vendored graph library offline, and is the only part that can read the runner's worker logs from disk.

Layout of the live board: three were mocked up. The person chose **A, graph first with a detail drawer**: a thin status
strip on top, the graph filling the page, and a drawer on node click. The live-feed pane (C) and lanes (B) are not in
this version. A feed of recent events may be added later.

## The edge function (`web-api`)

Read-only routes, all GET, JSON, `Authorization: Bearer <token>` required. Errors are user-safe: "not found" reads the
same whether the thing is absent or unreadable, and database errors become `Database error`, as elsewhere.

| Route | Does |
|-------|------|
| `/scopes` | The scopes the caller can read, with their access. |
| `/memories` | Query params: `q` (text), `scope`, `tags`, `tags_all`, `category`, `limit`, `offset`. With `q` empty, the browse path of `PgMemoryStore` (no access count touched). With `q`, ranked search that does not count as an access, so looking at memories does not change their decay *(my call; it needs an option on the store's search)*. |
| `/memories/:id` | One memory in full, with its links, `superseded` and claim. |
| `/graph` | `tags_all` (required), `scope`, `detail`. A thin wrapper over `PgMemoryStore.graph`, with the claims. |
| `/boards` | The boards visible to the caller: the goal memories (`kind:goal`) with their scope, `board:` tag and `state:` tag. Built from a browse, so no new SQL is expected. |

- Authentication and the per-request member store are as in `agent-memory/index.ts`. `verify_jwt = false` in
  `supabase/config.toml` for this function, as for `agent-memory`.
- The embedder is loaded lazily, only on first use by a text search.
- No route writes, so no request can change a memory, claim or link.

## The local server (`web/`)

A Deno program, started with `deno task web`.

- Reads the function's URL and the member token from the environment (the gitignored `.env`). It never prints the
  token and never sends it to the browser.
- Binds to `127.0.0.1` only, and rejects any request whose `Host` header is not `localhost` or `127.0.0.1`, to block
  DNS-rebinding.
- `/api/*` is forwarded to the `web-api` function with the token added. Query strings pass through.
- `/` and static files serve `web/public/`.
- `/logs/<board>/<label>`: serves one worker's transcript. The runner keeps worker files under
  `~/.board-runner/<board>/workers/`, or under `$BOARD_RUNNER_HOME` (the server honours the variable). The route
  validates `<board>` (lower-case kebab) and `<label>` (the shape `new_label` in `runner/board_runner/launch.py`
  makes, a strict pattern, since a `By:` line is text an agent wrote and is untrusted), refuses anything else, and
  resolves the real path to check it stays inside the board's `workers/` folder. The runner gives every run a fresh
  label, so a label matches one run. If it matches more than one file, the newest wins.
  - It serves the `<slot>-<label>.jsonl` transcript, and falls back to the older `.json` file and the `.err` file for
    runs made before the runner change.
  - It accepts a byte offset, so the app can fetch only what was added since its last request while the worker runs,
    and it caps each response. It reports whether the worker's process is still running, from the runner's
    `state.json`.
  - It returns "no log" when there is none. That is the normal case for a worker not started by this machine's
  runner, such as a board someone else runs, or a hand-started session. The tab then says so ("No local log: this
  worker did not run on this machine") and keeps showing the worker's label from the fact. Everything else on the
  board still works, because it comes from the database.
  - For a worker with no local `state.json` entry, "still running" falls back to the intent's active claim.
  *(My call.)*

## Runner change

Workers move from `claude -p --output-format json` to `--output-format stream-json --verbose`. The first writes
nothing until the worker exits and holds only the final result. The second writes one JSON line per step as it
happens, so a log can be followed live and holds the whole transcript.

- `worker_argv` in `runner/board_runner/launch.py` changes the flags, and the runner writes `workers/<slot>-<label>.jsonl`
  in place of `.json`.
- `claude_result_text` in `runner/board_runner/protocol.py` still returns the `result` text. It now accepts both a
  single JSON object, as the lead's one-shot runs and older logs use, and a stream, from which it takes the last
  line of type `result`. A stream with no such line, as when a worker is killed, gives no result, and the runner
  already treats that as `lost`.
- When a worker exits, the runner removes it from `state.json` (today the entry stays until the slot is reused), so
  "still running" is true. The log route also treats a transcript ending in a `result` line as finished.
- Before starting a worker, the runner keeps only the newest 200 worker transcripts per board, so the folder cannot
  grow without limit. *(Both added after the plan review.)*
- The runner's unit tests gain cases for the stream form: a normal stream, a stream cut short, and a malformed line.
- The first real toy run confirms the stream format of the installed Claude Code and that an Ollama worker streams the
  same way, before the app depends on it.

## The app (`web/public/`)

- Plain TypeScript or JavaScript as ES modules, no framework, no build step.
- Cytoscape.js is vendored as a file in the repo, so the app works offline.
- **Browse tab:** search box, scope and tag filters, a table, a page size, a "load more" for browse and "show more"
  (up to 100) for text. Selecting a row opens the drawer.
- **Board tab:** the picker (a board is identified by its scope and its `board:` tag together, so two scopes holding
  the same project name stay apart), the status strip, the graph, polling `/graph` with `tags_all=board:<project>` every ~3 s
  while the page is visible, paused when the tab is hidden, backing off on errors. It diffs each result against the
  last (new nodes, tag changes, claim appear or disappear, superseded) and animates the change. On the first load it
  shows the whole graph. Where `truncated` is true, it says so plainly, because a board over 400 nodes is not fully
  drawn.
- **Short names:** derived in the browser from a node's snippet, from the template lines above, falling back to the
  first words of the snippet for a memory that does not follow a template.
- **Drawer:** loads `/memories/:id` on demand. Links in the drawer select the other node. The **Worker log** tab is
  shown for a fact with a `By: <label>` line, and for an intent while a worker holds its claim (the claim names the
  worker's label). It reads `/logs/...`.
  - The tab turns the transcript into steps: the worker's text, each tool call with its input, and each result
    collapsed to a few lines with "expand". A line it does not recognise is shown as raw text, so a change to Claude
    Code's stream format degrades the view without breaking it.
  - While the worker runs it fetches from its last byte offset every few seconds and scrolls to follow, unless the
    person has scrolled up. A very large transcript shows the end first and loads earlier steps on request.
- The status strip fetches the board's goal and progress memories in full, once and on change, and reads three
  generic lines of the blackboard skill's own templates: `Max intents:` from the goal, `Round:` and the latest
  progress line from the progress memory. It counts intents from the graph. These are the skill's conventions, not
  any project's. A missing line shows as unknown. *(My call.)*

## Skill change

Add one line to the fact template in `skills/blackboard/work.md`: `By: <your worker label>`. The drawer reads it to name
the worker and find the worker's log. It is a one-line change, and the UI works without it, with the Worker log tab
simply absent. A test on a toy board should confirm that workers still produce facts that the lead accepts.

The worker's claim description also gains its label, `Working on this for board <project> (label: <label>)`. A claim's
session label is shown only to the member who holds it, but every reader sees the description, so an intent that is
being worked on can be tied to its worker's log. *(Added after the plan review.)*

## Later (not in this version)

- A History tab, with a new migration that decides what history a member may read (who, when and what, with or
  without the previous content).
- Hosting the app means the worker logs stop being local files. Transcripts hold tool output, which can include file
  contents and command output, so a hosted version must not expose them without a deliberate, separate decision.

- **Hosting with a login.** The function already takes bearer tokens. Hosting means a front door that signs a member
  in and passes their token (or an equivalent) to `web-api`, plus CORS on the function. The browser app is written to
  call `/api/...` only, so it does not change when the local proxy is replaced.
- Writing (hints, stop), a live event feed, and pushing from the runner.

## Verification

- Unit tests for each route's handler: parameter validation, error text, the limits above.
- Integration tests against the local database for every route: a member sees only their scopes, and an unreadable
  scope or memory reads as "not found", exactly like an absent one. Browse and ranked search honour their limits.
  `/graph` returns claims.
- Tests for the local server: the Host check, the token never appearing in a response, the proxy path, and the log
  route refusing any path that is not `<board>/<label>` in the right folder (traversal, symlink, wrong board).
  The route returns only the bytes after an offset, caps its response, and reports a running worker correctly.
- Runner tests for the stream form (see "Runner change"), run by the existing Python CI job.
- Run a toy board with the runner (`runner/examples/toy.toml`) while the Board tab is open. Check that nodes appear,
  claims show a ring, a refuted fact changes colour, and the Worker log tab shows the worker's log.
- Hosted deploy of `web-api` only with the person's approval for that run, after `--dry-run` where it exists.

## Left to the builder

- The exact route shapes and field names.
- Graph layout (for example cytoscape with a dagre layout, or force-directed) and styling.
- How `web/` reads the function URL and token (names of the environment variables), and how `deno task web` is wired.
- Where the `Intent:` and `Fact for intent` parsing lives, and its tests.

## Builder's calls

What was decided while building, beyond or against the text above.

- **Env keys:** `AGENT_MEMORY_TOKEN`, then `WEB_API_URL`, or else `AGENT_MEMORY_URL` with `agent-memory` swapped for
  `web-api`; `WEB_PORT` (default 8787); `BOARD_RUNNER_HOME`. `deno task web` loads `.env`.
- **Routes:** `/scopes`, `/boards`, `/graph`, `/memories` and `/memories/:id` on `web-api`; the local server forwards
  only that allow-list. The log route is `/logs/<board>/<label>` with `from`, `tail` or `before` byte-offset queries,
  and the server chooses the offsets so a response never ends inside a UTF-8 sequence.
- **Hosted timing, measured on the deployed function.** The largest board the member could read (68 nodes, 98 edges,
  37 KB): run 1 p50 321 ms, p95 597 ms, cold 446 ms; run 2 p50 307 ms, p95 404 ms. A 9-node board: p50 288 ms, p95
  526 ms. Wall time is dominated by network and authentication, not graph size. Locally, a 400-node board (196 KB)
  took p50 82 ms, p95 94 ms. `POLL_MS` stays at 3000, so no fingerprint route was needed.
- **Layout:** the first plan was cytoscape's breadthfirst layout. It spread nodes over the viewport and tangled after a
  few rounds, and a dagre layout was tried and dropped. The final layout puts **rounds in rows**: each round is a
  horizontal band, its intents in a row, and each intent's results directly beneath it. Faint "Round n" separators
  mark the bands. The lead now tags each intent `round:<n>`. An older board without the tag is grouped as "Batch n"
  by gaps of two minutes in creation time. Dashed lines join the goal to intents that link to nothing, since the first
  round of intents has no link to the goal. Switching boards resets pan and zoom and closes the drawer.
- **Drawer context:** an intent shows a "Starting point" (the facts it builds on and the latest measurement before it),
  a fact shows its result first, and the goal shows the progress fields and the latest measurement. Progress history is
  not stored, so "measured before" is rebuilt from fact timestamps and may differ from the progress memory's
  `Best result:` at that time.
- **Worker log tab:** shown for a fact with a `By:` line, and for an intent through its claim description label
  `(label: <label>)` or, once done, through its fact. It trims a trailing partial line while a worker runs, and a
  symlink out of the folder reads the same as an absent file, so the route cannot be used to test whether a path exists.
  An empty buffer takes the first chunk at any offset, because a tail read starts partway into the file.
- **Runner:** workers use `stream-json`; finished workers leave `state.json`; the newest 200 transcripts per board are
  kept. A first run in a new workspace folder waits at Claude Code's folder-trust dialog until the person accepts it
  in the lead's tmux session.
- **Skill:** facts end with `By: <label>`, worker claims carry `(label: <label>)`, intents carry `round:<n>`.
- **Verified by:** unit and integration tests for every route and the local server; a hosted run of a toy board with two
  Haiku workers and a Sonnet lead, with the Board tab open. Intents appeared, claims showed a ring with the worker's
  label, a fact landed and flashed, a worker's transcript followed live past non-ASCII text, a done intent's log was
  found through its fact, and after the board finished the conclusion appeared and the logs stopped polling.
- **Left for later:** the History tab, writing, hosting with a login, and a live event feed, as listed under "Later".
