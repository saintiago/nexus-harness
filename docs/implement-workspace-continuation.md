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
    locks/<connected-project-namespace>/   one consumer per connected project; owner metadata
```

- A **workspace** is the working copy: cloned once, accumulated over attempts, and local by
  default — a configured delivery step may push a passed attempt's branch and open or
  update its pull request ([WORKFLOW.md](WORKFLOW.md) §8), and the independently optional
  review-to-completion path may then arm native GitHub auto-merge, verify the configured post-merge
  workflows, and transition Jira ([spec.md](spec.md) §10, [WORKFLOW.md](WORKFLOW.md) §10) — and
  retained while an issue points at it.
- A **run** is one attempt: one deadline, one baseline round, its own turns, one verdict, one
  comment. Its report is never rewritten.
- `workspaceId` is the name of the clone's own directory under `workspaces/`, so the pointer below
  and the directory names speak the same string. A source that has a human-readable name for the
  item it took — Jira, whose canonical key is `HARN-23` — uses that key as the *preferred* name for
  a workspace a first attempt creates, so retained work is recognizable without reading a label or
  a report; a task-file run, and a source that names nothing, keep the id of the run that created
  the workspace (`run-<timestamp>-<hash>`). A preferred name is validated exactly like a pointer
  label — letters, digits, `-`, and `_` only, never a path — and a name that cannot be one is not
  used: the run's own id names the workspace instead. All of it is display naming: ownership is the
  immutable external id the ledger records, never the directory's name.
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

That label is what fixes the name: a ticket whose key changes later keeps the workspace it already
had. Its label still names it, the ledger's recorded key is display only and is never compared, and
nothing renames a directory or rewrites a label.

The label is the only durable statement of where an issue's work lives, and it is readable by any
agent. The queue label (`harness-task`) selects work; this one records where the work is.

A label is untrusted text, so the id it names is checked before anything else happens to it: it must
be a usable workspace id — a generated run name, or the key a source preferred, which is the same
shape, `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, and never a path — its resolved path must stay under
`<workDir>/workspaces`, and the workspace's ledger must record the item and the repository the
workspace was created for. *Resolved* means through the filesystem, not by the spelling of the
name: junctions and symbolic links are followed, for the clone and for the ledger read beside it, so
a generated id whose directory — or whose `<workspaceId>.json` — lies inside the workspaces
directory only lexically, while reaching somewhere else, is refused before anything is read through
it. Identity is the connector type, the site, and the immutable external id; the key is display
only. A label on another item, another site, or a run against another repository is refused, not
followed.

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
| none, and the name a fresh attempt would use is already held | any | **refuse**: something is there — another item's workspace, a directory or ledger the harness cannot read as this item's, or this item's own workspace with no pointer saying so — and the harness never adopts or overwrites it; the refusal names what holds the name and how to continue it through its pointer label, or how to move it aside |
| exactly one, and it resolves on this machine | any | **continue** that workspace, attempt N+1 |
| exactly one, and it does not resolve here | any | **refuse**: the pointer names a workspace this machine does not have |
| exactly one, and it is not a usable workspace id | any | **refuse**: a label is never read as a path |
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

- The workspace is reopened, not re-cloned: same directory, same branch, and the earlier attempts'
  local commits. Uncommitted work an earlier attempt left is the operator's to finish: the harness
  starts no coding turn from a working copy that still holds it, and a continuation whose checkout
  is dirty is refused before it is claimed (see below).
- A continuation creates no directory of its own beside the workspace it reopens: its evidence is a
  new `runs/<runId>`, and `workspaces/<workspaceId>` stays exactly the clone the pointer names.
  Allocation creates the workspace directory only for the attempt that creates the workspace.
- Its recorded base commit stays the base, so `changes` in the report is the ticket's whole diff, not
  just this attempt's part. The report also records what the attempt *found* (how many paths already
  differed) so the two are never confused.
- The baseline round runs on that working copy and **may be red**: a continuation of failed work is
  expected to be red — the work the earlier attempts committed is what the checks judge, and
  refusing to start would make continuation useless — while the uncommitted work they left is
  finished by hand first (below). A baseline that could not be executed still stops the run,
  unchanged.
- Only the post-turn round decides the outcome.
- Attempts commit locally, so the branch is expected to move forward from the recorded base. A
  checkout is returned to the branch the ledger records before every coding turn and before the
  round that judges it: a clean checkout on a branch of its own whose commit descends from that
  branch is fast-forwarded to it and checked out, the committing branch keeps its commit, and a
  detached, divergent, or branchless checkout stops before the turn or the check with the branch
  names and the manual action. The return never writes over a local file the checkout ignores: Git
  is asked not to overwrite one, a return that would is refused with the paths named and the file's
  bytes kept, and what the checkout and the fast-forward did is read back instead of taken from
  their exit codes, so a Git configuration that squashed the merge cannot pass for a returned
  branch. Nothing is reset, force-updated, or discarded. The recorded base, not `HEAD`, is what the
  report compares against.
- A coding turn starts only from the workspace's own committed state, on the recorded branch
  included: a checkout that still holds uncommitted work — staged, unstaged, or untracked — stops
  the run before that turn with the branch, the paths, and the manual action, and nothing is
  committed, stashed, or discarded for it. The round that judges a turn still reads the working
  copy that turn left, uncommitted work included: that is what the attempt is judged on, and the
  delivery step's own clean-checkout refusal is the boundary for publishing it.
- A coding turn is encouraged to commit small, meaningful pieces locally as it works. Every
  attempt writes the workspace's repository-local commit identity (Nexus Agent \<nexus@local\>,
  commit signing disabled) before its checks and turns run, so a continuation commits under the same
  identity as the attempts before it.
- An attempt is recorded in its workspace's ledger as it ends. If that record cannot be written, the
  attempt keeps its report, its logs, and its working copy, its receipt records the failed path, and
  intake stops instead of climbing the ladder or taking the next issue, with no result published for
  the attempt: the next attempt's number and its guidance are read from that ledger (the tier that ran
  each attempt before it included), so none is started from one that does not hold the attempt that
  ran.
- The workspace must not be deleted while an issue points at it.

## Attempts and escalation

One claim is one **coding cycle**. A cycle runs one **attempt per configured tier**, in order,
without an operator between them:

```json
"escalation": [
  { "name": "flash", "agent": { "runtime": "codex", "command": ["codex", "--profile", "deepseek", "--model", "deepseek-flash"] }, "maxRepairs": 2 },
  { "name": "pro",   "agent": { "runtime": "codex", "command": ["codex", "--profile", "deepseek", "--model", "deepseek-pro"] }, "maxRepairs": 2 }
]
```

- With no `escalation` field, one tier is built from `agent` and `maxRepairs`, which is today's
  behaviour.
- Escalation is local to one cycle, and every cycle starts at its first tier: a first attempt, and a
  continuation of an issue's workspace — a ticket returned to its ready status by a reviewer's
  findings, a failed required check, a delivery failure, or a failed post-merge workflow included —
  all begin there, in the same retained workspace. The workspace's own attempt count is history: it
  is what its reports and its ledger record, and it never selects a tier.
- Within one cycle, the next tier runs only after the tier before it exhausted its own repair
  allowance on an ordinary red post-agent round, and the last configured tier is the last rung. The
  tier's own launch is what that attempt starts, and what its report records: the launched command
  and the reported tier agree, continuations included.
- Each attempt is a separate run: its own run directory, report, comment ("attempt 2 of 3, tier
  pro" — the rung's position in the cycle's own ladder), and its own repair allowance.
- The issue stays in the running status while the ladder climbs: an attempt whose result may be
  published gets its own comment while nothing has moved the item, and only the climb's end moves it
  to review. Two endings deliberately publish nothing and move nothing: a run whose stopped
  executions could not be confirmed to have ended, and an attempt whose workspace ledger could not be
  written (the "Continuation rules" ledger rule above). Later attempts read the item's thread for
  themselves, so a later rung is told the comment the harness published for the rung before it.
- A run that ended before any coding turn spends no rung: a red baseline on a fresh workspace, and a
  setup, launch, authentication, or protocol failure, all end the cycle where they happened rather
  than climbing, and the next cycle — the one that follows the operator's repair — starts at the
  first tier again. The pre-delivery baseline diagnosis introduced later is not a rung either: it
  happens outside the ladder, records its finding in Jira, and hands the same ticket back to the
  ordinary first rung ([implement-baseline-diagnosis.md](implement-baseline-diagnosis.md)).
- Only an exhausted ordinary red check round climbs. A coding turn that could not finish (a launch,
  authentication, or protocol error), a round that could not be executed (a setup failure, a check
  that could not be launched), an expired limit, a cancellation, and a stop that was not confirmed
  are all the ladder's last word at the rung where they happened, and none of them starts another
  tier.
- A green post-turn round ends the intake as passed. The ladder's last attempt — a pass, a terminal
  failure, or the rung that exhausted the ladder — publishes the final result and moves the issue to
  the review status, unless it is one of the two silent endings above, which stop intake with the
  issue left where it is; the next step is another agent's or the operator's decision, taken by
  moving the issue back.

## What an attempt is told

An attempt's task text is the issue's current description — the task — plus the item's own thread:
every attempt reads it, because that is where a restarted ticket's history, another agent's
reasoning, and the harness's own result comments live. A continuation reads what was added since its
workspace's own history began — the first attempt that workspace's ledger records — and a first
attempt reads the whole thread. That window is what keeps a reviewed baseline finding in every
rung's brief: the diagnosis writes it to the thread between two attempts of the same workspace, so a
window that began at the previous attempt would drop exactly the guidance a later rung still has to
act on — and the same finding is read back from the retained evidence when the thread cannot supply
it whole. The evidence is also what says which comment is that finding: only one carrying the marker
with that exact evidence identity, and all four fields nonblank, counts — anything else is ordinary
thread context ([WORKFLOW.md](WORKFLOW.md) §11). Every rung of one climb reads the thread for itself, so a later rung is not handed the
previous rung's stale view of it — the harness's own comment for the attempt before it included. A
continuation is also told what its workspace
ledger records of the attempts before it: tier, outcome, and the reason each run ended with. All of
it is rendered, attributed, bounded (twelve lines, four thousand characters, six hundred per line),
with a reviewed baseline finding carried field by field and kept ahead of the rest, and context for
the turn. Those bounds are the context's own: a reviewed baseline finding is bounded where its turn
was accepted — up to 2,000 characters per field, on lines of its own — and is never charged against
them, so a long finding cannot spend the room the newest thing the ticket or the ledger says is kept
from ([WORKFLOW.md](WORKFLOW.md) §11). None of it becomes a command, an argument, a path, or a limit,
and none of it changes the acceptance criteria or the checks that decide the run.

## What does not change

- A coding turn never pushes, publishes, merges, or changes Jira status, and with no configured
  delivery or completion step the harness pushes and publishes nothing either. Local commits are
  the coding turn's own work: they stay in the retained workspace until a configured integration
  step acts. A configured `delivery` pushes a passed attempt's branch and opens or updates its pull
  request; the independently optional completion path may then arm native GitHub auto-merge, verify
  the configured post-merge workflows, and transition Jira, as [spec.md](spec.md) §10 and
  [WORKFLOW.md](WORKFLOW.md) §10 define.
- One consumer per connected project under an output directory; a different connected project may
  consume its own queue under the same `workDir`, and the lock is never broken automatically.
- Receipts stay local, and remain the audit trail and the second-consumer guard.
- `In Review` still means "an attempt finished and needs a decision", never success; only the
  explicitly configured completion path moves an issue to `Done`, after it verifies the merge and
  the configured post-merge workflows.
- Text from Jira is untrusted input: it is context, never configuration.

## Increments

1. **Workspaces outlive runs** — layout, resolution, reopen rules, the
   pointer label, the eligibility table, the red-baseline exception, and the report/state fields.
2. **Escalation tiers** — the `escalation` config, the tier loop inside one intake, per-attempt
   comments, and the attempt budget.
3. **Continuation guidance** — the item's thread since the workspace's own history began, with any
   reviewed baseline finding carried field by field, and the previous attempts' evidence, rendered
   into the turn's context.

**Status.** All three increments are implemented: the split layout, the ledger beside each clone, the
pointer label written once, the eligibility table with its refusals, reopening with the red-baseline
exception, the report's workspace fields; the ladder — `escalation` tiers, one attempt per rung
climbed inside a single claim, each with its own run, comment, launch, and repair allowance; and the
guidance a continued attempt is told, which is the attempts its ledger records plus the item's own
comments since that workspace's first attempt ended, bounded, and context only — except for a
reviewed baseline finding, which the turn's prompt renders as the repair that comes before the
original task ([spec.md](spec.md) §11).

**Defects fixed since, in HARN-7.** The contract above is the intended behaviour and it now holds in
the implementation: the ladder launches the tier it reports (for a continued workspace included),
an attempt's own comment is published while the issue stays in the running status (except for the
two silent endings: a stop that was not confirmed, and a workspace ledger that could not be saved)
and the review move happens only when the ladder is spent, and only an exhausted ordinary red check
round escalates — a setup/launch/authentication/protocol error, a cancellation, a timeout, and a stop
that was not confirmed each end the intake at the rung where they happened. The three defects this
section used to list are covered by the offline suite; the live exercise that has not been run is
stated under "Verification" below.

**Corrected in HARN-39.** The escalation index is now local to one coding cycle as the contract
above says. It used to be the workspace's own attempt count, so a ticket returned to the ready status
by a reviewer's findings, a failed required check, a delivery failure, or a failed post-merge workflow
resumed at the rung that count had reached — routinely the stronger tier — and an attempt that ended
before any coding turn spent a rung the developer never used. Every claim now starts at the first
configured tier in the same retained workspace, and the next tier is selected only when the tier that
ran exhausted its own repair allowance on an ordinary red post-agent round. The workspace's attempt
history is unchanged and separate: reports and the ledger still count every attempt in order, so
ledgers written before this change are read as they are, and the published attempt line names the
rung within the cycle's own ladder. The reviewer is a separate, independent selection and is
untouched by this change.

**Corrected in HARN-35.** A coding turn works with Git write access, metadata included, so it can
commit on a branch of its own and leave the checkout there. Nothing used to read that: a repair turn
started wherever the turn before it had left the checkout, and a continuation refused a workspace
whose checkout was on any other branch. Both made the safe delivery refusal — what would be
published is the recorded branch, and what the checks validated is the checkout
([spec.md](spec.md) §7) — the end of the road, and only a person could reconcile the two branches.
Now a checkout that is not on the branch its ledger records is read against what it would take to
return it: it must be clean (no staged, unstaged, or untracked path), and the commit it is at must
descend from the recorded branch's tip. When both hold, the recorded branch is fast-forwarded to
that commit and checked out before every coding turn and before the round that judges it, so a
continuation and a repair turn start on the immutable recorded branch, the commit the turn made
stays on the branch it made it on, and the revision the checks validate is the revision a delivery
step publishes. Everything else stops before the turn, the check, or the
delivery, naming both branch names and what an operator can do by hand: a dirty checkout, a
detached HEAD, a commit the recorded branch does not descend from, and a recorded branch the
workspace does not hold. A local file the checkout ignores that the return would write over stops
the run the same way — it is refused with the file's bytes kept, the paths Git named, and the
branch names — though that refusal belongs to the return, so a claimed attempt stops before the
turn or the check rather than being refused before the claim. `reopenWorkspace` reads the same
standing without changing anything, so a continuation that cannot be returned is refused before it
is claimed. Nothing here resets, force-updates, adopts a branch, or discards a commit, and the
delivery step's own exact-revision check is unchanged.

**Corrected in HARN-35, during its repair.** The first attempt above left one case open: the strict
reading applied only to a checkout that was not on its recorded branch, so a retained workspace
whose own recorded branch held uncommitted work still started another coding turn on it. A coding
turn is now started only from the workspace's own committed state: the reading a caller makes
before a turn (`BranchRead.requireClean`) refuses a checkout that holds staged, unstaged, or
untracked work — on the recorded branch included — and the run stops there with the branch, the
commit, the paths, and the manual action. `reopenWorkspace` makes the same strict reading, so a
continuation of a dirty workspace is refused before it is claimed. The round that judges a turn
still reads the working copy the turn left, uncommitted work included: the attempt is judged on
what it really left, and the delivery step's own clean-checkout refusal remains the boundary for
publishing it. A turn is therefore asked to finish with the work it wants the next turn to build
on committed, and a dirty working copy is finished by hand — the harness never commits, stashes,
or discards it for anyone.

**Corrected in HARN-35, in the repair of its delivered pull request.** The return above gained the
two protections it was still missing. Git overwrites an ignored local file silently when a checkout
writes at its path, so a checkout the harness called clean could lose a locally regenerated file
the recorded branch still tracks — the case where a turn stopped tracking that file, added it to
`.gitignore`, and left its own copy behind. The checkout and the fast-forward now ask Git not to
overwrite an ignored file (`--no-overwrite-ignore`); a return that would have written over one is
**refused** with the paths Git named and the branch names, the file's bytes are left exactly as they
were, and the run stops before the turn, the check, or the delivery that would have followed. And
what the two commands did is read back rather than assumed from their exit codes: they inherit Git
configuration and run hooks, and a `branch.<name>.mergeOptions` that sets `--squash` makes
`git merge --ff-only` exit 0 after staging the descendant without moving the recorded branch. The
merge cancels a configured squash (`--no-squash`), and a checkout that does not end on the recorded
branch, at the commit the checkout held, and clean is reported as the failure it is instead of
handing a staged working copy to the next coding turn.

## Verification

- Offline: workspace allocation and resolution, reopening a workspace whose attempts committed,
  refusal when the checkout cannot be returned to its recorded branch, the eligibility table, the
  red-baseline exception, the tier loop and its cycle-local index (a continuation whose earlier cycle
  spent the whole ladder starts again at the first tier with the returned guidance; a run that ended
  before any coding turn climbs nothing; a rung whose allowance is unspent does not hand over to the
  next), the guidance rendering, the decision made from the item as it was just re-read rather than
  from a lagging search result, and the pointer checks — a malformed
  id, another item's, site's, or repository's workspace, a workspace directory or ledger whose
  resolved path leaves the workspaces directory through a junction or symbolic link (owned
  temporary fixtures, refused as a refusal rather than an exception), and a ledger with no item
  identity — all against fakes; the naming a first attempt prefers — the ticket key as the
  workspace's directory and pointer label, the generated id when a caller has no preference or the
  preferred name cannot be one, a continuation that creates no directory beside the clone it
  reopens, the refusals a name already held draws (another item's workspace, a directory or ledger
  without trustworthy ownership, and this item's own unpointed workspace), a legacy `run-*` pointer
  reopening unchanged, and a ticket whose key changes still continuing the workspace its pointer
  names; `npm run validate` green, on Linux as well as Windows for anything that touches process or
  path handling.
  The return to the recorded branch is covered on its own: a clean branch of a turn's own whose
  commit descends from the recorded branch is returned to it — the recorded branch takes the
  commit, and the branch the turn made keeps it — while a dirty branch of a turn's own, a commit
  the recorded branch does not descend from, a detached checkout, and a recorded branch the
  workspace does not hold are each refused with both branch names and the manual action and move
  nothing. The strict reading a coding turn needs is covered too: a checkout that holds uncommitted
  work is refused whether it is on a branch of its own or on the recorded branch itself, naming the
  branch and the paths, and a continuation of one is refused before it is claimed — while the
  reading the round after a turn makes still accepts it, because what the turn left is what that
  round judges. The same coverage exists through the runner (a repair turn asked to work after the
  implementation turn left a branch of its own, a red branch of its own that stops the run before
  any check after the turn, and a red round whose uncommitted work stops the run before the repair
  turn) and through a source batch (a passed return delivered on the revision the checks validated,
  and a dirty branch of a turn's own stopped and told to the issue). The return's own safety is
  covered as well: a checkout the recorded branch would write an ignored local file over is refused
  with the file's bytes kept, the checkout and both branches untouched, and the run stopped before
  the check that would have followed the turn; and a `branch.<name>.mergeOptions` of `--squash` in
  the workspace cannot make the fast-forward report a reconciliation it did not perform — the
  recorded branch really takes the commit, the checkout ends clean on it, and the repair turn that
  follows starts there.
- Live: **partly run, 2026-09-19.** A real Jira-driven continuation has happened: run
  `run-20260919115244-4ff8eedf` claimed HARN-2, reopened workspace `run-20260919100148-e48a9ab0`
  (same clone, same recorded base `36f62fd`, attempt 2), and the attempt's work is the local commit
  `f835c33` on that retained branch. Still **not run:** the supervised adoption of HARN-1's existing
  workspace — its first attempt recorded, the pointer label set, the issue moved back to the ready
  status, and the next attempt continuing that workspace rather than cloning a new one — and any
  live watch, restart, or failure scenario. The queue read recorded in [README.md](../README.md) is
  not this exercise either. Nor has a live run claimed a ticket since the naming change: no real
  Jira workspace has yet been created under a ticket key, and no live scenario has exercised a
  held name or a changed key, so the offline coverage above is all the evidence there is for them.
