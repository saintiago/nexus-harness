# Test layers, coverage ownership, and the restored suite

HARN-48. This document is the behaviour-to-test ownership map the ticket asks
for: what each restored suite owns, what moved, what was deleted and why, which
case is the primary owner of every overlapping scenario, and how the restored
suite performs against the audit's baseline. It replaces the temporary
quarantine recorded in [test-architecture-audit.md](test-architecture-audit.md);
that file stays as the evidence the containment decision was made from.

Raw count is not evidence of equivalence. The map below names the assertion each
move and deletion is accounted for by; the counts that changed are reconciled
against the audit reference, with the measured before/after comparison, under
[Performance](#performance).

## The two layers

The suite is two Vitest projects with explicit concurrency policy
(`vitest.config.ts`), not one pool of 35 files:

- **policy** — configuration, parsing, the terminal model, reporting, the queue
  decisions and the history store: ordinary functions and in-memory
  collaborators, no child process of their own. It may run wide (`maxWorkers: 8`)
  and finishes in seconds.
- **boundary** — real Git, real command shells, real children. Every worker can
  start further Git and Node processes, so this layer is capped
  (`maxWorkers: 4`), and it runs after the fast layer rather than beside it
  (`sequence.groupOrder`).

Commands:

| Command                 | What it runs                                               |
| ----------------------- | ---------------------------------------------------------- |
| `npm test`              | Both layers, in order — what `npm run validate` runs.      |
| `npm run test:policy`   | The fast layer alone, for the loop while working on it.    |
| `npm run test:boundary` | The process-heavy layer alone.                             |
| `npm run test:live`     | The opt-in live provider exercise. Never part of the gate. |

The cap is a scheduling policy, not an assertion: no test asserts on a worker
count, and no per-test deadline was widened to make the layer fit. The one case
whose own bound is stated is `completion-arm.test.ts > recovers a native merge
after …`, which makes three arm/pass calls over real `gh` commands; its 15 s is
that case's own work, not a default.

## Ownership of the overlapping scenarios

These scenarios were replayed through several entry points. Each has one primary
owner now; the other suites keep only the assertions the primary owner cannot
make.

| Scenario                                         | Primary owner (assertion)                                                                                    | Kept elsewhere for a distinct boundary                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Implementation turn implements the task          | `runner.test.ts` (a run whose baseline passes: checks decide, report written)                                | `local-run.integration.test.ts` through the real adapter; `cli-run.integration.test.ts` through the CLI      |
| Repair allowance, one red round after another    | `runner-repair.test.ts` (the bounded repair loop: rounds, allowance, last round red)                         | `local-run.integration.test.ts` once, with the real target's own checks                                      |
| Allowance exhausted                              | `runner-repair.test.ts` (the exact allowance is spent, the last round is reported red)                       | —                                                                                                            |
| A turn that claims success while a check fails   | `runner.test.ts` (a failing check is never a pass)                                                           | `local-run.integration.test.ts` (the same claim through the real adapter)                                    |
| Red baseline before any coding turn              | `runner.test.ts` + `baseline.test.ts` + `baseline-queue.integration.test.ts`                                 | `local-run.integration.test.ts` (red baseline against the committed target)                                  |
| Cancellation, and the child tree it must stop    | `lifecycle.test.ts` (real cancellation at each phase, child-tree assertions) and the fixture-lifecycle proof | `runner-repair.test.ts` (the run's own stop decision), `cli-run.integration.test.ts` (the CLI's signal seam) |
| Setup failure, launch failure, an unusable check | `checks.test.ts` (configured commands, launch failures, command-tree deadlines)                              | `runner-repair.test.ts` (what the run records for each)                                                      |
| Task deadline / timeout                          | `runner-repair.test.ts` (a run that runs out of task time, with a controlled clock)                          | `completion-arm.test.ts` (deadline reporting on the command boundary)                                        |
| Completion deadline, retry and idempotency       | `completion-github.test.ts` + `completion-arm.test.ts` over the real command boundary and persisted evidence | —                                                                                                            |
| Built artifact, argument routing, exit codes     | `cli.test.ts` (parser/display) and `cli-run.integration.test.ts` (a real run through the CLI)                | `cli.integration.test.ts` (the built `dist/cli.js` as a process)                                             |

## What each restored file owns now

Each of the nine quarantined files is active again. Where a file was mixed, it
was split by responsibility and the shared fixture was extracted; no assertion
was deleted, weakened or given a wider deadline in this step.

| Former file                      | Now                                                                                                                     | What moved, and why                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completion.test.ts` (158.6 s)   | `completion-github.test.ts`, `completion-arm.test.ts`, `completion-summary.test.ts` over `tests/fixtures/completion.ts` | The pass itself, the arm/reconcile step and the summary are three responsibilities; one worker no longer carries a union of all three.                                                                                                                                                   |
| `runner.test.ts` (104.8 s)       | `runner.test.ts`, `runner-repair.test.ts`, `runner-records.test.ts` over `tests/fixtures/runner.ts`                     | The loop up to a green baseline, the repair/deadline/stop policy, and what a run records. The stand-in clock and scripted rounds are shared instead of re-declared.                                                                                                                      |
| `source.test.ts` (85.2 s)        | `source.test.ts`, `source-cli.integration.test.ts` over `tests/fixtures/source.ts`                                      | The coordinator, receipt, lock and escalation policy no longer load the 2,700-line CLI block; the CLI block keeps its own fake Jira and runners.                                                                                                                                         |
| `workspace.test.ts` (83.2 s)     | `workspace.test.ts`, `workspace-branch.test.ts` over `tests/fixtures/workspace.ts` and `tests/fixtures/git.ts`          | Retention and branch recovery (real Git safety) are one file; preflight, run directory, preparation and the change report are another.                                                                                                                                                   |
| `baseline.test.ts` (39.5 s)      | `baseline.test.ts`, `baseline-queue.integration.test.ts` over `tests/fixtures/baseline.ts`                              | The diagnosis (reviewer turn, evidence, finding file, Jira record, coordinator) and the queue-facing half (next claim, restart, serial queue, `source run`).                                                                                                                             |
| `cli.test.ts` (34.1 s)           | `cli.test.ts`, `cli-run.integration.test.ts` over `tests/fixtures/cli.ts`                                               | Help, `check-config`, usage errors, path resolution, colour and the entry-point guard are one file; the real run fixtures and interrupts are another.                                                                                                                                    |
| `live-verifier.test.ts` (33.9 s) | unchanged, active                                                                                                       | Its subject is the opt-in tool itself: the prerequisite gate, the entry point as a process, the disposable project, the injected failure and three verifier wiring cases. It is the tool's own contract, not a re-test of the runner; the repair _policy_ is owned by the runner suites. |
| `local-run.integration.test.ts`  | unchanged, active                                                                                                       | Kept as the composition layer: `runTask` with the real adapter, the real target's own checks, a real clone and a stand-in runtime on disk. Its individual scenarios are also owned above, which is why it is the smallest of the heavy files.                                            |
| `delivery.test.ts` (11.6 s)      | unchanged, active                                                                                                       | Real Git plus a stand-in `gh`: the push, the create-or-update decision and the revision refusals.                                                                                                                                                                                        |

## Coverage that was not in the quarantined files

HARN-41's history, delivery, runner, source, baseline and reviewer regressions
run again with the rest. Three of them asserted the _retired_ intake-guidance
channel, which HARN-41 replaced by design: on a history-backed turn, ordinary
conversation context comes only from the identified snapshot
(`docs/spec.md` §11, `docs/WORKFLOW.md` §8). Their substantive assertions were
re-pointed, not dropped:

| Case                                                                      | Was                                                   | Is now                                                                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-cli.integration.test.ts > runs one attempt per ladder tier …`     | the weaker attempt's ledger line in the prompt        | the prompt names the history snapshot, and that snapshot holds the weaker attempt's complete report and its published comment as an authenticated mirror |
| `source-cli.integration.test.ts > restarts a re-armed continuation …`     | both earlier attempts' ledger lines in the prompt     | the snapshot holds one complete report per earlier attempt, each comment authenticated as that report's rendering                                        |
| `baseline-queue.integration.test.ts > returns the same ticket to To Do …` | the ledger line for the failed baseline in the prompt | the snapshot holds that claim's complete report, and the reviewed finding whole — including the repair text the concise comment does not carry           |

## The shared fixture lifecycle

The audit found the same defect on every process suite: `afterEach` removed the
temporary directory without cancelling or awaiting the work the test had
started, so a failing, cancelled or timed-out test could leave a process holding
the tree.

`tests/fixtures/lifecycle.ts` is the one implementation now:

- `runProcess` starts a real command, owns it until it ends, and honours both a
  deadline and the test's own stop: the tree is stopped, the process itself is
  awaited, and a stopped command reports the stop rather than the exit code the
  host gives a killed process.
- `ownFixtureProcess` keeps a fixture process by the token only that process
  recorded — never a bare PID, which this platform hands on
  (`notes/windows-fixture-flakes.md`).
- `disposeFixtures` stops what is still running, waits (bounded) for each
  fixture's own beacon to fall silent, and only then removes the directories. A
  stop that cannot be confirmed is reported as an error instead of being hidden
  by a removal.

Identical bodies removed: `runProcess` from `agent`, `git`, `runner` and
`workspace`; `registerFixture` from `checks`, `git`, `lifecycle` and
`local-run.integration`; the private Git environment from ten suites (now
`tests/fixtures/git.ts`).

`tests/fixture-lifecycle.test.ts` proves the lifecycle on the four ways a test
can end: a command that outlives its bound, a command the test cancels, a
registered fixture process with its directory, and — through
`vitest.lifecycle.config.ts`, which runs cases that must fail — an assertion
failure, a setup failure and a timeout with work still pending. After each of
them the fixture directory is gone, the recorded PIDs (and their children) are
gone, and a timed-out fixture's beacon never answers again.

## Performance

**Before.** The reference is one successful audit run at commit `f44a859`:
1,301 passing, two pre-existing skips, 192.50 s test-phase wall time with four
workers in one pool over 34 files. It is a single four-worker observation, not a
statistical average, and the containment measurement (57.52 s with 571 skips) is
not a comparison point.

**After.** The measurements below are the two restored validations the ticket
asks for, run back to back on the same host and toolchain — Windows, 24 logical
CPUs, node `v24.14.1`, npm `11.11.0`, vitest `5.0.0` — at the layer policy
above (`policy` first with `maxWorkers: 8`, then `boundary` with
`maxWorkers: 4`), with no other Nexus run or test workload on the machine.
Nothing in the tree changed between them. The measured tree is commit `b528855`;
the commits that carry this table change no test or source file.

Raw output: [validation 1](../performance/harn-48-validation-1.txt) and
[validation 2](../performance/harn-48-validation-2.txt) are the complete
`npm run validate` output of each run, and the per-suite and per-case durations
in [the timing detail](../performance/harn-48-after-timings-per-test.txt) come
from a third run of the same test command with the JSON reporter
(`npx vitest run --reporter=json`), because the default reporter prints only the
summary when its output is not a terminal.

| Run | Command                       | Test phase | Total validation | Outcome | Active / skipped |
| --- | ----------------------------- | ---------: | ---------------: | ------- | ---------------- |
| 1   | `npm run validate`            |   206.46 s |         218.23 s | pass    | 1,341 / 2        |
| 2   | `npm run validate`            |   206.44 s |         218.09 s | pass    | 1,341 / 2        |
| 3   | `npx vitest run` (detail run) |   197.88 s |                — | pass    | 1,341 / 2        |

Run 3 is the test command alone, timed from outside vitest for the whole
process; runs 1 and 2 are the complete gate, and their test phase is the
`Duration` line vitest itself printed.

Against the 192.50 s reference that is **+13.96 s (+7.25 %)** for run 1 and
**+13.94 s (+7.24 %)** for run 2. The detail run is **+5.4 s (+2.8 %)**. This is
not a speedup and is not claimed as one: two samples on one host cannot separate
the change from run-to-run variance, and the reference itself is a single
observation. What the numbers do show is that the restored suite runs in the
same order as the four-worker baseline while carrying 40 more active cases, 12
more files, and the deadlines whose timeouts the containment gate could not get
past.

Where the after time goes, from the detail run:

| Layer (span from first start to last end) | Files |     Span |
| ----------------------------------------- | ----: | -------: |
| `policy`, `maxWorkers: 8`                 |    17 |   3.59 s |
| `boundary`, `maxWorkers: 4`               |    29 | 192.80 s |

The six slowest suites, and the six slowest cases, from the same run:

| Suite                            | Duration |
| -------------------------------- | -------: |
| `completion-github.test.ts`      | 100.62 s |
| `source-cli.integration.test.ts` |  67.30 s |
| `completion-arm.test.ts`         |  61.17 s |
| `runner.test.ts`                 |  51.93 s |
| `workspace.test.ts`              |  42.14 s |
| `workspace-branch.test.ts`       |  40.69 s |

| Case (suite, then the case's own name)                                                     | Duration |
| ------------------------------------------------------------------------------------------ | -------: |
| `live-verifier.test.ts`, "runs both exercises through the configured selection…"           |  11.58 s |
| `checks.test.ts`, "reports a stop it could not confirm, and calls the copy unsafe…"        |  11.09 s |
| `git.test.ts`, "reports a stop it could not confirm, which is what makes a copy unsafe…"   |   8.45 s |
| `live-verifier.test.ts`, "passes the repair exercise, and hands the injected failure on…"  |   8.34 s |
| `source-cli.integration.test.ts`, "watch picks up an issue made eligible later, then…"     |   7.26 s |
| `lifecycle.test.ts`, "reports a stop it could not confirm, and never calls the copy safe…" |   6.55 s |

Every remaining slow case is a case whose subject is a real bound — a command
that must be stopped, a process tree that must exit, a poll that must expire, or
an exercise that starts a real child — so its duration is the work it asserts
rather than a widened deadline. The one stated bound is the `completion-arm`
recovery case at 15 s; every other case still runs under the default 5 s.

### The budget this establishes

Measured on this host, at these worker settings, with the machine otherwise
idle: **test phase ≤ 212 s (the 192.50 s reference plus 10 %), no single suite
over 110 s, `policy` under 15 s, and no per-case bound widened past the one
documented 15 s case.** Runs 1 and 2 leave about 5.5 s of headroom; the
`policy` layer costs 3.6 s against its 15 s, and the suite that dominates the
tail (`completion-github`, 100.6 s) is the first thing to attack if a future
change needs the wall time back — the known gaps below name the intended next
reduction. A future change that cannot fit the budget has to explain itself
here, and it does not get to fit by widening deadlines, skipping cases or
running fewer workers.

### Cleanup after each run

Each validation was wrapped in the same check: the fixture directories under
`%TEMP%` matching `nexus-harness-*`, and the processes whose command line names
one of them, were listed before and after the run and compared.

| Run | New `nexus-harness-*` directories | New matching processes |
| --- | --------------------------------: | ---------------------: |
| 1   |                                 0 |                      0 |
| 2   |                                 0 |                      0 |

Both runs ended with the same counts they started with. The 453 directories that
were already in `%TEMP%` before run 1 are older leftovers from runs of earlier
revisions and are not removed by the suite: it removes what it created, and
reports rather than deletes anything it did not. The Linux run below left no
fixture directory and no `node` or `git` process either.

### Coverage counts against the reference

| Measure                        | `f44a859` (before) | Restored (after) |
| ------------------------------ | -----------------: | ---------------: |
| Active cases                   |              1,301 |            1,341 |
| Pre-existing skips             |                  2 |                2 |
| Test files                     |                 34 |               46 |
| Test-phase wall time (Windows) |           192.50 s |         206.46 s |

The 40 extra active cases are accounted for by the restoration itself: the nine
quarantined suites are active again, `tests/fixture-lifecycle.test.ts` proves the
shared lifecycle's four end-of-test paths (`vitest.lifecycle.config.ts` runs the
deliberately failing cases it checks), and `tests/completion-policy.test.ts`
decides the completion deadline against the in-memory boundary. The file count
rose because the mixed suites were split, not because the coverage was widened by
changing what any file asserts. A count is still not the evidence: the ownership
tables above name the assertion that carries each moved case, and each deleted
case's successor.

### Linux CI evidence

Separate from the Windows comparison above, and not comparable to it: the same
`npm run validate` was run on Linux (WSL2, `Linux 6.18.33.2-microsoft-standard-WSL2 x86_64`,
24 CPUs, same node `v24.14.1` and vitest `5.0.0`) against the committed head.
It passed: **46 files, 1,333 passed, 10 skipped, 37.06 s test phase, 58.70 s
total**, with no fixture directory and no `node` or `git` process left behind.
The eight extra skips are the cases that are explicitly bounded to Windows
(`it.skipIf(process.platform !== 'win32')` in `agent`, `checks`, `git` and
`lifecycle`), which run on Windows and are skipped on Linux; no case is skipped
on both. Raw output: [Linux validation](../performance/harn-48-linux-validation.txt).
The job GitHub runs is still `ubuntu-latest` through `.github/workflows/ci.yml`;
this local run is evidence, not that job's result.

### Limitations

- Two sequential Windows runs and one detail run on one host. The reference is a
  single historical four-worker observation, so the ±7 % figures are an
  observed range, not a measured distribution.
- The timing detail run measures the test command alone; runs 1 and 2 measure it
  inside `npm run validate`, after the format, lint, typecheck and build steps.
  The 8.5 s between them was not investigated further and is inside the range
  the ticket asks to state rather than to hide.
- No coverage instrumentation or mutation testing was run, before or after. The
  ownership map is the equivalence argument, and the real-boundary cases it names
  as primary owners are the ones that still start processes.

## Known gaps

- Most of the completion matrix still runs through the real command boundary.
  Splitting it removed the single-worker pole (158.6 s on `completion.test.ts`
  → 100.6 s and 61.2 s on two files) without dropping a case, and the deadline
  decision now also has an in-memory case (`tests/completion-policy.test.ts`,
  over `tests/fixtures/completion-actions.ts`). The retry, repetition and
  idempotency cases have not been converted: each of them also asserts a
  command-level or persisted-evidence effect today, so moving one means writing
  the in-memory equivalent before deleting the real-boundary case, not deleting
  it because a double exists. `completion-github.test.ts` (100.6 s) is the tail
  of the wall time and the next reduction.
- `reviews.test.ts` (28.6 s, 102 cases) is still mixed — verdict evidence, scan
  policy, watch, configuration, keys, CLI and Git-backed views — and is the
  largest file left. It was kept (no observed timeout) rather than split in
  this change.
- `live-verifier.test.ts` and `local-run.integration.test.ts` are kept whole for
  the reasons in the table above; their scenario overlap with the policy suites
  is documented rather than deleted, so nothing here claims those files are
  redundant.
