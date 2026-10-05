import path from 'node:path';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../../index.js';
import { readRecord, readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  handoffFile,
  parentAreaDirectory,
  parentHandoffDeclaration,
} from '../../select-work/artifacts.js';
import { retainTerminalReason } from '../../terminal-reason.js';
import {
  stageAuthorArtifact,
  stageRoundExhaustionFile,
  stageRoundPlanDeclaration,
  type PreparationStage,
  type StageRoundPlan,
} from '../artifacts.js';
import {
  ensureStageRound,
  readStageArtifact,
  readStagePlan,
  readStageResult,
  stageRoot,
  writeStagePlan,
} from '../storage.js';

/**
 * StartStageRound plans and opens one evaluated preparation round. The "new" route opens round 1
 * where the author proposes work or a skip; the "next" route opens the following round after the
 * evaluator requested changes. Rounds are cumulative across restarts and across a stage's later
 * visits: a completed round is never reused or overwritten, and a route that would exceed the
 * configured allowance returns exhausted without opening a round. The retained reason lets the
 * terminal handoff state exhaustion after a restart. An unfinished opening is reused, so a replay
 * continues the round it already opened.
 */

export type StartStageRoundSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /**
   * The configured author ladder and evaluator profile of this stage. The first round selects the
   * first author; a later round selects the next, which escalates the prototype author from Flash
   * to Sol and never downgrades.
   */
  readonly profiles: {
    readonly authors: readonly string[];
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
  if (settings.profiles.authors.length === 0) {
    throw new Error(`The ${settings.stage} stage configures no author profile.`);
  }

  /** The author profile of one round: the ladder advances with each round and never downgrades. */
  function authorOf(round: number): string {
    const index = Math.min(round, settings.profiles.authors.length) - 1;
    return settings.profiles.authors[index] as string;
  }

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

    /** The retained plan, or null when none exists or it cannot be read. */
    async function retainedPlan(): Promise<StageRoundPlan | null> {
      try {
        return await readStagePlan(root);
      } catch {
        return null;
      }
    }

    if (route === 'new') {
      const current = await retainedPlan();
      // A pending reassessment opens as such: the parent retained that an upstream correction
      // requires this stage's current decision before the route continues.
      const handoff = await readRecord(
        path.join(selection.workspace.root, parentAreaDirectory, handoffFile),
        parentHandoffDeclaration,
      );
      const reassessing = handoff?.awaitingStages.includes(settings.stage) ?? false;
      if (
        current !== null &&
        current.stage === settings.stage &&
        (await readStageResult(root, current.round)) === null &&
        (await readStageArtifact(root, current.round, stageAuthorArtifact)) === null
      ) {
        // This stage visit already opened its round and has not finished it; the replay continues
        // that round instead of allocating another one.
        await ensureStageRound(root, current.round);
        if (reassessing && current.route !== 'reassess') {
          const plan: StageRoundPlan = { ...current, route: 'reassess' };
          await writeStagePlan(root, plan);
          return opened(plan);
        }
        return opened(current);
      }
      // The stage's rounds are cumulative across its visits: a later visit continues after the
      // completed rounds instead of overwriting them with round 1.
      const round = (current?.round ?? 0) + 1;
      if (round > settings.maxRounds) {
        return exhausted(current);
      }
      const plan: StageRoundPlan = {
        stage: settings.stage,
        round,
        route: reassessing ? 'reassess' : 'new',
        profiles: { author: authorOf(round), evaluator: settings.profiles.evaluator },
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
    if ((await readStageArtifact(root, current.round, stageAuthorArtifact)) === null) {
      // This route opened the round but the author has not responded yet; the replay reuses it.
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
      profiles: { author: authorOf(round), evaluator: settings.profiles.evaluator },
    };
    await ensureStageRound(root, plan.round);
    await writeStagePlan(root, plan);
    return opened(plan);
  };
}
