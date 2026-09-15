# AGENTS.md

## Start here

Build a small, local-first coding harness. This document set replaces the earlier, more complex design; do not bring its requirements back implicitly.

- [spec.md](docs/spec.md): what the first working version does.
- [architecture.md](docs/architecture.md): code ownership and extension points.
- [WORKFLOW.md](docs/WORKFLOW.md): the loop and JSON input contract.
- [scaffold-request.md](scaffold-request.md): the current, narrower scaffolding task.

Read what is relevant to the task. The spec defines behavior; the task defines what to implement now. Report a real conflict instead of rewriting requirements to fit the code.

## Keep it small

Use TypeScript, npm, ordinary functions, and a few focused modules. Add an abstraction when a real caller or test needs it, not because a future integration might.

Do not add databases, queues, provider registries, a workflow engine, or services. Do not implement later features during scaffolding. Keep runtime-specific code out of the task loop.

## Verify changes

Preserve user changes. Once a lockfile exists, use `npm ci` unless intentionally changing dependencies. Run focused tests, then `npm run validate` before finishing. The scaffold task creates these scripts.

Add tests for meaningful behavior and failure cases. Do not disable checks, weaken assertions, or hide files from validation just to get a pass. Tests must not need a live coding agent or credentials.

## Finish honestly

Do not publish, deploy, or use provider accounts without an explicit task. Use temporary directories for destructive tests.

Report changes, exact checks and outcomes, and remaining gaps. A scaffold is not a functioning harness; passing local checks is not proof of production readiness.
