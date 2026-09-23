# Jira adapter

## Responsibility

Perform explicitly requested Jira operations and return provider data.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies the Jira connection, credentials, project and field/workflow mappings.
Consumers supply the issue identity, query or requested change.

Expose issue reads, field changes, transitions, comments and ranking operations as required by consumers.
Return issue data, comments or the provider's operation result. Eligibility, claiming decisions and
desired task status belong to the calling action.

## Behavior

Keep task reads and conversation retrieval separate. Preserve full requested comment bodies,
attribution and source ordering. Ranking changes rank, not priority.

Translate requested fields and transitions through the configured mappings. Preserve Jira document
structure rather than flattening it into a shared cross-provider document format.
