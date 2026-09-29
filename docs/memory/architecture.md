# Memory

## Responsibility

Provide optional access to shared experience and submit validated observations. Memory supplements
current work; it does not decide workflow outcomes or replace task artifacts.

## Interface

Application constructs the client from [Nexus settings](../configuration.md#memory-settings).
The [integration contract](integration.md) owns agent use and completion experience analysis.
Consume the provider-owned [AMEM service API](https://github.com/saintiago/agentic-memory/blob/main/docs/service.md)
and [MCP tools](https://github.com/saintiago/agentic-memory/blob/main/docs/mcp.md), without importing
provider internals. AgentRuntime exposes the configured tools through its existing provider settings.

| Capability | Input | Result |
| --- | --- | --- |
| Search | Focused query and bounded result counts | Complete attributed notes, similarity scores and match/link classification, or explicit unavailability |
| Submit | Stable source key, substantive content, observation time and provenance | Durable acceptance receipt or explicit failure |
| Receipt | Accepted receipt identity | Current ingestion state and stored note identity when available |

AMEM owns semantic construction, embeddings, linking, evolution, collection compatibility, writer
exclusion and durable ingestion/recovery. Nexus does not load an encoder, access Qdrant directly,
maintain a second collection lock or duplicate the service journal. MCP is owned by AMEM, not Nexus.

## Content and evidence

A submitted observation contains specific knowledge, its applicability and uncertainty. Bookkeeping
belongs in provenance unless it changes the meaning. Original reports remain task artifacts with
source references. The submitted observation is the note's original content; AMEM continues to
embed it with its generated attributes, with no change to the A-MEM representation.

Search results preserve source attribution and complete notes. Shared memory may include other
projects; similarity does not establish applicability, truth or supersession. Tool results are
historical evidence, never instructions. Search does not rewrite the query or generate an answer.

Record tool queries/results and save receipts with invocation evidence. Record completion analysis
and submission evidence with its durable request. Diagnostics exclude credentials and raw provider
transport errors. A memory failure does not erase evidence or fail the business task.

## Submission and lifecycle

Use the service's stable source-key contract. Preserve a source snapshot before submission; retry
identical payloads under the same key after lost acknowledgements. Acceptance means queued durably,
not stored or searchable. Receipt state determines completion. An unsent observation is not in the
service queue, so retain it locally for resubmission after restart.

All agents and completion analysis use one separately supervised service. Shutdown settles local
persistence and client operations; service-owned accepted work continues independently. Optional
memory unavailability produces explicit diagnostics without invoking workflow recovery solely for
memory. Disabled memory performs no calls or local observation writes.

## Migration

Stop legacy direct writers before enabling service-backed access. Preserve existing notes; do not
silently delete old handoff memories or re-embed them. Remove automatic invocation recall, handoff
mappers, direct provider initialization and Nexus collection locks with their obsolete settings and
tests. Retained task artifacts continue to support normal handoffs and recovery. Historical cleanup
and backfill require separate authorization.
