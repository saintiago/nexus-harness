# Module structure

**What this is.** The `src/` tree as it stands after the layout refactor of HARN-1: the folders a
developer sees, what each one owns, and how to add the next task source or coding runtime without
reading a thousand-line file first.

**What this is not.** It defines no behaviour. [spec.md](spec.md) is the behaviour,
[WORKFLOW.md](WORKFLOW.md) the JSON inputs, and [architecture.md](architecture.md) the ownership and
extension rules; where this document and those disagree about behaviour, they win. This document
describes where the code lives, and it is kept current with the tree.

The refactor moved code and split files. It did not change the loop, the CLI, the Jira connector, the
Codex adapter, or a single behaviour, and the whole suite (`npm run validate`) stayed the gate that
decided it.

## 1. Source tree

Line counts are indicative, not a rule: they are here to show where the substance of the harness is.

```text
src/
  cli.ts                          (120)  entry point: dispatch, bootstrap, exit code
  cli/
    context.ts                    (72)   exit codes, CliIo, interrupt signals, CliContext
    help.ts                       (63)   the usage text and the hint that points at it
    options.ts                    (105)   each command's option table and the argument parser
    check-config.ts               (94)   `check-config` and what it prints
    run-command.ts                (194)  `run`: load the inputs, install the stop, print the outcome
    source-command.ts             (339)  `source list|run|watch`, the connector selection, abortable sleep
    dependencies.ts               (132)  the loop's real collaborators and the wrapped set a test gets
    signals.ts                    (28)   host SIGINT/SIGTERM/SIGBREAK handling
  config/
    schema.ts                     (216)  zod schemas and the documented defaults
    load.ts                       (156)  file reading, validation, workDir and agent-executable paths
  shared/
    types.ts                      (585)  the data contracts; data only, no imports, no runtime I/O
    errors.ts                     (10)    `messageOf`: the one message helper
  process/
    launch.ts                     (167)  how one command is started (executable, args, Windows shims)
    command.ts                    (326)  one bounded command invocation, its logs, and its result
    stop.ts                       (90)   stopping a process tree this harness started, and the grace
  checks/
    round.ts                      (295)  one setup/check round; what a command's result means
  reporting/
    errors.ts                     (8)    ReportError
    logs.ts                       (297)  run.log, per-command logs, per-turn agent logs, repair excerpts
    report.ts                     (394)  result.json and source-task.json
    changes.ts                    (80)   the final change summary and its review warnings
  workspace/
    errors.ts                     (8)    WorkspaceError
    git.ts                        (143)  git invocation (never a shell) and small path helpers
    status.ts                     (56)   reading `git status --porcelain -z`
    preflight.ts                  (153)  preflightSource: a usable source checkout, a safe output path
    run-directory.ts              (166)  allocateRunDirectory and the run/workspace paths
    prepare.ts                    (305)  prepareWorkspace: the clone, its branch, the ledger it writes
    state.ts                      (129)  the workspace ledger: what a clone is, every attempt in it
    reopen.ts                     (131)  resolveWorkspace/reopenWorkspace: the pointer, the checkout
    changes.ts                    (288)  inspectWorkspaceChanges: what the copy differs from its base by
  runs/
    contracts.ts                  (312)  run and turn requests/results, RunnerDependencies, the two errors
    runner.ts                     (668)  runTask: the loop (prepare or continue -> baseline -> turns -> checks)
    finalize.ts                   (462)  how a run ends: stop evidence, change summary, report
    stops.ts                      (113)  the stop request one phase works under, and the stop cause
    progress.ts                   (152)  timeline lines, reasons, and the counts they carry
    feedback.ts                   (30)   the failed commands one repair turn is given
  sources/
    contract.ts                   (298)  TaskSource, the ordinary source data and errors, pointer labels
    receipts.ts                   (238)  the intake lock and one receipt per attempted item
    eligibility.ts                (81)   what an item is: a first attempt, a continuation, or a refusal
    guidance.ts                   (60)   what an attempt is told, bounded: the thread and earlier attempts
    coordinator.ts                (775)  runSource and watchSource: discovery, the ladder, publication
    list.ts                       (88)   the read-only `source list` preview
    jira/
      connector.ts                (41)   createJiraSource: the wiring of the functions below
      http.ts                     (230)  the gateway client: auth, timeouts, failure classification
      search.ts                   (109)  the queue JQL and the paged search
      issue.ts                    (131)  issue reads, eligibility, and the source reference
      tasks.ts                    (96)   one issue mapped onto the existing four-field Task
      transitions.ts              (142)  transition discovery, selection by target status, posting
      comments.ts                 (270)  the thread read, the result comment, the refusal comment
      labels.ts                   (32)   the workspace pointer label, added once
      json.ts                     (20)   the narrow readers every Jira answer goes through
      adf.ts                      (243)  the supported ADF description parser
      adf-text.ts                 (296)  rendering that description and extracting the criteria
  agents/
    codex/
      runtime.ts                  (110)  the launch prefix, the environment, the stop contract
      adapter.ts                  (390)  runCodexTurn: one turn, normalized for the runner
      prompt.ts                   (137)  what one turn is told, the bounded guidance included
      events.ts                   (80)   reading the runtime's JSON event stream
```

Every file is a module with one job. Three files stay deliberately large, because splitting them
further would separate one decision from itself: `runs/runner.ts` (the loop), `sources/coordinator.ts`
(the one serial intake sequence: finite batch, escalation ladder, watch loop), and `shared/types.ts`
(every declaration-only data contract in one place, with no imports at all). `runs/finalize.ts` and
`reporting/report.ts` are the next largest, and are single-purpose too.

## 2. Module responsibilities

### `cli.ts` and `cli/`

- **Owns:** the process entry point, command dispatch, exit codes, argument parsing, usage text, and
  everything the user sees: progress echoed from the run timeline, the outcome block, source-list
  output, and error messages. It is also the only place that composes the loop's collaborators
  (`cli/dependencies.ts`), and the only place that constructs a task source.
- **Does not own:** any part of the loop, any command execution, any Git or Jira call. A command
  module resolves its inputs, hands the collaborators to `runTask`/`runSource`/`watchSource`, and
  returns an exit code.
- **Entry points:** `runCli`, `consoleContext` (`cli.ts`); `CliContext`, `CliIo`, `InterruptSignals`,
  `EXIT_OK`, `EXIT_INPUT_ERROR`, `EXIT_USAGE`, `EXIT_CANCELLED` (`cli/context.ts`).

### `config/`

- **Owns:** the two input files. `schema.ts` states what a configuration or task file may contain and
  what an omitted optional field means; `load.ts` reads a file, applies the schema, resolves `workDir`
  and a path-valued agent executable against the configuration file's own directory, and reports every
  problem under the file name.
- **Does not own:** CLI option parsing (`cli/options.ts`), credentials, or any default that is not
  documented in WORKFLOW sections 1 and 5.
- **Entry points:** `loadHarnessConfig`, `loadTask`, `resolveWorkDir`, `resolveAgentSelection`,
  `escalationTiers`, `ConfigError` (`config/load.ts`); `harnessConfigSchema`, `taskSchema`,
  `sourceSchema`, `JIRA_SOURCE_DEFAULTS`, `MIN_POLL_INTERVAL_SECONDS`, `DEFAULT_AGENT_SELECTION`
  (`config/schema.ts`).

### `shared/`

- **Owns:** `types.ts`, the declaration-only data contracts other modules share — `Task`,
  `HarnessConfig`, `CommandResult`, `CheckRoundResult`, `SourceRef`, the report shape,
  `AgentSelection` — and `errors.ts`, the three-line `messageOf` used by every module that reports a
  thrown value.
- **Does not own:** runtime behaviour and I/O. `types.ts` has no imports at all, and an ESLint rule
  (`eslint.config.js`, exercised by `tests/boundaries.test.ts`) refuses a `node:*` import in it.
- **Entry points:** every exported type, plus `messageOf`.

### `process/`

- **Owns:** everything about starting and ending an operating-system process. `launch.ts` decides how
  an executable plus literal arguments is started, including the Windows `.cmd`/`.bat` interpreter
  case and the argument contents it refuses. `command.ts` runs one bounded invocation, records its
  outcome, and writes its two log files. `stop.ts` stops a process tree the harness started and waits
  for it.
- **Does not own:** the meaning of a command's result (`checks/round.ts`), what a round does with it
  (`runs/`), or any vendor's invocation (`agents/codex/`). Nothing here knows about tasks, runs, or
  Jira.
- **Entry points:** `planLaunch` (`process/launch.ts`); `RunCommandRequest`, `runCommand`
  (`process/command.ts`); `requestTreeStop`, `within`, `STOP_GRACE_MS` (`process/stop.ts`).

### `checks/`

- **Owns:** one setup/check round: setup runs first and in order, checks run only when setup
  succeeded, an ordinary nonzero check is a completed red round, and a command that could not be
  executed, was signalled, timed out, or was stopped ends the round as an execution error. It also
  owns `commandSucceeded`, the one reading of a command result.
- **Does not own:** process spawning (delegated to `process/command.ts`), repair policy, deadlines, or
  the report.
- **Entry points:** `CheckRoundRequest`, `commandSucceeded`, `runCheckRound` (`checks/round.ts`).

### `reporting/`

- **Owns:** what a run writes into its own directory. `logs.ts` creates the append-only timeline, one
  output pair per command invocation, one log per coding turn, and reads the bounded excerpt a repair
  turn is given. `report.ts` validates and writes `result.json` and the `source-task.json` snapshot.
  `changes.ts` builds the final change summary and its warnings. `errors.ts` is the single
  `ReportError`.
- **Does not own:** the run's decisions; it writes what it is handed, and a file that already exists is
  refused rather than overwritten.
- **Entry points:** `runLogPath`, `appendRunLog`, `openCommandLog`, `readCommandOutput`,
  `agentLogPath`, `openAgentLog` (`reporting/logs.ts`); `RunReportRequest`, `runReportPath`,
  `sourceTaskPath`, `writeSourceTaskSnapshot`, `writeRunReport` (`reporting/report.ts`);
  `ChangeSummaryRequest`, `summarizeChanges` (`reporting/changes.ts`); `ReportError`
  (`reporting/errors.ts`).

### `workspace/`

- **Owns:** the source checkout and the working copies, and Git is invoked nowhere else. `preflight.ts`
  records the committed base and refuses a dirty checkout or an output path that overlaps the source;
  `run-directory.ts` allocates `<workDir>/runs/<runId>` and names
  `<workDir>/workspaces/<workspaceId>` for one attempt's evidence and clone; `prepare.ts` fills an
  allocated directory with a clone of the recorded base and writes the ledger `state.ts` owns;
  `reopen.ts` resolves a pointer to a workspace, reads the checkout, and refuses one that is not on
  the branch its ledger records; `changes.ts` reads what the copy differs from its base by; `git.ts`
  and `status.ts` are the plumbing they share, including the repository-local commit identity
  (`configureWorkspaceIdentity`) a run writes into a working copy before any check or coding turn.
- **Does not own:** the coding turns, the checks, the report, or the policy that decides whether an
  item continues a workspace (that is `sources/eligibility.ts`). The ledger is derived state: a run's
  own report stays the authority on what the run did.
- **Entry points:** `preflightSource`, `PreflightRequest`, `SourcePreflight`
  (`workspace/preflight.ts`); `RunDirectory`, `runDirPathFor`, `workspacePathFor`,
  `allocateRunDirectory` (`workspace/run-directory.ts`); `PreparedWorkspace`,
  `PrepareWorkspaceBounds`, `prepareWorkspace` (`workspace/prepare.ts`); `WorkspaceAttempt`,
  `WorkspaceState`, `workspaceStatePath`, `readWorkspaceState`, `recordWorkspaceAttempt`
  (`workspace/state.ts`); `ContinuedWorkspace`, `WorkspaceResolution`, `resolveWorkspace`,
  `reopenWorkspace` (`workspace/reopen.ts`); `WORKSPACE_IDENTITY`, `configureWorkspaceIdentity`
  (`workspace/git.ts`); `inspectWorkspaceChanges` (`workspace/changes.ts`); `WorkspaceError`
  (`workspace/errors.ts`).

### `runs/`

- **Owns:** one run's order of work. `contracts.ts` states what a run is asked to do, including a
  workspace to continue instead of one to create, the tier name it records, and the guidance every
  turn is given; `runner.ts` runs the loop, gives the working copy its repository-local commit
  identity before any check or turn runs in it, allows a red baseline only for a continuation, and
  starts nothing after the first stop it observes; `finalize.ts` turns an ending into evidence, a
  change summary, and the report, from the source base the runner recorded for that run; `stops.ts`
  is the one stop request a phase honours, and the reason a stop carries; `progress.ts` is the
  wording the timeline and the reasons use; `feedback.ts` collects the failed commands a repair turn
  is given.
- **Does not own:** the working copy, the checks, the runtime, the report files, or any connector. It
  never imports `sources/` or `agents/`: the CLI hands it ordinary functions.
- **Entry points:** `runTask` (`runs/runner.ts`); `RunTaskRequest`, `RunTaskResult`,
  `RunnerDependencies`, `AgentTurnRequest`, `AgentTurnResult`, `AgentTurnShutdown`,
  `RunCancelledError`, `RunTimeoutError` (`runs/contracts.ts`); `RunFinalizerContext`,
  `createRunFinalizer` (`runs/finalize.ts`).

### `sources/`

- **Owns:** the task-input boundary and the one serial coordinator. `contract.ts` is the `TaskSource`
  contract and the ordinary source data (`SourceRef`, `SourceCandidate`, `SourceTask`,
  `SourceComment`, `SourceRunOutcome`, `SourceSummary`, `SourceError`, `SourceFeedbackError`), plus
  the pointer label helpers (`WORKSPACE_POINTER_PREFIX`, `workspacePointerLabel`,
  `parseWorkspacePointers`). `receipts.ts` is the only retained intake state: one exclusive lock and
  one receipt per attempted item, keyed by the item's immutable identity. `eligibility.ts` decides
  what an item is — a first attempt, a continuation of the workspace its pointer names, or a refusal —
  and `guidance.ts` renders what an attempt is told from the item's own thread and its earlier
  attempts, bounded. `coordinator.ts` discovers a finite batch, reserves, claims, climbs the configured
  escalation ladder one rung per attempt inside that claim, and publishes each attempt's result;
  `list.ts` is the read-only preview.
- **Does not own:** Jira. The coordinator imports no connector, no JQL, and no credential. It also
  does not implement the run: it calls the runner it was handed.
- **Entry points:** `TaskSource`, `SourceComment`, `SourceContext`, `SourceIo`, `SourceRunOutcome`,
  `SourceSummary`, `SourceError`, `SourceFeedbackError`, `workspacePointerLabel`,
  `parseWorkspacePointers` (`sources/contract.ts`); `runSource`, `watchSource`, `SourceWatchOptions`
  (`sources/coordinator.ts`); `listSource`, `SourceListEntry` (`sources/list.ts`);
  `acquireIntakeLock`, `readReceipt`, `reserveReceipt`, `updateReceipt`, `receiptFilePath`,
  `receiptIdentity` (`sources/receipts.ts`).

### `sources/jira/`

- **Owns:** the only implemented task source. `connector.ts` builds it; `http.ts` is the client: the
  Atlassian gateway route, Bearer authentication, the request timeout plus the caller's signal,
  refused redirects, and the classification of a failed answer. `search.ts` builds the queue JQL and
  consumes every page; `issue.ts` reads one issue and decides whether it is still eligible; `tasks.ts`
  maps it onto the existing four-field `Task`; `transitions.ts` finds and posts a transition chosen by
  target status, which is also how a claim is made; `comments.ts` reads the issue's thread and posts
  the result and refusal comments; `labels.ts` adds the workspace pointer label once; `adf.ts` and
  `adf-text.ts` are the small explicit description convention; `json.ts` holds the narrow wire
  readers they share.
- **Does not own:** the loop, the receipt/lock state, or the decision to run anything. A Jira failure
  is classified for the coordinator (`SourceError`), never repaired.
- **Entry points:** `createJiraSource` (`sources/jira/connector.ts`); `resolveJiraToken`,
  `jiraApiBaseUrl`, `JIRA_REQUEST_TIMEOUT_MS`, `JiraSourceParts` (`sources/jira/http.ts`);
  `queueJql` (`sources/jira/search.ts`).

### `agents/codex/`

- **Owns:** the only implemented coding runtime. `runtime.ts` is the launch prefix and the host
  contract (environment, process-tree stop, grace); `adapter.ts` is one top-level turn through the
  host's `codex exec`, normalized to the runner's `AgentTurnResult`; `prompt.ts` is what a turn is
  told, the bounded guidance included; `events.ts` reads the runtime's JSON event stream. No Codex
  flag, event, or type leaves these files.
- **Does not own:** the run, the checks, the working copy, or model/provider selection. The launch
  prefix comes from configuration, and credentials stay in the runtime's own environment or native
  configuration.
- **Entry points:** `runCodexTurn`, `AgentError` (`agents/codex/adapter.ts`); `codexRuntime`,
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
  |
  +--> agents/codex/  -------> process/ (launch and stop)
  |
  +--> config/  and  shared/  (low level: schemas, data contracts, messageOf)
```

The rules that keep it acyclic:

- `shared/` imports nothing. `config/` imports only `shared/`.
- `process/`, `reporting/`, `workspace/`, and `checks/` never import `runs/`, `sources/`, `agents/`,
  or `cli/`.
- `runs/` never imports `sources/` or `agents/`: a run is handed the coding turn and the checks as
  functions (`RunnerDependencies`), and the CLI is what wires the adapter in.
- `agents/codex/` depends on `runs/contracts.ts` for the turn's own types only; no module under
  `runs/` imports an adapter.
- `sources/jira/` depends on `sources/contract.ts`, `sources/jira/json.ts`, and `config/schema.ts`;
  nothing above `sources/` imports a connector except the one command that builds it
  (`cli/source-command.ts`).
- Nothing imports `cli.ts`, and nothing outside `cli/` writes to the terminal.

The two boundary rules the repository enforces mechanically are checked with ESLint and the boundary
fixtures: helper modules may not import the CLI, and `src/shared/types.ts` may not import `node:*`.

## 4. Important contracts

| Contract | Where it lives | Written down by |
| --- | --- | --- |
| `Task` | `src/shared/types.ts`; validated by `taskSchema` in `src/config/schema.ts` | a task file, or a connector's mapping |
| Harness configuration | `HarnessConfig`, `AgentSelection`, `JiraSourceConfig` in `src/shared/types.ts`; schemas and defaults in `src/config/schema.ts`; reading and path rules in `src/config/load.ts` | the operator's configuration file |
| `TaskSource` | `src/sources/contract.ts` (`listEligible`, `prepare`, `claim`, `complete`, `recordWorkspace`, `refuse`, `commentsSince`) | the coordinator in `src/sources/coordinator.ts` |
| Jira connector | `src/sources/jira/`, built by `createJiraSource` (`connector.ts`) | the Atlassian REST API v3 boundary; tested against a fake HTTP boundary |
| Coding runtime / agent | `AgentTurnRequest`, `AgentTurnResult`, `AgentTurnShutdown`, `RunnerDependencies.runAgentTurn` in `src/runs/contracts.ts`; the only implementation is `src/agents/codex/` | the runner, which never sees a runtime flag or event |
| Run result / report | `RunTaskResult` (`src/runs/contracts.ts`) is what a caller gets; `RunReport`/`CheckRoundResult`/`ChangeSummary` (`src/shared/types.ts`) are what `result.json` holds; `writeRunReport` (`src/reporting/report.ts`) is the only writer | the run's own evidence, plus the change summary from `src/workspace/changes.ts` |
| Workspace layout and ledger | `WorkspaceState`/`WorkspaceAttempt` (`src/workspace/state.ts`), `ContinuedWorkspace` (`src/workspace/reopen.ts`); the paths in `src/workspace/run-directory.ts` | the runner, as each attempt finishes; the coordinator resolves it, and refuses rather than guesses |
| Pointer label | `workspacePointerLabel`/`parseWorkspacePointers` (`src/sources/contract.ts`), written through `src/sources/jira/labels.ts` | the run that creates a workspace, once, before any coding turn |
| Escalation ladder | `EscalationTier` (`src/shared/types.ts`), the `escalation` schema in `src/config/schema.ts`, the climb in `src/sources/coordinator.ts` | the operator's configuration |
| Attempt guidance | `SourceComment` (`src/sources/contract.ts`), rendering and bounds in `src/sources/guidance.ts`, the prompt section in `src/agents/codex/prompt.ts` | the item's own thread and the workspace ledger, bounded, context only |

The runner's collaborators are still plain functions (`RunnerDependencies`), so a test substitutes
one function rather than a framework. `cli/dependencies.ts` is the only place that builds the real
set.

## 5. Adding a new task source

A second source beside Jira is a new folder plus a few small, named edits:

1. **Describe it in configuration.** Add a strict object schema for the new `source.type` in
   `src/config/schema.ts`, with the documented defaults, and widen the `source` field of
   `harnessConfigSchema` (today it is the Jira schema alone). Widen `HarnessConfig.source` in
   `src/shared/types.ts` to the union of the source configuration types.
2. **Implement `TaskSource`** in a new `src/sources/<name>/` folder: an ordinary object with
   `listEligible`, `prepare`, `claim`, `complete`, `recordWorkspace`, `refuse`, and `commentsSince`,
   plus one factory that takes the validated configuration and whatever credential it needs, the way
   `createJiraSource` does. Keep the transport, the wire parsing, and the mapping inside that folder;
   validate the mapped object with `taskSchema` so a bad item is a per-item
   `SourceError('invalid-task')` rather than a broken run.
3. **Select it in the CLI.** `src/cli/source-command.ts` is the one place that constructs a connector
   and resolves a credential: add the branch on `config.source.type` there (and extend the `source`
   section of `check-config`'s output in `src/cli/check-config.ts` if the new fields are worth
   printing).
4. **Test it offline.** Add tests with a fake transport boundary, the way `tests/jira.test.ts` does,
   plus one `source list` wiring test through `runCli`.

Do not change `Task`, the runner, `sources/contract.ts`, `sources/coordinator.ts`, or
`sources/receipts.ts`: the coordinator already knows only ordinary source data and functions. Do not
add a registry, a plugin loader, or a `source` array — one configured source per invocation is the
documented contract.

## 6. Adding a new coding runtime

A second runtime beside Codex is an adapter folder and three named edits:

1. **Name it.** Add the runtime to `AgentRuntime` in `src/shared/types.ts`, widen the literal in
   `agentSchema` (`src/config/schema.ts`), and widen the "only implemented runtime" check in
   `assertReportable` (`src/reporting/report.ts`).
2. **Write the adapter** under `src/agents/<runtime>/`, mirroring `src/agents/codex/`: a
   runtime/launch module (executable prefix, environment, stop contract), an adapter exporting one
   function with the runner's own shape — `(request: AgentTurnRequest) => Promise<AgentTurnResult>` —
   a prompt module, and a parser for that runtime's event stream. Share `src/process/` for launching
   and stopping; do not import another runtime's parser. A wrapper that still speaks the Codex
   protocol is a launch prefix, not a new adapter.
3. **Select it.** `src/cli/dependencies.ts` is the one place where the effective `AgentSelection`
   becomes a function (`runAgentTurn`); branch on `runtime` there.
4. **Test it** with a stand-in executable on the CLI's `PATH`, the way `tests/agent.test.ts` tests the
   Codex adapter, and keep model, provider, and credential settings in the runtime's own native
   configuration.

Do not add provider or model fields to the harness configuration, and do not let the runner learn
about a runtime: the turn's request and result types in `src/runs/contracts.ts` are the whole
boundary.

## 7. Placement rules

- Jira-only code stays under `src/sources/jira/`. Nothing outside that folder spells JQL, ADF, a
  transition, or a Jira URL.
- Process spawning and cancellation stay under `src/process/`. A capability that needs to start or
  stop a process imports it; it does not spawn or kill on its own. The Codex adapter starts the
  runtime through the same launcher and stops it through the same tree stop.
- CLI parsing and presentation stay under `src/cli/`. A command module writes through `CliIo` and
  returns an exit code; nothing under `runs/`, `sources/`, `checks/`, or `reporting/` prints.
- Run orchestration stays in `src/runs/`. Workspace preparation stays in `src/workspace/`: the runner
  asks for a working copy, it does not clone one.
- Report serialization (`reporting/report.ts`) stays apart from lifecycle logging
  (`reporting/logs.ts`), and both stay apart from the wording of the timeline (`runs/progress.ts`).
- Shared code must actually be shared before it goes into `shared/`: `types.ts` holds the
  cross-cutting data contracts, `errors.ts` holds `messageOf`. A new helper there needs at least two
  real callers, or it belongs to the module that uses it.
- A workspace is looked for at `<workDir>/workspaces/<workspaceId>` and nowhere else. A clone
  somewhere else is refused, not adopted, and a `workDir` written before this layout was upgraded by
  hand once (`docs/implement-workspace-continuation.md`).
- The ledger is derived state. A run's report is the authority on what that run did, the ledger is
  only what the next attempt reads, and nothing rewrites a report.
- Text from an item - its description, its comments, another agent's note - is context for a turn and
  never configuration: it cannot become a command, a path, a repository, or a limit.
- A module has one responsibility. If a file needs two paragraphs to say what it owns, it is two
  modules - that rule is what produced this tree, and it is how the next split should be chosen.
