import type {
  BranchHead,
  CheckoutIdentity,
  GitAdapter,
  RepositoryState,
} from '../../src/adapters/git.js';
import { ok, type Result } from '../../src/result.js';

/**
 * A controlled Git adapter for action tests: inspections answer from the scripted observations
 * and every other operation is answered by the supplied operations or fails the test. The default
 * observation is the prepared task branch at the initial revision with no uncommitted work.
 */

/** One repository observation with the prepared branch and no uncommitted work by default. */
export function repositoryState(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return {
    remoteUrl: '/origin/repository.git',
    branch: 'task/NEX-1',
    headRevision: '1'.repeat(40),
    trackedChanges: false,
    untrackedChanges: false,
    ...overrides,
  };
}

/** The Git operations a test supplies beyond the scripted inspections. */
export type GitOperations = {
  cloneRepository?(
    source: string,
    destination: string,
  ): Result<CheckoutIdentity> | Promise<Result<CheckoutIdentity>>;
  pullBranch?(
    repository: string,
    remote: string,
    branch: string,
  ): Result<BranchHead> | Promise<Result<BranchHead>>;
  pushBranch?(
    repository: string,
    branch: string,
    expectedHead: string,
  ): Result<BranchHead> | Promise<Result<BranchHead>>;
  readRemoteBranchHead?(
    remote: string,
    branch: string,
  ): Result<string | null> | Promise<Result<string | null>>;
  readDiff?(
    repository: string,
    baseRevision: string,
    headRevision: string,
  ): Result<string> | Promise<Result<string>>;
};

/** A Git adapter that answers inspections from the script, the supplied operations and nothing else. */
export function scriptedGit(
  observations: readonly (RepositoryState | Error)[],
  operations: GitOperations = {},
): {
  readonly git: GitAdapter;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const unexpected = (operation: string): never => {
    throw new Error(`Unexpected Git operation: ${operation}`);
  };
  return {
    calls,
    git: {
      async inspectRepository(repository): Promise<Result<RepositoryState>> {
        calls.push(repository);
        const observation = observations[Math.min(index, observations.length - 1)];
        index += 1;
        if (observation === undefined) {
          throw new Error('No scripted repository observation remains.');
        }
        return observation instanceof Error
          ? { ok: false, fault: { message: observation.message } }
          : ok(observation);
      },
      async cloneRepository(source, destination) {
        calls.push(`clone:${source}:${destination}`);
        return operations.cloneRepository
          ? await operations.cloneRepository(source, destination)
          : unexpected('cloneRepository');
      },
      async fetchRevision() {
        return unexpected('fetchRevision');
      },
      async pullBranch(repository, remote, branch) {
        calls.push(`pull:${repository}:${remote}:${branch}`);
        return operations.pullBranch
          ? await operations.pullBranch(repository, remote, branch)
          : unexpected('pullBranch');
      },
      async createBranch() {
        return unexpected('createBranch');
      },
      async pushBranch(repository, branch, expectedHead) {
        calls.push(`push:${branch}@${expectedHead}`);
        return operations.pushBranch
          ? await operations.pushBranch(repository, branch, expectedHead)
          : unexpected('pushBranch');
      },
      async readRemoteBranchHead(remote, branch) {
        calls.push(`remote:${remote}:${branch}`);
        return operations.readRemoteBranchHead
          ? await operations.readRemoteBranchHead(remote, branch)
          : unexpected('readRemoteBranchHead');
      },
      async readDiff(repository, baseRevision, headRevision) {
        calls.push(`diff:${baseRevision}..${headRevision}`);
        return operations.readDiff
          ? await operations.readDiff(repository, baseRevision, headRevision)
          : unexpected('readDiff');
      },
    },
  };
}
