# PrepareWorkspace

## Responsibility

Create or reuse the selected task's workspace and prepare its repository for implementation.

## Interface

Follow the [action contract](architecture.md). Read [Selection](select-task.md#output).
Use the fixed [workspace layout](../../workspace.md#layout-and-reference), project repository and
preparation settings, the [Git adapter](../../adapters/git.md#interface),
the [Processes adapter](../../adapters/processes.md#interface) and filesystem access.

### Output

This action runs before the first round. It owns state/prepared-workspace.json within the selected
workspace and exports its record declaration:

```ts
type PreparedWorkspace = {
  taskKey: string;
  repository: string;
  branch: string;
  baseRevision: string;
};
```

The workspace root comes from Selection. The base revision is the implementation's comparison base,
not a requirement to reset retained work to that revision.

### Outcomes

- prepared: the directory layout, repository and configured preparation commands are ready.
- failed: a repository condition or completed preparation command prevents readiness.

prepared writes the record. Preserve preparation output under state/preparation/ and emit failure
reasons for recovery. Launch and filesystem errors are execution errors.

## Behavior

Create missing workspace directories. For new work, obtain the repository in worktree/, check out
main and pull its latest remote changes with a fast-forward. Create and check out the task's development
branch from that updated main. Record the branch and base revision for later actions.
After recovery discarded an attempt, use a new branch name rather than adopting its old remote branch.

For retained work, inspect the repository and saved identity. Reuse the matching worktree, preserving
local commits and uncommitted changes for implementation to inspect. Do not reset, clean or silently
adopt a different repository or task branch.

Run the configured preparation commands in the worktree and preserve their output. A completed
nonzero command produces failed. Retain the repository and original comparison base on repetition;
preparation must not turn a continuation into a fresh checkout.

This action does not select a round or inspect subsequent action artifact schemas.
Baseline verification is not part of preparation.
