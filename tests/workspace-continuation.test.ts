/**
 * Workspace ownership: the ledger beside a retained clone, the pointer label
 * that may continue it, and the branch a continued attempt works on.
 *
 * A workspace belongs to the item and the repository it was created for, and to
 * nobody else: a pointer label is untrusted text on an issue, so the id, the
 * resolved path, and what the ledger records are all checked before anything is
 * reopened. A checkout a coding turn left on a branch of its own is returned to
 * the recorded branch by fast-forwarding it — losing no commit — and anything
 * else stops with the branch names and the paths instead of being forced.
 *
 * Every case works in temporary repositories, and the Git environment is the
 * suite's own private one.
 */
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../src/workspace/errors.js';
import { inspectBranchStanding, returnToRecordedBranch } from '../src/workspace/branch.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import { reopenWorkspace, resolveWorkspace } from '../src/workspace/reopen.js';
import type { WorkspaceExpectation } from '../src/workspace/reopen.js';
import {
  readWorkspaceState,
  recordWorkspaceAttempt,
  workspaceStatePath,
  writeWorkspaceState,
} from '../src/workspace/state.js';
import type { WorkspaceSourceItem, WorkspaceState } from '../src/workspace/state.js';
import { createRepository, gitOrFail, useIsolatedGitEnvironment } from './integration-support.js';
import type { RepositoryFixture } from './integration-support.js';

useIsolatedGitEnvironment();

/** The external item every case's workspace belongs to. */
const ITEM: WorkspaceSourceItem = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10001',
  key: 'HARN-23',
};

/** Another item on the same site, and the same item on another site. */
const OTHER_ITEM: WorkspaceSourceItem = { ...ITEM, id: '10002', key: 'HARN-24' };
const OTHER_SITE: WorkspaceSourceItem = { ...ITEM, scope: 'https://other.atlassian.net' };

/** The committed HEAD of a repository or working copy. */
async function headOf(repository: string): Promise<string> {
  return (await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], repository)).trim();
}

/** A working copy prepared for {@link ITEM}, and the fixture it came from. */
async function preparedWorkspace(): Promise<{
  readonly fixture: RepositoryFixture;
  readonly prepared: PreparedWorkspace;
}> {
  const fixture = await createRepository();
  const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
  const run = await allocateRunDirectory(fixture.workDir);
  const prepared = await prepareWorkspace(
    run,
    source,
    { deadlineMs: Date.now() + 120_000, now: () => new Date() },
    ITEM,
  );
  return { fixture, prepared };
}

/** What a continuation of the fixture's own item and repository must match. */
function expectation(
  fixture: RepositoryFixture,
  parts: Partial<WorkspaceExpectation> = {},
): WorkspaceExpectation {
  return {
    sourceItem: ITEM,
    sourceRoot: realpathSync.native(fixture.repo),
    ...parts,
  };
}

describe('a workspace that outlives its run', () => {
  it('is recorded in a ledger beside the clone, and reopens by its id', async () => {
    const { fixture, prepared } = await preparedWorkspace();
    const ledgerPath = workspaceStatePath(fixture.workDir, prepared.workspaceId);

    const state = await readWorkspaceState(fixture.workDir, prepared.workspaceId);
    expect(state?.version).toBe(1);
    expect(state?.workspaceId).toBe(prepared.runId);
    expect(state?.sourceRoot).toBe(realpathSync.native(fixture.repo));
    expect(state?.baseCommit).toBe(prepared.baseCommit);
    expect(state?.branch).toBe(prepared.branch);
    expect(state?.sourceItem).toEqual(ITEM);
    expect(state?.attempts).toEqual([]);
    expect(Number.isNaN(Date.parse(state?.createdAt ?? ''))).toBe(false);

    const resolution = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      throw new Error(resolution.problem);
    }
    expect(resolution.workspace.branch).toBe(prepared.branch);
    expect(resolution.workspace.baseCommit).toBe(prepared.baseCommit);
    expect(resolution.workspace.attempt).toBe(1);

    // Reopening reads the checkout and changes nothing about it.
    const head = await headOf(prepared.workspacePath);
    const continued = await reopenWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    );
    expect(continued.workspacePath).toBe(prepared.workspacePath);
    expect(await readFile(ledgerPath, 'utf8')).toContain('HARN-23');
    expect(await headOf(prepared.workspacePath)).toBe(head);
  }, 90_000);

  it('reopens a workspace whose earlier attempt committed in it', async () => {
    const { fixture, prepared } = await preparedWorkspace();
    await writeFile(path.join(prepared.workspacePath, 'work.txt'), 'committed work\n', 'utf8');
    await gitOrFail(['add', '--all'], prepared.workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'the attempt’s work'],
      prepared.workspacePath,
    );
    const tip = await headOf(prepared.workspacePath);
    expect(tip).not.toBe(prepared.baseCommit);

    const continued = await reopenWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    );

    // The base stays the recorded one; the checkout is simply ahead of it.
    expect(continued.baseCommit).toBe(prepared.baseCommit);
    expect(continued.branch).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(tip);
  }, 90_000);

  it('counts the attempts its ledger records, and refuses a name it never wrote', async () => {
    const { fixture, prepared } = await preparedWorkspace();

    await recordWorkspaceAttempt(fixture.workDir, prepared.workspaceId, {
      runId: prepared.runId,
      outcome: 'failed',
      endedAt: new Date().toISOString(),
      reportPath: path.join(prepared.runDir, 'result.json'),
    });

    const resolution = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    );
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.workspace.attempt).toBe(2);
    }
    await expect(
      recordWorkspaceAttempt(fixture.workDir, 'HARN-99', {
        runId: prepared.runId,
        outcome: 'failed',
        endedAt: new Date().toISOString(),
        reportPath: path.join(prepared.runDir, 'result.json'),
      }),
    ).rejects.toThrow(/has no ledger/);
  }, 90_000);

  it('refuses a pointer label that could name a path, before it is used as one', async () => {
    const { fixture, prepared } = await preparedWorkspace();

    for (const label of ['../evil', 'a/b', '', 'run id', 'C:\\Windows']) {
      const resolution = await resolveWorkspace(fixture.workDir, label, expectation(fixture));
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) {
        expect(resolution.problem).toContain('does not name a usable workspace');
      }
    }

    // The workspace the label would have named is untouched.
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
  }, 90_000);

  it('refuses a pointer this machine has no workspace for', async () => {
    const { fixture } = await preparedWorkspace();

    const resolution = await resolveWorkspace(fixture.workDir, 'HARN-99', expectation(fixture));

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.problem).toContain('this machine has no workspace at');
      expect(resolution.problem).toContain('HARN-99');
    }
  }, 90_000);

  it('refuses a pointer on another item, another site, or another repository', async () => {
    const { fixture, prepared } = await preparedWorkspace();
    const other = await createRepository();
    const otherSource = await preflightSource({
      repoPath: other.repo,
      workDir: other.workDir,
    });

    const forAnotherItem = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture, { sourceItem: OTHER_ITEM }),
    );
    expect(forAnotherItem.ok).toBe(false);
    if (!forAnotherItem.ok) {
      expect(forAnotherItem.problem).toContain('was created for');
      expect(forAnotherItem.problem).toContain('not for this item');
    }

    const forAnotherSite = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture, { sourceItem: OTHER_SITE }),
    );
    expect(forAnotherSite.ok).toBe(false);

    const forAnotherRepository = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture, { sourceRoot: otherSource.sourceRoot }),
    );
    expect(forAnotherRepository.ok).toBe(false);
    if (!forAnotherRepository.ok) {
      expect(forAnotherRepository.problem).toContain('which was cloned from');
      expect(forAnotherRepository.problem).toContain(otherSource.sourceRoot);
    }
  }, 120_000);

  it('refuses a ledger it did not write, and one that records no identity', async () => {
    const { fixture, prepared } = await preparedWorkspace();
    const ledgerPath = workspaceStatePath(fixture.workDir, prepared.workspaceId);
    const written = await readFile(ledgerPath, 'utf8');

    // A version this harness never wrote, and a document that is not one at all.
    await writeFile(
      ledgerPath,
      `${JSON.stringify({ version: 2, workspaceId: prepared.runId })}\n`,
      'utf8',
    );
    const rewritten = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    );
    expect(rewritten.ok).toBe(false);
    if (!rewritten.ok) {
      expect(rewritten.problem).toContain('ledger cannot be read');
    }

    // A ledger this harness wrote before identities were recorded: the harness
    // performs no adoption or migration, and says how to repair it by hand.
    const state = JSON.parse(written) as WorkspaceState;
    await writeWorkspaceState(fixture.workDir, { ...state, sourceItem: null });
    const unidentified = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    );
    expect(unidentified.ok).toBe(false);
    if (!unidentified.ok) {
      expect(unidentified.problem).toContain('records no source item identity');
      expect(unidentified.problem).toContain('The harness never adopts or migrates a workspace');
    }

    // The clone itself was never touched by any of it.
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
  }, 90_000);

  it('refuses a pointer whose workspace is a link out of the workspaces root', async (context) => {
    const { fixture, prepared } = await preparedWorkspace();
    const escape = path.join(fixture.workDir, 'workspaces', 'ESCAPE');
    try {
      await symlink(fixture.repo, escape, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      context.skip();
      return;
    }

    const resolution = await resolveWorkspace(fixture.workDir, 'ESCAPE', expectation(fixture));

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.problem).toContain('not where this harness keeps workspaces');
    }
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
  }, 90_000);

  it('refuses a checkout holding uncommitted work when a turn would start on it', async () => {
    const { fixture, prepared } = await preparedWorkspace();
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'left behind\n', 'utf8');

    const error = await reopenWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    ).then(
      () => null,
      (cause: Error) => cause,
    );

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error?.message).toContain('holds uncommitted changes');
    expect(error?.message).toContain('left.txt');
    expect(error?.message).toContain('never commits, stashes, or discards');
    // Nothing was committed or discarded for it.
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
    expect(
      (await gitOrFail(['status', '--porcelain=v1'], prepared.workspacePath)).includes('left.txt'),
    ).toBe(true);
  }, 90_000);

  it('refuses a checkout on no branch, because which branch it belongs on is a guess', async () => {
    const { fixture, prepared } = await preparedWorkspace();
    await gitOrFail(['checkout', '--quiet', '--detach'], prepared.workspacePath);

    const standing = await inspectBranchStanding(prepared.workspacePath, prepared.branch);
    expect(standing.kind).toBe('refused');
    if (standing.kind === 'refused') {
      expect(standing.problem).toContain('is on no branch (a detached HEAD)');
      expect(standing.problem).toContain(prepared.branch);
    }
    const error = await reopenWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    ).then(
      () => null,
      (cause: Error) => cause,
    );
    expect(error?.message).toContain('detached HEAD');
  }, 90_000);
});

describe('a retained checkout that left its recorded branch', () => {
  it('is returned to the recorded branch by fast-forwarding it, losing no commit', async () => {
    const { prepared } = await preparedWorkspace();
    await gitOrFail(['checkout', '--quiet', '-b', 'side'], prepared.workspacePath);
    await writeFile(
      path.join(prepared.workspacePath, 'side.txt'),
      'work on a branch of its own\n',
      'utf8',
    );
    await gitOrFail(['add', '--all'], prepared.workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'the turn’s own branch'],
      prepared.workspacePath,
    );
    const revision = await headOf(prepared.workspacePath);

    const standing = await inspectBranchStanding(prepared.workspacePath, prepared.branch);
    expect(standing.kind).toBe('recoverable');

    const returned = await returnToRecordedBranch(prepared.workspacePath, prepared.branch);

    expect(returned).toEqual({ changed: true, from: 'side', revision });
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(
      (
        await gitOrFail(['symbolic-ref', '--quiet', '--short', 'HEAD'], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.branch);
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe('');
    // The commit the checkout held is still there, and the branch it was made on
    // still names it: nothing was reset or discarded.
    expect(
      (
        await gitOrFail(
          ['rev-parse', '--verify', 'refs/heads/side^{commit}'],
          prepared.workspacePath,
        )
      ).trim(),
    ).toBe(revision);
  }, 90_000);

  it('is left exactly where it is when it is already on the recorded branch', async () => {
    const { prepared } = await preparedWorkspace();
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'left behind\n', 'utf8');
    const head = await headOf(prepared.workspacePath);

    const returned = await returnToRecordedBranch(prepared.workspacePath, prepared.branch);

    expect(returned).toEqual({ changed: false });
    // The ordinary state a round reads after a turn, uncommitted work included.
    expect(await headOf(prepared.workspacePath)).toBe(head);
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe(
      '?? left.txt',
    );
  }, 90_000);

  it('refuses to switch a dirty branch of its own, naming both branches and the paths', async () => {
    const { prepared } = await preparedWorkspace();
    await gitOrFail(['checkout', '--quiet', '-b', 'side'], prepared.workspacePath);
    await writeFile(
      path.join(prepared.workspacePath, 'uncommitted.txt'),
      'not committed\n',
      'utf8',
    );

    const standing = await inspectBranchStanding(prepared.workspacePath, prepared.branch);
    expect(standing.kind).toBe('refused');
    if (standing.kind === 'refused') {
      expect(standing.problem).toContain('"side"');
      expect(standing.problem).toContain(`"${prepared.branch}"`);
      expect(standing.problem).toContain('uncommitted.txt');
    }
    // Nothing was switched, committed, or discarded for it.
    expect(
      (
        await gitOrFail(['symbolic-ref', '--quiet', '--short', 'HEAD'], prepared.workspacePath)
      ).trim(),
    ).toBe('side');
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe(
      '?? uncommitted.txt',
    );
  }, 90_000);

  it('refuses a commit the recorded branch does not descend from, naming both revisions', async () => {
    const { prepared } = await preparedWorkspace();
    // A commit on a branch of its own...
    await gitOrFail(['checkout', '--quiet', '-b', 'side'], prepared.workspacePath);
    await writeFile(path.join(prepared.workspacePath, 'side.txt'), 'side\n', 'utf8');
    await gitOrFail(['add', '--all'], prepared.workspacePath);
    await gitOrFail(['commit', '--quiet', '--message', 'side work'], prepared.workspacePath);
    const side = await headOf(prepared.workspacePath);
    // ...and one the recorded branch moved on with, so neither contains the other.
    await gitOrFail(['checkout', '--quiet', prepared.branch], prepared.workspacePath);
    await writeFile(path.join(prepared.workspacePath, 'recorded.txt'), 'recorded\n', 'utf8');
    await gitOrFail(['add', '--all'], prepared.workspacePath);
    await gitOrFail(['commit', '--quiet', '--message', 'recorded work'], prepared.workspacePath);
    const recorded = await headOf(prepared.workspacePath);
    await gitOrFail(['checkout', '--quiet', 'side'], prepared.workspacePath);

    const standing = await inspectBranchStanding(prepared.workspacePath, prepared.branch);

    expect(standing.kind).toBe('refused');
    if (standing.kind === 'refused') {
      expect(standing.problem).toContain(side);
      expect(standing.problem).toContain(recorded);
      expect(standing.problem).toContain('Nothing was switched, reset, or force-updated');
    }
    expect(await headOf(prepared.workspacePath)).toBe(side);
    expect(
      (
        await gitOrFail(
          ['rev-parse', '--verify', `refs/heads/${prepared.branch}^{commit}`],
          prepared.workspacePath,
        )
      ).trim(),
    ).toBe(recorded);
  }, 90_000);

  it('refuses a checkout whose recorded branch the workspace does not hold', async () => {
    const { prepared } = await preparedWorkspace();
    await gitOrFail(['checkout', '--quiet', '-b', 'side'], prepared.workspacePath);
    await gitOrFail(
      ['branch', '--quiet', '--delete', '--force', prepared.branch],
      prepared.workspacePath,
    );

    const standing = await inspectBranchStanding(prepared.workspacePath, prepared.branch);

    expect(standing.kind).toBe('refused');
    if (standing.kind === 'refused') {
      expect(standing.problem).toContain('it holds no branch named');
      expect(standing.problem).toContain('never recreates, renames, or adopts a branch');
    }
  }, 90_000);
});
