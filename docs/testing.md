# Testing architecture

Test documented behavior at the smallest scope that can reliably prove it. Use many small tests,
fewer focused integration tests and a few system journeys. No fixed percentage or test-count target
is required. Each broader test must cover a risk that narrower tests cannot establish.

## Unit and component tests

Exercise real Nexus logic through its public interface. Keep ordinary in-memory collaborators real;
substitute external effects with supplied responses. These tests run without network access, real
processes or filesystem operations. Control time instead of waiting for it to pass.

Cover decisions, meaningful variations and failure outcomes here.

| Subject | Behavior to verify | Supplied dependencies |
| --- | --- | --- |
| Application | Commands, configuration paths, exit codes, recovery invocation and resume/attention decisions within the allowance | Arguments, configuration, work/recovery results and notification responses |
| SelectWork | Source ordering, eligibility, stage mapping and continuation decisions | Issue data and retained selection |
| StartDevRound | Initial profile, repair triggers, executed-turn counting, changes-requested promotion, no downgrade, planned-round reuse and exhaustion | Round history, developer ladder and current-round record |
| Shared round storage | Current-plan validation, numbered history, directory creation and plan persistence without role or route decisions | Finite and idea plan fixtures in temporary workspaces |
| Review | Verdict validation, readable report association and revision-bound publication | Agent outcome, Markdown and repository observations |
| CompleteTask | Completion only after merge with no failed required pre-merge check and successful configured checks for that merge | GitHub observations and source updates |
| AgentRuntime | Profile resolution, complete context assembly and per-invocation inactivity observation | Coding-provider response and controlled time |
| OperatorInterface | Event presentation, activity grouping, pane lifecycle and colors | Events, terminal dimensions and output sink |
| Workflow | Initial, repair and terminal transitions | Named action outcomes, using the real XState definition |

Tests assert observable results and required effects. Do not mirror private methods or incidental
call order. Verify order when it is the behavior, such as completing checks before marking a task Done.

## Focused integration tests

Exercise one connection with its real implementation. Keep unrelated dependencies substituted.

| Connection | Real parts | What it establishes |
| --- | --- | --- |
| Action artifacts | Producer output handling, artifact helpers and consumer input handling on temporary storage | The consumer can use the producer's actual saved output, including current-round and history selection |
| Workflow persistence | ExecutionRunner, XState and temporary state files; supplied actions | Active execution resumes; terminal execution resets on the next run; invalid state fails |
| Git operations | Git adapter and temporary local repositories | Checkout, pull, branch creation and push behave as expected |
| Process execution | Process adapter and a small controlled child process | Arguments, output, exit and timeout behavior |
| Worker communication | Parent bridge and a controlled worker process | Events, terminal result and process failure cross the boundary correctly |
| Agent activity | Logger, event transport and OperatorInterface with interleaved agent streams | Separate durable files, correct main-event references and independent panes for concurrent invocations |
| External protocols | Adapter with controlled HTTP responses or CLI output | Requests, response interpretation and provider errors match the adapter contract |

A simulated provider verifies Nexus's handling of the supplied protocol. It does not prove that live
credentials, permissions or provider behavior work. Verify those through a targeted live integration
check when needed, separately from routine validation.

## System tests

Run the assembled Nexus entry point with real component wiring and local storage. Substitute external
services and agent execution. Keep a few representative journeys: a task completes, a requested repair
completes, and an interrupted execution resumes through recovery. Verify the final observable result.

Do not repeat the component-level failure matrix through the whole system. These journeys verify
composition; they do not establish the quality of a real agent's implementation or review.

## Contracts and workflows

Contract tests verify a provider's observable promises and its consumer's expectations. A schema check
alone does not establish compatibility. Use the real provider behavior relevant to the contract and
test the consumer's handling of its results.

For action artifacts, the producer exports one Zod schema with its artifact declaration. Derive the
TypeScript type from that schema; consumers import the declaration rather than defining their own
shape. The artifact reader validates persisted JSON with that schema. Static types alone do not
validate file contents.

Verify compatibility using actual producer output. For example, run Develop with a supplied agent
response and repository observations, let it write development.json through the real artifact helper,
then exercise Review's real input handling against the same round. Supply its other required inputs
and verify that its assembled review context contains the narrative development report, revision,
task requirements, verification evidence and readable previous review reports. This requires no live
agent, GitHub access or full workflow.

Do not replace both sides with independently handcrafted fixtures. Test malformed JSON and missing
required fields at the artifact-reading boundary without repeating that matrix for every consumer.
Vitest runs these tests; Zod supplies runtime shape validation.

For repair handoffs, carry actual Markdown review/evaluation reports into the next author/developer
context, then the narrative response and current work into the evaluator/reviewer context. Verify
that earlier concerns remain readable and a current defect requests repair while a corrected defect
permits acceptance, without response arrays, dispositions or ID matching. Cover malformed required
fields and unknown control values at their owning action boundary. Assessment quality and
consistency with narrative evidence require inspection of actual agent reports, not deterministic
finding counts. Verify retained former reports stay byte-for-byte unchanged and readable,
continuation preserves allowances, and old approval cannot authorize a changed implementation head.
Verify that each invocation includes its selected role's complete constant prompt once alongside the
supplied context; test prompt assembly, not the wording of documentation.

For document-stage evaluation, exercise unchanged adequate documents with empty changed-document
lists, concrete defects, applicability skips with Markdown explanations and optional references and
compatible later-stage edits. Verify fresh finalization and interrupted replay against the observed
current assessment, without document-citation or historical approval-reuse requirements after the
stage advances. Retain prototype preview/observation and upstream-correction coverage. Exercise
task-relevant pre-existing code outside the comparison diff in review context and preserve
exact-head publication and merge/check gate coverage. Remove tests whose sole purpose is enforcing
the deleted finding lifecycle or document-reuse mechanism; retain resolver regressions where
optional references still use it.

Verify report separation through actual producer/consumer storage handling for every role category:
developer/reviewer, all eight preparation roles, the four idea roles, Recovery and analysis.
Recording providers write the assigned Markdown and return only their minimal outcomes. Cover
developer repair and profile variants, concurrent contributor paths, focused/post-help turns and
retained-revision completion. Assert outcome schema delivery, observed metadata, report
references/identity and full necessary Markdown context. Code fences and JSON examples in reports
remain text, never decisions.

At the shared report boundary test malformed/extra outcome fields, missing/unreadable assigned
reports, changed associated bytes, and partial outcome persistence. At the owning boundaries retain
functional-plan/routing/memory validation and applicable input/revision checks. Remove
narrative-field, structured-finding and prose/verdict-consistency validators and tests together.
Preserve readable legacy bytes and complete recorded identities, while damaged new bindings cannot
fall back to legacy. Verify report-backed PR/review/ticket/notification publication and retained
publication bodies on replay.

Carry a rejected outcome and available Markdown through recovery, selection reset and worker restart
into the next responsible invocation. Check attribution, exact rejection reason, matching correction
retirement and isolation from other roles/items. Keep historical evidence after correction and
retain allowances and merge/check gates. Memory capture must preserve associated reports
independently of attempt disposal; zero lessons still writes Markdown, and accepted legacy
analyses/submission retries reuse their immutable payloads. Controlled agents prove handling, not
report substance.

Contract and workflow describe what a test proves, not additional pyramid layers. Classify them by
the scope and dependencies they exercise. Test Nexus's XState definition and integration, not XState's
internal implementation.

### Change coherence instruction delivery

Verify the [coherence requirements](agent-runtime/change-coherence.md) through actual preparation
author/evaluator and Develop/Review action invocations, real application profile composition and
AgentRuntime, with a recording coding provider and controlled outputs. Capture the provider's
assembled prompt for all eight preparation roles, the developer and reviewer. Include a development
repair and every selectable developer and prototype-author profile variant; exercise a profile
reused across roles to establish that instructions do not leak between roles.

Assert the delivered obligations, not only that a prompt contains an imported constant. Preparation
authors receive reconciliation before evaluation; evaluators receive inspection of the resulting
revision or proposed skip. Developers receive removal of superseded dependencies and reconciliation
before review; reviewers receive inspection of resulting intent, implementation and affected
interactions. Check scope limits, confirmed ownership causes, adequate-work acceptance and optional
suggestions alongside complete task/repair context. Shared preparation guidance and selected role
instructions occur once. Reuse existing finite-workflow and delivery-gate coverage; this instruction
change adds no workflow transitions or report shapes.

Review authoritative role documentation against the delivered prompts. Controlled agent outputs
prove instruction delivery and existing routing, not model compliance, cumulative design quality
or absence of regressions in a month-long run.

### Product-grounded UI instruction delivery

Extend the existing action-to-provider instruction checks for the UX author/evaluator, prototype
author/evaluator and production developer, following the
[role-owned contract](agent-runtime/preparation-roles.md#interface-and-data-handling). Capture actual
assembled prompts through application composition and AgentRuntime, including every selectable
prototype-author/developer profile and a developer repair. Verify each role's applicable product
grounding and creator or evaluator duties, not merely inclusion of an imported constant. Check
independent live interaction and image inspection, applicable live motion, product/user reasoning,
UX versus prototype correction ownership and delivery-review separation where those duties apply.
Preserve proportionality, adequate-work acceptance and evaluated skips. Exercise a profile reused
across roles to check that specialized duties do not leak into unrelated roles.

Reuse existing observation, upstream-return, repair and delivery-gate tests; this change introduces
no schema or routing mechanism. Review delivered instructions against owning role documents.
Recording providers establish instruction delivery, not model compliance or rendered design quality.
Unchanged browser/image tooling does not require another host capability exercise for this guidance
change; applicable product prototypes still require their own independent observations.

## Test discipline

Keep edge cases at the narrowest effective scope. Add broader coverage only for interactions that
need it. Tests remain independent of execution order and leave no files or processes affecting other
tests. Use ordinary test-runner setup and cleanup; add shared helpers only for demonstrated repetition.

Run fast tests first, then integration and system tests. Routine validation needs no live credentials
or paid agent turns. Test implementation against documented intent; do not create documentation tests
or assertions that merely reproduce the implementation.

## Idea refinement coverage

Use the real XState workflow with controlled role outputs to verify the initial parallel
Researcher/Project guide join, editor/Challenger exchanges, selective focused contributions,
approval and the three distinct returns: unsuitable, author decision needed and attempts exhausted.
Cover revision, answers and rebuttals, including a resolved objection without changing the idea text.
Suggestions may accompany approval. A changed revision or editor response requires a fresh
Challenger assessment; stale approval cannot publish it. Check exact cycle-limit behavior, including
approval at the limit, and that focused help cannot bypass the limit through an internal loop.

Verify the idea-stage behavior through representative scenarios, not only prompt-string assertions:

- An architectural idea can change an existing design choice. Dynamic model selection is not
  narrowed merely because profiles currently fix the model.
- A human clarification overrides a previous agent interpretation or published summary.
- Research enriches an idea with concrete examples and possibilities without demanding proof first.
- A valid rebuttal resolves a mistaken objection; an optional suggestion does not prevent approval.
- A plausible exploratory idea can advance with uncertainty, without a mandatory benchmark plan.
- A real feasibility or value concern receives a response and either resolves or produces an
  understandable return reason.
- Missing purpose documents lead to scoped, provisional inference; unrelated home-directory,
  provider-session and investigation material is not used to reconstruct the author's intent.
- Synthesis preserves source ownership and uncertainty: a community source is not attributed to
  the author without evidence, vendor claims remain attributed, and an unsuccessful search is not
  converted into proof of absence.
- A search-service quota or authorization failure leads to another available research method and
  an honest limitation, rather than repeated requests to the unavailable service.

Verify all four roles receive the shared idea definition and guidance once, captured author input,
relevant conversation, readable history references and root `AGENTS.md` when present. Preserve
comment authorship and distinguish human input from previous agent output. Purpose documents are
discovered without configured references; absent documents permit cited provisional inference
from code and commits. Output follows the concise deliverable defined in the specification; word
count is not a rejection gate. Check that the shared source-scope and attribution instructions reach
initial and focused role invocations once alongside the concrete worktree and artifact references.
Role quality needs inspection of actual exchanges and tool activity as well as routing tests:
assess source scope, attribution and the concise idea and summary in live evidence. Controlled outputs
and prompt assembly checks cannot prove model compliance or filesystem isolation.

At action boundaries, verify producer-owned artifacts, distinct paths for concurrent contributions,
assessment binding to the current revision and response, and a single Jira issue/comment capture
per selection. Every entry from `Idea` reuses the same selection path and retained workspace;
StartIdeaRound starts a new submission at cycle 1 without applying delivery repair policy. Prior
artifacts remain readable history without being rewritten.

Verify configured source transitions and publication using the captured input without a later Jira
read. Approved output and human-facing returns include the refined idea, refinement summary and
cycle count. A return gives a plain reason and next step; exhaustion is not presented as rejection.
Internal exchanges remain in artifacts and per-agent logs. Operational failures do not produce an
idea verdict. The source pointer names the shared issue root, handoff references let later workflows
read retained artifacts, and a fresh finite delivery attempt preserves the refinement area.

Reuse existing component and system test scopes; do not duplicate XState's own parallel-state tests.

## Memory coverage

Use [AnalyzeExperience](task-engine/actions/analyze-experience.md) and
[Memory integration](memory/integration.md). Exercise the dependency-cruiser rule with allowed
public imports by the action and prohibited imports by Application, other actions, AgentRuntime
and adapters. Separately verify native tool settings retain ordinary agents' explicit AMEM
search/save access and restrict the action's analyst to search only.

Workflow tests establish learning after every selected-work terminal handoff, original destination
preservation, no capture on intermediate retries or empty/failed selection, multiple items in a
finite queue and no stale selection. Cover delivery success/failure, all idea publication returns,
operational errors after parallel agents settle, and recovery of interrupted requests. Analysis
is independent of Jira status and does not change completion/publication/recovery gates.

Action tests cover stable handoff identities, durable capture, no-provider capture path, zero
lessons, evidence validation, persisted output/provenance reuse and accepted-versus-stored receipts.
Pending work survives queue drain/restart and migration of existing completion requests. Disabled
memory has no effects; faults retain evidence and preserve business outcomes. Service/MCP algorithms
belong to AMEM tests. Semantic quality requires separate source-grounded retrieval evaluation.

Restart and recovery coverage additionally establishes that a fresh attempt carries a new identity,
that a producer's retained reason reconstructs the identical handoff, that an outstanding request
stays analyzable after its attempt was discarded or replaced, that a partially initialized idea
submission is the interrupted one, that an analysis invocation without a prepared repository still
runs, and that a capture-discovery failure reports unavailable without replacing the terminal
outcome.

## Agent inactivity observation

Verify the [runtime inactivity contract](agent-runtime/architecture.md#inactivity-observation) with
controlled time: silence before the first response and after activity warns at two minutes, continuing
silence does not repeat the warning, resumed activity permits a later warning, concurrent invocations
remain independent, and completion or failure releases observation. Diagnostics must remain
attributable in live presentation and durable activity logs, including plain terminal output.

## Project parent coverage

The [project workflow](project-workflow.md#persistence-observation-and-verification) defines the
parent/child journeys and stage acceptance boundaries. Test invoked machine composition with
controlled responses, restored child snapshots and resumable source handoffs. Exercise parent
selection/publication independently of Jira-free child business actions. Preserve finite delivery's
revision, repair, review and merge/check journeys after moving source effects.

Use real temporary Git repositories to establish successive stages retaining both edits to the same
document in one checkout/branch, path-scoped commits excluding unrelated staged work, and deletions.
Compose actual stage bindings with AgentRuntime and a recording coding runtime to assert both roles'
working directories; do the same for first-implementation Develop/Review and process/Git operations.
Handcrafted WorkspaceRef values alone cannot establish that binding.

Restart the real composed machines at upstream correction and reevaluation boundaries. Changed
input/content/report identities prevent stale acceptance or skip reuse; unrelated HEAD changes retain
valid content. Pending correction order and finite round/return allowances survive restart. Divergent
legacy checkouts and incompatible identities request reconciliation without losing history.

Exercise a two-task handoff through two PRs with real local Git and controlled source/GitHub responses.
The first keeps the preparation repository/base; the second requires merge/check completion and a
base including prerequisite merge revisions. Interrupted creation/link/admission/completion must
reconcile uncertain identities, avoid duplicates and preserve human pauses. There is no preparation
or aggregate PR and no admission based only on source Done. Existing action tests establish rejection
of changed-head approval, failed verification/checks and missing merge/post-merge evidence.
Recovery cannot delete the preparation continuation's donor checkout.

For handoff queue ranking, control actual source order, candidate-query membership and mapped
preparation statuses. Exercise one-ticket and branching plans, including prerequisite order differing
from prerequisite-list order, preparation both ahead of and behind implementation, and no remaining
preparation. Verify resulting rank and retained acknowledgements rather than a fixed sequence of rank
calls. Interrupt ranking, including a move whose response is lost, and replay with the same ticket
identities; unfinished ranking cannot close the original. Connect the resulting order to actual
selection: available implementation precedes preparation, while absent prerequisite completion or
Waiting for Feedback still permits eligible preparation. Keep these focused scenarios in existing
handoff and selection coverage; the serial parent and delivery gates remain unchanged.

Test prototype evidence validation and fault/repair routing with controlled responses, then run a
real isolated Storybook fixture in Chromium through Playwright MCP and the actual assigned prototype
profiles. Both roles interact with a state-changing journey, receive and inspect screenshot images,
and save separate readable observations with Nexus-observed revision/report attribution. A broken
journey/layout enters repair; corrected work needs fresh inspection and an applicability skip needs
none. Cover two edited files with broader genuine browser evidence, no changed paths, and a defect
outside declared edits: changed-path lists neither gate evidence nor limit assessment. Exercise
finalization, replay, downstream decisions and retained records with former or absent per-file fields.
Remove tests enforcing assessed-file inventories and per-file observation/content comparisons;
retain report integrity, fresh-assessment association, missing/unreadable evidence and allowance
coverage without fabricating legacy evidence. This targeted host
integration check establishes tool/image delivery that simulated responses cannot prove. The fixture
is consumed by tests and adds no Nexus product UI.
