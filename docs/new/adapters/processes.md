# Processes adapter

## Responsibility

Execute a supplied command and report its output and exit.

## Interface

Follow the [adapter contract](architecture.md#interface).
Input consists of an executable, argument array, working directory, environment and optional time limit.
The consumer supplies an output observer.

Stream stdout and stderr with their stream identity and return the exit code.
The consumer decides whether to preserve output and what the command result means for its work.

## Behavior

Pass executable and arguments separately. A shell command requires an explicit shell executable.
Use the supplied environment and necessary host settings without inheriting unrelated credentials.

Nonzero exit is a command result. Launch failures and timeouts are execution errors.
Apply the supplied time limit and end owned processes on timeout.
