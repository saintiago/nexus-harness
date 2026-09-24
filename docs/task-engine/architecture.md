# TaskEngine

## Responsibility

Execute a task workflow supplied as an XState definition. The workflow defines sequencing, ordinary functions perform
the actions, and persistent artifacts carry data between actions. Finite delivery uses sequential
states; idea refinement uses independent parallel regions.

The public module is `src/task-engine/index.ts`. Its construction inputs are a workflow, an action
binding that receives the engine's EventPublisher and produces the bound action implementations,
and a workflow-state filepath.

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
    ├── Deliver
    └── CompleteTask
    └── Idea refinement actions (see specification)
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
At run startup, reset a persisted terminal state to the workflow's initial state. Restore a nonterminal
state. Reaching a terminal state during this run still returns its outcome and ends the run.

subscribe registers a listener for subsequent events and returns a function that removes that
listener. The runner and every action receive the same EventPublisher capability during construction.
TaskEngine forwards emitted events without interpreting or rewriting their payloads. Producers own
event types and data contracts; there is no fixed enumeration of task phases in this interface.
Event data is JSON-serializable for transport across the process boundary.
Actions share the [action outcome contract](#action-outcome-events) for the durable output each one
saves.

Subscriptions provide observation only. They do not replay history, recover artifacts or drive
workflow transitions. Removing a listener does not stop execution. Listener failures are isolated
from actions and other listeners.

### Agent activity events

The caller assigns each AgentRuntime invocation a role name, unique invocation ID and Unix
start time in milliseconds. The same contract applies to one or several concurrent invocations,
including recovery. Transported activity carries that identity so simultaneous roles remain
attributable. The Application logger writes complete timestamped activity to one JSONL file per
invocation. The main execution stream contains:

| Type | Data |
| --- | --- |
| agent-started | `{ agentName, invocationId, startedAtUnixMs, operation, profile, task?, log: ArtifactRef }` |
| agent-finished | `{ agentName, invocationId, startedAtUnixMs, log: ArtifactRef, result }` |

The log path includes the agent name, Unix start time and invocation ID. Agent messages and tool
activity are absent from the main durable event file; they use the per-invocation activity channel
for logging and live presentation. A finished event means the invocation ended, including failure,
and never declares task success. [Application](../application.md#execution-log) owns storage; the
[OperatorInterface](../operator-interface.md#agent-activity-pane) owns rendering.

### Action outcome events

The following fields describe finite delivery action outcomes. Idea refinement actions
preserve the same saved-artifact reference principle while using an idea key, cycle and brief
revision where relevant, as defined in its specification.

An action publishes one outcome event after it finishes writing the durable output for the outcome it
returns. Its type is `outcome`, its source is the producing action, and its data is:

| Field | Meaning |
| --- | --- |
| task | The selected task key the action worked on |
| round | The round whose record or directory holds the output, or null when the action runs before a round exists |
| outcome | The action's returned workflow outcome |
| detail | One short producer-owned phrase naming the useful fact the operator needs, such as branch, profile, check count or pull request, or null when the outcome adds none |
| artifact | An [ArtifactRef](../high-level-architecture.md#shared-interface-vocabulary) to the saved file |

The reference names the file the action saved for that outcome. An invocation that reuses an earlier
saved output publishes the same truthful reference; no action names a file it did not save. Outcomes
that save no output, such as selection finding no candidate or a repository condition preventing
preparation, publish no outcome event: the existing failed and exhausted events keep carrying their
reasons. Producers own the detail text; the runner forwards outcome events unchanged and reads no
artifact.

### Construction

The workflow, bound actions and workflow-state filepath are supplied before run.
Source and remote repository settings are supplied to the actions that use them, together with the
workspace reference and other required capabilities. They are not repeated in a run request.

For queue execution, actions read the current selection from a shared selection-file location bound
at startup. That record supplies the current ticket's workspace. The runner state filepath remains
fixed for the queue; switching tickets does not make the runner interpret task data or change files.
Workflow state belongs to the queue execution directory, outside individual task workspaces.
Bootstrap record ownership and round/history reads follow the general action contract.

One instance executes one workflow at a time. Restart reconnects the same workflow state and action
storage, then calls run again.

### Required interfaces

| Port | Provider contract | Use |
| --- | --- | --- |
| Agent execution | [AgentRuntime.run](../agent-runtime/architecture.md#provided-interface) | Profile ID, WorkspaceRef, context text and AgentResult |
| Work source | Configured source adapter; [Jira](../adapters/jira.md#interface) for HARN | Select and read tickets or ideas; publish feedback and update their state |
| Repository | [Git](../adapters/git.md#interface) | Read repository state and perform Git operations selected by actions |
| Delivery | [GitHub](../adapters/github.md#interface) | Publish and observe pull requests, review, checks and integration |
| Commands | [Processes](../adapters/processes.md#interface) | Run configured setup/check commands and return exit codes and output |

Dependencies are supplied to actions at construction; ExecutionRunner receives none of these ports.
Actions read task details and locally saved conversation, construct role inputs
and verify role claims against observed evidence. No presentation or Application dependency is required.
An agent-backed action calls run(profile, workspaceRef, additionalContext). The action reads the
artifacts it needs and supplies invocation instructions/context directly. The runtime does not read
an action request from the workspace. Actions without agent work do not receive AgentRuntime.

## ExecutionRunner

XState executes the state machine. The runner binds operations, saves/restores execution state and
publishes progress. Subscription-driven saves run in order without gating actions. The runner waits
for the terminal save before returning the outcome. Detailed behavior belongs to its own design.

## Workflow definition

A workflow is an XState machine definition with named states, invoked operations in sequential or
parallel states, outcome transitions and terminal results. Business operations and artifact handling
remain outside the definition.

Sequential states name an action and map its returned outcomes to the next state. A terminal state
declares the workflow result. For example, this state routes verification outcomes:

```ts
verify: {
  invoke: {
    src: 'Verify',
    onDone: [
      { guard: ({ event }) => event.output === 'passed', target: 'deliver' },
      { guard: ({ event }) => event.output === 'failed', target: 'startRound' },
      { actions: 'unexpectedOutcome' },
    ],
  },
}
```

The complete finite workflow is defined in [finite-delivery.ts](../../workflows/finite-delivery.ts).
Queue loops, round and repair loops and waits are workflow choices; the runner only follows
transitions. The [idea refinement workflow](../idea-refinement/spec.md) expresses parallel
regions, joins, verdict precedence and bounded correction loops in XState; operations retain their
artifact and source-update responsibilities.

The finite workflow routes the initial prepared workspace and failed Develop, failed Verify
and changesRequested Review to StartRound. StartRound returns started for another round or exhausted
for the blocked terminal state. Approved Review still routes to CompleteTask; inconclusive Review
routes directly to blocked, and operational errors remain execution errors rather than repairs. The
reviewer profile is selected by Review and is separate from the developer profile selected by
StartRound.

Nexus registers its operations as promise actors. XState invokes them and follows the declared
outcome transitions. Unexpected outcomes and rejected operations are execution faults.

The definition can be opened in Stately's visual editor. Git stores the authoritative definition;
visualization does not require a separately maintained workflow. State persistence remains the
runner's responsibility.

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
