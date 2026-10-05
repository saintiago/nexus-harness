# Idea refinement workflow

This specification defines Nexus's idea refinement workflow for any connected project. It is
architecture documentation for implementing Nexus, not a per-run agent guide. Roles receive their
instructions and context through AgentRuntime and consult project documents when useful.

## Purpose

Help the author develop an idea through a short, informed conversation and decide whether it is
worth pursuing. Preserve intent, add useful knowledge, and challenge consequential weaknesses.
Approval means the idea is worth taking into Requirements and Design with a plausible way forward.
It does not require a settled solution or proof that every uncertainty has been resolved.

An idea describes a desirable change in software, why it matters, and the principle behind it—without
yet committing to implementation.

Incomplete submissions are welcome: refinement helps articulate those elements. Concrete examples,
technologies and architectural directions can give an idea substance without committing to a design.
Detailed requirements, schemas, thresholds and implementation plans belong to later work. An
exploratory idea does not need a benchmark or trial plan merely to be worth pursuing.

## Deliverable

The refined idea is a concise decision aid, normally about 150–200 words across these parts:

| Part | Content |
| --- | --- |
| Idea | The desirable change, why it matters and its guiding principle |
| Project fit | Why it belongs in this project |
| Feasibility | A plausible way forward, with significant constraints or uncertainty |
| Open questions (optional) | Questions worth carrying forward that do not prevent deciding to pursue the idea |

Use plain language and one to three short sentences per part. The length guidance includes open
questions; it is not a validation gate. Explain the benefit and guiding principle before component
names or integration mechanics. Retain architectural directions supplied by the author, but keep
supporting implementation detail in the research and project guidance artifacts. The editor should
remove repetition before returning the idea, rather than rely on publication to shorten it.
Functional publication data includes a cumulative refinement summary of one or two short sentences
and the cycle count, separately from the idea's substance. Describe the useful changes without
repeating the refined idea or narrating the agents' work.

## Shared role guidance

Every role receives the idea definition, the following stage and communication guidance, and the
connected project's root `AGENTS.md` when present. Give shared instructions one authoritative runtime
home and include them once per invocation; role prompts add only their particular duties.

- **Preserve intent.** Captured author text and human clarifications govern what is proposed. Retain
  comment authorship. Previous agent publications, interpretations and approvals are revisable history,
  not author instructions. The editor's framing is also an interpretation, not a replacement for the
  author's input. Ask the author only when a material ambiguity cannot reasonably be resolved.
- **Preserve evidence and attribution.** Distinguish author input, external sources, project facts
  and agent inference throughout contributions, synthesis and assessment. A source does not become
  the author's own work merely because it is relevant or was found in earlier material. Preserve
  consequential qualifications: vendor-reported results are not local measurements, and a search
  that found no example does not establish that none exists. Check the supporting source before
  strengthening a claim; otherwise retain the qualification or omit the unsupported claim.
- **Stay within project evidence.** Use the supplied connected worktree and its Git history,
  supplied issue-artifact references, and sources explicitly provided by the author. Do not search
  home directories, other checkouts, provider session history, host configuration or operational
  investigation logs for additional project context. An encountered path or an agent's historical
  reference does not expand this scope. Public web research remains available for relevant external
  evidence. Missing project evidence permits a stated uncertainty, not a wider filesystem search.
- **Understand the project without freezing it.** Distinguish enduring purpose and actual constraints
  from current design choices. An idea may propose changing those choices. A conflict with today's
  architecture alone is not grounds to narrow or reject an architectural idea. Apply project guidance
  at the idea stage; avoiding premature optimization does not prohibit exploring a performance idea
  before measurement.
- **Contribute to the decision.** Ask how a contribution improves the idea or shows why it should not
  proceed. Separate helpful suggestions from concerns that prevent recommending pursuit. A blocker
  must explain the consequence for value, project fit or feasibility. A preferable alternative alone
  is not a veto, and uncertainty alone does not imply infeasibility.
- **Converse plainly.** Make short, concrete observations, questions, answers or corrections. Address
  the other role's point, accept valid rebuttals and withdraw mistaken concerns. Use relevant evidence
  for consequential factual claims; do not fact-check incidental wording or demand implementation
  details to approve an idea. Avoid rhetorical language and repeated reports.

Every invocation writes its contribution, research, guidance, concerns, responses and explanation at
the Markdown path assigned by Nexus, then returns only the functional fields below. Reports may
begin with a short contribution for the next role and keep supporting detail in the same artifact;
no duplicate contribution field is returned. Do not write action-owned outcomes/state records or
supply observed work, role/profile, cycle or revision metadata.

Agents follow applicable project guidance. Linked architecture documents are evidence to consult
selectively, not additional role instructions or a reading list to open on every invocation.

## Agents and constant prompts

Four roles have distinct responsibilities. The Idea editor owns fidelity and synthesis; Researcher
adds knowledge; Project guide connects the idea to the project's direction; Challenger tests whether
it is worth pursuing. Each has a useful contribution without overlapping vetoes.

### Idea editor

> Be clear, perceptive and lightly witty when it helps understanding. First frame the author's
> proposed change and the few questions that could usefully develop it. Preserve their intent;
> keep your interpretation open to correction. Integrate research and project guidance into the
> refined idea's four parts. Keep the result concise and distinguish proposals from established
> facts. When challenged, revise what is weak, answer what can be answered, request focused help
> when knowledge is missing, or rebut an objection that is mistaken or distorts the idea. You do
> not have to accept every suggestion. If the idea appears unsuitable, explain why; if a decision
> only the author can make is essential, ask it plainly. Maintain a short cumulative account of
> what refinement changed. Do not turn the idea into requirements or an implementation plan.

### Researcher

> Be idealistic, trusting and receptive to new ideas. Your role is to build this idea up, not to
> scrutinize or reject it. Search the internet and relevant project sources for useful knowledge,
> existing solutions, articles, patterns, technologies and examples. Explain what they make possible
> for this idea. Offer meaningful alternatives as possibilities, not replacements imposed on the
> author. Do not invent evidence or present inference as established fact. Retain sources and research
> detail in your report; give the editor a short contribution with the most useful discoveries.
> If a search service reports exhausted quota or missing authorization, do not repeat requests that
> require the same unavailable access. Use another available search or direct source retrieval and
> record any material limitation in the research report. Do not turn unavailable search into a claim
> that no relevant solution exists or into a judgment against the idea.
> For a follow-up request, answer the specific question rather than repeating the investigation.
> Do not require the author to prove the idea's value before enriching it.

### Project guide

> Be wise and thoughtful about the project's purpose and long-term direction, and concrete in your
> advice. Find purpose, charter and vision documents in the supplied project worktree first. If they
> are absent or incomplete, infer direction from that project's code and Git history, citing your
> evidence and marking the inference as provisional. Identify an old or unmerged document as
> historical evidence rather than the current project position; current author clarification governs
> intent. Explain how the idea could fit, what existing capabilities help,
> and which real constraints matter. Distinguish enduring purpose from choices the idea proposes
> to change. Suggest useful steering while preserving the author's concept. Missing documents
> alone are not a reason to block it. Give the editor a short contribution; keep supporting detail
> available separately. On follow-up, address the requested question.

### Challenger

> Be pragmatic, precise and candid about consequential weaknesses. Read the current idea and the
> editor's response. Decide whether pursuing it makes sense for this project: consider value,
> feasibility and avoidable complexity. Recommend approval when there is a plausible way forward,
> even with acknowledged uncertainty. Otherwise raise only the few concerns that change that
> decision, explaining the consequence and what would resolve each concern. Keep optional
> suggestions separate; they do not block approval. Do not demand detailed design, substitute a
> different idea, or treat current architecture as immutable. Consider the editor's answers and
> rebuttals, and explicitly withdraw concerns they resolve. If you believe the idea is unsuitable
> or needs the author's decision, explain that to the editor rather than treating your first
> objection as a final verdict. Return either approve or discuss, bound to the supplied revision
> and response. Write the explanation and remaining concerns in the assigned Markdown report;
> return only the verdict and applicable functional publication obstacle.

## Inputs and project context

Each entry from `Idea` captures the issue text, links, author, revision and relevant conversation
once through parent selection. The parent moves it to the active state. The child receives the
capture and never reads or writes Jira. Submission and resubmission follow this same
path; no special resubmission input or publication reread is required.

Every invocation receives the captured author input, current framing or refined idea, and relevant
conversation directly. All saved artifacts, including previous submissions and detailed research,
remain accessible by reference. Read history selectively; do not inject every old report or treat
an accumulated agent summary as more authoritative than human input.

Shared invocation context identifies the connected worktree and the issue artifacts available by
reference. Supply the shared source-scope and attribution guidance once to every role, including
focused follow-ups. These are agent instructions, not a filesystem sandbox guarantee. Repository
and internal-source reads follow that scope; ordinary provider/tool setup instructions do not become
evidence about the project or author.

The Project guide discovers purpose references itself. Missing documents lead to provisional
inference from code and commits, not an execution fault. The Researcher retains source links,
access dates and the distinction between sourced facts and inference. Idea roles use the normal
AgentRuntime worktree contract and do not modify project code or source status.

Project configuration supplies the existing Jira source's idea query and submitted, active, approved
and waiting-for-feedback mappings. Nexus supplies four role profiles and the cycle limit. No separate
source configuration mechanism is needed. HARN uses `Idea`, `Idea Refinement`, `Draft` and
`Waiting for Feedback`, respectively.

The [memory integration](../memory/integration.md#agent-use) exposes optional explicit search/save
tools to idea roles. Historical results preserve uncertainty and source ownership; they cannot
override human intent or establish project facts without evidence. Direct conversation artifacts
remain the handoff; saved role outputs are not automatically ingested.

## Conversation and cycles

1. Receive parent-selected input in the shared issue workspace. The parent moves it to
   Idea Refinement. Prepare refinement/worktree before invoking agents.
2. StartIdeaRound opens cycle 1. The editor frames the idea and useful questions. If an essential
   author decision is already missing, the editor may return it with a specific question.
3. Researcher and Project guide contribute concurrently. XState joins their results before the
   editor writes the refined idea.
4. Challenger reviews the current revision and recommends approval or discussion. Suggestions
   can accompany approval; only consequential unresolved concerns require discussion.
5. After a discuss result, StartIdeaRound opens the next cycle, subject to the limit. The editor
   responds: revise, answer, rebut, request focused Researcher or Project guide help, or return to
   the author. It may request both contributors concurrently when both are needed. After receiving
   that help it produces its response and any revision; it does not open an unbounded help loop.
6. Challenger considers that response and the current revision. Repeat until approval, return to
   author, or exhaustion. A rebuttal may resolve a concern without changing the idea text. Only the
   current Challenger result can approve the current revision and response.

A **cycle** opens an editor preparation/response and, unless the editor returns the idea to its
author, ends with one Challenger assessment. Initial framing and contributions belong to cycle 1;
focused help belongs to the cycle requesting it.
Tool calls and concurrent contributions do not add cycles. StartIdeaRound records each opened cycle;
publication reports cycles used, including an opened cycle ending in an editor return. The configured
maximum applies per selection. At the limit, approval still succeeds; an unresolved discuss result
returns as attempts exhausted rather than opening another cycle.

The editor may accept a concern and explain why the idea is unsuitable, or identify an essential
author decision. A Challenger objection has an opportunity for an editor response while budget
remains. There is no unanimous vote, severity precedence or automatic restart of all research.
XState owns parallelism, joins, bounded conversation routing and termination. Actions save outputs
and return typed outcomes; Application and AgentRuntime do not implement a second coordinator.

## Outcomes and parent publication

| Child outcome | Parent publication and transition |
| --- | --- |
| Approved | Publish the refined idea, short refinement summary and cycle count; move to `Draft` |
| Unsuitable | Explain why pursuing this idea appears unwise, include the latest idea and summary, and move to `Waiting for Feedback` |
| Author decision needed | Ask the specific question that prevents proceeding, include the latest idea and summary, and move to `Waiting for Feedback` |
| Attempts exhausted | Say explicitly that the cycle limit was reached, include the latest idea, summary, count and remaining obstacle, and move to `Waiting for Feedback` |

Each returned comment is short and understandable without reading internal reports. Include the
cycle count on every outcome. If no refined idea exists yet, use the captured idea and editor's
framing. State the reason plainly and end with the next step: reply in a Jira comment and move the
issue back to `Idea`. Exhaustion does not mean rejection. Only approved output and human-facing
feedback are published; internal conversation, raw concerns and tool transcripts stay in artifacts
and logs. The parent publishes terminal decisions; do not publish interim messages or bypass preparation by
moving an idea directly to Implementation.

Approval saves `artifacts/handoff.json` referencing the shared issue workspace and its input,
approved revision, contributions and decision. The Requirements child receives these retained artifacts through the parent.
Returned ideas are not selected again until the author moves them to `Idea`; each run terminates
rather than waiting internally. Agent/tool failures, malformed output or source update failures
remain operational faults handled by common execution recovery, never fabricated idea decisions.

## Role outcomes and consumers

Use strict response schemas owned by each producing action. Every listed role/variant also writes
Markdown, including roles with an empty machine outcome. Null represents inapplicable functional
fields in provider responses. The following are the complete new response fields:

| Role / invocation | Machine fields | Functional consumer |
| --- | --- | --- |
| Editor framing | `framing`, `questions`, `authorDecision: { question } \| null` | Framing/questions guide contributions and synthesis; the question supports an author-decision return and publication before a revision exists |
| Editor synthesis | The editor-turn fields below; `refinedIdea` holds `idea`, `projectFit`, `feasibility`, `openQuestions`, `changeSummary` when revised | The immutable idea revision, Challenger and terminal publication; synthesis may instead return unsuitable or author-decision-needed, preserving existing routes |
| Editor discussion / post-help / retained-revision completion | `disposition`, `refinedIdea \| null`, `help: { researcher: string \| null, projectGuide: string \| null } \| null`, `reason: string \| null` | Existing routing, optional immutable revision, focused contributor questions and terminal human feedback |
| Researcher initial / focused | `{}` | Completion plus the readable report permits the existing join; sourced discoveries, options, links/access dates and limitations are all Markdown |
| Project guide initial / focused | `{}` | Completion plus the readable report permits the existing join; fit, steering, constraints, evidence, provisional inference and uncertainty are all Markdown |
| Challenger | `verdict: approve \| discuss`, `obstacle: string \| null` | Existing discussion/approval route; a plain author-facing obstacle is needed for an exhausted terminal publication |

`framing` is the concise functional interpretation presented before a revision exists, not the
editor's detailed explanation. `changeSummary`, editor return `reason` and Challenger `obstacle` are
retained only as concise human-publication data; never copy full narrative into them. Discussion
answers and rebuttals are exclusively the editor's Markdown, replacing `response`. `reason` is
required only for unsuitable or author-decision-needed: the concise author-facing explanation or
essential question, respectively. All other dispositions require null. Help is present only for
help-requested with at least one named question; refinedIdea only for revised. Initial synthesis
permits revised, unsuitable or author-decision-needed. Discussion permits the existing six
dispositions. Post-help permits no second help request. `changeSummary` is the concise cumulative
publication account, not the editor's report. Challenger discuss requires an obstacle and approve
requires null. Remove structured concerns/suggestions and all their count/consistency validators;
assessment obligations remain in its prompt and Markdown. Questions and required publication text
still receive functional validation.

Callers add observed task identity, role/profile, submission/cycle/revision as applicable and
[ReportBinding](../task-engine/actions/architecture.md#markdown-reports-and-machine-outcomes) to
saved outcomes. Keep existing functional artifact paths; each invocation's Markdown has its own
path. Editor and Challenger context includes the relevant contributor/editor/Challenger Markdown
plus functional idea, question and routing data. The approved handoff references outcomes whose
report bindings expose this narrative to Requirements. No consumer reads removed narrative JSON
fields.

Terminal decision recording assembles its concise comment from functional idea/publication data and
observed cycle count, and retains the exact comment for parent publication/replay. Its decision is
not inferred from Markdown. A return without a refined revision still uses captured input and
functional framing; exhausted feedback still includes the current Challenger obstacle. Operational
failures remain faults, not business decisions.

## Artifacts and revision binding

Use `refinement/` under the stable `<storage root>/workspaces/<project>/<issue>/` root. Preserve
earlier submissions and their artifacts. Every role runs in its prepared `worktree/`; Nexus actions
own structured writes under `artifacts/` and `state/`; agents write only their assigned Markdown
reports. Each numbered submission retains:

- Captured input and the editor's framing.
- Numbered cycles with editor contributions, refined idea revisions, contributor reports and
  Challenger results. Concurrent roles write distinct artifacts.
- Final decision, publication evidence and, on approval, the handoff.

Keep substantial research separate from short conversation contributions. Each contribution records
its role and the context or question it addresses. A Challenger result references and records
identities of the exact refined idea revision and editor outcome plus associated Markdown response
assessed. Revising either requires a fresh assessment; a previous approval cannot authorize
publication of changed content. Carry forward useful reports by reference, without relabeling them
as new work. Older combined artifacts remain readable history under producer-owned compatibility
readers, without rewriting them or requiring retroactive Markdown. New outcomes require their report
binding; compatibility never relaxes current idea/editor association or Challenger approval
freshness. When Challenger reassesses a combined result, retain its original bytes separately
before saving the new bound outcome, and include that original in readable history and the approved
handoff. Reassessment stays in the existing cycle. Workflow restart follows the common
execution-state contract.

If an editor turn saved its immutable revision but not its response, recovery asks the editor to
complete the response specifically for that retained revision. The response must describe what the
saved revision actually says, including concerns it leaves unresolved in Markdown. Give this
completion its own report path and minimal editor-turn contract; retain the exact functional
revision and disposition from the interrupted turn, rather than letting completion overwrite them. A
retry that changes the revision or chooses another disposition fails without saving a response; it
cannot silently pair new commentary with discarded changes. Further revisions belong to later
conversation cycles.

StartIdeaRound owns `state/current-round.json`: submission identity, cycle number and selected role
profiles. On selection it opens the next submission at cycle 1; on discussion it opens the next cycle
within the configured limit. It reuses the shared round storage functions for history and persistence.
It does not apply finite delivery's repair counters or developer ladder, interpret concerns or choose
conversation routes. XState supplies the route; the actions use the saved plan. An exhausted route
opens no cycle and retains its reason at `state/submission-exhaustion.json`, so the terminal handoff
states it after a restart. A later submission created but not yet planned is the interrupted
submission: a terminal handoff for it names that submission and its retained input, never the previous
plan's submission.

Actions persist complete outputs before returning small outcomes and artifact references. Machine
context holds control state and references, not full reports. Later workflows can read retained
artifacts without copying them or changing refinement state.

## Workflow pseudocode

This illustrates XState structure; it is not a separate executable coordinator.

```text
receiveParentInput -> prepareWorkspace -> StartIdeaRound(new) -> frameIdea
frameIdea:
  framed -> gatherInitialContributions
  needsAuthorDecision -> returnAuthorDecision -> final

gatherInitialContributions (parallel):
  Researcher
  ProjectGuide
join -> editIdea

editIdea:
  written -> challenge
  unsuitable -> returnUnsuitable -> final
  needsAuthorDecision -> returnAuthorDecision -> final

challenge:
  approve -> returnApproved -> final
  discuss, cycle limit reached -> returnAttemptsExhausted -> final
  discuss -> StartIdeaRound(next) -> editorResponse

editorResponse:
  revise | answer | rebut -> challenge
  requestHelp -> gatherFocusedContributions
  unsuitable -> returnUnsuitable -> final
  needsAuthorDecision -> returnAuthorDecision -> final

gatherFocusedContributions (parallel):
  Researcher if requested, otherwise final
  ProjectGuide if requested, otherwise final
join -> editorResponseAfterHelp

editorResponseAfterHelp:
  revise | answer | rebut -> challenge
  unsuitable -> returnUnsuitable -> final
  needsAuthorDecision -> returnAuthorDecision -> final
```

The parallel regions invoke distinct actions and join through XState completion. No promise fan-out
or routing loop outside the machine replaces these states. The child returns saved decision artifacts. Parent-owned publication uses the capture and
artifacts; the child has no source client.

## Agent activity and verification

All four roles use the shared [agent activity events](../task-engine/architecture.md#agent-activity-events),
[execution log](../application.md#execution-log) and
[agent activity panes](../operator-interface.md#agent-activity-panes). Each invocation has its own
identity and activity-log reference, including concurrent and repeated contributions. Outcome events
identify the idea, cycle and saved artifact; terminal milestones omit internal paths.

[Testing coverage](../testing.md#idea-refinement-coverage) verifies conversation routing, intent
preservation, decision and publication boundaries, and retained workspace behavior.

## Terminal experience analysis

The parent invokes [AnalyzeExperience](../task-engine/actions/analyze-experience.md) after its
approval or waiting-for-feedback handoff, including unsuitable, author-decision-needed and
attempts-exhausted returns, and on selected-submission failure exits before blocked/recovery.
Pass the terminal decision and retained conversation/evidence, not a Jira status trigger. Preserve
approved, waiting-for-feedback and failure destinations; analysis failure does not change them.
Do not analyze intermediate editor/Challenger cycles, focused help or an empty/failed selection.
The same action serves finite delivery and any subsequent workflow's terminal handoffs.

The [project workflow](../project-workflow.md) owns parent handoffs and profile assignments.
Parent-owned publication replaces child PublishDecision source writes; retained decision artifacts
remain publication and experience-analysis inputs.
