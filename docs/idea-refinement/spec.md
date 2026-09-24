# Idea refinement workflow

This specification defines a workflow for any connected project, separate from finite delivery.

## Purpose

Turn a submitted idea into a concise, evidence-backed brief that is ready for requirements and
architecture work, or return it to its author with specific feedback. The workflow must not keep an
idea waiting in an internal holding state. Approval means **ready for design**, not ready for
implementation or movement into the delivery queue.

Refinement tests purpose, substance and simplicity while change is cheap. It does not design the
solution, write implementation requirements, modify project code or create a To Do delivery ticket.
A separate Requirements and Design workflow may consume an approved brief later.

## Expected outcomes

- **Ready for design:** every council reviewer approves the exact current brief revision. Save
  the original idea, approved brief, purpose assessment, research and sources, alternatives,
  council decisions and unresolved design questions as one handoff artifact. Publish the approved
  brief to Jira for the next workflow; keep internal agent feedback in artifacts and logs. Move
  the source item to its configured approved state. For HARN Jira, this is
  `Idea Refinement -> Draft`. No automatic move to To Do.
- **Returned to author:** at least one reviewer finds the idea unworkable, or bounded internal
  revision cannot converge. Publish concise, actionable human-facing feedback in a Jira comment
  and move the item to its configured waiting-for-feedback state. For HARN Jira, this is
  `Idea Refinement -> Waiting for Feedback`. The author replies in a Jira comment with their
  feedback or revised idea and moves the item back to `Idea` to resubmit it; this run ends.
  The original idea, latest brief, research and complete council feedback remain in artifacts
  and logs. Internal agent feedback is not published to Jira.
- **Execution fault:** inaccessible project sources, agent/tool failure, malformed output or
  source update failure is an operational fault, not a council verdict. Application handles it
  under the common execution-fault contract. Never manufacture approval.

A waiting-for-feedback item is excluded from automatic selection until explicit resubmission.
The workflow never silently waits for author input.

## Inputs and project context

Each time an item enters `Idea`, selection captures one immutable input: source key, author,
current text, links, revision and complete relevant Jira conversation. Every agent receives
that input and all saved workspace artifacts available when its stage starts, including earlier
submissions, briefs and feedback when present, as content or readable references. The same
context rule applies on first submission, resubmission and internal revision. The current
captured input is authoritative for what the author now proposes; earlier artifacts supply history.
In this spec, `original idea` means the input captured for the current entry, not the first
version ever submitted. Council reviewers do not receive one another's pending verdicts from the
current cycle.

Project configuration provides an idea selection query and submitted, active, approved and
waiting-for-feedback status mappings on its existing Jira task source. Agents can read the
connected project's repository, documents and commit history. Nexus configuration selects
this workflow, the six role profiles, iteration limits and storage. Idea refinement uses the same Jira adapter as finite delivery with a separate
selection query. HARN selects Jira Task issues in `Idea`; `Idea Refinement` is the active status,
`Draft` is the approved status and `Waiting for Feedback` awaits human input.

SelectIdea reads the Jira issue and its relevant comments once, then moves it
to the active status. It uses a stable workspace path for the issue, reusing that workspace when
it already exists. The captured content is the input for this run. Publication uses that
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
   briefs and feedback when present, and every council criterion below. It records a short
   problem/value statement, project fit, supporting evidence with links, alternatives, smallest
   useful scope, assumptions and open questions for design. It must distinguish evidence from proposal.
5. Three council reviewers run concurrently and independently on the same immutable brief revision.
   They see the current captured idea, brief and available history, but not one another's
   current-cycle verdicts before submitting their own. Each emits exactly one verdict:
   `approve`, `minor_corrections`, `major_rework` or `idea_not_working`. A nonapproval names the failed criterion, evidence and actionable correction.
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
   exceed it, return to the author as unable to converge. An `idea_not_working` verdict returns
   immediately. Both routes post the human-facing reason and requested action to Jira, then set
   `Waiting for Feedback`; their decision artifacts retain distinct reasons and full feedback.
9. An approved handoff is available to the Requirements and Design workflow from the approved
   source state. That workflow decides requirements and architecture and may ultimately produce
   a To Do implementation ticket.

A reviewer may choose minor only when the current purpose and research reports remain valid.
Choose major when the premise, purpose fit, evidence or alternatives require renewed investigation.
Choose idea not working when an actionable internal revision is unlikely to make the idea worthwhile.
Disagreement is a finding, not a vote count; every reviewer has a veto until the next revision.

## Agents and constant prompts

Each role is a configured AgentRuntime profile with a complete constant prompt plus invocation
context. The prompts below are required role instructions. Each action supplies the current
captured idea, all available saved workspace artifacts, project sources, revision/cycle and output
schema. Agent output is parsed and checked by the owning action; a role's claim never counts as a source
status update. Profiles may use different models or tools, but all six are separately attributable
invocations. Purpose and research must be able to run concurrently. Council roles must not read
one another's pending outputs.

### Purpose Verifier

> Be wise and philosophical about the project's enduring purpose: consider the values and
> long-term direction behind the idea, then ground every conclusion in evidence. Find this
> project's purpose, charter and long-term vision in its documentation. If those documents
> are absent or incomplete, inspect the connected project's code and commit history
> and infer its direction as well as the evidence permits. Read the supplied prior briefs and
> feedback when present; assess the current captured idea against the discovered purpose or
> provisional inference. Identify where it supports or conflicts with the project's direction
> and the smallest steering that would improve fit. Cite documents, files and commits for each
> material claim; distinguish stated intent from inference and name uncertainty
> or conflicts. Preserve the author's intent. Do not design architecture, write requirements or
> decide implementation priority. Return a concise purpose assessment, conflicts, suggested
> steering and source references.

### Researcher

> Be idealistic, trusting and receptive to new ideas and principles. Explore the strongest
> plausible version of the current captured idea before challenging it. Investigate using the
> supplied workspace history, project knowledge, existing work and accessible internet sources.
> Check duplicates and established alternatives, relevant articles, patterns and
> technologies. Give links and access dates for external sources. Separate facts, opinions
> and your inference; explain evidence quality and tradeoffs. Search enough to challenge
> the premise and avoid repeating known work, then stop. Do not choose an architecture or claim novelty
> without evidence. Return a concise research report with alternatives and open questions.

### Brief Writer

> Write the smallest coherent idea brief from the current captured idea, purpose assessment,
> research, and the supplied earlier briefs and feedback. Be witty when a light, precise turn
> of phrase makes the brief clearer; keep the substance and tone suitable for a project decision.
> Preserve intent while applying justified steering. Include the problem and expected value,
> project fit, supporting evidence and links, existing alternatives, smallest useful scope,
> assumptions, and questions for the later design workflow. Address each prior objection
> explicitly. Do not turn this brief into requirements, architecture or an
> implementation plan. The council will check fidelity, evidence and simplicity. Return a complete
> brief revision and a short change summary.

### Purpose Council Reviewer

> Be unforgiving about material gaps, pragmatic about what the project can use, and precise
> in your reasoning. Independently review the exact supplied brief revision against the
> original idea and the Purpose Verifier's cited documents or provisional inference from code
> and commits. Check project fit, coherent value, evidence quality and fidelity to the
> author's intent.
> Choose approve, minor_corrections, major_rework or idea_not_working using the workflow's severity
> definitions. Approve when the criteria are met; do not raise the severity for style or
> personality. For any objection, name the criterion, cite evidence and give a concrete
> correction. Do not review other council verdicts or design the solution.

### Evidence Council Reviewer

> Be unforgiving about unsupported claims, pragmatic about the evidence needed for a useful
> decision, and precise in every finding. Independently review the exact supplied brief
> revision against the research and its cited sources. Check that the problem and value are
> substantiated, duplicates and alternatives are represented fairly, sources support the
> claims, and uncertainty is explicit. Choose one allowed verdict
> with severity proportionate to the material gap. Approve when the evidence meets the criteria.
> For any objection, name the criterion, cite evidence and give a concrete correction. Do not
> review other council verdicts or invent missing evidence.

### Simplicity Council Reviewer

> Be unforgiving about avoidable complexity, pragmatic about the smallest useful scope,
> and precise about what to remove. Independently review the exact supplied brief revision.
> Challenge unnecessary features, process, configuration, abstractions and promised guarantees
> relative to the stated problem and evidence. Check that the brief is understandable and leaves
> design decisions to the next workflow. Choose one allowed verdict with severity proportionate
> to the material gap; approve a brief that meets the criteria. For any objection, name the
> criterion, cite evidence and give a concrete correction. Do not review other council verdicts.

## Artifacts and revision binding

Use a stable workflow-specific workspace under
`<storage root>/workspaces/<project>/<idea>/refinement/`. Selection reuses it when present and
creates it when absent. Keep a read-only project snapshot or references under `worktree/`; Nexus
owns writes under `artifacts/` and `state/`. Each entry from `Idea` has its own numbered history
within the same workspace:

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
```

Submission and cycle numbers are positive integers. The submission number is a storage identity,
not a different workflow path. Minor revision may reuse the current submission's preceding
purpose/research reports by reference, never by falsely relabeling them as new work. Major revision
writes new reports. Each council result names the immutable brief artifact it reviewed, its
reviewer identity, verdict, criteria and feedback. A council set is valid only when all three
results name the current brief artifact. Captured inputs, decisions and prior cycles are
retained in the workspace. The decision artifact records the route, strongest verdict, full
feedback and source update evidence, including the human-facing Jira comment when applicable.
These artifact paths are specific to idea refinement; finite delivery's round layout is unchanged.

StartIdeaRound owns `state/current-round.json` with the active submission number, council cycle
and selected role profiles:

```ts
type IdeaRoundPlan = {
  submission: number;
  cycle: number;
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

## Verification criteria

- Selection follows the same path for every item in `Idea`. It reuses the issue's workspace when
  present, retains previous submissions, and StartIdeaRound opens the next submission at cycle 1.
  Each correction calls StartIdeaRound with XState's minor or major route and uses its saved role plan.
- Purpose and research can overlap; writer cannot start until both finish. All three council
  reviewers can overlap; routing waits for all three and aggregates all feedback.
- Mixed verdicts follow the stated precedence and preserve every objection. Minor repeats only the
  writer and council; major repeats purpose, research, writer and council. Every rewrite invalidates
  earlier approvals. Limits and an unworkable verdict return a complete feedback package.
- The Purpose Verifier searches project documents. Missing purpose documents trigger code and commit
  investigation, with cited provisional inferences and uncertainty, rather than an operational fault.
  The purpose council evaluates that evidence without treating missing documents alone as a veto.
- A selected HARN idea moves `Idea -> Idea Refinement` before agent work. It reaches `Draft`
  only after unanimous approval on one exact revision. Rejection or exhaustion moves it to
  `Waiting for Feedback` with a human-facing Jira comment; internal agent feedback stays in
  artifacts and logs. Neither route moves the item to To Do. Resubmission requires the author to
  reply in a Jira comment and move the item back to `Idea`. Selection captures that comment
  with the rest of the conversation on the same entry path. Execution faults do not publish a
  council verdict or request human feedback. A run reads its Jira input only at selection and
  does not re-read it before publication.
