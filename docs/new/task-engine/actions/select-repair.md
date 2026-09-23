# SelectRepair

## Responsibility

Apply the configured repair allowance and profile escalation to the failed implementation round.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output),
[verificationArtifact](verify.md#output) and [reviewArtifact](review.md#output).
Read their available current-round results and earlier-round history.

Later-stage artifacts can be absent when an earlier stage failed. Use the failure for the current
development revision; a result for another revision is not the repair trigger.

Configuration supplies the developer profile ladder and each profile's repair allowance.
This action needs no agent or external adapter.

### Output

```text
repairArtifact = { pathFromArtifactsRoot: "repair.json", type: RepairOutput }
```

```ts
type RepairOutput = {
  decision: 'selected' | 'exhausted';
  profile: string | null;
  repairsUsed: number;
  reason: string;
};
```

selected requires a profile; exhausted has no next profile. Reason explains whether the decision
continues the current profile, escalates or exhausts the configured policy.

### Outcomes

- selected: a further implementation round is allowed with the recorded profile.
- exhausted: every configured profile's allowance is exhausted.

Both outcomes write repairArtifact.

## Behavior

A failed development report, failed verification or review requesting changes is a repair trigger.
An operational exception or an inconclusive review is not silently converted into a coding repair.

Count completed repair turns from development reports, not directory numbers or action invocations.
The initial implementation is not a repair. A selected repair that has not run consumes no allowance.
Empty rounds left by interruption do not count.
Both completed and failed development reports count as executed turns when an agent returned a usable
report; completed here means the invocation finished, not that the implementation succeeded.

Both failed checks and review-requested changes use the same policy. Continue the current profile while
its allowance remains; then select the next configured profile. A new review cycle does not reset
the counters or the escalation position.

Record the decision before returning. Repeated evaluation of unchanged reports produces the same
decision, rather than incrementing another persistent counter. Starting the next round is a workflow
transition, not work performed by this action.
