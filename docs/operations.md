# nexus harness

A small, local-first coding harness. One CLI invocation takes an explicit development task,
prepares a working copy of a repository, runs that project's own setup and checks, asks the Codex
CLI to implement the task, reruns the checks, gives the runtime the observed failures to repair
within a bounded allowance, and keeps the working copy, the logs, and a final report on your disk.

Nothing leaves your machine except the coding turns themselves — a clone is made locally, the
configured commands run locally, and by default the harness pushes, publishes, and integrates
nothing: a coding turn may make small local commits, and they stay in the retained working copy.
Two independently optional, explicitly configured steps let the harness's own deterministic path
act instead. `delivery` pushes a passed attempt's branch and opens or updates its GitHub pull
request; review-to-completion may then arm native GitHub auto-merge, verify the configured
post-merge workflows, and move the Jira item to Done ([docs/spec.md](../docs/spec.md) §7 and §10,
[docs/WORKFLOW.md](../docs/WORKFLOW.md) §8 and §10). A coding turn never performs any of it, and a
configuration that enables neither step changes nothing.

## Requirements and supported platforms

- **Node.js 24 or newer.** `engines` requires `>=24.0.0`, and `.nvmrc` records `24.14.1`, which is
  the version used by the repository.
- **A coding runtime: the Codex CLI** (`@openai/codex`).
  It is not an npm dependency of this repository: you install it globally and authenticate it
  yourself. The harness starts it with a launch you configure — `codex` on `PATH` by default, or a
  path and a native profile of your choosing. See [Coding runtime](#coding-runtime).
- **Git** on `PATH`. The harness runs real `git` commands: it records a base commit, clones the
  repository into a workspace of its own (or reopens the workspace a continuation names), and works
  on that workspace's own branch.
- **Platform:** use the configured host environment. CI runs the offline gate on Linux;
  process and signal handling also have Windows-specific paths. A passing offline suite does
  not establish live provider behavior on another platform.

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

| Script                      | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `npm start`                 | Run the built CLI (`dist/cli.js`).                                |
| `npm run dev`               | Run the CLI from TypeScript sources via `tsx`.                    |
| `npm run build`             | Compile `src/` to `dist/`.                                        |
| `npm run typecheck`         | Type-check sources and tests without emitting.                    |
| `npm run lint`              | Check code quality with ESLint.                |
| `npm test`                  | Run the offline suite once. Needs no credentials.                 |
| `npm run test:watch`        | Run the offline suite in watch mode.                              |
| `npm run test:unit`         | Run the deterministic unit layer alone.                           |
| `npm run test:boundary`     | Run the boundary layer alone, against this host.                  |
| `npm run test:workflow`     | Run the workflow layer alone.                                     |
| `npm run format:check`      | Check formatting without writing.                                 |
| `npm run validate`          | Run the validation gate, reusing eligible unchanged results. |
| `npm run validate:fresh`    | Clear local caches and execute every validation task. |
| `npm run cache:clear`       | Clear this checkout's local validation caches. |

Active suites live in the directory of the layer that owns their behavior — `tests/unit/`,
`tests/boundary/` or `tests/workflow/` — and run in `npm test` and `npm run validate`; a layer
that discovers none fails rather than passing an empty suite. The suites in `tests_old/` are
disabled reference material for the whole-command surfaces the active layers' decisions are
assembled into, and for the live provider exercises that stay outside the ordinary gate; each
archived file's required behavior and the active suite that carries it are named in
`tests_old/REFERENCE.txt` (docs/testing.md).

`npm start -- --help` prints the full usage text, and `npm start -- run` with a missing option
prints a usage error and exits `2`.

The supervised commands are the exception to "nothing leaves the machine beyond the configured
delivery and completion steps": an incident's one concise report is written into the ticket's
thread, and its summary is published to the configured SNS topic, which is what delivers the email
to the configured address. Both are exactly what the `recovery.notifications` policy names, and a
configuration that names none is refused by the supervised commands.

## Configuration: one harness file, one file per connected project

Configuration is **two files**, and each field has exactly one owner
([docs/WORKFLOW.md](../docs/WORKFLOW.md) §1):

- **The Nexus-wide harness configuration** — the file every command is given as `--config`. It says
  how this installation runs work: `workDir`, the limits (`maxRepairs`, `taskTimeoutMinutes`,
  `commandTimeoutMinutes`), the coding launches (`agent`, `escalation`), and the reviewer that
  follows them (`reviewer`, `completion`). It names no repository, no Jira connection, and no
  project command.
- **The project configuration** — `nexus.project.json` at a connected repository's root, committed
  with that repository. It says what that repository is: `setup` and `checks` (the commands that
  decide a task there), its Jira queue (`source`), and its GitHub destination and completion
  outcomes (`delivery`, `delivery.completion`). It carries no launch, no limit, and no reviewer
  identity.

The two are **composed, not layered**: neither file may carry a field the other owns, no field is
defaulted from one into the other, and what the two say about each other is refused rather than
guessed — a review belongs to the repository its own project delivers to and is enabled only when
the harness declares a reviewer and the project declares both Jira and delivery. Local-only and
Jira-only projects use the same harness file with no review path. The reviewer and the completion
gate must name the same Nexus Lens
App, login and check; and a completed item's outcomes must differ from the review status it started
in. Every refusal names both paths and the field. The configuration shape this contract replaced is
refused the same way: its project fields are reported as belonging to the project configuration.

One Nexus installation can connect several projects: the same `nexus.config.json` and the same
`workDir` serve all of them, and each project's own `nexus.project.json` names its queue and
destination. Their intake locks are separate — a stable hash of the connected project's own
identity, never a credential or a display name — so a second consumer of one project and `workDir`
is refused while two different connected projects may work their own queues concurrently
([docs/WORKFLOW.md](../docs/WORKFLOW.md) §1, [docs/spec.md](../docs/spec.md) §6).
The lock uses the canonical Jira site URL, lowercase cloud UUID and GitHub owner/repository,
and uppercase Jira project key: equivalent casing cannot start a second consumer. This boundary
is covered by offline regressions in this change; use it operationally only after the change is
integrated. No live concurrent-project exercise has been run. An existing legacy
`.intake/lock/` still blocks every project until its owner has stopped and the operator removes it;
do not interrupt an active queue to upgrade. Do not mix old and new consumer revisions under one
storage root. Completion logs and saved auto-merge admissions also separate immutable source
identity and destination repository, so equal issue IDs on different Jira sites cannot share state.

`docs/nexus.config.example.json` is a credential-free Nexus-wide example,
`docs/nexus.project.example.json` a credential-free project example, and this repository's own
`nexus.project.json` is what it commits for itself. `examples/task.json` is the task example. Their
formats are defined in [WORKFLOW.md](WORKFLOW.md) §1–2.

### Connecting a new repository

[Connect a project to Nexus](../docs/connect-a-project.md) is the canonical, practical sequence: it
takes an integration agent from an existing repository through the one committed file —
repository-root `nexus.project.json`, copied from
[docs/nexus.project.example.json](../docs/nexus.project.example.json) — to `check-config --project`,
the read-only `source list --project`, and a finite `queue run --repo`, after the project-side
choices and checks are ready. Installation-wide setup belongs to the operator and is not part of
that sequence. This section does not restate the steps; the file's fields stay defined in
[docs/WORKFLOW.md](../docs/WORKFLOW.md) §1, §5, §8 and §10, and the commands in §11.

### Migrating an installation onto this split

The retired single file is no longer read. Split it: the Nexus-wide fields become the operator's own
`nexus.config.json` (gitignored in the operator's checkout, and what `--config` now names), and the
project fields become a committed `nexus.project.json` in the connected repository's root. That is
exactly what this repository did for itself: its `nexus.project.json` carries the Jira queue, the
delivery destination, and the one command its CI runs, while the reviewer, the launches, and the
limits moved into the operator's harness file — start from
[docs/nexus.config.example.json](../docs/nexus.config.example.json), which holds this installation's
tiers, reviewer, and completion policy, and set `workDir` and the launcher's own path for the
machine. The retired filename stays ignored so a leftover copy cannot make the checkout dirty, and
the queue's invocation becomes `npm start -- queue run --repo . --config nexus.config.json`.

## `check-config`: validate the composed configuration

```sh
npm start -- check-config --config docs/nexus.config.example.json --project . --task examples/task.json
```

```
check-config: /home/you/project/docs/nexus.config.example.json is valid
  workDir                /home/you/project/.harness (resolved from this file)
  maxRepairs             2
  taskTimeoutMinutes     60
  commandTimeoutMinutes  10
  escalation             2 tier(s): flash, astra
  reviewer               github app 5001141 installation 163007360 as nexus-lens[bot], check "Nexus Lens review", key path environment variable NEXUS_LENS_PRIVATE_KEY_PATH
  reviewer launch        codex codex --profile nexus-astra --model gpt-6-astra
  completion             reviewer nexus-lens[bot] (App 5001141), check "Nexus Lens review", credential environment variable NEXUS_LENS_TOKEN, poll 30s, deadline 1800s
  recovery               codex codex --profile nexus-recovery --model gpt-6-astra -c model_reasoning_effort=high, at most 2 attempt(s) per incident
  recovery reporting     arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications -> saint282@gmail.com, publisher aws sns publish
check-config: /home/you/project/nexus.project.json is valid
  setup                  1 command
  checks                 1 command
  source                 jira https://malton-family.atlassian.net project HARN
  source queue           issuetype Task, label harness-task, To Do -> In Progress -> In Review
  source ordering        rank: Jira Rank ASC, then created ASC, then the issue key
  source polling         30s, token environment variable JIRA_API_TOKEN
  delivery               github saintiago/nexus-harness -> main
  delivery completion    reviewer nexus-lens[bot] (App 5001141), check Nexus Lens review, credential environment variable NEXUS_LENS_TOKEN
  delivery completion    post-merge workflows ci.yml, fail -> To Do, verified -> Done, poll 30s, deadline 1800s
  review                 github saintiago/nexus-harness as nexus-lens[bot], app 5001141 installation 163007360
  review scanning        In Review, check "Nexus Lens review", key path environment variable NEXUS_LENS_PRIVATE_KEY_PATH
  review reviewer        codex codex --profile nexus-astra --model gpt-6-astra
check-config: /home/you/project/examples/task.json is valid
  id                     example-001
  title                  Add a greeting function
  acceptanceCriteria     2 item(s)
```

Every path it prints is the one it really read: `/home/you/project` stands for the checkout you run
this in, and the resolved `workDir` is spelled out so you can see where a run would write before you
start one. `--config` names the Nexus-wide harness configuration, `--project` the connected
project's root, and `--task` adds that file. `check-config` is **static**. It creates no directory,
runs no configured command, contacts no provider, needs no credentials, and reads no native profile
or authentication file. Inputs are rejected rather than repaired: unknown keys, wrong types, blank
text, invalid limits, malformed command arrays, an unsupported `agent` runtime, and an empty or
blank `agent` command all fail with the file and field named, and no value is coerced or
interpolated. A field in the wrong file, a project completion without harness completion policy,
and every other mismatch fail the same way — before anything runs. The path rules for a
launch executable are applied exactly as a command would apply them, though the coding prefix is not
printed. What the two files compose prints too — the repository, queue, check name, and ids, and the
_name_ of the variable that holds a credential, never a credential value. Exit codes: `0` both files
are valid and compose, `1` a file could not be read, is invalid, or does not compose, `2` a missing or
unknown option. `--task` is optional: without it the two configuration files are validated alone —
which is what a `source` command needs, and what you run before pointing the harness at a Jira
queue.

### Selecting the launch

The task is decided by the connected project's `setup` and `checks` commands and by the Nexus-wide
limits. The optional `agent` object of the harness configuration selects what the coding turns are
started with:

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
relative path **containing a separator** resolves against the harness configuration file's own
directory, once, before anything runs; an absolute path is used as supplied. The remaining arguments are opaque
— the harness does not guess which are paths, expand `~`, `$HOME`, or `%VARIABLE%`, or join the
prefix into a shell string. Omitting `agent` entirely means `{"runtime": "codex", "command":
["codex"]}`, which uses your ordinary Codex defaults.

## `run`: the workspace, check, and repair loop

```sh
npm start -- run --repo ../target-project --config nexus.config.json --task examples/task.json
```

Everything the run needs is loaded and validated **before anything is started**, and the loaded
configuration and task stay fixed for the whole run: nothing the working copy, the runtime, or the
target project writes can change which commands decide the result. The project configuration is
read from the checkout `--repo` names, so the repository a run clones describes its own `setup` and
`checks`. Then:

1. **Preflight.** The source repository must be a clean Git checkout with a commit; the output
   directory must not be inside it.
2. **A run directory**, `<workDir>/runs/<runId>`, holding the logs and (last) the report, and a
   **workspace**, `<workDir>/workspaces/<workspaceId>`, holding the working copy beside it, with a
   ledger at `workspaces/<workspaceId>.json` recording its base, branch, and attempts. A fresh
   run's `workspaceId` is its own run ID; a continuation reuses the workspace its issue's pointer
   label names. `workDir` comes from the harness configuration file and resolves from that file's
   own directory.
3. **A working copy**: a clone of the source at its recorded base commit, in that workspace, on a
   dedicated branch `harness/<workspaceId>`. Only committed content is inherited. The clone is
   given a repository-local Git identity (`Nexus Agent <nexus@local>`, commit signing disabled)
   before anything runs in it, so the coding turns can commit as they go; nothing is pushed. A
   **continuation** — a source issue moved back to the ready status whose pointer label names a
   workspace this machine has — reopens that clone instead of making a new one, on its recorded
   branch and base, keeping the local commits earlier attempts left.
   A checkout a turn left on a branch of its own is read against that recorded branch: when it is
   clean and its commit descends from the recorded branch's tip, the harness fast-forwards the
   recorded branch to it and checks it out — the commit stays on the branch the turn made it on —
   and a detached, divergent, or branchless checkout stops the run before the next turn or check
   with both branch names and what to do by hand. A return that would write over a local file the
   working copy ignores is refused with the paths named and the file's bytes kept, rather than
   performed, and what the checkout and the fast-forward did is read back, so a Git configuration
   that squashed the merge cannot pass for a returned branch. A coding turn is also started only
   from the workspace's own committed state: a working copy that still holds uncommitted work stops
   the run before the agent, with its branch, the paths, and what to do by hand. Nothing is reset,
   force-updated, or discarded.
4. **The baseline round**: every `setup` command, then every `checks` command, in the order the
   configuration lists them. A red baseline stops a fresh run before any coding turn — the task is
   not attempted on a project that is already failing. A continuation may start red, because its
   workspace may already carry failed work, and only its post-turn round decides.
   For a ticket from a configured source, that red baseline is not the end of the road: when every
   setup command succeeded and the check round completed nonzero, the configured reviewer diagnoses
   it in one bounded local turn over the snapshot and the command evidence, and an actionable
   finding returns the same ticket to its ready status — with its workspace pointer — as guidance
   for the next claim, which repairs the baseline and then continues the original task. Nothing is
   sent to GitHub, and nothing is delivered until a post-agent round passes.
   The diagnosis establishes the snapshot before it spends anything: a working copy whose recorded
   base commit has moved, or whose tracked files a configured command changed, is refused as
   incomplete evidence and left In Review instead. The reviewer turn itself runs under the narrower
   `workspace-write` policy, with only its own working directory writable — the launch states that
   policy's additional writable roots as none and takes the host's temporary roots out of it, so
   neither tree is writable even when `workDir` sits beneath one or the operator's own configuration
   grants a root over it — so it cannot change the snapshot it reads or the retained working copy. A
   configured reviewer launch that carries a switch of its own — `--add-dir`, `--cd`/`-C`,
   `--worktree`, `-s`/`--sandbox`, `--dangerously-bypass-approvals-and-sandbox` — is refused before
   any turn starts, because those grants are applied beside that policy rather than through a key
   the launch's own arguments could take back; the ticket stays In Review with the reason and the
   required human action.
   A finding that is actionable carries the order it belongs in: the next claim is told, in its
   prompt, to repair the baseline before continuing the original task. A diagnosis a stopped invocation left
   pending is finished before anything else is discovered: the missing status move, or the
   validated outcome the reviewer turn's invocation recorded — never a second turn or a second
   comment for the same evidence, and never the finding file a turn that then failed left behind. A
   stop that lands while the reviewer turn is running is recorded rather than dropped: that one
   comment and that one move run under their own bounded best-effort deadline, so the claimed
   ticket is never left In Progress with nothing looking for it; a stop that reaches the diagnosis
   before it published anything is no different — the claimed ticket is told and taken out of the
   running status under that same deadline. A
   log file the diagnosis cannot read is incomplete evidence, not a check that said nothing: the
   ticket stays In Review with the paths named, and no reviewer turn is started from it; a refusal
   reached there still carries a stop the evidence's own record already holds as unconfirmed — the
   intake lock is kept for inspection — and a record that cannot be read at all fails closed the
   same way. The diagnosis's
   own evidence lives under the connected project's namespace, so two projects sharing one output
   directory never act on each other's pending diagnosis, and the claim that follows a repair
   always carries the finding — from the thread, or read back from that evidence. Only a comment
   that says the whole finding, names the exact evidence the retained record closed as a repair,
   and repeats every field of the finding that record holds counts as coming from the thread — a
   marker names the evidence, never the text, so an edited comment is not it; a partial, edited, or
   differently attributed comment is context, and the recorded finding is handed over in its place.
   That record is the accepted outcome the reviewer turn produced, never the turn's own finding
   file, so a ticket returns to To Do only while the outcome really holds the actionable finding a
   marker names — an edited marker on a rejected turn never returns it for repair.
   A required finding nothing can supply starts no developer: the claimed ticket is told why on its
   own thread and taken out of the running status with its workspace pointer preserved, so it is
   never left in progress with nothing looking for it.
5. **Coding turns**: one fresh invocation of the configured launch per top-level turn, started in
   the working copy and never asking for approval. The implementation turn is given the task; each
   repair turn is given the failures the harness observed for itself. Every turn of the run uses the
   same selection, and every turn is asked to make small, meaningful local commits and to finish
   with the work it wants built on committed — the harness starts no further turn from a working
   copy that still holds uncommitted work. A commit is not a check result: the round below decides.
6. **A post-agent round** after every turn: `setup` again, then every check. The checkout is
   returned to its recorded branch before the round reads it, so the checks judge the revision that
   branch holds.
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
- Every Git step is bounded too: inside a run each reading gets what is left of the task time when
  it starts, and the run's own stop request; a reading with no run deadline to spend — the source
  preflight, a continuation's branch check, the final comparison — runs under a fixed finite bound.
  A Git stopped at its limit is reported as that stop, with whether it was confirmed, instead of
  being waited for.
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

The `source` and `review` commands use the same codes. A `source run` that processed only handled
failures, invalid task descriptions, or a failed publication exits `1`; a `review scan` that had to
report a ticket for coordinator attention exits `1`; a watch stopped with Ctrl+C exits `130`.

No arguments and `--help` print help and exit `0`. A report that could not be written is reported
with a nonzero code and the run directory that was kept: the CLI never prints a successful
completion, and never names a report that does not exist.

### What a run leaves on disk

```
<workDir>/
  .intake/                       source intake: the per-project consumer locks and the per-issue
                                 receipts
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
  workspaces/<workspaceId>.history/
    current.json                 points at the newest conversation snapshot
    reports/                     the complete developer and reviewer reports
    snapshots/<snapshot-id>/     one immutable snapshot: index.md, index.json, entries.jsonl,
                                 entries/ (one file per entry), and task.json
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

### The ticket conversation history

A source-backed ticket also keeps one local conversation history beside its workspace, prepared by
the harness before every developer and reviewer turn and never fetched by an agent itself:

```sh
cat <workDir>/workspaces/<workspaceId>.history/current.json   # the newest snapshot
cat <workDir>/workspaces/<workspaceId>.history/snapshots/<id>/index.md
rg "<text>" <workDir>/workspaces/<workspaceId>.history/snapshots/<id>/entries/
ls  <workDir>/workspaces/<workspaceId>.history/reports         # complete developer/reviewer reports
```

The index names each entry's role, author, time, round, source id, and the reviewed or delivered
commit where it has one; each entry file holds its provenance header and the original wording
below it, unchanged. The prompt a turn receives carries the current brief, the latest delivery, the
complete unresolved review findings with their latest responses, and the human feedback since the
same role's last consumed snapshot (including comments arriving or edited during its last turn);
everything else stays in the snapshot for the turn to search. A complete developer report is saved
under `reports/` before its Jira comment is published, and a complete reviewer report before its
GitHub review is; the acknowledged comment or review is recorded with the report, and a rendering
that comes back through Jira or GitHub is recognized by that recorded identity and not duplicated —
a comment that merely quotes a marker, or a rendering edited after publication, stays an ordinary
entry. Outstanding findings are tracked separately for each reviewer; unrelated approvals and
comment-only reviews cannot clear them. Each developer report names the commit its delivery verified.
Edits to an App review remain actionable responses beside its outstanding findings, even when GitHub
provides no edit timestamp. The recorded publication hash detects the change; refreshes, restarts and
either role consuming the feedback do not hide it. A detected edit without an edit timestamp remains
a response even if its original review predates a newer outstanding round from the same reviewer.
Human review edits follow the same rule; the harness does not infer an edit time.
The harness re-reads requirements before each turn and refuses the turn if they cannot be obtained.
Developer turns with a history snapshot use it for conversation guidance, including on repairs;
old comment excerpts collected at intake are not repeated alongside edited or consumed feedback.
The accepted baseline-repair requirement still appears on every turn. Runs without a history
snapshot retain their existing guidance behavior.
`consumed-developer.json` and `consumed-reviewer.json` track feedback separately after usable turn
output. A prepared snapshot never advances them; legacy workspaces without cursors replay feedback.
Developer messages are retained in full through the runtime adapter. Old messages marked with the
adapter's truncation suffix are explicitly incomplete; their raw logs remain supporting evidence.
Responses and new feedback each have a 60,000-character inline budget. When the prompt names
`brief.responses` or `brief.newHumanFeedback` in its immutable `index.json` as required reading,
read that whole array before acting, or report the input gap.

Jira timezone offsets and UTC timestamps are compared as instants, so consuming a snapshot does
not hide a later response to an outstanding review. Invalid timestamps are named as gaps.
Normal completion comments are matched to the retained review by acknowledged publication identity:
the review excerpt is a mirror, while separate completion context stays an attributed harness entry.
Check failures and repair dispositions after an outstanding review appear in both prompts' responses,
even after consumption or restart while that review remains outstanding. If the response section
overflows, its required local reading includes this completion context in full.
For the whole original completion rendering, read `mirrors[].originalEntry` in the snapshot's
`index.json`; its report digest also retains the published text and hash. Edits and older comments
without recorded acknowledgement remain separate entries. A marker alone does not authenticate them.

Baseline reviewer reports are recovered from the matching `baseline/<project>/<evidenceId>/outcome.json`
for both roles. Missing or corrupt outcomes are named as gaps; an unaccepted `finding.json` cannot
replace them. Baseline entries name their evidence ID and reviewed commit, and label the file
modification time used when the original turn time is unavailable. New baseline comments are
matched to those reports by acknowledged Jira identity and unchanged text.

Developer summaries are retained before the next repair; reviewer verdicts are kept even if later
publication checks refuse them.
If a run finished but its coordinator stopped before saving the final history report, the next
snapshot recovers its outcome, reason and checks from the ledger and `result.json`. An unavailable
or unusable final report is an explicit gap naming that path; the saved turn messages remain
readable. Earlier snapshots and saved digests stay unchanged, and recovery assumes no delivery.
A reviewer's retained `verdict.json` is read back instead of being reported missing, and a source the
harness could not read, a pagination bound that was reached, and a report that is missing or cannot
be read as the conversation it claims to be (an older workspace whose `result.json` or review record
is unusable) are named as gaps in the snapshot and in the prompt, so a turn is told what is
incomplete instead of being started as though the history were whole. Snapshots are immutable: a
refresh writes a new one and leaves the one a running turn holds exactly as it was. See
[docs/WORKFLOW.md](../docs/WORKFLOW.md) §9.

## `source`: tasks from a Jira queue

A source command takes work from outside and hands it to the **same** loop. It finds eligible
issues, maps each one onto the existing four-field `Task`, claims it, runs it exactly as `run` would,
and posts a compact result back. Only the intake is new: the working copy, the checks, the coding
turns, the repairs, the deadline, the logs, and the report are the ones described above.

```sh
# Static: validates the composed configuration, the project's queue included. No credential, no network.
npm start -- check-config --config nexus.config.json --project ../target-project

# Read-only preview: contacts Jira, claims nothing, starts no run, costs no coding turns.
npm start -- source list --config nexus.config.json --project ../target-project

# One finite batch, run sequentially. --limit bounds fresh attempts, not the whole queue.
npm start -- source run --repo ../target-project --config nexus.config.json --limit 1

# Scan, run the batch, wait, and scan again until you stop it (Ctrl+C).
npm start -- source watch --repo ../target-project --config nexus.config.json
```

`source list` needs `--config` and `--project`, because it reads the connected project's
configuration without opening a working copy. `source run` and `source watch` take `--repo`
instead: it is the one repository every fetched issue is bound to, and the checkout the project
configuration is read from. Every source command rejects `--task`: a source task comes from Jira,
not from a file. The whole batch is discovered **before** any issue is claimed, and the
runs are strictly sequential. Jira decides the order, and the preview prints the issues in that same
discovered order. With the default `"ordering": "priority"` the highest-priority ready issue comes
first, then the oldest creation, then the issue key. With `"ordering": "rank"` the board's own
manual order decides — `ORDER BY Rank ASC`, then the same creation and key tie-breakers — so moving
an issue on the board steers what the next fresh scan offers. Either way the harness takes Jira's
answer as the batch order: it never sorts locally, never reads Rank values, and never combines the
two orders. A Priority or Rank change takes effect on the next fresh scan and never reorders an
active task or a batch that was already discovered.

The queue is the connected project's `source` object, and nothing else — the repository carries it,
so the same Nexus-wide harness file can serve several projects with different queues:

```json
{
  "source": {
    "type": "jira",
    "siteUrl": "https://your-site.atlassian.net",
    "cloudId": "9337c4da-7d33-4c1d-b03c-db207e537f88",
    "projectKey": "SAM1",
    "label": "harness-task",
    "ordering": "priority",
    "pollIntervalSeconds": 30
  }
}
```

`issueType` (`Task`), `label` (`harness-task`), `readyStatus` (`To Do`), `runningStatus`
(`In Progress`), `reviewStatus` (`In Review`), `ordering` (`priority`), `pollIntervalSeconds`
(`30`, at least `5`), and `tokenEnv` (`JIRA_API_TOKEN`) have the documented defaults, so the minimum
is `type`, `siteUrl`, `cloudId`, and `projectKey`. `ordering` accepts exactly `"priority"` and
`"rank"`: any other value, an explicit `null`, or a value of the wrong type is an input error, never
a default and never a coercion. A site that refuses Rank JQL — the field is unavailable or the
service account may not view it — fails that scan with Jira's own bounded error and starts no task:
the harness never falls back to Priority, never guesses a board order, never calls the Jira Agile
board API, and never writes Rank. `check-config` prints the intake order it validated
(`source ordering  priority: Jira priority DESC, then created ASC, then the issue key`, or the same
line with `rank: Jira Rank ASC` in its place) without contacting Jira. `docs/WORKFLOW.md` §5 is the
contract; `docs/nexus.project.example.json` is a credential-free example, and
`examples/jira-description.md` shows the description format an issue must use.

**Running the harness on this repository itself** works, as long as the checkout is clean and the
output stays outside it: this repository commits its own `nexus.project.json`, and the operator's
Nexus-wide file sits in the checkout as `nexus.config.json`, gitignored (an untracked file would
make this checkout dirty for preflight), pointing `workDir` at a sibling directory —
`../nexus-jira-runs` — so no run directory is ever created inside the source.

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
report, and the round the run started with is not one. Without delivery or review-to-completion,
nothing here moves an issue to Done and no pull request is merged: local commits a coding turn makes
stay in the retained workspace, and the comment says so. When delivery is configured the comment
carries the pull request URL, and when review-to-completion is configured the same source command's
bounded completion pass may carry an approved pull request through native auto-merge and the
configured post-merge workflows to `Done` — or return the item to its To Do status with the
findings ([docs/spec.md](../docs/spec.md) §10, [docs/WORKFLOW.md](../docs/WORKFLOW.md) §10). A coding turn
does none of it.

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
red does Astra run — in the **same retained workspace**, so the earlier commits are still in it —
with its own two-repair allowance, and the tier's own launch is what really starts and what its
report records. A turn is asked to commit what it wants the next turn to build on: the harness
starts no further turn from a working copy that still holds uncommitted work, and one left that way
stops the run for a person instead of climbing. Escalation is local to one coding cycle: every claim
starts at the first tier, so a ticket that a reviewer's findings, a failed required check, a delivery
failure, or a failed post-merge workflow sent back to its ready status returns to Flash in its
retained workspace, with the work and guidance it accumulated, and the workspace's own attempt count
never selects a tier.
Only an exhausted ordinary red check round climbs: a run that ended before any coding turn, a setup,
launch, authentication, or protocol error, a cancellation, a timeout, and an unconfirmed cleanup all
end the intake at the rung where they happened rather than spending a stronger launch on them, and
that attempt's result is then the issue's last word — published and moved to review, except where a
required local save failed or the run's stop was not confirmed, which publish no comment and leave
the issue in the running status. A tier that names no `agent` or `maxRepairs` inherits the top-level
one, and no `escalation` at all means the single ordinary tier. The launch prefixes above are
operator-native Codex profiles;
[nexus-agent-tools.md](../docs/nexus-agent-tools.md) is how to install them, and the harness never reads
or writes them.

```sh
# One finite batch with the ladder: Flash first, Astra only if Flash's checks stay red.
npm start -- source run --repo ../target-project --config nexus.config.json --limit 1
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
workspace's base has nothing to publish. A working copy left checked out at another revision than
its recorded branch is **refused** as well: what would be pushed is the recorded branch, and what
the checks validated is the revision the copy is at, so nothing is switched or adopted and the
failure names both revisions. Before the checks that judge a turn, the run returns a clean checkout
to its recorded branch when it can — a fast-forward and a checkout, with the commit a turn made on a
branch of its own kept on that branch — and a detached, divergent, or branchless checkout stops the
run before any check, with both branch names and what to do by hand; that is what keeps the
validated revision and the published branch the same. That return refuses to write over a local
file the working copy ignores, naming the paths instead, and reads back what the checkout and the
fast-forward did, so a configuration that squashed the merge cannot pass for a returned branch. A
coding turn starts only from committed state, so a working copy left holding uncommitted work stops
the run before the next agent instead of being handed to one. The pull request is found by repository,
head branch, and base branch — the
one open match is updated, a closed or merged one is refused instead of edited, and one is created
only when no match exists at all. Later committed work
updates the same branch and the same pull request, because a continued attempt reuses the workspace
and its branch. The delivery step itself never merges the pull request, force-pushes, or changes
Jira status. The
separately configured review-to-completion path can carry it further: once the current head carries
the configured approval and check, it works through native GitHub auto-merge, verifies the
configured post-merge workflows on the merge commit, and moves the item to Done; a definitive
finding returns it to the To Do status instead. GitHub performs the merge under branch protection,
and the queue arms auto-merge before the reviewer publishes the final required check (see
[`queue`](#queue-run-the-whole-queue-serially) below). Without that configuration the pull request
waits for the operator loop. Delivery applies to source attempts
only: a `run --task` invocation clones afresh every time, so it has no stable branch to deliver and
stays local. [docs/spec.md](../docs/spec.md) §7 and [docs/WORKFLOW.md](../docs/WORKFLOW.md) §8 are the
delivery contract, and [docs/spec.md](../docs/spec.md) §10 with
[docs/WORKFLOW.md](../docs/WORKFLOW.md) §10 the completion contract; delivery command output and the
published body are kept in the run's own `logs/` directory.

**Nothing runs twice by accident.** `.intake/receipts/<hash>.json` under `workDir` records each
attempted issue by its immutable ID, and a receipt is created **before** the issue is claimed. A
receipt survives a restart, and editing or reopening the issue does not clear it. Nor is a receipt
the whole story: what happens next is decided by the pointer label below — a receipt with no
pointer refuses the issue instead of silently repeating it. The
`.intake/locks/<connected-project-namespace>/` directory makes sure only one consumer takes tickets
for a connected project under that output directory; it is never broken automatically. The
namespace is the stable hash of the project's own composed identity — its Jira site, cloud ID and
project key, and its GitHub destination repository — so two different connected projects may
consume their own queues under one `workDir` and one harness configuration, while a second consumer
of the same project and `workDir` is refused with that lock's ownership diagnostic.

**Where an issue's work lives is written on the issue.** The run that creates a workspace adds one
`harness-ws-<workspaceId>` label, before any coding turn, and a later attempt only ever reads it.
That is what makes a rework possible: move an attempted issue back to the ready status and the
harness **continues its workspace** — the same clone, on the same branch, with the work of the
earlier attempt still in it, and a baseline that is allowed to be red, because continuing failed
work is the point. An attempted issue with no such label is not run again: the harness refuses it,
says why in a comment, and moves it out of the queue, so a stale ticket cannot quietly burn more
attempts. A pointer the harness will not follow is refused the same way, and the comment says which
of these it is: it is not a usable workspace id (a label is never read as a path), it names a
workspace this machine does not have, its directory or its ledger is a junction or symbolic link
out of `workDir/workspaces` (a pointer is never followed through one), the workspace's ledger
records another item, site, or repository (a workspace is continued only by what created it), or
the ledger records no item identity at all (a legacy ledger: add its `sourceItem` by hand —
`type`, `scope`, `id`, and `key`, from that workspace's first attempt report, whose `sourceRef`
records them — and scan again; the harness never adopts or migrates a workspace on its own). An
issue carrying two pointers is refused too, because there is no way to tell which one to continue.
The receipt stays as the audit trail behind all of it.

**The retained work is named after the ticket.** A workspace a Jira attempt creates is named after
the ticket's canonical key — `HARN-23` — so the directory a person sees under `workDir/workspaces`
names the ticket it belongs to, while the attempt's own evidence keeps its generated
`run-<timestamp>-<hash>` directory under `runs/`. The name is settled before anything is created: a
name something already holds — another ticket's workspace, a directory with no trustworthy ledger,
or this ticket's own workspace with no pointer label — is **refused** with guidance rather than
adopted, overwritten, or quietly replaced by a different name, and a ticket whose key changes later
keeps the workspace its pointer already named. File-task runs keep the generated name they always
had.

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
a continued attempt instead works in the workspace its pointer names, and the commits the earlier
attempts left there are still in it. One that left uncommitted work is refused before its next
coding turn: commit or remove those paths by hand in the workspace and scan again.

## `review`: reviews of In Review tickets through Nexus Lens

The optional Nexus-wide `reviewer` object turns on the second half of the Jira-driven loop: the
tickets the harness has already worked — the ones the connected project's `source` connection
reports as **In Review** — are reviewed automatically, and each verdict is published to GitHub as
one native review plus one app-owned check run. It is off unless the harness configuration asks for
it, and the review commands themselves are read-only on Jira: they claim nothing, move nothing, post
no comment, and never mark an issue Done. The separately configured completion path
([docs/spec.md §10](../docs/spec.md#10-optional-review-to-completion),
[docs/WORKFLOW.md §10](../docs/WORKFLOW.md#10-review-to-completion--optional-across-both-files)) may
move an item to Done only after it verifies the merge and every configured post-merge workflow
succeeded. A current-head request for changes or a definitive failed required PR check can instead
return the item to To Do before merge; an unsuccessful post-merge workflow also returns it to To Do,
with findings and its workspace pointer preserved. The repository whose pull requests are reviewed
is the one the project's `delivery` names, so the two can never describe different artifacts.

```sh
# Static: validates the reviewer and the project it composes with. No credential, no network.
npm start -- check-config --config nexus.config.json --project ../target-project

# One finite pass over the tickets in the configured review status.
npm start -- review scan --config nexus.config.json --project ../target-project

# One pass, then keep scanning with the source's interval until stopped (Ctrl+C).
npm start -- review watch --config nexus.config.json --project ../target-project

# Bound the paid reviewer turns one pass starts: a ticket already reviewed costs none.
npm start -- review scan --config nexus.config.json --project ../target-project --limit 1
```

The reviewer is one strict Nexus-wide object; `docs/nexus.config.example.json` is a credential-free
example to copy, [docs/WORKFLOW.md](../docs/WORKFLOW.md) §9 is the field contract, and
[docs/spec.md](../docs/spec.md) §9 is the behaviour. For this installation the App is `nexus-lens`
(app id `5001141`, installation `163007360`) and the reviewer is the Astra profile:

```json
{
  "reviewer": {
    "app": {
      "appId": 5001141,
      "installationId": 163007360,
      "privateKeyPathEnv": "NEXUS_LENS_PRIVATE_KEY_PATH",
      "login": "nexus-lens[bot]"
    },
    "reviewer": {
      "runtime": "codex",
      "command": ["codex", "--profile", "nexus-astra", "--model", "gpt-6-astra"]
    },
    "checkName": "Nexus Lens review"
  }
}
```

That object belongs to the Nexus-wide harness configuration: the App, the reviewer launch, and the
check's name are installation-wide. Which repository is reviewed is not: it is the connected
project's own `delivery.repository`, which is also where its passed attempts are pushed.

**What one pass does.** A ticket is eligible when it is in the `source` connection's review status
with the configured project, issue type, and label, it carries exactly one valid
`harness-ws-<workspaceId>` pointer label, and exactly one open pull request in `repository` has the
head branch `harness/<workspaceId>` — the repository the ticket's project `delivery` names. A
ticket whose local intake receipt records a failed or
cancelled attempt — or a reservation with no finished attempt — is reported too: a review approves
work, and a pull request that predates the failure is not the successful code awaiting approval.
Anything else — no pointer, two pointers, no pull request, more than one match — is reported and
left in review; nothing is published for it. For an eligible
ticket the scan gives the reviewer a **repository view** instead of an assembled patch: a clone of
the ticket's own retained workspace (`<workDir>/workspaces/<workspaceId>`, the one its pointer
label names), detached from it so it keeps no remote, and pinned at exactly the pull request's
head with the change's base commit in it. The view holds no credential of any kind — the App
private key and the installation token stay with Nexus — and the reviewer reads files, history
and diffs there with ordinary read tools. The scan also reads the head's check runs and combined
status, and runs the configured reviewer as **one bounded turn** in its own evidence directory
under `<workDir>/reviews/`, one directory above the view — deliberately not inside the checkout,
so the pull request's own `AGENTS.md` files stay evidence the reviewer reads, not instructions that
govern its turn. The reviewer never
changes the view, implements fixes, commits, pushes, merges, or edits the ticket: it writes one
verdict which the harness validates. `REQUEST_CHANGES` needs at least one finding and is published
with inline file/line comments where the pull request's own diff can position them; `APPROVE` is
published only for a completed verdict with no blocking findings. Before publishing anything, the
scan checks that the view is still the clean snapshot at that head, re-reads the pull
request head, and re-reads the ticket, so a head that moved, a ticket that left review, or a view
the turn changed publishes nothing and is reviewed again later. Then the verdict becomes one native
review pinned to the
reviewed commit, and one app-owned check run named `Nexus Lens review` on that same head:
`success` only for an approval, `failure` for a requested change. A missing credential, an
unavailable tool, an API failure, and incomplete evidence are reported as such, never as an
approval, and never start a coding turn.

The reviewer can explicitly return `inconclusive`, explaining missing material evidence and what
the coordinator needs to provide. It publishes neither a native verdict nor a check. Known missing
patches (including binary files) and a change far too large to render are **not** refusals: the
reviewer reads the change from its view, and a finding the patch cannot position is written in the
review body. What is refused before a paid turn is a review that cannot be given a pinned view —
no retained workspace on this machine, a workspace that does not hold the reviewed head or its
base commit, a clone that fails, a view that is not clean, or a ticket description over the
documented size bound — and a change GitHub lists in more than three pages of files, whose list
is treated as incomplete. Each of those is reported for a coordinator, never as an approval and
never as a coding turn. Approval requires a completed review with sufficient evidence;
pending CI alone does not prevent a code review, because CI remains a separate merge requirement.

**A repeated scan does not review an unchanged head twice.** A completed review by the configured
App login whose `commit_id` is the current head is the native record that the head was reviewed; a
later commit is a new head and is reviewed again. If a review exists but its check run is missing
or contradicts the latest native verdict, the next scan creates or updates the app-owned check
from that verdict instead of reviewing again. An old success cannot substitute for a later
request for changes. Incomplete native review/check lists require attention. There is no
local review database and no second coding consumer.

**Operator setup for this installation.** The `nexus-lens` App needs **pull requests: write**,
**checks: write**, and read access to contents, commit statuses, and metadata, and it must be
installed on the destination repository. Put the **path** of its private key PEM (never the key
itself) in the environment variable the configuration names, here
`NEXUS_LENS_PRIVATE_KEY_PATH`:

```powershell
$env:NEXUS_LENS_PRIVATE_KEY_PATH = "C:\keys\nexus-lens.pem"
```

Then require, in the destination's branch rule, **both** the repository's CI check and the
`Nexus Lens review` check **from this App** (`app5001141`, spelled the way the rule UI shows it). A
generic "one approving review" rule does not identify Nexus Lens and is not the signal this
increment provides; the app-owned check on the reviewed head is. The App remains a separate
identity: installation tokens are restricted to the configured repository and required permissions;
`delivery` still pushes and opens pull requests with your own `git` and `gh` login, and
the harness stores no GitHub credential. Start with `review scan --limit 1` and inspect the review,
the check run, and the evidence under `<workDir>/reviews/` before letting `review watch` run
unattended. The scan also needs the ticket's own retained workspace under that `workDir`, on the
machine running it: that is what the reviewer's view is cloned from. Do not delete or move a
workspace whose pull request is still awaiting review — a review that cannot be given a pinned
view reports the ticket for attention instead of reviewing it.

**What the review commands leave alone.** A review publishes the verdict and its app-owned check and
stops there: it never merges, enables auto-merge, verifies a merge, or changes Jira, and no
pull-request CI result is interpreted as part of the review — CI remains a separate merge
requirement. Carrying an approved pull request further is the independently optional
review-to-completion path ([docs/spec.md](../docs/spec.md) §10, [docs/WORKFLOW.md](../docs/WORKFLOW.md)
§10): with `delivery.completion` configured, the deterministic completion pass arms native GitHub
auto-merge, verifies the configured post-merge workflows, and moves the item to Done, or returns it
to To Do with the findings and its retained pointer. Without that configuration, the pull request
waits for a person. A pending CI run and an infrastructure or authentication failure stay In Review
for diagnosis rather than triggering code repair.

## `queue`: run the whole queue serially

The optional `delivery.completion` path can carry an approved pull request through GitHub's own
merge to a Jira Done. A person still had to decide when each step happened. The two `queue`
commands make that a foreground loop: one ticket at a time through the coding attempt, the
delivery, the Nexus Lens review, and the completion path, with the local checkout prepared for the
next workspace in between.

```sh
# Static: validates the objects the queue needs too. No credential, no network.
npm start -- check-config --config nexus.config.json --project ../target-project

# Finite: finish tickets until a fresh scan finds no eligible one, then exit 0.
npm start -- queue run --repo ../target-project --config nexus.config.json

# One foreground process that waits for the next eligible ticket (Ctrl+C stops it).
npm start -- queue watch --repo ../target-project --config nexus.config.json
```

A queue command needs three objects to be configured: the project's `source` (the Jira queue it
takes from) and `delivery` **with** `delivery.completion` (its destination and the path that ends a
ticket), and the harness configuration's `reviewer` (the Nexus Lens path). The loader already
requires them to agree — the review belongs to the delivered repository, and the reviewer and the
completion gate name the same App, login and check — so a configuration that could never complete a
ticket is refused before any credential is resolved. The queue uses the Jira service-account token
and the App's private
key path, renewing the App installation token for completion evidence reads as needed with the
same Lens permissions used by reviews. Public post-merge workflow reads need no added Actions
permission in the token request; inaccessible evidence stops the queue for attention. Only the
operator credential arms auto-merge.
Queue mode does not require a pre-minted token in `reviewerTokenEnv`. Each child gets only the
credentials its phase needs. [docs/WORKFLOW.md](../docs/WORKFLOW.md#11-serial-queue--queue-run-and-queue-watch) §11 is
the command contract and [docs/spec.md](../docs/spec.md) §11 the behaviour.

What one invocation does:

1. **One current ticket.** A fresh scan of the configured ready queue, in the source's own configured
   order (Jira's Priority field by default, the board's native Rank with `"ordering": "rank"`),
   offers at most one ticket; it is claimed and run through the same workspace/check/repair loop,
   ladder included, and delivered as a pull request.
2. **Arm, then review, then completion.** As soon as the pull request is delivered or updated, the
   queue arms native auto-merge for that exact head — before the Nexus Lens check is published,
   because GitHub refuses to arm a pull request whose required checks are already clean. Nexus Lens
   then reviews that head; the completion path verifies the recorded arm, waits for GitHub's own
   merge, requires every configured post-merge workflow to succeed, and then comments and marks the
   ticket Done. A refused arm stops the queue with the refusal as evidence and leaves the ticket In
   Review.
3. **Repair before anything else.** Findings from the review, a definitively failed required check,
   or an unsuccessful post-merge workflow return the ticket to To Do with its pointer intact. The
   queue then continues **that** ticket in **that** retained workspace — same clone, same base,
   same ladder — before considering unrelated ready work.
   A completed red baseline is the same idea one step earlier: the configured reviewer diagnoses
   that exact snapshot in one bounded local turn, does not touch GitHub, and an actionable finding
   is one Jira comment plus the same return to To Do with the pointer intact. The next claim
   continues the workspace with the finding as guidance — every field of it whole, on every rung of
   that claim, at the width the reviewer's finding was validated at rather than the bounded width
   the comment on the ticket renders it as — repairs the baseline, and then continues the original
   task. That finding is read from
   the ticket's thread, or, when the thread cannot supply it, from the evidence the diagnosis kept
   under the connected project's own namespace. The thread counts only as its whole comment: the
   marker naming the evidence the retained record closed as a repair, all four fields, and every
   one of them equal to the finding that record holds. A partial, edited, or differently attributed
   comment is ordinary context, and the recorded finding is handed over instead; when nothing can
   supply it, no developer starts: the ticket is told why on its own thread, taken out of the
   running status with its pointer preserved, and the queue stops for a person.
4. **Source readiness.** After a confirmed Done, the operator's checkout must be on the configured
   base branch, carry no uncommitted or untracked work, and have the expected delivery repository
   as a remote; the verified merge commit must be in the fetched base branch and the local `HEAD`
   an ancestor of it, so the only move is a fast-forward. Nothing is reset, forced, stashed,
   discarded, committed, or reconciled; a checkout that cannot be proven ready stops the queue
   with what to fix.
5. **Fresh scan, or a visible wait.** `queue run` exits `0` when no eligible ticket remains.
   `queue watch` prints an idle status, waits `source.pollIntervalSeconds`, scans again, and starts
   no agent while it is idle.

Anything a person has to decide — a failed or cancelled attempt, a delivery failure, a review with
no usable verdict, a merge or post-merge workflow still pending at its deadline, a conflict, an
authentication or API failure, an unsupported transition, a checkout that is not ready — exits
nonzero with the ticket's evidence kept. The blocked ticket is never skipped for another one. One
queue invocation holds its connected project's intake lock for its whole life, including while it
waits, so a second queue for the same project and `workDir` is refused while a queue for a
different connected project may run under the same `workDir` and harness configuration. It keeps
no database, scheduler, daemon, or durable queue: Jira's status, the pointer label, GitHub's native
state, and the existing receipts are what a restart reads. No two real project queues have been run
concurrently yet; the boundary is verified offline, as the lock's own regressions below state.

**One stated limit.** A ticket whose pull request GitHub has already merged cannot be repaired in
place: the delivery step refuses to edit a merged pull request, so a repair after an unsuccessful
post-merge workflow ends as an actionable stop rather than a second pull request. Turning that into
a new ticket is an operator decision.

**Restart recovery.** Before each fresh claim, the queue checks authoritative Jira status for
unfinished work. It stops on In Progress ownership that an operator must resolve, and resumes a
single In Review ticket through its scoped review and completion phases. Multiple In Review
tickets stop for attention. A merged pull request must still pass the existing admission and native
GitHub checks. Ready tickets with retained workspace pointers resume before unrelated new work;
Done tickets are never rerun. The queue never adopts or resets a workspace.

### One ticket at a time, by identity

```powershell
npm run dev -- queue run --repo ../target-project --config nexus.config.json --ticket HARN-51
```

`--ticket` narrows a finite queue run to one ticket. The run reads that ticket's own status and
follows it by identity — a ticket in review resumes its scoped review and completion, a ready
ticket with a workspace pointer continues that workspace, and a ready ticket without one is the
claim. Nothing else is discovered, claimed, or reported on. A scoped ticket that is in none of the
configured statuses leaves the run with nothing to do and exits `0`, like an empty queue; a scoped
ticket still in the running status is refused by name, because something else may still be working
on it.

## `supervise`: run the queue under a recovery agent

```powershell
npm run dev -- supervise run --repo ../target-project --config nexus.config.json
npm run dev -- supervise watch --repo ../target-project --config nexus.config.json
npm run dev -- supervise ticket HARN-51 --repo ../target-project --config nexus.config.json
```

The supervisor is a small parent around `queue run` and `queue watch`. It starts the queue as a
worker of its own — the same CLI, the same two files, and the worker's activity display intact —
and watches how that process ended. A plain zero exit settles the supervision. An ending the
operator asked for with Ctrl+C stays stopped: the worker is stopped, its evidence is kept, and
nothing is recovered from an intentional stop. Any other ending — a nonzero exit, a process killed
by a signal, a crash that left no report at all, a worker that could not be started — opens one
incident and starts the separate recovery agent described in
[docs/WORKFLOW.md](../docs/WORKFLOW.md#12-supervision--supervise-run-supervise-watch-supervise-ticket)
§12 and [docs/spec.md](../docs/spec.md#12-supervised-recovery) §12.

The recovery agent's own judgment investigates the cause, preserves committed and uncommitted work,
repairs the harness or the working copy, reconciles the ticket and the workspace, and says what
resumes. A ticket that has to come first may be ranked ahead of the interrupted one, and its
resumption is recorded on the incident. One incident spends at most `recovery.maxAttempts` recovery
turns; the same failure returning unchanged after a repair ends in an actionable request for human
help. Recovery may repair the Nexus installation itself — including its own code — and runs the
installation's checks when it does. It never weakens a project's tests or checks, never approves,
merges or pushes, and never marks a ticket Done: its report is context for the next developer and
reviewer turn, and the configured checks, the Nexus Lens review and the completion path stay the
only things that decide whether work is done.

Each incident publishes one concise report into the ticket's own Jira thread — written by the same
service account that wrote the ticket, so both the next developer turn and the next reviewer turn
read it in the shared history — and one email summary through the configured SNS topic to the
configured address (in the shipped example,
`arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications` to `saint282@gmail.com`). Both
publications survive a supervisor restart without repeating: an acknowledged comment is never
posted twice, an interrupted one is looked for in the thread before another is sent, and an
acknowledged summary is never published again. A failed publication is recorded as the incident's
reporting problem and never repeats a recovery that succeeded.

The configuration needs a `recovery` object with its notification policy, and the notification
publisher (the AWS CLI by default) needs to be able to publish to that topic:

```json
"recovery": {
  "agent": {
    "runtime": "codex",
    "command": ["codex", "--profile", "nexus-recovery", "--model", "gpt-6-astra", "-c", "model_reasoning_effort=high"]
  },
  "maxAttempts": 2,
  "notifications": {
    "topicArn": "arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications",
    "email": "saint282@gmail.com",
    "publisher": ["aws", "sns", "publish"]
  }
}
```

The recovery launch is the `nexus-recovery` profile
([docs/nexus-agent-tools.md](../docs/nexus-agent-tools.md) §5), which is what gives that turn its
unattended operational access: the output directory's workspaces and processes, GitHub through the
operator's own credentials, the ticket thread through the service account credential the
supervisor's environment carries, and the notification topic above. A `supervise` invocation
refuses a configuration that declares no `recovery` policy, no notification policy, or a readable
project configuration that composes no queue, before it claims anything. A project configuration
that cannot be read at all does not stop it: the supervisor starts, names the problem, and
supervises a worker that will stop on it, which is the state the recovery agent is there to repair.

The parent can also be started on its own, which is what to reach for when the ordinary CLI will
not load:

```powershell
node dist/cli/supervise.js run --repo ../target-project --config nexus.config.json
```

That entry point takes exactly the arguments above and loads the supervisor, the harness
configuration and the display — no ordinary command, and no worker module — so a broken queue or
run module is repaired by the recovery agent instead of taking the parent down with it. The worker
it starts is the ordinary CLI beside it (`dist/cli.js`).

The supervisor keeps only:

```text
<workDir>/.supervisor/<supervision-id>/     # a hash of the checkout and the harness configuration
  owner.json                        # the live supervisor, created exclusively; a second start is refused
  current.json                      # the incident being carried, and the worker's PID
  incidents/<incident-id>/incident.json   # stops, origin, attempts, pending attempt, resume plan,
                                          # conclusion, resumption, report ids and states
  incidents/<incident-id>/attempt-1/{input.md,recovery.log,outcome.json}
  incidents/<incident-id>/recovery-notification*.{stdout,stderr}.log
```

One supervisor runs per supervision — one checkout and one harness configuration — and the owner
record is created exclusively, so two simultaneous starts cannot both own it. A restart adopts the
incident its predecessor left instead of starting a second worker; a recorded worker PID, or a
recovery turn's runtime PID, that is still alive refuses a supervisor that would put a second one
beside it; and an attempt that was left in flight is reconciled from its own `outcome.json` rather
than launched again, counted toward `recovery.maxAttempts` either way. Starting the supervisor
while a raw `queue` consumer still runs is refused with the intake lock and its owner named — stop
that consumer first; a lock is never broken automatically.

An incident's report survives a restart without repeating itself. The Jira comment is looked for in
the ticket's thread before another is posted, and the email summary is written down as `pending`
before the publisher runs, so a restart can tell an unattempted send from one that was in flight:
the publisher's own output is read back, an acknowledged `MessageId` is adopted, and a send that was
never acknowledged is recorded as `interrupted` and left to a person to check rather than sent
again. A publication that failed is retried by the next invocation without repeating the recovery
that succeeded, wherever the incident record sits. A blocker a judgment ranked ahead of the
interrupted ticket really runs first — as its own scoped `queue run --ticket <KEY>` worker — and the
resumption is recorded when the interrupted work is really started again.

Exit codes are the queue's own with the supervision added: `0` when the worker settled, `1` when an
incident needs a person or an input, configuration, or publication error stopped the supervision,
`2` for a usage error, and `130` for the operator's own interrupt.

## Example task

A local task describes an outcome for a connected repository. For example:

```json
{
  "id": "greeting",
  "title": "Greet a list of names",
  "description": "The application greets one person. Add a way to greet every supplied name while preserving single-person greetings.",
  "acceptanceCriteria": ["Every supplied name receives a greeting."]
}
```

With the project's own setup and checks configured, a run follows this idea:

```text
prepare working copy
check the baseline
ask the developer to implement the task
run the configured checks
while checks fail and repair allowance remains:
    give the observed failures to the developer
    run the checks again
retain the work and report the observed outcome
```

The exact setup and checks come from the connected project, not from task prose.

## Safety, limits, and what a run does to your machine

Read this before pointing a run at anything you care about.

- **Configured commands execute target-project code.** `setup` and `checks` are started as real
  processes, in the working copy, with your user's privileges and no sandbox. The coding turn is
  **unsandboxed too**: it runs with `--sandbox danger-full-access` and `--ask-for-approval never`, so
  it can read and write anywhere your user can, exactly like a configured command. That is a
  deliberate, documented choice, not a fallback — the narrower `workspace-write` policy this CLI
  offers on Windows leaves the working copy's `.git` read-only, so a turn cannot stage or commit its
  work (`git add` fails on `.git/index.lock`). An unattended run still never waits for a
  prompt. The one turn that is not a coding turn is the pre-delivery baseline diagnosis (§11): it
  stages nothing and must not change what it inspects, so it runs as `--sandbox workspace-write`
  with its own working directory as the only writable root — that launch states the policy's
  additional writable roots as none and excludes the host's temporary roots — and the snapshot and
  the retained working copy are read-only to it however `workDir` is placed and whatever the
  operator's own configuration grants. Treat a target project's configuration the way you would
  treat a script you are about to run.
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
- **By default the harness pushes nothing and integrates nothing; only explicitly configured
  optional steps do, and never a coding turn.** The working copy is given a repository-local commit
  identity (`Nexus Agent <nexus@local>`, commit signing disabled) and its turns are asked to commit
  small pieces as they go — but those commits are the turn's own doing, local to the retained
  workspace, and no remote is added, so there is no default push destination. With a `delivery`
  object configured, the harness itself pushes a **passed** attempt's branch to the repository you
  named and opens or updates its pull request; it never force-pushes and never edits a closed or
  merged pull request. With review-to-completion also configured, the deterministic completion path
  may arm native GitHub auto-merge — GitHub performs the merge under branch protection — verify the
  configured post-merge workflows on the merge commit, and move the Jira item to Done; it never
  force-pushes, bypasses protection, reruns a workflow, or publishes anywhere else. Without those
  steps, nothing here integrates the work for you.
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
- **`source` commands add one small lock per connected project.** `.intake/locks/<namespace>/`
  under `workDir` keeps two consumers of the _same connected project_ out of one output directory,
  while two different connected projects may consume their own queues under it concurrently. It is
  not a distributed lock: two watchers with different `workDir`s against the same Jira queue are
  unsupported. Jira statuses are not a lease either: there is no exactly-once guarantee across
  machines, and the receipts only protect the directory they live in.
- **A queue from a revision before this one keeps the old lock path.** A consumer that predates the
  per-project namespace holds `.intake/lock/` under `workDir`, which names no project; this
  revision refuses every project while that path exists, including stale or unreadable owner
  metadata. Let active work finish before upgrading, inspect the owner, and remove the old directory
  by hand only once it has stopped. Do not mix old and new consumer revisions under one storage
  root; older binaries cannot recognize the new locks. Locks are never broken automatically.
- **Legacy completion evidence needs manual reconciliation.** Old `completion-logs/<issueId>`
  directories contain no source or repository identity. A matching issue ID stops completion
  before GitHub commands or Jira writes. Verify the old evidence's ownership and preserve any
  active admission and deadline when reconciling it, then move the old directory aside by hand;
  the harness never adopts, overwrites, or silently resets it.
- **A ready issue is an authorization to spend agent capacity.** The configured project, issue
  type, label, and ready status are the queue boundary, and the harness does not ask again: put
  only work you would run yourself behind that label, in a project whose issues are trusted input.
  Issue text is context for the coding turn and for review; it can never choose a repository,
  a command, an environment variable, or a limit — but the turn still reads it and can act on its
  content inside the working copy.
- **An `In Review` issue in the configured queue is an authorization to review and publish.**
  `review scan` and `review watch` read that queue and, for an eligible ticket with a clearly
  identified open pull request, publish a native GitHub review and an app-owned check run as the
  configured App installation. The App's private key path lives in the environment the harness is
  started in, never in JSON, a task, or a log; the reviewer turn runs with the same unsandboxed
  reach a coding turn has — the pre-delivery baseline diagnostic is the narrower
  `--sandbox workspace-write` exception, because it must not change what it reads — is told not to
  change anything, and is never merged or asked to fix what it finds. Point the App at a repository
  whose rules you are prepared to gate with its check.
- **Not implemented, and not planned here:** automatic merging outside the configured completion
  path, automatic workflow reruns, a provider registry, workflow engines, background services,
  webhooks, parallel consumers of one project's queue, and a second coding runtime. Without
  `delivery`, a passed attempt's work stays local; with `delivery` alone, its branch is pushed and
  its pull request is opened or updated, and the pull request stops there; with review-to-completion
  configured, the deterministic path of [docs/spec.md](../docs/spec.md) §10 carries an approved pull
  request through native auto-merge and the configured post-merge workflows to Jira Done, or
  returns it to To Do with findings. Reviews record a verdict and stop there. There is exactly one
  runtime interface (the Codex CLI), exactly one loop, exactly one implemented task source (Jira),
  exactly one optional delivery step (GitHub), exactly one optional review path, and exactly one
  optional completion path.

## What is verified, and what is not

**Verified offline** means the repository tests executed without live provider credentials.
They cover decisions, command and Git boundaries, and representative assembled workflows with
controlled external services.

Live behavior requires evidence from actual provider execution. A separately authorized live check is an
explicit, opt-in exercise; it is not part of ordinary validation. Local or mocked checks do not
establish the result of GitHub CI, a remote mutation or a paid agent run. Report each check for
what it actually establishes. Individual run results belong in their logs and Git history.

## Coding runtime

Nexus invokes the host's Codex CLI through its non-interactive interface. Configure the launch
prefix in the harness configuration; keep provider credentials and model settings in the runtime's
native configuration. A model change behind Codex does not require a new Nexus adapter.

The adapter handles the working directory, input, events, result and shutdown. It must preserve
these contracts when a wrapper launches Codex. Only the Codex runtime is implemented; another CLI
requires its own concrete adapter rather than being disguised as a Codex launcher.

The harness does not change the user's global runtime configuration. The configured launch is
reported as launch information, not proof of the upstream model that served the response.
See the [runtime invocation contract](../docs/WORKFLOW.md).

## Toolchain

The [architecture guide](../docs/architecture.md#tech-stack) describes the stack and dependency
choices. Versions are recorded in the package files and .nvmrc. Install with `npm ci`.

CI runs `npm run validate` on pull requests and pushes to main using the declared Node version
on Ubuntu. It verifies the delivered revision and does not publish or merge changes.

## Future work

Jira holds the current backlog.

## Optional review-to-completion

`delivery.completion` explicitly enables the agent-free path from a current-head Nexus Lens
approval through native squash auto-merge and successful configured post-merge workflows to
Jira Done. The separate `review scan`/`review watch` commands still own review judgment.
Completion runs after source batches, starts no reviewer or coding agent, and leaves
completion disabled configurations unchanged. See [the completion configuration](../docs/WORKFLOW.md#10-review-to-completion--optional-across-both-files)
and [the completion behaviour](../docs/spec.md#10-optional-review-to-completion).

Only the per-PR `enablePullRequestAutoMerge` GraphQL mutation uses the operator credential.
Read operations use the separately configured reader/reviewer token. Configure the Lens
bot login, numeric App ID and check name to match `reviewer.app` and `reviewer.checkName`.
The latest completed review must match the current head and the app-owned check must link
to that review. A failed required PR check or unsuccessful post-merge workflow returns the
same issue to To Do with findings and its workspace pointer preserved. Conflicts and
infrastructure failures stay In Review.

GitHub merged state and the expected push workflows on the exact merge commit are authoritative.
The Jira comment marker deduplicates writes; it never substitutes for those checks.
Every mutation and every ambiguous answer is settled by one fresh read of the pull request, because
GitHub can merge the reviewed head between two reads of it: an unprocessable auto-merge refusal and
a reading that no longer approves the head are reconciled the same way. The exact reviewed head
merged continues through post-merge verification without a second arm; a closed pull request, a head
that moved, or a merge the reviewer's approval does not cover is reported for a person and never
assumed. Only reads GitHub could not answer this moment are retried, inside the item deadline: the
request is never replayed, a required-check command that wrote no check result is such a read rather
than a failed check, and so is a read the harness itself stopped at its command limit, which may have
written nothing at all. The reads that guard the resolution comment and the status move share the one
item deadline instead of each minting a new budget.
The local admission file records the PR/head being followed and the polling deadline, written
before the arm request is sent so a restart verifies the armed head or resumes that merge instead of arming twice, and
can identify a PR that disappeared from the open list. A merge whose identity cannot be recorded is
reported for a person. Historical merged PRs without that admission are not backfilled.

The `queue run` and `queue watch` commands of [docs/WORKFLOW.md](../docs/WORKFLOW.md#11-serial-queue--queue-run-and-queue-watch)
§11 are what run this path per ticket, in order, with the Nexus Lens scan in front of it and the
checkout prepared between two tickets. Completion on its own still runs inside a `source` command
after a batch; a configuration that selects no queue command behaves exactly as it did.

Offline tests exercise the API and Jira recovery contracts. Live completion requires evidence
from the configured repository and provider checks.
