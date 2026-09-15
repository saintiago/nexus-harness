# nexus harness

A small, local-first coding harness: one CLI invocation takes an explicit development task,
prepares a working copy, asks a coding agent to implement it, runs the project's own checks,
and saves a local report.

**This repository is a scaffold.** Configuration and task validation work end to end. The
workspace, agent, check, and report loop does not exist yet, and `run` is refused rather than
faked. See [docs/spec.md](docs/spec.md) §6 for the increment plan.

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

## What does not work yet

`npm run dev -- run ...` is rejected with a "not implemented" error. No cloning, agent calls,
command execution, repair loop, reporting, Jira intake, or PR publication exists. The modules
that will hold that work — `runner.ts`, `workspace.ts`, `agent.ts`, `checks.ts`, `report.ts` —
are deliberately absent rather than present as stubs.

## Module ownership

| File            | Responsibility                                                             |
| --------------- | -------------------------------------------------------------------------- |
| `src/cli.ts`    | Arguments, help, exit codes, top-level wiring. Owns all presentation.      |
| `src/config.ts` | Reads and validates the two JSON inputs; resolves `workDir`.               |
| `src/types.ts`  | `HarnessConfig`, `Task`, `Command`. Data only: no imports, no runtime I/O. |

`src/cli.ts` depends on `config.ts` and `types.ts`; nothing depends on `cli.ts`. That boundary and
the "`types.ts` is data only" rule are enforced by `no-restricted-imports` entries in
`eslint.config.js`, and `tests/boundaries.test.ts` demonstrates one permitted and one rejected
import against fixtures in `tests/fixtures/boundaries/`.

`.prettierignore` excludes the supplied `AGENTS.md` and `docs/` so those design documents stay
byte-for-byte as written.

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

Implement the local loop with a fake agent — workspace creation, baseline and post-agent checks,
bounded repair, and `result.json` — then swap in the Codex wrapper. Tests must not call a real
model, and nothing should need provider credentials.
