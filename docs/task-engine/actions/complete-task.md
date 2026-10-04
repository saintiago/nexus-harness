# CompleteTask

## Responsibility

Confirm the approved change merged without a failed required pre-merge check and with its required
post-merge checks passed, then return completion evidence to the parent.

## Interface

Follow the [action contract](architecture.md). Import [deliveryArtifact](deliver.md#output) and
[reviewArtifact](review.md#output). Use [Selection](select-task.md#output), project completion/check configuration,
the [GitHub adapter](../../adapters/github.md#interface) and supplied source input.

### Output

```text
completionArtifact = { pathFromArtifactsRoot: "completion.json", type: CompletionOutput }
```

```ts
type CompletionOutput = {
  taskKey: string;
  pullRequestUrl: string;
  reviewedHead: string;
  mergeRevision: string;
  checks: { name: string; producer: string; revision: string; result: 'passed' }[];
};
```

### Outcomes

- completed: merge and required post-merge checks are confirmed; the parent can publish completion.
- failed: an observed condition prevents completion, with its reason retained for recovery.

Only completed produces a usable completionArtifact. The completed outcome publishes the
[action outcome event](architecture.md#action-outcome-events) referencing the saved evidence and
naming the pull request; reusing confirmed evidence publishes the same reference. failed also retains its reason at artifacts/&lt;round&gt;/completion-failure.json, so the
terminal handoff states it after a restart. Provider access failures are execution errors.

## Behavior

Require approval of the delivered head. Read current PR state and checks from their configured
producers. The review check must come from the Nexus Lens producer, be completed and be successful
for the approved head; a same-name check from another producer is not the Lens gate. If the head
changed, do not transfer the old approval.

Observe the delivered revision's required pre-merge checks while the merge is pending, binding each
observation to the revision the provider reports with it. An observation at a revision other than
the delivered head is the changed-head failure, never evidence against the delivered revision. A
required check that concluded unsuccessfully — any conclusion other than success, skipped or
neutral — is a terminal failure: report the failing check, its conclusion and the provider evidence
link instead of waiting for the completion deadline. Required checks that have not reported or are
still running remain pending within the configured completion wait, and an approved review does not
bypass them.

Observe the actual merge and require every configured post-merge check to succeed for that merge
revision. All matching runs must succeed; a newer successful run does not supersede a failed matching run.
Those successful results are the completion evidence. Pending work remains pending within
the configured completion wait; failed checks or expiry cannot produce completed.

Write completion evidence after merge/check confirmation. Return completed to the parent, which
marks the ticket Done only after confirming that evidence. CompleteTask has no Jira capability.
A failed parent source update cannot advance the parent to its next selection.
Do not directly merge or bypass repository gates.

On repetition, read the current PR and supplied ticket state. A merged PR or already-completed ticket does
not by itself establish that required post-merge checks passed. Reuse confirmed evidence and finish
any outstanding completion step without redoing the implementation.

## Experience analysis handoff

The workflow invokes [AnalyzeExperience](analyze-experience.md) after the returned terminal outcome,
including failed completion. CompleteTask supplies its ordinary evidence and never calls memory or
schedules analysis. Learning does not determine completion or require a Jira Done trigger.
