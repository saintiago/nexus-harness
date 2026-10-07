# Preparation stage actions

## Responsibility and interface

Requirements, UX Proposal, Storybook Refinement and Architecture each own their author/evaluator
loop and result artifacts. Their acceptance boundaries belong to the
[project workflow](../../project-workflow.md). Invoke roles through
[AgentRuntime](../../agent-runtime/architecture.md#provided-interface), using the
[preparation role instructions](../../agent-runtime/preparation-roles.md).

Inputs are the parent-selected source snapshot and attributed conversation, the shared repository
[WorkspaceRef](../../workspace.md#layout-and-reference), producer-owned upstream references and any
return finding. The stage's artifact area is separate from that repository reference. Use the
[Git adapter](../../adapters/git.md#interface) for repository observations and path-scoped commits.
Existing authoritative documents can supply an earlier stage's input without a mandatory citation list.
No stage action receives Jira credentials. Consumers import these declarations rather than restating
stage output schemas.

### Shared repository output

PrepareStage creates or reuses one checkout on a non-base preparation branch. It owns
`parent/prepared-repository.json` in the preparation issue workspace:

```ts
type PreparationWorkspace = {
  repository: string;
  repositoryWorkspace: WorkspaceRef;
  branch: string;
  baseRevision: string;
};
```

The comparison base is the configured base revision from which preparation started. Inspect the
actual repository, branch and saved identity on every entry. Create missing work only before a
retained repository exists. Preserve local work; a missing retained checkout or incompatible identity
requests attention instead of silently cloning, resetting or selecting another stage branch.
Idea refinement keeps its separate repository. Preparation-stage entry never creates a stage checkout.

### Result output

```ts
type PreparationResult = {
  stage: 'requirements' | 'ux' | 'prototype' | 'architecture';
  outcome: 'accepted' | 'skipped' | 'returnUpstream' | 'needsInput' | 'exhausted';
  authoredRevision: number;
  outputs: ArtifactRef[];
  evaluation: ArtifactRef;
  reason: string | null; // action-observed failure/exhaustion only; assessment is in Markdown
  returnStage: 'idea' | 'requirements' | 'ux' | 'prototype' | null;
};
```

This envelope keeps references; producing declarations also retain authored-work declarations,
optional applicability evidence, implementation plan and prototype observations when applicable.
Changed-path declarations support committing authored work, not assessment coverage.
Allowed return destinations are earlier stages in the route. Accepted and skipped results require the evaluator's current decision;
provider/storage failures remain execution faults. Repository conditions can prevent preparation with
an attributable retained failure reason.

The operations export one runtime-validated declaration for each persisted record. The evaluation
owns its acceptance basis, observed by the action rather than trusted from an agent:

```ts
type AcceptanceBasis = {
  author: ArtifactRef;
  authorIdentity: string;
  sourceIdentity: string;
  upstream: { result: ArtifactRef; identity: string }[];
  repositoryRevision?: string; // action-observed; absent only on former saved records
};
```

Identities bind complete saved reports or captured source input, including attributed conversation.
Publication acknowledgements do not themselves replace that captured input. Refreshed human input
must be reconciled before reuse. Repository paths used to commit authored work are canonical
checkout-relative paths. A declaration may name a deletion when the path was tracked before the
author invocation or the stage's retained authored declarations already recorded that deletion.
Browser observations do not supply path ownership or per-file deletion evidence. This permits
stage-owned cleanup and replay without manufacturing a replacement document. Observed repository
revisions remain attributable in the retained repository. Result references
identify the evaluator decision carrying this basis; a stage name or round number alone is insufficient.

## Round storage and acceptance

Each stage area owns `state/current-round.json`, `state/result.json` and numbered
`artifacts/<round>/` containing author.json, evaluation.json and result.json. The plan records selected
profiles and why the round opened. Cumulative round and return allowances survive re-entry/restart.
A terminal exhaustion record does not replace an earlier completed round. The current terminal record,
not a search through old acceptances, determines whether the stage can advance.

### Role response contracts

Author and evaluator responses omit action-added metadata and narrative. StageAuthor adds stage,
authored revision, observed task identity, role/profile and ReportBinding; StageEvaluator adds those
identities, the assessed author revision, ReportBinding and its observed acceptance basis. Use the
[action report contract](architecture.md#markdown-reports-and-machine-outcomes). Result/plan
persistence stays with stage operations. Context assigns separate author/evaluator Markdown paths
and reserves `author.json`, `evaluation.json`, `result.json`, `plan.json` and state records.

```ts
type StageAuthorResponse = {
  outcome: 'authored' | 'skip-proposed' | 'needs-input' | 'return-upstream';
  documents: { path: string }[];
  sourcePaths: string[];
  observation: ArtifactRef | null;
  plan: PlannedTask[];
  skip: { references: string[] } | null;
  question: string | null;
  upstream: UpstreamRequest | null;
};

type StageEvaluationResponse = {
  verdict: 'accepted' | 'accepted-skip' | 'changes-requested' | 'return-upstream';
  observation: ArtifactRef | null;
  upstream: UpstreamRequest | null;
};

type UpstreamRequest = {
  stage: 'idea' | 'requirements' | 'ux' | 'prototype';
  correction: string; // concrete input correction handed to the earlier stage
};
```

Assessment narrative follows the [findings guidance](findings.md); no Finding schema is imported.
PlannedTask has the summary, scope, completion criteria and prerequisite indices defined under
Implementation plan below. Define each response and saved record once in its preparation-owned
schema and derive its TypeScript type and provider response format.

`authored` submits work for direct evaluation; it does not require this invocation to change a file.
For unchanged adequate documents, `documents` and `sourcePaths` may both be empty. They declare
changed authoritative documents and stage-owned sources, never reading citations. Non-authored
outcomes carry empty arrays. Only Architecture supplies a nonempty plan for authored work or a
proposed applicability skip; other stages and outcomes carry an empty plan. Only Prototype declares
an observation, under the rules below. A question or upstream request accompanies only its matching
outcome. The assigned Markdown explains changes and declaration reasons, answers to earlier
assessments, disagreements and remaining problems. The outcome contains no summary or
finding-response array.

A skip proposes stage inapplicability, not existing-document adequacy or historical approval reuse.
Its Markdown must explain inapplicability; optional references remain functional evidence and may be
empty. The action validates the references, not the prose explanation. Only a skip proposal carries
`skip`, and only a normally evaluated skip receives `accepted-skip`. An authored submission receives
`accepted`, even with no changed documents. Incompatible outcome/verdict pairs remain invalid. An
applicable prototype uses current work and observation, not a reuse skip. A repair round may propose
an applicability skip when corrected scope makes the stage irrelevant; evaluation decides that
applicability. Existing authored cleanup and applicability reassessment preserve obsolete-work
reconciliation; a skip cannot commit or silently discard stage-owned work.

Accepted and accepted-skip apply the [bounded material-quality
standard](../../agent-runtime/preparation-roles.md#bounded-material-quality) and require no known
material issue; changes-requested requires at least one, explained in Markdown. Remaining
suggestions explain why they are nonblocking. These are evaluator judgment obligations, not
machine finding-count checks. Return-upstream requires a concrete UpstreamRequest to an allowed earlier stage. Validate
outcome/verdict pairing, destination, correction, role-specific fields, plan and applicable
evidence; do not parse narrative to verify the verdict. There are no finding IDs, response/status
records, dispositions or matching checks across rounds. `assessedRevision` is action-observed saved
metadata, not a claim returned by the evaluator.

Use the [report rejection contract](architecture.md#rejection-evidence-and-continuation) in each
stage area. The responsible role receives outstanding feedback after recovery or reselection.
Retained author/evaluator reads preserve malformed outcome bytes and recover available Markdown
references as producer-attributed rejection evidence before parsing failures propagate or route stale,
including round opening, finalization, replay, downstream decisions and publication.
Repaired history alone does not retire feedback; validate and record a usable replacement as its
correction. Rejection and correction grant no acceptance or extra allowance.

### Current-worktree evaluation

The [project workflow
requirements](../../project-workflow.md#current-worktree-evaluation-requirements) own document-stage
acceptance, compatible shared-document edits, retained continuation and examples. Requirements,
UX/UI and Architecture assess the ticket against current authoritative documents in the shared
worktree, regardless of authorship or commit history. Prototype evaluation follows the
[prototype assessment requirements](../../project-workflow.md#prototype-assessment-requirements):
inspect the current worktree and preview against ticket scope, without treating changed-path
declarations as assessment coverage. Context follows the [preparation prompt
outcomes](../../agent-runtime/preparation-roles.md#preparation-prompt-outcomes): readable captured
scope and attributed feedback, directly available current corrections, and accessible references
to upstream artifacts and historical reports. The current author Markdown and functional outcome/plan
remain inspectable. Preserve repository guidance without duplicating runtime-supplied instructions.
The evaluator inspects relevant existing documents itself; an empty changed-document list does not restrict its scope or prevent
invocation. Architecture also evaluates the current implementation plan.

Before evaluation, commit declared documents and applicable prototype sources in the shared
checkout. Named commits exclude unrelated staged work. The evaluator does not edit tracked work.
Capture the current author identity, source identity, upstream result identities and repository
revision before invocation. For a fresh decision and interrupted finalization, require those inputs,
their associated report bytes and the repository revision to remain unchanged through result
persistence, with declared stage work still committed and applicable browser evidence readable.
Preserve unrelated retained work; do not turn this into a worktree-wide readiness rule. Build caches
and untracked diagnostic output do not constitute changed assessed work. A changed assessment basis
requires normal reevaluation rather than binding an old report to current bytes.

This repository observation is a short-lived finalization check, not a document-citation or dependency
engine. No stage writes per-file acceptance content or observation bindings. Once a stage advances,
compatible later-stage document commits or upstream report replacements do not mechanically
invalidate its completed verdict.
Downstream decision reads check the completed report association and captured human intent, explicit
pending corrections and applicable prototype evidence. They do not compare completed document
approvals with historical file revisions or demand renewed approval of an unchanged document.
Architecture acceptance returns directly to handoff; there is no combined preparation publication.

### Prompt context and evidence

Assemble a common preparation context for all authors and evaluators. After the selected profile's
role purpose, outcome and specific standards, order it as follows:

1. Shared material-quality, applicability, scope, ownership and coherence guidance.
2. Readable captured task intent and attributed conversation, followed by active correction context.
3. Worktree location, repository-instruction paths, accepted upstream and local history references,
   and the current work to assess. Reassessment states that an earlier decision is pending and
   identifies the changed input; it cannot confer acceptance.
4. Reporting mechanics: the assigned Markdown path, action-owned paths, applicable declaration and
   observation rules, and the minimal response contract. Prototype observation details belong here,
   only for the prototype roles. Include each rule once, rather than repeating shared reporting
   instructions in the author/evaluator suffixes.

Generic runtime instructions retain their existing precedence. Preparation's work and quality
guidance precedes its reporting mechanics in every route and selectable profile.

#### Readable captured source

Render the captured summary, description and conversation deterministically as readable text.
Preserve expressed scope, exclusions, acceptance conditions, questions, disagreements, links and
evidence paths. Keep the description's meaningful structure; do not invent exclusions, resolve
conflicting statements or shorten content by dropping qualifications. Render rich-text paragraphs,
headings, lists, links, code, tables and other meaningful nodes without their administrative JSON.
Other captured fields carrying task instructions or evidence also receive readable text or an
explicit inspection reference; omission applies to administrative data, not arbitrary task content.
Give non-text evidence a readable reference. For an unsupported meaningful structure, explicitly
identify the unrendered content and its source location and require inspection before relying on
it; never silently discard it or present an incomplete rendering as complete intent.

Attribute each comment by captured author and source comment identity, preserving captured order
and available chronology. Mark known Nexus publication acknowledgements using the parent's saved
publication identities, rather than promoting them to human decisions or omitting them silently.
Bot attribution, missing authorship and uncertain origin remain explicit; an owner's account name
alone cannot establish that a publication was human feedback. Agents distinguish human direction
from assessments using this attribution and source evidence. Administrative API envelopes, avatars,
watchers, status bookkeeping and time tracking do not enter the readable context.

Before invocation, retain the exact `{ issue, conversation }` used for this context in
`captured-source.json` beside the invocation's assigned Markdown report, and supply its absolute
path. This action-owned evidence copy is not a new role response, control record or source of
decisions. It remains available after reselection changes the parent snapshot. Write it from the
same captured values used by the existing source-identity check; never query Jira or derive the
identity from rendered text. Leave retained copies unchanged in later invocations. Failure to retain
readable source evidence is an execution fault.

#### References and active corrections

Give upstream results and retained author/evaluator records accessible absolute paths, with stage,
role, round, revision or assessed revision, and outcome/verdict attribution where recorded. Include
their Markdown paths when bound, and the stage history directory for further evidence. The current
author record, report, declarations and Architecture plan are read through these references, not
embedded in full. Legacy combined records remain readable at their original paths without rewriting
them. Validate referenced current, upstream and repair records through existing producer-owned
readers and report bindings; switching presentation to paths does not bypass report usability,
source association, revision checks or producer-attributed rejection retention.
An accepted or skipped upstream result requires its producing author and evaluator records before
consumer invocation. Missing required records use the producing role's rejection handling; absent
upstream stages remain legitimate, and retained legacy combined records need no Markdown binding.

Active correction context is distinct from supporting history. Include the retained human question
and captured answer/feedback, the upstream request's concrete correction, outstanding report
rejection reasons and evidence references, and the latest still-relevant evaluator assessment
directly. For a bound upstream return, validate and include the returning assessment alongside its
functional correction; legacy returns retain their problem and consequence text. For a
changes-requested assessment, or a return-upstream assessment whose correction is pending, include
its validated Markdown as active concerns, preserving problem, consequence, correction, optional
suggestions and uncertainty. Use the original narrative rather
than extracting a machine finding set or generating a lossy summary. Accepted assessments are
supporting references, not active demands for optional improvements.

Find the most recent preceding evaluation across intervening author-only rounds. A return, question,
restart or `new` route label does not clear its concerns. Provide relevant intervening author reports
as attributed references, explicitly requiring inspection of their corrections and disagreements.
An evaluator supplies a complete account of material concerns that remain in the assessed work,
including earlier concerns it judges unresolved. A subsequent current evaluation supersedes the
earlier assessment for this purpose; no program parses Markdown to infer resolution. Explicit
pending upstream routes and outstanding rejection feedback retain their existing clearing rules.
Reassessment against changed input still requires a fresh judgment even after an earlier acceptance.

There is no prompt-size cutoff for active concerns and no narrative parser, summary service, new
finding schema or lifecycle store. Historical bodies are referenced; a report still carrying an
active correction is included because a path alone would hide the repair obligation. Evidence and
allowances remain in their existing stores. Missing or changed bound evidence uses existing
attributable rejection handling, never acceptance, a manufactured skip or an upstream product rule.

#### Repository instructions and verification

Reference the connected worktree's `AGENTS.md` and require applicable repository instructions to be
followed. Do not embed its contents. When the provider supplies those instructions natively, this
path adds no duplicate body; otherwise the role reads applicable instruction files before work.
Keep nested applicable instructions and the repository file intact. Linked design documents are
evidence to consult, not additional role instructions. This uses file access already required for
preparation and needs no provider-detection flag or new runtime capability.

Verify actual assembled invocations through application profile composition and AgentRuntime to the
coding-provider request, covering all eight roles and relevant profile reuse/variants. Check order,
single guidance delivery, source meaning and attribution, readable references, and directly present
active corrections. Exercise response, reassessment, upstream-return, author-only question/return,
restart and rejection continuation with controlled evidence. Both native instruction delivery and
explicit file-reading must preserve repository guidance without preparation embedding another copy.
Keep existing report-integrity, source/revision, prototype observation, current-worktree evaluation
and finite allowance regressions; shorter prompts alone are not acceptance evidence.

### Applicability references and retained data

Optional references support a skip reason but do not select historical approvals or owned assets.
Use the existing shared reference resolver for supplied relative paths, absolute in-checkout paths
and section citations; canonicalize repository paths consistently. An outside retained file is
attributed evidence, not a repository path. Supplied references must be readable when assessing the
proposal; unreadable supplied references are invalid evidence, while an empty reference list is
valid. Completed document decisions do not depend on subsequent citation changes. No
`existingDocuments` binding or historical content comparison is created for these citations. Keep the delivered resolver behavior
where references remain supported, without restoring mandatory citations.

Results retain authored-work declarations, optional skip references and the current evaluator
reference. Changed-path handling serves authored-work commits, not evidence scope or validity.
Results do not create `existingDocuments` or infer reused documents from earlier result files. Implementation handoff links the evaluated
results and plan and can name changed documents and optional evidence without requiring citations
for unchanged adequate documents. The retained checkout carries accumulated work into implementation.

For an applicable prototype, preserve its work in the shared checkout and both roles' browser
observations as readable artifacts under the rules below, without assessed-file inventories or
per-file content bindings. Previously built sources are ordinary current work; historical approval
does not select or authorize a new assessment. A new applicable assessment inspects the current
preview and records current observations. Completed evidence remains attributable history; concrete
changes that undermine its adequacy require normal reassessment, without per-file comparisons.

## Correction and continuation

An upstream return retains its correction and owning earlier stage in the functional outcome, and
its problem and consequence in the returning role's Markdown report. The return record references
the returning stage, the destination stage, the returning role, the concrete correction and that
role's saved report binding, producing outcome reference and observed profile. Rejection handling
retains the outcome's raw bytes separately from the Markdown copy and uses the producing invocation,
including when a later invocation reads repair context. The role and complete binding are required
together; their omission cannot reclassify a current return as legacy. Unbound legacy and action-generated corrections
require their problem and consequence text. The result's destination must match its correction.
Finalization, replay, publication and destination context loading resolve the report
through that producer-owned binding: a missing or changed report is preserved as the returning
role's rejection evidence and the correction cannot proceed, so replacement bytes never stand in
for the assessment the return cites. The parent records the destination and downstream stages
awaiting reassessment before advancing source state; this pending route survives restart. The
destination corrects its work in the shared checkout. Idea correction changes its input artifacts
without replacing that checkout.

Proceed through pending stages in order. Each uses current input and work and obtains a current
assessment, preserving adequate content and repairing affected content. Do not manufacture edits,
existing-document skips or approval-reuse proposals to reenter a document stage. No semantic
dependency engine or extra reviewer is required. Before handoff, require completed evaluator
decisions for the captured ticket, clear explicit pending corrections and validate applicable
prototype evidence. Return upstream for a concrete input defect, not a compatible shared-document
edit. Changed human intent, missing/corrupt reports or concrete prototype changes that undermine
prior assessment require normal reassessment. Do not infer evidence validity from file inventories.

Re-entry supplies previous author/evaluator reports through readable, attributed local history
references. Current upstream requests, unresolved findings and rejection feedback remain directly
available, including after an author-only return or input request; their full supporting evidence
remains accessible. No traversal derives an unresolved ID set or waits for disposition records. The
next evaluator judges whether previous concerns remain and reports actionable current findings.
A missing later evaluation is not an implicit resolution or acceptance. Current terminal records
and pending routes govern advancement; do not search past an intervening unfinished or invalid round
for an older approval. Preserve cumulative round and return allowances.

### Retained-record compatibility

New responses are strict and omit removed lifecycle fields. Producer-owned saved-record readers
accept former IDs, response/disposition arrays, `existingDocuments` and prior acceptance-basis
fields, including former prototype per-file content, as retained data without enforcing removed
matching, citation-reuse or observation scope/content rules. Preserve
original reports byte-for-byte and supply readable references so their full evidence remains
available. Reading a simplified typed view must not change the complete recorded identity used to
associate an author with its evaluation or retire rejection feedback. Required control/functional
fields, outcome/verdict pairing, the verdict's upstream destination/correction pairing, source
association and applicable observation validity still receive validation from the producer-owned
retained-decision reader. Every retained evaluation read enforces verdict/upstream pairing, including
return and repair context reads, rather than checking acceptance alone. New outcomes require their Markdown binding;
legacy combined records stay readable without a retroactive Markdown requirement or finding-list
checks. Acceptance and author questions validate their producing reports at finalization, completed
replay and publication. Validate bound reports before author/evaluation, revision or input association
checks can short-circuit rejection retention, including the author reread after evaluator invocation;
valid changed inputs still follow ordinary stale routing or reevaluation.
Report failures retain the available outcome/report and producer-attributed
rejection before failing or marking a completed decision stale; recovery cannot lose the correction
obligation by repairing the old artifact alone.

Completed document-stage decisions can continue under these association and routing checks, without
retroactive citation bindings or new report fields. An unfinished legacy evaluation that lacks
the fresh repository observation receives normal reevaluation before finalization; never
invent that observation from later content. Legacy results carrying an applicable prototype still
require readable browser assessment and screenshots even when their saved outcome was skipped,
without requiring or reconstructing per-file inventories or bindings. New
inapplicability skips retain no applicable prototype bundle.

Reassessment writes a new decision and preserves historical author reports, evaluations, results
and observations. An interrupted new finalization can resume its saved checkpoint when its current
basis remains valid; otherwise use normal reassessment. Neither continuation nor schema compatibility
resets allowances, replaces the checkout or branch, manufactures approval or introduces a retry
mechanism. Installation activation follows [Application](../../application.md#installation-activation)
after active runtime users exit; preparation owns no runtime switch or checkpoint reset.

## Prototype observations

Both prototype roles use a running preview with real browser interaction and image/layout inspection.
Each role's report references its own saved observation record under its round's artifacts. The record
identifies role, preview/start command and URL, relevant journeys/states, actions, observed results,
screenshots and visual conclusions. Nexus observes task/profile/revision/report attribution; the
agent does not inventory assessed files or bind observations to individual file revisions. An image
path or a claimed successful build alone is insufficient. Screenshots must fully decode as PNG, JPEG, GIF or
WebP; format headers alone do not establish readable rendered pixels. The evaluator checks that both roles' evidence exists,
is readable and adequately addresses applicable acceptance examples and UX questions against the
current worktree and preview. These are assessment judgments, not file-list/content comparisons. Agent observations remain attributed evidence, not machine proof of usability.

Apply the [product-grounded UI guidance](../../agent-runtime/preparation-roles.md#product-grounded-ui-work)
when judging the rendered experience. The evaluator's record describes its independent inspection;
the author's evidence cannot substitute for it. Use existing actions and observed results to record
applicable motion exercised in the live preview, and visual conclusions for rendered-image
inspection. The assigned Markdown assessment relates concrete observations to product intent and
intended users. No additional observation fields or machine design-quality validation are required.

The prototype author response declares its source paths and observation ArtifactRef; the evaluator
response declares its separate observation ArtifactRef. Other stage responses and evaluated skips
carry null. The prototype result retains both observation references for downstream consumers.
Any result retaining an applicable prototype, including a legacy result saved as a reuse skip,
requires both roles' readable browser evidence even when its saved observation references are empty
or absent. Former per-file fields cannot gate continuation or substitute for actual evidence.
Finalization, replay and downstream current-decision checks validate these records and screenshots. Only a genuinely
non-applicable skip with no retained prototype is exempt.
These fields belong to the preparation response declarations, with the normal strict
structured-output/nullability rules. Observation records use one producer-owned runtime schema:

```ts
type PrototypeObservation = {
  role: 'author' | 'evaluator';
  preview: { command: string; url: string };
  journeys: {
    example: string;
    state: string;
    actions: string[];
    observed: string;
    screenshots: ArtifactRef[];
    visualConclusion: string;
  }[];
};
```

Applicable observations require exercised journeys, assessment of the relevant examples,
and readable rendered-image evidence. No assessed-file inventory or per-file revision is required.
Keep preview output/browser diagnostics with the observation when they explain a failure. Store screenshots and reports in the role's round artifact area,
without committing execution evidence into product documentation.

Interaction or layout defects become normal findings for repair, or a concrete upstream return when
an earlier input is wrong. A defect report or upstream return keeps the observation of the preview it
performed, so the observed evidence reaches the repair handoff; an evaluated applicability skip
carries none. Prototype repairs receive fresh author and evaluator inspection. Later decisions
use the existing correction and reassessment routes when evidence no longer supports the requested
outcome; per-file revision or content comparisons do not decide that adequacy. Missing/unusable
evidence cannot produce acceptance. Preview defects are repaired by the author; unavailable browser/image capability or invocation faults follow execution recovery, without
an invented skip, product requirement or verdict. An evaluated non-applicable prototype needs no
preview evidence. Tool installation belongs to the [profile setup](../../agent-runtime/profiles.md).

## Implementation plan

Architecture produces one or more bounded tasks with summary, scope, completion criteria and
zero-based prerequisite indices. Its evaluator checks outcome coverage, size, duplication and a valid
acyclic graph. Existing technical design meeting the bounded material-quality standard receives
direct acceptance while this plan still receives evaluation. Source issue creation, links and
ranking stay outside stage roles. The first
implementation continues the shared checkout; prototype references remain available to all planned tasks. Preparation
has no documentation assembly, documentation-only PR, repository reviewer or merge/check state.
