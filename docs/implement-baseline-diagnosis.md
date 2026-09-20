# Diagnosing a completed red baseline

A clean target repository can be perfectly usable and still fail the checks it asks the harness to
run: a load-sensitive test, a fixture that depends on the host, a tool the machine does not have.
Until this increment, that ending had no autonomous path. The harness claimed the ticket, created
its retained workspace, ran the configured setup and checks, published the failed run, moved the
ticket to In Review, and stopped — with no developer turn, no guidance, and nothing for the operator
to do except read the logs and decide everything by hand. HARN-34 demonstrated it: a pre-existing
load-sensitive test blocked every Jira task behind one undiagnosed baseline.

This increment keeps the recovery inside the same ticket and the same retained workspace. A
completed red baseline is handed to one bounded local diagnostic review *before* any developer
turn; the configured reviewer inspects the exact source snapshot and the evidence the configured
commands wrote, and writes down one structured finding. An actionable finding is one concise Jira
comment and a return to the status the ticket was claimed from, with its workspace pointer
preserved: the next claim continues that workspace, is told the original task and the reviewed
finding, repairs the baseline, and then continues the original task. No separate repair ticket, no
special label, and no manual ranking step is introduced.

## The contract

[spec.md](spec.md) §11 and [WORKFLOW.md](WORKFLOW.md) §11 own the behavior and the input contract;
this document is the assignment they were written from.

**When it applies.** Only to an attempt that ran no coding turn and whose own evidence is a
completed red baseline: `status: failed`, no timeout and no cancellation, a fresh (not continued)
workspace, an empty attempt list, and a baseline round with `outcome: failed` — which by
construction means every `setup` command exited `0` and every configured check was attempted with
at least one nonzero exit. Everything else keeps the behavior it had: a setup failure, a missing
host tool, a command that could not be launched, a cancellation, an expired limit, an incomplete
round, a writable ledger that could not be recorded, and a continuation that starts red (which may
proceed to its coding turn) are not diagnosed.

**What the reviewer receives.** The Nexus-wide `reviewer.reviewer` selection, never a coding tier,
for one turn in its own evidence directory under `<workDir>/baseline/<evidence>/`, bounded by the
harness configuration's `taskTimeoutMinutes` and by the intake's own stop request. It is given the
ticket, the configured commands with the results they exited with, the bounded
stdout/stderr evidence each failing check wrote, and a read-only clone of the retained workspace
pinned at the commit the baseline ran against. It receives no coding instruction. It cannot change
the retained workspace — it never sees it, only the clone — and the clone is checked after the turn:
one that changed produces no finding.

The phase exists exactly when the composed configuration provides that reviewer: the harness file's
`reviewer`, with the project's own `source` and `delivery`. A project without it keeps the older
behaviour, and a file-task run has no ticket to return in any case.

**What it writes.** One `finding.json`, exactly one of two shapes: an actionable finding (the
failing check, the evidence, the likely cause, and the repair guidance), or an inconclusive one
(why no repository-local repair can be named, and what a person must supply, do, or decide). A turn
that fails, is stopped, writes nothing usable, or leaves a changed clone has no finding, and is
handled exactly like an inconclusive one.

**What happens next.** An actionable finding is recorded as exactly one comment on the issue,
carrying the marker `nexus-baseline:repair:<evidence>` and the four things above, and the issue
returns to `readyStatus` with its workspace pointer and acceptance criteria untouched. The queue
continues that same ticket before any unrelated ready work: the next claim reopens the retained
workspace, receives the finding as guidance, repairs the baseline, and carries on. Nothing about
that attempt is special — the same runner, the same escalation ladder starting again at its first
tier, the same checks, and the same delivery refusal for a still-red result. An inconclusive,
environmental, or unsafe diagnosis posts one `nexus-baseline:attention:<evidence>` comment with the
evidence and the required action, moves the issue to `reviewStatus`, and stops intake for a person.
No coding turn is ever started from a diagnosis, and no repair is guessed at.

**What it never does.** It records in Jira only. There is no pull request yet, so the harness
fabricates no GitHub pull-request review, no Lens approval, and no check run for one; the delivery
step still runs only for a passed attempt, so a still-red result can never be delivered.

**Restarts.** The comment's marker is the deduplication record, keyed by an evidence identity: the
immutable item, the snapshot commit, and the configured commands with the results they produced.
The same evidence is never diagnosed twice — no second reviewer turn, no second comment — and a pass
that stopped between the comment and the status move finishes only that move.

## Modules

- `src/sources/baseline.ts` — the phase: the evidence identity, the marker, the one comment, and the
  one status move.
- `src/reviews/baseline.ts` — the one reviewer turn over the snapshot clone, its prompt, and the
  finding file it validates.
- `src/sources/jira/baseline.ts` — the Jira side: the thread, one comment, one move out of the
  running status, over the completion path's existing helpers.
- `src/sources/contract.ts` — the ordinary data between them; `src/sources/coordinator.ts` decides
  which ending qualifies; `src/queue/loop.ts` carries a diagnosed ticket into its repair attempt;
  `src/cli/source-command.ts` and `src/cli/queue-command.ts` compose the phase from the configured
  reviewer and the source's own statuses.

See [architecture.md](architecture.md) and [module-structure.md](module-structure.md) for where the
code lives and what owns what.

## Verification

- Offline: the phase against an in-memory thread and a scripted reviewer — an actionable finding
  becomes one marker comment and a return to the ready status, an inconclusive one becomes one
  comment and In Review, a failed reviewer turn becomes the same attention record, a stop is not
  written, a failed comment or move moves nothing, and a thread that cannot be read starts no turn;
  the reviewer turn through the real view and the stand-in runtime, over a disposable repository
  whose failing baseline is real — the prompt carries the commands, the bounded output and the
  snapshot, the finding is validated, a missing file and a changed clone are refused, and the
  retained workspace is untouched; the Jira record against a fake HTTP boundary — one comment and a
  move by target status name for an actionable finding, In Review for an inconclusive one, and a
  second pass that spends no second turn and writes no second comment; the coordinator's ending
  table — a completed red baseline enters the diagnosis, a setup error, a cancellation, a timeout,
  a continuation that starts red, and a post-agent red round do not, no diagnosis configured keeps
  the old publication, and a red result is never delivered; the next claim through the real
  `reopenWorkspace` and a real ledger, where the developer's guidance carries both the earlier
  attempt and the reviewed finding; and the serial queue ordering a diagnosed ticket into its
  repair attempt before anything else; and a reviewer that never answers bounded by the configured
  limit instead of holding the intake open. `npm run validate` is green.
- Live: **not run.** HARN-34's load-sensitive baseline is the scenario for it, and the exercise —
  a real Jira ticket with a red baseline, a real reviewer turn, the comment, the return to To Do,
  the continuation with the finding, and a delivered repair — has not been performed.
