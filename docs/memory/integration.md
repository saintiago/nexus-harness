# Memory integration

## Composition and ownership

[AnalyzeExperience](../task-engine/actions/analyze-experience.md) is the sole automatic Nexus Memory component caller.
All workflows invoke it after terminal handoffs for selected work, including success, failure and
human-feedback returns. Successful preparation has one such handoff after implementation work is
handed off, rather than after each accepted stage or evaluated skip; its
[handoff requirements](../task-engine/actions/analyze-experience.md#preparation-handoff-requirements)
govern complete preparation evidence and preservation of older pending requests.
Task source status is not the analysis trigger. The action owns durable
capture, analysis, memory search, validated submission and receipt polling. AMEM independently owns
semantic memory, MCP, embeddings and the ingestion queue.

Application binds the action and supervises its resumable background capability, without accessing
Memory directly. Workflow bindings supply public producer artifacts and generic handoff identities;
the action never imports producer implementations or reads Jira. TaskEngine preserves the original
business destinations. AgentRuntime transports the action's configured analyst invocation.

## Agent use

Developer, Reviewer, idea roles, every preparation author/evaluator and Recovery retain explicit AMEM
`memory_search` and `memory_save` tools through native MCP settings when memory is enabled.
They search for relevant experience and save concrete reusable discoveries with applicability,
uncertainty and evidence references. Keep
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

### Preparation attempt identity requirements

Operators must be able to restart preparation for the same ticket without colliding with an older
analysis request. A fresh preparation attempt has a distinct memory-analysis identity even when it
reuses the ticket, stage, round number and terminal outcome. Continuing an existing attempt after
interruption is not a fresh attempt: retrying the same terminal handoff, including after worker
restart, reuses its recorded request and does not create a second analysis request or duplicate a memory
submission. This applies to preparation handoffs with or without a numbered stage round.

The journey is: capture a preparation handoff -> retain its request and evidence -> resume its
analysis/submissions as needed. A fresh preparation attempt follows that journey with a distinct
request while the old request remains independently resumable. Do not replace old captured evidence
with fresh-attempt artifacts or change an existing pending request's identity to fit the new run.
Keep already accepted observations, submission identities, exact payloads and receipt continuation
intact when reporting contracts or attempt identities change. A receipt retry uses the settled
analysis rather than invoking the analyst again. No replacement ledger, backfill or duplicate
submission mechanism is introduced.

| Situation | Observable result |
| --- | --- |
| A preparation handoff is captured twice, then retried after a worker restart | All captures refer to the same durable request. Analysis and receipt continuation reuse existing work without duplicate lesson submissions. |
| A ticket starts fresh preparation and reaches the same stage, round and final successful handoff as an earlier attempt | The new handoff creates a distinct request without an old-request capture conflict. The earlier request and its original evidence remain intact and independently resumable. |
| A fresh preparation attempt ends before a numbered stage round exists | Its analysis identity still distinguishes it from earlier attempts; replay of that same handoff remains idempotent. |
| An older request has pending analysis or a pending receipt when a fresh attempt starts or the installation changes | It resumes under its existing identity and retained evidence, preserving accepted observations and submission payloads. The fresh attempt neither overwrites it nor duplicates its submissions. |

These are outcome requirements. The identity representation and workflow-specific handoff binding
belong to the action/Application architecture, not a new operator protocol. Current report validation
follows the [shared report requirements](../agent-runtime/report-requirements.md); removed report
hashes and correction ledgers cannot become new analysis or submission gates.

Requests retain their own copy of the handoff's selected evidence, outside the disposable attempt,
so an outage can neither orphan an outstanding request nor make a retry analyze a replacement
attempt's artifacts under the original request. Producers retain their failed and exhausted reasons
in the attempt, and bindings read them back, so a restarted worker reconstructs the identical
handoff. Application records an operational-error handoff only for an execution fault of an attempt
the stopped invocation established.

Evaluate lesson usefulness, source fidelity, duplicate noise and preserved uncertainty on success,
failure and idea handoffs. Cluster appearance and final task success alone do not establish useful
memory. Boundary and workflow coverage belong in [testing](../testing.md#memory-coverage).
