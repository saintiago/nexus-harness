import path from 'node:path';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import type { GitHubAdapter, PullRequest } from '../../../adapters/github.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
import { createArtifactHelpers, roundArtifactPath } from '../artifacts.js';
import { devArtifact, developmentReportText } from '../develop/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord } from '../records.js';
import { selectionDeclaration, type Selection } from '../select-task/artifacts.js';
import { issueSummary } from '../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { retainTerminalReason } from '../terminal-reason.js';
import { verificationArtifact } from '../verify/artifacts.js';
import { deliveryArtifact, deliveryFailureArtifact, type DeliveryOutput } from './artifacts.js';

/**
 * Deliver publishes the current round's verified revision: it pushes the prepared branch, confirms
 * the remote head, finds or creates the task's pull request, requests native auto-merge and saves
 * the delivery artifact. Source publication belongs to the parent-owned boundary actor;
 * publication does not merge or complete the task, and Review/CompleteTask own the remaining gates.
 *
 * A verified-revision or publication condition produces the failed outcome with its observed
 * reason. Adapter faults and inputs that contradict each other are execution errors.
 */

/**
 * Deliver's fixed post-push confirmation bounds. GitHub can briefly report the previous pull-request
 * head after a successful push; Deliver re-reads the same pull request at this interval until the
 * verified revision or this deadline, without making the wait an operator setting.
 */
const confirmationIntervalMs = 2_000;
const confirmationDeadlineMs = 20_000;

export type DeliverSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured GitHub repository in owner/name form. */
  readonly repository: string;
  /** The configured base branch the pull request merges into. */
  readonly baseBranch: string;
  /** The configured Jira field identity that retains the pull request URL. */
  /** The configured Jira status the delivered task moves to for review. */
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly publish: EventPublisher;
  /** Wait before the next pull-request confirmation read; supplied so tests control time. */
  readonly wait: (milliseconds: number) => Promise<void>;
};

/** How one pull-request observation relates to the revision being delivered. */
type TargetObservation =
  | { readonly kind: 'confirmed'; readonly pullRequest: PullRequest }
  | { readonly kind: 'stale'; readonly pullRequest: PullRequest }
  | { readonly kind: 'unrelated'; readonly reason: string };

/** The verified pull request, or the reason the post-push confirmation could not establish it. */
type Confirmation =
  | { readonly kind: 'confirmed'; readonly pullRequest: PullRequest }
  | { readonly kind: 'failed'; readonly reason: string };

/** Read the worktree's identity and uncommitted work; a Git failure is an execution error. */
async function inspectRepository(git: GitAdapter, worktree: string): Promise<RepositoryState> {
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  return inspection.value;
}

/** Read one pull request; a provider failure is an execution error. */
async function readPullRequest(
  github: GitHubAdapter,
  repository: string,
  pullRequestNumber: number,
): Promise<PullRequest> {
  const result = await github.readPullRequest(repository, pullRequestNumber);
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return result.value;
}

/** The pull request title: the task key with its source summary when one is readable. */
function pullRequestTitle(selection: Selection): string {
  const summary = issueSummary(selection.task);
  return summary === null ? selection.taskKey : `${selection.taskKey}: ${summary}`;
}

/** Create Deliver over the selected workspace, configured delivery target and adapters. */
export function createDeliver(settings: DeliverSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRequiredRecord(
      preparedFile,
      preparedWorkspaceDeclaration,
      'Prepared workspace',
    );
    // The recorded repository workspace owns the branch being published; later implementation
    // tickets use their own checkout, the first continues the preparation one.
    const worktree = path.join(
      (prepared.repositoryWorkspace ?? selection.workspace).root,
      'worktree',
    );
    const taskBranch = prepared.branch;
    const repository = prepared.repository;

    const helpers = createArtifactHelpers({ root });
    const [development, verification] = await helpers.readInputArtifacts(
      devArtifact,
      verificationArtifact,
    );
    const [recorded] = await helpers.readOptionalInputArtifacts(deliveryArtifact);
    const round = await readRequiredRecord(
      path.join(root, currentRoundFile),
      currentRoundDeclaration,
      'Current round',
    );

    /** Report an observed condition that prevents publication. */
    async function fail(reason: string): Promise<'failed'> {
      // The reason is retained before it is stated, so the terminal handoff reconstructs it after a
      // restart of the workflow binding.
      await retainTerminalReason(
        roundArtifactPath(root, round.number, deliveryFailureArtifact.pathFromArtifactsRoot),
        reason,
      );
      settings.publish({ source: 'deliver', type: 'failed', data: { reason } });
      return 'failed';
    }

    if (development.taskKey !== selection.taskKey || prepared.taskKey !== selection.taskKey) {
      throw new Error(
        `The development result is for task "${development.taskKey}" and the prepared workspace ` +
          `for "${prepared.taskKey}", not the selected "${selection.taskKey}".`,
      );
    }

    // Only the verified committed head is published.
    if (verification.status !== 'passed') {
      return fail(
        `Verification status is "${verification.status}"; only a passed verification is published.`,
      );
    }
    if (verification.headRevision !== development.headRevision) {
      return fail(
        `The verification result is for revision ${verification.headRevision}, not the ` +
          `development result's ${development.headRevision}.`,
      );
    }
    const headRevision = development.headRevision;

    const state = await inspectRepository(settings.git, worktree);
    if (state.headRevision !== headRevision) {
      return fail(
        `The worktree at "${worktree}" is at revision ${state.headRevision ?? 'no revision'}, ` +
          `not the verified ${headRevision}.`,
      );
    }
    if (state.branch !== taskBranch) {
      return fail(
        `The worktree is on branch "${state.branch ?? 'no branch'}", not the prepared ` +
          `"${taskBranch}".`,
      );
    }
    if (state.trackedChanges) {
      return fail(
        `The worktree holds tracked changes that are not part of revision ${headRevision}; the ` +
          'verified revision is published instead.',
      );
    }

    // A normal non-forced push of the prepared branch, with the remote head confirmed afterwards.
    const pushed = await settings.git.pushBranch(worktree, taskBranch, headRevision);
    if (!pushed.ok) {
      throw new Error(pushed.fault.message);
    }
    const remote = await settings.git.readRemoteBranchHead(repository, taskBranch);
    if (!remote.ok) {
      throw new Error(remote.fault.message);
    }
    if (remote.value !== headRevision) {
      return fail(
        `The remote branch "${taskBranch}" is at revision ${remote.value ?? 'no revision'}, ` +
          `not the verified ${headRevision}.`,
      );
    }

    // The task's pull request: the recorded identity for this revision, a matching open or merged
    // pull request, or a new one. A closed or unrelated pull request is not silently reused.
    const recordedForHead =
      recorded !== null && recorded.headRevision === headRevision ? recorded : null;

    /**
     * The one deadline for this delivery invocation's post-push confirmation. A stale observation
     * never resets it, and it bounds the reads as well as the observations they return.
     */
    const confirmationDeadlineAt = Date.now() + confirmationDeadlineMs;

    /**
     * The expiry failure, retaining the expected and last observed revisions. An observation that
     * arrives after the deadline is reported as such even when it carries the verified revision.
     */
    function confirmationExpired(
      pullRequestNumber: number,
      observedRevision: string | null,
    ): string {
      const deadline = `the post-push confirmation deadline of ${confirmationDeadlineMs / 1000}s`;
      if (observedRevision === null) {
        return (
          `Pull request #${pullRequestNumber} has no observed revision to confirm the verified ` +
          `${headRevision}; ${deadline} expired.`
        );
      }
      return observedRevision === headRevision
        ? `Pull request #${pullRequestNumber} reported the verified revision ${headRevision}, but ` +
            `only after ${deadline} expired.`
        : `Pull request #${pullRequestNumber} reports revision ${observedRevision}, not the ` +
            `verified ${headRevision}; ${deadline} expired.`;
    }

    /**
     * Judge one pull-request observation against the verified revision, prepared branch and
     * configured base.
     */
    function judgeTarget(found: PullRequest): TargetObservation {
      if (found.headBranch !== taskBranch) {
        return {
          kind: 'unrelated',
          reason:
            `Pull request #${found.number} is on branch "${found.headBranch}", not the prepared ` +
            `"${taskBranch}".`,
        };
      }
      if (found.baseBranch !== settings.baseBranch) {
        return {
          kind: 'unrelated',
          reason:
            `Pull request #${found.number} targets "${found.baseBranch}", not the configured ` +
            `"${settings.baseBranch}".`,
        };
      }
      if (found.state === 'closed' && !found.merged) {
        return {
          kind: 'unrelated',
          reason: `Pull request #${found.number} is closed without being merged.`,
        };
      }
      if (found.merged && found.headRevision !== headRevision) {
        return {
          kind: 'unrelated',
          reason:
            `Merged pull request #${found.number} carries revision ${found.headRevision}, not the ` +
            `verified ${headRevision}; it is not reused for this change.`,
        };
      }
      if (found.headRevision !== headRevision) {
        return { kind: 'stale', pullRequest: found };
      }
      return { kind: 'confirmed', pullRequest: found };
    }

    /**
     * Confirm one pull request for the verified revision. A stale head is re-read from that same
     * pull request at fixed intervals within this invocation's single post-push deadline; a read
     * that would land beyond the deadline is not issued, and an observation received after it does
     * not confirm. Publication writes are not repeated while waiting, and provider faults remain
     * execution errors.
     */
    async function confirmTarget(
      pullRequestNumber: number,
      lastObservedRevision: string | null,
      first?: PullRequest,
    ): Promise<Confirmation> {
      let observed = first;
      for (;;) {
        if (observed === undefined) {
          if (Date.now() > confirmationDeadlineAt) {
            return {
              kind: 'failed',
              reason: confirmationExpired(pullRequestNumber, lastObservedRevision),
            };
          }
          observed = await readPullRequest(settings.github, settings.repository, pullRequestNumber);
        }
        lastObservedRevision = observed.headRevision;
        const judgment = judgeTarget(observed);
        if (judgment.kind === 'unrelated') {
          return { kind: 'failed', reason: judgment.reason };
        }
        if (Date.now() > confirmationDeadlineAt) {
          return {
            kind: 'failed',
            reason: confirmationExpired(pullRequestNumber, lastObservedRevision),
          };
        }
        if (judgment.kind === 'confirmed') {
          return judgment;
        }
        if (confirmationDeadlineAt - Date.now() < confirmationIntervalMs) {
          return {
            kind: 'failed',
            reason: confirmationExpired(pullRequestNumber, lastObservedRevision),
          };
        }
        await settings.wait(confirmationIntervalMs);
        observed = undefined;
      }
    }

    /** The publication target: the recorded or branch-matching pull request, or a new one. */
    async function publicationTarget(): Promise<
      | { readonly kind: 'use'; readonly pullRequest: PullRequest }
      | { readonly kind: 'create' }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      if (recordedForHead !== null) {
        const confirmed = await confirmTarget(recordedForHead.pullRequestNumber, null);
        if (confirmed.kind === 'failed') {
          return { kind: 'failed', reason: confirmed.reason };
        }
        return { kind: 'use', pullRequest: confirmed.pullRequest };
      }

      const matches = await settings.github.findPullRequests(settings.repository, {
        branch: taskBranch,
        baseBranch: settings.baseBranch,
      });
      if (!matches.ok) {
        throw new Error(matches.fault.message);
      }
      const observations: PullRequest[] = [];
      for (const identity of matches.value) {
        if (Date.now() > confirmationDeadlineAt) {
          return { kind: 'failed', reason: confirmationExpired(identity.number, null) };
        }
        const observed = await readPullRequest(
          settings.github,
          settings.repository,
          identity.number,
        );
        if (Date.now() > confirmationDeadlineAt) {
          return {
            kind: 'failed',
            reason: confirmationExpired(identity.number, observed.headRevision),
          };
        }
        observations.push(observed);
      }
      // The candidate target: the one open match, or the merged pull request that already carries
      // the verified revision. A merged pull request for another revision is history, and a new
      // pull request is created when no candidate remains. The candidate is validated against the
      // same target constraints as an open match before it is reused.
      const open = observations.filter((found) => !found.merged && found.state === 'open');
      if (open.length > 1) {
        return {
          kind: 'failed',
          reason:
            `More than one open pull request matches branch "${taskBranch}"; none is ` +
            'silently chosen.',
        };
      }
      const candidate =
        open[0] ??
        observations.find((found) => found.merged && found.headRevision === headRevision) ??
        null;
      if (candidate === null) {
        return { kind: 'create' };
      }
      const confirmed = await confirmTarget(candidate.number, candidate.headRevision, candidate);
      if (confirmed.kind === 'failed') {
        return { kind: 'failed', reason: confirmed.reason };
      }
      return { kind: 'use', pullRequest: confirmed.pullRequest };
    }

    const target = await publicationTarget();
    if (target.kind === 'failed') {
      return fail(target.reason);
    }
    const pullRequest = target.kind === 'use' ? target.pullRequest : null;

    // Create or update the publication, then request native auto-merge unless the latest
    // observation of that pull request reports it already enabled or the pull request already
    // merged. A creation or update that still reports the previous head is confirmed by re-reading
    // that same pull request within the post-push confirmation deadline, and the confirming
    // observation is the latest state that decides the auto-merge request.
    const title = pullRequestTitle(selection);
    // The pull request body is the developer's saved Markdown under its producer-owned binding; a
    // retained combined report supplies its former narrative.
    const body = await developmentReportText(development);
    let pullRequestNumber: number;
    let pullRequestUrl: string;
    let needsAutoMerge: boolean;
    if (pullRequest === null) {
      const created = await settings.github.createPullRequest(settings.repository, {
        baseBranch: settings.baseBranch,
        headBranch: taskBranch,
        title,
        body,
      });
      if (!created.ok) {
        throw new Error(created.fault.message);
      }
      if (Date.now() > confirmationDeadlineAt) {
        return fail(confirmationExpired(created.value.number, created.value.headRevision));
      }
      const confirmation =
        created.value.headRevision === headRevision
          ? null
          : await confirmTarget(created.value.number, created.value.headRevision);
      if (confirmation !== null && confirmation.kind === 'failed') {
        return fail(confirmation.reason);
      }
      const observed = confirmation === null ? null : confirmation.pullRequest;
      pullRequestNumber = created.value.number;
      pullRequestUrl = created.value.url;
      // A fresh pull request starts without auto-merge; a confirmation observation reports the
      // state the provider held while the creation response still named the previous head.
      needsAutoMerge = observed === null || (!observed.merged && !observed.autoMergeEnabled);
    } else {
      let observed = pullRequest;
      if (!pullRequest.merged) {
        const updated = await settings.github.updatePullRequest(
          settings.repository,
          pullRequest.number,
          { title, body },
        );
        if (!updated.ok) {
          throw new Error(updated.fault.message);
        }
        if (updated.value.headRevision !== headRevision) {
          const confirmed = await confirmTarget(pullRequest.number, updated.value.headRevision);
          if (confirmed.kind === 'failed') {
            return fail(confirmed.reason);
          }
          observed = confirmed.pullRequest;
        }
      }
      pullRequestNumber = pullRequest.number;
      pullRequestUrl = pullRequest.url;
      needsAutoMerge = !observed.merged && !observed.autoMergeEnabled;
    }
    if (needsAutoMerge) {
      const accepted = await settings.github.requestAutoMerge(
        settings.repository,
        pullRequestNumber,
        headRevision,
      );
      if (!accepted.ok) {
        throw new Error(accepted.fault.message);
      }
    }

    const output: DeliveryOutput = {
      repository: settings.repository,
      pullRequestNumber,
      pullRequestUrl,
      headRevision,
    };
    await helpers.writeOutputArtifact(deliveryArtifact, output);
    // The parent-owned publication actor sets the ticket's PR field/review status and publishes the
    // developer report from this saved artifact and the round's development report.
    settings.publish(
      actionOutcomeEvent('deliver', {
        task: selection.taskKey,
        round: round.number,
        outcome: 'published',
        detail: `PR #${String(pullRequestNumber)}`,
        artifact: {
          path: roundArtifactPath(root, round.number, deliveryArtifact.pathFromArtifactsRoot),
        },
      }),
    );
    return 'published';
  };
}
