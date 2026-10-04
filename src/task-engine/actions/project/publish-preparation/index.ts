import type { JiraAdapter } from '../../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import {
  preparationStages,
  stageResultArtifact,
  type PreparationResult,
  type PreparationStage,
  type UpstreamStage,
} from '../../preparation/artifacts.js';
import { readStageArtifact, readStagePlan, stageRoot } from '../../preparation/storage.js';
import {
  publishComment,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
} from '../../source.js';
import type { WorkflowStage } from '../../select-task/artifacts.js';
import { applyTransition } from '../../source.js';
import { advanceStage, readHandoff, readSelection, writeHandoff } from '../state.js';

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
  readonly ideaSubmitted: string;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

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
    const result = await readStageArtifact(root, plan.round, stageResultArtifact);
    if (result === null) {
      throw new Error(`No ${stage} result exists under "${root}" to publish.`);
    }

    /** Report a source condition that prevents publication. */
    function failed(reason: string): 'failed' {
      settings.publish({ source: 'publish-preparation', type: 'failed', data: { reason } });
      return 'failed';
    }

    /** The configured status one stage's work runs in. */
    function statusOf(target: PreparationStage | 'idea'): string | null {
      if (target === 'idea') {
        return settings.ideaSubmitted;
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

    /** Move the issue to the target status when it is not already there. */
    async function moveTo(status: string): Promise<string | null> {
      const issue = await readIssue(settings.jira, selection.source.issueId);
      if (statusNameOf(issue) === status) {
        return null;
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
      const comments = await readComments(settings.jira, selection.source.issueId);
      await publishComment(settings.jira, selection.source.issueId, comments, text);
    }

    /** Publish one advance to a forward or upstream stage. */
    async function advanceTo(target: PreparationStage | 'idea'): Promise<'advanced' | 'failed'> {
      const status = statusOf(target);
      if (status === null) {
        return failed(
          `No configured status mapping exists for the "${target}" stage; the ${stage} result ` +
            'cannot advance to it.',
        );
      }
      const problem = await moveTo(status);
      if (problem !== null) {
        return failed(problem);
      }
      await advanceStage(selection, settings.selectionFile, target as WorkflowStage);
      return 'advanced';
    }

    /** Publish a return, a retained question or exhaustion as Waiting for Feedback. */
    async function wait(question: string, text: string): Promise<'waiting' | 'failed'> {
      const problem = await moveTo(settings.waitingForFeedback);
      if (problem !== null) {
        return failed(problem);
      }
      await comment(text);
      const handoff = await readHandoff(selection.workspace.root);
      await writeHandoff(selection.workspace.root, {
        stage: handoff?.stage ?? stage,
        upstreamReturns: handoff?.upstreamReturns ?? 0,
        feedback: { stage, question },
        tickets: handoff?.tickets ?? [],
        publications: handoff?.publications ?? [],
      });
      return 'waiting';
    }

    const outcome: PreparationResult['outcome'] = result.outcome;
    if (outcome === 'accepted' || outcome === 'skipped') {
      if (stage === 'architecture') {
        // Architecture hands off through the parent's documentation and ticket publication.
        return 'handoff';
      }
      const next = nextStageOf(stage);
      if (next === null) {
        return failed(`The ${stage} stage has no forward stage to advance to.`);
      }
      await comment(
        `Preparation ${stage} ${outcome}: ${result.reason ?? 'the stage criteria are met.'}`,
      );
      return advanceTo(next);
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
      await comment(
        `Returning to ${target} for correction: ${
          result.reason ?? 'an upstream input needs ' + 'correction.'
        }`,
      );
      return advanceTo(target);
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
    return wait(
      reason,
      `Preparation ${stage} exhausted: ${reason}\n\nThe retained findings are in the stage ` +
        'artifacts. Please reply in a Jira comment and move the item back to the stage status to ' +
        'resume.',
    );
  };
}
