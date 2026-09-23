# Documentation reference

Documentation is the law; code is not. Documentation states intent, and code is its embodiment.
If code contradicts documentation, correct the code.

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

## Low coupling and high cohesion

Each component owns a focused responsibility, its state and the behavior needed to fulfill it.
Closely related decisions stay within that boundary.

Components depend only on public contracts. Each contract has one authoritative definition, owned
by its provider; consumers reference it. Internal changes must not require consumer changes while
the public contract remains compatible. Routine coordinated redesign indicates a boundary problem.

Each component architecture is independent. Its interface section is the only place that names other
components, imports their contracts or defines interaction with them. Its internal design uses its
own responsibilities and state. System composition and flows belong in the high-level architecture.

Contract tests verify individual boundaries. Integration and workflow tests verify cooperation.
A multi-component flow does not create a special shared contract.

## Purpose and design

- [Tech stack](docs/new/tech-stack.md): Linux platform, WSL development, language, tooling and integrations.
- [High-level architecture](docs/new/high-level-architecture.md): target composition, component contracts and finite execution.
- [Application design](docs/new/application.md): commands, configuration, worker lifecycle, recovery and process exit.
- [OperatorInterface design](docs/new/operator-interface.md): event subscriptions, activity pane and terminal colors.
- [TaskEngine design](docs/new/task-engine/architecture.md): declarative execution, action composition and event subscriptions.
- [ExecutionRunner design](docs/new/task-engine/execution-runner.md): XState binding, persisted execution state and progress events.
- [Finite workflow](workflows/finite-delivery.ts): XState definition for the target TaskEngine and Stately visualization.
- [Action design](docs/new/task-engine/actions/architecture.md): action structure, typed input/output artifacts and repeated-round handoffs.
- [SelectTask design](docs/new/task-engine/actions/select-task.md): source selection, task input and retained workspace reference.
- [PrepareWorkspace design](docs/new/task-engine/actions/prepare-workspace.md): repository preparation and retained-work continuation.
- [StartRound design](docs/new/task-engine/actions/start-round.md): round directories, current-round state and artifact-root selection.
- [Develop design](docs/new/task-engine/actions/develop.md): implementation context, profile selection and developer output.
- [Verify design](docs/new/task-engine/actions/verify.md): configured checks and persisted command results.
- [Deliver design](docs/new/task-engine/actions/deliver.md): verified branch publication and developer reporting.
- [Review design](docs/new/task-engine/actions/review.md): revision-specific review, complete findings and review publication.
- [SelectRepair design](docs/new/task-engine/actions/select-repair.md): shared repair allowance and profile escalation.
- [CompleteTask design](docs/new/task-engine/actions/complete-task.md): merge/check evidence and task completion.
- [AgentRuntime design](docs/new/agent-runtime/architecture.md): profiles, supplied context and agent invocation.
- [Native Codex profiles](docs/new/agent-runtime/profiles.md): repository templates and Linux installation.
- [DevelopmentRole design](docs/new/agent-runtime/development-role.md): constant developer instructions and task-specific input boundary.
- [ReviewerRole design](docs/new/agent-runtime/reviewer-role.md): evidence-based review instructions and prior-finding evaluation.
- [RecoveryRole design](docs/new/agent-runtime/recovery-role.md): current-project diagnosis, queue reconciliation and fresh task restart.
- [Findings contract](docs/new/task-engine/actions/findings.md): finding, response and disposition shapes shared across rounds.
- [Adapters design](docs/new/adapters/architecture.md): shared external-boundary responsibilities and contract conventions.
- [Jira adapter](docs/new/adapters/jira.md): issue data, comments, changes and ranking.
- [GitHub adapter](docs/new/adapters/github.md): pull requests, reviews, checks and workflow observations.
- [Git adapter](docs/new/adapters/git.md): repository data and explicit Git operations.
- [Processes adapter](docs/new/adapters/processes.md): command execution, streamed output and exit results.
- [Coding runtime adapter](docs/new/adapters/coding-runtime.md): coding-provider invocation and activity.
- [Notifications adapter](docs/new/adapters/notifications.md): notification publication.
- [Workspace design](docs/new/workspace.md): directory layout and concrete workspace references.
- [Configuration design](docs/new/configuration.md): project/Nexus setting ownership, file locations and value constraints.

## Development

- [Testing architecture](docs/new/testing.md): test scopes, contracts and system journeys.
- [Documentation guide](docs/new/documentation.md): document ownership and maintenance.
