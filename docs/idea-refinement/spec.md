# Idea refinement workflow

This specification documents Nexus's design and behavior for a workflow any connected project can
run, separate from finite delivery. It is authoritative for implementing Nexus and is relevant
evidence for ideas about this workflow, but it is not an operating guide for idea refinement roles:
each run's roles follow their supplied role instructions, the captured idea, artifacts and relevant
project evidence.

## Purpose

Turn a submitted idea into a concise, evidence-backed refined idea that is ready for requirements
and architecture work, or return it to its author with specific feedback. The workflow must not
keep an idea waiting in an internal holding state. Approval means **ready for design**, not ready
for implementation or movement into the delivery queue.

An idea describes a desirable change in software, why it matters, and the principle behind it—without yet committing to implementation.

The refined idea states that idea in clear parts: `idea` states the desirable change, why it
matters and the principle behind it, without yet committing to implementation; `projectFit` states
why it belongs in this project; `feasibility` states a plausible path given the known constraints
and evidence, not a design or implementation plan; and `openQuestions` lists only the material
questions the next workflow must answer, and may be absent. It stays concise and on point,
preserves the author's intent and leaves detailed research in its research artifact. Council
decisions and history live in their own artifacts, separate from the refined idea's substance.

An initial submission may lack evidence, the proposed change, why it matters or the principle
behind it; that is not an intake rejection, because refinement develops those elements. A finished
refined idea still needs enough clarity and substance for the council's idea-stage decision, and
the council may object when it cannot decide. Refinement works on the idea as the author proposed
it: it preserves that concept and intent rather than replacing it with a different or more generic
need. The idea stage decides whether the idea is worth developing and its smallest useful scope;
exact selection, configuration and implementation belong to Requirements and Design. An
architectural idea may name its direction at concept level, and architecture documents are
evidence of existing capabilities and constraints rather than design decisions the idea must
settle. Genuine ambiguity in the stated idea is a legitimate finding, while need, purpose fit,
value, evidence and simplicity stay open to scrutiny. Rejecting an unsuitable idea is a valid
outcome.

Nexus supplies the definition, this idea-stage guidance and one shared communication rule to every
idea refinement role invocation ahead of that role's own context; this specification states their
intent rather than acting as a run-time playbook. The communication rule asks for short, plain,
concrete turns addressed to the next role, with only the observations and citations that bear on
the idea-stage decision. It asks roles to research and cite relevant sources for substantive
claims, but not fact-check incidental wording or nitpick details that cannot change the idea-stage
decision. It welcomes genuine skepticism, useful research and rejecting an unsuitable idea, and
keeps rhetorical and implementation prose out. No role depends on reading this specification, and
the role prompts below add only role-specific duties.

Refinement tests purpose, substance and simplicity while change is cheap. The result is a decision
aid, not a design document: a refined idea of about 150–200 words across its four parts, with only
material detail and plain, direct language. Each part gets one to three short sentences, and open
questions stay at a few. The length is a default, not a rigid cap: keep any context the council
needs to decide. The strongest supporting evidence, meaningful alternatives, smallest plausible
scope and key uncertainty stay in the purpose and research reports it draws on. It does not design
the solution, write implementation requirements, modify project code or create a To Do delivery
ticket. Research detail stays in its research artifact. A separate Requirements and Design
workflow may consume an approved refined idea later.

## Expected outcomes

- **Ready for design:** every council reviewer approves the exact current refined idea revision.
  Save one handoff artifact with the source issue workspace and references to the captured idea,
  approved refined idea, purpose assessment, research and council decisions. Later workflows can
  read the full retained history from that workspace. Publish the approved refined idea to Jira
  for the Requirements and Design workflow; keep internal agent feedback in artifacts and logs.
  The published refined idea reports the council cycles used and the cumulative summary of what
  refinement changed. Move the source item to its configured approved state. For HARN Jira, this
  is `Idea Refinement -> Draft`. No automatic move to To Do.
- **Returned to author:** at least one reviewer finds the idea unworkable, or bounded internal
  revision cannot converge. Publish a concise, actionable human-facing comment and move the item
  to its configured waiting-for-feedback state. The comment states the plain outcome — returned
  for feedback, or attempts exhausted after the cycles used — reproduces the latest refined idea
  with the cycle count and cumulative change summary, lists the actionable corrections under what
  stopped approval, and closes with the single next step. An exhausted return keeps every distinct
  material correction and never reads as rejection; a return reports that the council did not
  approve the idea, never that the idea has no worth. For HARN Jira, this is
  `Idea Refinement -> Waiting for Feedback`. The author replies in a Jira comment with their
  feedback or revised idea and moves the item back to `Idea` to resubmit it; this run ends. The
  original idea, latest refined idea, research and complete council feedback remain in artifacts
  and logs; raw reviewer summaries, council verdict names, criteria, evidence, code citations and
  tool transcripts are not published. Internal agent feedback is not published to Jira.
- **Execution fault:** inaccessible project sources, agent/tool failure, malformed output or
  source update failure is an operational fault, not a council verdict. Application handles it
  under the common execution-fault contract. Never manufacture approval.

A waiting-for-feedback item is excluded from automatic selection until explicit resubmission.
The workflow never silently waits for author input.

## Inputs and project context

Each time an item enters `Idea`, selection captures one immutable input: source key, author,
current text, links, revision and complete relevant Jira conversation. Every agent receives that
input and the saved workspace artifacts available when its stage starts, including earlier
submissions, refined ideas and feedback when present, as content or readable references. The
current cycle's inputs are supplied directly; earlier material stays available as references that
agents read selectively, guided by the latest cumulative change summary rather than restating
obsolete reports. The same context rule applies on first submission, resubmission and internal
revision.
The current captured input is authoritative for what the author now proposes; earlier artifacts
supply history. In this spec, `original idea` means the input captured for the current entry, not
the first version ever submitted. Council reviewers do not receive one another's pending verdicts
from the current cycle.

Project configuration provides an idea selection query and submitted, active, approved and
waiting-for-feedback status mappings on its existing Jira task source. Agents can read the
connected project's repository, documents and commit history. Nexus configuration selects
this workflow, the six role profiles, iteration limits and storage. Idea refinement uses the same Jira adapter as finite delivery with a separate
selection query. HARN selects Jira Task issues in `Idea`; `Idea Refinement` is the active status,
`Draft` is the approved status and `Waiting for Feedback` awaits human input.

SelectIdea reads the Jira issue and its relevant comments once, then moves it
to the active status. It reuses the source issue's stable workspace root when present, or creates
that root when absent, and derives its `refinement/` area. The source workspace pointer names the
shared issue root. The captured content is the input for this run. Publication uses that
snapshot and the run artifacts without another Jira read. The adapter owns Jira identity and
transition details; the workflow owns selection, verdicts and publication decisions.

The Purpose Verifier searches the connected project's documentation for its purpose, charter
and long-term vision. If these are absent or incomplete, it examines code and commit history
to infer the project's direction as well as the evidence permits. It cites the files and commits
used, labels inferred claims as provisional, and states uncertainty or conflicts. Missing purpose
documents alone are not an execution fault. The researcher may use configured web tools and must
retain links, dates and the distinction between source facts and inference. Repository and
internal-source reads are scoped to the connected project. Agent roles write no project code and
do not change source statuses. Nexus actions own artifacts and source updates.

## Behavior

1. Select one eligible submitted idea. In HARN, select Jira Task issues in `Idea`. Read the
   issue and relevant comments once, capture that input, find or create its stable workspace,
   and move it to `Idea Refinement` before invoking agents. This path also handles an item
   returned to `Idea` after human feedback; no separate resubmission branch exists.
2. StartIdeaRound opens the first council cycle for this selection from the workspace history and
   records the selected role profiles. Each later correction enters StartIdeaRound again with the route
   chosen by XState. The configured council-cycle limit applies to this selection.
3. Run Purpose Verifier and Researcher concurrently with the current captured idea and the
   available workspace history. The Purpose Verifier finds purpose documents itself and, where
   needed, infers purpose from code and commit history. They work independently and write
   separate reports. The writer starts only after both reports exist.
4. Brief Writer creates revision 1. It sees the current captured idea, both reports, earlier
   refined ideas and feedback when present, and every council criterion below. It records a short
   refined idea revision of about 150–200 words across its four parts, concise and on point, with
   one to three short sentences per part, at most a few open questions, only material detail and
   plain, direct language. Length is a default, not a rigid cap: keep any context the council
   needs to decide. The `idea` part states the author's idea: the proposed change, why it matters
   and the principle behind it, without committing to implementation. The `projectFit` part states
   why it belongs in this project. The `feasibility` part states a plausible path given the known
   constraints and evidence, not a design or implementation plan. The `openQuestions` part lists
   only the material questions the next workflow must answer, and may be absent. It preserves the
   author's intent. The strongest supporting evidence, meaningful alternatives, smallest plausible
   scope and key uncertainty stay in the purpose and research reports it draws on.
   `changeSummary` is the cumulative account of what refinement changed across the submission's
   cycles, and the revision's cycle number records how many council cycles were used; both are
   reporting metadata, and council decisions and history stay in their own artifacts. The revision
   must make purpose, value, evidence and scope clear enough for the council to decide, and
   distinguish evidence from proposal. It must not prescribe implementation or settle design
   decisions: no mechanism selection, detailed requirements, command syntax, file or line
   inventories, schemas, component placement, acceptance criteria or resolution of design
   tradeoffs.
5. Three council reviewers run concurrently and independently on the same immutable refined idea
   revision. They see the current captured idea, refined idea and available history, but not one
   another's current-cycle verdicts before submitting their own. Each emits exactly one verdict:
   `approve`, `minor_corrections`, `major_rework` or `idea_not_working`. A nonapproval names the
   failed criterion, evidence and correction, and writes that correction as a short, plain-language
   request the author can act on, distinct from the internal evidence and summary. Every council
   invocation carries one shared objection standard: ask how the objection improves the idea. An
   objection may sharpen, narrow or correct the idea as the author proposed it, name a genuine
   ambiguity in the stated idea, or show that it should not proceed (`idea_not_working`);
   preventing a bad idea is a real improvement. An objection never silently replaces the author's
   proposal with a different or more generic idea. Factual or design nitpicks that do not improve
   the idea-stage outcome are not objections, incidental implementation detail the refined idea
   should not contain is not an objection, and the refined idea's length alone is never a fault. An
   unresolved design choice is a blocker only when it changes the idea-stage decision: whether the
   idea is worth developing, its purpose fit, value, evidence or smallest useful scope. Otherwise
   it belongs to Requirements and Design. Every finding keeps its parts distinct and
   author-facing: the criterion names the standard that failed, the evidence carries the internal
   justification, and the correction is the short request in plain language that the author can
   act on, standing alone without the reviewer's evidence or summary. The standard adds no output
   field and no route.
6. After all council results are saved, route by strongest verdict:
   `idea_not_working > major_rework > minor_corrections > approve`. Preserve all feedback in
   artifacts even when one result determines routing. Unanimous approval alone advances to the
   approved state. Do not post internal council feedback or revision requests to Jira.
7. Minor corrections return to Brief Writer using existing purpose and research reports. Major
   rework reruns Purpose Verifier and Researcher concurrently with the current captured idea and
   all available workspace artifacts, including the current refined idea and council feedback.
   Their next reports must address the objections; the writer then creates a new refined idea
   revision. Any rewrite invalidates every earlier approval. The council reviews the new revision
   independently.
8. The configured maximum number of council cycles bounds internal work. If another revision would
   exceed it, return to the author as unable to converge: the comment says that attempts were
   exhausted after the cycles used and lists every distinct material correction. An
   `idea_not_working` verdict returns immediately with the corrections that stopped approval. Both
   routes state the plain outcome, the latest refined idea, the cycles used, the cumulative change
   summary, what stopped approval and the single next step; a return reports that the council did
   not approve the idea rather than that it has no worth. Both post a concise human-facing comment to
   Jira, then set `Waiting for Feedback`; their decision artifacts retain distinct reasons and full
   feedback. Publication never dumps raw reviewer summaries, verdict names, criteria, evidence,
   code citations or tool transcripts, and exhaustion never reads as rejection of the idea.
9. An approved handoff is available to the Requirements and Design workflow from the approved
   source state. That workflow defines requirements and architecture, and may then produce a
   To Do implementation ticket.

A reviewer may choose minor only when the current purpose and research reports remain valid.
Choose major when the premise, purpose fit, evidence or alternatives require renewed investigation.
Choose idea not working when an actionable internal revision is unlikely to make the idea worthwhile.
Disagreement is a finding, not a vote count; every reviewer has a veto until the next revision.
Questions that prevent a decision about purpose, value, evidence or smallest useful scope cannot
be deferred to design; the council must request a correction or return the idea to its author.

## Agents and constant prompts

Each role is a configured AgentRuntime profile with a complete constant prompt plus invocation
context. Every invocation receives the shared definition of *idea*, the idea-stage guidance and
the communication rule from the Purpose section exactly once each, ahead of its role-specific
context, and every council invocation receives the shared objection standard from Behavior step 5
the same way. The prompts below are required role instructions. Each action supplies the current
captured idea, the saved workspace artifacts as readable references with an instruction to read
them selectively, the current cycle's inputs directly, project sources, revision/cycle and output
schema. Every invocation also receives the connected project's root `AGENTS.md` content when
present. Agents follow its applicable instructions and treat the architecture and project documents
it links as evidence to consult only when relevant to the current idea: they do not open every link
by default and never treat architecture specifications as role instructions. A missing `AGENTS.md`
does not block refinement.
Agent output is parsed and checked by the owning action; a role's claim never counts as a source
status update. Profiles may use different models or tools, but all six are separately attributable
invocations. Purpose and research must be able to run concurrently. Council roles must not read one
another's pending outputs.

### Purpose Verifier

> Be wise and philosophical about the project's enduring purpose: consider the values and
> long-term direction behind the idea, then ground every conclusion in evidence. Find this
> project's purpose, charter and long-term vision in its documentation. If those documents
> are absent or incomplete, inspect the connected project's code and commit history
> and infer its direction as well as the evidence permits. Read the supplied prior refined ideas
> and feedback when present; assess the current captured idea against the discovered purpose or
> provisional inference. Read the retained history selectively: consult only the artifacts that
> bear on the current decision. Identify where it supports or conflicts with the project's
> direction and the smallest steering that would improve fit, including when the conflict makes
> the idea not worth developing. Cite documents, files and commits for each material claim;
> distinguish stated intent from inference and name uncertainty or conflicts. Check fidelity to the
> stated idea: preserve the author's proposed concept and intent, explain what the idea wants to
> change and why it may matter where useful, and judge its purpose fit and worth rather than its
> design. Flag a genuine ambiguity in the stated idea instead of silently substituting a different
> or more generic proposal. Do not design architecture, write requirements, decide implementation
> priority or ask the idea to settle design decisions such as component ownership, routing,
> configuration or artifact layout. Architecture and design documents are evidence of existing
> capabilities and constraints. Return a short purpose assessment: only the few material findings,
> the steering that improves fit and the source references that support them.

### Researcher

> Be idealistic, trusting and receptive to new ideas and principles. Treat the submitted idea
> as worth developing. Enrich its proposed change, why it matters and the principle behind it with
> sourced knowledge, examples, relevant technologies and patterns, and conceptual possibilities
> that give it substance, using the supplied workspace history, project knowledge, existing work
> and accessible internet sources. Read the retained history selectively and keep findings and
> options relevant to the current decision. Keep suggestions and options at idea level: strengthen
> the author's proposal without replacing it with another idea, and produce no implementation plan
> or draft configuration, role catalogues, trigger mechanisms, vote policies, artifact layouts or
> requirements. Give links and access dates for external sources; distinguish source facts from
> your suggestions. Do not scrutinize, reject or argue against the idea, and do not select an
> architecture. Return a short enrichment report with a few enriching examples, the knowledge they
> add and their sources, not a catalogue.

### Brief Writer

> Write the smallest coherent refined idea from the current captured idea, purpose assessment,
> research, and the supplied earlier refined ideas and feedback. Be witty when a light, precise turn
> of phrase makes it clearer; keep the substance and tone suitable for a project decision.
> Preserve intent while applying justified steering: work on the author's idea as submitted,
> keeping its proposed concept and direction rather than replacing it with a different or more
> generic idea. Keep the refined idea short by default: about 150-200 words across all four parts,
> with only material detail and plain, direct language. Give each part one to three short sentences
> and keep open questions to at most a few. That length is a default, not a rigid cap: keep any
> context the council needs to decide.
> The `idea` part states the desirable change, why it matters and the principle behind it, without
> committing to implementation. The `projectFit` part states why it belongs in this project. The
> `feasibility` part states a plausible path given the known constraints and evidence; it is not a
> design or implementation plan. The `openQuestions` part lists only the material questions the
> next workflow must answer, and may be omitted when there are none. Keep detailed research in the
> research artifact and cite it selectively. Do not prescribe implementation or settle design
> decisions: no mechanism selection, detailed requirements, command syntax, file or line
> inventories, schemas, component placement, acceptance criteria or resolution of design tradeoffs.
> Keep council history and what refinement changed out of the idea's parts; write changeSummary as
> the cumulative account of what refinement has changed across cycles, not only the latest edit.
> Address each prior objection explicitly. The council will check fidelity, evidence and simplicity.
> Return a complete refined idea revision and a short cumulative change summary.

### Purpose Council Reviewer

> Be unforgiving about material gaps, pragmatic about what the project can use, and precise
> in your reasoning. Independently review the exact supplied refined idea revision against the
> original idea and the Purpose Verifier's cited documents or provisional inference from code
> and commits. Check project fit, coherent value, evidence quality and fidelity to the stated
> idea; flag a genuine ambiguity instead of letting the revision silently substitute a different or
> more generic proposal. Object only to gaps that materially affect the idea-stage
> decision; do not request implementation detail the refined idea should not contain, and do not fail
> it on length or style. Read the retained history selectively. Keep your summary short and
> internal and report only the few findings that change the idea-stage decision. Choose exactly
> one: approve when criteria are met; minor_corrections for a refined-idea-only fix; major_rework when
> purpose or research must be revisited; idea_not_working when revision is unlikely to make the
> idea worthwhile. Do not raise severity for style or personality. For any objection, name the
> criterion, cite evidence and give a concise correction the author can act on. Do not review
> other council verdicts or design the solution.

### Evidence Council Reviewer

> Be unforgiving about unsupported claims, pragmatic about the evidence needed for a useful
> decision, and precise in every finding. Independently review the exact supplied refined idea
> revision against the research and its cited sources. Check that the idea's need, value and fit
> are substantiated, duplicates and alternatives are represented fairly, sources support the
> claims, and uncertainty is explicit. Object only to material gaps in the idea-stage evidence;
> do not demand implementation detail, file inventories or resolved design tradeoffs, and do not
> fail the refined idea on length or style. Read the retained history selectively. Keep your summary
> short and internal and report only the few findings that change the idea-stage decision. Choose
> exactly one: approve when criteria are met; minor_corrections for a refined-idea-only fix;
> major_rework when purpose or research must be revisited; idea_not_working when revision is
> unlikely to make the idea worthwhile. Keep severity proportionate to the material gap. For any
> objection, name the criterion, cite evidence and give a concise correction the author can act on.
> Do not review other council verdicts or invent missing evidence.

### Simplicity Council Reviewer

> Be unforgiving about avoidable complexity, pragmatic about the smallest useful scope,
> and precise about what to remove. Independently review the exact supplied refined idea revision.
> Challenge unnecessary features, process, configuration, abstractions and promised guarantees
> relative to the stated need and evidence. Check that the refined idea is concise, on point and
> leaves design decisions to the next workflow. Object only when avoidable complexity or an
> oversized promise materially affects the idea-stage decision; do not demand implementation detail
> or resolved design tradeoffs, and do not fail the refined idea on length or style. Read the
> retained history selectively. Keep your summary short and internal and report only the few
> findings that change the idea-stage decision. Choose exactly one: approve when criteria are met;
> minor_corrections for a refined-idea-only fix; major_rework when purpose or research must be
> revisited; idea_not_working when revision is unlikely to make the idea worthwhile. Keep severity
> proportionate to the material gap. For any objection, name the criterion, cite evidence and give
> a concise correction the author can act on. Do not review other council verdicts.

## Artifacts and revision binding

Use the `refinement/` area under the stable
`<storage root>/workspaces/<project>/<issue>/` workspace. Selection reuses the area when present
and creates it when absent. Prepare a Git worktree from the connected project under its
`worktree/` before invoking agents. AgentRuntime runs every idea role there through its normal
working-directory contract. Nexus owns writes under `artifacts/` and `state/`; idea agents do
not modify project code. Each entry from `Idea` has its own numbered history in that area:

```text
state/
  current-round.json
artifacts/
  submissions/<n>/
    input.json
    cycles/<m>/
      purpose.json
      research.json
      refined-idea.json
      council/purpose.json
      council/evidence.json
      council/simplicity.json
    decision.json
  handoff.json
```

Submission and cycle numbers are positive integers. The submission number is a storage identity,
not a different workflow path. Minor revision may reuse the current submission's preceding
purpose/research reports by reference, never by falsely relabeling them as new work. Major revision
writes new reports. Each council result names the immutable refined idea artifact it reviewed, its
reviewer identity, verdict, criteria and feedback. A council set is valid only when all three
results name the current refined idea artifact. Captured inputs, decisions and prior cycles are
retained in the workspace. The decision artifact records the route, strongest verdict, full
feedback and source update evidence, including the human-facing Jira comment when applicable.
A refined idea revision's `cycle` is the number of council cycles used for the submission, and
its `changeSummary` is the cumulative account of what refinement changed. These metadata fields
carry the reporting publication needs; the idea's parts stay separate from the council's decisions
and feedback. Revisions retained from earlier runs stay readable without migration: a brief kept
at its own `brief.json` path, in either earlier shape, is read as the refined idea it expresses,
with its problem and value presented as the idea part, and its project fit and smallest scope as
the project-fit and feasibility parts. That compatibility is read-time only: retained artifacts
and interrupted state are never rewritten, and new revisions write the refined idea's parts at
`refined-idea.json`. Council results, decisions and the handoff keep naming the reviewed revision
through the stored `brief` reference field they already used, so records saved before this change
stay readable.
An approval also writes the single `handoff.json` with the shared issue workspace and references to
the captured input, approved refined idea, purpose assessment, research and council decisions.
SelectIdea's selection record sits beside the idea-refinement execution's workflow state;
StartIdeaRound writes the captured input's retained `input.json` copy when it opens the
submission, and every role reads that copy as the current captured idea.
These artifact paths are specific to idea refinement; finite delivery's round layout at the
shared issue root is unchanged. Later workflows may read all retained artifacts in the issue
workspace without changing refinement state.

StartIdeaRound owns `state/current-round.json` with the active submission number, council cycle
the route that opened it and the selected role profiles:

```ts
type IdeaRoundPlan = {
  submission: number;
  cycle: number;
  route: "new" | "minor" | "major";
  profiles: Partial<Record<IdeaRole, string>>;
};
```

At each entry from `Idea`, it inspects the existing workspace history, opens the next
submission and starts cycle 1 with all six configured roles. For a minor correction, it opens
the next cycle with Brief Writer and the three council roles; for major rework, it includes Purpose
Verifier and Researcher as well. All available prior artifacts enter the invocation context
on every route, but earlier approvals do not apply to the new input. StartIdeaRound does not
decide the correction severity or final verdict: XState supplies the route after collecting all council
results. StartIdeaRound uses the shared round storage functions for history and plan persistence.
Its role selection and cycle policy are idea-specific; it does not apply finite delivery's repair
counters or developer ladder.

Actions write complete outputs before returning a transition outcome. A changed refined idea
invalidates all council results for that revision. Concurrent roles have distinct artifact paths
and no shared writable output. XState control state is separate from these business artifacts.

## Workflow pseudocode

This is structural XState pseudocode, not a second executable coordinator. Actions perform the
named operations and return outcomes; XState owns parallelism, joins, guards and routing.

```ts
machine IdeaRefinement {
  context: { cycle, maxCycles, inputRef, roundPlanRef, currentRefinedIdeaRef, verdictRefs: [] }

  selectIdea -> startIdeaRound("new") // captures input; HARN: Idea -> Idea Refinement

  state startIdeaRound(route) {
    invoke StartIdeaRound(route)
    onDone({ openedCycle, planRef }) {
      cycle = openedCycle
      roundPlanRef = planRef
      if route == "minor" -> writeBrief
      otherwise           -> assessAndResearch
    }
  }

  state assessAndResearch parallel {
    region purpose  { invoke PurposeVerifier; onDone -> final }
    region research { invoke Researcher;      onDone -> final }
    onDone -> writeBrief                 // only after both regions finish
  }

  state writeBrief {
    invoke BriefWriter
    onDone(refinedIdeaRef) -> reviewCouncil
  }

  state reviewCouncil parallel {
    region purpose   { invoke PurposeCouncil;   onDone -> final }
    region evidence  { invoke EvidenceCouncil;  onDone -> final }
    region simplicity{ invoke SimplicityCouncil;onDone -> final }
    onDone -> routeVerdicts              // only after all three save results
  }

  state routeVerdicts {
    entry: collectAllFeedbackAndValidateSameRefinedIdeaRevision
    always [
      if any(idea_not_working) -> returnToAuthor,
      if all(approve)         -> publishApproved,
      if cycle >= maxCycles   -> returnUnableToConverge,
      if any(major_rework)    -> startIdeaRound("major"),
      otherwise              -> startIdeaRound("minor")
    ]
  }

  publishApproved        -> final("approved")            // HARN: Idea Refinement -> Draft
  returnToAuthor         -> final("waiting-for-feedback") // Jira comment; HARN: Idea Refinement -> Waiting for Feedback
  returnUnableToConverge -> final("waiting-for-feedback") // same publication contract
}
```

The exact machine definition may split the named parallel states into XState child states. No
application-side promise fan-out, manual join, verdict router or separate council coordinator may
replace these transitions. The parallel regions invoke distinct actions and XState's completion
condition joins them. Each action's result is a small outcome or artifact reference, never the full
report in machine context.

## Agent activity and operator view

All six roles use the shared [agent activity events](../task-engine/architecture.md#agent-activity-events),
[execution log](../application.md#execution-log) and
[agent activity panes](../operator-interface.md#agent-activity-panes). Concurrent invocations
remain individually attributable through those contracts.
An idea action's outcome event names the idea key, the council cycle and the artifact it saved, so
the operator sees the same milestone line without internal paths.

## Verification criteria

- Selection follows the same path for every item in `Idea`. It reuses the issue's workspace when
  present, retains previous submissions, and StartIdeaRound opens the next submission at cycle 1.
  Each correction calls StartIdeaRound with XState's minor or major route and uses its saved role plan.
- Every idea role runs through AgentRuntime in the prepared `refinement/worktree/` Git worktree.
  Purpose and research can overlap; writer cannot start until both finish. All three council
  reviewers can overlap; routing waits for all three and aggregates all feedback.
- Mixed verdicts follow the stated precedence and preserve every objection. Minor repeats only the
  writer and council; major repeats purpose, research, writer and council. Every rewrite invalidates
  earlier approvals. Limits and an unworkable verdict return a complete feedback package. The
  human-facing comment is a concise decision aid and never publishes reviewer summaries, verdict
  names, criteria, evidence, code citations or tool transcripts.
- The refined idea is a short decision aid of about 150–200 words across its four parts, concise
  and on point, in plain, direct language: one to three short sentences per part, at most a few
  open questions, and only material detail. `idea` states the author's proposed change, why it
  matters and the principle behind it; `projectFit` states why it belongs in this project;
  `feasibility` states a plausible path given the known constraints and evidence; and
  `openQuestions` states only the material questions the next workflow must answer, or is absent.
  It neither prescribes implementation, requirements, code detail or design resolutions, nor
  carries the supporting evidence, alternatives and uncertainty that stay in the purpose and
  research reports. Its length is guidance for the writer and never a validated execution gate or
  rigid cap; necessary context is never dropped to fit it.
- The published refined idea and the returned comment report the council cycles used and the
  cumulative change summary. A returned comment states the plain outcome, reproduces the latest
  refined idea, lists the actionable corrections under what stopped approval and closes with the
  reply-and-move next step; it never publishes reviewer summaries, verdict names, criteria,
  evidence, code citations, research detail, alternatives or tool text. An exhausted return says
  that attempts were exhausted and keeps every distinct material correction without implying
  rejection; a return reports that the council did not approve, never that the idea has no worth.
- Council reviewers apply one shared objection standard: an objection must improve the idea. It may
  sharpen, narrow or correct the idea as the author proposed it, name a genuine ambiguity in the
  stated idea, or show that it should not proceed (`idea_not_working`); preventing a bad idea is a
  real improvement, and an objection never silently replaces the author's proposal with a different
  or more generic idea. Factual or design nitpicks are not objections, and an unresolved design
  choice is a blocker only when it changes the idea-stage decision. Every finding writes its
  correction as a short, plain-language request the author can act on, distinct from the internal
  evidence and summary. Agent turns stay short, plain and concrete for the next role, and every
  role reads retained artifacts through their references and selectively.
- Every role invocation receives the shared definition of *idea*, the separate idea-stage guidance
  and the shared communication rule exactly once each, ahead of its role-specific context. Role
  prompts carry only role-specific duties and do not repeat that text.
- A retained brief stays readable at its own path in either earlier shape: its problem and value
  are read as the idea part, its project fit and smallest scope as the project-fit and feasibility
  parts, and a brief whose single `idea` field stood alone is read without a project fit. Retained
  artifacts are never rewritten.
- The Purpose Verifier searches project documents. Missing purpose documents trigger code and commit
  investigation, with cited provisional inferences and uncertainty, rather than an operational fault.
  The purpose council evaluates that evidence without treating missing documents alone as a veto.
- Approval leaves no unresolved question that prevents judging purpose, value, evidence or
  smallest useful scope. Requirements and Design defines the solution before a To Do
  implementation ticket is produced.
- A selected HARN idea moves `Idea -> Idea Refinement` before agent work. It reaches `Draft`
  only after unanimous approval on one exact revision. Rejection or exhaustion moves it to
  `Waiting for Feedback` with a human-facing Jira comment; internal agent feedback stays in
  artifacts and logs. Neither route moves the item to To Do. Resubmission requires the author to
  reply in a Jira comment and move the item back to `Idea`. Selection captures that comment
  with the rest of the conversation on the same entry path. Execution faults do not publish a
  council verdict or request human feedback. A run reads its Jira input only at selection and
  does not re-read it before publication.
