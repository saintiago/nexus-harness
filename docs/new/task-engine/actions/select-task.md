# SelectTask

## Responsibility

Select one eligible task in source order and retain its identity and workspace reference for the workflow.

## Interface

Follow the [action contract](architecture.md). Use project task-source settings,
the Nexus workspace root and the [Jira adapter](../../adapters/jira.md#interface).
Use [WorkspaceRef](../../workspace.md#layout-and-reference) to identify the selected workspace.

### Output

This action runs before a round exists. Its output is selection.json beside the configured workflow-state
file, not a round artifact. The action exports the Selection type and the selection-file declaration.

```ts
type Selection = {
  taskKey: string;
  source: { kind: 'jira'; issueId: string };
  task: unknown;
  conversation: unknown[];
  workspace: WorkspaceRef;
};
```

task holds the task details: its title and description in the source's native format. No separate
acceptance-criteria section or prescribed description template is required. conversation holds the
complete source conversation separately, saved locally for both development and review. Prior agent
exchanges remain in the round artifacts. These records do not introduce another issue/comment schema.
The source connection is supplied configuration. Workspace paths distinguish projects as well as tasks.

### Outcomes

- selected: the selected task, complete source input and workspace reference have been saved.
- empty: a successful source inspection found no eligible task in the configured project.
- failed: an observed task condition prevents selection, with the reason emitted for recovery.

Only selected supplies a task for subsequent actions. Source access failures are execution errors,
not evidence of an empty queue.

## Behavior

Read a fresh candidate list in configured source rank order. Do not reserve a batch or reorder by a
separate priority rule.

Read the candidate's task details and full conversation. Require a title, a description and the
configured eligibility conditions. Re-read its status before claiming it; preserve intervening human changes.

Choose the existing retained workspace when recorded, or a stable project/task path under the configured
root. Save selection before updating the configured source status and workspace pointer. This action
chooses a reference; it does not create the worktree.

On repetition, inspect the saved selection and current source state. Finish an incomplete claim or
continue the same unfinished task before selecting unrelated work. A completed previous task allows
fresh selection. Unexpected source state is reported rather than overwritten.

With no saved active selection, select from the current source order. There is no special blocker
target. Reuse retained work only when it still exists. If recovery deleted the broken workspace and
cleared its pointer, selection supplies a new workspace reference and preparation starts from updated main.

The design assumes one queue consumer; no claim lease or distributed locking protocol is added here.
