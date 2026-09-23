# Components

## Task intake

Read eligible tasks from the configured source and preserve their identity, requirements and
conversation. Claim work exclusively, respect source ordering and human state changes, and
report outcomes back without duplicate publication.

## Workspace management

Provide an isolated working copy and retain useful work across attempts. Establish ownership
before reuse, preserve local changes and Git history, and identify the revision being checked
or delivered. An uncertain workspace must not be silently reset or adopted.

## Execution and repair

Give the developer the task and relevant history, execute the configured checks, and request
repairs from observed failures. Apply the configured repair allowance, escalation and deadlines.
A developer's success claim cannot substitute for a successful check result. Tell the turn what a
passing check does and does not mean, let it change the project's own build and test configuration
only where the task explicitly asks for that, and require it to verify its change at the affected
integration point instead of repeating an expensive test matrix. Every finding a review left
outstanding receives one explicit answer — cause, affected scope, repair, verification, remaining
uncertainty — and a missing or partial answer stays incomplete rather than reading as remediation.

## Process execution

Run a command with explicit arguments, environment, working directory and bounds. Capture its
output and outcome. Propagate cancellation and confirm owned work has stopped before resources
are reused. Report uncertainty when shutdown cannot be established.

## Conversation history

Give developers and reviewers consistent, attributed task context. Preserve complete actionable
findings and responses, distinguish new feedback from previously consumed material, and expose
missing evidence. Keep a turn's input stable while later conversation updates arrive. Keep every
outstanding finding's identity stable, render it with the answer it received and the verification
it was given, and keep a developer's claim apart from a reviewer's verification: a finding with no
complete answer — or one whose latest report is missing or incomplete — and a finding whose repair
was never verified are never presented as resolved. A finding a later review raises again keeps the
identity it continues and records its own occurrence beside it, and a new change request adds the
findings it raises without clearing the ones already outstanding. A continuation is resolved
against every identity the history retained, so a defect an earlier review already settled keeps the
identity it was raised with when a later revision brings it back: a native review the harness kept
no report for is reconstructed from the review and its inline comments, and those identities
survive the review that settled them.

## Review

Evaluate the delivered revision against the task and required behavior. Give the reviewer a
consistent repository view and complete prior findings. Validate and retain its verdict before
publication. Verify each outstanding disposition in the reviewed revision itself and record that
verification with the verdict — only a `verified` reading settles one, while `unverified` and
`regressed` leave it outstanding for the next round; classify and group confirmed related
occurrences rather than reporting one example at a time; and keep reviewing the whole change against
the requested outcome. Approval applies to the reviewed revision, not to later changes. Only a
review the pull request itself carries settles an earlier disposition: an approval clears one only
at the head it was made on, a verdict refused publication is conversation, not a settlement, and a
review GitHub has dismissed settles nothing — its approval clears nothing at any head, and the
findings its own report raised stay outstanding because dismissal withdraws the blocking state,
not the defect the review recorded.

## Delivery and completion

Publish only work that passed its configured checks. Identify the correct repository, branch and
PR. Request native auto-merge only through the configured gates; verify the merge and required
post-merge workflows before completing the task. Re-read remote state after ambiguous outcomes
and avoid duplicate actions when resuming.

## Queue coordination

Carry one ticket through execution, review and completion before selecting another. Continue a
returned repair in its retained workspace. Prepare the source checkout for the next task without
discarding work. Finite mode exits when no eligible work remains; watch mode waits for more work.

## Supervision and recovery

Run the queue as a worker under a small parent that owns one worker at a time, detects an
unexpected stop without inventing one from an intentional cancellation, and records one incident
per stopped episode. Invoke the configured recovery agent with unattended operational access, keep
its judgment, bound the attempts one incident may spend, and end a repeated unchanged failure in an
actionable request for human help. Preserve committed and uncommitted work, record the resumption
that really happened, and publish one concise report per incident without duplicating it across
restarts. Recovery context never substitutes for approval or verification.

## Records and presentation

Retain enough execution and publication evidence to explain outcomes and resume safely. Keep
machine evidence distinct from concise human summaries. Terminal presentation reflects observed
progress; it does not decide success.

## Integration adapters

Translate task-source, GitHub and coding-runtime protocols into the observations and operations
these components need. Keep credentials and provider-specific details at those boundaries.
