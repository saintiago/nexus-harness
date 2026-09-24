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

- **Ready for design:** every council reviewer approves the exact current brief revision. Publish
  the original idea, approved brief, purpose assessment, research and sources, alternatives, council
  decisions and unresolved design questions as one handoff. Move the source item to its configured approved state. For HARN Jira, this is `Draft`.
  No automatic move to To Do.
- **Returned to author:** at least one reviewer finds the idea unworkable, or bounded internal
  revision cannot converge. Publish the original idea, latest brief, research and all actionable
  feedback on the source item for the author, and move it to its configured needs-refinement
  state. For HARN Jira, this is `Idea Refinement`. A human can revise and resubmit it by
  returning it to `Idea`; this run ends.
- **Execution fault:** missing required project context, agent/tool failure, malformed output or
  source update failure is an operational fault, not a council verdict. Preserve artifacts and
  report it through Application's ordinary recovery/attention path. Never manufacture approval.

Publish each terminal decision once; retries inspect the source before repeating a write. A
needs-refinement item is excluded from automatic selection until explicit resubmission. The
workflow never silently waits for author input.

## Inputs and project context

The submitted idea is immutable within a run: source key, author, text, links and revision at
selection. Every agent receives it alongside the latest relevant artifacts. Project configuration
provides the authoritative purpose/charter/long-term vision references, the idea-source adapter
and selection query, mappings for submitted, approved and needs-refinement states, and
repository/document sources available to agents. Nexus configuration selects this workflow,
the six role profiles, iteration limits and storage. The workflow uses the source contract rather
than Jira-specific operations. HARN uses Jira Task issues with `Idea` as submitted, `Draft`
as approved and `Idea Refinement` as needs refinement. Another connected project may bind
a different idea source through its adapter.

The idea-source contract has four operations: select an eligible idea, read its text and source
revision, publish the brief or feedback, and change its state. Before publishing, the action re-reads the
source revision and reconciles changes. The configured adapter owns provider identity and
transition details. A connected
project may use the same provider for ideas and delivery tickets with different selectors;
neither workflow assumes they share a queue.

Purpose sources must be available and identifiable. If they are absent, return an operational
needs-attention result asking for project context; agents must not invent a charter. The researcher
may use configured web tools and must retain links, dates and the distinction between source facts
and inference. Repository and internal-source reads are scoped to the connected project. Agent roles
write no project code and do not change source statuses. Nexus actions own artifacts and source
updates.

## Behavior

1. Select one eligible submitted idea and capture its exact source revision. In HARN, select Jira
   Task issues in `Idea`. Leave the source item in its submitted state during internal work.
   Run at most one refinement execution per connected project so the same revision is not
   selected twice. A source change before publication requires reconciliation, not overwriting
   the author's new text.
2. Run Purpose Verifier and Researcher concurrently on the original idea. They work independently
   and write separate reports. The writer starts only after both reports exist.
3. Brief Writer creates revision 1. It sees the original idea, both reports, previous feedback when
   revising, and every council criterion below. It records a short problem/value statement, project
   fit, supporting evidence with links, alternatives, smallest useful scope, assumptions and open
   questions for design. It must distinguish evidence from proposal.
4. Three council reviewers run concurrently and independently on the same immutable brief revision.
   They see the original idea and relevant evidence, but not one another's verdicts before submitting
   their own. Each emits exactly one verdict: `approve`, `minor_corrections`, `major_rework` or
   `idea_not_working`. A nonapproval names the failed criterion, evidence and actionable correction.
5. After all council results are saved, route by strongest verdict:
   `idea_not_working > major_rework > minor_corrections > approve`. Preserve all feedback even when
   one result determines routing. Unanimous approval alone advances to the approved state.
6. Minor corrections return to Brief Writer using existing purpose and research reports. Major rework
   restarts Purpose Verifier and Researcher concurrently with the original idea, current brief and all
   council feedback. Their next reports must address the objections; the writer then creates a new
   brief revision. Any rewrite invalidates every earlier approval. The council reviews the new
   revision independently.
7. The configured maximum number of council cycles bounds internal work. If another revision would
   exceed it, return to the author as unable to converge, with the full feedback. An
   `idea_not_working` verdict returns immediately. Both routes publish feedback and set the
   needs-refinement state; their decision artifacts retain distinct reasons.
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

> Assess the submitted idea against this project's supplied charter, purpose and long-term vision.
> Identify the outcome the project is meant to serve, where the idea supports or conflicts with it,
> and the smallest steering that would improve fit. Cite the exact project source for each material
> claim. Preserve the author's intent and state uncertainty. Do not design architecture, write
> requirements, decide implementation priority or invent missing project purpose. Return a concise
> purpose assessment, conflicts, suggested steering and source references.

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
> project's purpose sources. Check project fit, coherent value and fidelity to the author's intent.
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
update evidence. These artifact paths are specific to idea refinement; finite delivery's round
layout is unchanged.

Actions write complete outputs before returning a transition outcome. On restart, an action may
reuse a validated artifact for the same source revision, cycle and inputs. A changed original idea
requires a new run; a changed brief invalidates all council results. Concurrent roles have distinct
artifact paths and no shared writable output. The runner persists XState control state separately
from these business artifacts.

## Workflow pseudocode

This is structural XState pseudocode, not a second executable coordinator. Actions perform the
named operations and return outcomes; XState owns parallelism, joins, guards and routing.

```ts
machine IdeaRefinement {
  context: { cycle: 1, maxCycles, originalRef, currentBriefRef, verdictRefs: [] }

  selectIdea -> captureOriginal -> assessAndResearch

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

  publishApproved        -> final("approved")       // HARN: Idea -> Draft
  returnToAuthor         -> final("needs-refinement") // HARN: Idea -> Idea Refinement
  returnUnableToConverge -> final("needs-refinement")
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
- A source item reaches the approved state only after unanimous approval on one exact revision.
  In HARN this means `Idea -> Draft`; rejection or exhaustion means
  `Idea -> Idea Refinement`. Neither route moves the item to To Do. Resubmission requires
  a human to revise the idea and move it back to `Idea`.
- Concurrent agent activity remains attributable in separate durable files and independent 10-line
  terminal panes. Main events include invocation and business-artifact references without detailed
  agent activity.
