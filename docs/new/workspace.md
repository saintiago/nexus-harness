# Workspace

Status: proposed data design.

Workspace consists of a fixed directory layout and a reference to one instance.

## Layout and reference

The workspace layout is:

```text
<workspace root>/
├── worktree/
├── artifacts/
└── state/
    └── workflow.json
```

| Path relative to root | Contents |
| --- | --- |
| `worktree/` | The target repository working copy |
| `artifacts/` | Persistent inputs, outputs and conversation records |
| `state/workflow.json` | The persisted workflow state |

These names and locations are fixed. Subdirectories and files within artifacts/ are defined by
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
