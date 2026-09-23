# Processes adapter

## Responsibility

Execute a supplied command and report its output and exit.

## Interface

Follow the [adapter contract](architecture.md#interface).
Input consists of an executable, argument array, working directory, environment, optional standard
input and optional time limit. The consumer supplies an output observer.

Stream stdout and stderr with their stream identity and return the exit code.
The consumer decides whether to preserve output and what the command result means for its work.

### Required capability

run(command, onOutput) starts the supplied command, emits stdout/stderr chunks and resolves with its
exit code after completion. [PrepareWorkspace](../task-engine/actions/prepare-workspace.md#interface)
uses it for preparation; [Verify](../task-engine/actions/verify.md#interface) uses it for checks.
Local Git and coding-provider integrations may use the same command capability.

The return value is command data, not an artifact path or a pass/fail decision. Consumers persist
the emitted streams where their own output contracts require them.

## Behavior

Pass executable and arguments separately. A shell command requires an explicit shell executable.
Use the supplied environment and necessary host settings without inheriting unrelated credentials.
When supplied, deliver the standard input as UTF-8 text and end the stream. Consumers pass large
text here rather than as an argument, which the operating system bounds per argument.

Nonzero exit is a command result. Launch failures, failed standard-input delivery and timeouts are
execution errors.
Apply the supplied time limit and end owned processes on timeout.
