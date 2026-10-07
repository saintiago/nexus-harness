import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../../adapters/git.js';
import { messageOf } from '../../../../result.js';
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
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stagePlanArtifact,
  stageAuthorResponseSchema,
  stageResultArtifact,
  stageReportScope,
  type PreparationStage,
  type RetainedStageAuthorOutput,
  type RetainedStageEvaluationOutput,
  type StageAuthorOutput,
  type StageAuthorResponse,
} from '../artifacts.js';
import { stageContextText } from '../context.js';
import { capturedSourcePathOf, retainCapturedSource } from '../readable-source.js';
import {
  checkoutRelative,
  resolveSkipReference,
  skipReferenceProblem,
} from '../evaluation-content.js';
import { readPrototypeObservation } from '../observation.js';
import {
  clearPendingValidationError,
  projectOfWorkspace,
  readPendingValidationError,
  rejectReport,
  rejectUnusableRecord,
  type ReportScope,
} from '../../report-feedback.js';
import {
  type PrecedingStageWork,
  preparationWorktree,
  readStageRoleArtifact,
  readStagePlan,
  readStageTerminal,
  roundArtifactDirectory,
  roundArtifactFile,
  stageRoot,
  stageRounds,
  writeStageArtifact,
} from '../storage.js';

/**
 * StageAuthor is the evaluated preparation stages' author invocation: it proposes work or a skip
 * with evidence references, or revises the work in response to the evaluator's findings. It
 * saves the authored revision, its functional outcome, plan, skip proposal, question or upstream
 * request bound to the invocation's assigned Markdown report. Provider and unusable-output
 * failures are execution errors.
 */

export type StageAuthorSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /** The author role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  /** The Git capability that observes whether a declared document is a retained deletion. */
  readonly git: GitAdapter;
  readonly publish: EventPublisher;
};

/** The task the workflow supplied with the invocation. */
function taskOf(input: unknown): 'propose' | 'respond' {
  const task =
    typeof input === 'object' && input !== null
      ? (input as { readonly task?: unknown }).task
      : undefined;
  if (task === 'propose' || task === 'respond') {
    return task;
  }
  throw new Error(
    `The preparation workflow supplied StageAuthor the unknown task ${JSON.stringify(task)}.`,
  );
}

/** True when the path names an existing file inside the shared preparation checkout. */
async function fileExists(worktree: string, relative: string): Promise<boolean> {
  try {
    return (await stat(path.join(worktree, relative))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new Error(
      `Document "${path.join(worktree, relative)}" could not be read: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * Why one declared path is not usable, or null. A path must stay inside the shared checkout and
 * either exist now, name a deletion attributable to this work, or retain the stage's recorded
 * deletion. An absent path is attributable when the stage already retained its deletion, when
 * the checkout still tracks it (an uncommitted deletion) or when the pre-invocation revision
 * tracked it (a deletion this invocation committed, which the post-invocation head no longer holds).
 */
async function declaredPathProblem(
  settings: {
    readonly git: GitAdapter;
    readonly worktree: string;
    readonly preEditHead: string | null;
  },
  value: string,
  deletions: ReadonlySet<string>,
): Promise<string | null> {
  const relative = checkoutRelative(settings.worktree, value);
  if (relative === null) {
    return `the declared path "${value}" lies outside the shared preparation checkout`;
  }
  if (await fileExists(settings.worktree, relative)) {
    return null;
  }
  if (deletions.has(relative)) {
    return null;
  }
  const inspection = await settings.git.inspectRepository(settings.worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  const head = inspection.value.headRevision;
  if (head === null) {
    return `the declared path "${value}" does not exist and the checkout has no revision`;
  }
  if ((await settings.git.readFileAtRevision(settings.worktree, head, relative)).ok) {
    return null;
  }
  if (
    settings.preEditHead !== null &&
    settings.preEditHead !== head &&
    (await settings.git.readFileAtRevision(settings.worktree, settings.preEditHead, relative)).ok
  ) {
    return null;
  }
  return `the declared path "${value}" does not exist and was not tracked before this edit`;
}

/**
 * Deletions this stage actually declared and retained for evaluation. Ownership survives later
 * repair, skip and return rounds; it does not authorize absent paths deleted by other stages.
 * Ownership comes from a retained authored declaration, never from the checkout's present
 * contents: the declaration recorded a deletion only when its path is absent at the exact
 * repository revision that round's evaluation observed, while a path it committed as a file stays
 * a modification even if some later work removed it. Browser observations and former per-file
 * content supply no path ownership. The current round is included so replay after an interrupted
 * evaluation keeps its recorded deletion too; a former unfinished declaration without an
 * evaluated revision preserves its work and uses existing attention/reassessment handling instead
 * of inferring ownership from absence.
 */
async function retainedStageDeletions(
  settings: {
    readonly git: GitAdapter;
    readonly root: string;
    readonly round: number;
    readonly worktree: string;
  },
  readAuthor: (round: number) => Promise<RetainedStageAuthorOutput | null>,
  readEvaluation: (round: number) => Promise<RetainedStageEvaluationOutput | null>,
): Promise<ReadonlySet<string>> {
  const { git, root, round, worktree } = settings;
  const deleted = new Set<string>();
  for (const retained of await stageRounds(root)) {
    if (retained > round) break;
    const author = await readAuthor(retained);
    if (author?.outcome !== 'authored') continue;
    const declared = new Set(
      [...author.documents.map((document) => document.path), ...author.sourcePaths]
        .map((value) => checkoutRelative(worktree, value))
        .filter((value): value is string => value !== null),
    );
    const evaluation = await readEvaluation(retained);
    const revision = evaluation?.basis.repositoryRevision;
    if (revision !== undefined) {
      for (const relative of declared) {
        if (!(await git.readFileAtRevision(worktree, revision, relative)).ok) {
          deleted.add(relative);
        }
      }
    }
  }
  return deleted;
}

/** Why the author's implementation plan does not match its stage and outcome, or null. */
function planProblem(report: StageAuthorResponse, stage: PreparationStage): string | null {
  const suppliesPlan =
    stage === 'architecture' &&
    (report.outcome === 'authored' || report.outcome === 'skip-proposed');
  if (suppliesPlan) {
    return report.plan.length === 0
      ? 'an authored or skip-proposed Architecture report supplies the nonempty implementation ' +
          'plan the handoff requires'
      : null;
  }
  return report.plan.length > 0
    ? 'only an authored or skip-proposed Architecture report supplies an implementation plan'
    : null;
}

/** Why the author's report is not a usable proposal, or null. */
async function reportProblem(
  report: StageAuthorResponse,
  settings: {
    readonly git: GitAdapter;
    readonly stage: PreparationStage;
    readonly worktree: string;
    readonly roundDirectory: string;
    /** The revision the checkout reported before this invocation; deletions it tracked. */
    readonly preEditHead: string | null;
    readonly retainedDeletions: ReadonlySet<string>;
  },
): Promise<string | null> {
  const plan = planProblem(report, settings.stage);
  if (plan !== null) {
    return plan;
  }
  const deletions = settings.retainedDeletions;
  if (settings.stage !== 'prototype') {
    if (report.observation !== null) {
      return 'only the Storybook Refinement stage retains a prototype observation';
    }
  } else if (report.outcome !== 'authored') {
    if (report.observation !== null) {
      return (
        'only authored prototype work carries an observation; a skip proposal, question or ' +
        'upstream return carries null'
      );
    }
  } else if (report.observation === null) {
    return (
      'applicable prototype work needs the author\u2019s saved browser observation; retain the ' +
      'record under the round artifact area and declare it'
    );
  } else {
    try {
      await readPrototypeObservation({
        declared: report.observation.path,
        roundDirectory: settings.roundDirectory,
        role: 'author',
      });
    } catch (error) {
      return messageOf(error);
    }
  }
  if (report.outcome === 'authored') {
    if (report.skip !== null) {
      return 'only a skip-proposed outcome carries a skip proposal';
    }
    if (report.question !== null) {
      return 'only a needs-input outcome carries the author question';
    }
    if (report.upstream !== null) {
      return 'only a return-upstream outcome carries the upstream request';
    }
    for (const document of report.documents) {
      const problem = await declaredPathProblem(settings, document.path, deletions);
      if (problem !== null) {
        return problem;
      }
    }
    for (const source of report.sourcePaths) {
      const problem = await declaredPathProblem(settings, source, deletions);
      if (problem !== null) {
        return problem;
      }
    }
    return null;
  }
  if (report.documents.length > 0) {
    return 'only authored work may declare changed documents';
  }
  if (report.sourcePaths.length > 0) {
    return 'only authored work may declare stage-owned source paths';
  }
  if (report.skip !== null && report.outcome !== 'skip-proposed') {
    return 'only a skip-proposed outcome carries a skip proposal';
  }
  if (report.question !== null && report.outcome !== 'needs-input') {
    return 'only a needs-input outcome carries the author question';
  }
  if (report.upstream !== null && report.outcome !== 'return-upstream') {
    return 'only a return-upstream outcome carries the upstream request';
  }
  if (report.outcome === 'skip-proposed') {
    if (report.skip === null) {
      return 'a proposed skip needs its skip declaration, while an empty references list is valid';
    }
    for (const reference of report.skip.references) {
      const resolution = await resolveSkipReference({ worktree: settings.worktree, reference });
      const problem = skipReferenceProblem(resolution);
      if (problem !== null) {
        return `the skip reference is unusable: ${problem}`;
      }
    }
    return null;
  }
  if (report.outcome === 'needs-input') {
    return report.question === null || report.question.trim() === ''
      ? 'a needs-input outcome needs the specific question for the author'
      : null;
  }
  return report.upstream === null
    ? 'a return-upstream outcome needs the earlier stage and the concrete correction'
    : null;
}

/** Create the StageAuthor invocation for one evaluated preparation stage. */
export function createStageAuthor(settings: StageAuthorSettings): BoundAction {
  return async (input?: unknown) => {
    const task = taskOf(input);
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
        `No ${settings.stage} round plan exists under "${root}"; the author needs an opened round.`,
      );
    }
    const scope: ReportScope = stageReportScope({
      project: projectOfWorkspace(selection.workspace.root),
      workId: selection.taskKey,
      area: root,
      stage: settings.stage,
      role: 'author',
    });
    const invocationId = randomUUID();
    const authorProfile = plan.profiles.author;
    const evaluatorProfile = plan.profiles.evaluator;
    const evaluatorScope: ReportScope = stageReportScope({
      project: projectOfWorkspace(selection.workspace.root),
      workId: selection.taskKey,
      area: root,
      stage: settings.stage,
      role: 'evaluator',
    });
    const attribution =
      `Preparation ${settings.stage} author, round ${String(plan.round)} ` +
      `(route ${plan.route}), task ${selection.taskKey}, task ${task}.`;
    // The invocation's own Markdown report, assigned before it runs so the agent writes the
    // narrative there and returns only the minimal outcome.
    const assignedReport = await assignReportPath(
      roundArtifactDirectory(root, plan.round),
      invocationId,
      'author',
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
        scope: byAuthor ? scope : evaluatorScope,
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
        context: `${attribution} Reading retained author round ${String(round)}.`,
      });
    }

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

    const author = await readAuthor(plan.round);
    // A response round revises the preceding authored revision in answer to the preceding
    // evaluation; the new round's own directory holds only the response it produces.
    let preceding: PrecedingStageWork | null = null;
    for (let earlier = plan.round - 1; earlier >= 1; earlier -= 1) {
      const retained = await readAuthor(earlier);
      if (retained !== null) {
        preceding = { round: earlier, author: retained };
        break;
      }
    }
    if (task === 'respond' && author === null && preceding === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'revise and no earlier round retains one.',
      );
    }
    // The most recent preceding evaluation supplies the still-relevant concerns for this
    // invocation; an intervening author-only round, a return, a question, a restart or a `new`
    // route label never clears them. An unusable record is preserved under the evaluator
    // responsibility instead of failing without evidence.
    let precedingEvaluation: RetainedStageEvaluationOutput | null = null;
    let precedingEvaluationRound: number | null = null;
    for (let earlier = plan.round - 1; earlier >= 1; earlier -= 1) {
      const retained = await readEvaluation(earlier);
      if (retained !== null) {
        precedingEvaluation = retained;
        precedingEvaluationRound = earlier;
        break;
      }
    }
    const pending = await readPendingValidationError({ areaRoot: root, scope });

    // A response round and a pending reassessment both revise the preceding authored revision
    // rather than starting from nothing; the new round's own directory holds only its response.
    const revising = task === 'respond' || plan.route === 'reassess';
    const authorRound = revising ? (preceding?.round ?? plan.round) : plan.round;
    // Author rounds retained after that evaluation carry corrections and disagreements the next
    // role must inspect; a missing later evaluation resolves nothing.
    const interveningAuthors: { round: number; author: RetainedStageAuthorOutput }[] = [];
    if (precedingEvaluationRound !== null) {
      for (let earlier = precedingEvaluationRound + 1; earlier < authorRound; earlier += 1) {
        const retained = await readAuthor(earlier);
        if (retained !== null) {
          interveningAuthors.push({ round: earlier, author: retained });
        }
      }
    }
    const capturedSource = capturedSourcePathOf(assignedReport.path);
    await retainCapturedSource({
      file: capturedSource,
      task: selection.task,
      conversation: selection.conversation,
    });
    const context = await stageContextText({
      selection,
      plan,
      stageRoot: root,
      worktree,
      author: revising ? (preceding?.author ?? author) : author,
      authorRound,
      evaluation: precedingEvaluation,
      evaluationRound: precedingEvaluationRound,
      interveningAuthors,
      report: assignedReport,
      capturedSource,
      retained:
        plan.route === 'reassess'
          ? await (async () => {
              const terminal = await readStageTerminal(root);
              return terminal === null
                ? null
                : { outcome: terminal.outcome, reason: terminal.reason };
            })()
          : null,
      feedback: pending,
      work: [
        task === 'propose'
          ? plan.route === 'reassess'
            ? 'Propose the current decision for this reassessed work: repair what changed and ' +
              'leave adequate current documents unchanged; a submission may declare no changed files.'
            : 'Propose this round\u2019s work or an evaluated skip for the exact revision you author.'
          : 'Revise the authored revision in answer to the current findings, explaining ' +
            'corrections, disagreements and remaining problems in the assigned Markdown report. ' +
            'When the findings show that the corrected scope makes the stage irrelevant, you may ' +
            'propose an applicability skip instead of further work; evaluation decides its ' +
            'applicability.',
      ],
      reporting: [
        'Write the complete narrative report to that path before returning: what you authored or ' +
          'proposed, declaration explanations, the skip rationale, corrections, disagreements and ' +
          'remaining problems, using the supplied previous reports as context. Return the minimal ' +
          'response object only; the action adds the observed identity, revision and report ' +
          'binding.',
        'An authored outcome declares the changed authoritative documents in documents and any ' +
          'additional stage-owned authored files it commits in sourcePaths; never declare files ' +
          'that were merely read. Unchanged adequate documents may leave both empty: the ' +
          'evaluator inspects the current worktree regardless of who wrote it. A skip-proposed, ' +
          'needs-input or return-upstream outcome carries empty documents and sourcePaths, and a ' +
          'proposed skip explains its inapplicability in the report and carries its optional ' +
          'supporting evidence in skip.references. Each supplied reference cites a readable file ' +
          'in the shared checkout (a path, or a path#section citation) or an existing retained ' +
          'file; an unreadable reference rejects the report and an empty list is valid.',
        'Only the Architecture stage supplies plan entries: an authored or skip-proposed ' +
          'Architecture report carries the nonempty implementation plan the handoff requires. ' +
          'Every other stage, and a needs-input or return-upstream outcome, returns an empty ' +
          'plan array.',
        settings.stage === 'prototype'
          ? 'Accepted applicable prototype work needs your own saved browser observation; the ' +
            'observation contract above states the record and the round artifact area.'
          : 'The observation field is null; only the Storybook Refinement stage retains an ' +
            'observation record.',
        'The outcome carries only the functional declaration, plan, question, skip references or ' +
          'upstream destination and correction. There are no finding IDs, response arrays, ' +
          'disposition records or narrative summaries in it.',
        actionOwnedRecordsText([
          roundArtifactFile(root, plan.round, stageAuthorArtifact.pathFromArtifactsRoot),
          roundArtifactFile(root, plan.round, stagePlanArtifact.pathFromArtifactsRoot),
          roundArtifactFile(root, plan.round, stageEvaluationArtifact.pathFromArtifactsRoot),
          roundArtifactFile(root, plan.round, stageResultArtifact.pathFromArtifactsRoot),
        ]),
        responseFormatText(stageAuthorResponseSchema),
      ],
      rejectUnreadableReport,
    });
    // The pre-invocation revision is the evidence that a deletion committed during the invocation
    // was tracked before this edit; the post-invocation head no longer retains it.
    const before = await settings.git.inspectRepository(worktree);
    if (!before.ok) {
      throw new Error(before.fault.message);
    }
    const result = await settings.runner.run({
      operation: 'stage-author',
      invocationId,
      profile: authorProfile,
      // The invocation's workspace is the preparation issue root; AgentRuntime resolves the one
      // shared checkout at its worktree/ child. Stage areas only hold artifacts.
      workspace: { root: selection.workspace.root },
      context,
      outputSchema: z.toJSONSchema(stageAuthorResponseSchema),
      task: selection.taskKey,
    });
    if (!result.ok) {
      throw new Error(result.fault.message);
    }
    const report = await (async (): Promise<StageAuthorResponse> => {
      try {
        return parseAgentReport(
          result.value.output,
          stageAuthorResponseSchema,
          `${settings.stage} author`,
        );
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'stage-author',
          profile: authorProfile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();
    await (async () => {
      try {
        await readAssignedReport(assignedReport.path, 'Assigned author report');
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'stage-author',
          profile: authorProfile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();
    const problem = await reportProblem(report, {
      git: settings.git,
      stage: settings.stage,
      worktree,
      roundDirectory: roundArtifactDirectory(root, plan.round),
      preEditHead: before.value.headRevision,
      retainedDeletions:
        report.outcome === 'authored'
          ? await retainedStageDeletions(
              { git: settings.git, root, round: plan.round, worktree },
              readAuthor,
              readEvaluation,
            )
          : new Set(),
    });
    if (problem !== null) {
      await rejectReport({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'stage-author',
        profile: authorProfile,
        context: attribution,
        source: null,
        output: result.value.output,
        assignedReport,
        reason: `The ${settings.stage} author report is unusable: ${problem}.`,
      });
    }
    // The retained response keeps its revision on a replay; a new revision continues the stage's
    // cumulative authored revisions.
    const revision = author?.revision ?? (preceding?.author.revision ?? 0) + 1;
    const output: StageAuthorOutput = {
      stage: settings.stage,
      revision,
      ...report,
      taskKey: selection.taskKey,
      profile: authorProfile,
      role: 'author',
      report: assignedReport,
      invocationId,
    };
    await writeStageArtifact(root, plan.round, stageAuthorArtifact, output);
    const artifact = path.join(
      root,
      'artifacts',
      String(plan.round),
      stageAuthorArtifact.pathFromArtifactsRoot,
    );
    // The owner validated and saved the usable replacement, whatever its business outcome; its
    // pending validation-error context is cleared while the readable history stays.
    await clearPendingValidationError({ areaRoot: root, scope });
    settings.publish(
      actionOutcomeEvent('stage-author', {
        task: selection.taskKey,
        round: plan.round,
        outcome: report.outcome,
        detail: `${settings.stage} · revision ${String(revision)}`,
        artifact: { path: artifact },
      }),
    );
    return report.outcome;
  };
}
