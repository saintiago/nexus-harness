import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import { preparationPublicationFailureDeclaration } from './artifacts.js';
import { retainTerminalReason } from '../../terminal-reason.js';
import type { JiraAdapter } from '../../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import {
  preparationStages,
  stageAuthorArtifact,
  stageEvaluationArtifact,
  type PreparationResult,
  type PreparationStage,
  type UpstreamStage,
} from '../../preparation/artifacts.js';
import {
  readCurrentDecision,
  readStageArtifact,
  readStageTerminal,
  readStagePlan,
  requireCurrentAcceptance,
  stageRoot,
} from '../../preparation/storage.js';
import {
  publishComment,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
} from '../../source.js';
import type { WorkflowStage } from '../../select-task/artifacts.js';
import { initialHandoff, type StageReturn } from '../../select-work/artifacts.js';
import { applyTransition } from '../../source.js';
import {
  advanceStage,
  readHandoff,
  readSelection,
  writeAwaitingStages,
  writeHandoff,
} from '../state.js';

/**
 * PublishPreparationResult validates one evaluated preparation result against the parent route,
 * publishes the human-facing outcome comment and moves the issue to the next stage, the returned
 * upstream stage or Waiting for Feedback. The selection and handoff records follow the
 * publication, so the parent's next route matches what Jira now shows. A missing mapping or
 * permitted transition is a failed publication the parent reports for attention.
 */

export type PublishPreparationSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured stage mappings; absent for a delivery-only project. */
  readonly statuses:
    | {
        readonly requirements: string;
        readonly uxProposal: string;
        readonly storybookRefinement: string;
        readonly architecture: string;
      }
    | undefined;
  /** The configured statuses the parent uses for feedback and returned ideas. */
  readonly waitingForFeedback: string;
  readonly ideaActive: string;
  readonly git: GitAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

/** The publication outcomes the project parent routes: a published terminal or a failed write. */
export type PreparationPublicationOutcome =
  'advanced' | 'waiting' | 'exhausted' | 'handoff' | 'failed';

/** The stage the parent supplied with this invocation. */
function stageOf(input: unknown): PreparationStage {
  const stage =
    typeof input === 'object' && input !== null
      ? (input as { readonly stage?: unknown }).stage
      : undefined;
  const found = preparationStages.find((candidate) => candidate === stage);
  if (found === undefined) {
    throw new Error(
      `The project workflow supplied PublishPreparationResult the unknown stage ` +
        `${JSON.stringify(stage)}.`,
    );
  }
  return found;
}

/** The next forward stage of one accepted preparation stage. */
function nextStageOf(stage: PreparationStage): PreparationStage | null {
  const index = preparationStages.indexOf(stage);
  return preparationStages[index + 1] ?? null;
}

/** Create the parent-owned preparation publication. */
export function createPublishPreparation(settings: PublishPreparationSettings): BoundAction {
  return async (input?: unknown) => {
    const stage = stageOf(input);
    const selection = await readSelection(settings.selectionFile);
    const root = stageRoot(selection.workspace.root, stage);
    const plan = await readStagePlan(root);
    if (plan === null) {
      throw new Error(`No ${stage} round plan exists under "${root}" to publish.`);
    }
    const result = await readStageTerminal(root);
    if (result === null) {
      throw new Error(`No ${stage} result exists under "${root}" to publish.`);
    }
    // Read the source state this publication writes from once: the human-facing comment and the
    // expected-status validation rest on the same observation. The captured source input is not
    // rewritten here, so Nexus's own publication acknowledgement cannot invalidate a current
    // decision's input identity.
    const issue = await readIssue(settings.jira, selection.source.issueId);
    const comments = await readComments(settings.jira, selection.source.issueId);

    /** Report a source condition that prevents publication. */
    async function failed(reason: string): Promise<'failed'> {
      await retainTerminalReason(
        path.join(root, preparationPublicationFailureDeclaration.file),
        reason,
      );
      settings.publish({ source: 'publish-preparation', type: 'failed', data: { reason } });
      return 'failed';
    }

    /** The configured status one stage's work runs in. */
    function statusOf(target: PreparationStage | 'idea'): string | null {
      if (target === 'idea') {
        return settings.ideaActive;
      }
      if (settings.statuses === undefined) {
        return null;
      }
      switch (target) {
        case 'requirements':
          return settings.statuses.requirements;
        case 'ux':
          return settings.statuses.uxProposal;
        case 'prototype':
          return settings.statuses.storybookRefinement;
        case 'architecture':
          return settings.statuses.architecture;
      }
    }

    /**
     * Move the issue to the target status when it is not already there. A target the issue already
     * holds is a repeated publication; any other current status must be one the child's own
     * selection left behind, so an unexpected human pause or reroute is preserved and reported
     * rather than overwritten.
     */
    async function moveTo(status: string, allowed: readonly string[]): Promise<string | null> {
      const current = statusNameOf(issue);
      if (current === status) {
        return null;
      }
      if (current === null || !allowed.includes(current)) {
        return (
          `Issue ${selection.taskKey} is in status "${current}" while the ${stage} publication ` +
          `expected one of ${allowed.map((value) => `"${value}"`).join(', ')}; an ` +
          'unexpected human change is preserved instead of overwritten.'
        );
      }
      const transition = await transitionInto(settings.jira, issue, status);
      if (transition.kind === 'blocked') {
        return transition.reason;
      }
      await applyTransition(settings.jira, issue.id, transition.transition);
      return null;
    }

    /** Publish the human-facing comment for this outcome. */
    async function comment(text: string): Promise<void> {
      await publishComment(settings.jira, selection.source.issueId, comments, text);
    }

    /**
     * Publish one advance to a forward or upstream stage. A return supplies the concrete finding
     * the destination stage must correct; a forward advance clears any consumed return. The
     * publication does not rewrite the captured source input: Nexus's own publication comment is
     * not new author input, and SelectWork re-captures refreshed human input on the next
     * selection. The status move is validated before the comment is published, so an unexpected
     * human state preserves both the status and the conversation.
     */
    async function advanceTo(
      target: PreparationStage | 'idea',
      returnFinding: StageReturn | null,
      text: string,
      awaitingStages: readonly PreparationStage[],
    ): Promise<'advanced' | 'failed'> {
      const status = statusOf(target);
      if (status === null) {
        return failed(
          `No configured status mapping exists for the "${target}" stage; the ${stage} result ` +
            'cannot advance to it.',
        );
      }
      const stageStatus = statusOf(stage);
      const problem = await moveTo(status, stageStatus === null ? [status] : [stageStatus, status]);
      if (problem !== null) {
        return failed(problem);
      }
      await comment(text);
      const updated = await advanceStage(
        selection,
        settings.selectionFile,
        target as WorkflowStage,
        returnFinding,
      );
      await writeAwaitingStages(updated.workspace.root, awaitingStages);
      return 'advanced';
    }

    /** Publish a return, a retained question or exhaustion as Waiting for Feedback. */
    async function wait(question: string, text: string): Promise<'waiting' | 'failed'> {
      const stageStatus = statusOf(stage);
      const problem = await moveTo(settings.waitingForFeedback, [
        ...(stageStatus === null ? [] : [stageStatus]),
        settings.waitingForFeedback,
      ]);
      if (problem !== null) {
        return failed(problem);
      }
      await comment(text);
      const handoff = await readHandoff(selection.workspace.root);
      await writeHandoff(selection.workspace.root, {
        stage: handoff?.stage ?? stage,
        upstreamReturns: handoff?.upstreamReturns ?? 0,
        feedback: { stage, question },
        return: handoff?.return ?? null,
        awaitingStages: handoff?.awaitingStages ?? [],
        tickets: handoff?.tickets ?? [],
        publications: handoff?.publications ?? [],
      });
      return 'waiting';
    }

    const outcome: PreparationResult['outcome'] = result.outcome;
    /**
     * Every stage whose retained acceptance basis no longer matches: refreshed source input,
     * changed reports or repository content require a current decision, whether the affected
     * stage stands earlier or later in the route.
     */
    async function invalidatedStages(): Promise<PreparationStage[]> {
      const changed: PreparationStage[] = [];
      for (const candidate of preparationStages) {
        if (candidate === stage) {
          continue;
        }
        const decision = await readCurrentDecision({
          issueRoot: selection.workspace.root,
          stage: candidate,
          selection,
          git: settings.git,
        });
        if (decision.kind === 'stale') changed.push(candidate);
      }
      return changed;
    }
    /** The stage position of one preparation stage in the route. */
    function indexOf(candidate: PreparationStage): number {
      return preparationStages.indexOf(candidate);
    }
    /** Add a correction interval without dropping any earlier unfinished correction. */
    async function pendingCorrection(target: UpstreamStage): Promise<PreparationStage[]> {
      const retained = await readHandoff(selection.workspace.root);
      return preparationStages.filter(
        (candidate) =>
          retained?.awaitingStages.includes(candidate) ||
          ((target === 'idea' || indexOf(candidate) >= indexOf(target)) &&
            indexOf(candidate) <= indexOf(stage)),
      );
    }
    if (outcome === 'accepted' || outcome === 'skipped') {
      // The published decision must be current: the exact authored report, captured input, relied-on
      // upstream results and assessed content the evaluator stood behind.
      const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
      const evaluation = await readStageArtifact(root, plan.round, stageEvaluationArtifact);
      if (author === null) {
        return await failed(
          `The ${stage} result has no authored report to validate before publication.`,
        );
      }
      try {
        await requireCurrentAcceptance({
          issueRoot: selection.workspace.root,
          stage,
          selection,
          round: plan.round,
          verdict: outcome === 'skipped' ? 'accepted-skip' : 'accepted',
          author,
          evaluation,
          git: settings.git,
        });
      } catch (error) {
        return await failed(
          `The ${stage} result is not a current decision: ` +
            `${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      const retained = await readHandoff(selection.workspace.root);
      const invalidated = await invalidatedStages();
      const earliest = invalidated.find(
        (candidate): candidate is Exclude<UpstreamStage, 'idea'> =>
          indexOf(candidate) < indexOf(stage),
      );
      if (earliest !== undefined) {
        // Return to the earliest stale decision, then reassess downstream work in order. Keep
        // the complete pending route so refreshed input follows the same bounded correction
        // flow as changed content, including after a restart.
        return advanceTo(
          earliest,
          {
            from: stage,
            to: earliest,
            problem:
              `The retained ${earliest} decision no longer matches its authored report, ` +
              'relied-on inputs or assessed repository content.',
            consequence: `The route cannot advance on the stale ${earliest} decision.`,
            correction:
              `Reassess the ${earliest} work against the current inputs and content and confirm ` +
              'or repair every affected downstream decision.',
          },
          `Returning to ${earliest} for reconsideration: its retained decision is no longer current.`,
          [...new Set([...(await pendingCorrection(earliest)), ...invalidated])],
        );
      }
      const awaiting = [
        ...(retained?.awaitingStages ?? []).filter((candidate) => candidate !== stage),
        ...invalidated,
      ];
      if (stage === 'architecture') {
        if (statusNameOf(issue) !== statusOf(stage)) {
          return failed(
            `Issue ${selection.taskKey} is in status "${statusNameOf(issue)}"; Architecture handoff requires its active stage status.`,
          );
        }
        // Freeze the pending work before the parent starts the handoff: Architecture's own
        // completed reassessment is cleared while any genuinely pending stage still blocks it.
        const pending = [...new Set(awaiting)];
        const handoffRecord = retained ?? initialHandoff(stage);
        await writeHandoff(selection.workspace.root, {
          ...handoffRecord,
          awaitingStages: pending,
        });
        if (pending.length > 0) {
          return failed(
            `Preparation is awaiting a current decision for the ${pending.join(', ')} stage(s); ` +
              'the Architecture handoff cannot proceed.',
          );
        }
        // Architecture hands off through the parent's documentation and ticket publication.
        return 'handoff';
      }
      const next = nextStageOf(stage);
      if (next === null) {
        return failed(`The ${stage} stage has no forward stage to advance to.`);
      }
      return advanceTo(
        next,
        null,
        `Preparation ${stage} ${outcome}: ${result.reason ?? 'the stage criteria are met.'}`,
        [...new Set(awaiting)],
      );
    }
    if (outcome === 'returnUpstream') {
      const target: UpstreamStage | null = result.returnStage;
      if (target === null) {
        return failed(`The ${stage} result names no upstream stage to return to.`);
      }
      // A return names an earlier stage of the same route; a later or equal destination is not a
      // valid upstream return.
      const order = ['idea', 'requirements', 'ux', 'prototype', 'architecture'] as const;
      if (order.indexOf(target) >= order.indexOf(stage)) {
        return failed(
          `The ${stage} result returns to "${target}", which is not an earlier stage of the route.`,
        );
      }
      const finding = result.returnFinding;
      // The correction invalidates the corrected stage's decision and every later decision up to
      // the returning stage: the parent retains them as awaiting a current decision.
      const awaiting = await pendingCorrection(target);
      return advanceTo(
        target,
        {
          from: stage,
          to: target,
          problem: finding?.problem ?? result.reason ?? `the ${stage} stage reported a problem`,
          consequence:
            finding?.consequence ??
            `The ${stage} stage cannot produce a viable result until the ${target} input is corrected.`,
          correction:
            finding?.correction ?? 'Correct the named input and return it for reassessment.',
        },
        `Returning to ${target} for correction: ${
          result.reason ?? 'an upstream input needs ' + 'correction.'
        }`,
        awaiting,
      );
    }
    if (outcome === 'needsInput') {
      const question = result.reason ?? 'the stage needs an author decision';
      return wait(
        question,
        `Author decision needed for ${stage}: ${question}\n\nPlease reply in a Jira comment and ` +
          `move the item back to the ${stage} status to resume.`,
      );
    }
    const reason = result.reason ?? 'the configured stage allowance was reached';
    const published = await wait(
      reason,
      `Preparation ${stage} exhausted: ${reason}\n\nThe retained findings are in the stage ` +
        'artifacts. Please reply in a Jira comment and move the item back to the stage status to ' +
        'resume.',
    );
    return published === 'waiting' ? 'exhausted' : published;
  };
}
