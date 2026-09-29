# AnalyzeExperience

## Responsibility

Capture reusable experience after a work item's terminal handoff. One action serves every workflow,
on both success and failure paths. It is the only automatic Nexus workflow operation that invokes memory: search,
observation submission and receipt polling belong here. It does not change the business outcome,
update a task source or decide whether work succeeded.

## Interface

Follow the [action contract](architecture.md). Use the supplied workspace and terminal handoff
rather than discovering source status. Dependencies are the public [Memory](../../memory/architecture.md)
and [AgentRuntime](../../agent-runtime/architecture.md#provided-interface) contracts, the configured
analysis profile, durable storage and event publishing. AMEM's HTTP/MCP contracts remain provider-owned.

The workflow binding supplies this input using producer-owned artifacts and the selected workspace:

```ts
type ExperienceHandoff = {
  workId: string;
  workflow: string;
  attemptId: string;
  terminalId: string;
  outcome: string;
  reason?: string;
  workspaceRoot: string;
  artifacts: { path: string }[];
};
```

Identities are opaque values, not Jira issue/status contracts. `terminalId` identifies the specific
terminal handoff within the workflow attempt; repeated execution reuses it, while a new attempt or
idea submission has a new identity. Revisions belong in evidence when available; a merge revision
is not required for failed work or idea refinement. Never infer success from the outcome's name.
The bindings own workflow-specific artifact selection; the action has no switch on workflow names,
ticket statuses or concrete action implementations. Consumers use artifact declarations only.

### Output and outcomes

Persist an experience request with the complete immutable handoff, source references and capture
time outside disposable workflow attempts. The request identity combines work, workflow, attempt
and terminal identities. An existing identical request is reused; conflicting input fails explicitly.
Record the request reference and capture outcome as the action's durable handoff evidence.

Return `recorded`, `skipped` or `unavailable`. Recorded means durably scheduled, not analyzed or
stored in memory. Skip when disabled or no selected work/evidence exists; an empty queue or selection
failure must not reuse a previous item's selection. Unavailable reports the capture failure. All
three outcomes continue to the same original business destination; analysis cannot mask success,
convert failure to success, prevent the next item or replace operational recovery.

## Workflow placement

Every workflow invokes AnalyzeExperience after each terminal handoff for selected work, before
selecting another item, returning a final outcome or transferring a failed attempt to recovery.
Use the same bound implementation in separate states when destinations differ. Routing and original
outcomes belong to the workflow, not this action. Ordinary retry rounds and intermediate exchanges
do not trigger it. Each item in a finite queue produces its own request; queue drain produces none.

Finite delivery inserts it after successful CompleteTask and on selected-item routes to blocked:
PrepareWorkspace failure, StartRound exhaustion, Deliver failure, inconclusive Review and failed
CompleteTask. Selection failure and an empty queue skip analysis. Develop/Verify failures and
changesRequested reviews that return to StartRound are intermediate work.

Idea refinement inserts it after PublishDecision for approval and each return to the author:
unsuitable, author-decision-needed and attempts-exhausted. Waiting for feedback is a valid handoff,
not an execution error. Selected-submission routes to blocked also pass through it; failed selection
and drain skip it. Refinement, discussion and focused-help cycles remain intermediate work.

Unexpected execution errors are terminal handoffs only after already-started agents have settled.
Retain the original fault and invoke the same action before recovery, with saved evidence. A killed
process cannot execute a transition: recovery resumes recording from the retained interrupted
attempt before replacing its artifacts. Do not invent a business verdict for an operational fault.

Completion/publication actions supply their ordinary evidence and outcomes but never call memory
or schedule analysis themselves. In particular, a failed source update can yield a failed handoff
with completed implementation evidence; analysis uses that evidence without treating a Jira status
as its trigger or rewriting the original outcome.

## Analysis and memory execution

Capturing the request never waits for an LLM, network call or embedding. The action owns resumable
background processing of its recorded requests; Application supervises that capability and settles
or resumes it across worker exit, queue drain and restart. There is no second Application analysis
implementation or memory caller. Persist pending work before returning; do not rely on detached
promises in an exiting worker. Retain source evidence until analysis is settled.

The configured analyst reads the supplied artifacts and relevant history, searches existing memory
for related lessons, and returns zero or more substantive observations with applicability,
uncertainty and evidence. For success it can extract supported outcomes and mechanisms; for failure
it must distinguish demonstrated causes from hypotheses. Idea analysis preserves author intent,
provisional decisions and unanswered questions. Do not save routine status reports or entire handoffs.

This action's analyst receives AMEM MCP restricted to search. The action validates the
response and readable evidence files within the canonical workspace, persists accepted observations
once, and submits them itself. Preserve original artifacts. Other agents retain explicit AMEM search/save tools under the
[agent-use contract](../../memory/integration.md#agent-use); these are deliberate agent calls, not
automatic workflow hooks. No other Nexus operation adds automatic memory context.

Stable submission keys derive from the persisted request and observation identities. Reuse exact
payloads, provenance, timestamps and keys after interruption or configuration changes. Durable
acceptance is distinct from stored/searchable memory; poll accepted receipts, including blocked
receipts. Report outstanding work without changing the business result. Preserve existing memories
and persisted pending requests during migration; do not delete, silently re-embed or backfill them.

## Dependency enforcement and verification

Dependency-cruiser must reject imports of `src/memory/` from any implementation outside
`src/task-engine/actions/analyze-experience/`, except Memory's own internals. The action consumes only
Memory's public module. Application constructs and resumes the action's public capability without
importing or invoking Memory; AgentRuntime, other actions and adapters cannot import or call that component. Explicit agent MCP
calls are a separate provider tool boundary, not a second automatic workflow integration. Add the
action to existing action-declaration boundaries. Verify the rule with prohibited import fixtures.
Static dependency checks do not inspect runtime MCP settings: separately test that the analyst has search only, while ordinary enabled profiles retain explicit search/save access.

Workflow tests cover every terminal handoff, original outcome preservation, no learning during
retry loops or queue drain, multiple completed items and no stale selection. Action tests cover
idempotent capture, disabled/no-evidence skips, failure evidence, zero lessons, evidence validation,
immutable output reuse and receipts. Restart/parallel-error tests verify durable pending work,
settled agents before analysis and preserved recovery faults. Reuse existing service and analysis
contracts rather than duplicating AMEM algorithms.
