import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentEvent, AgentResult } from '../agent-runtime/index.js';
import type { NotificationAcceptance } from '../adapters/notifications.js';
import type { NexusConfiguration, ProjectConfiguration } from '../configuration/index.js';
import { messageOf, type ArtifactRef, type Result } from '../result.js';
import {
  actionOwnedRecordsText,
  assignReportPath,
  openingNarrativeParagraph,
  parseAgentReport,
  readAssignedReport,
  readBoundReport,
  responseFormatText,
  retainedReportBindingFields,
} from '../task-engine/actions/agent-reports.js';
import type { ArtifactDeclaration } from '../task-engine/actions/artifacts.js';
import { completionArtifact } from '../task-engine/actions/complete-task/artifacts.js';
import { deliveryArtifact } from '../task-engine/actions/deliver/artifacts.js';
import { devArtifact } from '../task-engine/actions/develop/artifacts.js';
import { implementationInputDeclaration } from '../task-engine/actions/project/implementation-handoff/artifacts.js';
import { preparedWorkspaceDeclaration } from '../task-engine/actions/prepare-workspace/artifacts.js';
import { readRecord, writeRecord, type RecordDeclaration } from '../task-engine/actions/records.js';
import {
  clearPendingValidationError,
  readPendingValidationError,
  rejectReport,
  validationErrorContextText,
  type PendingValidationError,
  type ReportScope,
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
import { workspaceRoot, type ExecutionPaths } from './composition.js';
import type { ExecutionRequest } from './index.js';
import type { Workflow } from './workflow.js';
import { prepareOperationalWorktree } from './operational-worktree.js';

/**
 * Application's recovery boundary and lifecycle. Application hands one stopped work invocation to
 * this module: it consumes the configured allowance, prepares the complete recovery context in a
 * separate operational workspace, runs the configured recovery profile, validates the returned
 * decision and its assigned Markdown report, saves RecoveryReport with the observed identity and
 * report binding, publishes the Markdown report and applies the decision. Recovery itself judges
 * and performs the repair; Application only consumes the decision. See docs/application.md and
 * docs/agent-runtime/recovery-role.md.
 */

/** The task workspace reference from the Workspace design, when a selection was readable. */
export type TaskWorkspaceRef = { readonly root: string };

/** The recovery invocation's decision: resume the queue or stop for operator attention. */
export type RecoveryDecision = { readonly kind: 'resume' } | { readonly kind: 'needs-attention' };

/** The decision one recovery invocation returns; every narrative belongs in its Markdown report. */
const recoveryDecisionSchema = z
  .union([
    z.strictObject({
      kind: z.literal('resume').describe('The normal queue can continue.'),
    }),
    z.strictObject({
      kind: z.literal('needs-attention').describe('The execution cannot continue without help.'),
    }),
  ])
  .describe('Resume only when the normal queue can continue; otherwise needs-attention.');

/** The response format requested from the recovery agent and parsed from its output. */
export const recoveryResponseSchema = z.strictObject({
  decision: recoveryDecisionSchema,
});

export type RecoveryResponse = z.infer<typeof recoveryResponseSchema>;

/** The execution request a saved recovery outcome answers, as Application stores it. */
export const recoveryRequestSchema = z.strictObject({
  projectConfigPath: z.string().trim().min(1),
  workflow: z.string().trim().min(1),
});

/**
 * Application's saved recovery outcome: the decision, the request it answered, the observed
 * work/role/profile/attempt identity and the assigned Markdown report binding.
 */
export const recoveryReportSchema = z.strictObject({
  project: z.string().trim().min(1).describe('The configured project this recovery answered for.'),
  workId: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe('The selected work item, or null when no item was selected.'),
  role: z.literal('recovery'),
  profile: z.string().trim().min(1).describe('The recovery profile that produced this outcome.'),
  request: recoveryRequestSchema,
  recoveryAttempt: z.number().int().positive().describe('The recovery allowance this consumed.'),
  decision: recoveryDecisionSchema,
  ...retainedReportBindingFields,
});

/** The recovery report, from the Application provided interface. */
export type RecoveryReport = z.infer<typeof recoveryReportSchema>;

/**
 * A former combined recovery report from before the Markdown separation: its summary stays
 * readable history without a report path or a new Markdown requirement imposed retroactively.
 */
export const legacyRecoveryReportSchema = z.strictObject({
  summary: z.string().trim().min(1),
  decision: recoveryDecisionSchema,
});

export type LegacyRecoveryReport = z.infer<typeof legacyRecoveryReportSchema>;

/**
 * The producer-owned reader: a current bound outcome, or a former combined report. A record
 * carrying any binding field must satisfy the current schema; a damaged new record never falls
 * back to the former shape.
 */
export const retainedRecoveryReportSchema = z.union([
  recoveryReportSchema,
  legacyRecoveryReportSchema,
]);

export type RetainedRecoveryReport = z.infer<typeof retainedRecoveryReportSchema>;

/** True when one retained recovery report carries the current report binding. */
export function isBoundRecoveryReport(report: RetainedRecoveryReport): report is RecoveryReport {
  return 'report' in report;
}

/**
 * The readable text of one retained recovery report: the validated Markdown of a current outcome,
 * or the former combined summary. Legacy output remains readable history and never authorizes a
 * different execution; only the allowance and the current invocation's decision do.
 */
export async function recoveryReportText(report: RetainedRecoveryReport): Promise<string> {
  return isBoundRecoveryReport(report)
    ? (await readBoundReport(report, 'Recovery report')).text
    : report.summary;
}

/** Parse the agent's output as its decision response; unusable output is an error naming it. */
export function parseRecoveryResponse(output: string): RecoveryResponse {
  return parseAgentReport(output, recoveryResponseSchema, 'recovery agent');
}

/**
 * Application's recovery execution record: the retained execution request, the invocations this
 * execution has consumed and the saved outcomes of those invocations, so an invocation receives
 * its predecessors' readable reports and the allowance persists across worker restarts.
 */
export const recoveryExecutionSchema = z.strictObject({
  request: recoveryRequestSchema,
  invocations: z.number().int().nonnegative(),
  reports: z.array(z.string().trim().min(1)).default([]),
});

type RecoveryExecution = z.infer<typeof recoveryExecutionSchema>;

const recoveryExecutionDeclaration = {
  file: 'execution.json',
  schema: recoveryExecutionSchema,
} satisfies RecordDeclaration<typeof recoveryExecutionSchema>;

/** Application's recovery records live in this directory under the queue execution directory. */
const recoveryDirectoryName = 'recovery';

/** The assigned Markdown report name of one recovery invocation. */
const recoveryReportName = 'recovery';

/** The saved outcome file of one recovery invocation beside its Markdown report. */
const recoveryOutcomeName = 'recovery.json';

/** The stable work partition recovery uses when no work item was selected. */
export const noSelectedWorkId = 'no-selected-work';

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
  /** The assigned Markdown report the agent writes before returning its decision. */
  readonly reportPath: string;
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
  /** The selected workflow's configured definition path. */
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
  /** The Markdown path this invocation must write before returning its decision. */
  readonly assignedReport: string;
  /** The action-owned outcome record this invocation must leave to Application. */
  readonly outcomeFile: string;
  readonly stop: RecoveryStop;
  /** The pending validation error of this recovery report responsibility, or null. */
  readonly feedback: PendingValidationError | null;
  /**
   * A pending validation error retained under the former project-wide recovery responsibility,
   * whose original work item cannot be established, or null.
   */
  readonly formerFeedback: PendingValidationError | null;
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

/**
 * The earlier saved recovery outcomes of this execution as readable context: each current bound
 * report supplies its validated Markdown, a former combined report supplies its summary, and an
 * unreadable one states its path and failure without blocking the invocation that may repair it.
 */
async function earlierReportsSection(files: readonly string[]): Promise<string> {
  if (files.length === 0) {
    return 'Saved reports of this execution: none yet.';
  }
  const lines = [
    'Saved reports of this execution (readable history; only your own invocation decides):',
  ];
  for (const file of files) {
    try {
      const report = await readRecord(file, {
        file,
        schema: retainedRecoveryReportSchema,
      });
      if (report === null) {
        lines.push(`- ${file}: the saved outcome is no longer present.`);
        continue;
      }
      const text = await recoveryReportText(report);
      const attribution = isBoundRecoveryReport(report)
        ? `attempt ${String(report.recoveryAttempt)}, work ${report.workId ?? 'none selected'}, ` +
          `profile ${report.profile}, decision ${report.decision.kind}`
        : `former combined report, decision ${report.decision.kind}`;
      lines.push(`- ${file} (${attribution}):`, text);
    } catch (error) {
      lines.push(`- ${file}: the saved outcome could not be read: ${messageOf(error)}`);
    }
  }
  return lines.join('\n');
}

/** The complete context text one recovery invocation receives. */
async function recoveryContextText(settings: RecoveryContextSettings): Promise<string> {
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
    [
      'Original execution request',
      `Project configuration file: ${request.projectConfigPath}`,
      `Workflow: ${request.workflow}`,
    ].join('\n'),
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
        '(readable validation-error history plus this work item\u2019s pending context, when one is ' +
        'retained)',
      `Your operational workspace: ${settings.workspace.root} (worktree/ is your working ` +
        'directory and is outside every task workspace)',
    ].join('\n'),
    await earlierReportsSection(settings.reports),
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
      responseFormatText(recoveryResponseSchema),
      'Use {"decision":{"kind":"needs-attention"}} when the execution cannot continue. ' +
        'Application saves and publishes the report and restarts the worker only after a resume ' +
        'decision.',
      `Assigned Markdown report: ${settings.assignedReport}`,
      'Write your complete recovery report to that path before returning: the cause or remaining ' +
        'uncertainty, the actions you took, the ticket and queue changes, any discarded work and ' +
        'why resumption is ready or human attention is required. Do not return narrative or ' +
        'observed identity metadata in the response.',
      actionOwnedRecordsText([settings.outcomeFile]),
    ].join('\n\n'),
    ...validationErrorContextText(settings.feedback),
    ...(settings.formerFeedback === null
      ? []
      : [
          [
            'A legacy recovery diagnostic retained under the former project-wide recovery ' +
              'responsibility follows. Its original work item cannot be established from the ' +
              'retained record, so reconcile it explicitly against this execution instead of ' +
              'assuming it belongs to the currently selected work item. A validated saved ' +
              'replacement retires it together with the current pending context.',
          ].join('\n'),
          ...validationErrorContextText(settings.formerFeedback),
        ]),
  ].join('\n\n');
}

/**
 * The subject and body Application publishes for one saved report: the observed identity and
 * decision, then the associated Markdown recovery report itself. Outcome JSON is never the
 * narrative.
 */
function reportNotification(settings: {
  readonly project: ProjectConfiguration;
  readonly report: RecoveryReport;
  readonly markdown: string;
  readonly failure: string;
  readonly reportPath: string;
  readonly executionDirectory: string;
}): { readonly subject: string; readonly body: string } {
  const decision = settings.report.decision.kind;
  const identity =
    `project ${settings.report.project}, ` +
    `work ${settings.report.workId ?? 'no selected work item'}, role recovery, ` +
    `profile ${settings.report.profile}, attempt ${String(settings.report.recoveryAttempt)}, ` +
    `invocation ${settings.report.invocationId}`;
  return {
    subject:
      `Nexus recovery report (${settings.project.taskSource.project}): ` +
      (decision === 'resume' ? 'resume' : 'needs attention'),
    body: [
      `The queue execution for project ${settings.project.taskSource.project} stopped and the ` +
        'recovery agent reported.',
      `Execution directory: ${settings.executionDirectory}`,
      `Decision: ${decision}`,
      `Recovery identity: ${identity}`,
      '',
      'Failure:',
      settings.failure,
      '',
      'Report:',
      settings.markdown,
      '',
      `Saved outcome: ${settings.reportPath}`,
    ].join('\n'),
  };
}

/** Create the recovery lifecycle of one execution over resolved configuration. */
export function createRecovery(settings: RecoverySettings): Recovery {
  const { nexus, project, workflow, paths, runtime, publish } = settings;
  const directory = path.join(paths.directory, recoveryDirectoryName);
  const executionFile = path.join(directory, recoveryExecutionDeclaration.file);
  const workspace: TaskWorkspaceRef = { root: path.join(directory, workspaceDirectoryName) };
  const profile = nexus.executionPolicy.recoveryProfile;
  const allowance = nexus.executionPolicy.maxRecoveryAttempts;
  const deliveryProblems: string[] = [];
  let saved: ArtifactRef | null = null;

  const attention = (reason: string): RecoveryOutcome => ({ kind: 'attention', reason });

  /** Publish the saved report; a delivery failure is recorded separately and never repeated. */
  async function deliver(
    reportRef: ArtifactRef,
    report: RecoveryReport,
    markdown: string,
    failure: string,
  ): Promise<void> {
    const { subject, body } = reportNotification({
      project,
      report,
      markdown,
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
        request: { projectConfigPath: request.projectConfigPath, workflow: request.workflow },
        invocations: 0,
        reports: [],
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
          reports: execution.reports,
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
        // Recovery partitions its context by selected work, with a separate no-selected-work
        // location, so unrelated work items never inherit each other's errors.
        workId: stop.selection === null ? noSelectedWorkId : stop.selection.task,
        area: directory,
        role: 'recovery',
        reportKind: 'recovery-report',
      };
      // Before HARN-125 recovery retained one context for the whole project execution under the
      // project identity as its work, so this former responsibility must stay reachable: it is
      // read by its own recorded attribution and supplied with the uncertainty stated, never
      // silently mapped onto the currently selected work item.
      const formerProjectWideScope: ReportScope = {
        ...scope,
        workId: project.taskSource.project,
      };
      let feedback: PendingValidationError | null;
      let formerFeedback: PendingValidationError | null = null;
      try {
        feedback = await readPendingValidationError({ areaRoot: directory, scope });
        if (formerProjectWideScope.workId !== scope.workId) {
          formerFeedback = await readPendingValidationError({
            areaRoot: directory,
            scope: formerProjectWideScope,
          });
        }
      } catch (error) {
        // Missing or unusable evidence is an explicit error, never an empty context: an
        // invocation that cannot receive its required diagnosis must not run unawares.
        return attention(
          `Recovery could not read its pending validation-error context: ${messageOf(error)}`,
        );
      }
      const invocationId = randomUUID();
      // One directory per invocation, named by the invocation identity, keeps a later execute
      // call from overwriting reports earlier ExecutionResults point to.
      const assignedReport = await assignReportPath(directory, invocationId, recoveryReportName);
      const outcomeFile = path.join(path.dirname(assignedReport.path), recoveryOutcomeName);
      const context = await recoveryContextText({
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
        reports: execution.reports,
        invocation,
        assignedReport: assignedReport.path,
        outcomeFile,
        stop,
        feedback,
        formerFeedback,
      });

      publish({ source: 'application', type: 'recovering', data: { reason: stop.failure } });
      const agentInvocation = beginAgentInvocation({
        agentName: 'recovery',
        operation: 'Recovery',
        invocationId,
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
            reportPath: assignedReport.path,
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

      /**
       * Reject one unusable invocation with its exact returned output and available Markdown
       * retained under the stable project recovery area; the execution needs attention.
       */
      const rejected = async (reason: string): Promise<RecoveryOutcome> => {
        let failure = reason;
        try {
          await rejectReport({
            areaRoot: directory,
            scope,
            invocationId,
            operation: 'Recovery',
            profile,
            context:
              `Recovery invocation ${String(invocation)} of project ` +
              `${project.taskSource.project}, stopped because: ${stop.failure}`,
            source: null,
            output: result.value.output,
            assignedReport,
            reason,
          });
        } catch (error) {
          // A failed evidence write reports both the original rejection and the persistence
          // failure, and grants no acceptance.
          failure = messageOf(error);
        }
        return attention(failure);
      };
      let response: RecoveryResponse;
      try {
        response = parseRecoveryResponse(result.value.output);
      } catch (error) {
        return await rejected(`The recovery invocation failed: ${messageOf(error)}`);
      }
      let reportText: string;
      try {
        reportText = (await readAssignedReport(assignedReport.path, 'Assigned recovery report'))
          .text;
      } catch (error) {
        return await rejected(`The recovery invocation failed: ${messageOf(error)}`);
      }
      const report: RecoveryReport = {
        project: project.taskSource.project,
        workId: stop.selection === null ? null : stop.selection.task,
        role: 'recovery',
        profile,
        request: execution.request,
        recoveryAttempt: invocation,
        decision: response.decision,
        report: assignedReport,
        invocationId,
      };
      try {
        await writeRecord(outcomeFile, report);
      } catch (error) {
        return attention(`The recovery outcome could not be saved: ${messageOf(error)}`);
      }
      try {
        // Keep the saved outcome associated with this execution's request and its predecessors.
        await writeRecord(executionFile, {
          request: execution.request,
          invocations: invocation,
          reports: [...execution.reports, outcomeFile],
        } satisfies RecoveryExecution);
      } catch (error) {
        return attention(
          `The recovery outcome was saved, but its report association could not be recorded: ` +
            messageOf(error),
        );
      }
      try {
        // The owner validated and saved the usable replacement; its pending validation-error
        // context is cleared while the readable history stays. A former project-wide diagnostic
        // supplied to this invocation is retired with it, so a resolved error cannot reach a
        // later selection that never inherited it.
        await clearPendingValidationError({ areaRoot: directory, scope });
        if (formerFeedback !== null) {
          await clearPendingValidationError({ areaRoot: directory, scope: formerProjectWideScope });
        }
      } catch (error) {
        return attention(
          `The recovery outcome was saved, but its pending validation-error context could not be ` +
            `cleared: ${messageOf(error)}`,
        );
      }
      saved = { path: outcomeFile };
      publish({
        source: 'application',
        type: 'recovered',
        data: { decision: report.decision.kind, report: saved },
      });
      await deliver(saved, report, reportText, stop.failure);
      if (report.decision.kind === 'resume') {
        return { kind: 'resume' };
      }
      return attention(
        openingNarrativeParagraph(reportText) ??
          `The recovery invocation returned needs-attention; the saved report is at ` +
            `${outcomeFile}.`,
      );
    },

    savedReport: () => saved,
    deliveryProblems: () => [...deliveryProblems],
  };
}
