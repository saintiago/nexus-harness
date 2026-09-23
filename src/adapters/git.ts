import type { ProcessOutputObserver, ProcessResult } from './processes.js';
import type { Result } from '../result.js';

/**
 * Run one git command. The caller supplies the executable, environment and process handling;
 * the adapter supplies the arguments and working directory of each requested operation.
 */
export type GitCommandExecution = (
  args: readonly string[],
  directory: string,
  onOutput: ProcessOutputObserver,
) => Promise<ProcessResult>;

/** A checkout's current branch and head commit, absent as null while Git reports none. */
export type BranchHead = {
  readonly branch: string | null;
  readonly headRevision: string | null;
};

/** A checkout's origin remote URL with its current branch and head commit. */
export type CheckoutIdentity = BranchHead & {
  readonly remoteUrl: string | null;
};

/** A checkout identity plus the worktree's uncommitted tracked and untracked work. */
export type RepositoryState = CheckoutIdentity & {
  readonly trackedChanges: boolean;
  readonly untrackedChanges: boolean;
};

/** The Git operations consumers request. Revisions are commit identities observed from Git. */
export type GitAdapter = {
  inspectRepository(repository: string): Promise<Result<RepositoryState>>;
  cloneRepository(source: string, destination: string): Promise<Result<CheckoutIdentity>>;
  fetchRevision(repository: string, remote: string, ref: string): Promise<Result<string>>;
  pullBranch(repository: string, remote: string, branch: string): Promise<Result<BranchHead>>;
  createBranch(
    repository: string,
    branch: string,
    startRevision: string,
  ): Promise<Result<BranchHead>>;
  readDiff(repository: string, baseRevision: string, headRevision: string): Promise<Result<string>>;
  pushBranch(repository: string, branch: string, expectedHead: string): Promise<Result<BranchHead>>;
  readRemoteBranchHead(remote: string, branch: string): Promise<Result<string | null>>;
};

/** A completed git command with its collected output. */
type CompletedCommand = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function ok<Value>(value: Value): Result<Value> {
  return { ok: true, value };
}

function fault(message: string): Result<never> {
  return { ok: false, fault: { message } };
}

/** A failed command's diagnostics, preferring stderr because Git reports failures there. */
function failureOf(command: CompletedCommand): Result<never> {
  const diagnostics = command.stderr.trim() || command.stdout.trim() || 'no diagnostics';
  return fault(`Git command failed with exit code ${command.exitCode}: ${diagnostics}`);
}

/**
 * Exit codes for genuine absence in the optional queries. A `--quiet` reference lookup exits 1
 * when the reference does not exist and `remote get-url` exits 2 when the remote does not exist;
 * every other nonzero exit is a failure that must reach the consumer.
 */
const absentReferenceExitCode = 1;
const absentRemoteExitCode = 2;

/** Create the Git adapter over the supplied command execution. */
export function createGitAdapter(execute: GitCommandExecution): GitAdapter {
  /** Run git and collect its complete output. */
  async function attempt(
    args: readonly string[],
    directory: string,
  ): Promise<Result<CompletedCommand>> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const result = await execute(args, directory, (output) => {
      (output.stream === 'stdout' ? stdout : stderr).push(output.chunk);
    });
    if (!result.ok) {
      return result;
    }
    return ok({
      exitCode: result.value.exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
  }

  /** Run git, requiring success. A nonzero exit is a fault carrying Git's diagnostics. */
  async function required(
    args: readonly string[],
    directory: string,
  ): Promise<Result<CompletedCommand>> {
    const result = await attempt(args, directory);
    if (!result.ok) {
      return result;
    }
    return result.value.exitCode === 0 ? result : failureOf(result.value);
  }

  /**
   * Read a git query that reports genuine absence with one exit code: null for that code, but the
   * fault for an execution fault or any other nonzero exit, so a failed read is never absence.
   */
  async function optional(
    args: readonly string[],
    directory: string,
    absenceExitCode: number,
  ): Promise<Result<string | null>> {
    const result = await attempt(args, directory);
    if (!result.ok) {
      return result;
    }
    if (result.value.exitCode === absenceExitCode) {
      return ok(null);
    }
    if (result.value.exitCode !== 0) {
      return failureOf(result.value);
    }
    return ok(result.value.stdout.trim());
  }

  /** Read the branch and head Git currently reports for a checkout. */
  async function readBranchHead(directory: string): Promise<Result<BranchHead>> {
    // A detached head has no branch and an unborn head has no commit; both are genuinely absent.
    const branch = await optional(
      ['symbolic-ref', '--short', '--quiet', 'HEAD'],
      directory,
      absentReferenceExitCode,
    );
    if (!branch.ok) {
      return branch;
    }
    const headRevision = await optional(
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      directory,
      absentReferenceExitCode,
    );
    if (!headRevision.ok) {
      return headRevision;
    }
    return ok({ branch: branch.value, headRevision: headRevision.value });
  }

  /** Read a checkout's origin remote URL with its branch and head. */
  async function readIdentity(directory: string): Promise<Result<CheckoutIdentity>> {
    const remoteUrl = await optional(
      ['remote', 'get-url', 'origin'],
      directory,
      absentRemoteExitCode,
    );
    if (!remoteUrl.ok) {
      return remoteUrl;
    }
    const branchHead = await readBranchHead(directory);
    if (!branchHead.ok) {
      return branchHead;
    }
    return ok({ remoteUrl: remoteUrl.value, ...branchHead.value });
  }

  return {
    async inspectRepository(repository) {
      // Status also establishes that the path is a worktree; the identity reads report a branch,
      // head or remote that Git genuinely does not have instead of masking their own failures.
      const status = await required(['status', '--porcelain'], repository);
      if (!status.ok) {
        return status;
      }
      const identity = await readIdentity(repository);
      if (!identity.ok) {
        return identity;
      }
      const entries = status.value.stdout.split('\n').filter((line) => line !== '');
      return ok({
        ...identity.value,
        trackedChanges: entries.some((entry) => !entry.startsWith('??')),
        untrackedChanges: entries.some((entry) => entry.startsWith('??')),
      });
    },

    async cloneRepository(source, destination) {
      // There is no repository to work in yet, so clone runs from the Nexus process directory.
      const clone = await required(['clone', source, destination], process.cwd());
      if (!clone.ok) {
        return clone;
      }
      return readIdentity(destination);
    },

    async fetchRevision(repository, remote, ref) {
      const fetch = await required(['fetch', remote, ref], repository);
      if (!fetch.ok) {
        return fetch;
      }
      // FETCH_HEAD names the ref this fetch produced, whatever the refspec mapping; peeling an
      // annotated tag leaves the commit the revision must identify.
      const revision = await required(['rev-parse', 'FETCH_HEAD^{commit}'], repository);
      if (!revision.ok) {
        return revision;
      }
      return ok(revision.value.stdout.trim());
    },

    async pullBranch(repository, remote, branch) {
      const pull = await required(['pull', '--ff-only', remote, branch], repository);
      if (!pull.ok) {
        return pull;
      }
      return readBranchHead(repository);
    },

    async createBranch(repository, branch, startRevision) {
      const checkout = await required(['checkout', '-b', branch, startRevision], repository);
      if (!checkout.ok) {
        return checkout;
      }
      return readBranchHead(repository);
    },

    async readDiff(repository, baseRevision, headRevision) {
      const diff = await required(['diff', '--no-color', baseRevision, headRevision], repository);
      if (!diff.ok) {
        return diff;
      }
      return ok(diff.value.stdout);
    },

    async pushBranch(repository, branch, expectedHead) {
      const head = await optional(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        repository,
        absentReferenceExitCode,
      );
      if (!head.ok) {
        return head;
      }
      if (head.value === null) {
        return fault(`No local branch "${branch}" to push.`);
      }
      if (head.value !== expectedHead) {
        return fault(
          `Local branch "${branch}" is at ${head.value} instead of the expected ${expectedHead}.`,
        );
      }
      const push = await required(['push', 'origin', branch], repository);
      if (!push.ok) {
        return push;
      }
      return ok({ branch, headRevision: head.value });
    },

    async readRemoteBranchHead(remote, branch) {
      // Reading a remote needs no local repository; the working directory is irrelevant.
      const listing = await required(['ls-remote', remote, `refs/heads/${branch}`], process.cwd());
      if (!listing.ok) {
        return listing;
      }
      const line = listing.value.stdout.split('\n').find((entry) => entry.trim() !== '');
      if (line === undefined) {
        return ok(null);
      }
      return ok(line.trim().split(/\s+/)[0] ?? null);
    },
  };
}
