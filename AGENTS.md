# Documentation reference

Documentation is the law; code is not. Documentation states intent, and code is its embodiment.
If code contradicts documentation, correct the code.

## Core design principles

Apply these principles when shaping requirements, workflows, architecture, code and tests.

- **KISS:** Prefer the simplest design that meets the need and is easy to understand, debug and
  maintain.
- **DRY:** Give each rule or contract one authoritative home. Extract repeated behavior only
  when the cases share a responsibility.
- **YAGNI:** Add a capability, setting, state or extension point only when a current requirement
  needs it.
- **Avoid premature optimization:** Require evidence of a bottleneck before adding performance
  complexity to an architecture or implementation.
- **Composition over inheritance:** Assemble focused behaviors through components and delegation
  instead of deep inheritance hierarchies. Use inheritance when a genuine subtype relationship is
  simpler; avoid components that add no clarity.

Account for the full cost of a design choice: implementation, validation, failure handling,
persistence, tests, documentation and maintenance. Even a small field can create obligations across
components. When removing a mechanism, remove its dependent validation, state and tests.

Keep specialized guarantees within the component or action that needs them.

## Low coupling and high cohesion

Keep related state and decisions within the owning component.

Components depend on provider-owned public contracts. Compatible internal changes should not force
consumer changes; routine coordinated redesign indicates a boundary problem.

Each component architecture is independent. Its interface section is the only place that names other
components, imports their contracts or defines interaction with them. Its internal design uses its
own responsibilities and state. System composition and flows belong in the high-level architecture.

Contract tests verify individual boundaries. Integration and workflow tests verify cooperation.
A multi-component flow does not create a special shared contract.

## SOLID principles

Apply these to component responsibilities and public contracts as well as code.

- **Single Responsibility:** Give a component, module or action one coherent reason to change.
- **Open/Closed:** Keep stable public contracts when adding a supported variation; change the
  design directly when that is simpler than an extension mechanism.
- **Liskov Substitution:** Any alternative implementation must honor the behavior promised by its
  public contract.
- **Interface Segregation:** Let consumers depend only on the focused capabilities they use.
- **Dependency Inversion:** Make policy depend on owned public contracts at external boundaries,
  not on concrete providers.

## Purpose and design

- [Tech stack](docs/tech-stack.md): Linux platform, WSL development, language, tooling and integrations.
- [High-level architecture](docs/high-level-architecture.md): system composition, component contracts and workflows.
- [Application design](docs/application.md): commands, configuration, worker lifecycle, recovery and process exit.
- [OperatorInterface design](docs/operator-interface.md): event subscriptions, activity pane and terminal colors.
- [TaskEngine design](docs/task-engine/architecture.md): declarative execution, action composition and event subscriptions.
- [ExecutionRunner design](docs/task-engine/execution-runner.md): XState binding, persisted execution state and progress events.
- [Finite workflow](workflows/finite-delivery.ts): XState definition for finite delivery and Stately visualization.
- [Idea refinement specification](docs/idea-refinement/spec.md): cross-project purpose, roles, council, routing, artifacts and XState pseudocode.
- [Action design](docs/task-engine/actions/architecture.md): action structure, typed input/output artifacts and repeated-round handoffs.
- [SelectTask design](docs/task-engine/actions/select-task.md): source selection, task input and retained workspace reference.
- [PrepareWorkspace design](docs/task-engine/actions/prepare-workspace.md): repository preparation and retained-work continuation.
- [StartDevRound design](docs/task-engine/actions/start-dev-round.md): round planning, developer profile selection and current-round state.
- [Develop design](docs/task-engine/actions/develop.md): implementation context, selected developer profile and developer output.
- [Verify design](docs/task-engine/actions/verify.md): configured checks and persisted command results.
- [Deliver design](docs/task-engine/actions/deliver.md): verified branch publication and developer reporting.
- [Review design](docs/task-engine/actions/review.md): revision-specific review, complete findings and review publication.
- [CompleteTask design](docs/task-engine/actions/complete-task.md): merge/check evidence and task completion.
- [AgentRuntime design](docs/agent-runtime/architecture.md): profiles, supplied context and agent invocation.
- [Native Codex profiles](docs/agent-runtime/profiles.md): repository templates and Linux installation.
- [DevelopmentRole design](docs/agent-runtime/development-role.md): constant developer instructions and task-specific input boundary.
- [ReviewerRole design](docs/agent-runtime/reviewer-role.md): evidence-based review instructions and prior-finding evaluation.
- [RecoveryRole design](docs/agent-runtime/recovery-role.md): current-project diagnosis, queue reconciliation and fresh task restart.
- [Findings contract](docs/task-engine/actions/findings.md): finding, response and disposition shapes shared across rounds.
- [Adapters design](docs/adapters/architecture.md): shared external-boundary responsibilities and contract conventions.
- [Jira adapter](docs/adapters/jira.md): issue data, comments, changes and ranking.
- [GitHub adapter](docs/adapters/github.md): pull requests, reviews, checks and workflow observations.
- [Git adapter](docs/adapters/git.md): repository data and explicit Git operations.
- [Processes adapter](docs/adapters/processes.md): command execution, streamed output and exit results.
- [Coding runtime adapter](docs/adapters/coding-runtime.md): coding-provider invocation and activity.
- [Notifications adapter](docs/adapters/notifications.md): notification publication.
- [Workspace design](docs/workspace.md): directory layout and concrete workspace references.
- [Configuration design](docs/configuration.md): project/Nexus setting ownership, file locations and value constraints.

## Development

- [Testing architecture](docs/testing.md): test scopes, contracts and system journeys.
- [Documentation guide](docs/documentation.md): document ownership and maintenance.
- [Task inventory](docs/tasks/inventory.md): implementation tasks and current statuses.
