import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { IdeaRole } from '../../agent-runtime/index.js';
import type { ArtifactRef } from '../../result.js';
import { messageOf } from '../../result.js';
import { actionOutcomeEvent, type AgentRoleRunner, type EventPublisher } from '../index.js';
import type { ArtifactContent, ArtifactDeclaration } from './artifacts.js';
import { challengerArtifact } from './challenger/artifacts.js';
import { readDocumentText } from './documents.js';
import {
  framingArtifact,
  editorHelpArtifact,
  editorResponseArtifact,
  readRefinedIdeaRevision,
  refinedIdeaArtifact,
  retainedBriefArtifactPath,
  type RefinedIdeaRead,
} from './idea-editor/artifacts.js';
import {
  ideaCycleDirectory,
  ideaSubmissionArtifactFile,
  ideaSubmissionInputFile,
  listIdeaCycles,
  listIdeaSubmissions,
  readCycleArtifact,
} from './idea-storage.js';
import { projectGuideArtifact, projectGuideFollowUpArtifact } from './project-guide/artifacts.js';
import { decisionArtifact } from './publish-decision/artifacts.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  recordReportCorrection,
  rejectReport,
  rejectUnusableRecord,
  reportFeedbackContextText,
  type ReportRejection,
  type ReportScope,
  type RetainedReportFeedback,
} from './report-feedback.js';
import { researchArtifact, researchFollowUpArtifact } from './researcher/artifacts.js';
import { issueSummary } from './source.js';
import type { IdeaInput } from './select-idea/artifacts.js';
import type { IdeaRoundPlan } from './start-idea-round/artifacts.js';

/**
 * The context every idea refinement role receives: the current captured author input as the
 * authoritative proposal, the prepared project worktree, the retained workspace history as
 * readable references and the connected project's root AGENTS.md when present. The shared texts
 * below have this one runtime home; every invocation carries each of them once, ahead of its
 * role-specific context.
 */

/**
 * The one shared definition of an idea, supplied to every idea refinement role invocation ahead of
 * its role-specific context. The specification owns the wording, so no role depends on opening it
 * and no role prompt repeats the definition.
 */
export const ideaDefinitionText = [
  'Idea definition (shared by every idea refinement role):',
  'An idea describes a desirable change in software, why it matters, and the principle behind it\u2014without yet committing to implementation.',
].join('\n');

/**
 * The shared idea-stage guidance supplied to every idea refinement role invocation with the
 * definition. It keeps the conversation on the idea as the author proposed it, keeps the project's
 * current design open to change, and separates helpful suggestions from concerns that prevent
 * recommending pursuit.
 */
export const ideaStageGuidanceText = [
  'Idea stage (shared by every idea refinement role): captured author text and human clarifications',
  'govern what is proposed, and comment authorship is retained. Previous agent publications,',
  'interpretations and approvals are revisable history, not author instructions; the editor\u2019s',
  'framing is also an interpretation, not a replacement for the author\u2019s input. Ask the author',
  'only when a material ambiguity cannot reasonably be resolved. Distinguish the project\u2019s',
  'enduring purpose and actual constraints from current design choices.',
  'An idea may propose changing those choices, and a conflict with today\u2019s architecture alone',
  'is not grounds to narrow or reject an architectural idea. Apply project guidance at the idea',
  'stage; avoiding premature optimization does not prohibit exploring a performance idea before',
  'measurement. Ask how a contribution improves the idea or shows why it should not proceed,',
  'separate helpful suggestions from concerns that prevent recommending pursuit, and explain the',
  'consequence for value, project fit or feasibility of any blocker. A preferable alternative',
  'alone is not a veto, and uncertainty alone does not imply infeasibility.',
].join('\n');

/**
 * The one shared communication rule supplied to every idea refinement role invocation with the
 * definition and stage guidance. Each role makes short, plain, concrete observations, questions,
 * answers or corrections addressed to the next role, accepts valid rebuttals and leaves rhetorical
 * and implementation prose out.
 */
export const ideaCommunicationText = [
  'Idea communication (shared by every idea refinement role): make short, concrete observations,',
  'questions, answers or corrections, and address the other role\u2019s point directly. Accept valid',
  'rebuttals and withdraw mistaken concerns. Use relevant evidence for consequential factual',
  'claims, but do not fact-check incidental wording or demand implementation details to approve an',
  'idea. Avoid rhetorical language and repeated reports; give only the few points that bear on the',
  'decision to pursue the idea.',
].join('\n');

/**
 * The one shared evidence and attribution rule supplied to every idea refinement role invocation
 * with the definition and stage guidance. It keeps captured author input, external sources,
 * project facts and agent inference distinct through contributions, synthesis and assessment, and
 * preserves a claim's consequential qualifications instead of strengthening it beyond its source.
 */
export const ideaAttributionText = [
  'Idea evidence and attribution (shared by every idea refinement role): distinguish captured',
  'author input, external sources, project facts and agent inference throughout contributions,',
  'synthesis and assessment. A source does not become the author\u2019s own work merely because it',
  'is relevant or was found in earlier material. Preserve consequential qualifications:',
  'vendor-reported results are not local measurements, and a search that found no example does not',
  'establish that none exists. Check the supporting source before strengthening a claim; otherwise',
  'retain the qualification or omit the unsupported claim.',
].join('\n');

/**
 * The one shared source-scope rule supplied to every idea refinement role invocation with the
 * definition and stage guidance. Project context comes from the supplied connected worktree, its
 * Git history, the supplied issue artifacts and the sources the author explicitly provided;
 * missing project evidence permits a stated uncertainty, not a wider filesystem search.
 */
export const ideaSourceScopeText = [
  'Idea source scope (shared by every idea refinement role): use the supplied connected worktree',
  'and its Git history, the supplied issue-artifact references, and the sources the author',
  'explicitly provided. Do not search home directories, other checkouts, provider session history,',
  'host configuration or operational investigation logs for additional project context; an',
  'encountered path or an agent\u2019s historical reference does not expand this scope. Public web',
  'research remains available for relevant external evidence. Ordinary provider and tool setup',
  'instructions are not evidence about the project or author. Missing project evidence permits a',
  'stated uncertainty, not a wider filesystem search.',
].join('\n');

/** The worktree directory under a refinement area (Workspace design). */
const worktreeDirectory = 'worktree';

/**
 * The retained cycle artifacts the history lists, with the label each history line carries and the
 * role that owns it. The paths earlier implementations wrote are listed too, so their artifacts
 * stay readable history without being rewritten.
 */
const cycleHistory: readonly {
  readonly relative: string;
  readonly label: string;
  readonly role: IdeaRole;
}[] = [
  { relative: framingArtifact.pathFromArtifactsRoot, label: 'framing', role: 'idea-editor' },
  {
    relative: refinedIdeaArtifact.pathFromArtifactsRoot,
    label: 'refined idea revision',
    role: 'idea-editor',
  },
  {
    relative: editorResponseArtifact.pathFromArtifactsRoot,
    label: 'editor response',
    role: 'idea-editor',
  },
  {
    relative: editorHelpArtifact.pathFromArtifactsRoot,
    label: 'focused help request',
    role: 'idea-editor',
  },
  { relative: researchArtifact.pathFromArtifactsRoot, label: 'research', role: 'researcher' },
  {
    relative: researchFollowUpArtifact.pathFromArtifactsRoot,
    label: 'focused research',
    role: 'researcher',
  },
  {
    relative: projectGuideArtifact.pathFromArtifactsRoot,
    label: 'project guidance',
    role: 'project-guide',
  },
  {
    relative: projectGuideFollowUpArtifact.pathFromArtifactsRoot,
    label: 'focused project guidance',
    role: 'project-guide',
  },
  {
    relative: challengerArtifact.pathFromArtifactsRoot,
    label: 'challenger result',
    role: 'challenger',
  },
  // Artifacts retained from earlier implementations remain readable history.
  { relative: retainedBriefArtifactPath, label: 'refined idea revision', role: 'idea-editor' },
  { relative: 'purpose.json', label: 'purpose assessment', role: 'project-guide' },
  { relative: 'research.json', label: 'research report', role: 'researcher' },
  { relative: 'council/purpose.json', label: 'council result', role: 'challenger' },
  { relative: 'council/evidence.json', label: 'council result', role: 'challenger' },
  { relative: 'council/simplicity.json', label: 'council result', role: 'challenger' },
];

/**
 * The retained workspace history as readable references: every submission's captured author input
 * and every cycle's artifacts, in history order. References are for selective reading; roles never
 * rewrite them and open only the artifacts that bear on their current decision.
 */
export async function retainedHistoryText(
  root: string,
  plan: IdeaRoundPlan,
  options: { readonly omitCurrentCycleOf: IdeaRole | null },
): Promise<string> {
  const submissions = await listIdeaSubmissions(root);
  if (submissions.length === 0) {
    return 'Retained workspace history: none yet.';
  }
  const lines = [
    'Retained workspace history (the author\u2019s earlier submissions, the editor\u2019s framing and',
    'responses, refined idea revisions, contributions and Challenger results). Read it selectively:',
    'open only the artifacts that bear on your current decision, and use the latest refined idea\u2019s',
    'cumulative changeSummary to understand what refinement has already changed:',
  ];
  for (const submission of submissions) {
    lines.push(`- Submission ${String(submission)}:`);
    lines.push(`  - captured idea input: ${ideaSubmissionInputFile(root, submission)}`);
    for (const cycle of await listIdeaCycles(root, submission)) {
      const cycleRoot = ideaCycleDirectory(root, submission, cycle);
      for (const entry of cycleHistory) {
        if (
          options.omitCurrentCycleOf === entry.role &&
          submission === plan.submission &&
          cycle === plan.cycle
        ) {
          continue;
        }
        const file = path.join(cycleRoot, entry.relative);
        if ((await readDocumentText(file, 'Artifact')) === null) {
          continue;
        }
        lines.push(`  - cycle ${String(cycle)} ${entry.label}: ${file}`);
      }
    }
    // The decision is a submission-level artifact, not a cycle-level one.
    if (
      (await readDocumentText(
        ideaSubmissionArtifactFile(root, submission, decisionArtifact),
        'Artifact',
      )) !== null
    ) {
      lines.push(
        `  - decision record: ${ideaSubmissionArtifactFile(root, submission, decisionArtifact)}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * The current captured idea as invocation context. The captured input is authoritative for what
 * the author now proposes; the worktree is where the connected project is read. The current
 * framing or refined idea revision is supplied with it directly, and the retained history keeps
 * the rest readable by reference.
 */
export async function capturedIdeaText(
  root: string,
  plan: IdeaRoundPlan,
  input: IdeaInput,
): Promise<string> {
  const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
  const framing = await readDocumentText(
    path.join(cycleRoot, framingArtifact.pathFromArtifactsRoot),
    'Artifact',
  );
  const revision = await readRetainedRefinedIdea({
    root,
    workId: input.taskKey,
    plan,
    submission: plan.submission,
    cycle: plan.cycle,
    context:
      `Reading the refined idea revision in force for submission ${String(plan.submission)} ` +
      `cycle ${String(plan.cycle)} of idea ${input.taskKey}.`,
  });
  const parentInput = input.parentInput;
  const correction =
    parentInput === undefined ||
    (parentInput.question === null && parentInput.returnFinding === null)
      ? null
      : [
          'Retained parent correction for this selection (it governs what this refinement must ' +
            'address):',
          ...(parentInput.returnFinding === null
            ? []
            : [
                `The ${parentInput.returnFinding.from} stage returned this idea for correction: ` +
                  parentInput.returnFinding.problem,
                `Consequence: ${parentInput.returnFinding.consequence}`,
                `Required correction: ${parentInput.returnFinding.correction}`,
              ]),
          ...(parentInput.question === null
            ? []
            : [`The retained human question is: ${parentInput.question}`]),
        ].join('\n');
  return [
    `Current captured idea: ${input.taskKey}`,
    'The captured input below is authoritative for what the author now proposes; earlier',
    'submissions, refined ideas and contributions are history, not the current proposal.',
    JSON.stringify({ issue: input.issue, conversation: input.conversation }, null, 2),
    ...(framing === null ? [] : [`The editor\u2019s framing of this submission:\n${framing}`]),
    ...(revision === null
      ? []
      : [
          `The refined idea revision in force (${revision.path}, revision ` +
            `${String(revision.value.revision)}):\n${JSON.stringify(revision.value, null, 2)}`,
        ]),
    `Captured input artifact: ${ideaSubmissionInputFile(root, plan.submission)}`,
    ...(correction === null ? [] : [correction]),
    `Connected project worktree: ${path.join(root, worktreeDirectory)}`,
  ].join('\n');
}

/**
 * The shared instruction every idea role receives with the connected project's guidance: follow
 * the applicable AGENTS.md instructions, and treat the architecture and project documents that
 * file links as evidence for the current idea rather than as instructions for the role.
 */
export const projectGuidanceInstruction = [
  'Follow its applicable instructions. Treat the architecture and project documents it links as',
  'evidence to consult only when relevant to the current idea; do not open every link by default.',
  'Architecture specifications document how the project is designed and behaves and are never role',
  'instructions.',
].join('\n');

/** The connected project's root AGENTS.md content, or null when the project has none. */
export async function projectGuidanceText(root: string): Promise<string | null> {
  const file = path.join(root, worktreeDirectory, 'AGENTS.md');
  const text = await readDocumentText(file, 'Project AGENTS.md');
  if (text === null || text.trim() === '') {
    return null;
  }
  return [
    `The connected project's root AGENTS.md (${file}):`,
    projectGuidanceInstruction,
    text,
  ].join('\n');
}

/**
 * The saved report contract of one idea role: the responsibility a rejection or correction is
 * routed to and the operation whose report the artifact retains.
 */
export type IdeaReportContract = {
  readonly role: IdeaRole;
  readonly reportKind: string;
  readonly operation: string;
};

/** The saved reports the idea actions read from one another. */
export const ideaReportContracts = {
  framing: { role: 'idea-editor', reportKind: 'idea-framing', operation: 'FrameIdea' },
  editorTurn: {
    role: 'idea-editor',
    reportKind: 'idea-editor-turn',
    operation: 'idea-editor-turn',
  },
  research: { role: 'researcher', reportKind: 'research', operation: 'Researcher' },
  projectGuidance: {
    role: 'project-guide',
    reportKind: 'project-guidance',
    operation: 'ProjectGuide',
  },
  challenge: { role: 'challenger', reportKind: 'challenge', operation: 'Challenger' },
} as const satisfies Record<string, IdeaReportContract>;

/**
 * The report responsibility of one idea role's saved report: the configured project, the work
 * item, the refinement area and the role's report contract. Feedback routes by this scope.
 */
export function ideaReportScope(settings: {
  readonly root: string;
  readonly workId: string;
  readonly role: IdeaRole;
  readonly reportKind: string;
}): ReportScope {
  return {
    project: projectOfWorkspace(path.dirname(settings.root)),
    workId: settings.workId,
    area: settings.root,
    role: settings.role,
    reportKind: settings.reportKind,
  };
}

/**
 * Read one cycle's retained idea report. An unusable record is preserved as rejection evidence
 * under its producer's report responsibility, and the read fails on that explicit evidence
 * instead of silently letting a later repair drop the correction obligation.
 */
export async function readRetainedIdeaReport<Declaration extends ArtifactDeclaration>(settings: {
  readonly root: string;
  readonly workId: string;
  readonly plan: IdeaRoundPlan;
  readonly cycleRoot: string;
  readonly declaration: Declaration;
  readonly contract: IdeaReportContract;
  readonly context: string;
}): Promise<ArtifactContent<Declaration> | null> {
  const file = path.join(settings.cycleRoot, settings.declaration.pathFromArtifactsRoot);
  try {
    return await readCycleArtifact(settings.cycleRoot, settings.declaration);
  } catch (error) {
    return await rejectUnusableRecord({
      areaRoot: settings.root,
      scope: ideaReportScope({
        root: settings.root,
        workId: settings.workId,
        role: settings.contract.role,
        reportKind: settings.contract.reportKind,
      }),
      invocationId: null,
      operation: settings.contract.operation,
      profile: settings.plan.profiles[settings.contract.role] ?? null,
      context: settings.context,
      file,
      error,
    });
  }
}

/** The file one cycle's refined idea revision is stored at, whichever retained shape holds it. */
async function refinedIdeaFile(cycleRoot: string): Promise<string> {
  const current = path.join(cycleRoot, refinedIdeaArtifact.pathFromArtifactsRoot);
  try {
    return (await readDocumentText(current, 'Artifact')) !== null
      ? current
      : path.join(cycleRoot, retainedBriefArtifactPath);
  } catch {
    // Resolving the evidence's path must not mask the rejection when the current revision file
    // exists but cannot be read; the rejection records those unreadable bytes explicitly.
    return current;
  }
}

/**
 * Read one cycle's refined idea revision. An unusable retained revision is the editor's report
 * evidence, so it is preserved under the editor's report responsibility before the read fails.
 */
export async function readRetainedRefinedIdeaRevision(settings: {
  readonly root: string;
  readonly workId: string;
  readonly plan: IdeaRoundPlan;
  readonly cycleRoot: string;
  readonly context: string;
}): Promise<RefinedIdeaRead | null> {
  try {
    return await readRefinedIdeaRevision(settings.cycleRoot);
  } catch (error) {
    return await rejectUnusableRecord({
      areaRoot: settings.root,
      scope: ideaReportScope({
        root: settings.root,
        workId: settings.workId,
        role: 'idea-editor',
        reportKind: ideaReportContracts.editorTurn.reportKind,
      }),
      invocationId: null,
      operation: ideaReportContracts.editorTurn.operation,
      profile: settings.plan.profiles['idea-editor'] ?? null,
      context: settings.context,
      file: await refinedIdeaFile(settings.cycleRoot),
      error,
    });
  }
}

/**
 * The refined idea revision in force at or before one cycle, with an unusable retained revision
 * preserved under the editor's report responsibility.
 */
export async function readRetainedRefinedIdea(settings: {
  readonly root: string;
  readonly workId: string;
  readonly plan: IdeaRoundPlan;
  readonly submission: number;
  readonly cycle: number;
  readonly context: string;
}): Promise<RefinedIdeaRead | null> {
  for (let number = settings.cycle; number >= 1; number -= 1) {
    const read = await readRetainedRefinedIdeaRevision({
      root: settings.root,
      workId: settings.workId,
      plan: settings.plan,
      cycleRoot: ideaCycleDirectory(settings.root, settings.submission, number),
      context: settings.context,
    });
    if (read !== null) {
      return read;
    }
  }
  return null;
}

import { actionOwnedRecordsText, parseAgentReport } from './agent-reports.js';

export { parseAgentReport, responseFormatText } from './agent-reports.js';

/** What one idea role invocation needs: its plan, context and declared response schema. */
export type IdeaInvocationSettings<Schema extends z.ZodType> = {
  /** The refinement area the invocation's context refers to. */
  readonly root: string;
  /** The current round plan, which selects the role's profile. */
  readonly plan: IdeaRoundPlan;
  /** The idea role this invocation carries. */
  readonly role: IdeaRole;
  /** The operation name the invocation boundary carries. */
  readonly operation: string;
  /**
   * The role's report kind within the refinement area; it distinguishes the incompatible response
   * contracts one role invokes, such as the editor's framing and turn reports.
   */
  readonly reportKind: string;
  /** The captured idea input the invocation works on; its issue carries the boundary's Summary. */
  readonly input: IdeaInput;
  /** The caller-prepared context: role instructions, captured idea, history and sources. */
  readonly context: string;
  readonly schema: Schema;
  /** The role's agent runner: it assigns the invocation's identity and transports its activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** One idea role invocation's returned report and its outstanding-rejection obligations. */
export type IdeaInvocationOutcome<Schema extends z.ZodType> = {
  readonly report: z.output<Schema>;
  /**
   * Retain a post-parse semantic violation of this invocation's report as rejection evidence and
   * fail with its reason.
   */
  reject(reason: string, cause?: unknown): Promise<never>;
  /**
   * Record the correction that retires exactly the rejections this invocation was supplied, once
   * the caller validated and saved the usable replacement report.
   */
  resolveFeedback(artifact: ArtifactRef, content: unknown): Promise<void>;
};

/**
 * Run one idea role through AgentRuntime with the profile the round plan selected, then parse its
 * declared report. The invocation is supplied the outstanding rejections of its own report
 * responsibility, and a malformed response is retained as rejection evidence before the invocation
 * fails. The runner carries the invocation's preassigned identity and announces its boundaries, so
 * concurrent roles stay independently attributable; a provider failure is an execution error.
 */
export async function invokeIdeaRole<Schema extends z.ZodType>(
  settings: IdeaInvocationSettings<Schema>,
): Promise<IdeaInvocationOutcome<Schema>> {
  const profile = settings.plan.profiles[settings.role];
  if (profile === undefined) {
    throw new Error(
      `The idea round plan (submission ${String(settings.plan.submission)}, cycle ` +
        `${String(settings.plan.cycle)}) selects no "${settings.role}" profile.`,
    );
  }
  const scope: ReportScope = ideaReportScope({
    root: settings.root,
    workId: settings.input.taskKey,
    role: settings.role,
    reportKind: settings.reportKind,
  });
  const invocationId = randomUUID();
  const attribution =
    `Idea refinement ${settings.role} (${settings.reportKind}), submission ` +
    `${String(settings.plan.submission)}, cycle ${String(settings.plan.cycle)}, ` +
    `idea ${settings.input.taskKey}.`;
  const feedback: readonly RetainedReportFeedback<ReportRejection>[] =
    await outstandingReportFeedback({ areaRoot: settings.root, scope });
  const result = await settings.runner.run({
    operation: settings.operation,
    invocationId,
    profile,
    workspace: { root: settings.root },
    context: [
      ideaDefinitionText,
      ideaStageGuidanceText,
      ideaAttributionText,
      ideaSourceScopeText,
      ideaCommunicationText,
      actionOwnedRecordsText([
        path.join(settings.root, 'artifacts') +
          ' (the captured inputs, refinements, contributions, responses and decisions the actions save)',
        path.join(settings.root, 'state') + ' (the refinement state records)',
      ]),
      settings.context,
      ...reportFeedbackContextText(feedback),
    ].join('\n\n'),
    outputSchema: z.toJSONSchema(settings.schema),
    idea: settings.input.taskKey,
    summary: issueSummary(settings.input.issue),
  });
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  const report = await (async (): Promise<z.output<Schema>> => {
    try {
      return parseAgentReport(result.value.output, settings.schema, `"${settings.role}" agent`);
    } catch (error) {
      return await rejectReport({
        areaRoot: settings.root,
        scope,
        invocationId,
        operation: settings.operation,
        profile,
        context: attribution,
        source: null,
        output: result.value.output,
        reason: messageOf(error),
        cause: error,
      });
    }
  })();
  return {
    report,
    async reject(reason, cause): Promise<never> {
      return rejectReport({
        areaRoot: settings.root,
        scope,
        invocationId,
        operation: settings.operation,
        profile,
        context: attribution,
        source: null,
        output: result.value.output,
        reason,
        cause,
      });
    },
    async resolveFeedback(artifact, content): Promise<void> {
      if (feedback.length === 0) {
        return;
      }
      // The action validated and saved the usable replacement; recording its complete identity
      // retires exactly the rejections this invocation was supplied, preserving their history.
      await recordReportCorrection({
        areaRoot: settings.root,
        scope,
        rejections: feedback.map((entry) => ({ path: entry.path })),
        artifact,
        content,
        invocationId,
      });
    },
  };
}

/** Publish one idea action's saved artifact as its outcome event. */
export function publishIdeaOutcome(settings: {
  readonly publish: EventPublisher;
  readonly source: string;
  readonly taskKey: string;
  readonly cycle: number;
  readonly outcome: string;
  readonly detail: string | null;
  readonly artifact: string;
}): void {
  settings.publish(
    actionOutcomeEvent(settings.source, {
      task: settings.taskKey,
      round: null,
      cycle: settings.cycle,
      outcome: settings.outcome,
      detail: settings.detail,
      artifact: { path: settings.artifact },
    }),
  );
}
