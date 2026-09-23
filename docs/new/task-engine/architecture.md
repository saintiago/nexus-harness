# TaskEngine

## Responsibility

Execute a task workflow supplied as an XState definition. The workflow defines sequencing, ordinary functions perform
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
    ├── StartRound
    ├── Develop
    ├── Verify
    ├── Review
    ├── SelectRepair
    ├── Deliver
    └── CompleteTask
```

ExecutionRunner is the core: a thin XState integration that executes the supplied workflow.
Actions own task-specific behavior. Workflow definitions are executable input, not another coordinator.

## Interface

Use the [shared value types](../high-level-architecture.md#shared-interface-vocabulary).
Action structure and artifact interfaces follow the [general action design](actions/architecture.md).
Execution uses the [ExecutionRunner interface](execution-runner.md#interface).
Actions use the [workspace data contract](../workspace.md#layout-and-reference). Workflow settings
conform to [Nexus configuration](../configuration.md#nexus-configuration); repository and
command settings conform to [project configuration](../configuration.md#project-configuration).

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
| Agent execution | [AgentRuntime.run](../agent-runtime.md#provided-interface) | Profile ID, WorkspaceRef, AdditionalContext and AgentResult |
| Task source | [Jira](../adapters.md#jira) | Read source documents and ordering; update task state, fields and reports |
| Repository | [Git](../adapters.md#git) | Read repository state and perform Git operations selected by actions |
| Delivery | [GitHub](../adapters.md#github) | Publish and observe pull requests, review, checks and integration |
| Commands | [Processes](../adapters.md#processes) | Run configured setup/check commands and return exit codes and output |

Dependencies are supplied to actions at construction; ExecutionRunner receives none of these ports.
Local task files are an owned input format. Actions normalize source documents, construct role inputs
and verify role claims against observed evidence. No presentation or supervisor dependency is required.
An agent-backed action calls run(profile, workspaceRef, additionalContext). The action reads the
artifacts it needs and supplies invocation instructions/context directly. The runtime does not read
an action request from the workspace. Actions without agent work do not receive AgentRuntime.

## ExecutionRunner

XState executes the state machine. The runner binds operations, saves/restores execution state and
publishes progress. Subscription-driven saves run in order without gating actions. The runner waits
for the terminal save before returning the outcome. Detailed behavior belongs to its own design.

## Workflow definition

A workflow is an XState machine definition with named states, one invoked operation per nonterminal
state, transitions selected by outcomes and terminal results. Business operations and artifact handling
remain outside the definition.

Each state names an action and maps its returned outcomes to the next state. A terminal state
declares the workflow result. For example, this state routes verification outcomes:

```ts
verify: {
  invoke: {
    src: 'Verify',
    onDone: [
      { guard: ({ event }) => event.output === 'passed', target: 'deliver' },
      { guard: ({ event }) => event.output === 'failed', target: 'repair' },
      { actions: 'unexpectedOutcome' },
    ],
  },
}
```

The complete finite workflow is defined in [finite-delivery.ts](../../../workflows/finite-delivery.ts).
Queue loops, repair loops and waits are workflow choices; the runner only follows transitions.

Nexus registers its operations as promise actors. XState invokes them and follows the declared
outcome transitions. Unexpected outcomes and rejected operations are execution faults.

The definition can be opened in Stately's visual editor. Git stores the authoritative definition;
visualization does not require a separately maintained workflow. This definition is not yet
connected to the existing Nexus runtime. State persistence remains the runner's responsibility.

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

An action finishes writing its output artifacts before returning its outcome. XState then transitions;
the runner saves its state through a subscription. Saves can lag execution, so a crash can cause
completed actions to run again. Each action decides whether to reuse existing outputs.

ExecutionRunner persists only control state. It neither maintains conversation history nor assembles
agent context.
