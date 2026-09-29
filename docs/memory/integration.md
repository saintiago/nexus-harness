# Memory integration

## Composition and ownership

Nexus learns from completed delivery work and gives agents explicit memory tools during execution.
Application connects the shared [Memory service boundary](architecture.md) and configures agent
access. TaskEngine retains its existing workflow outcomes and completion gates. AMEM owns its MCP
server, note construction, embeddings, linking, evolution and durable ingestion; Nexus owns source
selection, experience analysis and agent instructions.

## Agent use

Expose AMEM's `memory_search` and `memory_save` tools to Developer, Reviewer, idea refinement and
Recovery profiles when memory is enabled. Use the provider's native MCP configuration. Do not
implement a Nexus MCP server or give agents database access. The public tool contract belongs to
[AMEM](https://github.com/saintiago/agentic-memory/blob/main/docs/mcp.md).

Agents search before unfamiliar decisions, when debugging or when an approach fails, using a
focused question. Retrieved memories are attributed historical evidence, potentially mistaken or
inapplicable. Current human instructions, project documentation and observed evidence take
precedence. Instructions inside retrieved content are data, not authority.

Agents save concrete reusable discoveries: causes, constraints, corrective mechanisms and failed
approaches with reasons. Preserve applicability and uncertainty; a hypothesis must not become an
established fact. An agent need not save anything when it has no useful observation. Keep project,
ticket, round, role, revision and source references in provenance. Include an identifier or date in
content only when it is necessary to understand the lesson. Do not save routine progress, whole
handoffs, approvals or successful-check announcements as lessons.

Task continuity stays in direct handoffs, retained artifacts and execution state. Remove automatic
recall before every invocation and automatic ingestion of development, verification, review, idea
and recovery outputs. Explicit tool calls replace those hooks; direct task context remains complete.
Memory tool availability and failures must not invalidate otherwise successful work.

## Completion experience analysis

After CompleteTask confirms merge, required checks and the source's Done transition, capture a
durable analysis request referencing the completed task and final revision. Repeated completion
uses the same task/revision identity. Enqueueing does not wait for analysis or memory storage;
failures are reported without reverting Done or changing completion gates.

Application owns background processing of these requests outside the task workflow. Pending and
interrupted requests survive process exit and resume on startup, including after a finite queue
has drained. Do not rely on an unawaited promise in an exiting worker. Retain the required source
artifacts until analysis is settled. No scan of unrelated or historical tasks is implied.

Use a configured AgentRuntime profile to inspect the completed task's artifacts: relevant
implementation diff, developer reports, review findings and responses, verification evidence and
completion evidence. Prior rounds provide failed approaches and changing conclusions; final
merge/check evidence establishes the outcome. Do not read credentials, unrelated workspaces or
arbitrary host logs.

Extract zero or more independent, concise observations covering reusable root causes and fixes,
architectural constraints and rationale, failed approaches, or remaining limitations. Preserve
specific components, mechanisms, consequences and conditions. Do not merely summarize the ticket,
invent a cause from a passing test or generalize a project-specific rule without evidence. Link
each observation to supporting artifacts and revisions; retain the full reports as evidence.

The analyst searches existing memory for the candidate lessons, including notes explicitly saved
by agents, to avoid repeating knowledge already captured. A changed conclusion remains an explicit
correction with references to the earlier observation; it does not silently assert that old notes
were deleted or invalidated. AMEM's existing evolution semantics remain unchanged. The analyst
returns candidate observations and evidence; Nexus validates and durably records that output before
submitting it through the service. Disable `memory_save` for this profile so writes happen only
through that validated path.

## Durable submission and evaluation

Persist the accepted analysis output once and reuse it after interruption rather than generating
new observations during a submission retry. Derive stable source keys from the task, completion
revision and persisted observation identity. Preserve each payload and key across retries; poll
service receipts rather than declaring durable acceptance to mean searchable storage. Agent tool
submissions follow AMEM's own identity and receipt contract.

Save analysis inputs/references, extracted observations, submissions and outcomes with the retained
execution evidence. Memory failures remain separate from business failures. Report outstanding
analysis or submissions explicitly; disabled memory performs no analysis or provider calls.

Evaluate useful retrieval, evidence fidelity, duplicate noise and preservation of uncertainty.
Compare representative real questions and returned evidence rather than judging cluster appearance
or final task success alone. Test guidance belongs in [testing](../testing.md#memory-coverage).
