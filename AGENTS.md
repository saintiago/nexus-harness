# Documentation reference

Documentation is the law; code is not. Documentation states intent, and code is its embodiment.
If code contradicts documentation, correct the code.

## Purpose and design

- [Proposed high-level architecture](docs/new/high-level-architecture.md): target composition, component contracts and execution modes.
- [Proposed OperatorInterface design](docs/new/operator-interface.md): commands, execution presentation and terminal ownership.
- [Proposed Supervisor design](docs/new/supervisor.md): execution lifecycle, recovery and restart decisions.
- [Proposed TaskEngine design](docs/new/task-engine/architecture.md): declarative execution, action composition and event subscriptions.
- [Proposed finite workflow](workflows/finite-delivery.ts): XState definition for the target TaskEngine and Stately visualization.
- [Proposed action design](docs/new/task-engine/actions/architecture.md): action structure, typed input/output artifacts and repeated-round handoffs.
- [Proposed StartRound design](docs/new/task-engine/actions/start-round.md): round directories, current-round state and artifact-root selection.
- [Proposed AgentRuntime design](docs/new/agent-runtime.md): profiles, supplied context and agent invocation.
- [Proposed Adapters design](docs/new/adapters.md): external operations, protocol translation and observed outcomes.
- [Proposed Workspace design](docs/new/workspace.md): directory layout and concrete workspace references.
- [Proposed configuration design](docs/new/configuration.md): project/Nexus setting ownership, file locations and value constraints.
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
