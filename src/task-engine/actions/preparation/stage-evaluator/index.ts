import path from 'node:path';
import { z } from 'zod';
import {
  actionOutcomeEvent,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../../../index.js';
import { parseAgentReport, responseFormatText } from '../../agent-reports.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageEvaluationResponseSchema,
  toFindings,
  type PreparationStage,
  type StageEvaluationOutput,
} from '../artifacts.js';
import { stageContextText } from '../context.js';
import {
  readStageArtifact,
  readStagePlan,
  stageRoot,
  stageWorktree,
  writeStageArtifact,
} from '../storage.js';

/**
 * StageEvaluator assesses the exact authored revision of one evaluated preparation round. It
 * resolves the previous round's findings, distinguishes necessary changes from optional
 * suggestions and accepts the work, the author's skip proposal or a concrete upstream return. A
 * report that assesses another revision or invents a skip the author did not propose is unusable.
 */

export type StageEvaluatorSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /** The evaluator role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** Why the evaluator's report is not a usable assessment of the current revision, or null. */
function reportProblem(
  report: z.output<typeof stageEvaluationResponseSchema>,
  authorRevision: number,
  authorProposedSkip: boolean,
): string | null {
  if (report.assessedRevision !== authorRevision) {
    return (
      `the report assesses revision ${String(report.assessedRevision)} while the authored ` +
      `revision is ${String(authorRevision)}`
    );
  }
  if (report.verdict === 'accepted-skip' && !authorProposedSkip) {
    return 'the evaluator accepted a skip the author did not propose';
  }
  if (report.verdict === 'changes-requested' && report.findings.length === 0) {
    return 'a changes-requested verdict needs at least one finding';
  }
  if (report.verdict === 'return-upstream' && report.upstream === null) {
    return 'a return-upstream verdict needs the problematic input, consequence and correction';
  }
  return null;
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
    const worktree = stageWorktree(selection.workspace.root, settings.stage);
    const plan = await readStagePlan(root);
    if (plan === null || plan.stage !== settings.stage) {
      throw new Error(
        `No ${settings.stage} round plan exists under "${root}"; the evaluator needs an opened ` +
          'round.',
      );
    }
    const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
    if (author === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'assess.',
      );
    }
    const previous = await readStageArtifact(root, plan.round, stageEvaluationArtifact);

    const context = await stageContextText({
      selection,
      plan,
      stageRoot: root,
      worktree,
      author,
      evaluation: previous,
    });
    const result = await settings.runner.run({
      operation: 'stage-evaluator',
      profile: plan.profiles.evaluator,
      workspace: { root: worktree },
      context: [
        context,
        `Assess the exact authored revision ${String(author.revision)} and resolve every prior ` +
          'finding. Accept adequate work, the author\u2019s evaluated skip or a concrete upstream ' +
          'return; separate necessary changes from optional suggestions.',
        responseFormatText(stageEvaluationResponseSchema),
      ].join('\n\n'),
      outputSchema: z.toJSONSchema(stageEvaluationResponseSchema),
      task: selection.taskKey,
    });
    if (!result.ok) {
      throw new Error(result.fault.message);
    }
    const report = parseAgentReport(
      result.value.output,
      stageEvaluationResponseSchema,
      `${settings.stage} evaluator`,
    );
    const problem = reportProblem(report, author.revision, author.outcome === 'skip-proposed');
    if (problem !== null) {
      throw new Error(`The ${settings.stage} evaluator report is unusable: ${problem}.`);
    }

    const output: StageEvaluationOutput = {
      assessedRevision: report.assessedRevision,
      verdict: report.verdict,
      reason: report.reason,
      findings: toFindings(report.findings),
      upstream: report.upstream,
    };
    await writeStageArtifact(root, plan.round, stageEvaluationArtifact, output);
    const artifact = path.join(
      root,
      'artifacts',
      String(plan.round),
      stageEvaluationArtifact.pathFromArtifactsRoot,
    );
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
