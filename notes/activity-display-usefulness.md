# HARN-16 live terminal usefulness — 2026-09-19

The pane now reads a command the way the runtime reported it. A launch through a
wrapper this reader recognizes — PowerShell (`pwsh`/`powershell`, `-Command` or
`-c`), `cmd.exe /c`, or a POSIX shell (`sh`, `bash`, `dash`, `zsh`, `ksh`, `-c`
optionally preceded by `l`/`e` in the same cluster) — is shown as the payload that wrapper was
given, in its own quoting, _before_ the 400-code-unit activity bound applies, so
a long `pwsh.exe` path can no longer consume the width. The payload is sliced out
of the reported line; nothing is executed and nothing in it is interpreted. A
shape the reader does not recognize (a missing flag, another launcher, an
unknown program) is shown exactly as it was reported, bounded as before.

A completion line now identifies the operation it belongs to and states the
outcome observed for it: `exit N`, or the runtime's own status word, then the
operation (bounded to 160 code units, wrapper-aware), then the last nonblank
line of `aggregated_output` (bounded to 160) when the command printed anything.
An exit code is repeated, never read as success or failure, and an excerpt is
the runtime's own words — no intent, test count, or change is inferred.

The history is grouped by the agent's messages: each message starts a group that
keeps at most the latest three work lines that followed it, the newest line is
never the one dropped, and the whole history is at most twenty physical lines
(fewer on a shorter terminal, as before). When it is full the oldest work line
goes first, so earlier messages accumulate in chronological order while the work
between them disappears; a message is dropped only once no work line remains.
Work reported before the first message keeps a message-less group above it, so
no work line is ever drawn under a message it did not follow.

On an interactive terminal the progress lines are condensed by `cli/progress.ts`:
`time limit: 60 min total, 10 min per command`, `agent: runtime codex, model
deepseek-flash` (the `--model`/`-m` value the launch prefix names, or the runtime
alone), `source task: jira HARN-8`, `HARN-8: reserved; claiming`, and a workspace
line that keeps the path and leaves out the branch and commit. The working copy's
Git identity line is left to the log. The task line, every phase line, and the
outcome block are unchanged. A line whose shape is not recognized is written as
the run wrote it; a redirected, too narrow, or too short terminal keeps every
line exactly as written, and the run log and report are untouched either way.

## Bounded Windows synthetic check

From this working copy, after `npm run build`:

```powershell
node tests/manual/activity-display.mjs
```

Run on Windows (`win32`), Node 24.14.1, in an 80 by 24 PTY: exit 0 in about six
seconds. The first block reproduces the reported screenshot's own shapes — the
launcher path filling the width and a bare `result: exit 0` — and the second
feeds the same shapes (plus a failing command, a command with no output, an
unknown launcher, four changed files, further turns, and six agent messages)
through the real reader and the real pane. Every draw of an activity line was
asserted to fit one row. The captured trace showed the condensed progress
(reservation without the receipt path or ID, `time limit`, `agent: runtime
codex, model deepseek-flash`, `source task`, the workspace path without branch
or base, no Git identity line), then:

```text
run: 'npm run validate'
result: exit 0 — 'npm run validate' — Tests 214 passed (214)
run: 'npm run typecheck'
result: exit 2 — 'npm run typecheck' — Found 1 error.
run: nerdctl.exe run --rm -v "C:\tools\workspace" --entrypoint node image
result: exit 0 — nerdctl.exe run --rm -v "C:\tools\workspace" --entrypoint nod…
agent: The type error is in the pane; I will fix it and re-run the check.
change: update src/cli/activity.ts
change: add src/cli/progress.ts
change: update tests/activity.test.ts
```

The pane stayed at twenty rows while six messages and their latest work lines
were on screen, each message above its own work, and erasure on close left the
synthetic outcome and paths alone on the screen.

## What this does and does not establish

- The check is synthetic and offline. It shows the shapes the documented runtime
  reports and the interface this repository reads; it is not a live coding run,
  and the wrapper recognition rests on the reported Windows PowerShell shape and
  the recognized launcher list, not on a captured live stream in this task.
- The excerpt is the last nonblank line of the command's own output. A summary
  printed earlier, or a failure whose useful text is in the middle, may be
  represented by a less useful final line; a command whose runtime reports no
  `aggregated_output` gets none. Both were exercised synthetically.
- Progress condensation recognizes the exact line shapes the runner and the
  source coordinator write today. A future wording change degrades to showing
  the line verbatim (verified for an unrecognized line), never to hiding it.
- Resize handling remains outside the pane, as before; the synthetic PTY was a
  fixed 80 by 24. Ambiguous-width characters follow the `string-width`
  convention (notes/activity-display-width.md).
- The pane and the condensed progress are presentation only: the timeline in
  `logs/run.log`, each turn's own agent log, and `result.json` are unchanged,
  and nothing the pane shows is evidence or a status.

## Local verification

- `npx vitest run tests/activity.test.ts`: 54 tests passed (panel grouping and
  eviction, width fitting, redirection, progress condensation, and the event
  reader's wrapper, outcome, and excerpt cases).
- `npx vitest run tests/cli.test.ts tests/source.test.ts`: 160 tests passed,
  including a real run's condensed context, the run log's untouched inventory,
  and a source run's reservation line.
- `npm run validate`: formatting, lint, typecheck, build, and the full suite —
  21 files, 636 passed, 2 existing platform skips.
- `node tests/manual/activity-display.mjs` in the Windows PTY described above.

## Review correction: stop at uncertain launcher arguments

The original scanner continued past scripts and unfamiliar options, incorrectly
showing only `smoke` for both `pwsh -NoProfile -File build.ps1 -Command smoke`
and `bash build.sh -c smoke`. Recognition now stops at the first token that is
neither a command flag nor a known argument-free launcher option. The allowed
prefix options are PowerShell's `-NoProfile`, `-NoLogo`, and `-NonInteractive`,
cmd's `/d` and `/s`, and POSIX `l`/`e` flag clusters. POSIX flags remain case
sensitive. File modes, positional scripts, option terminators, and unfamiliar
options preserve the original bounded command on both starts and completions.
Even valid launch options outside this deliberately small set use the fallback;
long unfamiliar wrappers can still obscure their operation within the bound.

Added 19 regression cases alongside the existing long-path PowerShell case.
The focused command `npx vitest run tests/activity.test.ts tests/cli.test.ts
tests/source.test.ts` passed all 233 tests. The grouped display is unchanged.
`npm run validate` passed formatting, lint, typecheck, build, and all 21 test
files: 655 tests passed, with 2 existing platform skips.

Reran `node tests/manual/activity-display.mjs` against the built reader in a
Windows 80 by 24 PTY: exit 0 in about seven seconds, including all row-width
assertions. The added script cases visibly retained their script names:

```text
run: pwsh -NoProfile -File build.ps1 -Command smoke
result: exit 0 — pwsh -NoProfile -File build.ps1 -Command smoke
run: bash build.sh -c smoke
result: exit 0 — bash build.sh -c smoke
```

The demonstration now includes seven retained agent messages and 31 synthetic
activity entries, with older work disappearing first at twenty rows. Recognized
long-path launches still showed `'npm run validate'` and `'npm run typecheck'`
with their supplied outcomes and excerpts. This remains an offline presentation
check; no displayed command, script, or live model was run.
