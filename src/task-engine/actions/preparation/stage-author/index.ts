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
import { parseAgentReport, responseFormatText } from '../../agent-reports.js';
import { requireFindingResponses } from '../../finding-responses.js';
import { readRecord, readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageAuthorResponseSchema,
  stageReportScope,
  type PreparationStage,
  type StageAuthorOutput,
  type StageAuthorResponse,
  type StageEvaluationOutput,
} from '../artifacts.js';
import { stageContextText } from '../context.js';
import {
  checkoutRelative,
  resolveSkipReference,
  skipReferenceProblem,
  type RetainedPrototypeReference,
} from '../evaluation-content.js';
import {
  evidenceFilePath,
  observationScopeProblem,
  observationSubmissionProblem,
  prototypeObservationSchema,
  readPrototypeObservation,
  type PrototypeObservation,
} from '../observation.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  recordReportCorrection,
  rejectReport,
  rejectUnusableRecord,
  type ReportScope,
} from '../../report-feedback.js';
import {
  type PrecedingStageWork,
  preparationWorktree,
  readStageArtifact,
  readStagePlan,
  readStageTerminal,
  retainedStagePrototype,
  roundArtifactDirectory,
  roundArtifactFile,
  stageRoot,
  stageRounds,
  writeStageArtifact,
} from '../storage.js';

/**
 * StageAuthor is the evaluated preparation stages' author invocation: it proposes work or a skip
 * with reasons and references, or revises the work in response to the evaluator's findings. It
 * saves the authored revision, its documents, plan, skip proposal, question or upstream request
 * and the author's finding responses. Provider and unusable-output failures are execution errors.
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
 * Include the current round so replay after an interrupted evaluation keeps its deletion too.
 */
async function retainedStageDeletions(
  root: string,
  round: number,
  worktree: string,
  readAuthor: (round: number) => Promise<StageAuthorOutput | null>,
  readEvaluation: (round: number) => Promise<StageEvaluationOutput | null>,
  readObservation: (round: number, file: string) => Promise<PrototypeObservation | null>,
): Promise<ReadonlySet<string>> {
  const deleted = new Set<string>();
  for (const retained of await stageRounds(root)) {
    if (retained > round) break;
    const author = await readAuthor(retained);
    if (author?.outcome !== 'authored') continue;
    const evaluation = await readEvaluation(retained);
    const declared = new Set(
      [...author.documents.map((document) => document.path), ...author.sourcePaths].map((value) =>
        checkoutRelative(worktree, value),
      ),
    );
    // A validated author's observation also retains ownership before evaluation is saved. Read
    // its declaration without requiring old screenshots: a repair may replace damaged evidence.
    let content = evaluation?.basis.content ?? [];
    if (evaluation === null && author.observation !== null) {
      const file = evidenceFilePath(
        roundArtifactDirectory(root, retained),
        author.observation.path,
      );
      if (file !== null) {
        const observation = await readObservation(retained, file);
        if (observation?.role === 'author') content = observation.content;
      }
    }
    for (const entry of content) {
      const relative = checkoutRelative(worktree, entry.path);
      if (!entry.exists && relative !== null && declared.has(relative)) deleted.add(relative);
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
          'plan the handoff requires, even when an existing adequate design permits the skip'
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
    /** The retained prototype this stage owns, when a prototype reuse skip cites it. */
    readonly retainedPrototype: RetainedPrototypeReference | null;
  },
  task: 'propose' | 'respond',
): Promise<string | null> {
  if (task === 'respond' && report.outcome === 'skip-proposed') {
    return 'a revision round cannot propose a skip; the evaluator asked for changes';
  }
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
    let observation: PrototypeObservation;
    try {
      observation = await readPrototypeObservation({
        declared: report.observation.path,
        roundDirectory: settings.roundDirectory,
        role: 'author',
      });
    } catch (error) {
      return messageOf(error);
    }
    const scope = observationScopeProblem({
      worktree: settings.worktree,
      observation,
      observedPaths: report.sourcePaths,
    });
    if (scope !== null) {
      return scope;
    }
    const submission = await observationSubmissionProblem({
      git: settings.git,
      worktree: settings.worktree,
      observation,
    });
    if (submission !== null) {
      return submission;
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
    if (report.documents.length === 0 && report.sourcePaths.length === 0) {
      return 'authored work must name at least one document or stage-owned source path';
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
    if (report.skip === null || report.skip.references.length === 0) {
      return 'a proposed skip needs its reason and references to the satisfying inputs';
    }
    for (const reference of report.skip.references) {
      const resolution = await resolveSkipReference({
        worktree: settings.worktree,
        reference,
        retainedPrototype: settings.retainedPrototype,
      });
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
    ? 'a return-upstream outcome needs the problematic input, consequence and correction'
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

    /**
     * Read one retained authored report. An unusable retained record is preserved as rejection
     * evidence under this report responsibility instead of silently failing its next reader.
     */
    async function readAuthorRecord<Value>(
      round: number,
      file: string,
      read: () => Promise<Value>,
    ): Promise<Value> {
      try {
        return await read();
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'stage-author',
          profile: authorProfile,
          context: `${attribution} Reading retained author round ${String(round)}.`,
          file,
          error,
        });
      }
    }

    async function readAuthor(round: number): Promise<StageAuthorOutput | null> {
      return readAuthorRecord(
        round,
        roundArtifactFile(root, round, stageAuthorArtifact.pathFromArtifactsRoot),
        () => readStageArtifact(root, round, stageAuthorArtifact),
      );
    }

    /**
     * Read one retained evaluation. The evaluation is the evaluator's report: an unusable record
     * is preserved under the evaluator's responsibility so its next invocation receives the
     * correction obligation, while this invocation keeps failing on the unreadable evidence.
     */
    async function readEvaluation(round: number): Promise<StageEvaluationOutput | null> {
      const file = roundArtifactFile(root, round, stageEvaluationArtifact.pathFromArtifactsRoot);
      try {
        return await readStageArtifact(root, round, stageEvaluationArtifact);
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope: evaluatorScope,
          invocationId,
          operation: 'stage-evaluator',
          profile: evaluatorProfile,
          context: `${attribution} Reading retained evaluation round ${String(round)}.`,
          file,
          error,
        });
      }
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
    // The most recent preceding evaluation supplies the findings this round answers; an unusable
    // record is preserved under the evaluator responsibility instead of failing without evidence.
    let precedingEvaluation: StageEvaluationOutput | null = null;
    if (plan.route !== 'new') {
      for (let earlier = plan.round - 1; earlier >= 1; earlier -= 1) {
        const retained = await readEvaluation(earlier);
        if (retained !== null) {
          precedingEvaluation = retained;
          break;
        }
      }
    }
    const findings = precedingEvaluation?.findings ?? [];
    const outstanding = await outstandingReportFeedback({ areaRoot: root, scope });

    // A response round and a pending reassessment both revise the preceding authored revision
    // rather than starting from nothing; the new round's own directory holds only its response.
    const revising = task === 'respond' || plan.route === 'reassess';
    const context = await stageContextText({
      selection,
      plan,
      stageRoot: root,
      worktree,
      author: revising ? (preceding?.author ?? author) : author,
      evaluation: revising ? precedingEvaluation : null,
      retained:
        plan.route === 'reassess'
          ? await (async () => {
              const terminal = await readStageTerminal(root);
              return terminal === null
                ? null
                : { outcome: terminal.outcome, reason: terminal.reason };
            })()
          : null,
      feedback: outstanding,
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
      context: [
        context,
        task === 'propose'
          ? plan.route === 'reassess'
            ? 'Propose the current decision for this reassessed work: reuse retained accepted work whose content and inputs still match, or repair what changed.'
            : 'Propose this round\u2019s work or an evaluated skip for the exact revision you author.'
          : 'Revise the authored revision in answer to every current finding, or rebut with reasons.',
        'Return the response object only; do not write or overwrite the action-owned stage records ' +
          '(author.json, plan.json, evaluation.json, result.json or the state records). The action ' +
          'adds the stage and authored revision metadata and persists your report.',
        'An authored outcome declares the changed authoritative documents in documents and any ' +
          'additional stage-owned authored files it commits in sourcePaths; never declare files ' +
          'that were merely read. A skip-proposed, needs-input or return-upstream outcome carries ' +
          'empty documents and sourcePaths, and a proposed skip puts the existing inputs that ' +
          'satisfy the stage in skip.references. Each reference cites a readable file in the ' +
          'shared checkout (a path, or a path#section citation) or an existing retained file; a ' +
          'Storybook Refinement reuse skip may instead cite the retained prototype branch, ' +
          'revision or checkout. Explanations belong in the skip reason: an unresolvable ' +
          'reference rejects the report.',
        'Only the Architecture stage supplies plan entries: an authored or skip-proposed ' +
          'Architecture report carries the nonempty implementation plan, even when an existing ' +
          'adequate design permits the skip. Every other stage, and a needs-input or ' +
          'return-upstream outcome, returns an empty plan array.',
        settings.stage === 'prototype'
          ? 'Accepted applicable prototype work needs your own saved browser observation; the ' +
            'observation contract above states the record and the round artifact area.'
          : 'The observation field is null; only the Storybook Refinement stage retains an ' +
            'observation record.',
        findings.length === 0
          ? 'No prior findings are supplied for this round; return an empty findingResponses array.'
          : `Eligible prior finding IDs: ${findings
              .map((finding) => `"${finding.id}"`)
              .join(', ')}. Return exactly one findingResponses entry for each and none for any ` +
            'other ID, stating what you changed, disagree with or could not resolve.',
        responseFormatText(stageAuthorResponseSchema),
      ].join('\n\n'),
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
          reason: messageOf(error),
          cause: error,
        });
      }
    })();
    const problem = await reportProblem(
      report,
      {
        git: settings.git,
        stage: settings.stage,
        worktree,
        roundDirectory: roundArtifactDirectory(root, plan.round),
        preEditHead: before.value.headRevision,
        retainedDeletions:
          report.outcome === 'authored'
            ? await retainedStageDeletions(
                root,
                plan.round,
                worktree,
                readAuthor,
                readEvaluation,
                (round, file) =>
                  readAuthorRecord(round, file, () =>
                    readRecord(file, { file, schema: prototypeObservationSchema }),
                  ),
              )
            : new Set(),
        retainedPrototype:
          settings.stage === 'prototype' ? await retainedStagePrototype(root, plan.round) : null,
      },
      task,
    );
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
        reason: `The ${settings.stage} author report is unusable: ${problem}.`,
      });
    }
    try {
      requireFindingResponses(report.findingResponses, findings, `${settings.stage} author`);
    } catch (error) {
      await rejectReport({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'stage-author',
        profile: authorProfile,
        context: attribution,
        source: null,
        output: result.value.output,
        reason: messageOf(error),
        cause: error,
      });
    }

    // The retained response keeps its revision on a replay; a new revision continues the stage's
    // cumulative authored revisions.
    const revision = author?.revision ?? (preceding?.author.revision ?? 0) + 1;
    const output: StageAuthorOutput = {
      stage: settings.stage,
      revision,
      ...report,
    };
    await writeStageArtifact(root, plan.round, stageAuthorArtifact, output);
    const artifact = path.join(
      root,
      'artifacts',
      String(plan.round),
      stageAuthorArtifact.pathFromArtifactsRoot,
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
