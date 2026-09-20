# Complete agent messages — HARN-34

Messages previously lost text twice: the Codex activity reader capped them at
400 characters, and the interactive renderer fitted them to one row with an
ellipsis. Both limits are removed for messages. Commands, results and file
summaries keep their existing limits; agent logs are unchanged.

One message remains one group, with one receive timestamp and invocation
identity. Its physical rows wrap by display cells and complete graphemes, with
yellow reset on every row. Work retention still drops older work first. When
messages exceed the pane's twenty-row capacity, all rows are painted before the
oldest rows are released into terminal history. Only the retained tail can be
redrawn. Resize, lifecycle output and cleanup freeze existing rows in place,
preserving the HARN-31 no-replay behavior.

## Synthetic Windows exercise

On 2026-09-20, ran `node tests/manual/activity-display.mjs` after the build in a
Windows (`win32`) pseudo-terminal reporting 80 columns and 24 rows. It exited 0
in about nine seconds. Its 37 synthetic activity events covered three invocation
boundaries, a reviewer message with CJK, combining marks and emoji, and a developer
message starting `Committed locally as ba5dda8.` that exceeded twenty rows and
ended `MESSAGE-END: all synthetic details were displayed.` Subsequent command and
result redraws completed, followed by the final cleanup marker. Assertions checked
display-column bounds and per-row highlight/reset sequences, including continuation
rows. No model, Jira, provider account or actual harness run was used.

The deterministic tests additionally cover 20/40/80-column terminals, one-row
panes, complete text beyond the former 400-character cap, stable receive times,
work-first retention, grapheme boundaries, resize/reflow, separate developer and
reviewer invocations, and repeated cleanup. Existing HARN-31 regressions remain.

This exercise verifies synthetic terminal output, not a live coding run. Terminal
glyph widths use the existing `string-width` convention; fonts and terminal
settings can differ, and scrollback retention is controlled by the terminal.

## Checks

- `npm ci`: exit 0.
- `npx vitest run tests/activity.test.ts`: 122 tests passed.
- `npm run validate`: final run exited 0; formatting, lint, typecheck and build
  passed, followed by 32 passing test files, 1,099 passing tests and two skipped
  tests (118.82 seconds for the test suite).
- The first full test run had two five-second timeouts in the unchanged
  `tests/completion.test.ts`: `can resolve a reopened ticket only for a later
different merged result` and `recovers a comment accepted by Jira whose response
was lost`. Both passed together in an isolated targeted run, and the subsequent
  unchanged full validation passed. No timeout, test configuration or assertion
  was relaxed. An earlier validation invocation stopped on two test-code lint
  errors, which were corrected before these full test runs.
- `node tests/manual/activity-display.mjs`: exit 0, as described above.
- `git diff --check`: exit 0.

## Repair-turn verification (2026-09-20)

The harness subsequently reported ten five-second timeouts in six integration
test files. These were timeouts, not renderer assertion failures. The retained
implementation and test configuration were left unchanged while investigating.

- `npm ci`: exit 0, zero audit vulnerabilities.
- `npm run validate` at 21:59:04 local time: formatting, lint, typecheck and build
  passed; the test suite exited 1 after 125.21 seconds, with 1,097 passing tests,
  two skipped tests and two five-second timeouts in `tests/completion.test.ts`.
  This time the failures were `recovers a native merge after merge-uncertain
(repair: true)` and `recovers a native merge after view-after-arm (repair:
false)`, different from the harness-reported failures.
- A focused Vitest run selecting all ten harness-reported cases, both newly
  failing cases and renderer coverage passed: seven files, 100 tests, 14.23
  seconds. The selection used the original five-second limits; 378 nonmatching
  cases were not run in this diagnostic command.
- `npx vitest run tests/activity.test.ts`: all 122 tests passed in 2.83 seconds.
- `node tests/manual/activity-display.mjs` in a Windows pseudo-terminal: exit 0
  in 8.78 seconds at 80 columns by 24 rows, with 37 synthetic activity events,
  222 highlighted row draws and three invocation boundaries. The oversized
  message reached its `MESSAGE-END` suffix and final cleanup marker. No live
  model or provider was used.
- Final `npm run validate` (test suite started at 22:04:05 local time): exit 0.
  Formatting, lint, typecheck and build passed, followed by 32 passing test
  files, 1,099 passing tests and two existing skips in 117.69 seconds.

The focused diagnostic command was:

```powershell
npx vitest run tests/activity.test.ts tests/completion.test.ts tests/delivery.test.ts tests/refresh.test.ts tests/cli.test.ts tests/workspace.test.ts tests/source.test.ts -t 'activity pane|complete wrapped agent messages|receive time|reading activity|CLOSED pull request|diverged checkout|remote is not the delivery repository|ignores a configured source|repairs a red round|pointer that is not a generated workspace id|decides from the item as it is now|re-armed continuation at the rung|per-issue evidence directory|bounds pending required pull request|recovers a native merge'
```

The varying failures and passing focused cases establish intermittency, not a
root cause or a repair. A read-only process inventory found no persistent Node
process belonging to this workspace before validation; processes belonging to
other workspaces and applications were left alone. No test limits, assertions,
worker settings, checks or unrelated application behavior were changed.
