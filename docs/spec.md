# Simple development harness — specification

**Baseline:** local-first, single-process. Replaces the earlier design for this fresh start.

## 1. Goal

Turn an explicit development task into locally checked changes, with as little coordination code as possible:

```text
Task → working copy → coding agent → checks → result
                           ↑           |
                           └── repair ─┘
```

One CLI invocation processes one task. The coding agent implements and repairs; normal application code decides when to check, retry the code change, or stop.

The first working version produces a retained working copy and a local report. It does not create a PR, merge, update Jira, or deploy. Those are useful additions after the local loop works, not prerequisites for it.

The first coding runtime will be Codex. The coding assistant used to build this repository is a separate choice.

## 2. What the first working version does

1. Read a task JSON file, a configuration JSON file, and a local Git repository path. Validate inputs before execution; keep the loaded task/config fixed for the run.
2. Create a unique run directory. Clone the source repository's committed `HEAD` into it and use a dedicated local branch. Require a clean source checkout so uncommitted work is not silently omitted. Never reset or edit the source checkout.
3. Run configured setup and checks before the agent. A failing baseline stops the run with a clear explanation.
4. Ask the agent to implement the task in the run's working copy. Supply the task, acceptance criteria, and relevant target-repository instructions.
5. Wait for the agent to finish and stop its mutating processes. Run setup again, then all configured checks from the harness. Agent-reported success is not a check result.
6. If checks fail and repairs remain, send the failure output back to the agent, then repeat step 5. A setup/launch error or timeout stops the run rather than starting a code-repair loop.
7. Save the report and retain the working copy, whether the run passes or fails. Human review and subsequent delivery happen outside this version.

Run checks sequentially. Ordinary nonzero check results are repair feedback; a check that could not execute is not a pass. Do not keep coding after every check succeeds.

## 3. Bounds and outcomes

`maxRepairs` counts additional top-level coding turns after the initial implementation. With `maxRepairs: 2`, there are at most three coding turns. The agent's internal tool calls do not each count as a turn. Reusing a session does not create extra free attempts.

The task deadline covers preparation, agent work, setup, and checks. Each setup/check command also has a timeout; the remaining task time always wins. No automatic outer-loop infrastructure retries in the first version: stop, explain, and let the user rerun deliberately.

Final report statuses are:

| Status | Meaning |
| --- | --- |
| `passed` | Every configured post-agent check exited successfully for the retained working copy. |
| `failed` | Checks exhausted the repair allowance, execution failed, time expired, or the agent could not finish. Record the reason. |
| `cancelled` | The user stopped the run. |

Do not invent `passed` results for missing/skipped checks. Keep the agent summary separate from observed check results. Invalid input before execution is a CLI error, not a fictional run.

On cancellation/timeout, stop active commands and agent execution before reporting a clean stop. If process termination cannot be confirmed, report that limitation and do not reuse the working copy. Automatic crash recovery is not part of this version.

## 4. Files, not a database

Use one generated run ID, unrelated to task text, and a directory under the configured `workDir`:

```text
<workDir>/<run-id>/
  workspace/       # task's clone and changes
  result.json      # final report
  logs/            # command output and useful agent output
```

The report includes task/run IDs, source path and base commit, workspace path, start/end times, repairs used, status/reason, and check results grouped by baseline and implementation/repair attempt. Keep command arguments, exit/signal/timeout information, and log locations. Do not overwrite earlier failure evidence with the last attempt.

Retain files by default; cleanup is manual. A crash may leave an incomplete directory without a final report. Do not treat that as success, automatically resume it, or delete it on the next run. The user inspects/stops any leftover processes before reuse. No transactional run store, journal, or background reconciliation service is required.

## 5. Practical safeguards and limits

This first version is a **trusted, local developer tool**, not a secure multi-tenant execution platform. A separate clone protects the source checkout from ordinary edits, but is not a sandbox.

Use only repositories and commands the user approves. Do not supply production/publishing credentials, interpolate task text into shell commands, or log secrets. Derive output paths from generated run IDs and refuse unsafe overlap between source and output directories. Setup and tests execute project code too; do not present them as harmless data processing.

Keep the command plan outside the task working copy. Instruct the agent not to weaken tests or tooling to manufacture a pass; highlight changes to test/tooling/config files in the final summary. This version does not enforce tamper-proof tests or reproduce checks in a sealed environment. `passed` means the configured checks passed, not that all requirements are proven or the changes are safe to ship. Review the diff before delivery.

Unattended execution of untrusted repositories requires an explicit isolation improvement later; it is not achieved by renaming a folder “sandbox.”

## 6. Build incrementally

**Scaffold now:** working configuration/task validation, CLI help and `check-config`, developer tooling, tests, and CI. No agent or project commands execute.

**Next:** implement the local workspace/check/report loop using a fake agent, then add the actual Codex wrapper and exercise the full repair loop on a disposable repository.

**Later, only when needed:** task intake from Jira, PR publication, CI feedback, stronger isolation, or parallel tasks. Add one capability at a time with tests; no placeholder framework for all of them now.

For the first working loop, test baseline failure, pass without repair, repair then pass, repair exhaustion, execution errors, timeout/cancellation, preserved workspace, and unchanged source checkout. Normal tests must not call a real LLM.

The [architecture](architecture.md) assigns responsibilities; [WORKFLOW.md](WORKFLOW.md) defines JSON inputs. The [scaffold request](../scaffold-request.md) limits the current implementation task.
