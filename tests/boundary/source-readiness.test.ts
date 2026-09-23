/**
 * Source readiness between two queue tickets, against real temporary Git
 * repositories.
 *
 * The step exists to move the operator's own checkout forward and nothing else,
 * so a case asserts what each refusal left alone as much as what a successful
 * step did: it fetches the one remote that names the configured delivery
 * repository, requires the verified merge commit to be in the fetched base
 * branch and the checkout's own head to be an ancestor of it, and only then
 * fast-forwards. A dirty checkout, a diverged one, one whose remote is not the
 * delivery repository, and one that cannot show the verified merge are refused
 * with what a person has to fix — never reset, forced, stashed, or cleaned.
 *
 * The repositories are temporary and the Git environment is private to this
 * suite, so the machine's own configuration and identity cannot change what is
 * proved here.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../src/workspace/errors.js';
import { githubRepositoryOf, refreshSource } from '../../src/workspace/refresh.js';
import { createRepository, gitOrFail, useIsolatedGitEnvironment } from './integration-support.js';
import type { RepositoryFixture } from './integration-support.js';

useIsolatedGitEnvironment();

/** The repository the operator's checkout tracks, as `owner/name`. */
const REPOSITORY = 'saintiago/nexus-harness';

/** The operator's checkout, the bare repository it tracks, and where commits come from. */
interface DeliveryFixture extends RepositoryFixture {
  /** The bare "delivery" repository the checkout's remote names. */
  readonly delivery: string;
  /** The checkout the next workspace is cloned from. */
  readonly checkout: string;
  /** The remote URL the delivery repository is substituted with. */
  readonly remoteUrl: string;
  /** The commit the checkout starts at. */
  readonly first: string;
}

/** One clean checkout on `main`, one bare delivery repository, and a seed. */
async function createDeliveryFixture(): Promise<DeliveryFixture> {
  const fixture = await createRepository();
  const delivery = path.join(fixture.parent, 'delivery.git');
  const checkout = path.join(fixture.parent, 'checkout');
  await gitOrFail(['clone', '--quiet', '--bare', fixture.repo, delivery], fixture.parent);
  await gitOrFail(['clone', '--quiet', delivery, checkout], fixture.parent);
  const remoteUrl = delivery.split(path.sep).join('/');
  await gitOrFail(['remote', 'set-url', 'origin', remoteUrl], checkout);
  const first = (await gitOrFail(['rev-parse', 'HEAD'], checkout)).trim();
  return { ...fixture, delivery, checkout, remoteUrl, first };
}

/** One commit made in the seed repository and pushed to the delivery repository. */
async function mergedCommit(fixture: DeliveryFixture, message: string): Promise<string> {
  await gitOrFail(['commit', '--quiet', '--allow-empty', '--message', message], fixture.repo);
  const commit = (await gitOrFail(['rev-parse', 'HEAD'], fixture.repo)).trim();
  await gitOrFail(['push', '--quiet', fixture.delivery, 'main'], fixture.repo);
  return commit;
}

/** The commit one checkout really holds now. */
async function headOf(checkout: string): Promise<string> {
  return (await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], checkout)).trim();
}

/** The error one readiness step that was expected to fail rejected with. */
async function failureOf(work: () => Promise<unknown>): Promise<WorkspaceError> {
  try {
    await work();
  } catch (cause) {
    if (!(cause instanceof WorkspaceError)) {
      throw new Error(`the step failed with something else: ${String(cause)}`, { cause });
    }
    return cause;
  }
  throw new Error('the step was expected to fail, and it did not');
}

describe('githubRepositoryOf', () => {
  it('reads every URL shape Git may hold for one GitHub repository', () => {
    for (const url of [
      'https://github.com/saintiago/nexus-harness.git',
      'https://github.com/saintiago/nexus-harness',
      'https://saintiago@github.com/saintiago/nexus-harness.git',
      'git@github.com:saintiago/nexus-harness.git',
      'ssh://git@github.com/saintiago/nexus-harness.git',
      'https://github.com/Saintiago/Nexus-Harness.git',
    ]) {
      expect(githubRepositoryOf(url), url).toBe('saintiago/nexus-harness');
    }
    expect(githubRepositoryOf('https://gitlab.com/saintiago/nexus-harness.git')).toBeNull();
    expect(githubRepositoryOf('https://github.com/saintiago')).toBeNull();
    expect(githubRepositoryOf(path.join('tmp', 'delivery.git'))).toBeNull();
  });
});

describe('source readiness between two queue tickets', () => {
  it('fetches and fast-forwards a clean checkout to the verified merge commit', async () => {
    const fixture = await createDeliveryFixture();
    const merged = await mergedCommit(fixture, 'the completed ticket, as merged');

    const result = await refreshSource(
      {
        repoPath: fixture.checkout,
        baseBranch: 'main',
        repository: REPOSITORY,
        mergedCommit: merged,
      },
      { fetchUrl: fixture.remoteUrl },
    );

    expect(result.moved).toBe(true);
    expect(result.previousHead).toBe(fixture.first);
    expect(result.fetchedHead).toBe(merged);
    expect(result.remote).toBe('origin');
    expect(await headOf(fixture.checkout)).toBe(merged);
  }, 45_000);

  it('refuses a checkout that still holds uncommitted work, and moves nothing', async () => {
    const fixture = await createDeliveryFixture();
    const merged = await mergedCommit(fixture, 'the completed ticket, as merged');
    await writeFile(path.join(fixture.checkout, 'left.txt'), 'still here\n', 'utf8');

    const error = await failureOf(() =>
      refreshSource(
        {
          repoPath: fixture.checkout,
          baseBranch: 'main',
          repository: REPOSITORY,
          mergedCommit: merged,
        },
        { fetchUrl: fixture.remoteUrl },
      ),
    );

    expect(error.message).toContain('is not a clean checkout');
    expect(error.message).toContain('left.txt');
    // Nothing was reset, stashed, or cleaned: the checkout is exactly as it was.
    expect(await headOf(fixture.checkout)).toBe(fixture.first);
    expect(await gitOrFail(['status', '--porcelain=v1'], fixture.checkout)).toContain('left.txt');
  }, 45_000);

  it('refuses a checkout that has diverged, and never resets or forces it', async () => {
    const fixture = await createDeliveryFixture();
    await gitOrFail(
      ['commit', '--quiet', '--allow-empty', '--message', 'local work'],
      fixture.checkout,
    );
    const local = await headOf(fixture.checkout);
    const merged = await mergedCommit(fixture, 'the completed ticket, as merged');

    const error = await failureOf(() =>
      refreshSource(
        {
          repoPath: fixture.checkout,
          baseBranch: 'main',
          repository: REPOSITORY,
          mergedCommit: merged,
        },
        { fetchUrl: fixture.remoteUrl },
      ),
    );

    expect(error.message).toContain('has diverged from the verified merge commit');
    expect(error.message).toContain('never resets, forces, stashes, discards');
    // The local commit is still there: the step only ever moves a checkout forward.
    expect(await headOf(fixture.checkout)).toBe(local);
  }, 45_000);

  it('refuses a checkout whose remote is not the delivery repository', async () => {
    const fixture = await createDeliveryFixture();
    const merged = await mergedCommit(fixture, 'the completed ticket, as merged');
    await gitOrFail(
      ['remote', 'set-url', 'origin', 'https://github.com/other/repository.git'],
      fixture.checkout,
    );

    const error = await failureOf(() =>
      refreshSource(
        {
          repoPath: fixture.checkout,
          baseBranch: 'main',
          repository: REPOSITORY,
          mergedCommit: merged,
        },
        { fetchUrl: fixture.remoteUrl },
      ),
    );

    expect(error.message).toContain('has no remote for the delivery repository');
    expect(error.message).toContain('will not guess which remote');
    expect(await headOf(fixture.checkout)).toBe(fixture.first);
  }, 45_000);

  it('refuses a checkout that cannot show the verified merge commit', async () => {
    const fixture = await createDeliveryFixture();
    const absent = '0'.repeat(40);

    const error = await failureOf(() =>
      refreshSource(
        {
          repoPath: fixture.checkout,
          baseBranch: 'main',
          repository: REPOSITORY,
          mergedCommit: absent,
        },
        { fetchUrl: fixture.remoteUrl },
      ),
    );

    expect(error.message).toContain(`is not in`);
    expect(error.message).toContain(absent);
    expect(error.message).toContain('Nothing was changed');
    expect(await headOf(fixture.checkout)).toBe(fixture.first);
  }, 45_000);
});
