# Test architecture audit and temporary quarantine

**Restored, 2026-09-21.** [HARN-48](https://malton-family.atlassian.net/browse/HARN-48) re-enabled
all nine quarantined suites, split the mixed ones by responsibility, gave the fast and process-heavy
layers their own concurrency policy, and replaced the duplicated fixture helpers with one bounded,
cancelling lifecycle. The behaviour-to-test ownership map, the layer policy and the before/after
measurement are in [test-layers.md](test-layers.md); the quarantine below is kept as the evidence
the containment decision was made from.

**Restoration work, 2026-09-22.** Subsequent local rounds implemented: the completion and
run-loop policy matrices moved to in-memory collaborators with controlled clocks, the review, runner
and baseline suites finished their split, the overlapping `local-run`, `cli.integration` and
`live-verifier` scenarios were consolidated onto the owners named in the map, the fixture lifecycle
was tied to each test's own pending work (cancellation, bounded settlement, and directories kept
when a stop cannot be confirmed), and the restored suite was measured twice sequentially plus once
in the audit's four-worker shape. Recovery replaces stale timing evidence and repairs late fixture context and CLI teardown. The numbers, raw output and remaining limits are in
[test-layers.md](test-layers.md).

Operator decision, 2026-09-21. Restoration owner:
[HARN-48](https://malton-family.atlassian.net/browse/HARN-48).

The operator explicitly requested a deep audit, manual disabling of underperforming suites,
reconciliation into HARN-41, and resumption of that ticket. This is a temporary, authorized
exception to the repository's usual rule against disabling tests. It reduces regression coverage;
a green reduced gate is **not** evidence that the disabled behavior passed. No product logic,
assertion, credential boundary, delivery gate, or individual test deadline changes here.

## Evidence and limits

The audited retained HARN-41 checkout was `f44a859`; main was `4480786`. The retained checkout
adds history tests and integration regressions that main did not yet contain. On the same Windows
host (24 available logical CPUs), Vitest 5 selected 23 workers without an explicit cap. Each worker
can start further Git, Node, and command-shell processes. The last recovery gate had seven
five-second timeouts spread across four files; its cleanup also reported EBUSY.

The immediately subsequent experiment changed only the CLI worker count to four. All 34 files
passed: 1,301 tests passed, two existing skips, 192.50 seconds wall time. This supports contention
as a contributor, not proof of the cause of every timeout or proof of long-term stability.
History's dedicated suite took 0.8 seconds. Completion alone occupied a worker for 158.6 seconds.
Durations below are **file execution durations**, not additive wall time or isolated benchmarks.
The default run and four-worker run are sequential observations, not a controlled statistical study.

Local raw evidence on the recovery machine:

- `E:/projects/nexus-jira-runs/recovery-HARN-41-20260921/tests-default-workers-timings.json`
- `E:/projects/nexus-jira-runs/recovery-HARN-41-20260921/tests-four-workers-timings.json`
- `E:/projects/nexus-jira-runs/recovery-HARN-41-20260921/tests-four-workers.log`
- `E:/projects/nexus-jira-runs/recovery-HARN-41-20260921/test-architecture-inventory.json`
- `E:/projects/nexus-jira-runs/runs/run-20260921161207-3879e6d2/logs/attempt-3-check-1.stderr.log`

The inventory parses imports, named functions and suite declarations. Its test-definition count
does not expand parameterized cases and must not be reported as the executed test count. It found
identical function bodies after removing comments and whitespace; scenario overlap below was
assessed separately from actual assertions and fixtures. No coverage or mutation analysis was run,
so this audit does not claim that every overlapping test can safely be deleted.

## All-suite disposition

Quarantine selects (a) the four files with observed deadline failures, (b) mixed orchestration or
meta-verifier files still above 30 seconds with four workers, and (c) the redundant local-loop
milestone layer whose main paths remain exercised by the built CLI and adapter suites. This is an
explicit temporary prioritization, not a general rule that slow tests have no value. Nine files
are disabled using visible `describe.skip` declarations; their sources still lint and typecheck.
The remaining process tests are capped at four workers. No runtime environment toggle hides skips.

| File under tests/             | Default / 4 workers (s) | Decision and reason                                                                                                                        |
| ----------------------------- | ----------------------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| completion.test.ts            |           184.5 / 158.6 | Quarantine: observed failures; policy matrix pays real fake-gh startup repeatedly.                                                         |
| runner.test.ts                |           141.3 / 104.8 | Quarantine: broad loop matrix clones repositories and runs real commands despite injectable collaborators.                                 |
| source.test.ts                |            124.3 / 85.2 | Quarantine: fast coordinator/receipt tests coupled to a large CLI/real-runner matrix.                                                      |
| workspace.test.ts             |            122.3 / 83.2 | Quarantine: observed failures; repeated full preparation for branch and path cases. Unique Git safety coverage must return.                |
| baseline.test.ts              |             77.9 / 39.5 | Quarantine: diagnosis, parser, Jira, restart, coordinator, queue and CLI layers in one file.                                               |
| cli.test.ts                   |             73.0 / 34.1 | Quarantine: observed failure; parser/display/path cases mixed with real runner and process tests.                                          |
| live-verifier.test.ts         |             57.3 / 33.9 | Quarantine: testing the opt-in test tool repeats preparation and implementation/repair exercises.                                          |
| reviews.test.ts               |             64.6 / 26.6 | Keep: mixed and needs splitting, but no observed timeout; owns review ownership, pinned view and HARN-41 reviewer history wiring.          |
| local-run.integration.test.ts |             59.2 / 26.5 | Quarantine: historical milestone repeats much of runner and built-CLI behavior with another target fixture.                                |
| cli.integration.test.ts       |             55.1 / 23.7 | Keep: real built-artifact smoke, argument routing, actual adapter and interrupt boundary. Trim repeated matrices during refactor.          |
| git.test.ts                   |             30.2 / 23.3 | Keep: actual bounded Git command and process termination behavior, not just policy.                                                        |
| queue-cli.test.ts             |             54.0 / 21.5 | Keep: distinct queue wiring, authoritative ownership and scoped completion paths.                                                          |
| agent.test.ts                 |             52.4 / 20.8 | Keep: actual adapter launch, input, credential isolation and runtime termination. Split embedded runner matrix later.                      |
| checks.test.ts                |             21.1 / 17.1 | Keep: configured commands, logs, command-tree deadlines and setup/check ordering.                                                          |
| lifecycle.test.ts             |             34.6 / 15.6 | Keep: real cancellation at multiple phases with child-tree assertions. Consolidate fixture machinery, not the safety guarantee.            |
| refresh.test.ts               |             36.9 / 13.3 | Keep: real remote/source update and preservation behavior between queue tickets.                                                           |
| delivery.test.ts              |             33.3 / 11.6 | Quarantine: observed timeout despite modest aggregate time; real Git plus fake-gh setup per case. Unique revision/push safety must return. |
| readme.test.ts                |              13.5 / 4.6 | Keep: executes the actual documented example, plus link/command checks; distinct documentation contract.                                   |
| activity.test.ts              |               3.9 / 2.6 | Keep: deterministic terminal model; large file is not itself a performance problem.                                                        |
| report.test.ts                |               3.3 / 1.2 | Keep: reporting semantics and evidence persistence at low cost.                                                                            |
| fixture-beacon.test.ts        |               2.2 / 1.2 | Keep: ownership/liveness safeguards used by destructive fixture cleanup.                                                                   |
| history.test.ts               |               1.6 / 0.8 | Keep when HARN-41 lands: task-specific history behavior, including prior review findings.                                                  |
| completion-cli.test.ts        |               2.1 / 0.6 | Keep: two small command wiring tests; does not replace the full completion matrix.                                                         |
| boundaries.test.ts            |               0.7 / 0.6 | Keep: exercises import restrictions, including rejected imports.                                                                           |
| config.test.ts                |               0.8 / 0.3 | Keep: configuration contracts and ownership at low cost.                                                                                   |
| jira.test.ts                  |               0.4 / 0.1 | Keep: mocked HTTP boundary, mapping, eligibility and publication.                                                                          |
| queue.test.ts                 |               0.3 / 0.1 | Keep: good example of a direct orchestration test with controlled collaborators.                                                           |
| completion-config.test.ts     |               0.1 / 0.1 | Keep: completion-specific configuration contract.                                                                                          |
| support.test.ts               |               0.1 / 0.1 | Keep: cleanup retry classification; does not prove process lifecycle cleanup.                                                              |
| review-github.test.ts         |              0.1 / <0.1 | Keep: HTTP protocol, review/check provenance and boundary failures.                                                                        |
| queue-recovery.test.ts        |             <0.1 / <0.1 | Keep: authoritative recovery decisions without full workflow setup.                                                                        |
| connect-guide.test.ts         |             <0.1 / <0.1 | Keep: public guide contract at negligible cost.                                                                                            |
| completion-gate.test.ts       |             <0.1 / <0.1 | Keep: pure check/workflow state matrix; model for moving completion policy tests.                                                          |
| stop.test.ts                  |             <0.1 / <0.1 | Keep: bounded diagnostic behavior; complements real tree-stop tests.                                                                       |

## Repeated scenarios and appropriate owners

### Loop behavior replayed through multiple entry points

`runner.test.ts` covers green baseline, implementation, repair allowance/exhaustion, failed setup,
timeouts, cancellation and observed reports. `local-run.integration.test.ts` repeats ten milestone
scenarios: implementation, repair, exhaustion, a lying agent, red baseline, setup failure, launch
failure, timeout, cancellation and directory isolation. `cli.integration.test.ts` repeats several
through the built CLI. `agent.test.ts` embeds a runner-plus-checks-plus-adapter group, and
`live-verifier.test.ts` repeats implementation/repair exercises to validate the optional live tool.

These are overlapping behavioral claims, not interchangeable tests. Proposed ownership:

- Runner policy: direct collaborators, scripted outcomes, fake clock; complete decision matrix.
- Adapter and checks: actual child processes for arguments, input, output, termination and isolation.
- Built CLI: representative success, repair and interruption, plus distinct argument/exit routing.
- Local-loop milestone: retain only a demonstrated boundary not covered above, otherwise remove.
- Live verifier: prerequisite/fixture contracts and one wiring case; avoid a second complete loop matrix.

Keep the lying-agent assertion somewhere real: agent text must never overrule observed checks.
Keep cancellation at materially different ownership boundaries. A fake stop result cannot replace
observing that an actual child and its descendant exited.

### Mixed test layers make expensive setup contagious

`source.test.ts` combines direct coordinator, receipt, lock, escalation and watch tests with a
large CLI block using actual repositories and commands. `baseline.test.ts` combines finding
parsing, durable diagnosis, fake Jira, real reviewer, coordinator, queue and source CLI. The same
baseline return/restart decisions are also reached through source and queue tests. Split by layer,
then assign policy cases to the narrowest real owner and retain a small number of composition checks.

`reviews.test.ts` similarly mixes verdict evidence, scan policy, watch, configuration, keys, CLI
and Git-backed review views. Keep ownership/provenance/pinned-head guarantees; separate them from
transport and filesystem mechanics. `queue.test.ts`, `jira.test.ts`, `review-github.test.ts` and
`completion-gate.test.ts` already demonstrate cheap tests at existing interfaces. No new mocking
framework or provider registry is needed.

### Completion policy repeatedly starts an executable

In `completion.test.ts`, `createFixture` installs fake gh and writes response files; `passFor`
constructs real GitHub completion actions. The merge deadline/idempotent notification scenario
runs four full passes. The logical clock is fake, but every relevant GitHub read still starts a
process. Use the existing `CompletionActions` boundary for these decisions. Retain a small real
command suite for argument construction, credential selection, transport failures and evidence
directory creation. Preserve on-disk restart tests where persisted evidence itself is the subject.

### Git fixtures prepare more than the assertion needs

Workspace branch-return cases create and commit a repository, run full preflight/allocation/clone,
create another branch/commit, inspect it, recover it, and inspect again. Real Git is essential to
the preservation assertions; the entire workspace bootstrap is not essential to every variation.
Build minimal independent Git fixtures for branch operations and keep preparation integration
tests separately. Do not share mutable repositories between tests or remove post-mutation safety
reads merely to reduce process counts.

## Exact duplication and lifecycle defects

The AST inventory found identical `runProcess` bodies in `agent.test.ts`, `git.test.ts`,
`runner.test.ts` and `workspace.test.ts`. Each starts a child and waits for close, but has no test
cancellation signal or own deadline. Identical `registerFixture` bodies exist in checks/lifecycle;
identical real-runner dependency construction exists in agent/lifecycle. Other files contain
similar, non-identical helpers. Consolidate only after accounting for those differences.

`tests/fixtures/local-target.ts` is itself over 1,000 lines and owns target content, Git helpers,
fake runtime/Git/GitHub installation, build locking, CLI execution and process cleanup. Several
older suites also embed independent target programs and execution helpers. Split the shared fixture
by these concrete responsibilities and reuse a single lifecycle implementation; avoid a generic
fixture framework that adds more indirection than it removes.

The completion `runPass` helper uses `AbortSignal.timeout(30_000)`, while failing cases are subject
to Vitest's five-second deadline. Those lifetimes are not linked. Shared `afterEach` cleanup removes
directories without waiting for all test-owned asynchronous work; workspace's raw child helper
cannot be cancelled. A timed-out test can therefore retain work after cleanup starts. EBUSY is
consistent with that race, but this audit did not trace a particular holder for each observed error.
Retrying removal is not a substitute for cancelling and awaiting the owner.

Required fixture contract: register ownership immediately, propagate the test's stop to spawned
work, prevent subsequent commands after stop, await termination, and only then remove directories.
Exercise timeout and assertion/setup failure cleanup without killing unrelated host processes.
Retain existing beacon checks and bounded stop confirmation rather than replacing them with PID-only
tree kills. The 39 abandoned historical fixtures previously removed from this host are supporting
operational evidence, not proof that all current fixtures leak.

## Related production architecture

The dependency boundaries are useful: the runner accepts collaborators; completion accepts actions,
source, clock and sleep; review separates repository and view; the process module centralizes bounded
invocation and stop. Tests frequently choose the most expensive implementation of those boundaries
even when testing policy. This is primarily a test-layer choice, not a missing framework.

There are also real maintainability problems. `createCompletionPass` occupies roughly 1,260 lines
in one closure, combining admission persistence, deadlines, reconciliation and publication flow.
Source/baseline orchestration and reporting are similarly coupled in large test files. Extract
small ordinary functions for independently testable decisions and cohesive persistence operations
where callers need them; keep ordering and ownership explicit in the coordinating function.
HARN-46 already owns broader baseline product cleanup, so HARN-48 must not duplicate that rewrite.

Production workspace code is more purposefully split (prepare, reopen, branch, refresh, Git and
state). Repeated reads around mutation often defend against races or verify preservation; they
are not automatically redundant. No product safety reads are removed by this containment change.
The prior HARN-41 revision-lookup optimization did not eliminate the suite-wide contention problem.

## Coverage gap and restoration

The reduced gate on the main-based containment branch passed formatting, lint, typechecking,
build and tests: 24 files passed, nine files skipped; 687 tests passed, 571 skipped (1,258 total),
52.89 seconds test wall time. This includes the pre-existing skips. HARN-41 has additional tests,
so its reconciled checkout must be validated separately and its counts reported separately.

While quarantined, unique workspace, delivery, completion, intake and baseline edge cases do not
execute. HARN-41's dedicated history and reviewer tests remain active, but its added regressions
inside runner/source/baseline are also skipped. Retained boundary suites reduce this gap; they do
not close it. Report active and skipped counts on every validation result during this period.

HARN-48 must map each case to retained/moved/deleted coverage, restore all required behavior, remove
these temporary skips, and document separate fast/boundary execution policy. Run the restored full
gate twice sequentially on Windows, inspect owned fixture cleanup after each, and pass Linux CI.
Record timings and counts; choose a performance budget from measurements, not a blanket deadline
increase. The normal gate must again exercise both fast and integration layers before closing it.
