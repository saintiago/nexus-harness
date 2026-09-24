import path from 'node:path';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import type { GitHubAdapter, PullRequest } from '../../../adapters/github.js';
import type { JiraAdapter, JiraTransition } from '../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import { createArtifactHelpers } from '../artifacts.js';
import { devArtifact, type DevelopmentOutput } from '../develop/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord } from '../records.js';
import { repairArtifact } from '../select-repair/artifacts.js';
import { selectionDeclaration, type Selection } from '../select-task/artifacts.js';
import {
  applyTransition,
  publishComment,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
  updateIssueFields,
} from '../source.js';
import { verificationArtifact } from '../verify/artifacts.js';
import { deliveryArtifact, type DeliveryOutput } from './artifacts.js';

/**
 * Deliver publishes the current round's verified revision: it pushes the prepared branch, confirms
 * the remote head, finds or creates the task's pull request, requests native auto-merge and
 * publishes the developer report to the ticket. Publication does not merge or complete the task;
 * Review and CompleteTask own the remaining gates.
 *
 * A verified-revision or publication condition produces the failed outcome with its observed
 * reason. Adapter faults and inputs that contradict each other are execution errors.
 */

export type DeliverSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured GitHub repository in owner/name form. */
  readonly repository: string;
  /** The configured base branch the pull request merges into. */
  readonly baseBranch: string;
  /** The configured Jira field identity that retains the pull request URL. */
  readonly pullRequestField: string;
  /** The configured Jira status the delivered task moves to for review. */
  readonly reviewStatus: string;
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

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
  const task = selection.task;
  const fields =
    typeof task === 'object' && task !== null
      ? (task as { readonly fields?: unknown }).fields
      : undefined;
  const summary =
    typeof fields === 'object' && fields !== null
      ? (fields as { readonly summary?: unknown }).summary
      : undefined;
  return typeof summary === 'string' && summary.trim() !== ''
    ? `${selection.taskKey}: ${summary}`
    : selection.taskKey;
}

/**
 * The developer report: the profile, what changed and why, the completed repair turns and any
 * profile escalation. Operational paths and repeated links stay out of the comment.
 */
function reportText(
  development: DevelopmentOutput,
  repairsUsed: number,
  escalatedFrom: string | null,
): string {
  const lines = [`profile: ${development.profile}`, development.summary];
  if (repairsUsed > 0) {
    const escalation =
      escalatedFrom === null
        ? ''
        : `, escalated from "${escalatedFrom}" to "${development.profile}"`;
    lines.push(`Repairs used: ${repairsUsed}${escalation}.`);
  }
  return lines.join('\n');
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
    const worktree = path.join(root, 'worktree');
    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRequiredRecord(
      preparedFile,
      preparedWorkspaceDeclaration,
      'Prepared workspace',
    );
    const taskBranch = prepared.branch;
    const repository = prepared.repository;

    const helpers = createArtifactHelpers({ root });
    const [development, verification] = await helpers.readInputArtifacts(
      devArtifact,
      verificationArtifact,
    );
    const [recorded] = await helpers.readOptionalInputArtifacts(deliveryArtifact);

    /** Report an observed condition that prevents publication. */
    function fail(reason: string): 'failed' {
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

    /** The publication target: the recorded or branch-matching pull request, or a new one. */
    async function publicationTarget(): Promise<
      | { readonly kind: 'use'; readonly pullRequest: PullRequest }
      | { readonly kind: 'create' }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      if (recordedForHead !== null) {
        const found = await readPullRequest(
          settings.github,
          settings.repository,
          recordedForHead.pullRequestNumber,
        );
        if (found.baseBranch !== settings.baseBranch) {
          return {
            kind: 'failed',
            reason:
              `Recorded pull request #${found.number} targets "${found.baseBranch}", not the ` +
              `configured "${settings.baseBranch}".`,
          };
        }
        if (found.state === 'closed' && !found.merged) {
          return {
            kind: 'failed',
            reason: `Recorded pull request #${found.number} is closed without being merged.`,
          };
        }
        if (found.headRevision !== headRevision) {
          return {
            kind: 'failed',
            reason:
              `Pull request #${found.number} carries revision ${found.headRevision}, not the ` +
              `verified ${headRevision}; it is not reused for this change.`,
          };
        }
        return { kind: 'use', pullRequest: found };
      }

      const matches = await settings.github.findPullRequests(settings.repository, {
        branch: taskBranch,
        baseBranch: settings.baseBranch,
      });
      if (!matches.ok) {
        throw new Error(matches.fault.message);
      }
      const open: PullRequest[] = [];
      let merged: PullRequest | null = null;
      let otherHead: string | null = null;
      for (const identity of matches.value) {
        const found = await readPullRequest(settings.github, settings.repository, identity.number);
        if (found.merged) {
          if (found.headRevision === headRevision && merged === null) {
            merged = found;
          }
          continue;
        }
        if (found.state === 'open') {
          if (found.headRevision === headRevision) {
            open.push(found);
          } else {
            otherHead ??= `pull request #${found.number} carries revision ${found.headRevision}`;
          }
        }
      }
      if (open.length > 1) {
        return {
          kind: 'failed',
          reason:
            `More than one open pull request matches branch "${taskBranch}"; none is ` +
            'silently chosen.',
        };
      }
      const found = open[0] ?? merged;
      if (found !== null) {
        return { kind: 'use', pullRequest: found };
      }
      if (otherHead !== null) {
        return {
          kind: 'failed',
          reason: `The matching open ${otherHead}, not the verified ${headRevision}; it is not reused.`,
        };
      }
      return { kind: 'create' };
    }

    const target = await publicationTarget();
    if (target.kind === 'failed') {
      return fail(target.reason);
    }
    const pullRequest = target.kind === 'use' ? target.pullRequest : null;

    // Create or update the publication, then request native auto-merge where it is not enabled.
    const title = pullRequestTitle(selection);
    const body = development.summary;
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
      if (created.value.headRevision !== headRevision) {
        return fail(
          `The created pull request carries revision ${created.value.headRevision}, not the ` +
            `verified ${headRevision}.`,
        );
      }
      pullRequestNumber = created.value.number;
      pullRequestUrl = created.value.url;
      needsAutoMerge = true;
    } else {
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
          return fail(
            `Pull request #${pullRequest.number} carries revision ${updated.value.headRevision}, ` +
              `not the verified ${headRevision}.`,
          );
        }
      }
      pullRequestNumber = pullRequest.number;
      pullRequestUrl = pullRequest.url;
      needsAutoMerge = !pullRequest.merged && !pullRequest.autoMergeEnabled;
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

    // The completed development turns count as executed repair turns. The repair decisions record
    // the profile changes: when the repair policy selected this round's profile after the initial
    // implementation ran another one, the report names the escalation.
    const turns = await helpers.readArtifactHistory(devArtifact);
    const decisions = await helpers.readArtifactHistory(repairArtifact);
    const initialProfile = turns[0]?.value.profile ?? development.profile;
    const latestSelection = decisions
      .filter((decision) => decision.value.decision === 'selected')
      .at(-1);
    const escalatedFrom =
      initialProfile !== development.profile &&
      latestSelection !== undefined &&
      latestSelection.value.profile === development.profile
        ? initialProfile
        : null;

    // Read the ticket state before recording the publication, so a known completion condition
    // cannot leave a delivery artifact for an unpublished result.
    const issue = await readIssue(settings.jira, selection.source.issueId);
    const comments = await readComments(settings.jira, selection.source.issueId);
    const needsPullRequestField = issue.fields[settings.pullRequestField] !== pullRequestUrl;
    const status = statusNameOf(issue);
    let transition: JiraTransition | null = null;
    if (status !== settings.reviewStatus) {
      const found = await transitionInto(settings.jira, issue, settings.reviewStatus);
      if (found.kind === 'blocked') {
        return fail(found.reason);
      }
      transition = found.transition;
    }

    const output: DeliveryOutput = {
      repository: settings.repository,
      pullRequestNumber,
      pullRequestUrl,
      headRevision,
    };
    await helpers.writeOutputArtifact(deliveryArtifact, output);

    if (needsPullRequestField) {
      await updateIssueFields(settings.jira, issue.id, { pullRequest: pullRequestUrl });
    }
    if (transition !== null) {
      await applyTransition(settings.jira, issue.id, transition);
    }
    await publishComment(
      settings.jira,
      issue.id,
      comments,
      reportText(development, turns.length, escalatedFrom),
    );
    return 'published';
  };
}
