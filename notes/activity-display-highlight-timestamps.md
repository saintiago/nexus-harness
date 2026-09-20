# HARN-18 activity timestamps and message highlight — 2026-09-20

The activity pane now stamps every entry with the local time the viewer
received it and highlights each agent message. Both are presentation only: the
run log, the agent logs, the report, and what decides a run's status are
untouched.

The stamp is `HH:mm:ss` in the process's own local time, read from the pane's
clock once, in the call that receives the entry, and stored on the entry as
part of the line. A redraw re-writes that stored line, so an entry never
changes its time when the history is redrawn or trimmed; a test that advances a
controlled clock counts exactly one read per entry. It is the viewer's receive
time and nothing more: the runtime's event stream carries no event timestamp,
and the pane does not write anything that could be read as one.

An agent message's own line — its label and its text, not the timestamp — is
drawn in the standard ANSI yellow (`ESC[33m`) and reset (`ESC[0m`) inside the
same entry, so the color cannot reach the next activity line, a progress line,
the outcome, or anything a caller writes after the entry. Commands, results,
and changed files carry no styling at all. The color is applied after the line
is fitted: the timestamp counts toward the width as visible text, and the
escape sequences take no cell. That keeps the existing bound, the three work
lines per message, the eviction order, the scrolling, grapheme-safe
truncation, and control sanitization exactly as HARN-11 and HARN-16 left them.

A terminal whose host asked for no color — `NO_COLOR` set to anything but the
empty string, read by `consoleContext` — keeps the pane, the timestamps and the
20-line bound, and drops every styling sequence; the test support's screen
model now ignores styling sequences for the same reason a real terminal does.
Redirected output is unchanged from before this task: ordinary lines, no
timestamp, no escape sequence, no cursor work.

## Focused offline tests

`npx vitest run tests/activity.test.ts`: 79 tests passed, including the new
cases that use a controlled clock:

- every entry is stamped with its own local `HH:mm:ss`, two digits per field;
- the clock is read once per entry and never again on a redraw, and an entry's
  stamp survives a later progress line that redraws the whole history;
- every redraw of a message carries the highlight and its reset, and no other
  entry carries any escape sequence;
- a long message is fitted with its timestamp counted and its color ignored:
  at 40 and 20 columns the drawn line occupies exactly the pane's width, at the
  exact-fit boundary nothing is cut, and an exactly-fitting wide grapheme line
  is drawn whole;
- a pane told `color: false` draws the same stamped lines with cursor work but
  without one styling sequence.

`npx vitest run tests/cli.test.ts` covers the same behavior through a real run
with a substituted coding turn: the stream the interactive terminal saw
carries `HH:mm:ss` before each entry, the message wrapped in `ESC[33m` … `ESC[0m`,
and the redraw in place still uses cursor moves; with `color: false` the stream
keeps the timestamps and the cursor moves and carries no styling at all.
`colorAllowed` is tested directly for unset, empty, and non-empty `NO_COLOR`.

## Full validation

`npm run validate` passed formatting, lint, typecheck, build, and the full
suite: 31 files, 937 tests passed, 2 existing platform skips.

## Bounded Windows synthetic check

From this working copy, after `npm run build`:

```powershell
node tests/manual/activity-display.mjs
```

Run on Windows (`win32`), Node 24.14.1, in an 80 by 24 PTY: exit 0 in about
seven seconds. The demonstration now asserts, for every line the pane draws,
that it fits one row, starts with its receive time, and — when it is an agent
message — carries the highlight and the reset inside that line, while a
`run`/`result`/`change` line carries no escape sequence. The captured trace
showed the stamped entries and the highlighted messages, for example:

```text
09:10:11 agent: I will run the checks before changing anything.        (yellow)
09:10:11 run: 'npm run validate'
09:10:12 result: exit 0 — 'npm run validate' — Tests 214 passed (214)
09:10:12 change: update README.md
09:10:13 agent: Repair turn 2: narrowing the failure and re-running.    (yellow)
```

The pane stayed at twenty rows across 31 synthetic activity entries and 104
highlighted message draws (including redraws), and erasure on close left the
synthetic outcome and paths alone on the screen.

## What this does and does not establish

- The synthetic check is offline and uses no model, run, repository, or
  network; it shows the pane's own drawing, not a live runtime stream.
- The stamp is a receive time on one process's local clock. Entries received in
  the same second share a stamp, and nothing correlates a stamp with an event
  the runtime did not timestamp.
- Ambiguous-width characters still follow the `string-width` convention
  (notes/activity-display-width.md); terminals configured differently may fit a
  line differently.
- The demonstration ran on Windows in a fixed 80 by 24 PTY; resize handling is
  outside the pane, as before, and no visual inspection of every Windows font
  was part of this check.
