# PrepareWorkspace

## Responsibility

Create or reuse the selected task's workspace and prepare its repository for implementation.

## Interface

Follow the [action contract](architecture.md). Read [Selection](select-task.md#output).
Use the fixed [workspace layout](../../workspace.md#layout-and-reference), project repository and
preparation settings, the [Git adapter](../../adapters/git.md#interface),
the [Processes adapter](../../adapters/processes.md#interface) and filesystem access.
Import an implementation ticket's [handoff input](implementation-handoff.md#output) when present.

### Output

This action runs before the first round. It owns state/prepared-workspace.json within the selected
workspace and exports its record declaration:

```ts
type PreparedWorkspace = {
  taskKey: string;
  repository: string;
  repositoryWorkspace: WorkspaceRef;
  branch: string;
  baseRevision: string;
};
```

Selection supplies the issue root for state and artifacts. repositoryWorkspace separately names
the checkout used by all repository operations and agent invocations. Ordinary tasks use the selected
issue root; the first implementation uses the handoff's preparation repository reference. The base
revision is the implementation's comparison base, not a requirement to reset retained work to it.
A record retained before the repository reference was recorded resolves to the selected issue's own
root; it is never silently reinterpreted as another issue's checkout.

It also owns the attempt's retained records, outside the round artifact roots:

- state/attempt.json: the identity of one finite delivery attempt. PrepareWorkspace writes a fresh
  identity before any repository work, so the terminal handoff of an attempt that never prepares still
  names its own attempt, and the next attempt after recovery discarded the state carries a new one
  even when it reuses the branch name.
- state/preparation-failure.json: the reason of the action's failed outcome, retained so the terminal
  handoff states it after a restart instead of relying on the event of a stopped process.

### Outcomes

- prepared: the directory layout, repository and configured preparation commands are ready.
- failed: a repository condition or completed preparation command prevents readiness.

prepared writes the record and publishes the
[action outcome event](../architecture.md#action-outcome-events) referencing it, naming the task branch;
reusing a retained workspace publishes the same reference and keeps the attempt identity. failed
saves no prepared-workspace record; it retains its reason at state/preparation-failure.json and
publishes it. Preserve preparation output under state/preparation/ and emit failure
reasons for recovery. Launch and filesystem errors are execution errors.

## Behavior

Create missing workspace directories. For new work, obtain the repository in worktree/, check out
main and pull its latest remote changes with a fast-forward. Create and check out the task's development
branch from that updated main. Record the branch and base revision for later actions.
After recovery discarded an attempt, use a new branch name rather than adopting its old remote branch.

For the first implementation's continuation, adopt the recorded preparation repository, branch and
comparison base after checking their actual identities against the configured repository source and
the retained preparation record, and the frozen preparation revision's ancestry. Do not clone, rename
the branch or pull/reset the checkout. Retain preparation commits together with any local
implementation work. The implementation issue owns its own attempt, rounds and command logs. Repeat
admission using its saved record; never infer a donor checkout from description text. A selected
ticket that carries the handoff's source identity but retains no implementation input requests
attention instead of preparing a fresh ordinary checkout, unless its source handoff record already
finished the ticket's link and admission under the earlier contract, which created tickets without
inputs.
For later implementation tickets, use an updated configured base containing every prerequisite's
confirmed merge revision, read from the workspace reference the handoff recorded for that prerequisite.
A base that lacks it cannot produce prepared; do not manufacture inclusion through cherry-picks or
silently start without it.

For retained work, inspect the repository and saved identity. Reuse the matching worktree, preserving
local commits and uncommitted changes for implementation to inspect. Do not reset, clean or silently
adopt a different repository or task branch.

Run the configured preparation commands in the worktree and preserve their output. A completed
nonzero command produces failed. Retain the repository and original comparison base on repetition;
preparation must not turn a continuation into a fresh checkout.

Recovery of a continuation preserves its donor checkout and the immutable preparation handoff.
A fresh delivery attempt can discard its own round/state records after reconciling its unmerged PR,
but cannot substitute a new repository or branch. If safe continuation cannot be established,
request attention. Disposable ordinary delivery repositories retain the normal fresh-branch behavior.

This action does not select a round or inspect subsequent action artifact schemas.
Baseline verification is not part of preparation.

Successful preparation retires Selection.initialClaim only after its prepared-workspace record is
durable, so repeated interrupted claims stay resumable until this boundary completes.
