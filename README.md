# nexus harness

A small, local-first coding harness. One CLI invocation takes an explicit development task,
prepares a working copy of a repository, runs that project's own setup and checks, asks the Codex
CLI to implement the task, reruns the checks, gives the runtime the observed failures to repair
within a bounded allowance, and keeps the working copy, the logs, and a final report on your disk.

Nothing leaves your machine except the coding turns themselves — a clone is made locally, the
configured commands run locally, and the harness never commits, pushes, or publishes anything.

**This README is the operating document.** The supplied documents stay authoritative for the
contracts they define: [docs/WORKFLOW.md](docs/WORKFLOW.md) for the JSON inputs and the run
procedure, [docs/spec.md](docs/spec.md) for behaviour and limits, and
[docs/architecture.md](docs/architecture.md) for where code goes. This file says how to install it,
how to run it, what it does to your machine, and what is not proven yet.

## Requirements and supported platforms

- **Node.js 24 or newer.** `engines` requires `>=24.0.0`, and `.nvmrc` records `24.14.1`, which is
  what everything here has been run on. npm 11.
- **A coding runtime: the Codex CLI** (`@openai/codex`, version **0.154.0** when this was written).
  It is not an npm dependency of this repository: you install it globally and authenticate it
  yourself. See [Coding runtime](#coding-runtime).
- **Git** on `PATH`. The harness runs real `git` commands: it records a base commit, clones the
  repository into the run directory, and creates a branch there.
- **Platform support, stated as it is.** Development, the full offline gate, and every recorded
  verification have run on **Windows 11 with Node 24.14.1** (PowerShell and Git Bash), which is the
  only platform verified by hand. CI runs the same offline gate on `ubuntu-latest`, so the suite is
  exercised on Linux on every push, but no live coding turn has been run on Linux here. macOS is
  **not verified at all**. POSIX code paths are written and unit-tested, not platform-verified —
  see [What is verified, and what is not](#what-is-verified-and-what-is-not).

Windows needs one thing spelled out, because it surprises people: a `run` started by another
program (an IDE, a supervisor, this repository's own tests) is in a process group of its own, and
Ctrl+C is not delivered to it. **Ctrl+Break is**, and the harness listens for it (`SIGBREAK`) as
well as for Ctrl+C and `SIGTERM` on other platforms.

## Installation

```sh
nvm use          # or install Node 24 another way
npm ci           # installs from package-lock.json, and nothing else
npm run build    # compiles src/ to dist/
```

`npm ci` is offline-safe and needs no credentials. `npm run build` produces the artifact every
documented command runs: `dist/cli.js`, the file `npm start` executes. `npm run dev` runs the same
CLI from TypeScript sources through `tsx` if you would rather not build.

## Commands

| Script                 | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `npm start`            | Run the built CLI (`dist/cli.js`).                               |
| `npm run dev`          | Run the CLI from TypeScript sources via `tsx`.                   |
| `npm run build`        | Compile `src/` to `dist/`.                                       |
| `npm run typecheck`    | Type-check sources and tests without emitting.                   |
| `npm run lint`         | ESLint, including the dependency boundaries below.               |
| `npm test`             | Run the offline suite once. Needs no credentials.                |
| `npm run test:watch`   | Run the offline suite in watch mode.                             |
| `npm run format:check` | Check formatting without writing.                                |
| `npm run validate`     | Format, lint, typecheck, build, test — the gate CI runs.         |
| `npm run test:live`    | The opt-in **live** check: builds, then drives a real Codex CLI. |

`npm start -- --help` prints the full usage text, and `npm start -- run` with a missing option
prints a usage error and exits `2`.

## `check-config`: validate the two input files

```sh
npm start -- check-config --config harness.config.json --task examples/task.json
```

```
check-config: /home/you/project/harness.config.json is valid
  workDir                /home/you/project/.harness (resolved from this file)
  maxRepairs             2
  taskTimeoutMinutes     60
  commandTimeoutMinutes  10
  setup                  1 command
  checks                 2 commands
check-config: /home/you/project/examples/task.json is valid
  id                     example-001
  title                  Add a greeting function
  acceptanceCriteria     2 item(s)
```

Every path it prints is the one it really read: `/home/you/project` stands for the checkout you run
this in, and the resolved `workDir` is spelled out so you can see where a run would write before you
start one. `check-config` is **static**. It creates no directory, runs no configured command,
contacts no provider, and needs no credentials. Inputs are rejected rather than repaired: unknown
keys, wrong types, blank text, invalid limits, and malformed command arrays all fail with the file
and field named, and no value is coerced or interpolated. Exit codes: `0` both files are valid, `1` a
file could not be read or is invalid, `2` a missing or unknown option.

`harness.config.json` and `examples/task.json` are the working examples; their format is defined in
[docs/WORKFLOW.md](docs/WORKFLOW.md) §1–2. That document is the contract — this README does not
restate it.

## `run`: the workspace, check, and repair loop

```sh
npm start -- run --repo ../target-project --config harness.config.json --task examples/task.json
```

Everything the run needs is loaded and validated **before anything is started**, and the loaded
configuration and task stay fixed for the whole run: nothing the working copy, the runtime, or the
target project writes can change which commands decide the result. Then:

1. **Preflight.** The source repository must be a clean Git checkout with a commit; the output
   directory must not be inside it.
2. **A run directory**, `<workDir>/<runId>`, holding the working copy, the logs, and (last) the
   report. `workDir` comes from the configuration file and resolves from that file's own directory.
3. **A working copy**: a clone of the source at its recorded base commit, on a dedicated branch
   `harness/<runId>`. Only committed content is inherited.
4. **The baseline round**: every `setup` command, then every `checks` command, in the order the
   configuration lists them. A red baseline stops the run before any coding turn — the task is not
   attempted on a project that is already failing.
5. **Coding turns**: one fresh `codex exec` invocation per top-level turn, started in the working
   copy. The implementation turn is given the task; each repair turn is given the failures the
   harness observed for itself.
6. **A post-agent round** after every turn: `setup` again, then every check.
7. **The final report**, written once, plus the change summary of the retained working copy.

The run ends at the first of: a green round, a red round with no repair allowance left, a failure
it cannot repair away, the task deadline, or your interrupt.

### Repair counting

`maxRepairs` counts **additional top-level coding turns after the implementation turn**, and
nothing else. `maxRepairs: 2` therefore allows at most three coding turns: the implementation and
two repairs. A repair turn is given only a **completed red round** — the commands the harness
observed to exit nonzero, with the output they wrote. A command that could not be executed, was
stopped, or ran out of time is an infrastructure failure, not repair feedback, and stops the run
instead. `repairsUsed` in the report is counted from the recorded turns, never from a number the
caller supplies.

### Deadlines and interrupts

- `taskTimeoutMinutes` bounds the **whole run**: setup, coding turns, and checks together.
- `commandTimeoutMinutes` bounds each **single** configured command, capped by the task time left
  when it starts — the remaining task time always wins.
- A limit that expires is a **`failed` run** with a `timeout` record saying which limit expired, in
  which phase, and whether the execution it stopped was confirmed to have ended. It is never
  reported as a red check round, and an exit code the harness cut short means nothing either way.
- Ctrl+C (Ctrl+Break on Windows, `SIGTERM` elsewhere) asks the run to stop and the command **waits
  for the run to finalize** before exiting: the report is written, the stop is recorded, and the
  exit code is `130`. A second interrupt says the run is already stopping rather than killing it.
- A stop the harness cannot confirm is recorded as `unconfirmed` with what could not be confirmed.
  It is never rounded down to "stopped": a working copy that may still be written to is not safe to
  reuse, and the report says so.

### Exit codes

| Code  | Meaning                                                                     |
| ----- | --------------------------------------------------------------------------- |
| `0`   | The run passed.                                                             |
| `1`   | The run failed, or an input, preflight, or reporting error stopped the CLI. |
| `2`   | Usage error: an unknown command or option, or a missing value.              |
| `130` | The run was stopped by the user, and was finalized first.                   |

No arguments and `--help` print help and exit `0`. A report that could not be written is reported
with a nonzero code and the run directory that was kept: the CLI never prints a successful
completion, and never names a report that does not exist.

### What a run leaves on disk

```
<workDir>/<runId>/
  workspace/                     the working copy: a clone, on branch harness/<runId>
  result.json                    the final report, written last
  logs/
    run.log                      the run's timeline, one line per state change
    agent-implementation.log     the useful output of the implementation turn
    agent-repair-1.log           …one file per repair turn, never overwritten
    baseline-setup-1.stdout.log  per command invocation, both streams, kept complete
    baseline-check-1.stdout.log
    attempt-1-setup-1.stdout.log
    attempt-1-check-1.stdout.log
    attempt-2-check-1.stdout.log
    …                            .stderr.log beside each, and one pair per configured command
```

A run ID is generated (`run-<UTC timestamp>-<8 hex>`) and never comes from task text, so no task can
decide where a run writes. `run.log` holds lines such as `baseline check-round result: passed`,
`implementation turn result: completed`, `post-agent check-round result: failed, 1 of 1 check
passed`, and `final status: passed, every configured check passed after the implementation turn`.
Command output is never copied into it.

`result.json` carries the evidence in the shape the run observed it: the task, the source repository
and its base commit, the working copy and its branch, the baseline round, one entry per coding turn
with its own agent-log path and the check round observed after it, the repairs used, the timeout or
cancellation record when there is one, and the change summary. It points at the log files rather
than copying them.

### Inspecting what was kept

Nothing is deleted for you, and nothing is cleaned up automatically.

```sh
# What changed, and what needs a human look
cat <runDir>/result.json              # status, reason, repairsUsed, attempts, changes
cat <runDir>/logs/run.log             # what happened, in order

# The work itself: a real clone, on its own branch, still checked out
cd <runDir>/workspace
git status && git diff <baseCommit>   # uncommitted work is left uncommitted
```

`changes.paths` lists every path that differs from the recorded base commit;
`changes.highlighted` picks out the ones that touch **tests, tooling, or configuration**, because a
change to those can change what the checks that decided the run actually did. `changes.warnings`
records, in the report itself, what the run's status does and does not prove.

## Try it on a disposable project

This is the offline-verified example: a throwaway project with a committed, green baseline, and an
output directory **outside** the source repository. Follow it somewhere you do not mind leaving
behind, then delete it.

**1. A disposable target project** with its own setup step and check runner (all four files are
plain ES modules, and the project has no dependencies):

```sh
mkdir -p /tmp/nexus-demo/tiny-project/src /tmp/nexus-demo/tiny-project/test /tmp/nexus-demo/tiny-project/tools
cd /tmp/nexus-demo/tiny-project
git init --initial-branch=main
cat > .gitignore <<'EOF'
build/
EOF
cat > src/greet.mjs <<'EOF'
export function greet(name) {
  return `Hello, ${name}!`;
}
EOF
cat > test/greet.test.mjs <<'EOF'
import assert from 'node:assert/strict';
import { greet } from '../src/greet.mjs';

assert.equal(greet('Ada'), 'Hello, Ada!');
console.log('greet: ok');
EOF
cat > test/greet-all.test.mjs <<'EOF'
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// The task's acceptance test. It reports the feature as missing and passes while
// src/greet-all.mjs is absent, which is what makes the committed baseline green;
// once the module exists this test imports it and asserts the real criteria.
const location = new URL('../src/greet-all.mjs', import.meta.url);

if (!existsSync(location)) {
  console.log('greet-all: skipped, the feature is not here yet');
} else {
  const { greetAll } = await import(location.href);
  assert.equal(greetAll(['Ada']), 'Hello, Ada!');
  assert.equal(greetAll(['Ada', 'Grace']), 'Hello, Ada and Grace!');
  assert.equal(greetAll([]), 'Hello, nobody!');
  console.log('greet-all: ok');
}
EOF
cat > tools/run-checks.mjs <<'EOF'
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

mkdirSync('build', { recursive: true });
const files = readdirSync('test').filter((name) => name.endsWith('.test.mjs')).sort();

let failed = 0;
for (const file of files) {
  const child = spawn(process.execPath, [path.join('test', file)], { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('close', resolve));
  failed += code === 0 ? 0 : 1;
}
console.log(`run-checks: ${files.length - failed} of ${files.length} test files passed`);
process.exitCode = failed === 0 ? 0 : 1;
EOF
git add --all && git commit --quiet -m 'tiny-project: baseline'
node tools/run-checks.mjs      # green before any run: 2 of 2 test files passed
```

**2. The harness inputs**, outside the project. `workDir` resolves from the configuration file's
own directory, which is exactly why the output can be kept out of the source repository:

```sh
mkdir -p /tmp/nexus-demo/harness && cd /tmp/nexus-demo/harness
cat > harness.config.json <<'EOF'
{
  "workDir": "./runs",
  "maxRepairs": 2,
  "taskTimeoutMinutes": 30,
  "commandTimeoutMinutes": 5,
  "setup": [],
  "checks": [["node", "tools/run-checks.mjs"]]
}
EOF
cat > task.json <<'EOF'
{
  "id": "greet-all",
  "title": "Add a greetAll helper to tiny-project",
  "description": "tiny-project needs a greetAll helper that greets several names in one sentence, following the conventions of src/greet.mjs.",
  "acceptanceCriteria": [
    "src/greet-all.mjs exports greetAll(names).",
    "greetAll(['Ada']) is 'Hello, Ada!'.",
    "greetAll(['Ada', 'Grace']) is 'Hello, Ada and Grace!'.",
    "greetAll([]) is 'Hello, nobody!'.",
    "The project's own checks (node tools/run-checks.mjs) exit 0."
  ]
}
EOF
node /path/to/nexus/dist/cli.js check-config --config harness.config.json --task task.json
```

**3. Run it.** From a checkout of this repository, after `npm ci && npm run build`:

```sh
npm start -- run --repo /tmp/nexus-demo/tiny-project --config /tmp/nexus-demo/harness/harness.config.json --task /tmp/nexus-demo/harness/task.json
```

**4. What it prints.** Progress lines come from the run's own timeline as it goes, then:

```
run run-20260101000000-1a2b3c4d: passed
  reason     every configured check passed after the implementation turn
  repairs    0 of 2 repair turns used
  run dir    /tmp/nexus-demo/harness/runs/run-20260101000000-1a2b3c4d
  workspace  /tmp/nexus-demo/harness/runs/run-20260101000000-1a2b3c4d/workspace (branch harness/run-20260101000000-1a2b3c4d)
  report     /tmp/nexus-demo/harness/runs/run-20260101000000-1a2b3c4d/result.json
```

That layout is the real one — `<workDir>/<runId>` with `workspace/`, `result.json`, and `logs/`
inside it — and it sits outside `/tmp/nexus-demo/tiny-project`. The run above was produced and
checked **offline**, with the runtime boundary substituted by a stand-in `codex` on the CLI's
`PATH` (the same boundary the end-to-end suite uses). It is not a live Codex result; a live run
needs your own account, and the printed paths are always derived from the run directory the CLI
really allocated.

**5. Look at it, then delete it.**

```sh
cat /tmp/nexus-demo/harness/runs/*/result.json
git -C /tmp/nexus-demo/harness/runs/*/workspace log --stat   # the turn's commits, if it made any
rm -rf /tmp/nexus-demo                                        # nothing was cleaned up for you
```

## Safety, limits, and what a run does to your machine

Read this before pointing a run at anything you care about.

- **Configured commands execute target-project code.** `setup` and `checks` are started as real
  processes, in the working copy, with your user's privileges and no sandbox. The runtime's own
  `--sandbox workspace-write` constrains the _runtime's_ file writes; it does not constrain your
  configured commands. Treat a target project's configuration the way you would treat a script you
  are about to run.
- **A clone is not a sandbox.** The working copy is a separate directory and a separate branch, so
  your source checkout is not where the work happens — but the code in it runs as you, and it can
  write anywhere your user can.
- **Do not use production or publishing credentials.** Configure a disposable account for the
  runtime. A coding turn reads your repository's content and sends it to the provider as part of
  the task, and nothing here is designed to hold a credential you would not paste into a prompt.
- **A `passed` run still needs human review.** `passed` means the configured checks exited `0` for
  the retained working copy, and nothing more: it is not a statement that the change is correct, and
  it is not an audit. The harness does not decide whether a changed test still tests the right
  thing. Read the diff, starting with the paths `changes.highlighted` names.
- **There is no automatic resume.** Every top-level turn is one fresh `codex exec` invocation, and
  no session is continued. A run that stops does not pick up where it left off, and nothing about it
  can be resumed by running the command again: a new invocation is a new run, with a new clone at
  the recorded base of the source repository as it is _then_.
- **The harness never commits, pushes, or publishes anything.** What a coding turn commits inside
  the working copy is that turn's own doing, and it stays in the working copy. No remote is added,
  and no pull request is opened.
- **Run directories are kept, not cleaned up.** They accumulate: each holds a full clone plus logs.
  Remove them by hand when you have read them.
- **An interrupted or crashed run can leave an incomplete run directory.** A run directory can exist
  without `result.json` — the process was killed, the machine went down, or the report itself could
  not be written. That directory is not evidence of a status: read `logs/run.log` (it is flushed as
  the run goes) and treat the working copy in it as a leftover, not as a result.
- **Check for leftover processes before reusing anything.** A run that was interrupted tries to stop
  what it started, and records whether that stop was _confirmed_. When the record says
  `unconfirmed`, something it started may still be running and may still be writing inside that
  working copy — find it and stop it (for example `Get-Process node`, or `ps`) before you reuse or
  delete the directory.
- **One run at a time per source repository.** The harness takes no lock: two runs over the same
  repository, with the same output directory or the same working tree, can interfere with each
  other's work.
- **Not implemented, and not planned here:** Jira or any other intake, pull-request publication, a
  provider registry, workflow engines, and background services. There is exactly one runtime
  interface (the Codex CLI) and exactly one loop.

## What is verified, and what is not

**Verified offline, in this repository, with no credentials and no provider contact:**

- the built CLI (`node dist/cli.js`, the file `npm start` runs) end to end against a disposable
  repository — argument parsing, Git, the working copy, the configured commands, the reports, the
  logs, and the exit codes — with a single substituted boundary: the executable named `codex` on the
  CLI's `PATH` (`tests/cli.integration.test.ts`, `tests/fixtures/`). Nothing in `src/` knows the
  stand-in exists, and no flag reaches it.
- real OS interrupt delivery to a running `run` (Ctrl+Break via a console control event on Windows,
  `SIGINT` elsewhere), with the run's own records read back afterwards.
- the input contract, the module boundaries, the check rounds, the process-tree stop, the reporting,
  and the runtime adapter's own contract — including that a repair turn is handed the failures the
  harness observed.

**Verified live (`npm run test:live`), and therefore not verified here:** that the same code works
against a real Codex account, a real model, and real repository changes. That is T16's job, and it
is recorded separately. `npm run test:live` builds `dist/` and then runs
`tests/live/codex-live-check.ts`: it prepares two disposable repositories, drives the built CLI
against them with the real runtime, and reads back what the runs left behind.

Its **prerequisite gate runs first and fails loudly**: with no runtime it can start, or no account
evidence (`CODEX_API_KEY`, or an authentication file where `CODEX_HOME` points), it prints every
missing prerequisite and exits `2` without invoking anything, saying in as many words that nothing
was verified and that this is not a pass. An unexecuted live check is never a passing one. The gate
is verified offline in `tests/live-verifier.test.ts`, including that `npm test`, `npm run validate`,
and CI never reach the live entry point at all.

**Not verified anywhere yet:**

- any live coding turn on Linux or macOS, and any macOS behaviour at all;
- live runs against a real account (T16): the reports, turn counts, and repair evidence a live run
  produces have not been observed on this machine;
- behaviour on a runtime version other than the 0.154.0 interface this adapter was written against.

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
  dump is persisted anywhere. The live check's prerequisite gate looks only at whether a credential
  _source_ is present, and never opens one.
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

## Toolchain

Node 24.14.1, TypeScript 6.0.3, ESLint 10, Prettier 3, Vitest 5, Zod 4, and tsx.

TypeScript is pinned to the 6.0 line on purpose: TypeScript 7 is newer, but `typescript-eslint`
8.70 still declares `typescript >=4.8.4 <6.1.0`, so 6.0.3 is the newest release the whole
toolchain supports. Dependencies are pinned by `package-lock.json`; use `npm ci`.

CI (`.github/workflows/ci.yml`) runs on `ubuntu-latest` with the Node version `.nvmrc` records,
installs with `npm ci`, and runs `npm run validate` — format, lint, typecheck, build, and the
offline suite. It needs no credentials, and `npm run test:live` is deliberately not part of it.

## Documentation

- [AGENTS.md](AGENTS.md) — working agreement for this repository.
- [docs/spec.md](docs/spec.md) — what the harness does and its limits. **Authoritative.**
- [docs/architecture.md](docs/architecture.md) — code placement and extension points.
- [docs/WORKFLOW.md](docs/WORKFLOW.md) — the loop and the JSON input contract. **Authoritative**;
  this is documentation for people. The runtime reads plain JSON, with no Markdown parsing and no
  workflow language.
- [docs/tasks.md](docs/tasks.md) — the ordered backlog and the completion notes, including what
  each task verified and what it could not.
- [docs/scaffold-request.md](docs/scaffold-request.md) — the task that produced this scaffold.

## Next task

T16: the opt-in live Codex implementation and repair exercise — run `npm run test:live` against an
approved account and a disposable repository, and record its exit code, runtime version, run IDs,
report locations, turn counts, and observed results. Without a usable runtime or account it stays
unchecked, and the missing prerequisite is reported instead.
