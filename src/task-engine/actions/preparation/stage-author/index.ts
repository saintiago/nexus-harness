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
  type PreparationStage,
  type StageAuthorOutput,
  type StageAuthorResponse,
} from '../artifacts.js';
import { stageContextText } from '../context.js';
import { checkoutRelative } from '../evaluation-content.js';
import {
  evidenceFilePath,
  observationScopeProblem,
  observationSubmissionProblem,
  prototypeObservationSchema,
  readPrototypeObservation,
  type PrototypeObservation,
} from '../observation.js';
import {
  precedingStageEvaluation,
  precedingStageWork,
  priorStageFindings,
  preparationWorktree,
  readStageArtifact,
  readStagePlan,
  readStageTerminal,
  roundArtifactDirectory,
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
): Promise<ReadonlySet<string>> {
  const deleted = new Set<string>();
  for (const retained of await stageRounds(root)) {
    if (retained > round) break;
    const author = await readStageArtifact(root, retained, stageAuthorArtifact);
    if (author?.outcome !== 'authored') continue;
    const evaluation = await readStageArtifact(root, retained, stageEvaluationArtifact);
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
        const observation = await readRecord(file, { file, schema: prototypeObservationSchema });
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
  task: 'propose' | 'respond',
): Promise<string | null> {
  if (task === 'respond' && report.outcome === 'skip-proposed') {
    return 'a revision round cannot propose a skip; the evaluator asked for changes';
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
  if (report.sourcePaths.length > 0) {
    return 'only authored work may declare stage-owned source paths';
  }
  if (report.outcome === 'skip-proposed') {
    return report.skip === null || report.skip.references.length === 0
      ? 'a proposed skip needs its reason and references to the satisfying inputs'
      : null;
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
    const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
    // A response round revises the preceding authored revision in answer to the preceding
    // evaluation; the new round's own directory holds only the response it produces.
    const preceding = await precedingStageWork(root, plan.round);
    if (task === 'respond' && author === null && preceding === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'revise and no earlier round retains one.',
      );
    }
    const findings = await priorStageFindings(root, plan);

    // A response round and a pending reassessment both revise the preceding authored revision
    // rather than starting from nothing; the new round's own directory holds only its response.
    const revising = task === 'respond' || plan.route === 'reassess';
    const context = await stageContextText({
      selection,
      plan,
      stageRoot: root,
      worktree,
      author: revising ? (preceding?.author ?? author) : author,
      evaluation: revising ? await precedingStageEvaluation(root, plan.round) : null,
      retained:
        plan.route === 'reassess'
          ? await (async () => {
              const terminal = await readStageTerminal(root);
              return terminal === null
                ? null
                : { outcome: terminal.outcome, reason: terminal.reason };
            })()
          : null,
    });
    // The pre-invocation revision is the evidence that a deletion committed during the invocation
    // was tracked before this edit; the post-invocation head no longer retains it.
    const before = await settings.git.inspectRepository(worktree);
    if (!before.ok) {
      throw new Error(before.fault.message);
    }
    const result = await settings.runner.run({
      operation: 'stage-author',
      profile: plan.profiles.author,
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
    const report = parseAgentReport(
      result.value.output,
      stageAuthorResponseSchema,
      `${settings.stage} author`,
    );
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
            ? await retainedStageDeletions(root, plan.round, worktree)
            : new Set(),
      },
      task,
    );
    if (problem !== null) {
      throw new Error(`The ${settings.stage} author report is unusable: ${problem}.`);
    }
    requireFindingResponses(report.findingResponses, findings, `${settings.stage} author`);

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
