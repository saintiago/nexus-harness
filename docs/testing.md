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

At the workflow level, use the real XState definition to prove both parallel joins, unanimous
approval on one brief revision, mixed-verdict precedence, minor and major routes, bounded
nonconvergence, and immediate return for an unworkable idea. Verify that each `Idea` entry
uses the same selection path, reuses a retained workspace, and invokes StartIdeaRound to plan the
initial, minor and major cycles from history without applying StartDevRound's repair policy.
Verify that every invocation receives the current captured idea and available saved history,
including earlier briefs and feedback on resubmission. Verify that each of the six role invocations
receives the shared definition of *idea* and the separate idea-stage guidance exactly once each,
ahead of its role-specific context. When present, the connected project's root `AGENTS.md` is
included too. Council reviewers cannot read one another's pending verdicts, and each council
invocation receives the shared objection standard: an objection must improve the idea by
sharpening, narrowing or correcting it, by naming a genuine ambiguity in it, or by showing that it
should not proceed, and it never silently replaces the author's proposal. An unresolved design
choice is a blocker only when it changes the idea-stage decision.
Verify that a new brief states the author's idea in its one `idea` field and that a retained brief
written before that field is still read — as history for the next revision and as the one idea the
publication presents — without rewriting the retained artifact or interrupting retained state.
Verify that purpose documents are discovered without configured references and that absent
documents produce cited, provisional inference from code and commits rather than an execution
fault. At the action boundary, verify producer-owned artifacts,
council binding to the current brief artifact, one Jira issue/comment capture per run, and the
configured submitted-to-active, active-to-approved, active-to-waiting-for-feedback and
waiting-for-feedback-to-submitted transitions, including capture of the complete relevant
conversation on every entry. Verify that publication uses the captured input without a later
Jira read, only human-facing feedback is posted to Jira, and internal feedback stays in
artifacts. Verify that the source pointer names the shared issue root, the handoff lets a later workflow
read retained artifacts without copying them, and a fresh finite delivery attempt preserves the
refinement area.
Reuse existing component and system test scopes; do not duplicate XState's own parallel-state
tests.
