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
for one turn in its own evidence directory under
`<workDir>/baseline/<project>/<evidence>/`, bounded by the harness configuration's
`taskTimeoutMinutes` and by the intake's own stop request. It is given the
ticket, the configured commands with the results they exited with, the bounded
stdout/stderr evidence each failing check wrote, and a read-only clone of the retained workspace
pinned at the commit the baseline ran against. That evidence has to be readable before the turn is
started: a log file that is missing or cannot be read is incomplete evidence — not a check that
said nothing — and the item stays In Review with the paths named instead of being shown to a
reviewer as if the evidence were whole. A refusal reached here, or at any step before the turn,
still carries the stop the evidence's own record already holds: an earlier invocation whose reviewer
runtime was not seen to end reaches its caller as that unconfirmed stop — the intake keeps its lock
for inspection — rather than being rounded down to a confirmed one because this invocation refused
before it would have re-read the record; a record that cannot be read at all fails closed by name
the same way. It receives no coding instruction. It cannot change
the retained workspace: it runs as `exec --sandbox workspace-write` with its own working directory
(`turn/`) as its only writable root, and that launch states the policy's additional writable roots
as none and takes the host's temporary roots out of it (the runtime's own
`sandbox_workspace_write.writable_roots` as the empty list,
`sandbox_workspace_write.exclude_tmpdir_env_var` and `.exclude_slash_tmp`), so neither a `workDir`
beneath a temporary root nor a root the operator's own configuration states through that policy's
own keys can put the clone or the retained working copy inside a writable root. Those keys are not
the only place a configured launch prefix can widen a launch, so a prefix that carries a switch of
its own — `--add-dir`, `--cd`/`-C`, `--worktree`, `-s`/`--sandbox`,
`--dangerously-bypass-approvals-and-sandbox` — is refused before the turn starts: those grants are
applied beside the policy rather than through a key this launch's own values take back, so no
runtime is started under one, and the refusal is recorded on the ticket In Review with what a person
must do (probed against the installed CLI 0.154.0 with `codex debug prompt-input`: `--add-dir` keeps
its write entry even beside the empty writable-root list and the two exclusions, and `-C` moves the
working root, which is then the policy's only write entry). The clone and
the retained working copy are both checked after the turn: either one that changed produces no
finding. An `EPERM` from the sandbox is the
boundary working, not a failure of the turn. The turn's own environment also declares the snapshot a repository git
may read (git's `safe.directory` through the `GIT_CONFIG_*` variables): the sandbox runs its commands
under an identity that does not own the files on Windows, and git refuses such a repository as
"dubious ownership" before reading anything, which would otherwise leave the reviewer unable to use
the ordinary git reads this turn is built around.

**The snapshot has to be established first.** The recorded base commit is what the clone is pinned
at, so the failure can only be attributed to that tree while the retained workspace still stands at
it: a working copy whose `HEAD` has moved, or whose tracked files differ from the commit, is refused
as incomplete evidence — one In Review record naming what could not be shown, and no reviewer turn
at all. A setup or check command that rewrites a tracked fixture is therefore not diagnosed through
a clone of the old file; it has to be made to leave the repository alone first. Untracked, ignored
artifacts the configured commands generate are not part of that condition: they are not what the
clone is missing.

The phase exists exactly when the composed configuration provides that reviewer: the harness file's
`reviewer`, with the project's own `source` and `delivery`. A project without it keeps the older
behaviour, and a file-task run has no ticket to return in any case.

**What it writes.** One `finding.json`, exactly one of two shapes: an actionable finding (the
failing check, the evidence, the likely cause, and the repair guidance), or an inconclusive one
(why no repository-local repair can be named, and what a person must supply, do, or decide). A turn
that fails, is stopped, writes nothing usable, or leaves a changed clone has no finding, and is
handled exactly like an inconclusive one; when the stop that ended it was the caller's own, the
interruption is what that inconclusive record names, and it is still published. The finding file
lives in the turn's own working
directory, which is the only place the launch lets it write. The finding file decides nothing on its
own: what the turn produced is recorded as `outcome.json` beside the evidence, before anything is
published — the validated finding, or the problem that rejected the turn, with the turn's own stop —
and a restart reads that record. A turn whose own process tree could not be confirmed stopped is
never settled: the item stays In Review with the evidence and what a person must do, and the intake
keeps its lock for inspection while the runtime may still be writing. A restart that finds the
finding already on the issue reads the recorded stop back from that record before it moves anything,
instead of assuming the reviewer ended: an unconfirmed stop keeps the lock there too, and a record
that cannot be read is refused by name rather than rounded down to a confirmed one. That record
decides the move as well: the comment's marker names the evidence and never the outcome, so the item
returns for repair, and the evidence is closed as a repair, only while the recorded outcome holds
the actionable finding the marker names — an edited marker on a rejected turn cannot promote it into
one — and the finding a continuation is handed is the recorded outcome, never the turn's own
finding file, which a turn that failed, was stopped, or timed out leaves looking exactly like a
completed one.

**What happens next.** An actionable finding is recorded as exactly one comment on the issue,
carrying the marker `nexus-baseline:repair:<evidence>` and the four things above, and the issue
returns to `readyStatus` with its workspace pointer and acceptance criteria untouched. The queue
continues that same ticket before any unrelated ready work: the next claim reopens the retained
workspace, receives the finding as guidance, repairs the baseline, and carries on. That guidance
carries each field of the finding whole and on its own line rather than as one collapsed comment, and
it is in the brief of every rung of the climb that claim may take, not only the first: the collapse
used to cut off exactly the likely cause and the repair, which are the two fields a developer acts
on. The finding also carries the order it belongs in: the guidance and the coding prompt both say
that the baseline is repaired before the original task continues, so an attempt is never left to
read the repair as optional context. That finding is not context the attempt may start without: the item's own thread is its ordinary
source, and when the thread cannot supply it — a read that failed, a comment that no longer says the
whole finding, or a comment that names some other evidence — the evidence kept beside the workspace
is. The thread's comment counts as that finding only as its whole self: the marker naming the exact
evidence the retained record closed as a repair, all four fields nonblank, and every one of those
fields equal to the finding that record holds. The marker names the evidence, never the text —
anyone who can edit the issue can keep it and change a field — so an edited comment is ordinary
thread context like a partial quotation one: it is never promoted to what the attempt must repair
first, and the complete recorded finding is handed over instead. A finding that is required this way
and that nothing can supply — the retained record cannot be read back, so there is nothing to hold
the thread's comment against — starts no developer. The claimed ticket is told why on its own
thread, under the same short best-effort deadline an interrupted run's result gets, and is taken out
of the running status with its workspace pointer preserved, so it is never left In Progress with
nothing looking for it and a person decides what happens next. Nothing about that attempt is special — the same runner, the same escalation ladder starting
again at its first tier, the same checks, and the same delivery refusal for a still-red result. An
inconclusive, environmental, or unsafe diagnosis posts one
`nexus-baseline:attention:<evidence>` comment with the evidence and the required action, moves the
issue to `reviewStatus`, and stops intake for a person. No coding turn is ever started from a
diagnosis, and no repair is guessed at.

**What it never does.** It records in Jira only. There is no pull request yet, so the harness
fabricates no GitHub pull-request review, no Lens approval, and no check run for one; the delivery
step still runs only for a passed attempt, so a still-red result can never be delivered.

**Restarts.** The comment's marker is the deduplication record, keyed by an evidence identity: the
immutable item, the snapshot commit, and the configured commands with the results they produced.
The same evidence is never diagnosed twice — no second reviewer turn, no second comment — and the
local half of that record is the evidence file the phase writes before its reviewer turn:
`<workDir>/baseline/<project>/<evidence>/evidence.json` holds the item, the task, the retained
workspace, the round, and the connected project that wrote it, so an invocation that stopped after
that record was written and before the item was told
is finished by the next one instead of leaving the ticket in the running status, where a fresh scan
never looks. That resume step runs before anything is discovered or claimed, in a finite batch, a
watch scan, and a serial queue step alike, and it stops that intake when what it finds needs a
person: a pending diagnosis that cannot be finished, and one whose reviewer runtime was not seen to
end, both stop the batch, the watch scan, or the queue before anything else is discovered or
claimed, and an unconfirmed stop carries that observation all the way to the intake lock, which is
then kept instead of released. It makes only the step that is missing: the status move
for a finding that is already on the thread, or the publication of the outcome the interrupted
invocation recorded beside its evidence. That outcome — `outcome.json`, written once the reviewer
turn has ended and before anything is published — holds the validated finding or the problem that
rejected the turn, so the finding file a failed, stopped, or timed-out turn left behind is never
read as if the turn had completed. A turn that was interrupted before it wrote a finding is not run
again for the same evidence — one reviewer turn per piece of evidence is the bound — and the item
stays In Review with the retained evidence and what a person must do. An item a person moved in the
meantime is left exactly where that person left it, and its evidence is closed rather than diagnosed;
a record this harness left unfinished after it really made the move is reconciled with the finding
the item's own thread carries, so that workspace's next claim is still told it. That reconciliation
reads the recorded reviewer stop back first, exactly as a deduplicated finding does: a record that
says the runtime was not seen to end — or one that cannot be read — keeps the intake lock instead of
being settled; and the same record is what settles the closure, so a marker no accepted actionable
outcome stands behind is never finished as the repair it claims. A resume with more than one record
pending stops at the first unconfirmed shutdown
instead of spending a second reviewer turn, and a result that needs a person dominates any
actionable one beside it. One `workDir` serves
several connected projects, and the project is
part of where evidence lives: a resume, a read-back, or a closure reads this project's own directory
only, and a record that names another project is refused by name, so starting one project can never
post on, transition, or close another project's issue.

A stop that lands while the reviewer turn is running is not a window in which the ticket is
abandoned. The turn ends, and the interruption is what this evidence's one comment then records:
the item the attempt claimed is moved to `reviewStatus` with it, under the same short best-effort
deadline an interrupted run's own result gets rather than the aborted stop that ended the turn.
That one comment and one move are the whole of it — no coding turn, no repair guessed at — and an
unconfirmed reviewer shutdown keeps the intake lock exactly as it does anywhere else. A stop the
caller asked for *before* the turn began writes no diagnosis: when the invocation had already
recorded its evidence, the next invocation's own recovery finishes it; and when the stop reached the
diagnosis before anything was published at all, the ticket the attempt claimed is not left behind —
it is told on its own thread, and taken out of the running status, under the same short best-effort
deadline, so no cancellation leaves a claimed ticket In Progress with nothing looking for it.

## Modules

- `src/sources/baseline.ts` — the phase: the evidence identity, the marker, the one comment, and the
  one status move — with the intake lock kept when the reviewer runtime's own stop could not be
  confirmed, and with the interruption published under its own bounded best-effort deadline when the
  stop was the caller's own — the retained evidence record a restart resumes from — named by the connected
  project's own namespace, so one `workDir` can serve several projects — the step that finishes what
  a previous invocation left pending, reconciling a record this harness left unfinished after its
  own move with the finding the item's thread carries, and the read-back of a finding a continuation
  is required to be told: every one of those reads holds a marker against the outcome the evidence's
  own reviewer turn recorded, so a rejected turn's finding file never returns a ticket for repair,
  never closes evidence as one, and is never handed to a continuation — with the identity that
  read-back publishes, and with the whole-comment
  check that decides whether a comment of the thread is that same finding or ordinary context — and
  the one reading of a resume outcome its callers share: what stops an
  intake, and whether everything the diagnosis started was confirmed stopped, so a batch, a watch
  scan, and the serial queue cannot read the same outcome differently.
- `src/reviews/baseline.ts` — the one reviewer turn over the snapshot clone, its prompt, and the
  finding file it validates, the outcome record it writes before anything is published and reuses on
  a restart — the validated finding, or the problem that rejected the turn, with the turn's own stop
  — which a reader — the phase's marker read, its resume reconciliation, and the read-back a
  continuation is given — reads back as the one answer to what this evidence's turn really produced
  — the snapshot checks that hold the turn to the tree the checks really ran against, and the
  bounded reading of the evidence: a log that cannot be read is refused by name instead of rendered
  as a check that said nothing.
- `src/sources/jira/baseline.ts` — the Jira side: the thread, one comment, one move out of the
  running status, and whether the item is still there, over the completion path's existing helpers.
- `src/sources/jira/comments.ts` — the issue's own thread and the comments the harness posts,
  including the attention record that tells a claimed ticket why no developer was started and takes
  it out of the running status while it is still there.
- `src/sources/contract.ts` — the ordinary data between them; the guidance prefix in
  `src/runs/contracts.ts` marks a finding's lines for the coding prompt, which renders them as the
  requirement to repair the baseline before the original task — `src/sources/coordinator.ts` decides
  which ending qualifies, runs the resume step before discovery, requires the reviewed finding
  before it starts a baseline continuation, and stops intake rather than claiming another ticket
  when a resume reports an unconfirmed reviewer shutdown; `src/sources/guidance.ts` carries
  the reviewed finding the coordinator established into every later attempt of that workspace —
  never one a comment merely claims by carrying a marker; `src/queue/loop.ts` carries a
  diagnosed ticket into its repair attempt;
  `src/cli/source-command.ts` and `src/cli/queue-command.ts` compose the phase from the configured
  reviewer and the source's own statuses.

See [architecture.md](architecture.md) and [module-structure.md](module-structure.md) for where the
code lives and what owns what.

## Verification

- Offline: the phase against an in-memory thread and a scripted reviewer — an actionable finding
  becomes one marker comment and a return to the ready status, an inconclusive one becomes one
  comment and In Review, a failed reviewer turn becomes the same attention record, a stop is not
  written, an interrupt that really lands while the reviewer turn is running is recorded as the
  attention comment that moves the ticket to In Review — with the lock kept when that turn could not
  confirm its own stop, and with a restart then spending neither a second turn nor a second comment —
  and a rejected turn whose published comment was re-marked as a repair returning the item to In
  Review instead, never to its ready status, while the workspace's next claim is handed no finding
  from that turn's own file and a retained record that claims a repair beside a rejection is refused
  by name rather than believed —
  a failed comment or move moves nothing, and a thread that cannot be read starts no turn;
  the reviewer turn through the real view and the stand-in runtime, over a disposable repository
  whose failing baseline is real — the prompt carries the commands, the bounded output and the
  snapshot, the finding is validated, a missing file and a changed clone are refused, the turn is
  launched under the narrower policy in its own working directory, with the host's temporary roots
  excluded from that policy's writable set and its additional writable roots stated as none, so
  neither a `workDir` beneath one nor a root the configured launch grants can expose the retained
  working copy or the snapshot, and a configured prefix that grants a root or moves the working root
  with a switch of its own — `--add-dir`, `--cd`/`-C`, the other spellings included — refused
  before any runtime starts, with the refusal recorded as that turn's rejection and no writable
  grant ever handed to a process, a finding from a turn that wrote
  into the retained working copy is refused, a working copy the configured commands changed is
  refused before any turn, a check log that cannot be read is refused before any turn — while a log
  the command really left empty is read as a check that said nothing — and a refusal reached there
  still carries the unconfirmed stop the evidence's own record holds, while a record that cannot be
  read at all fails closed by name — and a finding an interrupted
  turn already wrote is reused without a
  second launch — published by the next pass through the phase itself, with the outcome record the
  earlier invocation wrote as its only input. A turn that writes a valid finding and *then* fails,
  stops, or times out is rejected on that invocation and on every restart after it, with its own
  finding file never read as if the turn had completed; a turn that left a finding but no recorded
  outcome is refused rather than diagnosed again; and a reviewer stop the harness could not confirm
  is reported, recorded, and carried to the coordinator, which keeps its intake lock, including from
  a resume that finds the attention comment already on the issue and reads that recorded stop back
  instead of starting a second reviewer turn; a resume that reports one stops a finite batch, a
  watch scan, and the serial queue before either discovers or claims anything, and the queue's own
  summary and final lock decision carry the flag — covered
  through the commands' real compositions, including the queue path that used to spend a coding
  turn's discovery before stopping. A retained
  record this harness left unfinished after it really moved the item is reconciled with the finding
  the thread carries, so the next claim is still told it, and that reconciliation reads an
  unconfirmed or unreadable recorded stop back before it settles anything and keeps the intake lock;
  a resume with two records pending stops at the first unconfirmed shutdown without starting the
  second reviewer turn or claiming anything; the Jira record against a fake HTTP boundary — one
  comment and a move by target status name for an actionable finding, In Review for an inconclusive
  one, the attention record that tells a claimed item why no developer started and takes it out of
  the running status while leaving one a person already moved exactly where it is, and a
  second pass that spends no second turn and writes no second comment; the coordinator's ending
  table — a completed red baseline enters the diagnosis, a setup error, a cancellation, a timeout,
  a continuation that starts red, and a post-agent red round do not, no diagnosis configured keeps
  the old publication, a red result is never delivered, and a diagnosis that reports an unconfirmed
  reviewer stop keeps the intake lock where a confirmed one releases it, as does a discovery that
  reports the same — and a stop that lands between the completed red run and the diagnosis, before
  anything was published, leaving no claimed ticket behind either: the ticket is told and taken out
  of the running status under the bounded deadline, a stop that landed after the diagnosis published
  its one comment writes no second record and leaves the missing move to the next invocation, a stop
  that lands as the pre-review thread is read takes the claimed ticket out of the running status the
  same way, and a ticket that could not be told after the stop stops intake with the claimed state
  named; the next claim through the real
  `reopenWorkspace` and a real ledger, where the developer's guidance carries both the earlier
  attempt and every field of the reviewed finding — and the requirement, asserted in the developer's
  own prompt, that the baseline is repaired before the original task continues — on a later rung of the same climb as well as on
  the first, and the finding recovered from the retained evidence when the thread cannot be read at
  all; a required finding nothing can supply — the retained record cannot be read back — starting no
  developer, with the claimed ticket told why and taken out of the running status under the bounded
  deadline even after a stop, with its pointer preserved, and with the receipt naming the same thing
  locally; the whole-comment check that decides whether a comment of the thread is the
  reviewed finding — a partial quotation and a complete comment naming other evidence both fall
  back to the complete recorded finding, a comment field edited while its marker stayed is never
  promoted to the requirement either, and a marker-carrying comment nothing establishes stays
  ordinary context and never becomes what the turn must repair first — with the finding one
  diagnosis comment carries, field by field, accepted only as its whole self; two connected projects
  sharing one `workDir` never resuming, commenting on,
  moving, or closing each other's pending evidence, and evidence that names another project being
  refused by name; the restart through the entry point a batch or a queue really uses — a diagnosis
  interrupted between its comment and its status move, resumed with no second turn and no second
  comment, and one interrupted before its comment, finished before the claim — with the ticket back
  in To Do and the claim that follows continuing the same workspace with the finding; pending
  evidence that cannot be finished
  stopping the intake for a person; an item a person moved being left alone and never diagnosed
  again; and the serial queue ordering a diagnosed ticket into its repair attempt before anything
  else; and a reviewer that never answers bounded by the configured limit instead of holding the
  intake open. `npm run validate` is green.
- Live: **not run.** HARN-34's load-sensitive baseline is the scenario for it, and the exercise —
  a real Jira ticket with a red baseline, a real reviewer turn, the comment, the return to To Do,
  the continuation with the finding, and a delivered repair — has not been performed.
