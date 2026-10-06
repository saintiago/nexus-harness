# Implementation handoff

## Responsibility and interface

After evaluated Architecture and its plan, create/link implementation tickets and retain a resumable
handoff. Preparation Done records that handoff.

Follow the [action contract](architecture.md). Import the plan and current acceptance declarations
from [preparation operations](preparation-stage.md), [WorkspaceRef](../../workspace.md#layout-and-reference)
and the [completion declaration](complete-task.md#output). Use the configured
[Jira adapter](../../adapters/jira.md#interface) for source effects. No GitHub publication capability
is needed here. Selection and PrepareWorkspace consume the input declaration owned by this action.

Construction supplies the project's existing idea and task candidate queries and preparation status
mappings, alongside the ticket-creation settings. Preparation statuses include submitted/active Idea,
the approved-idea admission status (Draft), Requirements, UX Proposal, Storybook Refinement and
Architecture. Derive these inputs from existing project settings; introduce no new operator setting.
Ranked identity searches and explicit before/after rank operations suffice; the adapter contract
does not change.

### Output

Retain the accepted plan identity, plan-index-to-ticket mapping, original source identity and each
creation/link/ranking/admission acknowledgement under the source issue's parent area. Write an input
record under each implementation issue's `parent/implementation-input.json` before admitting it:

```ts
type ImplementationPrerequisite = {
  key: string;
  workspace: WorkspaceRef;
};

type ImplementationInput = {
  sourceKey: string;
  sourceWorkspace: WorkspaceRef;
  architectureResult: ArtifactRef;
  planIdentity: string;
  plannedTask: number;
  prerequisites: ImplementationPrerequisite[];
  continuation: { workspace: PreparationWorkspace; headRevision: string } | null;
};
```

PreparationWorkspace is imported from its producer, rather than independently defined here.
Accepted stage/document/prototype references are reached through the source workspace and current
Architecture handoff. Ticket descriptions link the source, planned task, criteria and accepted
references; machine admission uses the record, never parsed description prose. Each issue's source
workspace pointer names its own root. Each prerequisite names its ticket key and the workspace
reference the handoff resolved for that ticket, so selection and preparation read that ticket's
completion evidence from the recorded reference instead of reconstructing a path.

The first task in stable topological plan order receives continuation. Every later task requires
that first ticket's merge/check completion as well as its declared prerequisites, since its merged
base must contain preparation. Store that requirement in prerequisites without duplicating keys.
Do not add ordering between otherwise independent later tasks. Plan indices retain their original
identities even when creation order differs. Only the first ticket can use the preparation checkout.

## Validation and source effects

Require a current Architecture decision and nonempty evaluated plan. Validate prerequisite indices,
duplicates, self-dependencies and cycles before source effects. Recheck current stage decisions,
report/ticket associations, applicable prototype inspection, explicit pending corrections and
repository/branch continuity before freezing the handoff. Later-stage document edits do not
mechanically invalidate an earlier verdict. Invalid acceptance routes through preparation reevaluation. An incompatible repository
requests attention without discarding work. There is no assembly or preparation-only PR gate.

Save the immutable handoff basis before ticket creation. Once source effects begin, never apply
changed plan positions to existing ticket identities. A changed plan or input during unfinished
handoff requests reconciliation rather than additional creation under an ambiguous mapping.

Create in stable topological order with the existing source-side identity derived from source issue
and plan index. Save successful identities immediately; reconcile an uncertain creation against that
identity before retrying. Multiple matches request attention. Complete missing links, input records,
rank changes and configured ready-status admission on replay. Preserve recorded initial admission
status, already-applied ready status and unexpected human changes. Source failures cannot authorize
advancement or original completion.

Retain each created ticket's input immediately after its identity, before its link and rank effects:
creation can land a ticket directly in the configured ready status, so a ticket that carries the
handoff's source identity is never selectable without its input. Selection and PrepareWorkspace
classify such a ticket through this record: while it still owes the ticket its input, link, rank or
admission the ticket is ineligible, and a ticket the record does not name requests attention with its
identity. The earlier-contract exception requires a source record without the current contract's
frozen basis and with the ticket's link and admission finished; that ticket keeps the ordinary delivery
path. Finished effects with a current-contract basis and missing input require reconciliation, since
that input owns preparation continuation and prerequisites.

Rank every handed-off implementation ticket ahead of remaining preparation tickets in the project,
with prerequisites before dependents in actual source rank, following the
[project workflow requirements](../../project-workflow.md#implementation-before-further-preparation).
The ranking procedure and replay acknowledgement are defined below.
After all tickets have input records and completed admission/link/rank effects, publish their
links in plan order and transition the original to Done. The comment states preparation handoff,
without claiming implementation shipped. Even one planned task creates a distinct implementation
issue. Repetition finishes missing effects without duplicate issues or comments.

## Queue ranking

Use the union of the configured candidate queries, restricted to this project and its preparation
statuses, to find remaining preparation in Rank ASC order. Exclude the original issue being handed
off. Waiting for Feedback and Done are not preparation anchors. Status filtering uses the existing
mapping rather than issue labels, descriptions or hard-coded status names. The searches return
identities; no additional issue-field projection or eligibility policy is needed for ranking.

Process every ticket in stable topological plan order, including the first ticket and tasks with no
declared prerequisites. Before ranking a ticket, read fresh project-wide Rank ASC order so it includes
created tickets not yet admitted to the candidate queries, and find the earliest remaining preparation
anchor. Use the prerequisite keys retained in the ticket's input, including the preparation
continuation prerequisite. Require the ticket, its prerequisites and any preparation anchor to occur
in the observed rank order; missing identities or failed searches cannot establish completed ranking.

All previously processed prerequisites precede preparation. If the ticket precedes a prerequisite,
move it immediately after its last prerequisite in actual source order. Otherwise, if it follows the
earliest preparation anchor, move it immediately before that anchor. If neither condition holds,
leave its rank unchanged. These moves preserve the established prerequisite-before-preparation
invariant without requiring a contiguous implementation block or imposing an order on unrelated
implementation tickets. With no preparation anchor, only prerequisite correction is needed. Moving
one ticket never changes the relative order of the other source issues.

Retain the existing per-ticket ranking acknowledgement after the observed order or acknowledged rank
effect satisfies both constraints, including when no move is needed. Finish ranking before that
ticket's ready-status admission. On unfinished-handoff replay, inspect actual rank again even for
acknowledged tickets: a lost rank response can have applied the move, and an earlier acknowledgement
does not prove the current order. Reuse the frozen plan, inputs and ticket identities; no rank target,
priority flag or additional checkpoint is persisted.

Before publishing the completed handoff and closing the original, re-read source rank and remaining
preparation and confirm every planned ticket precedes preparation and every prerequisite precedes its
dependent. A failed operation or unsatisfied final order leaves the handoff unfinished under the
existing failure/replay path. There is no new retry loop or selection scheduler. Completed historical
handoffs and their admitted tickets require no migration.

## Selection and delivery admission

Resolve prerequisites through each ticket's actual completed delivery artifact and source completion;
Done on the preparation issue supplies no delivery evidence. Missing merge/check evidence defers
implementation and keeps prerequisite work first; provider faults remain faults. Tickets otherwise
compete in the source-ranked serial queue, with the completed handoff placing its implementation
ahead of remaining preparation under the project workflow requirements.

The first implementation receives the recorded repository reference and comparison base, preserving
preparation commits and branch. Later tickets obtain their own checkout from updated merged base;
validate that prerequisite merge revisions are included before starting. PrepareWorkspace owns
repository preparation and retained identity checks. Delivery owns one PR per implementation ticket,
including documents and retained prototype work carried by its branch. Review assesses task correctness
at the delivered revision; stage acceptance supplies context and cannot substitute for its verdict.
Its scope includes relevant pre-existing code; the contributed diff is
orientation rather than a review boundary. Changed-document references describe committed work;
unchanged adequate documents need no citation or historical approval-reuse record. Optional
applicability evidence remains attributed context without an `existingDocuments` binding.
There is no final aggregate feature PR. Required verification, review, merge and post-merge gates
apply to each ticket independently.

The continuation head is the frozen, committed preparation revision. Validate that it remains in
the branch history; resumed implementation can have later commits without pretending they were
stage-evaluated. Reject missing or rewritten preparation history. The handoff record and accepted
artifacts are immutable inputs once admission starts, not a mutable pointer to whatever HEAD later
holds. Only a successfully completed first delivery releases its checkout for ordinary maintenance.

## Repetition and compatibility

Keep the preparation checkout and immutable accepted evidence available while its first implementation
uses them. Ordinary restart reuses producer records and the composed checkpoint. Reconcile old
per-stage layouts and already-started publication separately before new routing; preserve existing
PR/review/check evidence and uncertain source effects. Incompatible legacy state requests attention
with its identity, rather than being reset or treated as a new successful handoff. This is checkout
reconciliation, without a parallel legacy publication workflow.

A retained preparation-only documentation publication, recorded by identity or by its retained
documentation review, requests attention with that identity before any new ticket effect. Its pull
request, review and check state is never treated as a completed handoff and is never reset.
