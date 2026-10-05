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
its consequence and the correction needed. Idea refinement retains approved, unsuitable,
author-decision-needed and attempts-exhausted meanings. Finite Delivery returns completed or blocked
with its revision-specific evidence. Provider/storage faults remain execution failures.

The parent validates the result, saves handoff evidence, finishes Jira publication/transition, then
enters the next child. Save outputs before publication. An accepted local result cannot advance past
a failed source write. Repetition inspects retained publication identities and current source state,
finishing only missing effects. Machine context contains control values/references, not full reports.

## Evaluation and stage applicability

Each preparation stage begins with its author assessing the requested change and stage applicability.
An irrelevant stage permits a skip with reasons; adequate existing documents receive normal
evaluation without a special existing-document skip. Accepted skips are durable results and advance
immediately, without manufacturing a document or prototype. Missing information requires clarification
or an upstream return.

The normal loop is Author -> Evaluate -> Author response/revision -> Evaluate. Evaluate the exact
current revision and responses; earlier approval cannot approve changed content. Authors can revise,
answer or rebut mistaken findings. Evaluators explicitly resolve prior findings and distinguish
necessary changes from optional suggestions.

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
inspection remains bound to the inspected sources. Restart retains the workspace, findings,
completed round history and cumulative allowances.

Seek improvements as well as omissions: simpler rules, clearer journeys, lower user effort, fewer
unnecessary interactions and maintainable designs. Click count alone is not a goal; preserve clarity,
accessibility and error prevention. Acceptance means stage criteria are met, not that no imaginable
improvement remains. Optional suggestions do not prevent acceptance.

Configure finite stage-round and upstream-return allowances. Count them across restarts; focused help
cannot bypass the limit. Exhaustion retains findings and requests attention, without declaring the
idea unsuitable. Waiting for Feedback retains the originating stage and specific question. Human
clarifications govern intent when resumed.

### Current-worktree evaluation requirements

Affected categories are document evaluation, preparation role/report contracts, stage continuation
and handoff. Participants are Requirements, UX/UI and Architecture authors and evaluators, the
prototype roles when applicable, and operators continuing retained work. The journey is: inspect
the captured ticket and current shared documents -> preserve adequate content or correct omissions
-> evaluate within the selected stage -> resolve necessary findings -> advance through the normal
route and implementation handoff.

Activities and rules:

1. Requirements, UX/UI and Architecture evaluators assess the ticket's requested changes against
   the current authoritative documents in the shared worktree. Accept adequate content regardless
   of who wrote it, whether this author changed it, or its commit history. Architecture's
   implementation plan still receives evaluation.
2. Existing sufficient documents need no mandatory document citations, special existing-document
   skip proposal or historical approval reuse. Authors may leave adequate documents unchanged;
   missing edits or citation lists alone cannot block evaluation or acceptance. An irrelevant stage
   still permits a normally evaluated applicability skip. Applicable prototype evaluation inspects
   the current preview and retains both roles' required observation evidence.
3. Later-stage edits to a shared document do not mechanically invalidate completed document-stage
   verdicts or force another cycle. Assess a concrete input defect through the existing findings
   and upstream-return route. Changed human intent and explicit pending corrections still require
   reassessment. Historical reports remain attributable evidence, not approval of current content.
4. Remove the dependent document-citation and historical approval-reuse validation, state and
   tests, and align authoritative documentation with the contracts actually supplied to roles.
   Preserve normal findings and responses, stage routing, finite allowances, action-owned artifacts,
   applicable prototype inspection and implementation review, merge and required CI gates.
5. Continue retained work without replacing its checkout or branch, discarding its work or history,
   clearing unresolved findings, or resetting allowances. Deliver through normal preparation,
   implementation, review, merge and required CI. Activate a changed runtime only after active users
   exit, under [installation activation](application.md#installation-activation).

Observable acceptance examples:

| Situation | Observable result |
| --- | --- |
| Existing requirements, UX/UI or architecture documents satisfy the ticket, and the author makes no document edits or supplies no document citations | The responsible evaluator accepts them directly; authorship, commit history and absence of an existing-document skip do not block acceptance. Architecture still supplies an evaluated implementation plan. |
| Current documents omit a requested rule or contradict the ticket | The evaluator identifies the concrete omission or contradiction and required correction through normal findings; the corrected current documents receive evaluation. |
| Requirements and Architecture both edit the preparation-stage document, and the later edit remains compatible with the requested outcome | The route advances without returning to Requirements merely because historical file bindings differ. No citation/approval-reuse cycle is required. |
| A later stage discovers a genuine defect in an earlier stage's input, or the human changes the requested outcome | Normal upstream correction and reassessment occur; document evaluation does not erase finding obligations or treat old approval as current assessment. |
| A stage is irrelevant, or a prototype is applicable | The irrelevant stage receives an evaluated applicability skip without mandatory document citations. The applicable prototype receives current preview inspection with the existing required evidence; adequate prose or historical approval cannot replace it. |
| A retained run resumes or the change is delivered | Retained work, histories, findings and consumed allowances survive. An active runtime is not disturbed; completion still requires normal review, merge and required CI evidence. |

No material product decision is unsettled. This changes no reporting-terminal interaction and adds
no new evaluation stage, dependency engine or retry mechanism. Technical contracts, removal of the
superseded mechanisms and compatibility of retained records belong to Architecture within these
requirements.

## Requirements

Requirements Analyst defines affected categories, journey, activities, rules and observable
acceptance examples from source intent and existing requirements. Requirements Evaluator checks
clarity, coverage, contradictions and unnecessary scope and seeks simpler rules and stronger
acceptance examples. Adequate existing requirements receive direct acceptance. Product choices
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

## Architecture

Architect identifies supporting responsibilities, public contracts and data handling under the
project's design principles. Architecture Evaluator traces required outcomes and checks feasibility,
ownership, failure handling, contract completeness and opportunities to simplify. If no feasible
clean design supports the inputs, return a concrete finding to Requirements, UX or Storybook.
After correction, proceed forward again, reevaluating affected outputs and retaining usable work.
Existing sufficient design receives direct acceptance, while the implementation plan still requires
evaluation.

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
order. Rank prerequisites before dependent tasks using actual Jira
rank order, moving a premature dependent after its last prerequisite without moving it ahead of
unrelated higher-ranked work. A dependent ticket cannot start implementation before its prerequisites
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
rank order rather than bypassing higher-ranked project work.

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

AnalyzeExperience remains a shared terminal-handoff action after published success, skip,
waiting/exhaustion or selected-work failure and finite completion. Preserve the business destination
if learning is unavailable. Do not analyze intermediate revisions or empty selection.

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
| A stage authors work, receives findings and responds | Its evaluator assesses the current committed content and complete responses, explicitly resolves earlier findings and can accept adequate work despite optional suggestions. No combined documentation review follows Architecture. |
| Existing inputs suffice, or no useful UX/prototype work applies | The author supplies concrete references and the evaluator accepts or rejects the skip. An accepted skip advances without an invented document, prototype or browser observation. |
| Nexus preparation changes internal workflow without an explicit reporting-terminal change | UX and Prototype propose skips under docs/ux-ui.md and their evaluators assess applicability. The existing reporting terminal is retained; no terminal redesign or mock Jira/PR navigation is added. |
| A stage discovers an earlier input must change | It returns the concrete problem to its owning earlier stage. Correction occurs in the same retained workspace, and affected downstream outputs are reevaluated before handoff. Old approval cannot authorize changed content or changed relied-on inputs. |
| A human scope correction removes previously accepted UI scope from an internal Nexus task | Requirements is corrected and evaluated, then UX and Prototype reconcile their obsolete contributions and obtain evaluated skips before Architecture resumes. Historical revisions and observations remain attributable evidence; affected acceptances are invalidated and cannot authorize reuse of the removed work. |
| Execution restarts during correction, a stage handoff or allowance exhaustion | The retained checkout/branch, completed history, findings, input/revision identities and consumed finite allowances remain available. Restart neither revives stale acceptance nor grants extra rounds/returns. |
| An applicable Storybook prototype represents a journey and its relevant states | Both roles use a running preview with actual browser interaction and image/layout inspection. Saved evidence identifies what was inspected and observed at the accepted revision; simulated responses alone cannot establish acceptance. |
| Preview interaction reveals a navigation/layout failure or a wrong upstream assumption | The prototype returns to its repair loop or the responsible earlier stage and requires fresh observation after correction. An unavailable browser/preview yields no acceptance or manufactured applicability skip. |
| Nexus implements browser/image-verification capabilities while its own prototype stage is skipped | An isolated implementation test fixture supplies a running Storybook preview with a journey and relevant states. Both prototype author and evaluator capabilities perform real browser interaction and image/layout inspection with concrete evidence. Fixture observations verify those capabilities without reviving the removed Nexus UI mock or replacing the evaluated applicability skip. |
| Architecture accepts a plan with two implementation tickets | Both tickets are created and linked to the source and accepted evidence; the original becomes Done as a handoff. No preparation-only PR is opened, and no claim of feature delivery is made. |
| Ticket creation/linking or the original Done update is interrupted | Replay reconciles recorded/source identities and performs missing effects. Exactly the planned tickets and links exist; unexpected human status changes remain preserved. |
| The two planned tickets are delivered, with the second depending on the first | The first continues the actual preparation checkout/branch and delivers its committed documents with implementation in PR 1. After its merge/check completion, the second starts from that merged base and delivers PR 2. Dependencies and normal source ranking are respected; there is no final aggregate PR. |
| An implementation head changes after review, verification fails, a required check fails, or merge/post-merge evidence is absent | Earlier review approval cannot authorize the changed head, and the ticket cannot complete without current verification, actual revision-specific review and required merge/check evidence. Invocation faults produce no invented verdict or unrelated retry path. |
| Preparation roles run with memory enabled and Nexus is launched for development | Every author/evaluator can explicitly search/save shared memory; no new automatic recall/ingestion is introduced. Documentation reflects these roles and the workflow, and Nexus uses a visible WSL terminal with color support. |

No product decision is left unsettled by these requirements. Supporting workspace contracts,
browser/image tooling and implementation-task decomposition are Architecture decisions, not new
product scope.
