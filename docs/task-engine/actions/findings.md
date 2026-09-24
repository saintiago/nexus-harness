# Findings contract

## Ownership and shapes

[Review](review.md#output) owns and exports Finding and FindingDisposition with its artifact declarations.
[Develop](develop.md#output) owns and exports FindingResponse with its artifact declaration.
Consumers import these definitions. Define each with one Zod schema and derive its TypeScript type;
the following shapes specify the data, not additional copies of those schemas.

```ts
type Finding = {
  id: string;
  title: string;
  severity: 'blocking' | 'non-blocking';
  basis: string;
  evidence: string;
  impact: string;
  repairGuidance: string;
  locations: { path: string; line?: number }[];
};

type FindingResponse = {
  findingId: string;
  status: 'addressed' | 'disputed' | 'unresolved';
  response: string;
};

type FindingDisposition = {
  findingId: string;
  disposition: 'resolved' | 'open' | 'withdrawn';
  reason: string;
};
```

basis identifies the task requirement, documented obligation or expected behavior that is violated.
evidence describes the observed or reproducible failure, the related occurrences inspected and any
material uncertainty. impact explains its consequence. repairGuidance describes the required
correction without prescribing an unnecessary implementation. locations identifies affected files;
it may be empty for a missing behavior with no useful code location. Lines refer to the reviewed revision.

response explains the change, disagreement or remaining problem, with supporting evidence and the
extent of the related-occurrence check. addressed is a developer claim; review confirms resolution.
reason explains the reviewer's disposition using the current implementation and developer response.

## Handoff and identity

Finding IDs are unique within a task and stable across rounds. Reuse an ID for an existing defect,
including additional occurrences of that same cause. Give a genuinely different defect a new ID.
Use retained reports to choose IDs; no separate finding store is required.

The development input contains the preceding review's current findings as complete Finding values.
The developer returns one FindingResponse for each supplied finding. The next reviewer receives those
same findings and responses, plus the current implementation and verification evidence. Use these
shapes unchanged in context, agent responses and persisted artifacts; human publication is a summary.

Review's findings array contains all findings still present in the current revision, including retained
open findings and newly discovered ones. priorFindings contains one disposition for each supplied prior
finding. An open disposition has a matching current finding. Resolved or withdrawn findings remain in
history rather than the current array. Neither role silently drops or renumbers an existing finding.

## Verdict rules

- approved: sufficient evidence and no current blocking findings. Non-blocking observations do not
  require another repair round.
- changesRequested: at least one current blocking finding with a concrete basis, evidence and impact.
- inconclusive: material evidence is unavailable; the summary explains what is missing.

Actions validate response shapes, referenced IDs and consistency with these verdict rules. The reviewer
judges the substance of evidence; the harness does not attempt to prove prose claims deterministically.
