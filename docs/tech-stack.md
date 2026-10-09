# Tech stack

## Platform

Nexus runs on Linux only. Development on Windows takes place inside WSL, including dependency
installation, builds, tests and Nexus execution. Native Windows execution is not supported.

## Language and tooling

Use Node.js, TypeScript ES modules and npm. Use XState for workflow execution and persisted snapshots,
including idea refinement's parallel regions and joins.
Use Zod for external input validation, ESLint for linting and Prettier for formatting.

Use Dependency Cruiser in validation to enforce component import boundaries. Cross-component imports
use public interfaces; actions may import other actions' artifact declarations, not their implementations.
Keep ExecutionRunner independent of concrete actions and adapters, and adapters independent of
orchestration implementations. Application wiring assembles implementations. Contract tests verify behavior.

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

### JEv dependency

Consume `@saintiago/jev` from the standalone [JEv package](https://github.com/saintiago/jev-mcp),
using its [public contract at the delivered revision](https://github.com/saintiago/jev-mcp/blob/c914b52e034a350c3713281cfbe6221f8b138337/docs/contracts.md).
The package is private and unpublished. Build revision
`c914b52e034a350c3713281cfbe6221f8b138337` with its locked dependencies on Node 24/npm 11,
then run `npm pack`. Retain the resulting package as
`vendor/saintiago-jev-0.0.0-c914b52.tgz`, declare a runtime `file:` dependency on that tarball and
commit the npm lockfile integrity. A clean `npm ci` must install its public root exports and
`jev-mcp` executable without a sibling checkout, registry publication or runtime download.
The tarball contains the delivered package, not Nexus-owned copies of its provider implementation.

Install Git and ripgrep (`rg`) on the runtime PATH; JEv uses both for repository discovery.
CI installs ripgrep before validating installed-package retrieval.

Use this installed dependency for native stdio MCP `retrieve_evidence` and `expand_evidence` access. Launch its installed `jev-mcp`
bin from an absolute installation path, independent of the selected project's working directory.
The package owns validation, provider endpoint, transport, timeouts, safe errors and opt-in local
usage logging. The package returns exact source windows in batches and expands requested ranges or complete files without JEv. Agents own interpretation and verification. No additional adapter, HTTP service
or MCP client is needed. Package upgrades replace the pinned tarball and lockfile through normal
dependency review; installation activation preserves active runtime users under
[Application](application.md#installation-activation).
