# Develop

## Responsibility

Implement the selected task or repair the preceding round's findings in its retained worktree.

## Interface

Follow the [action contract](architecture.md). Use the task input from
[SelectWork](select-task.md#output), the prepared workspace from
[PrepareWorkspace](prepare-workspace.md#output), [AgentRuntime](../../agent-runtime/architecture.md#provided-interface)
and the [Git adapter](../../adapters/git.md#interface). Use the
parent-owned source input to refresh task content and conversation.

Import the output declarations of [Verify](verify.md#output) and [Review](review.md#output) for
historical context. These are earlier-round reads, not fallbacks for missing current-round inputs.
Read [StartDevRound](start-dev-round.md#output)'s current-round record for the developer profile selected
for this round. Develop does not choose or escalate profiles.

Each invocation uses [DevelopmentRole](../../agent-runtime/development-role.md#interface). Supply
task-specific context and the response format; the profile supplies the constant role instructions.
Use the [findings contract](findings.md) for current findings supplied within previous reports.
Request DevelopmentResponse below. Repository revisions and
profile identity are observed by this action rather than accepted from the agent.

### Output

```text
devArtifact = { pathFromArtifactsRoot: "development.json", type: DevelopmentOutput }
```

```ts
type DevelopmentOutput = {
  taskSubject?: string;
  taskKey: string;
  profile: string;
  status: 'completed' | 'failed';
  baseRevision: string;
  headRevision: string;
  role: 'developer';
  report: ArtifactRef;
  reportIdentity: string;
  invocationId: string;
  readinessFailure: string | null; // action-observed condition, not agent narrative
};

type DevelopmentResponse = { status: 'completed' | 'failed' };
```

The action captures the refreshed task subject in taskSubject when saving a new report, retaining
the subject for later artifact interpretation even if task selection is refreshed.

Request one JSON object conforming to DevelopmentResponse as the agent's final output. Include the
shape and field meanings in context. Parse and validate it before recording the artifact. There is
no structured per-finding response or cross-round matching requirement.

The action records the profile and observed repository revisions. The agent supplies only status.
Its assigned Markdown explains changes, verification and results, corrections, disagreements and
remaining problems, as applicable. Validate and save the [report
binding](architecture.md#markdown-reports-and-machine-outcomes) with the outcome. For incomplete
work, explain why it could not be completed. Claimed verification does not replace Verify's command
evidence.

### Outcomes

- completed: the agent produced a usable implementation report and committed work is available for verification.
- failed: the agent produced a usable report explaining why implementation could not be completed.

Both outcomes write devArtifact and publish the
[action outcome event](../architecture.md#action-outcome-events) referencing it with the profile used.
An invocation that reuses the current-round report publishes the same reference. Invocation failures
or unusable output are execution errors.

## Behavior

Use the profile recorded for the current round. Read the task and conversation refreshed by the
parent-owned input boundary, preserving human changes. Read relevant repository instructions and
previous review and development reports and failed-check evidence. The parent owns the selection
update; Develop supplies that saved input alongside the existing round history.
Include available earlier-round history as complete reports or readable local references without
silently truncating finding bodies. Do not derive an eligible finding set or response obligations.

Invoke the agent once with the workspace reference and assembled context. The agent may inspect and
continue existing uncommitted work. It leaves local commits; publication belongs outside this action.
It leaves the worktree ready for verification, including installing dependencies when its changes
require them. Verification uses this same worktree.

Resolve the repository and agent working directory from PreparedWorkspace.repositoryWorkspace,
while reading/writing rounds under the selected implementation issue. The first implementation
therefore continues the preparation branch without moving or copying stage artifacts.

Interpret the returned report and inspect the resulting branch and revision. Completed work must be
committed and ready for verification. Record failed when the turn reports incomplete work or leaves
tracked implementation changes uncommitted; when a completed turn's observed worktree is not ready,
the saved outcome records the observed readinessFailure separately; the agent's Markdown remains
unchanged. Save the outcome and report association before returning.

On repetition, inspect existing work and the current-round report before deciding whether another
invocation is needed. A report for a different task or revision is not evidence for the current work.

Untracked files do not prevent completion. Do not classify or reject them as a readiness check.

Task/conversation refresh is performed by a parent-owned input actor at the development-round
boundary. Develop receives the saved snapshot and has no Jira capability.

## Retained reports

New responses and saved outcomes use the separated contracts above. Producer-owned saved-record
readers also accept retained reports carrying the former finding-response field, without validating
its removed lifecycle rules. Preserve the original file as readable history and provide its
narrative and previous review evidence to the next invocation. The producer reads legacy combined
reports under the [action compatibility rules](architecture.md#agent-response-contracts). New
outcome/report bindings, control values and repository readiness still receive validation and normal
rejection feedback. No history rewrite, new round allowance or alternative delivery path is
introduced.