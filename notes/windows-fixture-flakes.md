# Windows fixture flakes, recorded for later investigation

**Status: open.** Observed twice, not diagnosed, and deliberately not worked around. No test was
weakened, skipped, or reordered to hide this. Both failures happened during full `npm run validate` /
`npx vitest run` runs on Windows on 2026-09-16 and 2026-09-17, and never in an isolated run of the
file involved.

## What failed

1. `tests/checks.test.ts` > `a command that runs out of time` > `is stopped with the child it started,
and is not waited for`. The failing assertion was `expect(result.outcome).toBe('timed-out')` for a
   command configured with a 500 ms limit, so the command was classified some other way. The received
   value was not captured: the console output was truncated before vitest printed the failure block,
   and a re-run did not reproduce it.

2. `tests/cli.integration.test.ts` teardown, twice:

   ```
   AssertionError: fixture processes still running after the suite:
     expected [ Array(1) ] to deeply equal []
    ❯ tests/cli.integration.test.ts:160:72
   ```

   Every test in the file passed (the whole gate showed 424 passed, 1 skipped) and only the
   after-all cleanup assertion failed: one fixture process that the harness should have stopped was
   still alive when the suite ended.

## How often, and under what conditions

- Six full-suite runs on Windows: two failures (one of each kind), four green, including a green
  re-run immediately after each failure.
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
- Teardown samples leftovers too early rather than a stop that never happened (candidate for
  failure 2).

Each is checkable from the captures above. None is established, and none should be fixed by relaxing
an assertion: the assertions are the only thing that noticed.
