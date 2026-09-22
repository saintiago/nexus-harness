# Test layers, coverage ownership, and the restored suite

HARN-48. This document is the behaviour-to-test ownership map the ticket asks
for: what each restored suite owns, what moved, what was deleted and why, which
case is the primary owner of every overlapping scenario, and how the restored
suite performs against the audit's baseline. It replaces the temporary
quarantine recorded in [test-architecture-audit.md](test-architecture-audit.md);
that file stays as the evidence the containment decision was made from.

Raw count is not evidence of equivalence. The map below names the assertion each
move and deletion is accounted for by, and the two counts that changed are
explained one by one at the end.

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

Baseline and comparison, Windows, four workers, same host and toolchain. The
reference is one successful audit run at commit `f44a859`: 1,301 passing, two
pre-existing skips, 192.50 s test-phase wall time. It is a single four-worker
observation, not a statistical average, and the containment measurement
(57.52 s with 571 skips) is not a comparison point.

_Filled in from the two sequential restored validations below._

## Known gaps

- The completion policy matrix still runs through the real command boundary.
  Splitting it removed the single-worker pole (158.6 s → three files) without
  dropping a case; moving the deadline/retry/idempotency cases onto an in-memory
  `CompletionActions` double with a controlled clock is the next reduction and
  is not done here.
- `reviews.test.ts` (26.6 s) is still mixed — verdict evidence, scan policy,
  watch, configuration, keys, CLI and Git-backed views — and is the largest file
  left. It was kept (no observed timeout) rather than split in this change.
- `live-verifier.test.ts` and `local-run.integration.test.ts` are kept whole for
  the reasons in the table above; their scenario overlap with the policy suites
  is documented rather than deleted, so nothing here claims those files are
  redundant.
