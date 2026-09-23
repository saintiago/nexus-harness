# Git adapter

## Responsibility

Perform requested local and remote Git operations.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies Git command execution. Consumers supply repository paths, revisions, remotes
and the requested operation.

Return repository state, command results or diff data as required by the consumer.
The calling action decides whether to create or reuse a checkout and how to handle existing work.
The adapter does not combine these decisions into a prepare operation.

## Behavior

Preserve the requested revision identities and report tracked and untracked work when reading status.
Perform the requested operation without adding resets, cleanup or history rewriting.

Return operation failures with useful Git diagnostics. Deciding how to reconcile the repository
belongs to the caller.
