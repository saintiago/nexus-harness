# Develop

## Responsibility

Implement the selected task or repair the preceding round's findings in its retained worktree.

## Interface

Follow the [action contract](architecture.md). Use the task input from
[SelectTask](select-task.md#output), the prepared workspace from
[PrepareWorkspace](prepare-workspace.md#output), [AgentRuntime](../../agent-runtime/architecture.md#provided-interface)
and the [Git adapter](../../adapters/git.md#interface). For a Jira task, use the
[Jira adapter](../../adapters/jira.md#interface) to refresh task content and conversation.

Import the output declarations of [Verify](verify.md#output), [Review](review.md#output) and
[SelectRepair](select-repair.md#output) for historical context. These are earlier-round reads, not
fallbacks for missing current-round inputs.

Configuration supplies the initial developer profile. A selected repair supplies the next profile.
Each uses [DevelopmentRole](../../agent-runtime/development-role.md#interface). Supply task-specific
context and the response format; the profile supplies the constant role instructions.
Use the [findings contract](findings.md) for complete finding inputs and response values.
Request DevelopmentResponse below. Repository revisions and
profile identity are observed by this action rather than accepted from the agent.

### Output

```text
devArtifact = { pathFromArtifactsRoot: "development.json", type: DevelopmentOutput }
```

```ts
type DevelopmentOutput = {
  taskKey: string;
  profile: string;
  status: 'completed' | 'failed';
  baseRevision: string;
  headRevision: string;
  summary: string;
  findingResponses: FindingResponse[];
};

type DevelopmentResponse = Pick<DevelopmentOutput, 'status' | 'summary' | 'findingResponses'>;
```

Request one JSON object conforming to DevelopmentResponse as the agent's final output. Include that
shape, FindingResponse and its response/identity rules in context. Require exactly one response per supplied finding ID; use an
empty array when none were supplied. Parse and validate it before recording the artifact.

The action records the profile and observed repository revisions. The agent supplies the status, summary and
responses. Summary explains what changed and why, or why implementation could not be completed.
It is not a declaration that checks passed.

### Outcomes

- completed: the agent produced a usable implementation report and committed work is available for verification.
- failed: the agent produced a usable report explaining why implementation could not be completed.

Both outcomes write devArtifact. Invocation failures or unusable output are execution errors.

## Behavior

Use the initial profile for the first implementation and the recorded repair choice for later rounds.
Refresh the task and conversation, preserving human changes. Read relevant repository instructions
and complete preceding findings and responses.
Update the selection record with the refreshed task and complete conversation, preserving its
identity and workspace, and provide that file with the existing round history.
Include available earlier-round history without silently truncating finding bodies.

Invoke the agent once with the workspace reference and assembled context. The agent may inspect and
continue existing uncommitted work. It leaves local commits; publication belongs outside this action.
It leaves the worktree ready for verification, including installing dependencies when its changes
require them. Verification uses this same worktree.

Interpret the returned report and inspect the resulting branch and revision. Completed work must be
committed and ready for verification. Record failed when the turn reports incomplete work or leaves
implementation changes uncommitted; when a completed turn's observed worktree is not ready, the
recorded summary keeps the agent's explanation and the observed readiness failure. Finish writing
the report before returning.

On repetition, inspect existing work and the current-round report before deciding whether another
invocation is needed. A report for a different task or revision is not evidence for the current work.
