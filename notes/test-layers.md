# Test layers, coverage ownership, and the restored suite

HARN-48. This document is the behaviour-to-test ownership map the ticket asks
for: what each suite owns, what moved, what was deleted and which active case
carries the guarantee it asserted, which case is the primary owner of every
overlapping scenario, and how the restored suite performs against the audit's
baseline. It replaces the temporary quarantine recorded in
[test-architecture-audit.md](test-architecture-audit.md); that file stays as the
evidence the containment decision was made from.

Raw count is not evidence of equivalence. The maps below name the assertion each
move and deletion is accounted for by; the counts that changed are reconciled
against the audit reference under [Performance](#performance).

## The two layers

The suite is two Vitest projects with explicit concurrency policy
(`vitest.config.ts`), not one pool of 53 files:

- **policy** — configuration, parsing, the terminal model, reporting, the queue
  decisions, the history store, the review verdict/scan/watch decisions, the
  baseline finding text, and the run loop's repair and deadline decisions:
  ordinary functions and in-memory collaborators, no child process of their own.
  It may run wide (`maxWorkers: 8`) and finishes in seconds.
- **boundary** — real Git, real command shells, real children, the built CLI and
  the stand-in runtime. Every worker can start further Git and Node processes, so
  this layer is capped (`maxWorkers: 4`), and it runs after the fast layer rather
  than beside it (`sequence.groupOrder`).

The six cases in `cli.integration.test.ts` form the built-artifact smoke subset
of the boundary layer. Run them alone with
`npx vitest run tests/cli.integration.test.ts`; they share the boundary worker cap.

Commands:

| Command                     | What it runs                                                    |
| --------------------------- | --------------------------------------------------------------- |
| `npm test`                  | Both layers, in order — what `npm run validate` runs.           |
| `npm run test:policy`       | The fast layer alone, for the loop while working on it.         |
| `npm run test:boundary`     | The process-heavy layer alone.                                  |
| `npm run test:four-workers` | The comparable measurement: every file, one pool, four workers. |
| `npm run test:live`         | The opt-in live provider exercise. Never part of the gate.      |

`npm run test:four-workers` (`vitest.four-workers.config.ts`) exists only so a
measurement can be taken in the shape the audit's reference run used: one pool,
four workers, every file. It runs the same cases as `npm test` and is never part
of `validate` or CI.

The caps are scheduling policy, not assertions: no test asserts on a worker
count, and there is no layer-wide deadline. A case states its own bound only
where its work is bigger than one round of it: `completion-arm.test.ts > recovers
a native merge after …` makes three arm/pass calls over real `gh` commands (15
s), and the cases that make two or more complete passes state
`TWO_PASSES_TIMEOUT_MS` (10 s). Everything else keeps the 5 s default.

## Ownership of the overlapping scenarios

These scenarios were replayed through several entry points. Each has one primary
owner now; the other suites keep only the assertions the primary owner cannot
make, and every additional execution below is named with the boundary it is
there for.

| Scenario                                         | Primary owner (assertion)                                                                                                           | Kept elsewhere, for a distinct boundary                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation turn implements the task          | `runner.test.ts` (a run whose baseline passes: checks decide, report written)                                                       | `local-run.integration.test.ts` once, through the real Codex adapter and the target's own checks; `cli-run.integration.test.ts` once, through the CLI         |
| Repair allowance, one red round after another    | `runner-policy.test.ts` (the bounded repair loop: rounds, allowance, last round red, report and timeline)                           | `runner-repair.test.ts` once, with real Git and real configured commands; `cli-run.integration.test.ts` once, through the CLI                                 |
| Allowance exhausted                              | `runner-policy.test.ts` (the exact allowance is spent, the last round is reported red)                                              | —                                                                                                                                                             |
| A turn that claims success while a check fails   | `runner-repair.test.ts` (the lying summary sits beside the red round it did not change)                                             | `runner.test.ts` (a failing check is never a pass)                                                                                                            |
| A repair turn that fails                         | `runner-policy.test.ts` (no further turn, no invented round, the report keeps the failed turn)                                      | `runner.test.ts` (the same decision with real commands)                                                                                                       |
| A round that cannot be executed after a repair   | `runner-policy.test.ts` (execution-error, no further turn, the failed command's output kept)                                        | `runner-repair.test.ts` (the real setup command that closes the gate)                                                                                         |
| One task deadline across every phase             | `runner-policy.test.ts` (one budget from preparation through the repair turns, with a controlled clock)                             | `runner-repair.test.ts` (the deadline that stops a real command)                                                                                              |
| Red baseline before any coding turn              | `runner.test.ts` + `baseline.test.ts` + `baseline-queue.integration.test.ts`                                                        | —                                                                                                                                                             |
| Cancellation, and the child tree it must stop    | `lifecycle.test.ts` (real cancellation at each phase, child-tree assertions) and the fixture-lifecycle proof                        | `runner-repair.test.ts` (the run's own stop decision), `cli-run.integration.test.ts` (the CLI's signal seam), `cli.integration.test.ts` (a real interrupt)    |
| Setup failure, launch failure, an unusable check | `checks.test.ts` (configured commands, launch failures, command-tree deadlines)                                                     | `runner.test.ts` (what the run records for each)                                                                                                              |
| Completion deadline, retry and idempotency       | `completion-policy.test.ts` over `CompletionActions` and a controlled clock                                                         | `completion-github.test.ts` + `completion-arm.test.ts` for the command boundary: exact `gh` invocations, the credential split, the evidence and restart files |
| Built artifact, argument routing, exit codes     | `cli.integration.test.ts` (the built `dist/cli.js` as a process)                                                                    | `cli.test.ts` (parser/display) and `cli-run.integration.test.ts` (a real run through the CLI)                                                                 |
| The opt-in live verifier's own contract          | `live-verifier.test.ts` (prerequisites, the entry point as a process, the disposable project, one passing and one failing exercise) | —                                                                                                                                                             |
| The README's documented example                  | `readme.test.ts` (the documented command, run as documented)                                                                        | `live-verifier.test.ts` (the `test:live` entry point's prerequisites)                                                                                         |

## What each restored file owns now

Each of the nine quarantined files is active again. Where a file was mixed, it
was split by responsibility and the shared fixture was extracted; no assertion
was deleted or weakened. The only deadline change is the stated
`TWO_PASSES_TIMEOUT_MS` bound for the cases that make two or more complete passes
over the real command boundary, documented under "Completion: the in-memory
boundary" below.

| Former file                      | Now                                                                                                                          | What moved, and why                                                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `completion.test.ts` (158.6 s)   | `completion-policy.test.ts`, `completion-github.test.ts`, `completion-arm.test.ts`, `completion-summary.test.ts`             | The pass itself, the arm/reconcile step and the summary are three responsibilities; the deadline, retry and idempotency decisions moved to the in-memory boundary with a controlled clock, and the command boundary kept the exact invocations, the credential split and the restart files |
| `runner.test.ts` (104.8 s)       | `runner.test.ts`, `runner-repair.test.ts`, `runner-records.test.ts`, `runner-policy.test.ts` over `tests/fixtures/runner.ts` | The loop up to a green baseline, the repair/deadline/stop policy, and what a run records. The policy matrix now runs against in-memory collaborators; the real repository stays for the cases that assert real commands, real Git and real child trees                                     |
| `source.test.ts` (85.2 s)        | `source.test.ts`, `source-cli.integration.test.ts` over `tests/fixtures/source.ts`                                           | The coordinator, receipt, lock and escalation policy no longer load the 2,700-line CLI block; the CLI block keeps its own fake Jira and runners                                                                                                                                            |
| `workspace.test.ts` (83.2 s)     | `workspace.test.ts`, `workspace-branch.test.ts` over `tests/fixtures/workspace.ts` and `tests/fixtures/git.ts`               | Retention and branch recovery (real Git safety) are one file; preflight, run directory, preparation and the change report are another                                                                                                                                                      |
| `baseline.test.ts` (39.5 s)      | `baseline.test.ts`, `baseline-queue.integration.test.ts` over `tests/fixtures/baseline.ts`, `baseline-findings.test.ts`      | The diagnosis (reviewer turn, evidence, finding file, Jira record, coordinator), the queue-facing half, and the finding text itself — which is a decision over strings and needs no reviewer                                                                                               |
| `cli.test.ts` (34.1 s)           | `cli.test.ts`, `cli-run.integration.test.ts` over `tests/fixtures/cli.ts`                                                    | Help, `check-config`, usage errors, path resolution, colour and the entry-point guard are one file; the real run fixtures and interrupts are another                                                                                                                                       |
| `live-verifier.test.ts` (33.9 s) | unchanged apart from the deleted repair replay                                                                               | Its subject is the opt-in tool itself: the prerequisite gate, the entry point as a process, the disposable project, the injected failure, and two exercises (one that must pass, one that must be detected). The repair matrix is owned by the runner suites                               |
| `local-run.integration.test.ts`  | reduced to five composition cases                                                                                            | Kept as the composition layer: the pass through the real adapter, one repair, the target's own checks, a real clone, and the real process trees a deadline and a cancellation stop. Five replayed policy scenarios were deleted, each with its owner named below                           |
| `delivery.test.ts` (11.6 s)      | unchanged, active                                                                                                            | Real Git plus a stand-in `gh`: the push, the create-or-update decision and the revision refusals                                                                                                                                                                                           |

Two more files were split for the same reason:

| Former file             | Now                                                                                                                 | What moved, and why                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviews.test.ts`       | `reviews.test.ts` (68 cases, 0.9 s) and `reviews-cli.integration.test.ts` (34 cases) over `tests/reviews-shared.ts` | The verdict, the scan decisions, the watch, the configuration and the App key are decisions over strings and fakes; the CLI path, the Git-backed review view and the evidence directory are the boundary half |
| `runner-repair.test.ts` | `runner-repair.test.ts` plus the new `runner-policy.test.ts`                                                        | Five policy variations (allowance, a failed repair turn, an execution-error round, the one budget, the task-time-left limit) no longer clone a repository; the file keeps the real-command cases              |

## Coverage that moved, and what each removal points to

Every deleted case below is a _moved_ one unless it is marked otherwise: the
replacement asserts the same substantive observations — the same status, report
fields, counts and reasons — against the layer that owns the decision.

### Completion: the in-memory boundary (`completion-policy.test.ts`)

| Case (formerly at the real `gh` boundary)                                                             | Now                                                                           |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `completion.test.ts` "bounds a merge that never finishes across passes…"                              | the same case, and the pre-expiry restart checks the recorded wait again      |
| `completion-arm.test.ts` "retries a transient read before arming…"                                    | "reads a transient failure of the pull request again while arming"            |
| `completion-arm.test.ts` "retries a transient GitHub failure within the deadline…"                    | "reads a transient merge failure again instead of stopping for a person"      |
| `completion-arm.test.ts` "retries a transient failure of the required-check read…"                    | "reads a transient check failure again rather than turning it into a finding" |
| `completion-arm.test.ts` "stops a transient GitHub failure at the deadline…"                          | "stops a transient failure at the deadline instead of retrying forever"       |
| `completion-arm.test.ts` "does not mint a fresh deadline for the guard before the resolution comment" | the same case, with the read counted instead of a `gh` occurrence             |
| `completion-arm.test.ts` "does not mint a fresh deadline for the guard before the status move"        | the same case, with the read counted instead of a `gh` occurrence             |
| `completion-github.test.ts` "writes one findings comment and one move when the pass is repeated"      | "writes one findings comment and one move when the pass is repeated"          |
| `completion-github.test.ts` "does not write a second comment when the first write was uncertain"      | "does not write a second comment when the first write was uncertain"          |
| `completion-github.test.ts` "does not duplicate the resolution comment when the move failed first"    | "does not duplicate the resolution comment when the move failed first"        |
| `completion-github.test.ts` "recovers a comment accepted by Jira whose response was lost"             | "does not repeat a comment whose write landed without an answer"              |
| `completion-github.test.ts` "does not repeat a transition that Jira accepted with a lost response"    | "does not repeat a transition Jira accepted without answering"                |

What stayed at the real boundary because only it can assert it: the reader
credential's refresh and its separation from the operator token, the per-issue
evidence directory and the exact `gh` arguments, a read the harness had to stop
at its own command limit, the persisted admission across a restart, the Jira
write shapes themselves (`tests/jira.test.ts` owns those), and the whole
decision matrix over real answers.

The cases that make **two or more complete passes** — or arm calls — over that
boundary state their own bound (`TWO_PASSES_TIMEOUT_MS`, 10 s in
`tests/fixtures/completion.ts`): six in `completion-github.test.ts` and four in
`completion-arm.test.ts`, plus the three-call `completion-arm` recovery case that
already had 15 s. That is the case's own work, not a layer-wide deadline: a case
that makes a single pass keeps the default five seconds, and the layer's cap
remains a scheduling policy no case asserts on.

### The run loop: in-memory collaborators (`runner-policy.test.ts`)

| Case (formerly against a real repository)                                                             | Now                                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `runner-repair.test.ts` "spends at most maxRepairs additional turns…"                                 | the same case: three turns, three red rounds, four rounds in all             |
| `runner-repair.test.ts` "stops without another turn when a repair turn itself fails"                  | the same case: two turns, no round after the failed one                      |
| `runner-repair.test.ts` "stops without another turn when the round after a repair cannot be executed" | the same case: execution-error, no further turn, the setup's own output kept |
| `runner-repair.test.ts` "spends one budget from preparation through the repair turns"                 | the same case: one deadline, the same budget left at each round              |
| `runner-repair.test.ts` "stops the baseline when the task time that was left is the smaller limit"    | the same case: the timeout record names the task limit, not the command's    |

The real-repository file keeps the repair case that proves the wiring: real
configured commands, a real stand-in turn that commits, the repair turn's
feedback read from the files the commands really wrote, and the event order.

### The integration suites

| Deleted case                                                                                            | Carried by                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `local-run.integration.test.ts` "spends the exact repair allowance…"                                    | `runner-policy.test.ts` (allowance exhausted) and `runner-repair.test.ts`                                                        |
| `local-run.integration.test.ts` "does not let a coding turn that claims success…"                       | `runner.test.ts` (a failing check is never a pass) and `runner-repair.test.ts` (the lying summary)                               |
| `local-run.integration.test.ts` "stops before any coding turn when the committed baseline is red"       | `runner.test.ts` and `baseline-queue.integration.test.ts`                                                                        |
| `local-run.integration.test.ts` "ends the run without a repair when a setup command fails after a turn" | `runner-policy.test.ts` (execution-error round)                                                                                  |
| `local-run.integration.test.ts` "ends the baseline with no coding turn when a check cannot be launched" | `checks.test.ts` (a check that cannot execute is not a red round) and `runner.test.ts`                                           |
| `cli.integration.test.ts` "repairs a failed round and passes…"                                          | `cli-run.integration.test.ts` and `runner-repair.test.ts`                                                                        |
| `cli.integration.test.ts` "stops at a red baseline with a report…"                                      | `runner.test.ts` and `baseline-queue.integration.test.ts`                                                                        |
| `cli.integration.test.ts` "spends the whole repair allowance…"                                          | `runner-policy.test.ts`                                                                                                          |
| `cli.integration.test.ts` "ends a run whose coding turn failed…"                                        | `runner.test.ts`, `runner-policy.test.ts`                                                                                        |
| `cli.integration.test.ts` "ends a run whose runtime never reported a turn at all"                       | `agent.test.ts` (a runtime that exits without reporting a completed turn)                                                        |
| `live-verifier.test.ts` "passes the repair exercise, and hands the injected failure to the repair turn" | `runner-repair.test.ts` / `runner-policy.test.ts` for the repair matrix; the verifier keeps a passing exercise and a failing one |

What the three files keep is the assertion their entry point alone can make:
`local-run` keeps the real adapter and the real process trees a deadline and a
cancellation stop; `cli.integration` keeps the built artifact as a process, its
exit codes, a real interrupt and the launch prefix; `live-verifier` keeps the
tool's prerequisites, its discovery/CI exclusion and the disposable project.

## The shared fixture lifecycle

The audit found the same defect on every process suite: `afterEach` removed the
temporary directory without cancelling or awaiting the work the test had
started, so a failing, cancelled or timed-out test could leave a process holding
the tree.

`tests/fixtures/lifecycle.ts` is the one implementation now, and it is a scope
per test rather than a registry of things that happened to be started:

- **The test's own stop.** The scope carries an `AbortSignal` that the hook
  aborts before it waits for anything. `runProcess` takes it, the completion
  fixture hands it to every `run`/`arm`, the runner fixture hands it to `runTask`
  (as the run's own stop, beside whatever the request carried) and the built CLI
  takes it by having its child registered. A test that times out or is cancelled
  cancels what it started instead of racing the removal.
- **Owned work.** `ownFixtureOperation` registers the asynchronous operation
  itself — a completion pass, a task run, a CLI invocation — so disposal waits
  (bounded) for it to settle after the trees are stopped, and _refuses_ an
  operation asked for after disposal began. A continuation that resumes late
  cannot start one behind the hook's back.
- **Owned processes.** `runProcess` and `ownChildProcess` keep the child and its
  working directory; `ownFixtureProcess` keeps a fixture process by the token
  only that process recorded — never a bare PID, which this platform hands on
  (`notes/windows-fixture-flakes.md`).
- **Directories are preserved when a stop cannot be confirmed.** A process whose
  end is not confirmed — or an operation that never settled, which is exactly
  when the directory it holds is unknown — keeps the temporary directory it ran
  in. The hook reports both, and removes only the directories no unconfirmed
  owner might still hold.

Identical bodies removed: `runProcess` from `agent`, `git`, `runner` and
`workspace`; `registerFixture` from `checks`, `git`, `lifecycle` and
`local-run.integration`; the private Git environment from ten suites (now
`tests/fixtures/git.ts`); the review fixtures both halves of the review suite
needed (now `tests/reviews-shared.ts`).

`tests/fixture-lifecycle.test.ts` proves the lifecycle on the ways a test can
end, and two of those proofs are new in this round:

- after a command that outlives its own bound, a command the test cancels, and a
  registered fixture process with its directory: the directory is gone and the
  recorded PIDs (and their children) are gone;
- through `vitest.lifecycle.config.ts`, which runs cases that must fail: an
  assertion failure with a tree still running, a setup failure, and a timeout
  with a fixture process still owned;
- **a timeout whose continuation is still pending**: the case's continuation is
  still asleep when the test times out, resumes after the hook has begun, tries
  to start another command, is refused by the closed scope, and is awaited
  before the directory is removed — the proof asserts the refusal, that the late
  command never ran, and that the directory is gone;
- **a stop the host would not carry out**: the case takes the utility Windows
  stops a tree with off its own `PATH`, so the stop is attempted and cannot be
  confirmed. The hook keeps the directory, names it in the failure, and the
  proof ends the leftover tree itself — by the utility's absolute path — before
  removing the directory it deliberately kept.

Two assertions were updated because the fixture now supplies the test's own stop
to the run it starts: `runner-repair.test.ts` and `runner-records.test.ts` used
to deep-compare the whole preflight request, which had no `stop`. They now
assert the same facts field by field — the deadline, the clock, the paths — and
that the stop is present and live. Nothing else about those cases changed.

## HARN-41 guarantees retained from integrated main

The starting commit is `0804d2d` (integrated HARN-41), not containment.
`history.test.ts` and `history-source.test.ts` retain their assertions unchanged;
`history-runner.test.ts` only changes its shared Git fixture import. The original
finding fixes and later repairs retain these observable guarantees in active owners:

| Guarantee                                             | Active cases and observations                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentic mirrors and preserved edits                 | `history.test.ts`: recorded publication identity/hash deduplicates actual renderings; quoted markers, legacy edits and timestamp-free review edits survive across roles, rounds and restarts.                                                                                                                         |
| Unresolved review provenance and responses            | `history.test.ts`: newer native change requests survive older local approvals and unrelated reviews; offset/unknown timestamps and completion responses remain actionable. `review-github.test.ts` retains paginated native review reads.                                                                             |
| Independent role consumption and fresh requirements   | `history.test.ts`: preparation consumes nothing; each role acknowledges its immutable input; edits and feedback during a turn appear next time; unreadable requirements refuse input.                                                                                                                                 |
| Whole reports before publication and restart recovery | `history-source.test.ts`, `source.test.ts`: full report precedes rendering, records delivered commit/acknowledgment, and persistence failure stops publication. `history.test.ts`: interim/legacy reports reconcile with finished runs and missing evidence remains a named gap.                                      |
| Developer repair input and shutdown evidence          | `history-runner.test.ts`, `runner-records.test.ts`: readable fresh history before each turn, whole preceding message before repair, exact consumed input, no turn on preparation failure, retained timeout/cancellation/report failures.                                                                              |
| Reviewer and baseline wiring                          | `reviews-cli.integration.test.ts`, `baseline-queue.integration.test.ts`: real reviewer receives readable snapshot paths and whole feedback; durable review precedes publication; baseline return/restart guidance comes from the recorded snapshot. `baseline.test.ts` retains diagnosis evidence/refusal assertions. |
| Bounded prompts with whole local overflow             | `history.test.ts`: both roles share organization; long findings, consumed responses and completion feedback retain whole local overflow. `history-runner.test.ts`: refreshed guidance replaces stale intake while keeping the validated baseline requirement.                                                         |

`delivery.test.ts` retains the real revision regression: a recorded branch must
exist and match the passed revision; uncommitted work is refused, while another
checkout branch at the same revision is accepted. Git preservation and source
refresh remain in `workspace-branch.test.ts`, `workspace.test.ts` and `refresh.test.ts`.

## Review repair: context and CLI teardown

Vitest's `aroundEach` enters an `AsyncLocalStorage` scope before setup, body or
teardown starts. This replaces first-fixture-call binding: unregistered setup
making its first fixture call after a subsequent test begins retains its closed
original scope. Temporary allocation registers pending work before its first
await; `createLocalTarget` owns its entire asynchronous setup. Nested lifecycle
registrations reuse the outer scope.

The nested proof resumes a registered continuation after disposal returned,
and separately resumes an unregistered setup continuation during the next test.
It asserts that command, operation, directory and CLI starts are refused while
the new test can still start work. Unconfirmed-process and never-settling-work
directories survive subsequent successful cleanup. A settled late operation
releases its hold and its directory is then removed.

The real built-CLI suite uses the bounded lifecycle after each test and retains
its beacon assertions. POSIX launches lead their own process group; cleanup
first gives the real interrupt handler a bounded chance to stop separately
grouped runtime/checks, then retains the tree-stop fallback. Nested timeout and
setup-failure cases both reach a holding runtime and assert that the CLI PID,
runtime PID/token and runtime child PID/token ended before the target disappears.
These cases execute on Windows and Linux. No production process or baseline
lifecycle behavior changes in this repair.

## Review repair: pending entry points and late allocations

The review of `d44573b` identified two remaining ownership gaps. All direct
command/check-round calls in `checks.test.ts` and `lifecycle.test.ts` now use
`tests/fixtures/operations.ts`. The local-loop suite and shared runner fixture
use its `runTask` wrapper. These wrappers register the promise before production
code starts, combine the fixture stop with caller cancellation, and wait through
the existing bounded disposal. Local-loop and lifecycle Git helpers also use
the shared owned `runProcess`. Product behavior and HARN-46 baseline logic are
unchanged; no existing assertions, skips, deadlines or check commands changed.

The directory registry now stores the allocating scope alongside each path.
An allocation that finishes after disposal is registered to that original scope
and refused before returning to closed setup. Pending work in that scope keeps
the directory across later cleanups, even when it did not exist in disposal's
initial path snapshot. Settlement releases the hold; no broader removal retry
or process-killing rule was added.

| Guarantee                                                  | Active regression and observable assertions                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout during a real pending command, check round or task | `fixture-lifecycle.test.ts` invokes `fixtures/lifecycle/nested/operations.test.ts` through actual Vitest deadlines, using the same owned entry points as the affected suites. All three reach a real hanging child tree; each directory still exists when the production promise settles; afterwards both process generations and the directory are gone. |
| Allocation finishes beyond bounded disposal                | `fixture-allocation.test.ts` controls allocation and the cleanup clock. The closed setup receives a refusal, the late directory survives two newer scope disposals while its original setup remains pending, and is removed only after setup settles.                                                                                                     |
| Late allocation across actual later tests                  | The nested `allocation.test.ts` releases allocation from the next Vitest test, after timeout and disposal have returned. A following test observes the old directory preserved and the newer directory removed, then settles the old setup; the last test and parent proof observe removal.                                                               |

No coverage was deleted. The allocation regression adds one active outer test;
three real-operation timeouts and the four-step allocation proof extend the
existing nested lifecycle proof and are not counted as ordinary gate skips or
passing cases. At that point the suite had 50 files and 1,331 active Windows cases, with the
two pre-existing platform skips. Earlier successful measurements at `5ec1316`
predate these fixes and are replaced below by final-code measurements.

## Repair after the in-process CLI review finding

The review at `b7a53b9` correctly identified three remaining unowned entry points:
`fixtures/cli.ts`, `source-cli.integration.test.ts`, and
`reviews-cli.integration.test.ts`. They now use the same owned `runCli` wrapper
in `fixtures/operations.ts`. It registers before dispatch, connects fixture
cancellation to the production interrupt interface, handles a listener installed
after disposal starts, and releases listeners on both return and rejection.
The default still uses production `hostSignals`; the original real host-listener
and explicitly supplied signal assertions remain active.

CLI and source setup Git/Node commands now use the shared process runner. Review
command workspace setup also uses that runner instead of synchronous Git calls.
The complete asynchronous setup operations and review environment restoration
are registered, so disposal awaits their continuations as well as commands.
The review suite now installs `useFixtureLifecycle` instead of removing
directories directly. The waiting agent needs no 15-second emergency timer:
the test's disposal reaches its existing abort listener.

| Guarantee                                                                         | Active owner and observable evidence                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending real in-process CLI at a Vitest timeout or setup failure                  | `fixture-lifecycle.test.ts` runs `nested/in-process-cli.test.ts` through actual Vitest failure/timeout hooks. The actual `fixtures/cli.ts` helper runs a real check tree, returns exit 130 while its directory still exists, and releases its supplied signal handler; afterwards both process generations and the directory are gone.    |
| CLI fixture Git still pending when setup fails                                    | The same nested proof starts real Git with a fixture alias that holds a child tree. Setup throws before awaiting Git. The shared helper rejects on disposal while its directory exists; the parent proof observes the entire recorded tree and directory gone.                                                                            |
| Disposal before CLI interrupt registration; rejection; late calls in a newer test | `fixture-cli.test.ts` controls dispatch through the actual fixture helper. An invocation paused before registering observes the already-aborted stop; directory removal waits for settlement. A throwing dispatch releases actual host handlers. A continuation from a disposed scope cannot dispatch or register work in the next scope. |
| Source CLI watch teardown                                                         | `source-cli.integration.test.ts` disposes an actual pending source watch without the test sending its planned interrupt; it settles with exit 130 before removal and releases its handler. The original poll/interrupt assertions remain.                                                                                                 |
| Review CLI teardown and environment restoration                                   | `reviews-cli.integration.test.ts` disposes while the real reviewer adapter and its child are holding. It observes both processes gone, the stopped-review diagnostic with no verdict, restoration of six environment variables, and settlement before removal.                                                                            |

No existing assertion or case was removed. Five new ordinary cases plus three
nested failure-path cases extend the proof. Production behavior, test deadlines,
worker settings and validation commands are unchanged. Earlier measurements at
`f7b37b7` predate this repair and must not be used as final-code evidence.

## Review repair: standalone boundary ownership

The review of `6f1b3a8` found direct delivery, adapter and Git calls outside the
registered task/command/CLI helpers. `tests/fixtures/boundary-operations.ts` now
registers those entry points before calling production, combines fixture and
caller cancellation, and awaits adapter log closure. Delivery and Git's scoped
environment helper includes restoration in its owned promise. Their async setup
builders are also owned, as are Git-suite preflight/preparation/comparison calls.
The Windows unconfirmed-stop case still removes `taskkill` from its own `PATH`
and retains the beacon-based cleanup; restoration now covers the whole operation.
No production behavior, deadline, existing assertion or quarantine status changed.

| Guarantee                                  | Active owner and observable proof                                                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone delivery cancellation           | Nested `boundaries.test.ts`: timeout and setup failure after real local revision checks/push reach a hanging fake `gh`; delivery rejects as stopped, environment is restored before directory removal, parent and child PIDs/beacons are gone. |
| Standalone Git cancellation                | The same nested file: timeout and setup failure while production `runGit` is pending, without a post-result process registration; result is stopped and both processes/beacons are gone.                                                       |
| Standalone adapter cancellation            | The same nested file: both `runCodexPrompt` and `runCodexTurn` are pending at timeout and setup failure; shutdown is confirmed, log closure precedes removal, runtime and child PIDs/beacons are gone.                                         |
| Caller cancellation and delayed settlement | `fixture-boundary.test.ts`: four callers keep their supplied stop; two controlled log-flush barriers keep directories/environment until closure settles.                                                                                       |
| Late boundary/environment entry            | `fixture-boundary.test.ts`: calls resume in a disposed scope while a new scope is active; all four entries and environment mutation are refused, no production call starts and the new scope owns no work.                                     |

These are seven new top-level regression cases and eight nested failing cases
verified by the existing lifecycle case, not eight omitted tests. The original
delivery, adapter credential/process, Git preservation and HARN-41 assertions
remain active. Existing late-allocation, repeated preservation, CLI teardown and
POSIX process-group proofs remain unchanged. Final measurements below replace
the previous implementation's evidence.

### Remaining workspace and review ownership (2026-09-22)

The review of `9fd8f50` correctly identified still-unowned production calls in
workspace and review helpers. This repair keeps their existing substantive
assertions and routes those calls through the same fixture lifecycle; it changes
no product behavior or HARN-46 baseline orchestration. The production baseline
reviewer itself is owned, including its internally imported adapter, view checks,
log closure and persisted outcome. `prepareRun` owns preflight through allocation
and preparation, and refuses allocation after preflight returns to a stopped scope.
Standalone diagnosis/source entry points own persistence and publication after the
reviewer returns; a controlled publication barrier in `fixture-workspace.test.ts`
proves teardown waits for that enclosing operation too.

| Guarantee                                                         | Active owner and evidence                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pending helper settlement precedes directory removal              | `fixture-workspace.test.ts`: controlled barriers through actual `accepted`, `expectRejected`, `prepareRun`, branch inspection/recovery, reopening, view preparation/verification, and `reviewerFor`; each receives teardown cancellation while an unrelated caller signal stays unchanged.                                                                               |
| Preflight/allocation continuations cannot start later preparation | Same file: preflight returning success after disposal starts cannot allocate; an allocation already pending must settle before removal and cannot invoke preparation.                                                                                                                                                                                                    |
| Late entry belongs to the old test                                | Same file: all nine helpers are refused after disposal while another scope is active; no production call or allocation starts and the newer test owns no work.                                                                                                                                                                                                           |
| Real pending workspace/review work at timeout and setup failure   | `fixtures/lifecycle/nested/workspace.test.ts`, asserted by `fixture-lifecycle.test.ts`: eight deliberately failing cases through actual `prepareRun`, `prepareReviewView`, `reviewerFor`, and baseline `source run`; parent and child PIDs plus both beacons must be gone, environment restored, directories present at settlement and removed afterward.                |
| Baseline CLI environment and internal reviewer lifetime           | `baseline-queue.integration.test.ts` uses the owned CLI entry and owns the environment restoration around both claims. The nested baseline CLI cases stop a real pending reviewer and assert the existing failure exit, the stopped-diagnosis comment and In Review status, plus tree termination.                                                                       |
| Async setup and other callers of the same boundaries              | Workspace repository/environment/preparation, baseline evidence/retained-workspace and review-view setup register their whole promises. Source, queue and report suites now dispose owned work before their old cleanup/restoration hooks; report Git commands use the shared process runner. Other runner/agent/source collaborators use the same owned boundary calls. |

Thirteen top-level cases and eight nested failure cases are added; no existing test,
assertion, deadline, quarantine or skip is removed. Existing assertion-failure,
caller-cancellation, repeated directory preservation, credential-isolation and
POSIX process-group proofs remain active. The four new timeout cases start their
real pending operations in `beforeEach`, then hit a 100 ms body deadline; the
JSON reporter must identify each exact timeout and each exact setup failure.
This avoids four unnecessary five-second waits without removing any process,
beacon, settlement or directory assertion. The new view cancellation assertion
keeps its actual production diagnostic (failed clone); independent process and
beacon assertions prove termination instead of inferring it from that text.

## Performance

Final-code measurements replace this recovery's interrupted and historical
measurements. The reference remains `f44a859`: Windows, four workers in one pool,
1,301 passing and two pre-existing skips, **192.50 seconds test-phase wall time**
(one successful observation). Previous-attempt measurements do not describe
this implementation. The budget remains test phase <= 212 s, policy < 15 s and
no suite > 110 s. No deadline is widened to meet it.

Reproduce on Windows with
`powershell -NoProfile -File performance/measure-windows.ps1`. This runs two
complete validations sequentially, adding verbose and JSON reporters to the
unchanged `npm run validate` command. `-Mode four-workers` runs the single-pool
comparison separately. Each run saves its own raw case timings, wall time,
settings, process identities and fixture-directory differences. Raw JSON uses a
`.txt` suffix to preserve the reporter output without reformatting machine data.
Verbose transcripts are transcoded from PowerShell UTF-16 to UTF-8 for review;
their text and timing values are unchanged.

### Final Windows measurements

Implementation commit: `9375c4ed5d8b19b8b24ca29789371b83d141de25`. Only captured output and documentation changed
after this implementation. These measurements replace the earlier `3477328` runs
before the timeout-proof refinement; those successful observations are preserved
separately below. Evidence at `9fd8f50` predates this repair.

Same reference Windows host: 24 logical CPUs, Windows 10.0.26200, Node `v24.14.1`,
npm `11.11.0`, Vitest `5.0.0`, Git `2.53.0.windows.2`. Dependencies were installed
with `npm ci --cache .harness/npm-cache`. Runs were sequential with no other Nexus
queue or test workload observed. The waiting task supervisor and desktop processes
remain in the inventories. Reporter overhead, scheduling caches and host variation
were not controlled away. Focused tests preceded the first run.

| Run                 | Command and workers                          | Test-phase wall | Total command wall     | Passing / skipped | Files |
| ------------------- | -------------------------------------------- | --------------- | ---------------------- | ----------------- | ----- |
| Reference `f44a859` | Full suite, one pool / 4                     | 192.50 s        | Not recorded here      | 1,301 / 2         | 34    |
| Final 1             | `npm run validate`, policy 8 then boundary 4 | 207.07 s        | 218.876 s              | 1,356 / 2         | 53    |
| Final 2             | `npm run validate`, policy 8 then boundary 4 | 209.83 s        | 221.634 s              | 1,356 / 2         | 53    |
| Comparable          | `npm run test:four-workers`, one pool / 4    | 207.83 s        | 208.427 s (tests only) | 1,356 / 2         | 53    |

All commands exited 0. The complete validation includes formatting, lint, typecheck,
build and both test layers. Detailed reporters were supplied as
`npm run validate -- -- --reporter=verbose --reporter=json --outputFile.json=performance/harn-48-validation-N-timings.txt`;
the comparison used `npm run test:four-workers -- --reporter=verbose --reporter=json --outputFile.json=performance/harn-48-four-workers-timings.txt`.
The comparison is tests only, not another complete validation. Vitest's `Duration`
is the test-phase wall; the script records total command wall separately.

| Comparison against 192.50 s          | Absolute change | Percentage change |
| ------------------------------------ | --------------- | ----------------- |
| Final 1 (different layer scheduling) | +14.57 s        | +7.57%            |
| Final 2 (different layer scheduling) | +17.33 s        | +9.00%            |
| Comparable (matching single pool)    | +15.33 s        | +7.96%            |

All three final samples were slower than the reference. Only the last row matches
its pool shape. Normal validation observed
**207.07–209.83 s**; the comparable sample was **207.83 s**.
These samples against one historical success do not establish a robust speedup or
latency distribution. No unexpected test failure or timeout was observed. The active
count is 55 higher than the reference, including this repair's 13 cases. Eight new
nested failures are asserted by the existing lifecycle case, including their exact
failure reasons; they are not skipped regressions. The ownership map explains
coverage equivalence, not the count. The quarantine gate is never the baseline.

### Per-run timing detail

Suite spans are JSON reporter `endTime - startTime`, including hooks. Case times
are assertion `duration`. Layer spans run from the first suite start to the last
suite end; they do not replace Vitest's printed test-phase wall.

| Run     | Policy span        | Boundary span        |
| ------- | ------------------ | -------------------- |
| Final 1 | 3.689 s (20 files) | 202.872 s (33 files) |
| Final 2 | 3.654 s (20 files) | 205.694 s (33 files) |

Six slowest suites per run:

| Run        | Suite                            | Duration |
| ---------- | -------------------------------- | -------- |
| Final 1    | `completion-github.test.ts`      | 87.772 s |
| Final 1    | `fixture-lifecycle.test.ts`      | 82.682 s |
| Final 1    | `source-cli.integration.test.ts` | 65.799 s |
| Final 1    | `runner.test.ts`                 | 53.396 s |
| Final 1    | `completion-arm.test.ts`         | 50.142 s |
| Final 1    | `workspace.test.ts`              | 45.002 s |
| Final 2    | `completion-github.test.ts`      | 90.662 s |
| Final 2    | `fixture-lifecycle.test.ts`      | 83.501 s |
| Final 2    | `source-cli.integration.test.ts` | 69.322 s |
| Final 2    | `runner.test.ts`                 | 54.729 s |
| Final 2    | `completion-arm.test.ts`         | 52.510 s |
| Final 2    | `workspace-branch.test.ts`       | 44.904 s |
| Comparable | `completion-github.test.ts`      | 88.903 s |
| Comparable | `fixture-lifecycle.test.ts`      | 83.817 s |
| Comparable | `source-cli.integration.test.ts` | 69.243 s |
| Comparable | `runner.test.ts`                 | 53.106 s |
| Comparable | `completion-arm.test.ts`         | 52.549 s |
| Comparable | `workspace.test.ts`              | 45.589 s |

Six slowest cases per run:

| Run        | Suite: case                                                                                                                                | Duration |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Final 1    | `fixture-lifecycle.test.ts`: the fixture lifecycle cleans up after the cases that must fail, time out or cancel                            | 81.387 s |
| Final 1    | `live-verifier.test.ts`: the entry point, as a process runs both exercises through the configured selection, against the fixture           | 11.476 s |
| Final 1    | `checks.test.ts`: a command that runs out of time reports a stop it could not confirm, and calls the copy unsafe to reuse                  | 11.028 s |
| Final 1    | `git.test.ts`: a Git command under a bound reports a stop it could not confirm, which is what makes a copy unsafe to reuse                 | 8.397 s  |
| Final 1    | `source-cli.integration.test.ts`: the source commands through the CLI watch picks up an issue made eligible later, then stops on interrupt | 6.970 s  |
| Final 1    | `lifecycle.test.ts`: a run its caller stops, for real reports a stop it could not confirm, and never calls the copy safe to reuse          | 6.460 s  |
| Final 2    | `fixture-lifecycle.test.ts`: the fixture lifecycle cleans up after the cases that must fail, time out or cancel                            | 82.243 s |
| Final 2    | `live-verifier.test.ts`: the entry point, as a process runs both exercises through the configured selection, against the fixture           | 11.654 s |
| Final 2    | `checks.test.ts`: a command that runs out of time reports a stop it could not confirm, and calls the copy unsafe to reuse                  | 11.106 s |
| Final 2    | `git.test.ts`: a Git command under a bound reports a stop it could not confirm, which is what makes a copy unsafe to reuse                 | 8.417 s  |
| Final 2    | `lifecycle.test.ts`: a run its caller stops, for real reports a stop it could not confirm, and never calls the copy safe to reuse          | 6.970 s  |
| Final 2    | `source-cli.integration.test.ts`: the source commands through the CLI watch picks up an issue made eligible later, then stops on interrupt | 6.836 s  |
| Comparable | `fixture-lifecycle.test.ts`: the fixture lifecycle cleans up after the cases that must fail, time out or cancel                            | 82.349 s |
| Comparable | `live-verifier.test.ts`: the entry point, as a process runs both exercises through the configured selection, against the fixture           | 12.042 s |
| Comparable | `checks.test.ts`: a command that runs out of time reports a stop it could not confirm, and calls the copy unsafe to reuse                  | 11.022 s |
| Comparable | `git.test.ts`: a Git command under a bound reports a stop it could not confirm, which is what makes a copy unsafe to reuse                 | 8.417 s  |
| Comparable | `source-cli.integration.test.ts`: the source commands through the CLI watch picks up an issue made eligible later, then stops on interrupt | 7.077 s  |
| Comparable | `lifecycle.test.ts`: a run its caller stops, for real reports a stop it could not confirm, and never calls the copy safe to reuse          | 6.451 s  |

The lifecycle case deliberately runs timeout, assertion/setup failure, late
continuation/allocation and unconfirmed-stop cases in a nested Vitest process,
then checks settlement, environment restoration, directories, PIDs and beacons.
The four new timeout bodies now wait only 100 ms for Vitest to cancel work whose
parent and child were already observed in setup. The checks/Git/lifecycle stop
cases spend real stop grace periods. Source watch exercises polling/interruption;
live-verifier runs both configured offline exercises. Remaining boundary cost is
real Git/process execution.

**Budget is unchanged:** test-phase wall at most 212 s, policy span below 15 s,
and no suite above 110 s. Measured wall outcomes:

| Run        | Wall budget outcome  |
| ---------- | -------------------- |
| Final 1    | 4.93 s below ceiling |
| Final 2    | 2.17 s below ceiling |
| Comparable | 4.17 s below ceiling |

The largest policy span was 3.689 s; the slowest suite across all
final runs was 90.662 s. Any overrun is reported, not hidden by excluding cases,
changing workers or increasing deadlines. This diagnostic budget is not evidence
of a stable performance distribution.

### Raw evidence and cleanup

| Run        | Metadata / command wall                             | Verbose output                                           | Every suite/case (raw JSON)                                | Cleanup inventory                                                                |
| ---------- | --------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Final 1    | [metadata](../performance/harn-48-validation-1.txt) | [output](../performance/harn-48-validation-1-detail.txt) | [timings](../performance/harn-48-validation-1-timings.txt) | [processes/directories](../performance/harn-48-fixture-cleanup-1.txt)            |
| Final 2    | [metadata](../performance/harn-48-validation-2.txt) | [output](../performance/harn-48-validation-2-detail.txt) | [timings](../performance/harn-48-validation-2-timings.txt) | [processes/directories](../performance/harn-48-fixture-cleanup-2.txt)            |
| Comparable | [metadata](../performance/harn-48-four-workers.txt) | [output](../performance/harn-48-four-workers-detail.txt) | [timings](../performance/harn-48-four-workers-timings.txt) | [processes/directories](../performance/harn-48-fixture-cleanup-four-workers.txt) |

Each final run started and ended with **1,873 pre-existing fixture directories**,
**zero new directories** and **zero new Node/Git/cmd/taskkill process identities**.
Identity includes PID and creation time, so PID reuse cannot conceal a new process.
Inventories include generic child command lines; tests separately verify owned
parent/child termination through their own beacons. The audit kills nothing.

### Earlier measurements in this repair

At `3477328`, all three commands passed with clean inventories, but the four new
timeout probes spent unnecessary five-second waits. Moving startup into setup and
requiring the exact Vitest failure preserved every cleanup assertion. These
observations are retained, not counted as final-code evidence:

| Earlier run  | Test phase | Total command | Change from 192.50 s |
| ------------ | ---------- | ------------- | -------------------- |
| validation-1 | 256.52 s   | 268.617 s     | +64.02 s (+33.26%)   |
| validation-2 | 214.53 s   | 226.403 s     | +22.03 s (+11.44%)   |
| four-workers | 253.10 s   | 253.610 s     | +60.60 s (+31.48%)   |

All metadata, verbose transcripts, per-case JSON and cleanup inventories for those
runs are in [initial-restored-ownership](../performance/initial-restored-ownership/).
In the first earlier run, the lifecycle suite started 162.251 s after the first
suite and took 93.893 s. This describes the schedule without assigning a cause to
host or cache variation. The refinement's [focused proof](../performance/harn-48-timeout-refinement-focused.txt)
passed in 76.81 s test-phase wall (75.468 s for the nested proof).

Earlier focused checks exposed incorrect expectations in the new proof about
review-view cancellation text and the baseline CLI exit. They were corrected to
preserve existing behavior and augmented with stopped-diagnosis comment/status
assertions. Both attempts remain in [first output](../performance/harn-48-restored-ownership-focused.txt)
and [second output](../performance/harn-48-restored-ownership-final-focused.txt).
The corrected [lifecycle/workspace proof](../performance/harn-48-restored-lifecycle-focused.txt)
and [enclosing diagnosis/source check](../performance/harn-48-enclosing-operations-focused.txt)
passed. Final complete validations above cover the last implementation.

The older `6ac85ff` recovery (235.85 s test phase, 255.815 s total) left two
directories and no new processes. Its [metadata](../performance/harn-48-pre-final.txt),
[output](../performance/harn-48-pre-final-detail.txt), [timings](../performance/harn-48-pre-final-timings.txt)
and [cleanup report](../performance/harn-48-pre-final-cleanup.txt) remain historical.
Those two directories remain among the 1,873 pre-existing directories. This repair
does not remove historical fixtures or count that leaking run as clean evidence.

### Linux verification

On implementation commit `9375c4e`, `bash performance/validate-linux.sh`
passed normal `npm run validate` with verbose reporting: **53 files, 1,348 passed,
10 skipped**, **120.43 s test phase**, **144.96 s total validation**.
Local WSL2 Linux `6.18.33.2-microsoft-standard-WSL2`, Node `v24.14.1`, npm `11.11.0`,
Vitest `5.0.0`, Git `2.43.0`, reading this checkout through `/mnt/e`. This is
separate platform evidence, not a Windows timing comparison or hosted CI result.

WSL drive automount is disabled. `E:` was mounted temporarily with
`uid=1000,gid=1000`; `npm ci --cache .harness/npm-cache` and the validation script
ran as the existing `aiur` user. No persistent WSL configuration changed. Windows
dependencies were restored with `npm ci --cache .harness/npm-cache` afterward.
Snapshots were captured in the same Linux invocation before WSL could stop. No
fixture directory or Node/Git process remained. Existing platform skips differ
from Windows; all new workspace/view/baseline timeout and setup-failure proofs
ran, including POSIX process-group cancellation and the exact failure assertions.

Raw evidence: [validation and wall time](../performance/harn-48-linux-validation.txt),
[processes before](../performance/harn-48-linux-processes-before.txt),
[processes after](../performance/harn-48-linux-processes-after.txt),
[directories before](../performance/harn-48-linux-directories-before.txt), and
[directories after](../performance/harn-48-linux-directories-after.txt). Empty
directory files are actual zero-row inventories. Hosted `ubuntu-latest` CI has
not been observed from this coding turn and remains an independent merge gate.

## HARN-49: the gate as cached tasks

HARN-49 kept this map's behaviour and changed how the gate runs it. `npm run validate` is now one
Turborepo task per check: `format:check`, `lint`, `typecheck`, `build`, the **policy** layer split
into five cache-eligible groups, and `test:boundary` — uncached, so the process-heavy layer still
executes on every validation, after the fast layer. `npm run test:policy`, `npm run test:boundary`,
`npm test` and `npm run test:four-workers` are unchanged and execute directly. The task boundaries,
the declared inputs, the tooling decision and the operating commands are in
[validation-caching.md](../docs/validation-caching.md).

The five groups partition this map's policy list exactly once — `display` (activity), `config`
(configuration, completion configuration and gate, dependency boundaries, connect guide), `loop`
(run-loop policy, stop, support, completion policy), `intake` (queue, queue recovery, Jira,
baseline findings) and `history` (history, history runner/source, reviews). No case was deleted and
no deadline changed; the boundary layer's concurrency policy is what it was: the cap and the group
order still describe this suite. What is new is that a change to one group's files no longer
invalidates the other four.

### The repair: two files moved to the layer that always runs

The first delivery cached two policy files that made real Git repositories: `report.test.ts` (the
workspace preparation failure, over a real `git init`/`commit`/`rev-parse`) and
`completion-cli.test.ts` (its own target repository, over real `git`). No declaration here can
bound the Git executable, its version or the inherited Git configuration those cases observe, so an
unchanged rerun could have replayed them while the host changed underneath. They are now files of
the **boundary** layer: `vitest.config.ts` no longer lists them in `policyFiles`, and the boundary
project picks them up wholesale, which is why the layer's file count grew by the same two files.
Both files keep every case they had, with their own bounds; nothing moved between files and nothing
was skipped. `tests/validation-cache.test.ts` now reads the syntax of every cached group's own
files and fails if one imports `node:child_process` or calls a process runner, and it checks that
every test file in the repository belongs to exactly one layer.

Two other input gaps the review found are closed in the same place: `build` declares
`scripts/build.mjs`, which it executes, and the configuration group declares the files its cases
read without importing them — `docs/**` (the connect guide and the links it resolves), `examples/**`
and `nexus.project.json` (the checked-in inputs `config.test.ts` composes), `.gitignore`,
`.prettierignore`, `scripts/**`, `tsconfig*.json` and `turbo.json` (what the contract test reads
back). The contract test follows the reads it can see — `path.join(repoRoot, …)` written in
literals, and read helpers given a literal path — and names the two it cannot by hand.

The build stopped keeping incremental state for its emit. A state that describes a `dist/` the
task cache restored, an operator removed or a partial deletion damaged lets TypeScript report an
incomplete output as up to date, exit 0, and the cached outputs carry no state to restore beside
the JavaScript. `tsconfig.build.json` now compiles without it, `scripts/build.mjs` empties `dist/`
first and verifies the artefact `npm start` runs, and the check-only program keeps its incremental
state, which is the one whose second run is worth it. `tests/build-guard.test.ts` compiles real
throwaway projects through that script: a module removed from a complete `dist/` comes back, a
module whose source is gone does not survive, a behaviour change and its revision come back in
turn, and a project that emits nothing is a failed build.

The runtime the tasks execute on is a declared input now: `scripts/turbo.mjs` observes `node` and
`npm` through the same PATH resolution a task gets, passes `NEXUS_VALIDATE_NODE` and
`NEXUS_VALIDATE_NPM`, and `turbo.json` declares both in `globalEnv`. `.nvmrc` and `packageManager`
remain the declared runtime and are hashed as files, but they are not enforced, so on their own
they let a checkout on another Node reuse this one's results.

### Counts

| Revision                                                  | Files | Tests | Passed | Skipped |
| --------------------------------------------------------- | ----- | ----- | ------ | ------- |
| HARN-48 final (53 files)                                  | 53    | 1,358 | 1,356  | 2       |
| HARN-49 first delivery (55 files): policy 21, boundary 34 | 55    | 1,373 | 1,371  | 2       |
| HARN-49 repair (56 files): policy 19, boundary 37         | 56    | 1,383 | 1,381  | 2       |

The repair moved two files and added ten cases; no case was removed, skipped or given a different
deadline, which is why the total only grows:

- `tests/validation-cache.test.ts` (policy, 9 cases now) reads back the declarations this map
  depends on: the gate's task list, that exactly one of those tasks is ineligible and it is the
  boundary layer, that every cache-eligible group declares the files its tests import _and_ the
  ones they read through the filesystem, that a cached group contains no case that starts a real
  process, that every test file belongs to exactly one layer, that the groups cover the policy list
  exactly once, that the declared runtime is the executing one, that the caches live in an ignored
  directory the checks themselves ignore, that the build regenerates its output rather than
  resuming it, and that no credential-shaped name is a cache input. Two of those cases are new.
- `tests/validation-cache-turbo.test.ts` (boundary, 11 cases now) runs the installed Turborepo
  through `scripts/turbo.mjs` against a throwaway single-package fixture: a hit replays without
  executing the task, a declared input invalidates while an undeclared file does not, a removed
  output is restored, a failed or interrupted task is never replayed as a success, a damaged cache
  artefact cannot become one, the summary distinguishes reuse from execution, a `--` passthrough
  that Turborepo would append to every task is refused, the manifest and the lockfile are inputs,
  the runtime the wrapper observed is the one the task sees and another runtime cannot reuse the
  earlier result, and a PATH that resolves no `node` stops the gate instead of producing one. Three
  of those cases are new.
- `tests/build-guard.test.ts` (boundary, 5 cases) is the new file: it compiles real throwaway
  projects through `scripts/build.mjs` and checks the regeneration, the absence of incremental
  state, the behaviour-change repair cycle, the missing-artefact failure and the failed-compile
  failure.

The two pre-existing skips are unchanged; they are not hidden regressions.

### Measurements

Recorded on the same Windows host as this map's earlier numbers (24 logical CPUs, Node `v24.14.1`,
npm `11.11.0`, Vitest `5.0.0`, Turborepo `2.11.2`), with
`powershell -NoProfile -File performance/measure-windows.ps1`, which runs the gate once with the
cache cleared and once unchanged, and copies its transcripts into `performance/` only after both
runs (a file added part-way through would change the formatting task's default file set).

| Run    | Command                  | Turbo summary                           | Command wall | Layer detail                                                            |
| ------ | ------------------------ | --------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| Fresh  | `npm run validate:fresh` | 10 successful, 0 cached, 3 m 18.9 s     | 199.77 s     | policy 8.9 s over five groups; boundary 176.05 s over 34 files          |
| Cached | `npm run validate`       | 10 successful, **9 cached**, 2 m 51.8 s | 172.13 s     | every eligible task replayed; `test:boundary` executed fresh (171.28 s) |

Raw evidence: [fresh metadata](../performance/harn-49-validation-fresh.txt),
[fresh transcript](../performance/harn-49-validation-fresh-detail.txt),
[cached metadata](../performance/harn-49-validation-cached.txt),
[cached transcript](../performance/harn-49-validation-cached-detail.txt),
[cleanup inventories](../performance/harn-49-validation-cached-cleanup.txt): both runs started and
ended with no new fixture directory and no new Node/Git/cmd/taskkill process identity.

The budget in this map is unchanged and still unmet by nothing: the policy phase is 8.9 s over its
five processes (below 15 s; HARN-48 recorded 3.7 s for one process, so splitting the layer costs
startup), the slowest suite remains under 110 s, and the fresh test phase — 8.9 s + 176.1 s — is
below 212 s. The cached run is faster only by what it replays, and the boundary layer, which is the
majority of it, is not eligible. These two samples are not a controlled comparison with HARN-48's
207–210 s test phase: they were taken at different times on a busy desktop host, and no claim is
made that the gate got faster beyond the reuse itself.

The delivered revision was validated with `npm run validate:fresh`: 10 tasks, 0 cached, exit 0,
1,371 passed and 2 skipped in 273.6 s wall (policy 602 in 9.4 s over five groups; boundary 769 + 2
skips over 34 files in 248.9 s). Its transcript is
[harn-49-final-validation.txt](../performance/harn-49-final-validation.txt). The boundary layer
measured 171.3 s, 176.1 s and 248.9 s for the same files on the same host across these sessions:
that spread is exactly why the layer is never replayed, and no number here is offered as a stable
distribution. Only this paragraph and that record changed after the validated revision.

The single-pool `test:four-workers` comparison was not re-measured for HARN-49: it is a measurement
command, not part of the gate, and this ticket's claims rest on the two runs above.

Linux is a separate check, not a comparison: `bash performance/validate-linux.sh` ran
`npm run validate:fresh` on WSL2 (this checkout read through `/mnt/e`) and passed — 10 tasks, 34
boundary files, 1,363 passed, 10 platform skips, 157 s, no new fixture directory and no remaining
Node or Git process. Its log is [harn-49-linux-validation.txt](../performance/harn-49-linux-validation.txt);
hosted `ubuntu-latest` CI remains the merge gate. No Linux number here is compared with a Windows
one.

## Remaining limits

GitHub-hosted Linux CI remains a delivery gate; local WSL validation cannot
establish its result. Live provider exercises remain opt-in and have not run.
Real Git and command suites retain independent fixtures and pay actual process
startup costs. Held directories are released only after owners are confirmed
gone; unresolved owners require inspection, not deletion.
