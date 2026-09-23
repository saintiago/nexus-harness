# Nexus high-level architecture

## Composition

Nexus consists of Application, OperatorInterface, Supervisor, TaskEngine, AgentRuntime and Adapters. Each has a public contract and can be designed, implemented and tested
independently against it.

```text
Nexus
├── Application
│   ├── Commands and configuration loading
│   └── Parent and worker component wiring
├── OperatorInterface
│   ├── Event subscriptions
│   └── Progress, activity pane and result presentation
├── Supervisor
│   ├── TaskEngine process lifecycle
│   └── Recovery coordination
├── TaskEngine
│   ├── ExecutionRunner
│   └── Actions
│       ├── SelectTask
│       ├── PrepareWorkspace
│       ├── StartRound
│       ├── Develop
│       ├── Verify
│       ├── Review
│       ├── SelectRepair
│       ├── Deliver
│       └── CompleteTask
├── AgentRuntime
│   ├── Profile catalogue and instructions
│   └── Agent execution
└── Adapters
    ├── Jira
    ├── GitHub
    ├── Git
    ├── Processes
    ├── Coding runtime
    └── Notifications
```

Supervisor is the parent of the Nexus worker process. Application constructs TaskEngine and its
dependencies in the worker. Actions use AgentRuntime for development/review; Supervisor uses it for recovery.
Adapters are modules at external boundaries, not a registry or additional service.

Workspace and configuration are data designs. Workspace defines a fixed directory hierarchy and a
reference to an instance.

## Application and configuration

[Application](application.md) owns the command entry point, configuration loading, component wiring
and process exit. It connects presentation before starting supervised execution.

Project configuration defines the target project. Nexus configuration defines the workflow, storage,
profiles and operational policy. Their settings and path rules are defined in
[Configuration](configuration.md).

```text
Application: parent entry
    → connect OperatorInterface to Supervisor events
    → Supervisor.execute(projectConfigPath)
        → Application: worker entry
            → load configurations and workflow
            → construct actions and TaskEngine
            → TaskEngine.run()
```

Supervisor retains the execution request and launches the worker again when recovery requests it.
Each launch reconnects retained workflow state and action storage. Application supplies relevant
settings and capabilities; it does not make workflow or recovery decisions.

## Execution model

Persisted workflow state is the checkpoint. Save and load it directly. The current design requires
neither a separate checkpoint subsystem nor a filesystem transaction protocol. A future database
does not require a storage framework now.

Execution is sequential: an action finishes before the next starts, and recovery runs after the work
invocation ends. Cancellation and coordination between multiple writers are not current features.

## Component responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Application | Commands, configuration loading, component wiring and process exit | Workflow decisions, recovery policy or task artifacts |
| OperatorInterface | Event subscriptions, display state and terminal presentation | Commands, execution startup, queue decisions or recovery policy |
| Supervisor | Work process lifecycle, execution intent and recovery decisions supplied by the agent | Task phases or judging the adequacy of a recovery repair |
| TaskEngine | Sequential workflow execution, bound actions, persisted state and event subscriptions | Interpreting action artifacts or operational recovery policy |
| AgentRuntime | Profiles, prompt assembly, invocation and output collection | Business output schemas, task selection or declaring completion |
| Adapters | External protocols, authentication and observed results | Business lifecycle or recovery decisions |

ExecutionRunner follows XState workflow definitions. Actions perform task-specific operations and
exchange persistent artifacts through their contracts. Application binds dependencies and storage.
The runner has no knowledge of artifact contents or task semantics.

Profile permissions are configured independently. Recovery can investigate and repair operational
state through its authorized tools. Sharing a runtime does not give development/review profiles
recovery permissions. Agent reports do not replace checks required for completion.

## Relationships and contracts

OperatorInterface observes events; it does not call execution methods. Application wires its subscriptions
and starts Supervisor. Supervisor runs TaskEngine without knowing its internal orchestration.
It forwards producer events unchanged and adds its own lifecycle events. This combined stream carries
both components' events to presentation without duplicate subscriptions.

| Caller or producer | Receiver | Contract boundary |
| --- | --- | --- |
| Application | Supervisor | Execute the finite queue with project filepath |
| Supervisor | Nexus worker / TaskEngine | Launch configured workflow and receive events/result |
| TaskEngine, through Supervisor | OperatorInterface | Unchanged worker event stream |
| Supervisor | OperatorInterface | Lifecycle events, including the final execution result |
| TaskEngine actions | AgentRuntime | run(profile, workspaceRef, additionalContext) |
| Supervisor | AgentRuntime | Same run interface with recovery profile and failure context |
| AgentRuntime | Caller | Agent output, activity and invocation result |
| Actions and authorized tools | Adapters | Explicit external operations and their results |
| AgentRuntime | Coding runtime adapter | Prompt, provider settings and invocation output |
| Supervisor | Notification adapter | Recovery report and publication result |

### Shared interface vocabulary

These are boundary values, not a shared service. Identifiers are opaque strings; paths are absolute;
timestamps are UTC ISO 8601 and durations state their unit.

```ts
type ArtifactRef = { path: string };

type Fault = { message: string };

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; fault: Fault };

type Observer<E> = (event: E) => void;
```

ArtifactRef identifies a persisted artifact. Content format belongs to its owning data contract.
Expected boundary failures return a fault with a useful message excluding secrets. A failure does
not promise that external effects were rolled back. Ordinary negative outcomes, such as failed
checks, are domain results interpreted by the caller.

Events report progress. They do not drive workflow transitions or replace returned results.
Observer errors do not change execution decisions.

### Process boundary

The [Application worker protocol](application.md#worker-entry-point) carries events and the final
workflow result to the parent. Supervisor observes these alongside process exit. A failed exit,
missing result or invalid result is an execution failure. Terminal text is not a control protocol.

Application connects event publishing before execution. TaskEngine forwards events unchanged;
Supervisor forwards them and emits its own lifecycle events. OperatorInterface presents the stream.

## Finite Run

Finite Run processes eligible work serially until a fresh source inspection finds no eligible tasks.
It does not reserve a fixed batch at startup.

1. Application connects presentation to events and sends Supervisor the project filepath.
2. Supervisor starts the worker; Application reads configuration and constructs the selected workflow.
3. TaskEngine executes selection, implementation, repair, review, delivery and completion actions
   according to the workflow, then selects again.
4. Supervisor forwards progress and adds lifecycle events for OperatorInterface to display.
5. The empty queue produces a drained result; the worker exits and the result is presented.

A source failure is not an empty queue. Ordinary failed checks and review findings follow the
workflow's repair and escalation decisions.

When work cannot continue, Supervisor invokes recovery with the failure and available context.
Recovery investigates, performs repairs and decides whether to resume, run a blocker first or request
operator attention. Supervisor applies that decision within its configured recovery allowance.
Required task checks and completion gates still belong to the normal actions.

The defined workflow includes development, verification, delivery, review and completion.
