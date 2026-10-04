import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../../../../result.js';
import {
  actionOutcomeEvent,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../../../index.js';
import { parseAgentReport, responseFormatText } from '../../agent-reports.js';
import { requireFindingResponses } from '../../finding-responses.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  stageAuthorArtifact,
  stageAuthorResponseSchema,
  type PreparationStage,
  type StageAuthorOutput,
  type StageAuthorResponse,
} from '../artifacts.js';
import { stageContextText } from '../context.js';
import {
  precedingStageWork,
  priorStageFindings,
  readStageArtifact,
  readStagePlan,
  stageRoot,
  stageWorktree,
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

/** True when the document path names an existing file inside the stage worktree. */
async function documentExists(worktree: string, relative: string): Promise<boolean> {
  if (path.isAbsolute(relative)) {
    return false;
  }
  const file = path.resolve(worktree, relative);
  const inside = path.relative(worktree, file);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    return false;
  }
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new Error(`Document "${file}" could not be read: ${messageOf(error)}`, { cause: error });
  }
}

/** Why the author's report is not a usable proposal, or null. */
async function reportProblem(
  report: StageAuthorResponse,
  worktree: string,
  task: 'propose' | 'respond',
): Promise<string | null> {
  if (task === 'respond' && report.outcome === 'skip-proposed') {
    return 'a revision round cannot propose a skip; the evaluator asked for changes';
  }
  if (report.outcome === 'authored') {
    if (report.documents.length === 0) {
      return 'authored work must name at least one document';
    }
    for (const document of report.documents) {
      if (!(await documentExists(worktree, document.path))) {
        return `the named document "${document.path}" does not exist in the worktree`;
      }
    }
    return null;
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
    const worktree = stageWorktree(selection.workspace.root, settings.stage);
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

    const context = await stageContextText({
      selection,
      plan,
      stageRoot: root,
      worktree,
      author: task === 'respond' ? (preceding?.author ?? author) : author,
      evaluation: task === 'respond' ? (preceding?.evaluation ?? null) : null,
    });
    const result = await settings.runner.run({
      operation: 'stage-author',
      profile: plan.profiles.author,
      // The invocation's workspace is the stage area root; AgentRuntime resolves its worktree/.
      workspace: { root },
      context: [
        context,
        task === 'propose'
          ? 'Propose this round\u2019s work or an evaluated skip for the exact revision you author.'
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
    const problem = await reportProblem(report, worktree, task);
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
