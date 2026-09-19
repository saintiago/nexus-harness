# Fixture flakes, recorded as they are found and fixed

**Status: every known race addressed; none of the assertions were weakened, skipped, or
reordered.** The name of this file is narrower than its content: the first flakes were seen on
Windows, and the lifecycle one was seen on Ubuntu. The fourth entry below (2026-09-19) is the one
that stopped a harness run by ending an unrelated process, and it is the entry that fixed the
cleanup, not the assertions.

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

Established on this host, not assumed:

- `taskkill /PID <pid> /T /F` exits **128** when the PID holds nothing, with
  `ERROR: The process "<pid>" not found.` — and it also exits 128 for a process it is _refused_:
  `Access is denied`, or `This is critical system process` (asked about PID 0/4, its own children
  listed as unreachable). The exit code alone therefore decides nothing; the utility's own words
  do, which is why the harness stopped discarding them (below). Every 128 must still be read as a
  failed stop, never as "the process is already gone".
- With the failing test's own shape — `cmd.exe` → the `.cmd` shim → a node stand-in holding —
  `taskkill` exits 0 and the tree ends: 40/40 idle, and 160/160 under four parallel workers plus
  CPU load. A live tree of this shape does not produce 128 on this host.
- The failing signature reproduces 6/6 by ending that tree from outside with the same `taskkill`
  immediately before the harness's own stop request: the harness then asks about a PID that is
  gone, reports the stop unconfirmed, while the process it spawned is seen to end. That is exactly
  what the failure log shows.

So the process was already ending when the harness's stop reached it, or its own stop ended it and
the utility still failed on a member of the tree that had gone. Which of those the 128 was — did
the PID hold nothing, or did `taskkill` race the tree it was ending — the discarded message would
have said, and it is the difference between the failure that
`tests/agent.test.ts`'s teardown would produce once a recorded PID is handed to another process and
one that needs a reproduction before anything is changed. Two things point at the first: the
failing workspace's base `e27bc48` predates PR #27, and four files there cleaned up their fixtures
by naming recorded PIDs with no proof (`tests/checks.test.ts`, `tests/lifecycle.test.ts`,
`tests/local-run.integration.test.ts`, `tests/fixture-beacon.test.ts`) — the section above records
the same defect killing the live verifier's child in the very next HARN-3 run; and ending that tree
from outside just before the harness's own stop reproduces this failure's shape every time. The
second, `taskkill` racing the tree it is ending, did not appear in the bounded attempts above and
would be a false reading of a stop that worked, so nothing is changed for it.

**What changed here.** `tests/agent.test.ts` was the last file still naming a recorded PID to stop
something: its teardown called `requestTreeStop` on any recorded PID that still looked alive, so a
PID the host had handed to another process would have been stopped as a stranger. Its stand-in now
answers on a beacon of its own (`tests/fixtures/beacon.mjs`) and records the token beside its PID;
the teardown waits on that beacon and hands the record to `endFixtureTree`, which names the PID only
while the beacon answers, never when a record carries no token. A new test pins the contract the
cleanup leans on: the recorded token answers while that stand-in runs and falls silent once it has
ended. The stop problem now also repeats what a failed utility said —
`"taskkill" exited with code 128: ERROR: The process "1234" not found.` — so the next occurrence
names its own kind; a Windows-only test covers it by asking about a PID argument no process can
hold, so nothing is signalled.

One full `vitest run` while that change was being validated also failed this file's teardown with
`EBUSY: resource busy or locked, rmdir '…\runs\workspaces\run-…'`: a temporary directory removed
while something still held it. Measured rather than assumed, neither a process whose working
directory it is nor an open file in it refuses the removal on this host — node removes both — so
what held that tree was not something a fixture did, and it is the same class of transient Windows
lock the fixture helpers already retry. The teardown now waits for the stand-in's beacon to fall
silent _and_ for its recorded PID to go (read-only) before cleaning up, and
`cleanupTempDirectories` removes through the same bounded retry as `removeDirectory` (five
attempts, ~1.5 s): a refusal that is transient is waited out, and a directory that is refused every
time still throws, which `tests/support.test.ts` pins. The retry is not a reproduction of that one
removal — no Node-side holder on this host provokes one.

Honest limits. This change would not have made the HARN-3 failure pass: the killer is what had to
change, and it did. The read-only liveness assertions of the suites — including `waitUntilGone` in
`tests/agent.test.ts` — still read a bare PID, so a recycled PID can still fail one of those; that
is a different failure and is still open. And a stand-in whose beacon never came up is left to its
own release/backstop rather than named by a PID nothing vouches for, the same trade as above. What
the next occurrence will settle is which reading its 128 was: the message is now kept, so a "not
found" beside a process that was seen to end is a bystander kill, and a "could not be terminated"
in the same place is the utility racing its own tree.

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
