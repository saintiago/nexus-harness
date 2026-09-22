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
(`vitest.config.ts`), not one pool of 49 files:

- **policy** — configuration, parsing, the terminal model, reporting, the queue
  decisions, the history store, the review verdict/scan/watch decisions, the
  baseline finding text, and the run loop's repair and deadline decisions:
  ordinary functions and in-memory collaborators, no child process of their own.
  It may run wide (`maxWorkers: 8`) and finishes in seconds.
- **boundary** — real Git, real command shells, real children, the built CLI and
  the stand-in runtime. Every worker can start further Git and Node processes, so
  this layer is capped (`maxWorkers: 4`), and it runs after the fast layer rather
  than beside it (`sequence.groupOrder`).

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

## Performance

**Before.** The reference is one successful audit run at commit `f44a859`:
1,301 passing, two pre-existing skips, 192.50 s test-phase wall time with four
workers in one pool over 34 files. It is a single four-worker observation, not a
statistical average, and the containment measurement (57.52 s with 571 skips) is
not a comparison point.

**After.** The measurements below are from this host — Windows, 24 logical CPUs,
node `v24.14.1`, npm `11.11.0`, vitest `5.0.0` — on the final tree. Runs 1 and 2
are the two sequential complete validations the ticket asks for, with nothing in
between them; run 3 is the comparable four-worker measurement, run 4 is the same
test command with the JSON reporter, and run 5 is the last validation of the
same tree, taken after the measurements and before the commits that carry only
this document and the raw output.

The host also runs the queue that started this turn (one `node dist/cli.js queue
run` process) and a normal Windows desktop set; that was true of every run here
and of the reference, but the load it produces is not constant, and the spread
below is that host's, not the suite's.

| Run | Command                          |    Test phase | Total validation | Outcome | Active / skipped | Files |
| --- | -------------------------------- | ------------: | ---------------: | ------- | ---------------- | ----: |
| 1   | `npm run validate`               |      200.99 s |         213.16 s | pass    | 1,330 / 2        |    49 |
| 2   | `npm run validate`               |      167.00 s |         178.58 s | pass    | 1,330 / 2        |    49 |
| 3   | `npm run test:four-workers`      |      164.31 s |         164.90 s | pass    | 1,330 / 2        |    49 |
| 4   | `npx vitest run --reporter=json` | 212.68 s span |         213.85 s | pass    | 1,330 / 2        |    49 |
| 5   | `npm run validate` (final)       |      169.35 s |         181.14 s | pass    | 1,330 / 2        |    49 |

Raw output: [validation 1](../performance/harn-48-validation-1.txt),
[validation 2](../performance/harn-48-validation-2.txt),
[the comparable four-worker run](../performance/harn-48-four-workers.txt),
[the JSON detail run](../performance/harn-48-after-timings-per-test.json) and
[the final check](../performance/harn-48-final-check.txt). Runs 1, 2, 3 and 5
are the complete output of each command; run 4's per-suite and per-case
durations are in [the timing detail](../performance/harn-48-after-timings-per-test.txt).

### The comparison against 192.50 s

| Measurement                                   | Test phase | vs `f44a859`       |
| --------------------------------------------- | ---------: | ------------------ |
| `f44a859` reference, four workers, one pool   |   192.50 s | —                  |
| Run 1, two layers (policy 8, then boundary 4) |   200.99 s | +8.49 s (+4.4 %)   |
| Run 2, two layers (policy 8, then boundary 4) |   167.00 s | −25.50 s (−13.2 %) |
| Run 3, four workers, one pool (comparable)    |   164.31 s | −28.19 s (−14.6 %) |
| Run 4, two layers, JSON reporter              |   212.68 s | +20.18 s (+10.5 %) |
| Run 5, final check, two layers                |   169.35 s | −23.15 s (−12.0 %) |

The comparable four-worker measurement is run 3: the layer policy differs from
the reference's single pool, so a like-for-like number had to be taken
deliberately, with `npm run test:four-workers`. It is the cleanest comparison
there is: same pool shape, same worker count, same cases, 28.19 s faster than the
reference. The two-layer runs are usually faster still (run 2), but run 1 and the
detail run show the other end of the host's range — on a load spike the suite is
_slower_ than the reference, by up to 10 %, and that is reported here rather than
smoothed away.

Where the after time goes, from the detail run:

| Layer (span from first start to last end) | Files |     Span |
| ----------------------------------------- | ----: | -------: |
| `policy`, `maxWorkers: 8`                 |    20 |   3.64 s |
| `boundary`, `maxWorkers: 4`               |    29 | 208.77 s |

The six slowest suites, and the slowest cases, from the same run:

| Suite                            | Duration |
| -------------------------------- | -------: |
| `completion-github.test.ts`      | 100.12 s |
| `source-cli.integration.test.ts` |  77.81 s |
| `runner.test.ts`                 |  59.54 s |
| `completion-arm.test.ts`         |  58.46 s |
| `workspace.test.ts`              |  48.87 s |
| `workspace-branch.test.ts`       |  47.24 s |

| Case (suite, then the case's own name)                                                                   | Duration |
| -------------------------------------------------------------------------------------------------------- | -------: |
| `live-verifier.test.ts`, "runs both exercises through the configured selection, against the fixture"     |  12.19 s |
| `fixture-lifecycle.test.ts`, "cleans up after the cases that must fail, time out or cancel"              |  12.01 s |
| `checks.test.ts`, "reports a stop it could not confirm, and calls the copy unsafe to reuse"              |  11.13 s |
| `git.test.ts`, "reports a stop it could not confirm, which is what makes a copy unsafe to reuse"         |   8.66 s |
| `source-cli.integration.test.ts`, "watch picks up an issue made eligible later, then stops on interrupt" |   7.81 s |
| `source-cli.integration.test.ts`, "restarts a re-armed continuation at the first tier…"                  |   7.04 s |

Every remaining slow case is a case whose subject is a real bound — a command
that must be stopped, a process tree that must exit, a poll that must expire, an
exercise that starts a real child — or one of the two cases the lifecycle proof
runs against deliberately failing suites. The stated bounds above the 5 s default
are the `completion-arm` recovery case at 15 s and the cases that make two or
more complete passes over the real command boundary (10 s); every other case
still runs under the default 5 s. The full per-case table is in the timing
detail file.

### The budget this establishes

Measured on this host, at these worker settings: **test phase ≤ 212 s (the
192.50 s reference plus 10 %), no single suite over 110 s, `policy` under 15 s,
and no per-case bound widened except the stated ones below.** The budget is met
by the three complete validations (200.99 s, 169.35 s, 167.00 s), by the
comparable four-worker run (164.31 s) and by the slowest suite (`completion-github.test.ts`
at 100.12 s, inside 110 s) and the policy layer (3.64 s, inside 15 s). It is
_not_ met by the JSON detail run, which took 212.68 s and sits 0.7 s over the
ceiling: that run is the bare test command, it was taken while the host was at
its slowest, and a worker may have built `dist/` inside it. That overrun is
recorded here rather than smoothed away.

The stated per-case bounds are the `completion-arm` recovery case at 15 s — it
makes three arm or pass calls over real `gh` commands — and `TWO_PASSES_TIMEOUT_MS`
(10 s) for the ten cases that make two or more complete passes over the real
boundary. There is no layer-wide deadline: every other case keeps the 5 s
default, and no assertion was weakened to fit a bound.

The budget is a ceiling to investigate against, not a settled result. A future
change that cannot fit it has to explain itself here, and it does not get to fit
by widening deadlines, skipping cases or running fewer workers. The known gaps
below name the intended next reduction.

### Cleanup after each run

Each run was wrapped in the same check: the fixture directories under `%TEMP%`
matching `nexus-harness-*`, and the processes whose command line names one of
them (`nexus-harness-<id>`, which excludes the check's own command line), were
listed before and after the run and compared.

| Point in time              | `nexus-harness-*` directories | Matching processes |
| -------------------------- | ----------------------------: | -----------------: |
| Before run 1               |                           453 |                  0 |
| After run 1                |                           453 |                  0 |
| After run 2                |                           453 |                  0 |
| After run 3 (four workers) |                           453 |                  0 |
| After run 5 (final)        |                           453 |                  0 |

Raw output: [fixture cleanup](../performance/harn-48-fixture-cleanup.txt). The
453 directories are older leftovers from runs of earlier revisions and are not
removed by the suite: it removes what it created, keeps what it cannot confirm is
gone, and reports rather than deletes anything it did not create. The Linux run
below left no fixture directory behind.

### Coverage counts against the reference

| Measure                        | `f44a859` (before) | Restored (after) |
| ------------------------------ | -----------------: | ---------------: |
| Active cases                   |              1,301 |            1,330 |
| Pre-existing skips             |                  2 |                2 |
| Test files                     |                 34 |               49 |
| Test-phase wall time (Windows) |           192.50 s |    164.3–212.7 s |

The 29 extra active cases are accounted for by the restoration itself: the nine
quarantined suites are active again, `tests/fixture-lifecycle.test.ts` proves the
shared lifecycle's end-of-test paths (`vitest.lifecycle.config.ts` runs the
deliberately failing cases it checks) and now also proves the delayed
continuation and the unconfirmed stop, and `completion-policy.test.ts` and
`runner-policy.test.ts` decide the deadline, retry, idempotency, repair and
allowance policy against an in-memory boundary. The file count rose because the
mixed suites were split, not because the coverage was widened by changing what
any file asserts. A count is still not the evidence: the maps above name the
assertion that carries each moved case, and each deleted case's successor.

### Linux CI evidence

Separate from the Windows comparison above, and not comparable to it: the same
`npm run validate` was run on Linux (WSL2, `Linux 6.18.33.2-microsoft-standard-WSL2`
x86_64, 24 CPUs, same node `v24.14.1` and vitest `5.0.0`) against the committed
head, twice. It passed both times: **49 files, 1,322 passed, 10 skipped**,
35.68 s and 33.63 s test phase, with no fixture directory left behind. A third
run on the final tree — the one that moved two cases from the boundary to the
policy layer and stated the multi-pass bounds — passed the same way in 34.52 s,
leaving no fixture directory behind either. The eight
extra skips are the cases that are explicitly bounded to Windows
(`it.skipIf(process.platform !== 'win32')` in `agent`, `checks`, `git` and
`lifecycle`), which run on Windows and are skipped on Linux; no case is skipped
on both. Raw output: [Linux validation](../performance/harn-48-linux-validation.txt).
The job GitHub runs is still `ubuntu-latest` through `.github/workflows/ci.yml`;
this local run is evidence, not that job's result.

### Limitations

- Five Windows runs on one host, all passing. The reference is a single
  historical four-worker observation, and the runs above spread by 48 s
  (164.3 s to 212.7 s) on identical content, so the percentages are an observed
  range, not a measured distribution or a claim about the change. The host also
  runs the queue that started this turn and the user's own desktop applications;
  the slower runs correlate with that load, not with any change in the tree.
- Runs 1, 2, 3 and 5 measure the test phase inside `npm run validate`, after the
  format, lint, typecheck and build steps; run 4 measures the test command alone
  with the JSON reporter, whose summary line is not printed, so its test phase is
  the span from the first suite's start to the last suite's end.
- The four-worker comparison is one run. It is comparable to the reference in
  worker count and pool shape, not in statistical weight.
- No coverage instrumentation or mutation testing was run, before or after. The
  ownership map is the equivalence argument, and the real-boundary cases it names
  as primary owners are the ones that still start processes.

## Known gaps

- `completion-github.test.ts` (100.1 s, 61 cases) is still the single slowest
  suite. Its remaining cases each assert something only the command boundary can
  — the exact `gh` invocation, the credential, the evidence file, the persisted
  admission — but several of them start a process per reading, and the next
  reduction is to share one fixture process across a case's readings rather than
  one per command. It was not attempted here because it changes how the
  credential-refresh assertions observe the reader token.
- `source-cli.integration.test.ts` (77.8 s, 26 cases) is the second tail: every
  case starts the CLI in-process with a fake Jira and a real stand-in runtime.
  Nothing there is duplicated with another suite — it is the only place the
  `source` commands run end to end — so it was left as it is.
- `workspace.test.ts` and `workspace-branch.test.ts` (48.9 s and 47.2 s) still
  create a repository per case. They are real-Git safety cases with distinct
  fixtures, and merging their repositories would couple tests that exist to fail
  independently.
- The fixture lifecycle preserves a directory when a stop cannot be confirmed;
  nothing removes those preserved directories automatically afterwards. That is
  deliberate — the next person has to look at what leaked — and it is why the
  proof ends its leftover tree by hand.
