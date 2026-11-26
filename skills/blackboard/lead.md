# /blackboard lead <project>

This is one reasoning round. It reads the board, decides, and writes intents, corrections or a conclusion. Use your lead
label from SKILL.md, made once in this conversation, for every claim call.

1. **Note the round's start time:** `date -u +%Y-%m-%dT%H:%M:%SZ`. It becomes this round's `Last round at`. Taking it
   before reading means anything written during the round is read next round.
2. **Read the goal.** Call `graph` with `tags_all ["board:<project>", "kind:goal"]` and `detail "full"`.
   - If there is no goal, say so and **end the loop**.
   - If its state is not `state:running`, release your lead claim on it (`release_claim` with your `session_label`, if
     you hold one), say the board is no longer running, and **end the loop**.
3. **Take or renew the lead role,** in a separate call made after you have read step 2's result and seen
   `state:running`. Call `claim_memory` on the goal with:
   - `minutes 30`;
   - `session_label`: your lead label;
   - `description`: `Lead of board <project>`;
   - `force true` only for `lead <project> takeover`.

   If it is refused, report who holds the lead and until when, write nothing, and **end the loop**. Two leads never run.
   Each round renews the 30 minutes, so pace a `/loop` at under 30 minutes between rounds.
4. **Read the board.**
   - Call `graph` with `tags_all ["board:<project>", "kind:intent"]`, short detail. This gives every intent, with its
     state and any active `claim`. If the result says `truncated: true`, the board has outgrown one read: tell the
     person to start a fresh board for the next phase, write nothing, and **end the loop**. Planning from a partial list
     would duplicate intents.
   - Call `graph` with `tags_all ["board:<project>", "kind:rules"]`, full; then the same for `kind:progress`.
   - Read what is new since the progress memory's `Last round at`. Call `search` with no query,
     `tags_all
     ["board:<project>", "kind:fact"]`, `after` set to that time (omit it if `never`) and `limit 400`;
     then the same for `kind:hint`. Page with `offset` while `has_more` is true.
   - Do not use `graph` full for facts: it returns the oldest 100.
5. **Decide**, and do every part that applies.
   - **Done.** The facts meet the goal's Done when.
     1. Store a conclusion with the template below. Tag it `board:<project>`, `kind:conclusion`, `evergreen`. Link it
        `derived-from` each fact that proves it. If the board already has a conclusion, from a stop at the intent limit,
        link the new one `supersedes` it.
     2. Swap the goal's `state:running` for `state:done`, keeping its other tags.
     3. Swap `state:open` for `state:dropped` on every open intent.
     4. Rewrite progress (step 6), release your claim on the goal, and **end the loop**.
   - **Unreachable.** The facts show the goal cannot be met. Do the same as Done, but the conclusion says why it cannot
     be met, and the goal becomes `state:stopped`. If the only reason is that the ideas have run out, do Stuck for ideas
     (below) first, and decide Unreachable only if none of its ideas is worth an intent.
   - **Correct.** A fact is shown wrong by later facts. Store a corrected fact, with the work.md fact template and a
     `verdict:` tag, and link it `supersedes` the wrong one.
   - **Drop.** An open intent that nobody holds a claim on has become pointless. Swap its `state:open` for
     `state:dropped`.
     - An intent with two or more `Worker timed out` hints `relates-to` it is too big for one worker. Drop it, and in
       Plan write smaller intents that cover it, if the intent limit allows.
   - **Intent limit.** If the goal has a `Max intents` number, count every intent on the board, in any state. Plan
     writes no intent that would take the count past the limit.
     - Done comes first: if the facts meet Done when, do Done (or, with `measure`, propose the candidate) even at the
       limit. With `measure`, a candidate not yet measured also comes first: propose it, and stop at the limit only once
       no unmeasured candidate remains.
     - When the count has reached the limit and no intent is open, stop the board instead of planning. Store a
       conclusion with the template below whose first line ends `Stopped: intent limit of <n> reached`. Its `Shown by:`
       gives the best result so far and the facts behind it, and it is linked `derived-from` those facts. Then do the
       rest of Unreachable: the goal becomes `state:stopped`.
     - If the board already has a conclusion from an earlier stop, link the new one `supersedes` it.
   - **Plan.** Count the open intents, claimed or not. Write new intents until that count reaches the goal's
     `Max open intents`. Each new intent must:
     - not overlap any open intent, or any done intent whose fact already answers it;
     - cite the one to three facts or hints that most directly prompted it, linked `derived-from` each (round 1 has
       none). Background everyone already knows belongs in the progress memory, not in links;
     - follow the intent template below, describing only the task. How to use the board is in this skill, not in
       intents.

     When two results look like they would combine, an intent to combine them and check the result is a normal intent.
     If nothing is open, the goal is not met, it is not unreachable and the intent limit allows, write at least one
     intent.
   - **Stuck for ideas.** Only when you are struggling, ask a sub-agent for ideas, on the model named by the goal's
     `Ideas model` line. You are struggling when:
     - Plan must write an intent, but every idea you have overlaps one the board has already tried;
     - the last three intents to finish all ended in refuted or inconclusive facts; or
     - you are about to decide Unreachable only because the ideas have run out.

     Ask at most once a round, and not again until a new fact has arrived since the last idea hint.
     1. Start the sub-agent with the Agent tool. For a model name, pass it as `model`. For `inherit`, or a goal with no
        `Ideas model` line, pass no `model`, so it runs on your own. For `none`, skip Stuck for ideas. Give it, as text,
        the goal, the rules, the progress memory and the facts that matter, and ask for up to three ideas, each with why
        it could work and how a worker would check it. It may read the workspace's code. Tell it to change nothing: no
        edits, no commits and no shared-memory writes.
     2. Store its answer as one hint, as SKILL.md's hint command does, so later rounds see what was suggested. Its
        second line is `From: <model> sub-agent, asked by <your lead label>`.
     3. Weigh each idea as you would any hint, and use none of them if none is good. An intent you write from one is
        linked `derived-from` that hint.

     If the Agent tool is not available, plan without it. If it refuses the model, ask again with no `model`.
   - **Hints.** Treat every new hint as advice to weigh. If it asks for a change to the rules, tell the person; do not
     edit the rules.
6. **Rewrite the progress memory** (`update` its content; its tags stay) with the template below. If step 4 found no new
   facts or hints and step 5 changed nothing, skip the rewrite: its `Last round at` stays, so nothing is missed.
7. **If an intent is free and you have time,** you may do one exactly as work.md does, using your lead label.
8. **End the round,** keeping your claim on the goal: it holds the lead role until the next round renews it. Say in two
   or three lines what the round decided, ending with `(label: <your lead label>)`.
9. **Pace the next round** (self-paced `/loop`). Count the open intents nobody holds a claim on.
   - **None free:** about 5 minutes. Workers that finish their intent will find nothing to claim until you plan again.
   - **Some free:** about 15 minutes.
   - Never more than 25 minutes, so your 30-minute claim on the goal does not lapse between rounds.

## In runner mode

When the command includes `runner`, a board runner sends each round and starts the workers.

- Skip step 7: do no intents yourself. Skip step 9: schedule nothing, since the runner decides when the next round is.
- Before ending, count `free` and `open` (SKILL.md, Output lines) from the intents as they stand after your writes:
  re-read them with `graph` if you wrote or changed any.
- Your final message ends with `(label: <your lead label>)`, then, as its very last line, exactly one of:
  - step 2, the goal missing or not running: `BOARD-LEAD stopped`;
  - step 3, refused: `BOARD-LEAD refused <holder's session label> <until>`;
  - step 4, truncated: `BOARD-LEAD outgrown`;
  - step 5, Done: `BOARD-LEAD done`; Unreachable, or stopped at the intent limit: `BOARD-LEAD stopped`;
  - with `measure`, a candidate (below): `BOARD-LEAD candidate <ref> free=<n> open=<n>`;
  - otherwise: `BOARD-LEAD running free=<n> open=<n>`.

### With `measure`

The command says `measure` when the board has a measurement that must confirm the goal before it is concluded.

- **Done becomes a proposal.** When the facts appear to meet Done when, do not conclude. Pick `<ref>`: what the proving
  facts name as the result, such as a branch, commit, path or value, with no spaces. Do the rest of the round as usual,
  then end with the `candidate` line.
- **`<ref>` is exactly the result that gets measured.** The runner passes it unchanged to the measurement command as
  `BOARD_CANDIDATE`. Use the bare value, branch, commit or path, such as `38` rather than `n=38`, and never a name you
  make up.
- **Never propose a `<ref>` that has already been measured.** A measurement fact for it, below, says so. After a failed
  measurement, plan work toward a different result. Do not rename the same result to measure it again.
- **`measured <ref> pass output=<path>`.** Read the file at `<path>`. Store a fact with the work.md template:
  - `Fact for intent none: measurement of <ref> passed`, with the file's key lines as `Evidence:`, and a last line
    `By: <your lead label>`;
  - tagged `verdict:confirmed`;
  - linked `derived-from` the facts that named `<ref>`.

  Then do Done. After storing the conclusion, link it with `relate_memories`, `type "derived-from"`, once to this
  measurement fact and once to each fact that named `<ref>`. A conclusion with no links cannot be checked, so make these
  calls before you change any tags.
- **`measured <ref> fail output=<path>`.** Store the same kind of fact, but `measurement of <ref> failed` and
  `verdict:refuted`. Then carry on with the round: the failure is new information to plan from.
- **A goal with `Measure: yes` whose command lacks `measure`.** The person is leading by hand. When the facts appear to
  meet Done when, do not conclude. Tell the person the candidate and ask them to run the measurement, then end the
  round.

## Intent template

```
Intent: <the task in one line>
Why: <the fact or hint ids that prompted it and what they showed; "first round" if none>
Produce: <what the fact must report for this to count as answered>
Give up when: <the point at which the worker records an inconclusive fact instead>
```

Tags: `board:<project>`, `kind:intent`, `state:open`, `round:<n>`, `evergreen`, where `<n>` is the round number step 6
writes in the progress memory's `Round:` line.

## Progress template

```
Progress for board <project>.
Round: <n>
Last round at: <this round's start time from step 1>
Lead: <your lead label>
Established: <what the facts so far prove, citing fact ids>
Best result: <the best answer so far, or none>
Open questions: <what the open intents are trying to settle>
Intents: <open> open (<claimed> claimed), <done> done, <dropped> dropped
```

## Conclusion template

```
Conclusion for board <project>: <the answer in one line, or why the goal cannot be met>
Done when: <the goal's condition>
Shown by: <each proving fact id and what it contributes>
```
