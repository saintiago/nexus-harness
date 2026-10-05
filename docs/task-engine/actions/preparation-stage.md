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
Existing authoritative documents can satisfy missing earlier artifacts; record what was relied on.
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
  reason: string | null;
  returnStage: 'idea' | 'requirements' | 'ux' | 'prototype' | null;
};
```

This envelope keeps references; producing declarations also retain document revisions, evaluated skip
references, implementation plan and prototype observations when applicable. Allowed return destinations
are earlier stages in the route. Accepted and skipped results require the evaluator's current decision;
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
  content: AssessedContent[];
};
```

Identities bind complete saved reports or captured source input, including attributed conversation.
Publication acknowledgements do not themselves replace that captured input. Refreshed human input
must be reconciled before reuse. Repository paths are canonical checkout-relative paths; a deleted
file is represented by exists=false at its observed commit. A declaration may name a deletion when
the path was tracked before the author invocation or this stage retained its deletion in a validated
author observation or evaluation. An observation naming an ancestral deletion commit establishes
absence, not ownership by the declaring stage. This permits stage-owned cleanup and replay without
manufacturing a replacement document. Revisions must remain readable in the retained repository. Result references
identify the evaluator decision carrying this basis; a stage name or round number alone is insufficient.

## Round storage and acceptance

Each stage area owns `state/current-round.json`, `state/result.json` and numbered
`artifacts/<round>/` containing author.json, evaluation.json and result.json. The plan records selected
profiles and why the round opened. Cumulative round and return allowances survive re-entry/restart.
A terminal exhaustion record does not replace an earlier completed round. The current terminal record,
not a search through old acceptances, determines whether the stage can advance.

Author and evaluator response contracts omit action-added metadata. StageAuthor adds stage and
authored revision; StageEvaluator adds the observed acceptance basis; result/plan persistence stays
with the stage operations. Invocation context explicitly reserves their report and state paths.
Non-authored responses carry empty `sourcePaths`; skip citations belong in `skip.references`.
Every stage accepts authored work with `accepted` and a proposed skip with `accepted-skip`;
incompatible outcome/verdict pairs are rejected before persistence and during retained replay.

Use the [report rejection contract](architecture.md#rejection-evidence-and-continuation) in each
stage area. The current responsible author or evaluator receives outstanding feedback even when
recovery repaired a previous record or reselection opens another bounded round. Repaired history
alone does not retire feedback; a usable replacement must be validated and recorded as its
correction. Neither rejection nor correction changes evaluation bases or finding obligations.

Before evaluation, commit the author's declared documents and applicable prototype source paths in
the shared checkout. Named commits exclude unrelated staged work. The author declares prototype paths;
committing the entire checkout would absorb work outside that stage's responsibility. Retain the
observed commit revision and the identity of the complete authored report, including plan, skip and
finding responses. Evaluators assess only their stage's content and inputs, never a combined
preparation publication. Architecture acceptance returns directly to handoff.

The evaluation records its input basis: immutable upstream result/report references and identities,
source input identity, and the document/prototype paths and Git revisions actually assessed or relied
on. Existing-document skips have the same binding. Compare those paths with saved content before
acceptance and before reuse; an unrelated new HEAD is not by itself a change to accepted content.
A changed authored report, assessed content or relied-on input needs a current evaluator decision.
Resolve relative and in-checkout absolute references to canonical checkout-relative paths. Paths
outside the checkout are not repository document references. Preserve source attribution.
Unusable skip citations and repository citations missing from a retained evaluation's content basis
require reevaluation before finalization, replay, downstream reuse or handoff. Removing or replacing
a cited document cannot restore a historical acceptance with a missing binding. Preserve the
historical record; current content cannot supply a retroactive binding.

## Correction and reuse

An upstream return retains the problematic input, consequence, correction and owning earlier stage.
The parent records the destination and downstream stages awaiting validity decisions before advancing
source state. This pending route survives restart. The destination corrects its own work in the shared
checkout; Idea correction changes its input artifacts without replacing the preparation checkout.

Proceed forward through pending stages in order. Where content and relied-on inputs still match,
reuse the accepted result and observation references explicitly. If an upstream report changed,
the stage's evaluator can confirm that unchanged work remains adequate against the corrected input
in a normal bounded round; the new evaluation records that basis. A proposed reuse/skip does not
itself approve changed content. Fresh evaluation of current repository document citations can accept
their changed content, even when an earlier accepted skip cited the same paths. Finalization uses
that current assessment rather than requiring those citations to match the preceding skip's basis.
This differs from reusing prior stage-owned documents, sources or a retained prototype: reuse must
preserve their complete, still-valid content and applicable observation evidence. Repeating a
document citation does not by itself establish reuse of a prior owned asset.
When the changed input affects the stage, repair and reevaluate it. No
semantic dependency engine or extra reviewer is required. Optional suggestions remain non-blocking.
Before final handoff, validate every required stage's current decision and clear pending work;
a mismatching reference routes to the earliest responsible stage, without reviving an older approval.

Re-entry supplies the latest work, complete unresolved findings, responses and any return finding.
Author-only returns and input requests resume as reassessment and retain the latest evaluation's
finding evidence until a later evaluation explicitly resolves or withdraws it. Acceptance reuse
must not search past an intervening invalid or unfinished round. Import the existing
[findings contract](findings.md); authors may answer or rebut as well as edit, and evaluators explicitly
resolve prior findings. Evaluated applicability skips remain valid when their basis remains valid.

### Reassessment and finalization requirements

Affected categories are document-citation assessment, retained-asset reuse, stage finalization and
retained-work continuation. Participants are preparation authors/evaluators and operators resuming
an interrupted stage. The journey is: changed cited content or owned work -> inspect the complete
current content -> reassess citations or repair owned work -> current evaluation -> finalization ->
confirm or repair affected downstream decisions -> handoff.

Finalization must retain the current evaluation and assessed citation revisions. Changes to the
author report, cited content, captured source/conversation or relied-on upstream inputs after that
evaluation still require a new decision; an older acceptance cannot fill a missing or unreadable
current binding. Genuinely stale,
unassessed reuse remains rejected. Retaining an applicable prototype still requires its complete
source and both roles' current observation evidence under the rules below.

Observable acceptance examples:

| Situation | Observable result |
| --- | --- |
| A non-applicable prototype previously cited a role document that a later stage changed; both roles reassess it and obtain a current accepted skip | Finalization succeeds with the newly assessed document revisions. With no retained prototype, no browser evidence is required. The old evaluation remains historical evidence. |
| A requirements skip cites testing, CI/CD and stack documents changed by Architecture while the requirements document remains unchanged; the current evaluator accepts the reassessment | Finalization succeeds for the current citations, including section citations to the same files named by the prior skip. It does not renew downstream decisions. |
| Architecture extends a document owned by an earlier accepted requirements result | The earlier requirements acceptance is stale. Requirements repairs its authored work against the complete current document, preserving compatible later-stage additions within the accepted scope, and obtains a new evaluation. This preserves the requested outcome without adding a product requirement. Repeating the path as an input-only citation cannot authorize the changed owned work. Every affected downstream decision is then confirmed or repaired through normal reassessment before handoff. |
| Cited content changes after the current evaluator assessed it, or its binding is missing or unreadable | Finalization, replay and downstream acceptance reject the stale or incomplete decision and require current evaluation. |
| A proposal reuses a prior result or owned asset whose content changed without reassessment | The preceding acceptance cannot authorize the changed asset; stale reuse remains rejected. |
| A skip retains an applicable prototype but its sources changed or either role's observation evidence is missing, unusable or stale | The skip cannot finalize or be reused as current acceptance. Unchanged assets with complete valid evidence remain reusable. |

Regression coverage must reproduce both reassessment patterns and genuinely stale, unassessed
reuse. Deliver through normal verification, review, merge and required post-merge checks. The
initiating task activates the checked merged runtime only after its current users exit, following
[installation activation](../../application.md#installation-activation), then resumes the affected
checkpoints without replacing their checkout/branch, histories, findings or consumed allowances.
Resumption proceeds through normal gates and does not itself establish acceptance.

No material product decision is unsettled. This changes no reporting-terminal interaction and adds
no unrelated retry machinery. Evidence representation, reuse classification and activation
mechanisms belong to Architecture and delivery.

### Citation assessment and retained-asset resolution

Preparation owns reference classification. Author validation, evaluation binding and finalization
use the same reference resolution: relative paths, absolute in-checkout paths and section citations
identify one canonical repository path. A section citation binds the whole file. An external retained
file remains evidence; only a reference to the immediately preceding accepted or skipped result
selects that result for reuse. Other historical reports do not select an older acceptance.

Use the existing result distinctions to classify references; no new report field or persisted reuse
state is needed:

| Reference | Assessment and retained output |
| --- | --- |
| Current repository document, including a path found only in the preceding result's `existingDocuments`, with no applicable retained prototype selected | Assess current content as an input. Retain it in the new `existingDocuments` at the current evaluation's revision; do not copy the preceding revision or include it in prior-asset validation. |
| Document or source path owned by the preceding result (`documents` or `sourcePaths`) | Retain the selected owned asset only with its complete preceding content binding and a current evaluation binding. Its content must still match the preceding acceptance. Changed owned work requires an authored correction. |
| Immediately preceding accepted or skipped result | Select its full retained content, including `existingDocuments`, sources and any prototype evidence. Validate the complete preceding bindings as well as the current assessment. |
| Applicable retained prototype, selected by its branch, revision, checkout or a document/source carried by its preceding result | Retain the complete prototype bundle, including all documents, input documents, sources and both observation references. A partial citation cannot discard the rest of its evidence. |

The prototype rule preserves complete bundle selection, including selection through an input document
carried with that prototype. A non-applicable prototype result has no such bundle: its repeated
document citations are current inputs. A reference selecting an owned asset or complete result cannot
be downgraded to an input citation to bypass stale-reuse checks.

When a later stage changes an earlier stage's owned document, the owning stage corrects its authored
work against the complete current file, retaining compatible later-stage additions within the
accepted scope, and obtains a new evaluation. Subsequent stages confirm or repair their decisions
against that corrected input through the existing pending reassessment route. Neither fresh citation
assessment nor the owner's new acceptance renews downstream decisions.

Evaluation observes all current input citations and all paths selected for asset reuse before invoking
the evaluator, then saves the existing acceptance basis. Resolving fresh citations needs no preceding
content binding; a missing historical binding cannot prevent a new complete assessment of those
inputs. Resolving actual reuse does require the preceding binding for every selected path, including
retained deletions. Reuse remains limited to the immediately preceding completed acceptance.

Finalization first validates the exact current author/evaluation pair, source and upstream identities,
usable citations and current content bindings. It then validates preceding content only for selected
retained assets. Each reused path must also occur in the current basis. Fresh input revisions come
only from that basis; reused owned-document revisions and prototype observations retain their
preceding provenance. Deduplicate by canonical path, with owned assets retaining their ownership.
An unrelated HEAD change is harmless only while the bound file content remains equal.

Keep the response, evaluation and result contracts compatible with retained rounds. Reassessment
writes a new decision; it never edits historical author reports, evaluations, results or observation
records to make them current. Existing finalization replay and downstream current-decision validation
continue to reject changed inputs/content or incomplete bindings. Valid fresh citation finalization
does not renew any downstream stage's decision.

An interrupted finalization with a complete current evaluation can resume at its saved checkpoint
without opening another author/evaluator round. If that evaluation is no longer current, normal
reassessment is required. Installation activation follows the existing Application contract above;
the initiating task performs it after delivery and after runtime users exit, then resumes the exact
affected checkpoints. No action gains an installation switch, checkpoint reset or retry mechanism.

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
Any result retaining an applicable prototype, including a reuse skip, requires both roles' readable,
current evidence even when its saved observation references are empty or absent. Finalization, replay
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
acyclic graph. Existing adequate technical design permits a skip while this plan still receives
evaluation. Source issue creation, links and ranking stay outside stage roles. The first implementation
continues the shared checkout; prototype references remain available to all planned tasks. Preparation
has no documentation assembly, documentation-only PR, repository reviewer or merge/check state.
