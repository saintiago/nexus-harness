# Idea refinement workflow

This specification defines a workflow for any connected project, separate from finite delivery.

## Purpose

Turn a submitted idea into a concise, evidence-backed brief that is ready for requirements and
architecture work, or return it to its author with specific feedback. The workflow must not keep an
idea waiting in an internal holding state. Approval means **ready for design**, not ready for
implementation or movement into the delivery queue.

An **idea** is a possible project improvement, normally framed as a need, opportunity, or desired
outcome. It need not arrive with evidence or a complete proposal; refinement develops that. It
generally leaves solutions to Requirements and Design. An idea about an architectural improvement
may name its proposed direction at concept level. Preserve the author's intent and seek the
underlying need. Keep this definition lightweight and not restrictive.

This definition is supplied automatically to every idea refinement role invocation, ahead of that
role's own context. No role depends on reading this specification, and the role prompts below add
only role-specific duties.

Refinement tests purpose, substance and simplicity while change is cheap. The result is a decision
aid, not a design document: about 300–500 words that state the improvement as one concise `idea` —
the need, opportunity or desired outcome and why it may matter or fit — with the strongest
supporting evidence, meaningful alternatives, smallest plausible scope and key uncertainty. It does
not design the solution, write implementation requirements, modify project code or create a To Do
delivery ticket. Research detail stays in its research artifact. A separate Requirements and Design
workflow may consume an approved brief later.

## Expected outcomes

- **Ready for design:** every council reviewer approves the exact current brief revision. Save
  one handoff artifact with the source issue workspace and references to the captured idea,
  approved brief, purpose assessment, research and council decisions. Later workflows can read
  the full retained history from that workspace. Publish the approved brief to Jira for the
  Requirements and Design workflow; keep internal agent feedback in artifacts and logs. The
  published brief reports the council cycles used and the cumulative summary of what refinement
  changed. Move the source item to its configured approved state. For HARN Jira, this is
  `Idea Refinement -> Draft`. No automatic move to To Do.
- **Returned to author:** at least one reviewer finds the idea unworkable, or bounded internal
  revision cannot converge. Publish a concise, actionable human-facing comment and move the item
  to its configured waiting-for-feedback state. An exhausted return says that attempts were
  exhausted, reproduces the last concise brief with its cycle count and cumulative change summary,
  and names the remaining material objections with their corrections; exhaustion alone is not a
  rejection. An `idea_not_working` return states the reviewer's actual reason. For HARN Jira, this
  is `Idea Refinement -> Waiting for Feedback`. The author replies in a Jira comment with their
  feedback or revised idea and moves the item back to `Idea` to resubmit it; this run ends.
  The original idea, latest brief, research and complete council feedback remain in artifacts
  and logs; raw council evidence, code citations and tool transcripts are not published. Internal
  agent feedback is not published to Jira.
- **Execution fault:** inaccessible project sources, agent/tool failure, malformed output or
  source update failure is an operational fault, not a council verdict. Application handles it
  under the common execution-fault contract. Never manufacture approval.

A waiting-for-feedback item is excluded from automatic selection until explicit resubmission.
The workflow never silently waits for author input.

## Inputs and project context

Each time an item enters `Idea`, selection captures one immutable input: source key, author,
current text, links, revision and complete relevant Jira conversation. Every agent receives that
input and the saved workspace artifacts available when its stage starts, including earlier
submissions, briefs and feedback when present, as content or readable references. The current
cycle's inputs are supplied directly; earlier material stays available as references that agents
read selectively, guided by the latest cumulative brief summary rather than restating obsolete
reports. The same context rule applies on first submission, resubmission and internal revision.
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
   briefs and feedback when present, and every council criterion below. It records a decision aid
   of about 300–500 words. The `idea` field states the proposed improvement coherently: the need,
   opportunity or desired outcome and why it may matter or fit, as one idea rather than separate
   problem, value and project-fit essays. The other fields carry the strongest supporting evidence,
   meaningful alternatives, smallest plausible scope and key uncertainty, which the existing
   assumptions list holds. Research detail stays in the research artifact. The brief must not
   prescribe implementation, detailed requirements, command syntax, file or line inventories,
   schemas, component placement, acceptance criteria or resolution of design tradeoffs.
   `changeSummary` is the cumulative account of what refinement changed across the submission's
   cycles, and the brief's cycle number records how many council cycles were used. It must make
   purpose, value, evidence and scope clear enough for the council to decide, and distinguish
   evidence from proposal.
5. Three council reviewers run concurrently and independently on the same immutable brief revision.
   They see the current captured idea, brief and available history, but not one another's
   current-cycle verdicts before submitting their own. Each emits exactly one verdict:
   `approve`, `minor_corrections`, `major_rework` or `idea_not_working`. A nonapproval names the
   failed criterion, evidence and actionable correction. Every council invocation carries one
   shared objection standard: ask how the objection improves the idea. An objection may sharpen,
   redirect or narrow the idea, or show that it should not proceed (`idea_not_working`);
   preventing a bad idea is a real improvement. Factual or design nitpicks that do not improve the
   idea-stage outcome are not objections, incidental implementation detail the brief should not
   contain is not an objection, and the brief's length alone is never a fault. The standard adds no
   output field and no route.
6. After all council results are saved, route by strongest verdict:
   `idea_not_working > major_rework > minor_corrections > approve`. Preserve all feedback in
   artifacts even when one result determines routing. Unanimous approval alone advances to the
   approved state. Do not post internal council feedback or revision requests to Jira.
7. Minor corrections return to Brief Writer using existing purpose and research reports. Major rework
   reruns Purpose Verifier and Researcher concurrently with the current captured idea and all
   available workspace artifacts, including the current brief and council feedback. Their next
   reports must address the objections; the writer then creates a new brief revision. Any rewrite invalidates every earlier approval. The council reviews the new
   revision independently.
8. The configured maximum number of council cycles bounds internal work. If another revision would
   exceed it, return to the author as unable to converge: the comment says that attempts were
   exhausted, reproduces the last concise brief with the cycles used and the cumulative change
   summary, and lists the remaining material objections and requested corrections. An
   `idea_not_working` verdict returns immediately with the reviewer's actual reason and actionable
   corrections. Both routes post a concise human-facing comment to Jira, then set
   `Waiting for Feedback`; their decision artifacts retain distinct reasons and full feedback.
   Publication never dumps raw council evidence, code citations or tool transcripts, and
   exhaustion never reads as rejection of the idea.
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
context. Every invocation receives the shared definition of *idea* from the Purpose section ahead
of its role-specific context, and every council invocation receives the shared objection standard
from Behavior step 5 the same way. The prompts below are required role instructions. Each action
supplies the current captured idea, the saved workspace artifacts as readable references with an
instruction to read them selectively, the current cycle's inputs directly, project sources,
revision/cycle and output schema. Every invocation also receives the connected project's root
`AGENTS.md` content when present. Agents follow that guidance and the project documents it
references; a missing `AGENTS.md` does not block refinement. Agent output is parsed and checked by
the owning action; a role's claim never counts as a source status update. Profiles may use
different models or tools, but all six are separately attributable invocations. Purpose and
research must be able to run concurrently. Council roles must not read one another's pending
outputs.

### Purpose Verifier

> Be wise and philosophical about the project's enduring purpose: consider the values and
> long-term direction behind the idea, then ground every conclusion in evidence. Find this
> project's purpose, charter and long-term vision in its documentation. If those documents
> are absent or incomplete, inspect the connected project's code and commit history
> and infer its direction as well as the evidence permits. Read the supplied prior briefs and
> feedback when present; assess the current captured idea against the discovered purpose or
> provisional inference. Read the retained history selectively: consult only the artifacts that
> bear on the current decision. Identify where it supports or conflicts with the project's
> direction and the smallest steering that would improve fit. Cite documents, files and commits
> for each material claim; distinguish stated intent from inference and name uncertainty
> or conflicts. Do not design architecture, write requirements or decide implementation priority.
> Return a concise purpose assessment, conflicts, suggested steering and source references.

### Researcher

> Be idealistic, trusting and receptive to new ideas and principles. Treat the current
> captured idea as worth developing. Use the supplied workspace history, project knowledge,
> existing work and accessible internet sources to enrich it with relevant findings, related
> solutions, approaches, patterns and technologies. Read the retained history selectively, and
> keep findings and options relevant to the current decision. Explore promising possibilities
> and explain how each could strengthen the idea. Give links and access dates for external
> sources; distinguish source facts from your suggestions. Do not scrutinize, reject or
> argue against the idea, and do not select an architecture. Return a concise enrichment
> report with useful knowledge, options and sources.

### Brief Writer

> Write the smallest coherent idea brief from the current captured idea, purpose assessment,
> research, and the supplied earlier briefs and feedback. Be witty when a light, precise turn
> of phrase makes the brief clearer; keep the substance and tone suitable for a project decision.
> Preserve intent while applying justified steering. Aim for a decision aid of about 300-500
> words. State the improvement as one idea: the need, opportunity or desired outcome and why it
> may matter or fit the project, as coherent prose rather than separate problem, value and
> project-fit essays. The remaining fields carry the strongest supporting evidence, meaningful
> existing alternatives, smallest plausible scope and key uncertainty.
> Keep research detail in the research artifact and cite it selectively. Do not prescribe
> implementation, detailed requirements, command syntax, file or line inventories, schemas,
> component placement, acceptance criteria or resolution of design tradeoffs. Write changeSummary
> as the cumulative account of what refinement has changed across cycles, not only the latest
> edit. Address each prior objection explicitly. The council will check fidelity, evidence and
> simplicity. Return a complete brief revision and a concise cumulative change summary.

### Purpose Council Reviewer

> Be unforgiving about material gaps, pragmatic about what the project can use, and precise
> in your reasoning. Independently review the exact supplied brief revision against the
> original idea and the Purpose Verifier's cited documents or provisional inference from code
> and commits. Check project fit, coherent value, evidence quality and fidelity to the
> author's intent. Object only to gaps that materially affect the idea-stage decision; do not
> request implementation detail the brief should not contain, and do not fail it on length or
> style. Read the retained history selectively. Keep your summary short and every correction
> actionable. Choose exactly one: approve when criteria are met; minor_corrections for a
> brief-only fix; major_rework when purpose or research must be revisited; idea_not_working when
> revision is unlikely to make the idea worthwhile. Do not raise severity for style or
> personality. For any objection, name the criterion, cite evidence and give a concrete
> correction. Do not review other council verdicts or design the solution.

### Evidence Council Reviewer

> Be unforgiving about unsupported claims, pragmatic about the evidence needed for a useful
> decision, and precise in every finding. Independently review the exact supplied brief
> revision against the research and its cited sources. Check that the idea's need, value and fit
> are substantiated, duplicates and alternatives are represented fairly, sources support the
> claims, and uncertainty is explicit. Object only to material gaps in the idea-stage evidence;
> do not demand implementation detail, file inventories or resolved design tradeoffs, and do not
> fail the brief on length or style. Read the retained history selectively. Keep your summary
> short and every correction actionable. Choose exactly one: approve when criteria are met;
> minor_corrections for a brief-only fix; major_rework when purpose or research must be
> revisited; idea_not_working when revision is unlikely to make the idea worthwhile. Keep
> severity proportionate to the material gap. For any objection, name the criterion, cite
> evidence and give a concrete correction. Do not review other council verdicts or invent
> missing evidence.

### Simplicity Council Reviewer

> Be unforgiving about avoidable complexity, pragmatic about the smallest useful scope,
> and precise about what to remove. Independently review the exact supplied brief revision.
> Challenge unnecessary features, process, configuration, abstractions and promised guarantees
> relative to the stated need and evidence. Check that the brief is understandable and leaves
> design decisions to the next workflow. Object only when avoidable complexity or an oversized
> promise materially affects the idea-stage decision; do not demand implementation detail or
> resolved design tradeoffs, and do not fail the brief on length or style. Read the retained
> history selectively. Keep your summary short and every correction actionable. Choose exactly
> one: approve when criteria are met; minor_corrections for a brief-only fix; major_rework when
> purpose or research must be revisited; idea_not_working when revision is unlikely to make the
> idea worthwhile. Keep severity proportionate to the material gap. For any objection, name the
> criterion, cite evidence and give a concrete correction. Do not review other council
> verdicts.

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
      brief.json
      council/purpose.json
      council/evidence.json
      council/simplicity.json
    decision.json
  handoff.json
```

Submission and cycle numbers are positive integers. The submission number is a storage identity,
not a different workflow path. Minor revision may reuse the current submission's preceding
purpose/research reports by reference, never by falsely relabeling them as new work. Major revision
writes new reports. Each council result names the immutable brief artifact it reviewed, its
reviewer identity, verdict, criteria and feedback. A council set is valid only when all three
results name the current brief artifact. Captured inputs, decisions and prior cycles are
retained in the workspace. The decision artifact records the route, strongest verdict, full
feedback and source update evidence, including the human-facing Jira comment when applicable.
A brief revision's `cycle` is the number of council cycles used for the submission, and its
`changeSummary` is the cumulative account of what refinement changed. These existing fields carry
the reporting publication needs, so briefs retained from earlier runs stay readable without
migration. A brief written before the `idea` field keeps being read: its problem, value and project
fit are presented as the one idea they already express. That compatibility is read-time only:
retained artifacts and interrupted state are never rewritten, and new briefs write `idea` alone.
An approval also writes the single `handoff.json` with the shared issue workspace and references to
the captured input, approved brief, purpose assessment, research and council decisions. SelectIdea's
selection record sits beside the idea-refinement execution's workflow state; StartIdeaRound writes
the captured input's retained `input.json` copy when it opens the submission, and every role reads
that copy as the current captured idea.
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

Actions write complete outputs before returning a transition outcome. A changed brief invalidates
all council results for that brief. Concurrent roles have distinct artifact paths and no shared
writable output. XState control state is separate from these business artifacts.

## Workflow pseudocode

This is structural XState pseudocode, not a second executable coordinator. Actions perform the
named operations and return outcomes; XState owns parallelism, joins, guards and routing.

```ts
machine IdeaRefinement {
  context: { cycle, maxCycles, inputRef, roundPlanRef, currentBriefRef, verdictRefs: [] }

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
    onDone(briefRef) -> reviewCouncil
  }

  state reviewCouncil parallel {
    region purpose   { invoke PurposeCouncil;   onDone -> final }
    region evidence  { invoke EvidenceCouncil;  onDone -> final }
    region simplicity{ invoke SimplicityCouncil;onDone -> final }
    onDone -> routeVerdicts              // only after all three save results
  }

  state routeVerdicts {
    entry: collectAllFeedbackAndValidateSameBriefRevision
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
  human-facing comment is a concise decision aid and never publishes raw council evidence, code
  citations or tool transcripts.
- The brief is a decision aid of about 300–500 words: one `idea` stating the need, opportunity or
  desired outcome and why it may matter or fit, the strongest supporting evidence, meaningful
  alternatives, smallest plausible scope and key uncertainty, without prescribing implementation,
  requirements, code detail or design resolutions. Its length is guidance for the writer and never
  a validated execution gate.
- The published brief and the returned comment report the council cycles used and the cumulative
  change summary. An exhausted return says that attempts were exhausted, reproduces the last
  concise brief and names the remaining material objections without implying rejection; an
  unworkable verdict states its actual reason and actionable corrections.
- Council reviewers apply one shared objection standard: an objection must improve the idea by
  sharpening, redirecting or narrowing it, or show that it should not proceed (`idea_not_working`);
  preventing a bad idea is a real improvement, and factual or design nitpicks are not objections.
  Agent reports stay concise, and every role reads retained artifacts through their references and
  selectively.
- Every role invocation receives the shared definition of *idea* exactly once, ahead of its
  role-specific context. Role prompts carry only role-specific duties and do not repeat the
  definition.
- A retained brief written before the `idea` field stays readable: its problem, value and project
  fit are read as one idea for the next revision and for publication, and the artifact itself is
  never rewritten.
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
