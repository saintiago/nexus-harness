import path from 'node:path';
import { loadNexusConfiguration, loadProjectConfiguration } from '../configuration/index.js';
import type { ArtifactRef, Observer } from '../result.js';
import { readRecord } from '../task-engine/actions/records.js';
import { selectionDeclaration } from '../task-engine/actions/select-task/artifacts.js';
import type { EngineEvent, Unsubscribe, WorkflowResult } from '../task-engine/index.js';
import { executionPaths, workerProcessEnvironment } from './composition.js';
import {
  recoveryPending,
  type RecoveryContext,
  type RecoveryInvocation,
  type TaskWorkspaceRef,
} from './recovery.js';
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

export type RecoveryDecision = { readonly kind: 'resume' } | { readonly kind: 'needs-attention' };

export type RecoveryReport = {
  readonly summary: string;
  readonly decision: RecoveryDecision;
};

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
  /** The recovery invocation; the deferred boundary stops for attention until it is implemented. */
  readonly recovery?: RecoveryInvocation;
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

/** Create the Application over its installation settings, worker launch and recovery boundary. */
export function createApplication(settings: ApplicationSettings): Application {
  const listeners = new Set<Observer<ExecutionEvent>>();
  const recover = settings.recovery ?? recoveryPending;

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

  /** The workspace of the retained selection, or null when none is readable. */
  async function retainedWorkspace(selectionFile: string): Promise<TaskWorkspaceRef | null> {
    try {
      const selection = await readRecord(selectionFile, selectionDeclaration);
      return selection === null ? null : selection.workspace;
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
      emitLifecycle('starting', null);
      const nexus = await loadNexusConfiguration(settings.installationConfigPath);
      const project = await loadProjectConfiguration(request.projectConfigPath);
      const workflow = await loadWorkflow(nexus.workflow.path);
      const paths = executionPaths(nexus, project);

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

      const finished = (result: ExecutionResult): ExecutionResult => {
        emitLifecycle('finished', result);
        return result;
      };
      if (completion.kind === 'completed') {
        return finished({
          outcome: 'completed',
          reason: `The workflow finished with the successful outcome "${completion.outcome}".`,
          report: null,
        });
      }

      // Recovery integration is a separate pending task; until it exists the explicit boundary
      // below stops the execution with needs-attention instead of claiming a recovery.
      emitLifecycle('recovering', { reason: completion.failure });
      const context: RecoveryContext = {
        request,
        project,
        failure: completion.failure,
        execution: paths,
        workspace: await retainedWorkspace(paths.selectionFile),
        output: completion.diagnostics,
      };
      const recovery = await recover(context);
      return finished({
        outcome: 'needs-attention',
        reason: `${completion.failure}\n${recovery.summary}`,
        report: null,
      });
    },

    subscribe(listener: Observer<ExecutionEvent>): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
