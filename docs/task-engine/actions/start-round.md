# StartRound

## Responsibility

Plan and open an implementation round. Select the round's developer profile from the configured
ladder, persist that choice and its reason as the current round, and report exhaustion when no further
configured repair turn is available.

## Interface

Follow the [general action design](architecture.md). Construction supplies the
[workspace reference](../../workspace.md#layout-and-reference), the configured developer ladder and
filesystem access. Use the action's event publisher for the exhausted reason. Import
[devArtifact](develop.md#output), [verificationArtifact](verify.md#output) and
[reviewArtifact](review.md#output) for current and historical round reads. No agent or external
adapter is required.

### Input

Read state/current-round.json when present. Its absence means no round has started in this workspace.
A present but unreadable or invalid record is an error, not a new workspace.

Before changing the current-round record, read the current round's available development, verification
and review results and the earlier-round history needed for the policy. A later invocation requires a
same-revision repair trigger as defined below.

### Output

The action owns state/current-round.json:

```ts
type CurrentRound = {
  number: number;
  profile: string;
  reason: string;
};
```

number is a positive integer, starting at 1. The corresponding directory is artifacts/<number>/ within
the same workspace. profile is the developer profile Develop must use for that round. reason records
why the profile was selected.

This record selects the artifact root and carries the round plan; it is outside that root so it can be
read before resolving round artifacts. StartRound declares no development, review or other business
output shapes, and it creates no repair decision artifact.

### Outcomes

- started: the round directory exists and the current-round record has been saved, either for a new
  round or by reusing an unrun plan.
- exhausted: no profile at or above the current position has a remaining repair allowance. No round is
  opened, the current-round pointer is unchanged and no artifact is written. The reason is emitted
  through the action's event publisher.

Filesystem or input errors fail the action. A later invocation without a repair trigger is an
execution error, not a new round or an exhausted policy.

## Round planning

1. With no current-round record, plan round 1 with the first profile in the configured developer
   ladder. The initial implementation is not a repair and consumes no repair allowance.
2. With a current-round record, read the current round's development result. If it does not exist,
   the round was planned but never ran development. Reuse its number, profile and reason, ensure its
   directory exists and return started. Do not advance the number or evaluate the policy again.
3. If a development result exists, require a same-revision repair trigger:
   - the development result has status failed; or
   - the verification result failed for the development result's headRevision; or
   - the review result requested changes for the development result's headRevision.

   An approval, an inconclusive review, a result for another revision or a missing result is not a
   repair trigger. The workflow must not invoke StartRound for those cases; if it does, fail rather
   than opening a repair round.
4. Count executed repair turns from the retained development reports in rounds after the first. Group
   them by the report's profile. Both completed and failed reports count when the agent returned a
   usable report; a planned round without a development report counts nothing. The initial
   implementation is not a repair.
5. Derive the changes-requested streak from the retained review results in round order, counting each
   reviewed head once within this task/PR lifecycle: a repeated publication or a duplicate review of
   the same head is not a new rejection. A changesRequested verdict increases the streak; an approved
   verdict resets it to zero; an inconclusive review, a round without a review, a failed check and a
   status change leave it unchanged.
6. Determine the next profile. Start from the strongest profile already used for an executed repair,
   or the initial ladder profile when no repair has run. If a stronger entry exists and the current
   repair trigger is the distinct changesRequested review that brings the changes-requested streak
   to an even count (the second, fourth, sixth and later consecutive rejections), advance one ladder
   entry before selecting, even when the weaker profile has unused allowance. Failed development
   reports and failed checks never promote, even when earlier reviews left the streak at two or
   more. Then advance while the candidate's executed repair-turn count has reached its
   repairAllowance. Never select a profile weaker than one already used for a repair, and do not
   spend a skipped weaker allowance later. Select the candidate when it remains within the ladder.
   The strongest profile is therefore used while allowance remains; if advancement passes the
   strongest profile, return exhausted.
7. Create artifacts/<next>/ and save the new current-round record with the selected profile and a
   concise reason. Replace the current-round pointer only after every policy read and decision has
   completed. The reason identifies the initial choice, continuation, review promotion or advance
   after allowance exhaustion.

The action neither moves nor copies existing artifacts. Earlier directories remain available as
history, and an existing next directory is retained.

## Restart

The current-round record is the round plan. If the worker stops after saving a new plan but before
saving workflow state, repeating StartRound finds no development result for the current round and
reuses the same number and profile. It does not increment a counter or select again.

If the worker stops before saving the new plan, repeating StartRound recomputes the next number from
the unchanged history and reaches the same decision. A fresh task/PR lifecycle after recovery has its
own artifact history and starts again at round 1 with the initial profile; discarded history does not
affect it.
