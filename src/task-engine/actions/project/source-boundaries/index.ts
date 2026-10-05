import path from 'node:path';
import type { JiraAdapter, JiraComment } from '../../../../adapters/jira.js';
import { messageOf } from '../../../../result.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import { openingNarrativeParagraph } from '../../agent-reports.js';
import { createArtifactHelpers, roundArtifactPath } from '../../artifacts.js';
import { devArtifact, developmentReportText } from '../../develop/artifacts.js';
import { deliveryArtifact } from '../../deliver/artifacts.js';
import { readRequiredRecord, readRecord, writeRecord } from '../../records.js';
import { reviewArtifact, reviewReportText } from '../../review/artifacts.js';
import { selectionDeclaration, type Selection } from '../../select-task/artifacts.js';
import {
  applyTransition,
  publishComment,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
  updateIssueFields,
} from '../../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../../start-round/artifacts.js';
import { retainTerminalReason } from '../../terminal-reason.js';

/**
 * The parent-owned boundary actors the finite delivery child invokes: they refresh the captured
 * task and conversation at the coding and review boundaries and publish the child's milestone
 * reports to Jira. They receive the child's saved artifacts, not child implementation types, and
 * they hold the only Jira capability the finite delivery child's path has.
 */

/** The failure record a parent publication retains when it cannot publish a review milestone. */
export const reviewPublicationFailureFile = 'review-publication-failure.json';

/** Refresh the selected task and conversation in place, preserving the retained workspace. */
export function createRefreshTaskInput(settings: {
  readonly selectionFile: string;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
}): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const issue = await readIssue(settings.jira, selection.source.issueId);
    const conversation = await readComments(settings.jira, selection.source.issueId);
    await writeRecord(settings.selectionFile, {
      ...selection,
      task: issue,
      conversation,
    } satisfies Selection);
    settings.publish({
      source: 'refresh-task-input',
      type: 'refreshed',
      data: { task: selection.taskKey },
    });
    return 'refreshed';
  };
}

/** The saved development and delivery evidence of the current round, when both exist. */
async function roundEvidence(root: string): Promise<{
  readonly round: number;
  readonly development: { profile: string; narrative: string } | null;
  readonly repairsUsed: number;
  readonly escalatedFrom: string | null;
  readonly delivery: {
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
  } | null;
}> {
  const current = await readRequiredRecord(
    path.join(root, currentRoundFile),
    currentRoundDeclaration,
    'Current round',
  );
  const development = await readRecord(
    roundArtifactPath(root, current.number, devArtifact.pathFromArtifactsRoot),
    { file: devArtifact.pathFromArtifactsRoot, schema: devArtifact.schema },
  );
  const delivery = await readRecord(
    roundArtifactPath(root, current.number, deliveryArtifact.pathFromArtifactsRoot),
    { file: deliveryArtifact.pathFromArtifactsRoot, schema: deliveryArtifact.schema },
  );
  // Development reports after the initial round are executed repair turns; their recorded
  // profiles show whether the current round escalated from a weaker one.
  const helpers = createArtifactHelpers({ root });
  const earlier = await helpers.readArtifactHistory(devArtifact);
  const escalatedFrom =
    development === null
      ? null
      : (earlier
          .map((report) => report.value.profile)
          .filter((profile) => profile !== development.profile)
          .at(-1) ?? null);
  return {
    round: current.number,
    development:
      development === null
        ? null
        : {
            profile: development.profile,
            // The concise comment carries the report's opening paragraph; a retained combined
            // report supplies its former narrative.
            narrative:
              openingNarrativeParagraph(await developmentReportText(development)) ??
              `the change is ready for review; see the round ${String(current.number)} ` +
                'development report',
          },
    repairsUsed: earlier.length,
    escalatedFrom,
    delivery:
      delivery === null
        ? null
        : {
            pullRequestNumber: delivery.pullRequestNumber,
            pullRequestUrl: delivery.pullRequestUrl,
          },
  };
}

/**
 * Publish the delivered pull request: retain the PR field, move the issue into its review status
 * and publish the concise developer comment from the child's saved delivery and development
 * artifacts. A missing permitted transition is a failed publication.
 */
export function createPublishDeliveryReport(settings: {
  readonly selectionFile: string;
  readonly pullRequestField: string;
  /** The configured status the selection claim left the task in. */
  readonly inProgressStatus: string;
  readonly reviewStatus: string;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
}): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const evidence = await roundEvidence(selection.workspace.root);
    if (evidence.delivery === null) {
      settings.publish({
        source: 'publish-delivery',
        type: 'failed',
        data: { reason: 'the child published no delivery artifact to report' },
      });
      return 'failed';
    }

    /** Report a source condition that prevents publication. */
    function failed(reason: string): 'failed' {
      settings.publish({ source: 'publish-delivery', type: 'failed', data: { reason } });
      return 'failed';
    }

    const issue = await readIssue(settings.jira, selection.source.issueId);
    const comments = await readComments(settings.jira, selection.source.issueId);
    const status = statusNameOf(issue);
    if (status !== settings.inProgressStatus && status !== settings.reviewStatus) {
      return failed(
        `Issue ${selection.taskKey} is in status "${status ?? 'unknown'}" while the delivery ` +
          `report expected "${settings.inProgressStatus}" or "${settings.reviewStatus}"; an ` +
          'unexpected human change is preserved instead of overwritten.',
      );
    }
    if (issue.fields[settings.pullRequestField] !== evidence.delivery.pullRequestUrl) {
      await updateIssueFields(settings.jira, issue.id, {
        pullRequest: evidence.delivery.pullRequestUrl,
      });
    }
    if (statusNameOf(issue) !== settings.reviewStatus) {
      const transition = await transitionInto(settings.jira, issue, settings.reviewStatus);
      if (transition.kind === 'blocked') {
        return failed(transition.reason);
      }
      await applyTransition(settings.jira, issue.id, transition.transition);
    }
    const profile = evidence.development?.profile ?? 'unknown profile';
    const summary = evidence.development?.narrative ?? 'the change is ready for review';
    const escalation =
      evidence.escalatedFrom === null
        ? ''
        : `, escalated from "${evidence.escalatedFrom}" to "${profile}"`;
    await publishComment(
      settings.jira,
      issue.id,
      comments,
      [
        `profile: ${profile}`,
        summary,
        ...(evidence.repairsUsed > 0
          ? [`Repairs used: ${String(evidence.repairsUsed)}${escalation}.`]
          : []),
        `Pull request: ${evidence.delivery.pullRequestUrl}`,
      ].join('\n'),
    );
    settings.publish({
      source: 'publish-delivery',
      type: 'published',
      data: {
        task: selection.taskKey,
        round: evidence.round,
        pullRequest: evidence.delivery.pullRequestUrl,
      },
    });
    return 'published';
  };
}

/**
 * Publish the review milestone: a concise ticket comment beginning with the review outcome and
 * profile, naming what to improve when changes were requested. Review publication on GitHub
 * remains the Review action's own responsibility.
 */
export function createPublishReviewFeedback(settings: {
  readonly selectionFile: string;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
}): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const current = await readRequiredRecord(
      path.join(selection.workspace.root, currentRoundFile),
      currentRoundDeclaration,
      'Current round',
    );
    const reviewFile = roundArtifactPath(
      selection.workspace.root,
      current.number,
      reviewArtifact.pathFromArtifactsRoot,
    );
    const review = await readRecord(reviewFile, {
      file: reviewArtifact.pathFromArtifactsRoot,
      schema: reviewArtifact.schema,
    });
    /** Report a condition that prevents publication, retaining the reason for the terminal handoff. */
    async function failed(reason: string): Promise<'failed'> {
      await retainTerminalReason(
        roundArtifactPath(selection.workspace.root, current.number, reviewPublicationFailureFile),
        reason,
      );
      settings.publish({ source: 'publish-review', type: 'failed', data: { reason } });
      return 'failed';
    }

    if (review === null) {
      return failed('the child published no review artifact to report');
    }
    const outcome = review.verdict === 'approved' ? 'Review approved' : 'Review requested changes';
    const opening = openingNarrativeParagraph(await reviewReportText(review));
    const text =
      opening === null
        ? `${outcome} (profile ${review.profile}); see the round ${String(current.number)} ` +
          `review report for revision ${review.headRevision}.`
        : `${outcome} (profile ${review.profile}): ${opening}`;

    let comments: readonly JiraComment[];
    try {
      comments = await readComments(settings.jira, selection.source.issueId);
      await publishComment(settings.jira, selection.source.issueId, comments, text);
    } catch (error) {
      return failed(`the review comment could not be published: ${messageOf(error)}`);
    }
    settings.publish({
      source: 'publish-review',
      type: 'published',
      data: { task: selection.taskKey, round: current.number, verdict: review.verdict },
    });
    return 'published';
  };
}

/** The absolute path of the retained review-publication failure of one round, when it exists. */
export function reviewPublicationFailurePath(root: string, round: number): string {
  return path.join(root, 'artifacts', String(round), reviewPublicationFailureFile);
}
