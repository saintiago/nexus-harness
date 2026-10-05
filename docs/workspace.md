# Workspace

An issue has one stable workspace root at `<storage root>/workspaces/<project>/<issue>/`.
The source workspace pointer names that issue's root. Workflow areas retain their own artifacts;
repository location and artifact ownership are separate. Passing a repository forward does not
transfer ownership of earlier stage or issue artifacts.

## Layout and reference

```text
<issue workspace root>/
├── worktree/                    shared preparation checkout, or ordinary delivery checkout
├── requirements/{state/,artifacts/<round>/}
├── ux/{state/,artifacts/<round>/}
├── prototype/{state/,artifacts/<round>/}
├── architecture/{state/,artifacts/<round>/}
├── parent/                      repository identity and source handoffs
├── artifacts/<round>/           this issue's finite delivery history
├── state/                       this issue's finite delivery working state
└── refinement/
    ├── worktree/                separate idea-refinement repository
    ├── artifacts/               submissions and conversation cycles
    └── state/                   idea round plan
```

Preparation stages share the root-level worktree and its branch. Their areas contain state and
artifacts, without separate checkouts. There is no cross-stage copying or assembly of accepted files.

| Path relative to the delivery issue root | Contents |
| --- | --- |
| `artifacts/<roundNumber>/` | Persistent inputs and outputs for one delivery round |
| `state/attempt.json` | Identity of the finite delivery attempt |
| `state/prepared-workspace.json` | Task, repository workspace, branch and comparison-base identity |
| `state/preparation/` | Preparation command output |
| `state/current-round.json` | Current developer round plan |
| `report-feedback/` | Report rejection/correction evidence retained outside disposable delivery attempts |

These locations are fixed. roundNumber is a positive integer. Producers define the record schemas.

Preparation stage areas and the refinement area retain their own `report-feedback/` directories.
The [report owner](task-engine/actions/architecture.md#rejection-evidence-and-continuation) supplies
the scope and declaration. Repository continuation never transfers feedback to a donor issue or
another role. Delivery cleanup preserves the issue-root feedback directory.

```ts
type WorkspaceRef = {
  readonly root: string;
};
```

WorkspaceRef.root is an absolute, canonical directory identifying a workspace area. Repository
operations resolve `worktree/` exactly once within a repository WorkspaceRef. For preparation this
reference names the preparation issue root; for idea refinement it names `refinement/`. Ordinary
delivery uses its own issue root. A reference does not imply that a directory exists.

The first implementation issue owns its state and artifacts under its own issue root, while its
prepared-workspace record names the preparation issue's repository WorkspaceRef. All repository
operations and agent working directories use that recorded reference. The source workspace pointer
continues to identify the implementation issue's own root. Later implementation issues use their
own repositories from the merged base. Neither a symlink nor a copied checkout stands in for
continuity.

Two references with the same canonical root identify the same area. WorkspaceRef is a plain value,
without methods, process handles, configuration loaders or lifecycle state. ArtifactRef names an
absolute file; it does not identify a mutable checkout as accepted evidence. Layout paths remain
inside their owning issue workspace. Explicit repository references permit the first implementation
to use the preparation workspace without deriving a donor path from ticket text.

## Idea refinement layout

The [idea refinement specification](idea-refinement/spec.md#artifacts-and-revision-binding) defines
the separate refinement area. Re-entry retains submission history, conversation cycles and revision
identities. StartIdeaRound owns its plan and does not use the finite developer ladder. Nexus owns
artifact writes; agents use the supplied prepared repository and context.

## Parent preparation storage

The [preparation operations](task-engine/actions/preparation-stage.md) own the shared repository
identity and stage acceptance records. The [implementation handoff](task-engine/actions/implementation-handoff.md)
owns the plan-to-ticket mapping and repository continuation input under parent/. Each stage writes
only its own numbered rounds and current terminal record. Later stages and implementation issues
read immutable producer artifacts by reference, including accepted prototype evidence.

The project execution directory owns one composed parent/child snapshot. Checkouts are working state,
not handoff evidence. Recovery preserves the preparation repository while its first implementation
continues it; disposable later delivery attempts can be replaced without removing preparation or
idea history. A retained legacy layout needs explicit reconciliation before use. Do not silently
select one of several divergent stage checkouts or lose accepted revisions and consumed allowances.
