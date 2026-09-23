# CompleteTask

## Responsibility

Confirm the approved change is merged and its required post-merge checks passed, then complete the task.

## Interface

Follow the [action contract](architecture.md). Import [deliveryArtifact](deliver.md#output) and
[reviewArtifact](review.md#output). Use [Selection](select-task.md#output), project completion/check configuration,
the [GitHub adapter](../../adapters/github.md#interface) and [Jira adapter](../../adapters/jira.md#interface).

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

- completed: merge and required post-merge checks are confirmed, and the task is in its completed state.
- failed: an observed condition prevents completion, with its reason retained for recovery.

Only completed produces a usable completionArtifact. Provider access failures are execution errors.

## Behavior

Require approval of the delivered head. Read current PR state and checks from their configured
producers. If the head changed, do not transfer the old approval.

Observe the actual merge and require every configured post-merge check to succeed for that merge
revision. Those successful results are the completion evidence. Pending work remains pending within
the configured completion wait; failed checks or expiry cannot produce completed.

Write completion evidence after the merge and checks are confirmed. Transition the ticket to Done
only after those conditions hold. Finish the configured source update before returning completed.
Do not directly merge or bypass repository gates.

On repetition, read the current PR and ticket state. A merged PR or already-completed ticket does
not by itself establish that required post-merge checks passed. Reuse confirmed evidence and finish
any outstanding completion step without redoing the implementation.
