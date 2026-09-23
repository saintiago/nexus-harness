# Review

## Responsibility

Evaluate the delivered change against the task and produce an actionable review of that revision.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output),
[verificationArtifact](verify.md#output) and [deliveryArtifact](deliver.md#output).
Use [Selection](select-task.md#output), earlier-round review/development history, configured reviewer profile,
[AgentRuntime](../../agent-runtime.md#provided-interface), the
[Git adapter](../../adapters/git.md#interface), [GitHub adapter](../../adapters/github.md#interface)
and [Jira adapter](../../adapters/jira.md#interface).

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
  findings: {
    id: string;
    title: string;
    body: string;
    severity: 'blocking' | 'non-blocking';
    location?: { path: string; line: number };
  }[];
  priorFindings: {
    findingId: string;
    disposition: 'resolved' | 'open' | 'withdrawn';
    reason: string;
  }[];
};
```

Findings contain the complete problem, impact and repair guidance. IDs allow later development and
review reports to refer to the same finding; they are not a separate finding database.

### Outcomes

Return the recorded verdict: approved, changesRequested or inconclusive.
Each outcome writes reviewArtifact before publication. Unusable agent output is an execution error.

## Behavior

Confirm that the delivered head, development result, verification result and retained worktree describe
the same revision. Read the full task and PR conversations. Give the reviewer complete prior findings
and developer responses, not shortened Jira summaries.

Read the comparison diff for the recorded base/head and include that revision range in the review
context. Agent claims do not change the revision this action is evaluating.

Use the existing worktree with the reviewer profile. The reviewer may inspect code and run focused
checks; it must not alter implementation files. The action verifies that the reviewed revision and
implementation remain unchanged after the turn.

The reviewer evaluates correctness and missing behavior, explains prior finding dispositions and
returns a verdict. Check that the report is usable and refers to the reviewed revision. Approval must
not coexist with unresolved blocking findings.

Save the complete report. Publish its review and configured review check for that exact head.
Publish a concise ticket comment beginning with the profile and explaining what was missed and what
to improve. A requested repair stays in the current workflow; a Jira comment is not the repair input.

On repetition, inspect the saved report and remote publication for that head before invoking the
reviewer or publishing again. Never apply approval to a later head.
