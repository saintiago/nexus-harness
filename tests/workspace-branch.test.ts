/**
 * A workspace that outlives its run, and a checkout that left its recorded branch.
 *
 * Real Git repositories in temporary directories, driven through real child processes: the retention contract (a continued workspace keeps the clone, the ledger and the pointer that name it) and the branch contract (a checkout a turn left on a branch of its own is returned to the recorded branch before the next turn, and a checkout that cannot be returned is refused before anything is claimed).
 */

import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { inspectBranchStanding, returnToRecordedBranch } from '../src/workspace/branch.js';
import { inspectWorkspaceChanges } from '../src/workspace/changes.js';
import { WorkspaceError } from '../src/workspace/errors.js';

import type { PreparedWorkspace } from '../src/workspace/prepare.js';

import { reopenWorkspace, resolveWorkspace } from '../src/workspace/reopen.js';
import { workspacePathFor } from '../src/workspace/run-directory.js';

import { readWorkspaceState, workspaceStatePath } from '../src/workspace/state.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import {
  gitOrFail,
  type Fixture,
  createRepository,
  headOf,
  createAlias,
  prepareRun,
  FIXTURE_SOURCE_ITEM,
} from './fixtures/workspace.js';
import { beginFixtureGitEnvironment } from './fixtures/workspace.js';

useFixtureLifecycle();

beforeEach(beginFixtureGitEnvironment);

describe('a workspace that outlives its run', () => {
  it('is recorded in a ledger beside the clone, and reopens by its id', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    // The ledger says what the clone is, and holds no attempts yet.
    const ledger = await readWorkspaceState(fixture.workDir, prepared.workspaceId);
    expect(ledger).toMatchObject({
      version: 1,
      workspaceId: prepared.workspaceId,
      branch: `harness/${prepared.runId}`,
      baseCommit: prepared.baseCommit,
      attempts: [],
    });
    expect(existsSync(workspaceStatePath(fixture.workDir, prepared.workspaceId))).toBe(true);

    // Resolving is a read: the clone, the ledger, and which attempt comes next.
    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.workspace.workspacePath).toBe(prepared.workspacePath);
      expect(resolved.workspace.attempt).toBe(1);
    }

    // Reopening reads the checkout and returns it for the next attempt.
    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.workspacePath).toBe(prepared.workspacePath);
    expect(reopened.branch).toBe(prepared.branch);
    expect(reopened.attempt).toBe(1);
  });

  it('reopens a workspace whose earlier attempt committed in it', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // A coding turn commits its own work locally, so the branch is expected to
    // move forward from the recorded base; the recorded base is what stays.
    await writeFile(path.join(prepared.workspacePath, 'committed.txt'), 'a checkpoint\n', 'utf8');
    // The file is named rather than staged with `--all`: a host whose Git
    // rewrites line endings at checkout would otherwise renormalize the files
    // this fixture never touched.
    await gitOrFail(['add', 'committed.txt'], prepared.workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'a checkpoint an attempt made'],
      prepared.workspacePath,
    );
    expect(await headOf(prepared.workspacePath)).not.toBe(prepared.baseCommit);

    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.workspacePath).toBe(prepared.workspacePath);
    expect(reopened.branch).toBe(prepared.branch);
    expect(reopened.baseCommit).toBe(prepared.baseCommit);
    expect(reopened.attempt).toBe(1);

    // The commit is visible against the recorded base, exactly as uncommitted
    // work is: reopening loses nothing.
    const changes = await inspectWorkspaceChanges(prepared);
    const committed = changes.find((change) => change.path === 'committed.txt');
    expect(committed?.kind).toBe('added');
    expect(committed?.states).toEqual(['committed']);
  });

  it('refuses a workspace on no branch, naming the branch it records and the manual action', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // A detached checkout names no branch, so which branch its commit belongs
    // on is a guess the harness does not make: it is refused rather than
    // continued or adopted (HARN-35).
    await gitOrFail(['checkout', '--quiet', '--detach'], prepared.workspacePath);

    await expect(
      reopenWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      }),
    ).rejects.toThrow(
      new RegExp(
        `on no branch \\(a detached HEAD\\), not on its recorded branch ` +
          `"${prepared.branch}".*check out the recorded branch by hand`,
      ),
    );
  });

  it('refuses a workspace that is not where the layout puts it', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // One layout, and nothing else: a clone left in the pre-split location, with
    // its ledger beside the workspaces, is not adopted silently. A workDir from an
    // older harness is upgraded by moving its workspaces and runs into place
    // (docs/implement-workspace-continuation.md).
    const preSplit = path.join(fixture.workDir, prepared.workspaceId, 'workspace');
    await mkdir(path.dirname(preSplit), { recursive: true });
    await rename(prepared.workspacePath, preSplit);

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain(workspacePathFor(fixture.workDir, prepared.workspaceId));
    }
  });

  it('refuses a pointer whose workspace directory is a junction out of the workspaces root', async (context) => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // The id is generated and the name lies inside the workspaces root, but the
    // directory it names is a junction to one outside it: the label is followed
    // to where the directory really is, and a pointer is never followed out of
    // the workspaces root (docs/implement-workspace-continuation.md).
    const outside = path.join(fixture.parent, 'outside');
    await rename(prepared.workspacePath, outside);
    if (!(await createAlias(outside, prepared.workspacePath, 'junction'))) {
      // Junctions need no elevation on Windows; other hosts may lack them.
      if (process.platform === 'win32') {
        throw new Error(`could not create a junction at "${prepared.workspacePath}"`);
      }
      context.skip();
      return;
    }
    expect(realpathSync.native(prepared.workspacePath)).toBe(realpathSync.native(outside));

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });

    // A refusal, not an exception: a scan goes on to publish why, rather than
    // ending on a containment check it could not express.
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain(prepared.workspaceId);
      expect(resolved.problem).toContain(prepared.workspacePath);
      expect(resolved.problem).toContain(realpathSync.native(outside));
      expect(resolved.problem).toContain(
        realpathSync.native(path.join(fixture.workDir, 'workspaces')),
      );
      expect(resolved.problem).toMatch(/junction or symbolic link/);
      expect(resolved.problem).toMatch(/Move the workspace's real directory/);
    }
    // Nothing was opened through the alias: the directory it reaches is whole.
    expect(existsSync(path.join(outside, '.git'))).toBe(true);
  });

  it('refuses a pointer whose ledger is a link out of the workspaces root', async (context) => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // The clone is a real workspace where the layout puts it; the record beside
    // it is a link to a file somewhere else, which a continuation will not read.
    const ledgerPath = workspaceStatePath(fixture.workDir, prepared.workspaceId);
    const outside = path.join(fixture.parent, 'outside-ledger.json');
    await rename(ledgerPath, outside);
    if (!(await createAlias(outside, ledgerPath, 'file'))) {
      // A file symlink needs elevation or developer mode on Windows; the
      // junction case above covers the alias behavior on that platform.
      expect(process.platform).toBe('win32');
      context.skip();
      return;
    }

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('ledger');
      expect(resolved.problem).toContain(ledgerPath);
      expect(resolved.problem).toContain(realpathSync.native(outside));
      expect(resolved.problem).toMatch(/junction or symbolic link/);
      expect(resolved.problem).toMatch(/Put the workspace's own ledger back/);
    }
  });

  it('refuses a pointer that is not a generated workspace id, before using it as a path', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const unusable = [
      '../evil',
      'a/b',
      'a\\b',
      '..',
      '.',
      '',
      'C:\\evil',
      'run.lock',
      'x'.repeat(65),
    ];

    for (const pointer of unusable) {
      const resolved = await resolveWorkspace(fixture.workDir, pointer, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.problem).toMatch(/not a usable workspace id/);
      }
      // The id never becomes a path: an unusable one throws before it is joined.
      expect(() => workspacePathFor(fixture.workDir, pointer)).toThrow(WorkspaceError);
    }
    // A generated id still resolves to its own workspace.
    expect(workspacePathFor(fixture.workDir, prepared.workspaceId)).toBe(prepared.workspacePath);
  });

  it('refuses a pointer on another item, and says which item the workspace belongs to', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: { ...FIXTURE_SOURCE_ITEM, id: '10012', key: 'SAM1-12' },
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('created for jira SAM1-11 (immutable id 10011)');
      expect(resolved.problem).toContain('not for this item (jira SAM1-12 (immutable id 10012)');
    }
  });

  it('refuses a pointer from another site, even for the same immutable id', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: { ...FIXTURE_SOURCE_ITEM, scope: 'https://other.atlassian.net' },
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('on https://example.atlassian.net');
      expect(resolved.problem).toContain('on https://other.atlassian.net');
    }
  });

  it('refuses a workspace cloned from another repository', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const elsewhere = path.join(fixture.parent, 'somewhere-else');

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: elsewhere,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain(`cloned from "${prepared.sourceRoot}"`);
      expect(resolved.problem).toContain(`"${elsewhere}"`);
    }
  });

  it('refuses a ledger with no source item identity, and says how to repair it by hand', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const ledger = await readWorkspaceState(fixture.workDir, prepared.workspaceId);
    if (ledger === null) {
      throw new Error('the fixture workspace has no ledger');
    }

    // A ledger written before identities were recorded: the same content without
    // the sourceItem field, which is the recorded absence of an identity.
    const firstAttempt = {
      runId: prepared.runId,
      outcome: 'failed',
      endedAt: '2026-01-01T00:00:00.000Z',
      reportPath: `/runs/${prepared.runId}/result.json`,
    };
    const withoutIdentity = {
      version: 1,
      workspaceId: ledger.workspaceId,
      sourceRoot: ledger.sourceRoot,
      baseCommit: ledger.baseCommit,
      branch: ledger.branch,
      createdAt: ledger.createdAt,
      attempts: [firstAttempt],
    };

    await writeFile(
      workspaceStatePath(fixture.workDir, prepared.workspaceId),
      `${JSON.stringify(withoutIdentity)}\n`,
      'utf8',
    );

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('records no source item identity');
      expect(resolved.problem).toContain('"sourceItem"');
      expect(resolved.problem).toContain(firstAttempt.reportPath);
      expect(resolved.problem).toContain('never adopts or migrates');
    }

    // The repair the refusal names makes the same workspace continuable again.
    await writeFile(
      workspaceStatePath(fixture.workDir, prepared.workspaceId),
      `${JSON.stringify({ ...withoutIdentity, sourceItem: FIXTURE_SOURCE_ITEM })}\n`,
      'utf8',
    );
    const repaired = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(repaired.workspacePath).toBe(prepared.workspacePath);
  });

  it('refuses a ledger it did not write: unsupported versions, identities, and attempts are never reused', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const ledger = await readWorkspaceState(fixture.workDir, prepared.workspaceId);
    if (ledger === null) {
      throw new Error('the fixture workspace has no ledger');
    }
    const ledgerPath = workspaceStatePath(fixture.workDir, prepared.workspaceId);
    const attempt = {
      runId: prepared.runId,
      outcome: 'failed',
      endedAt: '2026-01-01T00:00:00.000Z',
      reportPath: `/runs/${prepared.runId}/result.json`,
    };
    const written = {
      version: 1,
      workspaceId: ledger.workspaceId,
      sourceRoot: ledger.sourceRoot,
      baseCommit: ledger.baseCommit,
      branch: ledger.branch,
      createdAt: ledger.createdAt,
      sourceItem: FIXTURE_SOURCE_ITEM,
      attempts: [attempt],
    };

    // Each record below is one this harness never writes: an unsupported
    // version, an identity of the wrong shape, and an attempt whose fields a
    // continuation and its guidance would read. None is cast into something
    // usable, and none is repaired or migrated automatically.
    const unreadable: readonly { readonly ledger: unknown; readonly problem: string }[] = [
      {
        ledger: { ...written, version: 2 },
        problem: 'version',
      },
      {
        ledger: { ...written, sourceItem: { type: 'jira', scope: FIXTURE_SOURCE_ITEM.scope } },
        problem: 'sourceItem.id',
      },
      {
        ledger: {
          ...written,
          attempts: [{ ...attempt, outcome: 'green' }],
        },
        problem: 'attempts.0.outcome',
      },
      {
        ledger: { ...written, attempts: [{ runId: prepared.runId }] },
        problem: 'attempts.0.endedAt',
      },
      {
        // A nonblank string is not enough for the end of an attempt: it is
        // parsed as the moment a continuation reads comments since, so a value
        // that is not an instant is refused rather than read as `NaN`.
        ledger: { ...written, attempts: [{ ...attempt, endedAt: 'not-a-date' }] },
        problem: 'attempts.0.endedAt',
      },
      {
        // Nor is a date `Date.parse` would quietly roll over: this harness
        // refuses a timestamp it did not write instead of coercing it into one.
        ledger: { ...written, attempts: [{ ...attempt, endedAt: '2026-02-30T00:00:00.000Z' }] },
        problem: 'attempts.0.endedAt',
      },
    ];

    for (const entry of unreadable) {
      await writeFile(ledgerPath, `${JSON.stringify(entry.ledger)}\n`, 'utf8');

      const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      });

      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        // The refusal names the file and the field, and never tells an operator
        // to add a value that is already there or to treat the record as absent.
        expect(resolved.problem).toContain(ledgerPath);
        expect(resolved.problem).toContain(entry.problem);
        expect(resolved.problem).not.toContain('records no source item identity');
      }
      await expect(
        reopenWorkspace(fixture.workDir, prepared.workspaceId, {
          sourceItem: FIXTURE_SOURCE_ITEM,
          sourceRoot: prepared.sourceRoot,
        }),
      ).rejects.toThrow(/cannot be continued/);
    }

    // A record this harness did write is read again, with the exact timestamp
    // form the harness writes: refusing the malformed ones above is a check on
    // their shape, not a refusal of the workspace.
    const now = new Date().toISOString();
    await writeFile(
      ledgerPath,
      `${JSON.stringify({ ...written, attempts: [{ ...attempt, endedAt: now }] })}\n`,
      'utf8',
    );
    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.attempt).toBe(2);
    expect((await readWorkspaceState(fixture.workDir, prepared.workspaceId))?.attempts).toEqual([
      { ...attempt, endedAt: now },
    ]);
  });
});

/**
 * A coding turn has write access to its clone, Git metadata included, so it can
 * commit its work on a branch of its own. The harness's own branch is what a
 * continuation reopens, what the checks judge and what a delivery step
 * publishes, so a clean checkout that descends from it is returned to it by
 * fast-forwarding, and a checkout that cannot be returned that way is refused
 * with the branch names and the manual action (HARN-35).
 */

describe('a retained checkout that left its recorded branch', () => {
  /** The failure one call rejects with, as a `WorkspaceError` to assert on. */
  async function refusalOf(call: () => Promise<unknown>): Promise<WorkspaceError> {
    const failure = await call().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceError);
    return failure as WorkspaceError;
  }

  /** The branch the checkout is on, or `''` when it is on no branch. */
  async function currentBranchOf(workspacePath: string): Promise<string> {
    return (await gitOrFail(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath)).trim();
  }

  /**
   * A repository fixture whose bytes survive every checkout: this host's system
   * Git configuration rewrites line endings at checkout, the harness's own Git
   * invocations inherit it while the fixture's do not, and without this a file
   * the fixture committed would read as modified after the harness checked it
   * out. tests/runner.test.ts commits the same file for the same reason.
   */
  async function createExactByteRepository(): Promise<Fixture> {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, '.gitattributes'), '* -text\n', 'utf8');
    await gitOrFail(['add', '.gitattributes'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'exact bytes'], fixture.repo);
    return fixture;
  }

  /**
   * Leaves the prepared workspace the way a coding turn can: the checkout is on
   * `branch`, with the turn's work committed there and the recorded branch
   * still where the attempt started from. `dirty` adds a path the turn never
   * committed; `commit: false` leaves a branch at the recorded tip.
   */
  async function leaveOnBranch(
    prepared: PreparedWorkspace,
    branch: string,
    options: { readonly commit?: boolean; readonly dirty?: boolean } = {},
  ): Promise<string> {
    await gitOrFail(['checkout', '--quiet', '-b', branch], prepared.workspacePath);
    if (options.commit !== false) {
      await writeFile(
        path.join(prepared.workspacePath, 'side.txt'),
        'work on a branch of its own\n',
        'utf8',
      );
      await gitOrFail(['add', 'side.txt'], prepared.workspacePath);
      await gitOrFail(
        ['commit', '--quiet', '--message', 'the work of a coding turn'],
        prepared.workspacePath,
      );
    }
    if (options.dirty === true) {
      await writeFile(
        path.join(prepared.workspacePath, 'leftover.txt'),
        'work the turn never committed\n',
        'utf8',
      );
    }
    return await headOf(prepared.workspacePath);
  }

  it('is returned to the recorded branch by fast-forwarding it, losing no commit', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

    // The reading names what would move and changes nothing.
    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'recoverable',
      currentBranch: 'task/side',
      revision,
      recorded: prepared.baseCommit,
    });
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');

    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: true,
      from: 'task/side',
      revision,
    });
    // The checkout is on the recorded branch at the commit the turn made, and
    // the branch the turn used still holds that commit: nothing was reset,
    // force-updated, or discarded.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(revision);
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe('');

    // Nothing is left to do the next time the checkout is read.
    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'on-branch',
    });
    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: false,
    });
  });

  it('returns a clean branch that is already at the recorded tip without moving either', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await leaveOnBranch(prepared, 'task/ordinary', { commit: false });

    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: true,
      from: 'task/ordinary',
      revision: prepared.baseCommit,
    });
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/ordinary'], prepared.workspacePath)).trim(),
    ).toBe(prepared.baseCommit);
  });

  it('fast-forwards the recorded branch even when Git configuration would squash the merge', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

    // Git reads `branch.<name>.mergeOptions` when merging into that branch, and
    // `--ff-only` does not cancel a configured `--squash`: a plain fast-forward
    // exits 0 after staging the descendant without moving the recorded branch.
    // A return that reported that as a reconciliation would hand a coding turn
    // a staged working copy, so the merge has to cancel the squash and the
    // result has to be read back.
    await gitOrFail(
      ['config', `branch.${prepared.branch}.mergeOptions`, '--squash'],
      prepared.workspacePath,
    );

    expect(
      await returnToRecordedBranch(
        prepared.workspacePath,
        prepared.branch,
        {},
        {
          requireClean: true,
        },
      ),
    ).toEqual({ changed: true, from: 'task/side', revision });

    // The recorded branch really moved to the commit the checkout held, the
    // checkout is on it, and nothing was left staged for the next turn.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(revision);
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe('');
    expect(
      await inspectBranchStanding(
        prepared.workspacePath,
        prepared.branch,
        {},
        { requireClean: true },
      ),
    ).toEqual({ kind: 'on-branch' });
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
  });

  it('refuses a return that would write over an ignored local file, keeping its bytes', async () => {
    const fixture = await createExactByteRepository();
    await writeFile(path.join(fixture.repo, 'settings.json'), 'the committed settings\n', 'utf8');
    await gitOrFail(['add', 'settings.json'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'track the settings'], fixture.repo);
    const prepared = await prepareRun(fixture);

    // A turn of its own stops tracking the settings file, ignores it, and
    // leaves a locally regenerated copy. The harness's own reading calls that
    // checkout clean, because an ignored path never makes one dirty; checking
    // the recorded branch out would write the committed copy over the local
    // one, and the fast-forward would then delete it.
    await gitOrFail(['checkout', '--quiet', '-b', 'task/side'], prepared.workspacePath);
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
      currentBranch: 'task/side',
      revision,
      recorded: prepared.baseCommit,
    });

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );

    // The refusal names both branches and the path Git would have written over,
    // and says the local file was left alone rather than destroyed.
    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain('settings.json');
    expect(failure.message).toMatch(/nothing local was written over/);

    // The file's own bytes survive, and nothing moved: the checkout is still on
    // the branch the turn made, at its commit, and the recorded branch is still
    // where the attempt started from.
    expect(await readFile(path.join(prepared.workspacePath, 'settings.json'), 'utf8')).toBe(
      'regenerated locally\n',
    );
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.baseCommit);
  });

  it('refuses a return that did not really move the branch, reading its own result back', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

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
    // wherever the suite runs. The marker the hook leaves inside the Git
    // directory is checked before the refusal is, so a host that skipped the
    // hook anyway fails on that precondition — which names the reason — rather
    // than on a refusal the test expected and did not get.
    await chmod(hookPath, 0o755);
    const markerPath = path.join(prepared.workspacePath, '.git', 'hook-ran.txt');

    const settled = await returnToRecordedBranch(prepared.workspacePath, prepared.branch).then(
      () => null,
      (error: unknown) => error,
    );
    expect(existsSync(markerPath)).toBe(true);
    expect(settled).toBeInstanceOf(WorkspaceError);
    const failure = settled as WorkspaceError;

    // The refusal names the branch and the revisions it really found, and it
    // says nothing was reset or discarded.
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain(prepared.baseCommit);
    expect(failure.message).toContain(revision);
    expect(failure.message).toMatch(/read back rather than assumed/);
    expect(failure.message).toMatch(/Nothing was reset, force-updated, or discarded/);

    // The commit the turn made is still on the branch it made it on.
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
  });

  it('leaves a checkout that is already on the recorded branch exactly as it is', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    // The round that judges a turn reads the working copy the turn left, so it
    // does not ask for a clean one: uncommitted work on the recorded branch is
    // ordinary there, it is not a reason to switch, and nothing about it is
    // touched.
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'uncommitted\n', 'utf8');

    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'on-branch',
    });
    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: false,
    });
    expect(await readFile(path.join(prepared.workspacePath, 'left.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
  });

  it('refuses a checkout that holds uncommitted work when a coding turn needs a clean one', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'uncommitted\n', 'utf8');

    // The strict reading is what a caller about to start a coding turn makes: a
    // turn works from the workspace's own committed state, so the checkout is
    // refused rather than handed on.
    const strict = { requireClean: true } as const;
    const standing = await inspectBranchStanding(
      prepared.workspacePath,
      prepared.branch,
      {},
      strict,
    );
    expect(standing.kind).toBe('refused');
    if (standing.kind !== 'refused') {
      return;
    }
    // Both names the criterion asks for: the branch the ledger records, the
    // commit it is at, and the paths that would have to be finished by hand.
    expect(standing.problem).toContain(`"${prepared.branch}"`);
    expect(standing.problem).toContain(prepared.baseCommit);
    expect(standing.problem).toContain('left.txt');
    expect(standing.problem).toMatch(/Commit or remove those paths by hand/);

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch, {}, strict),
    );
    expect(failure.message).toBe(standing.problem);

    // Nothing moved: the checkout is where the turn left it, with its commit and
    // its leftover.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
    expect(await readFile(path.join(prepared.workspacePath, 'left.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
  });

  it('refuses a dirty branch of its own, naming both branches and the manual action', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side', { dirty: true });

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );

    // The refusal names what Git would have to move between, and what a person
    // can do instead: the harness never commits, discards, or force-switches a
    // dirty checkout.
    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain('leftover.txt');
    expect(failure.message).toMatch(/Commit or remove those paths by hand/);
    expect(failure.message).toContain(revision);

    // Nothing moved: the checkout, its commit, its leftover, and the recorded
    // branch are all exactly where the turn left them.
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(await readFile(path.join(prepared.workspacePath, 'leftover.txt'), 'utf8')).toBe(
      'work the turn never committed\n',
    );
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.baseCommit);
  });

  it('refuses a commit the recorded branch does not descend from, and names both revisions', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');
    // The recorded branch moves on as well, so neither side descends from the
    // other: fast-forwarding it to the checkout would drop the commit it holds.
    await gitOrFail(['checkout', '--quiet', prepared.branch], prepared.workspacePath);
    await writeFile(path.join(prepared.workspacePath, 'recorded.txt'), 'later work\n', 'utf8');
    await gitOrFail(['add', 'recorded.txt'], prepared.workspacePath);
    await gitOrFail(['commit', '--quiet', '--message', 'later work'], prepared.workspacePath);
    const recorded = await headOf(prepared.workspacePath);
    await gitOrFail(['checkout', '--quiet', 'task/side'], prepared.workspacePath);

    const standing = await inspectBranchStanding(prepared.workspacePath, prepared.branch);
    expect(standing.kind).toBe('refused');

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );
    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain(revision);
    expect(failure.message).toContain(recorded);
    expect(failure.message).toMatch(/reconcile the two by hand/);

    // Both branches and the checkout are untouched.
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(recorded);
  });

  it('refuses a checkout whose recorded branch the workspace does not hold', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await leaveOnBranch(prepared, 'task/side');
    await gitOrFail(['branch', '--delete', '--force', prepared.branch], prepared.workspacePath);

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );

    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`holds no branch named "${prepared.branch}"`);
    expect(failure.message).toMatch(/never recreates, renames, or adopts a branch/);
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
  });

  it('is accepted by a continuation when it can be returned, and left where it is', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

    // Verification is a read: the run that follows is what returns the checkout
    // to the recorded branch, before its first coding turn.
    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.branch).toBe(prepared.branch);
    expect(reopened.attempt).toBe(1);
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.baseCommit);
    expect(await headOf(prepared.workspacePath)).toBe(revision);
  });

  it('is refused by a continuation when it cannot be returned, with the branch names', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await leaveOnBranch(prepared, 'task/side', { dirty: true });

    await expect(
      reopenWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      }),
    ).rejects.toThrow(
      /cannot be continued: .*task\/side.*recorded branch.*leftover\.txt.*Commit or remove/s,
    );
  });

  it('is refused by a continuation when its recorded branch holds uncommitted work', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    // The earlier attempt left work it never committed, on the branch the ledger
    // records: the next attempt would start another agent on it, and the harness
    // starts no coding turn from a working copy like that (HARN-35).
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'uncommitted\n', 'utf8');

    await expect(
      reopenWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      }),
    ).rejects.toThrow(
      new RegExp(
        `cannot be continued: .*"${prepared.branch}".*left\\.txt.*Commit or remove those paths by hand`,
        's',
      ),
    );

    // Verification is a read: the working copy is exactly where the earlier
    // attempt left it, so the work can be finished by hand.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
    expect(await readFile(path.join(prepared.workspacePath, 'left.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
  });
});
