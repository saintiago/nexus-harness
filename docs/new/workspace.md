# Workspace

Status: proposed data design.

Workspace is a folder hierarchy and a reference to one concrete instance of that hierarchy. It has
no actions, lifecycle methods or orchestration. WorkspaceLayout and WorkspaceRef are plain values.

## Layout and reference

```ts
type WorkspaceLayout = {
  worktree: string;
  artifacts: string;
  state: string;
};

type WorkspaceRef = {
  root: string;
};
```

Layout entries are relative directory paths within the workspace root. WorkspaceRef.root is the
absolute, canonical root of a particular instance. A reference may exist before any directory has
been created. Resolving layout entries against the root must stay within that root.

For example:

```text
<workspace root>/
├── worktree/
├── artifacts/
└── state/
    └── workflow.json
```

The worktree holds the target project's working copy. Artifacts hold persistent action inputs,
outputs and conversation. State holds the workflow checkpoint. Individual artifact names, schemas
and task/candidate identities belong to producer/consumer contracts, not the folder hierarchy.

Nexus configuration owns the layout and the storage root under which instances are located. The
project does not configure either. Startup supplies the selected layout to the code that needs to
resolve locations and supplies a WorkspaceRef for the current action sequence. Resuming uses the
same reference. Independent task workspaces use distinct references; a queue must preserve the
reference selected for its active task across interruption.

## Preparation

PrepareWorkspace receives the layout, instance reference and repository settings through its bound
dependencies. It creates the directories and prepares the repository working copy at the resolved
worktree location. The source repository and base branch come from project configuration.

Directory creation, checking an existing working copy and deciding how to reuse it are behavior of
PrepareWorkspace. They are not methods on WorkspaceRef or WorkspaceLayout. Preserve existing work;
preparation does not imply resetting a retained working copy. A repeated preparation action may use
the same reference and existing directories.

## Use by actions and runtime

Actions receive the current workspace reference and the capabilities they need. Artifact readers
and writers resolve their agreed locations using the configured layout. An action completes its
output writes before returning its outcome.

AgentRuntime receives the same workspace reference for its working directory and authorized resource
locations. The invoking action supplies the instructions and context; the runtime does not discover
an invocation request by scanning this hierarchy. An agent can inspect files referenced by the
supplied context through its authorized tools.

ExecutionRunner receives its checkpoint location directly during construction. It does not receive
a workspace object, interpret the layout or inspect artifacts. The state machine remains independent
of how the application organizes directories.
