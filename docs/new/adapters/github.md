# GitHub adapter

## Responsibility

Perform explicitly requested GitHub operations and return observed repository and pull-request data.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies the repository connection and authorized credentials. Consumers supply target
identities, revisions and requested changes.

Expose pull-request, review, check and workflow operations as required by consumers. Read metadata,
conversations and checks independently when requested.

The calling action decides whether to find, create or update a pull request. The adapter performs
that operation; it does not combine the decision into ensurePullRequest.

## Behavior

Preserve revision and check-producer identity, conversation structure and complete requested content.
Apply supported provider preconditions when requested.

Report actual merge state and merge revision. Acceptance of an auto-merge request is not a completed
merge. Required-gate decisions belong to the caller; provider branch rules remain in force.
