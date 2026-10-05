# Findings contract

## Ownership and shape

[Review](review.md#output) owns and exports Finding with its artifact declaration. Consumers,
including preparation evaluators, import that public definition. Preparation owns its own verdict,
stage and observation rules; sharing Finding does not create a shared workflow coordinator.
Define Finding with one Zod schema and derive its TypeScript type. This shape specifies its data:

```ts
type Finding = {
  title: string;
  severity: 'blocking' | 'non-blocking';
  basis: string;
  evidence: string;
  impact: string;
  repairGuidance: string;
  locations: { path: string; line?: number }[];
};
```

basis identifies the task requirement, documented obligation or expected behavior that is violated.
evidence describes the observed or reproducible failure, related occurrences inspected and material
uncertainty. impact explains its consequence. repairGuidance describes the required correction
without prescribing an unnecessary implementation. locations identifies affected files; it may be
empty for missing behavior with no useful location. Lines refer to the assessed revision. The strict
agent response uses an explicit null for an absent line; the saved finding omits that line.

## Current assessment and history

Findings describe problems present in the current assessment. They have no stable IDs, responses,
statuses or dispositions to match across rounds. Authors and developers explain repairs,
disagreements and remaining problems in their report narrative. Evaluators and reviewers use previous
reports as context and judge those explanations against the current work. A remaining or recurring
defect warrants a current finding with evidence; a resolved problem needs no lifecycle record.

Context construction supplies complete previous reports or readable references, preserving their
attribution and evidence. Human publication is a summary, never the repair input. Historical reports
remain readable without retroactive responses or dispositions. The current finding list must not
include resolved problems merely to answer an earlier review.

## Verdict rules

- approved: sufficient evidence and no current blocking findings. Non-blocking observations do not
  require another repair round.
- changesRequested: at least one current blocking finding with a concrete basis, evidence and impact.

These are the only implementation review verdicts. If material evidence is unavailable and the
assessment cannot finish, use the existing execution-error and recovery path. Missing evidence alone
is not a blocking finding and must not become approval or a changesRequested verdict.

Actions validate report shape and consistency between current findings and verdict. They do not
match findings to earlier reports or attempt to prove prose claims deterministically. Preparation
applies its own verdict names and upstream-correction rules to this same current-finding shape.
