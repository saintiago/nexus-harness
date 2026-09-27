import path from 'node:path';
import type { IdeaRole } from '../../../agent-runtime/index.js';
import { actionOutcomeEvent, type EventPublisher } from '../../index.js';
import { challengerArtifact } from '../challenger/artifacts.js';
import {
  ensureIdeaCycle,
  ideaCycleDirectory,
  listIdeaSubmissions,
  openIdeaSubmission,
  readCycleArtifact,
  submissionDecided,
  writeIdeaInput,
} from '../idea-storage.js';
import { readCurrentPlan, saveCurrentPlan } from '../round-storage.js';
import type { IdeaInput } from '../select-idea/artifacts.js';
import {
  ideaRoundPlanDeclaration,
  ideaRoundPlanFile,
  type IdeaRoundPlan,
  type IdeaRoute,
} from './artifacts.js';

/**
 * StartIdeaRound plans and opens one conversation cycle. XState supplies the route it took: "new"
 * opens the next submission at cycle 1, and "next" opens the next cycle of the active submission
 * after the Challenger asked to discuss. The action reads the refinement area's retained history,
 * records the four role profiles the cycle runs and replaces the current-round record. The
 * configured cycle limit bounds the conversation: a route that would exceed it returns exhausted
 * without opening a cycle, so approval at the limit still succeeds.
 *
 * Repeating a route that opened the current cycle (a restarted invocation) reuses that cycle
 * instead of opening another. A missing or invalid current plan is an error for the next route;
 * earlier submissions and cycles are retained in place as history.
 */

export type StartIdeaRoundSettings = {
  /** The refinement area the plan, submissions and cycles live in. */
  readonly workspace: { readonly root: string };
  /** The captured idea input the new submission retains. */
  readonly input: IdeaInput;
  /** The configured profile of each idea refinement role. */
  readonly profiles: Readonly<Record<IdeaRole, string>>;
  /** The configured maximum number of conversation cycles per selection. */
  readonly maxCycles: number;
  readonly publish: EventPublisher;
};

/** The route the idea workflow supplied with the invocation. */
function routeOf(input: unknown): IdeaRoute {
  const route =
    typeof input === 'object' && input !== null
      ? (input as { readonly route?: unknown }).route
      : undefined;
  if (route === 'new' || route === 'next') {
    return route;
  }
  throw new Error(
    `The idea workflow supplied StartIdeaRound the unknown route ${JSON.stringify(route)}.`,
  );
}

/** True when one cycle already carries the Challenger's result. */
async function cycleChallenged(root: string, submission: number, cycle: number): Promise<boolean> {
  const cycleRoot = ideaCycleDirectory(root, submission, cycle);
  return (await readCycleArtifact(cycleRoot, challengerArtifact)) !== null;
}

/** Create StartIdeaRound over the refinement area it plans. */
export function createStartIdeaRound(
  settings: StartIdeaRoundSettings,
): (input?: unknown) => Promise<string> {
  const root = settings.workspace.root;
  const planFile = path.join(root, ideaRoundPlanFile);

  /** Publish the opened cycle and its saved plan. */
  function opened(plan: IdeaRoundPlan): 'opened' {
    settings.publish(
      actionOutcomeEvent('start-idea-round', {
        task: settings.input.taskKey,
        round: null,
        cycle: plan.cycle,
        outcome: 'opened',
        detail: `submission ${String(plan.submission)} · ${String(Object.keys(plan.profiles).length)} roles`,
        artifact: { path: planFile },
      }),
    );
    return 'opened';
  }

  /** Open the next submission at cycle 1 with every configured idea role. */
  async function openSubmission(): Promise<string> {
    const submissions = await listIdeaSubmissions(root);
    const submission = (submissions.at(-1) ?? 0) + 1;
    await openIdeaSubmission(root, submission);
    await writeIdeaInput(root, submission, settings.input);
    const plan: IdeaRoundPlan = {
      submission,
      cycle: 1,
      route: 'new',
      profiles: settings.profiles,
    };
    await ensureIdeaCycle(root, submission, plan.cycle);
    await saveCurrentPlan(planFile, plan);
    return opened(plan);
  }

  /** Open the next cycle of the active submission, or report the configured cycle limit. */
  async function openCycle(current: IdeaRoundPlan): Promise<string> {
    const cycle = current.cycle + 1;
    if (cycle > settings.maxCycles) {
      const reason =
        `The configured maximum of ${String(settings.maxCycles)} conversation ` +
        `cycle${settings.maxCycles === 1 ? '' : 's'} for this selection is reached; another ` +
        'cycle would exceed it.';
      settings.publish({ source: 'start-idea-round', type: 'exhausted', data: { reason } });
      return 'exhausted';
    }
    const plan: IdeaRoundPlan = {
      submission: current.submission,
      cycle,
      route: 'next',
      profiles: settings.profiles,
    };
    await ensureIdeaCycle(root, plan.submission, plan.cycle);
    await saveCurrentPlan(planFile, plan);
    return opened(plan);
  }

  return async (input?: unknown) => {
    const route = routeOf(input);
    const current = await readCurrentPlan(planFile, ideaRoundPlanDeclaration);

    if (route === 'new') {
      if (
        current !== null &&
        current.route === 'new' &&
        !(await submissionDecided(root, current.submission))
      ) {
        // The submission this run opened is still unfinished; repeating the route reuses it.
        await ensureIdeaCycle(root, current.submission, current.cycle);
        return opened(current);
      }
      return openSubmission();
    }

    if (current === null) {
      throw new Error(
        `No idea round plan exists at "${planFile}"; the next route needs an opened submission.`,
      );
    }
    if (
      current.route === route &&
      !(await cycleChallenged(root, current.submission, current.cycle))
    ) {
      // The route that opened this cycle is repeated before its Challenger reported; reuse it.
      return opened(current);
    }
    return openCycle(current);
  };
}
