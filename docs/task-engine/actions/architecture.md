# Actions

## Responsibility

An action performs one workflow operation. It reads declared input artifacts, carries out its work,
writes declared output artifacts and returns a named outcome. Its output declarations are its data
interface to other actions.

## Interface

Actions follow the [TaskEngine action contract](../architecture.md#actions). They are bound functions;
configuration, capabilities, event publishing and the [workspace reference](../../workspace.md#layout-and-reference)
are supplied before execution. An action receives only the dependencies it needs.

An action design specifies:

- The operation it performs.
- Input artifact declarations it imports, including which inputs are optional.
- Output artifact declarations it owns: paths, content types and meanings.
- Returned outcomes and which outputs each outcome produces.
- Required configuration and capabilities.

Actions invoke capabilities through their public interfaces. Agent-backed actions use
[AgentRuntime.run](../../agent-runtime/architecture.md#provided-interface), supplying context assembled from their inputs
and interpreting the returned output themselves. Actions requiring JSON supply a machine-readable
output schema derived from their owned response schema through that interface, as well as the
response instructions in context. They still validate the returned content and business rules before
persisting an artifact; structured output does not establish correctness or approval.

### Markdown reports and machine outcomes

The [report requirements](../../agent-runtime/report-requirements.md) govern all roles, including
Recovery and experience analysis. Each caller assigns one Markdown path before invocation and
supplies it with the outcome schema and reserved record paths. The agent writes that report and
returns only the outcome. AgentRuntime transports this context and schema; it neither reads the
report nor owns storage, validation or routing.

The shared report helpers own this association declaration and readable-file operations:

```ts
type ReportBinding = {
  report: ArtifactRef;
  invocationId: string;
};
```

A new saved outcome includes ReportBinding and its owner's observed work identity, role, selected
profile and applicable input/revision metadata. Existing owner-specific identity names can remain;
Recovery records null work identity when no item was selected. None of this metadata is agent
output. Owners export response and saved-outcome schemas separately; no universal business envelope
or workflow coordinator is required.

Assign `reports/<invocationId>/<role-or-variant>.md` within the owner's current round/cycle artifact
area. Recovery uses its stable recovery area; analysis uses its durable request area. Initial,
focused, post-help and retained-revision turns have separate paths, as do concurrent roles. Create
the parent directory before invocation. Agents may write the assigned Markdown but not outcome/state
records. Reports stay outside the product checkout and path-scoped commits.

After the invocation, validate the strict response and functional data, read the assigned report as
UTF-8 text, and require a readable regular file at that path. Do not impose headings, length,
nonempty-prose or JSON rules. Check the owner's existing input/revision rules before saving the
outcome. A saved new outcome is usable only with its associated readable report. Do not compute or
compare Markdown-byte hashes, including on retained reads, capture or publication. Readable changes
to report wording do not invalidate the association. Do not infer status, verdict, findings or
routing from report prose; assessment quality remains the responsible role's judgment.

Persist the outcome only after these checks. Retained invocation context records the assigned path,
invocation and current inputs with existing invocation evidence. An interrupted save can finish only
from that invocation's usable output/report and still-valid owner basis; otherwise normal recovery
or reassessment applies. Never attach a previous invocation's report to a new outcome. Do not
reinvoke merely to reconstruct an already saved usable result.

Context readers import producer declarations, pass functional inputs as data, and supply relevant
Markdown contents or readable paths with work/role/profile/invocation/revision attribution. Include
complete necessary evidence; published comments are not repair context. Report-binding validation
and text loading are shared plumbing; owners select relevant history and apply continuation rules.
Human publication uses a validated saved report as text, alongside functional publication fields. PR
and implementation review bodies use the saved Markdown text. Concise ticket feedback uses the
opening narrative paragraph, prefixed with the observed profile and outcome; role instructions ask
for a brief opening account without enforcing a heading or prose schema. If no opening prose is
available, use the known outcome and report reference, never invent findings. No decision or finding
is extracted from that paragraph. The publication owner retains the exact body it sends and reuses
it on repetition, so reconciliation never requires regenerating prose or comparing a different
rendering.

### Agent response contracts

Each report owner defines its response schema separately from its saved artifact schema. Derive
the provider schema and response-format text from the same response declaration. Field descriptions
state meaning and ownership; caller-supplied instructions state outcome, role and invocation
restrictions that the provider schema cannot express. Supply these rules before invocation, including
previous reports as context and the assessed revision when relevant. Keep semantic validation with the
owner of the rule. Shared report helpers format, parse and retain evidence; they do not choose a
verdict, infer artifact ownership or supply a second workflow policy.

The agent returns only outcome fields and writes its assigned Markdown and explicitly assigned
documents or evidence. The caller supplies observed identity/revision metadata and writes its
declared artifacts. Identify the action-owned paths in invocation context and explicitly forbid the
agent from writing them. Response nullability conversions are declared mappings, not repairs of
malformed output. Reject unknown response fields rather than silently stripping claims outside the
response contract.

When a contract removes fields, its producer-owned saved-record reader can permit those former
fields in retained artifacts without retaining their obsolete validation or adding them to the
current response schema. Keep required control/functional data, report associations and applicable
input/revision rules validated. Provide the original report as readable historical context; do not
rewrite it or synthesize missing current data. Complete recorded identities retain historical fields
where existing associations depend on them; a simplified typed view is not a new identity. This
compatibility belongs to the report producer, not to a generic history reader, AgentRuntime or a
parallel workflow.

New saved-outcome readers require ReportBinding. Retained separated outcomes may contain the former
`reportIdentity` field as opaque historical data; its absence, value or mismatch with readable
Markdown is never a gate. Preserve the original saved values when existing author/evaluation or
source associations use the complete record identity, without hashing the Markdown it references.
Producer-owned compatibility readers separately
accept former combined artifacts with their former required narrative and identity fields. A record
with any new binding field must satisfy the new schema; a damaged new record cannot fall back to
legacy parsing. Retain legacy bytes without adding report paths or rewriting them into Markdown.
Provide the original combined artifact as readable historical context. Existing usable completed
legacy outcomes can continue only under their owning action's current input/revision/evidence
protections, including [preparation compatibility](preparation-stage.md#retained-record-compatibility);
superseded per-file prototype rules do not gate continuation. No new
Markdown requirement is imposed retroactively. Legacy findings may remain readable fields but no
longer require machine consistency or lifecycle validation.

### Rejection evidence and continuation

Validation errors are distinct from valid negative business outcomes and unavailable invocation
output. The validating caller preserves the exact returned outcome bytes, available original
Markdown and the specific violated rule before raising the existing execution error. A malformed
saved record remains readable evidence, not a usable producer artifact. Unavailable output/report
stays explicitly unavailable with its attempted path; do not reconstruct it from activity.

The caller supplies the owning area and responsible role/response variant. Shared helpers perform
readable evidence storage and context formatting; they do not own routing or decide usability.
Use the existing `report-feedback/` area outside disposable attempt state. Preserve diagnostics and
available report copies there as readable history, with observed work, role/profile, invocation,
operation and relevant round/request/revision attribution. Retain original reports without rewriting
history. The sole continuation state is one `pending.json` validation-error context per responsible
role/response variant within that area. It contains the actionable reason and attribution plus
available output/report or their readable references. A later invalid attempt updates this context
with its useful diagnosis while retaining earlier evidence. No rejection IDs, correction records,
resolved-reference lists, supplied-feedback proofs or saved-outcome identity matches are created.

Preparation owns feedback in its stage area, idea refinement in its refinement area, finite delivery
in the selected implementation issue root, analysis in its durable request area, and Application
recovery in its stable project recovery area. Recovery partitions context by selected work, with a
separate no-selected-work location, so a different item cannot inherit an earlier item's errors.
Each caller selects a fixed work/role/response-variant location; concurrent roles remain separate. Repository donation, profile changes, round advancement,
selection reset and worker restart neither transfer this context to another item nor erase it.

Before the next permitted responsible invocation, supply its pending error reason, original
attribution and available rejected evidence as historical context. Current human input, response
rules and substantive finding obligations govern. Do not require a previous profile, round, branch
or invocation to match the new attempt. Incompatible response variants and other roles/items do not
inherit the context. Agents do not write error-state or correction declarations.

After the responsible owner validates and saves a replacement under its normal functional,
readable-report and applicable input/revision checks, clear that responsibility's pending context.
This includes valid failed, changes-requested, needs-input and upstream-return outcomes: usability
is not business approval. Interrupted processing may clear context after owner validation of the
saved replacement; no proof that its invocation received particular errors is required. Mere edits
or existence of a historical file are insufficient. Use the owner's current attempt/round and
input/revision rules to select the replacement; do not search older usable outcomes to bypass a
failed responsible attempt. An invalid replacement leaves actionable
context pending. Save-before-clear ordering makes interruption safe: replay validates the saved
replacement and completes the clear without another invocation or a correction protocol. A missing
pending file means no pending context; an unreadable existing one is an explicit storage error.
Failure to preserve evidence or clear context reports the original problem and storage failure
without granting acceptance or a new attempt.

Producer-owned compatibility handling carries still-actionable former feedback into this simple
context before retiring active ledger/supplied-feedback state. Previously resolved diagnostics stay
history and must not be reopened solely because their ledger is removed. Existing validated
replacement evidence can establish usability under current owner rules without correction identity
matching. The owner imports applicable unresolved legacy diagnostics once, persisting simple
pending context before moving their active ledger/supplied-feedback files into readable history.
Complete this conversion before invoking or clearing context; retry an interrupted conversion
from available original diagnostics without reopening already resolved errors. Historical files
are thereafter evidence only, so clearing pending context cannot reimport old ledger entries.
No migration marker or journal is introduced. Preserve legacy feedback bytes as readable history;
do not maintain a second ledger reader as a runtime validation gate. Remove correction schemas,
record hashing, matching and related prompt instructions and tests across all owners together. No new migration registry or matching mechanism
is needed. Existing recovery, finite allowances, workflow routes and acceptance/review/CI gates
continue to decide whether any further invocation is permitted.

### Artifact declarations

An artifact declaration has two properties:

```text
{
  pathFromArtifactsRoot,
  type
}
```

pathFromArtifactsRoot is a fixed relative path within the current round's artifact directory.
type describes the stored content's shape. The declaration identifies a data contract; the current
workspace and round determine the concrete file. Store the content in the file, not the declaration.

Each producer exports its output declarations separately from its executable implementation.
Consumers import those declarations rather than redefining paths or content shapes. Each output
path has one producer. Content types contain the information consumers need.

For example, the development result is declared as:

```text
devArtifact = {
  pathFromArtifactsRoot: "development.json",
  type: DevelopmentOutput
}
```

This is pseudocode: DevelopmentOutput denotes the content type, not a runtime type registry.
The producing action's design defines its fields and their meaning.

### Reading and writing

Artifact helpers are bound to the current workspace. readInputArtifacts accepts imported
declarations and returns their typed contents in argument order. writeOutputArtifact accepts an
owned declaration and content of its declared type. Structured outcomes are stored as JSON;
associated Markdown is loaded as text through report references, never through a JSON artifact
parser.

For finite delivery, read state/current-round.json from the selected workspace on each call and
resolve the artifact as artifacts/<number>/<pathFromArtifactsRoot>. Idea refinement uses its own
submission/cycle layout and round plan. Missing or invalid round state fails the operation, except
for [StartDevRound](start-dev-round.md#input) planning the first round. StartDevRound reads the current round's
results before replacing that record. Do not cache the current round between calls. Missing current
inputs never fall back to earlier rounds.

For finite delivery, the current-round record is owned by
[StartDevRound](start-dev-round.md#output). These path-resolution rules belong to the helpers, not
to that action.

History reads are explicit: readArtifactHistory(declaration) returns the available earlier-round
values with their round numbers, in order. A missing artifact in a round that did not produce it is
normal; an unreadable existing artifact is an error. Consumers import the same producer declaration
for current and historical reads. History readers do not copy, archive or rewrite prior artifacts.

StartDevRound and StartIdeaRound reuse small filesystem functions: `readCurrentPlan` validates
the caller's record shape, `listNumberedHistory` enumerates retained rounds, `ensureRoundDirectory`
creates the next artifact directory, and `saveCurrentPlan` persists the plan. The caller supplies
fixed paths and record validation. These functions do not choose roles, count repairs, interpret agent
feedback or decide workflow routes. StartDevRound owns the finite-delivery
policy; [StartIdeaRound](../../idea-refinement/spec.md#artifacts-and-revision-binding) owns the
idea-cycle role plan. No policy registry or second coordinator is introduced.

The interaction is:

```text
// Develop writes its declared output.
writeOutputArtifact(devArtifact, developmentOutput)
return "completed"

// Review imports the declaration, not the Develop implementation.
import { devArtifact } from "../develop/artifacts"

[development] = readInputArtifacts(devArtifact)
// Perform review using development and other declared inputs.
writeOutputArtifact(reviewArtifact, reviewOutput)
return reviewOutcome
```

Reads and writes finish before execution continues. Required inputs must exist and conform to their
declared content type; a missing or invalid required input is an action failure. An optional input's
absence and meaning are defined by the consuming action. No input is silently replaced with guessed data.

Imports expose producer–consumer data dependencies. They do not make actions call one another or
restrict the workflow to immediate producer–consumer transitions: intervening actions may run, and
an action may consume several producers' outputs.

## Execution

Read inputs, perform the operation, finish writing the outputs required by the outcome, then return
that outcome. Workflow transitions choose the next action. Events report activity without selecting
the next state.

Actions own their business decisions, agent output interpretation and external effects. They may
execute again after interruption and decide whether existing work can be reused. Detailed results
are artifacts; the returned outcome is only the workflow's transition key.

A declared failure outcome emits its reason through the action's event publisher and preserves any
output defined for that outcome. Unexpected invocation, provider or storage failures remain execution
errors. Neither form is silently treated as successful work.

After finishing the outputs required by its returned outcome, an action publishes the
[action outcome event](../architecture.md#action-outcome-events) referencing the saved file. An
outcome that saves no output publishes no outcome event. An invocation that reuses an output an
earlier invocation saved publishes the same reference; an action never names a file that was not
saved.

## Inputs before a round exists

[SelectWork](select-task.md#output) owns selection.json beside the queue's workflow-state file.
[PrepareWorkspace](prepare-workspace.md#output) owns state/prepared-workspace.json in the selected
ticket's workspace. Consumers import these record declarations and read them directly; they are not
resolved through the current-round helper. [StartDevRound](start-dev-round.md#output) owns the current-round
record and the developer profile and reason in its round plan.

Application binds the selection-file location to the actions that need it. Each invocation reads the
current selection to obtain its task workspace; it does not retain another ticket's workspace between
calls. The runner's configured state filepath stays fixed for the queue and the runner does not read
the selection. Each ticket retains its own worktree and round history across queue runs.

## Repeated rounds

Each round has a separate directory. Producers write their declared paths within that directory;
consumers read the same paths within the current round. A missing current-round output cannot be
mistaken for an earlier round's result.

Earlier directories preserve previous exchanges without producers archiving their outputs. Actions
that need earlier findings or conversation use those directories explicitly as history when assembling
context; ordinary input reads remain scoped to the current round.

Workflow sequencing starts the initial round before implementation and routes each same-revision
repair trigger back to StartDevRound. That action either opens another planned round or reports
exhaustion; the round policy is part of StartDevRound, not a separate action or planner. Within a round,
actions finish writing their outputs before returning. Workflow definitions contain states and
transitions, not artifact paths or mappings.

## Idea refinement actions

The [idea refinement specification](../../idea-refinement/spec.md) owns its action sequence and
workflow-specific artifacts. These actions follow the same producer-owned output and named-outcome
principles, but use cycle/revision paths rather than finite delivery's current-round helper.
Researcher and Project guide write distinct paths so concurrent invocations do not share writable
output. The Idea editor consumes their contributions and responds to the Challenger through revision,
answers, rebuttals or focused requests. Challenger results bind to the exact refined idea revision
and editor response assessed. Actions persist those outputs and return typed outcomes; XState routes
them and enforces the cycle limit. Source updates belong to explicit publication actions.

## Terminal experience handoffs

Every workflow invokes the shared [AnalyzeExperience](analyze-experience.md) action after terminal
handoffs for selected work, on success and failure paths, before the next selection, final return or
recovery. The action receives a generic handoff and producer-owned evidence; it has no task-source
API. Preserve the original outcome and destination even when learning is skipped or unavailable.
Intermediate retries and empty selection are not experience handoffs. The action contract owns
background durability and the exclusive automatic Memory dependency; agents retain explicit MCP.

## Parent and child source boundary

The [project workflow](../../project-workflow.md) owns Jira access and stage handoffs. Selection is
parent-owned. Stage/finite business actions receive captured source input, not Jira adapters.
Parent-owned input/publication actors can be supplied at explicit child boundaries; they own source
effects and return data/acknowledgement. Internal revision/repair decisions stay with children.
Consumers import producer-owned output declarations and schemas.

Preparation areas retain applicability decisions, round history and accepted output references.
Skips are evaluated and saved. The parent consumes current results for publication/routing.
Original preparation completion and implementation completion require their distinct evidence.

## Retained finite entry

RouteDeliveryEntry imports the selected workspace, current-round declaration and development,
verification and delivery artifacts. After PrepareWorkspace, it routes a new child admission to the
first unfinished phase: round planning for missing/failed development or failed verification,
verification for completed development, delivery for matching passed verification, or retained
publication/review for an already-delivered revision. It validates task and revision identity and
writes no artifact. Restoring an active child uses its saved checkpoint instead of this entry route.
