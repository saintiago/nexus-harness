/**
 * Workspace ownership: the ledger beside a retained clone, the pointer label
 * that may continue it, and the branch a continued attempt works on.
 *
 * A workspace belongs to the item and the repository it was created for, and to
 * nobody else: a pointer label is untrusted text on an issue, so the id, the
 * resolved path, and what the ledger records are all checked before anything is
 * reopened. A checkout a coding turn left on a branch of its own is returned to
 * the recorded branch by fast-forwarding it — losing no commit, overwriting no
 * ignored local file whatever Git configuration says, and reading the state it
 * left back rather than trusting that exit code — while anything else stops
 * with the branch names and the paths instead of being forced.
 *
 * Every case works in temporary repositories, and the Git environment is the
 * suite's own private one.
 */
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../src/workspace/errors.js';
import { inspectBranchStanding, returnToRecordedBranch } from '../../src/workspace/branch.js';
import { prepareWorkspace } from '../../src/workspace/prepare.js';
import type { PreparedWorkspace } from '../../src/workspace/prepare.js';
import { preflightSource } from '../../src/workspace/preflight.js';
import { allocateRunDirectory } from '../../src/workspace/run-directory.js';
import { reopenWorkspace, resolveWorkspace } from '../../src/workspace/reopen.js';
import type { WorkspaceExpectation } from '../../src/workspace/reopen.js';
import {
  readWorkspaceState,
  recordWorkspaceAttempt,
  workspaceStatePath,
  writeWorkspaceState,
} from '../../src/workspace/state.js';
import type { WorkspaceSourceItem, WorkspaceState } from '../../src/workspace/state.js';
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

/** A working copy of `fixture` prepared for {@link ITEM}. */
async function prepareFrom(fixture: RepositoryFixture): Promise<PreparedWorkspace> {
  const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
  const run = await allocateRunDirectory(fixture.workDir);
  return await prepareWorkspace(
    run,
    source,
    { deadlineMs: Date.now() + 120_000, now: () => new Date() },
    ITEM,
  );
}

/** A working copy prepared for {@link ITEM}, and the fixture it came from. */
async function preparedWorkspace(): Promise<{
  readonly fixture: RepositoryFixture;
  readonly prepared: PreparedWorkspace;
}> {
  const fixture = await createRepository();
  const prepared = await prepareFrom(fixture);
  return { fixture, prepared };
}

/** The commit one branch of a working copy holds. */
async function tipOf(workspacePath: string, branch: string): Promise<string> {
  return (await gitOrFail(['rev-parse', '--verify', `refs/heads/${branch}`], workspacePath)).trim();
}

/** The branch the checkout is on, as Git names it. */
async function currentBranchOf(workspacePath: string): Promise<string> {
  return (await gitOrFail(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath)).trim();
}

/**
 * Leaves the prepared workspace the way a coding turn can: the checkout is on a
 * branch of its own with the turn's work committed there, and the recorded
 * branch still where the attempt started from.
 */
async function leaveOnOwnBranch(prepared: PreparedWorkspace, branch: string): Promise<string> {
  await gitOrFail(['checkout', '--quiet', '-b', branch], prepared.workspacePath);
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
  return await headOf(prepared.workspacePath);
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

  it('refuses a pointer whose ledger is a link out of the workspaces root', async (context) => {
    const { fixture, prepared } = await preparedWorkspace();
    // The clone is a real workspace where the layout puts it; the record beside
    // it is the workspace's own ledger, which this case moves outside the
    // workspaces root and links back to the name the layout gives it. The
    // ledger half of the layout is checked on its resolved path exactly as the
    // clone half is: a name that resolves to a record outside the root is
    // refused before anything is read through it.
    const ledgerPath = workspaceStatePath(fixture.workDir, prepared.workspaceId);
    const outside = path.join(fixture.parent, 'outside-ledger');
    await mkdir(outside);
    const recordPath = path.join(outside, `${prepared.workspaceId}.json`);
    await rename(ledgerPath, recordPath);
    const record = await readFile(recordPath, 'utf8');

    // An ordinary symbolic link to the moved record is what this looks like. A
    // host whose account may not create one — Windows without the developer
    // privilege — still allows a junction to the directory holding it, which
    // the same check resolves out of the root; a host that allows neither is
    // not this case's subject.
    let linked = true;
    try {
      await symlink(recordPath, ledgerPath, 'file');
    } catch {
      try {
        await symlink(outside, ledgerPath, 'junction');
      } catch {
        linked = false;
      }
    }
    if (!linked) {
      context.skip();
      return;
    }
    const linkTarget = await readlink(ledgerPath);

    const resolution = await resolveWorkspace(
      fixture.workDir,
      prepared.workspaceId,
      expectation(fixture),
    );

    // A refusal, not an exception and not a continuation: the record is never
    // read through the link, and the refusal says where it really resolves and
    // what an operator can do about it.
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.problem).toContain('ledger');
      expect(resolution.problem).toContain(ledgerPath);
      expect(resolution.problem).toContain(realpathSync.native(outside));
      expect(resolution.problem).toMatch(/junction or symbolic link/);
      expect(resolution.problem).toMatch(/Put the workspace's own ledger back/);
    }

    // Nothing was read, written, or adopted through the link: the external
    // record keeps its bytes and its name still points at it, and the clone
    // beside it is where the earlier attempt left it.
    expect(await readFile(recordPath, 'utf8')).toBe(record);
    expect((await lstat(ledgerPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(ledgerPath)).toBe(linkTarget);
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

  it('fast-forwards the recorded branch even when Git configuration would squash the merge', async () => {
    const { prepared } = await preparedWorkspace();
    const revision = await leaveOnOwnBranch(prepared, 'side');

    // Git reads `branch.<name>.mergeOptions` when merging into that branch, and
    // `--ff-only` does not cancel a configured `--squash`: a return that did not
    // pass `--no-squash` would exit successfully after staging the descendant
    // without moving the recorded branch, and hand a coding turn a staged
    // working copy instead of the returned branch. The result is read back, so
    // that state would be refused rather than reported as a reconciliation.
    await gitOrFail(
      ['config', `branch.${prepared.branch}.mergeOptions`, '--squash'],
      prepared.workspacePath,
    );

    const returned = await returnToRecordedBranch(
      prepared.workspacePath,
      prepared.branch,
      {},
      { requireClean: true },
    );

    // The recorded branch really moved to the commit the checkout held, the
    // checkout is on it, and nothing was left staged for the next turn.
    expect(returned).toEqual({ changed: true, from: 'side', revision });
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(await tipOf(prepared.workspacePath, prepared.branch)).toBe(revision);
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe('');
    expect(
      await inspectBranchStanding(
        prepared.workspacePath,
        prepared.branch,
        {},
        { requireClean: true },
      ),
    ).toEqual({ kind: 'on-branch' });
    expect(await tipOf(prepared.workspacePath, 'side')).toBe(revision);
  }, 90_000);

  it('refuses a return that would write over an ignored local file, keeping its bytes', async () => {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, 'settings.json'), 'the committed settings\n', 'utf8');
    await gitOrFail(['add', 'settings.json'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'track the settings'], fixture.repo);
    const prepared = await prepareFrom(fixture);

    // A turn of its own stops tracking the settings file, ignores it, and leaves
    // a locally regenerated copy. The harness's own reading calls that checkout
    // clean, because an ignored path never makes one dirty; checking the
    // recorded branch out would write the committed copy over the local one, so
    // Git is asked not to do that, and the refusal it produces stops the run
    // with the path named instead of destroying what the turn left.
    await gitOrFail(['checkout', '--quiet', '-b', 'side'], prepared.workspacePath);
    await gitOrFail(['rm', '--quiet', '--cached', 'settings.json'], prepared.workspacePath);
    await writeFile(path.join(prepared.workspacePath, '.gitignore'), 'settings.json\n', 'utf8');
    await gitOrFail(['add', '.gitignore'], prepared.workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'stop tracking the settings'],
      prepared.workspacePath,
    );
    await writeFile(
      path.join(prepared.workspacePath, 'settings.json'),
      'regenerated locally\n',
      'utf8',
    );
    const revision = await headOf(prepared.workspacePath);

    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'recoverable',
      currentBranch: 'side',
      revision,
      recorded: prepared.baseCommit,
    });

    const error = await returnToRecordedBranch(prepared.workspacePath, prepared.branch).then(
      () => null,
      (cause: Error) => cause,
    );

    // The refusal names both branches and the path Git would have written over,
    // and says the local file was left alone rather than destroyed.
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error?.message).toContain('"side"');
    expect(error?.message).toContain(`"${prepared.branch}"`);
    expect(error?.message).toContain('settings.json');
    expect(error?.message).toMatch(/nothing local was written over/);

    // The file's own bytes survive, and nothing moved: the checkout is still on
    // the branch the turn made, at its commit, and the recorded branch is still
    // where the attempt started from. The index and the working tree are the
    // ones the turn left, with nothing staged by the refused return.
    expect(await readFile(path.join(prepared.workspacePath, 'settings.json'), 'utf8')).toBe(
      'regenerated locally\n',
    );
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe('');
    expect(await currentBranchOf(prepared.workspacePath)).toBe('side');
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(await tipOf(prepared.workspacePath, prepared.branch)).toBe(prepared.baseCommit);
  }, 90_000);

  it('refuses a return that did not really move the recorded branch, reading its own result back', async () => {
    const { prepared } = await preparedWorkspace();
    const revision = await leaveOnOwnBranch(prepared, 'side');

    // Git runs hooks after a merge, and a hook can leave the recorded branch
    // wherever it likes while the command still exits 0. The return reads its
    // own result back instead of trusting that exit code, so what it reports is
    // the state that really exists rather than the one it asked for. The hooks
    // path is pinned in the workspace's own configuration so a developer's
    // global setting cannot decide whether the fixture's hook runs.
    await gitOrFail(['config', 'core.hooksPath', '.git/hooks'], prepared.workspacePath);
    const hookPath = path.join(prepared.workspacePath, '.git', 'hooks', 'post-merge');
    await writeFile(
      hookPath,
      `#!/bin/sh\ngit update-ref refs/heads/${prepared.branch} ${prepared.baseCommit}\n` +
        'echo ran > .git/hook-ran.txt\n',
      'utf8',
    );
    // Git skips a hook that is not executable on a POSIX host, and runs one
    // either way on Windows: the bit is set so the fixture takes the same path
    // wherever the suite runs.
    await chmod(hookPath, 0o755);
    const markerPath = path.join(prepared.workspacePath, '.git', 'hook-ran.txt');

    const error = await returnToRecordedBranch(prepared.workspacePath, prepared.branch).then(
      () => null,
      (cause: Error) => cause,
    );

    // The hook really ran, so what follows is about a return that did not end
    // where it promised rather than about a host that skipped the hook.
    expect(existsSync(markerPath)).toBe(true);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error?.message).toContain(`"${prepared.branch}"`);
    expect(error?.message).toContain(prepared.baseCommit);
    expect(error?.message).toContain(revision);
    expect(error?.message).toMatch(/read back rather than assumed/);
    expect(error?.message).toMatch(/Nothing was reset, force-updated, or discarded/);

    // The commit the turn made is still on the branch it made it on.
    expect(await tipOf(prepared.workspacePath, 'side')).toBe(revision);
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
