# SelectWork

## Responsibility

Select one eligible project issue in source order and retain its identity, stage and workspace
reference for the parent. This is a parent-owned source operation, not part of a child.

## Interface

Follow the [action contract](architecture.md). Use project task-source settings,
the Nexus workspace root and the [Jira adapter](../../adapters/jira.md#interface).
Use [WorkspaceRef](../../workspace.md#layout-and-reference) to identify the selected workspace.
Import [ImplementationInput](implementation-handoff.md#output) and the
[completion declaration](complete-task.md#output) for linked implementation eligibility.

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
  /** Captured source workspace for a handoff ticket with no implementation input. */
  handoffSourceWorkspace?: WorkspaceRef;
  /** The stage the parent routes to; the parent's publications update it. */
  stage: 'idea' | 'requirements' | 'ux' | 'prototype' | 'architecture' | 'delivery';
  /** Retained ready admission; PrepareWorkspace retires it on successful preparation. */
  initialClaim?: boolean;
};
```

task holds the task details: its title and description in the source's native format. No separate
acceptance-criteria section or prescribed description template is required. conversation holds the
complete source conversation separately, saved locally for both development and review. Prior agent
exchanges remain in the round artifacts. These records do not introduce another issue/comment schema.
The source connection is supplied configuration. Workspace paths distinguish projects as well as tasks.
The configured status mappings select the stage; a candidate whose status has no configured stage
requests attention instead of being silently skipped, and the parent's own publications advance or
return the stage and update the record.

### Outcomes

- selected: the selected task, complete source input and workspace reference have been saved.
- empty: a successful source inspection found no eligible task in the configured project.
- failed: an observed task condition prevents selection, with the reason emitted for recovery
  and the actual candidate identity/reason retained in selection-failure.json beside selection.json.
  The failure carries a selected-work snapshot only when this invocation continued or claimed it;
  a stale selection does not establish ownership. Selected-work failures also retain a copy under
  that issue's parent area for terminal evidence.

Only selected supplies a task for subsequent actions. Source access failures are execution errors,
not evidence of an empty queue. selected publishes the
[action outcome event](../architecture.md#action-outcome-events) referencing the saved selection file,
including when it continues a retained selection without rewriting it; empty and failed save no
selection and publish no outcome event.

## Behavior

Read a fresh candidate list in configured source rank order. Do not reserve a batch or reorder by a
separate priority rule.

Read the candidate's task details and full conversation. Require a title, a description and the
configured eligibility conditions. Re-read its status before claiming it; preserve intervening human changes.

Choose the existing retained issue root when recorded, or the stable project/issue path under
the configured root. The source workspace pointer names that root, including after idea refinement.
Save selection before updating the configured source status and workspace pointer. This action
chooses a reference; it does not create the worktree.

On repetition, inspect the saved selection and current source state. Finish an incomplete claim or
continue the same unfinished task before selecting unrelated work. Preserve ready-admission
evidence independently of refreshed task snapshots across repeated interruptions until repository
preparation succeeds. This exception admits only In Progress; In Review always requires matching
prepared, development, verification and delivery evidence.
Read retained development through its producer-owned usable-outcome reader: invalid task or report
associations retain attributable validation-error evidence before admission fails. Admission leaves
pending context for the consuming owner to clear after its applicable revision/readiness checks,
without another development turn or a correction protocol. A completed previous
task allows fresh selection. Unexpected source state is reported rather than overwritten.

With no saved active selection, select from the current source order. There is no special blocker
target. Reuse retained work only when it still exists. If recovery discarded the broken finite
delivery attempt and cleared its pointer, selection uses the same stable issue workspace;
preparation starts a fresh attempt from updated main. Earlier workflow artifacts remain
available.

The design assumes one queue consumer; no claim lease or distributed locking protocol is added here.

Stage eligibility and entry follow the [project workflow](../../project-workflow.md#entry-and-routing).
Children receive captured inputs without importing the Jira adapter.

For a linked implementation, validate its retained input and prerequisite delivery completion before
claiming it. Defer a dependent whose prerequisite lacks confirmed merge/check and source completion;
continue inspecting eligible work in source rank order. Source Done alone is insufficient. Malformed
input and provider faults are not an empty queue or a completed prerequisite. A ticket that carries
the handoff's source identity but retains no input yet is deferred until the handoff retains it, and
so is a ticket whose source handoff record has not recorded its link, rank and admission effects yet;
neither is treated as an ordinary task. A ticket no source handoff record accounts for requests
attention with its identity. Only a source handoff without the current contract's frozen basis and
with finished link/admission effects qualifies for the earlier-contract ordinary delivery exception.
Finished effects with a current-contract basis and missing input require reconciliation.

Read prerequisite completion at the workspace carried in the implementation input. A cleared source
pointer does not discard that reference; a nonempty pointer conflicting with it requests reconciliation.
For an input-less ticket, resolve the source issue's recorded workspace pointer (or stable root when
no pointer is recorded), then capture it as handoffSourceWorkspace for PrepareWorkspace. An unavailable
recorded source root never falls back to a different handoff. Resume with the captured reference;
reconcile conflicting source pointers instead of replacing it. Keep the implementation issue's own
workspace pointer even when its repository will be borrowed from preparation.
