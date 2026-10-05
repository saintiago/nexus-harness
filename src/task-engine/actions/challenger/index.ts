import path from 'node:path';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import { editorResponseArtifact } from '../idea-editor/artifacts.js';
import {
  capturedIdeaText,
  ideaReportContracts,
  invokeIdeaRole,
  projectGuidanceText,
  publishIdeaOutcome,
  readRetainedIdeaReport,
  readRetainedRefinedIdea,
  responseFormatText,
  retainedHistoryText,
} from '../idea-context.js';
import {
  ideaCycleDirectory,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import {
  challengerArtifact,
  challengerResponseSchema,
  type ChallengerReport,
  type ChallengerResponse,
} from './artifacts.js';

/**
 * Challenger decides whether pursuing the current refined idea makes sense for this project. It
 * reviews the exact revised revision and the editor's response to its previous concern, and saves
 * one result bound to both: approve when there is a plausible way forward, or discuss with only
 * the few concerns that change that decision and a plain statement of the remaining obstacle for
 * the idea's author. Suggestions can accompany either result. A repeated invocation for the same
 * revision and response reuses the result it saved.
 */

export type ChallengerSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The Challenger role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/**
 * Why one Challenger response does not support the verdict it reports, or null. A verdict must
 * carry exactly the parts the challenge contract requires; the saved report is never normalized.
 */
function challengerProblem(response: ChallengerResponse, assessedRevision: number): string | null {
  if (response.verdict === 'approve' && response.concerns.length > 0) {
    return (
      `The Challenger approved refined idea revision ${String(assessedRevision)} while naming ` +
      'unresolved concerns.'
    );
  }
  if (response.verdict === 'approve' && response.obstacle !== null) {
    return (
      `The Challenger approved refined idea revision ${String(assessedRevision)} while stating ` +
      'a remaining obstacle; approval reports the obstacle as null.'
    );
  }
  if (response.verdict === 'discuss' && response.concerns.length === 0) {
    return (
      'The Challenger chose "discuss" without naming a concern, its consequence and what would ' +
      'resolve it.'
    );
  }
  if (response.verdict === 'discuss' && response.obstacle === null) {
    return (
      'The Challenger chose "discuss" without stating the remaining obstacle plainly for the ' +
      'idea\u2019s author.'
    );
  }
  return null;
}

/** Create Challenger over the refinement area it reports into. */
export function createChallenger(settings: ChallengerSettings): BoundAction {
  return async () => {
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const input = await readIdeaInput(root, plan.submission);
    const revision = await readRetainedRefinedIdea({
      root,
      workId: input.taskKey,
      plan,
      submission: plan.submission,
      cycle: plan.cycle,
      context:
        `Challenger reading the refined idea revision in force for submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} of idea ${input.taskKey}.`,
    });
    if (revision === null) {
      throw new Error(
        `No refined idea revision exists for submission ${String(plan.submission)} cycle ` +
          `${String(plan.cycle)}; the Challenger reviews a written revision.`,
      );
    }
    const turn = await readRetainedIdeaReport({
      root,
      workId: input.taskKey,
      plan,
      cycleRoot,
      declaration: editorResponseArtifact,
      contract: ideaReportContracts.editorTurn,
      context:
        `Challenger reading the editor response of submission ${String(plan.submission)} ` +
        `cycle ${String(plan.cycle)} for idea ${input.taskKey}.`,
    });
    const turnFile =
      turn === null ? null : path.join(cycleRoot, editorResponseArtifact.pathFromArtifactsRoot);
    const file = path.join(cycleRoot, challengerArtifact.pathFromArtifactsRoot);

    /** Publish the saved or reused result. */
    function reported(verdict: string): string {
      publishIdeaOutcome({
        publish: settings.publish,
        source: 'challenger',
        taskKey: input.taskKey,
        cycle: plan.cycle,
        outcome: verdict,
        detail: null,
        artifact: file,
      });
      return verdict;
    }

    const existing = await readRetainedIdeaReport({
      root,
      workId: input.taskKey,
      plan,
      cycleRoot,
      declaration: challengerArtifact,
      contract: ideaReportContracts.challenge,
      context:
        `Challenger reading its retained result for submission ${String(plan.submission)} ` +
        `cycle ${String(plan.cycle)} of idea ${input.taskKey}.`,
    });
    if (
      existing !== null &&
      existing.refinedIdea === revision.path &&
      existing.editorResponse === turnFile &&
      existing.revision === revision.value.revision
    ) {
      // This result already answers for this exact revision and response; reuse it.
      return reported(existing.verdict);
    }

    const guidance = await projectGuidanceText(root);
    const context = [
      'Decide whether pursuing this idea makes sense for this project: consider value,',
      'feasibility and avoidable complexity. Recommend approval when there is a plausible way',
      'forward, even with acknowledged uncertainty. Otherwise raise only the few concerns that',
      'change that decision, explaining the consequence and what would resolve each concern;',
      'keep optional suggestions separate from concerns, since they do not block approval.',
      'Also state the remaining obstacle plainly for the idea\u2019s author: what stopped approval',
      'and why it matters, readable without your concerns and free of internal paths, code',
      'references and instructions meant for the editor. Report null when nothing remains.',
      'Consider the editor\u2019s answers and rebuttals and explicitly withdraw concerns they',
      'resolve. The current architecture is not immutable, and a preferable alternative alone is',
      'not a veto. Do not demand detailed design or substitute a different idea.',
      await capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: null }),
      `The exact refined idea revision you review is the revision in force above: ${revision.path}`,
      turn === null || turnFile === null
        ? 'The revision stands alone: the editor has not responded to a previous concern.'
        : `The editor\u2019s response you review: ${turnFile}\n${JSON.stringify(turn, null, 2)}`,
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(challengerResponseSchema),
    ].join('\n\n');

    const outcome = await invokeIdeaRole({
      root,
      plan,
      role: 'challenger',
      operation: 'Challenger',
      reportKind: 'challenge',
      input,
      context,
      schema: challengerResponseSchema,
      runner: settings.runner,
      publish: settings.publish,
    });
    const response = outcome.report;
    const problem = challengerProblem(response, revision.value.revision);
    if (problem !== null) {
      await outcome.reject(problem);
    }

    const report: ChallengerReport = {
      ...response,
      refinedIdea: revision.path,
      editorResponse: turnFile,
      revision: revision.value.revision,
    };
    await writeCycleArtifact(cycleRoot, challengerArtifact, report);
    await outcome.resolveFeedback({ path: file }, report);
    return reported(response.verdict);
  };
}
