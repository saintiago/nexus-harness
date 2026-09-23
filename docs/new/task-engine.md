# TaskEngine

Status: proposed component design.

## Responsibility

Execute a task workflow supplied as YAML. The workflow defines sequencing, ordinary functions perform
the actions, and persistent artifacts carry data between actions. Process one action at a time.

The public module is `src/task-engine/index.ts`. Its construction inputs are a workflow, bound action
implementations and a workflow-state filepath.

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
Action structure and artifact interfaces follow the [general action design](task-engine/actions/architecture.md).
Actions use the [workspace data contract](workspace.md#layout-and-reference). Workflow settings
conform to [Nexus configuration](configuration.md#nexus-configuration); repository and
command settings conform to [project configuration](configuration.md#project-configuration).

### Provided interface

```ts
interface TaskEngine {
  run(): Promise<WorkflowResult>;
  subscribe(listener: EventListener): Unsubscribe;
}

type WorkflowResult = Result<string>;

type EngineEvent = {
  source: string;
  type: string;
  data: unknown;
};

type EventListener = (event: EngineEvent) => void;
type Unsubscribe = () => void;
type EventPublisher = (event: EngineEvent) => void;
```

run executes the configured workflow from the persisted state. A terminal state returns its declared
outcome as the result value. Execution failure returns a fault. These are execution outcomes, not
task reports or completion inventories.
A persisted terminal state returns its outcome without executing another action.

subscribe registers a listener for subsequent events and returns a function that removes that
listener. The runner and every action receive the same EventPublisher capability during construction.
TaskEngine forwards emitted events without interpreting or rewriting their payloads. Producers own
event types and data contracts; there is no fixed enumeration of task phases in this interface.
Event data is JSON-serializable for transport across the process boundary.

Subscriptions provide observation only. They do not replay history, recover artifacts or drive
workflow transitions. Removing a listener does not stop execution. Listener failures are isolated
from actions and other listeners.

### Construction

The workflow, bound actions and workflow-state filepath are supplied before run.
Source and remote repository settings are supplied to the actions that use them, together with the
workspace reference and other required capabilities. They are not repeated in a run request.

One instance executes one workflow at a time. Restart reconnects the same workflow state and action
storage, then calls run again.

### Required interfaces

| Port | Provider contract | Use |
| --- | --- | --- |
| Agent execution | [AgentRuntime.run](agent-runtime.md#provided-interface) | Profile ID, WorkspaceRef, AdditionalContext and AgentResult |
| Task source | [Jira](adapters.md#jira) | Read source documents and ordering; update task state, fields and reports |
| Repository | [Git](adapters.md#git) | Observe and prepare revisions/workspaces; publish an observed branch |
| Delivery | [GitHub](adapters.md#github) | Publish and observe pull requests, review, checks and integration |
| Commands | [Processes](adapters.md#processes) | Run configured setup/check commands and return exit codes and output |

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
5. Persist the next state, then continue.

The persisted state names the action to execute next. On restart, load the last successfully saved
state and start that action anew. An unreadable state is a storage failure; the runner does not guess
where to resume.

The runner owns only its workflow state. It does not inspect, validate, route or copy action
artifacts; allocate their storage; decide repair policy; or discover and reconcile external effects.
Its bound action functions require no execution identity or storage scope from the runner.
An action completes its work before returning; the runner awaits it before invoking another.

Before starting, validate the YAML structure, initial state, referenced transitions and action bindings.
An undeclared outcome, action exception or state read/write failure stops execution with a fault. The runner
does not invent a transition or retry policy. An action that fails without an outcome leaves the
persisted state unchanged.

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

Restart loads the supplied workflow and its saved state. A saved state absent from that workflow is
an input error. Required task checks and completion evidence remain action contracts.

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
persist the next state. A crash can leave outputs without an advanced workflow state; the action starts
anew and decides whether to reuse those outputs.

ExecutionRunner persists only control state. It neither maintains conversation history nor assembles
agent context.
