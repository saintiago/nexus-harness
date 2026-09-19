# Simple development harness — specification

**Baseline:** local-first, single-process. One task per run, one retained workspace that attempts may continue, independent checks, and a local report. A source invocation may start several runs, strictly sequentially; the original file-based invocation still runs one task.

**Revision: 2026-09-16 — task input sources, Jira first; service-account authentication.** Extend the supplied application after the reported completion of T01–T15; do not rebuild it or change the implementation/check/repair loop. Preserve configurable Codex launching. [WORKFLOW.md](WORKFLOW.md) owns JSON and CLI contracts; [architecture.md](architecture.md) owns module placement; [implement-task-source-connectors.md](implement-task-source-connectors.md) is the new implementation assignment. Existing runtime setup and T16 remain separate: these documents are requirements, not evidence that code or live verification has passed.

**Revision: 2026-09-19 — workspaces outlive runs.** The continuation contract in [implement-workspace-continuation.md](implement-workspace-continuation.md) is implemented: the split layout (`runs/<runId>` evidence, `workspaces/<workspaceId>` clone with its ledger beside it), the pointer label, continuation rules, the escalation ladder, and continued-attempt guidance. This revision realigns the text below with that contract and with the [Rely on Git](#rely-on-git) change; it adds no runtime behaviour of its own.

## 1. Goal

Turn an explicit development task into locally checked changes, with as little coordination code as possible:

```text
Task → working copy → coding agent → checks → result
                          ↑           |
                          └── repair ─┘
```

The coding agent implements and repairs; ordinary application code decides when to check, retry the code change, or stop. The runner produces a retained working copy and a local report, not a PR, merge, or deployment: a coding turn may make small local commits in the working copy, and the harness never pushes, merges, publishes, or otherwise integrates that work. A commit is the turn's own local arrangement of its work, never evidence that a check passed.

Codex CLI remains the only implemented coding runtime. Allow its launch prefix to be configured so an operator can select a native profile or model without changing the runner. DeepSeek through Codex is the immediate integration target. The coding assistant used to build this repository is a separate choice.

Preserve normal local OpenAI Codex defaults. Selecting DeepSeek for the harness must not require switching the user's global default, deleting authentication, or restoring configuration before ordinary Codex use.

### Rely on Git

Git owns code history, branches, commits, and comparisons. The harness owns task execution, independent verification, and the evidence of what each run observed. Use Git's existing capabilities to show what a task changed and retain its code history.

Keep harness state limited to what execution and reporting need. A report or workspace ledger may record a Git reference or commit SHA for a concrete purpose; that does not require a parallel history model or a continuation gate based on that SHA. Additional checkpoint bookkeeping, per-attempt commit ranges, or history restrictions need an explicit task requirement rather than being defaults.

## 2. What the working version does

1. Read task/configuration JSON and a local Git repository path. Validate inputs, normalize the optional agent selection, and keep the loaded task/configuration fixed for the run.
2. Create a unique run directory. A fresh attempt clones the source repository's committed `HEAD` into a new workspace and uses a dedicated local branch there; a continuation reopens the workspace its pointer label names, on its recorded branch and base. Require a clean source checkout so uncommitted work is not silently omitted. Never reset or edit the source checkout.
3. Run configured setup and checks before the agent. A failing baseline stops a fresh attempt with a clear explanation; a continuation may start red, because its workspace may already carry failed work, and only its post-turn round decides.
4. Ask the selected agent invocation to implement the task in the retained working copy. Supply the task, acceptance criteria, and relevant target-repository instructions. The turn works with a repository-local Git identity and is asked to commit small, meaningful pieces as it goes; those commits stay in the retained copy and are never pushed, merged, or published.
   The turn's runtime is launched with write access to that copy, its Git metadata included, so staging and committing are possible; the harness still makes no commit of its own.
5. Wait for the agent to finish and stop its managed mutating processes. Run setup again, then all configured checks from the harness. Agent-reported success is not a check result.
6. After an ordinary completed red check round, send observed failure output back to the same selected agent and repeat step 5 while repairs remain. A setup/launch/authentication/protocol error or timeout stops the run rather than starting a code-repair loop.
7. Save the report and retain the working copy, whether the run passes or fails. Human review and subsequent delivery happen outside this version.

Run checks sequentially. Ordinary nonzero check results are repair feedback; a check that could not execute is not a pass. Do not keep coding after every check succeeds.

### Agent selection

The original six configuration fields remain required. Preserve optional `agent`, containing `runtime` and a literal `command` prefix. When omitted, use `runtime: "codex"` and `command: ["codex"]`. When present, require both fields and reject unsupported runtime values and unknown fields. Add an independent optional `source` object for intake, as defined in WORKFLOW. All existing task and configuration files remain valid.

The adapter owns non-interactive execution, workspace binding, stdin prompts, structured-output parsing, and shutdown. The launch prefix may choose a Codex executable, compatible wrapper, native profile, or model. It is not a complete command or a way to replace the adapter's execution protocol.

Coding-provider credentials, endpoints, catalogs, reasoning settings, and gateway configuration remain in native runtime settings or the process environment. Do not add equivalent LLM fields to task/config JSON, provider SDKs, or an LLM gateway inside the harness. Jira connection settings belong to `source`; the Jira service-account API token comes only from the environment variable named by `tokenEnv`.

A selected runtime/profile/key that is unavailable must fail clearly. Never silently use OpenAI, switch models, try Claude, run a login flow, or choose a cheaper provider as a fallback. Reuse the same selection for all top-level turns.

## 3. Bounds and outcomes

`maxRepairs` counts additional top-level coding turns after implementation. With `maxRepairs: 2`, there are at most three turns. Internal tool calls do not each count as a turn. Session reuse cannot create extra free attempts; this change does not introduce session reuse.

The task deadline covers preparation, agent work, setup, and checks. Each setup/check command also has a timeout; remaining task time always wins. Do not restart the clock between phases or repairs. No automatic coding-run infrastructure retries or provider fallback. A runtime's own internal behavior is still bounded by the harness's deadline. Intake HTTP requests and idle polling are outside that deadline and have their own bounded waits; each actual run gets its own original task deadline.

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

Use only approved repositories and commands. Do not supply production/publishing credentials, interpolate task text into shell strings, or log secrets. Refuse unsafe source/output overlap. Setup and tests execute project code too; do not describe them as harmless data processing.

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

Use existing workflow statuses, defaulting to `To Do → In Progress → In Review`. `In Review` means **the local attempt ended and needs human attention**, for `passed`, `failed`, and `cancelled` alike. A result comment must state the exact outcome; never represent a failed attempt as completed implementation. Do not automatically set `Done`, push, merge, publish, or otherwise integrate the changes: the local commits a coding turn made stay in the retained workspace.

Discover available transitions for the issue and select a unique transition by its target status, not by assuming a status ID is a transition ID. If a workflow requires additional fields or offers no unambiguous transition, report that limitation rather than changing the workflow. [J2]

Save local results first. Post one compact result comment with run ID, observed outcome/reason, check summary, repairs used, and local artifact locations; mark paths as local, not downloadable Jira attachments. Exclude transcripts, diffs, environment variables, tokens, and native provider configuration. Then move to review only if the issue is still in the running status; respect subsequent human status changes. Jira comments use ADF. [J3]

A delivery failure keeps the original local run outcome and a separate `feedback: failed` receipt entry. Record whether a comment was acknowledged before a later transition failed. Do not blindly resend comments after an ambiguous response. No automatic outbox/reconciliation loop in this increment.

### Errors, shutdown, and retries

Read-only discovery network errors, HTTP 429, and transient server errors cause `source list`/`source run` to exit nonzero. Watch retries discovery after an abortable delay, with bounded exponential backoff; respect `Retry-After` as a minimum and never shorten a server-directed wait. Authentication/authorization failures, invalid configuration/JQL, and malformed API responses stop watch. [J4]

A handled failed run can be reported and followed by the next issue, provided its owned processes are confirmed stopped. Unknown process termination, local persistence failures, ambiguous claims, and remote feedback errors stop intake. No queue activity may start another agent to repair infrastructure or report delivery.

On interrupt, stop polling and claiming immediately, cancel the active run through existing shutdown handling, and preserve artifacts/receipts. After confirmed process cleanup, allow at most one best-effort feedback sequence with a separate total 10-second deadline; do not keep the terminal alive indefinitely. Do not start a second feedback sequence when one was already attempted or its delivery is uncertain. Release only this process's lock after cleanup; leave it for manual inspection if cleanup cannot be confirmed. Forced termination may leave a lock; never delete it automatically based only on its age.

### Minimal retained intake state

Store `.intake/lock/` and `.intake/receipts/<identity-hash>.json` under `workDir`, outside target workspaces. A receipt contains source identity, reservation time, and any known real run/result/feedback details. The initial creation is exclusive; subsequent replacements are atomic. Corrupt/unknown receipt formats must fail closed, not be treated as absence. This is duplicate prevention, not a new run registry or resumable workflow engine.

Rework is ordinary: move an attempted issue back to the ready status and the harness continues the workspace its pointer label names — same clone, same recorded base, a new run directory and report, and a baseline that may be red. Merely editing or reopening an issue does not erase its receipt or its pointer. To deliberately start over — a first attempt in a new workspace — create a new Jira task, or stop the watcher, inspect/stop prior processes, retain the run artifacts, remove the pointer label, remove only that issue's receipt, and restore its ready status. Preserve `.intake` when cleaning old run directories.

## 7. Current increment and later work

**Keep:** the existing workspace/check/report loop, file-task CLI, configurable Codex adapter and DeepSeek profile selection, offline tests, logging, deadlines, cancellation, and retained artifacts. Inspect actual code and preserve user changes. The production harness still never configures the user's coding-provider account.

**Implemented by this increment:** optional source configuration; a small source contract; Jira Cloud mapping, discovery, claim, and result feedback; list/run/watch commands; a single-consumer lock and local receipts; offline tests and an opt-in Jira exercise. Do not require Jira credentials for existing file-task commands or ordinary validation. The later workspace-continuation increment builds on it: see [implement-workspace-continuation.md](implement-workspace-continuation.md).

**Later, only when needed:** another concrete task source, real Claude Code adapter, webhooks, parallel consumers, dependency scheduling, PR publication, CI feedback, stronger isolation, or remote recovery. Add another connector without changing Task or the coding loop; do not ship a placeholder connector now.

Regression verification must retain baseline failure, pass without repair, repair then pass, repair exhaustion, execution/auth/protocol errors, timeout/cancellation, retained workspace/logs, and unchanged source. Add source tests without weakening those cases. Default tests must not call Jira or a real LLM. T16 is not considered passed by mocked connector tests.

## Jira API references

These references support the external API details, not claims about implemented harness behavior. Verified 2026-09-16.

[J1]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
[J2]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
[J3]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
[J4]: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
[J5]: https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/
