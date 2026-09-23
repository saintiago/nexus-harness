import type { GitAdapter, RepositoryState } from '../../src/adapters/git.js';
import { ok, type Result } from '../../src/result.js';

/**
 * A controlled Git adapter for action tests: inspections answer from the scripted observations
 * and every other operation fails the test. The default observation is the prepared task branch at
 * the initial revision with no uncommitted work.
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

/** A Git adapter that answers inspections from the script and fails every other operation. */
export function scriptedGit(observations: readonly (RepositoryState | Error)[]): {
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
      async cloneRepository() {
        return unexpected('cloneRepository');
      },
      async fetchRevision() {
        return unexpected('fetchRevision');
      },
      async pullBranch() {
        return unexpected('pullBranch');
      },
      async createBranch() {
        return unexpected('createBranch');
      },
      async readDiff() {
        return unexpected('readDiff');
      },
      async pushBranch() {
        return unexpected('pushBranch');
      },
      async readRemoteBranchHead() {
        return unexpected('readRemoteBranchHead');
      },
    },
  };
}
