# AGENTS.md

## Start here

Build and maintain a small, local-first coding harness. The documents in `docs/` are the source of truth; do not bring the earlier, more complex design back implicitly.

- [spec.md](docs/spec.md): what the harness does and its limits.
- [architecture.md](docs/architecture.md): code ownership and extension points.
- [WORKFLOW.md](docs/WORKFLOW.md): the loop, the JSON input contract, and the source CLI.
- [implement-task-source-connectors.md](docs/implement-task-source-connectors.md): the Jira intake assignment, including the opt-in live exercise that has not been run.
- [GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md): how changes to this repository are made.
- [README.md](README.md): the operating document for the person running the harness.

Read what is relevant to the task. The spec defines behavior; the task defines what to implement now. Report a real conflict instead of rewriting requirements to fit the code.

## Work on a branch

`main` stays green. One task, one `task/<name>` branch, merged into `main` through a pull request: see [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md). Never commit directly to `main`, and never push, merge, publish, or open pull requests in a *target* repository: a run leaves its work in the retained working copy.

## Keep it small

Use TypeScript, npm, ordinary functions, and a few focused modules. Add an abstraction when a real caller or test needs it, not because a future integration might.

Do not add databases, queues, provider registries, a workflow engine, or services. Do not implement later features as part of an unrelated task. Keep runtime-specific code out of the task loop.

## Verify changes

Preserve user changes. Use `npm ci` unless intentionally changing dependencies. Run focused tests, then `npm run validate` before finishing.

Add tests for meaningful behavior and failure cases. Do not disable checks, weaken assertions, or hide files from validation just to get a pass. Tests must not need a live coding agent, a Jira site, or credentials.

## Finish honestly

Do not publish, deploy, use provider accounts, or run a live Jira exercise without an explicit task. Use temporary directories for destructive tests.

Report changes, exact checks and outcomes, and remaining gaps. Mocked tests are not evidence that a live path works, and passing local checks is not proof of production readiness.
