import path from 'node:path';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import { editorResponseArtifact } from '../idea-editor/artifacts.js';
import {
  capturedIdeaText,
  finishRetainedIdeaCorrection,
  ideaReportContracts,
  ideaReportReference,
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
import { recordIdentity } from '../report-feedback.js';
import {
  challengerArtifact,
  challengerResponseSchema,
  isBoundChallengerReport,
  type ChallengerReport,
  type ChallengerResponse,
} from './artifacts.js';

/**
 * Challenger decides whether pursuing the current refined idea makes sense for this project. It
 * reviews the exact revised revision and the editor's outcome for it, and saves one result bound
 * to both: approve when there is a plausible way forward, or discuss with the few concerns that
 * change that decision and a plain statement of the remaining obstacle for the idea's author. The
 * explanations, concerns and suggestions live in its assigned Markdown report. A repeated
 * invocation for the same revision and editor outcome reuses the result it saved; a legacy
 * approval without recorded identities is reassessed, because it cannot bind the content it
 * assessed.
 */

export type ChallengerSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The Challenger role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/**
 * Why one Challenger response does not support the verdict it reports, or null. A discuss verdict
 * needs the plain author-facing obstacle, and an approval reports none; the saved report is never
 * normalized.
 */
function challengerProblem(response: ChallengerResponse, assessedRevision: number): string | null {
  if (response.verdict === 'approve' && response.obstacle !== null) {
    return (
      `The Challenger approved refined idea revision ${String(assessedRevision)} while stating ` +
      'a remaining obstacle; approval reports the obstacle as null.'
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
    const refinedIdeaIdentity = recordIdentity(revision.value);
    const turn = await readRetainedIdeaReport({
      root,
      workId: input.taskKey,
      plan,
      cycleRoot,
      declaration: editorResponseArtifact,
      contract: ideaReportContracts.editorTurn,
      context:
        `Challenger reading the editor outcome of submission ${String(plan.submission)} ` +
        `cycle ${String(plan.cycle)} for idea ${input.taskKey}.`,
    });
    const turnFile = turn === null ? null : turn.file;
    const editorIdentity = turn === null ? null : recordIdentity(turn.value);
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
      isBoundChallengerReport(existing.value) &&
      existing.value.refinedIdea === revision.path &&
      existing.value.refinedIdeaIdentity === refinedIdeaIdentity &&
      existing.value.editorResponse === turnFile &&
      existing.value.editorIdentity === editorIdentity &&
      existing.value.revision === revision.value.revision
    ) {
      // This result already answers for this exact revision and editor outcome; reuse it and
      // finish any correction write its invocation still owes.
      await finishRetainedIdeaCorrection({
        root,
        workId: input.taskKey,
        contract: ideaReportContracts.challenge,
        read: existing,
      });
      return reported(existing.value.verdict);
    }

    const guidance = await projectGuidanceText(root);
    const context = [
      'Decide whether pursuing this idea makes sense for this project: consider value,',
      'feasibility and avoidable complexity. Recommend approval when there is a plausible way',
      'forward, even with acknowledged uncertainty. Otherwise raise only the few concerns that',
      'change that decision, explaining the consequence and what would resolve each concern;',
      'keep optional suggestions separate from concerns, since they do not block approval.',
      'Write the assessment, the concerns with their consequences and resolutions and any',
      'optional suggestions in this invocation\u2019s assigned Markdown report; the response',
      'object carries only the verdict and the applicable publication obstacle.',
      'For "discuss", state the remaining obstacle plainly for the idea\u2019s author: what',
      'stopped approval and why it matters, readable without your report and free of internal',
      'paths, code references and instructions meant for the editor. For "approve", report the',
      'obstacle as null.',
      'Consider the editor\u2019s answers and rebuttals and explicitly withdraw concerns they',
      'resolve. The current architecture is not immutable, and a preferable alternative alone is',
      'not a veto. Do not demand detailed design or substitute a different idea.',
      await capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { workId: input.taskKey, omitCurrentCycleOf: null }),
      `The exact refined idea revision you review (revision ${String(revision.value.revision)}): ` +
        `${revision.path}\n${JSON.stringify(revision.value, null, 2)}`,
      turn === null || turnFile === null
        ? 'The revision stands alone: the editor has not responded to a previous concern.'
        : `The editor outcome you review (${ideaReportReference(
            turn,
            ideaReportContracts.editorTurn,
            editorResponseArtifact,
          )}):\n${turn.narrative}`,
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(challengerResponseSchema),
    ].join('\n\n');

    const outcome = await invokeIdeaRole({
      root,
      plan,
      role: 'challenger',
      operation: 'Challenger',
      reportKind: 'challenge',
      reportName: 'challenger',
      input,
      context,
      schema: challengerResponseSchema,
      runner: settings.runner,
    });
    const response = outcome.response;
    const problem = challengerProblem(response, revision.value.revision);
    if (problem !== null) {
      await outcome.reject(problem);
    }

    const report: ChallengerReport = {
      taskKey: input.taskKey,
      role: 'challenger',
      profile: outcome.profile,
      verdict: response.verdict,
      obstacle: response.obstacle,
      refinedIdea: revision.path,
      refinedIdeaIdentity,
      editorResponse: turnFile,
      editorIdentity,
      revision: revision.value.revision,
      report: outcome.assignedReport,
      reportIdentity: outcome.reportFile.identity,
      invocationId: outcome.invocationId,
    };
    await writeCycleArtifact(cycleRoot, challengerArtifact, report);
    await outcome.finishFeedback({ path: file }, report);
    return reported(response.verdict);
  };
}
