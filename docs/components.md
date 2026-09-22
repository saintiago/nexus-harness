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
A developer's success claim cannot substitute for a successful check result.

## Process execution

Run a command with explicit arguments, environment, working directory and bounds. Capture its
output and outcome. Propagate cancellation and confirm owned work has stopped before resources
are reused. Report uncertainty when shutdown cannot be established.

## Conversation history

Give developers and reviewers consistent, attributed task context. Preserve complete actionable
findings and responses, distinguish new feedback from previously consumed material, and expose
missing evidence. Keep a turn's input stable while later conversation updates arrive.

## Review

Evaluate the delivered revision against the task and required behavior. Give the reviewer a
consistent repository view and complete prior findings. Validate and retain its verdict before
publication. Approval applies to the reviewed revision, not to later changes.

## Delivery and completion

Publish only work that passed its configured checks. Identify the correct repository, branch and
PR. Request native auto-merge only through the configured gates; verify the merge and required
post-merge workflows before completing the task. Re-read remote state after ambiguous outcomes
and avoid duplicate actions when resuming.

## Queue coordination

Carry one ticket through execution, review and completion before selecting another. Continue a
returned repair in its retained workspace. Prepare the source checkout for the next task without
discarding work. Finite mode exits when no eligible work remains; watch mode waits for more work.

## Records and presentation

Retain enough execution and publication evidence to explain outcomes and resume safely. Keep
machine evidence distinct from concise human summaries. Terminal presentation reflects observed
progress; it does not decide success.

## Integration adapters

Translate task-source, GitHub and coding-runtime protocols into the observations and operations
these components need. Keep credentials and provider-specific details at those boundaries.
