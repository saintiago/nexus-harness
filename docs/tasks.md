# Implementation tasks — simple development harness

Implement the remainder of the first working version after the scaffold. One local TypeScript CLI, one task per invocation, one retained working copy, and one final report. **Do not turn this backlog into a services/platform project.**

Place this file at `docs/tasks.md` in the scaffolded repository.

## Authority and scope

Read the repository's `AGENTS.md`, then [spec.md](spec.md), [architecture.md](architecture.md), and [WORKFLOW.md](WORKFLOW.md) before implementing. The [scaffold request](../scaffold-request.md) describes the completed foundation, not the remaining application. The supplied spec owns behavior; architecture owns module placement; WORKFLOW owns the JSON contracts. This backlog decomposes their requirements and does not replace them.

The scaffold is reported complete; its implementation was not supplied with this planning request. Inspect the actual code and reuse its schemas, CLI parser, scripts, and conventions. Do not rebuild it, restore the old architecture, or assume a helper already exists. Preserve user changes. Read the actual `AGENTS.md`; its contents were not included in the planning inputs.

The remaining scope ends at a working Codex implementation/check/repair loop with local artifacts. Jira, PR publication, merging, deployment, CI observation, resume/crash recovery, stronger isolation, parallel tasks, dashboards, and alternative providers remain out of scope. Do not create placeholders for them.

## How the implementation agent should use this file

Implement the next unchecked task whose dependencies are complete, unless explicitly assigned a different ready task. Complete one task and report its evidence before moving on. Add production modules only with their first real behavior. Use ordinary functions and a small runner dependency argument where substitution is needed; no interface framework, generic provider registry, or workflow library.

For **every task**:

1. Inspect the relevant existing code and tests; give a brief implementation plan.
2. Implement the behavior and meaningful automated tests. Use temporary sibling source/output directories, local Git fixtures, and controlled child processes. Default tests must not require a real LLM, network service, or credentials.
3. Run the listed focused verification, then `npm run validate`. A required command that cannot run is a verification gap, not a pass. Clean up only test-owned processes and temporary fixtures, never the user's working tree.
4. Mark the task checkbox complete only after its acceptance criteria and required verification pass. Record changed files, commands, results, and any remaining limitations. Do not weaken tests to finish a task.

Test filenames below are proposed locations, not new architectural contracts. Reuse an equivalent existing test file rather than duplicating it. Commands assume the scaffold's `npm test` runs Vitest once; preserve that convention. `npm run validate` is the harness's own validation pipeline. JSON `setup`/`checks` are target-project commands and must stay separate.

### Small implementation choices made by this backlog

The source docs leave some mechanics open. These are proposed defaults, not additional product requirements:

- Treat equality or nesting in either direction between the normalized source repository and configured `workDir` as unsafe. Resolve existing symlink/junction aliases before comparing; do not rely on a raw string prefix. This conservative rule is why fixtures use sibling directories.
- Use CLI exit `0` for `passed`, `1` for `failed` or CLI/preflight/reporting errors, and `130` for a user-cancelled run. Other deliberate signal conventions may be documented, but may never report failure as success.
- Treat a command's unexplained signal termination as an execution failure, not ordinary repair feedback. Normal nonzero **check** exits are repairable; setup failures, launch failures, timeouts, and agent failures are not.
- Tests can inject a fake agent or a fake Codex transport at an internal boundary. Do not add a public fake-agent mode, provider selection field, or test-only production command.

Keep the six configuration fields and four task fields unchanged. Choose and document supported host platforms during process implementation; do not silently assume Unix shell or process-group behavior works on native Windows. Native Windows support must test the appropriate npm/executable launcher and argument handling; WSL-only support must be described as WSL-only.

## Ordered backlog

Dependencies are task IDs. The normal execution order is top to bottom.

| Done | ID | Task | Depends on |
| --- | --- | --- | --- |
| [x] | T01 | Read-only repository and output-path preflight | Scaffold |
| [x] | T02 | Unique run directory and dedicated local clone | T01 |
| [x] | T03 | Literal-argument command execution and logs | T02 |
| [x] | T04 | Sequential setup and complete check rounds | T03 |
| [x] | T05 | Final report and attempt evidence | T02, T04 |
| [x] | T06 | Baseline and implementation loop with a fake agent | T04, T05 |
| [x] | T07 | Bounded repair loop and honest outcomes | T06 |
| [x] | T08 | Total deadline, command limits, and timeout shutdown | T07 |
| [x] | T09 | Cancellation and confirmed process shutdown | T08 |
| [x] | T10 | Final diff inspection and review warnings | T07, T09 |
| [x] | T11 | Offline local-loop milestone | T10 |
| [x] | T12 | Real Codex adapter with offline contract tests | T11 |
| [x] | T13 | Public `run` command and terminal UX | T12 |
| [ ] | T14 | Built-CLI end-to-end regression gate | T13 |
| [ ] | T15 | Operating docs, live-test entrypoint, and offline validation | T14 |
| [ ] | T16 | Opt-in live Codex implementation and repair exercise | T15 |

T01–T11 deliver the local workspace/check/report loop using a test fake. T12–T15 deliver the integrated application and its offline verification. T16 records live-runtime evidence separately; missing credentials must not break normal CI or be disguised as a completed live test.

---

## T01 — Read-only repository and output-path preflight

**Depends on:** scaffold. **Main files:** `src/workspace.ts`, existing config/types only where needed. **Sources:** spec §§2, 5; WORKFLOW §3.

### Implement

Add the actual preflight helper that validates the requested local source and output location without allocating a run. Resolve the supplied repository to its real repository root and obtain its committed `HEAD`. Accept a clean detached checkout with a valid commit; reject a non-repository, a bare repository without a working checkout, or an unborn repository.

Reject staged changes, unstaged changes, and non-ignored untracked files. Ignored local files are not part of the committed snapshot. Check source/output overlap using the policy above, including a not-yet-created `workDir` beneath an existing aliased parent. Return the normalized source and base commit for preparation; do not reset, stash, clean, checkout, or edit the source.

### Acceptance and verification

`tests/workspace.test.ts` must prove:

- A clean repository yields its root and exact commit, including when invoked from another current directory.
- Each dirty-source case, missing commit/repository, and unsafe path case fails with a useful explanation and creates no run directory.
- Equal, nested, and existing symlink/junction-alias paths are rejected on the supported platform; sibling names such as `repo` and `repo-other` are not mistaken for overlap.
- The source's contents, HEAD, refs, and staged/unstaged state remain unchanged after accepted and rejected preflight calls.

Run `npm test -- tests/workspace.test.ts`, then the common validation gate. Do not add the public `run` command yet.

## T02 — Unique run directory and dedicated local clone

**Depends on:** T01. **Main files:** `src/workspace.ts`, necessary data in `src/types.ts`. **Sources:** spec §§2, 4; architecture §4.

### Implement

Allocate `<workDir>/<generated-run-id>/workspace` and `logs` without deriving filesystem names or branch names from task text. Create a separate local clone based on the committed HEAD recorded in preflight and a dedicated local branch. Verify that the actual base matches the recorded commit; do not silently use a different source HEAD if it moves during preparation.

Do not use linked worktrees or add interchangeable workspace backends. Retain partial directories on preparation failures for inspection. Never reuse, overwrite, automatically resume, or delete a previous run directory.

### Acceptance and verification

Extend `tests/workspace.test.ts` to prove:

- Two runs receive different directories/branches and each starts from the recorded committed contents.
- Edits and local commits in one clone do not change the source or the other clone. Ignored source files are not copied into the snapshot.
- Task IDs containing separators, shell punctuation, or traversal text remain labels and cannot determine output paths or branch arguments.
- Simulated clone failure or a pre-existing destination cannot overwrite earlier work; partial output is retained and the error identifies its location.
- A source-HEAD change cannot produce a reportable workspace with an incorrect recorded base.

Run `npm test -- tests/workspace.test.ts`, then the common validation gate.

## T03 — Literal-argument command execution and logs

**Depends on:** T02. **Main files:** `src/checks.ts`, log operations in `src/report.ts`, small result data in `src/types.ts`. **Sources:** WORKFLOW §§1, 3; architecture §2; spec §§4, 5.

### Implement

Execute one configured command in the task workspace using its argument array. Preserve argument boundaries, intentional empty arguments, spaces, quotes, and shell-looking characters. Do not concatenate command strings, interpolate task/config text, or implicitly expand environment variables. Use a platform-appropriate launcher; explicitly document unsupported cases.

Record command arguments, working directory, start/end times, exit code or signal, launch errors, and stdout/stderr log locations. Capture useful output without discarding earlier evidence. Keep report/log file creation in `report.ts`; `checks.ts` owns launching configured commands. Avoid dumping the environment or authentication material into logs. Timeout and cancellation behavior is completed in T08–T09, before public execution is enabled.

Also create one append-only human-readable `logs/run.log` per run. It is a lightweight lifecycle timeline, not a structured logging subsystem. Append timestamped messages for meaningful state changes such as run preparation, baseline start/result, agent turn start/result, check-round start/result, repair start/result, cancellation/timeout, and final status. Keep messages concise and useful for debugging. Do not add Winston/Pino, log-level configuration, tracing IDs, JSON event streams, or another logging abstraction. Command stdout/stderr remain in their own files rather than being duplicated into `run.log`.

### Acceptance and verification

`tests/checks.test.ts` must use real harmless child processes to prove:

- A fixture receives the exact argument array and workspace current directory, including an empty string and shell-looking literal arguments; no interpolation or unintended sentinel command occurs.
- Success, ordinary nonzero exit, and missing-executable/launch failure remain distinguishable. Missing execution cannot become an exit-0 result.
- Both output streams are persisted and associated with the correct command. Repeated invocations do not overwrite earlier logs.
- `logs/run.log` is append-only: multiple lifecycle messages appear in chronological order with timestamps, and later writes do not erase earlier messages.
- `run.log` does not duplicate full command stdout/stderr and does not contain an environment dump or known secret fixture value.
- Workspace paths containing spaces work. Any claimed native Windows launcher support is exercised rather than assumed.

Run `npm test -- tests/checks.test.ts`, then the common validation gate.

## T04 — Sequential setup and complete check rounds

**Depends on:** T03. **Main files:** `src/checks.ts`, related result types. **Sources:** spec §2; WORKFLOW §§1, 4.

### Implement

Compose the command helper into one reusable setup/check round. Run setup commands in order; an empty setup list is valid. After successful setup, run every configured check sequentially, collecting each result. Ordinary check failures do not skip later checks. Setup failure or a command that cannot execute terminates the round as an execution error, not repair feedback. T08–T09 add the corresponding timeout/cancellation stop paths.

Make the distinction between a completed red check round and an incomplete execution explicit in the returned data. Do not represent an unexecuted check as a successful result.

### Acceptance and verification

Extend `tests/checks.test.ts` with an event-recording fixture:

- Two setup commands and multiple checks run in exactly configured order, with no overlap.
- A first ordinary failing check is followed by all remaining checks, preserving each result.
- A failing setup command prevents later setup/check commands. A missing executable stops execution and is not a repairable red round.
- Empty setup runs the checks directly. A fully successful round contains one successful observed result per configured check.

Run `npm test -- tests/checks.test.ts`, then the common validation gate.

## T05 — Final report and attempt evidence

**Depends on:** T02, T04. **Main files:** `src/report.ts`, the small run-result data contract. **Sources:** spec §§3, 4, 5; architecture §5.

### Implement

Write a readable `result.json` in the run directory. Use only `passed`, `failed`, and `cancelled` as final run statuses. Include task/run IDs, normalized source path and base commit, workspace path, start/end times, repairs used, status/reason, and check evidence grouped by baseline and implementation/repair attempt. Preserve command arguments, exit/signal/timeout information and log locations, including the run timeline location. Keep agent summaries separate from observed checks.

Persist useful agent output per top-level coding turn in distinct files such as `logs/agent-implementation.log`, `logs/agent-repair-1.log`, and so on. Do not overwrite previous turns. `result.json` should reference these files rather than copying large agent transcripts into the report. `logs/run.log` remains the compact lifecycle overview; detailed command and agent output stays in dedicated files.

Add report fields only for real uses. Preparation can fail after directory creation: report known facts and clearly mark unavailable workspace/preparation information instead of fabricating a successful clone. Runs that fail before allocating a directory have a CLI diagnostic, not an invented report. Leave incomplete directories from crashes alone.

### Acceptance and verification

`tests/report.test.ts` must parse real written reports and assert:

- Passed, failed, and cancelled examples contain the required context and unambiguous reasons/evidence.
- Baseline plus multiple attempts retain earlier failures and distinct log references; agent text claiming success cannot replace check results.
- The report references `logs/run.log` plus distinct command/agent log files without embedding their full contents. Multiple agent turns keep separate files and never overwrite earlier output.
- A preparation failure can be represented without pretending that a workspace was created.
- Writing a report does not remove or modify workspace files or another run's artifacts.
- An unwritable destination produces a surfaced reporting error. No success message or fictitious report path is produced by the helper.

Run `npm test -- tests/report.test.ts`, then the common validation gate. Do not add a database, journal, resumability contract, or background repair of incomplete reports.

## T06 — Baseline and implementation loop with a fake agent

**Depends on:** T04, T05. **Main files:** `src/runner.ts`, small data additions; test fake under `tests/`. **Sources:** spec §§1, 2, 6; architecture §§2, 3, 5.

### Implement

Introduce `runTask` as an ordinary async function. Supply a small plain argument object of concrete functions when tests need to substitute workspace, agent, checks, reporting, or time. Do not create a generic port bundle or a production fake-agent module.

Implement the first vertical path: prepare → setup/baseline → implementation → setup/post-agent checks → report. Keep the loaded task and command plan fixed in memory and outside the working copy. Supply the fake agent with task text, acceptance criteria, and workspace context. Await the complete agent turn before running setup/checks. Append the corresponding lifecycle transitions to `logs/run.log` and persist the implementation turn's useful output in its dedicated agent log. This task can finish the no-repair path; T07 adds repair behavior, and public `run` remains unavailable until T13.

### Acceptance and verification

`tests/runner.test.ts` must prove:

- A red baseline or baseline setup/launch error results in `failed`, retains available artifacts, and calls the agent zero times.
- A green baseline invokes one implementation turn followed by setup and all checks, then writes `passed` only when those post-agent checks pass.
- No post-agent command starts while the fake agent is still active.
- The lifecycle timeline shows baseline → implementation → post-agent checks → finalization in the observed order, without copying complete command output into the timeline.
- A throwing/failed agent produces `failed` without inventing post-agent results and retains any useful agent log written before failure.
- Changing the input files or a config copy in the workspace during the agent turn cannot change the loaded command plan.

Run `npm test -- tests/runner.test.ts`, then the common validation gate.

## T07 — Bounded repair loop and honest outcomes

**Depends on:** T06. **Main files:** `src/runner.ts`, existing report/agent-turn data. **Sources:** spec §§2, 3; WORKFLOW §4.

### Implement

After a completed red post-agent check round, call a repair turn only when allowance remains. Give it the failed commands, observed failure output, and available log locations, along with the original task context. Repeat setup and every configured check after each completed repair. Preserve all attempts and agent summaries in the final result.

`maxRepairs` counts additional top-level coding turns, not tool calls or internal runtime events. Stop immediately after the first fully green post-agent round. A setup/launch error or an agent failure is terminal; do not spend another repair on infrastructure failure or add outer-loop retries.

### Acceptance and verification

Extend `tests/runner.test.ts` with exact call-order and count assertions:

- `maxRepairs: 0`: at most one implementation turn, zero repair turns, and `failed` on red post-agent checks.
- `maxRepairs: 2`: at most three coding turns total. Two failed repair rounds exhaust the allowance; the report says `repairsUsed: 2`.
- Implementation fails checks, first repair passes: exactly two coding turns, `repairsUsed: 1`, and no further agent call.
- Setup/check launch failure or agent failure during a repair sequence stops without an extra turn.
- A fake agent saying “done” or “tests passed” cannot override red/missing checks. Failure feedback refers to observed command results and earlier evidence remains available.

Run `npm test -- tests/runner.test.ts`, then the common validation gate.

## T08 — Total deadline, command limits, and timeout shutdown

**Depends on:** T07. **Main files:** `src/runner.ts`, `src/checks.ts`, `src/workspace.ts`, related report data. **Sources:** spec §3; WORKFLOW §1.

### Implement

Establish one task deadline before preparation and carry its remaining budget through repository work, setup, coding turns, and checks. Do not restart the task clock per phase or repair. A setup/check command receives the smaller of its configured command limit and the remaining task time. Git preparation and agent work are bounded by the remaining task time, not by a newly invented configuration field.

On timeout, stop active owned execution and await termination before continuing to finalization. Do not launch more commands or repairs. Include timeout details and any unconfirmed termination in the report/diagnostic. A timeout is `failed`, not ordinary red check feedback. If timeout occurs before a run directory can be allocated, explain that no report/workspace was created rather than inventing one.

Keep lifecycle helpers small. Shared process-lifetime code is justified only by actual callers; Git remains owned by `workspace.ts` and configured commands by `checks.ts`. Use an injectable clock or internal short-duration test budget rather than weakening the public positive-integer minute validation.

### Acceptance and verification

Extend `tests/runner.test.ts`, `tests/checks.test.ts`, and `tests/workspace.test.ts` to prove:

- Time spent preparing the clone consumes the same budget used by later phases; repair cannot reset it.
- Both limit orderings work: command limit shorter than remaining task time, and remaining task time shorter than command limit.
- Expiry during preparation, setup, a check, implementation, and repair stops the run, does not start further work, and retains available artifacts/evidence.
- A controlled real command and its owned long-running child are terminated on timeout on the supported platform. A never-finishing fake agent receives a stop request and is awaited.
- Unconfirmed termination is explicitly reported and prevents checks, repair, or any assertion that the working copy is safe to reuse.

Run `npm test -- tests/runner.test.ts tests/checks.test.ts tests/workspace.test.ts`, then the common validation gate. Use bounded test cleanup; do not leave timed-out fixture processes running.

## T09 — Cancellation and confirmed process shutdown

**Depends on:** T08. **Main files:** runner and concrete execution helpers. **Sources:** spec §§3, 4, 5.

### Implement

Accept cancellation through the runner's ordinary execution context, using one consistent mechanism such as an abort signal. Stop owned commands/agent execution, await shutdown, then finalize as `cancelled`. Do not let a late exit-0 event, a concurrent timeout, or a late agent response overwrite an already recorded terminal reason. A simple first-observed stop reason is sufficient; no state-machine library is needed.

A successfully completed agent turn also requires a quiescent managed execution boundary before checks start. If termination cannot be confirmed, report that limitation, retain the work, and prevent further use by the current run. Do not claim control over arbitrary detached or unrelated host processes. Tests may only terminate processes they created.

### Acceptance and verification

Add `tests/lifecycle.test.ts` and extend runner coverage:

- Cancellation before the next operation prevents it from starting; cancellation during setup, checks, implementation, and repair stops active work and permits no later turn/check round.
- A controlled parent/child process fixture actually exits before final clean-stop reporting. Readiness signals, not arbitrary long sleeps, coordinate the test.
- Repeated cancellation and completion/cancellation races finalize once, keep a consistent reason, and clean up timers/listeners.
- A deliberately uncooperative fake reports unconfirmed termination. Its result is not `passed` and does not claim a clean stop or safe workspace reuse.
- Cancelled runs preserve their workspace, partial output, and report where writable; source checkout remains unchanged.

Run `npm test -- tests/lifecycle.test.ts tests/runner.test.ts`, then the common validation gate. OS signal wiring belongs to T13, not an import-time handler inside a helper.

## T10 — Final diff inspection and review warnings

**Depends on:** T07, T09. **Main files:** `src/workspace.ts`, `src/runner.ts`, `src/report.ts`. **Sources:** spec §5; architecture §2.

### Implement

After owned mutation has stopped, inspect the retained workspace against its recorded base. Summarize changed paths and highlight test, tooling, and configuration changes in the final human-readable summary and report. Include staged/unstaged changes, new untracked files, deletions, and changes already committed locally by the agent; do not inspect only `git diff HEAD`.

Use a small documented set of path categories and show the complete changed-path list for human review. Do not build a semantic code auditor or claim tamper-proof checks. State that `passed` means configured post-agent checks passed, not that every acceptance criterion is proven or the change is safe to ship. On failed/cancelled runs, inspect only when shutdown is confirmed; otherwise record why the summary is unavailable/unsafe to treat as final.

### Acceptance and verification

Extend `tests/workspace.test.ts` and `tests/report.test.ts`:

- A fixture with a local commit, staged edit, unstaged edit, new file, and deletion reports each category against the original base.
- Test files and representative package/tooling/config files are highlighted; ordinary source edits still appear in the full list.
- Inspection is read-only and never modifies the source or retained changes.
- An unavailable diff or unconfirmed shutdown is recorded as such, not as an empty “no changes” result.

Run `npm test -- tests/workspace.test.ts tests/report.test.ts`, then the common validation gate.

## T11 — Offline local-loop milestone

**Depends on:** T10. **Main files:** `tests/local-run.integration.test.ts`, test fixtures; production fixes only where these tests reveal defects. **Sources:** spec §§2–6; scaffold request §6.

### Implement

Exercise `runTask` with real temporary Git repositories, cloning, setup/check child processes, log files, and reports. Substitute only the coding agent and, where necessary, a controlled clock/failure hook. The fake agent edits the actual clone rather than returning “success” without doing work. Keep test-only hooks out of the public CLI and JSON formats.

Use a tiny deterministic target project whose committed baseline is green. Its checks should detect whether the fake agent's implementation actually works. Do not require package downloads or a real provider to test the harness.

### Acceptance and verification

Prove these scenarios end to end, not solely through mocked function counts:

- Implementation then pass; failed implementation then successful repair; repair exhaustion with the exact turn limit.
- Red baseline prevents any agent mutation. Setup/launch errors terminate without a repair.
- Timeout and cancellation stop owned execution and preserve available artifacts.
- A lying fake agent cannot turn failing tests into a pass; every successful outcome has a complete green post-agent round.
- Earlier attempt logs/results remain readable, source contents/HEAD/status remain unchanged, and two runs do not reuse a directory.

Run `npm test -- tests/local-run.integration.test.ts`, then `npm run validate` with provider credentials absent. The harness must not attempt provider/network access. This is the completed **fake-agent local-loop milestone**, not a reason to ship a fake public runtime.

## T12 — Real Codex adapter with offline contract tests

**Depends on:** T11. **Main files:** new `src/agent.ts`, narrow runner wiring, `tests/agent.test.ts`. **Sources:** spec §§1–3, 5; architecture §§2–4.

### Implement

At implementation time, consult the current official Codex documentation and select **one actually supported interface** appropriate to the chosen host platform: SDK or CLI, not both. Record the official reference, interface/version, local setup/authentication requirements, and observed limitations in the README. Do not invent SDK methods or install a provider abstraction first.

Keep all vendor calls and vendor-specific types inside `agent.ts`. Normalize useful summary/output, completion/failure, and shutdown information into the small existing runner contract. Bind Codex to the run workspace; provide the task, acceptance criteria, and relevant target-repository instructions through the supported mechanism. Tell it not to weaken tests/tooling to manufacture a pass, edit the source checkout or external command plan, or publish changes.

Support implementation and repair feedback. Session reuse is optional and must not change the top-level turn allowance. Honor the remaining deadline/cancellation and confirm managed execution is stopped before returning control for checks. A runtime/auth/launch/protocol failure stops the run; no automatic outer infrastructure retries. Keep authentication outside task/config JSON and do not persist credentials or raw authentication/environment payloads.

### Acceptance and verification

`tests/agent.test.ts` uses a fake transport/executable at the selected runtime boundary and proves:

- Correct workspace, task, acceptance criteria, repository-instruction handling, and repair failure output reach the runtime.
- Successful output, runtime failure, launch/auth failure, and malformed or incomplete completion information are normalized honestly; partial output is retained when useful.
- Runtime declarations that tests passed remain agent text, not observed check results.
- Cancellation/timeout invokes the supported shutdown path and waits for completion; unconfirmed termination blocks subsequent checks.
- Session reuse does not hide extra top-level turns. A sentinel credential provided to the mock environment/auth boundary does not appear in persisted diagnostics or reports.

Run `npm test -- tests/agent.test.ts tests/runner.test.ts`, then the common validation gate with no live provider credentials. A live call is **not required for T12**; it is verified explicitly in T16. Do not claim that a mocked contract test proves live runtime behavior.

## T13 — Public `run` command and terminal UX

**Depends on:** T12. **Main files:** `src/cli.ts`, concrete runner composition; existing CLI tests. **Sources:** WORKFLOW §3; spec §§2–4; architecture §2.

### Implement

Replace the scaffold's “run not implemented” rejection with:

```sh
npm run dev -- run --repo ../target-project --config harness.config.json --task examples/task.json
```

Reuse existing strict input loading. Resolve CLI paths from invocation current directory and `workDir` from the config directory. Reject unknown options, missing arguments, invalid JSON/schema input, and unsuitable source/output paths with useful errors before starting agent/project execution. Keep loaded inputs fixed. The CLI wires real helpers; it does not implement the repair loop or vendor protocol.

Show concise progress, final status/reason, repairs used, retained workspace/report locations, and review warnings. Wire supported user-interrupt signals into T09 cancellation and wait for finalization rather than exiting over active children. Use the documented exit-code mapping. Surface report-write failure with a nonzero exit and the retained run location; never print a successful completion or claim that a nonexistent report exists.

### Acceptance and verification

Extend `tests/cli.test.ts` to prove:

- Help/no arguments and `check-config` retain their original behavior; `check-config` still needs no credentials and creates/runs nothing.
- A valid `run` reaches the runner with correctly resolved inputs. Different invocation/config/target directories do not change the path rules.
- Invalid inputs or unsafe/dirty source paths invoke no agent or target commands and cannot fabricate a successful run/report.
- Passed, failed, cancelled, preparation failure, and report-write failure produce the documented output and non-misleading exit codes.
- Interrupt handling requests cancellation and waits for cleanup. A help/import/test call does not install persistent signal handlers.

Run `npm test -- tests/cli.test.ts`, `npm run build`, and `npm start -- --help`, then the common validation gate. Update the old test for unimplemented `run`; do not remove unrelated CLI validation coverage.

## T14 — Built-CLI end-to-end regression gate

**Depends on:** T13. **Main files:** `tests/cli.integration.test.ts`, controlled fixtures. **Sources:** spec §6; architecture §3; scaffold request §§3, 4.

### Implement

Spawn the actual built CLI against a disposable local repository. Keep Git, target commands, filesystem/reporting, argument parsing, and the production Codex adapter real; replace only the lowest runtime boundary with a controlled local fake. For a CLI interface this can be a test executable on the test process's PATH; for an SDK use an isolated test-process/module substitution suitable to the existing tooling. Do not add a user-facing runtime bypass to make this test easy.

The test/validate script ordering must build the artifact before these tests when needed, without recursive scripts. Reuse scenario fixtures from T11 rather than cloning a large second test framework. Normal CI still runs `npm ci` and `npm run validate`, without task-provider credentials or live agent jobs.

### Acceptance and verification

The built-CLI suite must verify:

- A successful run and a repair-then-pass run produce exit `0`, real retained changes, and parseable reports with complete post-agent checks.
- Red baseline, repair exhaustion, runtime failure, and invalid input produce nonzero exits and the correct presence/absence of run artifacts.
- A supported OS interrupt cancels the CLI, stops its owned fixture processes, and produces cancellation evidence rather than success.
- Config/task files and target/output paths containing spaces work; logs and reports point to existing artifacts.
- The original source is unchanged and neither the fake transport nor provider calls are touched by help or `check-config`.

Run `npm run build`, `npm test -- tests/cli.integration.test.ts`, then `npm run validate` without live credentials. Repair real failures; do not omit this suite from CI merely because it exercises processes.

## T15 — Operating docs, live-test entrypoint, and offline validation

**Depends on:** T14. **Main files:** `README.md`, an opt-in live verifier, `package.json`, existing examples/test configuration only where necessary. **Sources:** all supplied documents; especially spec §§4–6 and WORKFLOW §§1–3.

### Implement

Replace scaffold-only README claims with the actual completed behavior. Keep the supplied spec/input documents authoritative rather than duplicating them. Document installation and declared Node/runtime/platform support, Codex authentication/setup, `check-config`, `run`, repair counting, deadline/interrupt behavior, report/log layout, and manual inspection of retained work.

Show a disposable target repository example with a clean green baseline and an output directory outside the source. Explain that configured commands execute target-project code, a clone is not a sandbox, credentials should not be production/publishing credentials, and a passed run still needs human diff review. Explain unsupported platforms/features, manual cleanup, incomplete crash directories, and the need to inspect/stop leftover processes before reuse. Never imply automatic resume or strong isolation.

Include the selected runtime's official setup references. Add a separate `npm run test:live` entrypoint for the disposable implementation/repair exercise described in T16. Keep it outside default test discovery, `npm run validate`, and CI. Its prerequisite check must fail clearly without a usable runtime/account rather than treating an unexecuted live test as passed. Verify its fixture preparation and prerequisite handling offline in this task; actual provider calls wait until T16. Do not change the example JSON contract or add speculative settings.

### Acceptance and verification

- Follow the documented offline installation/build/help/`check-config` steps in a clean temporary checkout; confirm expected exit codes and that `check-config` has no execution side effects.
- Run the documented disposable example through the same fake runtime boundary used by the end-to-end suite and check that shown report/workspace paths match the actual layout. Label this as offline verification, not a live Codex result.
- Confirm the checked-in example files still parse, README command names exist in `package.json`, local documentation links resolve, and CI still installs reproducibly and runs the full validation gate. Test the live verifier's missing-prerequisite path with isolated fixtures and prove that default test/validation commands do not invoke it.
- Run `npm ci`, `npm run validate`, `npm start -- --help`, and the documented `check-config` command. Record actual results and supported-platform evidence; list unavailable platform verification rather than claiming it happened.

This completes **offline-verified application implementation**. T16 is a separate live integration gate.

## T16 — Opt-in live Codex implementation and repair exercise

**Depends on:** T15. **Main files:** the opt-in verifier and its README evidence; production fixes only when verified defects are found. **Sources:** spec §§1, 6; architecture §§3, 4.

### Implement

Run the opt-in verifier prepared in T15 using an approved Codex account and a disposable repository. Keep it out of `npm test`, `npm run validate`, and default CI. Check prerequisites before invoking Codex; do not attempt account changes, purchase access, or use a real project as the test target. Keep the configured task deadline and repair allowance bounded.

Exercise real implementation followed by independently executed setup/checks. Also exercise at least one real repair turn. To avoid relying on the model making a mistake, the repair exercise may inject one clearly labelled ordinary check failure after a green baseline at the **test-only boundary**. The repair must use real Codex feedback, and a final independent project check must still pass. Do not add forced failures or bypasses to production behavior, secretly weaken project tests, or describe the injected failure as a naturally discovered defect.

### Acceptance and verification

The opt-in verifier must assert, from actual artifacts and process results:

- A live implementation run has a green baseline, a real completed coding turn, observed post-agent checks, expected target behavior, and a retained report/workspace.
- A live repair exercise records a failed post-agent round, a real repair invocation, a later complete green round, correct `repairsUsed`, and preserved earlier evidence.
- Both runs keep the source checkout unchanged, respect their bounds, and create no commits in the source, pushes, PRs, Jira updates, or deployments.
- The selected runtime returns control only after its managed mutation has stopped; any unsupported shutdown guarantee is surfaced as a limitation, not concealed by a pass.

Run `npm run test:live` and record its exit code, runtime/version, run IDs, report locations, turn counts, and observed results. Run `npm run validate` after any implementation changes. **Without credentials or a usable runtime, leave T16 unchecked and report the specific missing prerequisite.** Do not present T12's mocked tests or T14's fake-transport tests as live evidence.

---

## Requirement coverage check

Use this small map during final review; it is not another subsystem to implement.

| Required behavior | Primary verification |
| --- | --- |
| Strict existing inputs; fixed command plan; correct path bases | Existing scaffold tests, T06, T13 |
| Clean committed source; safe paths; independent retained clone | T01, T02, T11 |
| Literal arguments; sequential setup/checks; all normal checks run | T03, T04, T14 |
| Red baseline prevents agent work | T06, T11, T14 |
| One implementation plus at most `maxRepairs` repair turns | T07, T11, T14 |
| Agent claims never replace observed post-agent check evidence | T06, T07, T12 |
| Setup/launch/runtime failure stops without infrastructure retries | T04, T07, T12, T14 |
| Total deadline, per-command cap, cancellation, confirmed shutdown | T08, T09, T12, T14 |
| Exact final statuses; earlier attempts/logs retained; report-write errors | T05, T07, T13, T14 |
| Source unchanged; test/tool/config changes highlighted for review | T02, T10, T11, T16 |
| Real supported Codex interface; normal tests require no credentials | T12, T14, T15 |
| Actual live implementation and repair evidence | T16 only |

## Completion note template

Append a short evidence entry after each completed task, or use the same structure in the agent's handoff. Do not copy secrets or long logs into this file.

```text
Task: Txx — title
Result: complete / blocked / partial
Changed: relevant files and implemented behavior
Verification: exact commands, exit codes, and meaningful test results
Evidence: local report/log paths for integration runs, when applicable
Limitations: anything required that was not verified; otherwise none
Next ready task: Txx
```

A completed backlog means the specified local tool was implemented and verified, with live evidence explicitly distinguished from offline tests. It does not authorize the deferred delivery/integration/platform features.

---

## Completion notes

```text
Task: T01 — Read-only repository and output-path preflight
Result: complete
Changed: src/workspace.ts (new) exports preflightSource(), WorkspaceError, and the
  PreflightRequest/SourcePreflight data. It resolves the requested path to the real
  repository root (symlinks/junctions/short names resolved), reads the committed
  HEAD, accepts a clean checkout including a detached one, and rejects a
  non-repository, a bare repository, an unborn HEAD, staged/unstaged changes, and
  non-ignored untracked files. Output overlap (equal, nested either direction) is
  refused after canonicalizing both sides, so an existing alias and a not-yet-created
  workDir beneath an aliased parent are caught while repo/repo-other is not. Git runs
  through child_process with literal argument arrays; inherited GIT_DIR/GIT_WORK_TREE/
  GIT_INDEX_FILE are dropped and optional locks are off. Tests: tests/workspace.test.ts
  (new), 27 cases over real temporary Git repositories, junctions, and a child process.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test -- tests/workspace.test.ts
  exit 0 (26 passed, 1 skipped); npm run validate exit 0 (format:check, lint, typecheck,
  test 88 passed / 1 skipped, build).
Evidence: temporary directories only; no run directory is allocated by preflight.
Limitations: the directory-symlink alias case skips on this Windows host — creating a
  directory symlink needs elevation or Developer Mode (EPERM). The junction alias cases
  do run and assert here; POSIX runs the symlink case. No run/CLI wiring yet (T13).
Next ready task: T02
```

```text
Task: T02 — Unique run directory and dedicated local clone
Result: complete
Changed: src/workspace.ts exports allocateRunDirectory() and prepareWorkspace() with the
  RunDirectory/PreparedWorkspace data. Allocation creates <workDir>/<runId>/workspace and
  <runDir>/logs by exclusive mkdir, from a generated timestamp+random ID that must match a
  name pattern; task text is not an input, and a taken ID is skipped, never reused. The run
  ID is also the branch name (harness/<runId>). prepareWorkspace() clones the recorded base
  with `git clone --no-checkout --no-hardlinks --origin source`, removes that remote so the
  copy is a snapshot rather than a second checkout, creates the branch at the recorded
  commit, and then verifies what it actually got: the source is still at that commit, the
  clone's HEAD equals it, the branch is current, and the checkout reproduces the recorded
  contents. Any failure keeps the run directory and names it in the error; WorkspaceError
  gained an optional `cause`.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test -- tests/workspace.test.ts
  exit 0 (37 passed, 1 skipped — the pre-existing Developer Mode symlink case);
  npm run validate exit 0 (format:check, lint, typecheck, 99 passed / 1 skipped, build).
Evidence: 11 new cases in tests/workspace.test.ts over temporary sibling directories and real
  Git child processes: allocation layout and uniqueness, no-clobber with a taken ID, unusable
  generated names, recorded-base/branch/contents checks, ignored files left behind, clone
  isolation from the source and from a sibling clone, non-empty destination refused,
  incomplete source object store detected, moved source HEAD refused, and hostile task IDs.
Limitations: verified on Windows 11 with Git 2.53 and Node 24.14 only; POSIX clone/branch
  paths are not exercised here. The incomplete-object fixture relies on that Git version
  exiting 0 from a checkout it cannot complete; the read-back verification is what catches it,
  and a Git that fails the clone instead is accepted by the same test. Whether a checkout
  looks clean to `git status` depends on the host's line-ending settings, so the harness
  checks it in the environment that wrote the checkout. Removing the clone's remote means
  later phases cannot fetch from the source (intentional). No CLI wiring yet (T13).
Next ready task: T03
```

```text
Task: T03 — Literal-argument command execution and logs
Result: complete
Changed: src/checks.ts (new) exports runCommand() and commandSucceeded(): one configured
  command is started as a literal argument array in the task workspace, nothing is
  concatenated, interpolated, or expanded, and the result records the command, cwd,
  start/end times, outcome, exit code or signal, launch error, and the two output log
  paths. A command that never started is `failed-to-launch` with a null exit code, so it
  can be neither an exit-0 success nor an ordinary nonzero exit. src/report.ts (new)
  exports ReportError, runLogPath(), appendRunLog() for the append-only
  `<runDir>/logs/run.log` timeline, and openCommandLog() for the per-invocation
  `<label>.stdout.log`/`.stderr.log` pair; files are created exclusively and only
  appended to. src/types.ts gained CommandOutcome and CommandResult. tests/checks.test.ts
  (new), 22 cases over real child processes.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test -- tests/checks.test.ts
  exit 0 (22 passed); npm run validate exit 0 (format:check, lint, typecheck, test 121 passed /
  1 skipped, build).
Evidence: temporary directories only; no run directory is allocated by these modules. Log
  files are plain text under `<logsDir>`; result.json is not built here (T05).
Limitations: launcher verification is Windows 11 / Node 24.14 with cmd.exe only; on POSIX
  the executable is always started directly and no interpreter path exists. A `.cmd`/`.bat`
  shim is run through `cmd.exe /d /s /v:off /c` with the resolved absolute path; three
  argument contents cannot survive that interpreter and are refused with an explanation
  instead of being silently altered — a double quote, a percent sign, and a line break (a
  command needing one must name a real executable). Timeouts and cancellation are not
  implemented here (T08–T09); no CLI wiring yet (T13).
Next ready task: T04
```

```text
Task: T04 — Sequential setup and complete check rounds
Result: complete
Changed: src/checks.ts exports runCheckRound() and CheckRoundRequest: one reusable round that runs
  the configured setup commands in order (an empty setup list is valid) and, only when every one of
  them exited 0, runs every configured check in order, one at a time. An ordinary nonzero check
  exit is recorded and the later checks still run: a completed red round. A setup command that does
  not exit 0, a command that could not be started, and a command killed by a signal stop the round
  as an execution error with an explanation, and the commands after it have no result at all.
  src/types.ts gained RoundOutcome and CheckRoundResult. tests/checks.test.ts gained an
  event-recording fixture and 7 cases.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test -- tests/checks.test.ts
  exit 0 (29 passed); npm run validate exit 0 (format:check, lint, typecheck, test 128 passed /
  1 skipped, build).
Evidence: temporary directories only; a round writes only its own log files under `<logsDir>`.
  Regression probes confirmed the new cases bite: starting the checks concurrently failed 3 of
  them, and stopping at the first failing check failed 2; both probes were reverted.
Limitations: verified on Windows 11 / Node 24.14 only. The signalled stop path is implemented but
  not exercised by a test: a child that kills itself on Windows is reported as an ordinary nonzero
  exit (code 1, signal null), and only Node's own child.kill produces a signal, which belongs to
  the T08/T09 stop paths. Timeout/cancellation are not built here, and run.log round lines stay the
  runner's job (T06). No CLI wiring yet (T13).
Next ready task: T05
```

```text
Task: T05 — Final report and attempt evidence
Result: complete
Changed: src/report.ts exports writeRunReport()/runReportPath() (the readable
  <runDir>/result.json), openAgentLog()/agentLogPath() (agent-implementation.log for
  turn 1, agent-repair-N.log after it, created exclusively so no turn overwrites an
  earlier one), and RunReportRequest. src/types.ts gained RunStatus, AttemptKind,
  AttemptEvidence, WorkspaceReport, and RunReport. The report holds task/run IDs, the
  normalized source path and base commit, the workspace path with prepared/branch/
  problem, run start/end, status and reason, repairsUsed derived from the recorded
  attempts, the baseline round, one entry per coding turn that keeps the agent summary
  apart from the observed round, and the run timeline path. Command arguments, working
  directory, exit code/signal, launch error, and log locations are carried as the
  command helper recorded them; the report references log files instead of copying
  their contents. `passed` is refused unless the last turn's observed round is a
  completed green one, and a report without a prepared working copy must name the
  preparation problem. tests/report.test.ts (new), 14 cases over real run directories,
  real check rounds, and a real failing prepareWorkspace.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test -- tests/report.test.ts
  exit 0 (14 passed); npm run validate exit 0 (format:check, lint, typecheck, test 142
  passed / 1 skipped, build).
Evidence: temporary run directories only. Writing a report left the working copy, the
  run's other logs, and a sibling run's artifacts byte-identical. Regression probes
  confirmed the new cases bite: deriving repairsUsed as 0 failed 2 cases, and a
  weakened pass guard failed 8; both probes were reverted.
Limitations: timeout evidence is not in the report yet — T08 owns the timeout outcome,
  and the report serializes the command result as it exists today. Timeout information
  is therefore absent rather than fabricated, and T08 extends the contract. Verified on
  Windows 11 / Node 24.14 only; the unwritable-destination case is exercised with a path
  that cannot be a directory and with an existing result.json, not with a read-only
  volume. The writer records the log paths the run produced; it does not re-verify that
  each referenced file still exists. No CLI wiring yet (T13).
Next ready task: T06
```

```text
Task: T06 — Baseline and implementation loop with a fake agent
Result: complete
Changed: src/runner.ts (new) exports runTask(), RunTaskRequest, AgentTurnRequest,
  AgentTurnResult, RunnerDependencies, and RunTaskResult. runTask is an ordinary async
  function over the first vertical path — preflight and run-directory allocation, then
  baseline check-round, implementation turn, post-agent check-round, final report — and
  every collaborator is a concrete function in one plain argument object (preflight,
  allocateRunDirectory, prepareWorkspace, runCheckRound, runAgentTurn, openAgentLog,
  appendRunLog, writeRunReport, now), all required, with no default and no fake in src/.
  The loaded task and command plan are passed to the rounds from memory and are never
  re-read, so nothing the working copy writes can change which commands decide the run.
  A baseline that is not a completed green round ends the run as failed before any
  coding turn; a failed turn ends it as failed with no invented post-agent round; only a
  completed green post-agent round reports `passed`. The lifecycle goes to logs/run.log
  (plan counts and round descriptions only, never command output) and the turn's own
  output to logs/agent-implementation.log. No repair loop and no CLI wiring yet.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test --
  tests/runner.test.ts exit 0 (10 passed); npm run validate exit 0 (format:check, lint,
  typecheck, test 152 passed / 1 skipped, build).
Evidence: tests/runner.test.ts (new), 10 cases over temporary sibling directories, real
  Git fixtures, and a real stand-in coding child process. Covering: red baseline failed
  with the agent called zero times; baseline setup launch error as execution-error with
  no checks; failed preparation reported without a working copy; a dirty source refused
  before allocation; a green baseline running exactly one turn then setup and both checks
  as an exact 14-event order; a post-agent command never starting while the agent is
  active (a lock file the stand-in takes before its first await, plus turn-start/turn-end
  brackets around a 600 ms held turn); a failed turn keeping its agent log and its
  checks as absent rather than invented; a turn writing harness.config.json and task.json
  traps not changing the loaded plan; and a fully substituted collaborator set showing the
  requests each helper received. Regression probes confirmed the new cases bite: starting
  the post-agent round before awaiting the turn failed 4 cases, and letting a red baseline
  continue into the coding turn failed the baseline case; both were reverted, suite back
  to 10/10.
Limitations: the coding runtime is still absent, so runAgentTurn has no production
  implementation and the public `run` command stays unavailable (T13); the no-repair path
  only. Cancellation and the total deadline are T08/T09. Verified on Windows 11 /
  Node 24.14 only; no live LLM, network, or credentials were used.
Next ready task: T07
```

```text
Task: T07 — Bounded repair loop and honest outcomes
Result: complete
Changed: src/runner.ts — T06's runTask/RunnerDependencies extended into the bounded loop:
  baseline, then one coding turn per iteration (implementation, then repair turns), a setup
  + full check round after every completed turn, and a stop at the first of a green round,
  an exhausted allowance, a failed turn, or an unexecutable round. AgentTurnRequest carries
  `repair: RepairFeedback | null` — null for the implementation, and for a repair the failed
  commands of the round it repairs (configured arguments, exit code, both log paths) plus the
  output they wrote. src/types.ts adds FailedCommand and RepairFeedback, and nothing else.
  src/report.ts adds readCommandOutput(), the one read-back: it owns the log layout, so it
  returns each stream labelled with its file, bounded to the last 4000 characters with an
  explicit "earlier output omitted" marker, "(no output was written)" for an empty stream,
  and no failure of its own when a file cannot be read. `maxRepairs` counts additional
  top-level coding turns: the allowance is spent only when a completed red round exists, so
  0 allows one turn and 2 allows at most three. A setup launch error or a command that cannot
  execute ends the round as execution-error and returns immediately — infrastructure failure
  is terminal and costs no repair; a failed agent turn returns before any round runs. No
  outer-loop retry exists anywhere, and `repairsUsed` stays derived in buildReport from the
  attempts array, never supplied.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test --
  tests/runner.test.ts exit 0 (14 passed); npm run validate exit 0 (format:check, lint,
  typecheck, test 159 passed / 1 skipped, build).
Evidence: tests/runner.test.ts (extended), 14 cases. The four new bounded-loop cases cover
  an exhausted allowance with maxRepairs: 0 (one turn, zero repairs, failed, exact 14-event
  order, no turn-2 agent log); maxRepairs: 2 with both repairs red (turns implementation 1,
  repair 2, repair 3, feedback of turn 3 pointing at attempt-2-check-1.stdout.log,
  repairsUsed 2, no turn-4 log); implementation red then a passing repair (exactly two turns,
  repairsUsed 1, the agent's "done — every test passes" claim kept as text beside the red
  round it did not change); a repair turn failing (checks null, no round run, one turn less);
  and a setup launch error after a repair (execution-error, checks empty, repairedTurn 1,
  repairsUsed 1, stops). Exact request kinds/turns, event order, lifecycle phases, and log
  files are asserted throughout. tests/report.test.ts adds 3 cases for readCommandOutput:
  a real failing round's logs read back, a 50,000-character log bounded to its tail, and an
  empty stream recorded as "(no output was written)". Regression probes confirmed the cases
  bite: allowing one repair past the allowance failed the maxRepairs 0 and 2 cases, and
  letting an execution-error round fall through to the repair decision spent the remaining
  allowance and failed the setup-launch case; both were reverted, suite back to 14/14.
Limitations: the coding runtime is still absent, so runAgentTurn has no production
  implementation and the public `run` command stays unavailable (T13). No timeout, total
  deadline, or cancellation path yet — T08/T09 own those, so a command that hangs is not
  stopped here. Verified on Windows 11 / Node 24.14 only; no live LLM, network, or
  credentials were used.
Next ready task: T08
```

```text
Task: T08 — Total deadline, command limits, and timeout shutdown
Result: complete
Changed: src/runner.ts — runTask establishes the run's one deadline (now() +
  taskTimeoutMinutes*60_000) before preflight and never recomputes it: preparation, setup, coding
  turns, and checks all spend that budget, a repair turn is not given a fresh one, and every phase
  reads what is left before it starts anything. Each round is handed the configured
  commandTimeoutMs, the absolute deadlineMs, and the same injected clock, so a repair can never
  hand the run time it already spent. roundStop() reads an expired limit out of a round that came
  back as an execution error — naming the task limit when the stopped command ran under less than
  its configured limit — before that outcome could be mistaken for an infrastructure failure or a
  red round be mistaken for repair feedback. Every stop leaves through endTimedOut(), which records
  one TimeoutEvidence and finalizes as `failed`; nothing is started after one. A run whose time is
  gone before a run directory exists throws RunTimeoutError rather than inventing a report.
  AgentTurnRequest.stop is the AbortSignal for the turn's remaining budget, released when the turn
  returns; a turn stopped that way keeps its own summary and is recorded with checks: null.
  src/checks.ts — each invocation runs under the smaller of its configured limit and the task time
  left, re-read before every command (a round whose time is gone stops without starting a late
  command), and a command at its limit is stopped as an owned process tree: taskkill /PID <pid> /T
  /F on Windows, a group SIGKILL addressed by the negated PID on POSIX. Only a PID this module
  recorded is ever named. The stop is `confirmed` only when the request succeeded and the close
  event was seen within 5000 ms; otherwise `unconfirmed` with the reason. Commands are detached
  only off Windows: a detached cmd.exe gets its own console, and a `.cmd` command then records
  empty output. src/types.ts — CommandOutcome gains 'timed-out', CommandResult gains
  timeoutMs/termination/terminationProblem, TimeoutEvidence (limit, phase, limitMs, elapsedMs,
  termination, problem) is what RunReport.timeout carries. src/workspace.ts — prepareWorkspace
  takes the run's bounds and checks the deadline before each of its five steps, failing as an
  incomplete run that must not be reused instead of killing Git mid-write. src/report.ts —
  refuses a timeout that is not `failed`, and refuses an unconfirmed stop that does not say what
  could not be confirmed.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test --
  tests/runner.test.ts tests/checks.test.ts tests/workspace.test.ts exit 0 (3 files, 95 passed /
  1 skipped); npm run validate exit 0 (format:check, lint, typecheck, test 174 passed / 1 skipped,
  build).
Evidence: tests/runner.test.ts +8 cases, tests/checks.test.ts +5, tests/workspace.test.ts +2.
  Runner: one deadline handed to preparation and to baseline/attempt-1/attempt-2 with the left
  falling 60 → 35 → 10 minutes (a repair turn for a red round really running inside it); a baseline
  stopped by the task time left, recorded as limit 'task' at 240000 ms with no turn and no second
  round; a post-agent check stopped at its own 600000 ms limit and unconfirmed, with no second
  round, no repair turn, the red round kept as the attempt's evidence, and the reason saying the
  working copy must not be reused; an unconfirmed stop with no reason given explained by the
  runner and still written; an implementation turn that is still running stopped and awaited, with
  checks null, the agent's own summary kept and its log closed; the same for repair turn 2, which
  had already been given the repairs of the red round it was repairing; preparation stopped by the
  real workspace on the run's deadline, with the run directory and the problem kept; a run refused
  with RunTimeoutError, no run directory made. Checks: the real hang fixture stopped with the child
  it started, both PIDs gone and its heartbeats frozen; the task-time-left and command-limit
  orderings named separately; nothing started once the deadline has passed; and an empty PATH
  making the stop unconfirmable. Workspace: a stepping clock stopping the real clone on the
  deadline, and an already-passed deadline stopping it at the destination check.
  Regression probes confirmed the cases bite: a fresh full budget per phase (remainingMs returning
  the limit) failed 4 runner cases; a fresh deadline per round (now() + limit) failed the budget
  carry-through case; a bare single-process kill instead of the tree stop failed the unconfirmed
  case in checks.test.ts. All three were reverted, suite back to 174 passed / 1 skipped, and no
  fixture process was left behind after the runs.
Limitations: a timeout is not cancellation — a user-initiated stop, its own evidence, and the
  `cancelled` status are T09, which reuses this stop path (no caller can ask a run to stop yet).
  The stop's confirmation is bounded by a 5000 ms grace window, so a stop that lands but is not
  observed in time is reported as unconfirmed rather than assumed. A timeout is only reachable in
  tests through the injected clock, so the real end-to-end path over minutes is exercised on a
  small scale (milliseconds) only. On this host a single-PID kill also ends a Node-spawned
  grandchild (Windows job inheritance), so the grandchild assertion records the behaviour this
  platform really has; the empty-PATH case is what separates the tree stop from a bare kill. The
  coding runtime is still absent, so runAgentTurn has no production implementation and the public
  `run` command stays unavailable (T13). Verified on Windows 11 / Node 24.14 only; the POSIX group
  signal is unexercised here, and no live LLM, network, or credentials were used.
Next ready task: T09
```

```text
Task: T09 — Cancellation and confirmed process shutdown
Result: complete
Changed: src/runner.ts — a run accepts one stop request, RunTaskRequest.stop, and cancellation
  has no second pathway: the same abort signal a phase's own limit uses is the one the caller
  sets off. It is read before preflight and after it (a stop that arrives before a run directory
  exists is refused with RunCancelledError rather than reported as a run that happened), handed to
  prepareWorkspace, given to every round, and composed per coding turn by phaseStop(). phaseStop
  owns one AbortController with two triggers — the phase's remaining task time and the caller's
  stop — each aborting it with a RunStopReason naming which one it was. AbortController keeps the
  first reason it was given, so a trigger that arrives second changes nothing, and stop.kind()
  reads back which one arrived first. stop.cancel() clears the timer and removes the caller
  listener when the phase returns, so a finished phase leaves nothing armed. roundStop() reads a
  stop out of a round that came back as an execution error: a command whose outcome is 'stopped'
  becomes a cancelled run carrying that command's own termination evidence, a stop observed
  between two commands becomes cancelled with the round's own explanation, and an expired limit
  stays a timeout. Every stop leaves through endStopped()/endCancelled(), which record one
  CancellationEvidence, finalize as `cancelled` with timeout: null, and start nothing after it.
  First observed reason wins: the turn's own stop signal is read (stop.kind()) immediately after
  the turn returns and its log is closed, before the turn's failure is read, so an agent that
  answers after it was asked to stop — including one that fails on its way out — cannot replace
  the reason the run ended for; then a quiescent boundary reads the caller's signal again once the
  turn's stop request has been released, so a successfully completed turn gets no check round
  unless the working copy is really nobody else's to write to; a stop that arrives in that window
  ends the run as cancelled instead of starting a round. src/checks.ts — RunCommandRequest.stop and
  CheckRoundRequest.stop; a command already running is stopped through the tree stop its own limit
  uses and recorded as 'stopped' (never as an exit, whatever code it reports on the way out), a
  command not yet started by a stopped round is not started at all (stoppedBeforeStart, and the
  round's stoppedBeforeNext between two commands), and both carry the existing unconfirmed-stop
  limitation rather than rounding it down. src/types.ts — CommandOutcome gains 'stopped';
  CancellationEvidence { phase, elapsedMs, termination, problem } is what RunReport.cancellation
  carries, exactly when the run was cancelled. src/workspace.ts — PrepareWorkspaceBounds.stop
  makes preparation check the caller's stop before the deadline at each of its five steps; a Git
  step already running is left to finish and the next step refuses to start. src/report.ts —
  refuses a cancellation record that is not on a `cancelled` run, and refuses an unconfirmed stop
  that does not say what could not be confirmed. No signal handler is installed anywhere: wiring
  the host's signals to the request is T13's work, and cancellation is verified through the
  request's own signal.
Verification: npm ci exit 0 (137 packages, 0 vulnerabilities); npm test --
  tests/lifecycle.test.ts tests/runner.test.ts exit 0 (2 files, 37 passed); npm run validate exit
  0 (format:check, lint, typecheck, test 188 passed / 1 skipped, build); after a full suite run,
  0 fixture processes still running and 0 new temporary directories left behind.
Evidence: tests/lifecycle.test.ts (new, 7 real-process cases) and tests/runner.test.ts (22 → 30
  cases); the suite went from 174 passing to 188. Lifecycle: a baseline setup command stopped with
  the child it started, both PIDs gone, its beats frozen, no check and no turn after it, the
  stopped round's own output still on disk and the report `cancelled`; a post-agent check the
  implementation made hang stopped with its child, its last beat preceding the report's mtime, and
  no second round or repair turn; an implementation turn stopped while it worked, its runtime
  stopping and awaiting the tree it managed before returning, the run finalizing only afterwards
  with the turn's own log and summary kept; a repair turn stopped after a real red round, with
  what both turns wrote kept and the source checkout unchanged (HEAD and status compared before and
  after every run); a deliberately uncooperative host (no taskkill findable) reporting
  termination: 'unconfirmed' with the fixture processes still running, status `cancelled` and never
  `passed`, the reason saying the stop could not be confirmed and the copy must not be reused; a
  round handed an already-aborted signal starting nothing at all (no process, no beat, no log
  file); and a single command stopped mid-flight. Runner: a pre-stopped run refused with
  RunCancelledError and nothing allocated; a stopped repair turn with no round after it and a
  consistent timeline; a stop landing exactly as a turn returns (the quiescent boundary); a round
  stopped between two commands; a caller stop racing an expired deadline (the timeout observed
  first is the one reported, with cancellation null); one finalization with one reason under
  repeated aborts, with no abort listener left on the caller's signal and no timer left armed;
  a phase that finished inside its budget releasing its deadline; and a turn that failed after
  being stopped, whose stop is still the reason. Regression probes confirmed the cases bite: a
  cancelled run allowed to continue to its next check round reported `passed` (failed the runner
  boundary case); letting a turn that failed while being stopped become the run's reason failed 8
  cases across both files — that probe exposed a gap, so the race case above was added; all probes
  were reverted, the suite returned to 37 passed for these two files, and no fixture process was
  left behind.
Limitations: only process trees the harness started itself are ever stopped, and only PIDs it
  recorded; no claim is made about a detached or unrelated host process, which is left alone. A
  stop is confirmed only when the request reached the operating system and the invocation was seen
  to end within the existing 5000 ms grace window, so a stop that lands but is not observed in
  time is reported as unconfirmed. The unconfirmed case is induced by making the tree-stop utility
  unfindable, which is the Windows path (taskkill on PATH); off Windows the stop is a group
  SIGKILL that needs no PATH lookup, so that particular case is Windows-only, as the T08 checks
  test already is. Cancellation is verified through the request's abort signal only: wiring the
  host's own signals to it is T13, and no import-time handler exists in any module. The coding
  runtime is still absent, so runAgentTurn has no production implementation and the public `run`
  command stays unavailable (T13); a turn is stopped through the signal a runtime would honour,
  exercised with real processes in the tests. Six temporary directories from earlier interrupted
  runs were already in %TEMP% before this task's suite runs; the suite creates and removes all of
  its own, leaving none. Verified on Windows 11 / Node 24.14 only; the POSIX group-signal path is
  unexercised here, and no live LLM, network, or credentials were used.
Next ready task: T10
```

```text
Task: T10 — Final diff inspection and review warnings
Result: complete
Changed: src/workspace.ts gains inspectWorkspaceChanges(workspace), the only place the
  retained copy is compared with its base. It reads git diff --name-status -z --no-renames
  <base> HEAD (changes the agent committed locally) plus git status --porcelain=v1 -z
  --untracked-files=all --no-renames (staged, unstaged, untracked, deletions), merges both into
  one ChangedPath per path (kind by precedence deleted > added > modified; states in a fixed
  committed/staged/unstaged/untracked order; paths sorted), and tags each with a small documented
  category set: tests (test/tests/__tests__/spec/specs directories, *.test.*/*.spec.* names),
  tooling (package.json and lock files, Makefile/Dockerfile/Jenkinsfile, .gitignore/.npmrc,
  .github/.circleci/.gitlab/.devcontainer), configuration (*config.*, tsconfig/jsconfig, .env*,
  .editorconfig, *.ini|toml|cfg). src/report.ts adds summarizeChanges() and the ChangeSummary
  contract: the full path list, the highlighted subset, and two review warnings — "`passed` means
  the configured post-agent checks exited successfully for the retained working copy. It does not
  prove that every acceptance criterion is met, and it does not mean the change is safe to ship:
  review the diff before delivery.", and, only when paths are flagged, "the flagged paths change
  tests, tooling, or configuration, so the checks that decided this run may not be the checks the
  task needed. The harness flags them; it does not judge them, and it does not enforce tamper-proof
  tests." assertReportable refuses a report that lists paths it did not inspect, an inspected
  summary with a problem, a silent uninspected one, a base other than the run's own, or any
  summary at all when a timeout/cancellation shutdown was unconfirmed. src/runner.ts inspects only
  after every owned process has stopped, writes the complete list to logs/run.log (changes: N paths
  differ from the recorded base <sha>, one "changed path: <file> (<kind>, <states>)[ - cat: review
  this change]" line each, then both review-warning lines before the final-status line), and
  returns the same summary in RunTaskResult and the report. Git stays in workspace.ts; the runner
  calls the inspection and summarizeChanges directly, so RunnerDependencies is unchanged. Types
  added: ChangeKind/ChangeState/ChangeCategory/ChangedPath/ReviewWarnings/ChangeSummary, plus
  RunReport.changes.
Verification: npm ci — exit 0 (137 packages, 0 vulnerabilities). npm test --
  tests/workspace.test.ts tests/report.test.ts — exit 0, 2 files passed, 64 passed | 1 skipped
  (65). npm run validate — exit 0: format:check, lint, typecheck clean, 8 files passed, 199
  passed | 1 skipped (200), build ok. New cases: four in tests/workspace.test.ts (every change
  category against the original base; test/tooling/config highlighting with an ordinary source
  edit still listed; read-only — HEAD, refs, index, status and file contents of both the retained
  copy and the source identical before and after two inspections; an unknown base and a copy with
  no .git both rejected rather than reported as "no changes"), four in tests/report.test.ts
  (wording of both warnings and the refusal set), and two in tests/runner.test.ts (the exact
  timeline lines and path list for a passed run; the unconfirmed-stop case recording
  changes.inspected === false with its problem and no changed-path lines). Regression probes: with
  the committed-diff reading dropped so a local commit went unreported, "reports every kind of
  change against the base the run recorded" failed (1 failed | 63 passed | 1 skipped); with the
  inspection returning [] when git diff fails, "refuses to report a comparison it could not make"
  failed (1 failed | 63 passed | 1 skipped). Both probes were reverted and the files returned to
  2 passed / 64 passed | 1 skipped.
Evidence: no integration run yet (no public run command until T13); the summary a run writes is
  asserted through real run directories and logs/run.log in tests/runner.test.ts.
Limitations: this is a naming-based heuristic over paths only — it never reads file contents, so
  a test change hidden in an unflagged path is not detected and a flagged path is not judged; it
  claims no tamper-proofness and no semantic review, and the categories are fixed, not
  configurable. Paths are compared against one recorded base with --no-renames, so a rename reads
  as a deletion plus an addition. An unconfirmed shutdown yields no summary at all rather than a
  possibly-stale one, which is deliberate. Verified on Windows 11 / Node 24.14 only; no live LLM,
  network, or credentials were used.
Next ready task: T11
```

```text
Task: T11 — Offline local-loop milestone
Result: complete
Changed: tests/local-run.integration.test.ts (new, the whole deliverable; no production file
  changed). It drives the real runTask with the real production dependencies imported directly
  from src/workspace.ts, src/checks.ts and src/report.ts, and substitutes exactly two things: the
  coding agent (runAgentTurn only, in the spirit of the T06 fake) and, in the deadline test, a
  test-owned clock. Everything else is real — a real temporary Git repository cloned by the real
  prepareWorkspace, real setup and check child processes, real per-command log files, a real
  logs/run.log timeline, and a real result.json/report written by the real writeRunReport. The
  fixture target project is a four-file Node project (src/greet.mjs, test/greet.test.mjs,
  test/greet-all.test.mjs, tools/prepare.mjs, tools/run-checks.mjs) committed once as its green
  baseline; its runner executes each test file in a real child process, so the checks really run
  the agent's code. The runtime stand-in is written as an .mjs program into the temp parent and
  spawned as a child: it edits the actual clone, signals start/edits-written/end through a
  JSON-lines events file, and holds the tree it manages, so it can be really stopped. No test-only
  hook was added to the public CLI, the config schema or the JSON formats; the harness still has
  no provider code at all (src reads no credential environment variable — src/checks.ts reads only
  PATH, PATHEXT and ComSpec).
Verification: npm ci — exit 0 (137 packages, 0 vulnerabilities). npm test --
  tests/local-run.integration.test.ts — exit 0, 1 file passed, 10 passed (10), 14.2–14.6 s per
  run over five consecutive runs (wall clock about 15.3 s). npm run validate with
  OPENAI_API_KEY/CODEX_API_KEY/ANTHROPIC_API_KEY/OPENAI_BASE_URL unset — exit 0: format:check
  clean, lint clean, typecheck clean, 9 files passed, 209 passed | 1 skipped (210), build ok. The
  skip is the pre-existing platform-conditional one in tests/workspace.test.ts, not this suite.
  Orphan check: node PIDs and $TEMP/nexus-harness-* directories snapshotted before and after a
  full suite run are identical (1 PID, 7 dirs on both sides; the 7 dirs predate this work and
  belong to other suites), so the suite leaves no fixture process and no stray temp directory.
  Regression probes: with the post-agent round treated as passed whenever the turn's own summary
  was non-empty, the lying-agent test failed (report.ts refused to write a passed report over red
  checks) and the repair-exhaustion test failed; with the red-baseline gate disabled so a red
  baseline still reached the agent, "stops before any coding turn when the committed baseline is
  red" failed with the observed reason "repair turn 2 failed, so no check was run after it". Both
  probes were reverted; git diff of src/ is empty and the suite returned to 10 passed.
Evidence: the ten scenarios proven end to end are implementation then a complete green post-agent
  round (asserting the check's own log line "greet-all: ok", so the checks ran the written code);
  failed implementation then a repair told the exact failure the checks observed, with the first
  attempt's log still readable afterwards; repair exhaustion at the exact limit with a no-op last
  turn; a lying turn that cannot turn failing checks into a pass, its claim kept in its own log
  beside the red round; a red committed baseline that stops the run with no attempt at all; a
  setup command that fails after a turn, ending the run with no repair; a check that cannot be
  launched, ending the baseline with no coding turn; the run's own deadline stopping a really
  hanging check process tree (limit task, limitMs 4000 = 60000 − 56000 of clock advanced, exact
  startedAt/endedAt, termination confirmed, and the hanging PID from the run's own log gone); a
  cancelled turn whose managed child tree is stopped and whose written file is retained; and two
  runs of one task getting distinct run directories, run ids, branches and clones (run 2's
  baseline shows the feature absent) with the source repository's HEAD, status and contents
  unchanged.
Limitations: the fake agent is controlled by the test, so the run loop can only be exercised in a
  scope the fake can reach; the fixture's prepare log is not a highlighted "tooling" path, because
  tools/ is not one of the name-based change categories (asserted as such rather than fabricated).
  As stated in the suite header, a baseline round and a no-op coding turn observe the same working
  copy, so no deterministic check can be green on the one and red on the other; the suite proves
  the checks really execute the agent's code instead. The deadline scenario compresses real
  minutes into a controlled clock, so the multi-minute wall-clock path is not exercised. Verified
  on Windows 11 / Node 24.14 only; the POSIX process-group stop is unexercised here, and no live
  LLM, network, or credentials were used.
Next ready task: T12
```

```text
Task: T12 — Real Codex adapter with offline contract tests
Result: complete
Changed: src/agent.ts (new) — the only module that knows the vendor: codexRuntime() and
  runCodexTurn(), one turn per invocation of the host's own Codex CLI. Interface established before
  any code was written, and recorded in README.md §"Coding runtime": codex exec (@openai/codex
  0.154.0), invoked as exactly `codex exec --sandbox workspace-write --json -` in the working copy
  with the prompt on standard input, one JSON event per line on stdout and progress on stderr;
  official references are the Codex non-interactive, CLI-command and AGENTS.md pages plus the
  openai/codex documentation through Context7. The CLI was selected over the SDK, and no vendor
  method was invented. The task text, every acceptance criterion, the working-copy path, the source
  root and the repository instructions (AGENTS.md, named only when the copy has one) go through the
  prompt; the prompt also states that tests and tooling must not be weakened or deleted to
  manufacture a pass, that the source checkout and the command plan are not to be edited, and that
  nothing is to be published. Repair turns carry the failed command, its exit code, the log path and
  the observed output. One fresh invocation per top-level turn (no `resume`), so a session can never
  quietly buy extra turns; a turn's own claim that tests passed is returned as text only. Auth stays
  outside task and config JSON: the environment is passed to the runtime untouched and nothing read
  from it is persisted. A launch, auth or protocol failure is a thrown AgentError — a stop, with no
  outer retry. Deadline and cancellation go through the same planLaunch/requestTreeStop/STOP_GRACE_MS
  machinery the checks use, and the adapter waits for the process tree it started to end before
  returning; src/runner.ts was wired narrowly (AgentTurnShutdown folded into the timeout and
  cancellation evidence; an unconfirmed stop ends the run as failed and bars further checks and
  workspace reuse), and src/checks.ts now exports within/planLaunch/requestTreeStop/Launcher.
  tests/agent.test.ts (new, 18 tests) fakes the runtime process itself — a real .mjs stand-in
  spawned through a codex/.cmd shim at the same boundary T14 will substitute. A stand-in a test
  deliberately leaves running is ended by a release file its own teardown writes, and a recorded PID
  is stopped only if it is still alive once that wait is over: stopping a PID the host has already
  freed risks ending whatever process holds the number now — in this suite, or in one running beside
  it. No dependency was added: package.json is unchanged, and the CLI interface needs none in this
  repository. The public `run` command was not added (T13).
Verification: npm ci — exit 0, 0 vulnerabilities. npm test -- tests/agent.test.ts
  tests/runner.test.ts — exit 0, 2 files passed, 50 passed (50). npm run validate with
  OPENAI_API_KEY/CODEX_API_KEY/ANTHROPIC_API_KEY unset — exit 0: format:check clean, lint clean,
  typecheck clean, 10 files passed, 227 passed | 1 skipped (228), build ok. The skip is the
  pre-existing platform-conditional one in tests/workspace.test.ts, not this suite. No live call was
  made and no account was authenticated against.
Evidence: tests/agent.test.ts proves, at the faked process boundary, that argv is exactly
  ['exec','--sandbox','workspace-write','--json','-'], the runtime's cwd is the working copy, and the
  prompt carries the task heading, each acceptance criterion, the workspace path, the source root
  and AGENTS.md, with the repair prompt carrying the failed command, its exit code, its log path and
  the observed output; successful, failed, auth, launch-failure, malformed, contradictory and
  incomplete endings normalize to a summary or to a named error, with partial output retained; a
  completed round is turned back into a `failed` run even while the agent says "All tests pass", and
  the claim is kept as agentSummary beside the red round in result.json; cancellation and timeout
  stop the tree through the injected stop boundary and the adapter awaits its own end; an
  unconfirmed stop ends the run with no post-agent round and no change inspection; session reuse
  never adds a top-level turn; and a sentinel credential reaches the runtime's environment but
  appears in neither the agent log, nor logs/run.log, nor result.json, nor a failure message.
  Regression probes: making the runner accept a runtime's "tests pass" summary as a passing round
  failed the claim-vs-evidence test (report.ts refused to write a passed report over red checks);
  writing a boundary credential into the agent log failed the credential test at the persisted-file
  assertion. Both probes were reverted and the suite returned to 2 files / 50 passed. The release
  handshake was checked with a single lingering-runtime test: 477 ms wall clock for a stand-in whose
  own hold is 30 000 ms, which is only possible if the release ended it. Temp directories under the
  system temp root: 10 before a full suite run and 10 after.
Limitations: no live Codex call was made, so nothing here proves the real CLI's behavior, its real
  event stream, or a real account (that is T16) — the adapter's contract is proven against a stand-in
  process, not the vendor binary. codex exec's exit codes are undocumented, so the adapter reads the
  event stream rather than an exit code; AGENTS.md discovery for exec is not explicitly documented
  and the harness does not depend on it; Windows packaging for the win32-x64 optional dependency has
  reported breakage. The POSIX launcher path and the POSIX process-group stop are unexercised on
  this Windows 11 / Node 24.14 host. Verified on Windows 11 / Node 24.14 only. Three intermittent
  failures of the wider suite appeared while this task was being verified, once in
  tests/runner.test.ts and twice in tests/lifecycle.test.ts, against 28 clean full-suite runs (8 of
  those taken with this suite removed, and clean too). The lifecycle one was diagnosed rather than
  guessed: the "stops a baseline command and the tree behind it" test failed on
  `beatsOf(fixture, 'setup-one')` not containing the `hanging` beat, while the assertion just above
  it — that the fixture process is still running — passed. That fixture writes its readiness file
  (the pid file these tests poll for) before it records the `hanging` beat, so the assertion can run
  before the beat exists, and a loaded machine widens the gap. Nothing this task changed is on that
  path, and the EBUSY on the working copy and the unhandled ENOENT appending to a timeline that
  accompany it are consequences, not separate faults: the test never reaches its own stop, so the run
  outlives it and then writes into a directory that has been removed. It was left unrepaired — that
  test is not this task's to change — and the fix there is to wait, bounded, for the beat it asserts
  instead of asserting at once. The runner.test.ts one, `git add --all` exiting 1 with empty standard
  error, is what a force-ended child looks like, and is what this suite's own teardown could once
  have done, since it stopped recorded PIDs a second time even when the harness or the runtime itself
  had already ended them; the release handshake above removes that from this suite.
Next ready task: T13
```

```text
Task: T13 — Public `run` command and terminal UX
Result: complete
Changed: src/cli.ts now implements `run` beside `check-config`, and composes the loop's real
  collaborators (preflightSource, allocateRunDirectory, prepareWorkspace, runCheckRound,
  runCodexTurn, openAgentLog, appendRunLog, writeRunReport) into one runTask call; it implements no
  part of the loop and no vendor protocol. Both commands take their own option set, so `--repo` is
  a run option and nothing else. CLI paths resolve from the invocation directory and workDir
  resolves from the config file's directory (resolveWorkDir), and both files are loaded and
  validated before anything runs and then stay fixed for the whole run. Progress is the run's own
  timeline, echoed as the runner appends it, minus its `final status:` line; the outcome block
  (status, reason, repairs used, run dir, working copy, report) is printed only after runTask
  returns, i.e. only once result.json exists. The host's SIGINT/SIGTERM are installed for the
  duration of a run behind an injectable InterruptSignals seam, abort the run's own stop request
  (T09), and are released in a finally block; the CLI waits for the run to finalize rather than
  exiting over it. Exit codes: 0 passed; 1 failed, or an input/preflight/reporting error; 2 usage;
  130 user-cancelled (finalized first). A report that cannot be written is printed as an error with
  the retained run directory and exits 1, and nothing prints a completion or names a report that
  does not exist. src/runner.ts adds `repairsUsed` to RunTaskResult (counted from its own attempts),
  so the terminal prints the runner's own count. README.md and the package.json description no
  longer describe `run` as unimplemented. tests/cli.test.ts was extended, and its old
  "run is not implemented" test replaced; the rest of the CLI validation coverage is kept.
Verification: npm ci — exit 0 (137 packages, 0 vulnerabilities). npm test -- tests/cli.test.ts —
  exit 0, 1 file passed, 47 passed (47). npm run build — exit 0. npm start -- --help — exit 0, prints
  both commands and the four exit codes. npm run validate — exit 0: format:check clean, lint clean,
  typecheck clean, 10 files passed, 248 passed | 1 skipped (249), build ok. The skip is the
  pre-existing platform-conditional symlink case in tests/workspace.test.ts. No live provider call
  was made and no account was authenticated against.
Evidence: tests/cli.test.ts runs real runs against temporary Git repositories with only
  dependencies.runAgentTurn substituted (the same boundary T14 will use): a passed run reaching the
  runner with resolved paths and recorded progress + outcome; a repair-then-pass run (3 real check
  invocations, repair feedback carrying exit code 1); a red run with no allowance left; a
  preparation failure; a report-write failure (no result.json, no outcome block, exit 1); refusals
  for invalid JSON, invalid config, a dirty source, an output directory inside the source, and a
  non-repository, each proved to have created nothing and started no command or turn by a probe
  file that would have recorded it; the same three-directory path-rule checks from a different
  invocation, config, and target directory; an interrupt through the CLI's own signals seam that
  cancels the run, waits for it, exits 130, and leaves a result.json that says `cancelled` for
  "implementation turn" with the handler released once; a stop before allocation that exits 130 and
  creates nothing; and a run that installs exactly one SIGINT and one SIGTERM listener during the
  turn and none after, while help and check-config install none at all. Regression probes: returning
  0 for a cancelled run failed the interrupt test (expected 130, received 0), and printing a
  completion plus a report path when the report write failed failed the report-write test (expected
  1, received 0). Both probes were reverted and the file returned to 47 passed.
Limitations: no live Codex call was made, so nothing here proves the adapter's behavior against the
  real runtime (T16). Real OS signal delivery to a `run` process is not exercised: Windows cannot
  deliver SIGINT to a child, and emitting one in-process would trip the test runner's own listeners,
  so the interrupt path is proven through the CLI's signals seam and the real listeners are only
  counted. POSIX signal delivery and the POSIX launcher path remain unverified on this Windows 11 /
  Node 24.14 host. The built `dist/cli.js` is exercised for `--help` only; the full built-CLI gate is
  T14. Pre-existing intermittent failures of the wider suite under artificial parallel load (noted
  in T12) are unchanged and were not reproduced during this task's verification.
Next ready task: T14
```
