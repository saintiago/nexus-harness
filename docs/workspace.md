# Workspace

WorkspaceRef identifies one workspace instance. Finite delivery and the planned idea refinement
workflow each own a fixed layout for their different artifacts.

## Layout and reference

The current finite delivery workspace layout is:

```text
<workspace root>/
├── worktree/
├── artifacts/
│   └── <roundNumber>/
└── state/
    ├── prepared-workspace.json
    ├── preparation/
    └── current-round.json
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

WorkspaceRef.root is an absolute, canonical directory path. It identifies exactly one workspace
instance. Two references with the same canonical root identify the same instance. A reference does
not imply that the directory exists.

All layout paths are relative to root and remain within it. WorkspaceRef is a plain value with no
methods, process handles, configuration loaders or lifecycle state.

## Planned idea refinement layout

The [idea refinement specification](idea-refinement/spec.md#artifacts-and-revision-binding)
defines a separate workspace under
`<storage root>/workspaces/<project>/<idea>/refinement/`. Its artifacts are keyed by council
cycle and brief revision. It does not use finite delivery's current-round record or writable
delivery worktree. The same WorkspaceRef value identifies the refinement workspace. Nexus owns
artifact writes; agents read the project snapshot and supplied context.
