# SelectTask

## Responsibility

Select one eligible task in source order and retain its identity and workspace reference for the workflow.

## Interface

Follow the [action contract](architecture.md). Use project task-source settings, the requested scope,
the Nexus workspace root and the [Jira adapter](../../adapters/jira.md#interface) or a supplied local task file.
Use [WorkspaceRef](../../workspace.md#layout-and-reference) to identify the selected workspace.
For local-task completion, import [completionArtifact](complete-task.md#output) and read it from the
task's retained history.

### Output

This action runs before a round exists. Its output is selection.json beside the configured workflow-state
file, not a round artifact. The action exports the Selection type and the selection-file declaration.

```ts
type Selection = {
  taskKey: string;
  source: { kind: 'jira'; issueId: string } | { kind: 'file'; path: string };
  task: unknown;
  conversation: unknown[];
  workspace: WorkspaceRef;
};
```

task and conversation hold complete provider-native values, or the local task document. Their concrete
types belong to the source contract; this record does not introduce another issue/comment schema.
The source connection is supplied configuration. Workspace paths distinguish projects as well as tasks.

### Outcomes

- selected: the selected task, complete source input and workspace reference have been saved.
- empty: a successful source inspection found no eligible task in the requested scope.
- failed: an observed task condition prevents selection, with the reason emitted for recovery.

Only selected supplies a task for subsequent actions. Source access failures are execution errors,
not evidence of an empty queue.

## Behavior

Read a fresh candidate list in configured source order. A single-ticket or local-task scope restricts
selection to that task. Do not reserve a batch or reorder by a separate priority rule.

Read the candidate and full conversation. Require an actionable task and the configured eligibility
conditions. Re-read its status before claiming it; preserve intervening human changes.

Choose the existing retained workspace when recorded, or a stable project/task path under the configured
root. Save selection before updating the configured source status and workspace pointer. This action
chooses a reference; it does not create the worktree.

On repetition, inspect the saved selection and current source state. Finish an incomplete claim or
continue the same unfinished task before selecting unrelated work. A completed previous task allows
fresh selection. Unexpected source state is reported rather than overwritten.

For local tasks, read the local document and use its retained completion output to distinguish finished
work; no Jira claim or source update is performed.

The design assumes one queue consumer; no claim lease or distributed locking protocol is added here.
