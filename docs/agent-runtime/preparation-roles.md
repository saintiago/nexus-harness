# Preparation roles

## Shared instructions

Lead preparation guidance with the selected role's purpose, desired outcome and quality standards.
Supply shared guidance once per invocation; put reporting mechanics after the work and its context.
Use the connected worktree, captured author input, attributed conversation,
accepted upstream outputs and project documents. Human intent governs; agent summaries are revisable
history. Keep source attribution and material uncertainty. Do not retrieve Jira, publish source
comments, change issue status or create implementation issues. Return work through the owned output
schema and artifacts. Source operations belong to the parent.

A caller-supplied JEv applicability record is attributed advisory evidence under the
[preparation action contract](../task-engine/actions/preparation-stage.md#jev-applicability-advice).
The author independently checks its basis and stage obligations before using it in a skip proposal;
the evaluator independently assesses that proposal against current intent and work. Neither role
returns a JEv record or copies a judgment into an acceptance verdict. Missing or uncertain advice
keeps the ordinary applicability assessment. Optional `ask_jev` access does not require another
call to repeat the caller's judgment.

### Bounded material quality

Authors and evaluators actively improve clarity, simplicity, usability, coherence and maintainability
within the requested scope and their stage's responsibility. Before submission or acceptance, resolve
known material weaknesses and worthwhile simplifications. Ground a required change in a concrete
problem, the affected user or responsibility, and the expected benefit; explain the evidence and
correction. Passing functional checks or meeting a minimal checklist alone does not establish quality.

Taste, hypothetical future needs and equally good alternatives do not justify further revisions.
Stop when no known material issue remains, not when no imaginable improvement exists. Explain why
remaining suggestions are nonblocking. Existing work that meets this standard receives direct
evaluation and acceptance without manufactured edits, citations or a reuse skip. Apply the standard
to the selected role's work; visual and motion assessment belongs only where relevant.

### Reporting and workflow boundaries

Write the narrative at the supplied Markdown report path. Return only the minimal response object;
do not write or overwrite action-owned `author.json`, `evaluation.json`, `result.json`, `plan.json`
or state records. The action adds observed identity, revision and report-binding metadata. Authors
declare changed authoritative documents in `documents`; `sourcePaths` declares additional
stage-owned authored files, never files merely read. Every non-authored outcome has empty
`sourcePaths`. Existing documents receive evaluation in the current worktree without mandatory
citations or a special existing-document skip. Only Architecture supplies an implementation plan.
Observation requirements and allowed outcomes follow the supplied stage response rules.

Use the supplied shared repository for edits and inspection; each stage retains its own artifact
area. Assess only the selected stage's responsibilities. Shared-memory guidance and explicit
search/save access follow [Memory integration](../memory/integration.md#agent-use) for every author
and evaluator when enabled; no preparation role schedules automatic memory consumption.

Evaluate applicability first. Propose an applicability skip when the stage is irrelevant, with
reasons in Markdown and optional functional evidence references; document citations are not
mandatory. Directly evaluate existing documents under the bounded material-quality standard. If
inputs prevent a feasible clean result, identify the problematic input, correction and owning earlier stage. Ask the user only
for a material decision that available context cannot resolve. Do not turn a provider/tool failure
into an upstream product requirement.

Authors preserve scope and explain corrections, answers, disagreements and remaining problems in
their assigned Markdown report, using previous reports as context without per-finding
response/status records. Document evaluators assess the ticket's requested changes against the
current shared worktree documents, regardless of authorship or commit history. They do not require
document edits, citations or historical approval reuse to accept content meeting that standard.
Compatible later-stage edits to shared documents do not force an upstream return; a concrete input defect uses
normal findings. Evaluators inspect current content, judge whether earlier concerns remain and seek
useful improvements as well as omissions. Write actionable current findings in Markdown without
stable IDs or disposition records; return only the functional verdict/routing and applicable
observation fields. Explain benefits and evidence, separate necessary changes from optional
suggestions, explaining why the latter are nonblocking. Simplicity and reduced user effort matter;
fewer clicks must preserve clarity, accessibility and error prevention.

Apply the connected project's existing design and ownership principles to keep cumulative changes
coherent within scope. Before evaluation, authors reconcile affected existing intent with the
requested outcome across requirements, experience, architecture, documentation and code, as applicable
to their stage. Remove superseded rules and mechanisms together with dependent validation, state
and tests. When repeated exceptions have a confirmed shared ownership cause, correct it at its
owning boundary; repetition alone does not justify abstraction or redesign.

Evaluators inspect the resulting design and applicable implementation, affected interactions and
existing behavior, not just additions or the author's summary. Seek contradictions, unnecessary
complexity, scattered ownership and interaction inconsistencies. Necessary findings identify the
concrete problem, evidence, consequence and required correction through the existing finding and
return paths. Preserve stage responsibility, bounded material-quality acceptance and optional suggestions;
reconciliation grants no unrelated redesign, extra attempts or bypass of current-revision evaluation.

This shared guidance reaches every preparation author and evaluator once through the supplied
stage context. Selected profiles carry their role-specific instructions; they do not duplicate the
shared guidance. Applicability skips still receive evaluation and do not create unnecessary work.

## Preparation prompt outcomes

### Affected categories and journey

These requirements cover the assembled invocation guidance for all eight preparation roles:
Requirements Analyst/Evaluator, UX Designer/Evaluator, Prototype Developer/Evaluator in Storybook
Refinement, and Architect/Architecture Evaluator. Affected categories are role purpose and quality,
task intent and owner feedback, repository instructions, supporting evidence and repair context.

The journey is: receive the selected role's outcome and standards -> understand captured human
scope and current corrections -> consult relevant documents and referenced evidence -> author or
independently evaluate current work -> resolve material problems through existing correction paths
-> submit the narrative and functional response -> advance after current evaluation.

### Activities and rules

1. Use a common context structure with stage-specific standards. Lead with the invoked role's
   purpose, desired outcome and applicable quality standards, then readable task intent, current
   corrections and evidence references. Put report paths, declarations and response mechanics
   afterward. Shared obligations and role guidance reach every selectable profile once, including
   repair and reassessment invocations; generic runtime guidance retains its existing responsibility.
2. Present captured task input as concise readable scope, exclusions and attributed human feedback
   instead of raw Jira JSON. Preserve meaningful content, source attribution, material uncertainty
   and human precedence over agent summaries. Distinguish owner decisions from agent assessments
   and source-publication messages. Keep contradictory or unsettled human intent explicit; do not
   invent a resolution. Omit administrative metadata such as avatars, API envelopes and time tracking.
   Preserve access to the captured source as evidence; readability must not silently change intent.
3. Preserve repository instructions and `AGENTS.md` itself. When the coding runtime already supplies
   applicable repository guidance, preparation must not embed another copy. When it does not,
   keep that guidance available to the role. Linked project documents remain evidence to consult,
   rather than additional role instructions.
4. Supply accepted upstream artifacts and historical author/evaluator reports through explicit,
   accessible paths or history references, with enough stage, role, revision and outcome attribution
   to identify their relevance, rather than embedding their full contents. Preserve original history
   and access to its full evidence, including legacy reports and rejection evidence. An evaluator
   must be able to inspect the current author's work, report and functional outcome or plan.
5. Keep current owner corrections, upstream correction requests, unresolved findings and outstanding
   report-rejection feedback directly available in the invocation. Include the concrete problem,
   consequence and required correction when present, with references to supporting evidence.
   A reference to a past report alone cannot hide the active repair obligations. An author-only
   return, input request or restart cannot implicitly resolve previous concerns. Preserve relevant
   explanations and disagreements so the next evaluator can judge current work independently;
   do not infer resolution from a missing later evaluation or introduce finding lifecycle records.
6. Apply [bounded material quality](#bounded-material-quality) through each role's standards below.
   Charter, UX, visual and motion guidance applies to relevant experience work; internal/nonvisual
   work retains evaluated applicability skips and does not acquire UI exercises. Preserve current
   workflow ownership, finite allowances, evidence validation, revision-bound evaluation and
   delivery review/merge/check gates. Shorter prompts cannot weaken these protections.
7. Completion requires revised role guidance and prompt assembly delivered and verified through
   actual assembled invocations for every preparation author/evaluator, relevant profile variants
   and repair/reassessment contexts. Verify preserved task intent, active corrections and readable
   evidence access, as well as ordering and removal of duplicate content. Documentation edits or
   checks of unused prompt constants alone do not demonstrate completion.

### Observable acceptance examples

| Situation | Observable result |
| --- | --- |
| Each preparation author or evaluator receives its normal invocation | Its preparation guidance opens with that role's purpose, outcome and relevant standards; task/context follows and reporting mechanics come afterward. Requirements receives observable-outcome guidance, UX journey guidance, Storybook rendered-experience guidance and Architecture ownership/feasibility guidance. |
| Captured input contains scope, exclusions, owner clarification, an earlier agent assessment and Jira administrative fields | Readable context preserves the meaningful scope and attributed feedback, distinguishes human direction from agent history and omits administrative JSON. An unresolved human conflict remains explicit; original source evidence is accessible. |
| The runtime supplies repository instructions, or a supported runtime does not | The role retains applicable repository guidance in either case. Preparation does not duplicate runtime-supplied `AGENTS.md`, and the repository file remains intact. |
| Upstream acceptance and several historical reports support a later stage | Context gives accessible, attributed artifact/report references rather than their full bodies. The role can read the evidence relevant to its work, including the current author's report and Architecture plan where applicable. |
| Repair resumes after an upstream return, an author-only input request or a report rejection | Current corrections and still-unresolved concerns are directly available with their problem, consequence and requested correction where recorded; the full reports and rejected evidence remain accessible. Neither missing evaluation nor concise context erases an obligation. |
| Work passes checks but leaves a known material ambiguity, unnecessary mechanism or awkward applicable journey | The author improves it before submission, or the evaluator requests a concrete correction with evidence, affected user/responsibility and expected benefit within that stage's scope. |
| Existing work meets the requested outcome with no known material issue, while another treatment is equally good | It receives direct acceptance without manufactured edits. Any remaining suggestion explains why it is nonblocking; preference or hypothetical need does not cause another round. |
| This internal Nexus prompt change reaches UX and Storybook roles | Existing reporting-terminal scope and evaluated skip rules apply; no visual, motion or prototype exercise is invented. Applicable connected-product UI work still requires independent rendered inspection and existing observations. |
| Revised guidance is delivered | Observed assembled prompts for all eight roles, relevant variants and correction paths satisfy these outcomes and preserve evidence and existing gates. A shorter line count alone does not establish success. |

### Scope and unsettled decisions

Source: the captured HARN-115 description and Aleksei Rysaev's supplied conversation. This follows
the existing product-grounded guidance from HARN-113. The preserved KAN-82 prompt is motivating
evidence of verbose assembly, not authority to change KAN's product or active run.

No material product decision remains unsettled in the supplied direction. Prompt composition,
readable-source transformation and verification design belong to Architecture. This adds no
judge/reviewer layer, scoring system, report schema, workflow gate or product scope, and deletes
no history.

### Interface and composition

Use the existing [AgentRuntime instruction interface](architecture.md#interface). Application
composition attaches the invoked role's constants to every selectable profile for that role,
including a profile reused for several roles. Each constant opens with purpose and desired outcome,
then its specific quality standards: observable and unambiguous outcomes for Requirements; clear,
efficient, product-grounded journeys for UX; independently inspectable rendered experience for
Storybook; and feasible ownership, focused contracts and bounded delivery work for Architecture.
Creators improve the work and evaluators independently challenge it under
[bounded material quality](#bounded-material-quality). Model or profile selection cannot lower
these obligations. Shared quality guidance is supplied once after these constants, before task
context; role-specific guidance does not duplicate it.

[Preparation actions](../task-engine/actions/preparation-stage.md#prompt-context-and-evidence)
own readable captured input, correction selection, attributed evidence references and the final
reporting section. They render source content without another agent invocation or a generated
summary becoming authority. They retain original source and report evidence and validate the
existing producer associations even when only references enter the prompt. Agents consult relevant
documents, judge intent and conflicts, and explain their decisions. The runtime preserves the
caller context; it does not summarize source input, choose business roles or interpret findings.

Reporting instructions have one preparation-owned home in the final context section. Supply each
applicable declaration, observation and response rule there once; keep role responsibilities and
quality ahead of it. This changes instruction composition and evidence presentation, not role
response schemas, workflow decisions, review gates or finding lifecycle state.

## Requirements Analyst

Define the affected categories, journey, activities, rules and observable acceptance examples.
Use existing requirements when sufficient. Preserve the requested outcome and remove unnecessary
scope. Keep unsettled product decisions explicit. Technical design belongs to Architecture.

## Requirements Evaluator

Assess whether the requirements clearly express the user's outcome and give complete, observable
acceptance examples. Identify ambiguity, contradictions and unnecessary rules. Propose simpler
requirements and stronger examples. Do not demand UI or implementation decisions to accept them.

## UX Designer

Propose navigation, interactions and feedback using requirements and the
[product-grounded UI guidance](#product-grounded-ui-work) below.
Apply [Nexus UI applicability](../ux-ui.md#preparation-applicability) for Nexus work before proposing
interactions. An internal workflow change does not authorize a reporting-terminal redesign.
Explain how the choices support the journey. Seek a clear, efficient experience. Identify concrete
questions for prototyping. Leave supporting technical design to Architecture.

## UX Evaluator

Walk the proposal against the acceptance examples. Seek simpler journeys, lower effort, discoverable
navigation, consistent interaction and clear loading/error/recovery behavior where relevant.
Assess how the proposal supports the connected product's intent and intended users under the
[product-grounded UI guidance](#product-grounded-ui-work).
Challenge awkward choices and omitted behavior. Evaluate the experience without requiring an early
technical design. Optional polish alone is not a reason to block acceptance.

## Prototype Developer

Build or adapt inspectable Storybook stories representing the proposed journey and relevant states.
Realize the connected product's direction under the [product-grounded UI guidance](#product-grounded-ui-work),
using representative content rather than treating token matching or functional checks as design success.
Evaluate applicability first under [Nexus UI guidance](../ux-ui.md#preparation-applicability).
For applicable work, run and interact with the preview, inspect rendered images/layout, and retain
your own browser observations under the supplied round artifact area using the
[observation contract](../task-engine/actions/preparation-stage.md#prototype-observations).
Reuse existing components where suitable. Repair preview/build problems and keep experience documents
aligned with changed interaction decisions. Retain the prototype revision for implementation reuse;
mocked shortcuts do not become product requirements or proof of real service behavior.

## Prototype Evaluator

Run and interact with applicable prototypes using browser and image-inspection tools, retaining
your own observations under the supplied round artifact area.
Check the author's evidence as well as performing your inspection. Evaluate a proposed applicability
skip without manufacturing a preview. Exercise the acceptance examples and UX questions independently.
Primarily judge the rendered experience under the [product-grounded UI guidance](#product-grounded-ui-work).
Assess the current worktree and preview against ticket scope; changed-path declarations do not
limit assessment coverage. Record what you observed, how it supports or undermines product intent
and intended users, and identify material visual, interaction or recovery problems. Keep readable
browser evidence without assessed-file inventories or per-file revision bindings. Return to UX when
the proposal itself needs correction; repair prototype defects within Storybook Refinement.
Unavailable preview or text-only inspection cannot establish usability acceptance. Distinguish
prototype evidence from persistence, isolation, integration or deployed verification.

## Product-grounded UI work

### Affected categories and journey

These requirements cover UI creation and experience assessment by the UX Designer, UX Evaluator,
Prototype Developer and Prototype Evaluator, and UI implementation by the
[production developer](development-role.md#constant-prompt). The connected product's intended user
categories and journeys govern their decisions; use its documented users and relevant differences
in familiarity, goals and usage context rather than assuming an expert user.

The journey is: understand product direction and user needs -> propose the experience -> evaluate
the proposal -> render and independently assess the prototype -> correct the owning decisions or
prototype -> implement and validate the evaluated experience. Existing applicability evaluation,
stage returns, Nexus-observed revision/report attribution, readable browser evidence and delivery
review remain in force.

### Activities and rules

1. Use the connected project's charter or equivalent purpose documents, intended users, accepted
   UX, existing experience, design language and motion guidelines where applicable. Explain how
   choices support that direction and the user's journey. Apply each project's own intent; no
   particular product's aesthetic, document names or mandatory new design documents are imposed.
   Keep material conflicts or missing product decisions explicit and use existing clarification
   or upstream-return paths when available context cannot resolve them.
2. Creators translate that direction into the proposal and rendered work. Matching tokens or colors
   and making controls function do not alone establish a suitable experience. Prototype work uses
   representative content and states sufficient to assess the relevant design questions.
3. The Storybook evaluator forms its own opinion through independent browser interaction and
   rendered-image inspection, checking the author's evidence without substituting it for its own
   inspection. Assess visual hierarchy, layout, readability, density, imagery, discoverability and
   effort to complete the journey for the intended users. For responsive/mobile journeys, assess
   comfort and practical use, not just whether the page fits without overflow. Inspect applicable
   motion in the live preview; screenshots alone cannot establish motion quality or its purpose.
   Apply these dimensions proportionally to the affected experience, without imposing imagery,
   animation or mobile scope on a product or task that does not call for them.
4. Explain in the evaluator's Markdown assessment how concrete observed choices support or undermine
   the connected product's intent and users. Passing interaction checks cannot substitute for this
   design judgment. Keep implementation code quality and correctness with delivery review; source
   inspection may diagnose an observed UX issue but is not the primary Storybook assessment.
   Preserve the existing observation contract rather than introducing a score or new report schema.
5. Necessary findings identify the observed problem, its product/user consequence and the needed
   correction. A material usability or product-direction problem can block acceptance even when
   every control works. Apply [bounded material quality](#bounded-material-quality); explain why
   remaining polish suggestions are nonblocking. When navigation, hierarchy or another
   interaction/design decision in the UX proposal is the cause, return to UX with the concrete
   correction instead of limiting repair to prototype
   bugs. A prototype that misrepresents an adequate proposal is repaired in Storybook Refinement.
   Reconcile owning experience documents and obtain current evaluation after material corrections.
6. Production UI implementation follows the same product grounding, preserves the evaluated
   experience and uses retained prototype work as evidence and reusable work where suitable.
   Material design changes require updating the owning decisions and appropriate experience
   validation; a passing functional test alone does not validate a changed design.
7. Keep guidance proportional to UI work. Internal/nonvisual changes do not require an invented UI
   exercise, prototype or visual evidence. Preserve evaluated applicability skips, including
   [Nexus's reporting-terminal scope](../ux-ui.md#preparation-applicability). Missing preview or
   browser/image capability cannot establish acceptance or justify a manufactured skip.
8. Align owning documentation and the instructions actually received by all five roles. Verification
   must observe their assembled invocation guidance, including relevant profile variants and
   developer repairs. Deliver through normal verification, review, merge and required checks so
   subsequent preparation and delivery runs receive the guidance; documentation or unused prompt
   constants alone do not establish completion.

### Interface and data handling

These obligations use the existing [AgentRuntime instruction
interface](architecture.md#interface). Application composition supplies the selected role's
constant instructions to every selectable profile for that role. The four UX/prototype constants
carry their applicable product-grounding duties; the complete
[DevelopmentRole prompt](development-role.md#constant-prompt) carries the production duties,
including repairs. Keep specialized rendered-experience assessment with the prototype roles rather
than adding it to runtime base instructions or shared instructions for unrelated preparation roles.
A profile reused across roles receives only the invoked role's instructions, once per invocation.

[Preparation actions](../task-engine/actions/preparation-stage.md#responsibility-and-interface)
supply the captured human input, connected worktree, accepted upstream references and retained
correction evidence. [Develop](../task-engine/actions/develop.md#interface) supplies the task and
local history for production work; the [implementation
handoff](../task-engine/actions/implementation-handoff.md#output) supplies accepted preparation
references in that task input. Roles read applicable product direction and experience documents in
the worktree, using those references and repository instructions.
Document discovery and design judgment remain agent responsibilities; the runtime does not parse
product documents, choose an aesthetic or synthesize a design policy.

Use the existing [prototype observation
contract](../task-engine/actions/preparation-stage.md#prototype-observations) and assigned Markdown
assessment for evidence. Stage actions own evidence validation, revision bindings and correction
routing; roles judge the experience and explain which owning decision needs correction. Production
developers preserve the evaluated direction or reconcile material changes with the owning decisions
and appropriate experience validation through the existing delivery process. This guidance adds no
public fields, document registry, persistent state, scoring, workflow transitions or automatic
retries. Implementation correctness remains with delivery review, and execution failures remain at
their existing boundary.

### Observable acceptance examples

| Situation | Observable result |
| --- | --- |
| A connected product serves newcomers and calls for calm, scannable exploration | The UX proposal and rendered prototype explain and realize that direction. A working search that foregrounds unfamiliar query grammar is assessed for discoverability and effort, rather than accepted solely because queries execute. |
| All controls work and colors match, but large sparse panels, repeated actions or weak imagery undermine the intended journey | The evaluator independently inspects the preview and images, explains the concrete hierarchy/density/imagery problem against that product's direction, and requests a necessary correction when the consequence is material. No aesthetic from another product is imposed. |
| A mobile preview fits without overflow but has awkward scanning, crowded controls or excessive travel to complete the journey | For a mobile journey, the evaluator exercises it at a relevant mobile viewport and judges comfort and effort. Fit alone does not establish acceptance. |
| Motion is part of the product's design direction | Creators apply its stated purpose and the evaluator observes transitions or other affected motion in the running preview, relating observations to that purpose rather than relying only on still images. |
| The prototype faithfully renders a UX proposal whose interaction/design choice causes a material problem | The evaluator returns a concrete correction to UX. Corrected owning decisions and rendered work receive the existing current-revision evaluation. If the proposal is adequate and only the prototype is wrong, the prototype repair path applies. |
| The experience supports product intent and users with no known material issue, but the evaluator prefers another color treatment or minor polish | The evaluator accepts the work and explains why the suggestion is nonblocking, without forcing a repair round. |
| Production UI is implemented from accepted preparation, or materially changes its design | The developer uses product direction and retained prototype evidence, preserves the evaluated experience, and validates the implemented journey. A material change updates owning decisions and receives appropriate experience validation. |
| An internal Nexus instruction change does not alter the reporting terminal, or a connected project has no applicable imagery/motion guidance | Existing evaluated UX/prototype skips remain available for the internal change. UI guidance uses available project intent without inventing design documents, imagery or animation obligations. |
| A preview is unavailable, or only code, text or the author's screenshots have been reviewed | An applicable Storybook prototype receives no design acceptance until the evaluator performs its own required live interaction and image inspection. Execution failures stay at their owning boundary. |
| Subsequent normal role invocations run after delivery, including a developer repair and relevant profile variants | Supplied guidance includes each role's applicable product-grounding and assessment duties, agrees with owning docs, and preserves applicability, stage-return and delivery-review boundaries. |

### Scope and unsettled decisions

The captured HARN-113 description and owner clarifications require this guidance for creators as
well as evaluators. KAN-82 is attributed motivating evidence from that input, not independently
inspected work or a universal aesthetic. Its restart, ticket and workspace are outside this change.
Nexus's own reporting-terminal experience is unchanged.

No material product decision remains unsettled in the supplied input. Prompt composition and
verification design belong to Architecture; delivery implements and verifies the guidance. These
requirements add no role, workflow gate, scoring system or observation schema.

## Architect

Define or revise responsibilities, public contracts and data handling needed by the accepted journey.
Follow the project's design principles and authoritative documents. Seek the simplest maintainable
solution. Produce one or more bounded implementation tasks with dependencies and completion criteria.
Return specific input constraints upstream when no feasible clean design supports the proposed work.

## Architecture Evaluator

Trace acceptance outcomes through the design and assess feasibility, ownership, contracts, data and
failure handling. Seek simpler responsibilities, reuse and lower coupling. Check the implementation
plan collectively covers the outcome without oversized or overlapping tasks. Return work upstream
only when an input needs correction; architectural difficulties that can be cleanly solved here
belong here. Apply the bounded material-quality standard to existing design directly, while
evaluating the implementation plan.
