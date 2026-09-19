# nexus harness

A small, local-first coding harness. One CLI invocation takes an explicit development task,
prepares a working copy of a repository, runs that project's own setup and checks, asks the Codex
CLI to implement the task, reruns the checks, gives the runtime the observed failures to repair
within a bounded allowance, and keeps the working copy, the logs, and a final report on your disk.

Nothing leaves your machine except the coding turns themselves — a clone is made locally, the
configured commands run locally, and the harness never pushes, publishes, or integrates anything by
default: a coding turn may make small local commits, and they stay in the retained working copy. One
optional, explicitly configured delivery step can push a passed attempt's branch and open or update
its GitHub pull request; it never merges, and without that configuration nothing changes.

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
  repository into a workspace of its own (or reopens the workspace a continuation names), and works
  on that workspace's own branch.
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
2. **A run directory**, `<workDir>/runs/<runId>`, holding the logs and (last) the report, and a
   **workspace**, `<workDir>/workspaces/<workspaceId>`, holding the working copy beside it, with a
   ledger at `workspaces/<workspaceId>.json` recording its base, branch, and attempts. A fresh
   run's `workspaceId` is its own run ID; a continuation reuses the workspace its issue's pointer
   label names. `workDir` comes from the configuration file and resolves from that file's own
   directory.
3. **A working copy**: a clone of the source at its recorded base commit, in that workspace, on a
   dedicated branch `harness/<workspaceId>`. Only committed content is inherited. The clone is
   given a repository-local Git identity (`Nexus Agent <nexus@local>`, commit signing disabled)
   before anything runs in it, so the coding turns can commit as they go; nothing is pushed. A
   **continuation** — a source issue moved back to the ready status whose pointer label names a
   workspace this machine has — reopens that clone instead of making a new one, on its recorded
   branch and base, keeping the local commits and uncommitted changes earlier attempts left.
4. **The baseline round**: every `setup` command, then every `checks` command, in the order the
   configuration lists them. A red baseline stops a fresh run before any coding turn — the task is
   not attempted on a project that is already failing. A continuation may start red, because its
   workspace may already carry failed work, and only its post-turn round decides.
5. **Coding turns**: one fresh invocation of the configured launch per top-level turn, started in
   the working copy and never asking for approval. The implementation turn is given the task; each
   repair turn is given the failures the harness observed for itself. Every turn of the run uses the
   same selection, and every turn is asked to make small, meaningful local commits and to finish
   with the relevant work committed where practical. A commit is not a check result: the round below
   decides.
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
- Every Git step is bounded too: inside a run it gets the remaining task time and the run's own
  stop request, and a reading outside one — the source preflight, a continuation's branch check, the
  final comparison — runs under a fixed finite bound. A Git stopped at its limit is reported as that
  stop, with whether it was confirmed, instead of being waited for.
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
<workDir>/
  .intake/                       source intake: the one-consumer lock and the per-issue receipts
  runs/<runId>/
    result.json                  the final report, written last
    logs/
      run.log                    the run's timeline, one line per state change
      agent-implementation.log   the useful output of the implementation turn
      agent-repair-1.log         …one file per repair turn, never overwritten
      baseline-setup-1.stdout.log  per command invocation, both streams, kept complete
      baseline-check-1.stdout.log
      attempt-1-setup-1.stdout.log
      attempt-1-check-1.stdout.log
      attempt-2-check-1.stdout.log
      …                          .stderr.log beside each, and one pair per configured command
  workspaces/<workspaceId>/      the working copy: a clone, on branch harness/<workspaceId>
  workspaces/<workspaceId>.json  the workspace ledger: what it was cloned from, the item it was
                                 created for, and its attempts
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
cd <workDir>/workspaces/<runId>
git log --oneline <baseCommit>..HEAD   # what the turns committed, if anything
git diff <baseCommit>                  # the tracked diff against that base, committed or not
git status                             # plus untracked and staged state
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
runs are strictly sequential. Jira decides the order with its own Priority field: highest priority
first, then the oldest creation, then the issue key. The harness takes that order as the batch order,
so a priority change in Jira takes effect at the next scan and never reorders an active task or a
batch that was already discovered.

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
status. An attempt that ends normally publishes one compact comment — the run ID, the exact outcome
and reason, the check summary, the repairs used, and the local artifact paths — and while an
`escalation` ladder still has a rung to try that comment is the attempt's own, with the issue left in
the running status; the climb's last attempt — a pass, a terminal failure, or the rung that
exhausted the ladder — moves it to the review status. Two endings deliberately publish nothing and
move nothing, leaving the issue in the running status for a person: a run whose stopped executions
could not be confirmed to have ended, and an attempt whose required workspace ledger could not be
written. Both stop intake and keep the local result — the report, the logs, and the working copy —
with the receipt saying what failed. `In Review` means "a local attempt finished and needs a
human", not success. The check summary names the last round that ran, and says so in as many words
when the run was stopped before any round followed its last turn: a stopped turn has no checks to
report, and the round the run started with is not one. **Nothing here moves an issue to Done**, and
the harness merges nothing: without a delivery step, local commits a coding turn makes stay in the
retained workspace, and the comment says so.

**A ladder: a cheaper tier first, a stronger one after it.** The optional `escalation` array
declares tiers tried in order inside one claim, each with its own launch and repair allowance:

```json
{
  "escalation": [
    {
      "name": "flash",
      "agent": {
        "runtime": "codex",
        "command": ["codex", "--profile", "nexus-flash", "--model", "deepseek-flash"]
      },
      "maxRepairs": 2
    },
    {
      "name": "astra",
      "agent": {
        "runtime": "codex",
        "command": ["codex", "--profile", "nexus-astra", "--model", "gpt-6-astra"]
      },
      "maxRepairs": 2
    }
  ]
}
```

Flash runs the implementation and up to two repair turns; only when its post-agent checks are still
red does Astra run — in the **same retained workspace**, so the earlier commits and uncommitted work
are still in it — with its own two-repair allowance. Attempt N of an issue runs tier N, clamped to
the last tier, and the tier's own launch is what really starts and what its report records. Only an
exhausted ordinary red check round climbs: a setup, launch, authentication, or protocol error, a
cancellation, a timeout, and an unconfirmed cleanup all end the intake at the rung where they
happened rather than spending a stronger launch on them, and that attempt's result is then the
issue's last word — published and moved to review, except where a required local save failed or the
run's stop was not confirmed, which publish no comment and leave the issue in the running status. A
tier that names no `agent` or `maxRepairs` inherits the top-level one, and no `escalation` at all
means the single ordinary tier. The launch prefixes above are operator-native Codex profiles;
[nexus-agent-tools.md](docs/nexus-agent-tools.md) is how to install them, and the harness never reads
or writes them.

```sh
# One finite batch with the ladder: Flash first, Astra only if Flash's checks stay red.
npm start -- source run --repo ../target-project --config harness.jira.config.json --limit 1
```

**Delivering a passed attempt (optional).** Add a `delivery` object to have the harness push a
**passed** attempt's branch and open — or update — its pull request, so the work reaches GitHub
without you doing it by hand:

```json
{
  "delivery": {
    "type": "github",
    "repository": "your-org/your-repo",
    "baseBranch": "main"
  }
}
```

The step runs after the attempt passed and before Jira is told the result, so the result comment
carries the pull request URL. The destination's `gh` has to be authenticated for an account that may
write there (`gh auth status`, and `gh auth setup-git` so Git can use those credentials); the
harness stores no GitHub credential and never runs a login flow. A working copy that still holds
uncommitted files is **refused**, not committed for you, and a branch with no commit beyond the
workspace's base has nothing to publish. The pull request is found by repository, head branch, and
base branch — the one open match is updated, a closed or merged one is refused instead of edited,
and one is created only when no match exists at all. Later committed work updates the same branch
and the same pull request, because a continued attempt reuses the workspace and its branch. The
harness never merges it and never marks the issue Done. Delivery applies to source attempts only: a
`run --task` invocation clones afresh every time, so it has no stable branch to deliver and stays
local. `docs/WORKFLOW.md` §8 is the contract; delivery command output and the published body are
kept in the run's own `logs/` directory.

**Nothing runs twice by accident.** `.intake/receipts/<hash>.json` under `workDir` records each
attempted issue by its immutable ID, and a receipt is created **before** the issue is claimed. A
receipt survives a restart, and editing or reopening the issue does not clear it. Nor is a receipt
the whole story: what happens next is decided by the pointer label below — a receipt with no
pointer refuses the issue instead of silently repeating it. The single `.intake/lock/` directory
makes sure only one consumer uses an output directory; it is never broken automatically.

**Where an issue's work lives is written on the issue.** The run that creates a workspace adds one
`harness-ws-<workspaceId>` label, before any coding turn, and a later attempt only ever reads it.
That is what makes a rework possible: move an attempted issue back to the ready status and the
harness **continues its workspace** — the same clone, on the same branch, with the work of the
earlier attempt still in it, and a baseline that is allowed to be red, because continuing failed
work is the point. An attempted issue with no such label is not run again: the harness refuses it,
says why in a comment, and moves it out of the queue, so a stale ticket cannot quietly burn more
attempts. A pointer the harness will not follow is refused the same way, and the comment says which
of these it is: it is not a generated workspace id (a label is never read as a path), it names a
workspace this machine does not have, its directory or its ledger is a junction or symbolic link
out of `workDir/workspaces` (a pointer is never followed through one), the workspace's ledger
records another item, site, or repository (a workspace is continued only by what created it), or
the ledger records no item identity at all (a legacy ledger: add its `sourceItem` by hand —
`type`, `scope`, `id`, and `key`, from that workspace's first attempt report, whose `sourceRef`
records them — and scan again; the harness never adopts or migrates a workspace on its own). An
issue carrying two pointers is refused too, because there is no way to tell which one to continue.
The receipt stays as the audit trail behind all of it.

Putting an attempted issue back to the ready status is ordinary rework, not a retry of a dead run:
the harness continues the workspace its pointer names, with a new run directory and report. To start
over deliberately instead — a first attempt again, in a new workspace — stop the watcher, inspect
and stop prior processes, keep the run artifacts, delete only that issue's printed receipt file,
remove its `harness-ws-*` pointer label if it has one (otherwise the harness would continue the old
workspace instead of creating one), and put the issue back to the ready status. Never remove the
whole `.intake` directory to fix one task.

Scans are periodic and pause during a batch, so a new issue is picked up on the next scan rather
than instantly. `source list` and `source run` report a failed read and exit nonzero; `source watch`
retries one with a bounded backoff that respects the server's `Retry-After`. An authentication,
workflow, uncertain-write, GitHub-delivery, or result-feedback failure stops intake for a human
instead of being retried behind your back. A fresh run still clones the source checkout's committed `HEAD` **as it is then**;
a continued attempt instead works in the workspace its pointer names, and the commits and
uncommitted changes the earlier attempts left there are still in it.

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
  "workDir": ".",
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
  workspace  /tmp/nexus-demo/harness/workspaces/run-20260101000000-1a2b3c4d (branch harness/run-20260101000000-1a2b3c4d)
  report     /tmp/nexus-demo/harness/runs/run-20260101000000-1a2b3c4d/result.json
```

That layout is the real one — `<workDir>/runs/<runId>` for the evidence,
`<workDir>/workspaces/<workspaceId>` for the working copy beside it — and it sits outside
`/tmp/nexus-demo/tiny-project`. A later attempt of the same Jira issue continues that working copy
instead of cloning again when the issue carries its `harness-ws-<workspaceId>` pointer label; that
is the implemented contract in
[docs/implement-workspace-continuation.md](docs/implement-workspace-continuation.md) and the
operator-facing rules in [docs/WORKFLOW.md](docs/WORKFLOW.md) §7. The run above was produced and
checked **offline**, with the runtime boundary substituted by a stand-in `codex` on the CLI's
`PATH` (the same boundary the end-to-end suite uses). It is not a live Codex result; a live run
needs your own account, and the printed paths are always derived from the run directory the CLI
really allocated.

While a coding turn runs, the CLI also draws what the runtime is doing — its messages, short command
start and result lines, and the files it changed — in a fixed ten-line pane under the progress.
New lines scroll the oldest out, long lines are fitted to the pane, and control characters in
runtime text are never written as terminal commands. A redirected, too small, or too narrow terminal
gets those lines as ordinary output instead, with no cursor sequences at all; on every ending the
pane is taken away before the outcome block above is printed. The full runtime output always stays
in the turn's own `logs/agent-*.log`.

**5. Look at it, then delete it.**

```sh
cat /tmp/nexus-demo/harness/runs/*/result.json
git -C /tmp/nexus-demo/harness/workspaces/* log --stat   # the turn's commits, if it made any
rm -rf /tmp/nexus-demo                                        # nothing was cleaned up for you
```

## Safety, limits, and what a run does to your machine

Read this before pointing a run at anything you care about.

- **Configured commands execute target-project code.** `setup` and `checks` are started as real
  processes, in the working copy, with your user's privileges and no sandbox. The coding turn is
  **unsandboxed too**: it runs with `--sandbox danger-full-access` and `--ask-for-approval never`, so
  it can read and write anywhere your user can, exactly like a configured command. That is a
  deliberate, documented choice, not a fallback — the narrower `workspace-write` policy this CLI
  offers on Windows leaves the working copy's `.git` read-only, so a turn cannot stage or commit its
  work (`git add` fails on `.git/index.lock`; HARN-2). An unattended run still never waits for a
  prompt. Treat a target project's configuration the way you would treat a script you are about to
  run.
- **A clone is not a sandbox.** The working copy is a separate directory and a separate branch, so
  your source checkout is not where the work happens — but the code in it runs as you, and it can
  write anywhere your user can.
- **Do not use production or publishing credentials.** Configure a disposable account for the
  runtime. A coding turn reads your repository's content and sends it to the provider as part of
  the task, and nothing here is designed to hold a credential you would not paste into a prompt.
  The one credential a delivery step uses is the operator's own `gh`/Git one, and it is the reason
  to configure delivery only for a repository you would let an unattended harness write to: a passed
  attempt's branch is pushed there and its pull request is opened or updated, without asking again.
- **A `passed` run still needs human review.** `passed` means the configured checks exited `0` for
  the retained working copy, and nothing more: it is not a statement that the change is correct, and
  it is not an audit. The harness does not decide whether a changed test still tests the right
  thing. Read the diff, starting with the paths `changes.highlighted` names.
- **There is no automatic resume.** Every top-level turn is one fresh `codex exec` invocation, and
  no session is continued: a run that stops does not pick up where it left off, and re-running a
  `run --task` command is a new run, with a new clone at the source's commit as it is _then_. A
  Jira continuation is different: moving an attempted issue back to the ready status starts another
  attempt in the workspace its pointer names, against that workspace's recorded base, but it
  resumes no stopped process and recovers nothing automatically.
- **The harness pushes nothing unless you configure delivery, and it never merges.** The working
  copy is given a repository-local commit identity (`Nexus Agent <nexus@local>`, commit signing
  disabled) and its turns are asked to commit small pieces as they go — but those commits are the
  turn's own doing, local to the retained workspace, and no remote is added, so there is no default
  push destination. With a `delivery` object configured, the harness itself pushes a **passed**
  attempt's branch to the repository you named and opens or updates its pull request; it never
  force-pushes, never merges, never marks an issue Done, and never publishes anywhere else. Nothing
  here integrates the work for you.
- **Run directories and workspaces are kept, not cleaned up.** They accumulate: a run holds its logs
  and its report, and a workspace holds a full clone. Remove them by hand when you have read them.
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
- **Not implemented, and not planned here:** automatic merging, CI observation on a delivered pull
  request, a provider registry, workflow engines, background services, webhooks, parallel consumers,
  and a second coding runtime. Delivery opens or updates a pull request and stops there; a human
  merges it. There is exactly one runtime interface (the Codex CLI), exactly one loop, exactly one
  implemented task source (Jira), and exactly one optional delivery step (GitHub).

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
- workspace continuation through the same fakes and real temporary Git repositories: a continued
  attempt reopening the workspace its pointer label names and keeping its recorded base, the
  per-attempt run directories and ledger, the escalation ladder's tiers — the tier's own launch, each
  attempt's own comment while the issue stays in the running status, one review move when the ladder
  ends, the two endings that publish nothing and leave the issue where it is (a stop that was not
  confirmed, and a workspace ledger that could not be written), and the ladder's refusal to climb
  from a setup/launch/protocol error, a cancellation, or an expired limit — the guidance a continued
  attempt is told, the decision made from the item as it was just re-read rather than from the search
  result that discovered it, the pointer checks that refuse a malformed id, another item's, site's,
  or repository's workspace, and a ledger with no item identity, and the refusal of an attempted
  issue that names no workspace to continue.
- the optional GitHub delivery step, against disposable Git repositories with a local bare
  destination and a stand-in `gh` on `PATH`: the branch really moves to the destination, the pull
  request is created with the issue reference and the check summary, a repeated delivery finds and
  updates the same pull request instead of creating a second one, a workspace that still holds
  uncommitted work is refused with an actionable message and nothing is pushed, and a refused `gh`
  invocation fails with what it said while the run's own report and logs stay as they were. The
  source CLI path runs the same way, including the link the issue's comment then carries, and a
  configuration without `delivery` still asks GitHub for nothing. Nothing there needs a GitHub
  account, a token, or a network.

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
refusal and ended normally — nothing hung waiting for an approval nobody was there to give. That
exercise belongs to the sandboxed launch of that date: the unsandboxed launch this checkout now
selects does not refuse such a write, and nothing re-verifies the older claim here. It is a Codex
CLI + DeepSeek result: not OpenAI-backed inference, and not Claude Code.

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

- **any live turn through the unsandboxed launch beyond the 2026-09-19 Windows smoke.** That smoke
  is the only live evidence for this suffix: `run-20260919114837-ce22873c` had a real DeepSeek Flash
  turn stage and commit its change (`e8dafb7`), and `run-20260919114936-a1feeae5` reopened the same
  retained branch and committed `e105ef4` on top. Both ended clean, both commits are
  `Nexus Agent <nexus@local>`, the clone has no remote, and the source checkout is unchanged. It is
  one platform, one provider profile, and no Jira: `npm run test:live` has not run through this
  launch.
- any live coding turn on Linux or macOS, and any macOS behaviour at all;
- live runs through a provider other than the one configured on this machine, and any profile or
  gateway the operator has not installed;
- **the supervised live Jira exercise, and any live watch, restart, or failure scenario.** The read
  half has been exercised live (above), and live writes now have evidence too: the Jira-driven runs
  claimed HARN-2, commented on it, and moved it through its statuses, and one continued a retained
  workspace and left a local commit there (see [Next task](#next-task)). The supervised exercise in
  [docs/implement-task-source-connectors.md](docs/implement-task-source-connectors.md) §S07 — a
  disposable repository, the exact-byte marker assertion, the restart check, and the watch cycle —
  has not run, and no live watch, restart, or failure path has been exercised. Mocked tests are not
  evidence for the parts that have not run;
- **any live GitHub delivery.** The delivery step is verified offline against disposable Git
  repositories and a stand-in `gh` on `PATH`; no branch has been pushed to github.com and no pull
  request has been created by the harness here. The commands follow `gh`'s documented interface,
  but the live push, the live create-or-update decision, and a live authentication failure have not
  been exercised;
- **the Nexus research-tool profiles.** [docs/nexus-agent-tools.md](docs/nexus-agent-tools.md)
  defines two native Codex profile layers for the Flash and Astra launches. Their TOML and the MCP
  servers they name were checked with the installed CLI 0.154.0 in a temporary Codex home, and the
  suggestion deny-list through equivalent `-c` overrides. This repository installs none of them and
  changes no launch prefix, and no live session has run from this checkout: the four capabilities
  on their credential-free defaults (anonymous Context7, keyless Tavily), the optional keyed forms,
  and the absence of the personal connectors in a real session are not proven here. The operator's
  new-session smoke is what confirms them;
- behaviour on a runtime version other than the 0.154.0 interface this adapter was written against,
  and any runtime-reported model identity: a profile or model name in a report is launch
  information, not proof of which upstream model served a response.

## Coding runtime

The coding turn is the host's own Codex CLI, driven through its documented non-interactive form.
One interface was selected — the **CLI**, not the SDK — because it is the supported way to run a
single non-interactive turn on this platform and needs no extra client library in this repository.

- **Interface:** `codex exec` (`@openai/codex`, version **0.154.0** when this was written, which
  publishes a `win32-x64` build). The adapter invokes exactly
  `<your launch prefix> --ask-for-approval never exec --sandbox danger-full-access --json -`,
  started **in the working copy**, with the prompt written to standard input. `--json` makes the
  runtime write one JSON event per line to standard output; its progress goes to standard error; the
  turn ends when the runtime exits. Nothing is interpolated and no shell is involved beyond what a
  Windows `.cmd` shim already requires.
- **The turn is deliberately unsandboxed.** `--sandbox danger-full-access` is the adapter's own
  explicit selection, not a hidden fallback: a turn has to be able to stage and commit in the
  retained working copy, and the narrower `workspace-write` policy — in its `--sandbox` spelling and
  in its native `permissions`/`default_permissions` spelling — leaves that copy's Git metadata
  read-only on this Windows installation, where `git add` fails on `.git/index.lock` (reproduced by
  hand with the installed CLI; HARN-2, HARN-10). Model-generated commands therefore run the way your
  `setup` and `checks` run: as you, with no sandbox and no network carve-out. The suffix is the same
  for every turn; there is no `--dangerously-bypass-approvals-and-sandbox`, no retry with a wider
  policy, and no automatic approval service.
- **Non-interactive by construction.** `--ask-for-approval never` is the adapter's own argument, so a
  run never waits for a human: a turn that would ask for an approval is refused instead of pausing,
  and the failure stops the run. On the installed CLI the approval option is accepted **before** the
  `exec` subcommand and rejected after it (`unexpected argument '--ask-for-approval'`), which is why
  it leads the adapter's own arguments rather than sitting beside `--sandbox`.
- **Official references consulted:** [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  [CLI commands and flags](https://learn.chatgpt.com/docs/developer-commands?surface=cli) (`exec`,
  `--json`, `--sandbox`, `-o/--output-last-message`, `resume`),
  [permissions](https://learn.chatgpt.com/docs/permissions) and
  [agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security) for the
  permission and sandbox model the policy sits in,
  [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), and the `openai/codex`
  documentation served through the Context7 MCP server. `resume` and `--output-last-message` exist
  and are deliberately unused: every top-level turn is one fresh invocation, so continuing a session
  can never quietly buy extra turns.
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
- **Research tools for a Nexus turn, without personal connectors.** One native Codex profile layer
  per Nexus tier — `<Codex home>/nexus-flash.config.toml` and
  `<Codex home>/nexus-astra.config.toml` — carries that tier's model selection, adds the OpenAI
  Docs MCP server, Context7 and Tavily, and keeps every connector app except GitHub out of the
  turn. [docs/nexus-agent-tools.md](docs/nexus-agent-tools.md) has the two copy-ready files, the
  launch-prefix change, the optional private credentials — neither is needed: Context7 answers
  anonymously and Tavily's keyless mode is the default — and a short new-session smoke procedure.
  The checkout's own `harness.config.json` does not select those profiles: they are operator-native
  configuration the harness never reads or writes.
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
  - The unsandboxed turn can reach the network, as your own shell can: the harness does not rely on
    a turn being unable to install something. `setup` remains the place for installs — it runs
    before the turns, and its failure stops the run before any paid work.
  - `--cd` is not used: the working root is the process's own working directory, so a working-copy
    path that a Windows shim cannot carry as an argument can never fail a turn.
- **Verify the launch once, by hand (opt-in).** The offline suite proves what the adapter sends; only
  a real launch proves what the installed runtime and platform do with it. After a change to the
  launch, run both steps once, with the account and configuration this machine uses. Neither is part
  of `npm test`, `npm run validate`, or CI, and neither is a claim that either has already been run.

  1. `npm run test:live -- --config harness.config.json` — the opt-in live check. It drives the built
     CLI against two disposable repositories with the selected launch and reads its assertions out
     of the retained working copies. Its repair exercise is a second coding turn in the same
     retained working copy, so a fresh launch and a later launch over one clone both run.
  2. The commit check below: a real turn asked to change a tracked file and commit it — the part no
     offline test can decide about a real runtime. Run it from this repository's checkout: it takes
     the `agent` block from this checkout's `harness.config.json`, and its source, the run's output
     root, and the probe's own files are three separate paths outside any system temp directory.

```powershell
$probe  = Join-Path $env:USERPROFILE ("nexus-harness-probe-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$source = Join-Path $probe 'source'
New-Item -ItemType Directory -Force (Join-Path $source 'src') | Out-Null
Set-Content (Join-Path $source 'src\committed.txt') 'placeholder'
git -C $source init -q
git -C $source config user.email probe@local
git -C $source config user.name probe
git -C $source add -A
git -C $source commit -qm base

# `workDir` resolves against this file, so the run's output is a sibling of the
# source, not inside it. The checks pass on the clean baseline and after the
# turn's commit, and go red if the turn leaves its edit uncommitted. The agent
# block is added through ConvertFrom-Json/ConvertTo-Json, which escapes the
# Windows paths in it instead of pasting them into a hand-written string.
$config = @'
{ "workDir": "./run", "maxRepairs": 0, "taskTimeoutMinutes": 20, "commandTimeoutMinutes": 5,
  "setup": [],
  "checks": [
    ["git", "ls-files", "--error-unmatch", "src/committed.txt"],
    ["git", "diff", "--quiet", "HEAD"]
  ],
  "agent": null }
'@ | ConvertFrom-Json
$config.agent = (Get-Content harness.config.json -Raw | ConvertFrom-Json).agent
$config | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $probe 'probe.config.json')

@'
{ "id": "commit-probe", "title": "Commit inside the retained working copy",
  "description": "Replace the only line of src/committed.txt with: committed by the coding turn. Stage and commit the change with the message 'probe: commit from the coding turn'. Change nothing else.",
  "acceptanceCriteria": ["src/committed.txt holds the required line and is committed.", "The commit 'probe: commit from the coding turn' is on the current branch.", "git status --porcelain is empty."] }
'@ | Set-Content (Join-Path $probe 'probe.task.json')

npm run build
npm start -- run --repo $source --config (Join-Path $probe 'probe.config.json') --task (Join-Path $probe 'probe.task.json')
```

```powershell
$clone = (Get-Item (Join-Path $probe 'run\workspaces\*') | Select-Object -First 1).FullName
git -C $clone log --oneline -2                          # the baseline, then the turn's own commit
git -C $clone log -1 --format='%s | %an <%ae>'          # the message, and Nexus Agent <nexus@local>
git -C $clone show HEAD:src/committed.txt               # the line the turn committed
git -C $clone status --porcelain --untracked-files=all  # empty: the turn left nothing behind
```

The checks decide whether an edit was left uncommitted; a commit is read from `git show` and
`git log` above, not inferred from a clean diff — `git diff` would never show an untracked file, so
the example makes the turn change a file that is tracked from the start. A turn that cannot stage or
commit (the HARN-2 failure) leaves its edit visible and stops the run. Continuing a workspace reuses
the same launch: the repair exercise in step 1 is already a later turn in one retained copy, and
`source run` continues a clone across runs through the issue's `harness-ws-*` pointer
(docs/WORKFLOW.md §6). Nothing cleans `$probe` up.

## Module ownership

`src/` is a small hierarchy of responsibility-based modules; [docs/module-structure.md](docs/module-structure.md)
is the full tree, the placement rules, and the steps for adding a source or a runtime.

| Module                    | Responsibility                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `src/cli.ts` + `src/cli/` | Arguments, help, exit codes, command dispatch, and top-level wiring. Owns all presentation.  |
| `src/config/`             | The input schemas and their documented defaults, and reading/validating the two JSON inputs. |
| `src/shared/`             | The data contracts (data only: no imports, no runtime I/O) and the one message helper.       |
| `src/process/`            | Starting one command or Git reading, its limit, and stopping its process tree.               |
| `src/checks/`             | One setup/check round and what a command's result means.                                     |
| `src/workspace/`          | Preflight, run directory allocation, the working copy, the ledger, and the change summary.   |
| `src/runs/`               | The order the work happens in: baseline, turns, checks, repair, deadlines, the report.       |
| `src/reporting/`          | `result.json`, the logs under `<runDir>/logs`, and the change summary.                       |
| `src/sources/`            | The task-source contract, receipts, eligibility, guidance, and the serial coordinator.       |
| `src/sources/jira/`       | The Jira Cloud connector: HTTP, search, reads, transitions, comments, the ADF reader.        |
| `src/delivery/`           | The optional GitHub step: push a passed attempt's branch, create or update its pull request. |
| `src/agents/codex/`       | The coding runtime: one turn through the Codex CLI, normalized for the runner.               |

`src/cli.ts` (and `src/cli/`) depends on the modules below it; nothing depends on `cli.ts`. Helper
modules never import the CLI, and `src/shared/types.ts` is data only. Both rules are enforced by
`no-restricted-imports` entries in `eslint.config.js`, and `tests/boundaries.test.ts` demonstrates
one permitted and one rejected import against fixtures in `tests/fixtures/boundaries/`.

The intake boundary is the `TaskSource` contract in `src/sources/contract.ts`. The coordinator knows
ordinary data and functions, the runner never imports Jira, and the source command in `src/cli/`
selects the connector with one explicit branch on `source.type`: a second source would be a concrete
adapter plus configuration and CLI wiring, not a change to `Task` or to the loop.

Delivery is not a source and not a connector: `src/delivery/github.ts` is one optional step the
source command hands to the coordinator, and it starts its `git` and `gh` commands through the same
bounded runner every configured command uses.

`.prettierignore` excludes the supplied `AGENTS.md` and `docs/` so those design documents stay
byte-for-byte as written.

## Toolchain

Node 24.14.1, TypeScript 6.0.3, ESLint 10, Prettier 3, Vitest 5, Zod 4, and tsx.

TypeScript is pinned to the 6.0 line on purpose: TypeScript 7 is newer, but `typescript-eslint`
8.70 still declares `typescript >=4.8.4 <6.1.0`, so 6.0.3 is the newest release the whole
toolchain supports. Dependencies are pinned by `package-lock.json`; use `npm ci`.

CI (`.github/workflows/ci.yml`) runs on every pull request and on every push to `main`, on
`ubuntu-latest`, with the Node version `.nvmrc` records: it installs with `npm ci` and runs
`npm run validate` — format, lint, typecheck, build, and the offline suite. It needs no
credentials, and `npm run test:live` is deliberately not part of it.
It is the only workflow, and it holds `contents: read`: nothing in this repository pushes, opens a
pull request, or merges one. A task branch is merged by the operator, or by an agent using the
operator's own `gh` credentials, once the check is green —
[docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md) is the loop and the reason it is not automated.

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
  Its three increments are implemented, including the corrections HARN-7 made to which tier really
  launches, when Jira moves to review, and which failures may escalate.
- [docs/LONG_TERM_VISION.md](docs/LONG_TERM_VISION.md) — the direction the harness is meant to grow
  into. It defines no behaviour: [docs/spec.md](docs/spec.md) stays authoritative, and every change
  still needs a task.
- [docs/module-structure.md](docs/module-structure.md) — the `src/` layout as it stands, and the
  rules for placing new code in it.
- [docs/harness.jira.example.json](docs/harness.jira.example.json) — a credential-free source
  configuration to copy.
- [docs/nexus-agent-tools.md](docs/nexus-agent-tools.md) — the two native Codex profile files that
  give a Nexus turn GitHub (read), the OpenAI Docs MCP server, Context7 and Tavily, and keep the
  personal connectors out, with the operator setup and the new-session smoke procedure.
- [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md) — how changes to this repository are made: one
  `task/<name>` branch per task, merged into `main` through a pull request. It is about this
  repository only; a harness run never merges anything in a target repository, and without a
  configured delivery step it pushes and publishes nothing either — the commits a coding turn makes
  there stay in the retained workspace.

## Next task

The 2026-09-16 extension added the optional `agent` selection, the selected-launch reporting, the
explicit no-approval policy, and the Jira task source with `source list`, `source run`, and
`source watch`; the workspace-continuation increment — retained workspaces, the
`harness-ws-<workspaceId>` pointer label, the escalation ladder, and continuation guidance — is
implemented and verified offline. **A real Jira-driven continuation has since run:** Jira run
`run-20260919115244-4ff8eedf` claimed HARN-2, continued workspace `run-20260919100148-e48a9ab0` —
same clone, same recorded base `36f62fd`, attempt 2 — and the attempt's documentation work is the
local commit `f835c33` on that retained branch: one issue's continuation, not the full supervised
exercise. What remains is listed under
[What is verified, and what is not](#what-is-verified-and-what-is-not) rather than promised here. The
next real piece of work is the **supervised live Jira exercise**, still not run: it needs a
service-account token, a disposable target repository, and an operator who has inspected the queue
before the first paid call, and its restart, watch, and failure steps have no live evidence. After
that, a second coding adapter (Claude Code, with its own invocation
and event parser and its own tests — a Claude launcher behind the Codex parser would be a bug), live
turns on POSIX hosts, and stronger isolation before unattended runs of untrusted repositories.
Nothing here builds them ahead of a task that needs them.
