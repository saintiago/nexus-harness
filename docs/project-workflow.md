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

Each preparation stage begins with its author proposing work or a skip with reasons and existing
input references. The evaluator checks that proposal. Accepted skips are durable results and advance
immediately, without manufacturing a document or prototype. Missing information requires clarification
or an upstream return.

The normal loop is Author -> Evaluate -> Author response/revision -> Evaluate. Evaluate the exact
current revision and responses; earlier approval cannot approve changed content. Authors can revise,
answer or rebut mistaken findings. Evaluators explicitly resolve prior findings and distinguish
necessary changes from optional suggestions.

Seek improvements as well as omissions: simpler rules, clearer journeys, lower user effort, fewer
unnecessary interactions and maintainable designs. Click count alone is not a goal; preserve clarity,
accessibility and error prevention. Acceptance means stage criteria are met, not that no imaginable
improvement remains. Optional suggestions do not prevent acceptance.

Configure finite stage-round and upstream-return allowances. Count them across restarts; focused help
cannot bypass the limit. Exhaustion retains findings and requests attention, without declaring the
idea unsuitable. Waiting for Feedback retains the originating stage and specific question. Human
clarifications govern intent when resumed.

## Requirements

Requirements Analyst defines affected categories, journey, activities, rules and observable
acceptance examples from source intent and existing requirements. Requirements Evaluator checks
clarity, coverage, contradictions and unnecessary scope and seeks simpler rules and stronger
acceptance examples. Adequate existing requirements permit a skip. Product choices requiring author
agreement remain explicit questions; an agent does not manufacture human approval. Accepted
requirements and evaluation supply UX and Architecture.

## UX Proposal

UX Designer proposes navigation, interactions and feedback, explains choices and relates them to
requirements and existing experience design. UX Evaluator walks acceptance examples and seeks less
effort, discoverability, consistency and clear relevant loading/error/recovery behavior. No changed
interaction permits a skip. Technical design belongs to Architecture; no early technical-design
assessment is required. Outputs are the accepted proposal and questions for the prototype to resolve.

## Storybook Refinement

Prototype Developer builds/adapts the proposed journey with representative data and relevant states.
Prototype Evaluator runs and interacts with the preview through browser and image-inspection tools,
using acceptance examples and UX questions. Save observed evidence with findings. Text-only review
or an unavailable preview cannot establish inspected usability. Build/tool failures are repaired here,
not by reopening unrelated requirements.

Revise the prototype and UX documentation together when an interaction decision changes. No useful
prototype work permits an evaluated skip. Outputs identify stories/preview, the retained prototype
revision and evaluation evidence. Mocked behavior establishes usability, not persistence, account
isolation, service integration or deployed behavior. Prototype code stays on retained preparation
work and is supplied to implementation for reuse; it is not merged in a documentation-only release.

## Architecture

Architect identifies supporting responsibilities, public contracts and data handling under the
project's design principles. Architecture Evaluator traces required outcomes and checks feasibility,
ownership, failure handling, contract completeness and opportunities to simplify. If no feasible
clean design supports the inputs, return a concrete finding to Requirements, UX or Storybook.
After correction, proceed forward again, reevaluating affected outputs and retaining usable work.
Existing sufficient design permits a skip of technical-design work, while the implementation plan
still requires evaluation.

Architecture also produces an evaluated implementation plan: one or more bounded tasks, dependencies
and completion criteria that collectively deliver the accepted outcome. There is no Planner workflow,
role or Jira status.

## Documentation and implementation handoff

Publish changed authoritative documents in a documentation-only PR and confirm merge/check evidence
before creating implementation tickets. Determine publication necessity from the actual document
contribution reconciled with the current base. Unrelated base changes are not publication changes.
An empty document diff opens no PR; a previously started publication still completes its exact-revision merge/check gates on replay.
If existing documents already suffice, reference their accepted revision and skip evidence; do not
create an empty PR. Existing repository gates remain;
there is no additional approval gate beyond essential author decisions. The existing repository
reviewer assesses the exact assembled documentation revision within the Architecture child; the
deterministic parent publishes that saved assessment's actual Lens review/check verdict. Retained negative evidence is preserved and requests repairs, never replaced
with deterministic approval. Validate the entire publication diff against accepted document paths.

The parent creates concise implementation tickets linked to merged documents, source issue and any
retained prototype references. Validate the dependency graph before applying handoff effects and
create tasks in a topological order. Rank prerequisites before dependent tasks using actual Jira
rank order, moving a premature dependent after its last prerequisite without moving it ahead of
unrelated higher-ranked work. Retain created ticket identities as operations succeed. Reconcile
uncertain creation against the source issue and planned task before retrying; interruption must not
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

The existing queue command runs the project parent. HARN delivery-only configuration can bootstrap
this change through its existing To Do ready mapping. There is no parallel legacy Jira selector.

## Profiles

Separate author/evaluator invocations even when their profile is identical. Profiles configure model,
effort and tools; roles own complete constant instructions. Stage context supplies declared inputs
and findings. Jira publication is outside role tools. Prototype evaluation requires browser/image
inspection tools on its profile.

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
