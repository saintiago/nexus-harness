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

This envelope keeps references; producing declarations also retain changed document revisions,
optional applicability evidence, implementation plan and prototype observations when applicable.
Allowed return destinations are earlier stages in the route. Accepted and skipped results require the evaluator's current decision;
provider/storage failures remain execution faults. Repository conditions can prevent preparation with
an attributable retained failure reason.

The operations export one runtime-validated declaration for each persisted record. The evaluation
owns its acceptance basis, observed by the action rather than trusted from an agent:

```ts
type AssessedContent = { path: string; revision: string; exists: boolean };
type AcceptanceBasis = {
  author: ArtifactRef;
  authorIdentity: string;
  sourceIdentity: string;
  upstream: { result: ArtifactRef; identity: string }[];
  repositoryRevision?: string; // action-observed; absent only on former saved records
  content: AssessedContent[]; // applicable prototype content; empty for document stages
};
```

Identities bind complete saved reports or captured source input, including attributed conversation.
Publication acknowledgements do not themselves replace that captured input. Refreshed human input
must be reconciled before reuse. Repository paths are canonical checkout-relative paths; a deleted
file is represented by exists=false at its observed commit. A declaration may name a deletion when
the path was tracked before the author invocation or the stage's retained authored declarations
already recorded that deletion. A validated author observation and a former evaluation's assessed
content remain additional ownership evidence for records written before document bindings were
removed. An observation naming an ancestral deletion commit establishes absence, not ownership by
the declaring stage. This permits stage-owned cleanup and replay without manufacturing a replacement
document. Revisions must remain readable in the retained repository. Result references
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

Accepted and accepted-skip require no current blocking problem; changes-requested requires at least
one, explained in Markdown. These are evaluator judgment obligations, not machine finding-count
checks. Return-upstream requires a concrete UpstreamRequest to an allowed earlier stage. Validate
outcome/verdict pairing, destination, correction, role-specific fields, plan and applicable
evidence; do not parse narrative to verify the verdict. There are no finding IDs, response/status
records, dispositions or matching checks across rounds. `assessedRevision` is action-observed saved
metadata, not a claim returned by the evaluator.

Use the [report rejection contract](architecture.md#rejection-evidence-and-continuation) in each
stage area. The responsible role receives outstanding feedback after recovery or reselection.
Repaired history alone does not retire feedback; validate and record a usable replacement as its
correction. Rejection and correction grant no acceptance or extra allowance.

### Current-worktree evaluation

The [project workflow
requirements](../../project-workflow.md#current-worktree-evaluation-requirements) own document-stage
acceptance, compatible shared-document edits, retained continuation and examples. Requirements,
UX/UI and Architecture assess the ticket against current authoritative documents in the shared
worktree, regardless of authorship or commit history. Context supplies the ticket, attributed
conversation, upstream reports, current author Markdown and functional outcome/plan, repository
instructions and readable previous author/evaluation reports. The evaluator inspects relevant
existing documents itself; an empty changed-document list does not restrict its scope or prevent
invocation. Architecture also evaluates the current implementation plan.

Before evaluation, commit declared documents and applicable prototype sources in the shared
checkout. Named commits exclude unrelated staged work. The evaluator does not edit tracked work.
Capture the current author identity, source identity, upstream result identities and repository
revision before invocation. For a fresh decision and interrupted finalization, require those inputs,
their associated report bytes and the repository revision to remain unchanged through result
persistence, with declared stage work still committed and applicable prototype bindings valid.
Preserve unrelated retained work; do not turn this into a worktree-wide readiness rule. Build caches
and untracked diagnostic output do not constitute changed assessed work. A changed assessment basis
requires normal reevaluation rather than binding an old report to current bytes.

This repository observation is a short-lived finalization check, not a document-citation or dependency
engine. Document stages write no per-document acceptance bindings in `basis.content`; that field
retains applicable prototype content only. Once a stage advances, compatible later-stage document
commits or upstream report replacements do not mechanically invalidate its completed verdict.
Downstream decision reads check the completed report association and captured human intent, explicit
pending corrections and applicable prototype evidence. They do not compare completed document
approvals with historical file revisions or demand renewed approval of an unchanged document.
Architecture acceptance returns directly to handoff; there is no combined preparation publication.

### Applicability references and retained data

Optional references support a skip reason but do not select historical approvals or owned assets.
Use the existing shared reference resolver for supplied relative paths, absolute in-checkout paths
and section citations; canonicalize repository paths consistently. An outside retained file is
attributed evidence, not a repository path. Supplied references must be readable when assessing the
proposal; unreadable supplied references are invalid evidence, while an empty reference list is
valid. Completed document decisions do not depend on subsequent citation changes. No
`existingDocuments` binding or historical content comparison is created for these citations. Keep the delivered resolver behavior
where references remain supported, without restoring mandatory citations.

Results retain declared changed documents with their observed revision, stage-owned sources,
optional skip references and current evaluator reference. They do not create `existingDocuments`
or infer reused documents from earlier result files. Implementation handoff links the evaluated
results and plan and can name changed documents and optional evidence without requiring citations
for unchanged adequate documents. The retained checkout carries accumulated work into implementation.

For an applicable prototype, retain the complete assessed prototype sources, relevant input content
and both roles' observations under the rules below. Previously built sources are ordinary current
work; historical approval does not select or authorize them. A new applicable assessment inspects
the current preview and records current observations. Completed observation evidence remains usable
while its inspected content remains unchanged; an unrelated documentation commit alone does not
alter inspected prototype content.

## Correction and continuation

An upstream return retains its correction and owning earlier stage in the functional outcome, and
its problem and consequence in the returning role's Markdown report. The return record references
the returning stage, the destination stage, the concrete correction and that report; a former
combined return keeps its problem and consequence text as history. The parent records the
destination and downstream stages awaiting reassessment before advancing source state; this pending
route survives restart. The destination corrects its work in the shared checkout. Idea correction
changes its input artifacts without replacing that checkout.

Proceed through pending stages in order. Each uses current input and work and obtains a current
assessment, preserving adequate content and repairing affected content. Do not manufacture edits,
existing-document skips or approval-reuse proposals to reenter a document stage. No semantic
dependency engine or extra reviewer is required. Before handoff, require completed evaluator
decisions for the captured ticket, clear explicit pending corrections and validate applicable
prototype inspection. Return upstream for a concrete input defect, not a compatible shared-document
edit. Changed human intent, missing/corrupt reports or changed inspected prototype sources require
normal reassessment.

Re-entry supplies previous author/evaluator reports and any upstream request as complete narrative
context or readable local references, including the latest findings even after an author-only return
or input request. No traversal derives an unresolved ID set or waits for disposition records. The
next evaluator judges whether previous concerns remain and reports actionable current findings.
A missing later evaluation is not an implicit resolution or acceptance. Current terminal records
and pending routes govern advancement; do not search past an intervening unfinished or invalid round
for an older approval. Preserve cumulative round and return allowances.

### Retained-record compatibility

New responses are strict and omit removed lifecycle fields. Producer-owned saved-record readers
accept former IDs, response/disposition arrays, `existingDocuments` and prior acceptance-basis
fields as retained data without enforcing removed matching or citation-reuse rules. Preserve
original reports byte-for-byte and supply readable references so their full evidence remains
available. Reading a simplified typed view must not change the complete recorded identity used to
associate an author with its evaluation or retire rejection feedback. Required control/functional
fields, outcome/verdict pairing, source association and applicable observation validity still
receive validation. New outcomes require their Markdown binding; legacy combined records stay
readable without a retroactive Markdown requirement or finding-list checks.

Completed document-stage decisions can continue under these association and routing checks, without
retroactive citation bindings or new report fields. An unfinished legacy document evaluation that
lacks the fresh repository observation receives normal reevaluation before finalization; never
invent that observation from later content. Legacy results carrying an applicable prototype still
require complete valid prototype evidence even when their saved outcome was skipped. New
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
identifies role, prototype commit and inspected source paths, preview/start command and URL, relevant
journeys/states, actions, observed results, screenshots and visual conclusions. An image path or a
claimed successful build alone is insufficient. Screenshots must fully decode as PNG, JPEG, GIF or
WebP; format headers alone do not establish readable rendered pixels. The evaluator checks that both roles' evidence exists,
is readable, matches the assessed prototype content and covers applicable acceptance examples and UX
questions. Agent observations remain attributed evidence, not machine proof of usability.

The prototype author response declares its source paths and observation ArtifactRef; the evaluator
response declares its separate observation ArtifactRef. Other stage responses and evaluated skips
carry null. The prototype result retains both observation references for downstream consumers.
Any result retaining an applicable prototype, including a legacy result saved as a reuse skip,
requires both roles' readable, current evidence even when its saved observation references are empty
or absent. Finalization, replay
and downstream current-decision checks validate these records and screenshots. Only a genuinely
non-applicable skip with no retained prototype is exempt.
These fields belong to the preparation response declarations, with the normal strict
structured-output/nullability rules. Observation records use one producer-owned runtime schema:

```ts
type PrototypeObservation = {
  role: 'author' | 'evaluator';
  content: AssessedContent[];
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

Applicable observations require nonempty content and journeys, coverage of the relevant examples,
and readable rendered-image evidence. Keep preview output/browser diagnostics with the observation
when they explain a failure. Store screenshots and reports in the role's round artifact area,
without committing execution evidence into product documentation.

Interaction or layout defects become normal findings for repair, or a concrete upstream return when
an earlier input is wrong. A defect report or upstream return keeps the observation of the preview it
performed, so the observed evidence reaches the repair handoff; an evaluated applicability skip
carries none. Changed prototype content requires fresh author and evaluator observation.
An unrelated documentation commit can retain unchanged prototype content at its original observed
revision. Missing/unusable evidence cannot produce acceptance. Preview defects are repaired by the
author; unavailable browser/image capability or invocation faults follow execution recovery, without
an invented skip, product requirement or verdict. An evaluated non-applicable prototype needs no
preview evidence. Tool installation belongs to the [profile setup](../../agent-runtime/profiles.md).

## Implementation plan

Architecture produces one or more bounded tasks with summary, scope, completion criteria and
zero-based prerequisite indices. Its evaluator checks outcome coverage, size, duplication and a valid
acyclic graph. Existing adequate technical design receives direct acceptance while this plan still
receives evaluation. Source issue creation, links and ranking stay outside stage roles. The first
implementation continues the shared checkout; prototype references remain available to all planned tasks. Preparation
has no documentation assembly, documentation-only PR, repository reviewer or merge/check state.
