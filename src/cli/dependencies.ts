/**
 * The loop's real collaborators, and the wrapped set a CLI invocation hands it.
 *
 * Every collaborator is an ordinary function of the module that owns it; this is
 * the only place they are composed into a run, and the only place a test's
 * substitution is merged over them. The wrapped ones let the terminal follow the
 * run: the allocated run directory is remembered, and the run's own timeline is
 * echoed as the runner writes it.
 */
import { runCodexTurn } from '../agents/codex/adapter.js';
import { selectedCodexRuntime } from '../agents/codex/runtime.js';
import { runCheckRound } from '../checks/round.js';
import { appendRunLog, openAgentLog } from '../reporting/logs.js';
import { writeRunReport } from '../reporting/report.js';
import type { RunnerDependencies } from '../runs/contracts.js';
import type { AgentSelection } from '../shared/types.js';
import { configureWorkspaceIdentity } from '../workspace/git.js';
import { prepareWorkspace } from '../workspace/prepare.js';
import { preflightSource } from '../workspace/preflight.js';
import { allocateRunDirectory } from '../workspace/run-directory.js';
import type { RunDirectory } from '../workspace/run-directory.js';
import { recordWorkspaceAttempt } from '../workspace/state.js';
import type { CliContext, CliIo } from './context.js';

function realDependencies(
  agent: AgentSelection,
  childEnvironment?: NodeJS.ProcessEnv,
): RunnerDependencies {
  return {
    preflight: preflightSource,
    allocateRunDirectory,
    prepareWorkspace,
    configureWorkspaceIdentity,
    // A file-task run passes no environment: its commands and its runtime
    // inherit this process's own, exactly as before. A source run passes a copy
    // with the Jira credential variable removed, so a token this harness
    // resolved is not handed to project code or to the coding runtime
    // (docs/architecture.md §9). Nothing here touches `process.env` itself.
    runCheckRound:
      childEnvironment === undefined
        ? runCheckRound
        : (request) => runCheckRound({ ...request, env: childEnvironment }),
    runAgentTurn: (request) =>
      runCodexTurn(
        request,
        selectedCodexRuntime(
          agent,
          childEnvironment === undefined ? {} : { env: childEnvironment },
        ),
      ),
    openAgentLog,
    appendRunLog,
    writeRunReport,
    recordWorkspaceAttempt,
    now: () => new Date(),
  };
}

/**
 * The one timeline line that is not progress. The runner records its final
 * status in the timeline before it writes the report, and the terminal must not
 * be told how the run ended any earlier than the report exists: the CLI prints
 * the outcome itself, from the result, once the report is really written.
 */
const FINAL_STATUS_PREFIX = 'final status:';

/**
 * The loop's collaborators as this invocation will use them: the real ones,
 * with any substitution the caller made, and two wrapped so the terminal can be
 * told what the run is doing.
 *
 * - `allocateRunDirectory` is wrapped to remember the run directory as soon as
 *   one exists, so that a failure afterwards — a report that cannot be written
 *   above all — can name the location the run was kept in.
 * - `appendRunLog` is wrapped to echo the run's own timeline as the runner
 *   writes it, which is what the progress the user sees is made of. The line is
 *   echoed only after it was appended, and the runner's final status is left to
 *   the outcome block.
 */
export function composeDependencies(
  context: CliContext,
  io: CliIo,
  onAllocated: (run: RunDirectory) => void,
  agent: AgentSelection,
  childEnvironment?: NodeJS.ProcessEnv,
): RunnerDependencies {
  const real = realDependencies(agent, childEnvironment);
  const replaced = context.dependencies ?? {};
  const allocate = replaced.allocateRunDirectory ?? real.allocateRunDirectory;
  const append = replaced.appendRunLog ?? real.appendRunLog;

  return {
    preflight: replaced.preflight ?? real.preflight,
    allocateRunDirectory: async (workDir: string) => {
      const run = await allocate(workDir);
      onAllocated(run);
      return run;
    },
    prepareWorkspace: replaced.prepareWorkspace ?? real.prepareWorkspace,
    configureWorkspaceIdentity:
      replaced.configureWorkspaceIdentity ?? real.configureWorkspaceIdentity,
    runCheckRound: replaced.runCheckRound ?? real.runCheckRound,
    runAgentTurn: replaced.runAgentTurn ?? real.runAgentTurn,
    openAgentLog: replaced.openAgentLog ?? real.openAgentLog,
    appendRunLog: async (runLog: string, message: string) => {
      await append(runLog, message);
      if (!message.startsWith(FINAL_STATUS_PREFIX)) {
        io.out(message);
      }
    },
    writeRunReport: replaced.writeRunReport ?? real.writeRunReport,
    recordWorkspaceAttempt: replaced.recordWorkspaceAttempt ?? real.recordWorkspaceAttempt,
    now: replaced.now ?? real.now,
  };
}

/**
 * The host's own interrupt signals, and nothing else. `SIGINT` is what Ctrl+C
 * sends on every supported platform — Node delivers it on Windows too — and
 * `SIGTERM` is the ordinary way a Unix supervisor asks a process to stop.
 *
 * Windows has a second one, and the CLI would be wrong to ignore it. Ctrl+C is
 * delivered to a process the console considers its own: it is disabled for a
 * process started in a new process group, which is exactly how a supervisor, an
 * IDE, or another program starts one. Ctrl+Break reaches those processes, and
 * Node reports it as `SIGBREAK`, which is not a signal the default handler
 * cancels on — a Windows CLI listening only for `SIGINT` would be ended where it
 * wanted to stop, leaving the working copy, the runtime it started, and the
 * report behind. It is installed on Windows alone, where Node sends it; the
 * name is not a signal the other platforms have.
 *
 * A listener replaces Node's default handling of these signals, and it is
 * installed only for the duration of a `run`: it is released the moment the run
 * has finalized, and nothing else this CLI does installs one at all. A `--help`
 * call, and any module that imports this one, leaves the process's signals alone.
 */
