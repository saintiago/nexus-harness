# Workspace continuation and escalation

The Jira intake currently treats every issue as a single attempt: one claim, one run, one workspace
created inside that run's directory, and a receipt that makes the issue un-runnable afterwards by
design (`docs/WORKFLOW.md` §6). A failed attempt therefore ends in operator surgery — delete the
receipt, move the issue back — and the work the agent did is stranded in a directory no later run
will look at.

This increment makes the *workspace* the unit that survives, and an attempt a thing that happens to
it. It also gives the harness a bounded escalation ladder, so a failed attempt can be followed by a
stronger one without an operator in the loop.

The queue here is machine-only: agents create tickets, the harness works them. Nothing below assumes
a human reading Jira, and nothing below lets Jira text become a command, a path, a repository, or a
limit.

## Layout

```text
<workDir>/
  workspaces/
    <workspaceId>/          the clone, branch harness/<workspaceId>, long-lived
    <workspaceId>.json      the workspace's local state: base, branch, attempts
  runs/
    <runId>/                one attempt's evidence, immutable once it ends
      logs/
      result.json
      source-task.json
  .intake/
    receipts/<hash>.json    per issue: audit trail and second-consumer guard
    lock/
```

- A **workspace** is the working copy: cloned once, accumulated over attempts, never pushed,
  retained while an issue points at it.
- A **run** is one attempt: one deadline, one baseline round, its own turns, one verdict, one
  comment. Its report is never rewritten.
- `workspaceId` is the id of the run that created the workspace (`run-<timestamp>-<hash>`), so the
  pointer below and the directory names speak the same string.
- One layout, and only this one. A `workDir` written before this change is upgraded once, by hand
  (see below); the code never looks in the old place, so nothing half-migrated can be continued by
  accident.

## Upgrading a workDir from the old layout

Old shape: `<workDir>/<runId>/workspace` for the clone and `<workDir>/<runId>/` for the run's
evidence. New shape: `<workDir>/workspaces/<workspaceId>/` for the clone,
`<workDir>/workspaces/<workspaceId>.json` for its ledger, and `<workDir>/runs/<runId>/` for each
attempt's evidence, where `workspaceId` is the id of the run that created the workspace.

1. Move the clone: `<workDir>/<workspaceId>/workspace` → `<workDir>/workspaces/<workspaceId>/`.
2. Move the first attempt's evidence: everything else under `<workDir>/<workspaceId>/` →
   `<workDir>/runs/<workspaceId>/`.
3. Write the ledger, from that attempt's own report (`result.json`): `workspaceId`, `sourceRoot`,
   `baseCommit`, `branch`, `createdAt`, and one `attempts` entry with its `runId`, `outcome`,
   `endedAt`, and the report's new path.

The report keeps the path it recorded when it was written — evidence is not rewritten — so an
upgraded run's `workspace.path` points at where the clone used to be. The ledger is where the
current location lives, and `docs/WORKFLOW.md` §6 tells an operator which of the two to believe.

## The pointer

The first attempt writes the label `harness-ws-<workspaceId>` on the issue, once the workspace
exists and before any coding turn. It is written exactly once, by the run that created the
workspace; a continuation never writes a label.

The label is the only durable statement of where an issue's work lives, and it is readable by any
agent. The queue label (`harness-task`) selects work; this one records where the work is.

## Eligibility

| pointer labels | receipt | decision |
| --- | --- | --- |
| none | none | **fresh**: create the workspace, write the pointer, claim, attempt 1 |
| none | present | **refuse**: already attempted, and nothing says what to continue |
| exactly one, and it resolves on this machine | any | **continue** that workspace, attempt N+1 |
| exactly one, and it does not resolve here | any | **refuse**: the pointer names a workspace this machine does not have |
| two or more | any | **refuse**: ambiguous, and the harness never guesses which one |

A refusal is published like any other terminal outcome: one comment naming the reason, and the issue
moved to the review status. Nothing local is created for it.

## Continuation rules

- The workspace is reopened, not re-cloned: same directory, same branch, the changes the earlier
  attempts left still uncommitted in it.
- Its recorded base commit stays the base, so `changes` in the report is the ticket's whole diff, not
  just this attempt's part. The report also records what the attempt *found* (how many paths already
  differed) so the two are never confused.
- The baseline round runs on that working copy and **may be red**: a continuation of failed work is
  expected to be red, and refusing to start would make continuation useless. A baseline that could
  not be executed still stops the run, unchanged.
- Only the post-turn round decides the outcome.
- The branch was never committed to by the harness. If its `HEAD` moved, the workspace was changed
  outside the harness and the attempt refuses rather than building on it.
- The workspace must not be deleted while an issue points at it.

## Attempts and escalation

An intake runs one **attempt per configured tier**, in order, without an operator between them:

```json
"escalation": [
  { "name": "flash", "agent": { "runtime": "codex", "command": ["codex", "--profile", "deepseek", "--model", "deepseek-flash"] }, "maxRepairs": 2 },
  { "name": "pro",   "agent": { "runtime": "codex", "command": ["codex", "--profile", "deepseek", "--model", "deepseek-pro"] }, "maxRepairs": 2 }
]
```

- With no `escalation` field, one tier is built from `agent` and `maxRepairs`, which is today's
  behaviour.
- Attempt N uses tier N, clamped to the last tier: a re-armed issue whose earlier attempts already
  spent the ladder continues at its top.
- Each attempt is a separate run: its own run directory, report, comment ("attempt 2 of 3, tier
  pro"), and its own repair allowance.
- A green post-turn round ends the intake as passed. When the ladder is exhausted, the harness
  publishes the final result and moves the issue to the review status; the next step is another
  agent's or the operator's decision, taken by moving the issue back.

## What a continued attempt is told

An attempt's task text is the issue's current description, plus the comments added since the
previous attempt (rendered, attributed, and bounded), plus a compact record of the previous
attempts the harness itself produced: tier, outcome, and the checks that were red. All of it is
context for the turn. None of it becomes a command, an argument, a path, or a limit.

## What does not change

- The harness never commits, pushes, merges, or publishes anything in the target repository.
- One consumer per output directory; the lock is never broken automatically.
- Receipts stay local, and remain the audit trail and the second-consumer guard.
- `In Review` still means "an attempt finished and needs a decision", never success, and nothing
  marks an issue `Done`.
- Text from Jira is untrusted input: it is context, never configuration.

## Increments

1. **Workspaces outlive runs** — layout, resolution, reopen rules, the
   pointer label, the eligibility table, the red-baseline exception, and the report/state fields.
2. **Escalation tiers** — the `escalation` config, the tier loop inside one intake, per-attempt
   comments, and the attempt budget.
3. **Continuation guidance** — comments since the previous attempt and the previous attempts'
   evidence, rendered into the turn's context.

**Status.** Increment 1 is implemented: the split layout, the ledger beside each clone, the pointer
label written once, the eligibility table with its refusals, reopening with the red-baseline
exception, and the report's workspace fields. Increments 2 and 3 are not: the ladder is still one
configured agent per attempt, and a continued attempt is told the current description only.

## Verification

- Offline: workspace allocation and resolution, reopen refusal when `HEAD` moved,
  the eligibility table, the red-baseline exception, the tier loop, and the guidance rendering, all
  against fakes; `npm run validate` green, on Linux as well as Windows for anything that touches
  process or path handling.
- Live, once the increments are merged: HARN-1's existing workspace is adopted with its first
  attempt recorded, the pointer label is set, the issue is moved back to the ready status, and the
  next attempt continues that workspace rather than cloning a new one.
