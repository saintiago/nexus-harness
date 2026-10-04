import path from 'node:path';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../../index.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import { retainTerminalReason } from '../../terminal-reason.js';
import {
  stageRoundExhaustionFile,
  stageRoundPlanDeclaration,
  type PreparationStage,
  type StageRoundPlan,
} from '../artifacts.js';
import {
  ensureStageRound,
  readStageArtifact,
  readStagePlan,
  stageRoot,
  writeStagePlan,
} from '../storage.js';
import { stageEvaluationArtifact } from '../artifacts.js';

/**
 * StartStageRound plans and opens one evaluated preparation round. The "new" route opens round 1
 * where the author proposes work or a skip; the "next" route opens the following round after the
 * evaluator requested changes. The configured allowance bounds the rounds: a route that would
 * exceed it returns exhausted without opening a round, and the retained reason lets the terminal
 * handoff state it after a restart. Repeating a route that opened the current round reuses it.
 */

export type StartStageRoundSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /** The configured author and evaluator profiles of this stage. */
  readonly profiles: {
    readonly author: string;
    readonly evaluator: string;
  };
  /** The configured maximum number of rounds this stage may open. */
  readonly maxRounds: number;
  readonly publish: EventPublisher;
};

/** The route the preparation workflow supplied with the invocation. */
function routeOf(input: unknown): StageRoundPlan['route'] {
  const route =
    typeof input === 'object' && input !== null
      ? (input as { readonly route?: unknown }).route
      : undefined;
  if (route === 'new' || route === 'next') {
    return route;
  }
  throw new Error(
    `The preparation workflow supplied StartStageRound the unknown route ${JSON.stringify(route)}.`,
  );
}

/** Create StartStageRound over the stage area it plans. */
export function createStartStageRound(settings: StartStageRoundSettings): BoundAction {
  return async (input?: unknown) => {
    const route = routeOf(input);
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = stageRoot(selection.workspace.root, settings.stage);
    const planFile = path.join(root, stageRoundPlanDeclaration.file);

    /** Publish the opened round and its saved plan. */
    function opened(plan: StageRoundPlan): 'opened' {
      settings.publish(
        actionOutcomeEvent('start-stage-round', {
          task: selection.taskKey,
          round: plan.round,
          outcome: 'opened',
          detail: `${settings.stage} · round ${String(plan.round)}`,
          artifact: { path: planFile },
        }),
      );
      return 'opened';
    }

    /** Retain the reason and report the configured round allowance as exhausted. */
    async function exhausted(current: StageRoundPlan | null): Promise<'exhausted'> {
      const reached = current?.round ?? settings.maxRounds;
      const reason =
        `The configured maximum of ${String(settings.maxRounds)} preparation ` +
        `round${settings.maxRounds === 1 ? '' : 's'} for the ${settings.stage} stage is reached; ` +
        'another round would exceed it.';
      // The reason is retained before it is stated, so the terminal handoff reconstructs it after
      // a restart of the workflow binding.
      await retainTerminalReason(path.join(root, stageRoundExhaustionFile), reason);
      settings.publish({
        source: 'start-stage-round',
        type: 'exhausted',
        data: { reason, reached },
      });
      return 'exhausted';
    }

    /** The retained plan this route can reuse, or null. */
    async function reusablePlan(): Promise<StageRoundPlan | null> {
      try {
        return await readStagePlan(root);
      } catch {
        return null;
      }
    }

    if (route === 'new') {
      const current = await reusablePlan();
      if (current !== null && current.route === 'new' && current.stage === settings.stage) {
        await ensureStageRound(root, current.round);
        return opened(current);
      }
      if (settings.maxRounds < 1) {
        return exhausted(null);
      }
      const plan: StageRoundPlan = {
        stage: settings.stage,
        round: 1,
        route: 'new',
        profiles: { ...settings.profiles },
      };
      await ensureStageRound(root, plan.round);
      await writeStagePlan(root, plan);
      return opened(plan);
    }

    const current = await readStagePlan(root);
    if (current === null || current.stage !== settings.stage) {
      throw new Error(
        `No ${settings.stage} round plan exists at "${planFile}"; the next route needs an ` +
          'opened round.',
      );
    }
    if (
      current.route === 'next' &&
      (await readStageArtifact(root, current.round, stageEvaluationArtifact)) === null
    ) {
      // This route opened the round but the evaluator has not reported yet; reuse it.
      return opened(current);
    }
    const round = current.round + 1;
    if (round > settings.maxRounds) {
      return exhausted(current);
    }
    const plan: StageRoundPlan = {
      stage: settings.stage,
      round,
      route: 'next',
      profiles: { ...settings.profiles },
    };
    await ensureStageRound(root, plan.round);
    await writeStagePlan(root, plan);
    return opened(plan);
  };
}
