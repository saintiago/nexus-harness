# HARN-26 developer and reviewer panes in one timeline — 2026-09-20

One CLI invocation now prints one timestamped chronological timeline. Every agent
invocation gets a fresh bounded pane of its own, opened by a boundary row that
names the role of the phase that launched it — `developer` for an implementation
or repair turn, `reviewer` for a Nexus Lens turn — and the ticket it works on:

```text
14:46:25 ---- developer: HARN-16 — implementation turn ----
14:46:25 agent: I will run the checks before changing anything.        (yellow)
14:46:25 run: 'npm run validate'
14:46:26 result: exit 2 — 'npm run typecheck' — Found 1 error.
14:46:28 implementation turn result: completed
14:46:28 ---- reviewer: HARN-16 — review ----
14:46:28 agent: Nexus Lens is reading the diff before writing a verdict. (yellow)
14:46:28 run: git diff --stat
14:46:28 HARN-16: Nexus Lens approved it
14:46:29 ---- developer: HARN-26 — implementation turn ----
```

The role comes from the phase, never from the model: `composeDependencies` opens
the developer pane around the coding turn the runner launched, and
`createReviewerTurn` opens the reviewer pane around the review turn the scan
launched, so `run`, `source run|watch`, `review scan|watch`, and
`queue run|watch` all behave the same way. A pane starts empty, so a repair turn,
a review, and the next ticket's implementation inherit no row of the invocation
before them, and only the invocation running right now is cursor-managed. The
boundary is ordinary output above the pane. A narrow terminal gives up the
phase's wording first and the fences second; the complete role and ticket remain,
wrapping if necessary. Only the activity rows below the boundary count toward
cursor movement, so redrawing them cannot erase a wrapped boundary. Boundary
fields have their control characters sanitized just like activity text.

When an invocation ends its pane is finalized: it is erased where it stood and
its retained rows are written into the timeline as that invocation's own
segment, in order, before any later lifecycle event or the next boundary. Inside
one pane nothing changed: at most twenty visible rows, a group per agent message
keeping its latest three work lines, the golden/yellow highlight on the message
itself, and the same fitted, sanitized rows as before.

Ordinary lifecycle output — the timeline the CLI echoes, the outcome block, and
the messages that go to the error stream — is stamped with the same compact local
`HH:mm:ss`, one read per emission and one stamp per logical line, so a multi-line
block keeps its wording and gains a time on every line, including blank and
whitespace-only lines. LF and CRLF delimit logical lines consistently. A redirected,
noninteractive, too narrow, or too short terminal gets the boundaries and the
stamps with no cursor or color sequence at all; `NO_COLOR` now selects the same
plain output (corrected during the review repair below). The reporter stays presentation only: the
run log, each turn's own log, the report, and every decision read from them are
untouched.

## Focused deterministic tests

`npx vitest run tests/activity.test.ts tests/cli.test.ts tests/reviews.test.ts
tests/source.test.ts` — the new cases drive a controlled clock and read the
screen, not the escape sequences:

- `tests/activity.test.ts` covers a developer, then a reviewer, then the next
  developer through the display itself: each boundary in order, each pane holding
  only its own rows, the lifecycle lines between them stamped in place, twenty
  rows per invocation with the next pane empty, and the same sequence on
  redirected, too narrow, and too short terminals with no escape sequence at all.
  It also pins the one-stamp-per-emission rule (including a multi-line block),
  the error stream drawn above the pane, and the finalization a close performs.
- `tests/cli.test.ts` runs a real run with a substituted coding turn: the
  redirected stream carries `---- developer: example-001 — implementation turn
----` and the stamped lifecycle lines, the interactive one finalizes the turn's
  pane before the next one opens, and a failed and an interrupted run both leave
  the finalized pane above the outcome and its paths.
- `tests/reviews.test.ts` runs `review scan` against the fake GitHub/Jira world
  with an interactive terminal: the review draws `---- reviewer: HARN-3 — review
----` and the reviewer's own rows, and no developer pane.

`tests/readme.test.ts` and `tests/cli.integration.test.ts` read the documented
outcome block from a real process's output; both parse the stamped rows, since
the README shows them.

## Full validation

`npm run validate` passed formatting, lint, typecheck, build, and the full suite:
31 files, 1012 tests passed, 2 existing platform skips.

## Bounded Windows synthetic check

From this working copy, after `npm run build`:

```powershell
node tests/manual/activity-display.mjs
```

Run on Windows (`win32`), Node 24, in an 80 by 24 PTY: exit 0 in about eight
seconds. The demonstration drives the developer turn, its repair turns, a Nexus
Lens review, and the next ticket through the real reader and the real pane. Every
activity draw was asserted to fit one row and carry its receive time, every
message to be highlighted and reset inside its line, and the run reported 35
synthetic activity lines, 108 highlighted message draws, and three invocation
boundaries:

```text
  boundary 14:46:25 ---- developer: HARN-16 — implementation turn ----
  boundary 14:46:28 ---- reviewer: HARN-16 — review ----
  boundary 14:46:29 ---- developer: HARN-26 — implementation turn ----
```

The pane stayed at twenty rows across the whole developer turn — the redraws
returned to the pane's first row and one row left the top as another arrived — and
the finalized segments, the lifecycle lines, and the out-of-pane trailer followed
in order.

## What this does and does not establish

- Both checks are offline and synthetic: no model, run, repository, or network is
  involved, and no live Jira site or runtime was contacted. The reviewer pane was
  exercised through the fake GitHub/Jira world and the stand-in runtime, not
  against a live App installation.
- The manual PTY run is a synthetic display check on Windows, not a visual
  inspection of every font, and not evidence that a live runtime's stream has the
  shapes the fixture reports.
- The stamp is one process's own local clock, read once per emission; entries
  emitted in the same second share a stamp, and nothing correlates a stamp with
  an event the runtime did not timestamp. All timestamps in this note's examples
  come from that run and are not a claim about any other machine.
- Resize handling is still outside the pane, and ambiguous-width characters still
  follow the `string-width` convention (notes/activity-display-width.md).

## Review repair: lifecycle output during an invocation

The first implementation finalized panes between turns but still placed lifecycle
output arriving during a turn above its earlier activity. That reversed receive
order, particularly for interrupt diagnostics. The display now freezes the retained
activity before emitting a lifecycle block; subsequent activity resumes below it,
and cursor redraws cannot reach the frozen segment. The resumed pane retains the
same twenty-row bound and message/work retention policy.

The task also requires no cursor sequences for no-color terminals. `NO_COLOR` now
selects the plain-output fallback, retaining timestamps and invocation boundaries.
This supersedes the earlier behavior that disabled only highlighting.

Deterministic tests interleave developer, reviewer and next-ticket repair activity
with ordinary and multiline error output using an advancing clock. They check exact
chronological order, stable earlier segments, one timestamp per emission, repeated
cleanup, resumed activity bounds, and all plain-output fallbacks. These remain
offline tests; this repair did not run a live Jira or coding-agent exercise.
