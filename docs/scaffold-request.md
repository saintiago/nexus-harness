# Task: scaffold the simple development harness

Work in this directory. Create a small, working TypeScript project foundation from the supplied documents. **Do not implement the agent execution loop yet.**

## Read and scope

Read:

- [AGENTS.md](AGENTS.md)
- [docs/spec.md](docs/spec.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/WORKFLOW.md](docs/WORKFLOW.md)

This simplified design replaces the earlier harness design. Do not restore its state machine, seven-port framework, YAML schema, registration profiles, or database requirements. This is a fresh scaffold, not a backward-compatibility migration.

Inspect the directory first. It may contain only these documents. Preserve them and any other user changes; do not delete/reset files automatically. Give a short plan, then perform the work.

The spec describes the first working application. This task implements only its **scaffold milestone**: configuration/task validation, CLI help, tooling, tests, and CI.

## 1. Project setup

Use Node.js, TypeScript, npm, ESLint, Prettier, Vitest, and Zod. A small development runner such as `tsx` is fine. Choose mutually compatible supported stable versions, record the Node version, and create a lockfile. If a compatible scaffold exists, preserve it rather than upgrading everything.

Use strict TypeScript and a consistent Node ESM setup. Keep imports compatible with the chosen compiler/runtime configuration. No application framework, DI container, YAML parser, database, agent SDK, or dependency-cruiser is needed.

Create:

```text
src/
  cli.ts
  config.ts
  types.ts
tests/
  config.test.ts
  cli.test.ts
examples/
  task.json
harness.config.json
README.md
```

Preserve the supplied `AGENTS.md`, this request, and `docs/` files. Add normal package/compiler/lint/format/test configuration, `.gitignore`, `.editorconfig`, a Node version declaration, and `.github/workflows/ci.yml`.

Do not create empty execution modules. `runner.ts`, `workspace.ts`, `agent.ts`, `checks.ts`, and `report.ts` are future code locations, not files to fill with fake implementations now.

## 2. Implement useful behavior now

Create `harness.config.json` and `examples/task.json` using the examples in `docs/WORKFLOW.md`. That document owns the input contract; do not invent another format.

Implement strict Zod schemas and JSON loading:

- Reject unknown keys, wrong types, missing/nonblank-required values, invalid numeric limits, and malformed command arrays.
- Do not coerce values or interpolate environment variables.
- Resolve `workDir` relative to its config file.
- Produce useful read/JSON/schema errors naming the file and relevant field.

Implement CLI help and:

```sh
npm run dev -- check-config --config harness.config.json --task examples/task.json
```

The command reads/validates both inputs, reports success or errors, and exits appropriately. It must not create the configured work directory, execute setup/check commands, contact providers, or require credentials.

No arguments and `--help` display help successfully. Unknown commands/options and missing required arguments fail clearly. Reject `run` as not implemented rather than pretending the harness works. Make argument parsing/exit behavior testable without every unit test spawning a process; also smoke-test the built CLI.

Use a small `Task`/`HarnessConfig` type surface, inferred from schemas where appropriate. Do not implement the entire future run model, placeholders returning success, or a generic provider API.

## 3. Tests and lightweight boundaries

Use Vitest. Cover at least:

1. The actual checked-in config and task examples parse successfully.
2. Missing fields, unknown fields, invalid repair/time limits, empty checks, invalid executable arrays, and blank task text are rejected.
3. Invalid JSON and missing files return useful errors.
4. Relative `workDir` resolution uses the config directory, not the process directory.
5. Help, valid `check-config`, invalid input, unknown options, and unimplemented `run` have the documented behavior.
6. `check-config` does not create a workspace or execute the configured commands; test this with a harmless sentinel command that would create a file if mistakenly run.

Use temporary directories for file tests. No live agents, external services, provider secrets, or trivial `expect(true)` tests.

Keep `types.ts` free of runtime I/O and helper modules independent of `cli.ts`. A small ESLint import restriction is enough. If you add one, demonstrate one permitted import and one rejection using an isolated fixture. Do not build an architecture-testing framework or a large matrix of hypothetical module rules.

## 4. Scripts and CI

Provide:

```text
dev
start
build
typecheck
lint
lint:fix
format
format:check
test
test:watch
validate
```

`start` runs the built CLI. `npm test` runs once. `npm run validate` checks formatting, lint, types, tests, and build, stopping/returning nonzero on failure. Keep build output separate from source/tests; no recursive script definitions.

CI runs on pushes and pull requests, uses the declared Node version, installs with `npm ci`, and runs `npm run validate`. Use minimal permissions. No deployment, secrets, agent jobs, or runtime task execution.

Ignore dependencies, build output, coverage, local secret files, and `.harness/` runtime data. Create the lockfile on disk, but do not make Git commits, push, or access provider accounts.

## 5. Documentation and scope control

Write a short README with setup, commands, module ownership, current functionality, and the next implementation task. Point to the supplied docs rather than duplicating them. Describe WORKFLOW.md as documentation; the runtime reads JSON.

Do not implement workspace cloning, model calls, validation-command execution, repair, reports, Jira intake, PR publication, CI polling, recovery, sandbox provisioning, or a dashboard during this task. Do not add settings/abstractions for them in anticipation.

This task authorizes local scaffolding and necessary config/test changes, not arbitrary changes to product scope. Do not invent completed features or weaken checks to manufacture success.

## 6. Finish and report

Install dependencies, run formatting and focused tests, then run `npm run validate`. Smoke-test the built CLI with help, the supplied valid files, and an invalid fixture; confirm the expected exit codes. Remove temporary probes without resetting the user's working tree.

Report the created structure, implemented commands, test/validation results, and remaining limitations. State exactly which checks ran; do not invent a pass if the environment prevented execution.

The completed task is a small scaffold whose configuration checker works. Stop there. The next task implements one local task through a fake-agent loop before integrating Codex.
