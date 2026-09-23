# Verify

## Responsibility

Execute the configured checks against the current implementation and preserve their results.

## Interface

Follow the [action contract](architecture.md). Import [devArtifact](develop.md#output).
Use [PreparedWorkspace](prepare-workspace.md#output) and project check commands, the [Processes adapter](../../adapters/processes.md#interface)
and the [Git adapter](../../adapters/git.md#interface).

### Output

```text
verificationArtifact = { pathFromArtifactsRoot: "verification.json", type: VerificationOutput }
```

```ts
type VerificationOutput = {
  headRevision: string;
  status: 'passed' | 'failed';
  checks: {
    name: string;
    exitCode: number;
    stdoutPath: string;
    stderrPath: string;
  }[];
};
```

Log paths are relative to the same round directory. Logs are written under checks/<check-index>/,
using the command's position in the configured check list.

### Outcomes

- passed: every required command completed successfully against the recorded revision.
- failed: at least one completed command failed, or the checks left tracked implementation changes.

Both outcomes write verificationArtifact and the command output. An inability to launch or complete
a command is an execution error, not a failed assertion. So is a worktree that does not hold the
development result's revision or that already holds tracked changes: no check runs and no verdict is
written.

## Behavior

Read the current development result and confirm that its revision is the work being checked.
Execute project-configured checks in the worktree. Stream their output and save it without requiring
the process adapter to create artifacts.

A developer's report does not replace these results. Preserve the command exit codes and output;
do not reinterpret an infrastructure error as a code defect.

Confirm that verification did not change the implementation revision or leave tracked implementation
changes. A check that changes the revision is an execution error: captured logs remain and no verdict
is written. Tracked changes left by the checks cannot produce passed.

Repetition executes the configured checks again. Any cache used by those commands remains command
behavior; this action adds no separate verification cache or configuration fingerprint.
