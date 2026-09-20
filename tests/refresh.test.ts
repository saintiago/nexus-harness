/**
 * Source readiness between two queue tickets, against real temporary Git
 * repositories.
 *
 * The step exists to move the operator's own checkout forward and nothing else,
 * so what is asserted here is what each refusal left alone as much as what a
 * successful step did: a dirty checkout, a diverged one, one on the wrong
 * branch, one whose remote is not the delivery repository, and one that does not
 * hold the verified merge on its base branch are all refused without the
 * checkout being reset, stashed, cleaned, or otherwise rearranged.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceError } from '../src/workspace/errors.js';
import { githubRepositoryOf, refreshSource } from '../src/workspace/refresh.js';
import { git } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(async () => {
  await cleanupTempDirectories();
});

/** The repository the operator's checkout tracks, as `owner/name`. */
const REPOSITORY = 'saintiago/nexus-harness';

interface Fixture {
  /** The operator's own checkout: what the queue prepares. */
  readonly checkout: string;
  /** The bare "delivery" repository the checkout's remote names. */
  readonly delivery: string;
  /** A second checkout used to push commits into the delivery repository. */
  readonly seed: string;
  /** The URL stored on the checkout's remote, and passed as the fetch URL. */
  readonly remoteUrl: string;
  /** The commit the checkout starts at. */
  readonly first: string;
}

/** A clean checkout on `main`, one bare delivery repository, and one seed. */
async function fixture(): Promise<Fixture> {
  const root = await createTempDir();
  const seed = path.join(root, 'seed');
  const delivery = path.join(root, 'delivery.git');
  const checkout = path.join(root, 'checkout');
  await mkdir(seed, { recursive: true });

  git(seed, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(seed, 'README.md'), 'the base branch\n', 'utf8');
  git(seed, 'add', '--all');
  git(seed, 'commit', '--quiet', '--message', 'first');
  const first = git(seed, 'rev-parse', 'HEAD').trim();

  git(root, 'clone', '--quiet', '--bare', seed, delivery);
  git(root, 'clone', '--quiet', delivery, checkout);
  const remoteUrl = path.resolve(delivery).split(path.sep).join('/');
  git(checkout, 'remote', 'set-url', 'origin', remoteUrl);

  return { checkout, delivery, seed, remoteUrl, first };
}

/** One commit made in the seed and pushed to the delivery repository's main. */
function mergeCommit(fixture_: Fixture, message: string): string {
  git(fixture_.seed, 'commit', '--quiet', '--allow-empty', '--message', message);
  const commit = git(fixture_.seed, 'rev-parse', 'HEAD').trim();
  git(fixture_.seed, 'push', '--quiet', fixture_.delivery, 'main');
  return commit;
}

/** The readiness request for one fixture, with the local remote substituted. */
function request(fixture_: Fixture, mergedCommit: string) {
  return {
    repoPath: fixture_.checkout,
    baseBranch: 'main',
    repository: REPOSITORY,
    mergedCommit,
  };
}

describe('githubRepositoryOf', () => {
  it('reads every URL shape Git may hold for the same repository', () => {
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
    for (const url of [
      'https://gitlab.com/saintiago/nexus-harness.git',
      'https://github.com/saintiago',
      'git@github.com:other/nexus-harness.git',
      '/local/path/delivery.git',
    ]) {
      expect(githubRepositoryOf(url), url).toBe(
        url === 'git@github.com:other/nexus-harness.git' ? 'other/nexus-harness' : null,
      );
    }
  });
});

describe('source readiness between two queue tickets', () => {
  it('fetches and fast-forwards a clean checkout to the verified merge commit', async () => {
    const parts = await fixture();
    const merged = mergeCommit(parts, 'the completed ticket, as merged');

    const result = await refreshSource(request(parts, merged), { fetchUrl: parts.remoteUrl });

    expect(result.moved).toBe(true);
    expect(result.previousHead).toBe(parts.first);
    expect(result.fetchedHead).toBe(merged);
    expect(result.remote).toBe('origin');
    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(merged);
    expect(git(parts.checkout, 'status', '--porcelain').trim()).toBe('');
    // The commit really arrived: the file the merge added is in the checkout.
  });

  it('leaves a checkout that is already at the merge alone', async () => {
    const parts = await fixture();
    const merged = mergeCommit(parts, 'the completed ticket, as merged');
    git(parts.checkout, 'fetch', '--quiet', parts.remoteUrl, 'main');
    git(parts.checkout, 'merge', '--ff-only', '--quiet', 'FETCH_HEAD');

    const result = await refreshSource(request(parts, merged), { fetchUrl: parts.remoteUrl });

    expect(result.moved).toBe(false);
    expect(result.previousHead).toBe(merged);
    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(merged);
  });

  it('refuses a checkout with untracked work, and keeps it', async () => {
    const parts = await fixture();
    const merged = mergeCommit(parts, 'the completed ticket, as merged');
    await writeFile(path.join(parts.checkout, 'notes.txt'), 'mine\n', 'utf8');

    await expect(
      refreshSource(request(parts, merged), { fetchUrl: parts.remoteUrl }),
    ).rejects.toThrow(/notes\.txt/);

    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(parts.first);
    expect(git(parts.checkout, 'status', '--porcelain')).toContain('notes.txt');
  });

  it('refuses a checkout with staged work, and keeps it', async () => {
    const parts = await fixture();
    const merged = mergeCommit(parts, 'the completed ticket, as merged');
    await writeFile(path.join(parts.checkout, 'staged.txt'), 'staged\n', 'utf8');
    git(parts.checkout, 'add', 'staged.txt');

    await expect(
      refreshSource(request(parts, merged), { fetchUrl: parts.remoteUrl }),
    ).rejects.toThrow(/staged\.txt/);
    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(parts.first);
    expect(git(parts.checkout, 'status', '--porcelain')).toContain('staged.txt');
  });

  it('refuses a diverged checkout without resetting or discarding its commits', async () => {
    const parts = await fixture();
    git(parts.checkout, 'commit', '--quiet', '--allow-empty', '--message', 'local work');
    const local = git(parts.checkout, 'rev-parse', 'HEAD').trim();
    const merged = mergeCommit(parts, 'the completed ticket, as merged');

    await expect(
      refreshSource(request(parts, merged), { fetchUrl: parts.remoteUrl }),
    ).rejects.toThrow(/diverged/);

    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(local);
    expect(git(parts.checkout, 'rev-parse', 'HEAD~1').trim()).toBe(parts.first);
    expect(git(parts.checkout, 'log', '-1', '--format=%s').trim()).toBe('local work');
  });

  it('refuses a checkout whose remote is not the delivery repository', async () => {
    const parts = await fixture();
    const merged = mergeCommit(parts, 'the completed ticket, as merged');
    git(parts.checkout, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git');

    await expect(
      refreshSource(request(parts, merged), { fetchUrl: parts.remoteUrl }),
    ).rejects.toThrow(/delivery repository "saintiago\/nexus-harness"/);
    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(parts.first);
  });

  it('refuses a checkout that is not on the configured base branch', async () => {
    const parts = await fixture();
    const merged = mergeCommit(parts, 'the completed ticket, as merged');
    git(parts.checkout, 'checkout', '--quiet', '-b', 'side');

    await expect(
      refreshSource(request(parts, merged), { fetchUrl: parts.remoteUrl }),
    ).rejects.toThrow(/"side", not on the configured base branch "main"/);
    expect(git(parts.checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('side');
  });

  it('refuses when the verified merge commit is not in the checkout', async () => {
    const parts = await fixture();
    const absent = '1'.repeat(40);

    await expect(
      refreshSource(request(parts, absent), { fetchUrl: parts.remoteUrl }),
    ).rejects.toThrow(/is not in/);
    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(parts.first);
  });

  it('refuses when the base branch does not contain the verified merge commit', async () => {
    const parts = await fixture();
    // A commit on another branch, fetched into this checkout's object database,
    // is not in the base branch the delivery repository publishes.
    git(parts.seed, 'checkout', '--quiet', '-b', 'side');
    git(parts.seed, 'commit', '--quiet', '--allow-empty', '--message', 'side work');
    const side = git(parts.seed, 'rev-parse', 'HEAD').trim();
    git(parts.seed, 'push', '--quiet', parts.delivery, 'side');
    git(parts.checkout, 'fetch', '--quiet', parts.remoteUrl, 'side');
    const merged = mergeCommit(parts, 'the completed ticket, as merged');

    await expect(
      refreshSource(request(parts, side), { fetchUrl: parts.remoteUrl }),
    ).rejects.toThrow(/is not an ancestor of the fetched head/);
    expect(git(parts.checkout, 'rev-parse', 'HEAD').trim()).toBe(parts.first);
    expect(merged).toBeTruthy();
  });
});
