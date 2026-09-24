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

The submitted idea is immutable within a run: source key, author, text, links, revision and
the author's most recent resubmission comment, when present, at selection. Every agent receives
it alongside the latest relevant artifacts. Project configuration provides an idea selection
query and submitted, active, approved and waiting-for-feedback status mappings on its existing
Jira task source. Agents can read the connected project's repository, documents and commit
history. Nexus configuration selects this workflow, the six role profiles, iteration limits
and storage. Idea refinement uses the same Jira adapter as finite delivery with a separate
selection query. HARN selects Jira Task issues in `Idea`; `Idea Refinement` is the active status,
`Draft` is the approved status and `Waiting for Feedback` awaits human input.

The action reads the Jira issue and its relevant comments once when selecting it, then moves it
to the active status. Its captured content is the input for the entire run. Publication uses that
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
   issue and relevant comments once, capture that input, and move it to `Idea Refinement` before
   invoking agents. On resubmission, capture the author's response comment made after the prior
   feedback request along with the current idea text and links as the new run's input.
2. Run Purpose Verifier and Researcher concurrently on the original idea. The Purpose Verifier
   finds purpose documents itself and, where needed, infers purpose from code and commit history.
   They work independently and write separate reports. The writer starts only after both reports
   exist.
3. Brief Writer creates revision 1. It sees the original idea, both reports, previous feedback when
   revising, and every council criterion below. It records a short problem/value statement, project
   fit, supporting evidence with links, alternatives, smallest useful scope, assumptions and open
   questions for design. It must distinguish evidence from proposal.
4. Three council reviewers run concurrently and independently on the same immutable brief revision.
   They see the original idea and relevant evidence, but not one another's verdicts before submitting
   their own. Each emits exactly one verdict: `approve`, `minor_corrections`, `major_rework` or
   `idea_not_working`. A nonapproval names the failed criterion, evidence and actionable correction.
5. After all council results are saved, route by strongest verdict:
   `idea_not_working > major_rework > minor_corrections > approve`. Preserve all feedback in
   artifacts even when one result determines routing. Unanimous approval alone advances to the
   approved state. Do not post internal council feedback or revision requests to Jira.
6. Minor corrections return to Brief Writer using existing purpose and research reports. Major rework
   reruns Purpose Verifier and Researcher concurrently with the original idea, current brief and all
   council feedback. Their next reports must address the objections; the writer then creates a new
   brief revision. Any rewrite invalidates every earlier approval. The council reviews the new
   revision independently.
7. The configured maximum number of council cycles bounds internal work. If another revision would
   exceed it, return to the author as unable to converge. An `idea_not_working` verdict returns
   immediately. Both routes post the human-facing reason and requested action to Jira, then set
   `Waiting for Feedback`; their decision artifacts retain distinct reasons and full feedback.
8. An approved handoff is available to the Requirements and Design workflow from the approved
   source state. That workflow decides requirements and architecture and may ultimately produce
   a To Do implementation ticket.

A reviewer may choose minor only when the current purpose and research reports remain valid.
Choose major when the premise, purpose fit, evidence or alternatives require renewed investigation.
Choose idea not working when an actionable internal revision is unlikely to make the idea worthwhile.
Disagreement is a finding, not a vote count; every reviewer has a veto until the next revision.

## Agents and constant prompts

Each role is a configured AgentRuntime profile with a complete constant prompt plus invocation
context. The prompts below are required role instructions. The action supplies original idea,
project sources, artifact references, revision/cycle, output schema and prior feedback as relevant.
Agent output is parsed and checked by the owning action; a role's claim never counts as a source
status update. Profiles may use different models or tools, but all six are separately attributable
invocations. Purpose and research must be able to run concurrently. Council roles must not read
one another's pending outputs.

### Purpose Verifier

> Find this project's purpose, charter and long-term vision in its documentation. If those
> documents are absent or incomplete, inspect the connected project's code and commit history
> and infer its direction as well as the evidence permits. Assess the submitted idea against the
> discovered purpose or provisional inference. Identify where it supports or conflicts with the
> project's direction and the smallest steering that would improve fit. Cite documents, files and
> commits for each material claim; distinguish stated intent from inference and name uncertainty
> or conflicts. Preserve the author's intent. Do not design architecture, write requirements or
> decide implementation priority. Return a concise purpose assessment, conflicts, suggested
> steering and source references.

### Researcher

> Investigate the problem and proposal using the supplied project knowledge, existing work and
> accessible internet sources. Check duplicates and established alternatives, relevant articles,
> patterns and technologies. Give links and access dates for external sources. Separate facts,
> opinions and your inference; explain evidence quality and tradeoffs. Search enough to challenge the
> premise and avoid repeating known work, then stop. Do not choose an architecture or claim novelty
> without evidence. Return a concise research report with alternatives and open questions.

### Brief Writer

> Write the smallest coherent idea brief from the immutable original idea, purpose assessment,
> research and any council feedback. Preserve intent while applying justified steering. Include the
> problem and expected value, project fit, supporting evidence and links, existing alternatives,
> smallest useful scope, assumptions, and questions for the later design workflow. Address each
> prior objection explicitly. Do not turn this brief into requirements, architecture or an
> implementation plan. The council will check fidelity, evidence and simplicity. Return a complete
> brief revision and a short change summary.

### Purpose Council Reviewer

> Independently review the exact supplied brief revision against the original idea and the
> Purpose Verifier's cited documents or provisional inference from code and commits. Check project
> fit, coherent value, evidence quality and fidelity to the author's intent.
> Choose approve, minor_corrections, major_rework or idea_not_working using the workflow's severity
> definitions. For any objection, name the criterion, cite evidence and give a concrete correction.
> Do not review other council verdicts or design the solution.

### Evidence Council Reviewer

> Independently review the exact supplied brief revision against the research and its cited sources.
> Check that the problem and value are substantiated, duplicates and alternatives are represented
> fairly, sources support the claims, and uncertainty is explicit. Choose one allowed verdict. For
> any objection, name the criterion, cite evidence and give a concrete correction. Do not review
> other council verdicts or invent missing evidence.

### Simplicity Council Reviewer

> Independently review the exact supplied brief revision for the smallest worthwhile scope.
> Challenge unnecessary features, process, configuration, abstractions and promised guarantees
> relative to the stated problem and evidence. Check that the brief is understandable and leaves
> design decisions to the next workflow. Choose one allowed verdict. For any objection, name the
> criterion, cite evidence and give a concrete correction. Do not review other council verdicts.

## Artifacts and revision binding

Use a workflow-specific workspace under
`<storage root>/workspaces/<project>/<idea>/refinement/`. Keep a read-only project snapshot or
references under `worktree/`; Nexus owns writes under `artifacts/`. A simple layout is:

```text
artifacts/
  original.json
  cycles/<n>/
    purpose.json
    research.json
    brief.json
    council/purpose.json
    council/evidence.json
    council/simplicity.json
  decision.json
```

Cycle numbers are positive integers. Minor revision may reuse the previous purpose/research reports
by reference, never by falsely relabeling them as new work. Major revision writes new reports.
Every brief is identified by its cycle and content digest; each council result names both, its
reviewer identity, verdict, criteria and feedback. A council set is valid only when all three
results name the same current cycle and digest. Original input and prior cycles are retained
for history. The decision artifact records the route, strongest verdict, full feedback and source
update evidence, including the human-facing Jira comment when applicable. These artifact paths
are specific to idea refinement; finite delivery's round layout is unchanged.

Actions write complete outputs before returning a transition outcome. A resubmitted idea
starts a new run; a changed brief invalidates all council results. Concurrent roles have distinct
artifact paths and no shared writable output. XState control state is separate from these
business artifacts.

## Workflow pseudocode

This is structural XState pseudocode, not a second executable coordinator. Actions perform the
named operations and return outcomes; XState owns parallelism, joins, guards and routing.

```ts
machine IdeaRefinement {
  context: { cycle: 1, maxCycles, originalRef, currentBriefRef, verdictRefs: [] }

  selectIdea -> captureOriginal -> markRefining -> assessAndResearch // HARN: Idea -> Idea Refinement

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
      if any(major_rework)    -> nextCycleThenAssessAndResearch,
      otherwise              -> nextCycleThenWriteBrief
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

Use one invocation contract for every agent, including finite delivery and recovery. The caller
assigns a stable role name, unique invocation ID and Unix start time in milliseconds. The logger
writes the complete timestamped activity for that invocation to its own JSONL file under the
execution log directory, with the role name and start time in its filename. Main `events.jsonl`
contains invocation start/finish events with identity and an ArtifactRef to that file, plus workflow,
action outcome and other progress events. It does not duplicate agent messages, commands or tool
results. Existing action outcome events continue to reference their saved business artifacts.
Invocation identity accompanies activity in transport so concurrent output cannot be misattributed.

OperatorInterface renders one named rolling 10-line pane for each active invocation, stacked in
start order. Each pane updates independently, retains current message highlighting and condensed
work entries, and leaves its final visible lines in scrollback. One active agent uses exactly the
same pane and log path as several; no single-agent special case. Main progress stays concise.
Terminal closure does not stop durable agent logs. Plain output uses attributable timestamped
lines when interactive panes are unavailable.

## Verification criteria

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
  reply in a Jira comment and move the item back to `Idea`. The next run reads that comment.
  Execution faults do not publish a council verdict or request human feedback. A run reads its
  Jira input only at selection and does not re-read it before publication.
- Concurrent agent activity remains attributable in separate durable files and independent 10-line
  terminal panes. Main events include invocation and business-artifact references without detailed
  agent activity.
