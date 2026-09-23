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
| SelectTask | Source ordering, eligibility and continuation decisions | Issue data and retained selection |
| SelectRepair | Repair counting, profile escalation and exhaustion | Round history and policy |
| Review | Verdict interpretation and rejection of approval with unresolved blocking findings | Agent result and repository observations |
| CompleteTask | Completion only after merge and successful configured checks for that merge | GitHub observations and source updates |
| AgentRuntime | Profile resolution and complete context assembly | Coding-provider response |
| Supervisor | Resume, blocker and attention decisions within its recovery allowance | Work, recovery and notification results |
| OperatorInterface | Argument interpretation and progress presentation | Events and output sink |
| Workflow | Declared transitions, repair loops and terminal outcomes | Named action outcomes, using the real XState definition |

Tests assert observable results and required effects. Do not mirror private methods or incidental
call order. Verify order when it is the behavior, such as completing checks before marking a task Done.

## Focused integration tests

Exercise one connection with its real implementation. Keep unrelated dependencies substituted.

| Connection | Real parts | What it establishes |
| --- | --- | --- |
| Action artifacts | Producer output handling, artifact helpers and consumer input handling on temporary storage | The consumer can use the producer's actual saved output, including current-round and history selection |
| Workflow persistence | ExecutionRunner, XState and temporary state files; supplied actions | Saved execution can be restored with the documented repetition behavior |
| Git operations | Git adapter and temporary local repositories | Checkout, pull, branch creation and push behave as expected |
| Process execution | Process adapter and a small controlled child process | Arguments, output, exit and timeout behavior |
| Worker communication | Parent bridge and a controlled worker process | Events, terminal result and process failure cross the boundary correctly |
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
