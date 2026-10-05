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

The shared report helpers own this association declaration and byte-level operations:

```ts
type ReportBinding = {
  report: ArtifactRef;
  reportIdentity: string; // SHA-256 of the report's exact UTF-8 bytes
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
nonempty-prose or JSON rules. Compute its identity and check the owner's existing input/revision
rules before saving the outcome. A saved new outcome is usable only with its associated readable
report and matching identity. Do not infer status, verdict, findings or routing from report prose.
The hash associates bytes; it proves neither their claims nor assessment quality.

Persist the outcome only after these checks. Retained invocation context records the assigned path,
identity and current inputs with existing invocation evidence. An interrupted save can finish only
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

New saved-outcome readers require ReportBinding. Producer-owned compatibility readers separately
accept former combined artifacts with their former required narrative and identity fields. A record
with any new binding field must satisfy the new schema; a damaged new record cannot fall back to
legacy parsing. Retain legacy bytes without adding report paths or rewriting them into Markdown.
Provide the original combined artifact as readable historical context. Existing usable completed
legacy outcomes can continue only under their original input/revision/evidence protections; no new
Markdown requirement is imposed retroactively. Legacy findings may remain readable fields but no
longer require machine consistency or lifecycle validation.

### Rejection evidence and continuation

Report rejection is distinct from a valid negative business report and from an invocation that
returned no output. Preserve the exact returned bytes, the specific violated rule and attributable
context before raising the existing execution error. A malformed saved record retains its readable
bytes and path; it does not become a usable producer artifact. When output is unavailable, record
null and explain why. Do not manufacture a report from activity messages or guessed metadata.

The report helpers own one runtime-validated rejection and correction declaration, exposed for
consumers through the TaskEngine data interface. The validating caller owns each evidence write;
the responsible report producer owns validation of the replacement. The boundary values are:

```ts
type ReportScope = {
  project: string;
  workId: string;
  area: string; // absolute owning area, independent of the repository checkout
  role: string;
  reportKind: string; // distinguishes incompatible response contracts of one role
};
type ReportRejection = {
  kind: 'rejection';
  scope: ReportScope;
  invocationId: string | null; // null only when importing unattributed retained evidence
  operation: string;
  profile: string | null;
  context: string; // original round/cycle/request and relevant revision attribution
  source: ArtifactRef | null; // malformed saved record, when applicable
  output: string | null;
  reason: string;
  report: ArtifactRef | null; // immutable copy of available rejected Markdown
  assignedReport: ArtifactRef | null; // attempted path, even when unreadable/missing
};
type ReportCorrection = {
  kind: 'correction';
  scope: ReportScope;
  rejections: ArtifactRef[];
  artifact: ArtifactRef; // usable replacement report, not approval of its claims
  artifactIdentity: string; // complete saved outcome, including its report binding
  invocationId: string | null;
};
```

Copy available rejected Markdown byte-for-byte into the feedback area before raising the error,
alongside exact returned outcome bytes and the original violated rule. Missing/unreadable Markdown
remains explicitly unavailable, with its attempted path retained; do not synthesize it from
activity. Former feedback records lacking Markdown references remain readable as retained evidence.

Store immutable rejection and correction records under the owning area's
`report-feedback/<record-id>.json`, using unique record IDs. Derive outstanding feedback from
rejections without a valid matching correction; no separately persisted pending pointer is needed.
A correction references the exact rejection records it resolves. The owner validates and saves
the replacement before recording its complete identity and those references. Readers validate the
correction declaration and matching scope, rather than inferring correction from a file's existence.
Later disposal of delivery artifacts does not reopen a recorded correction. It is evidence of report
usability, not stage acceptance, review approval or task completion.

Preparation uses its stage area, idea refinement its refinement area, and finite delivery the
selected implementation issue root even when its repository belongs to a preparation issue. The
feedback directory is outside disposable delivery `state/` and `artifacts/`. Analysis uses its
durable request area and recovery its stable project recovery area, retaining their existing failure
policies. Parallel roles have independent invocation identities and evidence writes.

Before the next responsible invocation, load outstanding feedback matching project, work, owning
area, role and report kind. Include the rejection reason, original invocation/context attribution
and readable rejected outcome and Markdown references in context, labelled as rejected historical
evidence. Current input, current response rules and finding obligations remain authoritative. Match
the logical report responsibility across round advancement, profile changes, worker exit and
reselection; do not require the old round, branch or profile to equal the new one. Incompatible
variants and other roles/items do not inherit it. A correction retires the records it addresses,
preserving their history; a later rejection remains outstanding independently.

Resolve feedback only after the owner validates and saves the usable replacement. Replay can finish
recording a correction without another invocation only when retained evidence attributes the
replacement to an owner invocation supplied with those rejections. Mere reuse or a recovery-edited
historical artifact is insufficient. Otherwise feedback remains for the next permitted invocation.
Missing or unusable evidence is an explicit error, never an empty feedback set. A failed
evidence write reports both the original rejection and persistence failure, and grants no acceptance.
Report-evidence helpers add no invocation, allowance, route, escalation or retry policy. Existing
recovery, round planning and gates decide whether another invocation is permitted.

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
