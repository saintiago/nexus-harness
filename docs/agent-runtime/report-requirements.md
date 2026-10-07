# Agent report requirements

Every Nexus agent writes its narrative report as Markdown at an artifact path supplied by Nexus
and returns a separate machine-readable outcome. The outcome contains only control fields and
functional data consumed by its workflow. Findings, explanations, responses, disagreements and
evidence descriptions belong in the Markdown report, not in structured reporting fields.

These requirements govern report contracts and their validation across roles. Combined JSON
narrative/outcome contracts and structured finding-list validation must be replaced to conform to
this separation. Markdown-byte hashes, report-byte matching gates and formal rejection/correction
ledgers are also superseded: readable reports, observed attribution and simple validation-error
context provide the required reporting evidence. Role responsibilities, workflow decisions and
revision/check protections remain intact.
Agents must receive contracts that agree with the rules used to accept their output. When output is
rejected, retained work resumes with actionable feedback; repairing an old artifact alone must not
leave the next invocation repeating the same mistake.

## Affected categories and journey

The affected categories are role instructions and response formats, report/outcome validation,
artifact ownership and retention, context construction, publication, validation-error context and
affected tests. Participants are agents producing and reading reports, the owning Nexus operations
consuming outcomes, and operators reading reports or resuming interrupted work.

| Role category | Machine outcome and functional data | Markdown narrative |
| --- | --- | --- |
| Developer, including repair turns and selected profile variants | Only `status: completed \| failed` | Changes, verification, corrections, disagreements and incomplete work |
| Reviewer, including subsequent reviews | Only `verdict: approved \| changesRequested` | Assessment, current findings, evidence, optional suggestions and verdict explanation |
| Requirements, UX, Prototype and Architecture authors | Existing stage outcome and applicable changed-artifact declarations, inspection references, Architecture plan, applicability evidence, author question or upstream destination/correction data | Work performed, declaration explanations, skip rationale, corrections, disagreements and remaining problems |
| Requirements, UX, Prototype and Architecture evaluators | Existing stage verdict, applicable inspection references and upstream destination/correction data | Assessment, current findings, acceptance/skip explanation and evidence |
| Idea editor, Researcher, Project guide and Challenger, including framing, refinement, discussion, focused follow-up and retained-revision completion | Only the routing/decision data and functional idea, question, help-request or publication data the workflow consumes | Contributions, research, project guidance, concerns, responses, sources, uncertainty and decision explanations |
| Recovery | Existing resume or needs-attention decision | Diagnosis, uncertainty, actions, queue changes and reason for the decision |
| Experience analyst | Zero or more memory observations and their required evidence/provenance and related-memory data | Analysis rationale, evidence interpretation, uncertainty and why useful lessons were or were not found |

Functional data can contain text: implementation task summaries and completion criteria, refined idea
content, author questions and memory observation content remain data when their consumer needs them.
Their inclusion does not justify retaining a general narrative summary, findings array or duplicated
report body in the outcome. Structured plans, routing decisions and memory payloads remain separate
from narrative reports.

The journey is: receive the role's contract, task context and assigned Markdown path -> inspect or
perform the role's work -> write the report -> return the minimal outcome -> Nexus validates and
retains the outcome with its observed identity and report association -> continue through the
existing workflow, supplying Markdown reports to subsequent agents as context.

If output or its report is rejected, retain readable failure evidence
-> recover within the existing limits -> supply the error to the next responsible attempt
-> validate and save a replacement outcome -> clear pending validation-error context and continue
through the normal gates, keeping the original failure readable.

## Activities and rules

1. Supply every invocation in the role categories above with its assigned Markdown report path,
   applicable outcome contract and task context, including repair and focused follow-up variants.
   Concurrent roles have distinct report artifacts. The agent writes the narrative to that path and
   returns only the outcome. It does not choose report destinations or supply Nexus's identity or
   revision metadata. No fixed report headings, prose schema or length gate is required.
2. Give each outcome field a workflow consumer and make its meaning, outcome-dependent requirements
   and role/stage restrictions available before invocation. Developers return only status; reviewers
   return only verdict. Other roles retain only the minimal control and functional data their
   workflow consumes. Remove superseded narrative fields and their dependent validation and tests
   together. Provider-compatible structured output applies to outcomes, not Markdown prose.
3. Nexus saves outcomes with its observed task/work identity, role/profile, invocation and relevant
   revision/outcome metadata and associates them with the assigned report. Do not compute, require
   or compare Markdown-byte hashes, including when reading retained outcomes. Readable changes to
   report text alone do not invalidate an outcome or reopen a completed assessment. Report
   attribution remains necessary; readable prose does not transfer approval to another invocation
   or revision. Agents may write their assigned Markdown, documents and evidence, but must not
   overwrite action-owned outcome or state records, including
   preparation `author.json`, `evaluation.json`, `result.json`, `plan.json` and state records.
4. Validate control fields, applicable functional data, report existence/readability and applicable
   revision/input binding before using a new outcome. Never parse narrative content as JSON, extract
   control decisions from prose or require machine-shaped findings inside Markdown. Repository and
   evidence checks remain with their existing owners; neither a valid outcome nor a readable report
   proves the prose claims or establishes acceptance on its own.
5. Reviewers and evaluators still explain concrete current problems, evidence, consequences and
   required corrections, separating necessary changes from optional suggestions. Approval/acceptance
   requires adequate evidence and no current blocking problem; a changes-requested verdict requires
   a current blocking problem. These assessment obligations belong to the role's judgment and report,
   not deterministic validation of a structured findings list. An unfinished assessment uses existing
   failure/recovery paths rather than a fabricated verdict.
6. Supply subsequent responsible agents with the relevant Markdown reports or readable local
   references, preserving attribution and full necessary evidence. Previous reports provide context
   for corrections and disagreements; source comments and published summaries do not replace them.
   Human-facing publication remains concise and uses the saved report and functional publication
   data without restoring narrative fields in machine outcomes or parsing reports into JSON.
7. Preserve earlier reports as readable history without rewriting originals or imposing the new
   response format retroactively. Earlier combined artifacts remain available to subsequent agents
   as readable context. Historical reports do not authorize new work or changed revisions. Retained
   continuation still uses its existing identity, revision and evidence rules.
8. Rejected output remains rejected. Invalid control/functional data, missing or unreadable assigned
   reports and invalid applicable bindings must not be normalized into acceptance or completion.
   Preserve available rejected output, report and the specific rejection reason as attributable,
   readable evidence; unavailable material stays explicitly unavailable.
9. Preserve simple actionable validation-error context across process exit, recovery, reselection
   and retained continuation. The next responsible invocation must receive the violated rule,
   available rejected output/report or their readable references, and enough context to correct the
   report. Attribute the error to the affected work, role and invocation so unrelated work does not
   inherit it. Historical
   rejected claims remain evidence, not approved work or governing human intent. When the owner
   validates and saves a replacement outcome, clear that responsibility's pending validation-error
   context while retaining the original errors and reports as readable history. This also applies
   during resumed processing and to valid negative business outcomes. An invalid replacement keeps
   actionable error context pending. Editing a historical artifact without an owner-validated
   replacement does not establish a valid outcome.
   No rejection/correction ledger, correction declaration, rejection-reference list, saved-outcome
   identity match or proof that an invocation received particular errors is required to clear the
   context. Remove the dependent schemas, state, instructions and tests without introducing another
   bookkeeping protocol. Attribution routes the error to its responsible attempt; it is not a
   correction-matching gate.
10. Preserve finite round, return and recovery allowances, stage ownership, unresolved problems,
    current-worktree evaluation, readable prototype browser evidence and implementation
    review, and required merge/check protections. Feedback retention uses normal recovery and
    continuation; it does not add an unrelated retry mechanism, grant extra attempts or convert an
    invocation fault into a product verdict.
    Preparation declarations remain changed authoritative documents and additional stage-owned files,
    never mandatory reading citations or assessment coverage. Prototype assessment follows the
    [prototype assessment requirements](../project-workflow.md#prototype-assessment-requirements),
    without per-file inventories, observation revisions or persisted content bindings. Nexus-observed
    task/profile/revision/report attribution and fresh-decision integrity checks remain in force.
    Adequate existing documents receive direct evaluation in the
    current worktree; applicability skips receive evaluation. Do not restore finding IDs, response or
    disposition tracking, mandatory document citations or historical document approval reuse.
11. Update authoritative report contracts, role instructions, artifact handling, context construction,
    publication consumers and affected tests across every listed role and invocation variant. Verify
    valid outcomes, rejected counterparts and subsequent-agent report context through the owning
    boundaries. Retained records containing obsolete hashes or ledger data remain readable without
    enforcing those mechanisms or rewriting original history. Carry forward still-actionable
    validation errors as simple context when removing ledger state. Preserve existing pending analysis
    and accepted memory observations/submissions under the
    [memory continuation requirements](../memory/integration.md#durability-and-evaluation).
    Complete through configured preparation and linked implementation, review, merge and required
    CI, then activate the checked merged revision for KAN under
    [installation activation](../application.md#installation-activation). Preserve retained work and
    pending analysis when switching installations; this requirements stage does not perform those
    source or activation operations.

## Observable acceptance examples

| Situation | Observable result |
| --- | --- |
| A developer writes changes and verification in its assigned Markdown and returns `{"status":"completed"}` | Nexus accepts the response shape, checks its report and existing readiness evidence, and saves observed identity/profile/revisions separately from prose. Verification still requires Verify's evidence. Returning only `{"status":"failed"}` with a readable explanation preserves the existing failed-work route. |
| A reviewer writes a current blocking defect in Markdown and returns `{"verdict":"changesRequested"}` | The report supplies actionable evidence to the next developer and the existing repair flow runs. No structured findings array or prose-to-JSON conversion is needed. With sufficient evidence and no blocking problem, `{"verdict":"approved"}` permits only the existing reviewed-head gates. |
| A developer returns an unknown status, a reviewer returns an unsupported verdict, or either includes narrative report fields in its outcome | The response violates the role's minimal contract and is rejected through existing feedback/recovery handling; Markdown cannot override the invalid control value. |
| A role returns a valid control value but its assigned Markdown report is missing or unreadable, or an applicable revision binding is stale | Nexus rejects unusable output with the specific reason and preserves available evidence. It manufactures no skip, approval or completion. |
| Markdown contains headings, lists, code fences or JSON examples as part of an explanation | It remains readable narrative; none is parsed as an outcome or required to conform to a report schema. Decisions come from the validated outcome and existing workflow evidence. |
| Existing requirements satisfy a preparation ticket and the author leaves them unchanged | The author writes its Markdown assessment and submits authored work with empty changed-document/source declarations. Current-worktree evaluation proceeds without citations, a reuse skip or historical approval reuse. |
| A preparation author proposes inapplicability or returns a concrete earlier-input defect | Its Markdown explains why; the outcome carries only the applicable decision/routing and needed functional data. Existing skip evaluation and allowed upstream-return routes remain in force. |
| Architecture authors a bounded plan, or an applicable prototype is inspected | The structured plan remains available to implementation handoff and inspection references remain available to their evidence checks. Narrative findings and explanations are in Markdown; plan dependencies, readable browser evidence and Nexus-observed revision/report attribution still apply, without per-file observation bookkeeping. |
| Idea refinement frames, revises, discusses or requests focused help | Each role and follow-up has an assigned Markdown report. Research, guidance and concerns reach the editor as narrative, while functional idea/publication data, questions and decisions preserve the existing bounded conversation. Challenger approval remains bound to the assessed idea and editor response. |
| Recovery decides resume or needs-attention | The outcome carries the decision and the assigned Markdown contains diagnosis, actions and uncertainty. Nexus retains the report, sends the existing notification and applies the same recovery decision. |
| Experience analysis yields one useful lesson or no useful lesson | The outcome contains the functional memory observations or an empty observation list, separately from a readable Markdown account. Evidence validation, stable submissions and receipt retries remain intact; the business outcome is unchanged and routine narrative is not submitted as a lesson. |
| A later repair or evaluation follows earlier rounds, including a legacy combined report | The agent can read the relevant reports and their attribution/evidence. New narrative is Markdown, legacy originals remain readable and untouched, and no IDs, responses or dispositions must be matched. |
| A saved outcome's Markdown is still readable but its wording changes, or a retained outcome carries an obsolete report hash | No Markdown-byte matching gate rejects it. Observed task, role/profile, invocation and relevant revision/outcome attribution remain available, and existing current-revision protections still apply. |
| Recovery edits an old report, clears selection and resumes retained work without an owner-validated replacement outcome | The next responsible attempt still receives the actionable validation error and readable original evidence after a worker restart. A historical edit alone does not grant acceptance. |
| A responsible attempt supplies a valid replacement outcome and readable report, including a valid failed or changes-requested outcome | The owner saves it and clears its pending validation-error context without correction records, rejection IDs or identity matching. The original error and report remain readable, and the normal business route follows the replacement outcome. |
| A replacement remains invalid, or another work item or role starts | An invalid replacement leaves actionable errors for its next responsible attempt. Unrelated work or roles receive no foreign pending error context. |
| An old analysis already has accepted observations or a pending memory receipt when report validation changes | Continuation preserves the observations and existing submissions; it neither invokes analysis again solely for obsolete hash/ledger requirements nor submits a duplicate lesson. |
| Retained work has exhausted its allowance, an unresolved blocking problem, approval for another head or failed required checks | Report separation and feedback retention cannot reset allowances, remove correction obligations or permit completion without current required evidence. |
| The merged change has passed required review and CI and is ready for KAN | Activation waits until users of the current installation finish or reach a normal retained stop, verifies the configured launch target is the checked revision, and preserves KAN configuration, checkpoints, allowances, readable errors/reports and pending analysis. A local build alone does not demonstrate activation. |

## Scope and unsettled decisions

Existing [workflow](../project-workflow.md), [recovery](../application.md#execution-and-recovery),
[agent invocation](architecture.md#provided-interface) and
[delivery protections](../task-engine/actions/complete-task.md#behavior) remain authoritative.
The requested change concerns reporting artifacts and machine outcomes, not a reporting-terminal
interaction change. Existing [UX/prototype applicability](../ux-ui.md#preparation-applicability)
therefore applies. No general retry system, finding lifecycle or unrelated role capability is added.

No material product decision is unsettled by the captured request. Exact schemas, artifact layout,
metadata representation, legacy-reader compatibility and publication assembly belong to Architecture
within these requirements. Existing role/action documents must be aligned there: combined report
fields, structured-finding checks, Markdown hashes/matching gates and formal rejection/correction
protocols are superseded here. In particular, the shared action report contract and its preparation,
analysis, Application, Recovery and workspace consumers must remove those obsolete requirements
together. Workflow responsibilities, source/assessment associations, substantive findings and
upstream-return routes remain authoritative; they are not report-validation ledgers. Fresh
preparation memory identities follow the [memory requirements](../memory/integration.md#durability-and-evaluation).
Implementation, focused behavioral checks, delivery and KAN activation belong to linked delivery
work, not requirements authoring. No replacement bookkeeping mechanism is added.
