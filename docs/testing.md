# Testing

Use a pyramid: many fast unit tests, focused integration tests and a small number of complete
workflows. Each behavior should be proved at the lowest layer that can detect its failure.

## Unit tests

Exercise real decision code with explicit inputs and supplied observations. Cover input and
configuration validation, state transitions, repair and escalation, review and completion decisions,
and conversation-history rules. Control time and external responses. Do not start real Git,
processes, network services or entire command workflows to test a decision.

Keep policy separate from effects where doing so makes the production design clearer. Introduce
small seams at actual boundaries; do not build a generic dependency framework or mock internal
implementation details. Preserve required behavior while reorganizing code.

## Integration tests

Use real temporary repositories, files and processes only to verify their actual contracts:
workspace ownership and preservation, Git operations, process execution and cancellation, cleanup,
credential isolation and tool output handling. Test service adapters against controlled responses
and requests, without live accounts. Keep each fixture limited to the boundary under test.

Own every resource started by a fixture. Cancellation must finish owned work before cleanup;
cleanup must not race background work. Avoid nested test runners, repeated builds, dependency
installs and full repository clones in individual cases unless that behavior is the subject.
A boundary case works in a temporary directory that is removed after it, and the processes it
started are waited for or stopped and confirmed gone first; nothing it touched outlives it.

## Workflow tests

Keep a few representative cases that prove the assembled components cooperate: execution and
repair, developer/reviewer handoff, delivery and verified completion, and interrupted-work
continuation. Use controlled agent and service responses. Do not repeat lower-layer decision
matrices through CLI wrappers or build a second copy of Nexus inside the fixtures.

The rebuilt workflow layer lives in `tests/workflow/` and holds one suite per connection: a task
runs and is repaired in the same retained working copy (`execution-repair.test.ts`), a delivered
attempt is handed to the reviewer through a pinned view of its own workspace
(`review-handoff.test.ts`), the pass is delivered and the ticket is finished only on the merge
GitHub made at that revision (`delivery-completion.test.ts`), and an interrupted attempt's
workspace is the one the next attempt continues (`continuation.test.ts`). Each case assembles the
harness's own modules — the runner, the workspace, the configured commands, the review scan, the
delivery step, the completion pass, the report and the ledger — and supplies only the two
responses a workflow gets from outside: the agent turn, and the service answers of the configured
integrations. Nothing in the layer repeats a decision matrix the unit layer owns or re-verifies a
protocol the boundary layer owns.

## Validation and restoration

New suites live under `tests/` and run in normal validation. The old suites in `tests_old/` are
reference material, excluded from test discovery, type checking, linting and formatting. They are
not an alternate gate and should not be copied back wholesale. Recover their required behavior
coverage at the appropriate layer; discard duplication and assertions tied only to implementation.

The active suites live in the directory of the layer that owns their behavior, and
`vitest.config.ts` runs each directory as its own project: `tests/unit/` decides behavior from
explicit inputs and realizes no effect — configuration and input validation, queue and run state
transitions, repair and escalation decisions, review and completion decisions, and
conversation-history rules; `tests/boundary/` verifies this host's real contracts — processes,
Git and filesystem behavior, and the Jira and GitHub adapters against controlled services and
stand-in programs; and `tests/workflow/` proves the four assembled connections above. A suite
outside every layer, and a layer with no suite, fail `tests/unit/layers.test.ts`: validation has
no empty-suite acceptance, and a layer that stops being discovered stops being a failure rather
than passing.

The archived suites whose coverage those layers now carry were removed as their coverage was
rebuilt. What stays in `tests_old/` is reference material: the whole-command surfaces those
decisions are assembled into, and the live provider exercises, which require explicit
authorization and stay outside the ordinary gate. `tests_old/REFERENCE.txt` maps each archived file
to the active suite that carries its required behavior — the coding-runtime adapter and its event
stream, the configured setup/check round and the run timeline, the Jira connector's queue, claim,
pointer, publication and recovery behavior, source readiness, the review scan's GitHub reads, the
completion path's GitHub commands, the final report, the command line's own surface, the run's
repair, records and history, and the serial queue's own decisions — and names the surfaces no
active suite reaches yet: the terminal presentation, the source coordinator's receipts, claims and
publication, the pre-delivery baseline diagnosis pass, and the review watch's timing.

Cache deterministic unit results only when all their inputs are declared. Checks of real process
or host behavior run fresh — the boundary and workflow layers run on every validation. Maintain
cache inputs and task selection as suite boundaries change. Live provider exercises require
explicit authorization and stay outside the ordinary gate.
