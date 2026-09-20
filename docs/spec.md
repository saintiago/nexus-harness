# Simple development harness — specification

**Baseline:** local-first, single-process. One task per run, one retained workspace that attempts may continue, independent checks, and a local report. A source invocation may start several runs, strictly sequentially; the original file-based invocation still runs one task.

**Revision: 2026-09-16 — task input sources, Jira first; service-account authentication.** Extend the supplied application after the reported completion of T01–T15; do not rebuild it or change the implementation/check/repair loop. Preserve configurable Codex launching. [WORKFLOW.md](WORKFLOW.md) owns JSON and CLI contracts; [architecture.md](architecture.md) owns module placement; [implement-task-source-connectors.md](implement-task-source-connectors.md) is the new implementation assignment. Existing runtime setup and T16 remain separate: these documents are requirements, not evidence that code or live verification has passed.

**Revision: 2026-09-19 — workspaces outlive runs.** The continuation contract in [implement-workspace-continuation.md](implement-workspace-continuation.md) is implemented: the split layout (`runs/<runId>` evidence, `workspaces/<workspaceId>` clone with its ledger beside it), the pointer label, continuation rules, the escalation ladder, and continued-attempt guidance. This revision realigns the text below with that contract and with the [Rely on Git](#rely-on-git) change; it adds no runtime behaviour of its own.

**Revision: 2026-09-19 — optional Nexus Lens reviews.** The review contract in §9 is implemented: an opt-in `review scan` / `review watch` path that reviews the pull requests of tickets the configured Jira connection reports as being in review, as an explicitly configured reviewer profile, and publishes one native GitHub review plus one app-owned check run per reviewed head. It is read-only on Jira and touches no working copy; [WORKFLOW.md](WORKFLOW.md) §9 owns its inputs and [architecture.md](architecture.md) §2 its module.

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

1. Read task/configuration JSON and a local Git repository path. Validate inputs, normalize the optional agent selection, and keep the loaded task/configuration fixed for the run.
2. Create a unique run directory. A fresh attempt clones the source repository's committed `HEAD` into a new workspace and uses a dedicated local branch there; a continuation reopens the workspace its pointer label names, on its recorded branch and base. Require a clean source checkout so uncommitted work is not silently omitted. Never reset or edit the source checkout.
3. Run configured setup and checks before the agent. A failing baseline stops a fresh attempt with a clear explanation; a continuation may start red, because its workspace may already carry failed work, and only its post-turn round decides.
4. Ask the selected agent invocation to implement the task in the retained working copy. Supply the task, acceptance criteria, and relevant target-repository instructions. The turn works with a repository-local Git identity and is asked to commit small, meaningful pieces as it goes; those commits stay in the retained copy. Nothing pushes, merges, or publishes them except the optional delivery step of a passed attempt, which the harness — never the coding turn — performs (§7).
   The turn's runtime is launched with write access to that copy, its Git metadata included, so staging and committing are possible; the harness still makes no commit of its own.
5. Wait for the agent to finish and stop its managed mutating processes. Run setup again, then all configured checks from the harness. Agent-reported success is not a check result.
6. After an ordinary completed red check round, send observed failure output back to the same selected agent and repeat step 5 while repairs remain. A setup/launch/authentication/protocol error or timeout stops the run rather than starting a code-repair loop.
7. Save the report and retain the working copy, whether the run passes or fails. Human review and delivery happen outside this version, except for the optional delivery step: when the configuration selects one, a passed attempt is delivered after its run's report is written and before its result is published (§7).

Run checks sequentially. Ordinary nonzero check results are repair feedback; a check that could not execute is not a pass. Do not keep coding after every check succeeds.

### Terminal display

As a run works, its progress is ordinary output, and the coding turn's own event stream is drawn in a fixed pane beneath it: the agent's messages, short command start/result lines, and the names of the files it changed. A command the runtime launched through a wrapper this harness recognizes — a PowerShell, `cmd`, or POSIX shell launch — is shown as the payload that wrapper was given, in its own quoting, so a long launcher path cannot hide the operation; a shape it does not recognize is shown as it was reported, bounded. A completion names the operation it belongs to, repeats the outcome it was observed with — an exit code, or the runtime's own status word — and quotes the last line of the command's own output when it printed anything. Nothing about a command is reinterpreted: an exit code is repeated rather than read as success or failure, and an excerpt is the runtime's words, not a claim about the work.

The history is grouped by the agent's messages: each message starts a group that keeps at most the latest three work lines that followed it, and the whole history is at most twenty physical lines. When it is full, the oldest work lines are dropped first, so earlier messages accumulate in chronological order as the work between them disappears; only once no work line remains do the messages themselves scroll away, oldest first. Each activity entry is fitted to one physical row, and control characters in runtime text are never written as terminal commands. The progress lines above the pane keep the task, the current phase, and the selected model readable: the lines the harness recognizes as startup inventory — receipt paths, immutable IDs, revisions, commit hashes, launch arguments — are condensed or left to the run log, while a line whose shape is not recognized is shown as it was written. A redirected, too narrow, or too short terminal gets every line as ordinary output with no cursor sequences. On completion, failure, and interrupt the pane is removed before the outcome and its local paths are printed, so the terminal is left usable and the logging, outcome, and cancellation behavior of §3 and §4 are unchanged. The display is presentation only: the timeline and every turn's own output are retained in the run log and the agent logs, and nothing the pane shows is evidence or a status (HARN-11, HARN-16).

### Agent selection

The original six configuration fields remain required. Preserve optional `agent`, containing `runtime` and a literal `command` prefix. When omitted, use `runtime: "codex"` and `command: ["codex"]`. When present, require both fields and reject unsupported runtime values and unknown fields. Add an independent optional `source` object for intake, as defined in WORKFLOW. All existing task and configuration files remain valid.

The adapter owns non-interactive execution, workspace binding, stdin prompts, structured-output parsing, and shutdown. The launch prefix may choose a Codex executable, compatible wrapper, native profile, or model. It is not a complete command or a way to replace the adapter's execution protocol.

Coding-provider credentials, endpoints, catalogs, reasoning settings, and gateway configuration remain in native runtime settings or the process environment. Do not add equivalent LLM fields to task/config JSON, provider SDKs, or an LLM gateway inside the harness. Jira connection settings belong to `source`; the Jira service-account API token comes only from the environment variable named by `tokenEnv`.

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

On cancellation/timeout, stop owned commands and agent execution before reporting a clean stop. If termination cannot be confirmed, report the limitation, prevent further checks/repairs, and do not reuse the working copy in that run. Do not claim control over arbitrary detached or unrelated processes. Automatic crash recovery remains out of scope.

## 4. Files, not a database

Use one generated run ID, unrelated to task text:

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
  .intake/                        # source intake only: the lock and per-issue receipts
```

The report retains task/run IDs, source path and base commit, workspace path, times, repairs used, status/reason, and check results grouped by baseline and implementation/repair attempt. Keep arguments, exit/signal/timeout information, log locations, and final change-review warnings. Never overwrite earlier failure evidence. A continued workspace reports the base its own ledger recorded, which stays the comparison base for every attempt even when the source checkout has advanced since; only a fresh run records the base that preflight selected then.

Add the effective `agent` selection (`runtime` and non-secret launch prefix) to new reports and record it once in `run.log`. This identifies what the harness launched. A profile name alone is not an observed model identity. Do not inspect runtime credential/config files in production to enrich the report.

Keep lifecycle logging concise and append-only. Command output belongs in its own files; detailed agent output belongs in a separate file per top-level turn. The JSON report references those files instead of embedding full transcripts. Never dump environment variables, API keys, or native authentication data.

Retain files by default; cleanup is manual. A crash can leave an incomplete directory without a final report. Do not treat that as success, automatically resume it, or delete it on the next run. The user inspects/stops leftovers before reuse. Source intake adds only the local exclusion lock and per-issue receipt described below, not a transactional store, journal, or background reconciliation service.

## 5. Practical safeguards and limits

This is a trusted local developer tool, not a secure multi-tenant execution platform. A separate clone protects the source checkout from ordinary edits; it is not a sandbox.

Use only approved repositories and commands. Do not supply production/publishing credentials, interpolate task text into shell strings, or log secrets. Refuse unsafe source/output overlap. Setup and tests execute project code too; do not describe them as harmless data processing. A configured delivery step is the one deliberate exception to "nothing is published": it writes the attempt's branch and pull request to the destination repository with the operator's own Git and `gh` credentials, so configure it only for a repository and account an unattended harness may write to (§7).

Keep the command plan outside the task working copy. Instruct the agent not to weaken tests or tooling to manufacture a pass; highlight test/tooling/configuration changes in the final summary. `passed` means configured checks passed, not that every acceptance criterion is proven or the changes are safe to ship. Human diff review remains required.

The agent launcher is trusted operator configuration. Secrets are prohibited in its arguments because launch information is reportable. Use the tested platform launcher; unsupported argument/interpreter combinations must fail clearly rather than being silently altered. Do not introduce a shell-string executor or runtime permission bypass.

The harness launches every turn with one explicit policy, as part of the invocation rather than as something the operator has to configure: the runtime runs unsandboxed (`exec --sandbox danger-full-access`, approvals never asked), so the retained working copy — its Git metadata included — can be staged and committed. That is a documented choice, not a hidden fallback: the narrower `workspace-write` policy leaves that copy's Git metadata read-only on Windows and makes a local commit impossible. The harness itself still makes no commit of its own, and the launch is fixed for every turn of a run.

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

A fresh issue's first attempt still clones the source checkout's then-current committed `HEAD`. A continuation instead reopens the workspace its pointer label names, keeps the base its ledger recorded as the comparison base, and therefore inherits the earlier attempts' local commits and uncommitted changes; separate workspaces do not inherit each other's changes. Queue ordering does not implement dependencies, merging, or delivery.

### Issue mapping and trusted execution

Use the issue key as `Task.id`, summary as `title`, its supported description text as `description`, and the list under an `Acceptance criteria` heading as `acceptanceCriteria`. Validate the mapped object with the existing Task schema. WORKFLOW defines the small supported Jira description format.

Missing or ambiguous criteria, empty task text, or unsupported content that could hide requirements are per-issue input errors. Show them and skip that issue without a receipt, Jira mutation, or paid agent invocation; continue to other valid issues. Do not ask an LLM to infer missing fields. In watch mode suppress repeated identical diagnostics until the issue revision changes.

Repository, checks, setup, agent, and limits remain trusted local inputs. `Verification` text in Jira is context for the agent and human, not a source of executable setup/check commands. `passed` retains its existing meaning; prose criteria are not automatically proven.

### Reservation and duplicate prevention

For `source run` and `source watch`, perform existing source/output safety preflight before any output write or remote claim. Take an exclusive local lock for the normalized `workDir`; only one intake consumer may use it at a time. Recheck source checkout safety before each new attempt.

For each prepared valid issue:

1. Decide what it is from its workspace pointer labels and its receipt: no pointer and no receipt is a **fresh** attempt, which creates the workspace; exactly one pointer that resolves on this machine is a **continuation** of that workspace; a receipt with no pointer, a pointer that does not resolve here, and more than one pointer are refused and published like any terminal outcome, with nothing created. Identity is connector type + canonical source site + immutable external issue ID, not mutable summary, key, status, or update timestamp.
2. Exclusively create its receipt before any remote mutation or agent work; a continuation already has one and reuses it. Receipt existence means **attempt reserved**, not success.
3. Recheck eligibility and the captured issue revision, then request the transition to the configured running status. Only an unambiguously successful claim permits `runTask`.
4. Run through the unchanged runner; persist source provenance and the normalized input snapshot with normal local artifacts.
5. Record the real run ID, result path, and outcome in the receipt, then attempt remote feedback. Never turn a Jira delivery error into another coding attempt.

A claim rejected because the issue changed **before any mutation request was sent** may release only its newly created receipt and skip. After any mutation attempt, error, timeout, or uncertain response, keep the receipt and stop intake for operator inspection. A crash-reserved issue is never resumed or rerun automatically.

The local lock/receipt protects one consumer using the same retained `workDir`. Jira status transitions are not a distributed lock. Running consumers on different machines or with different work directories against the same queue is unsupported; there is no global exactly-once guarantee.

### Jira feedback and completion

Use existing workflow statuses, defaulting to `To Do → In Progress → In Review`. `In Review` means **the local attempt ended and needs human attention**, for `passed`, `failed`, and `cancelled` alike. A result comment must state the exact outcome; never represent a failed attempt as completed implementation. Do not automatically set `Done` or merge anything. Without a configured delivery step the local commits a coding turn made stay in the retained workspace; with one, a passed attempt was delivered first, and the result comment carries the pull request URL (§7). Nothing else about the changes leaves the machine.

Discover available transitions for the issue and select a unique transition by its target status, not by assuming a status ID is a transition ID. If a workflow requires additional fields or offers no unambiguous transition, report that limitation rather than changing the workflow. [J2]

Save local results first. Post one compact result comment with run ID, observed outcome/reason, check summary, repairs used, local artifact locations, and — when the attempt was delivered — its pull request URL; mark paths as local, not downloadable Jira attachments. Exclude transcripts, diffs, environment variables, tokens, and native provider configuration. Then move to review only if the issue is still in the running status; respect subsequent human status changes. Jira comments use ADF. [J3]

While an `escalation` ladder still has a rung to try, that comment is one attempt's own and the issue stays in the running status; only the climb's last attempt moves it to review, and only an exhausted ordinary red check round lets the climb continue ([implement-workspace-continuation.md](implement-workspace-continuation.md)).

A feedback failure keeps the original local run outcome and a separate `feedback: failed` receipt entry. Record whether a comment was acknowledged before a later transition failed. Do not blindly resend comments after an ambiguous response. No automatic outbox/reconciliation loop in this increment.

### Errors, shutdown, and retries

Read-only discovery network errors, HTTP 429, and transient server errors cause `source list`/`source run` to exit nonzero. Watch retries discovery after an abortable delay, with bounded exponential backoff; respect `Retry-After` as a minimum and never shorten a server-directed wait. Authentication/authorization failures, invalid configuration/JQL, and malformed API responses stop watch. [J4]

A handled failed run can be reported and followed by the next issue, provided its owned processes are confirmed stopped. Unknown process termination, local persistence failures, ambiguous claims, and remote feedback errors stop intake. No queue activity may start another agent to repair infrastructure or report delivery.

On interrupt, stop polling and claiming immediately, cancel the active run through existing shutdown handling, and preserve artifacts/receipts. After confirmed process cleanup, allow at most one best-effort feedback sequence with a separate total 10-second deadline; do not keep the terminal alive indefinitely. Do not start a second feedback sequence when one was already attempted or its delivery is uncertain. Release only this process's lock after cleanup; leave it for manual inspection if cleanup cannot be confirmed. Forced termination may leave a lock; never delete it automatically based only on its age.

### Minimal retained intake state

Store `.intake/lock/` and `.intake/receipts/<identity-hash>.json` under `workDir`, outside target workspaces. A receipt contains source identity, reservation time, and any known real run/result/feedback details. The initial creation is exclusive; subsequent replacements are atomic. Corrupt/unknown receipt formats must fail closed, not be treated as absence. This is duplicate prevention, not a new run registry or resumable workflow engine.

The workspace ledger is read the same way: it must be version 1 and hold the identity and attempt entries this harness writes, and a record of another shape — an unsupported version, a partially written identity, an attempt whose fields are missing, of the wrong kind, or ending at a value that is not a timestamp this harness writes — is refused before it is reused rather than repaired, migrated, or read as something it is not. An attempt that cannot be recorded in its workspace's ledger is a failed save, not a quiet success: its report and working copy are kept, the failed path is reported, and intake stops instead of continuing the workspace from state that does not hold the attempt.

Rework is ordinary: move an attempted issue back to the ready status and the harness continues the workspace its pointer label names — same clone, same recorded base, a new run directory and report, and a baseline that may be red. Merely editing or reopening an issue does not erase its receipt or its pointer. To deliberately start over — a first attempt in a new workspace — create a new Jira task, or stop the watcher, inspect/stop prior processes, retain the run artifacts, remove the pointer label, remove only that issue's receipt, and restore its ready status. Preserve `.intake` when cleaning old run directories.

## 7. Optional GitHub delivery

Delivery is a harness/operator operation, off unless the configuration selects it, and it never runs a coding turn. It is configured by one optional strict `delivery` object — the only implemented type is `"github"` — and an absent object means the local-only behavior described everywhere else ([WORKFLOW.md](WORKFLOW.md) §8).

After a **passed** attempt, and before that attempt's result is published, the harness delivers the working copy the run left:

1. A working copy that still holds uncommitted work — staged, unstaged, or untracked — is refused. Nothing is committed, stashed, or discarded on the turn's behalf; the failure names the paths and says what to do.
2. A branch with no commit beyond the workspace's recorded base is not delivered. A passed attempt that changed nothing has nothing to publish, which is reported rather than turned into a delivery to make.
3. Otherwise the workspace's own branch is pushed to the configured destination repository, as it is and never with force.
4. The pull request is found in that repository by head branch and base branch, whatever its state, and its native state decides what happens: one **open** match is updated, one is created only when no match exists at all, and a match that is `CLOSED` or `MERGED` — like two or more open matches — is refused instead of edited, so an attempt is never reported as delivered when no open review received its work. A created or updated pull request carries the same body: the item's reference and URL, the task, the actual check summary, and the run ID.

The published result comment then carries the pull request URL, so Jira links to what was delivered.

Delivery never merges a pull request, never marks an issue `Done`, never force-pushes, never rewrites a run's report, and keeps no delivery database: GitHub is the record of whether a pull request exists.

A delivery failure is not a coding failure. The run's own report, logs, and check evidence stay exactly as they were written; the receipt records the delivery problem; the issue is told the run's own outcome with the failure beside it and moved to review when Jira is reachable; and intake stops for a human. No coding turn is started to repair a publishing failure. Retrying the publication is an operator step with ordinary `git` and `gh` in the retained workspace — check GitHub first, because a push or a creation that reported a failure may already have taken effect — and returning the issue to the ready status is code rework, not a delivery retry ([WORKFLOW.md](WORKFLOW.md) §8).

Delivery applies to a source-triggered attempt, whose workspace and branch survive across attempts. A file-task run creates a fresh clone and branch every time, so there is no stable branch to deliver and `run --task` stays local even when the object is configured.

Delivery uses the operator's own Git and `gh` authentication; the configured repository and base branch are trusted local inputs, like the configured commands, and no GitHub credential is stored by the harness. A destination the harness cannot write to fails with what Git or `gh` said rather than falling back to anything else.

## 8. Current increment and later work

**Keep:** the existing workspace/check/report loop, file-task CLI, configurable Codex adapter and DeepSeek profile selection, offline tests, logging, deadlines, cancellation, and retained artifacts. Inspect actual code and preserve user changes. The production harness still never configures the user's coding-provider account.

**Implemented by this increment:** optional source configuration; a small source contract; Jira Cloud mapping, discovery, claim, and result feedback; list/run/watch commands; a single-consumer lock and local receipts; offline tests and an opt-in Jira exercise. Do not require Jira credentials for existing file-task commands or ordinary validation. The later workspace-continuation increment builds on it: see [implement-workspace-continuation.md](implement-workspace-continuation.md).

**Later, only when needed:** another concrete task source, real Claude Code adapter, webhooks, parallel consumers, dependency scheduling, automatic merging, coordinator-driven CI observation and merge verification, stronger isolation, or remote recovery. The optional GitHub delivery step of §7 opens or updates a pull request and stops there; merging, and reacting to CI on the pull request, stay outside the harness. Add another connector without changing Task or the coding loop; do not ship a placeholder connector now.

**Implemented by the review increment:** the optional `review` object and the `review scan` / `review watch` commands of §9 below. They add no field to Task, no change to the coding loop, and no new process: a scan reads the Jira queue, starts the configured reviewer as one bounded turn, and publishes a native GitHub review and an app-owned check run. Merging, Jira completion, and coordinator decisions remain outside it.

Regression verification must retain baseline failure, pass without repair, repair then pass, repair exhaustion, execution/auth/protocol errors, timeout/cancellation, retained workspace/logs, and unchanged source. Add source tests without weakening those cases. Default tests must not call Jira or a real LLM. T16 is not considered passed by mocked connector tests.

## 9. Optional Nexus Lens reviews

Review is off unless one optional strict `review` object selects it. With it, `review scan` and `review watch` read the tickets the configured Jira connection reports as being in review, identify each ticket's open pull request in the configured repository, ask an explicitly configured reviewer launch for a verdict, and publish that verdict as one native GitHub review plus one app-owned check run. Without it nothing changes: no GitHub App credential is resolved, GitHub is never contacted as an App, and no reviewer turn runs. The commands' inputs and defaults are [WORKFLOW.md](WORKFLOW.md) §9.

### Eligibility and the pull request link

The review queue is the configured project, issue type, and label in the configured review status. Each ticket is re-read and mapped exactly as intake maps it, so the reviewer receives the ticket's own intent and acceptance criteria; the pointer labels the read observed decide where its work lives. When the output directory holds the ticket's intake receipt, that receipt must record a passing attempt: a receipt whose last recorded attempt ended `failed` or `cancelled`, a reservation with no finished attempt, and a receipt that cannot be read are reported for coordinator attention rather than reviewed, because an approval of an earlier pull request would present unsuccessful work as code awaiting approval. A ticket this machine never attempted has no receipt and is reviewed from its pull request alone. A review then needs one clearly identified open pull request: exactly one valid `harness-ws-<workspaceId>` pointer label, and exactly one open pull request in the configured repository whose head branch is `harness/<workspaceId>`. A missing ticket read, no pointer, a pointer that is not a generated workspace id, more than one pointer, no open pull request, and more than one match are reported and left alone: nothing is reviewed, no review or check is published, and the ticket stays in review for the coordinator.

### What one review is

- The reviewer launch is its own explicitly configured selection, resolved like the coding launch. It is never the tier that implemented the ticket, and it is a launch prefix, not a credential: provider credentials stay in the runtime's own environment.
- The reviewer receives the ticket reference, title, description, and acceptance criteria; the pull request's changed files and patches; root and relevant ancestor-directory `AGENTS.md` files at the reviewed head when present; and the head's check runs and combined commit status. Known missing patches, incomplete change counts, and evidence exceeding the input bounds require coordinator attention before a reviewer turn.
- One reviewer turn is bounded by the same task timeout a run gets and runs through the same adapter, in its own evidence directory under `<workDir>/reviews/<reviewId>/`. It is review-only: it must not implement fixes, change files, commit, push, merge, or edit the ticket or the pull request. It must write one verdict file naming `approve`, `request_changes`, or `inconclusive` with a summary and findings. An explicit inconclusive result explains missing material evidence and publishes no review or check. Findings are blocking; approval requires an empty findings list and sufficient evidence.
- A turn that fails, is stopped, or writes no usable verdict is inconclusive. Nothing is published for it, no approval is produced, and no coding turn is started to repair it.
- `request_changes` requires at least one finding. An approval is published only for a completed, usable verdict: a missing credential, an unavailable tool, an incomplete evidence read, and an API failure are reported as such rather than rounded into one.

### Publishing, and the merge signal

- Before anything is published, the pull request is re-read and must still be open at the reviewed head, and the ticket must still be in the configured review status. A head that moved or a ticket that left review publishes nothing: a stale verdict can never approve a newer commit.
- The verdict becomes one native GitHub review — `APPROVE` or `REQUEST_CHANGES` — pinned to the reviewed commit with `commit_id`, carrying the ticket's reference and URL and the reviewer's summary, with inline file/line comments for findings the pull request's own diff can position.
- One check run named by `checkName`, published as the App installation on the reviewed head, is then created with conclusion `success` only for an approved verdict and `failure` for a requested change. A review that was published but whose check could not be is reported; a later scan creates the missing check or updates a contradictory check from the latest native review's state instead of reviewing again. The newest app-owned run is the effective check; list ordering and older successes cannot override a later verdict. Truncated native review/check lists are refused. Check reconciliation also revalidates the ticket and head before writing.

The smallest native signal that identifies Nexus Lens is that app-owned check run: a branch rule should require it from this App, together with the repository's CI check. A generic requirement of one approving review does not identify the App. Merge execution, auto-merge, Jira completion/rework decisions, and CI observation remain outside this increment: the coordinator enables auto-merge where supported, verifies the merge outcome, marks an issue `Done` only for confirmed integration, and returns code changes, CI failures, and conflicts to the ready status with the retained pointer and the concrete findings. A pending CI run and an infrastructure or authentication failure stay in review for diagnosis and do not trigger code repair.

### Deduplication and retained evidence

A head that already carries a completed review by the App's configured login whose `commit_id` is that same head is not reviewed again, and no reviewer turn is started; a later commit is a new head and is reviewed again. That native review metadata is the deduplication record: there is no check registry, delivery database, local lock, or second coding consumer. Each reviewer turn keeps its evidence (`input.md`, `reviewer.log`, `verdict.json`, and `review.json`) under `<workDir>/reviews/`, the scan appends one line per outcome to `<workDir>/reviews/review.log`, and nothing is published into a working copy. The scan never changes Jira: it claims and transitions nothing, posts no comment, and never marks an issue `Done`.

## 10. Optional review-to-completion

Completion is a second, independently optional step inside `delivery`: `delivery.completion`. Absent means §7 alone and an In Review item waits for a person. Present, it carries reviewed source work from an approved pull request through **native GitHub auto-merge** and the configured post-merge workflows on `main` to a verified Jira resolution, without a coordinator or a coding turn in between. It changes nothing about the blanket no-merge/no-`Done` rule above for a configuration that does not enable it.

The configuration names the Nexus Lens reviewer (`lensApp`, `lensAppId`, `lensCheckName`), the environment variable holding that reviewer's own credential (`reviewerTokenEnv`), at least one expected post-merge workflow (`postMergeWorkflows`), the two Jira statuses an item can end in (`toDoStatus`, `doneStatus`), and its polling bounds. An empty or missing workflow list, or a status that is not distinct from the review status or from the other outcome, is refused rather than treated as evidence.

The reviewer's credential is deliberately a different environment variable from the operator's `gh`/Git credential. The reviewer's token reads the reviewer's verdict and never enables auto-merge; the operator's credential authenticates the one per-pull-request arming request and never reaches the reviewer. The harness never merges, force-pushes, reruns a workflow, or bypasses protection: `enablePullRequestAutoMerge` with `mergeMethod: SQUASH` asks GitHub to merge once branch protection and every required check allow it, and only GitHub's own merged state is trusted.

One pass reads the In Review items of the configured queue and, for each of them, the single open pull request its workspace pointer's branch has. It proceeds on an approval from the configured reviewer on the **current** head, backed by a successful check of the configured name on that same head; the head is re-read immediately before every mutation. It then:

1. Arms squash auto-merge with the operator credential, and waits, bounded by its interval and deadline, for GitHub to report that exact pull request **merged**, with the approved head as its source, the configured base branch, and a merge commit SHA. An armed request, pending pull request checks, a closed pull request, or an absent branch is not a merge.
2. Requires every configured post-merge workflow to have a run for event `push`, on the configured base branch, for that exact merge commit SHA; the **latest attempt** must be completed with conclusion `success`. A run that has not appeared, or is queued or in progress, is pending and waits; a deadline that expires with work still pending posts one attention comment and leaves the item In Review.
3. Posts one resolution comment of at most 120 words naming what was delivered or concluded, the successful post-merge main workflow, material limitations, and the pull request and workflow links, and then moves the item to `doneStatus` through native transition discovery.

A current-head `REQUEST_CHANGES` decision from that reviewer, a definitive failed required PR check, and a post-merge workflow that concluded unsuccessfully are conclusive findings: one concise comment naming the review or the failed check or workflow with its conclusion and link, and the item returns to `toDoStatus` with its workspace pointer untouched, so the ordinary source consumer may take the next repair attempt. A merge that GitHub has already made is never rolled back.

Everything else — missing or inconclusive review evidence, an approval or a check on another head, a closed or ambiguous pull request, a conflict, a refused auto-merge, an authentication or permission failure, a check whose relationship to a decision is unclear — is reported for operator attention and left `In Review`. A person's status change is respected: an item that left the review status is not touched. Recovery is deterministic and agent-free: GitHub's merged state and the configured post-merge runs are authoritative, comment markers in the item's own thread are what prevents a second comment, and a status move is made only while the item is really still in review, so a restart retries only what did not happen. Nothing here starts a coding turn.

## Jira API references

These references support the external API details, not claims about implemented harness behavior. Verified 2026-09-16.

[J1]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
[J2]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
[J3]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
[J4]: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
[J5]: https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/
