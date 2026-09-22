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

## Workflow tests

Keep a few representative cases that prove the assembled components cooperate: execution and
repair, developer/reviewer handoff, delivery and verified completion, and interrupted-work
continuation. Use controlled agent and service responses. Do not repeat lower-layer decision
matrices through CLI wrappers or build a second copy of Nexus inside the fixtures.

## Validation and restoration

New suites live under `tests/` and run in normal validation. The old suites in `tests_old/` are
reference material, excluded from test discovery, type checking, linting and formatting. They are
not an alternate gate and should not be copied back wholesale. Recover their required behavior
coverage at the appropriate layer; discard duplication and assertions tied only to implementation.

While there are no rebuilt suites, validation explicitly has no active automated tests. Formatting,
linting, type checking and build checks continue. This temporary state is not a regression-suite
pass. Remove empty-suite acceptance when the first active suites are introduced, and keep new
coverage enabled as it is rebuilt.

Cache deterministic unit results only when all their inputs are declared. Checks of real process
or host behavior run fresh. Maintain cache inputs and task selection as suite boundaries change.
Live provider exercises require explicit authorization and stay outside the ordinary gate.
