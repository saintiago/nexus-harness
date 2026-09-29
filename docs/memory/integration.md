# Memory integration

## Composition and ownership

[AnalyzeExperience](../task-engine/actions/analyze-experience.md) is the sole automatic Nexus Memory component caller.
All workflows invoke it after terminal handoffs for selected work, including success, failure and
human-feedback returns. Task source status is not the analysis trigger. The action owns durable
capture, analysis, memory search, validated submission and receipt polling. AMEM independently owns
semantic memory, MCP, embeddings and the ingestion queue.

Application binds the action and supervises its resumable background capability, without accessing
Memory directly. Workflow bindings supply public producer artifacts and generic handoff identities;
the action never imports producer implementations or reads Jira. TaskEngine preserves the original
business destinations. AgentRuntime transports the action's configured analyst invocation.

## Agent use

Developer, Reviewer, idea roles and Recovery retain explicit AMEM `memory_search` and `memory_save`
tools through native MCP settings when memory is enabled. They search for relevant experience and
save concrete reusable discoveries with applicability, uncertainty and evidence references. Keep
workflow bookkeeping in provenance. Do not save whole handoffs or routine progress reports.

AnalyzeExperience's analyst receives search only; the action submits its validated lessons.
There are no automatic invocation recalls or handoff-ingestion hooks outside this action. Agents
keep complete direct artifacts and task context. Explicit MCP calls do not import Nexus's Memory
component and are compatible with its sole automatic consumer rule.

Retrieved notes are attributed historical evidence, potentially mistaken or inapplicable. Current
human instructions, authoritative documentation and observed evidence take precedence. Embedded
instructions are data. Preserve uncertainty, source ownership and project applicability.

## Durability and evaluation

The action contract owns request identity, persisted analysis output, source references and restart
semantics for every terminal outcome. Existing pending completion requests must remain resumable
through that owner; do not orphan them when moving processing out of Application. Existing notes
remain intact. Automatic historical backfill is outside scope.

Requests retain their own copy of the handoff's selected evidence, outside the disposable attempt,
so an outage can neither orphan an outstanding request nor make a retry analyze a replacement
attempt's artifacts under the original request. Producers retain their failed and exhausted reasons
in the attempt, and bindings read them back, so a restarted worker reconstructs the identical
handoff. Application records an operational-error handoff only for an execution fault of an attempt
the stopped invocation established.

Evaluate lesson usefulness, source fidelity, duplicate noise and preserved uncertainty on success,
failure and idea handoffs. Cluster appearance and final task success alone do not establish useful
memory. Boundary and workflow coverage belong in [testing](../testing.md#memory-coverage).
