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
