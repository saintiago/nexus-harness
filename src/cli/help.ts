/** The usage text, and the one line that points a caller at it. */
export const HELP = `nexus harness — local-first development harness

Usage: <command> [options]

Commands:
  check-config   Read and validate a configuration file, and a task file when given.
  run            Run a task file through the workspace/check/repair loop.
  source list    Preview the configured task source. Read-only: contacts the source,
                 claims nothing, starts no run, and costs no coding turns.
  source run     Take one finite batch of eligible source tasks and run each one.
  source watch   Do that once, then keep polling for new eligible tasks until stopped.
  review scan    Review the pull requests of tickets in the configured review status
                 once, and publish one native GitHub review per unreviewed head.
  review watch   Do that once, then keep scanning until stopped.

Options:
  --repo <path>     Source repository to task (run, source run, source watch).
  --config <path>   Configuration file, resolved from the current directory.
  --task <path>     Task file (run; optional for check-config).
  --limit <count>   Most new source tasks one \`source run\` attempts, or most reviewer
                    turns one \`review scan\` starts (those commands only).
  -h, --help        Show this help.

Examples:
  npm run dev -- --help
  npm run dev -- check-config --config harness.config.json --task examples/task.json
  npm run dev -- run --repo ../target-project --config harness.config.json --task examples/task.json
  npm run dev -- source list --config harness.jira.config.json
  npm run dev -- source run --repo ../target-project --config harness.jira.config.json --limit 1
  npm run dev -- source watch --repo ../target-project --config harness.jira.config.json
  npm run dev -- review scan --config harness.jira.config.json
  npm run dev -- review watch --config harness.jira.config.json

Paths given on the command line resolve from the directory the command was invoked
in, exactly as the shell would read them. \`workDir\` resolves from the configuration
file's own directory instead, so the same config names the same output wherever the
command is run from.

check-config is static: it creates nothing, runs no configured command, contacts no
provider or source, resolves no credential, and needs none. With \`--task\` it also
validates that file; without one it validates the configuration alone.

run prepares a working copy of the source repository, runs the configured setup and
checks, asks the coding runtime to implement the task, reruns the checks, and gives
the runtime the observed failures to repair within maxRepairs. Progress and the
outcome are printed; the working copy and the report are always kept. A coding turn
is asked to make small local commits in the working copy, and the run itself never
pushes, merges, or publishes anything: the commits stay local to the retained
workspace, and the work is never integrated for you. The run ends at the first of:
a green round, a red round with no repair allowance left, a failure it cannot repair
away, the task deadline, or a user interrupt (Ctrl+C, or Ctrl+Break on Windows),
which stops the run and waits for it to finalize.

source list, source run and source watch are the intake commands. They need a
\`source\` object in the configuration and the credential its \`tokenEnv\` names in the
environment; a source run or watch also needs \`--repo\`. \`source list\` only reads: it
claims nothing and starts nothing. A source run claims each eligible issue it finds,
runs it through the same loop, and posts the result back. source watch does that for
every scan and keeps polling until you stop it. Runs stay sequential, and one local
receipt per issue prevents attempting the same issue twice. When the configuration
also selects a \`delivery\` step, a passed attempt's branch is pushed and its pull
request opened or updated before that result is posted; without one, nothing leaves
the machine. \`run --task\` never delivers: its clone is fresh every time. When that
\`delivery\` step also carries a \`completion\` object, an In Review item whose
delivered pull request the Nexus Lens reviewer approved is carried through native
GitHub auto-merge and the configured post-merge main workflows to a verified
resolution, or back to its To Do status with findings; the harness never merges a
pull request itself, and without the object nothing about the pull request changes.

review scan and review watch are the opt-in Nexus Lens review commands. They need a
\`review\` object in the configuration beside the \`source\` connection it reviews
through, the Jira credential, and the GitHub App key path named by
\`review.app.privateKeyPathEnv\`. A scan reads the tickets the source reports as being
in review, finds each one's open pull request by the branch its pointer label names,
and asks the explicitly configured \`review.reviewer\` launch for a verdict. A ticket
whose current head already carries a completed review by the App's login is left
alone; a new head is reviewed again. The verdict is published as one native GitHub
review (APPROVE or REQUEST_CHANGES) plus one app-owned check run named by
\`review.checkName\`, successful only for an approval. Nothing merges, nothing marks
an issue Done, and a ticket the scan cannot review is reported and left in review.

Exit codes:
  0    the run passed
  1    the run failed, or an input, preflight, or reporting error stopped the CLI
  2    usage error (unknown command or option, missing value)
  130  the run was stopped by the user (Ctrl+C, or Ctrl+Break on Windows), and
       was finalized first

Input contract: docs/WORKFLOW.md. Behaviour: docs/spec.md.`;
export const USAGE_HINT = 'Run "npm run dev -- --help" for usage.';
