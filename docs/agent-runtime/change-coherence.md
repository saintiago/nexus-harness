# Change coherence requirements

Unattended changes must leave the affected requirements, experience, architecture, documentation
and code coherent within the task's scope. Each change must reconcile existing intent rather than
accumulate contradictory rules or mechanisms. The governing design policy remains the project's
[design and ownership principles](../../AGENTS.md); these requirements make
their application explicit in the existing roles and gates.

## Affected categories and journey

The affected categories are preparation author/evaluator instructions, development/review
instructions, alignment of documented intent with supplied prompts, and verification of instruction
delivery. Participants are all four preparation authors and their evaluators, the developer and the
reviewer. Each acts within its existing responsibility; Requirements does not acquire technical
design responsibility, and a stage skip does not create otherwise unnecessary work.

The journey is: reconcile affected intent while authoring -> evaluate the resulting stage revision
or proposed skip -> correct necessary findings through the existing preparation workflow ->
implement and self-review the coherent change -> review the resulting design and implementation ->
repair necessary findings through finite delivery -> merge and confirm required post-merge checks.

## Activities and rules

1. Make reconciliation explicit in the authoritative preparation, development and review role
   documentation and the instructions actually supplied to those roles. Reuse the project's
   existing design and ownership principles rather than introducing another policy definition.
2. Before evaluation or review, authors and developers reconcile the affected existing intent with
   the requested outcome. Within their responsibility, align applicable requirements, experience,
   architecture, documentation and code; remove superseded rules and mechanisms together with
   their dependent validation, state and tests. Preserve unrelated work and scope.
3. When repeated exceptions within scope demonstrate a shared ownership problem, address the cause
   at its owning boundary rather than adding another scattered exception. Confirm the shared cause;
   repetition alone does not justify abstraction or redesign. Apply the existing ownership policy.
4. Evaluators and reviewers inspect the resulting design and, where applicable, implementation,
   including affected interactions and existing behavior. Looking only at additions or trusting the
   author's summary is insufficient. Seek contradictions, unnecessary complexity, scattered
   ownership and interaction inconsistencies. Necessary findings explain the concrete problem,
   evidence, consequence and required correction, and use the existing finding and return paths.
5. Preserve adequate-work acceptance and the distinction between necessary corrections and optional
   suggestions. Alternative designs or personal preferences alone cannot block acceptance. Use the
   existing finite rounds, upstream returns and repair flow without granting extra attempts,
   reviving stale approval or bypassing evaluation, review or merge/check protections.
6. Keep authoritative role documentation and actual supplied prompts consistent. Meaningful
   verification must observe the assembled instructions received by each relevant role, including
   development repair invocations and applicable profile variants. A check of unused constants or
   documentation wording alone does not demonstrate that the instructions reach agents.

## Observable acceptance examples

| Situation | Observable result |
| --- | --- |
| A preparation author changes an existing requirement or design rule | Before evaluation, its current authoritative documents reconcile the affected prior intent and remove superseded rules within that stage's responsibility. Requirements acceptance does not demand technical design. |
| A developer replaces a mechanism that owns persisted state and validation | The contributed change aligns documentation and code and removes the obsolete dependent state, validation and tests within scope; the old mechanism is not retained accidentally alongside its replacement. |
| Several affected callers contain exceptions with a confirmed shared cause | The author or developer reconciles the cause at its owning boundary. Evaluation/review checks the resulting responsibilities and interactions rather than accepting another caller-specific exception. |
| The current revision leaves an affected contradiction, unnecessary mechanism, ownership problem or inconsistent interaction | Evaluation/review identifies the evidenced problem and necessary correction through the existing finite workflow. A correction receives assessment against its current revision. |
| The work meets the outcome, but an evaluator/reviewer prefers another design or optional polish | Adequate work is accepted; the preference stays an optional suggestion and does not require a repair round. |
| Each of the eight preparation roles, developer and reviewer is invoked through its normal path | Captured assembled invocation instructions contain the applicable reconciliation or inspection obligations and preserve scope and acceptance limits. Developer repairs and relevant profile variants retain those obligations. Role documentation agrees with those prompts. |
| This instruction change reaches UX and Prototype without an explicit reporting-terminal change | Authors propose skips citing existing adequate experience and Nexus UI guidance; evaluators assess those skips. No new Nexus UI or prototype is invented. |
| A correction exhausts an allowance, changes an approved revision or has failed required checks | Existing exhaustion, reevaluation and delivery protections still apply. Coherence instructions cannot grant another attempt, transfer stale approval or establish completion without the required evidence. |
| The instruction change is delivered | Delivery occurs after the HARN-96 report-contract fixes, with normal verification, revision-bound review, merge and required post-merge checks passed. An active Nexus runtime is not replaced. |

## Scope and unsettled decisions

Source: the captured HARN-100 issue description. The existing [preparation roles](preparation-roles.md),
[DevelopmentRole](development-role.md), [ReviewerRole](reviewer-role.md),
[project workflow](../project-workflow.md), [findings contract](../task-engine/actions/findings.md)
and [completion gates](../task-engine/actions/complete-task.md) retain their responsibilities.

This improves cumulative quality during long unattended runs through existing gates. It introduces
no scoring system, audit workflow, guarantee of zero regressions or unrelated redesign. Nexus
remains terminal-only; its unchanged UX and prototype stages require evaluated skips under
[Nexus UI applicability](../ux-ui.md#preparation-applicability).

No material product decision is unsettled. Prompt composition, supporting technical design and
verification implementation belong to Architecture. HARN-96 readiness and a delivery opportunity
that does not replace an active runtime must be established from delivery evidence; this
requirements revision does not establish either condition.
