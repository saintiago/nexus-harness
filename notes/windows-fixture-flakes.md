# Fixture flakes, recorded as they are found and fixed

**Status: every reproduced race addressed; none of the assertions were weakened, skipped, or
reordered.** One entry below (HARN-13, 2026-09-19) records a failure whose signature was reproduced
but whose cause was not: it is marked there as a hypothesis, and what it adds is a guard and a
diagnostic rather than a proven fix. The name of this file is narrower than its content: the first
flakes were seen on Windows, and the lifecycle one was seen on Ubuntu. The fourth entry below
(2026-09-19) is the one that stopped a harness run by ending an unrelated process, and it is the
entry that fixed the cleanup, not the assertions.

Failures 1 and 2 happened during full `npm run validate` / `npx vitest run` runs on Windows on
2026-09-16 and 2026-09-17, and never in an isolated run of the file involved.

Since this note was written, failure 2 fired in a real harness run (HARN-1,
`run-20260916225121-f3d4a6e4`): the post-agent `npm run validate` reported exactly this assertion
after a 36-minute implementation turn, the repair turn then spent the remaining budget on it, and the
run's task deadline (60 minutes) cut that repair off. The run was reported as failed, with a reason
about the deadline rather than about its checks. The leftover was named this time:

```
AssertionError: fixture processes still running after the suite: expected [ Array(1) ] to deeply equal []
  pid 15616 of a fixture runtime recorded in C:\Users\User\AppData\Local\Temp\nexus-harness-Uwgvde\fake-runtime-state\turns.jsonl
```

## Failure 2: the check now asks a beacon, not a PID

The teardown decided liveness from a recorded PID, and on Windows a PID is handed to a new process
within seconds of the process that held it ending — so the answer could be about the wrong process in
either direction. Each fixture invocation now answers, while it runs, on a liveness beacon
(`tests/fixtures/fake-codex.mjs`) named by a random token it records in `turns.jsonl` once its
listener is up; the suite asks that token instead (`fixtureProcessGone`,
`tests/fixtures/local-target.ts`), and `tests/fixture-beacon.test.ts` pins the contract: it answers
while the process runs, falls silent when that process is gone, answers for its own token alone, and a
probe never ends the process it asks about. A record that carries no token is still checked by PID
rather than skipped.

What this does and does not establish: a leftover reported from here on is a real surviving process,
not a recycled PID — the message says which question was asked. It does not prove the flake is gone;
the evidence is the mechanism and repeated full-suite runs, not a reproduction that no longer happens.

## The 2026-09-18 pass: three races, one of them reproduced

**The lifecycle fixture published its pid before its mark.** The Ubuntu failure that blocked a merge
was `tests/lifecycle.test.ts` > `stops the repair turn of a red run...`: `HANG_FLAG` was missing from
the retained working copy. The fixture wrote its pid record, and only then the mark it leaves in the
workspace — while the test stops the process as soon as it sees the record. Under load the stop won.
The fixture now writes the mark first, then its beat, then the record, so a recorded pid means the
mark is already on disk. Evidence: 5/5 Linux runs of that suite, the whole suite green on Linux, and
four consecutive full suites plus two concurrent ones green on Windows.

**A fixture's child could kill the fixture.** All three fixtures spawn a helper process with no
`error` handler, so a fork a loaded host refuses ends the fixture as an unhandled error — which the
harness reads as the command _exiting_, not as the timeout under test. That is the shape of the
`tests/checks.test.ts` failure recorded above. The handlers now record nothing and let the fixture
keep running; the test that timed out a 500 ms command now allows 2000 ms so a loaded host can start
it, and its assertions print the whole result when they fail. Honest limit: this one was **not**
reproduced, so the mechanism is plausible rather than proven — the next occurrence will say which.

**Several workers built the CLI into the same `dist/`.** Running two suites at once (the load that
reproduces these flakes) made `tests/live-verifier.test.ts` fail with `result failed to run: ENOENT`
against the built CLI: each test file checks whether `dist/` is current and compiles it if not, and
parallel workers found it stale together. `ensureBuiltCli` now takes an exclusive lock (`dist/.build.lock`),
re-checks under it, and only the worker that holds the lock removes it. Evidence: reproduced before the
fix (one of two concurrent suites failed, the other passed), and after it two concurrent processes
rebuilt from a stale `dist/` and passed 40/40 each, with two concurrent full suites green.

## The 2026-09-19 occurrence: a cleanup killed an unrelated process

The harness run `run-20260919130309-d941f854` ran `npm run validate` and the vitest phase failed on
`tests/live-verifier.test.ts` > `the entry point, as a process` > `runs both exercises through the
configured selection, against the fixture`:

```
AssertionError: expected 1 to be +0 // Object.is equality
 ❯ tests/live-verifier.test.ts:350:29
    349|       expect(result.stderr).toBe('');
    350|       expect(result.status).toBe(EXIT_OK);
```

The test had spawned the live entry as a real process, and that process died in 157 ms — where the
same test normally takes about 14 s — with **nothing on either stream** and exit code 1. It had not
reached its first exercise: no `nexus-live-check-*` directory was created at that time. The entry
point cannot exit 1 in silence — it prints a header before anything else, and every one of its
failure paths writes to standard error — so the process was ended from outside.

Two things were established on this host rather than assumed:

- A process ended by `taskkill /PID <pid> /T /F` reports exactly that shape to the process that
  spawned it: `code` 1, no signal, empty stdout and stderr. The same holds for
  `process.kill(pid, 'SIGKILL')` on Windows, which is the same termination by another name.
- PIDs are recycled fast enough to make that dangerous: spawning 300 short-lived `node`
  processes and then 300 more handed 64 of the second batch a PID the first batch had held
  within the last few seconds. So a PID recorded seconds earlier is routinely held by something
  else — usually a process an unrelated test file started — by the time a cleanup names it.

That was the defect: four suites cleaned up their own fixture processes by naming recorded PIDs
with no further proof (`tests/checks.test.ts`, `tests/lifecycle.test.ts`,
`tests/local-run.integration.test.ts`, `tests/fixture-beacon.test.ts`). A PID whose process had
already ended — which is the normal case, since each test stops its own fixtures and cleanup runs
afterwards — is a lottery ticket, and this time it landed on the live verifier's own child.

**The fix, in tests only: a recorded PID is named again only while that process's own beacon
answers.** The beacon moved into `tests/fixtures/beacon.mjs`, shared by the stand-in runtime and by
the three fixture programs written into temporary directories. Each fixture process — and the child
it starts, through a token the fixture passes down and records only once that child's beacon
answers — now records a token of its own with its PID, and `endFixtureTree`
(`tests/fixtures/local-target.ts`) asks that token before it stops anything. Both records are
registered, the parent and the child: a `taskkill /T` on the parent does not reliably reach the
child when the parent dies first, which is why the old cleanup named both PIDs and why this one
does too — each with its own proof. A record that carries no token is never named again: the target
project's own hanging test in the local-loop suite has only its backstop.
`tests/fixture-beacon.test.ts` covers both directions: a live fixture process is ended when its own
beacon names the PID, and a live bystander whose PID is recorded with a token nothing answers on is
left alone. No assertion moved, and none was weakened; what changed is which PIDs may be signalled.

Honest limits. The liveness assertions in those three suites still read a bare PID
(`expectGone`, `stillRunning`), so a recycled PID can still make one of _those_ fail — a different
failure from this one, and still open. And a process whose beacon never came up, or has fallen
silent while the process somehow still runs, is left to its own backstop (20–60 s) instead of being
named by a PID nothing can vouch for: cleanup may leave a bounded process behind, but it can no
longer kill a stranger.

## The HARN-13 baseline failure: `taskkill` exit 128 (investigated 2026-09-19)

The run `run-20260919121602-6df99460` (HARN-3, workspace base `e27bc48`) failed an unchanged
baseline on
`tests/agent.test.ts` > `stopping what a turn started` > `stops the runtime it started, waits for
it, and reports a confirmed stop`: 456 passed, 1 failed, 1 skipped, no coding turn started, and the
same test passed in isolation without changes. The recorded shutdown was
`{ termination: 'unconfirmed', problem: '"taskkill" exited with code 128' }`, and the test took
624 ms — its own `close` was observed well inside the 5 s grace, so the process it was talking
about really had ended.

Everything quoted above is retained outside this repository: the failing run's own output is at
`E:/projects/nexus-jira-runs/runs/run-20260919121602-6df99460/logs/baseline-check-1.stderr.log`
(the vitest failure block) and `.../baseline-check-1.stdout.log` (the gate's stdout); the raw outputs
of the bounded reproduction and of the one `EBUSY` removal below are in the investigating attempt's
agent log, `E:/projects/nexus-jira-runs/runs/run-20260919151935-04dbd8ce/logs/agent-implementation.log`.
The reproduction's scratch scripts were not committed, so the counts here are reported from that
log, not re-runnable from this checkout.

**Reproduced on this host** (a signature, not a cause):

- With the failing test's own shape — `cmd.exe` → the `.cmd` shim → a node stand-in holding —
  `taskkill /PID <pid> /T /F` exits 0 and the tree ends: 40/40 idle, 160/160 under four parallel
  workers plus CPU load, and 40 more in the first experiment. On this host a live tree of that shape
  did not produce 128.
- The failing signature comes back 6/6 when that tree is ended from outside with the same
  `taskkill` immediately before the harness's own stop request: the harness then asks about a PID
  that holds nothing, reports the stop unconfirmed, and the process it spawned is seen to end — the
  shape the failure log shows. That says what an outside stop _can_ produce; it does not say who
  stopped the historical process, and a later not-found message beside an observed `close` cannot
  identify a bystander.
- `taskkill` exits **128** both for a PID that holds nothing, with
  `ERROR: The process "<pid>" not found.` — which the suite's own Windows-only test asks about with
  a PID argument no process can hold — and for a process it is _refused_: `Access is denied`, or
  `This is critical system process`. The refusal text is on record from one probe of unrelated
  system PIDs (`taskkill /PID 0 /T /F`, `/PID 4 /T /F`) made while investigating; that probe was
  outside this task's owned-fixture constraint, is not repeated, and error scenarios from here come
  from an owned fixture's own record or from mocked utility output. The exit code alone decides
  nothing: every 128 must still be read as a failed stop, never as "the process is already gone",
  and the utility's own words are what tell the two apart — which is why the harness stopped
  discarding them (below).

**Supported hypothesis, and what stays open.** The failure's shape is consistent with the harness's
stop reaching a process that was already ending — its own stop had ended the tree, or the fixture
had ended by itself, or something else stopped it first. What would have separated a `not found`
from a refusal was thrown away with the utility's output. Two pieces of retained history make the
last of those worth guarding against, without proving it did this: the failing workspace's base
`e27bc48` predates PR #27, whose section above records four fixture cleanups that named recorded
PIDs with no proof (`tests/checks.test.ts`, `tests/lifecycle.test.ts`,
`tests/local-run.integration.test.ts`, `tests/fixture-beacon.test.ts`), and the section above
records that same defect killing the live verifier's child in a HARN-3 run; `tests/agent.test.ts`'s
own teardown named recorded PIDs the same way. The other reading — `taskkill` failing on a tree it
was ending itself — did not appear in the bounded attempts, and nothing here establishes whether it
is possible on this host; the stop is not changed for it.

**What changed here.** `tests/agent.test.ts` was the last file still naming a recorded PID to stop
something: its teardown called `requestTreeStop` on any recorded PID that still looked alive, so a
PID the host had handed to another process would have been stopped as a stranger. Its stand-in now
answers on a beacon of its own (`tests/fixtures/beacon.mjs`) and records the token beside its PID;
the teardown waits on that beacon and hands the record to `endFixtureTree`, which names the PID only
while the beacon answers, never when a record carries no token. A new test pins the contract the
cleanup leans on: the recorded token answers while that stand-in runs and falls silent once it has
ended. The stop problem now also repeats what a failed utility said —
`"taskkill" exited with code 128: ERROR: The process "1234" not found.` — with each stream bounded
as it is collected and standard error preferred over standard output, because `taskkill /T` prints a
success line per child it ended before it can report a failure and the reason must not be crowded
out of the record. `tests/stop.test.ts` pins that with a long success prefix followed by a failure on
standard error, through the collector itself, so no system process is started; the Windows-only test
in `tests/agent.test.ts` still asks about a PID argument no process can hold, so nothing is
signalled.

One full `vitest run` while that change was being validated also failed this file's teardown with
`Error: EBUSY: resource busy or locked, rmdir '…\runs\workspaces\run-…'`: a temporary directory
removed while something still held it. That one refusal is the only evidence for the retry; two
probes made while writing this — a process whose working directory was the tree, and a process with
an open file in it — did not refuse a removal on this host, but they do not exclude every
fixture-related lock, they only say those two Node shapes were not enough, and what held this tree
was never established. The teardown now waits for the stand-in's beacon to fall silent _and_ for its
recorded PID to go (read-only) before cleaning up, and `cleanupTempDirectories` removes through the
same bounded retry as `removeDirectory` (five attempts, 100+200+300+400 ms of waiting, so about a
second, then whatever the removal said). The retry waits out `EBUSY` alone and rethrows any other
failure at once, which `tests/support.test.ts` pins, together with a directory that is refused every
time still throwing: the tolerance is a response to one demonstrated refusal, not a blanket retry
for failures that were never shown to be transient.

Honest limits. None of this establishes that HARN-3's process was stopped by a bystander: the
reproduced signature shows an outside stop can produce that reading, and the retained history makes
it worth guarding against, but the process could have ended by itself, or the harness's own stop
could have ended it, and the discarded message is what would have narrowed that. What the guard does
is remove the only PID-naming stop left in this suite, so that a PID the host handed to something
else can no longer be named here; the stopping behaviour itself, and every stop-result assertion,
are unchanged. The read-only liveness assertions of the suites — including `waitUntilGone` in
`tests/agent.test.ts` — still read a bare PID, so a recycled PID can still fail one of those; that
is a different failure and is still open. And a stand-in whose beacon never came up is left to its
own release/backstop rather than named by a PID nothing vouches for, the same trade as above. The
kept words are what the next occurrence gains: a `not found` names a PID that held nothing when the
stop ran, a refusal names a process the utility could not end — neither says who, if anyone, stopped
the process first, and only a further occurrence beside its own evidence can say more.

## What failed

1. `tests/checks.test.ts` > `a command that runs out of time` > `is stopped with the child it started,
and is not waited for`. The failing assertion was `expect(result.outcome).toBe('timed-out')` for a
   command configured with a 500 ms limit, so the command was classified some other way. The received
   value was not captured: the console output was truncated before vitest printed the failure block,
   and a re-run did not reproduce it.

2. `tests/cli.integration.test.ts` teardown, three times:

   ```
   AssertionError: fixture processes still running after the suite:
     expected [ Array(1) ] to deeply equal []
    ❯ tests/cli.integration.test.ts:160:72
   ```

   Every test in the file passed (the whole gate showed 424 passed, 1 skipped) and only the
   after-all cleanup assertion failed: one process recorded as a fixture runtime was still reported
   at teardown. Whether that process really was the fixture, or the PID had been reused by something
   else, was exactly what could not be told apart — see below.

## How often, and under what conditions

- Seven full-suite runs on Windows: three failures (two of failure 2, one of failure 1), four green,
  including a green re-run immediately after each failure.
- `npx vitest run tests/checks.test.ts` six times in a row: six green.
- Both failures happened while vitest ran several test files in parallel, which is the only condition
  they have been seen in.
- CI runs `ubuntu-latest` only, so the Windows stop path (`taskkill`) is not exercised there at all:
  these flakes can stay invisible to the gate that guards `main`.

## What the two have in common

Both sit at the boundary where the harness stops a real process tree it started itself. A check
invocation with a child (`src/process/command.ts`) and a run's runtime stand-in with a child
(`src/agents/codex/adapter.ts`)
are stopped differently per platform: `taskkill /PID <pid> /T /F` on Windows, a signal to the
invocation's process group on POSIX. Both failures look like the Windows side of that path losing a
race under load, but nothing below has been established yet.

## What to capture when it happens again

1. The whole vitest failure block, including `Received`, not just the code frame. A bare `expect`
   without the received value is what made the first failure undiagnosable.
2. For the teardown case, the leftover records the assertion prints, and what each PID actually was:

   ```powershell
   Get-CimInstance Win32_Process -Filter "ProcessId = <pid>" |
     Select-Object Name, CommandLine, ParentProcessId, CreationDate
   ```

3. Whether the machine was loaded (other suites, builds, or editors indexing) at the time.

## Candidate explanations to test, not to assume

- A stop is reported as confirmed while a _child_ of the stopped invocation is still alive: the
  harness waits for the invocation it started, and `taskkill` runs as its own process, so the tree
  may outlive the wait.
- A fixture process starts but dies or wedges before recording its `start` event, so the surrounding
  test classifies the command through a different path than the one it expects (candidate for
  failure 1).
- Teardown samples leftovers too early rather than a stop that never happened: for failure 2 this is
  now answered by the beacon above, and it was the reading of a bare PID that could not tell the two
  apart in the first place.

Each is checkable from the captures above. None is established, and none should be fixed by relaxing
an assertion: the assertions are the only thing that noticed.

## The 2026-09-21 full-suite timeouts: failures under parallel load

While HARN-41's post-agent `npm run validate` was being reproduced by hand, full `vitest run` runs
failed one to four tests on the default 5 s timeout — `tests/workspace.test.ts` >
`is returned to the recorded branch by fast-forwarding it, losing no commit`,
`tests/completion.test.ts` > `bounds a merge that never finishes across passes, then reports
attention once`, and (once each) `tests/queue-cli.test.ts` >
`continues the workspace its pointer names under watch` and `tests/delivery.test.ts` >
`finds the pull request it created, and updates the same branch and pull request`. Every one of
them passed when its file ran alone, and the same runs' format, lint, typecheck, and build phases
passed.

Those tests do 3–4.5 s of real Git and stand-in
process work in isolation (measured: the workspace one 2.9 s, the completion one 4.3 s), so the
default 5 s leaves little headroom once 34 files run in parallel. A detached worktree at
`2d57612` — the previous commit, whose own full `npm run validate` was green on this machine at
12:48 the same day — failed **four** tests the same way when the suite was run again that
afternoon, including the same two. Nothing in those files imports the module the later change
touched.

What was and was not done: no test, timeout, or Vitest configuration was changed for this — the
assertions and the checks stay exactly as they were, and the harness's own `npm run validate`
remains the thing that decides. What is recorded here is the reproduction, so a later failure of
this shape on a loaded host has a comparison point; it does not establish that harness overhead
cannot contribute.

### HARN-41 repair turn 2: reduce executable lookup overhead

The three cases supplied by `run-20260921142726-d839de04` passed together when selected by name,
but all three timed out again in a full validation. The Windows launcher was constructing an
exception and stack for every missing PATH/PATHEXT candidate on every invocation. A probe calling
`planLaunch('git', ['--version'], process.cwd())` 1,000 times took 11,141 ms on this host's
45-directory PATH. Using `statSync` with `throwIfNoEntry: false` reduced the same probe to 4,174 ms.
These are observations under changing host load, not a controlled benchmark or proof of the sole
timeout cause.

The launcher still checks every candidate in order, follows the filesystem on every call, ignores
directories, and handles other filesystem errors as before. A regression test checks missing
directories, an executable-shaped directory, PATH precedence, an executable installed between
lookups, and a command that cannot be found. The three originally failing cases and the native
Windows launcher group passed together: 9 passed, 214 deselected. No existing test, deadline,
assertion, build command, or Vitest setting changed.

The first full validation from this repair's tool shell also had five assertion failures caused by
Node warning on that shell's simultaneous `NO_COLOR` and `FORCE_COLOR` environment variables.
Subsequent verification removes only the tool shell's `FORCE_COLOR` override; it does not suppress
warnings or change the commands or their assertions.

Final verification of this repair:

- `npm ci`: passed, 0 reported vulnerabilities.
- `npm run validate` with the conflicting tool-shell color override removed: format, lint,
  typecheck and build passed; tests exited 1 with 1,295 passed, 5 timed out, and 2 existing skips
  (34 files, 176.95 s). The three supplied cases still timed out, along with CLI relative-path
  resolution and completion reader-credential refresh. The lookup improvement did **not** resolve
  full-suite timing failures.
- A subsequent focused `npx vitest run` selecting those five failing cases plus the native Windows
  launcher group passed all 11 selected tests (285 deselected, 6.10 s).

No live Jira, GitHub, or coding-agent exercise was run. Full-suite timeouts remain an open gap;
passing isolated cases is not a substitute for the configured gate.

### HARN-41 repair turn 3: the full-suite failures remain unresolved

The retained checkout was clean at `711d191`. No production behavior, fixture, assertion,
timeout, test selection in the configured gate, or build configuration was changed in this turn.
Inspection of the Git launcher, workspace branch checks, delivery/completion commands, and
fixture setup did not establish a safe correction for the supplied timeouts. In particular,
isolated success does not establish that the host alone caused them.

Verification on 2026-09-21:

- `npm ci`: passed, 0 reported vulnerabilities.
- `npx vitest run tests/delivery.test.ts tests/workspace.test.ts tests/completion.test.ts -t
"finds the pull request it created|is returned to the recorded branch by fast-forwarding|bounds
a merge that never finishes"`: all 3 selected tests passed, 185 deselected, 4.56 s.
- `npm run validate`: format, lint, typecheck and build passed; tests exited 1 with 1,296 passed,
  4 timed out and 2 existing skips (34 files, 177.58 s). The failures were the completion wait
  across passes, workspace branch fast-forward, workspace fast-forward with configured squash,
  and queue watch continuation without renaming. The delivery case supplied to this turn passed
  in this full run. The timed-out workspace branch case also reported `EBUSY` while removing
  its temporary workspace during cleanup.
- `npx vitest run tests/history.test.ts tests/review-github.test.ts`: all 47 tests passed,
  1.09 s.
- `npx vitest run tests/delivery.test.ts tests/workspace.test.ts tests/completion.test.ts
tests/queue-cli.test.ts -t "finds the pull request it created|is returned to the recorded
branch by fast-forwarding|bounds a merge that never finishes|continues the workspace its
pointer names under watch|fast-forwards the recorded branch even when Git configuration
would squash"`: all 5 selected cases passed, 204 deselected, 5.26 s.

As in turn 2, full validation and the subsequent focused runs removed only the tool shell's
conflicting `FORCE_COLOR` override before invoking the commands. This does not change the
configured gate. The commands above are wrapped across lines for readability; each was run as
one command. No live Jira, GitHub, or coding-agent exercise was run. This is a record of an
unresolved repair, not a claim that the timeouts were fixed or that the task passed.

## The 2026-09-22 HARN-49 gate failure: two cases at the five-second default

The harness ran `npm run validate` after HARN-49's repair delivery (`f6b1766`), and the boundary
layer failed two cases on Vitest's five-second default while the other 800 of its 802 cases passed
(the two platform skips unchanged):

- `tests/completion-arm.test.ts > reconciling terminal states across an auto-merge race > finishes
an already-merged admission without arming or asking for a person` — `Error: Test timed out in
5000ms`, 5,203 ms.
- `tests/completion-github.test.ts > review-to-completion > creates the per-issue evidence directory
before its first GitHub command` — the same, 5,246 ms.

Both are real-command cases: each drives a completion pass against a stand-in `gh` on disk, so each
is a sequence of `cmd.exe`/Node child processes, and the two make two complete passes and one
complete pass respectively. The harness's run had other work on the host. The same two cases pass in
the recorded full runs — HARN-48's four-worker timings have them at 3,929 ms (and 3,662 / 3,628 ms
in the two final runs) and 2,824 ms (2,587 / 2,533 ms) — and this host measured the first at
5,188 ms in isolation, then saw the whole boundary layer green with the same two cases at 4,280 ms
and 2,079 ms a few minutes later, in a quieter window.

### The first repair, and why it was withdrawn

The first repair turn answered this by giving the boundary project a bound of its own
(`testTimeout: BOUNDARY_DEFAULT_TIMEOUT_MS`, 15 s) and by adding a contract case that required it.
That moved the actual deadline of every case in the layer that states none — the two that failed,
and every case beside them — and HARN-49's ticket says the restored suite's deadlines are preserved.
A layer-wide bound does not make a shared host deterministic either; it only decides how much host
load a revision is allowed to be blamed for. The repair was withdrawn: `vitest.config.ts` states no
deadline for either layer, and `tests/validation-cache.test.ts` now fails if a shared `testTimeout`
appears in the configuration, in either project. The withdrawn round stays on the record in
`performance/harn-49-boundary-timeout-repair.txt`; what it measured — 5,203 ms and 5,246 ms in the
harness's loaded run, 4,280 ms and 2,079 ms in a quieter one, 3,000 ms and 2,485 ms in isolation on
this host — is the evidence the repair below answers.

### The repair: the cases start fewer processes

Both cases drive the completion pass against a stand-in `gh` that the fixture installed as a `.cmd`
shim on Windows (a `#!/bin/sh` script on Linux). Every `gh` invocation therefore paid for a shell —
`cmd.exe /d /s /c …` — in front of the Node process that answers it, and these cases make about
forty and twenty of those invocations. A real `gh` is one native executable, so the fixture now
hands the completion step the executable form: this suite's own Node, with the stand-in script as
its fixed first argument (`FakeCompletionState.launch`, `tests/fixtures/local-target.ts`). The same
change is used by the two `queue-cli.test.ts` cases that drive the pass, for the same reason. No
assertion, case, bound or command argument changed; the shell in front of the stand-in is what is
gone. Cases that need the shim form — a stand-in named on `PATH`, or by a configuration file — still
install and use it, so nothing about the shim path stopped being covered.

**Evidence** (Windows host, Node `v24.14.1`, Vitest `5.0.0`, one case selected per run, the same
commands before and after):

| Case (one selected, four workers)                                        | Shim (before) | One process (after) |
| ------------------------------------------------------------------------ | ------------- | ------------------- |
| `completion-arm.test.ts > finishes an already-merged admission …`        | 3,000 ms      | 2,144 / 2,238 ms    |
| `completion-github.test.ts > creates the per-issue evidence directory …` | 2,485 ms      | 1,578 / 1,669 ms    |

The proof that the same work still happens is the suite itself: the files that own those cases pass
in full (87 cases), and the whole boundary layer passes 802 cases with 2 platform skips — in the
fully uncached gate recorded in `performance/harn-49-deadline-repair-validate-fresh.txt`.

**Honest limits.** This shrinks the work; it does not make a shared host deterministic. The two
cases now do about 2.1 s and 1.6 s of their own work in isolation, against the five-second bound
they keep, where before they did 3.0 s and 2.5 s. A host running the earlier gate's own ~1.7–2x
slower than quiet would have put them at about 3.6 s and 3.3 s; the same host at 2.4x would still
break them, and no bound-preserving change here can promise otherwise. What is promised is the
direction: a case that is close to its deadline is repaired by starting less, never by moving the
bound, and the next occurrence of a real leftover process is read as what it is (see the
2026-09-19 entry above for the one flake class this file still has open: a liveness assertion that
reads a bare PID, which a recycled PID on this host can make read as running).

### The same evening: that open class fired once, on the repaired revision

The first `npm run validate` after the repair (the cached run recorded in
`performance/harn-49-deadline-repair-validate.txt`) replayed nine of its ten tasks and failed the
fresh boundary layer on one case:

```
tests/fixture-lifecycle.test.ts > the fixture lifecycle > cleans up after the cases that must
fail, time out or cancel
AssertionError: cli-timeout: built CLI: expected false to be true
```

That is the bare-PID reading the 2026-09-19 entry records as still open: `gone(entry.cliPid)` polls
`process.kill(pid, 0)`, and on this host a PID is handed on quickly enough that another process can
answer for it. What the run left behind was checked directly: a process listing immediately after
the failure held no `dist/cli.js` process at all, and the same file passed 4/4 on its own right
afterwards (78.56 s). The case is `cli-timeout`, which starts the built CLI and a stand-in runtime
and has nothing to do with the completion stand-in this repair re-launched; its own beacons did not
report a surviving process. It stays open here rather than being papered over: the repair for it is
a liveness reading that cannot be answered by a PID the host has handed on, which is a change to
that proof and its own task, not this one.
