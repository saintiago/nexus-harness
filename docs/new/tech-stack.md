# Tech stack

## Platform

Nexus runs on Linux only. Development on Windows takes place inside WSL, including dependency
installation, builds, tests and Nexus execution. Native Windows execution is not supported.

## Language and tooling

Use Node.js, TypeScript ES modules and npm. Use XState for workflow execution and persisted snapshots.
Use Zod for external input validation, Vitest for tests, ESLint for linting and Prettier for formatting.

Use Turborepo for local validation caching and tool-native caches where appropriate. Cache only
deterministic validation results with their inputs declared. Live service operations and completion
checks are never replaced by cached validation results.

## Integrations

Use Git for repository operations and the operator's authenticated `gh` CLI for PR creation and
auto-merge. Publish reviews and the required review check through the Nexus Lens GitHub App identity.
Use the operator's configured Jira API token for Jira. Credentials remain in host configuration.

Use maintained libraries or existing tools for established infrastructure. Keep integration glue
small; introduce a dependency when it reduces total implementation and maintenance complexity.
