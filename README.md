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
  yourself. The harness starts it with a launch you configure — `codex` on `PATH` by default, or a
  path and a native profile of your choosing. See [Coding runtime](#coding-runtime).
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
contacts no provider, needs no credentials, and reads no native profile or authentication file.
Inputs are rejected rather than repaired: unknown keys, wrong types, blank text, invalid limits,
malformed command arrays, an unsupported `agent` runtime, and an empty or blank `agent` command all
fail with the file and field named, and no value is coerced or interpolated. The path rules for an
`agent` executable are applied exactly as a run would apply them, though the resolved prefix is not
printed. Exit codes: `0` both files are valid, `1` a file could not be read or is invalid, `2` a
missing or unknown option. `--task` is optional: without it, the configuration alone is validated —
which is what a `source` command needs, and what you run before pointing the harness at a Jira queue.

`harness.config.json` and `examples/task.json` are the working examples; their format is defined in
[docs/WORKFLOW.md](docs/WORKFLOW.md) §1–2. That document is the contract — this README does not
restate it.

### Selecting the launch

The six required fields describe the task and the commands that decide it. The optional `agent`
object selects what the coding turns are started with:

```json
{
  "agent": {
    "runtime": "codex",
    "command": ["codex", "--profile", "deepseek", "--model", "deepseek-flash"]
  }
}
```

`runtime` names the adapter; `codex` is the only one implemented, and another value is rejected
rather than run through the Codex adapter. `command` is a **launch prefix**, not a command line: the
first item is the executable, the rest are literal arguments passed to it unchanged, and the harness
appends its own arguments and writes the prompt to standard input. So a prefix can select an
installed Codex, a compatible wrapper, a native profile, or a model — and it cannot change what a
turn is. The prefix is recorded in `result.json` and once in `logs/run.log`, so **do not put a
credential in it**: keys belong in the environment the runtime inherits (for the example above,
`DEEPSEEK_API_KEY`), never in a task file, a configuration file, or a launch argument (docs/spec.md
§5).

Path rules for the executable: a bare name (`codex`) is resolved from `PATH` by the host launcher; a
relative path **containing a separator** resolves against the configuration file's own directory,
once, before anything runs; an absolute path is used as supplied. The remaining arguments are opaque
— the harness does not guess which are paths, expand `~`, `$HOME`, or `%VARIABLE%`, or join the
prefix into a shell string. Omitting `agent` entirely means `{"runtime": "codex", "command":
["codex"]}`, which uses your ordinary Codex defaults.

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
5. **Coding turns**: one fresh invocation of the configured launch per top-level turn, started in
   the working copy and never asking for approval. The implementation turn is given the task; each
   repair turn is given the failures the harness observed for itself. Every turn of the run uses the
   same selection.
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

The `source` commands use the same codes. A `source run` that processed only handled failures,
invalid task descriptions, or a failed publication exits `1`; a watch stopped with Ctrl+C exits
`130`.

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

## `source`: tasks from a Jira queue

A source command takes work from outside and hands it to the **same** loop. It finds eligible
issues, maps each one onto the existing four-field `Task`, claims it, runs it exactly as `run` would,
and posts a compact result back. Only the intake is new: the working copy, the checks, the coding
turns, the repairs, the deadline, the logs, and the report are the ones described above.

```sh
# Static: validates the configuration, the source object included. No credential, no network.
npm start -- check-config --config harness.jira.config.json

# Read-only preview: contacts Jira, claims nothing, starts no run, costs no coding turns.
npm start -- source list --config harness.jira.config.json

# One finite batch, run sequentially. --limit bounds fresh attempts, not the whole queue.
npm start -- source run --repo ../target-project --config harness.jira.config.json --limit 1

# Scan, run the batch, wait, and scan again until you stop it (Ctrl+C).
npm start -- source watch --repo ../target-project --config harness.jira.config.json
```

`source list` needs only `--config`. `source run` and `source watch` also need `--repo`, which is
the one repository every fetched issue is bound to, and they reject `--task`: a source task comes
from Jira, not from a file. The whole batch is discovered **before** any issue is claimed, and the
runs are strictly sequential.

The queue is the configuration's `source` object, and nothing else:

```json
{
  "source": {
    "type": "jira",
    "siteUrl": "https://your-site.atlassian.net",
    "cloudId": "9337c4da-7d33-4c1d-b03c-db207e537f88",
    "projectKey": "SAM1",
    "label": "harness-task",
    "pollIntervalSeconds": 30
  }
}
```

`issueType` (`Task`), `label` (`harness-task`), `readyStatus` (`To Do`), `runningStatus`
(`In Progress`), `reviewStatus` (`In Review`), `pollIntervalSeconds` (`30`, at least `5`), and
`tokenEnv` (`JIRA_API_TOKEN`) have the documented defaults, so the minimum is `type`, `siteUrl`,
`cloudId`, and `projectKey`. `docs/WORKFLOW.md` §5 is the contract; `docs/harness.jira.example.json`
is a credential-free example, and `examples/jira-description.md` shows the description format an
issue must use.

**Running the harness on this repository itself** works, as long as the checkout is clean and the
output stays outside it: the operator's live config sits at the repository root as
`harness.jira.config.json`, is gitignored (an untracked file would make this checkout dirty for
preflight), and points `workDir` at a sibling directory — `../nexus-jira-runs` — so no run
directory is ever created inside the source.

**Authentication is a service account, not your account.** Create a Jira service account, give it
access to the project, and create an **API token** with the classic scopes `read:jira-work` and
`write:jira-work`. The harness sends it as `Authorization: Bearer <token>` to the Atlassian gateway,
`https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...` — there is no direct
`*.atlassian.net/rest/api` route, no Basic authentication, and no email address. Put the token in
the environment variable the configuration names (`JIRA_API_TOKEN` by default) for the command, and
never in a file:

```powershell
$secure = Read-Host "Jira service-account API token" -AsSecureString
$env:JIRA_API_TOKEN = [System.Net.NetworkCredential]::new("", $secure).Password
Remove-Variable secure
```

The token is read only for a `source` command, is never written to a report, a log, or a receipt,
and is **removed from the environment** of the workspace's setup commands, checks, and coding turns.
A `run --task` invocation, and `check-config`, never resolve it and never contact Jira.

**What one issue becomes.** `Task.id` is the issue key, `Task.title` the summary, `Task.description`
the description rendered as readable text, and `Task.acceptanceCriteria` the items listed under the
`Acceptance criteria` heading. Everything else in the description — `Goal`, `Verification`,
`Constraints` — is context for the agent and for your review: **no Jira text becomes a command, a
repository, an agent argument, or a limit**, and the harness still runs the checks from its own
configuration. An issue whose description does not fit the documented format is reported and
skipped; it is never guessed at and never launched.

**What Jira sees.** On a confirmed claim the issue moves from the ready status to the running
status. When the run ends — `passed`, `failed`, or `cancelled` alike — one compact comment carries
the run ID, the exact outcome and reason, the check summary, the repairs used, and the local
artifact paths, and the issue moves to the review status. `In Review` means "a local attempt
finished and needs a human", not success. The check summary names the last round that ran, and says
so in as many words when the run was stopped before any round followed its last turn: a stopped turn
has no checks to report, and the round the run started with is not one. **Nothing here moves an
issue to Done**, and nothing commits, merges, or publishes anything.

**Nothing runs twice.** `.intake/receipts/<hash>.json` under `workDir` records each attempted issue
by its immutable ID, and a receipt is created **before** the issue is claimed. A receipt survives a
restart, and editing or reopening the issue does not clear it. A single `.intake/lock/` directory
makes sure only one consumer uses an output directory; it is never broken automatically. To
deliberately retry one issue: stop the watcher, inspect and stop prior processes, keep the run
artifacts, delete only that issue's printed receipt file, and put the issue back to the ready
status. Never remove the whole `.intake` directory to fix one task.

Scans are periodic and pause during a batch, so a new issue is picked up on the next scan rather
than instantly. `source list` and `source run` report a failed read and exit nonzero; `source watch`
retries one with a bounded backoff that respects the server's `Retry-After`. An authentication,
workflow, uncertain-write, or delivery failure stops intake for a human instead of being retried
behind your back. Each run still clones the source checkout's committed `HEAD` **as it is then**:
separate runs do not inherit each other's uncommitted work.

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
  `--sandbox workspace-write` constrains the _runtime's_ file writes, and the harness always adds
  `--ask-for-approval never`: an unattended run never waits for a prompt, so an action outside that
  sandbox fails the turn instead of pausing for you. Neither setting constrains your configured
  commands. Treat a target project's configuration the way you would treat a script you are about
  to run.
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
- **`source` commands add one small lock, and it only covers one output directory.** A
  `.intake/lock/` under `workDir` keeps two consumers out of the _same_ output directory; it is not
  a distributed lock, and two watchers with different `workDir`s against the same Jira queue are
  unsupported. Jira statuses are not a lease either: there is no exactly-once guarantee across
  machines, and the receipts only protect the directory they live in.
- **A ready issue is an authorization to spend agent capacity.** The configured project, issue
  type, label, and ready status are the queue boundary, and the harness does not ask again: put
  only work you would run yourself behind that label, in a project whose issues are trusted input.
  Issue text is context for the coding turn and for review; it can never choose a repository,
  a command, an environment variable, or a limit — but the turn still reads it and can act on its
  content inside the working copy.
- **Not implemented, and not planned here:** pull-request publication, a provider registry,
  workflow engines, background services, webhooks, parallel consumers, and a second coding runtime.
  There is exactly one runtime interface (the Codex CLI), exactly one loop, and exactly one
  implemented task source (Jira).

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
- the Jira intake path, against a fake Jira REST API v3 boundary: the gateway route and Bearer
  header, the queue JQL and its pagination, the description format and the mapping onto the existing
  `Task`, transition selection by target status, the result comment, the per-issue receipt and the
  one-consumer lock, a finite `source run`, a watch cycle that picks up a later issue, and the
  behaviour of a stop, a failed feedback, and a corrupt receipt. Nothing in that suite needs a Jira
  site, a token, or a network.

**Verified live (`npm run test:live`) on 2026-09-16, through the DeepSeek launch this checkout
selects:** Codex CLI 0.154.0 answered a read-only connectivity probe, and both exercises then passed
against disposable repositories — a real implementation whose post-agent round was green
(`run-20260916192927-5fdfa140`, one turn, zero repairs), and a real repair after the fixture's
injected failure (`run-20260916192944-72e7e822`, two turns, one repair), with the reports, timelines,
per-turn agent logs, and retained working copies read back. That evidence is recorded in
the live check's own output, which this document does not restate. A deliberately out-of-bounds action was exercised the same
way (`run-20260916194015-9fce84bf`): a disposable task asking the turn to write
`C:\Users\User\nexus-sandbox-probe.txt` produced three refused attempts
(`System.UnauthorizedAccessException`, access denied), no file on disk, and a turn that reported the
refusal and ended normally — nothing hung waiting for an approval nobody was there to give. It is a
Codex CLI + DeepSeek result: not OpenAI-backed inference, and not Claude Code.

`npm run test:live` builds `dist/` and then runs `tests/live/codex-live-check.ts`: it prepares two
disposable repositories, drives the built CLI against them with the selected runtime, and reads back
what the runs left behind.

```sh
npm run test:live                                    # the ordinary Codex launch, documented defaults
npm run test:live -- --config harness.config.json    # the agent, limits, and allowance that file selects
```

With `--config`, the verifier loads the file through the harness's own schema and path rules and
uses its `agent`, `maxRepairs`, `taskTimeoutMinutes`, and `commandTimeoutMinutes`. Its disposable
repository, output directory, task, setup, and checks stay its own: your configured project's
commands are never run and its `workDir` is never written to. A configuration that allows no repair
turn is refused before any paid work, because this verifier exists to exercise a real repair.

Its **prerequisite gate runs first and fails loudly**: when the selected launcher cannot be started,
or a supplied configuration cannot be used, it prints every problem and exits `2` without invoking
anything, saying in as many words that nothing was verified and that this is not a pass. An
unexecuted live check is never a passing one. There is no account prerequisite: a runtime can
authenticate in ways a file check cannot see, so the bounded invocation inside each exercise — and
not the presence of a key file — is what establishes that the selected runtime really works. The
gate is verified offline in `tests/live-verifier.test.ts`, including that `npm test`,
`npm run validate`, and CI never reach the live entry point at all.

**Verified live for Jira reads on 2026-09-17**, against the operator's own queue (`HARN`, on a site
whose default language is not English): `npm run dev -- source list --config harness.jira.config.json`
read the real queue through the scoped service-account token and listed `HARN-1`. The first run
reported it `stale`: the queue's JQL matched the canonical names (`To Do`, `Task`) while the site
answered with translated ones (`待办`, `任务`), because the client left the language to `fetch`, which
sends `accept-language: *` and so received the site's default language. With the connector asking
for one language explicitly, the same live command reports the issue `valid and unattempted`.
Nothing was claimed, no run directory was created, and no coding turn was started: that is a read,
and only a read.

**Not verified anywhere yet:**

- any live coding turn on Linux or macOS, and any macOS behaviour at all;
- live runs through a provider other than the one configured on this machine, and any profile or
  gateway the operator has not installed;
- **any live Jira write.** The read half has been exercised live (below); no issue has been claimed,
  commented on, or transitioned, no `source run` or `source watch` has run against a live site, and
  the supervised exercise in
  [docs/implement-task-source-connectors.md](docs/implement-task-source-connectors.md) §S07 has not
  been run. Mocked tests are not evidence that the live write path works;
- behaviour on a runtime version other than the 0.154.0 interface this adapter was written against,
  and any runtime-reported model identity: a profile or model name in a report is launch
  information, not proof of which upstream model served a response.

## Coding runtime

The coding turn is the host's own Codex CLI, driven through its documented non-interactive form.
One interface was selected — the **CLI**, not the SDK — because it is the supported way to run a
single non-interactive turn on this platform and needs no extra client library in this repository.

- **Interface:** `codex exec` (`@openai/codex`, version **0.154.0** when this was written, which
  publishes a `win32-x64` build). The adapter invokes exactly
  `<your launch prefix> --ask-for-approval never exec --sandbox workspace-write --json -`, started
  **in the working copy**, with the prompt written to standard input. `--json` makes the runtime
  write one JSON event per line to standard output; its progress goes to standard error; the turn
  ends when the runtime exits. Nothing is interpolated and no shell is involved beyond what a
  Windows `.cmd` shim already requires.
- **Non-interactive by construction.** `--ask-for-approval never` is the adapter's own argument, not
  a profile setting and not a configuration field, so a run never waits for a human: an action the
  `workspace-write` sandbox does not allow fails the turn and stops the run. There is no
  `--dangerously-bypass-approvals-and-sandbox`, no fallback to a weaker sandbox, and no retry with
  one. On the installed CLI the approval option is accepted **before** the `exec` subcommand and
  rejected after it (`unexpected argument '--ask-for-approval'`), which is why it leads the
  adapter's own arguments rather than sitting beside `--sandbox`; the tracked documents
  [docs/WORKFLOW.md](docs/WORKFLOW.md) and [docs/architecture.md](docs/architecture.md) still spell
  the suffix without it.
- **Official references consulted:** [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  [CLI commands and flags](https://learn.chatgpt.com/docs/developer-commands?surface=cli) (`exec`,
  `--json`, `--sandbox`, `-o/--output-last-message`, `resume`), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
  and the `openai/codex` documentation served through the Context7 MCP server. `resume` and
  `--output-last-message` exist and are deliberately unused: every top-level turn is one fresh
  invocation, so continuing a session can never quietly buy extra turns.
- **Local setup and authentication (yours to do, outside this repository):**
  `npm install --global @openai/codex`, then `codex login` (or `codex login --with-api-key`, or set
  `CODEX_API_KEY`) for the ordinary OpenAI-backed defaults. Credentials live where the CLI keeps
  them — the ambient environment and `CODEX_HOME` — and the adapter passes that environment to the
  runtime untouched. **Authentication is never part of a task file, a configuration file, or this
  repository's code**, and nothing the adapter reads is copied into a log, a timeline, or a report:
  no key, no token, and no environment dump is persisted anywhere.
- **Selecting another Codex-backed provider**, as the checked-in `harness.config.json` does for
  DeepSeek on this machine: keep your ordinary Codex defaults for `codex` and add a native profile
  for the other provider, so nothing has to be restored afterwards. The profile is
  `<Codex home>/deepseek.config.toml` (`model`, `model_provider`, `model_catalog_json`, and a
  `[model_providers.deepseek]` table with `base_url`, `wire_api`, and `env_key`), the catalog is
  `<Codex home>/deepseek-models.json`, and the credential is the variable the profile names — here
  `DEEPSEEK_API_KEY`, set in the environment the harness itself is started in. The harness never
  writes native configuration, downloads a catalog, logs in, or reads a profile or credential file:
  it starts the prefix you configured and records that prefix. A profile is a layer over your
  ordinary settings, not a second installation, and a profile name in a report is not an observed
  model identity.
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

| File                 | Responsibility                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `src/cli.ts`         | Arguments, help, exit codes, top-level wiring. Owns all presentation.                    |
| `src/config.ts`      | Reads and validates the two JSON inputs; resolves `workDir`.                             |
| `src/types.ts`       | The data contracts. Data only: no imports, no runtime I/O.                               |
| `src/workspace.ts`   | Preflight, run directory allocation, the working copy, and the final change summary.     |
| `src/checks.ts`      | Setup/check command execution, process-tree stop, output capture.                        |
| `src/agent.ts`       | The coding runtime: one turn through the Codex CLI, normalized for the runner.           |
| `src/runner.ts`      | The order the work happens in: baseline, turns, checks, repair, deadlines, cancellation. |
| `src/report.ts`      | `result.json` and the logs under `<runDir>/logs`; reads back command output for repair.  |
| `src/source.ts`      | The task-source contract and the one serial coordinator: batch, watch, lock, receipts.   |
| `src/jira.ts`        | The Jira Cloud connector: search, reads, transitions, comments, service-account auth.    |
| `src/jira-format.ts` | The small ADF reader and the plain-text result comment builder.                          |

`src/cli.ts` depends on `config.ts` and `types.ts`; nothing depends on `cli.ts`. That boundary and
the "`types.ts` is data only" rule are enforced by `no-restricted-imports` entries in
`eslint.config.js`, and `tests/boundaries.test.ts` demonstrates one permitted and one rejected
import against fixtures in `tests/fixtures/boundaries/`.

The intake boundary is the `TaskSource` contract in `src/source.ts`. The coordinator knows ordinary
data and functions, the runner never imports Jira, and `cli.ts` selects the connector with one
explicit branch on `source.type`: a second source would be a concrete adapter plus configuration and
CLI wiring, not a change to `Task` or to the loop.

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
A push to a `task/**` branch also runs `.github/workflows/auto-pr.yml`: it opens the pull request
into `main`, runs the same gate, and merges the pull request only when the gate passed. What that
automation does and does not prove is written down in [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md).

## Documentation

- [AGENTS.md](AGENTS.md) — working agreement for this repository.
- [docs/spec.md](docs/spec.md) — what the harness does and its limits. **Authoritative.**
- [docs/architecture.md](docs/architecture.md) — code placement and extension points.
- [docs/WORKFLOW.md](docs/WORKFLOW.md) — the loop and the JSON input contract. **Authoritative**;
  this is documentation for people. The runtime reads plain JSON, with no Markdown parsing and no
  workflow language.
- [docs/implement-task-source-connectors.md](docs/implement-task-source-connectors.md) — the
  assignment that added Jira intake, including the opt-in live exercise that has **not** been run.
- [docs/implement-workspace-continuation.md](docs/implement-workspace-continuation.md) — the
  contract for workspaces that outlive runs, the workspace pointer label, and the escalation ladder.
  Its increments are not implemented yet.
- [docs/harness.jira.example.json](docs/harness.jira.example.json) — a credential-free source
  configuration to copy.
- [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md) — how changes to this repository are made: one
  `task/<name>` branch per task, merged into `main` through a pull request. It is about this
  repository only; a harness run never commits or pushes anything in a target repository.

## Next task

The 2026-09-16 extension added the optional `agent` selection, the selected-launch reporting, the
explicit no-approval policy, and now the Jira task source with `source list`, `source run`, and
`source watch`. What remains is listed under
[What is verified, and what is not](#what-is-verified-and-what-is-not) rather than promised here. The
first real piece of work is the **supervised live Jira exercise**, which has not been run: it needs a
service-account token, a disposable target repository, and an operator who has inspected the queue
before the first paid call. After that, a second coding adapter (Claude Code, with its own invocation
and event parser and its own tests — a Claude launcher behind the Codex parser would be a bug), live
turns on POSIX hosts, and stronger isolation before unattended runs of untrusted repositories.
Nothing here builds them ahead of a task that needs them.
