# TaskEngine

Status: proposed component design.

## Responsibility

Execute a task workflow supplied as YAML. The workflow defines sequencing, ordinary functions perform
the actions, and persistent artifacts carry data between actions. Process one action at a time.

The public module is `src/task-engine/index.ts`. Its construction inputs are a workflow, bound action
implementations and a checkpoint location.

## Composition

```text
TaskEngine
├── ExecutionRunner
└── Actions
    ├── SelectTask
    ├── PrepareWorkspace
    ├── Develop
    ├── Verify
    ├── Review
    ├── SelectRepair
    ├── Deliver
    └── CompleteTask
```

ExecutionRunner is the core: a domain-independent state machine that follows the supplied workflow.
Actions own task-specific behavior. Workflow definitions are executable input, not another coordinator.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary).
Actions use the [workspace data contract](workspace.md#layout-and-reference). Workflow settings
conform to [Nexus configuration](configuration.md#nexus-configuration); repository and
command settings conform to [project configuration](configuration.md#project-configuration).

### Provided interface

```ts
interface TaskEngine {
  run(
    request: EngineRequest,
    observe: Observer<EngineEvent>,
    stop: AbortSignal,
  ): Promise<EngineResult>;
  inspect(invocationId: string): Promise<Result<EngineInspection>>;
}

type EngineRequest = {
  executionId: string;
  invocationId: string;
  selection:
    | { kind: 'queue'; whenEmpty: 'return' | 'wait' }
    | { kind: 'ticket'; key: string }
    | { kind: 'file'; path: string };
  continuation: ArtifactRef | null;
};

type TaskIdentity = { source: string; id: string; key: string | null };

type EnginePhase = 'selecting' | 'preparing' | 'baseline' | 'developing'
                 | 'checking' | 'reviewing' | 'delivering' | 'completing' | 'idle';

type EngineEvent = {
  invocationId: string;
  sequence: number;
  at: string;
  body:
    | { kind: 'phase'; task: TaskIdentity | null; phase: EnginePhase }
    | { kind: 'activity'; role: 'developer' | 'reviewer'; text: string }
    | { kind: 'verified'; completion: VerifiedTask }
    | { kind: 'evidence'; inspection: EngineInspection };
};

type VerifiedTask = {
  task: TaskIdentity;
  revision: string;
  completion: 'local' | 'integrated';
  evidence: ArtifactRef;
};

type EngineResult = {
  invocationId: string;
  outcome: 'drained' | 'target-completed' | 'blocked' | 'cancelled';
  activeTask: TaskIdentity | null;
  verified: readonly VerifiedTask[];
  fault: Fault | null;
  shutdown: Shutdown;
  continuation: ArtifactRef | null;
  report: ArtifactRef | null;
};

type EngineInspection = {
  invocationId: string;
  state: 'unknown' | 'active' | 'terminal' | 'interrupted';
  activeTask: TaskIdentity | null;
  verified: readonly VerifiedTask[];
  continuation: ArtifactRef | null;
  report: ArtifactRef | null;
  evidence: readonly ArtifactRef[];
};
```

These types describe the outer TaskEngine interface. Task selection, task reports and artifact
references do not become ExecutionRunner concepts. Construction binds the request to the configured
workflow and actions. Task-specific events and reports come from actions and their persisted data;
the runner supplies state transitions and its terminal result.

`run` admits at most one invocation per instance and one writer per task/workspace. An invocation
ID cannot describe different input. Resume an interrupted workflow at its last persisted state;
the action for that state starts anew. A persisted terminal state returns its result without running
another action. Invalid input returns blocked with an input fault and no new task effects.

`drained` is valid only for queue selection after a successful fresh empty read. Watch waits on an
empty read and exits through cancellation or a fault. `target-completed` is valid only for the exact
selected ticket or local file. A missing, invalid or ineligible target is blocked unless its completion
can be verified through the configured completion gates. It is never equivalent to an empty queue.

`verified` contains this invocation's confirmed completions, with source identity preserved. It
is also retained durably as each completion is established. Callers aggregate by source and stable
task ID, not by display key or event count. `local` means the configured local checks passed; it
does not imply publication or a source transition. `integrated` requires every configured integration
gate. A blocked outcome has a fault; a cancelled outcome requires confirmed shutdown. Unconfirmed
shutdown is blocked. A report is null only before admission or after a persistence failure.

`inspect` is a read-only public export available in the parent-side provider even when a work
process died. It reads only this component's records, makes no task mutations and launches no work.
It exports the last durable evidence and continuation, including when there is no final report.
Interrupted means process death was established; otherwise an unfinished record remains active.
Absent records return unknown with empty evidence, never invented success. Corrupt records return
a fault. Inspection is a snapshot, not permission to write or proof that every descendant stopped.

A continuation is an opaque reference to retained execution storage, including the workflow checkpoint
and action artifacts. Construction reconnects these locations; the runner reads only its checkpoint.
A caller temporarily running a different target uses separate storage and retains the original
continuation for return. It does not rewrite the original workflow state.

### Required interfaces

| Port | Provider contract | Use |
| --- | --- | --- |
| Agent execution | [AgentRuntime.run](agent-runtime.md#provided-interface) | Profile ID, WorkspaceRef, AdditionalContext and AgentResult |
| Task source | [Jira](adapters.md#jira) | Read source documents and ordering; conditionally update task state, fields and reports |
| Repository | [Git](adapters.md#git) | Observe and prepare revisions/workspaces; publish an observed branch |
| Delivery | [GitHub](adapters.md#github) | Publish and observe pull requests, review, checks and integration |
| Commands | [Processes](adapters.md#processes) | Run configured setup/check commands with owned shutdown and captured evidence |

Dependencies are supplied to actions at construction; ExecutionRunner receives none of these ports.
Local task files are an owned input format. Actions normalize source documents, construct role inputs
and verify role claims against observed evidence. No presentation or supervisor dependency is required.
An agent-backed action calls run(profile, workspaceRef, additionalContext). The action reads the
artifacts it needs and supplies invocation instructions/context directly. The runtime does not read
an action request from the workspace. Actions without agent work do not receive AgentRuntime.

## ExecutionRunner

The runner understands state names, action names, outcomes and transitions. Its execution loop is:

1. Read the persisted state, or persist the workflow's initial state for a new execution.
2. If the state is terminal, return its declared result.
3. Invoke the action bound to that state.
4. Select the next state using the action's returned outcome and the YAML transition table.
5. Atomically persist the next state, then continue.

The checkpoint records the state to execute next. If execution crashes before the checkpoint advances,
the same action starts again. If it crashes after the checkpoint advances, the next action starts.
This is at-least-once action execution. There is no separate uncertain-action reconciliation phase
inside the runner.

The runner owns only its workflow checkpoint. It does not inspect, validate, route or copy action
artifacts; allocate their storage; decide repair policy; or discover and reconcile external effects.
Its bound action functions require no execution identity or storage scope from the runner.

Before starting, validate the YAML structure, initial state, referenced transitions and action bindings.
An undeclared outcome, action exception or checkpoint failure stops execution with a fault. The runner
does not invent a transition or retry policy. Cancellation is forwarded to the active action and stops
further dispatch; completed outcomes are checkpointed before returning. An action that exits without
a completed outcome leaves the checkpoint unchanged. Actions own stopping their work and reporting it.

## Workflow definition

A workflow declares named states, one action per nonterminal state, transitions selected by outcomes,
and terminal results. Loops and branches are explicit transitions. Business decisions are typed actions;
YAML does not contain scripts, arbitrary expressions or artifact input/output mappings.

The finite delivery workflow is:

```yaml
name: finite-delivery
initial: select

states:
  select:
    action: SelectTask
    on: { selected: prepare, empty: finished, failed: blocked }
  prepare:
    action: PrepareWorkspace
    on: { prepared: develop, failed: blocked }
  develop:
    action: Develop
    on: { completed: verify, failed: blocked }
  verify:
    action: Verify
    on: { passed: deliver, failed: repair }
  deliver:
    action: Deliver
    on: { published: review, failed: blocked }
  review:
    action: Review
    on: { approved: complete, changesRequested: repair, inconclusive: blocked }
  repair:
    action: SelectRepair
    on: { selected: develop, exhausted: blocked }
  complete:
    action: CompleteTask
    on: { completed: select, failed: blocked }
  finished:
    terminal: drained
  blocked:
    terminal: blocked
```

After completion, the transition back to select supplies queue coordination. The repair transitions
supply review/check coordination. There are no additional coordinators choosing the next action.
Other workflows can reuse these actions: single-task execution ends after completion, while watch
adds waiting and another selection when the source is empty. Waiting is an action, not runner policy.

Workflow definitions are retained with their checkpoints so a restart uses the same definition.
Adopting a changed definition for retained state is an explicit operation, never an implicit reinterpretation
of a checkpoint. Required task checks and completion evidence remain action contracts.

## Actions

An action is a bound typed function. Its runner-facing result is a named outcome declared by the
workflow. Detailed outputs are not routed through ExecutionRunner.

Actions do not call the next action or select its state. The workflow defines all sequencing. An action
can execute again after interruption; the runner supplies no deduplication or transaction guarantee.

## Persistent artifacts

Artifacts are the durable inputs and outputs of actions. Their locations, formats and meanings are
action data contracts. Workflow definitions contain no artifact mappings, and ExecutionRunner does
not interpret those contracts.

An action finishes writing its output artifacts before returning its outcome. Only then does the runner
persist the next state. A crash can leave outputs without an advanced checkpoint; the action starts
anew and decides whether to reuse those outputs. Atomic checkpoint replacement does not imply an
atomic transaction over the action's files or external effects.

ExecutionRunner persists only control state. It neither maintains conversation history nor assembles
agent context.
