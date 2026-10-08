# Nexus high-level architecture

## Composition

Nexus consists of Application, OperatorInterface, TaskEngine, AgentRuntime, Memory and Adapters. Each has a
public contract and can be designed, implemented and tested independently against it.

```text
Nexus
├── Application
│   ├── Commands and configuration loading
│   ├── Parent and worker component wiring
│   └── Worker lifecycle and recovery
├── OperatorInterface
│   ├── Event subscriptions
│   └── Progress, activity pane and result presentation
├── TaskEngine
│   ├── ExecutionRunner
│   └── Actions
│       ├── SelectWork
│       ├── PrepareWorkspace
│       ├── StartDevRound
│       ├── Develop
│       ├── Verify
│       ├── Review
│       ├── Deliver
│       ├── CompleteTask
│       ├── StartIdeaRound
│       ├── Idea editing
│       ├── Research and project guidance
│       ├── Idea challenge and response
│       └── Decision publication
├── AgentRuntime
│   ├── Profile catalogue and instructions
│   └── Agent execution
├── Memory
│   ├── Retrieval context and evidence
│   └── Hand-off ingestion and receipts
└── Adapters
    ├── Jira
    ├── GitHub
    ├── Git
    ├── Processes
    ├── Coding runtime
    └── Notifications
```

Application is the parent of the Nexus worker process. Application constructs TaskEngine and its
dependencies in the worker. Actions use AgentRuntime for delivery, idea refinement and preparation roles; Application uses it for recovery.
Adapters are modules at external boundaries, not a registry or additional service.

Workspace and configuration are data designs. One issue workspace retains artifacts across
workflows. Repository WorkspaceRef and artifact ownership are separate. Preparation stages share one
checkout and branch while retaining stage areas. The first implementation uses that repository
reference with its own issue's delivery artifacts; later implementations use the merged base.
Later workflows can read immutable retained artifacts from the preparation issue root.

[Memory](memory/architecture.md) supplies optional historical experience. Application composes the
shared service client and configures the [AMEM MCP tools](memory/integration.md#agent-use) agents
use explicitly, including every preparation author/evaluator. AnalyzeExperience is the sole automatic
consumer after selected-work terminal handoffs.
Workflow routing, direct hand-offs and authoritative artifacts remain unchanged.

[JEv](tech-stack.md#jev-dependency) is an optional repository discovery dependency, not another Nexus
component. Application composes provider-native `search_repo` and `inspect_files` access for every agent role from the host
credential and the optional host logging settings. AgentRuntime transports the native tool settings
and guidance. The package owns repository discovery, whole-file screening, provider communication and local usage logging. Existing stage
routing and acceptance remain authoritative.

## Application and configuration

[Application](application.md) owns the command entry point, configuration loading, component wiring,
worker lifecycle, recovery and process exit. It connects presentation before starting execution.

Project configuration defines the target project. Nexus configuration defines the workflow, storage,
profiles and operational policy. Their settings and path rules are defined in
[Configuration](configuration.md).

```text
Application: parent entry
    → connect OperatorInterface to Application events
    → execute(projectConfigPath)
        → Application: worker entry
            → load configurations and workflow
            → construct actions and TaskEngine
            → TaskEngine.run()
```

Application retains the execution request and launches the worker again when recovery requests it.
Each launch reconnects queue execution state and action storage. Terminal workflow state resets at
startup; an active state resumes. Task workspaces contain no workflow snapshots. Application supplies relevant
settings and capabilities and applies recovery decisions. TaskEngine owns workflow execution;
RecoveryRole investigates failures and chooses how to recover.

## Execution model

Persisted workflow state is the checkpoint. Save and load it directly. The design requires
neither a separate checkpoint subsystem nor a filesystem transaction protocol.

The [project workflow](project-workflow.md) is the project-level XState parent. It selects one issue,
invokes the appropriate child and owns Jira input/publication. Children receive captured data and
artifacts without Jira dependencies. Finite delivery executes actions sequentially. The [idea refinement workflow](idea-refinement/spec.md)
uses XState parallel regions for research and project guidance, then joins before idea editing.
XState also routes editor/challenger exchanges. Each action owns separate artifacts.
Application-level recovery starts after the worker invocation ends. Cancellation and shared-writer
coordination are outside these workflows.

## Component responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Application | Commands, configuration loading, component wiring, worker lifecycle, recovery invocation and process exit | Task phases or judging the adequacy of a recovery repair |
| OperatorInterface | Event subscriptions, display state and terminal presentation | Commands, execution startup, queue decisions or recovery policy |
| TaskEngine | XState workflow execution, bound actions, persisted state and event subscriptions | Interpreting action artifacts or operational recovery policy |
| Memory | Service-backed search, observation submission and receipt inspection | Workflow decisions or the AMEM service's semantic memory and ingestion |
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
and starts the TaskEngine worker without knowing its internal orchestration.
It forwards producer events unchanged and adds its own lifecycle events. This combined stream carries
both components' events to presentation without duplicate subscriptions.

| Caller or producer | Receiver | Contract boundary |
| --- | --- | --- |
| Application | Nexus worker / TaskEngine | Launch configured workflow and receive events/result |
| TaskEngine, through Application | OperatorInterface | Unchanged worker event stream |
| TaskEngine, through Application | OperatorInterface | Attributable agent activity, matched to panes by invocation ID |
| Application | OperatorInterface | Lifecycle events, including the final execution result |
| TaskEngine actions | AgentRuntime | run(profile, workspaceRef, additionalContext) |
| Application | AgentRuntime | Same run interface with recovery profile and failure context |
| AgentRuntime | Caller | Agent output, activity and invocation result |
| Actions and authorized tools | Adapters | Explicit external operations and their results |
| AgentRuntime | Coding runtime adapter | Prompt, provider settings and invocation output |
| Application | Notification adapter | Recovery report and publication result |

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

The [Application worker protocol](application.md#worker-entry-point) carries events, attributable
agent activity and the final workflow result to the parent. Application observes these alongside
process exit. A failed exit, missing result or invalid result is an execution failure. Terminal text
is not a control protocol.

Application connects event publishing before execution. TaskEngine forwards events unchanged;
Application forwards them and emits its own lifecycle events. OperatorInterface presents the stream.

## Project run

The [project workflow](project-workflow.md) owns stage selection, cross-stage routing, source
publication and implementation-ticket creation. The queue command runs that parent. It processes
one issue at a time in source rank order until no eligible work remains. Fresh selection uses mapped
Jira status; interrupted execution restores the parent and active child snapshot.

Preparation children are Idea Refinement, Requirements, UX Proposal, Storybook Refinement and
Architecture. Each owns its agent loops and outputs. Architecture hands the original issue off to
linked implementation tickets. Finite Delivery runs for each selected implementation ticket and
publishes a separate PR for each, with committed preparation in the first. There is no combined
preparation-document review/assembly or preparation-only PR. Stage evaluators own their current
content/input decisions; upstream correction revisits affected decisions in the retained checkout.
Finite Delivery retains development, verification, delivery, review, repair and merge/check behavior. Parent-owned
boundary actors supply source refresh/publication acknowledgements where coding rounds need them.
The parent completes the implementation issue only after the child's merge/check evidence.

Source adapters belong to parent-owned actions. Application binds child machine actors and
operations; ExecutionRunner follows XState and persists the composed snapshot. Neither Application
nor a Jira watcher implements another coordinator.

Recovery remains project-scoped. It reconciles the parent selection, current child and producer-owned
evidence before resuming. Rank required blockers before interrupted implementation work and discard
only the broken delivery attempt, retaining preparation artifacts. Unexpected human source changes
are not overwritten. Recovery cannot weaken normal review/check gates. Cross-project repair and
Nexus installation changes require operator attention.

Idea Refinement retains its four-role conversation and concurrent Researcher/Project Guide join.
Its child receives captured author input and returns its decision. The parent publishes approval to
Draft and admits selected Draft work to Requirements. Waiting for Feedback retains the originating
stage and question. Delivery-only projects enter Finite Delivery through their ready mapping.
