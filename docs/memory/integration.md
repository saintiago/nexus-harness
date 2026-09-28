# Memory integration

## Composition and ownership

Application wires the [Memory component](architecture.md) into finite delivery, idea refinement and
recovery. The caller of an agent owns the task-specific retrieval query and placement of the returned
block in additionalContext. AgentRuntime preserves that supplied context through its existing
interface. TaskEngine continues to execute the existing workflows; memory adds no workflow states,
new transition outcomes or substitute coordinator.

Actions own extraction from their producer-owned artifacts. A small deterministic mapper per source
uses its public artifact contract; Memory does not discover files or import action implementations.
Application maps the recovery report it owns. Share formatting only where the data responsibility is
actually shared. No project name, ticket prefix or Nexus concept is added to the standalone package.

## Before an invocation

Recall before every actual Developer, Reviewer, Idea editor, Researcher, Project guide, Challenger
and Recovery invocation, including focused help and later rounds. Reusing a saved agent output does
not require another recall. The caller supplies a deterministic query from current information:

| Invocation | Query material |
| --- | --- |
| Developer | Task summary and description; current repair findings or verification failure when present |
| Reviewer | Task summary and description; current development summary and unresolved findings |
| Idea editor | Captured human idea; current framing, revision or Challenger questions relevant to this turn |
| Researcher / Project guide | Captured idea, framing and the assigned initial or focused questions |
| Challenger | Captured idea, current refined idea and editor response |
| Recovery | Current task when known, reported failure and stopped workflow/action |

Include role and project identity as scope, not as the sole search query. Do not concatenate entire
logs or accumulated history into a query. Query construction adds no model call. Continue without
supplemental context when recall is disabled, empty or unavailable. Preserve all normal direct
handoff inputs, including complete findings and human conversation.

Idea-role source guidance must explicitly admit the supplied memory block as attributed historical
evidence. It does not authorize searching other projects, host configuration or provider sessions.
A retrieved claim about the author or current project remains a claim to verify, not established
intent. Keep uncertainty and source ownership when using it.

## After a hand-off

Observe validated, durably saved business output, including negative results with usable artifacts.
Call Remember before the producing action returns its outcome; handle its result without changing
that outcome. Where publication follows artifact persistence, ingestion does not depend on a Jira
comment or PR publication succeeding. Reuse of a saved output observes the same source key and is
safe. Recovery records its report before ingesting it, notifying or restarting the worker.

The observation content starts with a compact source envelope: task/idea subject, project and role,
outcome and the revision/round/cycle needed to interpret the statement. Follow it with the source
fields below. Preserve original wording, uncertainty and supplied evidence. Link a finding response
to the complete finding it addresses so it is understandable on its own. IDs belong in source and
provenance; the package's concise-context prompt governs generated semantic attributes.

| Producer | Notes extracted | Source contract |
| --- | --- | --- |
| Develop | One development summary; one separate note per finding response, with its original finding | [development.json](../task-engine/actions/develop.md#output) and [finding responses](../task-engine/actions/findings.md) |
| Verify | One note per failed check with command identity, exit result and bounded diagnostic excerpt; record omitted output and log reference | [verification.json](../task-engine/actions/verify.md#output) and its check logs |
| Review | One overall verdict/summary; one note per new finding; one per prior-finding disposition with the finding and matching developer response | [review.json](../task-engine/actions/review.md#output) and [findings](../task-engine/actions/findings.md) |
| Idea editor framing | One framing note with intent and questions | [Idea artifacts](../idea-refinement/spec.md#artifacts-and-revision-binding) |
| Researcher | One note per saved contribution, with its evidence, source links and uncertainty; retain references to separate detailed research | Same |
| Project guide | One note per saved contribution with project direction, constraints, evidence and provisional inferences | Same |
| Idea editor edit/response | One note per saved response, including any revision it introduces and the addressed questions; focused help requests retain the question | Same |
| Challenger | One assessment note with verdict, reasoning and concerns tied to the assessed revision/response | Same |
| Recovery | One report note with failure context, diagnosis, actions and resume/attention decision | [RecoveryReport](../application.md#provided-interface) |

A note is an attributed report, not proof: a developer's claim of a fix and a reviewer's confirmation
remain distinct observations. Do not invent a successful resolution or convert an unanswered question
into a rule. Empty finding/response arrays create no element notes. Initial task descriptions and
human clarifications provide scope in the envelope; they are not duplicated as standalone memories
on every hand-off. Whole reports are not duplicated alongside all their elements except for the
explicit summary/verdict note above.

Selection, workspace preparation, round planning, successful checks, PR publication and task
completion supply provenance and operational evidence, not standalone experience notes. Final idea
publication refers to the already-recorded conversation; do not ingest the Jira rendering again.
Malformed agent output and tool transcripts are not hand-off memories. Recovery can capture a
subsequent diagnosis of such a failure.

## Source identity and deterministic extraction

Derive each source key from the canonical artifact path, a digest of the validated artifact content,
and the observation selector (summary, finding ID, response ID, check index or contribution). Use a
stable canonical JSON representation. Identical content at the same source and selector is the same
observation; changed content is a new observation. This handles repeated action-outcome events and
rewritten artifacts without confusing the key with a library note ID. Include the originating
artifact's timestamp when known; otherwise fix the observation timestamp at first capture and retain
it across retries. Provenance includes all source artifact references used in a composite note.

For diagnostic logs only, retain the first and last 2,000 characters of combined stdout/stderr,
without overlapping them; mark omissions and keep the source paths. Never turn clipped diagnostic
text into a claim that a cause has been established. All other mapped fields retain their content.
Do not collect environment dumps, credentials or unrelated host files. Memory uses the same source
material already authorized for the agent workflow; it does not mine historical logs automatically.

## Failure and evaluation

Memory remains optional. Failed retrieval supplies no block; failed ingestion preserves a source
snapshot when local persistence is available and reports its receipt and disposition. Business
verification, review, publication, completion and recovery gates remain unchanged. The
[component failure contract](architecture.md#ingestion-and-identity) owns retry and uncertainty;
action callers must not retry uncertain insertions or infer success from a process exit.

Evaluate retrieval from the saved query, included notes and actual invocation context. Check source
scope, relevance, duplicate noise and whether retrieved evidence helped the subsequent work; a
correct final answer alone is not proof of useful retrieval. Use the existing hand-off artifacts to
trace each note back to its source. Validation coverage belongs in [testing](../testing.md#memory-coverage).
