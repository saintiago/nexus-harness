# Architecture

One TypeScript CLI application, a few modules, and local files. No services, framework layers, database, or custom workflow engine.

[spec.md](spec.md) defines behavior. This document defines code placement. [WORKFLOW.md](WORKFLOW.md) defines the JSON inputs; it is not parsed at runtime.

## 1. Start with only the code needed

```text
src/
  cli.ts          # arguments, help, exit codes, top-level wiring
  config.ts       # read and validate configuration/task JSON
  types.ts        # small data contracts
```

The scaffold implements those files and their tests. Add the following files **when their behavior is implemented**, not as empty folders or throwing stubs:

```text
src/
  runner.ts       # coordinates the code/check/repair loop
  workspace.ts    # creates and inspects the per-run working copy
  agent.ts        # Codex interaction and normalized results
  checks.ts       # setup/check command execution and output
  report.ts       # result.json and log persistence
```

Ordinary named exports are enough. No directory-per-interface pattern, barrel hierarchy, seven-port contract bundle, generic provider factory, or dependency-injection container.

## 2. Responsibilities

The CLI loads inputs and, once implemented, calls a `runTask` function. The runner decides the order of work and whether another repair is allowed. Helper modules perform the concrete external operations.

```text
cli → config
cli → runner → workspace
             → agent
             → checks
             → report
```

Only `agent.ts` talks to a coding runtime. Only `workspace.ts` handles Git/working-copy preparation. Only `checks.ts` runs configured setup/check commands. Report file writes belong in `report.ts`.

The runner does not parse CLI arguments, contain provider API details, or construct shell commands. Helpers do not call back into the runner to choose its next action.

Keep `types.ts` limited to data: `Task`, `HarnessConfig`, command/check results, and the small run result. Infer types from validation schemas where convenient; do not maintain duplicate versions of the same schema. `types.ts` has no runtime I/O. More types are added with their first real use.

## 3. Testability without a framework

Use a plain argument object of functions when tests need to substitute the agent, checks, working copy, or reporting. Introduce it with the runner, not as speculative scaffolding.

The runner's tests use a fake agent and scripted check outcomes. Real file/process/Git tests use temporary directories. Live Codex tests are opt-in, not part of normal validation.

Keep imports directional and acyclic. During scaffolding, a small ESLint restriction can keep `types.ts` free of runtime implementation imports and prevent helpers importing `cli.ts`. Do not install a dependency-graph platform just to police three files. Test any restriction actually added with one allowed and one forbidden example.

## 4. Working copy and runtime

Use a separate local clone per run at first. It costs some disk space but avoids linked-worktree lifecycle/shared-metadata handling. A working-copy optimization can be added if profiling shows it matters; do not support multiple backends now.

Keep runtime calls in `agent.ts`, without exporting vendor types to the runner. Do not install an agent SDK or fabricate wrapper methods before the integration task. During that task, use the selected runtime's actual supported interface and document its setup.

The local execution model assumes a trusted repository and machine. Do not claim that a local child process or clone is a security sandbox. Isolation can be implemented behind these concrete execution functions later, without first building a remote worker platform.

## 5. State and reporting

Use an ordinary async function with a bounded loop, not a workflow/state-machine library. A few progress labels in logs are sufficient; final statuses are defined once in the spec.

Keep settings, deadline, repair count, and current check results in memory during execution. Save a final JSON report and useful logs under the run directory. No automatic crash recovery or resume is promised. Preserve unfinished directories for manual inspection.

The result file is an output artifact, not a database or a service API. Do not add leases, durable operation journals, candidate-signing systems, or event sourcing.

## 6. Tooling and growth

Use npm, strict TypeScript, ESLint, Prettier, Vitest, and Zod. A small dev runner such as `tsx` is acceptable. Use a compatible supported Node/toolchain combination and commit the lockfile as source content. One CI workflow installs reproducibly and runs `npm run validate`.

Extend by adding actual features: a Jira module can supply the existing `Task`; a publisher can consume a finished result; CI observation can be added after publication works. Define their small contracts at that point. None belongs in this scaffold.

Keep one application until there is a concrete reason to split it. Simplicity comes from clear ownership and a small loop, not from putting all code in one file.
