## Shared memory and threads

The shared memory is the record of **what I'm working on** and **what I've learnt**. It lasts across sessions and
repos, and other people and bots can read it. Use it rather than working context out again from git history or from
scratch.

### Scopes

| Scope | Use it for |
|-------|------------|
| `<team-scope>` | <shared engineering knowledge and work status for the team> |
| `<private-scope>` | <anything that must not reach the wider group> |

`store` needs a `scope`. Reads (`search`, `recall`, `list_recent`, `stats`) cover every scope you can read unless
`scopes` narrows them. `list_scopes` shows the scopes you can use and your access to each. A scope you have no grant on
is reported as "not found", the same as one that doesn't exist. So if a store fails that way, check `list_scopes`
rather than retrying.

Everyone who can read a scope sees everything in it, threads included. If a finding came from somewhere private, store
a version with the private details taken out. If a bot that answers in public reads a scope, treat everything in that
scope as public: it may be quoted.

### At the start of a session

- When picking work up, or asked "where was I" or "what's left", call `recall` with the relevant topics before
  answering. Those answers live in earlier sessions, not in this conversation.
- To sweep across every repo, search by status tag rather than by topic:
  `search(query="outstanding work", tags=["status:open", "status:blocked", "status:in-review"])`. `tags` matches a
  memory with any of the tags. `tags_all` requires every one, so `tags_all=["repo:<name>", "status:open"]` gives one
  repo's open work without filtering on the client.
- If a status memory names a thread session label, call `whats_new` with that label before carrying on.

### Work status

Store a memory when starting a task, reviewing a PR or ticket, or parking something unfinished. Use category
`observation` and these tags:

- `repo:<name>`, always;
- exactly one of `status:open`, `status:in-review`, `status:blocked` or `status:done`;
- `pr:<n>` / `issue:<n>` when there is one.

Write it so it still makes sense in six months: what the work is, where it got to, and what the next action is.
"Fixed the bug" is useless. Name the branch, the file, the decision taken and what remains.

**When the state changes, `update` the existing memory. Never store a second one.** Find it by its `repo:`/`pr:`
tags, change the text and swap the `status:` tag. If a duplicate has crept in, delete the stale one. A store that
lies about status is worse than none, because it is believed.

- **Changing only `tags` or `category` is safe:** the content and its embedding are kept.
- **Changing `content` re-embeds it,** so meaning-based search finds the new text.
- **`update` can move a memory to another scope** (`scope`). This needs write access on both.
- **`delete` is soft:** for 30 days an admin can restore the memory with `scripts/admin.ts restore`, which is not
  available through the MCP.

### What I've learnt

Store durable findings with the category that fits (`architecture`, `bug-fix`, `debugging`, `performance`,
`security`, `learning`, `tool-usage`), tagged `repo:<name>` plus topic tags:

- design decisions and the reasons for them;
- constraints that aren't obvious;
- traps that cost real time;
- what was tried and rejected.

Store the *why*, not the diff. Never store secrets, tokens, credentials or anything from a `.env` file: the store is
plaintext in a hosted database that others can read. Don't store what the repo already records, or session chatter.

### Threads

A memory holds what is settled. A thread holds the discussion that leads there. Use a thread to hand findings between
agents or people working on the same issue, or to ask a question someone else will answer later.

- **Open it in the work's scope** and link it to the status memory, so `recall` shows the discussion next to the
  facts.
- **Give each piece of work a session label**, such as `<repo>-<topic>`, and write it into the status memory.
  - Keep the session id the server returns and pass it back on every later call.
  - If the id is lost, use the label.
  - If several agents share a token, give each its own label.
- **Make each post stand on its own:** what you found, the evidence, and the next step. A question says what answer
  is needed.
- **Call `whats_new`** when resuming work and between steps of long work.
- **When the issue is settled, resolve the thread with a note that states the outcome.** Then put the conclusion into
  a memory. Never leave a conclusion only in a thread. If a resolved issue comes back, reopen the thread rather than
  start a new one.
