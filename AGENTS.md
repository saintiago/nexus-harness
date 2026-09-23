# Documentation reference

Documentation is the law; code is not. Documentation states intent, and code is its embodiment.
If code contradicts documentation, correct the code.

## Purpose and design

- [High-level architecture](docs/new/high-level-architecture.md): target composition, component contracts and execution modes.
- [OperatorInterface design](docs/new/operator-interface.md): commands, execution presentation and terminal ownership.
- [Supervisor design](docs/new/supervisor.md): execution lifecycle, recovery and restart decisions.
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
- [AgentRuntime design](docs/new/agent-runtime.md): profiles, supplied context and agent invocation.
- [Adapters design](docs/new/adapters/architecture.md): shared external-boundary responsibilities and contract conventions.
- [Jira adapter](docs/new/adapters/jira.md): issue data, comments, changes and ranking.
- [GitHub adapter](docs/new/adapters/github.md): pull requests, reviews, checks and workflow observations.
- [Git adapter](docs/new/adapters/git.md): repository data and explicit Git operations.
- [Processes adapter](docs/new/adapters/processes.md): command execution, streamed output and exit results.
- [Coding runtime adapter](docs/new/adapters/coding-runtime.md): coding-provider invocation and activity.
- [Notifications adapter](docs/new/adapters/notifications.md): notification publication.
- [Workspace design](docs/new/workspace.md): directory layout and concrete workspace references.
- [Configuration design](docs/new/configuration.md): project/Nexus setting ownership, file locations and value constraints.
- [Long-term vision](docs/LONG_TERM_VISION.md): future purpose and direction; not current behavior.
- [Architecture](docs/architecture.md): design principles, ownership, testing and tech stack.
- [Components](docs/components.md): responsibilities and required behavior.

## Behavior and operation

- [Specification](docs/spec.md): required behavior and limits.
- [Workflow](docs/WORKFLOW.md): configuration and command contracts.
- [Operations](docs/operations.md): installation, commands and examples.
- [Connect a project](docs/connect-a-project.md): project onboarding.
- [Agent tools](docs/nexus-agent-tools.md): runtime profiles and tool setup.
- [Harness configuration example](docs/nexus.config.example.json): installation settings.
- [Project configuration example](docs/nexus.project.example.json): connected-project settings.

## Development

- [Development guide](docs/development.md): implementation, verification and role boundaries.
- [Git workflow](docs/GIT-WORKFLOW.md): branches, pull requests and integration.
- [Testing](docs/testing.md): test pyramid, boundaries and coverage restoration.
- [Validation caching](docs/validation-caching.md): cache eligibility, invalidation and execution guarantees.
- [Documentation guide](docs/documentation.md): document ownership and maintenance.
