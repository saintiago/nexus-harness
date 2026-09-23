# Deliver

## Responsibility

Publish verified work to a pull request, request native auto-merge and publish its developer summary.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output) and
[verificationArtifact](verify.md#output), plus prior [repairArtifact](select-repair.md#output) decisions
for reporting. Use [Selection](select-task.md#output) and [PreparedWorkspace](prepare-workspace.md#output), delivery
configuration, the [Git adapter](../../adapters/git.md#interface),
[GitHub adapter](../../adapters/github.md#interface) and [Jira adapter](../../adapters/jira.md#interface).

### Output

```text
deliveryArtifact = { pathFromArtifactsRoot: "delivery.json", type: DeliveryOutput }
```

```ts
type DeliveryOutput = {
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  headRevision: string;
};
```

### Outcomes

- published: the pull request contains the verified head and the publication steps are complete.
- failed: an observed delivery condition prevents publication, with its reason retained for recovery.

Only published produces a usable deliveryArtifact. API or command failures are execution errors.

## Behavior

Require successful verification for the current committed head. Publish the branch with a normal
non-forced push and confirm the remote branch head. Find the task's existing pull request or its matching branch; decide whether to create
or update it. A closed or unrelated pull request is not silently reused.

Request native auto-merge immediately after first creating the pull request. Required review and
checks remain repository merge gates; requesting auto-merge does not wait for Review or CompleteTask.

Record the resulting pull-request identity and head. Set the ticket's PR field and configured review
status. Publish a concise developer comment beginning with the profile, followed by what changed and
why. Count completed developer repair turns when reporting repairs used, and include profile escalation
when applicable. A selected but unexecuted repair is not a used repair. Keep operational paths and repeated links
out of the comment. Jira publication applies only to Jira tasks.

Inspect existing publication state on repetition and finish incomplete work, including requesting
auto-merge if it is not enabled on the open pull request. Use the recorded PR
identity and revision to distinguish an already-published result from another change. This decision
belongs here rather than in a universal adapter ensure operation.

Publication does not mean merge or task completion.
