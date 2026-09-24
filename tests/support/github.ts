import type {
  CheckObservation,
  GitHubAdapter,
  PullRequest,
  PullRequestConversation,
  PullRequestCreation,
  PullRequestIdentity,
  PullRequestPublication,
  PullRequestUpdates,
  ReviewCheckIdentity,
  ReviewCheckPublicationRequest,
  ReviewIdentity,
  ReviewPublicationRequest,
  WorkflowRunObservation,
} from '../../src/adapters/github.js';
import type { Result } from '../../src/result.js';

/**
 * A controlled GitHub adapter for action tests: the supplied operations answer the calls under test
 * and every other call fails the test. Recorded calls let a test assert the operations and their
 * arguments without reaching a live provider.
 */

/** The operations a test supplies. Answering is synchronous or asynchronous. */
export type GitHubOperations = {
  findPullRequests?(
    repository: string,
    filter: { readonly branch: string; readonly baseBranch: string },
  ): Result<readonly PullRequestIdentity[]> | Promise<Result<readonly PullRequestIdentity[]>>;
  readPullRequest?(
    repository: string,
    pullRequestNumber: number,
  ): Result<PullRequest> | Promise<Result<PullRequest>>;
  createPullRequest?(
    repository: string,
    creation: PullRequestCreation,
  ): Result<PullRequestPublication> | Promise<Result<PullRequestPublication>>;
  updatePullRequest?(
    repository: string,
    pullRequestNumber: number,
    updates: PullRequestUpdates,
  ): Result<PullRequestPublication> | Promise<Result<PullRequestPublication>>;
  readConversation?(
    repository: string,
    pullRequestNumber: number,
  ): Result<PullRequestConversation> | Promise<Result<PullRequestConversation>>;
  publishReview?(
    repository: string,
    review: ReviewPublicationRequest,
  ): Result<ReviewIdentity> | Promise<Result<ReviewIdentity>>;
  readChecks?(
    repository: string,
    revision: string,
  ): Result<readonly CheckObservation[]> | Promise<Result<readonly CheckObservation[]>>;
  publishReviewCheck?(
    repository: string,
    publication: ReviewCheckPublicationRequest,
  ): Result<ReviewCheckIdentity> | Promise<Result<ReviewCheckIdentity>>;
  requestAutoMerge?(
    repository: string,
    pullRequestNumber: number,
    expectedHeadRevision: string,
  ): Result<void> | Promise<Result<void>>;
  readWorkflowRuns?(
    repository: string,
    revision: string,
    workflows: readonly string[],
  ): Result<readonly WorkflowRunObservation[]> | Promise<Result<readonly WorkflowRunObservation[]>>;
};

/** A controlled adapter with the call it received for each unsupplied operation. */
export function scriptedGitHub(operations: GitHubOperations): {
  readonly github: GitHubAdapter;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const unexpected = (operation: string): never => {
    throw new Error(`Unexpected GitHub operation: ${operation}`);
  };
  const github: GitHubAdapter = {
    async findPullRequests(repository, filter) {
      calls.push(`find:${filter.branch}->${filter.baseBranch}`);
      return operations.findPullRequests
        ? await operations.findPullRequests(repository, filter)
        : unexpected('findPullRequests');
    },
    async readPullRequest(repository, pullRequestNumber) {
      calls.push(`read:${pullRequestNumber}`);
      return operations.readPullRequest
        ? await operations.readPullRequest(repository, pullRequestNumber)
        : unexpected('readPullRequest');
    },
    async createPullRequest(repository, creation) {
      calls.push(`create:${creation.headBranch}->${creation.baseBranch}`);
      return operations.createPullRequest
        ? await operations.createPullRequest(repository, creation)
        : unexpected('createPullRequest');
    },
    async updatePullRequest(repository, pullRequestNumber, updates) {
      calls.push(`update:${pullRequestNumber}`);
      return operations.updatePullRequest
        ? await operations.updatePullRequest(repository, pullRequestNumber, updates)
        : unexpected('updatePullRequest');
    },
    async readConversation(repository, pullRequestNumber) {
      calls.push(`conversation:${pullRequestNumber}`);
      return operations.readConversation
        ? await operations.readConversation(repository, pullRequestNumber)
        : unexpected('readConversation');
    },
    async publishReview(repository, review) {
      calls.push(`publishReview:${review.pullRequestNumber}@${review.revision}:${review.verdict}`);
      return operations.publishReview
        ? await operations.publishReview(repository, review)
        : unexpected('publishReview');
    },
    async readChecks(repository, revision) {
      calls.push(`readChecks:${revision}`);
      return operations.readChecks
        ? await operations.readChecks(repository, revision)
        : unexpected('readChecks');
    },
    async publishReviewCheck(repository, publication) {
      calls.push(`publishCheck:${publication.revision}:${publication.name}:${publication.result}`);
      return operations.publishReviewCheck
        ? await operations.publishReviewCheck(repository, publication)
        : unexpected('publishReviewCheck');
    },
    async requestAutoMerge(repository, pullRequestNumber, expectedHeadRevision) {
      calls.push(`autoMerge:${pullRequestNumber}@${expectedHeadRevision}`);
      return operations.requestAutoMerge
        ? await operations.requestAutoMerge(repository, pullRequestNumber, expectedHeadRevision)
        : unexpected('requestAutoMerge');
    },
    async readWorkflowRuns(repository, revision, workflows) {
      calls.push(`workflowRuns:${revision}:${workflows.join(',')}`);
      return operations.readWorkflowRuns
        ? await operations.readWorkflowRuns(repository, revision, workflows)
        : unexpected('readWorkflowRuns');
    },
  };
  return { github, calls };
}
