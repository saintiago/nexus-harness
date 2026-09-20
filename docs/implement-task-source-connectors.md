# Implement task input source connectors — Jira first

## Assignment

Extend the existing local TypeScript development harness with task-source intake. Do not rebuild the repository, replace its runner, or reimplement completed T01–T15. Preserve the existing Codex configuration and keep T16's live-runtime evidence separate.

Read `AGENTS.md` if present, then [spec.md](spec.md), [architecture.md](architecture.md), and [WORKFLOW.md](WORKFLOW.md). Inspect the real code before choosing file names or changing interfaces. These three updated documents are the requested design; this task turns that design into code.

The user must be able to preview ready Jira tasks, fetch and automatically execute a finite batch on demand, or leave one foreground process polling for further tasks. Each issue becomes the existing four-field Task and goes through the existing workspace → agent → checks → repair → result flow.

**Status, 2026-09-19.** This assignment is history: it records the increment that added Jira intake,
and it predates the implemented workspace-continuation contract
([implement-workspace-continuation.md](implement-workspace-continuation.md)). Where the two disagree
about what an attempt does, the continuation contract wins: one issue's attempts share a retained
workspace, its recorded base stays the comparison base, and a re-armed issue continues that
workspace rather than cloning again. The two instructions below that changed are marked in place.

## Scope

Implement only Jira Cloud through direct REST API v3. Add one optional `source` config, a small `TaskSource` contract, and one serial coordinator. No database, message broker, HTTP server, webhooks, OS service installer, plugin registry, source array, parallel workers, generic workflow engine, or custom DeepSeek adapter.

Future connectors should need a concrete adapter plus config/CLI wiring, not a change to Task or the coding loop. Do not implement a second source or add a throwing placeholder to demonstrate extensibility. Use fakes only in tests.

Preserve all existing configuration/task inputs, commands, setup/check ordering, process safety, timeouts, cancellation, logging, and local reports. Existing file-based runs must still work without Jira credentials or network. Do not modify the user's Codex defaults, native profiles, API tokens, or real Jira issues as part of offline development.

## Implementation steps and verification

### S01 — Inspect the application and pin compatibility

Identify the actual config/Task schemas, CLI parser, runner entry point and return value, process launcher/environment handling, workspace preflight, report writer, signal handling, and test conventions. Reuse existing helpers. Keep the selected Codex prefix and adapter-owned noninteractive/workspace restrictions intact.

**Verify:** Run the existing offline validation gate before changing code. Record any pre-existing failure separately. Keep tests for the legacy six-field config, absent/default agent, explicitly selected agent, strict four-field Task, and current `run --task` behavior. Do not treat prior reports of task completion as test results from this checkout.

### S02 — Add strict source configuration and the CLI boundary

Implement the exact source fields/defaults in WORKFLOW. `cloudId` is required for Jira; use only the service-account scoped-token gateway route. No credential values belong in configuration. Make `check-config --config ...` valid without `--task`; when a task is supplied, continue validating it as before.

Add:

```text
source list --config <file>
source run --repo <path> --config <file> [--limit <positive integer>]
source watch --repo <path> --config <file>
```

Only source commands instantiate the connector. Require repo/config as specified, reject source `--task`, reject `--limit` outside source run, and preserve original CLI error/interrupt conventions. Help must distinguish read-only preview from commands that automatically run paid coding work.

**Verify:** Config tests cover legacy inputs, minimal/default source, every invalid field/type/null, unknown source kinds, bad URLs/cloud IDs/env names, duplicate status names, polling bounds, and invalid limits. Static validation makes no directories, subprocesses, credential reads, or network calls. Manual file runs and the existing live-runtime verifier ignore `source` operationally.

### S03 — Implement the Jira adapter and deterministic Task mapping

Use a small explicit factory and built-in fetch/existing HTTP helper. Implement enhanced JQL search, current issue reads, transition discovery/writes, and result comments using the endpoints in architecture. Use actual mocked HTTP responses resembling Jira REST data, not Rovo's converted Markdown responses.

Consume all `nextPageToken` pages into a finite, ordered, de-duplicated candidate batch before any claim. Do not use the deprecated search endpoint or return only the first page. Use configured project, type, label, ready status, and deterministic ordering; safely quote JQL literals.

Implement `listEligible`, `prepare`, `claim`, and `complete`. Map issue key/summary/ADF description/criteria to the existing Task schema. Preserve task content and reject missing, ambiguous, or unsupported meaningful input. `prepare` must refetch eligibility/content; `claim` must recheck the captured revision before mutation. False from claim means no mutation request was sent; an uncertain write throws.

Use the supported ADF nodes and exact heading rules in WORKFLOW. Do not run an LLM to extract Task, fetch attachments/comments/links, introduce custom fields, or turn a Verification section into trusted executable checks.

**Verify:** Tests cover multiple pages, an empty result, stale/duplicate issues, missing/repeated page tokens, invalid API responses, safely quoted JQL, issue moves/label/status/revision changes, null descriptions, duplicate/empty criteria, ordered/nested lists, code/line breaks/link destinations, unsupported nodes, and a fake heading inside a code block. Tests prove task text cannot choose a repo, agent, commands, environment, or limits.

### S04 — Add serial intake, lock, receipts, and source provenance

Put coordination outside the runner. Run the existing source/output preflight before creating intake state or making remote mutations. Acquire an exclusive intake lock for the connected project under the `workDir`: the lock namespace is the project's composed connection identity, so one storage root serves several projects while two consumers of one project are refused (HARN-33). Use the same batch function for on-demand and watch operation, and the existing runner in the same process for every valid task.

Implement the conservative reservation sequence in spec: fresh issue → valid Task → exclusive receipt → confirmed remote claim → existing runner → real local result → source feedback. Check receipt existence before processing old attempts. Recheck repo safety before each fresh reservation. Respect `--limit` and process one task at a time.

Receipt identity is a hash of source type, canonical site, and immutable issue ID. Initial creation must be exclusive; later updates atomic. A reserved/unknown attempt is not eligible again. Remove a just-created receipt only for the documented unequivocal pre-mutation stale skip. Corrupt receipts and unknown formats fail closed.

For source runs, write `source-task.json` containing the normalized Task and source reference before target commands execute, and add optional source provenance to the normal result/log. Do not add Jira transport types to the runner or rewrite old report files. Record actual run IDs, never fabricated ones.

**Verify:** A fake source plus the real orchestration tests prove serial ordering, all-page discovery before status changes, limit behavior, invalid/stale issue skips, continuation after handled task failure, source/output refusal before side effects, one active consumer, release of only an owned lock, and no duplicate runs across repeated scans/restart. Cover pre-claim crashes, post-claim uncertainty, missing final reports, corrupt receipts, and feedback failure. Changing key/revision or reopening an issue must not bypass its existing receipt.

### S05 — Add truthful feedback, bounded network behavior, and shutdown

Keep local runner outcomes exactly `passed`, `failed`, and `cancelled`. Publish only the compact summary specified in spec; use ADF comment bodies. Discover transitions by target status, require an unambiguous transition with no unsupported required fields, and never hardcode example transition IDs.

Default lifecycle is `To Do → In Progress → In Review`. Review means any completed local attempt needs attention; the comment carries the actual outcome. Do not automatically mark Done or alter a human-changed terminal status. Save local results before remote feedback and record any partial/failed delivery separately. Never retry coding to repair an API failure or blindly resend a comment after uncertain delivery.

Bound each HTTP request to 30 seconds and link caller cancellation. Reject redirects and sanitize HTTP diagnostics. Source list/run report transient read failures without retry loops. Watch waits and retries only safe discovery, respecting Retry-After and backoff; fatal configuration/auth/permission errors stop it. Mutation uncertainty and failed feedback stop execution for manual inspection.

Capture the service-account token privately from `tokenEnv`. Strip that variable from target/Codex child environments without deleting unrelated model-provider variables or mutating global process.env. Redact raw token values and Bearer authorization values from diagnostics. Never include request headers, full environment dumps, or raw issue bodies in recurring logs.

On Ctrl+C, stop taking new work, interrupt the active run through the existing shutdown code, preserve results/receipts, and allow only the specified bounded best-effort final feedback after confirmed cleanup. Do not retry an already-attempted or uncertain feedback sequence during shutdown. If termination cannot be confirmed, leave the lock for manual inspection and do not run further checks or start another task.

**Verify:** Mocked tests cover target-status versus transition-name differences, missing/ambiguous/required-field transitions, Bearer authentication, the required gateway route/prefix, rejection of missing `cloudId`, absent token, HTTP timeouts/redirects, 401/403/429/5xx, Retry-After longer than the local backoff cap, interrupt during idle sleep/HTTP/active coding, failed comment versus failed transition, and human status changes. Capture all logs and child environments to prove credentials do not leak. A remote failure never changes `passed` into a coding failure or starts a second agent run.

### S06 — Finish examples, documentation, and offline acceptance

Keep the supplied docs aligned with the implemented interface. Add a credential-free example config and an example Jira description to the repository's existing examples/docs convention. Document service-account creation/permissions, scoped API-token setup, persistent/session PowerShell token setup, queue readiness, source list/run/watch, read-only versus mutating commands, manual retry/lock recovery, and the one-consumer-per-connected-project boundary.

Explain that scans are periodic and pause during an active batch, that separate *issues* do not inherit each other's changes — since the continuation increment, one issue's attempts share and continue its workspace ([implement-workspace-continuation.md](implement-workspace-continuation.md)) — and that source results remain local until a person reviews/applies them. Do not suggest this implementation has distributed exactly-once execution or security isolation for untrusted code.

**Verify:** Run the full offline `npm run validate` gate. Keep any actual existing equivalent command if the repository uses another spelling. Default discovery, CI, and `npm test` must require neither Jira nor LLM credentials and must make no real network calls. Run a CLI-level fake-transport/fake-agent test that demonstrates preview without side effects, a one-shot run, and a watch cycle picking up a later eligible issue.

### S07 — Provide opt-in live verification and evidence

Prepare a reproducible manual exercise or an explicitly opt-in script; never include it in default tests. Ask the operator to configure credentials locally, not paste them into an issue or chat. Missing credentials or agent access must be reported as **live verification not run**, not as a pass or as a reason to skip offline implementation.

The supervised exercise must:

1. Use a disposable committed repository, external workDir, and an isolated/explicitly inspected Jira queue. Confirm its baseline is green with trusted local checks.
2. Run source list; verify expected issue mapping and no issue changes, directories, or paid agent calls.
3. Run one approved smoke issue with `--limit 1`; inspect exactly one local run, its workspace/check evidence, receipt, Jira comment, and review status.
4. Independently assert the expected marker file's exact bytes and full tracked/untracked diff. Do not rely on shell substitution, which loses trailing newline information. Do not make an absent post-change marker a mandatory baseline check.
5. Restart intake and confirm the receipt prevents duplicate execution of an issue that names no workspace to continue. (Since the continuation increment, returning an issue to the ready status with its pointer label continues that workspace instead of re-running it from scratch.)
6. Start watch; create or make a second approved issue eligible while it is idle; verify one subsequent run, then stop cleanly. A later eligible issue is a new immutable identity, not an implicit retry of the first.

Do not alter unrelated Jira work, use real application changes as a disposable fixture, deliberately exhaust paid provider retries, or delete retained artifacts. The existing `SAM1-11` is a candidate for a supervised exercise only after the operator checks the preview, target repository, and credentials. A code agent must not execute this live exercise merely because the documentation names that issue.

**Verify:** Report concrete commands, exit codes, issue keys, local run IDs/artifact paths, mapping evidence, observed Jira outcome, exact-byte/diff assertion results, and whether the later-issue/restart checks ran. Keep tokens and headers out. Do not claim T16 or the Jira live path passed based on mocks.

**Status, 2026-09-17.** The read-only half has been exercised against the operator's own queue
(`HARN`, on a site whose default language is not English): `source list` read the real queue through
a service-account token, and — after the language fix this exercise surfaced — reported `HARN-1` as
valid and unattempted. The first run reported it `stale`, because the queue's JQL matched the
canonical names while the site answered with translated ones; that defect and its evidence are
recorded in [README.md](../README.md). That read changed nothing. Since then, real Jira-driven runs
have claimed HARN-2, commented on it, and moved it through its statuses, and one continued its
retained workspace and left a local commit there; [README.md](../README.md) and
[implement-workspace-continuation.md](implement-workspace-continuation.md) record that evidence and
its limits. The supervised exercise above is still **not run as written**: it needs a disposable
repository and an inspected queue, and its exact-byte assertion, restart check, and watch cycle have
no live evidence.

## Definition of done

The updated implementation preserves file-task behavior and implements source list, finite source run, and foreground source watch through one Jira adapter and the existing runner. Offline tests prove mapping, serial intake, duplicate prevention, API errors, secret handling, and cancellation. Docs/examples match real help and validation behavior. Live verification has either explicit evidence or an honest not-run explanation.

Return a compact implementation report: files changed; how to run; offline commands/results; live commands/results or missing prerequisites; and any genuine mismatch between the requested behavior and actual code. Do not substitute a fresh scaffold or a large framework for this feature.
