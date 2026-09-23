/** The usage text, and the one line that points a caller at it. */
export const HELP = `nexus harness — local-first development harness

Usage: <command> [options]

Configuration is two files (docs/WORKFLOW.md §1). One Nexus-wide harness
configuration says how this instance runs work; one project configuration,
nexus.project.json in a connected repository's root, says what that repository
is. Every command reads both and runs on what they compose.

Commands:
  check-config   Read and validate the harness configuration, the connected
                 project's configuration, and a task file when given.
  run            Run a task file through the workspace/check/repair loop.
  source list    Preview the configured task source. Read-only: contacts the source,
                 claims nothing, starts no run, and costs no coding turns.
  source run     Take one finite batch of eligible source tasks and run each one.
  source watch   Do that once, then keep polling for new eligible tasks until stopped.
  review scan    Review the pull requests of tickets in the configured review status
                 once, and publish one native GitHub review per unreviewed head.
  review watch   Do that once, then keep scanning until stopped.
  queue run      Finish eligible tickets one at a time through coding, delivery,
                 review and completion, and exit when no eligible ticket remains.
  queue watch    Do that, and when the queue is empty wait for the next eligible
                 ticket instead of exiting. One foreground process; Ctrl+C stops it.
  supervise run    Run the queue under the supervisor: a worker in this process's
                 place, and the configured recovery agent after an unexpected stop.
  supervise watch  Do that for a watch-mode worker instead: it keeps watching until
                 stopped or until an incident needs a person.
  supervise ticket <key>
                 Do that for one ticket only, followed by identity from its current
                 status to its end. No other ticket is claimed or reported on.

Options:
  --config <path>   The Nexus-wide harness configuration: the output directory,
                    limits, coding launches, and reviewer integration. Every
                    command takes it.
  --repo <path>     The connected project's checkout, for the commands that clone
                    from one: run, source run, source watch, queue run, queue watch.
                    The project's own configuration is read from its root.
  --project <path>  The connected project's root directory, for the commands that
                    only need its configuration: check-config, source list,
                    review scan and review watch.
  --task <path>     Task file (run; optional for check-config).
  --limit <count>   Most new source tasks one \`source run\` attempts, or most reviewer
                    turns one \`review scan\` starts (those commands only).
  --ticket <key>    The one ticket a \`queue run\` follows by identity, and claims,
                    reviews and reports on nothing else (\`queue run\` only).
  -h, --help        Show this help.

Examples:
  npm run dev -- --help
  npm run dev -- check-config --config nexus.config.json --project ../target-project --task examples/task.json
  npm run dev -- run --repo ../target-project --config nexus.config.json --task examples/task.json
  npm run dev -- source list --config nexus.config.json --project ../target-project
  npm run dev -- source run --repo ../target-project --config nexus.config.json --limit 1
  npm run dev -- source watch --repo ../target-project --config nexus.config.json
  npm run dev -- review scan --config nexus.config.json --project ../target-project
  npm run dev -- review watch --config nexus.config.json --project ../target-project
  npm run dev -- queue run --repo ../target-project --config nexus.config.json
  npm run dev -- queue watch --repo ../target-project --config nexus.config.json
  npm run dev -- supervise run --repo ../target-project --config nexus.config.json
  npm run dev -- supervise watch --repo ../target-project --config nexus.config.json
  npm run dev -- supervise ticket HARN-51 --repo ../target-project --config nexus.config.json

Paths given on the command line resolve from the directory the command was invoked
in, exactly as the shell would read them. \`workDir\` resolves from the harness
configuration file's own directory instead, so the same harness configuration names
the same output wherever the command is run from.

check-config is static: it creates nothing, runs no configured command, contacts no
provider or source, resolves no credential, and needs none. It validates the
Nexus-wide harness configuration, the connected project's own configuration, and
with \`--task\` that file too; nothing is defaulted from the single-file example
this contract replaced. A field in the wrong file, a project completion without
harness completion policy, and every other mismatch fail before anything runs,
with both paths and the field named. Shared reviewer policy enables review only
for projects declaring both source and delivery; local-only projects use the same
harness file without enabling review.

run prepares a working copy of the source repository, runs the connected project's
setup and checks, asks the coding runtime to implement the task, reruns the checks,
and gives the runtime the observed failures to repair within maxRepairs. Progress
and the outcome are printed; the working copy and the report are always kept. A
coding turn is asked to make small local commits in the working copy, and the run
itself never pushes, merges, or publishes anything: the commits stay local to the
retained workspace, and the work is never integrated for you. The run ends at the
first of: a green round, a red round with no repair allowance left, a failure it
cannot repair away, the task deadline, or a user interrupt (Ctrl+C, or Ctrl+Break
on Windows), which stops the run and waits for it to finalize.

source list, source run and source watch are the intake commands. They need a
\`source\` object in the connected project's configuration and the credential its
\`tokenEnv\` names in the environment; a source run or watch also needs \`--repo\`.
\`source list\` only reads: it claims nothing and starts nothing. A source run claims
each eligible issue it finds, runs it through the same loop, and posts the result
back. source watch does that for every scan and keeps polling until you stop it.
Runs stay sequential, and one local receipt per issue prevents attempting the same
issue twice. When the project also selects a \`delivery\` step, a passed attempt's
branch is pushed and its pull request opened or updated before that result is
posted; without one, nothing leaves the machine. \`run --task\` never delivers: its
clone is fresh every time. When that project \`delivery\` carries a \`completion\`
object and the harness configuration carries its \`completion\` policy, an In Review
item whose delivered pull request the Nexus Lens reviewer approved is carried
through native GitHub auto-merge and the configured post-merge main workflows to a
verified resolution, or back to its To Do status with findings; the harness never
merges a pull request itself, and without those objects nothing about the pull
request changes.

review scan and review watch are the opt-in Nexus Lens review commands. They need
the harness configuration's \`reviewer\` object and, in the connected project, the
\`source\` connection a scan reads and the \`delivery\` repository whose pull requests
are reviewed, the Jira credential, and the GitHub App key path named by
\`reviewer.app.privateKeyPathEnv\`. A scan reads the tickets the source reports as
being in review, finds each one's open pull request by the branch its pointer label
names, and asks the explicitly configured \`reviewer.reviewer\` launch for a verdict.
The reviewer inspects a repository view cloned from that ticket's own retained
workspace under the configured workDir, pinned at the exact pull request head and
carrying no credential, instead of an assembled patch; a review that cannot be given
such a view, or whose view the turn changed, publishes nothing. A ticket whose
current head already carries a completed review by the App's login is left alone; a
new head is reviewed again. The verdict is published as one native GitHub review
(APPROVE or REQUEST_CHANGES) plus one app-owned check run named by
\`reviewer.checkName\`, successful only for an approval. Nothing merges, nothing
marks an issue Done, and a ticket the scan cannot review is reported and left in
review.

queue run and queue watch are the opt-in serial queue commands. They need the
project's \`source\`, a project \`delivery\` that carries \`delivery.completion\`, and
the harness configuration's \`reviewer\`, all naming the same repository, plus
\`--repo\` pointing at the operator's own checkout of the base branch. They keep one
current ticket and one active phase at a time: the coding attempt and its delivery,
then the Nexus Lens review of that ticket's pull request, then the completion path
that merges it once GitHub allows and verifies every configured post-merge
workflow. A ticket the review or CI sends back to its To Do status is repaired in
its preserved workspace before any other ticket is considered. queue run ends when
no eligible ticket remains; queue watch waits visibly for the next one and starts
no agent while it is idle. A ticket confirmed Done is followed by source readiness:
the configured base branch, the expected delivery repository, and a clean checkout
are required, and the checkout is only ever fast-forwarded to the verified merge
commit. Anything a person has to decide exits nonzero with the evidence kept.

supervise run, supervise watch and supervise ticket put a small parent in front of
that same queue. The supervisor starts the queue as a worker of its own — the same
CLI, with the same two files, and with its activity display intact — and watches
how that process ended. A plain zero exit settles it. An ending the operator asked
for with Ctrl+C stays stopped: nothing is recovered from an intentional stop. Any
other ending — a nonzero exit, a killed process, a crash with no report at all —
opens an incident and starts the configured recovery agent, whose own judgment
investigates the cause, preserves committed and uncommitted work, repairs the
harness or the workspace, reconciles the ticket, and says what resumes; a ticket
that has to come first may be ranked ahead of the interrupted one, and its
resumption is recorded. The supervisor needs a \`recovery\` object in the harness
configuration (docs/WORKFLOW.md section 12): the agent's launch, how many attempts
one incident may spend, and where its summary is emailed. Each concluded incident
publishes one concise Jira report into the ticket's own thread — written by the
same service account, so both the next developer turn and the next reviewer turn
read it in the shared history — and one email summary through the configured SNS
topic; those publications survive a supervisor restart without being repeated.
Recovery attempts are bounded, the same failure returning unchanged after a
repair ends in an actionable request for human help, and recovery context never
substitutes for a passed check, a review verdict, or the completion gate.
The parent has an entry point of its own,
\`node dist/cli/supervise.js <intent> --repo <checkout> --config <harness.json>\`,
which loads no ordinary command: use it when the CLI this help comes from will not
start, and let the recovery agent repair the installation.
The command \`supervise ticket <key>\` scopes the worker with
\`queue run --ticket <key>\`: only
that ticket is discovered, claimed, and reported on.

Exit codes:
  0    the run passed
  1    the run failed, or an input, preflight, or reporting error stopped the CLI
  2    usage error (unknown command or option, missing value)
  130  the run was stopped by the user (Ctrl+C, or Ctrl+Break on Windows), and
       was finalized first

Input contract: docs/WORKFLOW.md. Behaviour: docs/spec.md.`;
export const USAGE_HINT = 'Run "npm run dev -- --help" for usage.';
