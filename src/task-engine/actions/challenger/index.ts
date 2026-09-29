import path from 'node:path';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import { editorResponseArtifact } from '../idea-editor/artifacts.js';
import {
  capturedIdeaText,
  invokeIdeaRole,
  projectGuidanceText,
  publishIdeaOutcome,
  responseFormatText,
  retainedHistoryText,
} from '../idea-context.js';
import {
  ideaCycleDirectory,
  latestRefinedIdea,
  readCycleArtifact,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import {
  challengerArtifact,
  challengerResponseSchema,
  type ChallengerReport,
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

/** Create Challenger over the refinement area it reports into. */
export function createChallenger(settings: ChallengerSettings): BoundAction {
  return async () => {
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const input = await readIdeaInput(root, plan.submission);
    const revision = await latestRefinedIdea(root, plan.submission, plan.cycle);
    if (revision === null) {
      throw new Error(
        `No refined idea revision exists for submission ${String(plan.submission)} cycle ` +
          `${String(plan.cycle)}; the Challenger reviews a written revision.`,
      );
    }
    const turn = await readCycleArtifact(cycleRoot, editorResponseArtifact);
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

    const existing = await readCycleArtifact(cycleRoot, challengerArtifact);
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

    const response = await invokeIdeaRole({
      root,
      plan,
      role: 'challenger',
      operation: 'Challenger',
      input,
      context,
      schema: challengerResponseSchema,
      runner: settings.runner,
      publish: settings.publish,
    });
    if (response.verdict === 'approve' && response.concerns.length > 0) {
      throw new Error(
        `The Challenger approved refined idea revision ${String(revision.value.revision)} while ` +
          'naming unresolved concerns.',
      );
    }
    if (response.verdict === 'discuss' && response.concerns.length === 0) {
      throw new Error(
        'The Challenger chose "discuss" without naming a concern, its consequence and what ' +
          'would resolve it.',
      );
    }
    if (response.verdict === 'discuss' && response.obstacle === null) {
      throw new Error(
        'The Challenger chose "discuss" without stating the remaining obstacle plainly for the ' +
          'idea\u2019s author.',
      );
    }

    const report: ChallengerReport = {
      ...response,
      refinedIdea: revision.path,
      editorResponse: turnFile,
      revision: revision.value.revision,
    };
    await writeCycleArtifact(cycleRoot, challengerArtifact, report);
    return reported(response.verdict);
  };
}
