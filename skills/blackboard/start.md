# /blackboard start <project>

This sets up a new board with the person. It writes the goal, rules and progress memories and no intents: the lead's
first round writes those.

1. **Check the name is free.** Call `graph` with `tags_all ["board:<project>"]`. If anything comes back, say a board
   with that name already exists, offer `/blackboard status <project>`, and stop.
2. **Ask the person**, one question at a time, unless they have already said:
   - **Goal:** what the board is trying to achieve.
   - **Done when:** a condition a lead can check against facts, for example "a fact shows X, and facts cover Y". Vague
     answers like "when it's better" need a measurable form.
   - **Scope:** which shared-memory scope holds the board. Call `list_scopes`. It must be one they can write. Mention
     whether that scope is public-safe.
   - **Max open intents** (default 4) and **claim minutes**, which is how long a worker holds an intent before it is
     treated as abandoned (default 60). Max open intents should be at least the number of workers plus one, so a worker
     that finishes finds the next intent already waiting.
   - **Ideas model** (default `inherit`): the model a struggling lead asks for ideas. Do not ask about it unless the
     person raises it.
3. **Draft the rules.** Draft them from their answers and from the workspace in front of you: its README, test and build
   commands, and any scripts that measure what the goal cares about. Use the rules template below, then show the draft
   to the person and ask for changes or approval. Do not write rules the person has not approved.
4. **Write the memories:**
   - the **goal**: the template below, tags `board:<project>`, `kind:goal`, `evergreen`, `state:running`;
   - the **rules**: the approved text, tags `board:<project>`, `kind:rules`, `evergreen`;
   - the **progress**: the template below, tags `board:<project>`, `kind:progress`, `evergreen`.

   Then link the rules and the progress each `depends-on` the goal.
5. **Tell the person how to run it:**
   - `/loop /blackboard lead <project>` in one session;
   - `/loop /blackboard work <project>` in as many others as they like, on any model;
   - `/blackboard status <project>`, `hint` and `stop` from anywhere.

## From a board file

`start <project> from=<file>` is how a board runner starts a board, and it works by hand too. The file is TOML, which
you read with the Read tool. The file is the person's approval: ask nothing.

1. **Read the file.**
   - Its `board` must equal `<project>`. If it doesn't, say so, end with `BOARD-START not-running`, and write nothing.
   - Take `scope`, `goal`, `done_when` and `rules`.
   - Take `max_open_intents` (default 4), `claim_minutes` (default 60) and `max_intents` (default none).
   - `Measure` is `yes` when the file has a `[measure]` table, otherwise `no`.
   - `Ideas model` is the `[lead]` table's `ideas_model` (default `inherit`).
2. **Look for the board.** Call `graph` with `tags_all ["board:<project>", "kind:goal"]`, full detail.
3. **No goal:** write the board as in step 4 above.
   - The goal follows the goal template, with `Goal:` from `goal`, `Done when:` from `done_when`, and the numbers from
     the file. `Started:` is today's date, `by board file <file name, without its directory>`.
   - The rules memory holds `rules` exactly as written.
   - End with `BOARD-START created <goal id>`.
4. **The goal is `state:running`:** write nothing. Compare the file's goal, Done when and rules with the memories. List
   each one that differs, in a line or two. End with `BOARD-START exists`.
5. **The goal is `state:stopped`, its conclusion contains `Stopped: intent limit`, and the file's `max_intents` is
   higher than the goal's `Max intents`, or is absent:** follow SKILL.md's `resume` with that limit. End with
   `BOARD-START resumed`. This is the only change `from=` ever makes to an existing board.
6. **Otherwise** (done, stopped for another reason, or a limit that isn't higher): say why, write nothing, and end with
   `BOARD-START not-running`.

The `BOARD-START` line is the very last line of your final message, written exactly as shown.

## Goal template

```
Goal: <one paragraph: what and why>
Done when: <the checkable condition>
Max open intents: <n>
Max intents: <n, or none>
Claim minutes: <n>
Measure: <yes if a measurement must confirm the goal before it is concluded, otherwise no>
Ideas model: <the model a struggling lead asks for ideas: inherit (the lead's own), a model name, or none>
Started: <ISO date> by <the person>
```

## Rules template

```
Rules for board <project>.
How to work: <where and how a worker does an intent, e.g. its own checkout or directory>
How to verify: <the commands or checks that make a result trustworthy>
Evidence: <what a fact must cite so others can check it, e.g. a command and its key output, a file, a commit>
Long output: <where it goes, e.g. a file under a given directory; facts cite the path>
Allowed beyond the base safety rules: <anything explicitly allowed, or "nothing">
Never: <anything forbidden on top of the base safety rules>
```

## Progress template (round 0)

```
Progress for board <project>.
Round: 0
Last round at: never
Lead: none yet
Established: nothing yet.
Best result: none.
Open questions: none.
```
