import path from 'node:path';
import { loadNexusConfiguration, loadProjectConfiguration } from '../configuration/index.js';
import type { ArtifactRef, Observer } from '../result.js';
import { readRecord } from '../task-engine/actions/records.js';
import { selectionDeclaration } from '../task-engine/actions/select-task/artifacts.js';
import type { EngineEvent, Unsubscribe, WorkflowResult } from '../task-engine/index.js';
import { executionPaths, workerProcessEnvironment } from './composition.js';
import { createExecutionLog, executionLogFile, type DiagnosticSink } from './execution-log.js';
import { createRecovery, type RecoveryRuntimeFactory, type RecoverySelection } from './recovery.js';
import { createRecoveryRuntime } from './recovery-runtime.js';
import { loadWorkflow } from './workflow.js';

/**
 * Application manages one Nexus execution: the operator command, configuration loading, parent and
 * worker component wiring, worker lifecycle and process exit. See docs/application.md for the
 * contract this module implements.
 */

/** One execution's request: the absolute project configuration filepath. */
export type ExecutionRequest = {
  readonly projectConfigPath: string;
};

/** Application forwards worker events unchanged and adds its own lifecycle events. */
export type ExecutionEvent = EngineEvent;

/** The recovery decision and report from the Application provided interface. */
export type { RecoveryDecision, RecoveryReport } from './recovery.js';

/** The execution's final state: what happened, why, and the saved recovery report when one exists. */
export type ExecutionResult = {
  readonly outcome: 'completed' | 'needs-attention';
  readonly reason: string;
  readonly report: ArtifactRef | null;
};

export interface Application {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  subscribe(listener: Observer<ExecutionEvent>): Unsubscribe;
}

/** One worker launch request: the project filepath and the environment the worker runs with. */
export type WorkerLaunchRequest = {
  readonly projectConfigPath: string;
  readonly environment: Readonly<Record<string, string>>;
};

/**
 * What one launched worker reported. A launch or protocol problem is not a workflow result: the
 * parent evaluates the result, the exit code and the stream together.
 */
export type WorkerCompletion = {
  /** The final workflow result, or null when the worker reported none or an unreadable one. */
  readonly result: WorkflowResult | null;
  /** The worker's exit code, or null when it did not exit normally. */
  readonly exitCode: number | null;
  /** Why the launch or the worker protocol failed, or null when the worker ran and spoke it. */
  readonly problem: string | null;
  /** The diagnostics the worker wrote to standard error. */
  readonly diagnostics: string;
};

/** Launches one worker execution and forwards its events as they arrive. */
export type WorkerLaunch = (
  request: WorkerLaunchRequest,
  onEvent: (event: EngineEvent) => void,
) => Promise<WorkerCompletion>;

/** What the parent needs to construct its dependencies and launch the worker. */
export type ApplicationSettings = {
  /** The Nexus installation configuration filepath. */
  readonly installationConfigPath: string;
  /** The host environment credential references resolve from. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Launches one worker execution; the operator command supplies the process bridge. */
  readonly launchWorker: WorkerLaunch;
  /** Reports execution-log failures; the operator command supplies its standard error. */
  readonly diagnostics?: DiagnosticSink;
  /**
   * Builds the execution's recovery runtime; the default wires the configured recovery profile over
   * the coding provider and the configured Notifications adapter. Tests substitute a controlled
   * runtime so no provider, ticket or notification service is contacted.
   */
  readonly recovery?: RecoveryRuntimeFactory;
};

/** How one worker launch ended, as execution completion or a failure that needs recovery. */
type Completion =
  | { readonly kind: 'completed'; readonly outcome: string }
  | { readonly kind: 'stopped'; readonly failure: string; readonly diagnostics: string };

/**
 * Evaluate both the worker's result and its process exit. Zero exit alone is not completion; a
 * blocked outcome, fault, missing or invalid result and a failed exit all stop the execution.
 */
function completionOf(
  completion: WorkerCompletion,
  successfulOutcomes: readonly string[],
): Completion {
  const diagnostics = completion.diagnostics.trim();
  const detail = diagnostics === '' ? '' : `\n${diagnostics}`;
  if (completion.problem !== null) {
    return {
      kind: 'stopped',
      failure: `${completion.problem}${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (completion.result === null) {
    return {
      kind: 'stopped',
      failure: `The worker exited without reporting a workflow result.${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (!completion.result.ok) {
    return {
      kind: 'stopped',
      failure: `Execution fault: ${completion.result.fault.message}${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (completion.exitCode !== 0) {
    return {
      kind: 'stopped',
      failure:
        `The worker exited with code ${completion.exitCode} after reporting outcome ` +
        `"${completion.result.value}".${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (!successfulOutcomes.includes(completion.result.value)) {
    return {
      kind: 'stopped',
      failure:
        `The workflow reached outcome "${completion.result.value}" without completing ` +
        `successfully.${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  return { kind: 'completed', outcome: completion.result.value };
}

/** Create the Application over its installation settings, worker launch and recovery runtime. */
export function createApplication(settings: ApplicationSettings): Application {
  const listeners = new Set<Observer<ExecutionEvent>>();
  const recoveryFactory = settings.recovery ?? createRecoveryRuntime;
  const diagnostics = settings.diagnostics ?? process.stderr;

  /** Forward one event to the observers; listener failures do not affect execution. */
  const publish = (event: ExecutionEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A listener failure is isolated from execution and from the other listeners.
      }
    }
  };
  const emitLifecycle = (type: string, data: unknown): void => {
    publish({ source: 'application', type, data });
  };

  /** The retained selection's task and workspace, or null when the record is not readable. */
  async function retainedSelection(selectionFile: string): Promise<RecoverySelection | null> {
    try {
      const selection = await readRecord(selectionFile, selectionDeclaration);
      return selection === null
        ? null
        : { task: selection.taskKey, workspace: selection.workspace };
    } catch {
      return null;
    }
  }

  return {
    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      if (!path.isAbsolute(request.projectConfigPath)) {
        throw new Error(
          `The project configuration filepath "${request.projectConfigPath}" is not absolute.`,
        );
      }
      const nexus = await loadNexusConfiguration(settings.installationConfigPath);
      const project = await loadProjectConfiguration(request.projectConfigPath);
      const workflow = await loadWorkflow(nexus.workflow.path);
      const paths = executionPaths(nexus, project);
      // Open the log before the starting event and close it after finished on every exit path.
      const logFile = executionLogFile(paths.directory);
      const log = await createExecutionLog({ file: logFile, diagnostics });
      listeners.add(log.record);
      try {
        emitLifecycle('starting', null);
        const recovery = createRecovery({
          nexus,
          project,
          workflow,
          paths,
          logFile,
          runtime: recoveryFactory({ nexus, environment: settings.environment }),
          publish,
        });
        // One execute call manages one execution: its request and allowance are recorded before the
        // first worker starts, so worker restarts cannot reset what recovery has already consumed.
        await recovery.begin(request);
        const finished = (result: ExecutionResult): ExecutionResult => {
          emitLifecycle('finished', result);
          return result;
        };
        /** Delivery failures are reported separately; they never repeat or replace recovery. */
        const deliveryNote = (): string => {
          const problems = recovery.deliveryProblems();
          return problems.length === 0
            ? ''
            : `\n${problems
                .map((problem) => `Recovery report delivery failed: ${problem}`)
                .join('\n')}`;
        };

        // Work and recovery run sequentially: each invocation finishes before the next starts.
        for (;;) {
          emitLifecycle('running', null);
          const completion = completionOf(
            await settings.launchWorker(
              {
                projectConfigPath: request.projectConfigPath,
                environment: workerProcessEnvironment(
                  nexus,
                  settings.environment,
                  settings.installationConfigPath,
                ),
              },
              publish,
            ),
            workflow.successfulOutcomes,
          );
          if (completion.kind === 'completed') {
            return finished({
              outcome: 'completed',
              reason:
                `The workflow finished with the successful outcome "${completion.outcome}".` +
                deliveryNote(),
              report: recovery.savedReport(),
            });
          }
          // Recovery reads the log, so writes pending before its invocation are drained.
          await log.drain();
          const outcome = await recovery.recover({
            failure: completion.failure,
            output: completion.diagnostics,
            selection: await retainedSelection(paths.selectionFile),
          });
          if (outcome.kind === 'resume') {
            continue;
          }
          return finished({
            outcome: 'needs-attention',
            reason: `${completion.failure}\n${outcome.reason}${deliveryNote()}`,
            report: recovery.savedReport(),
          });
        }
      } finally {
        listeners.delete(log.record);
        await log.close();
      }
    },

    subscribe(listener: Observer<ExecutionEvent>): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
