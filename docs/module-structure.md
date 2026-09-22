# Module structure

This reference describes source ownership. The [spec](spec.md) defines behavior and the
[architecture](architecture.md) defines design principles. File size is not a design rule.

## 1. Source tree

Line counts are indicative, not a rule: they are here to show where the substance of the harness is.

```text
src/
  cli.ts  entry point: dispatch, bootstrap, exit code
  cli/
    context.ts  exit codes, CliIo, the terminal, interrupt signals, CliContext
    help.ts   the usage text and the hint that points at it
    options.ts   each command's option table and the argument parser
    check-config.ts   `check-config` and what it prints
    run-command.ts  `run`: load the inputs, install the stop, print the outcome
    source-command.ts  `source list|run|watch`, the connector selection, abortable sleep
    review-command.ts  `review scan|watch`: the App client, the reviewer, the scan
    queue-command.ts  `queue run|watch`: the three credentials, the lock, the four phases
    activity.ts  the activity timeline: one bounded, timestamped pane per invocation
    progress.ts  what a run's own progress line reads as on an interactive terminal
    dependencies.ts  the loop's real collaborators and the wrapped set a test gets
    signals.ts   host SIGINT/SIGTERM/SIGBREAK handling
  config/
    schema.ts  zod schemas and the documented defaults
    load.ts  file reading, validation, workDir and agent-executable paths
  shared/
    types.ts  the data contracts; data only, no imports, no runtime I/O
    errors.ts    `messageOf`: the one message helper
  process/
    launch.ts  how one command is started (executable, args, Windows shims)
    invocation.ts  one bounded process invocation, its output, and its stop
    command.ts  one configured command: its two log files and its result
    stop.ts   stopping a process tree this harness started, and the grace
  checks/
    round.ts  one setup/check round; what a command's result means
  reporting/
    errors.ts    ReportError
    logs.ts  run.log, per-command logs, per-turn agent logs, bounded readings
    report.ts  result.json and source-task.json
    changes.ts   the final change summary and its review warnings
  workspace/
    errors.ts    WorkspaceError
    git.ts  git invocation (never a shell), its bounds, path helpers
    status.ts   reading `git status --porcelain -z`
    preflight.ts  preflightSource: a usable source checkout, a safe output path
    run-directory.ts  allocateRunDirectory and the run/workspace paths
    prepare.ts  prepareWorkspace: the clone, its branch, the ledger it writes
    state.ts  the workspace ledger: what a clone is, every attempt in it
    reopen.ts  resolveWorkspace/reopenWorkspace: the pointer, the checkout
    branch.ts  the checkout against its recorded branch: read, return, refuse
    refresh.ts  source readiness between tickets: fetch, verify, fast-forward only
    changes.ts  inspectWorkspaceChanges: what the copy differs from its base by
  runs/
    contracts.ts  run and turn requests/results, the guidance prefix, the feedback deadline, the two errors
    runner.ts  runTask: the loop (prepare or continue -> baseline -> turns -> checks)
    finalize.ts  how a run ends: stop evidence, change summary, report
    stops.ts  the stop request one phase works under, and the stop cause
    progress.ts  timeline lines, reasons, and the counts they carry
    feedback.ts   the failed commands one repair turn is given
  sources/
    contract.ts  TaskSource, the ordinary source data and errors, pointer labels
    receipts.ts  the per-project intake lock and one receipt per attempted item
    eligibility.ts   what an item is: a first attempt, a continuation, or a refusal
    guidance.ts  what an attempt is told, each bounded: the finding, the thread, attempts
    baseline.ts the pre-delivery diagnosis: its evidence, one comment, one move
    coordinator.ts runSource and watchSource: discovery, the ladder, publication
    list.ts   the read-only `source list` preview
    jira/
      connector.ts   createJiraSource: the wiring of the functions below
      http.ts  the gateway client: auth, timeouts, failure classification
      search.ts  the queue JQL and the paged search
      issue.ts  issue reads, eligibility, and the source reference
      tasks.ts   one issue mapped onto the existing four-field Task
      transitions.ts  transition discovery, selection by target status, posting
      comments.ts  the thread read, the result, refusal and attention comments
      baseline.ts   the thread, one comment, one move, and whether it is still running
      labels.ts   the workspace pointer label, added once
      json.ts   the narrow readers every Jira answer goes through
      adf.ts  the supported ADF description parser
      adf-text.ts  rendering that description and extracting the criteria
  delivery/
    github.ts  the optional GitHub step: push, find, create or update a PR
  reviews/
    contract.ts  the review data, failures, and the repository/queue boundary
    github.ts  the App JWT, the installation token, and the repository calls
    diff.ts  the pull request's diff, and where a finding is positioned
    reviewer.ts  the reviewer prompt, the one bounded turn, and the verdict file
    baseline.ts the pre-delivery reviewer turn, its prompt, and its outcome record
    scan.ts  one scan or watch: eligibility, dedup, publishing, evidence
  history/
    contract.ts  the entries, the brief, the snapshot, and the readers boundary
    paths.ts   where one ticket's history and its reports live
    marker.ts   the `nexus-history:` marker both renderings carry
    store.ts  the immutable snapshot store: content hash, files, current.json
    reports.ts complete developer/reviewer report retention and local reads
    sync.ts  read, deduplicate, authenticate mirrors, brief, write one snapshot
    prompt.ts  the one history section both role prompts carry
  queue/
    loop.ts  the serial control loop: one current ticket, one phase at a time
  agents/
    codex/
      runtime.ts  the launch prefix, the two sandbox policies and their narrowing, the environment, the stop contract
      adapter.ts  runCodexTurn/runCodexPrompt: one turn, normalized for the runner
      prompt.ts  what one turn is told, the bounded guidance and the reviewed baseline finding included
      events.ts  the JSON event stream, and the activity lines read from it
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
  output, and error messages. `cli/activity.ts` is the one place that draws on the terminal beyond
  ordinary lines: it gives every agent invocation a fresh bounded pane under the progress —
  grouped by the agent's messages, with the oldest work lines dropped first, each entry stamped
  with the local time the viewer received it, and an agent message highlighted in yellow and reset
  — opens each pane with a boundary row naming the role the phase launched (`developer` or
  `reviewer`) and the ticket, and finalizes a pane in place into the timeline when its invocation
  ends: the rows it holds stay exactly where they were drawn, so one chronological, timestamped
  stream holds the bounded panes and the ordinary lifecycle lines in the order they were produced.
  It falls back to stamped ordinary lines when the output is
  redirected or the terminal cannot hold a pane.
  `cli/progress.ts` holds what those progress lines read as there, and only there: a line it does
  not recognize is written as the run wrote it. The directory is also the only place that composes
  the loop's collaborators (`cli/dependencies.ts`), and the only place that constructs a task
  source or the review path.
- **Does not own:** any part of the loop, any command execution, any Git or Jira call. A command
  module resolves its inputs, hands the collaborators to `runTask`/`runSource`/`watchSource` (or
  `scanReviews`/`watchReviews`), and returns an exit code.
- **Entry points:** `runCli`, `consoleContext`, `colorAllowed` (`cli.ts`); `CliContext`, `CliIo`,
  `InterruptSignals`, `CliTerminal`, `EXIT_OK`, `EXIT_INPUT_ERROR`, `EXIT_USAGE`, `EXIT_CANCELLED`
  (`cli/context.ts`); `createActivityDisplay`, `ActivityDisplay`, `ACTIVITY_PANE_LINES`
  (`cli/activity.ts`); `interactiveProgress` (`cli/progress.ts`).

### `config/`

- **Owns:** the two input files. `schema.ts` states what a configuration or task file may contain and
  what an omitted optional field means; `load.ts` reads a file, applies the schema, resolves `workDir`
  and a path-valued agent executable against the configuration file's own directory, and reports every
  problem under the file name.
- **Does not own:** CLI option parsing (`cli/options.ts`), credentials, or any default that is not
  documented in WORKFLOW sections 1 and 5.
- **Entry points:** `loadHarnessConfig`, `loadTask`, `resolveWorkDir`, `resolveAgentSelection`,
  `escalationTiers`, `projectLockNamespace`, `ConfigError` (`config/load.ts`); `harnessConfigSchema`, `taskSchema`,
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
  case and the argument contents it refuses. `invocation.ts` runs one bounded invocation: it starts
  the executable, stops it and everything it started when its limit expires or the caller's stop
  arrives, and says how it ended and whether that stop was confirmed. `command.ts` runs one
  configured command through it and writes the two log files its output goes to. `stop.ts` stops a
  process tree the harness started and waits for it.
- **Does not own:** the meaning of a command's result (`checks/round.ts`), what a round does with it
  (`runs/`), or any vendor's invocation (`agents/codex/`). Nothing here knows about tasks, runs, or
  Jira.
- **Entry points:** `planLaunch` (`process/launch.ts`); `InvocationRequest`, `InvocationResult`,
  `runInvocation` (`process/invocation.ts`); `RunCommandRequest`, `runCommand`
  (`process/command.ts`); `requestTreeStop`, `collectHostUtilityWords`, `HostUtilityWords`, `within`,
  `STOP_GRACE_MS` (`process/stop.ts`).

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
  turn is given — or, for the pre-delivery baseline diagnosis, the same reading with a log file it
  could not read named instead of rendered as output nothing wrote. `report.ts` validates and writes
  `result.json` and the `source-task.json` snapshot.
  `changes.ts` builds the final change summary and its warnings. `errors.ts` is the single
  `ReportError`.
- **Does not own:** the run's decisions; it writes what it is handed, and a file that already exists is
  refused rather than overwritten.
- **Entry points:** `runLogPath`, `appendRunLog`, `openCommandLog`, `readCommandOutput`,
  `readCommandOutputEvidence`, `CommandOutputEvidence`,
  `agentLogPath`, `openAgentLog`, `openEvidenceLog` (`reporting/logs.ts`); `RunReportRequest`,
  `runReportPath`,
  `sourceTaskPath`, `writeSourceTaskSnapshot`, `writeRunReport` (`reporting/report.ts`);
  `ChangeSummaryRequest`, `summarizeChanges` (`reporting/changes.ts`); `ReportError`
  (`reporting/errors.ts`).

### `workspace/`

- **Owns:** the source checkout and the working copies, and the Git plumbing every module shares
  (the review path's own view in `reviews/view.ts` is its only other caller). `preflight.ts`
  records the committed base and refuses a dirty checkout or an output path that overlaps the source;
  `run-directory.ts` allocates `<workDir>/runs/<runId>` for one attempt's evidence and names
  `<workDir>/workspaces/<workspaceId>` for the retained clone — the name its caller preferred (a
  Jira ticket key), or the run's own generated id, validated like a pointer label — while a run
  that continues one creates no directory beside it; `prepare.ts` fills an allocated directory with
  a clone of the recorded base and writes the ledger `state.ts` owns;
  `reopen.ts` resolves a pointer to a workspace, reads the checkout against the branch its ledger
  records — accepting a clean branch of a turn's own that the runner can return, and refusing one
  that cannot be returned or that still holds uncommitted work, because no coding turn is started
  from a working copy like that — and `branch.ts` reads that standing and returns the checkout to
  the recorded branch with a fast-forward and a checkout, never a reset, a force update, or an
  adopted branch — refusing a return that would write over a local file the checkout ignores, and
  reading back what the checkout and the fast-forward did before reporting it; `changes.ts` reads
  what the copy differs from its base by; `git.ts`
  and `status.ts` are the plumbing they share, including the repository-local commit identity
  (`configureWorkspaceIdentity`) a run writes into a working copy before any check or coding turn.
  Every Git invocation is bounded and stopped through `process/`: a run's phases give it what is
  the run's deadline and clock — each reading runs under what is left of the task time when it
  starts — and the run's stop request, and a reading without a run deadline runs under a finite
  default bound (`git.ts`), so a stalled Git cannot hold the harness past either.
  `refresh.ts` is the one write to the operator's own checkout, and it is a fast-forward only: the
  serial queue's source readiness, between two tickets, fetches the configured base branch and
  moves the checkout to the verified merge commit, or refuses with what to fix.
- **Does not own:** the coding turns, the checks, the report, or the policy that decides whether an
  item continues a workspace (that is `sources/eligibility.ts`). The ledger is derived state: a run's
  own report stays the authority on what the run did.
- **Entry points:** `preflightSource`, `PreflightRequest`, `SourcePreflight`
  (`workspace/preflight.ts`); `RunDirectory`, `runDirPathFor`, `workspacePathFor`,
  `allocateRunDirectory` (`workspace/run-directory.ts`); `PreparedWorkspace`,
  `PrepareWorkspaceBounds`, `prepareWorkspace` (`workspace/prepare.ts`); `WorkspaceAttempt`,
  `WorkspaceState`, `workspaceStatePath`, `readWorkspaceState`, `recordWorkspaceAttempt`
  (`workspace/state.ts`); `refreshSource`, `SourceRefreshRequest`, `SourceRefreshParts`,
  `SourceRefreshResult`, `githubRepositoryOf` (`workspace/refresh.ts`); `ContinuedWorkspace`,
  `WorkspaceResolution`, `resolveWorkspace`,
  `reopenWorkspace` (`workspace/reopen.ts`); `BranchStanding`, `BranchReturn`, `BranchRead`,
  `inspectBranchStanding`, `returnToRecordedBranch` (`workspace/branch.ts`); `WORKSPACE_IDENTITY`, `configureWorkspaceIdentity`,
  `runGit`, `GitRunBounds`, `GitResult`, `GIT_COMMAND_TIMEOUT_MS` (`workspace/git.ts`);
  `inspectWorkspaceChanges` (`workspace/changes.ts`); `WorkspaceError`, `WorkspaceStepStop`,
  `workspaceStopOf` (`workspace/errors.ts`).

### `runs/`

- **Owns:** one run's order of work. `contracts.ts` states what a run is asked to do, including a
  workspace to continue instead of one to create, the tier name it records, and the guidance every
  turn is given; `runner.ts` runs the loop, gives the working copy its repository-local commit
  identity before any check or turn runs in it, returns the checkout to the branch its workspace
  records before every coding turn and before the round that judges it (or ends the run when it
  cannot be returned), allows a red baseline only for a continuation, and starts nothing after the
  first stop it observes; `finalize.ts` turns an ending into evidence, a
  change summary, and the report, from the source base the runner recorded for that run; `stops.ts`
  is the one stop request a phase honours, and the reason a stop carries; `progress.ts` is the
  wording the timeline and the reasons use; `feedback.ts` collects the failed commands a repair turn
  is given.
- **Does not own:** the working copy, the checks, the runtime, the report files, or any connector. It
  never imports `sources/` or `agents/`: the CLI hands it ordinary functions.
- **Entry points:** `runTask` (`runs/runner.ts`); `RunTaskRequest`, `RunTaskResult`,
  `RunnerDependencies`, `AgentTurnRequest`, `AgentTurnResult`, `AgentTurnShutdown`,
  `RunCancelledError`, `RunTimeoutError` (`runs/contracts.ts`); `RunFinalizerContext`,
  `createRunFinalizer` (`runs/finalize.ts`); `BASELINE_GUIDANCE_PREFIX` (`runs/contracts.ts`).

### `sources/`

- **Owns:** the task-input boundary and the one serial coordinator. `contract.ts` is the `TaskSource`
  contract and the ordinary source data (`SourceRef`, `SourceCandidate`, `SourceTask`,
  `SourceComment`, `SourceRunOutcome`, `SourceSummary`, `SourceError`, `SourceFeedbackError`), plus
  the pointer label helpers (`WORKSPACE_POINTER_PREFIX`, `workspacePointerLabel`,
  `parseWorkspacePointers`). `receipts.ts` is the only retained intake state: one exclusive lock per
  connected project — named by the namespace `config/load.ts` derives from the composed identity —
  and one receipt per attempted item, keyed by the item's immutable identity. `eligibility.ts` decides
  what an item is — a first attempt, a continuation of the workspace its pointer names, or a refusal —
  and `guidance.ts` renders what an attempt is told from the item's own thread and its earlier
  attempts, each with its own bounds: a reviewed baseline finding is carried field by field, ahead of
  the rest, and never dropped for later chatter — and the context beside it is never dropped for the
  finding's width, because the finding's own bound is not charged against it — but only one the
  coordinator established, from the whole finding
  comment that names the evidence the retained record closed as a repair and repeats every field of
  the finding that record holds or, when the thread cannot supply it, from that record through
  `baseline.ts`; a comment is never promoted to that requirement merely because it carries a
  marker, and an edited field is ordinary context. `coordinator.ts` discovers a finite batch, reserves, claims, climbs the
  configured escalation ladder one rung per attempt inside that claim — publishing each attempt's
  own comment while the item stays in the running status, and the final result and review move when
  the climb ends — refuses to start a baseline continuation whose required finding cannot be read
  back, telling the claimed ticket why on its own thread and taking it out of the running status
  with its workspace pointer preserved, under the same bounded best-effort deadline an interrupted
  run's result gets — and `list.ts` is the read-only preview. `baseline.ts` is the pre-delivery
  diagnosis of one completed red baseline: the evidence identity, the marker a restart reads, the
  evidence record it writes before its reviewer turn under the connected project's own namespace —
  so one `workDir` never mixes two projects' evidence — one comment, the one status move the finding
  asks for — the intake lock kept when the reviewer runtime's own stop could not be confirmed — the
  interruption a caller's own stop caused published under its own bounded best-effort deadline
  rather than the aborted signal, so the ticket it claimed is never stranded in the running status —
  the stop read back from that recorded outcome when a resume finds the comment already on the thread,
  so a deduplicated finding never releases a lock its own record says to keep — the
  `resume` step that finishes what an invocation left pending before anything is discovered or
  claimed, which reconciles a record this harness left unfinished after its own status move with the
  finding the item's own thread carries — settled only as the outcome record really says, so a
  rejected turn's finding file closes nothing as a repair — and the read-back of a finding a
  continuation is required
  to be told, which is that same recorded outcome rather than the turn's own file — with the
  identity it was published for, and with the whole-comment check that decides
  whether a comment of the thread is that same finding, field for field, rather than an edited
  comment that kept the marker, and with the one rendering that becomes guidance — each field whole,
  at the width the reviewer's finding was validated at rather than the bounded width one comment
  line has, whichever of the two routes supplied it — through the reviewer and record functions it
  is handed — and `resumeStop`, the one
  reading of what a resume outcome means for its caller's intake: a stop, and whether everything the
  diagnosis started was confirmed stopped.
- **Does not own:** Jira. The coordinator imports no connector, no JQL, and no credential. It also
  does not implement the run: it calls the runner it was handed.
- **Entry points:** `TaskSource`, `SourceComment`, `SourceContext`, `SourceIo`, `SourceRunOutcome`,
  `SourceSummary`, `SourceTake`, `QueueTicket`, `SourceError`, `SourceFeedbackError`, `workspacePointerLabel`,
  `parseWorkspacePointers` (`sources/contract.ts`); `runSource`, `watchSource`, `SourceWatchOptions`
  (`sources/coordinator.ts`); `takeOneItem`, `SourceTakeRequest` (`sources/coordinator.ts`);
  `createBaselineDiagnosis`, `baselineEvidenceId`, `baselineCommentFinding`,
  `baselineThreadFinding`, `baselineFindingGuidanceLines`, `BaselineDiagnosisParts`,
  `BASELINE_EVIDENCE_FILE`,
  `BASELINE_MARKER_PREFIX`, `resumeStop` (`sources/baseline.ts`); `guidanceFrom` (`sources/guidance.ts`);
  `listSource`, `SourceListEntry` (`sources/list.ts`);
  `acquireIntakeLock`, `readReceipt`, `reserveReceipt`, `updateReceipt`, `receiptFilePath`,
  `receiptIdentity` (`sources/receipts.ts`).

### `sources/jira/`

- **Owns:** the only implemented task source. `connector.ts` builds it; `http.ts` is the client: the
  Atlassian gateway route, Bearer authentication, the request timeout plus the caller's signal,
  refused redirects, and the classification of a failed answer. `search.ts` builds the queue JQL and
  consumes every page; `issue.ts` reads one issue and decides whether it is still eligible; `tasks.ts`
  maps it onto the existing four-field `Task`; `transitions.ts` finds and posts a transition chosen by
  target status, which is also how a claim is made; `comments.ts` reads the issue's thread and posts
  the result, refusal, and attention comments — the last one tells a claimed issue why no developer
  was started and takes it out of the running status; `labels.ts` adds the workspace pointer label once; `adf.ts` and
  `adf-text.ts` are the small explicit description convention; `json.ts` holds the narrow wire
  readers they share. `baseline.ts` is the thin record one pre-delivery diagnosis writes through:
  the issue's thread, one comment, one move out of the running status, and whether the item is still
  in it, over `completion.ts`'s comment reader and its general status move and `issue.ts`'s issue
  read.
- **Does not own:** the loop, the receipt/lock state, or the decision to run anything. A Jira failure
  is classified for the coordinator (`SourceError`), never repaired.
- **Entry points:** `createJiraSource` (`sources/jira/connector.ts`); `resolveJiraToken`,
  `jiraApiBaseUrl`, `JIRA_REQUEST_TIMEOUT_MS`, `JiraSourceParts` (`sources/jira/http.ts`);
  `queueJql` (`sources/jira/search.ts`); `createJiraBaselineRecord` (`sources/jira/baseline.ts`).

### `delivery/`

- **Owns:** the one optional delivery step. `github.ts` pushes a passed attempt's own branch
  to the configured destination repository, finds its pull request by repository, head branch, and
  base branch, updates the one open match, creates one only when no match exists, and refuses a
  closed or merged match instead of editing a pull request no open review would receive. It refuses
  a working copy that still holds uncommitted work and delivers nothing when the branch has no
  commit beyond its recorded base. Every command goes through `process/command.ts`, so it is
  bounded and its output is kept in the run's log directory; the pull request body is written there
  too.
- **Does not own:** the run, the checks, the receipt, or whether delivery happens — the
  coordinator decides that, and only for a passed attempt. It never merges, force-pushes, or
  changes an issue, keeps no delivery state, and is not a source or a coding runtime.
- **Entry points:** `createGitHubDelivery`, `Delivery`, `DeliveryRequest`,
  `DeliveredPullRequest`, `GitHubDeliveryParts`, `DeliveryError`,
  `DELIVERY_COMMAND_TIMEOUT_MS` (`delivery/github.ts`).

### `agents/codex/`

- **Owns:** the only implemented coding runtime. `runtime.ts` is the launch prefix and the host
  contract (environment, process-tree stop, grace) plus the one filesystem policy a turn names —
  the coding policy by default, and the narrower one the pre-delivery baseline diagnosis asks for;
  it is also where that diagnosis refuses a configured prefix that carries a switch of its own — a
  writable root, a working root, or a policy the launch's own overrides cannot take back;
  `adapter.ts` is one top-level turn through the
  host's `codex exec`, normalized to the runner's `AgentTurnResult`; `prompt.ts` is what a turn is
  told, the bounded guidance included; `events.ts` reads the runtime's JSON event stream. No Codex
  flag, event, or type leaves these files.
- **Does not own:** the run, the checks, the working copy, or model/provider selection. The launch
  prefix comes from configuration, and credentials stay in the runtime's own environment or native
  configuration.
- **Entry points:** `runCodexTurn`, `runCodexPrompt`, `CodexPromptRequest`, `AgentError`
  (`agents/codex/adapter.ts`); `codexRuntime`,
  `selectedCodexRuntime`, `CodexRuntime`, `CodexSandboxPolicy`, `codexExecArguments`,
  `diagnosticLaunchProblem`, `CODEX_EXECUTABLE`, `CODEX_EXEC_ARGUMENTS`
  (`agents/codex/runtime.ts`).

### `reviews/`

- **Owns:** the one optional Nexus Lens review path. `contract.ts` is the ordinary data and
  failures the scan acts on (`ReviewError`, its problem kinds, the pull request, review, verdict,
  evidence and summary shapes, and the two boundaries — `ReviewQueue`, the read-only Jira side,
  `ReviewRepository`, everything the scan needs from GitHub, and `ReviewViewSource`, the local
  repository view it prepares and checks). `github.ts` is the App
  installation: the RS256 JWT signed with the configured PEM key, the installation token it is
  exchanged for, and the pull request, review, changed-file, check and check-run calls the scan
  makes. `view.ts` is the reviewer's own repository view: it clones the ticket's retained
  workspace into the review's evidence directory, removes the clone's remote, pins it at the
  exact reviewed head, and reports a view that is missing, cannot be pinned, does not hold the
  base commit, or was changed; it reuses the workspace module's bounded Git invocation and hands
  the reviewer no credential. `diff.ts` computes the classic diff position of a finding, so a
  finding the pull request's patch does not show — or a patch GitHub could not report completely
  — is reported in the body instead of dropped. `reviewer.ts` is the prompt one ticket's identity
  and its view become, the one bounded Codex turn through
  `agents/codex/`, and the strict reader of the `verdict.json` that turn has to write. `scan.ts`
  is one finite scan and the watch above it: eligibility, the ticket's own intake receipt when the
  output directory holds one, the pointer-to-branch pull request lookup, the native
  deduplication, the view's preparation and post-turn check, the stale-head and stale-ticket
  rechecks before publishing, the review and check publishing, and the evidence directory and log
  each attempt keeps. `baseline.ts` is the same reviewer over a different subject: the one bounded
  turn a completed red baseline enters before any coding turn, its prompt over the configured
  commands and their bounded output, the snapshot clone it inspects, the checks that hold that
  clone and the retained working copy to the tree the checks really ran against, the outcome
  record it writes before anything is published — the validated finding, or the problem that
  rejected the turn, with the turn's own stop — which a restart reuses instead of the turn's
  finding file and which every reader of what that evidence produced reads back, so a marker on the
  item's thread and a continuation's required finding are both held to what the turn really
  recorded, and the strict reader of the `finding.json` that turn has to write in its own
  writable working directory — a bound the finding's own fields are enforced against by refusing
  one that runs past it, never by cutting a field to it. A refusal reached before that turn carries the stop the evidence's
  record already holds — and a record that cannot be read at all fails closed by name — so no
  refusal can round an unconfirmed stop down to a confirmed one.
- **Does not own:** the coding loop, the working copy, Jira writes, delivery, or merging. It
  claims nothing, moves nothing, posts no Jira comment, starts no coding turn, and keeps no
  registry: a completed review pinned to a commit is the deduplication record.
- **Entry points:** `ReviewError`, `ReviewScanContext`, `ReviewWatchOptions`, `ReviewSummary`,
  `ReviewItemResult`, `ReviewQueue`, `ReviewRepository`, `ReviewView`, `ReviewViewSource`,
  `ReviewerTurn`, `ReviewVerdict` (`reviews/contract.ts`); `resolveAppPrivateKey`, `appJwt`,
  `createGitHubReviewClient`, `GITHUB_API_BASE_URL` (`reviews/github.ts`); `prepareReviewView`,
  `reviewViewProblem`, `reviewViews`, `REVIEW_VIEW_DIRECTORY` (`reviews/view.ts`);
  `reviewPrompt`, `parseVerdict`, `createReviewerTurn`, `reviewEvidenceProblem`
  (`reviews/reviewer.ts`); `scanReviews`, `watchReviews`, `allocateReviewDirectory`
  (`reviews/scan.ts`); `diffPosition`, `positionFindings` (`reviews/diff.ts`);
  `createBaselineReviewer`, `baselinePrompt`, `baselineFailures`, `parseBaselineFinding`,
  `baselineFindingPath`, `readBaselineOutcome`, `readBaselineReviewerShutdown`,
  `BASELINE_FINDING_FILE`,
  `BASELINE_TURN_DIRECTORY` (`reviews/baseline.ts`).

### `history/`

- **Owns:** the one identified ticket conversation snapshot a developer and a reviewer turn are
  both given, and the complete reports it is built from. `contract.ts` is the ordinary data
  (entries, the brief, the report summaries, the snapshot, the reader boundary, `HistoryError`);
  `store.ts` writes each snapshot under the hash of its own content and moves `current.json`
  atomically, so a refresh never rewrites a snapshot a running turn holds; `reports.ts` keeps the
  complete developer and reviewer reports under `<workspaceId>.history/reports` before anything
  renders them, records the acknowledged comment or native review as each report's publication,
  reuses a run's own `result.json` and the reviewer's retained verdict for reports that predate the
  increment (marking one that cannot be read back as the conversation it claims to be, and one that
  really existed but can no longer be read); `sync.ts` reads the connector boundary, deduplicates by
  source identity (an edited comment updates its entry), authenticates a published rendering of a
  local report against its recorded publication identity — never against wording alone —
  reconciles the unresolved round across retained reports and native reviews, tracks feedback
  against the entries the previous snapshot held, and builds the brief — the requirements, the
  latest delivery, the complete unresolved findings with their responses, and the human feedback new
  or edited since the previous snapshot; `prompt.ts` renders the one section both role prompts carry,
  gaps named first.
- **Does not own:** any connector, credential, or remote write. It imports no Jira or GitHub
  module; `cli/history.ts` composes its readers from the existing connector and App client and
  hands the same object to the source coordinator and the review scan.
- **Entry points:** `createTicketHistory`, `HistoryError`, `HistorySnapshot`, `TicketHistory`
  (`history/contract.ts`, `history/sync.ts`); `workspaceHistoryRoot` (`history/paths.ts`);
  `recordDeveloperReport`, `recordReviewerReport`, `readLocalReports` (`history/reports.ts`);
  `renderHistorySection` (`history/prompt.ts`); `createConfiguredHistory`
  (`cli/history.ts`).

### `queue/`

- **Owns:** the order of one serial queue invocation, and nothing else. `loop.ts` holds one current
  ticket, takes at most one ticket per fresh scan, runs that ticket's coding attempt and delivery,
  reviews it, completes it, prepares the checkout between two workspaces, and repairs the same
  ticket when the completion path returns it to its ready status. Every phase is an ordinary
  function handed to it; a `pending` completion is waited out with the configured interval, and an
  idle watch waits for the next ticket without starting an agent. Its discovery step reports a
  pending recovery it could not finish as a stop of its own — never as a failure it goes on
  past — and carries whether everything that recovery started was confirmed stopped, so the
  invocation's intake lock is kept when something may still be writing.
- **Does not own:** any phase's implementation. It imports no connector and no credential, starts no
  agent, merges nothing itself, and keeps no state across invocations. `src/cli/queue-command.ts` is
  what builds the four phases, resolves the three credentials, and holds the connected project's
  intake lock for the whole invocation.
- **Entry points:** `runQueue`, `QueueLoopContext`, `QueueRunMode`, `QueueSummary`,
  `QueueTicket`, `QueueRecovery`, `QueueDiscoveryStop`, `QueueReviewOutcome`,
  `QueueCompletionOutcome`, `QueueIo` (`queue/loop.ts`).

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
  |      +--> delivery/github.ts  (the optional step's own types)
  |      +--> sources/jira/  -----> config/schema.ts (the Task schema)
  |
  +--> delivery/  -------> process/ (bounded commands), workspace/ (Git hygiene)
  |
  +--> reviews/   -------> agents/codex/, reporting/ (evidence log), workspace/ (pointer ids and
  |                        the view's bounded Git), sources/contract.ts, shared/ -- and, for the
  |                        pre-delivery diagnosis, the same review turn over a different subject
  |
  +--> queue/     -------> sources/contract.ts only (the ticket's identity and its take result)
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
- `delivery/` depends on `process/`, `workspace/`, and `shared/`; `sources/` imports its `Delivery`
  type only, and the CLI is the one place that builds the implementation from the configuration.
- `sources/jira/` depends on `sources/contract.ts`, `sources/jira/json.ts`, and `config/schema.ts`;
  nothing above `sources/` imports a connector except the one command that builds it
  (`cli/source-command.ts`).
- `reviews/` depends on `agents/codex/` for the reviewer turn, `reporting/` for its evidence log,
  `workspace/run-directory.ts` for the pointer-id check, `workspace/git.ts` for the bounded Git
  invocation its repository view reuses, `sources/contract.ts` for the ordinary
  queue data, and `shared/`. Its queue is handed to it as functions, so it imports no Jira
  connector; the CLI is the one place that builds it (`cli/review-command.ts`), and nothing else
  imports `reviews/`.
- `queue/` depends on `shared/` and on `sources/contract.ts` for the ticket it carries and the
  result a consumer step reports; nothing under it imports a connector, a repository client, the
  runner, or `cli/`. The CLI is the one place that builds its phases (`cli/queue-command.ts`).
- Nothing imports `cli.ts`, and nothing outside `cli/` writes to the terminal.

The two boundary rules the repository enforces mechanically are checked with ESLint and the boundary
fixtures: helper modules may not import the CLI, and `src/shared/types.ts` may not import `node:*`.

## 4. Important contracts

| Contract | Where it lives | Written down by |
| --- | --- | --- |
| `Task` | `src/shared/types.ts`; validated by `taskSchema` in `src/config/schema.ts` | a task file, or a connector's mapping |
| Configuration | The effective `HarnessConfig`, `AgentSelection`, `JiraSourceConfig` in `src/shared/types.ts`; the two file schemas and their defaults in `src/config/schema.ts`; the file names in `src/config/paths.ts`; reading, path rules, and composition in `src/config/load.ts` | the operator's Nexus-wide harness configuration and the connected repository's own `nexus.project.json` |
| `TaskSource` | `src/sources/contract.ts` (`listEligible`, `prepare`, `claim`, `progress`, `complete`, `recordWorkspace`, `refuse`, `commentsSince`) | the coordinator in `src/sources/coordinator.ts` |
| Jira connector | `src/sources/jira/`, built by `createJiraSource` (`connector.ts`) | the Atlassian REST API v3 boundary; tested against a fake HTTP boundary |
| Coding runtime / agent | `AgentTurnRequest`, `AgentTurnResult`, `AgentTurnShutdown`, `RunnerDependencies.runAgentTurn` in `src/runs/contracts.ts`; the only implementation is `src/agents/codex/` | the runner, which never sees a runtime flag or event |
| Run result / report | `RunTaskResult` (`src/runs/contracts.ts`) is what a caller gets; `RunReport`/`CheckRoundResult`/`ChangeSummary` (`src/shared/types.ts`) are what `result.json` holds; `writeRunReport` (`src/reporting/report.ts`) is the only writer | the run's own evidence, plus the change summary from `src/workspace/changes.ts` |
| Workspace layout and ledger | `WorkspaceState`/`WorkspaceAttempt` (`src/workspace/state.ts`), `ContinuedWorkspace` (`src/workspace/reopen.ts`); the paths in `src/workspace/run-directory.ts` | the runner, as each attempt finishes; the coordinator resolves it, and refuses rather than guesses |
| Pointer label | `workspacePointerLabel`/`parseWorkspacePointers` (`src/sources/contract.ts`), written through `src/sources/jira/labels.ts` | the run that creates a workspace, once, before any coding turn |
| Escalation ladder | `EscalationTier` (`src/shared/types.ts`), the `escalation` schema in `src/config/schema.ts`, the climb in `src/sources/coordinator.ts` | the Nexus-wide harness configuration |
| Attempt guidance | `SourceComment` (`src/sources/contract.ts`), rendering and budgets in `src/sources/guidance.ts`, the prompt section in `src/agents/codex/prompt.ts` | the item's own thread and the workspace ledger, bounded; the reviewed baseline finding the coordinator establishes is carried as its own lines, ahead of the context and with a budget of its own, so neither spends the other's |
| Delivery | `GitHubDeliveryConfig` (`src/shared/types.ts`), the project `delivery` schema in `src/config/schema.ts`, `Delivery`/`DeliveryRequest`/`DeliveredPullRequest` and `createGitHubDelivery` (`src/delivery/github.ts`), the call in `src/sources/coordinator.ts` | the connected project's configuration; GitHub is the record of whether a pull request exists |
| Review | `GitHubReviewConfig` (`src/shared/types.ts`), the Nexus-wide `reviewer` schema composed with the project's `source` and `delivery` in `src/config/load.ts`, `ReviewQueue`/`ReviewRepository`/`ReviewVerdict`/`ReviewSummary` (`src/reviews/contract.ts`), `createGitHubReviewClient` (`src/reviews/github.ts`), `createReviewerTurn` (`src/reviews/reviewer.ts`), `scanReviews`/`watchReviews` (`src/reviews/scan.ts`), wired by `src/cli/review-command.ts` | the harness configuration's reviewer integration, the connected project's own repository, and the GitHub App installation; the native review pinned to a commit is the record of what was reviewed |
| Serial queue | `QueueTicket`/`SourceTake` (`src/sources/contract.ts`), `takeOneItem` (`src/sources/coordinator.ts`), the optional one-ticket scope in `ReviewScanContext` and `CompletionPassParts`, `runQueue` (`src/queue/loop.ts`), `refreshSource` (`src/workspace/refresh.ts`), wired by `src/cli/queue-command.ts` | the operator's configuration; Jira, the pointer label, and GitHub's native state are the authorities a restart reads |
| Baseline diagnosis | `BaselineFinding`/`BaselineDiagnosis`/`BaselineRecord`/`BaselineReview`/`BaselineReviewedFinding` (`src/sources/contract.ts`), `createBaselineDiagnosis`/`baselineCommentFinding` (`src/sources/baseline.ts`), `createBaselineReviewer` (`src/reviews/baseline.ts`), `createJiraBaselineRecord` (`src/sources/jira/baseline.ts`), wired by `src/cli/source-command.ts` and `src/cli/queue-command.ts` | the configured reviewer, the source's own thread and statuses, and the completed red round; the marker comment in the item's own thread is the remote half of the record a restart reads — and only as its whole comment, naming the exact evidence identity the record closed as a repair — and the evidence file the phase writes under `<workDir>/baseline/<project>/<evidence>/`, the connected project's own namespace, is the local half |

The runner's collaborators are still plain functions (`RunnerDependencies`), so a test substitutes
one function rather than a framework. `cli/dependencies.ts` is the only place that builds the real
set.

## 5. Adding a new task source

A second source beside Jira is a new folder plus a few small, named edits:

1. **Describe it in configuration.** Add a strict object schema for the new `source.type` in
   `src/config/schema.ts`, with the documented defaults, and widen the `source` field of
   `projectConfigSchema` (today it is the Jira schema alone). Widen `HarnessConfig.source` in
   `src/shared/types.ts` to the union of the source configuration types.
2. **Implement `TaskSource`** in a new `src/sources/<name>/` folder: an ordinary object with
   `listEligible`, `prepare`, `claim`, `progress`, `complete`, `recordWorkspace`, `refuse`, and
   `commentsSince`, plus one factory that takes the validated configuration and whatever credential
   it needs, the way `createJiraSource` does. Keep the transport, the wire parsing, and the mapping
   inside that folder; validate the mapped object with `taskSchema` so a bad item is a per-item
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
- Delivery stays in `src/delivery/`: one optional step of a source command, not a source, not a
  connector, and not part of the runner. It starts its commands through `src/process/` like
  everything else, and nothing under `sources/jira/` pushes a branch or opens a pull request.
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
  hand once (`docs/implement-workspace-continuation.md`). A name a fresh claim would use is checked
  before anything is created: what already holds it is refused with guidance, never adopted or
  overwritten, and an existing `run-*` name is looked up exactly like a ticket key.
- The ledger is derived state. A run's report is the authority on what that run did, the ledger is
  only what the next attempt reads, and nothing rewrites a report.
- Text from an item - its description, its comments, another agent's note - is context for a turn and
  never configuration: it cannot become a command, a path, a repository, or a limit.
- A module has one responsibility. If a file needs two paragraphs to say what it owns, it is two
  modules - that rule is what produced this tree, and it is how the next split should be chosen.


The optional completion path adds `delivery/completion.ts` and `delivery/gate.ts` for
GitHub reads and native auto-merge arming, `sources/completion.ts` for the bounded pass
and its arm-before-review step, and `sources/jira/completion.ts` for Jira feedback. The
serial queue owns only the order: arm the delivered head, review it, then verify the
recorded arm through completion. It starts no agent and creates no workflow engine or
service.
