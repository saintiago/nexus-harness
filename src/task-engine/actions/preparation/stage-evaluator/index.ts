import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../../adapters/git.js';
import { messageOf } from '../../../../result.js';
import {
  authoredIdentity,
  retainEvaluationContent,
  requireEvaluationContent,
  sourceInputIdentity,
} from '../evaluation-content.js';
import {
  actionOutcomeEvent,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../../../index.js';
import {
  actionOwnedRecordsText,
  assignReportPath,
  parseAgentReport,
  readAssignedReport,
  responseFormatText,
} from '../../agent-reports.js';
import { readRequiredRecord } from '../../records.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  recordReportCorrection,
  rejectReport,
  rejectUnusableRecord,
  type ReportScope,
} from '../../report-feedback.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  acceptanceVerdictProblem,
  evaluationVerdictProblem,
  isBoundStageAuthorOutput,
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageEvaluationResponseSchema,
  stagePlanArtifact,
  stageResultArtifact,
  stageReportScope,
  type AssessedContent,
  type PreparationStage,
  type RetainedStageAuthorOutput,
  type RetainedStageEvaluationOutput,
  type StageEvaluationOutput,
  type StageEvaluationResponse,
} from '../artifacts.js';
import { stageContextText } from '../context.js';
import {
  preparationWorktree,
  readStageRoleArtifact,
  readStagePlan,
  readStageTerminal,
  requireStageReport,
  roundArtifactDirectory,
  roundArtifactFile,
  stageRoot,
  upstreamResultReferences,
  writeStageArtifact,
} from '../storage.js';
import {
  evidenceFilePath,
  observationContentProblem,
  readPrototypeObservation,
  type PrototypeObservationRole,
} from '../observation.js';

/**
 * StageEvaluator assesses the exact authored revision of one evaluated preparation round. It
 * judges earlier concerns against the current content, distinguishes necessary changes from
 * optional suggestions and accepts the work, the author's skip proposal or a concrete upstream
 * return, writing its complete assessment to the assigned Markdown report. The action binds the
 * decision to the authored revision it observed; an outcome that invents a skip the author did
 * not propose is unusable.
 */

export type StageEvaluatorSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /** The evaluator role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly git: GitAdapter;
  readonly publish: EventPublisher;
};

/**
 * Why the evaluator's outcome is not a usable assessment of the current revision, or null. The
 * Markdown report carries the current findings; previous reports are context.
 */
function reportProblem(
  report: z.output<typeof stageEvaluationResponseSchema>,
  settings: {
    readonly stage: PreparationStage;
    readonly authorOutcome: RetainedStageAuthorOutput['outcome'];
  },
): string | null {
  const { authorOutcome } = settings;
  const acceptanceProblem = acceptanceVerdictProblem(authorOutcome, report.verdict);
  if (acceptanceProblem !== null) return acceptanceProblem;
  const verdictProblem = evaluationVerdictProblem(report.verdict, report.upstream);
  if (verdictProblem !== null) return verdictProblem;
  if (settings.stage !== 'prototype') {
    if (report.observation !== null) {
      return 'only the Storybook Refinement stage retains a prototype observation';
    }
  } else if (report.verdict === 'accepted-skip') {
    if (report.observation !== null) {
      return 'an evaluated applicability skip carries no observation; it needs no preview evidence';
    }
  } else if (report.verdict === 'accepted') {
    if (report.observation === null) {
      return (
        'accepting applicable prototype work needs the evaluator\u2019s own saved browser ' +
        'observation'
      );
    }
  }
  // A change request or upstream return may retain the observation of the preview it performed;
  // the declared record is validated with the rest of the report either way.
  return null;
}

/**
 * Validate the author's and the evaluator's saved observations against the exact revision an
 * accepted applicable prototype assesses: both records must be readable evidence covering the
 * stage-owned prototype paths, and their observed content must still match the evaluated revision.
 * Missing or stale evidence cannot produce acceptance.
 */
async function requirePrototypeEvidence(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly roundDirectory: string;
  readonly author: RetainedStageAuthorOutput;
  readonly evaluator: { readonly path: string } | null;
  /** True when the assessed verdict relies on the evaluator's own applicable observation. */
  readonly requireEvaluator: boolean;
  readonly assessed: readonly AssessedContent[];
  /** Retain a violation under the producer whose evidence failed, then raise the failure. */
  readonly reject: (
    role: PrototypeObservationRole,
    observationPath: string | null,
    error: Error,
  ) => Promise<never>;
}): Promise<void> {
  const declared: (readonly [PrototypeObservationRole, string])[] = [];
  if (settings.author.observation !== null) {
    declared.push(['author', settings.author.observation.path]);
  } else if (settings.author.outcome === 'authored') {
    await settings.reject(
      'author',
      null,
      new Error(
        'The prototype author report carries no observation; applicable prototype work needs the ' +
          'author\u2019s own browser evidence.',
      ),
    );
  }
  if (settings.evaluator !== null) {
    declared.push(['evaluator', settings.evaluator.path]);
  } else if (settings.requireEvaluator) {
    await settings.reject(
      'evaluator',
      null,
      new Error(
        'The prototype evaluator report carries no observation; an accepted applicable prototype ' +
          'needs the evaluator\u2019s own browser evidence.',
      ),
    );
  }
  for (const [role, observationPath] of declared) {
    try {
      const observation = await readPrototypeObservation({
        declared: observationPath,
        roundDirectory: settings.roundDirectory,
        role,
      });
      const problem = await observationContentProblem({
        git: settings.git,
        worktree: settings.worktree,
        observation,
        assessed: settings.assessed,
        observedPaths: settings.author.sourcePaths,
      });
      if (problem !== null) throw new Error(`${problem}.`);
    } catch (error) {
      await settings.reject(
        role,
        observationPath,
        new Error(`The ${role} prototype observation is unusable: ${messageOf(error)}`, {
          cause: error,
        }),
      );
    }
  }
}

/** Create the StageEvaluator invocation for one evaluated preparation stage. */
export function createStageEvaluator(settings: StageEvaluatorSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = stageRoot(selection.workspace.root, settings.stage);
    const worktree = preparationWorktree(selection.workspace.root);
    const plan = await readStagePlan(root);
    if (plan === null || plan.stage !== settings.stage) {
      throw new Error(
        `No ${settings.stage} round plan exists under "${root}"; the evaluator needs an opened ` +
          'round.',
      );
    }
    const evaluatorProfile = plan.profiles.evaluator;
    const authorProfile = plan.profiles.author;
    const authorScope: ReportScope = stageReportScope({
      project: projectOfWorkspace(selection.workspace.root),
      workId: selection.taskKey,
      area: root,
      stage: settings.stage,
      role: 'author',
    });
    const scope: ReportScope = stageReportScope({
      project: projectOfWorkspace(selection.workspace.root),
      workId: selection.taskKey,
      area: root,
      stage: settings.stage,
      role: 'evaluator',
    });
    const invocationId = randomUUID();
    const attribution =
      `Preparation ${settings.stage} evaluator, round ${String(plan.round)} ` +
      `(route ${plan.route}), task ${selection.taskKey}, authored revision to assess.`;
    // The invocation's own Markdown report, assigned before it runs so the agent writes the
    // narrative there and returns only the minimal outcome.
    const assignedReport = await assignReportPath(
      roundArtifactDirectory(root, plan.round),
      invocationId,
      'evaluator',
    );

    /**
     * Preserve an unreadable bound producer report as that producer's rejection evidence, then
     * fail: the responsible role receives the correction obligation instead of the evidence
     * silently disappearing.
     */
    async function rejectUnreadableReport(settings: {
      readonly role: 'author' | 'evaluator';
      readonly round: number;
      readonly report: { readonly path: string };
      readonly invocationId: string;
      readonly profile: string;
      readonly error: Error;
    }): Promise<never> {
      const byAuthor = settings.role === 'author';
      return rejectUnusableRecord({
        areaRoot: root,
        scope: byAuthor ? authorScope : scope,
        invocationId: settings.invocationId,
        operation: byAuthor ? 'stage-author' : 'stage-evaluator',
        profile: settings.profile,
        context: `${attribution} Reading the ${settings.role} report bound to round ${String(settings.round)}.`,
        file: roundArtifactFile(
          root,
          settings.round,
          (byAuthor ? stageAuthorArtifact : stageEvaluationArtifact).pathFromArtifactsRoot,
        ),
        error: settings.error,
        assignedReport: settings.report,
      });
    }

    async function readAuthor(round: number): Promise<RetainedStageAuthorOutput | null> {
      return readStageRoleArtifact({
        issueRoot: selection.workspace.root,
        stage: settings.stage,
        workId: selection.taskKey,
        round,
        role: 'author',
        profile: authorProfile,
        context: attribution,
      });
    }
    const author = await readAuthor(plan.round);
    if (author === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'assess.',
      );
    }
    /**
     * Read one retained evaluation: the evaluator's own earlier report. An unusable record is
     * preserved under this report responsibility, so this invocation fails on explicit evidence
     * and its next permitted invocation receives the correction obligation.
     */
    async function readEvaluation(round: number): Promise<RetainedStageEvaluationOutput | null> {
      return readStageRoleArtifact({
        issueRoot: selection.workspace.root,
        stage: settings.stage,
        workId: selection.taskKey,
        round,
        role: 'evaluator',
        profile: evaluatorProfile,
        context: `${attribution} Reading retained evaluation round ${String(round)}.`,
      });
    }

    const outstanding = await outstandingReportFeedback({ areaRoot: root, scope });
    // A response or reassessment round judges the preceding evaluation's concerns against the
    // current revision it assesses; a fresh round was already evaluated on its own revision, if at
    // all.
    let previous: RetainedStageEvaluationOutput | null = null;
    let previousRound: number | null = null;
    if (plan.route !== 'new') {
      for (let earlier = plan.round - 1; earlier >= 1; earlier -= 1) {
        const retained = await readEvaluation(earlier);
        if (retained !== null) {
          previous = retained;
          previousRound = earlier;
          break;
        }
      }
    }
    const retained = await retainEvaluationContent({
      git: settings.git,
      worktree,
      author,
    });
    const upstream = await upstreamResultReferences(selection.workspace.root, settings.stage);
    const basis = {
      author: { path: roundArtifactFile(root, plan.round, 'author.json') },
      authorIdentity: authoredIdentity(author),
      sourceIdentity: sourceInputIdentity(selection),
      upstream: upstream.map((reference) => ({
        result: { path: reference.resultFile },
        identity: reference.identity,
      })),
      repositoryRevision: retained.revision,
      content: retained.content,
    };
    const retainedDecision =
      plan.route === 'reassess'
        ? await (async () => {
            const terminal = await readStageTerminal(root);
            return terminal === null
              ? null
              : { outcome: terminal.outcome, reason: terminal.reason };
          })()
        : null;
    const context = await stageContextText({
      selection,
      plan,
      stageRoot: root,
      worktree,
      author,
      authorRound: plan.round,
      evaluation: previous,
      evaluationRound: previousRound,
      report: assignedReport,
      retained: retainedDecision,
      feedback: outstanding,
      rejectUnreadableReport,
    });
    const result = await settings.runner.run({
      operation: 'stage-evaluator',
      invocationId,
      profile: evaluatorProfile,
      // The invocation's workspace is the preparation issue root; AgentRuntime resolves the one
      // shared checkout at its worktree/ child. Stage areas only hold artifacts.
      workspace: { root: selection.workspace.root },
      context: [
        context,
        `Assess the exact authored revision ${String(author.revision)} and judge whether earlier ` +
          'concerns remain. Accept adequate work, the author\u2019s evaluated skip or a concrete ' +
          'upstream return; separate necessary changes from optional suggestions.',
        `Assigned Markdown report: ${assignedReport.path}`,
        'Write the complete assessment to that path before returning: the current findings with ' +
          'their evidence, the acceptance, skip or change explanation, any optional suggestions ' +
          'and remaining disagreements. Return the minimal response object only; the action adds ' +
          'the observed acceptance basis, assessed revision and report binding.',
        settings.stage === 'prototype'
          ? 'Accepting applicable prototype work needs your own saved browser observation; an ' +
            'evaluated applicability skip carries none. The observation contract above states the ' +
            'record and the round artifact area.'
          : 'The observation field is null; only the Storybook Refinement stage retains an ' +
            'observation record.',
        `The repository revision this evaluation observes: ${basis.repositoryRevision}. ` +
          'Assess the ticket against the current authoritative documents and the changed stage ' +
          'work in the supplied shared checkout; a submission that declares no changed files ' +
          'does not restrict your scope.',
        ...(basis.content.length === 0
          ? []
          : [
              'The applicable prototype content retained for this evaluation (path at revision, ' +
                `or a retained deletion): ${JSON.stringify(basis.content)}`,
            ]),
        'The relied-on upstream results this decision binds: ' + JSON.stringify(basis.upstream),
        'Previous reports are context: judge whether their concerns were addressed and report ' +
          'the findings present in the assessed revision. The outcome carries only the verdict, ' +
          'the applicable observation and any upstream destination and correction; findings have ' +
          'no stable IDs, response arrays, disposition records or summaries.',
        'State a verdict the current findings support: accepted and accepted-skip require no ' +
          'blocking finding, and changes-requested needs at least one, explained in the report.',
        actionOwnedRecordsText([
          roundArtifactFile(root, plan.round, stageAuthorArtifact.pathFromArtifactsRoot),
          roundArtifactFile(root, plan.round, stagePlanArtifact.pathFromArtifactsRoot),
          roundArtifactFile(root, plan.round, stageEvaluationArtifact.pathFromArtifactsRoot),
          roundArtifactFile(root, plan.round, stageResultArtifact.pathFromArtifactsRoot),
        ]),
        responseFormatText(stageEvaluationResponseSchema),
      ].join('\n\n'),
      outputSchema: z.toJSONSchema(stageEvaluationResponseSchema),
      task: selection.taskKey,
    });
    if (!result.ok) {
      throw new Error(result.fault.message);
    }
    const report = await (async (): Promise<StageEvaluationResponse> => {
      try {
        return parseAgentReport(
          result.value.output,
          stageEvaluationResponseSchema,
          `${settings.stage} evaluator`,
        );
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'stage-evaluator',
          profile: evaluatorProfile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();
    const reportFile = await (async () => {
      try {
        return await readAssignedReport(assignedReport.path, 'Assigned evaluation report');
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'stage-evaluator',
          profile: evaluatorProfile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();
    const problem = reportProblem(report, {
      stage: settings.stage,
      authorOutcome: author.outcome,
    });
    if (problem !== null) {
      await rejectReport({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'stage-evaluator',
        profile: evaluatorProfile,
        context: attribution,
        source: null,
        output: result.value.output,
        assignedReport,
        reason: `The ${settings.stage} evaluator report is unusable: ${problem}.`,
      });
    }
    if (settings.stage === 'prototype') {
      const roundDirectory = roundArtifactDirectory(root, plan.round);
      await requirePrototypeEvidence({
        git: settings.git,
        worktree,
        roundDirectory,
        author,
        evaluator: report.observation,
        requireEvaluator: report.verdict === 'accepted',
        assessed: retained.content,
        reject: async (role, observationPath, error) => {
          if (role === 'author') {
            // Retained author evidence belongs to the author, not the current respondent. If
            // its declaration is absent or outside the round, retain the declaring report.
            const observationFile =
              observationPath === null ? null : evidenceFilePath(roundDirectory, observationPath);
            return rejectUnusableRecord({
              areaRoot: root,
              scope: authorScope,
              invocationId: isBoundStageAuthorOutput(author) ? author.invocationId : null,
              operation: 'stage-author',
              profile: isBoundStageAuthorOutput(author) ? author.profile : null,
              context: attribution,
              file:
                observationFile ??
                roundArtifactFile(root, plan.round, stageAuthorArtifact.pathFromArtifactsRoot),
              error,
            });
          }
          return rejectReport({
            areaRoot: root,
            scope,
            invocationId,
            operation: 'stage-evaluator',
            profile: evaluatorProfile,
            context: attribution,
            source: null,
            output: result.value.output,
            assignedReport,
            reason: messageOf(error),
            cause: error,
          });
        },
      });
    }

    await requireEvaluationContent({
      git: settings.git,
      worktree,
      content: retained.content,
    });
    const currentAuthor = await readAuthor(plan.round);
    // An invalid binding must retain author rejection evidence before an identity change can
    // request ordinary reevaluation. Recheck even when the saved outcome itself is unchanged.
    if (currentAuthor !== null && isBoundStageAuthorOutput(currentAuthor)) {
      await requireStageReport({
        issueRoot: selection.workspace.root,
        workId: selection.taskKey,
        stage: settings.stage,
        role: 'author',
        binding: currentAuthor,
        profile: currentAuthor.profile,
        file: roundArtifactFile(root, plan.round, stageAuthorArtifact.pathFromArtifactsRoot),
        context: `${attribution} Validating the author report after assessment.`,
      });
    }
    if (currentAuthor === null || authoredIdentity(currentAuthor) !== authoredIdentity(author))
      throw new Error('The authored report changed during assessment; reevaluation is required.');
    const output: StageEvaluationOutput = {
      basis,
      assessedRevision: author.revision,
      verdict: report.verdict,
      observation: report.observation,
      upstream: report.upstream,
      stage: settings.stage,
      taskKey: selection.taskKey,
      profile: evaluatorProfile,
      role: 'evaluator',
      report: assignedReport,
      reportIdentity: reportFile.identity,
      invocationId,
    };
    await writeStageArtifact(root, plan.round, stageEvaluationArtifact, output);
    const artifact = path.join(
      root,
      'artifacts',
      String(plan.round),
      stageEvaluationArtifact.pathFromArtifactsRoot,
    );
    if (outstanding.length > 0) {
      // The owner validated and saved the usable replacement; recording its complete identity
      // retires exactly the rejections this invocation was supplied, preserving their history.
      await recordReportCorrection({
        areaRoot: root,
        scope,
        rejections: outstanding.map((entry) => ({ path: entry.path })),
        artifact: { path: artifact },
        content: output,
        invocationId,
      });
    }
    settings.publish(
      actionOutcomeEvent('stage-evaluator', {
        task: selection.taskKey,
        round: plan.round,
        outcome: report.verdict,
        detail: `${settings.stage} · revision ${String(author.revision)}`,
        artifact: { path: artifact },
      }),
    );
    return report.verdict;
  };
}
