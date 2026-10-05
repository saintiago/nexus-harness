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

## Correction and reuse

An upstream return retains the problematic input, consequence, correction and owning earlier stage.
The parent records the destination and downstream stages awaiting validity decisions before advancing
source state. This pending route survives restart. The destination corrects its own work in the shared
checkout; Idea correction changes its input artifacts without replacing the preparation checkout.

Proceed forward through pending stages in order. Where content and relied-on inputs still match,
reuse the accepted result and observation references explicitly. If an upstream report changed,
the stage's evaluator can confirm that unchanged work remains adequate against the corrected input
in a normal bounded round; the new evaluation records that basis. A proposed reuse/skip does not
approve changed content. When the changed input affects the stage, repair and reevaluate it. No
semantic dependency engine or extra reviewer is required. Optional suggestions remain non-blocking.
Before final handoff, validate every required stage's current decision and clear pending work;
a mismatching reference routes to the earliest responsible stage, without reviving an older approval.

Re-entry supplies the latest work, complete unresolved findings, responses and any return finding.
Author-only returns and input requests resume as reassessment and retain the latest evaluation's
finding evidence until a later evaluation explicitly resolves or withdraws it. Acceptance reuse
must not search past an intervening invalid or unfinished round. Import the existing
[findings contract](findings.md); authors may answer or rebut as well as edit, and evaluators explicitly
resolve prior findings. Evaluated applicability skips remain valid when their basis remains valid.

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
