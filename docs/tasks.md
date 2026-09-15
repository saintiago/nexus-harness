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
| [ ] | T05 | Final report and attempt evidence | T02, T04 |
| [ ] | T06 | Baseline and implementation loop with a fake agent | T04, T05 |
| [ ] | T07 | Bounded repair loop and honest outcomes | T06 |
| [ ] | T08 | Total deadline, command limits, and timeout shutdown | T07 |
| [ ] | T09 | Cancellation and confirmed process shutdown | T08 |
| [ ] | T10 | Final diff inspection and review warnings | T07, T09 |
| [ ] | T11 | Offline local-loop milestone | T10 |
| [ ] | T12 | Real Codex adapter with offline contract tests | T11 |
| [ ] | T13 | Public `run` command and terminal UX | T12 |
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
