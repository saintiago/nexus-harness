# nexus harness

A small, local-first coding harness: one CLI invocation takes an explicit development task,
prepares a working copy, asks a coding agent to implement it, runs the project's own checks,
and saves a local report.

**The loop exists; the public command that runs it does not.** Configuration and task validation
work end to end, the working copy, the configured check rounds, the bounded repair loop, the
report and its logs, and the Codex CLI adapter are implemented and covered by offline tests, and
`run` is refused rather than faked until T13 wires them into one CLI invocation. See
[docs/tasks.md](docs/tasks.md) for the ordered backlog, and [docs/spec.md](docs/spec.md) §6 for the
increment plan.

## Requirements

- Node.js 24 (`.nvmrc` records 24.14.1; `engines` requires 24 or newer)
- npm 11

## Setup

```sh
nvm use          # or install Node 24 another way
npm ci
```

## Commands

| Script                 | What it does                                                  |
| ---------------------- | ------------------------------------------------------------- |
| `npm run dev`          | Run the CLI from TypeScript sources via `tsx`.                |
| `npm start`            | Run the built CLI (`dist/cli.js`); run `npm run build` first. |
| `npm run build`        | Compile `src/` to `dist/`.                                    |
| `npm run typecheck`    | Type-check sources and tests without emitting.                |
| `npm run lint`         | ESLint, including the dependency boundaries below.            |
| `npm run lint:fix`     | ESLint with fixes applied.                                    |
| `npm run format`       | Write Prettier formatting.                                    |
| `npm run format:check` | Check formatting without writing.                             |
| `npm test`             | Run the Vitest suite once.                                    |
| `npm run test:watch`   | Run Vitest in watch mode.                                     |
| `npm run validate`     | Format, lint, typecheck, test, build — the same gate CI runs. |

## What works today

`check-config` reads a configuration file and a task file, validates both, resolves `workDir`,
and prints either a summary or every problem it found.

```sh
npm run dev -- check-config --config harness.config.json --task examples/task.json
```

It creates no directories, runs no configured command, contacts no provider, and needs no
credentials. Inputs are rejected rather than repaired: unknown keys, wrong types, blank text,
invalid limits, and malformed command arrays all fail with the file and field named. No value
is coerced and no environment variable is interpolated.

Exit codes: `0` success, `1` input error (unreadable file, invalid JSON, failed validation),
`2` usage error (unknown command or option, missing value, unimplemented command). No arguments
and `--help` print help and exit `0`.

`harness.config.json` and `examples/task.json` are the working examples; their format is defined
in [docs/WORKFLOW.md](docs/WORKFLOW.md) §1–2.

Everything else the loop does is exercised through the modules themselves rather than through the
CLI: `tests/local-run.integration.test.ts` runs real tasks end to end against a temporary target
project with only the coding turn substituted, and `tests/runner.test.ts`, `tests/lifecycle.test.ts`
and `tests/agent.test.ts` cover the runner, the check rounds, and the runtime adapter.

## What does not work yet

`npm run dev -- run ...` is rejected with a "not implemented" error (T13): the CLI has no `run`
command, so nothing in `src/` composes the loop for a real invocation and no OS signal reaches the
runner's stop request. No Jira intake and no PR publication exists either, and the harness never
commits, pushes, or publishes anything on your behalf.

## Module ownership

| File               | Responsibility                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `src/cli.ts`       | Arguments, help, exit codes, top-level wiring. Owns all presentation.                    |
| `src/config.ts`    | Reads and validates the two JSON inputs; resolves `workDir`.                             |
| `src/types.ts`     | The data contracts. Data only: no imports, no runtime I/O.                               |
| `src/workspace.ts` | Preflight, run directory allocation, the working copy, and the final change summary.     |
| `src/checks.ts`    | Setup/check command execution, process-tree stop, output capture.                        |
| `src/agent.ts`     | The coding runtime: one turn through the Codex CLI, normalized for the runner.           |
| `src/runner.ts`    | The order the work happens in: baseline, turns, checks, repair, deadlines, cancellation. |
| `src/report.ts`    | `result.json` and the logs under `<runDir>/logs`; reads back command output for repair.  |

`src/cli.ts` depends on `config.ts` and `types.ts`; nothing depends on `cli.ts`. That boundary and
the "`types.ts` is data only" rule are enforced by `no-restricted-imports` entries in
`eslint.config.js`, and `tests/boundaries.test.ts` demonstrates one permitted and one rejected
import against fixtures in `tests/fixtures/boundaries/`.

`.prettierignore` excludes the supplied `AGENTS.md` and `docs/` so those design documents stay
byte-for-byte as written.

## Coding runtime

The coding turn is the host's own Codex CLI, driven through its documented non-interactive form.
One interface was selected — the **CLI**, not the SDK — because it is the supported way to run a
single non-interactive turn on this platform and needs no extra client library in this repository.

- **Interface:** `codex exec` (`@openai/codex`, version **0.154.0** when this was written, which
  publishes a `win32-x64` build). The adapter invokes exactly
  `codex exec --sandbox workspace-write --json -`, started **in the working copy**, with the prompt
  written to standard input. `--json` makes the runtime write one JSON event per line to standard
  output; its progress goes to standard error; the turn ends when the runtime exits. Nothing is
  interpolated and no shell is involved beyond what a Windows `.cmd` shim already requires.
- **Official references consulted:** [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  [CLI commands and flags](https://learn.chatgpt.com/docs/developer-commands?surface=cli) (`exec`,
  `--json`, `--sandbox`, `-o/--output-last-message`, `resume`), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
  and the `openai/codex` documentation served through the Context7 MCP server. `resume` and
  `--output-last-message` exist and are deliberately unused: every top-level turn is one fresh
  invocation, so continuing a session can never quietly buy extra turns.
- **Local setup and authentication (yours to do, outside this repository):**
  `npm install --global @openai/codex`, then `codex login` (or `codex login --with-api-key`, or set
  `CODEX_API_KEY`). Credentials live where the CLI keeps them — the ambient environment and
  `CODEX_HOME` — and the adapter passes that environment to the runtime untouched. **Authentication
  is never part of a task file, a configuration file, or this repository's code**, and nothing the
  adapter reads is copied into a log, a timeline, or a report: no key, no token, and no environment
  dump is persisted anywhere.
- **Observed limitations, stated rather than smoothed over:**
  - `codex exec`'s **exit codes are not documented**. The adapter therefore does not read an exit
    code as meaning anything by itself: it reads the event stream, and every other ending — a
    reported failure, a nonzero exit, a stream that is not the documented one — is a failed turn
    that stops the run, with what the runtime said repeated verbatim. No outer retry, ever.
  - AGENTS.md discovery is documented for the agent generally, but the non-interactive page does
    **not** explicitly confirm it for `codex exec`. The harness does not depend on it: it starts
    the runtime in the working copy, and names `AGENTS.md` in the prompt when the copy has one.
  - Windows guidance is inconsistent across the documentation (native sandbox versus WSL2), and
    npm packaging for the `win32-x64` optional dependency has had reported breakage (for example
    `openai/codex` issues #12931 and #17432). If `codex` is missing or will not start, the run
    fails with a launch error naming the executable; that is a stop, not something to retry.
  - The runtime's sandbox has network access **off** by default, so a turn cannot install packages.
    `setup` commands run outside that sandbox and are the right place for installs.
  - `--cd` is not used: the working root is the process's own working directory, so a working-copy
    path that a Windows shim cannot carry as an argument can never fail a turn.
  - **No live call is made by the test suite.** `npm test` needs no credentials, contacts nothing,
    and proves the harness's side of the contract against a stand-in runtime at the same process
    boundary. It says nothing about a real account, a real model, or the real CLI's behaviour; live
    evidence is recorded separately in T16.

## Toolchain

Node 24.14.1, TypeScript 6.0.3, ESLint 10, Prettier 3, Vitest 5, Zod 4, and tsx.

TypeScript is pinned to the 6.0 line on purpose: TypeScript 7 is newer, but `typescript-eslint`
8.70 still declares `typescript >=4.8.4 <6.1.0`, so 6.0.3 is the newest release the whole
toolchain supports. Dependencies are pinned by `package-lock.json`; use `npm ci`.

Setup and checks run project code — they are not harmless data processing.

## Documentation

- [AGENTS.md](AGENTS.md) — working agreement for this repository.
- [docs/spec.md](docs/spec.md) — what the harness does and its limits.
- [docs/architecture.md](docs/architecture.md) — code placement and extension points.
- [docs/WORKFLOW.md](docs/WORKFLOW.md) — the loop and the JSON input contract. **This is
  documentation for people**; the runtime reads plain JSON, with no Markdown parsing and no
  workflow language.
- [docs/scaffold-request.md](docs/scaffold-request.md) — the task that produced this scaffold.

## Next task

Implement the public `run` command: parse its options, compose the loop's real collaborators
(`preflightSource`, `allocateRunDirectory`, `prepareWorkspace`, `runCheckRound`, `runCodexTurn`,
the report functions), forward the host's signals as the run's stop request, and print the result
and the report path. T14 then covers the built CLI end to end.
