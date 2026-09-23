# Nexus high-level architecture

Status: proposed target architecture. This composition guides the new design; it does not claim
that the existing implementation already has these boundaries or authorize a runtime migration.

## Composition

Nexus consists of five logical components: `OperatorInterface`, `Supervisor`, `TaskEngine`,
`AgentRuntime` and `Adapters`. These names are the architectural vocabulary. Each component has
an explicit public contract and can be designed, implemented and tested independently against it.

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

The five components are not five separately deployed services. Supervisor runs as the parent of
the Nexus worker process, whose startup constructs TaskEngine and its dependencies. AgentRuntime is
called by task actions for development/review and by Supervisor for recovery. Adapters are modules
used at external boundaries; there is no adapter registry or additional service implied by this grouping.

Workspace and configuration are data designs, not additional active components. WorkspaceLayout
defines the directory hierarchy; WorkspaceRef identifies a concrete instance. PrepareWorkspace
creates directories and the working copy at that reference using the supplied repository settings.

## Configuration and startup

Project configuration lives in the target project's root and describes repository source/base,
preparation and CI/check commands, task source and delivery requirements. Nexus configuration owns
workflow definitions, workspace layout/storage, profiles, runtime instructions and operational policy.

```text
Supervisor(projectConfigPath)
    → Nexus worker(projectConfigPath)
        → read project configuration and Nexus configuration
        → construct components and actions with their relevant settings
        → execute the Nexus-configured workflow
```

Supervisor retains and forwards the project filepath on restart. Its own recovery configuration is
available before child startup. The child loads both files; each component receives only the settings
it needs. ExecutionRunner does not load project configuration or interpret workspace layout.

Agent-backed actions call AgentRuntime.run(profile, workspaceRef, additionalContext). They select
and read task artifacts and prepare the additional instructions/context. AgentRuntime combines these
arguments with its configured base/profile instructions and executes the agent. It does not discover
or read an action request file. Other actions receive only the capabilities they use.

## Low coupling and high cohesion

Each component owns a focused responsibility, the state that belongs to it and the behavior needed
to fulfill it. Closely related decisions stay within that boundary rather than being scattered
across callers or shared utilities.

Components depend only on explicit public contracts. Each contract has one authoritative definition,
owned by its provider; consumers reference it. A component's internal changes must not require
changes to its consumers while its public contract remains compatible. Routine changes that require
coordinated redesign of several components indicate that their boundaries need correction.

Each component architecture is independent. Its interface section is the only place that names
other components, imports their contracts or defines interaction with them. Its internal design
uses only its own responsibilities and state. System-wide composition and flows are defined here.

OperatorInterface depends on Supervisor's public execution contract and does not need knowledge of
TaskEngine. Supervisor manages TaskEngine through its own public contract without knowing its
internal task orchestration. Supervisor translates engine observations into its execution view,
including recovery and lifecycle events, rather than exposing engine internals to the interface.

Design and test each component against its contracts independently. Contract tests verify each
boundary; integration and workflow tests verify cooperation across boundaries. Multi-component
flows do not create a special shared contract or require the components' internal designs to be
coupled.

## Component responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| OperatorInterface | Operator commands, configuration input, progress rendering and final presentation | Queue decisions, agent execution or recovery policy |
| Supervisor | Execution intent, TaskEngine process lifecycle, incident records, recovery invocation and verified restart | Normal task-phase sequencing or code-review decisions |
| TaskEngine | Serial task lifecycle, task/workspace ownership, execution evidence and conversation history | Terminal formatting or exceptional operational recovery policy |
| AgentRuntime | Profile catalogue, base/profile instructions, agent execution, output shape and cancellation | Selecting action input artifacts, queue decisions or declaring delivery complete |
| Adapters | External protocol translation, authentication and faithful operation results | Business lifecycle decisions or inferred success |

TaskEngine's ExecutionRunner follows an executable YAML workflow and persists the next state after
each action completes. The workflow supplies queue, review and repair sequencing. Actions perform
task-specific operations and exchange persistent artifacts through their own contracts. Application
startup binds their dependencies and storage. The runner has no knowledge of artifacts or task semantics;
after a crash it resumes at the persisted state and starts that action anew.

Role permissions are distinct. RecoveryRole may investigate and repair operational state through
its authorized tools. DeveloperRole and ReviewerRole do not acquire those permissions by sharing
AgentRuntime. A role's report does not replace the deterministic evidence required for completion.

## Relationships and contracts

| Caller or producer | Receiver | Contract boundary |
| --- | --- | --- |
| OperatorInterface | Supervisor | Start with project configuration filepath, mode and target; request intentional cancellation |
| Supervisor | Nexus worker / TaskEngine | Pass the project filepath to worker startup; invoke the engine with execution intent or continuation; request shutdown |
| TaskEngine | Supervisor | Structured progress, terminal outcome and evidence of confirmed shutdown |
| Supervisor | OperatorInterface | Execution progress, recovery progress, final outcome and requests for operator action |
| TaskEngine actions | AgentRuntime | run(profile, workspaceRef, additionalContext) for development/review |
| Supervisor | AgentRuntime | run(recoveryProfile, workspaceRef, additionalContext) with incident evidence and original intent |
| AgentRuntime | Its caller | Structured role result, activity and execution/shutdown outcome |
| TaskEngine and authorized role tools | Adapters | Explicit external operations with typed inputs and observed results |
| AgentRuntime | Coding runtime adapter | Launch, communicate with and stop the configured coding runtime |
| Supervisor | Notification adapter | Publish an incident summary and record its publication outcome |

Contracts define inputs, outputs, failure outcomes, cancellation, identity and ownership. Process
boundaries require a transport for those contracts; in-process boundaries use ordinary calls.
Transport and serialization must preserve the same semantics. Terminal text is never a control
protocol. Detailed signatures and record schemas must be prescribed before implementing each
component boundary.

### Shared interface vocabulary

These are value types used at public boundaries, not a shared state store or business-service
layer. A component owns the meaning of its domain records. Identifiers are opaque strings;
timestamps are UTC ISO 8601; durations are nonnegative milliseconds; paths are absolute local
paths. A task key is never used directly as a filesystem path.

```ts
type ArtifactRef = {
  path: string;
  sha256: string;
};

type Fault = {
  code: 'invalid-input' | 'configuration' | 'unavailable' | 'permission'
      | 'conflict' | 'invalid-data' | 'timeout' | 'cancelled'
      | 'uncertain' | 'internal';
  message: string;
  effects: 'none' | 'possible';
  evidence: readonly ArtifactRef[];
};

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; fault: Fault };

type Shutdown = {
  state: 'confirmed' | 'unconfirmed';
  evidence: readonly ArtifactRef[];
};

type Observer<E> = (event: E) => void;
```

ArtifactRef identifies an immutable, deliberately exported file. Its producer finishes and hashes
the file before publishing the reference; the receiver verifies identity and content before use.
It is not permission to traverse the producer's private storage. Missing or altered artifacts are
explicit faults. Mutable workspace locations are separate values and are never ArtifactRefs.

Expected failures are returned as data. An implementation exception at a component boundary becomes
an internal fault with retained evidence; it does not imply that effects were rolled back. Fault
messages and artifacts exclude credentials. An operation with a known ordinary negative result
returns that domain result rather than a transport fault.

Observers carry progress, never permission or authoritative completion evidence. Observer failure
is isolated from execution. Delivery may be coalesced or interrupted; full reports remain durable
and the returned result is authoritative. A component must not wait indefinitely for presentation.
Cancellation is explicit through AbortSignal; it is not inferred from an observer disappearing.

Shutdown describes the work a component actually owns. A process exit is not proof that its child
writers have stopped. Unconfirmed shutdown prohibits a replacement writer, including recovery.
Aborting an external write does not establish that the remote effect did not happen.

Public contracts use newline-delimited JSON across process boundaries. Every envelope contains
`version: 1`, `invocationId` and `kind`. The parent sends `kind: 'start'` with `request`, or
`kind: 'cancel'` with `reason`; the child sends `kind: 'event'` with `event`, or `kind: 'result'`
with `result`. A child accepts one start request. Progress and result records use stdout;
diagnostics use stderr. A parent-side transport bridge provides the
same interface as an in-process provider, validates messages and confirms process shutdown. It
contains no recovery or task policy. A missing, malformed or mismatched result is a failed invocation,
even when the child exited zero. The bridge also checks cancellation and exit evidence before
accepting a reported success. There is no network service or message broker in this design.

TaskEngine emits structured facts about its work. It does not choose colors, terminal layout or
human-readable progress sentences. OperatorInterface renders Supervisor's execution view and sends explicit
commands; it does not infer engine state from log wording. Changing presentation must not change
execution decisions. A presentation failure is distinct from an explicit cancellation request.

Construction and wiring belong at application startup. Components receive their dependencies;
OperatorInterface does not construct or orchestrate TaskEngine's internal phases. No component
calls another component's internals or reads its private records to bypass the public contract.

## Finite Run

Finite Run is a Nexus execution mode: process eligible work serially and finish when a fresh
inspection establishes that no eligible work remains. It does not reserve a fixed batch at startup.

1. OperatorInterface sends Supervisor a start command with projectConfigPath and Finite Run mode.
2. Supervisor starts the Nexus worker with that filepath. Worker startup reads both configurations,
   binds the actions/components and starts TaskEngine with the selected Nexus workflow.
3. TaskEngine selects one eligible task, carries it through implementation, ordinary repair,
   review, delivery and verified completion, then inspects the queue again.
4. TaskEngine sends structured progress to Supervisor, which maps it into the execution view
   exposed to OperatorInterface.
5. When the queue is confirmed empty, TaskEngine returns a drained outcome. Supervisor confirms
   its shutdown and OperatorInterface presents the result.

A source failure or an invalid task is not proof that the queue is empty. Ordinary failed checks
and requested code repairs stay within TaskEngine's normal lifecycle and escalation policy.

If normal execution cannot continue, or TaskEngine terminates unexpectedly, Supervisor records an
incident and invokes RecoveryRole through AgentRuntime. Recovery investigates the evidence and
returns its actions and proposed continuation. Supervisor verifies ownership and shutdown before
starting another writer. Recovery may resume interrupted work or explicitly prioritize a necessary
blocker. Unresolved recovery produces an operator-action outcome rather than an endless restart.

Intentional cancellation stops the execution and its owned work; it does not trigger an unwanted
recovery restart. Watch and Single Ticket modes use the same components and contracts with different
execution intent, rather than separate orchestration implementations.

## Verification boundaries

Every component contract is covered by contract tests. Exercise the real provider of the contract
against controlled dependencies, and verify that callers produce valid requests and handle its
defined outcomes. Schema checks alone do not establish ordering, cancellation or ownership behavior.

Use unit tests for internal decisions, focused integration tests for actual process, persistence and
external protocol boundaries, and a small number of complete workflows for component composition.
Do not repeat the same behavioral matrix at every layer or make each contract test start all Nexus.

Requirements are allocated to components and interactions. Architecture prescribes how those
obligations are divided; the verification inventory links the obligations to contract and behavior
scenarios. Shared guarantees are defined once and referenced by the contracts that rely on them.
