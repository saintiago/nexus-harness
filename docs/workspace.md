# Workspace

An issue has one stable workspace root at `<storage root>/workspaces/<project>/<issue>/`.
The source workspace pointer names that root, never a workflow area. Its workflow areas retain
artifacts across the issue's lifecycle. Later workflows may read all retained artifacts in
that issue workspace; each workflow writes only its own state and artifacts.

## Layout and reference

The issue workspace retains the existing finite delivery layout at its root. Idea refinement
uses the `refinement/` area. A later workflow adds its own area when its layout is defined.

```text
<issue workspace root>/
├── worktree/                    finite delivery repository
├── artifacts/<roundNumber>/     finite delivery round history
├── state/                       finite delivery working state
└── refinement/
    ├── worktree/                Git worktree for idea agents
    ├── artifacts/               submissions and council cycles
    └── state/                   idea round plan
```

| Path relative to root | Contents |
| --- | --- |
| `worktree/` | The target repository working copy |
| `artifacts/<roundNumber>/` | Persistent inputs and outputs for one round; earlier rounds form history |
| `state/prepared-workspace.json` | Task, repository, branch and comparison-base identity |
| `state/preparation/` | Preparation command output |
| `state/current-round.json` | The current round plan: number, developer profile and reason |

These names and locations are fixed. roundNumber is a positive integer. Files within each round are defined by
their individual artifact contracts. The workspace layout does not define their schemas.

```ts
type WorkspaceRef = {
  readonly root: string;
};
```

WorkspaceRef.root is an absolute, canonical directory path for the active workflow area:
the issue root for finite delivery and its `refinement/` child for idea refinement. Two
references with the same canonical root identify the same workflow area. A reference does not
imply that the directory exists.

All layout paths are relative to the selected workflow area and remain within the issue
workspace. WorkspaceRef is a plain value with no methods, process handles, configuration loaders
or lifecycle state. Saved artifact references identify files by absolute path. A later workflow
reads earlier artifacts through those references or the stable issue root; it does not copy them
into its own area. When a new issue is created from an approved idea, its handoff retains the
source issue identity and artifact references so the new issue can read the origin workspace.
Workflow state and mutable worktrees do not become handoff artifacts.

## Idea refinement layout

The [idea refinement specification](idea-refinement/spec.md#artifacts-and-revision-binding)
defines the stable `refinement/` area within the issue workspace. Each entry from `Idea`
reuses that area when present and adds a new numbered submission history. Artifacts are keyed by
submission, council cycle and brief revision. Idea refinement's StartIdeaRound owns its own
`state/current-round.json` plan with idea roles and cycle identity; it does not use finite
delivery's developer ladder or writable delivery worktree. The same WorkspaceRef value identifies
the refinement area. Nexus owns artifact writes; agents use the prepared project worktree
and supplied context. A fresh finite delivery attempt may replace its root-level `worktree/`,
`artifacts/` and `state/` without removing `refinement/` or other retained workflow areas.
