import type { GitHubAdapter } from '../../../adapters/github.js';
import type { JiraAdapter, JiraIssue } from '../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import { createArtifactHelpers } from '../artifacts.js';
import { deliveryArtifact } from '../deliver/artifacts.js';
import { readRecord } from '../records.js';
import { reviewArtifact } from '../review/artifacts.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { completionArtifact, type CompletionOutput } from './artifacts.js';

/**
 * CompleteTask confirms that the approved delivered head is merged and that every configured
 * post-merge check succeeded for the merge revision, records that evidence and moves the ticket to
 * its completed status. Pending merge or check work stays pending within the configured completion
 * wait; failed checks, a changed head and expiry cannot produce completed.
 *
 * The recorded completion evidence is reused on repetition, so only the outstanding completion
 * step runs again. A merged pull request or an already-completed ticket does not by itself establish
 * that the post-merge checks passed. Adapter faults are execution errors.
 */

export type CompleteTaskSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured GitHub repository the pull request belongs to. */
  readonly repository: string;
  /** The configured review check the approved head must carry. */
  readonly reviewCheck: string;
  /** The configured Nexus Lens App identity that owns the review check. */
  readonly nexusLens: { readonly appId: number };
  /** The configured post-merge checks and the workflows that produce them. */
  readonly postMergeChecks: readonly { readonly name: string; readonly workflow: string }[];
  /** The configured completion polling interval and total wait, in seconds. */
  readonly completion: {
    readonly pollIntervalSeconds: number;
    readonly waitLimitSeconds: number;
  };
  /** The configured Jira status the completed task holds. */
  readonly doneStatus: string;
  readonly github: GitHubAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
  /** Wait before the next completion poll; supplied so tests control time instead of passing it. */
  readonly wait: (milliseconds: number) => Promise<void>;
};

/** Read the current source issue; a source access failure is an execution error. */
async function readIssue(jira: JiraAdapter, issueId: string): Promise<JiraIssue> {
  const result = await jira.readIssue(issueId);
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return result.value;
}

/** The issue's current status name, or null when the field cannot be read. */
function statusNameOf(issue: JiraIssue): string | null {
  const status = issue.fields.status;
  if (typeof status !== 'object' || status === null) {
    return null;
  }
  const name = (status as { readonly name?: unknown }).name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/** One observation of the publication's merge state. */
type MergeObservation =
  | { readonly kind: 'merged'; readonly revision: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'pending' };

/** One observation of the configured post-merge checks for the merge revision. */
type PostMergeObservation =
  | { readonly kind: 'passed'; readonly checks: CompletionOutput['checks'] }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'pending'; readonly reason: string };

/** Create CompleteTask over the selected workspace, configured checks and adapters. */
export function createCompleteTask(settings: CompleteTaskSettings): BoundAction {
  return async () => {
    const selection = await readRecord(settings.selectionFile, selectionDeclaration);
    if (selection === null) {
      throw new Error(`Selection at "${settings.selectionFile}" does not exist.`);
    }
    const helpers = createArtifactHelpers(selection.workspace);
    const [delivery, review] = await helpers.readInputArtifacts(deliveryArtifact, reviewArtifact);
    const [recorded] = await helpers.readOptionalInputArtifacts(completionArtifact);
    const taskKey = selection.taskKey;
    const issueId = selection.source.issueId;

    /** Report an observed condition that prevents completion. */
    function fail(reason: string): 'failed' {
      settings.publish({ source: 'complete-task', type: 'failed', data: { reason } });
      return 'failed';
    }

    // Only an approval of the delivered head completes the task; a changed head does not inherit
    // the old approval.
    if (review.verdict !== 'approved') {
      return fail(
        `The review verdict is "${review.verdict}"; only an approved review completes the task.`,
      );
    }
    if (review.headRevision !== delivery.headRevision) {
      return fail(
        `The review approved revision ${review.headRevision}, not the delivered ` +
          `${delivery.headRevision}; the approval is not transferred.`,
      );
    }

    const startedAt = Date.now();
    const waitLimitMs = settings.completion.waitLimitSeconds * 1000;
    const pollIntervalMs = settings.completion.pollIntervalSeconds * 1000;

    /** Read the publication and report its merge state for the delivered head. */
    async function observeMerge(): Promise<MergeObservation> {
      const pull = await settings.github.readPullRequest(
        settings.repository,
        delivery.pullRequestNumber,
      );
      if (!pull.ok) {
        throw new Error(pull.fault.message);
      }
      if (pull.value.headRevision !== delivery.headRevision) {
        return {
          kind: 'failed',
          reason:
            `Pull request #${delivery.pullRequestNumber} is at revision ` +
            `${pull.value.headRevision}, not the delivered ${delivery.headRevision}; the ` +
            'approval is not transferred.',
        };
      }
      if (pull.value.merged) {
        if (pull.value.mergeRevision === null) {
          throw new Error(
            `Pull request #${delivery.pullRequestNumber} reports a merge without a merge revision.`,
          );
        }
        return { kind: 'merged', revision: pull.value.mergeRevision };
      }
      if (pull.value.state === 'closed') {
        return {
          kind: 'failed',
          reason: `Pull request #${delivery.pullRequestNumber} is closed without being merged.`,
        };
      }
      return { kind: 'pending' };
    }

    /** Observe the merge within the configured completion wait. */
    async function waitForMerge(): Promise<
      | { readonly kind: 'merged'; readonly revision: string }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      for (;;) {
        const observed = await observeMerge();
        if (observed.kind !== 'pending') {
          return observed;
        }
        if (Date.now() - startedAt >= waitLimitMs) {
          return {
            kind: 'failed',
            reason:
              `Pull request #${delivery.pullRequestNumber} is not merged and the configured ` +
              `completion wait of ${settings.completion.waitLimitSeconds}s expired.`,
          };
        }
        await settings.wait(pollIntervalMs);
      }
    }

    /** Read the configured producers' results for the merge revision. */
    async function observePostMergeChecks(mergeRevision: string): Promise<PostMergeObservation> {
      const runs = await settings.github.readWorkflowRuns(
        settings.repository,
        mergeRevision,
        settings.postMergeChecks.map((check) => check.workflow),
      );
      if (!runs.ok) {
        throw new Error(runs.fault.message);
      }
      const evidence: CompletionOutput['checks'] = [];
      const problems: string[] = [];
      const pending: string[] = [];
      for (const check of settings.postMergeChecks) {
        const matching = runs.value.filter(
          (run) =>
            run.revision === mergeRevision &&
            (run.name === check.workflow || run.path === check.workflow),
        );
        if (matching.length === 0) {
          pending.push(`post-merge check "${check.name}" has no run for revision ${mergeRevision}`);
          continue;
        }
        const incomplete = matching.find(
          (run) => run.status !== 'completed' || run.conclusion === null,
        );
        if (incomplete !== undefined) {
          pending.push(`post-merge check "${check.name}" is "${incomplete.status ?? 'pending'}"`);
          continue;
        }
        const unsuccessful = matching.find((run) => run.conclusion !== 'success');
        if (unsuccessful !== undefined) {
          problems.push(
            `post-merge check "${check.name}" concluded "${unsuccessful.conclusion}" for ` +
              `revision ${mergeRevision}`,
          );
          continue;
        }
        evidence.push({
          name: check.name,
          producer: check.workflow,
          revision: mergeRevision,
          result: 'passed',
        });
      }
      if (problems.length > 0) {
        return { kind: 'failed', reason: `${problems.join('; ')}.` };
      }
      if (pending.length === 0) {
        return { kind: 'passed', checks: evidence };
      }
      return { kind: 'pending', reason: pending.join('; ') };
    }

    /** Observe every configured post-merge check within the configured completion wait. */
    async function waitForPostMergeChecks(
      mergeRevision: string,
    ): Promise<
      | { readonly kind: 'passed'; readonly checks: CompletionOutput['checks'] }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      for (;;) {
        const observed = await observePostMergeChecks(mergeRevision);
        if (observed.kind !== 'pending') {
          return observed;
        }
        if (Date.now() - startedAt >= waitLimitMs) {
          return {
            kind: 'failed',
            reason:
              `${observed.reason}; the configured completion wait of ` +
              `${settings.completion.waitLimitSeconds}s expired.`,
          };
        }
        await settings.wait(pollIntervalMs);
      }
    }

    /** Finish the task once the evidence holds: move the ticket to its completed status. */
    async function completeTicket(): Promise<'completed' | 'failed'> {
      const issue = await readIssue(settings.jira, issueId);
      const status = statusNameOf(issue);
      if (status === settings.doneStatus) {
        return 'completed';
      }
      const transitions = await settings.jira.readTransitions(issue.id);
      if (!transitions.ok) {
        throw new Error(transitions.fault.message);
      }
      const transition = transitions.value.find(
        (candidate) => candidate.to.name === settings.doneStatus,
      );
      if (transition === undefined) {
        return fail(
          `No permitted Jira transition moves ${taskKey} from ` +
            `${status ?? 'its current status'} to "${settings.doneStatus}".`,
        );
      }
      const moved = await settings.jira.transitionIssue(issue.id, transition.id);
      if (!moved.ok) {
        throw new Error(moved.fault.message);
      }
      return 'completed';
    }

    // Confirmed evidence for this task and pull request is reused: a merged pull request is not
    // enough on its own, but the saved evidence already carries the checks confirmed for its merge.
    const confirmed =
      recorded !== null &&
      recorded.taskKey === taskKey &&
      recorded.pullRequestUrl === delivery.pullRequestUrl &&
      recorded.reviewedHead === delivery.headRevision
        ? recorded
        : null;
    if (confirmed !== null) {
      const observed = await observeMerge();
      if (observed.kind === 'failed') {
        return fail(observed.reason);
      }
      if (observed.kind === 'merged' && observed.revision === confirmed.mergeRevision) {
        return completeTicket();
      }
    }

    // The approved head carries the configured review check from the Nexus Lens App; a same-name
    // check from another producer is not the Lens gate.
    const checks = await settings.github.readChecks(settings.repository, delivery.headRevision);
    if (!checks.ok) {
      throw new Error(checks.fault.message);
    }
    const reviewChecks = checks.value.filter(
      (check) =>
        check.revision === delivery.headRevision &&
        check.name === settings.reviewCheck &&
        check.producer?.id === settings.nexusLens.appId,
    );
    if (reviewChecks.length === 0) {
      return fail(
        `Revision ${delivery.headRevision} carries no "${settings.reviewCheck}" check from the ` +
          'Nexus Lens App; the approval is not confirmed.',
      );
    }
    const unresolved = reviewChecks.find(
      (check) => check.status !== 'completed' || check.conclusion !== 'success',
    );
    if (unresolved !== undefined) {
      return fail(
        `The "${settings.reviewCheck}" check from the Nexus Lens App for revision ` +
          `${delivery.headRevision} is ` +
          `${unresolved.conclusion ?? `"${unresolved.status}"`}, not successful.`,
      );
    }

    const merge = await waitForMerge();
    if (merge.kind === 'failed') {
      return fail(merge.reason);
    }
    const observed = await waitForPostMergeChecks(merge.revision);
    if (observed.kind === 'failed') {
      return fail(observed.reason);
    }

    const output: CompletionOutput = {
      taskKey,
      pullRequestUrl: delivery.pullRequestUrl,
      reviewedHead: delivery.headRevision,
      mergeRevision: merge.revision,
      checks: observed.checks,
    };
    await helpers.writeOutputArtifact(completionArtifact, output);
    return completeTicket();
  };
}
