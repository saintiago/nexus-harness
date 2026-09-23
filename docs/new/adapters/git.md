# Git adapter

## Responsibility

Perform requested local and remote Git operations.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies Git command execution. Consumers supply repository paths, revisions, remotes
and the requested operation.

Return repository state, command results or diff data as required by the consumer.
The calling action decides whether to create or reuse a checkout and how to handle existing work.
The adapter does not combine these decisions into a prepare operation.

### Required capabilities

| Operation | Inputs and result | Consumers |
| --- | --- | --- |
| Inspect repository | Worktree path → repository/remote identity, branch, head and tracked/untracked status | [PrepareWorkspace](../task-engine/actions/prepare-workspace.md#interface), Develop, Verify, Deliver, Review |
| Clone repository | Source and destination → checkout identity | PrepareWorkspace |
| Fetch and resolve revision | Repository, remote and branch/ref → commit revision | PrepareWorkspace |
| Create/check out branch | Repository, branch and explicit starting revision → resulting branch/head | PrepareWorkspace |
| Read diff | Repository and base/head revisions → diff data | Review |
| Push branch | Repository, branch and expected local head → push result | Deliver |
| Read remote branch head | Remote and branch → revision or absence | Deliver |

Revision values identify actual Git commits. They are not artifact checksums or a separate integrity
scheme. Preserve local work when invoking the requested operations; conflicting work is reported.

## Behavior

Preserve the requested revision identities and report tracked and untracked work when reading status.
Perform the requested operation without adding resets, cleanup or history rewriting.

Return operation failures with useful Git diagnostics. Deciding how to reconcile the repository
belongs to the caller.
