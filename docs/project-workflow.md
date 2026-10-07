# Project workflow

## Purpose and composition

A project-level XState parent selects one eligible Jira ticket in source rank order and invokes the
child appropriate to its stage: Idea Refinement, Requirements, UX Proposal, Storybook Refinement,
Architecture or Finite Delivery. Children are invoked machine actors, not separate OS workers or
promise wrappers around another TaskEngine.run. They own their rounds, joins and business decisions.
The parent owns source input, publication and cross-stage routing. No Jira watcher or manual routing
loop coordinates them.

This workflow covers preparation through finite delivery. Configured integrated checks remain
required. Separate test-deployment and production-promotion workflows are outside this workflow.
Preparation completion does not establish that a feature was shipped.

## Affected categories and journey

The affected categories are preparation ownership, workspace continuity, evaluation and correction,
prototype observation, implementation handoff and delivery protection. The operator's journey is:
select preparation work -> evaluate Requirements -> evaluate UX -> evaluate Storybook -> evaluate
Architecture and its implementation plan -> hand off linked implementation tickets -> deliver each
ticket separately. Evaluated skips and upstream corrections are part of that journey.

The activities are authoring and committing stage-owned documents, assessing their exact revisions,
repairing findings, observing applicable prototypes, correcting earlier inputs, creating the linked
handoff and verifying, reviewing and completing each implementation PR. Requirements govern these
observable outcomes; Architecture owns supporting contracts, storage layout and tool choices.

Nexus applicability follows [Nexus UX and UI](ux-ui.md). This internal workflow change retains the
existing reporting terminal and requires evaluated UX and prototype skips. Browser/image-verification
capability work remains required; validate it during implementation with an isolated test fixture
running a real Storybook preview, browser interactions and image/layout inspection. That fixture
does not establish a Nexus UI proposal or authorize terminal redesign or external-service navigation
mocks.

## Parent responsibilities

SelectWork searches configured eligible stages in source rank order, captures the issue and complete
attributed conversation, and retains one selection before claiming it. It supplies the stable issue
workspace and source snapshot to the child. Do not reserve a batch. One parent consumer operates per
project; no distributed claim lease is introduced.

The parent owns all Jira reads and writes: refreshed conversation, workspace/PR fields, comments,
linked implementation-ticket creation, ranking, status changes and completion. Child business actions
and role tools receive no Jira adapter or credentials. They receive source data and declared artifacts.
Git, GitHub, process, browser and agent capabilities stay with the operations that need them.
GitHub Lens review publication and merge/check gates remain in Finite Delivery.

Parent-owned boundary actors supply input refresh and publication acknowledgements at finite-delivery
round/review boundaries. They are supplied by the parent and expose a focused data/acknowledgement
contract, not Jira operations. This keeps developer/reviewer feedback fresh and timely without
stopping the child for every coding round. Child business actions cannot perform source effects.

Parent XState definitions specify routing. Ordinary actions implement source effects and artifact
handling; Application binds the machines and operations. Application's OS parent/worker arrangement
is distinct from this parent state machine.

## Entry and routing

New selection uses mapped Jira status. Draft is the admission boundary: selected Draft work enters
Requirements and is claimed into its distinct active Requirements status before the child runs.
An upstream return to Idea establishes active Idea Refinement before invoking that child. Active
delivery statuses require prepared work on both fresh selection and retained continuation; In Review
also requires delivery and matching completed development/passed verification evidence. An attempt UUID is not that
evidence. A saved ready selection may finish an interrupted initial In Progress claim. Interrupted
execution restores the parent snapshot and its active children rather than choosing another entry
from Jira.

| Source stage | Child |
| --- | --- |
| Idea or Idea Refinement | Idea Refinement |
| Draft or Requirements | Requirements |
| UX Proposal | UX Proposal |
| Storybook Refinement | Storybook Refinement |
| Architecture | Architecture |
| Implementation, In Progress or In Review | Finite Delivery |
| Waiting for Feedback | No automatic selection until the author resumes the saved destination |
| Done | No selection |

The ready mapping remains project-owned: HARN may map Implementation to its existing To Do status;
KAN maps it to Implementation. Preparation mappings are optional for delivery-only projects.
Selecting preparation work requires its needed mappings. Missing mappings request attention; they
do not silently skip a stage. Re-read source state before writes and preserve unexpected human
changes. Jira status does not replace the persisted execution checkpoint.

## Child inputs and outputs

Supply source input, attributed conversation, workspace, declared upstream artifact references and
any return finding. Consumers import producer-owned schemas/declarations. Existing authoritative
project documents may satisfy inputs even when no earlier stage ran. Required inputs must validate.

Preparation children return accepted, skipped, returnUpstream, needsInput or exhausted, plus their
saved result reference. A return artifact names an allowed earlier stage, the problematic input,
the returning role's Markdown report binding and the correction needed; a former combined return
keeps its problem and consequence text as history. The parent validates that binding before it
publishes or advances the return, and destination context reads the report through it: an unusable
report is preserved as the returning role's rejection evidence instead of advancing the correction
without its assessment. Idea refinement retains approved, unsuitable,
author-decision-needed and attempts-exhausted meanings. Finite Delivery returns completed or blocked
with its revision-specific evidence. Provider/storage faults remain execution failures.

The parent validates the result, saves handoff evidence, finishes Jira publication/transition, then
enters the next child. Concise preparation comments carry the validated evaluation or returning
report's opening narrative with the observed profile, or the known outcome and report reference when
it has no opening prose. Save outputs before publication. An accepted local result cannot advance
past a failed source write. Repetition inspects retained publication identities and current source
state, finishing only missing effects. Machine context contains control values/references, not full
reports.

Successful publication advances directly through routing, including evaluated skips and upstream
corrections. The completed implementation handoff is the sole successful preparation analysis
boundary under [AnalyzeExperience](task-engine/actions/analyze-experience.md#preparation-handoff-requirements).
Waiting, exhaustion and failure keep their existing analysis routes and destinations.

A retained parent snapshot paused at the former intermediate-success analysis state must resume
routing without scheduling another analysis. Keep the saved state and invoked actor identities for
restoration; its legacy intermediate-success binding returns skipped before evidence discovery or
capture, then continues to routing. New advances never enter it. Requests already captured there
continue independently through the action's pending processor, with their original terminal names
and immutable inputs.
The compatibility state adds no memory gate, stage evaluation or source publication.

## Evaluation and stage applicability

Each preparation stage begins with its author assessing the requested change and stage applicability.
An irrelevant stage permits a skip with reasons; existing documents receive normal
evaluation without a special existing-document skip. Accepted skips are durable results and advance
immediately, without manufacturing a document or prototype. Missing information requires clarification
or an upstream return.

The normal loop is Author -> Evaluate -> Author response/revision -> Evaluate. Evaluate the exact
current content with previous reports as context; earlier approval cannot approve changed content.
Authors can revise, answer or rebut mistaken findings in their narrative reports. Evaluators judge
whether earlier problems remain without a tracked per-finding lifecycle, and distinguish necessary
changes from optional suggestions.

Authors update and commit relevant authoritative documentation when needed in one retained checkout
and branch, then passes that same workspace forward. Stage-owned round artifacts and evaluations
remain attributable to their stage. Both author and evaluator run in the actual retained checkout.
Requirements evaluates requirements, UX evaluates UX, Storybook evaluates the prototype, and
Architecture evaluates architecture and the implementation plan only. There is no combined
documentation assembly or review after these stage evaluations.

Every stage can return a concrete input problem to an allowed earlier stage, including Idea.
Correction and reevaluation use the retained workspace. Evaluators assess the requested change
against the current documents. Later stages may edit the same document without mechanically
invalidating an earlier verdict; a concrete input defect requires an explicit upstream finding.
Refreshed human intent and explicit pending corrections require reassessment. Applicable prototype
inspection retains readable browser evidence and Nexus-observed report/revision attribution, without
per-file assessment bindings. Restart retains the workspace, findings,
completed round history and cumulative allowances.

Seek improvements as well as omissions: simpler rules, clearer journeys, lower user effort, fewer
unnecessary interactions and maintainable designs. Click count alone is not a goal; preserve clarity,
accessibility and error prevention. Acceptance means stage criteria are met, not that no imaginable
improvement remains. Optional suggestions do not prevent acceptance.

Configure finite stage-round and upstream-return allowances. Count them across restarts; focused help
cannot bypass the limit. Exhaustion retains findings and requests attention, without declaring the
idea unsuitable. Waiting for Feedback retains the originating stage and specific question. Human
clarifications govern intent when resumed.

### JEv-assisted applicability

Affected categories are optional agent judgments, preparation applicability, configuration and
retained continuation. The operator enables JEv using host credentials; agents may consult
`ask_jev`, and preparation uses the package's normal TypeScript API to judge stage applicability.
The journey remains captured task -> stage applicability -> authored work or evaluated skip ->
accepted implementation handoff -> independently verified delivery. The activities added here are
consulting bounded judgments, applying Nexus policy, retaining attributable decisions and falling
back to the full stage path.

Rules:

1. Use the delivered [JEv dependency and public contracts](https://github.com/saintiago/jev-mcp/blob/main/docs/contracts.md).
   Keep provider requests, schemas and transport in that package. Native optional agent access and
   usage guidance are owned by [AgentRuntime](agent-runtime/architecture.md#optional-jev-judgments).
   Nexus owns applicability policy; it adds neither a duplicate provider implementation nor a
   shared HTTP service.
2. At preparation's applicability decision boundary, use the TypeScript API with the current
   captured task, relevant repository context and accepted upstream inputs available at that point.
   Decide applicability for the affected stage; Requirements does not become the default owner of
   all later-stage decisions. Preparation's Architecture defines the minimal placement and
   supported-skip criteria, including how uncertainty is recognized; these are not agent model
   selection or provider policy.
3. Apply deterministic requirements before acting on a judgment. A JEv recommendation cannot
   remove a stage obligation established by current task scope or an explicit pending correction,
   accept existing documents without evaluation, bypass applicable prototype observations or
   replace Architecture's evaluated implementation plan. Independent evaluation, finite allowances,
   configured checks, review and completion gates remain required. Confidence alone establishes
   none of these obligations as satisfied.
4. A supported recommendation of inapplicability follows the existing proposed-skip and current
   evaluation path. Only an accepted applicability skip advances as skipped; JEv's response alone
   is not stage acceptance. Preserve author/evaluator responsibility, narrative reasons, optional
   evidence references, correction routes and adequate-document direct evaluation.
5. Disabled, unavailable, failed or uncertain JEv decisions use the existing full stage path:
   the stage author assesses applicability and work, and the evaluator assesses the current
   submission. This can still produce an ordinary evaluated skip. Missing credentials, package
   authentication/rate-limit/timeout/unavailability/invalid-response errors, insufficient evidence
   and contradictions with current intent cannot produce an automatic skip or a new author
   decision request solely to restore JEv. Preserve workflow cancellation and genuine execution
   faults; JEv fallback does not conceal unusable required artifacts.
6. Retain enough attributable evidence to identify the stage, current task/repository/upstream
   basis, JEv judgment or failure/uncertainty, and the Nexus decision and reason. On resume, use the
   retained decision for the same basis instead of replacing it with a fresh model judgment.
   Changed human intent or explicit corrections require normal reassessment; historical decisions
   cannot authorize skipping newly required work. Preserve active runs, reports and consumed
   allowances, including continuation of pre-integration runs without invented JEv evidence.
7. Document and test delivered dependency consumption, API/MCP wiring, enablement, applicability,
   retained continuation and fallback. Initial developer selection, model-policy comparisons,
   benchmarking and changes to memory/context/parallel-fetch behavior are outside this integration.
   No latency, cost or quality improvement is claimed without evidence.

Acceptance examples:

- For an internal change with no reporting-terminal scope, an enabled API judgment receives the
  task, relevant repository evidence and accepted upstream inputs and recommends prototype
  inapplicability. Nexus retains that recommendation; the existing skip proposal and independent
  evaluation must succeed before prototype is skipped. Requirements has not decided all stages.
- For an explicit reporting-terminal change, a recommendation to skip prototype cannot override
  its required assessment/observations, even with high confidence. A pending upstream correction
  likewise cannot be dropped on a model's recommendation.
- Given adequate unchanged requirements documents, a judgment favoring no additional requirements
  work still leads to direct current-worktree evaluation, not an existing-document skip.
- With a controlled unavailable or malformed API response, an expired call, missing credentials,
  or evidence that cannot resolve applicability, the normal author/evaluator path proceeds and no
  automatic skipped result appears. With JEv disabled, this path makes no JEv request.
- Interrupt after retaining an applicability decision and resume with unchanged inputs: its basis,
  response/fallback and Nexus reason remain attributable, and no replacement API judgment is made
  for that decision. A subsequent captured scope correction is reassessed through the existing
  route. A pre-integration retained run continues without resetting work or allowances.
- An accepted JEv-assisted preparation skip does not let implementation bypass a failing configured
  check, current-revision review or merge/completion evidence.

### Current-worktree evaluation requirements

Affected categories are preparation evaluation, implementation review, role/report contracts,
cross-round context, retained history and delivery protection. Participants are all preparation
authors and evaluators, developers, reviewers and operators continuing retained work. The journey
is: inspect the captured ticket, current shared documents and previous reports -> preserve sound
content or repair defects -> evaluate within the selected stage -> hand off implementation ->
develop and verify -> review the task-relevant implementation -> repair current problems as needed
-> merge and confirm required CI. Reports carry context through the existing loops without a
tracked per-finding lifecycle.

Activities and rules:

1. Requirements, UX/UI and Architecture evaluators assess the ticket's requested changes against
   the current authoritative documents in the shared worktree. Accept content meeting the
   [bounded material-quality standard](agent-runtime/preparation-roles.md#bounded-material-quality) regardless
   of who wrote it, whether this author changed it, or its commit history. Architecture's
   implementation plan still receives evaluation.
2. Existing documents meeting that standard need no mandatory document citations, special existing-document
   skip proposal or historical approval reuse. Authors may leave those documents unchanged;
   missing edits or citation lists alone cannot block evaluation or acceptance. An irrelevant stage
   still permits a normally evaluated applicability skip. Applicable prototype evaluation inspects
   the current preview and retains both roles' required observation evidence.
3. Later-stage edits to a shared document do not mechanically invalidate completed document-stage
   verdicts or force another cycle. Assess a concrete input defect through the existing findings
   and upstream-return route. Changed human intent and explicit pending corrections still require
   reassessment. Historical reports remain attributable evidence, not approval of current content.
4. Remove the dependent document-citation and historical approval-reuse validation, state and
   tests. Remove cross-round finding bookkeeping project-wide, including Develop/Review and every
   preparation author/evaluator loop: stable finding IDs, mandatory `findingResponses`, per-finding
   response/status records, `priorFindings` dispositions and cross-round matching validators, together
   with their supporting state, prompts, documentation and tests. Previous reports supply context;
   authors explain corrections, disagreements and remaining problems narratively, and evaluators
   judge whether earlier problems were addressed. Keep actionable current findings with evidence,
   consequences and repair guidance; unresolved problems do not disappear merely because tracking
   fields are removed. Preserve stage routing and concrete upstream correction requests.
5. Under the [report requirements](agent-runtime/report-requirements.md), the developer writes its
   narrative in assigned Markdown and returns only status. Nexus saves `development.json` as the
   observed outcome and report association. The reviewer receives the Markdown reports, functional
   developer outcome, task requirements and verification evidence, writes its assessment/current
   findings in Markdown and returns only verdict.
6. Implementation review scope follows task correctness. The reviewer assesses all relevant code
   as it sees fit, including pre-existing code when correction is necessary. Neither the latest
   diff nor changes since the last reviewed commit limit that scope. Bind the assessment to the
   revision actually reviewed; an earlier approval cannot authorize a changed head.
7. Validate control/functional fields, report readability and applicable input/revision binding.
   Approval requires no current blocking problem as an agent judgment explained in Markdown;
   do not parse findings or validate verdict consistency against prose. Optional suggestions alone
   do not force repair. Invalid reports and unfinished assessments follow existing failure handling,
   without invented findings or approval. Align
   authoritative documentation, role instructions, context construction, report contracts and
   affected tests. Preserve finite allowances, action-owned artifacts, applicable prototype
   inspection, review, merge and required CI gates.
8. Continue against current main while preserving the delivered bounded citation and shared-document
   loop repairs from PR139, PR140 and PR142. Retain existing reports as readable history, without
   demanding retroactive per-finding responses or dispositions. Continue retained work without
   replacing its checkout or branch, discarding work or history, overlooking unresolved problems,
   or resetting allowances. Deliver through configured preparation, implementation, review, merge
   and required CI. Preserve active runtimes; activate a changed runtime only after active users exit,
   under [installation activation](application.md#installation-activation).

Observable acceptance examples:

| Situation | Observable result |
| --- | --- |
| Existing requirements, UX/UI or architecture documents satisfy the ticket, and the author makes no document edits or supplies no document citations | The responsible evaluator accepts them directly; authorship, commit history and absence of an existing-document skip do not block acceptance. Architecture still supplies an evaluated implementation plan. |
| Current documents omit a requested rule or contradict the ticket | The evaluator identifies the concrete omission or contradiction and required correction through normal findings; the corrected current documents receive evaluation. |
| Requirements and Architecture both edit the preparation-stage document, and the later edit remains compatible with the requested outcome | The route advances without returning to Requirements merely because historical file bindings differ. No citation/approval-reuse cycle is required. |
| A later stage discovers a genuine defect in an earlier stage's input, or the human changes the requested outcome | Normal upstream correction and reassessment occur; document evaluation does not erase finding obligations or treat old approval as current assessment. |
| A stage is irrelevant, or a prototype is applicable | The irrelevant stage receives an evaluated applicability skip without mandatory document citations. The applicable prototype receives current preview inspection with the existing required evidence; adequate prose or historical approval cannot replace it. |
| Any preparation author/evaluator loop or Develop/Review enters a repair round | Previous reports are supplied as context. The author/developer explains corrections or disagreements narratively; the evaluator/reviewer judges the current result. No stable finding IDs, response/status records, dispositions or cross-round matching are required. |
| A developer completes a repair, disagrees with a previous review or leaves a problem unresolved | The status-only response is saved with its observed metadata and Markdown association in `development.json`; Markdown explains changes, verification, corrections, disagreements and remaining problems. A missing `findingResponses` array is not a rejection reason. |
| A reviewer assesses an implementation after an earlier review | It receives previous reviews, developer artifacts, task requirements and verification evidence, writes its assessment and actionable findings in Markdown, and returns only verdict for the reviewed revision. Resolved historical problems need no disposition record; unresolved problems remain grounds for current findings. |
| Task correctness requires correcting pre-existing code outside the latest diff | The reviewer may inspect and report that defect with evidence, impact and repair guidance. Its scope follows the task rather than a commit range; unrelated cleanup is not required. |
| Current evidence shows no blocking problems, or shows a blocking defect | Preparation applies the bounded material-quality standard; delivery retains its review acceptance boundary. Optional suggestions do not block acceptance. A blocking defect requires changes with actionable current findings; control/functional-data, report-readability and applicable binding checks reject unusable output; prose is not parsed for verdict consistency or cross-round matching. |
| A run resumes with reports written under the former finding contract | The reports remain readable historical context. Continuation uses the simplified current contract without rewriting history, requiring retroactive lifecycle records or resetting allowances. |
| A retained run resumes or the change is delivered | Retained work, histories, findings and consumed allowances survive. An active runtime is not disturbed; completion still requires normal review, merge and required CI evidence. |

Source: the captured HARN-103 issue description. Its project-wide findings cleanup supersedes the
earlier limitation to Develop/Review and preserves direct evaluation of current documents.

No material product decision is unsettled. This changes no reporting-terminal interaction and adds
no new evaluation stage, dependency engine or retry mechanism. Technical design of report contracts,
context construction, removal of the superseded mechanisms and compatibility of retained records
belongs to Architecture within these requirements.

## Requirements

Requirements Analyst defines affected categories, journey, activities, rules and observable
acceptance examples from source intent and existing requirements. Requirements Evaluator checks
clarity, coverage, contradictions and unnecessary scope and seeks simpler rules and stronger
acceptance examples. All preparation stages apply the [bounded material-quality
standard](agent-runtime/preparation-roles.md#bounded-material-quality), including direct assessment
of existing work without manufactured edits. Existing requirements meeting it receive direct
acceptance. Product choices
requiring author agreement remain explicit questions; an agent does not manufacture human approval. Accepted
requirements and evaluation supply UX and Architecture.

## UX Proposal

UX Designer proposes navigation, interactions and feedback, explains choices and relates them to
requirements and existing experience design. UX Evaluator walks acceptance examples and seeks less
effort, discoverability, consistency and clear relevant loading/error/recovery behavior. No changed
interaction permits a skip. Technical design belongs to Architecture; no early technical-design
assessment is required. Outputs are the accepted proposal and questions for the prototype to resolve.

## Storybook Refinement

Prototype Developer builds/adapts the proposed journey with representative data and relevant states.
Both Prototype Developer and Prototype Evaluator run and interact with the preview using working
browser and image-inspection capabilities. Exercise relevant journeys and states from the acceptance
examples and UX questions, and inspect rendered images and layout. Acceptance of an applicable
prototype requires concrete observations identifying the inspected prototype revision, preview,
journeys/states, interactions and image/layout evidence. Text-only review, controlled test responses
or an unavailable preview cannot establish inspected usability.

Failed observations enter the prototype author/evaluator repair loop, or return to the responsible
earlier stage when its input needs correction. Build/tool failures are repaired at their owning
boundary; they are not new product requirements or a reason to invent an applicability skip.

Revise the prototype and UX documentation together when an interaction decision changes. No useful
prototype work permits an evaluated skip. Outputs identify stories/preview, the retained prototype
revision and evaluation evidence. Mocked behavior establishes usability, not persistence, account
isolation, service integration or deployed behavior. Prototype code stays on retained preparation
work and is supplied to implementation for reuse.

### Prototype assessment requirements

These requirements govern prototype assessment, role instructions and report contracts, retained
preparation evidence, changed-path handling, continuation and affected documentation/tests.
Participants are prototype authors and evaluators, downstream agents reading their evidence, and
operators resuming preparation. The requested outcome is that genuine browser assessment is judged
against the ticket and current worktree, without rejection caused by a mismatch between edited-file
lists and inspected-file inventories.

The journey is: preserve or adapt current prototype work -> commit authored changes -> author
inspects the running preview -> evaluator independently inspects the current preview against ticket
scope -> retain reports, screenshots, minimal outcomes and observed attribution -> repair material
problems or continue preparation and implementation. Retained work resumes through those same gates.

Activities and rules:

1. The prototype evaluator assesses the current worktree and rendered preview against the captured
   ticket, acceptance examples and applicable UX questions. Declared changed documents and source
   paths serve only to commit authored work; they neither enumerate assessment coverage nor limit
   inspection to edited files. Adequate existing prototype work needs no manufactured edits.
2. Remove assessed-file inventories, per-file observation revisions and presence/deletion bindings,
   persisted per-file acceptance content, and the dependent scope/content comparisons, schemas,
   instructions and tests. No replacement assessed-file inventory, file-coverage declaration or
   per-file hash is required to accept, finalize, replay or consume prototype evidence.
3. Keep each role's own detailed browser assessment and screenshots as readable round artifacts:
   preview command/URL, exercised journeys and states, actions, observed results and visual/layout
   conclusions. Both roles perform real browser interaction and image inspection; the author's
   evidence cannot replace independent evaluator inspection. Coverage and evidence quality are
   evaluator judgments grounded in the ticket, not comparisons of file lists or deterministic
   parsing of narrative.
4. Keep minimal functional outcomes and Nexus-observed task, role/profile, revision and report
   association metadata. Preserve report integrity and the existing current-assessment checks for
   fresh decisions and interrupted finalization. An assessment whose inputs change before it is
   finalized receives normal reevaluation; removing per-file bindings cannot attach an old report
   to a different current assessment.
5. Retained preparations remain resumable without old file inventories or invented observations.
   Preserve original reports, screenshots, outcome attribution, checkout/branch, explicit pending
   corrections and consumed allowances. Former inventory fields may remain readable history but
   cannot gate continuation. Missing or unusable required browser evidence follows existing recovery
   or reassessment; it cannot become acceptance or a fabricated applicability skip. Concrete changes
   that make earlier browser evidence inadequate require fresh assessment through normal routes.
6. Align affected documentation, runtime/profile instructions, saved-record handling, evidence
   consumers and tests with these rules, removing dependent validation/state rather than leaving
   obsolete machinery active elsewhere. Preserve evaluated inapplicability skips, upstream correction,
   finite allowances and implementation review, merge and required CI gates.
7. After reviewed delivery, merge and required CI, activate the checked revision under
   [installation activation](application.md#installation-activation), preserving active runtimes and
   retained work. Continue the retained KAN work through normal gates with the genuine available
   evidence; activation or compatibility handling cannot manufacture approval or reset checkpoints.

Observable acceptance examples:

| Situation | Observable result |
| --- | --- |
| A prototype round declares two edited files while genuine browser evidence discusses twelve relevant files, as reported for KAN-83 round 2 | The evaluator judges the current preview and worktree against the ticket. A file-count/list mismatch causes no rejection during author/evaluator processing, finalization, replay or downstream continuation. Acceptance still requires adequate independent browser assessment and no material problem. |
| Adequate prototype work already exists and the author declares no changed paths | Both roles inspect the current preview and retain their own evidence. Empty changed-path declarations neither prevent evaluation nor require a reuse skip or new edits. |
| An unchanged component outside the edited-file list breaks a ticket journey | The evaluator reports the concrete defect and required correction; the changed-file declaration cannot exclude it from assessment. |
| A new observation includes preview details, exercised states/actions, observed behavior and readable screenshots, but no file inventory or per-file revisions | It is usable evidence under the minimal response contract; absence of removed bookkeeping is not a validation failure. Nexus records task/profile/revision/report attribution separately. |
| An applicable prototype has no evaluator browser inspection, an unreadable required screenshot, or only a build-success claim | It receives no acceptance. Existing recovery or repair retains the available evidence and reason without inventing inspection or a product requirement. |
| Current assessment inputs change after evaluator invocation and before finalization | The old decision is not finalized for the changed inputs; normal reevaluation is required without per-file evidence comparison. |
| A completed retained preparation contains genuine browser reports/screenshots and former per-file fields, or lacks the removed inventories | It resumes under the current contract with original evidence and attribution intact. Removed fields are neither required nor compared; no replacement inventory or fabricated evidence is produced. |
| A retained evaluation was rejected solely because its genuine observation listed more files than the changed-path declaration | Reconcile the obsolete rejection using the retained output and diagnosis, then continue through current report/evaluation gates. No file-inventory repair is demanded, and history is not rewritten into approval. |
| Retained required evidence is missing, human intent changed, or a concrete prototype defect remains unresolved | Normal recovery, correction or reassessment applies. Inventory removal cannot turn an unfinished or invalid assessment into approval, erase pending corrections or renew allowances. |
| The author declares a source edit or stage-owned deletion alongside unrelated local work | Only declared authored work is committed under existing path-scoped ownership checks; unrelated work is preserved. Those paths do not become an evaluation coverage list. |
| Documentation, role instructions or a downstream evidence consumer still requires per-file bindings | The change is incomplete until the superseded requirement and its dependent machinery/tests are removed consistently. |
| Delivery is approved but required CI has failed, or the old installation still has active users | The runtime is not switched. After delivery/check and runtime-use conditions are satisfied, the resolved launch target identifies the checked revision and retained KAN work continues without losing work, history or allowances. |

Source: the captured HARN-120 issue description. This supersedes per-file prototype observation
protections while retaining browser assessment and report/revision attribution. No reporting-terminal
change is requested; existing UX/prototype applicability rules apply to Nexus itself. No material
product decision is unsettled. Evidence representation and retained-reader compatibility mechanisms
belong to Architecture; installation activation and KAN continuation belong to delivery/operations.

## Architecture

Architect identifies supporting responsibilities, public contracts and data handling under the
project's design principles. Architecture Evaluator traces required outcomes and checks feasibility,
ownership, failure handling, contract completeness and opportunities to simplify. If no feasible
clean design supports the inputs, return a concrete finding to Requirements, UX or Storybook.
After correction, proceed forward again, reevaluating affected outputs and retaining usable work.
Existing design meeting the bounded material-quality standard receives direct acceptance, while
the implementation plan still requires evaluation.

Architecture also produces an evaluated implementation plan: one or more bounded tasks, dependencies
and completion criteria that collectively deliver the accepted outcome. There is no Planner workflow,
role or Jira status.

## Documentation and implementation handoff

After Architecture and its implementation plan are accepted, the parent creates and links one or
more concise implementation tickets from that plan. Architecture owns the plan; the parent retains
all source creation and linking operations. Tickets reference the source issue, accepted preparation
outcomes and any retained prototype evidence. There is no preparation-only PR publication or merge
gate before this handoff. If existing documents suffice, retain the current evaluator decision
without manufacturing changes or an existing-document skip.

The first planned implementation ticket continues the preparation checkout and branch, preserving
its committed documents and retained prototype work. Its PR publishes the committed preparation
documents together with that ticket's implementation. Later planned tickets start from the merged
base containing the earlier delivered work. Each implementation ticket has its own PR; do not
accumulate the plan's implementation into one final feature PR. Checkout reconciliation preserves
retained work and reports incompatible repository or branch identity rather than silently replacing
it. The precise workspace and admission contracts belong to Architecture.

Validate the dependency graph before applying handoff effects and create tasks in a topological
order. Rank the handed-off implementation tickets ahead of remaining preparation tickets, with
prerequisites before dependent tasks in actual Jira rank order, under
[implementation before further preparation](#implementation-before-further-preparation).
A dependent ticket cannot start implementation before its prerequisites
have completed with merge/check evidence. Retain created ticket identities as operations succeed.
Reconcile uncertain creation against the source issue and planned task before retrying; interruption must not
duplicate tickets. Record each new ticket's initial admission status separately from later source
changes. On replay, accept that recorded initial state while admission is unfinished, or the
already-applied configured ready status. An unexpected retained status requests attention and is
preserved; an unknown initial state cannot authorize a transition.

After every planned ticket exists and is linked, move the original to Done with a preparation-complete
comment and the implementation links. The original never enters finite delivery. Even one
implementation task gets a new ticket. Original Done means the handoff exists, not feature delivery.
Created tickets start at the configured Implementation/ready status and compete in normal source
rank order after the handoff has placed them ahead of remaining preparation work.

### Implementation before further preparation

The affected categories are handoff ranking, prerequisite ordering and serial queue selection.
The operator's journey is: accept Architecture and its plan -> hand off implementation tickets ->
finish available implementation -> select the next preparation ticket. Activities are ranking the
handoff, selecting one eligible ticket and completing its normal delivery before selecting again.

Rules:

1. A completed Architecture handoff places every implementation ticket from its accepted plan
   ahead of every remaining preparation ticket in the same project's queue. Preparation tickets
   are those routed to Idea Refinement, Requirements, UX Proposal, Storybook Refinement or
   Architecture. This applies to a one-ticket plan and to independent tasks as well as dependents.
2. The resulting implementation order respects all prerequisites. A dependent can start only
   after its prerequisites have the existing required delivery completion evidence. Implementation
   priority does not waive verification, review, merge or required checks.
3. With that handoff order, the serial parent finishes eligible implementation before starting
   the next preparation. An implementation ticket is available when it meets the existing selection
   and prerequisite-completion rules. When no implementation is available, normal source-rank
   selection may proceed to eligible preparation; priority does not make a blocked ticket eligible.
4. Selection continues to follow source rank, and handoff replay preserves planned ticket
   identities and finishes missing ranking effects before reporting a completed handoff. No parallel
   ticket execution or separate selection-priority mechanism is introduced. This change gives no
   new priority rule among unrelated implementation tickets.

Observable acceptance examples (P and Q are eligible preparation tickets):

| Situation | Observable result |
| --- | --- |
| P and Q precede a newly handed-off implementation ticket I in source rank | On completed handoff, I ranks ahead of both P and Q. The serial parent completes I's normal delivery before starting P or Q. |
| A handoff produces A, B depending on A, and C depending on both A and B, while P is queued | All three rank ahead of P, with A before B before C. A completes before B starts, B completes before C starts, and C completes before P starts. |
| A handoff produces A, B depending on A, C depending on A, and D depending on both B and C | All four rank ahead of P and Q; A precedes B and C, and both B and C precede D. The parent delivers them one at a time; either order of B and C is acceptable. |
| A handed-off implementation ticket already ranks ahead of P and Q and satisfies its prerequisites | Completed handoff leaves it ahead of preparation; the serial parent selects it in source order. |
| Every remaining implementation ticket is waiting for author feedback or lacks prerequisite merge/check completion, while P is eligible | The parent may select P. The unavailable implementation tickets are neither selected nor declared complete. |
| Handoff ranking is interrupted before every planned ticket is ahead of P and Q | The handoff is not reported complete. Replay finishes the missing ranking using the same tickets; completed handoff leaves every planned ticket ahead of P and Q with prerequisites first. |

## Finite Delivery

The parent invokes the existing development/verification/delivery/review/repair/completion machine
for one selected implementation ticket. Move selection and Jira publication to parent-owned actions
and supplied boundary actors. Keep verified-head publication, auto-merge, complete findings/profile
escalation, GitHub review publication and required pre/post-merge checks. On admission of retained
work, RouteDeliveryEntry chooses the first unfinished phase from development/verification/delivery
artifacts; an already-delivered revision continues publication/review rather than opening another
coding round. An active child restored from a snapshot keeps its checkpoint. Completion returns
merge/check evidence; the parent marks the ticket Done only afterward. Parent-owned actors refresh source input
at the coding boundaries that need it and publish milestone feedback before the child proceeds.

The existing queue command runs the project parent. HARN uses its configured To Do ready mapping.
There is no parallel legacy Jira selector.

## Profiles

Separate author/evaluator invocations even when their profile is identical. Profiles configure model,
effort and tools; roles own complete constant instructions. Stage context supplies declared inputs
and findings. Jira publication is outside role tools. Both prototype roles require working
browser/image inspection capabilities. Every preparation author and evaluator has explicit shared
memory search/save access when memory is enabled, under the
[Memory integration](memory/integration.md#agent-use) guidance. AnalyzeExperience remains the sole
automatic memory consumer.

| Workflow | Author roles | Evaluator |
| --- | --- | --- |
| Idea Refinement | Researcher, Project Guide, Idea Editor: nexus-sol | Challenger: nexus-astra |
| Requirements | Requirements Analyst: nexus-sol | Requirements Evaluator: nexus-sol |
| UX Proposal | UX Designer: nexus-sol | UX Evaluator: nexus-sol |
| Storybook Refinement | Prototype Developer: nexus-flash -> nexus-sol | Prototype Evaluator: nexus-sol |
| Architecture | Architect: nexus-sol | Architecture Evaluator: nexus-astra |
| Finite Delivery | Developer: nexus-flash -> nexus-sol -> nexus-astra | Reviewer: nexus-astra |

Flash is DeepSeek Flash at max effort; Sol is GPT-6.1 Sol at high effort; Astra and recovery are
GPT-6 Astra at high effort. Parent operations are deterministic. Prototype escalation is bounded by
its stage allowance and never downgrades. Finite Delivery retains StartDevRound's repair/promotion
policy with the expanded ladder.

## Persistence, observation and verification

Persist one composed parent snapshot per project, including invoked child snapshots. Each stage
owns its artifact paths/schemas; reports and source handoffs stay outside the snapshot. Runner saves
and restores XState child snapshots without interpreting internal state trees. Track all started
bound operations, including child operations, and drain them on failure under the runner's existing
completion contract. All roles share attributable activity events and terminal panes.

AnalyzeExperience captures successful preparation once, after the final implementation handoff,
with the whole retained preparation evidence under its
[preparation handoff requirements](task-engine/actions/analyze-experience.md#preparation-handoff-requirements).
Successful stage publication, evaluated skips and upstream correction routing do not separately
trigger analysis. Existing waiting/exhaustion and selected-work failure handoffs, idea publication
and finite completion retain their analysis routes. Preserve the business destination if learning
is unavailable. Do not analyze intermediate revisions or empty selection.

Test real parent/child composition, later-stage entry, evaluated skips, revision binding, upstream
return/reassessment, feedback resumption, finite limits, missing inputs, source-write failure/retry,
duplicate-free ticket creation and restart during a child or its handoff. Run children with supplied
inputs and no Jira dependency. Preserve all finite delivery review/merge/check guarantees. Controlled
responses verify orchestration; actual Storybook usability requires observed browser interaction.

Nexus/HARN documentation must describe this workflow consistently, including preparation role memory
access and removal of obsolete bootstrap and preparation-publication behavior. Architecture aligns
the affected component contracts and their owning documents. All development uses WSL checkouts;
Nexus runs in a separate visible terminal attached to WSL with `TERM=xterm-256color` and
`COLORTERM=truecolor`. Retain checkout reconciliation and these terminal requirements in app-change
guidance without adding another approval or retry mechanism. Do not restore inconclusive review
verdicts.

## Observable acceptance examples

| Given / activity | Observable result |
| --- | --- |
| Requirements commits a rule and UX then changes the same document | UX sees the Requirements commit in the same real Git checkout and branch. Storybook and Architecture receive that accumulated history; no cross-checkout assembly overwrites either change. Runtime author/evaluator working directories resolve to the real checkout. |
| A stage authors work, receives findings and responds | Its evaluator assesses the current content and narrative response with earlier reports as context, judges whether earlier problems remain without per-finding tracking, and applies the bounded material-quality standard with nonblocking suggestions explained. No combined documentation review follows Architecture. |
| Existing Requirements, UX/UI or Architecture documents satisfy the ticket | The evaluator accepts the current documents directly without mandatory document citations or an existing-document skip proposal. Architecture still supplies an evaluated implementation plan. |
| No useful UX/prototype work applies | The evaluator assesses the proposed applicability skip. An accepted skip advances without an invented document, prototype or browser observation. |
| Nexus preparation changes internal workflow without an explicit reporting-terminal change | UX and Prototype propose skips under docs/ux-ui.md and their evaluators assess applicability. The existing reporting terminal is retained; no terminal redesign or mock Jira/PR navigation is added. |
| A stage discovers an earlier input must change | It returns the concrete problem to its owning earlier stage. Correction occurs in the same retained workspace, and affected downstream outputs are reevaluated before handoff. Old approval cannot authorize changed content or changed relied-on inputs. |
| A human scope correction removes previously accepted UI scope from an internal Nexus task | Requirements is corrected and evaluated, then UX and Prototype reconcile their obsolete contributions and obtain evaluated skips before Architecture resumes. Historical revisions and observations remain attributable evidence; affected acceptances are invalidated and cannot authorize reuse of the removed work. |
| Execution restarts during correction, a stage handoff or allowance exhaustion | The retained checkout/branch, completed history, findings, input/revision identities and consumed finite allowances remain available. Restart neither revives stale acceptance nor grants extra rounds/returns. |
| An applicable Storybook prototype represents a journey and its relevant states | Both roles use a running preview with actual browser interaction and image/layout inspection. Saved evidence identifies what was inspected and observed at the accepted revision; simulated responses alone cannot establish acceptance. |
| Preview interaction reveals a navigation/layout failure or a wrong upstream assumption | The prototype returns to its repair loop or the responsible earlier stage and requires fresh observation after correction. An unavailable browser/preview yields no acceptance or manufactured applicability skip. |
| Nexus implements browser/image-verification capabilities while its own prototype stage is skipped | An isolated implementation test fixture supplies a running Storybook preview with a journey and relevant states. Both prototype author and evaluator capabilities perform real browser interaction and image/layout inspection with concrete evidence. Fixture observations verify those capabilities without reviving the removed Nexus UI mock or replacing the evaluated applicability skip. |
| Architecture accepts a plan with two implementation tickets | Both tickets are created and linked to the source and accepted evidence; the original becomes Done as a handoff. No preparation-only PR is opened, and no claim of feature delivery is made. |
| Ticket creation/linking or the original Done update is interrupted | Replay reconciles recorded/source identities and performs missing effects. Exactly the planned tickets and links exist; unexpected human status changes remain preserved. |
| The two planned tickets are delivered, with the second depending on the first | The first continues the actual preparation checkout/branch and delivers its committed documents with implementation in PR 1. After its merge/check completion, the second starts from that merged base and delivers PR 2. Both rank ahead of remaining preparation, prerequisites are respected, and there is no final aggregate PR. |
| An implementation head changes after review, verification fails, a required check fails, or merge/post-merge evidence is absent | Earlier review approval cannot authorize the changed head, and the ticket cannot complete without current verification, actual revision-specific review and required merge/check evidence. Invocation faults produce no invented verdict or unrelated retry path. |
| Preparation roles run with memory enabled and Nexus is launched for development | Every author/evaluator can explicitly search/save shared memory; no new automatic recall/ingestion is introduced. Documentation reflects these roles and the workflow, and Nexus uses a visible WSL terminal with color support. |

No product decision is left unsettled by these requirements. Supporting workspace contracts,
browser/image tooling and implementation-task decomposition are Architecture decisions, not new
product scope.
