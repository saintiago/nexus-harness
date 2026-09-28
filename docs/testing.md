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
| SelectTask | Source ordering, eligibility and continuation decisions | Issue data and retained selection |
| StartDevRound | Initial profile, repair triggers, executed-turn counting, changes-requested promotion, no downgrade, planned-round reuse and exhaustion | Round history, developer ladder and current-round record |
| Shared round storage | Current-plan validation, numbered history, directory creation and plan persistence without role or route decisions | Finite and idea plan fixtures in temporary workspaces |
| Review | Verdict interpretation and rejection of approval with unresolved blocking findings | Agent result and repository observations |
| CompleteTask | Completion only after merge and successful configured checks for that merge | GitHub observations and source updates |
| AgentRuntime | Profile resolution and complete context assembly | Coding-provider response |
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
and verify that its assembled review context contains the development summary, revision and finding
responses. This requires no live agent, GitHub access or full workflow.

Do not replace both sides with independently handcrafted fixtures. Test malformed JSON and missing
required fields at the artifact-reading boundary without repeating that matrix for every consumer.
Vitest runs these tests; Zod supplies runtime shape validation.

For finding handoffs, carry the review's actual Finding values into development input, then its actual
FindingResponse values into the next review. Verify preserved IDs and complete evidence. Cover missing
or unknown response IDs, open findings without a current entry, and verdicts inconsistent with blocking
findings at their owning action boundary. Verify that each invocation includes its selected role's
complete constant prompt once alongside the supplied context; test prompt assembly, not the wording
of documentation.

Contract and workflow describe what a test proves, not additional pyramid layers. Classify them by
the scope and dependencies they exercise. Test Nexus's XState definition and integration, not XState's
internal implementation.

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

Use the [Memory contract](memory/architecture.md) and [integration mapping](memory/integration.md)
as the authority. At component scope, verify whole-note context budgeting, provenance and ordering,
empty/unavailable behavior, deterministic field mapping, and source identity across repeated and
changed artifacts, including identical verification.json with changed diagnostic excerpts. Exercise findings and responses with their actual producer output; preserve
original claim strength, referenced finding evidence and diagnostic omission markers.

Use the real standalone package public API in a focused contract test with controlled model,
embedding and storage providers. Verify that accepted observations reach add, returned note IDs
reach receipts, and search results reach the saved invocation block. Do not substitute both the
consumer and the package contract or retest the package's evolution algorithm in Nexus.

With temporary storage and controlled child processes, verify exclusion across two writers sharing
a collection, lock release on exit, deferred contention and receipts surviving worker/workspace
replacement. Cover stored replay, known-unchanged retry, uncertain persistence and a crash between
add and success-receipt storage. Uncertainty must defer further writes without blocking reads or
business workflow progress; presence of the new note cannot stand in for successful neighbor writes.

Extend representative delivery, idea-refinement and recovery system journeys to establish that
recall runs for actual invocations, saved outputs are ingested, disabled memory has no provider
effects, and memory faults do not alter business outcomes. Verify the actual supplied memory block
matches saved retrieval evidence, including concurrent idea contributors and focused help. Exercise
these through existing test scopes rather than a second workflow simulator. Verify fresh-checkout
installation/build of the pinned external package without sibling repositories. Routine checks
require no paid model calls, live credentials or running Qdrant; targeted live evidence is separate.
