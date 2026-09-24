import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentEvent, AgentResult } from '../agent-runtime/index.js';
import type { NotificationAcceptance } from '../adapters/notifications.js';
import { run } from '../adapters/processes.js';
import type { NexusConfiguration, ProjectConfiguration } from '../configuration/index.js';
import { messageOf, type ArtifactRef, type Result } from '../result.js';
import type { ArtifactDeclaration } from '../task-engine/actions/artifacts.js';
import { completionArtifact } from '../task-engine/actions/complete-task/artifacts.js';
import { deliveryArtifact } from '../task-engine/actions/deliver/artifacts.js';
import { devArtifact } from '../task-engine/actions/develop/artifacts.js';
import { preparedWorkspaceDeclaration } from '../task-engine/actions/prepare-workspace/artifacts.js';
import { readRecord, writeRecord, type RecordDeclaration } from '../task-engine/actions/records.js';
import { reviewArtifact } from '../task-engine/actions/review/artifacts.js';
import { selectionDeclaration } from '../task-engine/actions/select-task/artifacts.js';
import { currentRoundDeclaration } from '../task-engine/actions/start-round/artifacts.js';
import { verificationArtifact } from '../task-engine/actions/verify/artifacts.js';
import type { EngineEvent } from '../task-engine/index.js';
import { workspaceRoot, type ExecutionPaths } from './composition.js';
import type { ExecutionRequest } from './index.js';
import type { Workflow } from './workflow.js';

/**
 * Application's recovery boundary and lifecycle. Application hands one stopped work invocation to
 * this module: it consumes the configured allowance, prepares the complete recovery context in a
 * separate operational workspace, runs the configured recovery profile, parses the returned
 * RecoveryReport, saves and publishes it and applies its decision. Recovery itself judges and
 * performs the repair; Application only consumes the decision. See docs/application.md and
 * docs/agent-runtime/recovery-role.md.
 */

/** The task workspace reference from the Workspace design, when a selection was readable. */
export type TaskWorkspaceRef = { readonly root: string };

/** The recovery invocation's decision: resume the queue or stop for operator attention. */
export type RecoveryDecision = { readonly kind: 'resume' } | { readonly kind: 'needs-attention' };

/** The response format requested from the recovery agent and parsed from its output. */
export const recoveryReportSchema = z.strictObject({
  summary: z.string().trim().min(1),
  decision: z.union([
    z.strictObject({ kind: z.literal('resume') }),
    z.strictObject({ kind: z.literal('needs-attention') }),
  ]),
});

/** The recovery agent's report, from the Application provided interface. */
export type RecoveryReport = z.infer<typeof recoveryReportSchema>;

/** Parse the agent's output as a report; unusable output is an error naming the problem. */
export function parseRecoveryReport(output: string): RecoveryReport {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(`The recovery agent returned unusable output: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const parsed = recoveryReportSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join('.') : '<report>';
        return `${location}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`The recovery agent's report does not match the response format: ${issues}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Application's recovery execution record: the retained execution request and the invocations this
 * execution has consumed. It persists the allowance across worker restarts.
 */
export const recoveryExecutionSchema = z.strictObject({
  request: z.strictObject({ projectConfigPath: z.string().trim().min(1) }),
  invocations: z.number().int().nonnegative(),
});

type RecoveryExecution = z.infer<typeof recoveryExecutionSchema>;

const recoveryExecutionDeclaration = {
  file: 'execution.json',
  schema: recoveryExecutionSchema,
} satisfies RecordDeclaration<typeof recoveryExecutionSchema>;

/** Application's recovery records live in this directory under the queue execution directory. */
const recoveryDirectoryName = 'recovery';

/** Each execution's saved reports live in their own directory under this one. */
const reportsDirectoryName = 'reports';

/** Recovery's separate operational workspace, under the recovery directory. */
const workspaceDirectoryName = 'workspace';

/** The target repository working copy within a workspace root (Workspace design). */
const worktreeDirectory = 'worktree';

/** The task selection Application hands recovery when the record is readable. */
export type RecoverySelection = {
  readonly task: string;
  readonly workspace: TaskWorkspaceRef;
};

/** What one recovery agent invocation receives. */
export type RecoveryInvocationRequest = {
  /** The complete context text for the configured recovery profile. */
  readonly context: string;
  /** The separate operational workspace recovery runs in, outside every task workspace. */
  readonly workspace: TaskWorkspaceRef;
  /** Receives the invocation's activity while it runs. */
  readonly onActivity: (activity: AgentEvent) => void;
};

/** One recovery agent invocation with the configured recovery profile. */
export type RecoveryAgent = (request: RecoveryInvocationRequest) => Promise<AgentResult>;

/** Publishes one saved recovery report; the provider's acceptance or failure. */
export type RecoveryNotifier = (
  subject: string,
  body: string,
) => Promise<Result<NotificationAcceptance>>;

/** The parent-side recovery capability: the agent invocation and report publication. */
export type RecoveryRuntime = {
  readonly invoke: RecoveryAgent;
  readonly notify: RecoveryNotifier;
};

/** What building the recovery runtime needs: resolved Nexus configuration and the host. */
export type RecoveryRuntimeConstruction = {
  readonly nexus: NexusConfiguration;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

/** Builds one execution's recovery runtime from resolved configuration. */
export type RecoveryRuntimeFactory = (construction: RecoveryRuntimeConstruction) => RecoveryRuntime;

/** What one stopped work invocation hands recovery. */
export type RecoveryStop = {
  /** Why execution stopped: the blocked outcome, fault, protocol or exit failure. */
  readonly failure: string;
  /** The diagnostics the stopped worker wrote, when it ran. */
  readonly output: string;
  /** The retained task selection when it is readable; null when it is absent or unreadable. */
  readonly selection: RecoverySelection | null;
};

/** What one recovery invocation decided for the execution. */
export type RecoveryOutcome =
  { readonly kind: 'resume' } | { readonly kind: 'attention'; readonly reason: string };

/** Application's recovery lifecycle for one execution. */
export type Recovery = {
  /** Record this execution's request and reset its allowance, before the first worker starts. */
  begin(request: ExecutionRequest): Promise<void>;
  /** Consume one allowance and run one recovery invocation; its decision for the execution. */
  recover(stop: RecoveryStop): Promise<RecoveryOutcome>;
  /** The latest saved report of this execution, or null when none was saved. */
  savedReport(): ArtifactRef | null;
  /** Report delivery failures Application observed, in order, for the execution result. */
  deliveryProblems(): readonly string[];
};

/** What creating the recovery lifecycle needs: resolved configuration and the runtime. */
export type RecoverySettings = {
  readonly nexus: NexusConfiguration;
  readonly project: ProjectConfiguration;
  readonly workflow: Workflow;
  readonly paths: ExecutionPaths;
  /** The execution's event log, which recovery reads to see what happened. */
  readonly logFile: string;
  /** The environment the operational workspace preparation runs with. */
  readonly environment: Readonly<Record<string, string>>;
  readonly runtime: RecoveryRuntime;
  /** Publishes one event to Application's combined stream, including agent activity. */
  readonly publish: (event: EngineEvent) => void;
};

/** The context the recovery agent receives, assembled from the resolved configuration and stop. */
type RecoveryContextSettings = {
  readonly request: RecoveryExecution['request'];
  readonly project: ProjectConfiguration;
  readonly nexus: NexusConfiguration;
  readonly workflow: Workflow;
  readonly paths: ExecutionPaths;
  readonly logFile: string;
  readonly recoveryDirectory: string;
  readonly workspace: TaskWorkspaceRef;
  readonly reports: readonly string[];
  readonly invocation: number;
  readonly stop: RecoveryStop;
};

/** One producer-owned declaration the recovery context states: its path and generated schema. */
type RecoveryDeclaration = {
  readonly title: string;
  readonly path: string;
  readonly schema: z.ZodType;
};

/** One declaration's stated path and generated JSON Schema. */
function declarationText(declaration: RecoveryDeclaration): string {
  return [
    declaration.title,
    `Path: ${declaration.path}`,
    'JSON Schema:',
    JSON.stringify(z.toJSONSchema(declaration.schema), null, 2),
  ].join('\n');
}

/** One producer-owned round artifact, with its declared path within the round directory. */
function roundArtifact(title: string, declaration: ArtifactDeclaration): RecoveryDeclaration {
  return {
    title,
    path: `artifacts/<roundNumber>/${declaration.pathFromArtifactsRoot}`,
    schema: declaration.schema,
  };
}

/** The producer-owned records and round artifacts recovery reconciles, with their declared paths. */
function recoveryDeclarations(settings: RecoveryContextSettings): RecoveryDeclaration[] {
  const { paths, recoveryDirectory } = settings;
  return [
    {
      title: 'Task selection record (SelectTask)',
      path: paths.selectionFile,
      schema: selectionDeclaration.schema,
    },
    {
      title: 'Prepared workspace record (PrepareWorkspace)',
      path: preparedWorkspaceDeclaration.file,
      schema: preparedWorkspaceDeclaration.schema,
    },
    {
      title: 'Current round record (StartRound)',
      path: currentRoundDeclaration.file,
      schema: currentRoundDeclaration.schema,
    },
    roundArtifact('Development output (Develop)', devArtifact),
    roundArtifact('Verification output (Verify)', verificationArtifact),
    roundArtifact('Delivery output (Deliver)', deliveryArtifact),
    roundArtifact('Review output (Review)', reviewArtifact),
    roundArtifact('Completion output (CompleteTask)', completionArtifact),
    {
      title: 'Recovery execution record (Application)',
      path: path.join(recoveryDirectory, recoveryExecutionDeclaration.file),
      schema: recoveryExecutionSchema,
    },
  ];
}

/** The complete context text one recovery invocation receives. */
function recoveryContextText(settings: RecoveryContextSettings): string {
  const { nexus, project, workflow, paths, logFile, stop, request, invocation } = settings;
  const selection = stop.selection;
  const taskWorkspaceRoot = path.join(workspaceRoot(nexus), project.taskSource.project);
  return [
    'Nexus recovery context',
    `This is recovery invocation ${String(invocation)} of ` +
      `${String(nexus.executionPolicy.maxRecoveryAttempts)} for the current execution. Recovery ` +
      `stays within project "${project.taskSource.project}". Cross-project repair and changes to ` +
      'the Nexus installation are outside this capability: when continuation requires either, ' +
      'return the needs-attention decision with the diagnosis.',
    ['Original execution request', `Project configuration file: ${request.projectConfigPath}`].join(
      '\n',
    ),
    ['Why the execution stopped', stop.failure].join('\n'),
    [
      'Worker output',
      stop.output.trim() === '' ? 'The worker reported no output.' : stop.output,
    ].join('\n'),
    [
      'Execution state',
      `Execution directory: ${paths.directory}`,
      `Workflow state file: ${paths.workflowStateFile} (the ExecutionRunner's persisted XState ` +
        'snapshot: JSON whose status is "active" or "done", whose value names the active state ' +
        'nodes and whose children map holds the invoked operations)',
      `Task selection file: ${paths.selectionFile} (SelectTask's record, JSON matching the task ` +
        'selection schema below)',
      `Execution event log: ${logFile} (newline-delimited JSON, one object per received event, ` +
        'each holding its ISO receipt timestamp and the event)',
      `Recovery directory: ${settings.recoveryDirectory}`,
      'Saved reports of this execution: ' +
        (settings.reports.length === 0 ? 'none yet' : settings.reports.join(', ')),
      `Your operational workspace: ${settings.workspace.root} (worktree/ is your working ` +
        'directory and is outside every task workspace)',
    ].join('\n'),
    [
      'Producer-owned record and artifact declarations',
      'Paths are relative to the retained task workspace root unless absolute. Round artifacts ' +
        'resolve within the current round directory artifacts/<roundNumber>/: the current-round ' +
        'record selects the number, and earlier rounds remain as history.',
      ...recoveryDeclarations(settings).map(declarationText),
    ].join('\n\n'),
    [
      'Retained task workspace',
      selection === null
        ? 'The task selection record was absent or unreadable, so no retained task workspace is ' +
          'known.'
        : `Task ${selection.task} retained the workspace at ${selection.workspace.root}.`,
      `Task workspaces live under ${taskWorkspaceRoot}/<task>/ with the fixed layout worktree/, ` +
        'artifacts/<roundNumber>/ and state/ (prepared-workspace.json, preparation/, ' +
        'current-round.json). Confirm that a workspace you delete belongs to the interrupted task ' +
        'under this root.',
    ].join('\n'),
    [
      'Selected workflow',
      `Module: ${nexus.workflow.path}`,
      'Definition (the loaded XState configuration; guard and action functions are code in the ' +
        'module above and are absent from this JSON):',
      JSON.stringify(workflow.machine.config, null, 2),
      `Successful terminal outcomes: ${workflow.successfulOutcomes.join(', ')}`,
    ].join('\n'),
    ['Current project configuration', JSON.stringify(project, null, 2)].join('\n'),
    [
      'Response format',
      'Return only one JSON object, without Markdown fences and without other text:',
      '{"summary": "<cause or remaining uncertainty, actions taken, ticket and queue changes, ' +
        'discarded work, and why resumption is ready or human attention is required>", ' +
        '"decision": {"kind": "resume"}}',
      'Use {"kind": "needs-attention"} as the decision when the execution cannot continue. ' +
        'Application saves and publishes the report and restarts the worker only after a resume ' +
        'decision.',
    ].join('\n'),
  ].join('\n\n');
}

/** The subject and body Application publishes for one saved report. */
function reportNotification(settings: {
  readonly project: ProjectConfiguration;
  readonly report: RecoveryReport;
  readonly failure: string;
  readonly reportPath: string;
  readonly executionDirectory: string;
}): { readonly subject: string; readonly body: string } {
  const decision = settings.report.decision.kind;
  return {
    subject:
      `Nexus recovery report (${settings.project.taskSource.project}): ` +
      (decision === 'resume' ? 'resume' : 'needs attention'),
    body: [
      `The queue execution for project ${settings.project.taskSource.project} stopped and the ` +
        'recovery agent reported.',
      `Execution directory: ${settings.executionDirectory}`,
      `Decision: ${decision}`,
      '',
      'Failure:',
      settings.failure,
      '',
      'Summary:',
      settings.report.summary,
      '',
      `Saved report: ${settings.reportPath}`,
    ].join('\n'),
  };
}

/**
 * Prepare the recovery operational workspace's worktree. The configured Codex provider refuses to
 * start in a working directory outside a Git repository, so the worktree is initialized as an
 * empty repository; `git init` is idempotent for a later recovery invocation of the same
 * execution.
 */
async function prepareOperationalWorktree(
  directory: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const diagnostics: Uint8Array[] = [];
  const result = await run(
    { executable: 'git', args: ['init', '--quiet'], directory, environment },
    (output) => {
      if (output.stream === 'stderr') {
        diagnostics.push(output.chunk);
      }
    },
  );
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  if (result.value.exitCode !== 0) {
    const detail = Buffer.concat(diagnostics).toString('utf8').trim();
    throw new Error(
      `git init exited with code ${String(result.value.exitCode)}` +
        (detail === '' ? '' : `: ${detail}`),
    );
  }
}

/** Create the recovery lifecycle of one execution over resolved configuration. */
export function createRecovery(settings: RecoverySettings): Recovery {
  const { nexus, project, workflow, paths, runtime, publish } = settings;
  const directory = path.join(paths.directory, recoveryDirectoryName);
  const executionFile = path.join(directory, recoveryExecutionDeclaration.file);
  // One Recovery instance manages one execute call, so a unique report directory per execution
  // keeps a later execute call from overwriting reports earlier ExecutionResults point to. Saved
  // reports stay numbered by invocation within that execution.
  const executionReports = path.join(directory, reportsDirectoryName, randomUUID());
  const workspace: TaskWorkspaceRef = { root: path.join(directory, workspaceDirectoryName) };
  const profile = nexus.executionPolicy.recoveryProfile;
  const allowance = nexus.executionPolicy.maxRecoveryAttempts;
  const deliveryProblems: string[] = [];
  let saved: ArtifactRef | null = null;

  const attention = (reason: string): RecoveryOutcome => ({ kind: 'attention', reason });

  /** The report paths earlier invocations of this execution saved, in invocation order. */
  const earlierReports = (invocation: number): string[] =>
    Array.from({ length: invocation - 1 }, (_, index) =>
      path.join(executionReports, `${String(index + 1)}.json`),
    );

  /** Publish the saved report; a delivery failure is recorded separately and never repeated. */
  async function deliver(
    reportRef: ArtifactRef,
    report: RecoveryReport,
    failure: string,
  ): Promise<void> {
    const { subject, body } = reportNotification({
      project,
      report,
      failure,
      reportPath: reportRef.path,
      executionDirectory: paths.directory,
    });
    try {
      const published = await runtime.notify(subject, body);
      if (!published.ok) {
        deliveryProblems.push(published.fault.message);
      }
    } catch (error) {
      deliveryProblems.push(messageOf(error));
    }
  }

  return {
    async begin(request: ExecutionRequest): Promise<void> {
      await mkdir(directory, { recursive: true });
      await writeRecord(executionFile, {
        request: { projectConfigPath: request.projectConfigPath },
        invocations: 0,
      } satisfies RecoveryExecution);
    },

    async recover(stop: RecoveryStop): Promise<RecoveryOutcome> {
      let execution: RecoveryExecution | null;
      try {
        execution = await readRecord(executionFile, recoveryExecutionDeclaration);
      } catch (error) {
        return attention(`Recovery could not read its execution record: ${messageOf(error)}`);
      }
      if (execution === null) {
        return attention(`The recovery execution record at "${executionFile}" does not exist.`);
      }
      if (execution.invocations >= allowance) {
        return attention(
          `The configured recovery allowance of ${String(allowance)} ` +
            `invocation${allowance === 1 ? '' : 's'} is exhausted.`,
        );
      }
      const invocation = execution.invocations + 1;
      try {
        await writeRecord(executionFile, {
          request: execution.request,
          invocations: invocation,
        } satisfies RecoveryExecution);
      } catch (error) {
        return attention(`Recovery could not record its invocation: ${messageOf(error)}`);
      }

      try {
        await prepareOperationalWorktree(
          path.join(workspace.root, worktreeDirectory),
          settings.environment,
        );
      } catch (error) {
        return attention(
          `The recovery operational workspace could not be prepared: ${messageOf(error)}`,
        );
      }
      const context = recoveryContextText({
        request: execution.request,
        project,
        nexus,
        workflow,
        paths,
        logFile: settings.logFile,
        recoveryDirectory: directory,
        workspace,
        reports: earlierReports(invocation),
        invocation,
        stop,
      });

      publish({ source: 'application', type: 'recovering', data: { reason: stop.failure } });
      publish({
        source: 'application',
        type: 'agent-started',
        data: {
          role: 'recovery',
          operation: 'Recovery',
          profile,
          ...(stop.selection === null ? {} : { task: stop.selection.task }),
        },
      });
      let result: AgentResult;
      try {
        result = await runtime.invoke({
          context,
          workspace,
          onActivity: (activity) => {
            publish({ source: 'application', type: 'agent-activity', data: activity });
          },
        });
      } catch (error) {
        result = { ok: false, fault: { message: messageOf(error) } };
      } finally {
        publish({ source: 'application', type: 'agent-finished', data: null });
      }
      if (!result.ok) {
        return attention(`The recovery invocation failed: ${result.fault.message}`);
      }

      let report: RecoveryReport;
      try {
        report = parseRecoveryReport(result.value.output);
      } catch (error) {
        return attention(`The recovery invocation failed: ${messageOf(error)}`);
      }
      let reportRef: ArtifactRef;
      try {
        await mkdir(executionReports, { recursive: true });
        reportRef = { path: path.join(executionReports, `${String(invocation)}.json`) };
        await writeRecord(reportRef.path, report);
      } catch (error) {
        return attention(`The recovery report could not be saved: ${messageOf(error)}`);
      }
      saved = reportRef;
      publish({
        source: 'application',
        type: 'recovered',
        data: { decision: report.decision.kind, report: reportRef },
      });
      await deliver(reportRef, report, stop.failure);
      return report.decision.kind === 'resume' ? { kind: 'resume' } : attention(report.summary);
    },

    savedReport: () => saved,
    deliveryProblems: () => [...deliveryProblems],
  };
}
