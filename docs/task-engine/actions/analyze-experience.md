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
A binding reads the reason and the evidence its terminal's producer retained — the producer's failure
record and the attempt's own artifacts — instead of an event that lived only in the stopped process,
so a restarted worker reconstructs the identical handoff. A terminal the producer states no reason
for carries a null reason.

Preparation's workflow binding follows the [Application composition](../../application.md#memory-composition)
and imports the [preparation attempt declaration](preparation-stage.md#preparation-attempt-identity-output).
A fresh attempt differs even for the same work/stage/round/terminal, including a failure before the
first round. Replaying the same retained attempt and handoff preserves its identity. This requires
no change to ExperienceHandoff or the request/submission identity algorithms below.

### Output and outcomes

Persist an experience request with the complete immutable handoff, its retained copy of the selected
evidence, source references and capture time outside disposable workflow attempts. The request
identity combines work, workflow, attempt and terminal identities. An existing identical request is
reused; conflicting input fails explicitly. Record the request reference and capture outcome as the
action's durable handoff evidence.

Return `recorded`, `skipped` or `unavailable`. Recorded means durably scheduled, not analyzed or
stored in memory. Skip when disabled or no selected work/evidence exists; an empty queue or selection
failure must not reuse a previous item's selection. Unavailable reports the capture failure. All
three outcomes continue to the same original business destination; analysis cannot mask success,
convert failure to success, prevent the next item or replace operational recovery. A binding that
cannot resolve its selection or evidence reports unavailable without an execution fault, and
disabled memory discovers nothing.

## Workflow placement

Every workflow invokes AnalyzeExperience after each terminal handoff for selected work, before
selecting another item, returning a final outcome or transferring a failed attempt to recovery.
Use the same bound implementation in separate states when destinations differ. Routing and original
outcomes belong to the workflow, not this action. Ordinary retry rounds and intermediate exchanges
do not trigger it. Each item in a finite queue produces its own request; queue drain produces none.

Finite delivery inserts it after successful CompleteTask and on selected-item routes to blocked:
PrepareWorkspace failure, StartRound exhaustion, Deliver failure and failed
CompleteTask. Selection failure and an empty queue skip analysis. Develop/Verify failures and
changesRequested reviews that return to StartRound are intermediate work.

The project parent inserts it after publishing an idea decision for approval and for each return to
the author: unsuitable, author-decision-needed and attempts-exhausted. Waiting for feedback is a
valid handoff, not an execution error. The idea child's selection-free blocked routes return to the
parent without a handoff; refinement, discussion and focused-help cycles remain intermediate work.

Unexpected execution errors are terminal handoffs only after already-started agents have settled.
Retain the original fault and invoke the same action before recovery, with saved evidence. A killed
process cannot execute a transition: recovery resumes recording from the retained interrupted
attempt before replacing its artifacts. Do not invent a business verdict for an operational fault.
Application records an operational error only for an execution fault of the attempt the stopped
invocation's own events established, and never a second time for an attempt that already reached a
terminal handoff, including when its capture event is the first event after restoration or reports
unavailable without a task identity. Ownership
resets for each worker launch and on entry to selection. A resumed active state beyond selection
can establish continuation of its retained selected work; an initialization or selection fault
cannot establish ownership merely because an old selection file exists. A declared blocked outcome
is the workflow's own verdict: its selected-item routes
already handed off, a failed selection and an empty queue hand off nothing, so neither invents an
operational fault from whatever selection record an earlier attempt retained.

Completion/publication actions supply their ordinary evidence and outcomes but never call memory
or schedule analysis themselves. In particular, a failed source update can yield a failed handoff
with completed implementation evidence; analysis uses that evidence without treating a Jira status
as its trigger or rewriting the original outcome.

## Analysis and memory execution

Capturing the request never waits for an LLM, network call or embedding. The action owns resumable
background processing of its recorded requests; Application supervises that capability and settles
or resumes it across worker exit, queue drain and restart. There is no second Application analysis
implementation or memory caller. Persist pending work before returning; do not rely on detached
promises in an exiting worker. Retain source evidence until analysis is settled: capture copies the
selected evidence into the request's own area before recording it, and the analyst reads that copy,
so recovery discarding or replacing the attempt can neither orphan an outstanding request nor make a
retry read replacement artifacts. The analyst runs in the retained evidence area, so a handoff whose
attempt never prepared a repository still has a valid invocation location. The analyst runtime
initializes its separate worktree as a Git repository before invoking the coding provider, just as
recovery does; it never initializes or changes the original attempt's workspace.

Assign each analyst invocation its own Markdown path in the durable request area under the [shared
report contract](architecture.md#markdown-reports-and-machine-outcomes). The configured analyst
reads the supplied artifacts and relevant history, searches existing memory for related lessons, and
returns zero or more substantive observations with applicability, uncertainty and evidence. For
success it can extract supported outcomes and mechanisms; for failure it must distinguish
demonstrated causes from hypotheses. Idea analysis preserves author intent, provisional decisions
and unanswered questions. Do not save routine status reports or entire handoffs.

This action's analyst receives AMEM MCP restricted to search. The action validates the minimal
observation response, assigned readable Markdown and readable evidence files within the request's
canonical evidence scope — the retained copy's file, or a cited original location whose retained
copy exists — persists accepted observations once, and submits them itself. Preserve original
artifacts. Other agents retain explicit AMEM search/save tools under the [agent-use
contract](../../memory/integration.md#agent-use); these are deliberate agent calls, not automatic
workflow hooks. No other Nexus operation adds automatic memory context.

The complete analyst response remains `{ observations }`: each candidate has content, evidence
(path, revision, detail) and relatedMemories (noteId, correction/extension relationship,
explanation). These are functional memory payloads and provenance, validated by the action and
passed to Memory; they are not general report fields. An empty observation list is valid.
Interpretation, investigation and why lessons were or were not selected belong in Markdown, never in
an added summary field. The saved analysis adds observed work/workflow/attempt/terminal,
role/profile, observation identities and ReportBinding. Report text is not submitted as a memory
observation.

Capture retains the selected producer outcomes and their associated Markdown via their exported
report declarations, alongside existing evidence. Copy bytes before recording the immutable request;
resolve original report paths through the retained evidence mapping when the analyst reads them. Do
not rewrite outcomes to point at copies or lose their original identities. A selected missing or
unreadable associated report yields unavailable capture, rather than silently dropping narrative.
Legacy combined evidence remains readable at its original retained shape. Analysis readers preserve
already accepted legacy outputs and exact submission payloads without requiring new Markdown or
reinvoking the analyst; an unfinished new analysis must satisfy its report binding before
submission.

Use the [shared validation-error continuation](architecture.md#rejection-evidence-and-continuation)
in the durable request area. The next permitted analyst receives its pending error and original
output/report evidence. Validate and save a usable replacement before clearing pending context;
resumed owner validation can finish the clear without invoking again or matching correction records.
Zero candidates is a valid replacement. Report usability remains required before new observations
are accepted; a readable Markdown edit or an obsolete hash/ledger alone never reinvokes analysis.

Once observations were accepted, preserve their content and identities, analysis timestamp/profile
and all stored submissions. A report replacement cannot replace accepted lessons with new, fewer
or zero candidates. Supply the settled observations as context if an actual unusable report needs
repair. Receipt continuation uses settled analysis and stored submission payloads, not another
analyst invocation. Evidence or invocation failures leave analysis pending without changing the
original handoff. Legacy accepted analyses need no retroactive Markdown association.

Stable submission keys derive from the persisted request and observation identities. Reuse exact
payloads, provenance, timestamps and keys after interruption or configuration changes. Processing
visits persisted submission identities as well as the current analysis observations, so removing or
replacing an analysis record cannot orphan pending submissions, receipt polling or failure reporting.
The analysis must be usable under current owner rules before these submissions resume; obsolete
hash or ledger fields add no gate. Durable acceptance is distinct from stored/searchable memory; poll accepted receipts, including blocked
receipts. Report outstanding work without changing the business result. Preserve existing memories
and persisted pending requests during migration; do not delete, silently re-embed or backfill them.
Before retrying analysis of a request recorded without retention, preserve its available declared
artifacts independently of the source workspace. Earlier completion requests have no artifact list:
retain their local artifacts and state directories. Keep request identities, immutable handoffs and
capture times; already accepted outputs and exact submission payloads remain unchanged. Missing or
unusable files are reported, and later retries never substitute replacement source files.

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
