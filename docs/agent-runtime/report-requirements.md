# Agent report requirements

Nexus agents must receive report contracts that agree with the rules used to accept their output.
When a report is rejected, retained work must resume with actionable feedback about that rejection.
Correcting an old artifact alone must not leave the next invocation repeating the same mistake.

## Affected categories and journey

The affected categories are agent instructions and response formats, report validation, artifact
ownership, rejection feedback and retained-work recovery. The affected participants are agents
producing reports, operators resuming interrupted work and the actions consuming those reports.

The journey is: receive the role's contract -> return output -> validate and retain usable work ->
evaluate or review through the existing workflow. If output is rejected, retain the failure evidence
-> recover within the existing limits -> resume the responsible role with the correction available
-> validate its new output and continue through the normal gates.

## Activities and rules

1. Audit every Nexus agent role and its distinct invocation/output variants: Idea editor,
   Researcher, Project guide, Challenger, all four preparation authors and evaluators, developer,
   reviewer, recovery and experience analyst. Compare the emitted structured schema, response-format
   text, role instructions, semantic validation and producer-owned artifact responsibilities.
   Fix confirmed mismatches and analogous occurrences with the same demonstrated cause. Record the
   inspected coverage and any remaining uncertainty in delivery evidence; speculative defects do
   not expand the repair scope.
2. Make field meaning, outcome-dependent requirements and role/stage restrictions available to the
   agent before it produces output. Structured formats must remain compatible with the provider's
   requirements. Rules needing repository state, evidence or workflow context remain validated by
   their owner; structural validity alone does not establish semantic validity or acceptance.
3. Distinguish returned agent output from saved producer artifacts. Agents return their report and
   may create explicitly assigned documents or evidence. The owning action adds its metadata and
   persists its records. Instructions must identify action-owned files that agents must not write
   or overwrite, including preparation `author.json`, `evaluation.json` and `result.json`.
4. In preparation, `sourcePaths` declares additional stage-owned authored files, not reading
   citations. Non-authored outcomes carry an empty array. Existing inputs supporting a skip belong
   in `skip.references`; declaring a skip does not authorize committing those inputs or bypassing
   evaluation. Documents and applicable observations retain their existing ownership and rules.
5. Rejected reports remain rejected. Malformed output, semantic violations and unusable saved
   records must not be silently normalized into valid work, approval or completion. Preserve the
   rejected output when available and the specific rejection reason as attributable, readable
   evidence; unavailable output stays explicitly unavailable.
6. Preserve actionable rejection feedback across process exit, recovery, reselection and retained
   continuation. The next responsible invocation must receive the violated rule, available rejected
   output or its readable reference, and enough context to correct the report. Associate the feedback
   with the affected work, role and invocation so unrelated work does not inherit it. Historical
   rejected claims remain evidence, not approved work or governing human intent. A valid correction
   must not erase the historical failure or leave it presented as an outstanding rejection.
7. Preserve finite round, return and recovery allowances, stage ownership, unresolved findings,
   revision/input-bound evaluation and review, and required merge/check protections. Feedback
   retention uses normal recovery and continuation; it does not add an unrelated retry mechanism,
   grant extra attempts or convert an invocation fault into a product verdict.
8. Reproduce the reported failures and other confirmed cases with meaningful regression tests.
   Deliver the repair through required verification, review, merge and post-merge checks. Activate
   the checked merged version without disrupting active work, then resume KAN-76's retained
   requirements checkpoint through normal author validation and evaluation. Preserve its checkout,
   branch, document history and consumed allowances; resumption does not itself establish acceptance.

## Observable acceptance examples

| Situation | Observable result |
| --- | --- |
| A requirements author proposes a skip using existing documents | Its supplied contract explains that `sourcePaths` is empty and supporting inputs go in `skip.references`. A conforming proposal reaches normal evaluation; a skip with reading citations in `sourcePaths` is still rejected with the specific reason. |
| A preparation author returns a response without producer-added stage/revision metadata | The owning action persists a readable author record with its metadata. The invocation explicitly forbids writing the action-owned report files. A malformed retained record is diagnosed rather than silently accepted. |
| A schema-valid report violates an outcome, role or evidence rule | Validation rejects it with the violated rule and preserves available output. No evaluated skip, approval or completion is manufactured. A corrected report can proceed through the existing gates. |
| Recovery repairs an old report, clears selection and restarts retained work | The next responsible invocation receives the rejection and required correction even after a worker restart. The regression demonstrates that repairing the old record alone no longer loses the feedback. |
| Another work item or role starts, or the rejected report is validly corrected | Unrelated invocations receive no foreign rejection obligation. The correction ceases to carry an outstanding rejection while historical failure evidence remains attributable. |
| The audit finds another confirmed contract mismatch | A reproduction demonstrates the cause, the conforming case succeeds through its owning boundary, and the invalid counterpart remains rejected. Delivery evidence identifies the roles and variants checked and unresolved uncertainty. |
| Retained work has exhausted its allowance, unresolved findings, stale approval or failed required checks | Feedback retention cannot reset allowances, remove finding obligations, reuse stale approval or permit completion without current required evidence. |
| The merged repair passes required checks and is activated | The active Nexus version corresponds to the checked merged revision. KAN-76's preserved checkpoint resumes with correction feedback and passes through normal evaluation without fabricated acceptance or reset history. |

## Scope and unsettled decisions

Existing [workflow](../project-workflow.md), [recovery](../application.md#execution-and-recovery),
[agent invocation](architecture.md#provided-interface) and
[delivery protections](../task-engine/actions/complete-task.md#behavior) remain authoritative.
This work changes no reporting-terminal interaction and requires no Nexus UI prototype. It
introduces no general retry system or unrelated role capability.

No material product decision is unsettled. Additional defects beyond the supplied failures remain
unconfirmed until audited. Contract representation, feedback storage and routing, compatibility of
retained records, and the safe activation procedure belong to Architecture and delivery, within
the outcomes and protections above.
