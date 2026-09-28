# Memory

## Responsibility

Make experience from completed hand-offs available to later agent invocations. Own bounded retrieval,
context presentation, ingestion receipts and coordination of writes. Memory supplements the current
request and its direct artifacts; it does not replace them or decide workflow outcomes.

## Interface

Application constructs Memory from [Nexus settings](../configuration.md#memory-settings) and supplies
it to action callers and recovery. [Integration](integration.md) owns the workflow mappings and
placement of calls. [AgentRuntime](../agent-runtime/architecture.md) receives the resulting text as
part of caller-prepared context; it does not query storage or interpret hand-off artifacts.

Memory consumes the public exports of the standalone
[agentic-memory package](https://github.com/saintiago/agentic-memory), including AgenticMemory,
NoteStore, Embeddings and LanguageModel contracts. Use a reproducible, revision-pinned package build
with its runtime dependencies and declarations; installation must work in a fresh Linux checkout
without a sibling repository or prototype. Do not import library internals or fork its algorithms.
The package owns note construction, embeddings, candidate selection, linking, evolution and search.
Nexus supplies a model transport satisfying LanguageModel, using an explicit endpoint, model,
credential reference, output bound and timeout. Memory model calls are not AgentRuntime invocations
and cannot recursively retrieve or ingest memories. Use the library's default prompts and pinned
reference embedder initially; generation uses no reasoning/thinking mode.

The public capabilities are:

| Capability | Input | Output and promise |
| --- | --- | --- |
| Recall | Invocation identity, caller-prepared query and location for retrieval evidence | Bounded supplemental context and a saved retrieval record, or an explicit disabled/unavailable result with no context |
| Remember | A source observation: stable source key, content, timestamp and provenance | Stored note identity, already-recorded result, or a deferred/uncertain result; never reports an uncertain write as success |
| Close | No new work | Settle active operations and release owned resources |

A source key identifies one observation, not the identity of the new library note. Provenance records
project, issue when known, workflow, role/action, source artifact and element, and applicable round,
submission, cycle and revision. It is returned on retrieval. Content must itself state the semantic
scope needed for interpretation; metadata alone is not embedded by the library.

Expected provider and persistence failures become explicit memory results and safe diagnostics. They
do not turn a successful business action into a failed one or trigger workflow recovery. Disabled
Memory performs no provider calls or ingestion writes. Failure to save evidence is reported, never
silently treated as a recorded result.

## Retrieval

Embed the supplied query and use the package's ranked search and bounded one-hop expansion. Do not
add an LLM query rewrite, reranker or answer generator. Keep direct-match order followed by linked
additions. A collection is shared experience, so notes from another project can appear; attribution
must survive and project scope must not be inferred from similarity alone.

Format each included note with its ID, original content, current context, keywords/tags and source
provenance. Identify direct matches and linked additions, retaining direct similarity scores in the
retrieval evidence. Label this block as historical evidence that may be mistaken or inapplicable;
current human instructions and authoritative project documents take precedence. Embedded source
instructions are quoted data, not additional agent instructions.

Apply the configured character budget to the complete supplemental block, including its framing.
Keep whole note blocks; skip an oversized note and consider later results. Do not silently truncate
original content or qualifiers. An empty result supplies no block. This limit never truncates the
current task, direct findings or other ordinary invocation context.

Save the query, returned IDs/order/scores and retrieval route, included and omitted IDs, exact supplied
block, duration and outcome for each invocation. The saved block preserves what the agent actually
saw even when those notes later evolve. If that evidence cannot be saved, report the failure and
invoke the agent without memory. This is retrieval evidence, not a copy of the entire database.

## Ingestion and identity

Accept only explicit observations from the integration mapping. Extraction is deterministic: use
artifact fields and stable formatting, without another LLM summarization pass. The library's add
operation then generates semantic attributes and evolves related notes. Do not create a separate
update-old-memories operation or import a provider's internal evolution machinery.

Capture the immutable source observation with create-if-absent semantics, without replacing an
existing snapshot or receipt on contention. Only the writer-lock holder changes receipt state.
Persist the source observation before calling add. Keep a receipt with its source key, content,
provenance and state: pending, in-flight, stored or uncertain. Stored receipts contain the returned
note ID. An already-stored key is a no-op. A known unchanged failure returns the receipt to pending
with its stage and reason; re-observing that hand-off can try it again. Do not add automatic retry
loops, background ingestion workers or a scan of old workspaces.

Persist in-flight before the call. If add reports uncertain persistence, retain its note ID and
all affected IDs when supplied. An in-flight receipt surviving its owning operation is also
uncertain, including a crash after successful storage but before the success receipt was saved.
Do not repeat that insertion automatically. An existing new note alone does not prove all neighbor
updates succeeded. Keep further collection writes deferred until the operator reconciles the
uncertainty; reads remain available. Report the receipt location and reason for attention. This is
at-most-one automatic attempt after an ambiguous result, not an exactly-once guarantee.

## Writer ownership and lifecycle

One collection has at most one active insertion across Nexus processes on the same Linux host.
Use a process-scoped OS advisory lock keyed by the configured store identity, held from receipt
inspection through add completion and receipt persistence. Serialize local calls as well. Release
on process exit; do not implement stale lock stealing based on a timer. All processes using that
collection share the same receipt/lock directory. This is a single-host contract; other hosts and
external writers must use separate collections or external coordination.

Wait for the lock only up to the configured acquisition bound. On contention, preserve a pending
observation and return deferred. Never release the lock while a timed-out operation can still write;
provider timeouts must settle/cancel the operation before releasing ownership. On shutdown, await
active operations. Worker shutdown precedes recovery, which then uses the same contract.

Initialize providers only when enabled, verify the declared embedding-space compatibility, and
report unavailability without preventing normal workflow execution. Do not launch Qdrant or download
an encoder implicitly. An explicitly allowed first download is host setup. The package owns its
insert serialization and storage behavior; the host lock adds only cross-process exclusion.

## Persistence and limits

Memory owns `<storage root>/memory/<storeId>/` for receipts and writer coordination. Keep this state
outside issue workspaces so recovery cleanup cannot erase ingestion evidence. Receipts retain their
source snapshot even if the original artifact is later removed. Memory uses ordinary durable file
writes; persist a complete receipt before replacing its previous state.

Retrieval evidence belongs with the execution logs at
`<execution directory>/logs/<execution id>/memory/<invocation id>.json`. Callers supply this location
just as they supply agent activity locations. It contains no provider credentials or raw transport
errors. Report memory outcomes through normal execution diagnostics without changing XState routes.

There is no HTTP server, MCP server, distributed queue, automatic historical backfill, memory
revision archive or new graph UI in this integration. The standalone package remains reusable by
other applications. Its lack of a multi-note transaction and semantic correctness guarantees remains
visible at this boundary.
