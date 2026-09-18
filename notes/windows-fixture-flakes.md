# Fixture flakes, recorded as they are found and fixed

**Status: all three known races addressed; none of the assertions were weakened, skipped, or
reordered.** The name of this file is narrower than its content: the first flakes were seen on
Windows, and the lifecycle one was seen on Ubuntu.

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
invocation with a child (`src/checks.ts`) and a run's runtime stand-in with a child (`src/agent.ts`)
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
