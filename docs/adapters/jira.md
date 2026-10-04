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

Expose ranked issue search, issue/comment reads, available transitions, field updates, status changes,
comment publication, issue creation, issue links and ranking. Parent-owned selection, input-refresh,
publication and handoff actions consume these capabilities. Child business actions receive no Jira
adapter. Authorized project-scoped recovery tools can use the same operations. Preserve provider-native
issue/comment shapes and attribution. Actions own eligibility, claiming, reuse and desired statuses.
Creation returns issue identity; linking receives explicit source/target identities and link type.

## Behavior

Keep task reads and conversation retrieval separate. Preserve full requested comment bodies,
attribution and source ordering. Request each search result's issue key explicitly: the search
endpoint returns only the issue id unless the `key` field is requested. Ranking changes rank, not
priority.

Translate requested fields and transitions through the configured mappings. Preserve Jira document
structure rather than flattening it into a shared cross-provider document format.

Request English provider labels with `Accept-Language: en-US` so status names match the configured
English workflow mappings independently of the HTTP client default locale.

## Parent workflow use

The [project workflow](../project-workflow.md) owns every Jira effect. Idea approval maps to Draft;
feedback maps to Waiting for Feedback. Preparation handoffs publish a result and advance or return
upstream. Architecture creates linked implementation tickets before completing the original.
Finite delivery publication updates reports, PR fields and status using saved child evidence.
The parent captures source input and supplies it to children. Refreshing that input at later explicit
boundaries remains parent-owned. The adapter owns no routing, dispatcher or universal ensure operation.
