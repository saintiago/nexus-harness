import path from 'node:path';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../../index.js';
import { readRecord, readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import { terminalReasonSchema } from '../../terminal-reason.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stagePlanArtifact,
  stageResultArtifact,
  stageReturnExhaustionFile,
  stageRoundExhaustionFile,
  type PreparationResult,
  type PreparationStage,
} from '../artifacts.js';
import {
  readStageArtifact,
  readStagePlan,
  stageRoot,
  stageWorktree,
  writeStageArtifact,
} from '../storage.js';

/**
 * StageResult saves the terminal result envelope of one evaluated preparation stage: its outcome,
 * the assessed authored revision, its output references, the evaluation reference and a concrete
 * reason with the upstream destination when one applies. The parent publication reads this saved
 * result; the child returns only its outcome and this reference.
 */

export type StageResultSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  readonly publish: EventPublisher;
};

/** The terminal outcome the preparation workflow supplied with the invocation. */
function outcomeOf(input: unknown): PreparationResult['outcome'] {
  const outcome =
    typeof input === 'object' && input !== null
      ? (input as { readonly outcome?: unknown }).outcome
      : undefined;
  const known = ['accepted', 'skipped', 'returnUpstream', 'needsInput', 'exhausted'] as const;
  const found = known.find((candidate) => candidate === outcome);
  if (found === undefined) {
    throw new Error(
      `The preparation workflow supplied StageResult the unknown outcome ${JSON.stringify(outcome)}.`,
    );
  }
  return found;
}

/** One retained exhaustion reason for this stage, or null when none exists. */
async function readExhaustionReason(root: string): Promise<string | null> {
  for (const file of [stageRoundExhaustionFile, stageReturnExhaustionFile]) {
    const record = await readRecord(path.join(root, file), {
      file,
      schema: terminalReasonSchema,
    });
    if (record !== null) {
      return record.reason;
    }
  }
  return null;
}

/** Create StageResult over the stage area it finalizes. */
export function createStageResult(settings: StageResultSettings): BoundAction {
  return async (input?: unknown) => {
    const outcome = outcomeOf(input);
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = stageRoot(selection.workspace.root, settings.stage);
    const worktree = stageWorktree(selection.workspace.root, settings.stage);
    const plan = await readStagePlan(root);
    if (plan === null || plan.stage !== settings.stage) {
      throw new Error(`No ${settings.stage} round plan exists under "${root}" to finalize.`);
    }
    const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
    if (author === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'report.',
      );
    }
    const evaluation = await readStageArtifact(root, plan.round, stageEvaluationArtifact);
    const upstream = evaluation?.upstream ?? author.upstream;
    const reason =
      outcome === 'skipped'
        ? (author.skip?.reason ?? evaluation?.reason ?? author.summary)
        : outcome === 'returnUpstream'
          ? upstream === null
            ? author.summary
            : `${upstream.problem}; needed correction: ${upstream.correction}`
          : outcome === 'needsInput'
            ? (author.question ?? author.summary)
            : outcome === 'exhausted'
              ? ((await readExhaustionReason(root)) ?? evaluation?.reason ?? author.summary)
              : (evaluation?.reason ?? author.summary);

    const outputs: PreparationResult['outputs'] = author.documents.map((document) => ({
      path: path.resolve(worktree, document.path),
    }));
    if (author.plan.length > 0) {
      await writeStageArtifact(root, plan.round, stagePlanArtifact, author.plan);
      outputs.push({
        path: path.join(
          root,
          'artifacts',
          String(plan.round),
          stagePlanArtifact.pathFromArtifactsRoot,
        ),
      });
    }
    const evaluationRef = path.join(
      root,
      'artifacts',
      String(plan.round),
      evaluation === null
        ? stageAuthorArtifact.pathFromArtifactsRoot
        : stageEvaluationArtifact.pathFromArtifactsRoot,
    );
    const result: PreparationResult = {
      stage: settings.stage,
      outcome,
      authoredRevision: author.revision,
      outputs,
      evaluation: { path: evaluationRef },
      reason,
      returnStage: outcome === 'returnUpstream' ? (upstream?.stage ?? null) : null,
    };
    if (result.outcome === 'returnUpstream' && result.returnStage === null) {
      throw new Error(
        `The ${settings.stage} stage cannot return upstream without naming the earlier stage.`,
      );
    }
    await writeStageArtifact(root, plan.round, stageResultArtifact, result);
    const artifact = path.join(
      root,
      'artifacts',
      String(plan.round),
      stageResultArtifact.pathFromArtifactsRoot,
    );
    settings.publish(
      actionOutcomeEvent('stage-result', {
        task: selection.taskKey,
        round: plan.round,
        outcome,
        detail: `${settings.stage} · revision ${String(author.revision)}`,
        artifact: { path: artifact },
      }),
    );
    return 'saved';
  };
}
