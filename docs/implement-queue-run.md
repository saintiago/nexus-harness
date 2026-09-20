# The serial queue: `queue run` and `queue watch`

The earlier increments each did one thing to one ticket: `source run` claimed and ran a finite
batch, `review scan` reviewed the pull requests of In Review tickets, and the completion pass inside
`delivery.completion` carried an approved one through GitHub's own merge to a verified Jira
resolution. Between them sat a coordinator: a person (or another agent) decided which ticket was
reviewed, when the completion pass ran, and what happened to a ticket that came back.

This increment removes that coordinator from the happy path without adding a second one. One
foreground command takes the next eligible ticket, runs it, delivers it, arms native auto-merge for
the delivered head before the review can publish the final required check, has it reviewed,
completes it, prepares the checkout for the next workspace, and takes one more ticket — or waits,
visibly, for one to appear. Nothing about a single ticket's handling changes: the same runner, the
same ladder, the same review verdict, the same completion rules. What is new is the order they
happen in and who decides it.

## Commands

```sh
npm run dev -- queue run   --repo ../target-project --config nexus.config.json
npm run dev -- queue watch --repo ../target-project --config nexus.config.json
```

Both are opt-in and both are strict: the configuration the two files compose must carry the
project's `source`, the Nexus-wide `reviewer`, and a `delivery.completion` — and the loader already
requires that the review and the completion path describe the same repository, App, and check name.
(That split is HARN-24's; this document was written when both files were one.) Every existing
one-item command keeps its own option table and behaves exactly as it did; `queue run` and
`queue watch` accept `--config` and `--repo` and nothing else, and `--repo` names the checkout the
project configuration is read from.

`queue run` is finite: it ends successfully when a fresh scan finds no eligible ticket.
`queue watch` is the same loop as one visible foreground process — not a daemon, service, or
detached child — that shows an idle status, sleeps for `source.pollIntervalSeconds`, and scans
again. No agent runs while it is idle, and Ctrl+C (or Ctrl+Break) stops the wait or the active
bounded phase, starts no next ticket, and exits after cleanup.

## One ticket at a time

```text
fresh scan -> take at most one ticket -> coding attempt -> delivery -> arm auto-merge
     ^                                                                        |
     |                                       Nexus Lens review                v
     |                                            completion (merge + post-merge CI)
     |                                                |                    |
     |          Done: source readiness                |                    |  To Do: repair the same ticket
     +------------------------------------------------+                    +--> back to the coding attempt
```

The loop keeps one current ticket and one active phase. It never starts work for a different ticket
while the current one is In Progress or In Review, and coding and review turns never overlap:
`takeOneItem` prepares and claims at most one ticket per step, and the arm step, the review scan and
the completion pass are each narrowed to that ticket's immutable identity.

## Repairs, and who owns them

`request_changes` from Nexus Lens, a definitive failed required pull-request check, and a
post-merge workflow that concluded unsuccessfully all return the item to `toDoStatus` with its
workspace pointer preserved. The loop then asks for **that** ticket by identity — not for the next
eligible one — so its next attempt reopens the same retained workspace, under the same base, through
the ordinary escalation ladder, which starts again at its first tier because escalation is local to
one coding cycle. There is no second repair system: the attempt is the same runner with the same
per-rung launch and repair allowance, and the pointer label is still the only statement of where the
work lives. The loop never adopts, clears, or migrates a workspace.

The same ticket-by-identity rule covers the increment added after this one: a fresh workspace whose
baseline is completed red is diagnosed locally before any developer turn, and an actionable finding
returns it to its ready status with the comment carrying the repair guidance. The loop then carries
that ticket through its repair attempt before unrelated ready work, exactly as it does a ticket the
completion path returned ([implement-baseline-diagnosis.md](implement-baseline-diagnosis.md)).

## Source readiness, and only forward

After a ticket is confirmed Done, the next workspace needs the merged base. The loop hands the
verified merge commit to a readiness step that refuses to guess:

- the checkout must be a normal checkout, on the configured base branch;
- it must carry no staged, unstaged, or non-ignored untracked work;
- it must have a remote that names the configured delivery repository, and that remote is the one
  fetched;
- the verified merge commit must be in the fetched base branch, and the local `HEAD` must be an
  ancestor of it, so the only move available is a fast-forward;
- the move itself is `git merge --ff-only` to that commit.

Nothing there resets, forces, stashes, cleans, commits, rebases, or reconciles anything. A checkout
this step cannot prove ready stops the queue with what a person has to fix, before another ticket is
claimed.

## What stops the loop

Everything that is not a confirmed completion is an actionable, nonzero exit with the current
evidence kept: a coding attempt that failed, was cancelled, or could not be confirmed stopped; a
ledger that could not be written; a delivery failure; an auto-merge request GitHub refused (a clean
status included); a review that could not produce a usable verdict; a completion that needs a
person; a merge or post-merge CI that was still pending when its deadline expired; a checkout that
is not ready. The blocked ticket is never skipped for another one, and an infrastructure failure is
never reinterpreted as coding work.

## Restarts

Nothing about the loop is remembered between invocations, and nothing needs to be. Jira's status and
the item's own comments, the workspace pointer label, and GitHub's merged/review/check/workflow
state are the authorities; the local receipts still guard against attempting the same item twice,
and each completion comment carries its marker so a repeated pass finds what it already wrote
instead of writing it again. The recorded PR/head admission is checked against GitHub: an armed
current head is verified without a second request, a head GitHub no longer holds is re-armed, and
the completion phase resumes from the merge GitHub actually reports. A restarted queue therefore
resumes a ticket that a person or a conclusion returned to the ready status, and it does nothing at
all about a ticket that is already Done.

Before every fresh claim, including after a restart or an idle poll, the queue searches the
configured Jira project, type and label for In Progress and In Review work and re-reads each
candidate. An In Progress item stops the command with an ownership diagnostic; the queue never
adopts a possibly running consumer. Exactly one In Review item resumes its scoped review and
completion lifecycle without a coding attempt or a claim. Multiple In Review items require operator
attention. If its PR is already absent from the open list, the existing completion admission and
native merge/review/workflow evidence must verify it; absence alone never counts as completion.
Ready items with retained pointers resume before unrelated fresh work, preserving native order
among repairs. Done items are never claimed or reviewed again.

The queue obtains completion reader credentials from the same expiring GitHub App installation
authentication boundary as Lens. Every completion evidence read asks that boundary for a current
token, including after long coding turns, pending CI and idle waits. Token requests keep the
installed Lens permission set used by reviews, without adding Actions access: public post-merge
workflow evidence is read with the same token. Inaccessible evidence stops the queue for attention.
Auto-merge still uses only the operator credential. The `reviewerTokenEnv` setting remains required
by the completion schema and is stripped from child
environments, but queue mode does not require or capture its value; standalone source commands
retain their existing credential behavior.

## Limits, stated plainly

- A ticket whose pull request GitHub has already merged cannot be repaired in place by this
  harness: the delivery step refuses to edit a merged pull request, so a repair attempt after a
  failed post-merge workflow ends with that refusal as an actionable stop rather than a second pull
  request. Splitting such a repair into a new ticket is an operator decision, not something this
  loop invents.
- One queue invocation holds the connected project's intake lock under the output directory for its
  whole life, including while it waits in watch mode, so a second consumer of the same connected
  project in the same `workDir` is refused rather than interleaved, while a queue for a different
  connected project may run under the same `workDir` and harness configuration. There is still no
  cross-machine coordination, and the storage root itself is not locked.
- The loop is deterministic: it never decides that a ticket needs different work, never edits a
  ticket's text, and never reinterprets Jira text as a command, a path, a repository, or a limit.

## Verification

- Offline: the loop's ordering and outcomes (two successful tickets in the queue's own order, a
  same-ticket repair before unrelated ready work, a fresh scan after every confirmed Done, finite
  empty initial and final queues, idle polling in watch mode that starts no agent, a ticket
  appearing after an idle poll, cancellation while idle and during an active phase, pending review
  and post-merge CI, infrastructure failures, a checkout that cannot be proven ready, and restarts
  that neither rerun a Done ticket nor duplicate a completion effect); arming while the final
  required check is still pending, re-arming a repair's new head, and a restart that verifies the
  recorded arm without a second request or a second comment or transition; the consumer step's
  single-ticket behaviour, refusals, and lock handling; the arm step, review scan and completion
  pass narrowed to one ticket; and source readiness against real temporary Git repositories,
  including the dirty, diverged, wrong-remote, wrong-branch, and missing-merge refusals.
  `npm run validate` is green.
- Live: **not run.** A bounded visible-terminal exercise against the configured Nexus Jira
  repository, with a real reviewer launch and a real auto-merge, is a coordinator/operator
  verification after integration; the offline tests do not establish that path.
