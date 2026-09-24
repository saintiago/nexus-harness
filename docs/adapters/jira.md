# Jira adapter

## Responsibility

Perform explicitly requested Jira operations and return provider data.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies the Jira connection, the operator's API token, project and field/workflow mappings.
Consumers supply the issue identity, query or requested change.

Expose issue reads, field changes, transitions, comments and ranking operations as required by consumers.
Return issue data, comments or the provider's operation result. Eligibility, claiming decisions and
desired task status belong to the calling action.

### Required capabilities

| Operation | Inputs and result | Consumers |
| --- | --- | --- |
| Search issues | Configured query and ordering → complete ordered issue identities | [SelectTask](../task-engine/actions/select-task.md#interface) |
| Read issue | Issue identity → current issue fields and status | SelectTask, Develop, Review, Deliver, CompleteTask |
| Read comments | Issue identity → complete attributed provider-native comments | SelectTask, Develop, Review; publication inspection |
| Read available transitions | Issue identity → permitted transition identities and destinations | Actions changing source status |
| Update fields | Issue identity and requested fields → provider result | SelectTask for workspace pointer; Deliver for PR field |
| Transition issue | Issue identity and explicit transition → provider result | SelectTask, Deliver, CompleteTask |
| Add or edit comment | Issue identity, content and existing comment ID for edits → comment identity | Deliver and Review |
| Create issue | Requested issue fields → created issue identity | Authorized recovery tools |
| Rank issue | Issue identity and before/after target → provider result | Authorized recovery tools |

Read results retain the Jira document structure and comment metadata; consumers use those provider
types rather than a second shared issue schema. Publication consumers retain any returned IDs they
need and decide whether a further write is necessary.

## Behavior

Keep task reads and conversation retrieval separate. Preserve full requested comment bodies,
attribution and source ordering. Request each search result's issue key explicitly: the search
endpoint returns only the issue id unless the `key` field is requested. Ranking changes rank, not
priority.

Translate requested fields and transitions through the configured mappings. Preserve Jira document
structure rather than flattening it into a shared cross-provider document format.

Request English provider labels with `Accept-Language: en-US` so status names match the configured
English workflow mappings independently of the HTTP client default locale.

## Idea refinement use

The [idea refinement workflow](../idea-refinement/spec.md) uses the same Jira adapter for
configured `Idea` selection, issue revision/author/comment reads, status transitions and
author-facing Jira comments. In HARN, selection moves an idea to `Idea Refinement`; approval moves
it to `Draft`; a returned idea receives a human-facing comment and moves to
`Waiting for Feedback`. The author replies in a Jira comment and moves it back to `Idea`.
Internal agent feedback stays in artifacts and logs. The shared Task workflow permits these
transitions. Idea and finite-delivery selectors are separate even when they use the same Jira
project. Actions own eligibility, revision comparison, verdicts and desired statuses. The adapter preserves provider identity
and revision information needed to avoid overwriting an idea that changed after selection.
