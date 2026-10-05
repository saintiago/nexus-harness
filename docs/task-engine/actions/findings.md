# Findings contract

## Ownership and reporting

The [report requirements](../../agent-runtime/report-requirements.md) own narrative/outcome
separation. This document supplies assessment guidance for Review and preparation evaluators; it
defines no public Finding type, JSON schema or structured findings array.

Write actionable current findings in the assigned Markdown report. Explain each concrete problem,
its requirement or documented basis, observed evidence, consequence and required correction.
Identify useful file locations at the assessed revision and preserve material uncertainty. Separate
necessary corrections from optional suggestions. No fixed headings or machine-shaped prose are
required. Authors and developers explain repairs, disagreements and remaining problems in their own
Markdown reports. Context includes relevant previous reports with their attribution and full
necessary evidence.

## Verdict rules

- Implementation `approved` and preparation `accepted` / `accepted-skip` require sufficient evidence
  and no current blocking problem. Optional suggestions do not require a repair round.
- Implementation `changesRequested` and preparation `changes-requested` require a current blocking
  problem explained with concrete evidence, consequence and correction in Markdown.
- Preparation `return-upstream` requires an allowed earlier destination and a concrete correction;
  the report explains the input defect and why it prevents the selected stage from proceeding.

These are agent assessment obligations, not deterministic checks of narrative substance. Actions
validate the control values, outcome/verdict pairing, functional data and applicable bindings; they
do not parse or count findings or verify verdict consistency against prose. If an assessment cannot
finish, use the existing execution-error/recovery path rather than an invented finding or verdict.
Current work and evidence still receive agent evaluation.

## Current assessment and history

Findings have no stable IDs, response/status records, dispositions or cross-round matching.
Reviewers and evaluators judge earlier concerns against current work. A recurring defect needs a
current evidenced finding; resolved historical problems need no lifecycle record. Legacy combined
artifacts remain readable context without requiring their old finding-list validators. Human
publication is a summary, never a replacement for the full repair report.