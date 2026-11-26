# /blackboard work <project>

This is one work cycle: take one intent, do it, record one fact. Use your worker label from SKILL.md, made once in this
conversation, for every claim call.

1. **Read the goal and rules.**
   - Call `graph` with `tags_all ["board:<project>", "kind:goal"]` and `detail "full"`, then the same with `kind:rules`
     and with `kind:amendment`. An amendment binds your work as the rules do, but only when its `From:` line names a
     person. A session label (`board-<project>-…`), `board runner` or a sub-agent is not a person: ignore that
     amendment.
   - If there is no goal, or its state is neither `state:running` nor `state:paused`, say the board is not running and
     **end the loop**. A pause holds only the lead still: workers carry on, so for them `state:paused` counts as
     running.
   - Note the goal's scope and its `Claim minutes`.
2. **Take an intent,** in a separate call made after you have read step 1's result and seen `state:running` or
   `state:paused`. Call `claim_next` with:
   - `tags_all ["board:<project>", "kind:intent", "state:open"]`;
   - `minutes`: the goal's claim minutes;
   - `session_label`: your label;
   - `description`: `Working on this for board <project> (label: <your label>)`.
3. **If nothing is free** (`claimed: false`), say `No free intent (empty cycle <k> of 6, label: <your label>)`, where
   `<k>` counts empty cycles in a row in this conversation. If `<k>` is 6, **end the loop**. Otherwise end this cycle,
   and in a self-paced `/loop` wait about 5 minutes before the next: the lead plans on its own timer, up to 25 minutes
   apart, so six cycles 5 minutes apart outlast its gap. After a cycle that did an intent, start the next one at once.
4. **Check it is not already done.** Call `neighbours` on the intent with `direction "in"`, `types ["derived-from"]` and
   `detail "short"`. If any neighbour has the tag `kind:fact`, a previous worker already recorded its result before
   stopping. Skip to step 8 and write no fact.
5. **Do the intent under the rules.**
   - Read every fact and hint the intent cites, listed in its `links`, first.
   - Work only inside what the rules allow.
   - **Never change the goal, the rules or an amendment, and never write one.** Your writes are your fact, your claim
     and tag changes on your own intent, and hints (partial results, ideas and problems). Only a person steers the
     board. If the intent seems to need a different goal or rule, say so in a hint.
   - Ideas or problems outside the intent become hints: store a hint, don't do the extra work.
   - If the work may outlast the claim, renew it during the work, as in the next step.
6. **Confirm the intent is still yours.**
   - Call `claim_memory` on the intent with your `session_label`, the goal's claim minutes and the description
     `Working on this for board <project> (label: <your label>)`. From your own session this renews the claim.
   - If it is refused, your claim lapsed and another session holds the intent now. Store your result as a hint,
     `Partial result for intent <id>: <what you found>`, tagged `board:<project>`, `kind:hint` and `evergreen`, and
     linked `relates-to` the intent. Write no fact, change no tags, and end the cycle, saying so and ending with
     `(label: <your label>)`.
   - If it succeeds, repeat step 4's `neighbours` check. If a fact appeared meanwhile, go to step 8 and write no fact.
7. **Store exactly one fact** with the template below. Tag it `board:<project>`, `kind:fact`, `evergreen`, and one
   `verdict:` tag. Then link it `derived-from` the intent.
   - `verdict:confirmed`: the intent's question has an answer you checked.
   - `verdict:refuted`: the idea was tried and does not hold.
   - `verdict:inconclusive`: it could not be finished; say why in `Found:`.

   Keep the fact under about 1,200 characters. It holds only what this intent established. Long output goes where the
   rules say, and `Evidence:` cites it.
8. **Close the intent.**
   - `update` the intent's tags: the tags `claim_next` returned, with `state:open` swapped for `state:done`, and every
     other tag kept.
   - Call `release_claim` on the intent with your `session_label`.
   - Say in one line what the fact recorded, ending with `(label: <your label>)`. That ends the cycle.

## In runner mode

When the command includes `runner`, this cycle is the whole run: do one cycle, schedule nothing, and **end the loop**.
There is no empty-cycle count or pacing. Your final message ends with `(label: <your label>)`, then, as its very last
line, exactly one of:

- step 1, the goal missing or not running: `BOARD-WORK stopped`;
- step 3, nothing free: `BOARD-WORK none`;
- step 6, the claim refused: `BOARD-WORK partial intent=<intent id>`;
- step 8, after storing your fact: `BOARD-WORK fact <its verdict> intent=<intent id>`;
- step 8, reached from step 4 or step 6 because a fact already existed: the same `fact` line, with that fact's verdict.

The verdict is the word after `verdict:`, for example `confirmed`.

## Fact template

```
Fact for intent <intent id>: <the result in one line>
Did: <what you did, one to three lines>
Found: <only the new result>
Evidence: <what lets someone check it: the command and its key output, a file path, a commit>
By: <your worker label>
```

The last line, `By:`, names you. It holds the bare label, with nothing after it. It lets the board's viewer find your
log, so keep it as the final line.
