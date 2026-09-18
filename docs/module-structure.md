# Module structure

**What this is.** The `src/` tree the HARN-1 refactor is asked to produce: the folders a
developer would see, what each one owns, and how to add the next task source or coding
runtime without reading any of the big files first.

**What this is not.** It is a target, not a description of the repository as it stands. The
tree is still flat — `agent.ts`, `checks.ts`, `cli.ts`, `config.ts`, `jira.ts`, `report.ts`,
`runner.ts`, `source.ts`, `types.ts`, `workspace.ts` — and this document was written by an
earlier attempt that was stopped before it finished, so none of it is committed. It also
predates later work: the workspace ledger, the escalation ladder, and the guidance a
continued attempt is told. Where this document and the sources disagree about behaviour, the
sources and the contract documents below win, and the layout is what this document is for.

The behaviour contracts stay where they are defined: [spec.md](spec.md) for behaviour,
[WORKFLOW.md](WORKFLOW.md) for the JSON inputs, [architecture.md](architecture.md) for the
original placement rules, and [README.md](../README.md) for operating the harness. The
refactor moves code and splits files; it does not change the loop, the CLI, the Jira
connector, the Codex adapter, or a single behaviour, and the whole suite
(`npm run validate`) has to stay green while it happens.

## 1. Source tree

```text
src/
  cli.ts                      entry point: dispatch, exit codes, process bootstrap
  cli/
    context.ts                exit codes, CliIo, interrupt signals, CliContext
    help.ts                   the usage text and the line that points at it
    options.ts                per-command option tables and argument parsing
    check-config.ts           `check-config` and what it prints
    run-command.ts            `run`: loads the inputs, installs the stop, prints the outcome
    source-command.ts         `source list|run|watch` and the connector selection
    dependencies.ts           the loop's real collaborators, and the wrapped set a test gets
    signals.ts                host SIGINT/SIGTERM/SIGBREAK handling
  config/
    schema.ts                 zod schemas and the documented defaults, including Jira's
    load.ts                   file reading, validation, workDir and agent-executable paths
  shared/
    types.ts                  the data contracts; data only, no imports, no runtime I/O
    errors.ts                 `messageOf`: one message helper every reporting module uses
  process/
    launch.ts                 how one command is started (executable, args, Windows shims)
    command.ts                one bounded command invocation, its logs, and its result
    stop.ts                   stopping a process tree, STOP_GRACE_MS, within
  checks/
    round.ts                  one setup/check round and what a command's result means
  reporting/
    errors.ts                 ReportError
    logs.ts                   run.log, per-command logs, per-turn agent logs, repair excerpts
    report.ts                 result.json and source-task.json
    changes.ts                the final change summary and its review warnings
  workspace/
    errors.ts                 WorkspaceError
    git.ts                    git invocation (never a shell) and small path helpers
    status.ts                 reading `git status --porcelain`
    preflight.ts              preflightSource: a usable source checkout, a safe output path
    run-directory.ts          allocateRunDirectory: `<workDir>/<runId>/…`
    prepare.ts                prepareWorkspace: the clone, its branch, and its verification
    changes.ts                inspectWorkspaceChanges: what the copy differs from its base by
  runs/
    contracts.ts              run and turn requests/results, RunnerDependencies, the two errors
    runner.ts                 runTask: the loop (prepare -> baseline -> turns -> checks)
    finalize.ts               how a run ends: stop evidence, change summary, report
    stops.ts                  the stop request one phase works under, and the stop cause
    progress.ts               timeline lines, reasons, and the counts they carry
    feedback.ts               the failed commands one repair turn is given
  sources/
    contract.ts               TaskSource and the ordinary source data and errors
    receipts.ts               the intake lock and one receipt per attempted item
    coordinator.ts            runSource and watchSource: discovery, reservation, publication
    list.ts                   the read-only `source list` preview
    jira/
      connector.ts            createJiraSource: the four TaskSource functions
      http.ts                 the gateway client: auth, timeouts, failure classification
      search.ts               the queue JQL and the paged search
      issue.ts                issue reads, eligibility, and the source reference
      tasks.ts                one issue mapped onto the existing four-field Task
      transitions.ts          transition discovery, selection by target status, posting
      comments.ts             the result comment and its one POST
      json.ts                 the narrow readers every Jira answer goes through
      adf.ts                  the supported ADF description parser
      adf-text.ts             rendering that description and extracting the criteria
  agents/
    codex/
      runtime.ts              the launch prefix, the environment, and the stop contract
      adapter.ts              runCodexTurn: one turn, normalized for the runner
      prompt.ts               what one turn is told
      events.ts               reading the runtime's JSON event stream
```

Every file is a module with one job. Three files are deliberately larger than the rest:
`runs/runner.ts` (~780 lines, the loop itself), `shared/types.ts` (~550 lines, every data
contract in one declaration-only module) and `sources/coordinator.ts` (~540 lines, the finite
batch and the watch loop over the same per-item sequence). Nothing else reaches 450 lines.

## 2. Module responsibilities

### `cli.ts` and `cli/`

- **Owns:** the process entry point, command dispatch, exit codes, argument parsing, usage
  text, and everything the user sees: progress echoed from the run timeline, the outcome
  block, source-list output, and error messages. It is also the only place that composes
  the loop's collaborators, and the only place that constructs a task source.
- **Does not own:** any part of the loop, any command execution, any Git or Jira call. A
  command module resolves its inputs, hands the collaborators to `runTask`/`runSource`/
  `watchSource`, and returns an exit code.
- **Entry points:** `runCli` (`src/cli.ts`, exported for the tests), `CliContext`, `CliIo`,
  `InterruptSignals` and the `EXIT_*` constants (`cli/context.ts`).

### `config/`

- **Owns:** the two input files. `schema.ts` states what a configuration or task file may
  contain and what an omitted optional field means; `load.ts` reads the file, applies the
  schema, resolves `workDir` and a path-valued agent executable against the configuration
  file's own directory, and reports every problem under the file name.
- **Does not own:** CLI option parsing (`cli/options.ts`), credentials, or any default that
  is not documented in WORKFLOW §1/§5.
- **Entry points:** `loadHarnessConfig`, `loadTask`, `resolveWorkDir`, `ConfigError`
  (`config/load.ts`); `harnessConfigSchema`, `taskSchema`, `JIRA_SOURCE_DEFAULTS`,
  `MIN_POLL_INTERVAL_SECONDS` (`config/schema.ts`).

### `shared/`

- **Owns:** `types.ts`, the declaration-only data contracts other modules share — `Task`,
  `HarnessConfig`, `CommandResult`, `CheckRoundResult`, the report shape, source
  references, `AgentSelection` — and `errors.ts`, the three-line `messageOf` used by every
  module that reports a thrown value.
- **Does not own:** runtime behaviour and I/O. `types.ts` has no imports at all, and an
  ESLint rule (`eslint.config.js`, exercised by `tests/boundaries.test.ts`) refuses a
  `node:*` import in it.
- **Entry points:** every exported type, plus `messageOf`.

### `process/`

- **Owns:** everything about starting and ending an operating-system process. `launch.ts`
  decides how an executable plus literal arguments is started, including the Windows
  `.cmd`/`.bat` interpreter case and the argument contents it refuses. `command.ts` runs
  one bounded invocation, records its outcome, and writes its two log files.
  `stop.ts` stops a process tree the harness started and waits for it.
- **Does not own:** the meaning of a command's result (`checks/round.ts`), what a round
  does with it (`runs/`), or any vendor's invocation (`agents/codex/`). Nothing here knows
  about tasks, runs, or Jira.
- **Entry points:** `planLaunch` (`process/launch.ts`); `runCommand` (`process/command.ts`);
  `requestTreeStop`, `STOP_GRACE_MS`, `within` (`process/stop.ts`).

### `checks/`

- **Owns:** one setup/check round: setup runs first and in order, checks run only when setup
  succeeded, an ordinary nonzero check is a completed red round, and a command that could
  not be executed, was signalled, timed out, or was stopped ends the round as an execution
  error. It also owns `commandSucceeded`, the one reading of a command result.
- **Does not own:** process spawning (delegated to `process/command.ts`), repair policy,
  deadlines, or the report.
- **Entry points:** `runCheckRound`, `commandSucceeded`, `CheckRoundRequest`.

### `reporting/`

- **Owns:** what a run writes into its own directory. `logs.ts` creates the append-only
  timeline, one output pair per command invocation, one log per coding turn, and reads the
  bounded excerpt a repair turn is given. `report.ts` validates and writes `result.json`
  and the `source-task.json` snapshot. `changes.ts` builds the final change summary and its
  warnings. `errors.ts` is the single `ReportError`.
- **Does not own:** the run's decisions; it writes what it is handed, and a file that
  already exists is refused rather than overwritten.
- **Entry points:** `runLogPath`, `appendRunLog`, `openCommandLog`, `openAgentLog`,
  `agentLogPath`, `readCommandOutput` (`reporting/logs.ts`); `writeRunReport`,
  `RunReportRequest`, `runReportPath`, `writeSourceTaskSnapshot` (`reporting/report.ts`);
  `summarizeChanges` (`reporting/changes.ts`); `ReportError` (`reporting/errors.ts`).

### `workspace/`

- **Owns:** the source checkout and the working copy, and Git is invoked nowhere else.
  `preflight.ts` records the committed base and refuses a dirty checkout or an output path
  that overlaps the source; `run-directory.ts` allocates `<workDir>/<runId>`; `prepare.ts`
  clones the base, branches, and verifies what it got; `changes.ts` reads what the copy
  differs from its base by; `git.ts` and `status.ts` are the plumbing they share.
- **Does not own:** the coding turns, the checks, or the report.
- **Entry points:** `preflightSource` (`workspace/preflight.ts`), `allocateRunDirectory`
  (`workspace/run-directory.ts`), `prepareWorkspace` (`workspace/prepare.ts`),
  `inspectWorkspaceChanges` (`workspace/changes.ts`), `WorkspaceError`.

### `runs/`

- **Owns:** one run's order of work. `contracts.ts` states what a run is asked to do, what
  a coding turn is told and reports back, and which functions a run composes; `runner.ts`
  runs the loop; `finalize.ts` turns an ending into evidence, a change summary, and the
  report; `stops.ts` is the one stop request a phase honours; `progress.ts` is the wording
  the timeline and the reasons use; `feedback.ts` collects the failed commands a repair
  turn is given.
- **Does not own:** the working copy, the checks, the runtime, the report files, or any
  connector. It never imports `sources/` or `agents/`: the CLI hands it ordinary functions.
- **Entry points:** `runTask` (`runs/runner.ts`); `RunTaskRequest`, `RunTaskResult`,
  `RunnerDependencies`, `AgentTurnRequest`, `AgentTurnResult`, `RunCancelledError`,
  `RunTimeoutError` (`runs/contracts.ts`).

### `sources/`

- **Owns:** the task-input boundary and the one serial coordinator. `contract.ts` is the
  `TaskSource` contract and the ordinary source data (`SourceRef`, `SourceCandidate`,
  `SourceTask`, `SourceRunOutcome`, `SourceSummary`, `SourceError`). `receipts.ts` is the
  only retained intake state: one exclusive lock and one receipt per attempted item, keyed
  by the item's immutable identity. `coordinator.ts` discovers a finite batch, reserves,
  claims, calls the existing runner, and publishes the result; `list.ts` is the read-only
  preview.
- **Does not own:** Jira. The coordinator imports no connector, no JQL, and no credential.
  It also does not implement the run: it calls the runner it was handed.
- **Entry points:** `TaskSource` (`sources/contract.ts`), `runSource`, `watchSource`
  (`sources/coordinator.ts`), `listSource` (`sources/list.ts`), `acquireIntakeLock`,
  `readReceipt`, `reserveReceipt`, `updateReceipt`, `receiptFilePath` (`sources/receipts.ts`).

### `sources/jira/`

- **Owns:** the only implemented task source. `http.ts` is the client: the Atlassian
  gateway route, Bearer authentication, the request timeout plus the caller's signal,
  refused redirects, and the classification of a failed answer. `search.ts` builds the
  queue JQL and consumes every page; `issue.ts` reads one issue and decides whether it is
  still eligible; `tasks.ts` maps it onto the existing four-field `Task`; `transitions.ts`
  finds and posts a transition chosen by target status; `comments.ts` posts the one result
  comment; `adf.ts`/`adf-text.ts` are the small explicit description convention; `json.ts`
  holds the narrow wire readers they share.
- **Does not own:** the loop, the receipt/lock state, or the decision to run anything. A
  Jira failure is classified for the coordinator (`SourceError`), never repaired.
- **Entry points:** `createJiraSource` (`sources/jira/connector.ts`), `resolveJiraToken`,
  `jiraApiBaseUrl`, `JIRA_REQUEST_TIMEOUT_MS` (`sources/jira/http.ts`), `queueJql`
  (`sources/jira/search.ts`).

### `agents/codex/`

- **Owns:** the only implemented coding runtime. `runtime.ts` is the launch prefix and the
  host contract (environment, process-tree stop, grace); `adapter.ts` is one top-level
  turn through the host's `codex exec`, normalized to the runner's `AgentTurnResult`;
  `prompt.ts` is what a turn is told; `events.ts` reads the runtime's JSON event stream.
  No Codex flag, event, or type leaves these files.
- **Does not own:** the run, the checks, the working copy, or model/provider selection. The
  launch prefix comes from configuration, and credentials stay in the runtime's own
  environment or native configuration.
- **Entry points:** `runCodexTurn` (`agents/codex/adapter.ts`); `codexRuntime`,
  `selectedCodexRuntime`, `CodexRuntime`, `CODEX_EXECUTABLE`, `CODEX_EXEC_ARGUMENTS`
  (`agents/codex/runtime.ts`).

## 3. Dependency direction

Imports point one way, and the summary below is the whole graph between top-level modules:

```text
cli.ts (entry point)
  |
  v
cli/*  ---- the commands: parse, load, compose, print, exit
  |
  +--> runs/      the loop and how it ends
  |      |
  |      +--> checks/ ------> process/ ------> reporting/ (log files)
  |      +--> reporting/                           |
  |      +--> workspace/ -------------------------+
  |
  +--> sources/   the coordinator and the preview
  |      |
  |      +--> runs/contracts.ts   (the result it publishes)
  |      +--> sources/jira/  -----> config/schema.ts (the Task schema)
  |                                   |
  +--> agents/codex/  -----------------+--> process/ (launch and stop)
  |
  +--> config/  and  shared/  (low level: schemas, data contracts, messageOf)
```

The rules that keep it acyclic:

- `shared/` imports nothing. `config/` imports only `shared/`.
- `process/`, `reporting/`, `workspace/`, and `checks/` never import `runs/`, `sources/`,
  `agents/`, or `cli/`.
- `runs/` never imports `sources/` or `agents/`: a run is handed the coding turn and the
  checks as functions (`RunnerDependencies`), and the CLI is what wires the adapter in.
- `agents/codex/` depends on `runs/contracts.ts` for the turn's own types only; no module
  under `runs/` imports an adapter.
- `sources/jira/` depends on `sources/contract.ts` and `config/schema.ts`; nothing above
  `sources/` imports a connector except the one command that builds it (`cli/source-command.ts`).
- Nothing imports `cli.ts`, and nothing outside `cli/` writes to the terminal.

The measured edges, as the refactor's import-graph check reported them (type-only imports
included):

```text
shared/        -> (nothing)
config/        -> shared
process/       -> reporting (log files), shared
reporting/     -> shared, workspace (types only)
workspace/     -> shared
checks/        -> process, shared
runs/          -> checks, reporting, shared, workspace
agents/        -> process, shared, runs (turn types only)
sources/       -> config (the Task schema), runs, shared, workspace
sources/jira/  -> config (the Task schema), sources/contract, shared
cli/           -> agents, checks, config, reporting, runs, shared, sources, workspace
cli.ts         -> cli/
```

The two boundary rules the repository enforces mechanically are the same as before, with
the data module's new path: helper modules may not import the CLI, and
`src/shared/types.ts` may not import `node:*` (see `eslint.config.js` and
`tests/boundaries.test.ts`).

## 4. Important contracts

| Contract | Where it lives | Written down by |
| --- | --- | --- |
| `Task` | `src/shared/types.ts`; validated by `taskSchema` in `src/config/schema.ts` | a task file, or a connector's mapping |
| Harness configuration | `HarnessConfig`, `AgentSelection`, `JiraSourceConfig` in `src/shared/types.ts`; schemas and defaults in `src/config/schema.ts`; reading and path rules in `src/config/load.ts` | the operator's configuration file |
| `TaskSource` | `src/sources/contract.ts` (`listEligible`, `prepare`, `claim`, `complete`) | the coordinator in `src/sources/coordinator.ts` |
| Jira connector | `src/sources/jira/`, built by `createJiraSource` (`connector.ts`) | the Atlassian REST API v3 boundary; tested against a fake HTTP boundary |
| Coding runtime / agent | `AgentTurnRequest`, `AgentTurnResult`, `AgentTurnShutdown`, `RunnerDependencies.runAgentTurn` in `src/runs/contracts.ts`; the only implementation is `src/agents/codex/` | the runner, which never sees a runtime flag or event |
| Run result / report | `RunTaskResult` (`src/runs/contracts.ts`) is what a caller gets; `RunReport`/`CheckRoundResult`/`ChangeSummary` (`src/shared/types.ts`) are what `result.json` holds; `writeRunReport` (`src/reporting/report.ts`) is the only writer | the run's own evidence, plus the change summary from `src/workspace/changes.ts` |

The runner's collaborators are still plain functions (`RunnerDependencies`), so a test
substitutes one function rather than a framework. `cli/dependencies.ts` is the only place
that builds the real set.

## 5. Adding a new task source

A second source beside Jira is a new folder plus a few small, named edits:

1. **Describe it in configuration.** Add a strict object schema for the new `source.type`
   in `src/config/schema.ts`, with the documented defaults, and widen the `source` field of
   `harnessConfigSchema` (today it is the Jira schema alone). Widen `HarnessConfig.source`
   in `src/shared/types.ts` to the union of the source configuration types.
2. **Implement `TaskSource`** in a new `src/sources/<name>/` folder: an ordinary object
   with `listEligible`, `prepare`, `claim`, and `complete`, plus a factory function that
   takes the validated configuration and whatever credential it needs, mirroring
   `createJiraSource`. Keep the transport, the wire parsing, and the mapping inside that
   folder; validate the mapped object with `taskSchema` so a bad item is a per-item
   `SourceError('invalid-task')` rather than a broken run.
3. **Select it in the CLI.** `src/cli/source-command.ts` is the one place that constructs a
   connector and resolves a credential: add the branch on `config.source.type` there (and
   extend the `source` section of `check-config`'s output in `src/cli/check-config.ts` if
   the new fields are worth printing).
4. **Test it offline.** Add tests with a fake transport boundary, the way
   `tests/jira.test.ts` does, plus one `source list` wiring test through `runCli`.

Do not change `Task`, the runner, `sources/contract.ts`, the coordinator, or the receipts:
the coordinator already knows only ordinary source data and functions. Do not add a
registry, a plugin loader, or a `source` array — one configured source per invocation is
the documented contract.

## 6. Adding a new coding runtime

A second runtime beside Codex is an adapter folder and three named edits:

1. **Name it.** Add the runtime to `AgentRuntime` in `src/shared/types.ts`, and widen the
   literal in `agentSchema` (`src/config/schema.ts`) and the "only implemented runtime"
   check in `assertReportable` (`src/reporting/report.ts`).
2. **Write the adapter** under `src/agents/<runtime>/`, mirroring `src/agents/codex/`:
   a runtime/launch module (executable prefix, environment, stop contract), an adapter
   exporting one function with the runner's own shape —
   `(request: AgentTurnRequest) => Promise<AgentTurnResult>` — a prompt module, and a
   parser for that runtime's event stream. Share `src/process/` for launching and stopping;
   do not import another runtime's parser. A wrapper that still speaks the Codex protocol
   is a launch prefix, not a new adapter.
3. **Select it.** `src/cli/dependencies.ts` is the one place where the effective
   `AgentSelection` becomes a function (`runAgentTurn`); branch on `runtime` there.
4. **Test it** with a stand-in executable on the CLI's `PATH`, the way
   `tests/agent.test.ts` tests the Codex adapter, and keep model, provider, and credential
   settings in the runtime's own native configuration.

Do not add provider or model fields to the harness configuration, and do not let the runner
learn about a runtime: the turn's request and result types in `src/runs/contracts.ts` are
the whole boundary.

## 7. Placement rules

- Jira-only code stays under `src/sources/jira/`. Nothing outside that folder spells JQL, ADF,
  a transition, or a Jira URL.
- Process spawning and cancellation stay under `src/process/`. A capability that needs to
  start or stop a process imports it; it does not spawn or kill on its own.
- CLI parsing and presentation stay under `src/cli/`. A command module writes through
  `CliIo` and returns an exit code; nothing under `runs/`, `sources/`, `checks/`, or
  `reporting/` prints.
- Run orchestration stays in `src/runs/`. Workspace preparation stays in `src/workspace/`:
  the runner asks for a working copy, it does not clone one.
- Report serialization (`reporting/report.ts`) stays apart from lifecycle logging
  (`reporting/logs.ts`), and both stay apart from the wording of the timeline
  (`runs/progress.ts`).
- Shared code must actually be shared before it goes into `shared/`: `types.ts` holds the
  cross-cutting data contracts, `errors.ts` holds `messageOf`. A new helper there needs at
  least two real callers, or it belongs to the module that uses it.
- A module has one responsibility. If a file needs two paragraphs to say what it owns, it
  is two modules — that rule is what produced this tree, and it is how the next split
  should be chosen.
