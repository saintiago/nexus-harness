# Tech stack

## Platform

Nexus runs on Linux only. Development on Windows takes place inside WSL, including dependency
installation, builds, tests and Nexus execution. Native Windows execution is not supported.

## Language and tooling

Use Node.js, TypeScript ES modules and npm. Use XState for workflow execution and persisted snapshots.
Use Zod for external input validation, ESLint for linting and Prettier for formatting.

Use Dependency Cruiser in validation to enforce component import boundaries. Cross-component imports
use public interfaces; actions may import other actions' artifact declarations, not their implementations.
Keep ExecutionRunner independent of concrete actions and adapters, and adapters independent of
orchestration implementations. Startup wiring assembles implementations. Contract tests verify behavior.

Use Turborepo for local validation caching and tool-native caches where appropriate. Cache only
deterministic validation results with their inputs declared. Live service operations and completion
checks are never replaced by cached validation results.

## Testing

Use Vitest for unit, component, integration and system tests, including contract and workflow tests.
Use its assertions, spies, mocks, fake timers and setup/cleanup hooks. Workflow tests execute the real
XState machine with supplied action implementations.

Use Node.js standard filesystem and process APIs for temporary resources in integration tests.
Different test scopes share the same test runner; they do not require separate frameworks.

## Integrations

Use Git for repository operations and the operator's authenticated `gh` CLI for PR creation and
auto-merge. Publish reviews and the required review check through the Nexus Lens GitHub App identity.
Use the operator's configured Jira API token for Jira. Credentials remain in host configuration.

Use maintained libraries or existing tools for established infrastructure. Keep integration glue
small; introduce a dependency when it reduces total implementation and maintenance complexity.
