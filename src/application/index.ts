import path from 'node:path';
import {
  loadNexusConfiguration,
  loadProjectConfiguration,
  type WorkflowName,
} from '../configuration/index.js';
import { messageOf, type ArtifactRef, type Observer } from '../result.js';
import { createAnalyzeExperience } from '../task-engine/actions/analyze-experience/index.js';
import { readRecord } from '../task-engine/actions/records.js';
import {
  ideaSelectionDeclaration,
  type IdeaSelection,
} from '../task-engine/actions/select-idea/artifacts.js';
import {
  selectionDeclaration,
  type Selection,
} from '../task-engine/actions/select-task/artifacts.js';
import { issueSummary } from '../task-engine/actions/source.js';
import {
  agentInvocationOf,
  type AgentActivity,
  type EngineEvent,
  type Unsubscribe,
  type WorkflowResult,
} from '../task-engine/index.js';
import {
  executionPaths,
  experienceStoreDirectory,
  toolEnvironment,
  workerProcessEnvironment,
} from './composition.js';
import { createAnalysisRuntime, type AnalysisRuntimeFactory } from './analysis-runtime.js';
import { operationalErrorHandoff } from './analysis-handoff.js';
import { createActivityLog } from './activity-log.js';
import {
  createExecutionLog,
  executionLogDirectory,
  executionLogFile,
  type DiagnosticSink,
} from './execution-log.js';
import { createRecovery, type RecoveryRuntimeFactory, type RecoverySelection } from './recovery.js';
import { createRecoveryRuntime } from './recovery-runtime.js';
import { loadWorkflow } from './workflow.js';

/**
 * Application manages one Nexus execution: the operator command, configuration loading, parent and
 * worker component wiring, worker lifecycle and process exit. See docs/application.md for the
 * contract this module implements.
 */

/** One execution's request: the absolute project configuration filepath and selected workflow. */
export type ExecutionRequest = {
  readonly projectConfigPath: string;
  readonly workflow: WorkflowName;
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
  /**
   * Observe attributable agent activity while it happens. Panes match activity to an invocation by
   * its invocation ID; the complete activity is also written to the invocation's durable log.
   */
  subscribeActivity(listener: Observer<AgentActivity>): Unsubscribe;
}

/** One worker launch request: the project filepath and the environment the worker runs with. */
export type WorkerLaunchRequest = {
  readonly projectConfigPath: string;
  readonly workflow: WorkflowName;
  readonly environment: Readonly<Record<string, string>>;
  /** The execution's log directory: the worker names each invocation's own activity log under it. */
  readonly logDirectory: string;
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
  onActivity: (activity: AgentActivity) => void,
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
   * The Memory service transport; tests substitute a controlled fetch so no service is contacted.
   */
  readonly memoryTransport?: typeof globalThis.fetch;
  /**
   * Builds the execution's recovery runtime; the default wires the configured recovery profile over
   * the coding provider and the configured Notifications adapter. Tests substitute a controlled
   * runtime so no provider, ticket or notification service is contacted.
   */
  readonly recovery?: RecoveryRuntimeFactory;
  /**
   * Builds AnalyzeExperience's analyst; the default wires the configured analysis profile over the
   * coding provider. Tests substitute a controlled analyst so no provider turn is spent.
   */
  readonly analysis?: AnalysisRuntimeFactory;
};

/**
 * How one worker launch ended. A declared blocked outcome is the workflow's own business verdict,
 * not an execution fault: it needs recovery but never an invented operational-error handoff.
 */
type Completion =
  | { readonly kind: 'completed'; readonly outcome: string }
  | { readonly kind: 'blocked'; readonly failure: string; readonly diagnostics: string }
  | { readonly kind: 'fault'; readonly failure: string; readonly diagnostics: string };

/**
 * Evaluate both the worker's result and its process exit. Zero exit alone is not completion; a
 * blocked outcome, fault, missing or invalid result and a failed exit all stop the execution. Only
 * an execution fault is an operational error; a valid non-successful result is the workflow's own
 * declared blocked outcome, whose terminal handoff the workflow already routed through
 * AnalyzeExperience, or skipped for a failed selection.
 */
function completionOf(
  completion: WorkerCompletion,
  successfulOutcomes: readonly string[],
): Completion {
  const diagnostics = completion.diagnostics.trim();
  const detail = diagnostics === '' ? '' : `\n${diagnostics}`;
  if (completion.problem !== null) {
    return {
      kind: 'fault',
      failure: `${completion.problem}${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (completion.result === null) {
    return {
      kind: 'fault',
      failure: `The worker exited without reporting a workflow result.${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (!completion.result.ok) {
    return {
      kind: 'fault',
      failure: `Execution fault: ${completion.result.fault.message}${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (completion.exitCode !== 0) {
    return {
      kind: 'fault',
      failure:
        `The worker exited with code ${completion.exitCode} after reporting outcome ` +
        `"${completion.result.value}".${detail}`,
      diagnostics: completion.diagnostics,
    };
  }
  if (!successfulOutcomes.includes(completion.result.value)) {
    return {
      kind: 'blocked',
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
  const activityListeners = new Set<Observer<AgentActivity>>();
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

  /** Forward one activity packet to the live observers; listener failures do not affect work. */
  const publishActivity = (activity: AgentActivity): void => {
    for (const listener of [...activityListeners]) {
      try {
        listener(activity);
      } catch {
        // A listener failure is isolated from execution and from the other listeners.
      }
    }
  };

  /** The retained selection's issue and workspace, or null when the record is not readable. */
  async function retainedSelection(
    selectionFile: string,
    declaration: typeof selectionDeclaration | typeof ideaSelectionDeclaration,
  ): Promise<RecoverySelection | null> {
    try {
      const selection = await readRecord(selectionFile, declaration);
      return selection === null
        ? null
        : {
            task: selection.taskKey,
            // The retained issue carries the Summary the recovery invocation's boundary shows.
            summary: issueSummary('issue' in selection ? selection.issue : selection.task),
            workspace: selection.workspace,
            // Idea refinement retains the shared issue root its refinement area belongs to.
            ...('issueWorkspace' in selection ? { issueWorkspace: selection.issueWorkspace } : {}),
          };
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
      const workflowPath = nexus.workflow[request.workflow];
      const workflow = await loadWorkflow(workflowPath);
      const paths = executionPaths(nexus, project, request.workflow);
      const selection = {
        declaration:
          request.workflow === 'idea-refinement' ? ideaSelectionDeclaration : selectionDeclaration,
      };
      // Open the log before the starting event and close it after finished on every exit path.
      const logDirectory = executionLogDirectory(paths.directory);
      const logFile = executionLogFile(logDirectory);
      const log = await createExecutionLog({ file: logFile, diagnostics });
      const activityLog = createActivityLog({
        directory: path.join(logDirectory, 'agents'),
        diagnostics,
      });
      /** Record and forward one activity packet, so live panes and the durable log both see it. */
      const recordActivity = (activity: AgentActivity): void => {
        activityLog.record(activity);
        publishActivity(activity);
      };
      /**
       * What this invocation's own events established about the attempt it worked on. A selection
       * failure leaves no attempt of its own, and a workflow capture proves the attempt's terminal
       * handoff is already recorded; either way the stopped invocation records no operational
       * fault for whatever selection record a previous attempt retained.
       */
      const progress: {
        owned: { readonly task: string } | null;
        captured: boolean;
        selectionFailed: boolean;
      } = { owned: null, captured: false, selectionFailed: false };
      let continuation: RecoverySelection | null = null;
      const resetAttemptProgress = (): void => {
        progress.owned = null;
        progress.captured = false;
        progress.selectionFailed = false;
      };
      /** Track one event's contribution to the attempt this invocation owns. */
      const recordAttemptProgress = (event: EngineEvent): void => {
        if (event.source === 'execution-runner' && event.type === 'state') {
          const value = (event.data as { readonly value?: unknown }).value;
          const states =
            typeof value === 'string'
              ? [value]
              : typeof value === 'object' && value !== null
                ? Object.keys(value)
                : [];
          const active = states.map((name) => workflow.machine.root.states[name]);
          if (
            active.some((state) =>
              state?.invoke.some(
                (invoke) => invoke.src === 'SelectTask' || invoke.src === 'SelectIdea',
              ),
            )
          ) {
            // Starting source access invalidates the previous queue item's ownership, even if
            // selection subsequently throws without publishing its failed outcome.
            progress.owned = null;
            progress.captured = false;
            progress.selectionFailed = true;
          } else if (
            progress.owned === null &&
            !progress.selectionFailed &&
            continuation !== null &&
            active.length > 0 &&
            active.every((state) => state !== undefined && state.type !== 'final')
          ) {
            // A worker state in selected work establishes continuation; merely loading an old
            // selection before launch does not. Initialization faults publish no such state.
            progress.owned = { task: continuation.task };
          }
          return;
        }
        if (
          event.source === 'analyze-experience' &&
          (event.type === 'outcome' || event.type === 'unavailable')
        ) {
          // Restored capture may be the first action event, and discovery failures carry no
          // task ID. Both still mark a terminal handoff, never a second operational fault.
          progress.captured = true;
          return;
        }
        if (event.type === 'failed' || event.type === 'exhausted') {
          if (event.source === 'select-task' || event.source === 'select-idea') {
            // The invocation's own selection failed; any retained selection belongs to another one.
            progress.owned = null;
            progress.captured = false;
            progress.selectionFailed = true;
          }
          return;
        }
        if (event.type !== 'outcome') {
          return;
        }
        const data = event.data as { readonly task?: unknown; readonly outcome?: unknown };
        const task = typeof data.task === 'string' ? data.task : null;
        if (task === null) {
          return;
        }
        if (event.source === 'select-task' || event.source === 'select-idea') {
          if (data.outcome === 'selected') {
            progress.owned = { task };
            progress.captured = false;
            progress.selectionFailed = false;
          } else {
            // An empty queue selects nothing; no attempt belongs to this invocation.
            progress.owned = null;
          }
          return;
        }
        if (progress.owned === null && !progress.selectionFailed) {
          // The invocation resumed an attempt in flight rather than selecting one itself.
          progress.owned = { task };
        }
      };
      /**
       * Receive one boundary or progress event: an invocation's activity file is opened before its
       * first packet and closed after its last, then the event reaches the observers unchanged.
       */
      const receive = (event: EngineEvent): void => {
        recordAttemptProgress(event);
        const invocation = agentInvocationOf(event);
        if (invocation !== null) {
          if (event.type === 'agent-started') {
            activityLog.start(invocation);
          } else {
            activityLog.finish(invocation);
          }
        }
        publish(event);
      };
      // AnalyzeExperience owns every automatic Memory call: Application constructs and supervises
      // its capability over the project's durable store without importing the Memory component.
      const memory = nexus.memory;
      const memoryEnabled = memory !== undefined && memory.enabled;
      const analysis = createAnalyzeExperience({
        directory: experienceStoreDirectory(paths),
        project: project.taskSource.project,
        profile: memoryEnabled ? memory.analysisProfile : null,
        memory: memoryEnabled
          ? {
              url: memory.serviceUrl,
              ...(settings.memoryTransport === undefined
                ? {}
                : { fetch: settings.memoryTransport }),
            }
          : null,
        analyze: memoryEnabled
          ? (settings.analysis ?? createAnalysisRuntime)({
              nexus,
              // The analyst runs with the provider's own settings and without any Nexus credential.
              environment: toolEnvironment(project, nexus, settings.environment),
              publish: receive,
              publishActivity: recordActivity,
              activityDirectory: path.join(logDirectory, 'agents'),
            })
          : null,
      });
      /**
       * Report one durable capture or analysis problem. Capture never waits for the analysis, and
       * this processing reports its problems as diagnostics without changing the business outcome
       * or invoking recovery solely for memory.
       */
      const reportMemory = (problem: string): void => {
        try {
          diagnostics.write(`Nexus memory analysis: ${problem}\n`);
        } catch {
          // A failed report leaves nothing further to say.
        }
      };
      /** Resume and settle AnalyzeExperience's durable requests. */
      const settleAnalysis = async (): Promise<void> => {
        let problems: readonly string[];
        try {
          problems = await analysis.processPending();
        } catch (error) {
          problems = [`experience-analysis processing failed: ${messageOf(error)}`];
        }
        for (const problem of problems) {
          reportMemory(problem);
        }
      };
      /**
       * Record the stopped invocation's retained fault before recovery can discard or replace its
       * attempt. The already-started agents have settled by the time the worker stopped; the
       * durable capture retains its evidence, so the analysis reads that attempt's evidence even
       * after recovery replaced it.
       */
      const captureOperationalError = async (
        failure: string,
        expectedTask: string,
      ): Promise<void> => {
        let retained: Selection | IdeaSelection | null;
        try {
          retained = await readRecord(paths.selectionFile, selection.declaration);
        } catch (error) {
          reportMemory(
            `the retained selection could not be read for the stopped invocation: ${messageOf(error)}`,
          );
          return;
        }
        if (retained === null) {
          // No selected work exists: an empty or failed selection is not an experience handoff.
          return;
        }
        if (retained.taskKey !== expectedTask) {
          reportMemory(
            `the stopped invocation of "${expectedTask}" does not own the retained selection ` +
              `"${retained.taskKey}"; no operational handoff was recorded`,
          );
          return;
        }
        try {
          const handoff = await operationalErrorHandoff({
            workflow: request.workflow,
            selection: retained,
            failure,
          });
          const captured = await analysis.capture(handoff);
          if (captured.outcome === 'unavailable') {
            reportMemory(
              `the stopped invocation of ${handoff.workId} could not be captured: ` +
                (captured.detail ?? 'the capture failed'),
            );
          }
        } catch (error) {
          reportMemory(`the stopped invocation could not be captured: ${messageOf(error)}`);
        }
      };
      listeners.add(log.record);
      try {
        emitLifecycle('starting', null);
        // A request left pending by an earlier process resumes before this execution's work.
        await settleAnalysis();
        const recovery = createRecovery({
          nexus,
          project,
          workflow,
          workflowName: request.workflow,
          workflowPath,
          paths,
          logFile,
          environment: toolEnvironment(project, nexus, settings.environment),
          runtime: recoveryFactory({ nexus, environment: settings.environment }),
          publish: receive,
          publishActivity: recordActivity,
          activityDirectory: path.join(logDirectory, 'agents'),
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
          resetAttemptProgress();
          continuation = await retainedSelection(paths.selectionFile, selection.declaration);
          emitLifecycle('running', null);
          const completion = completionOf(
            await settings.launchWorker(
              {
                projectConfigPath: request.projectConfigPath,
                workflow: request.workflow,
                environment: workerProcessEnvironment(
                  nexus,
                  settings.environment,
                  settings.installationConfigPath,
                ),
                logDirectory,
              },
              receive,
              recordActivity,
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
          await activityLog.drain();
          // An execution fault of an established attempt is a terminal handoff: record it with the
          // attempt's retained evidence before recovery may discard or replace that attempt, then
          // settle the analysis. A declared blocked outcome and a failed selection record nothing
          // here, and an attempt the workflow already captured is never recorded twice.
          // Ownership must come from this worker's events, including a resumed active state.
          if (
            completion.kind === 'fault' &&
            !progress.selectionFailed &&
            progress.owned !== null &&
            !progress.captured
          ) {
            await captureOperationalError(completion.failure, progress.owned.task);
          }
          await settleAnalysis();
          const outcome = await recovery.recover({
            failure: completion.failure,
            output: completion.diagnostics,
            selection: await retainedSelection(paths.selectionFile, selection.declaration),
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
        // The worker exit and a drained queue do not stop the analysis: pending requests settle
        // before the process ends, and their failures stay diagnostics.
        await settleAnalysis();
        listeners.delete(log.record);
        await log.close();
        await activityLog.close();
      }
    },

    subscribe(listener: Observer<ExecutionEvent>): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    subscribeActivity(listener: Observer<AgentActivity>): Unsubscribe {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
  };
}
