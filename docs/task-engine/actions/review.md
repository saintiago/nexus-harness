# Review

## Responsibility

Evaluate the delivered change against the task and produce an actionable review of that revision.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output),
[verificationArtifact](verify.md#output) and [deliveryArtifact](deliver.md#output).
Use [Selection](select-task.md#output), earlier-round review/development history, configured reviewer profile,
[AgentRuntime](../../agent-runtime/architecture.md#provided-interface), the
[Git adapter](../../adapters/git.md#interface), [GitHub adapter](../../adapters/github.md#interface)
and [Jira adapter](../../adapters/jira.md#interface).

Use [ReviewerRole](../../agent-runtime/reviewer-role.md#interface). Supply the response format below
and complete findings/responses using the [findings contract](findings.md). The profile includes
the complete reviewer instructions.

### Output

```text
reviewArtifact = { pathFromArtifactsRoot: "review.json", type: ReviewOutput }
```

```ts
type ReviewOutput = {
  profile: string;
  headRevision: string;
  verdict: 'approved' | 'changesRequested' | 'inconclusive';
  summary: string;
  findings: Finding[];
  priorFindings: FindingDisposition[];
};

type ReviewResponse = Pick<ReviewOutput, 'verdict' | 'summary' | 'findings' | 'priorFindings'>;
```

Request one JSON object conforming to ReviewResponse as the agent's final output. Include that shape,
its finding definitions, identity/disposition rules and verdict rules in the context. Parse and validate the response, then add
the configured profile and observed reviewed head to create ReviewOutput. They are not agent claims.

### Outcomes

Return the recorded verdict: approved, changesRequested or inconclusive.
Each outcome writes reviewArtifact before publication and publishes the
[action outcome event](architecture.md#action-outcome-events) referencing it with the profile used.
An invocation that reuses the saved report for the delivered head publishes the same reference.
Unusable agent output is an execution error.

## Behavior

Confirm that the delivered head, development result, verification result and retained worktree describe
the same revision. Read the locally saved task conversation and round history; save refreshed task
and PR conversations locally. Give the reviewer complete prior findings
and developer responses, not shortened Jira summaries.

Read the comparison diff for the recorded base/head and include that revision range in the review
context. Agent claims do not change the revision this action is evaluating.

Use the existing worktree with the reviewer profile. Dependency installation, builds, focused checks
and temporary reproduction tests may write files. Verify that the reviewed revision and implementation
remain unchanged after the turn; new caches, logs or generated verification output alone do not
invalidate a review. Implementation fixes belong to a development turn.

The reviewer evaluates correctness and missing behavior, explains prior finding dispositions and
returns a verdict. Validate finding IDs, prior dispositions and the verdict under the shared contract.
Bind the report to the revision actually reviewed. Missing required responses or inconsistent verdicts
are unusable output, not approval or a newly invented coding finding.

Save the complete report. Publish its review and configured review check for that exact head through
the Nexus Lens publication capability. Only approved produces a successful review check;
changesRequested and inconclusive cannot authorize merge. The complete agent conversation stays
in local artifacts; the published review summarizes the result.
Recognize an already-published review by the configured Nexus Lens author, the reviewed commit, the
verdict and the report body, and the check by the configured name, the Nexus Lens producer identity,
a completed status and the verdict's conclusion. Publish only the missing part.
Publish a concise ticket comment beginning with the profile and explaining what was missed and what
to improve. A requested repair stays in the current workflow; a Jira comment is not the repair input.

On repetition, inspect the saved report and remote publication for that head before invoking the
reviewer or publishing again. Never apply approval to a later head.
