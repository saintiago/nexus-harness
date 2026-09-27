# Deliver

## Responsibility

Publish verified work to a pull request, request native auto-merge and publish its developer summary.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output) and
[verificationArtifact](verify.md#output). Read their earlier-round values for reporting. Use
[Selection](select-task.md#output) and [PreparedWorkspace](prepare-workspace.md#output), delivery
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

Only published produces a usable deliveryArtifact; it publishes the
[action outcome event](architecture.md#action-outcome-events) referencing the saved record and naming
the pull request. failed saves no record and publishes only its reason. API or command failures are
execution errors.

## Behavior

Require successful verification for the current committed head. Publish the branch with a normal
non-forced push and confirm the remote branch head. Find the task's existing pull request or its matching branch; decide whether to create
or update it. A closed or unrelated pull request is not silently reused.

After a successful push and confirmation of the verified remote branch head, allow bounded time for
the matching open pull request's reported head to catch up. If a PR read, creation or update reports
a different head, re-read that same PR at fixed intervals within a short, finite deadline before
returning failed. Use one deadline for this delivery invocation's post-push confirmation; do not
reset it after each stale observation. This is Deliver-owned behavior with fixed internal bounds,
not a new operator setting or a generic adapter retry policy.

Continue only after the PR reports the exact verified revision. Recheck its identity, branch and base
on each observation; a closed, unrelated or ambiguous target still fails, and provider faults remain
execution errors. Do not repeat pushes, create another PR or repeat publication writes while waiting.
If confirmation expires, retain the expected and last observed revisions in the failure reason. All
review and completion gates remain required after successful confirmation.

Request native auto-merge immediately after first creating the pull request. Required review and
checks remain repository merge gates; requesting auto-merge does not wait for Review or CompleteTask.

Record the resulting pull-request identity and head. Set the ticket's PR field and configured review
status. Publish a concise developer comment beginning with the profile, followed by what changed and
why. Count development reports after the initial round as executed repair turns when reporting repairs
used, and derive profile escalation from their recorded profiles. A planned round without a
development report is not a used repair. Keep operational paths and repeated links out of the comment.
Jira publication applies only to Jira tasks.

Inspect existing publication state on repetition and finish incomplete work, including requesting
auto-merge if it is not enabled on the open pull request. Use the recorded PR
identity and revision to distinguish an already-published result from another change. This decision
belongs here rather than in a universal adapter ensure operation.

Publication does not mean merge or task completion.
