import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentEvent, AgentResult } from '../agent-runtime/index.js';
import type { NotificationAcceptance } from '../adapters/notifications.js';
import type { NexusConfiguration, ProjectConfiguration } from '../configuration/index.js';
import { messageOf, type ArtifactRef, type Result } from '../result.js';
import type { ArtifactDeclaration } from '../task-engine/actions/artifacts.js';
import { completionArtifact } from '../task-engine/actions/complete-task/artifacts.js';
import { deliveryArtifact } from '../task-engine/actions/deliver/artifacts.js';
import { devArtifact } from '../task-engine/actions/develop/artifacts.js';
import { implementationInputDeclaration } from '../task-engine/actions/project/implementation-handoff/artifacts.js';
import { preparedWorkspaceDeclaration } from '../task-engine/actions/prepare-workspace/artifacts.js';
import { readRecord, writeRecord, type RecordDeclaration } from '../task-engine/actions/records.js';
import {
  outstandingReportFeedback,
  recordReportCorrection,
  reportFeedbackContextText,
  reportFeedbackDeclarationText,
  writeReportFeedbackRecord,
  type ReportRejection,
  type ReportScope,
  type RetainedReportFeedback,
} from '../task-engine/actions/report-feedback.js';
import { reviewArtifact } from '../task-engine/actions/review/artifacts.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageResultArtifact,
  stageRoundPlanDeclaration,
} from '../task-engine/actions/preparation/artifacts.js';
import { selectionDeclaration } from '../task-engine/actions/select-task/artifacts.js';
import { parentHandoffDeclaration } from '../task-engine/actions/select-work/artifacts.js';
import { ideaRoundPlanDeclaration } from '../task-engine/actions/start-idea-round/artifacts.js';
import { currentRoundDeclaration } from '../task-engine/actions/start-round/artifacts.js';
import { verificationArtifact } from '../task-engine/actions/verify/artifacts.js';
import type { EngineEvent } from '../task-engine/index.js';
import { beginAgentInvocation, type AgentActivityPublisher } from '../task-engine/index.js';
import type { WorkflowName } from '../configuration/index.js';
import { workspaceRoot, type ExecutionPaths } from './composition.js';
import type { ExecutionRequest } from './index.js';
import type { Workflow } from './workflow.js';
import { prepareOperationalWorktree } from './operational-worktree.js';

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
  summary: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The cause or remaining uncertainty, actions taken, ticket and queue changes, discarded work, and why resumption is ready or human attention is required.',
    ),
  decision: z
    .union([
      z.strictObject({
        kind: z.literal('resume').describe('The normal queue can continue.'),
      }),
      z.strictObject({
        kind: z.literal('needs-attention').describe('The execution cannot continue without help.'),
      }),
    ])
    .describe('Resume only when the normal queue can continue; otherwise needs-attention.'),
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
  /** The selected ticket's Summary field, when the record carried one. */
  readonly summary: string | null;
  readonly workspace: TaskWorkspaceRef;
  /** The parent stage the interrupted selection entered. */
  readonly stage: string;
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
  /** The selected workflow's name and configured definition path. */
  readonly workflowName: WorkflowName;
  readonly workflowPath: string;
  readonly paths: ExecutionPaths;
  /** The execution's event log, which recovery reads to see what happened. */
  readonly logFile: string;
  /** The execution's agent activity directory the recovery invocation's own log lives under. */
  readonly activityDirectory: string;
  /** The environment the operational workspace preparation runs with. */
  readonly environment: Readonly<Record<string, string>>;
  readonly runtime: RecoveryRuntime;
  /** Publishes one progress or agent boundary event to Application's combined stream. */
  readonly publish: (event: EngineEvent) => void;
  /** Records and forwards one attributable activity entry through Application. */
  readonly publishActivity: AgentActivityPublisher;
};

/** The context the recovery agent receives, assembled from the resolved configuration and stop. */
type RecoveryContextSettings = {
  readonly request: RecoveryExecution['request'];
  readonly project: ProjectConfiguration;
  readonly nexus: NexusConfiguration;
  readonly workflow: Workflow;
  readonly workflowPath: string;
  readonly paths: ExecutionPaths;
  readonly logFile: string;
  readonly activityDirectory: string;
  readonly recoveryDirectory: string;
  readonly workspace: TaskWorkspaceRef;
  readonly reports: readonly string[];
  readonly invocation: number;
  readonly stop: RecoveryStop;
  /** The outstanding recovery-report rejections this invocation was supplied. */
  readonly feedback: readonly RetainedReportFeedback<ReportRejection>[];
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
  const execution: RecoveryDeclaration = {
    title: 'Recovery execution record (Application)',
    path: path.join(recoveryDirectory, recoveryExecutionDeclaration.file),
    schema: recoveryExecutionSchema,
  };
  return [
    {
      title: 'Project selection record (SelectWork)',
      path: paths.selectionFile,
      schema: selectionDeclaration.schema,
    },
    {
      title: 'Parent handoff record',
      path: parentHandoffDeclaration.file,
      schema: parentHandoffDeclaration.schema,
    },
    {
      title: 'Prepared workspace record (PrepareWorkspace)',
      path: preparedWorkspaceDeclaration.file,
      schema: preparedWorkspaceDeclaration.schema,
    },
    {
      title: 'Implementation input (HandoffImplementation)',
      path: implementationInputDeclaration.file,
      schema: implementationInputDeclaration.schema,
    },
    {
      title: 'Finite-delivery current round record (StartRound)',
      path: currentRoundDeclaration.file,
      schema: currentRoundDeclaration.schema,
    },
    {
      title: 'Idea refinement round plan (StartIdeaRound)',
      path: path.join('refinement', ideaRoundPlanDeclaration.file),
      schema: ideaRoundPlanDeclaration.schema,
    },
    {
      title: 'Preparation stage round plan (StartStageRound)',
      path: path.join('<stage>', stageRoundPlanDeclaration.file),
      schema: stageRoundPlanDeclaration.schema,
    },
    roundArtifact('Development output (Develop)', devArtifact),
    roundArtifact('Verification output (Verify)', verificationArtifact),
    roundArtifact('Delivery output (Deliver)', deliveryArtifact),
    roundArtifact('Review output (Review)', reviewArtifact),
    roundArtifact('Completion output (CompleteTask)', completionArtifact),
    roundArtifact('Preparation author output (StageAuthor)', stageAuthorArtifact),
    roundArtifact('Preparation evaluation output (StageEvaluator)', stageEvaluationArtifact),
    roundArtifact('Preparation result (StageResult)', stageResultArtifact),
    execution,
  ];
}

/** The complete context text one recovery invocation receives. */
function recoveryContextText(settings: RecoveryContextSettings): string {
  const { nexus, project, workflow, paths, logFile, activityDirectory, stop, request, invocation } =
    settings;
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
      `Selection file: ${paths.selectionFile} (SelectWork's record, JSON matching the selection ` +
        'schema below)',
      `Execution event log: ${logFile} (newline-delimited JSON, one object per received event, ` +
        'each holding its ISO receipt timestamp and the event)',
      `Agent activity logs: ${activityDirectory} (one JSONL file per invocation, named with the ` +
        'agent name, Unix start time and invocation ID)',
      `Recovery directory: ${settings.recoveryDirectory}`,
      `Recovery report feedback: ${path.join(settings.recoveryDirectory, 'report-feedback')} ` +
        '(immutable rejection and correction records of earlier recovery reports)',
      'Saved reports of this execution: ' +
        (settings.reports.length === 0 ? 'none yet' : settings.reports.join(', ')),
      `Your operational workspace: ${settings.workspace.root} (worktree/ is your working ` +
        'directory and is outside every task workspace)',
    ].join('\n'),
    [
      'Producer-owned record and artifact declarations',
      'Paths are relative to the shared issue workspace root unless absolute. Finite delivery ' +
        'uses the root worktree/, artifacts/<roundNumber>/ and state/. Idea refinement uses the ' +
        'refinement/ area with artifacts/submissions/<submission>/cycles/<cycle>/. The evaluated ' +
        'preparation stages share the root worktree/ and each keeps its own state/ and ' +
        'artifacts/<roundNumber>/ under requirements/, ux/, prototype/ and architecture/. The ' +
        'parent/ area keeps the handoff record and, under an implementation issue, its ' +
        'implementation input. A prepared workspace record whose repositoryWorkspace names ' +
        'another issue root borrows that issue\u2019s checkout; it is not owned by the selected ' +
        'issue.',
      ...recoveryDeclarations(settings).map(declarationText),
    ].join('\n\n'),
    [
      'Retained issue workspace',
      selection === null
        ? 'The selection record was absent or unreadable, so no retained workspace is known.'
        : `Issue ${selection.task} retained the stage "${selection.stage}" at ` +
          `${selection.workspace.root}.`,
      `Issue workspaces live under ${taskWorkspaceRoot}/<issue>/ with the fixed layout of the ` +
        'current workflow areas: root worktree/, artifacts/<roundNumber>/ and state/ for finite ' +
        'delivery, refinement/ for idea refinement, one shared root worktree/ with the four ' +
        'preparation areas, and parent/ for the source handoff and implementation input. A first ' +
        'implementation can use another issue\u2019s preparation repository; preserve that donor ' +
        'checkout and its accepted history, and confirm that a target you delete belongs to the ' +
        'interrupted issue under this root.',
    ].join('\n'),
    [
      'Selected workflow',
      'Name: project',
      `Module: ${settings.workflowPath}`,
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
      'Return the response object only; do not write the report file. Application parses your ' +
        'response, saves the report and publishes it.',
    ].join('\n'),
    [
      'Report rejection and correction declarations',
      'Before repairing or replacing a rejected report of another role, preserve its available ' +
        'output and exact rejection reason with the declarations below. Write each immutable ' +
        'record under its owning area (a preparation stage area, refinement/, or an issue root) ' +
        'as report-feedback/<record-id>.json with a unique record ID; never write report-feedback ' +
        'inside your own operational workspace.',
      'A record scope names the configured project, the work item (the selection task key), the ' +
        'absolute owning area, and the report responsibility: a preparation stage report uses ' +
        'role "<stage>-author" with report kind "stage-author" or "<stage>-evaluator" with ' +
        '"stage-evaluation"; idea refinement uses the invoking role (researcher, project-guide, ' +
        'challenger, idea-editor) with "research", "project-guidance", "challenge", ' +
        '"idea-framing" or "idea-editor-turn"; finite delivery uses "developer"/"development" or ' +
        '"reviewer"/"review".',
      reportFeedbackDeclarationText(),
    ].join('\n\n'),
    ...reportFeedbackContextText(settings.feedback),
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
      const scope: ReportScope = {
        project: project.taskSource.project,
        // A recovery report answers for the whole project execution, not one selected work item:
        // its responsibility must match across selection clears and reselection, so the stable
        // project identity is the work the feedback belongs to.
        workId: project.taskSource.project,
        area: directory,
        role: 'recovery',
        reportKind: 'recovery-report',
      };
      let feedback: Awaited<ReturnType<typeof outstandingReportFeedback>>;
      try {
        feedback = await outstandingReportFeedback({ areaRoot: directory, scope });
      } catch (error) {
        // Missing or unusable evidence is an explicit error, never an empty feedback set: an
        // invocation that cannot receive its required correction must not run unawares.
        return attention(
          `Recovery could not read its retained report feedback: ${messageOf(error)}`,
        );
      }
      const context = recoveryContextText({
        request: execution.request,
        project,
        nexus,
        workflow,
        workflowPath: settings.workflowPath,
        paths,
        logFile: settings.logFile,
        activityDirectory: settings.activityDirectory,
        recoveryDirectory: directory,
        workspace,
        reports: earlierReports(invocation),
        invocation,
        stop,
        feedback,
      });

      publish({ source: 'application', type: 'recovering', data: { reason: stop.failure } });
      const agentInvocation = beginAgentInvocation({
        agentName: 'recovery',
        operation: 'Recovery',
        profile,
        task: stop.selection === null ? null : stop.selection.task,
        summary: stop.selection === null ? null : stop.selection.summary,
        directory: settings.activityDirectory,
        publish: settings.publish,
        publishActivity: settings.publishActivity,
      });
      /** One recovery invocation; a provider failure becomes the invocation's fault result. */
      const invoke = async (): Promise<AgentResult> => {
        try {
          return await runtime.invoke({
            context,
            workspace,
            onActivity: (activity) => {
              agentInvocation.activity(activity);
            },
          });
        } catch (error) {
          return { ok: false, fault: { message: messageOf(error) } };
        }
      };
      const result = await invoke();
      agentInvocation.finish(
        result.ok ? { outcome: 'finished' } : { outcome: 'failed', reason: result.fault.message },
      );
      if (!result.ok) {
        return attention(`The recovery invocation failed: ${result.fault.message}`);
      }

      let report: RecoveryReport;
      try {
        report = parseRecoveryReport(result.value.output);
      } catch (error) {
        const reason = `The recovery invocation failed: ${messageOf(error)}`;
        try {
          // The malformed response stays rejected: retain its exact bytes, the violated format
          // rule and the invocation attribution under the stable project recovery area.
          await writeReportFeedbackRecord(directory, {
            kind: 'rejection',
            scope,
            invocationId: agentInvocation.identity.invocationId,
            operation: 'Recovery',
            profile,
            context:
              `Recovery invocation ${String(invocation)} of project ` +
              `${project.taskSource.project}, stopped because: ${stop.failure}`,
            source: null,
            output: result.value.output,
            reason,
            report: null,
            assignedReport: null,
          });
        } catch (writeError) {
          // A failed evidence write reports both the original rejection and the persistence
          // failure, and grants no acceptance.
          return attention(
            `${reason} The rejection evidence could not be saved: ${messageOf(writeError)}`,
          );
        }
        return attention(reason);
      }
      let reportRef: ArtifactRef;
      try {
        await mkdir(executionReports, { recursive: true });
        reportRef = { path: path.join(executionReports, `${String(invocation)}.json`) };
        await writeRecord(reportRef.path, report);
      } catch (error) {
        return attention(`The recovery report could not be saved: ${messageOf(error)}`);
      }
      if (feedback.length > 0) {
        try {
          // The owner validated and saved the usable replacement; recording its complete identity
          // retires exactly the rejections this invocation was supplied, preserving their history.
          await recordReportCorrection({
            areaRoot: directory,
            scope,
            rejections: feedback.map((entry) => ({ path: entry.path })),
            artifact: reportRef,
            content: report,
            invocationId: agentInvocation.identity.invocationId,
          });
        } catch (error) {
          return attention(
            `The recovery report was saved, but its correction evidence could not be recorded: ` +
              messageOf(error),
          );
        }
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
