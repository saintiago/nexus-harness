# Nexus high-level architecture

## Composition

Nexus consists of five logical components: OperatorInterface, Supervisor, TaskEngine,
AgentRuntime and Adapters. Each has a public contract and can be designed, implemented and tested
independently against it.

```text
Nexus
├── OperatorInterface
│   ├── Commands and launch shortcuts
│   ├── Project configuration filepath input
│   └── Progress and result presentation
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

Supervisor is the parent of the Nexus worker process. Worker startup constructs TaskEngine and its
dependencies. Actions use AgentRuntime for development/review; Supervisor uses it for recovery.
Adapters are modules at external boundaries, not a registry or additional service.

Workspace and configuration are data designs. Workspace defines a fixed directory hierarchy and a
reference to an instance.

## Configuration and startup

Project configuration lives in the target project's root. It defines repository source/base,
preparation and CI/check commands, task source and delivery requirements. Nexus configuration owns
workflows, workspace storage, profiles, runtime instructions and operational policy.

```text
Supervisor(projectConfigPath)
    → Nexus worker(projectConfigPath)
        → read project configuration and Nexus configuration
        → construct components and actions with their relevant settings
        → execute the Nexus-configured workflow
```

Supervisor retains and forwards the project filepath on restart. Its recovery settings are available
before child startup. Worker startup reads both configurations and validates the selected workflow.
Relative paths resolve against their owning configuration file's directory.

| Consumer | Inputs |
| --- | --- |
| TaskEngine / ExecutionRunner | Selected workflow, bound actions and workflow-state filepath |
| PrepareWorkspace | WorkspaceRef and project repository settings |
| Verify | Project CI/check definitions and WorkspaceRef |
| AgentRuntime | Nexus profiles, instructions, tool/provider settings, limits and activity observer |
| Agent-backed actions | AgentRuntime capability, profile selection and WorkspaceRef |
| Source/delivery actions | Relevant project settings and adapter capabilities |
| Supervisor | Lifecycle/recovery settings and projectConfigPath |

Startup supplies each component with the values and capabilities it needs. Project commands run
in the prepared worktree. Credential references resolve through host settings; secret values do not
become agent context.

TaskEngine exposes run() and subscribe(listener). Source and remote repository settings are bound
to the relevant actions. Restart reconnects the saved workflow state and action storage.

Agent-backed actions call AgentRuntime.run(profile, workspaceRef, additionalContext). The action
reads the artifacts it needs and supplies context. The runtime combines this with its base/profile
instructions. Other actions receive only the capabilities they use.

## Simplicity

Use the smallest design that satisfies an explicit requirement or solves a demonstrated problem.
Every contract field, abstraction, validation rule and persistent record must serve a concrete need.
Hypothetical failures and possible future extensions alone do not justify additional mechanisms.

Account for the full cost of a design choice: implementation, validation, failure handling, persistence,
tests, documentation and maintenance. A small field can create obligations across many components.
Requirements justify mechanisms; mechanisms do not create their own requirements.

Keep specialized guarantees within the component or action that needs them. Shared contracts contain
only what their consumers require. When a mechanism is unnecessary, remove its dependent validation,
state and tests as well. Prefer removing the obligation to building machinery around it.

Persisted workflow state is the checkpoint. Save and load it directly. The current design requires
neither a separate checkpoint subsystem nor a filesystem transaction protocol. A future database
does not require a storage framework now.

Execution is sequential: an action finishes before the next starts, and recovery runs after the work
invocation ends. Cancellation and coordination between multiple writers are not current features.

## Low coupling and high cohesion

Each component owns a focused responsibility, its state and the behavior needed to fulfill it.
Closely related decisions stay within that boundary.

Components depend only on public contracts. Each contract has one authoritative definition, owned
by its provider; consumers reference it. Internal changes must not require consumer changes while
the public contract remains compatible. Routine coordinated redesign indicates a boundary problem.

Each component architecture is independent. Its interface section is the only place that names other
components, imports their contracts or defines interaction with them. Its internal design uses its
own responsibilities and state. System composition and flows are defined here.

OperatorInterface depends on Supervisor's execution contract. Supervisor runs TaskEngine without
knowing its internal orchestration. It forwards producer events unchanged and adds its own lifecycle
events; presentation interprets events for display.

Contract tests verify individual boundaries. Integration and workflow tests verify cooperation.
A multi-component flow does not create a special shared contract.

## Component responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| OperatorInterface | Commands, configuration filepath input and presentation | Queue decisions, agent execution or recovery policy |
| Supervisor | Work process lifecycle, execution intent and recovery decisions supplied by the agent | Task phases or judging the adequacy of a recovery repair |
| TaskEngine | Sequential workflow execution, bound actions, persisted state and event subscriptions | Interpreting action artifacts or operational recovery policy |
| AgentRuntime | Profiles, prompt assembly, invocation and output collection | Business output schemas, task selection or declaring completion |
| Adapters | External protocols, authentication and observed results | Business lifecycle or recovery decisions |

ExecutionRunner follows XState workflow definitions. Actions perform task-specific operations and
exchange persistent artifacts through their contracts. Startup binds dependencies and storage.
The runner has no knowledge of artifact contents or task semantics.

Profile permissions are configured independently. Recovery can investigate and repair operational
state through its authorized tools. Sharing a runtime does not give development/review profiles
recovery permissions. Agent reports do not replace checks required for completion.

## Relationships and contracts

| Caller or producer | Receiver | Contract boundary |
| --- | --- | --- |
| OperatorInterface | Supervisor | Execute with project filepath, mode and target |
| Supervisor | Nexus worker / TaskEngine | Launch configured workflow and receive events/result |
| Supervisor | OperatorInterface | Forwarded events, lifecycle events and final result |
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

Worker startup receives the project filepath, mode and target as arguments. The worker sends
newline-delimited JSON records on stdout: { kind: 'event', event } or { kind: 'result', result }.
Diagnostics use stderr. The parent forwards events and waits for the final result and process exit.

A failed exit, missing result or invalid result is an execution failure. The bridge carries records
and process outcomes; it does not evaluate task or recovery policy. Terminal text is not a control
protocol.

Startup binds the actions and event publisher before calling TaskEngine.run(). Any action and the
runner can emit events. TaskEngine forwards them without interpreting payloads.

## Finite Run

Finite Run processes eligible work serially until a fresh source inspection finds no eligible tasks.
It does not reserve a fixed batch at startup.

1. OperatorInterface sends Supervisor the project filepath and finite mode.
2. Supervisor starts the worker; startup reads configuration and constructs the selected workflow.
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

Watch and single-ticket modes use the same components with their configured workflows.

## Verification boundaries

Cover component contracts with contract tests using controlled dependencies. Verify real provider
behavior and caller handling of defined outcomes; schema checks alone do not establish behavior.

Use unit tests for internal decisions, focused integration tests for process, persistence and external
protocol boundaries, and a small number of complete workflows for composition. Do not repeat the same
behavioral matrix at every layer or start all Nexus for every contract test.

Allocate requirements to components and interactions. The verification inventory links those
requirements to tests; component architecture defines the design.
