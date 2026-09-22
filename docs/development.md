# Development guide

## Implement and verify

Implement the documented requirements. When requirements change, revise them before changing code.
Tests verify implementation behavior; do not create tests that require documentation to match code.

Preserve user changes. Work on a task branch; `main` stays green and changes integrate through a
PR with the required gates. Follow [GIT-WORKFLOW.md](GIT-WORKFLOW.md).

Use `npm ci` unless intentionally changing dependencies. Run focused checks while editing, then
`npm run validate` before finishing. Repeat or broaden checks when a change, failure or unresolved
question warrants it. Preserve meaningful assertions and required coverage; do not weaken checks
to obtain a pass.

The developer checks the change, the harness independently runs its configured gate, the reviewer
investigates correctness and gaps, and CI verifies the delivered revision on its platform.
Review need not replay every check when existing evidence answers the question.

Use the configured host environment. Use local WSL only to answer a specific platform question;
keep platform-specific dependencies separate. Linux CI remains its own gate. Historical benchmark
scripts do not require a measurement campaign in every task: gather the evidence the task needs.

## Respect the role

A Nexus coding turn works in its retained workspace and leaves local commits. The configured
harness integration path owns publication and completion; the turn does not push, merge or change
Jira. Authorized target build/test changes do not authorize changing the external harness or host
configuration. Planned recovery-agent permissions are separate from developer/reviewer permissions.

Tests use temporary resources, not live agents, Jira or credentials. Provider exercises and
publication require explicit task authorization. Report changes, checks, outcomes and gaps
honestly; cached results and mocked behavior are not fresh execution or live verification.
