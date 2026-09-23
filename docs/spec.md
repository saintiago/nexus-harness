# Simple development harness — specification

**Baseline:** local-first, single-process. One task per run, one retained workspace that attempts may continue, independent checks, and a local report. A source invocation may start several runs, strictly sequentially; the original file-based invocation still runs one task.

**Completion exception:** the no-merge/no-Done defaults below are superseded only by the explicitly configured path in §10. The review commands themselves remain read/review-only.

## 1. Goal

Turn an explicit development task into locally checked changes, with as little coordination code as possible:

```text
Task → working copy → coding agent → checks → result
                          ↑           |
                          └── repair ─┘
```

The coding agent implements and repairs; ordinary application code decides when to check, retry the code change, or stop. The runner produces a retained working copy and a local report, not a PR, merge, or deployment: a coding turn may make small local commits in the working copy, and the harness itself never merges or otherwise integrates that work. A commit is the turn's own local arrangement of its work, never evidence that a check passed.

By default nothing leaves the machine either: the harness does not push or publish a run's changes. One optional step, enabled only by an explicit `delivery` configuration and run by the harness itself, may push a **passed** attempt's branch and open or update its pull request (§7). A coding turn never performs it, it never merges, force-pushes, or marks an issue `Done`, and everything else below is unchanged when no delivery step is configured.

Codex CLI remains the only implemented coding runtime. Allow its launch prefix to be configured so an operator can select a native profile or model without changing the runner. DeepSeek through Codex is the immediate integration target. The coding assistant used to build this repository is a separate choice.

Preserve normal local OpenAI Codex defaults. Selecting DeepSeek for the harness must not require switching the user's global default, deleting authentication, or restoring configuration before ordinary Codex use.

### Rely on Git

Git owns code history, branches, commits, and comparisons. The harness owns task execution, independent verification, and the evidence of what each run observed. Use Git's existing capabilities to show what a task changed and retain its code history.

Keep harness state limited to what execution and reporting need. A report or workspace ledger may record a Git reference or commit SHA for a concrete purpose; that does not require a parallel history model or a continuation gate based on that SHA. Additional checkpoint bookkeeping, per-attempt commit ranges, or history restrictions need an explicit task requirement rather than being defaults.

## 2. What the working version does

1. Read the task JSON, the Nexus-wide harness configuration, and the connected project's own configuration, and a local Git repository path. Validate the three inputs, compose the two configuration files into one effective configuration, normalize the optional agent selection, and keep the loaded task/configuration fixed for the run. A file that is missing, malformed, carries a field the other file owns, or cannot compose with the other is refused before anything is claimed or started.
2. Create a unique run directory. A fresh attempt clones the source repository's committed `HEAD` into a new workspace and uses a dedicated local branch there; a continuation reopens the workspace its pointer label names, on its recorded branch and base. A continuation whose checkout is clean and sits on a branch of its own whose commit descends from that branch is accepted, and the run returns the checkout to the recorded branch before its first coding turn; a checkout that holds uncommitted work, is detached, is divergent, or names no held branch is refused, with the branch names and the manual action, while nothing has been claimed. Require a clean source checkout so uncommitted work is not silently omitted. Never reset or edit the source checkout.
3. Run configured setup and checks before the agent. A failing baseline stops a fresh attempt with a clear explanation, and the source path then diagnoses it rather than parking it (§11); a continuation may start red, because its workspace may already carry failed work, and only its post-turn round decides.
4. Ask the selected agent invocation to implement the task in the retained working copy. Supply the task, acceptance criteria, and relevant target-repository instructions. Before every coding turn the checkout is returned to the branch the workspace records, when that can be done without losing anything: a clean checkout on a branch of its own whose commit descends from that recorded branch is fast-forwarded to it and checked out, and a state that cannot be returned stops the run before the turn — one that would write over a local file the checkout ignores included, refused with the paths named and the file kept. The turn starts from the workspace's own committed state: a checkout that still holds uncommitted work stops the run before the agent rather than being handed to one, and the failure names the branch, the paths, and the manual action. The turn works with a repository-local Git identity and is asked to commit small, meaningful pieces as it goes; those commits stay in the retained copy. Nothing pushes, merges, or publishes them except the optional delivery step of a passed attempt, which the harness — never the coding turn — performs (§7).
   Every coding turn is also given the ticket's conversation history: one identified snapshot, prepared before the turn under `<workDir>/workspaces/<workspaceId>.history/`, of the current requirements, the Jira thread, the pull request conversation and reviews, and the harness's own complete developer and reviewer reports. The prompt carries the current brief, the latest delivery, the complete unresolved findings with their latest responses, and the human feedback this role’s last consumed snapshot did not hold — new or edited since it — and gives the snapshot's explicit local paths for the rest; a snapshot that cannot be written stops the turn rather than starting one whose promised history does not exist. Agents read and search it locally and make no connector call of their own (§9, §11).
   The turn's runtime is launched with write access to that copy, its Git metadata included, so staging and committing are possible; the harness still makes no commit of its own.
5. Wait for the agent to finish and stop its managed mutating processes. Return the checkout to the branch the workspace records before anything reads it, so what the checks judge is the revision that branch holds; a state that cannot be returned stops the run before any check. Run setup again, then all configured checks from the harness. Agent-reported success is not a check result.
6. After an ordinary completed red check round, send observed failure output back to the same selected agent and repeat step 5 while repairs remain. A setup/launch/authentication/protocol error or timeout stops the run rather than starting a code-repair loop.
7. Save the report and retain the working copy, whether the run passes or fails. Human review and delivery happen outside this version, except for the optional delivery step: when the configuration selects one, a passed attempt is delivered after its run's report is written and before its result is published (§7).

Run checks sequentially. Ordinary nonzero check results are repair feedback; a check that could not execute is not a pass. Do not keep coding after every check succeeds.

### The ticket conversation history

A source-backed ticket gets one local conversation history, prepared by the harness before every
developer and reviewer turn and kept beside the workspace it belongs to:

```text
<workDir>/workspaces/<workspaceId>.history/
  current.json                  # points at the newest prepared snapshot
  consumed-developer.json       # last snapshot consumed by a developer turn
  consumed-reviewer.json        # last snapshot consumed by a reviewer turn
  reports/                      # the complete developer and reviewer reports
  snapshots/<snapshot-id>/
    index.md                    # the concise index: role, author, time, round, source id, commit
    index.json                  # the same index, machine-readable
    entries.jsonl               # one JSON object per entry
    entries/                    # one file per entry: provenance header, then the wording verbatim
    task.json                   # the ticket's current requirements, whole
```

An entry is identified by its source's own identity — a Jira comment id, a GitHub review or comment
id, a run or review id — so a later read that reports an edited comment updates that entry instead
of adding another, and pagination is followed to its end (a page bound that is reached is reported
as a gap, never as the whole conversation). A complete developer or reviewer report is saved under
`reports/` before the concise Jira comment or native GitHub review that renders it is published;
when that publication is acknowledged, the comment id or native review id it was published as — and
the digest of the text that was published — is recorded with the report. Synchronization recognizes
that rendering back as a mirror of the report by its recorded publication identity, never by its
wording alone: a comment that quotes a marker, or a rendering edited after publication, stays an
attributed conversational entry. The native review the harness published also names its inline
findings, so those are the report rather than duplicates beside it, while a reply stays its own
entry. Every snapshot is written under the hash of its own content: a refresh with nothing new reuses
it, a refresh with something new writes a new directory, and the snapshot a running turn was handed
is never rewritten. Feedback is compared with the last snapshot consumed by the same role,
recorded only after its turn returns a summary or verdict. Preparing a snapshot, a failed launch,
or running the other role cannot consume that role's feedback. Missing legacy cursors replay all
human feedback conservatively; a cursor write failure also permits replay. A restart uses these
local cursors, not report timestamps. Requirements are freshly read and validated before each turn;
an unreadable or invalid current requirement stops that turn. The prompt's task sections use that
same refreshed task, never a mixture with stale intake requirements. Replaying an already recorded
baseline diagnosis starts no turn and requires no new history synchronization.

On history-backed developer turns, ordinary conversation guidance comes only from that snapshot;
the bounded comment and prior-attempt excerpts collected at intake are not replayed beside it.
This holds for every repair after an edit and after feedback has been consumed. The separately
validated requirement to repair an accepted baseline finding is still passed to every turn.
Runs without a prepared history keep their existing guidance behavior.

Outstanding change requests are tracked independently by reviewer across retained and native
reviews. A later published approval by that reviewer at the current head clears their request;
another author's approval, an approval of an old head, a comment-only review or an inconclusive
verdict cannot hide it. Responses include edits to older comments after the outstanding review.
Chronological ordering and response selection compare parsed instants across Jira timezone offsets
and UTC timestamps; the original timestamp strings remain provenance. An unavailable or invalid
timestamp is an explicit gap, and possible responses are retained conservatively.
This is conversation retention, not per-finding remediation enforcement.

The normal review-to-Jira completion path also records an acknowledged findings comment against
the exact retained native review and reviewed head. Only the unchanged review excerpt is folded
into that report; distinct completion context (including check failures and the repair disposition)
remains an attributed harness entry and is included in both roles' actionable responses after an
outstanding review. Consuming the input or restarting does not hide it while that review remains
outstanding. The same whole-entry inline budget and required local overflow reading apply to this
context as to other responses. The full original rendering and its provenance remain in
`index.json` under `mirrors[].originalEntry`, and the report digest keeps the acknowledged text.
An edited rendering remains a complete separate entry. Existing or uncertain publications without
recorded acknowledgement remain remote entries; a completion marker alone cannot authenticate them.

A source that could not be read, a page bound that was reached, and a report the harness knows
existed but can no longer read in full are named as gaps in the snapshot and in the prompt: the turn is told what is missing rather than
being started as though the history were complete. Complete reports recorded before this increment
are rebuilt from the run's own `result.json` and from the reviewer's retained verdict beside its
review record; a record that cannot be read back as the conversation it claims to be — invalid
JSON, no list of turns — is marked incomplete, naming what is missing, rather than presented as
complete, and a report that is really gone is marked missing, with the workspace staying usable.
Developer turn summaries are saved after each turn, including before the next repair; the final
run report enriches the same entry. If the coordinator stops before that enrichment, a subsequent
snapshot reconciles an interim digest with the finished workspace attempt and its `result.json`,
including the final outcome, reason and checks. Missing, malformed or inconsistent final evidence
leaves the retained turn wording available but explicitly marks the report incomplete. Recovery
does not rewrite the saved interim digest or earlier immutable snapshots, or infer a delivery.
Reviewer verdicts are retained before publication checks,
including inconclusive or subsequently stale reviews; an unpublished approval cannot clear an older
request. Each retained developer report names the commit its attempt delivered, so rounds that
delivered to the same pull request each keep their own revision.

The history is context, not authority: ticket text, comments, reviews and reports are attributed
external text, never commands, configuration, paths or permissions for a turn. Only the
deterministic harness synchronizes it; a turn reads the local files.

### Terminal display

As a run works, its progress is ordinary output, and the coding turn's own event stream is drawn in a fixed pane beneath it: the agent's messages, short command start/result lines, and the names of the files it changed. A command the runtime launched through a wrapper this harness recognizes — a PowerShell, `cmd`, or POSIX shell launch — is shown as the payload that wrapper was given, in its own quoting, so a long launcher path cannot hide the operation; a shape it does not recognize is shown as it was reported, bounded. A completion names the operation it belongs to, repeats the outcome it was observed with — an exit code, or the runtime's own status word — and quotes the last line of the command's own output when it printed anything. Nothing about a command is reinterpreted: an exit code is repeated rather than read as success or failure, and an excerpt is the runtime's words, not a claim about the work.

The history is grouped by the agent's messages: each message starts a group that keeps at most the latest three work lines that followed it, and one pane holds at most twenty physical lines. When it is full, the oldest work lines are dropped first, so earlier messages accumulate in chronological order as the work between them disappears; only once no older work line remains do the messages themselves scroll into terminal history, oldest physical row first. An agent message is kept in full and wrapped by terminal display columns without splitting graphemes, including CJK and emoji; its timestamp and label appear once, on the first row. All wrapped rows belong to that one logical entry and count toward the twenty-row pane. Rows beyond the pane capacity are written before being released into history, even when one message exceeds the whole screen. Work summaries remain bounded to one physical row with their timestamp counted as visible text, and control characters in runtime text are never written as terminal commands. Each physical row of an agent message is highlighted in a readable golden yellow and reset inside the entry, so its styling cannot reach the text after it, while commands, results, and changed files stay in the terminal's ordinary color. The progress lines above the pane keep the task, the current phase, and the selected model readable: the lines the harness recognizes as startup inventory — receipt paths, immutable IDs, revisions, commit hashes, launch arguments — are condensed or left to the run log, while a line whose shape is not recognized is shown as it was written.

Every agent invocation gets a fresh pane of its own, opened by a boundary row that names the role of the phase that launched the turn — `developer` for an implementation or repair turn, `reviewer` for a Nexus Lens turn, never anything inferred from the launch or the model — and the ticket the turn works on when one is known, so consecutive panes stay distinguishable in scrollback. A new pane starts empty: no row of the invocation before it is inherited, and a repair turn is a developer invocation like the implementation it follows. Only the invocation running right now is cursor-managed; one display never draws two panes at once. A pane owns the lines it holds and nothing else: a repaint rewrites those lines where they stand — every line it writes is cleared first, so a shorter line leaves no tail, and nothing outside them is ever erased, because the display never clears to the end of the screen — and a retained row can therefore never be left standing on one line and written again on another. Lifecycle output arriving during an invocation first freezes the retained activity in place; later activity resumes below that output, with only the new segment cursor-managed. When an invocation ends — completed, failed, stopped, interrupted — its pane is finalized: the rows it retained stay exactly where the pane drew them, as that invocation's own segment of the timeline, in order, and nothing is written again before any later lifecycle event is printed or the next pane is opened. Ordinary lifecycle output is prefixed with the same compact local `HH:mm:ss` emission time, read once per emission and stamped once on each logical line, including a multi-line block, whose wording is otherwise unchanged: it is the viewer's own clock, not an event time the runtime reports, and the terminal never writes it as one. A redirected, noninteractive, too narrow, or too short terminal gets every line — the invocation boundaries included — as stamped ordinary output with no cursor or color sequence at all, and a terminal whose environment asks for no color (`NO_COLOR`) uses that same plain output without cursor or color sequences. On completion, failure, and interrupt the pane is finalized and removed before the outcome and its local paths are printed, so the terminal is left usable and the logging, outcome, and cancellation behavior of §3 and §4 are unchanged. The display is presentation only: the timeline and every turn's own output are retained in the run log and the agent logs, and nothing the pane shows is evidence or a status.

### Agent selection

The original six configuration fields remain required, split between the two files that now own them: the harness configuration carries `workDir`, `maxRepairs`, `taskTimeoutMinutes`, and `commandTimeoutMinutes`, and the connected project's configuration carries `setup` and `checks`. Preserve optional `agent` in the harness configuration, containing `runtime` and a literal `command` prefix. When omitted, use `runtime: "codex"` and `command: ["codex"]`. When present, require both fields and reject unsupported runtime values and unknown fields. Add an independent optional `source` object for intake, as defined in WORKFLOW, to the project configuration. All existing task files remain valid, and an input that still carries the retired single-file shape is refused with where each of its fields now belongs rather than read as one.

The adapter owns non-interactive execution, workspace binding, stdin prompts, structured-output parsing, and shutdown. The launch prefix may choose a Codex executable, compatible wrapper, native profile, or model. It is not a complete command or a way to replace the adapter's execution protocol.

Coding-provider credentials, endpoints, catalogs, reasoning settings, and gateway configuration remain in native runtime settings or the process environment. Do not add equivalent LLM fields to task/config JSON, provider SDKs, or an LLM gateway inside the harness. Jira connection settings belong to the project configuration's `source`; the Jira service-account API token comes only from the environment variable named by `tokenEnv`. Neither configuration file holds a credential value.

A selected runtime/profile/key that is unavailable must fail clearly. Never silently use OpenAI, switch models, try Claude, run a login flow, or choose a cheaper provider as a fallback. Reuse the same selection for all top-level turns.

## 3. Bounds and outcomes

`maxRepairs` counts additional top-level coding turns after implementation. With `maxRepairs: 2`, there are at most three turns. Internal tool calls do not each count as a turn. Session reuse cannot create extra free attempts; this change does not introduce session reuse.

The task deadline covers preparation, agent work, setup, and checks. Each setup/check command also has a timeout; remaining task time always wins. Do not restart the clock between phases or repairs. No automatic coding-run infrastructure retries or provider fallback. A runtime's own internal behavior is still bounded by the harness's deadline. Intake HTTP requests and idle polling are outside that deadline and have their own bounded waits; each actual run gets its own original task deadline.

Every Git invocation the harness makes is bounded the same way, through the one process runner. A run's own phases — the source check, preparation, and the commit identity — give a Git step the run's deadline and clock, so each reading runs under what is left of the task time when that reading starts, and the run's own stop request; a reading with no such deadline to spend — a source command's preflight, a continuation's branch check, and the final comparison the run makes once its checks have decided it — runs under a finite default bound, with the caller's stop request when there is one. A Git stopped at its bound is reported as that stop, naming which bound it was, and whether the tree it started was confirmed stopped. The consequences are the command ones: nothing runs after a stop, an unconfirmed stop is stated and leaves the copy unusable and automatic continuation stopped, and a final comparison that could not be made is a diagnostic in the report rather than a run that never finishes.

Final statuses remain:

| Status | Meaning |
| --- | --- |
| `passed` | Every configured post-agent check exited successfully for the retained working copy. |
| `failed` | Checks exhausted repairs, execution failed, time expired, or the agent could not finish. Record the reason. |
| `cancelled` | The user stopped the run. |

Missing/skipped checks cannot produce `passed`. Keep agent summaries separate from observed results. Invalid input before execution is a CLI error, not a fictional run.

On cancellation/timeout, stop owned commands and agent execution before reporting a clean stop. If termination cannot be confirmed, report the limitation, prevent further checks/repairs, and do not reuse the working copy in that run. Do not claim control over arbitrary detached or unrelated processes. A run itself still recovers nothing: an unexpected end leaves its evidence where it is, and the supervised queue of §12 is what investigates it.

A failure to retain the developer report never replaces cancellation or timeout evidence. The
harness processes the runtime's shutdown result before finalizing that failure; an unconfirmed
stop still prevents inspecting the workspace as final or releasing it for automatic continuation.

## 4. Files, not a database

Use one generated run ID, unrelated to task text, for the attempt's own evidence. A source-backed
first attempt may name the workspace it creates after the item's canonical key (Jira's `HARN-23`),
which is what makes retained work recognizable in a terminal and in the filesystem; the pointer
label names the same string, and the ledger's immutable external id remains the ownership
authority. A name something already holds is refused, never adopted or overwritten, and a continued
workspace keeps the name its pointer fixed even if the item's key changes later:

```text
<workDir>/
  runs/<run-id>/
    result.json
    logs/
      run.log
      agent-implementation.log
      agent-repair-1.log          # only when a repair is attempted
      ...                        # distinct command stdout/stderr and later turns
  workspaces/<workspaceId>/       # the retained clone, on branch harness/<workspaceId>
  workspaces/<workspaceId>.json   # the workspace ledger: base, branch, attempts
  workspaces/<workspaceId>.history/  # the ticket's conversation history and complete reports
  .intake/                        # source intake only: the per-project locks and per-issue receipts
```

The report retains task/run IDs, source path and base commit, workspace path, times, repairs used, status/reason, and check results grouped by baseline and implementation/repair attempt. Keep arguments, exit/signal/timeout information, log locations, and final change-review warnings. Never overwrite earlier failure evidence. A continued workspace reports the base its own ledger recorded, which stays the comparison base for every attempt even when the source checkout has advanced since; only a fresh run records the base that preflight selected then.

Add the effective `agent` selection (`runtime` and non-secret launch prefix) to new reports and record it once in `run.log`. This identifies what the harness launched. A profile name alone is not an observed model identity. Do not inspect runtime credential/config files in production to enrich the report.

Keep lifecycle logging concise and append-only. Command output belongs in its own files; detailed agent output belongs in a separate file per top-level turn. The JSON report references those files instead of embedding full transcripts. Never dump environment variables, API keys, or native authentication data.

The developer's complete final runtime message is retained in each attempt and its local history
report, including messages returned during shutdown. The adapter does not shorten it; external
renderings may be concise. Legacy reports bearing the adapter's truncation suffix remain explicitly
incomplete even when a Markdown copy exists. Raw logs are supporting evidence, not a reconstructed
conversation report.

Both roles also receive retained baseline reviewer outcomes from
`baseline/<project>/<evidenceId>/outcome.json`, matched by ticket identity and workspace. The accepted
outcome is authoritative; a rejected or missing outcome is never replaced by `finding.json`.
Missing or corrupt legacy outcomes are named as gaps. Baseline entries preserve the evidence ID,
reviewed commit and original JSON; unavailable round and original turn time are identified as such.
Their indexed time is explicitly labeled as the retained outcome file's modification time. A new
baseline publication records its acknowledged Jira identity and text hash for mirror deduplication.

The responses and new-human-feedback sections each inline at most 60,000 characters of whole
entries, newest first in selection. Overflow remains complete in the immutable `index.json` under
`brief.responses` or `brief.newHumanFeedback`. Prompts explicitly require reading that array before
acting, or reporting a gap if it cannot be read; even a long outstanding review cannot expand its
historical discussion without a bound. Unresolved findings themselves remain whole.

Edits to published review renderings are compared with their recorded publication hash even when
the remote API supplies no edit timestamp. Their changed text stays in the actionable responses
beside outstanding findings across refreshes, role consumption and restarts; an earlier snapshot
that held only the unchanged mirror is not evidence that a later edit was consumed. A detected edit
with no edit timestamp is conservatively included even when its review was submitted before a newer
outstanding round from the same reviewer. This applies to human reviews as well as App renderings;
the original submission time is not evidence of when the edit occurred, and no edit time is invented.

Retain files by default; cleanup is manual. A crash can leave an incomplete directory without a final report. Do not treat that as success, automatically resume it, or delete it on the next run. The user inspects/stops leftovers before reuse. Source intake adds only the local exclusion lock and per-issue receipt described below, not a transactional store, journal, or background reconciliation service.

## 5. Practical safeguards and limits

This is a trusted local developer tool, not a secure multi-tenant execution platform. A separate clone protects the source checkout from ordinary edits; it is not a sandbox.

Use only approved repositories and commands. Do not supply production/publishing credentials, interpolate task text into shell strings, or log secrets. Refuse unsafe source/output overlap. Setup and tests execute project code too; do not describe them as harmless data processing. A configured delivery step is the one deliberate exception to "nothing is published": it writes the attempt's branch and pull request to the destination repository with the operator's own Git and `gh` credentials, so configure it only for a repository and account an unattended harness may write to (§7).

Keep the command plan outside the task working copy. Instruct the agent not to weaken tests or tooling to manufacture a pass; highlight test/tooling/configuration changes in the final summary. `passed` means configured checks passed, not that every acceptance criterion is proven or the changes are safe to ship. Human diff review remains required.

The agent launcher is trusted operator configuration. Secrets are prohibited in its arguments because launch information is reportable. Use the tested platform launcher; unsupported argument/interpreter combinations must fail clearly rather than being silently altered. Do not introduce a shell-string executor or runtime permission bypass.

The harness launches every coding turn with one explicit policy, as part of the invocation rather than as something the operator has to configure: the runtime runs unsandboxed (`exec --sandbox danger-full-access`, approvals never asked), so the retained working copy — its Git metadata included — can be staged and committed. That is a documented choice, not a hidden fallback: the narrower `workspace-write` policy leaves that copy's Git metadata read-only on Windows and makes a local commit impossible. The harness itself still makes no commit of its own, and the launch is fixed for every coding turn of a run. The one turn that is not a coding turn is the pre-delivery baseline diagnosis (§11): a reviewer that must not change what it inspects runs as `exec --sandbox workspace-write` with its own working directory as the only writable root — that launch states the policy's additional writable roots as none and excludes the host's temporary roots — which leaves the snapshot it inspects and the retained working copy outside it however `workDir` is placed and whatever the operator's own configuration would otherwise grant. A configured launch prefix that carries a switch granting a writable root, moving the working root, or naming a policy of its own is refused before that turn starts, because those switches are applied beside that policy rather than through a key the launch's own overrides could take back.

The production harness must never edit global Codex defaults, install provider configuration, copy credentials, run setup/restore scripts, or log the user in/out. The setup task may create the specifically requested local profile/catalog, preserving existing files and accounts. Native configuration remains external and can be re-read by the runtime; this version does not freeze it or provide configuration isolation for untrusted repositories.

Unattended execution of untrusted repositories requires a separate isolation improvement.

## 6. Task input sources

### Boundary and scope

Keep the four-field `Task` unchanged. An external source discovers work, maps it to that exact contract, marks it as running, and publishes a concise result. Intake calls the existing `runTask`; it must not shell out to a second harness process or implement another coding loop.

Implement only Jira Cloud. Support one configured source and one explicit local `--repo` per invocation. An operator can use another config for another project later. No source array, dynamic plugins, multi-repository routing, database, broker, HTTP server, webhooks, or scheduled OS service in this increment.

The Jira queue is the configured project, issue type, label, and ready status. Fetch through the documented enhanced-search API and consume its pagination. Search can lag recent changes, so re-read an issue immediately before taking it; a search result is not a claim. [J1]

Authenticate Jira with a dedicated Atlassian service account and scoped API token. `cloudId` is required. All Jira REST calls use `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...` with `Authorization: Bearer <token>`. Do not support a direct `*.atlassian.net/rest/api` fallback or require a service-account email. The token value is resolved only for source commands and is stripped from child environments. [J5]

### On demand and watch

- `source list`: read-only preview of matching issues, invalid task descriptions, existing local receipts, and workspace pointers. Never claim, create a run, or launch an agent.
- `source run`: take one finite candidate snapshot, then automatically start one normal run per valid issue it takes — a first attempt or a continuation — sequentially. Optional `--limit` bounds the attempts it starts; no interactive confirmation is required after this explicit command.
- `source watch`: run a scan immediately, process that finite batch, sleep, and repeat until stopped. Use ordinary interval polling, default 30 seconds, not a purported Jira long-poll endpoint.

Finish discovery of a batch before changing Jira statuses. De-duplicate returned immutable issue IDs. Revalidate each candidate just before its turn; issues edited, relabelled, moved, or deleted while waiting may no longer qualify. Capture task text once for the run; later edits do not rewrite an active prompt. Never treat comments or attachments as extra instructions automatically.

Watch polls do not overlap or run concurrently with a coding batch. New work remains in Jira until the next scan; detection latency includes active run time. Re-scan the full eligible queue rather than only `created`/`updated` timestamps, so older issues made ready later are discoverable. Do not claim snapshot isolation for Jira search.

A fresh issue's first attempt still clones the source checkout's then-current committed `HEAD`. A continuation instead reopens the workspace its pointer label names and keeps the base its ledger recorded as the comparison base, so it inherits the earlier attempts' local commits; a workspace the earlier attempts left holding uncommitted work is refused before another coding turn, with the branch and the paths, rather than handed to one. Separate workspaces do not inherit each other's changes. Queue ordering does not implement dependencies, merging, or delivery.

### Issue mapping and trusted execution

Use the issue key as `Task.id`, summary as `title`, its supported description text as `description`, and the list under an `Acceptance criteria` heading as `acceptanceCriteria`. Validate the mapped object with the existing Task schema. WORKFLOW defines the small supported Jira description format.

Missing or ambiguous criteria, empty task text, or unsupported content that could hide requirements are per-issue input errors. Show them and skip that issue without a receipt, Jira mutation, or paid agent invocation; continue to other valid issues. Do not ask an LLM to infer missing fields. In watch mode suppress repeated identical diagnostics until the issue revision changes.

Repository, checks, setup, agent, and limits remain trusted local inputs. `Verification` text in Jira is context for the agent and human, not a source of executable setup/check commands. `passed` retains its existing meaning; prose criteria are not automatically proven.

### Reservation and duplicate prevention

For `source run` and `source watch`, perform existing source/output safety preflight before any output write or remote claim. Take an exclusive local lock for the connected project under the normalized `workDir`; the namespace is a stable hash of the project's composed connection identity — its source type, canonical Jira site, cloud ID and project key, and its GitHub destination repository — so one consumer per connected project is admitted while two different connected projects may consume their own queues under one `workDir` and one Nexus-wide harness configuration. No credential, local path, or display name is part of that namespace, and queue tuning (issue type, label, statuses, ordering, poll interval, base branch) does not change it. Recheck source checkout safety before each new attempt.

For each prepared valid issue:

1. Decide what it is from its workspace pointer labels and its receipt: no pointer and no receipt is a **fresh** attempt, which creates the workspace; exactly one pointer that resolves on this machine is a **continuation** of that workspace; a receipt with no pointer, a pointer that does not resolve here, and more than one pointer are refused and published like any terminal outcome, with nothing created. Identity is connector type + canonical source site + immutable external issue ID, not mutable summary, key, status, or update timestamp.
2. Exclusively create its receipt before any remote mutation or agent work; a continuation already has one and reuses it. Receipt existence means **attempt reserved**, not success.
3. Recheck eligibility and the captured issue revision, then request the transition to the configured running status. Only an unambiguously successful claim permits `runTask`.
4. Run through the unchanged runner; persist source provenance and the normalized input snapshot with normal local artifacts.
5. Record the real run ID, result path, and outcome in the receipt, then attempt remote feedback. Never turn a Jira delivery error into another coding attempt.

A claim rejected because the issue changed **before any mutation request was sent** may release only its newly created receipt and skip. After any mutation attempt, error, timeout, or uncertain response, keep the receipt and stop intake for operator inspection. A crash-reserved issue is never resumed or rerun automatically.

The lock and receipts protect the retained `workDir`: the lock admits one consumer per connected project under it, and a receipt keeps the same immutable item from being attempted twice in that directory. Jira status transitions are not a distributed lock. Running consumers on different machines, or with different `workDir`s against the same queue, is unsupported; there is no global exactly-once guarantee.

### Jira feedback and completion

Use existing workflow statuses, defaulting to `To Do → In Progress → In Review`. `In Review` means **the local attempt ended and needs human attention**, for `passed`, `failed`, and `cancelled` alike. A result comment must state the exact outcome; never represent a failed attempt as completed implementation. Do not automatically set `Done` or merge anything. Without a configured delivery step the local commits a coding turn made stay in the retained workspace; with one, a passed attempt was delivered first, and the result comment carries the pull request URL (§7). Nothing else about the changes leaves the machine.

Discover available transitions for the issue and select a unique transition by its target status, not by assuming a status ID is a transition ID. If a workflow requires additional fields or offers no unambiguous transition, report that limitation rather than changing the workflow. [J2]

Save local results first. Post one compact result comment with run ID, observed outcome/reason, check summary, repairs used, local artifact locations, and — when the attempt was delivered — its pull request URL; mark paths as local, not downloadable Jira attachments. Exclude transcripts, diffs, environment variables, tokens, and native provider configuration. Then move to review only if the issue is still in the running status; respect subsequent human status changes. Jira comments use ADF. [J3]

While an `escalation` ladder still has a rung to try, that comment is one attempt's own and the issue stays in the running status; only the climb's last attempt moves it to review, and only an exhausted ordinary red check round — one whose rung spent its own repair allowance — lets the climb continue ([workspace continuation](spec.md#2-what-the-working-version-does)). Escalation is local to one coding cycle: every claim, a first attempt and a claim that continues the workspace a reviewer's findings, a failed required check, a delivery failure, or a failed post-merge workflow returned to the ready status alike, starts at the first configured tier in that same retained workspace, and the workspace's own attempt count never selects one.

A feedback failure keeps the original local run outcome and a separate `feedback: failed` receipt entry. Record whether a comment was acknowledged before a later transition failed. Do not blindly resend comments after an ambiguous response. No automatic outbox/reconciliation loop in this increment.

### Errors, shutdown, and retries

Read-only discovery network errors, HTTP 429, and transient server errors cause `source list`/`source run` to exit nonzero. Watch retries discovery after an abortable delay, with bounded exponential backoff; respect `Retry-After` as a minimum and never shorten a server-directed wait. Authentication/authorization failures, invalid configuration/JQL, and malformed API responses stop watch. [J4]

A handled failed run can be reported and followed by the next issue, provided its owned processes are confirmed stopped. Unknown process termination, local persistence failures, ambiguous claims, and remote feedback errors stop intake. No queue activity may start another agent to repair infrastructure or report delivery.

On interrupt, stop polling and claiming immediately, cancel the active run through existing shutdown handling, and preserve artifacts/receipts. After confirmed process cleanup, allow at most one best-effort feedback sequence with a separate total 10-second deadline; do not keep the terminal alive indefinitely. Do not start a second feedback sequence when one was already attempted or its delivery is uncertain. Release only this process's lock after cleanup; leave it for manual inspection if cleanup cannot be confirmed. Forced termination may leave a lock; never delete it automatically based only on its age.

### Minimal retained intake state

Store `.intake/locks/<connected-project-namespace>/` and `.intake/receipts/<identity-hash>.json` under `workDir`, outside target workspaces. The lock directory holds its owner metadata and is never broken automatically; a project whose queue is retuned keeps the same namespace, and a different connected project holds a different one. A receipt contains source identity, reservation time, and any known real run/result/feedback details. The initial creation is exclusive; subsequent replacements are atomic. Corrupt/unknown receipt formats must fail closed, not be treated as absence. This is duplicate prevention, not a new run registry or resumable workflow engine.

An existing legacy `.intake/lock/` blocks all consumers because it records no project. Its owner
metadata or age never permits bypass or automatic removal. Operators must let that consumer stop
and inspect the lock before removing it by hand. Mixed old/new consumer revisions are unsupported:
old binaries do not recognize the per-project locks.

The lock hash uses the canonical Jira site URL, lowercase cloud UUID and GitHub owner/repository,
and uppercase Jira project key. Case variations of these provider identifiers cannot create a
second lock for the same connection. This normalization is confined to the lock identity; existing
receipt, workspace and review ownership checks are unchanged.

The workspace ledger is read the same way: it must be version 1 and hold the identity and attempt entries this harness writes, and a record of another shape — an unsupported version, a partially written identity, an attempt whose fields are missing, of the wrong kind, or ending at a value that is not a timestamp this harness writes — is refused before it is reused rather than repaired, migrated, or read as something it is not. An attempt that cannot be recorded in its workspace's ledger is a failed save, not a quiet success: its report and working copy are kept, the failed path is reported, and intake stops instead of continuing the workspace from state that does not hold the attempt.

Rework is ordinary: move an attempted issue back to the ready status and the harness continues the workspace its pointer label names — same clone, same recorded base, a new run directory and report, and a baseline that may be red. Merely editing or reopening an issue does not erase its receipt or its pointer. To deliberately start over — a first attempt in a new workspace — create a new Jira task, or stop the watcher, inspect/stop prior processes, retain the run artifacts, remove the pointer label, remove only that issue's receipt, and restore its ready status. Preserve `.intake` when cleaning old run directories.

## 7. Optional GitHub delivery

Delivery is a harness/operator operation, off unless the connected project's configuration selects it, and it never runs a coding turn. It is configured by one optional strict `delivery` object in that project's own configuration — the only implemented type is `"github"` — and an absent object means the local-only behavior described everywhere else ([WORKFLOW.md](WORKFLOW.md) §8).

After a **passed** attempt, and before that attempt's result is published, the harness delivers the working copy the run left:

1. A working copy that still holds uncommitted work — staged, unstaged, or untracked — is refused. Nothing is committed, stashed, or discarded on the turn's behalf; the failure names the paths and says what to do.
2. A working copy that is checked out at a revision other than the tip of the workspace's own recorded branch is refused as well. What the checks decided is the working copy that is there, and the recorded branch is what would be pushed, so publishing it would deliver a revision the checks never validated. Nothing is switched, adopted, committed, or force-pushed on the attempt's behalf, and the failure names both revisions. An ordinary local branch at the same revision is not itself a mismatch. The run itself returns a clean checkout to the recorded branch before the checks that judge it (§2, step 5), so in an ordinary run the two revisions agree; this refusal is the boundary for a checkout that could not be returned, which the run has already stopped on before any check.
3. A branch with no commit beyond the workspace's recorded base is not delivered. A passed attempt that changed nothing has nothing to publish, which is reported rather than turned into a delivery to make.
4. Otherwise the workspace's own branch is pushed to the configured destination repository, as it is and never with force.
5. The pull request is found in that repository by head branch and base branch, whatever its state, and its native state decides what happens: one **open** match is updated, one is created only when no match exists at all, and a match that is `CLOSED` or `MERGED` — like two or more open matches — is refused instead of edited, so an attempt is never reported as delivered when no open review received its work. A created or updated pull request carries the same body: the item's reference and URL, the task, the actual check summary, and the run ID.

The published result comment then carries the pull request URL, so Jira links to what was delivered.

Delivery never merges a pull request, never marks an issue `Done`, never force-pushes, never rewrites a run's report, and keeps no delivery database: GitHub is the record of whether a pull request exists.

A delivery failure is not a coding failure. The run's own report, logs, and check evidence stay exactly as they were written; the receipt records the delivery problem; the issue is told the run's own outcome with the failure beside it and moved to review when Jira is reachable; and intake stops for a human. No coding turn is started to repair a publishing failure. Retrying the publication is an operator step with ordinary `git` and `gh` in the retained workspace — check GitHub first, because a push or a creation that reported a failure may already have taken effect — and returning the issue to the ready status is code rework, not a delivery retry ([WORKFLOW.md](WORKFLOW.md) §8).

Delivery applies to a source-triggered attempt, whose workspace and branch survive across attempts. A file-task run creates a fresh clone and branch every time, so there is no stable branch to deliver and `run --task` stays local even when the object is configured.

Delivery uses the operator's own Git and `gh` authentication; the configured repository and base branch are trusted local inputs, like the configured commands, and no GitHub credential is stored by the harness. A destination the harness cannot write to fails with what Git or `gh` said rather than falling back to anything else.

## 8. Scope

Support local file tasks and configured Jira intake through the same implementation/check/repair
lifecycle. Keep delivery, review and completion optional. Commands that do not use a provider
must not require its credentials. Use the selected coding runtime without altering the user's
provider account or global settings.

Retain work, logs and observed outcomes across attempts. Preserve the source checkout and respect
exclusive workspace ownership. Additional sources, runtimes, parallel consumers or recovery
capabilities require explicit requirements rather than placeholder infrastructure.

## 9. Optional Nexus Lens reviews

Review is off unless one optional strict `reviewer` object in the Nexus-wide harness configuration selects it, composed with the connected project's own `source` and `delivery`. With it, `review scan` and `review watch` read the tickets that project's Jira connection reports as being in review, identify each ticket's open pull request in the repository its project delivers to, ask an explicitly configured reviewer launch for a verdict, and publish that verdict as one native GitHub review plus one app-owned check run. Without it nothing changes: no GitHub App credential is resolved, GitHub is never contacted as an App, and no reviewer turn runs. The commands' inputs and defaults are [WORKFLOW.md](WORKFLOW.md) §9.

### Eligibility and the pull request link

The review queue is the configured project, issue type, and label in the configured review status. Each ticket is re-read and mapped exactly as intake maps it, so the reviewer receives the ticket's own intent and acceptance criteria; the pointer labels the read observed decide where its work lives. When the output directory holds the ticket's intake receipt, that receipt must record a passing attempt: a receipt whose last recorded attempt ended `failed` or `cancelled`, a reservation with no finished attempt, and a receipt that cannot be read are reported for coordinator attention rather than reviewed, because an approval of an earlier pull request would present unsuccessful work as code awaiting approval. A ticket this machine never attempted has no receipt, and is reviewed from the repository view below alone; one whose pointer names no workspace that is on this machine, or whose workspace cannot be pinned at the pull request's head, is reported for the coordinator instead of being reviewed. A review then needs one clearly identified open pull request: exactly one valid `harness-ws-<workspaceId>` pointer label, and exactly one open pull request in the configured repository whose head branch is `harness/<workspaceId>`. A missing ticket read, no pointer, a pointer that is not a usable workspace id, more than one pointer, no open pull request, and more than one match are reported and left alone: nothing is reviewed, no review or check is published, and the ticket stays in review for the coordinator.

### What one review is

Before looking up that branch's pull request or reconciling an existing review's check, the scan
validates the retained workspace with the same read-only resolution used by intake. The workspace
and its ledger must resolve inside the workspaces directory, and the ledger must record this
ticket's source type, site and immutable issue ID; its display key may have changed. The recorded
source repository must also match the connected project root when the caller supplies it. A
missing, malformed or mismatched ledger requires coordinator attention: no view, reviewer turn,
review or check is produced, and the ledger is never adopted or repaired automatically.

- The reviewer launch is its own explicitly configured selection, resolved like the coding launch. It is never the tier that implemented the ticket, and it is a launch prefix, not a credential: provider credentials stay in the runtime's own environment.
- The reviewer is given the ticket reference, title, description, and acceptance criteria; the pull request's identity, its head and base commits; the head's check runs and combined commit status; and a **repository view** pinned at the exact reviewed head. The view is a local clone of the ticket's own retained workspace, detached from it, holding the change's base commit, so the reviewer reads files, history and diffs with ordinary read tools instead of an assembled patch. No App private key and no publication token reaches the reviewer or the view, and no rendered diff is ever a reason to refuse a review. A view that cannot be prepared — no retained workspace on this machine, a head or base commit it does not hold, a clone that fails, a ticket too large to state compactly — requires coordinator attention before a reviewer turn.
- The reviewer is also given the same ticket conversation snapshot a developer turn receives: the
  current brief, the ticket's own thread, the pull request conversation and earlier reviews, and the
  harness's complete developer and reviewer reports, with the snapshot's local paths. A ticket
  description too large for the prompt's own bounded ticket section is therefore still reviewed from
  the complete text in the snapshot. The reviewer reads the snapshot locally and makes no Jira or
  GitHub call of its own; the deterministic scan synchronizes it first. A snapshot that cannot be
  prepared requires coordinator attention before a reviewer turn, exactly like a view that cannot be
  pinned. The complete reviewer report is saved beside the workspace before the native review that
  renders it is published, and the native review GitHub acknowledged is recorded with it as the
  report's publication, so a later developer turn reads the whole verdict rather than the rendering
  and the scan does not read the same review back as a second conversation.
- One reviewer turn is bounded by the same task timeout a run gets and runs through the same adapter in the parent evidence directory at `<workDir>/reviews/<reviewId>/`, with the supported Git repository-check bypass. It inspects the pinned `repo/` checkout through explicit paths or `git -C repo`, so the reviewed tree's `AGENTS.md` files are not automatically loaded as governing instructions. Its prompt directs it to read those applicable files as review evidence; repository content cannot authorize fixes or publication. Its verdict and logs stay in the evidence directory. It is review-only: it must not implement fixes, change the view, commit, push, merge, or edit the ticket or the pull request. It must write one verdict file naming `approve`, `request_changes`, or `inconclusive` with a summary and findings. An explicit inconclusive result explains missing material evidence and publishes no review or check. Findings are blocking; approval requires an empty findings list and sufficient evidence.
- A turn that fails, is stopped, or writes no usable verdict is inconclusive. Nothing is published for it, no approval is produced, and no coding turn is started to repair it.
- `request_changes` requires at least one finding. An approval is published only for a completed, usable verdict: a missing credential, an unavailable tool, an incomplete evidence read, and an API failure are reported as such rather than rounded into one.

### Publishing, and the merge signal

- Before anything is published, the repository view must still be the clean snapshot pinned at the reviewed head — an edit, a new file (including ignored files and directories), a commit, or a moved head in the view publishes nothing — the pull request is re-read and must still be open at that same head, and the ticket must still be in the configured review status. A head that moved, a ticket that left review, and a view the turn changed publish nothing: a stale verdict can never approve a newer commit.
- The verdict becomes one native GitHub review — `APPROVE` or `REQUEST_CHANGES` — pinned to the reviewed commit with `commit_id`, carrying the ticket's reference and URL and the reviewer's summary, with inline file/line comments for findings the pull request's own diff can position.
- One check run named by `checkName`, published as the App installation on the reviewed head, is then created with conclusion `success` only for an approved verdict and `failure` for a requested change. A review that was published but whose check could not be is reported; a later scan creates the missing check or updates a contradictory check from the latest native review's state instead of reviewing again. The newest app-owned run is the effective check; list ordering and older successes cannot override a later verdict. Truncated native review/check lists are refused. Check reconciliation also revalidates the ticket and head before writing.

The smallest native signal that identifies Nexus Lens is that app-owned check run: a branch rule should require it from this App, together with the repository's CI check. A generic requirement of one approving review does not identify the App. Merge execution, auto-merge, Jira completion/rework decisions, and CI observation remain outside this increment: the coordinator enables auto-merge where supported, verifies the merge outcome, marks an issue `Done` only for confirmed integration, and returns code changes, CI failures, and conflicts to the ready status with the retained pointer and the concrete findings. A pending CI run and an infrastructure or authentication failure stay in review for diagnosis and do not trigger code repair.

### Deduplication and retained evidence

A head that already carries a completed review by the App's configured login whose `commit_id` is that same head is not reviewed again, and no reviewer turn is started; a later commit is a new head and is reviewed again. That native review metadata is the deduplication record: there is no check registry, delivery database, local lock, or second coding consumer. Each reviewer turn keeps its evidence (`input.md`, `reviewer.log`, `verdict.json`, and `review.json`) under `<workDir>/reviews/`, beside the view it inspected (`repo/`), the scan appends one line per outcome to `<workDir>/reviews/review.log`, and nothing is published into a working copy: a finding the pull request's own patch cannot position is stated in the review body rather than dropped. The scan never changes Jira: it claims and transitions nothing, posts no comment, and never marks an issue `Done`.

## 10. Optional review-to-completion

Completion is a second, independently optional step: one project's `delivery.completion`, composed with the Nexus-wide `completion` policy. Absent means §7 alone and an In Review item waits for a person. Present, it carries reviewed source work from an approved pull request through **native GitHub auto-merge** and the configured post-merge workflows on `main` to a verified Jira resolution, without a coordinator or a coding turn in between. It changes nothing about the blanket no-merge/no-`Done` rule above for a configuration that does not enable it.

The two files own one half each: the harness configuration names the Nexus Lens reviewer (`lensApp`, `lensAppId`, `lensCheckName`), the environment variable holding that reviewer's own credential (`reviewerTokenEnv`), and the polling bounds; the project configuration names at least one expected post-merge workflow (`postMergeWorkflows`) and the two Jira statuses an item can end in (`toDoStatus`, `doneStatus`). A project completion without the harness policy, an empty or missing workflow list, a reviewer identity that disagrees with the configured reviewer, or a status that is not distinct from the review status or from the other outcome is refused rather than treated as evidence.

The reviewer's credential is deliberately a different environment variable from the operator's `gh`/Git credential. The reviewer's token reads the reviewer's verdict and never enables auto-merge; the operator's credential authenticates the one per-pull-request arming request and never reaches the reviewer. The harness never merges, force-pushes, reruns a workflow, or bypasses protection: `enablePullRequestAutoMerge` with `mergeMethod: SQUASH` asks GitHub to merge once branch protection and every required check allow it, and only GitHub's own merged state is trusted.

The serial queue arms native auto-merge immediately after it delivers or updates the pull request and before its review phase publishes the final required check. That ordering is what makes arming possible: GitHub refuses to enable auto-merge for a pull request whose required checks are already clean. The arm step records the exact pull request and head, verifies or re-arms a repair's new head before that head is reviewed, and verifies the recorded arm on a restart instead of sending a second request. Branch protection remains authoritative: arming asks GitHub to merge only when every required check and rule allows it, and a failed or `REQUEST_CHANGES` Lens check keeps the pull request blocked.

One pass reads the In Review items of the configured queue and, for each of them, the single open pull request its workspace pointer's branch has. It proceeds on an approval from the configured reviewer on the **current** head, backed by a successful check of the configured name on that same head; the head is re-read immediately before every mutation. It then:

1. Verifies the native auto-merge request recorded for the approved current head — arming it when the queue did not already, or when GitHub no longer holds one — and waits, bounded by its interval and deadline, for GitHub to report that exact pull request **merged**, with the approved head as its source, the configured base branch, and a merge commit SHA. An armed request, pending pull request checks, a closed pull request, or an absent branch is not a merge.
2. Requires every configured post-merge workflow to have a run for event `push`, on the configured base branch, for that exact merge commit SHA; the **latest attempt** must be completed with conclusion `success`. A run that has not appeared, or is queued or in progress, is pending and waits; a deadline that expires with work still pending posts one attention comment and leaves the item In Review.
3. Posts one resolution comment of at most 120 words naming what was delivered or concluded, the successful post-merge main workflow, material limitations, and the pull request and workflow links, and then moves the item to `doneStatus` through native transition discovery.

Every completion mutation and every ambiguous answer is reconciled against one fresh read of the pull request before it is classified, because GitHub can merge the reviewed head between two reads of the same pull request: an unprocessable or no-longer-eligible auto-merge refusal is settled by that read, and so is a gate reading of a pull request that has just merged. A merge of the exact expected head continues through post-merge verification without a second arm and without a person, and its merge commit is the one the resolution names. A closed and unmerged pull request, a head that moved away from the reviewed one, and a merge that cannot be tied to the reviewer's approval on that head are terminal: never retried, never read as a merge, and reported for a person with the pull request, the heads, and any merge commit as evidence. Only a read GitHub could not answer this moment — a server failure, a rate limit, a timeout — is retried, with the poll interval as backoff and the item's own deadline as the bound; a request that would change state is never replayed. That covers every reading the pass takes around a mutation — the reading that settles an auto-merge answer as well as the reading that settles the approval — and the required-check answer too: `gh pr checks` reports a red or pending check through its exit code, so a command that wrote no check result is classified from what it wrote and read again, never read as a failed check.

A read the harness itself stopped at its command limit counts among the reads GitHub could not answer — it is recorded as `timed-out`, and a stalled command may leave no diagnostic line at all — while a read the caller's own stop ended is not retried. The reads that guard the resolution comment and the status move are bounded by the item deadline the pass already holds: neither write mints a fresh completion budget after it has passed. A merge that GitHub makes in a window where the pass never requested auto-merge is recorded as the same PR/head admission before the pass verifies it or writes anything for the item, so a restart resumes the merge and its already-written comment instead of leaving the item unresolvable; a record of that exact PR/head already there keeps the wait start it carries, and a merge whose identity cannot be recorded is reported for a person rather than concluded.

A current-head `REQUEST_CHANGES` decision from that reviewer, a definitive failed required PR check, and a post-merge workflow that concluded unsuccessfully are conclusive findings: one concise comment naming the review or the failed check or workflow with its conclusion and link, and the item returns to `toDoStatus` with its workspace pointer untouched, so the ordinary source consumer may take the next repair attempt. A merge that GitHub has already made is never rolled back.

Everything else — missing or inconclusive review evidence, an approval or a check on another head, a closed or ambiguous pull request, a conflict, a refused auto-merge, an authentication or permission failure, a check whose relationship to a decision is unclear — is reported for operator attention and left `In Review`. A person's status change is respected: an item that left the review status is not touched. Recovery is deterministic and agent-free: GitHub's merged state and the configured post-merge runs are authoritative, comment markers in the item's own thread are what prevents a second comment, and a status move is made only while the item is really still in review, so a restart retries only what did not happen. Nothing here starts a coding turn.

A pass keeps the commands it runs under `<workDir>/completion-logs/<identity-hash>` and creates that directory before its first GitHub read, so a fresh or restarted pass never runs a command whose log directory is missing. A directory that cannot be created is an attention result naming the location: nothing is armed and nothing is written in Jira.

Completion evidence and auto-merge admissions use a hash of the source type, canonical site,
immutable item ID, and lowercase GitHub owner/repository. Equal Jira IDs from different sites or
destinations cannot share logs, temporary files, admissions, or restart deadlines. A legacy
`completion-logs/<issueId>` path has no trustworthy connection identity and stops the item for
manual reconciliation before any GitHub command or Jira write. It is never adopted, overwritten,
or silently treated as a fresh admission; inspect its ownership and preserve active recovery
state before moving that old directory aside.

## 11. The serial queue

`queue run` and `queue watch` are opt-in and composed only from the paths above: the Jira source and retained-workspace runner of §6, the delivery step of §7, the Nexus Lens review of §9, and the review-to-completion pass of §10. Without them, every existing command keeps its own behaviour and its own options; the queue's own commands accept `--config` and `--repo` and nothing else. The loop is ordinary deterministic code: the only agents it can start are the coding turn the configured runner already starts and the reviewer turn the configured review already starts.

### One ticket, one phase at a time

The loop keeps one current ticket and one active phase. It takes at most one ticket from a fresh scan of the configured ready queue, in the Jira order the source's own `ordering` selects (Jira's Priority field by default, or the board's native Rank), runs its coding attempt and the delivery step, arms native auto-merge for the delivered head before the review can publish the final required check, reviews that ticket's pull request with the configured reviewer, and carries the delivered pull request through §10 to a verified resolution or back to the ready status. An `ordering` change is read by the next fresh scan only: it never interrupts or reorders an active ticket, a same-ticket repair continuation, or a batch Jira already returned. It never starts work for a different ticket while the current one is In Progress or In Review, and coding and review turns never overlap: the arm step, the review scan and the completion pass are narrowed to the ticket's immutable identity, and no phase is started before the previous one has finished.

Both phases prepare the same ticket conversation history through the same readers: the coding turns
of the consumed ticket write their complete developer reports before the result comment is
published, and the reviewer turn prepares a snapshot over that history and writes its complete
verdict before the native review is published. A repair cycle therefore begins with the complete
findings and the latest human feedback in the prompt, and neither phase needs a Jira or GitHub call
of its own for them (docs/WORKFLOW.md §9).

  ### Repair before unrelated work

When the review requests changes, a required pull-request check has definitively failed, or a configured post-merge workflow concluded unsuccessfully, §10 returns the item to its To Do status with its workspace pointer preserved. The loop then continues **that** ticket by identity: the next attempt reopens the workspace its pointer names, under the recorded base, through the same runner and escalation ladder — which starts again at its first tier — and reviews the head the repair delivered. Unrelated ready work waits until the current ticket is confirmed Done. The loop does not clear, adopt, migrate, or replace a workspace, and it does not implement a second repair system.

### A completed red baseline is diagnosed, not parked

The one ending that used to leave a claimed ticket with nothing to carry is a fresh workspace whose
baseline is red: every setup command succeeded, the configured check round completed with a nonzero
result, and no coding turn ran. The source path hands that attempt to the configured reviewer — the
Nexus-wide selection, never a coding tier — for one bounded local turn before any developer turn. The
reviewer receives the exact source snapshot (a read-only clone of the retained workspace, pinned at
the commit the baseline ran against), the configured commands, and the bounded stdout/stderr each of
them wrote, together with the ticket's own conversation snapshot when one can be prepared — the same
organization and local paths a developer or review turn is given, so a thread that explains the
failing baseline is in hand; a snapshot that cannot be prepared starts no diagnostic turn and leaves
the item In Review with the paths named. It receives no coding instruction, may inspect that snapshot
with its normal local tools,
and cannot change the retained workspace it was cloned from. That recorded evidence has to be
readable before the turn starts: a log file that is missing or cannot be read is incomplete
evidence, not a check that said nothing, and leaves the item In Review with the paths named instead
of showing a reviewer a rendering that would pass for a silent command. The turn runs under a narrower
filesystem policy than a coding turn — it may write only inside its own working directory, where its
one `finding.json` goes, and that launch states the policy's additional writable roots as none and
takes the host's temporary roots out of its writable set — so the snapshot and the retained working
copy are read-only to it however `workDir` is placed and whatever the operator's own configuration
would otherwise grant. A configured launch prefix is refused rather than trusted where the launch
cannot take its grant back: a prefix that carries `--add-dir`, `--cd`/`-C`, `--worktree`,
`-s`/`--sandbox`, or `--dangerously-bypass-approvals-and-sandbox` — a writable root, a working root,
or a policy of its own — starts no reviewer turn at all, because that launch's own arguments only
state the policy's configuration keys and those switches are applied beside them; the refusal is
recorded on the ticket In Review with what a person must do, exactly like any other reviewer turn
that produced nothing usable. After a turn that did run, the harness verifies that the
snapshot is still pinned and clean and that the retained working copy is exactly what it was before
the turn. The
snapshot has to be established before the turn: a working copy whose recorded base commit has moved,
or whose tracked files the configured commands changed, cannot be shown to be the tree the failing
check really ran against, and is refused as incomplete evidence instead of being diagnosed from a
clone of the wrong tree. It writes one structured finding: either the failing check, the evidence,
the likely cause and the repair a later coding turn can make, or why no repair may be made
automatically. Every field of that finding is nonblank and bounded, and the bound is enforced by
refusing a finding that runs past it rather than cutting a field down to it: what follows the bound
can be the change the repair has to make, and nothing keeps a second copy of what the turn wrote.
Its own environment carries git's declaration that the snapshot it was given is a
repository git may read, because the sandbox runs the turn's commands under a different identity on
Windows and git would otherwise refuse that repository outright.

An actionable finding produces **one** concise Jira comment naming those four things, and the same
ticket returns to the status it was claimed from with its workspace pointer and its original
acceptance criteria preserved. The comment is a rendering of that finding and not its width: its
own lines are bounded, while the finding a developer is handed is not cut to them. The loop then
continues that ticket — before unrelated ready work —
and the next claim reopens the same retained workspace, is told the original task *and* the reviewed
finding as guidance — each field of the finding whole and on its own line, at the width the
reviewer's finding was validated at, and on every rung of the
ladder the returned ticket climbs, not only the first — and that finding is never charged against
the bounds the rest of the guidance is kept to, so it cannot spend the room the newest feedback the
ticket carries — the review of a repair that was delivered — is read from. The attempt repairs the
baseline first, and only then
continues the original task. That ordering is stated, not left to inference: the guidance carries
the requirement that the baseline is repaired before the original task continues, and the coding
prompt renders those lines as a requirement of this attempt rather than as ordinary context. That
finding is not context the attempt may start without: it comes from the item's own thread, and when
the thread cannot supply it — a read that failed, a comment that no longer says the whole finding,
or a comment that names some other evidence — from the evidence kept beside the workspace. Only a
comment that carries the marker with the exact evidence identity the retained record closed as a
repair, all four nonblank fields, and *every one of those fields equal to the finding that record
holds* is that finding: the marker names the evidence, never the text, so a partial quotation, an
edited comment, or a marker without an identity is ordinary thread context, never promoted to what
the attempt has to repair first — and what that record holds is the accepted outcome of the
reviewer turn, not the finding file a rejected, stopped, or timed-out turn may have left behind, so
a workspace is returned for repair and hands a finding on only while the recorded outcome is the
actionable one the marker names. A required finding nothing can supply — the retained record cannot
be read back, so there is nothing to hold the thread's comment against — starts no developer: the
claimed ticket is told why on its own thread, under the same bounded best-effort
deadline an interrupted run's result gets, and is taken out of the running status with its workspace
pointer preserved, so it is never left In Progress with nothing looking for it and a person decides
what happens next. An evidence directory this harness kept whose own record is gone is not "nothing
pending" either: nothing about it can be resumed, read back, or closed, and it may be the record
that returned a workspace for repair, so intake stops for a person — naming the directory — instead
of being passed over or claimed on as an ordinary continuation. That attempt is an ordinary one: the
same runner, the same escalation ladder
(which starts again at its first tier), the same checks, and the same delivery refusal for anything
that is still red.

An inconclusive, environmental, or unsafe diagnosis, a reviewer turn that produced nothing usable, a
baseline that could not be executed, a command that could not be launched, a cancellation, and an
expired limit all leave the item In Review with the evidence and what a person must do; none of them
starts a coding turn, guesses at a repair, or returns the item for one. A setup failure, a missing
host tool, a launch error, a cancellation, and incomplete evidence are never diagnosed as if they
were a red round: only a *completed* round whose setup commands all succeeded qualifies. A
cancellation that lands while the reviewer turn is running is recorded rather than dropped: the
ticket the attempt claimed still gets that one comment and that one move to In Review under the
same bounded best-effort deadline an interrupted run's own result gets, so it is never left In
Progress with nothing looking for it — and an unconfirmed reviewer shutdown still keeps the intake
lock there. A cancellation that reaches the diagnosis before it published anything is no more of a
stranded claim: the ticket the attempt claimed is told on its own thread and taken out of the
running status under the same bounded best-effort deadline, so no cancellation leaves a claimed
ticket In Progress with nothing looking for it.

This pre-delivery diagnosis is recorded in Jira only. There is no pull request yet, so nothing is
reviewed, approved, or checked on GitHub for it; the harness fabricates no pull-request review, no
Lens approval, and no check run. The marker inside the one comment is the deduplication record: a
diagnosis that finds the same evidence again — the same immutable item, the same snapshot, the same
configured commands with the same results — starts no second reviewer turn and writes no second
comment, and completes only the step the earlier pass had not made: the status move for a finding
that is already on the thread. That step is the one the accepted outcome asks for, not the one a
marker names: evidence is closed as a repair, and a ticket returned to its ready status, only while
the documented outcome holds the actionable finding the marker names, so a comment whose marker was
edited onto a rejected turn can never promote it into a repair — and a workspace whose evidence was
closed for a repair without that outcome, or with a rejection beside it, hands no finding on and
starts no developer from the turn's own file. That record, one per piece of evidence, is written
before anything is published and holds either the finding the turn produced or the problem that
rejected the turn — so the turn's own finding file is never read as if a failed, stopped, or
timed-out turn had completed, and a diagnosis that finds a recorded outcome replays it instead of
spending a second reviewer turn. A reviewer turn whose own process tree could not be confirmed
stopped is never settled: the item stays In Review with the evidence and what a person must do, and
the intake keeps its lock for inspection — and when the same evidence is diagnosed again, that
recorded stop is read back from the evidence before anything is moved instead of a stop being
assumed. The evidence is kept per connected project — `<workDir>/
baseline/<project>/<evidence>/` — and a record that names another connected project is refused by
name rather than read, finished, or published through this one, so two projects sharing one output
directory never act on each other's evidence.

An item a previous invocation left in the running status is an interrupted episode, and the
exceptional recovery of one is not the ordinary loop's: no `source` or `queue` command discovers,
finishes, comments on, or moves it, and none guesses what a retained record holds. That episode is
the supervised queue's recovery agent's to investigate and reconcile (§12) — the item, its retained
evidence and workspace, and the fact that the worker stopped unexpectedly are exactly what the agent
is given — and until one acts, the item stays In Progress with its retained evidence, visible in
Jira to whoever looks. A reviewer turn that was interrupted before it wrote a finding is not run
again for the same evidence on the ordinary path: the recorded evidence and what a person must do
stay where they are, and an item a person has moved in the meantime is left exactly where that
person left it.

### Source readiness between tickets

After the current ticket is confirmed Done, and before another ticket may be claimed, the operator's checkout must be provably ready for the next workspace: it must be a normal checkout on the configured base branch, carry no staged, unstaged, or non-ignored untracked work, and have a remote that names the configured delivery repository (the one that is fetched). The verified merge commit must then be contained in the fetched base branch, and the local `HEAD` must be an ancestor of it, so the only move the harness can make is a fast-forward — `git merge --ff-only` to that commit. It never resets, forces, stashes, discards, cleans, commits, rebases, or reconciles local changes. A checkout that cannot be proven ready stops the queue with an actionable diagnostic before any other ticket is claimed.

### Fresh scans, finite runs, and watch mode

After source readiness, the loop performs another fresh eligibility scan; it never caches or pre-reserves a batch. If a valid eligible ticket exists it becomes the new current ticket. `queue run` is finite: with no valid eligible ticket it exits successfully, closes any activity display, and claims nothing. `queue watch` is one visible foreground process, not a daemon or a service: with no valid eligible ticket it prints an idle status, sleeps for `source.pollIntervalSeconds`, and scans again, and it starts no agent while it is idle. A ticket that appears later is claimed one at a time and resumes the same serial lifecycle.

### What ends the loop

A coding attempt that failed or was cancelled, a stop that could not be confirmed, a workspace ledger that could not be written, a delivery failure, a review that could not produce a usable verdict, a completion that needs a person, an absent or pending post-merge workflow after its deadline, a merge conflict, an authentication, API, or infrastructure failure, a checkout that cannot be proven ready, and an unsupported Jira transition are all attention results: both modes exit nonzero with the current evidence preserved. The blocked ticket is never skipped for another one, and an infrastructure failure is never reinterpreted as coding work.

A user interrupt stops the wait or the active bounded phase, starts no next ticket, and exits after cleanup, with the interrupted ticket's evidence kept.

### Restarts and deduplication

Nothing about the loop survives an invocation in harness state of its own, and nothing needs to. Jira's status, the item's own thread, the workspace pointer label, GitHub's review/check/merge/workflow state, and the existing local receipts are the authorities. A restart therefore resumes a ticket that is really back in its ready status — its preserved pointer deciding where the work continues — verifies an armed current head instead of requesting it again, re-arms a head GitHub no longer holds, does nothing at all about a ticket that is already Done, starts no second consumer, and duplicates no review, comment, transition, or auto-merge request: the existing marker, native-review, and native-merge checks of §9 and §10 are what make that true.

Before any fresh claim, a queue invocation discovers and re-reads the configured queue's
In Progress and In Review items. In Progress ownership must be resolved by an operator; it stops
both modes before unrelated work. One In Review item resumes only its scoped review and completion
lifecycle, including the existing admission's merged-PR recovery. Multiple In Review items stop
for attention. Ready items carrying retained workspace pointers resume before unrelated new work,
in the source's own configured order among repairs — Jira's Priority field by default, the board's
native Rank when `ordering` asks for it. The queue never adopts or resets workspaces.

Queue completion evidence reads obtain a current installation token through the existing Lens App
authentication boundary, which renews expiring tokens with the same installed Lens permission set
used for reviews. Public post-merge workflow reads require no additional permission in the token
request; an inaccessible workflow stops the queue for attention. The queue never freezes a reader
token for a long-running process. Operator credentials remain exclusive to auto-merge mutations;
standalone one-item commands are unchanged.

### Shape

This stays a small foreground control loop over existing modules: no database, durable queue, scheduler, detached background process, webhook system, workflow engine, multi-repository coordinator, or general dependency graph. One queue invocation holds the connected project's intake lock under its output directory for its whole life, including while it waits in watch mode, so a second consumer of the same connected project and `workDir` is refused rather than interleaved, while a queue for a different connected project may run under the same `workDir` and harness configuration; there is still no cross-machine coordination, and the storage root itself is not locked.

One limitation is worth stating: a ticket whose pull request GitHub has already merged cannot be repaired in place, because the delivery step refuses to edit a merged pull request. A repair attempt after an unsuccessful post-merge workflow therefore ends with that refusal as an actionable stop rather than a second pull request; splitting such a repair into a new ticket is an operator decision.

### One ticket, by identity

`queue run --ticket <key>` narrows the same finite run to one ticket. The scoped run reads that
ticket's own status and follows it by identity: a ticket in review resumes only its scoped review
and completion lifecycle, a ready ticket carrying a workspace pointer continues that workspace, and
a ready ticket without one is the claim itself. No other ticket is discovered, claimed, reported
on, or counted, and a scoped run whose ticket is in none of the configured statuses carries
nothing and claims nothing. A scoped ticket that is still in the running status is refused by name
exactly as an unscoped scan refuses one, because something else may still be working on it. A
scoped run holds the same intake lock and reports the same outcomes as an unscoped one.

## 12. Supervised recovery

`supervise run`, `supervise watch` and `supervise ticket <key>` put one small parent in front of
the queue of §11. The parent runs the same CLI as a worker — the same two configuration files, the
same activity display — and owns no ticket logic of its own: it watches how that process ended and
starts a separate recovery agent when the ending was not the one the operator asked for. What used
to be exceptional recovery policy inside the ordinary loop is the recovery agent's own judgment
here, and the ordinary loop gains no branch for it.

**What the parent owns.** One worker at a time for one connected project and `workDir`, enforced by
its own claims under `<workDir>/.supervisor/<supervision-id>/` as well as by the queue's existing
intake lock. A live owner is refused by name; a record whose process is gone is adopted with a
fresh claim, which is what makes a supervisor restart resume the incident instead of starting a
second worker; and a recorded worker PID that is really still running is a refusal, never a second
worker beside it. Activation beside a raw queue consumer that is really running is refused with the
lock and its owner named. Nothing here breaks, adopts or deletes a lock: the queue's own
exclusivity rules are untouched.

Ownership is a claim, and publication is exclusive: each invocation publishes its own claim under
the next free rank, so two starts cannot both take one rank and a claim published later can never
overtake one already there — the lowest-ranking live claim owns the queue, and every other
invocation refuses by name. The rank is read again before every publication, and a publication that
no longer stands above every claim really there — the rank it named was cleared away before it was
published, and a claim published meanwhile outranks it — is withdrawn and published again above
what is really there, so a delayed contender never publishes below a claim that has already
decided. Nothing renames, replaces, or removes a claim a live holder may own: a
claim whose process is gone is ignored while the ownership is decided and cleared away by the
invocation that wins, so a crash between publishing a claim and deciding leaves the next start a
queue it can safely take. The supervisor's own state is keyed by the
supervision itself — the connected checkout and the harness configuration it was started with —
never by the connected project's configuration, which has to stay repairable while it is broken;
the project's own lock namespace is what the activation check reads while that configuration can be
read.

Every worker is launched through a handshake. The launch's token is written down — with no PID yet —
before the child is spawned, the child is started with that token and does nothing until the same
record names its PID, and a registration that fails stops the child where it waits rather than
letting work run under a launch nothing recorded. A restart that finds a launch naming no process
refuses it by name: the child it started is gated on exactly that record, so it began no work and
gives up by itself, and no second worker starts beside a process nobody can name.

The launch is kept until its ending is durable. The invocation that watched the worker end writes
the ending down beside the launch — the exit code or signal, whether the operator asked for the stop,
and whether the queue left new run evidence behind — before the launch may be cleared or the incident
that ending owes may be recorded, so an invocation that stops between them leaves the next one the
ending itself rather than a pointer that names nothing and no incident. A crash with no error report
is covered by exactly this: the interruption is never rounded into "no worker was running".

The parent has an entry point of its own (`dist/cli/supervise.js`) that loads no ordinary
command and no worker module, so a broken queue, run, review or source command does not stop the
parent that has to repair it; a project configuration that cannot be read at all starts the
supervision rather than refusing it, while a readable configuration that composes no queue is still
refused before anything claims.

**How an ending is read.** A plain zero exit is the worker's own settled result. Any other ending
that arrives under the operator's own interrupt is the operator's stop: the supervision stays
stopped, recovers nothing, keeps the evidence where it is, and exits with the conventional
cancellation code. Every other ending — a nonzero exit, a process killed by a signal, a crash that
left no report at all, a worker that could not be started — is an unexpected stop, and the parent
opens one incident for it.

**One incident.** An incident records one stopped episode: the stop evidence, every recovery
attempt it spent, its conclusion, the resumption it recorded, and the publication identities of
its one report. The recovery agent runs with its own configured launch — initially the
`nexus-recovery` profile with `gpt-6-astra` at high reasoning effort — and with unattended
operational access: the output directory's runs, retained workspaces, receipts and processes, the
ticket's thread through the service account credential, GitHub through the operator's own
credentials, and the configured notification topic. It writes one judgment file: `repaired`,
`blocked` or `unrecoverable`, with the cause, the committed and uncommitted work it preserved,
what it repaired or reconciled, the work that resumes, an optional blocker ranked ahead of the
interrupted ticket, the ticket the stop belonged to, and — when it could not repair the situation —
exactly what a person must do. A judgment field that runs past its bound is refused rather than cut
down, and the attempt is recorded as one that produced no judgment; so is a judgment that names a
ticket this harness cannot address, because a report written against the wrong item is worse than
none. The ticket a judgment names is what an unscoped stop's report is written into, which is how
an ordinary `run` or `watch` incident gets a thread at all.

**A recovery turn's permissions.** It is the one turn that may repair the Nexus installation
itself, independently of the broken runtime, and it runs the installation's own configured checks
when it does; it may repair the configuration and a broken working copy, stop the processes the
worker left, and reconcile the ticket with its workspace. It may not weaken, skip or delete a
project's tests, checks, linting or tooling; it may not push, approve, merge, publish or mark a
ticket Done; and its report is context for the next developer and reviewer turn, never an approval
or a verification.

**An interrupted episode the ordinary loop leaves alone.** A ticket a previous invocation left in
the running status — a red baseline it diagnosed but never finished, chiefly — is part of what this
turn reconciles: the ordinary `source` and `queue` commands gain no branch for it and never guess
what a retained record holds (§11), and the recovery turn is what reads the retained evidence, the
workspace and the ticket, returns the item to a state the queue can carry, and says what resumes.

**Bounds.** One incident spends at most `recovery.maxAttempts` recovery turns, and a resumed worker
that stops again with the very failure its recovery reported repaired ends in an actionable
request for human help instead of another attempt. That repetition is read from evidence and never
from an exit code alone: the recovered work must be the work that stopped again, that work must be
a ticket the supervisor can name, the worker must have left no new run evidence behind — a run the
queue really finished, never a directory it merely created before stopping — and the
ending must be the same one. Where the queue did really run something in between, the repetition is
read from what the two recoveries investigated instead: the same ticket and the same `cause` the
earlier one reported repaired end in the same request for a person. A failure the supervisor cannot read that way — an unscoped one, or a
different failure on a ticket it cannot tell apart — is investigated like any other, and the
supervisor bounds that case over the chain it can see: each incident records whether the work it
resumed left any run evidence behind, and a queue that stops `maxAttempts` times in a row without
doing any work at all, every one of those stops already investigated, ends in the same request for
a person. A recovery turn is bounded by the configured `taskTimeoutMinutes`, unchanged: no new
timeout is introduced for it. An exhausted bound, an unchanged repetition, a barren chain, an
`unrecoverable` judgment and an attempt that produced no judgment all end in the same actionable
place — the incident record, the Jira report and the email summary kept, and a nonzero exit naming
what a person must do.

**An attempt a restart finds in flight.** An attempt is written down before its turn is launched,
with the directory the turn works in and the PID of the runtime it started, and it is cleared only
when its result is recorded. A restarted supervisor therefore never launches the same attempt
twice: a runtime that is still running is a refusal, one that is gone is reconciled against the
judgment file it left behind — adopted whole when it is there, recorded as an interrupted attempt
that produced no judgment when it is not — and either way the attempt counts toward the bound,
because it was really spent. Nothing is handed to a recovery runtime before its PID is recorded, so
an attempt that names no process is one whose turn never began: a restart refuses it by name for a
person to reconcile instead of rounding it into an attempt that produced nothing. A turn whose
runtime could not be confirmed stopped keeps its ownership: the attempt stays in flight, its
recorded PID stays the incident's, and the stop itself is recorded as what it was — the tree's own
root, and what could not be confirmed — rather than as prose a restart would have to interpret. No
second attempt or worker starts beside a process nobody has accounted for, and a later invocation
reconciles that hold only on evidence: the tree the attempt's runtime led has to be shown ended,
which a missing root PID is not — an owned tool outliving its runtime is exactly what a failed tree
stop leaves behind — and where the host cannot answer that question at all, a person who has
checked the host says so by recording an acknowledgement on the incident, newer than the hold.

**Resumption.** A `repaired` or `blocked` conclusion returns the queue to work: the parent starts
the worker again and records the moment that really happened, so a blocker ranked ahead of the
interrupted ticket is a decision the parent executes rather than a promise: the blocker runs first
as its own scoped `queue run --ticket <KEY>` worker, whatever intent the incident began with, and
the interrupted work runs after it. The resumption is recorded when that interrupted work really
starts, and never before — and the plan advances on the blocker's confirmed result, never on its
start: a blocker whose own worker was started but never seen to settle is still owed, and a restart
carries it out again before the interrupted work may run. A settled worker is not a settled blocker
either: a scoped run reports a completed run with nothing completed when its ticket is not in a
status the queue carries, so the parent reads the ticket itself through the connected project's own
Jira connection, and only the configured done status advances the plan. A blocker that ended
somewhere else — and one whose status could not be read — leaves the interrupted work where it is
and ends in an actionable request for a person, rather than resuming behind a blocker that never
ran or starting the same worker again for the same result. An incident that ended in a request for
human help is not resumed: it is reported and the supervision stops, and a restart is not an answer
to it — the unresolved request keeps the queue stopped until a person does what it asks and
acknowledges it in the incident record (`"acknowledgement": { "at": …, "note": … }`).

**Reporting.** Each incident publishes one concise report into the ticket's own Jira thread,
written by the same service account that wrote the ticket, so the next developer turn and the next
reviewer turn both read it in the shared history of §2; and one email summary through the
configured SNS topic to the configured address. Publication survives a restart without repeating
itself: an acknowledged comment is never posted twice, a comment whose own write was interrupted
is looked for in the ticket's thread by its own identity before another is sent, and an
acknowledged summary is never published again. The email summary's attempt is written down as
`pending` before the publisher runs, so a restart distinguishes an unattempted send from one that
was in flight: the publisher's own output is read back, an acknowledgement found there is adopted,
and an ending that does not prove the topic refused anything — a timeout, a signal, a log that
could not be closed — is recorded as `interrupted` and never retried automatically, because a
second email for one incident is worse than an unconfirmed one; only a publisher that could not be
started at all is a failure a later invocation may retry: a publisher that ran and acknowledged
nothing is uncertain whatever its exit code — an accepted publish whose answer was lost, a refused
one, and a summary that never left the machine all end that way — and is recorded as `interrupted`
for a person. The Jira connection a comment is written through is read from the connected
project's configuration as it stands at that moment, so a report owed after a repair goes into the
thread the repaired configuration names rather than being silently omitted. A publication that
failed is
recorded as the incident's reporting problem and is never a reason to repeat a recovery that
succeeded; an unfinished publication stays reachable and is finished by the next invocation
wherever the incident sits, however many times the pointer has moved since. The complete incident
— every stop, every attempt with its cause and preserved work, the conclusion and what resumes —
reaches both roles through the local history of §2, beside the comments the same service account
made while handling it — its published report recognized by the identity the incident recorded,
its other comments by its configured author name and the window the incident covered — as context
that is never an approval or a verification.

**Restart and deduplication.** The supervisor's state is one set of claims, one current-incident
pointer, and one record per incident under the supervision's own id; nothing survives in a database
or a service. A restart adopts the incident it finds, spends the attempts that record is missing,
finishes its report if that is all that is left, carries out the resumption each conclusion still
owes, and starts a worker again only where the records say the queue may resume. An incident record
that cannot be read back is refused by name rather than treated as an absence, and the pointer
names the worker that is running right now — a worker, or a recovery turn's own runtime, that is
still alive is refused rather than duplicated. A pointer whose worker is gone and whose ending no
incident recorded is not read as "no worker is running": the pointer's launch says what that worker
was carrying out, and an ending it records is decided on exactly as the invocation that watched it
decided — a settled worker finished its work and the operator's own stop recovers nothing — while
any other ending, an ending nobody observed and one written down before the invocation that watched
it could record the incident included, is an unexpected stop: the supervisor itself stopped while
its worker ran, so an incident is opened for it and investigated before any fresh work starts. A
launch that was carrying out a step an incident's plan still owes is investigated like any other:
that plan records the interruption the step began from, never what happened during it, and the step
is carried out again only after its own interruption is reconciled.

## Jira API references

These references support the external API details, not claims about implemented harness behavior.

[J1]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
[J2]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
[J3]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
[J4]: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
[J5]: https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/
