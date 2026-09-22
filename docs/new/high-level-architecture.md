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
│   ├── Configuration input
│   └── Progress and result presentation
├── Supervisor
│   ├── TaskEngine process lifecycle
│   └── Recovery coordination
├── TaskEngine
│   ├── QueueCoordinator
│   ├── TaskIntake
│   ├── WorkspaceManager
│   ├── ExecutionRunner
│   ├── ReviewCoordinator
│   ├── DeliveryAndCompletion
│   └── ConversationHistory
├── AgentRuntime
│   ├── DeveloperRole
│   ├── ReviewerRole
│   └── RecoveryRole
└── Adapters
    ├── Jira
    ├── GitHub
    ├── Git
    ├── Coding runtime
    └── Notifications
```

The five components are not five separately deployed services. Supervisor runs as the parent of
the TaskEngine process. AgentRuntime is invoked by TaskEngine for development and review, and by
Supervisor for recovery. Adapters are modules used at external boundaries; there is no adapter
registry or additional service implied by this grouping.

## Low coupling and high cohesion

Each component owns a focused responsibility, the state that belongs to it and the behavior needed
to fulfill it. Closely related decisions stay within that boundary rather than being scattered
across callers or shared utilities.

Components depend only on explicit public contracts. Each contract has one authoritative definition,
owned by its provider; consumers reference it. A component's internal changes must not require
changes to its consumers while its public contract remains compatible. Routine changes that require
coordinated redesign of several components indicate that their boundaries need correction.

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
| AgentRuntime | Role profiles, role-specific input/output contracts, permissions, agent invocation and cancellation | Queue selection or authority to declare delivery complete |
| Adapters | External protocol translation, authentication and faithful operation results | Business lifecycle decisions or inferred success |

QueueCoordinator composes the TaskEngine's internal components. TaskIntake discovers and claims
work; WorkspaceManager prepares and retains working copies; ExecutionRunner coordinates developer
turns and checks; ReviewCoordinator coordinates assessment; DeliveryAndCompletion publishes work
and verifies integration; ConversationHistory supplies complete, attributed context.

Role permissions are distinct. RecoveryRole may investigate and repair operational state through
its authorized tools. DeveloperRole and ReviewerRole do not acquire those permissions by sharing
AgentRuntime. A role's report does not replace the deterministic evidence required for completion.

## Relationships and contracts

| Caller or producer | Receiver | Contract boundary |
| --- | --- | --- |
| OperatorInterface | Supervisor | Start an execution with mode, target and configuration; request intentional cancellation |
| Supervisor | TaskEngine | Start the engine with execution intent or a verified continuation; request shutdown |
| TaskEngine | Supervisor | Structured progress, terminal outcome and evidence of confirmed shutdown |
| Supervisor | OperatorInterface | Execution progress, recovery progress, final outcome and requests for operator action |
| TaskEngine | AgentRuntime | Invoke DeveloperRole or ReviewerRole with task context, workspace identity and cancellation |
| Supervisor | AgentRuntime | Invoke RecoveryRole with incident evidence and the original execution intent |
| AgentRuntime | Its caller | Structured role result, activity and execution/shutdown outcome |
| TaskEngine and authorized role tools | Adapters | Explicit external operations with typed inputs and observed results |
| AgentRuntime | Coding runtime adapter | Launch, communicate with and stop the configured coding runtime |
| Supervisor | Notification adapter | Publish an incident summary and record its publication outcome |

Contracts define inputs, outputs, failure outcomes, cancellation, identity and ownership. Process
boundaries require a transport for those contracts; in-process boundaries use ordinary calls.
Transport and serialization must preserve the same semantics. Terminal text is never a control
protocol. Detailed signatures and record schemas must be prescribed before implementing each
component boundary.

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

1. OperatorInterface sends Supervisor a start command selecting Finite Run and its configuration.
2. Supervisor starts one TaskEngine with that execution intent.
3. TaskEngine selects one eligible task, carries it through implementation, ordinary repair,
   review, delivery and verified completion, then inspects the queue again.
4. TaskEngine sends structured progress to Supervisor, which maps it into the execution view
   exposed to OperatorInterface.
5. When the queue is confirmed empty, TaskEngine returns a completed outcome. Supervisor confirms
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
