# Review

## Responsibility

Evaluate task correctness at the delivered revision and produce an actionable review,
including preparation content carried by its implementation branch.
Completed assessments proceed to publication and either repair or gated completion;
unfinished assessments proceed to recovery.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output),
[verificationArtifact](verify.md#output) and [deliveryArtifact](deliver.md#output).
Use [Selection](select-task.md#output), [PreparedWorkspace](prepare-workspace.md#output),
earlier-round review/development history, configured reviewer profile,
[AgentRuntime](../../agent-runtime/architecture.md#provided-interface), the
[Git adapter](../../adapters/git.md#interface), [GitHub adapter](../../adapters/github.md#interface)
and parent-supplied source input/publication acknowledgements.

Use [ReviewerRole](../../agent-runtime/reviewer-role.md#interface). Supply the response format below
and previous reports as context using the [findings contract](findings.md). The profile includes
the complete reviewer instructions.

### Output

```text
reviewArtifact = { pathFromArtifactsRoot: "review.json", type: ReviewOutput }
```

```ts
type ReviewOutput = {
  taskSubject?: string;
  profile: string;
  headRevision: string;
  verdict: 'approved' | 'changesRequested';
  taskKey: string;
  role: 'reviewer';
  report: ArtifactRef;
  invocationId: string;
};

type ReviewResponse = { verdict: 'approved' | 'changesRequested' };
```

The action captures the refreshed task subject in taskSubject when saving a new report, retaining
the subject for later artifact interpretation even if task selection is refreshed.

Request one JSON object conforming to ReviewResponse as the agent's final output. Include that
shape, its assigned Markdown path and narrative assessment/verdict obligations in context. Parse and
validate the response, then add the configured profile and observed reviewed head to create
ReviewOutput. They are not agent claims.

Review owns separate response and saved-outcome schemas and derives their provider format and types.
Both permit only the two declared verdicts; there is no report-shaped failure result.

### Outcomes

Return the recorded verdict: approved or changesRequested.
Each outcome writes reviewArtifact before publication and publishes the
[action outcome event](../architecture.md#action-outcome-events) referencing it with the profile used.
An invocation that reuses the saved report for the delivered head publishes the same reference.
Unusable agent output is an execution error.
An assessment that cannot finish supplies no usable verdict and follows the existing
[execution-error and recovery path](../../application.md#execution-and-recovery). Do not add a
review-specific retry mechanism or open a repair round merely because review could not finish.

## Behavior

Use PreparedWorkspace.repositoryWorkspace for repository inspection and the reviewer working
directory. Assess all code relevant to task correctness, including pre-existing code when correction
is necessary and preparation content carried by the first implementation. The comparison base and
diff help orient inspection; neither that range nor changes since a preceding review limit scope.
Stage acceptance is context, not delivery approval.
Keep review artifacts under the implementation issue; earlier stage or PR approval cannot approve
a changed head.

Confirm that the delivered head, development result, verification result and retained worktree describe
the same revision. Read saved task conversation and round history. A parent-owned input actor supplies refreshed task
conversation; save that input and refreshed GitHub PR conversations locally. Supply task requirements,
the current developer artifact and verification evidence, and complete earlier review/development
reports or readable local references, preserving their evidence and attribution. Published Jira
summaries do not replace these reports. Previous reports provide context; there is no eligible
finding set, per-finding response or disposition input.

Read the comparison diff for the recorded base/head and include that revision range in the review
context, explicitly identifying it as orientation rather than a scope boundary. Agent claims do not
change the revision this action is evaluating.

Use the existing worktree with the reviewer profile. Dependency installation, builds, focused checks
and temporary reproduction tests may write files. Verify that the reviewed revision and implementation
remain unchanged after the turn; new caches, logs or generated verification output alone do not
invalidate a review. Implementation fixes belong to a development turn.

The reviewer evaluates correctness and missing behavior and judges previous concerns and narrative
responses against current evidence. It writes assessment and actionable current findings in Markdown
and returns only verdict. Validate that control value, the assigned report and its binding under the
[shared report handling](architecture.md#markdown-reports-and-machine-outcomes). Do not parse or
validate findings or verdict consistency against prose. Bind the saved outcome/report to the
revision actually reviewed. Missing or invalid required output is unusable, never approval or an
invented finding.

An invocation fault or unusable response fails the action before saving a new reviewArtifact or
publishing a review/check. Retain the failure explanation through ordinary execution diagnostics;
do not manufacture a review report for an unfinished assessment.

Save the outcome/report binding. Publish the saved Markdown review and configured review check for
that exact head through the Nexus Lens publication capability. Only approved produces a successful
review check; changesRequested cannot authorize merge. The complete agent conversation stays in
local artifacts; the published review summarizes the result. Recognize an already-published review
by the configured Nexus Lens author, the reviewed commit, the verdict and retained publication body,
and the check by the configured name, the Nexus Lens producer identity, a completed status and the
verdict's conclusion. Publish only the missing part. Supply concise ticket feedback to the
parent-owned publication actor, which publishes a comment beginning with the profile and explaining
what was missed and what to improve. A requested repair stays in the current workflow; a Jira
comment is not the repair input.

On repetition, inspect the saved report and remote publication for that head before invoking the
reviewer or publishing again. Never apply approval to a later head.
Validate the current development outcome through its producer-owned usable-outcome reader before
both a fresh assessment and saved-review replay. Missing/unreadable reports, invalid outcomes,
foreign task evidence or mismatched repository revisions fail before publication and retain
validation-error context under the developer's responsibility. Readable Markdown wording changes
do not invalidate evidence. Approved and changesRequested saved replacements clear only the
reviewer's pending validation-error context under the shared continuation rules.
Developer context clears after validating the development basis: fresh assessment requires the
delivered worktree head with no tracked changes; saved-review publication replay uses the validated
assessment for the matching delivered and verified head without another worktree assessment.

New agent responses use the strict current response schema. The producer's saved-record reader also
accepts former finding IDs and disposition fields in retained reports without enforcing removed
lifecycle rules. Preserve the complete original reports as readable historical evidence. Required
verdict and revision fields and new report associations still receive validation; former structured
findings remain readable history without consistency validation. An invalid retained report is an
action failure, not an absent report or a verdict to translate. Reuse an otherwise valid completed
report only for its recorded head under the existing publication rules; history does not authorize a
changed revision. Do not rewrite history or add a compatibility verdict.

Review has no Jira capability. GitHub Nexus Lens review/check publication remains Review-owned.

## Acceptance examples

| Given | Observable result |
| --- | --- |
| Sufficient evidence and no current blocking findings, with or without non-blocking observations | The review is approved for the inspected head and its Lens review check succeeds. |
| At least one current blocking finding with concrete basis, evidence and impact | The review requests changes, its Lens review check does not authorize merge, and finite delivery returns to the existing repair flow. |
| Material evidence is unavailable and the assessment cannot finish | Execution fails through the existing recovery path; no usable review verdict, invented blocking finding or additional review retry mechanism is produced. |
| A reviewer returns the removed inconclusive verdict | The report is unusable output and is handled as an execution error. |
| Approval applies to a different head, a required pre-merge check fails, or merge and successful required post-merge checks are unconfirmed | The task cannot complete; the existing revision and pre/post-merge gates still apply. |
