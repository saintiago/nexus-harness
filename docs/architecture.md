# Architecture

One TypeScript CLI application, a few modules, and local files. No services, framework layers, database, or custom workflow engine.

**Revision: 2026-09-16 — task input sources, Jira first; service-account authentication.** Extend the existing application; do not replace completed modules. [spec.md](spec.md) defines behavior, [WORKFLOW.md](WORKFLOW.md) defines inputs, and [implement-task-source-connectors.md](implement-task-source-connectors.md) is the implementation assignment. Preserve the earlier Codex-launch extension. These documents describe requested changes, not evidence that they are implemented.

## 1. Keep the existing application

Retain the modules introduced by the completed tasks:

```text
src/
  cli.ts + cli/       # arguments, help, exit codes, command dispatch, top-level wiring
  config/             # input schemas, defaults, configuration-relative paths
  shared/             # small data contracts, and the one message helper
  process/            # starting, bounding, and stopping one command
  checks/             # one setup/check round and what a result means
  workspace/          # Git and per-run working copies, the ledger, the change summary
  runs/               # implementation/check/repair coordination and how a run ends
  reporting/          # result.json and log persistence
  sources/            # the source contract, receipts, guidance, the coordinator
  sources/jira/       # the Jira Cloud connector
  agents/codex/       # Codex CLI invocation and normalized turn results
```

The full tree, the placement rules, and the extension steps are in
[module-structure.md](module-structure.md); this section keeps the same ownership rules.

Inspect the actual repository before editing. Reuse its existing process-launch and shutdown helpers wherever they currently live; this change does not require moving them or recreating modules.

Ordinary named exports are enough. No directory-per-interface pattern, barrel hierarchy, generic provider factory, plugin registry, or dependency-injection container.

## 2. Responsibilities

The CLI loads inputs and wires `runTask`. A source command adds intake around it; a file-task command calls it directly. The runner chooses the coding/check order and whether a repair is allowed. Helpers perform concrete operations.

```text
cli → config
cli → runner → workspace
             → agent
             → checks
             → report
```

Only `agents/codex/` talks to a coding runtime. Only `workspace/` handles Git/working-copy preparation. Only `process/` starts or stops a process, and `checks/round.ts` says what a configured command's result means. Report file writes belong in `reporting/`.

`config.ts` validates the optional `agent` object, supplies the legacy default when it is omitted, and applies the path rules in WORKFLOW. CLI composition passes the effective selection to the existing agent adapter. The runner does not interpret profiles, model IDs, credentials, CLI events, or provider APIs.

Keep these two configuration responsibilities separate:

| Concern | Owner |
| --- | --- |
| Coding runtime, executable/launcher, non-interactive protocol, turn completion and shutdown | Harness configuration and runtime adapter |
| Model, provider endpoint, credentials, reasoning settings, model catalog, gateway/AWS configuration | Coding runtime's native configuration and process environment |

There is no harness-level model catalog, provider SDK, token store, or automatic model selection. Changing a model behind Codex does not create a new harness adapter. A different coding program with a different CLI/event protocol does.

Keep `types.ts` limited to shared data. Infer types from validation schemas where convenient; do not duplicate the schema. Preserve the effective agent selection; add only source provenance needed by reports. Keep connector-specific request/response types local to the connector.

## 3. Testability without a framework

Retain the runner's plain argument object of functions for substitutions. Runner tests use a fake agent and scripted check outcomes. Real file/process/Git tests use temporary directories. Normal validation remains offline and needs no provider credentials.

Extend the existing fake-executable Codex tests to prove default and configured launch prefixes, implementation and repair, errors, cancellation, and log hygiene. The fake belongs in tests, not in the public runtime selection.

Live verification uses the same production adapter and selected agent configuration, but is opt-in. It must not require evidence of an OpenAI account when the selected runtime authenticates to another provider. See the setup task for the replacement of the old live-verifier prerequisite gate.

Keep imports directional and acyclic. Retain the existing lightweight lint checks; do not introduce an architecture-enforcement platform.

## 4. Working copy and runtime

Use a separate local clone per run. Do not add linked worktrees or interchangeable workspace backends as part of this change.

### Configurable launch, one implemented runtime

The optional configuration is:

```json
{
  "agent": {
    "runtime": "codex",
    "command": ["codex", "--profile", "deepseek"]
  }
}
```

`command` is a literal launch prefix, not a complete shell command. The current adapter appends its existing arguments:

```text
<command prefix> exec --sandbox workspace-write --json -
```

The adapter sends the prompt through stdin, runs in the retained workspace, consumes the runtime's structured output, and returns the existing normalized turn result. It does not concatenate a shell string. WORKFLOW owns validation and launcher-path rules.

Omitting `agent` preserves the effective prefix `["codex"]` and the existing default invocation. An explicit selection must not silently fall back to that default after an error.

Only `runtime: "codex"` is implemented in this increment. Reject `"claude"` and other runtime values until their actual adapters exist. A wrapper can change how Codex is started, but must still preserve its arguments, working directory, standard streams, exit behavior, and process-lifetime contract. A Claude launcher is not a Codex adapter.

### Runtime-owned settings

The production harness never writes the user's Codex configuration, copies model catalogs, logs into accounts, or runs provider setup scripts. Those are one-time operator/setup-agent actions described in the setup task.

The local setup must preserve normal OpenAI Codex defaults and use an explicitly selected DeepSeek profile. For a different Codex-backed provider or gateway, the operator supplies a compatible native configuration; the harness does not implement protocol translation or claim compatibility without a live test.

Keep the selected launch prefix fixed across implementation and repairs. Native runtime settings remain external files, not a frozen harness snapshot; this version does not promise reproducibility if the operator changes them during a run.

The local execution model assumes a trusted repository and machine. A clone and a child process are not a security sandbox. Keep existing runtime restrictions and stop behavior; do not add a permission bypass to make a provider test pass.

## 5. State and reporting

Use the existing ordinary async function and bounded loop. Keep loaded settings, deadline, repair count, and check results in memory. No workflow/state-machine library or automatic crash recovery.

Retain `result.json`, the append-only `logs/run.log`, separate command stdout/stderr files, and separate agent output per coding turn. Preserve earlier failures and unfinished working directories.

Record the effective agent runtime and non-secret launch prefix once in the report and lifecycle log. This is configured launch information, not proof of the upstream model that served a response. Do not parse native profile files in production merely to populate provider/model labels, and never copy their contents or environment values into reports.

The result remains an output artifact, not a database or service API. Source-triggered runs add optional source provenance and `source-task.json`, containing the normalized Task and source reference, written before target commands execute. Existing file-task output remains compatible. Intake owns only the small lock/receipts described below; do not add distributed leases, journals, event sourcing, a general run registry, or migrations of old reports.

## 6. Tooling and growth

Keep npm, strict TypeScript, ESLint, Prettier, Vitest, Zod, the existing dev runner, and the lockfile. CI continues to run the full offline `npm run validate` gate.

Add Claude Code only as a later concrete adapter with its own invocation/event parser and tests. Share existing process-lifetime code where useful; keep vendor types out of the runner. Do not build it, accept it in validation, or add a throwing placeholder now.

Jira intake is the current addition. PR publication, CI observation, stronger isolation, parallel work, provider routing, and dashboards remain deferred. Keep one application until an actual feature requires otherwise.

## 7. Small task-source boundary

Add at most these three modules, reusing equivalent existing helpers when present:

```text
src/
  sources/contract.ts     # source contract and the ordinary source data
  sources/coordinator.ts  # sequential batch/watch coordination, lock and receipts
  sources/jira/           # Jira REST calls, eligibility, description mapping, transitions/comments
  sources/jira/adf*.ts    # small ADF reader and plain-text comment builder
```

```text
file command ───────────────────────→ runner → existing helpers
source command → source coordinator → runner → existing helpers
                         │
                         └─ TaskSource → jira → Jira REST API
```

`cli.ts` selects `createJiraSource` with a simple explicit branch for `source.type`. The coordinator knows only ordinary source data and functions. The runner never imports Jira, JQL, ADF, polling, or connector credentials. Input connectors and coding-runtime adapters are separate axes; adding GitHub intake later must not require a new coding adapter.

A sufficient contract is:

```ts
// Illustrative signatures; adapt to the repository's existing Task/RunResult types.
type SourceRef = {
  type: string;
  scope: string;      // canonical Jira site URL; stable across API auth routes
  id: string;         // immutable issue ID, not the issue key
  key: string;        // human-facing issue key
  url: string;        // browser link, never an API self URL
  updatedAt: string;  // captured revision before claiming
};

type SourceCandidate = { ref: SourceRef; title: string };
type SourceTask = { ref: SourceRef; task: Task };

interface TaskSource {
  listEligible(signal: AbortSignal): Promise<SourceCandidate[]>;
  prepare(item: SourceCandidate, signal: AbortSignal): Promise<SourceTask | null>;
  claim(item: SourceTask, signal: AbortSignal): Promise<boolean>;
  complete(item: SourceTask, result: RunResult, signal: AbortSignal): Promise<void>;
}
```

`listEligible` consumes all pages and returns a finite de-duplicated ordered batch, not an API cursor. `prepare` fetches current content, tests eligibility again, maps and validates Task, and returns null for an issue no longer eligible. Invalid task content is a typed per-issue diagnostic, distinct from transport failure.

`claim` rechecks the captured revision/eligibility and transitions to running. False means it sent **no mutation request**, so the coordinator can remove its just-created receipt. Once a mutation request was sent, an uncertain/error result throws and retains the receipt. A confirmed claim is required before invoking the runner.

`complete` publishes a bounded summary and attempts the review transition. Give it only needed result data, not process environments or raw transcripts. If useful, project the existing RunResult into a small object at the call site; do not introduce a hierarchy of result interfaces. A failure can carry acknowledged comment ID/stage for the receipt, so partial delivery is visible.

This interface supports future concrete sources without a plugin loader, class inheritance, capability negotiation, or speculative optional methods. An actual later source can use a remote marker instead of Jira's status transition while preserving the same coordinator contract.

## 8. Coordinator and local files

Load/freeze configuration once per invocation. Pass the same trusted repository/config and effective agent to each ordinary run; each run still has its own generated ID, clone, task deadline, and bounded repairs. Queue tasks do not select repositories or share mutable working copies.

Use a plain `for...of` with awaited calls. A watch loop invokes the same finite batch function, then awaits an abortable timer. No parallel background poller, worker queue, cron library, or separate daemon is needed. Small function arguments for source, runner, clock/sleep, fetch, and filesystem tests are sufficient; reuse existing test conventions.

```text
<workDir>/
  .intake/
    lock/                      # exclusive mkdir; owner metadata for manual inspection
    receipts/
      <sha256-identity>.json    # one attempted external item; kept across restarts
  <run-id>/
    source-task.json            # only source runs: { task, source }
    workspace/
    result.json                 # usual outcome plus optional source reference
    logs/...
```

Hash a canonical encoding of `(type, scope, immutable id)` for receipt filenames; never use issue text as a path. The source site identifies Jira for human links and receipt identity; API calls always use the service-account gateway route. Do not include issue revision, project, repo, config path, or credentials in receipt identity. One workDir must not be repurposed for a different target without explicit operator review.

Take the exclusive lock only after the existing overlap/clean-checkout preflight, before discovery intended for execution. Validate the source checkout again before each reservation. A read-only preview only reads existing receipts and must not create directories. Acquire with exclusive directory creation; release only the owned lock after cleanup, not another process's lock. Never auto-break a lock on PID/age assumptions.

A receipt needs only `version: 1`, source reference, reservation timestamp, and optional actual run ID, result path, outcome, feedback state (`pending`, `sent`, `failed`), acknowledged comment ID, and a redacted diagnostic. Create with exclusive file creation; update through a same-directory temporary file and atomic replacement. Treat corruption as an error. A receipt without a run ID means reserved/uncertain, not a run that succeeded. The source snapshot in a run directory permits manual correlation after a crash before the receipt update.

Store the source reference with the normal result and lifecycle log. Keep intake diagnostics in the terminal and relevant receipts; do not add another persistent logging platform. Logs/errors from HTTP must be sanitized. If run creation fails before a real RunResult exists, retain the reservation/error and stop; do not invent a failed result or run ID.

Preserve the coding outcome even when source feedback fails. The coordinator, not the runner, decides the source command's nonzero exit and records failed delivery. Manual retries/recovery are documented in WORKFLOW. There is no cross-machine coordination, automatic replay, or crash recovery.

## 9. Jira-specific implementation

Use the project's Node runtime and built-in `fetch` unless an existing tiny HTTP helper already suffices. Do not add an Atlassian SDK or run Rovo/MCP inside the harness. The local process authenticates independently using a Jira service-account scoped API token; ChatGPT's Rovo session is not its credential source. [A1]

WORKFLOW defines the required `cloudId`, gateway URL, token environment variable, configuration defaults, and JQL. Implement these documented REST API v3 calls: [A2], [A3], and [A4]

| Operation | Endpoint suffix |
| --- | --- |
| Find eligible issues | `POST /rest/api/3/search/jql` |
| Read current issue | `GET /rest/api/3/issue/{id}?fields=summary,description,status,labels,project,issuetype,updated` |
| Find allowed transitions | `GET /rest/api/3/issue/{id}/transitions?expand=transitions.fields` |
| Change status | `POST /rest/api/3/issue/{id}/transitions` |
| Publish result | `POST /rest/api/3/issue/{id}/comment` |

Use the configured project/type/label/ready status to build a safely quoted JQL expression, `ORDER BY created ASC, key ASC`. Request only needed search fields. Follow `nextPageToken` until `isLast`; reject a missing/repeated continuation token on a nonfinal page. Never use a returned `total`, old `startAt` pagination, or a fixed first page as the complete queue. This API may return stale search data; use current issue reads as additional checks. [A2]

Select a unique available transition whose `to.name` equals the configured target status. Missing, ambiguous, or required-input transitions produce actionable errors. Do not hardcode the transition IDs observed in the example project; status names and transition names are different concepts. Write ADF comments using ordinary paragraph/text nodes. [A3][A4]

The ADF reader supports only the explicit task convention in WORKFLOW. Keep it deterministic and bounded; reject unsupported meaningful nodes rather than silently losing requirements. No LLM extraction or full rich-text conversion framework. [A5]

Each HTTP request has a 30-second timeout plus the caller's abort signal. Reject redirects rather than forwarding authentication elsewhere; do not trust issue-provided API URLs. Shared source error classification is enough: invalid-task, stale/not-eligible, retryable-read, fatal, and uncertain-write. Never automatically replay mutation requests. Watch's read retry delay respects `Retry-After`, with backoff capped at five minutes **before** applying a possibly longer server delay. [A6]

Resolve the configured service-account token once when constructing the connector. Reject a missing/blank value before any execution. Keep it in a private closure; neither validated config nor source reference stores it. Send `Authorization: Bearer <token>` only to the configured `api.atlassian.com/ex/jira/<cloudId>` route. Pass target commands and Codex an environment with `tokenEnv` removed, while preserving unrelated variables needed by the existing agent. Do not mutate global `process.env`. This reduces accidental exposure; it does not isolate an untrusted process running as the same OS user.

[A1]: https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/
[A2]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
[A3]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
[A4]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
[A5]: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
[A6]: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
