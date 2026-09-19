# Workspace continuation and escalation

When this increment was written, the Jira intake treated every issue as a single attempt: one claim,
one run, one workspace created inside that run's directory, and a receipt that made the issue
un-runnable afterwards by design. A failed attempt therefore ended in operator surgery — delete the
receipt, move the issue back — and the work the agent did was stranded in a directory no later run
would look at.

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

- A **workspace** is the working copy: cloned once, accumulated over attempts, integrated nowhere
  by the harness itself — a configured delivery step may push a passed attempt's branch and open or
  update its pull request, and never merges ([WORKFLOW.md](WORKFLOW.md) §8) — and retained while an
  issue points at it.
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
   `baseCommit`, `branch`, `createdAt`, `sourceItem` (the immutable item identity the report's
   `sourceRef` records: `type`, `scope`, `id`, and `key`), and one `attempts` entry with its
   `runId`, `outcome`, `endedAt`, and the report's new path. A ledger written without `sourceItem`
   is refused when an issue's pointer names it; see "The pointer" below.

The report keeps the path it recorded when it was written — evidence is not rewritten — so an
upgraded run's `workspace.path` points at where the clone used to be. The ledger is where the
current location lives, and `docs/WORKFLOW.md` §6 tells an operator which of the two to believe.

## The pointer

The first attempt writes the label `harness-ws-<workspaceId>` on the issue, once the workspace
exists and before any coding turn. It is written exactly once, by the run that created the
workspace; a continuation never writes a label.

The label is the only durable statement of where an issue's work lives, and it is readable by any
agent. The queue label (`harness-task`) selects work; this one records where the work is.

A label is untrusted text, so the id it names is checked before anything else happens to it: it must
be a generated workspace id (the same shape a run id has, `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`), its
resolved path must stay under `<workDir>/workspaces`, and the workspace's ledger must record the
item and the repository the workspace was created for. *Resolved* means through the filesystem, not
by the spelling of the name: junctions and symbolic links are followed, for the clone and for the
ledger read beside it, so a generated id whose directory — or whose `<workspaceId>.json` — lies
inside the workspaces directory only lexically, while reaching somewhere else, is refused before
anything is read through it. Identity is the connector type, the site, and the immutable external
id; the key is display only. A label on another item, another site, or a run against another
repository is refused, not followed.

The harness never adopts or migrates a workspace by itself. A ledger that records no source item —
written before identities were recorded, or by a run that did not come from a source — is refused
with the repair: add a `sourceItem` object to that ledger, taking `type`, `scope`, `id`, and `key`
from the workspace's own first attempt report (`sourceRef` there records them), and scan again.

The ledger is read as the record this harness wrote, not as loose JSON: its version must be 1, an
identity it records must carry all four of its fields, and every attempt entry must carry the run
ID, outcome, end, and report path that the guidance and the next attempt's number are read from, and
its recorded end must be a timestamp this harness writes (an ISO 8601 instant such as
`2026-01-01T00:00:00.000Z`): a continuation parses it as the moment it reads the item's comments
since, so a value that is not one is refused rather than parsed as `NaN` or into another day. A
record of another shape — an unsupported version, a partially written identity, an attempt with a
field missing, of the wrong kind, or ending at something that is not a timestamp — is refused before
anything is read through it, and is never repaired, migrated, or read as something it is not.

## Eligibility

| pointer labels (as the item was just re-read) | receipt | decision |
| --- | --- | --- |
| none | none | **fresh**: create the workspace, write the pointer, claim, attempt 1 |
| none | present | **refuse**: already attempted, and nothing says what to continue |
| exactly one, and it resolves on this machine | any | **continue** that workspace, attempt N+1 |
| exactly one, and it does not resolve here | any | **refuse**: the pointer names a workspace this machine does not have |
| exactly one, and it is not a generated workspace id | any | **refuse**: a label is never read as a path |
| exactly one, and its real location is not under `<workDir>/workspaces` | any | **refuse**: a junction or symbolic link leads out of the workspaces directory, and a pointer is never followed through one |
| exactly one, and the ledger records another item, site, or repository | any | **refuse**: a workspace belongs to what created it |
| exactly one, and the ledger records no source item | any | **refuse**: the workspace cannot be shown to be this issue's, and the repair is manual |
| two or more | any | **refuse**: ambiguous, and the harness never guesses which one |

The decision is made from the item as it was just re-read, never from the search result that
discovered it: a search index can lag, and a pointer added or removed between discovery and the
read must not decide where the work goes. The search result is a candidate, and the pointer labels
travel with the prepared item because they were read with it.

A refusal is published like any other terminal outcome: one comment naming the reason, and the issue
moved to the review status. Nothing local is created for it.

## Continuation rules

- The workspace is reopened, not re-cloned: same directory, same branch, and whatever the earlier
  attempts left in it — local commits and uncommitted changes alike.
- Its recorded base commit stays the base, so `changes` in the report is the ticket's whole diff, not
  just this attempt's part. The report also records what the attempt *found* (how many paths already
  differed) so the two are never confused.
- The baseline round runs on that working copy and **may be red**: a continuation of failed work is
  expected to be red, and refusing to start would make continuation useless. A baseline that could
  not be executed still stops the run, unchanged.
- Only the post-turn round decides the outcome.
- Attempts commit locally, so the branch is expected to move forward from the recorded base. The
  attempt refuses a checkout that is not on the branch the ledger records; the recorded base, not
  `HEAD`, is what the report compares against.
- A coding turn is encouraged to commit small, meaningful pieces locally as it works. Every
  attempt writes the workspace's repository-local commit identity (Nexus Agent \<nexus@local\>,
  commit signing disabled) before its checks and turns run, so a continuation commits under the same
  identity as the attempts before it.
- An attempt is recorded in its workspace's ledger as it ends. If that record cannot be written, the
  attempt keeps its report, its logs, and its working copy, its receipt records the failed path, and
  intake stops instead of climbing the ladder or taking the next issue, with no result published for
  the attempt: the next attempt's number, its tier, and its guidance are all read from that ledger,
  so none is started from one that does not hold the attempt that ran.
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

## What an attempt is told

An attempt's task text is the issue's current description — the task — plus the item's own thread:
every attempt reads it, because that is where a restarted ticket's history, another agent's
reasoning, and the harness's own result comments live. A continuation reads what was added since the
previous attempt ended; a first attempt reads the whole thread. A continuation is also told what its
workspace ledger records of the attempts before it: tier, outcome, and the reason each run ended
with. All of it is rendered, attributed, bounded (twelve lines, four thousand characters, six
hundred per line), and context for the turn. None of it becomes a command, an argument, a path, or a
limit, and none of it changes the acceptance criteria or the checks that decide the run.

## What does not change

- The harness never merges or integrates anything in the target repository, and without a configured
  delivery step it pushes and publishes nothing either. Local commits are the coding turn's own
  work: they stay in the retained workspace, and everything there — commits and uncommitted changes
  together — waits for a human.
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

**Status.** All three increments are implemented: the split layout, the ledger beside each clone, the
pointer label written once, the eligibility table with its refusals, reopening with the red-baseline
exception, the report's workspace fields; the ladder — `escalation` tiers, one attempt per rung
climbed inside a single claim, each with its own run, comment, launch, and repair allowance; and the
guidance a continued attempt is told, which is the attempts its ledger records plus the item's own
comments since the last of them, bounded, and context only.

**Known gaps, separate tasks.** The contract above is the intended behaviour, and the implementation
still has defects that these increments do not fix: the ladder can launch the wrong tier for a
continued workspace, an attempt's result is published and the issue moved to review before the
ladder is spent, and an infrastructure failure is escalated like an ordinary failed check. They are
tracked separately and are not claimed as fixed here.

## Verification

- Offline: workspace allocation and resolution, reopening a workspace whose attempts committed,
  refusal when the checkout is not on its recorded branch, the eligibility table, the
  red-baseline exception, the tier loop, the guidance rendering, the decision made from the item as
  it was just re-read rather than from a lagging search result, and the pointer checks — a malformed
  id, another item's, site's, or repository's workspace, a workspace directory or ledger whose
  resolved path leaves the workspaces directory through a junction or symbolic link (owned
  temporary fixtures, refused as a refusal rather than an exception), and a ledger with no item
  identity — all against fakes; `npm run validate` green, on Linux as well as Windows for anything
  that touches process or path handling.
- Live: **partly run, 2026-09-19.** A real Jira-driven continuation has happened: run
  `run-20260919115244-4ff8eedf` claimed HARN-2, reopened workspace `run-20260919100148-e48a9ab0`
  (same clone, same recorded base `36f62fd`, attempt 2), and the attempt's work is the local commit
  `f835c33` on that retained branch. Still **not run:** the supervised adoption of HARN-1's existing
  workspace — its first attempt recorded, the pointer label set, the issue moved back to the ready
  status, and the next attempt continuing that workspace rather than cloning a new one — and any
  live watch, restart, or failure scenario. The queue read recorded in [README.md](../README.md) is
  not this exercise either.
