# Preparation stage actions

## Responsibility and interface

Requirements, UX Proposal, Storybook Refinement and Architecture each own an author/evaluator
machine and its result artifacts. Their responsibilities and acceptance criteria belong to the
[project workflow](../../project-workflow.md). Invoke roles through
[AgentRuntime](../../agent-runtime/architecture.md#provided-interface), using the
[preparation role instructions](../../agent-runtime/preparation-roles.md).

Inputs are the parent-selected source snapshot, attributed conversation, stage workspace,
producer-owned upstream references and any return finding. Use the general artifact/round helpers;
input reads are explicit and never silently fall back to stale rounds. Existing authoritative
repository documents can satisfy a stage input when no earlier artifact exists. The action records
which documents/revisions it relied on. No stage action receives Jira or source credentials.

Stage output declarations and schemas belong to the producing stage. The following result envelope
is owned by the preparation stage operations and imported by parent publication. It does not redefine
individual document, prototype or implementation-plan contents.

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

Validate allowed earlier destinations using the producing stage and the parent route. Accepted
results require an assessment of that exact authored revision. Skipped results require evaluated
applicability evidence and references satisfying the stage. Return/input/exhaustion reasons must be
concrete; missing inspection evidence cannot produce accepted prototype work. A child terminal output
contains its outcome and result reference; detailed values stay in the saved result.

## Round storage and findings

Each stage area has state/current-round.json and artifacts/<round>/ with author.json, evaluation.json
and result.json. The round plan records the selected role profiles, the authored revision and the
reason for opening the round. Earlier rounds remain history. StageResult retains the latest terminal
invocation in state/result.json; re-entry exhaustion updates this record without replacing a
completed round result. Parent publication reads that terminal, while history consumers read rounds.
Accepted document changes are committed by named paths; accepted prototype work is committed on its
retained stage branch. References name revisions containing the accepted content. Evaluated skips
retain their input references and the saved revisions of existing authoritative documents. Parent
source handoffs are stored outside stage-owned rounds. Before returning an accepted Architecture
handoff, ReviewPreparationPublication assembles the immutable accepted documents, validates the
whole diff and saves the repository reviewer's assessment for that exact revision. The parent
reconciles publication from this report; an absent or negative assessment cannot authorize merge.

The author owns its proposed artifacts, applicability reason and finding responses. The evaluator
owns findings, prior dispositions and acceptance of the current revision. Import the existing
[findings shapes](findings.md) rather than copy their schemas. Stable IDs and complete responses
cross rounds; optional suggestions remain non-blocking. Evaluate answers/rebuttals as well as edits.
Do not require implementation details at Requirements or UX acceptance.

Architecture author output includes an implementation plan: each task has a concise summary, bounded
scope, observable completion criteria and references to prerequisite planned tasks. The evaluator
checks coverage, dependency order and that the original is a preparation ticket. Source labels,
issue type, linking and creation remain parent-owned configuration/actions. Prototype output includes
its branch/revision, stories/preview references and observed evaluation evidence. A documentation PR
contains only authoritative document changes; prototype code is retained for implementation reuse.

## Execution and repetition

Assess applicability before authoring. A proposed skip is evaluated; rejected skips enter normal
work. Within a stage, author/evaluator decisions route through XState. Open rounds only within the
configured allowance and preserve counts across restart. Reuse completed output only when its input
and authored revision match. Return a durable result before parent publication, with one truthful
outcome event. Provider failures remain faults. The parent owns stage transition and feedback resume.
