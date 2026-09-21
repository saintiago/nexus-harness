/**
 * The optional GitHub delivery step: the push, the pull request lookup, and the
 * create-or-update decision, against a disposable Git repository and a stand-in
 * `gh` on `PATH`.
 *
 * Everything above that boundary is real: the module, its bounded command
 * runner, the argument lists, the body file it writes, and the command logs it
 * keeps. The destination is a local bare repository, so a push really moves the
 * branch; the stand-in GitHub CLI holds the pull requests it was asked to
 * create, so a repeated delivery really has something to find. Nothing here
 * contacts GitHub, and nothing needs a credential.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubDelivery, DeliveryError } from '../src/delivery/github.js';
import type { Delivery, DeliveryRequest } from '../src/delivery/github.js';
import type { GitHubDeliveryConfig } from '../src/shared/types.js';
import { fakeGhCalls, fakePullRequests, git, installFakeGh } from './fixtures/local-target.js';
import type { FakeGhState } from './fixtures/local-target.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import { createTempDir } from './support.js';

useFixtureLifecycle();

const REPOSITORY = 'example-owner/example-repo';
const BASE_BRANCH = 'main';
const RUN_ID = 'run-20260101000000-00000000';
const BRANCH = `harness/${RUN_ID}`;
const CHECKS = '1 of 1 configured checks exited 0 (round: passed)';

interface Fixture {
  readonly parent: string;
  readonly workspace: string;
  /** Where the stand-in `gh` lives, so it can be put first on `PATH`. */
  readonly bin: string;
  /** The local bare repository the delivery step pushes into. */
  readonly remote: string;
  readonly logsDir: string;
  readonly baseCommit: string;
  readonly gh: FakeGhState;
  readonly delivery: Delivery;
}

interface FixtureOptions {
  /** Commit the attempt's work to the branch before delivering it. */
  readonly work?: boolean;
  /** Leave this path uncommitted in the workspace after the committed work. */
  readonly leftover?: string;
  /** Make one stand-in `gh` invocation fail, as a refused request would. */
  readonly fail?: 'list' | 'create' | 'edit';
  /**
   * One pull request the destination already holds for this attempt's head and
   * base, with the native state `gh` reports for it.
   */
  readonly existing?: { readonly state: 'OPEN' | 'CLOSED' | 'MERGED' };
}

/** One pull request the stand-in GitHub already holds, before any delivery runs. */
interface SeededPullRequest {
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
}

/** One attempt's workspace: a clone-shaped repository on its own branch. */
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const parent = await createTempDir();
  const remote = path.join(parent, 'origin.git');
  git(parent, 'init', '--quiet', '--bare', remote);

  const workspace = path.join(parent, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# target project\n', 'utf8');
  git(workspace, 'init', '--quiet', '--initial-branch=main');
  git(workspace, 'add', '--all');
  git(workspace, 'commit', '--quiet', '--message', 'baseline');
  const baseCommit = git(workspace, 'rev-parse', 'HEAD').trim();

  git(workspace, 'checkout', '--quiet', '-b', BRANCH);
  if (options.work ?? true) {
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(
      path.join(workspace, 'src', 'greet-all.mjs'),
      'export const greetAll = 1;\n',
      'utf8',
    );
    git(workspace, 'add', '--all');
    git(workspace, 'commit', '--quiet', '--message', 'implement greetAll');
  }
  if (options.leftover !== undefined) {
    await writeFile(path.join(workspace, options.leftover), 'left behind\n', 'utf8');
  }

  const logsDir = path.join(parent, 'logs');
  await mkdir(logsDir, { recursive: true });

  const { bin, state } = await installFakeGh(parent);
  const config: GitHubDeliveryConfig = {
    type: 'github',
    repository: REPOSITORY,
    baseBranch: BASE_BRANCH,
  };
  const delivery = createGitHubDelivery(config, {
    pushUrl: remote,
    env: fakeGhEnvironment(bin, state, options.fail),
  });

  const fixture: Fixture = {
    parent,
    workspace,
    bin,
    remote,
    logsDir,
    baseCommit,
    gh: state,
    delivery,
  };
  if (options.existing !== undefined) {
    await seedPullRequests(fixture, [options.existing]);
  }
  return fixture;
}

/**
 * Writes the pull requests the stand-in GitHub already holds for this head and
 * base: one JSON line each, as the stand-in reads them back.
 */
async function seedPullRequests(
  fixture: Fixture,
  seeds: readonly SeededPullRequest[],
): Promise<void> {
  await writeFile(
    fixture.gh.pullRequestsFile,
    seeds
      .map((seed, index) => {
        const number = index + 1;
        return `${JSON.stringify({
          url: `https://github.com/${REPOSITORY}/pull/${String(number)}`,
          number,
          repo: REPOSITORY,
          head: BRANCH,
          base: BASE_BRANCH,
          title: `an earlier pull request (${seed.state})`,
          body: `the body a previous delivery wrote (${seed.state})`,
          state: seed.state,
        })}\n`;
      })
      .join(''),
    'utf8',
  );
}

/** What the delivery commands inherit: the stand-in `gh` first on `PATH`. */
function fakeGhEnvironment(
  bin: string,
  state: FakeGhState,
  fail: FixtureOptions['fail'],
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_GH: JSON.stringify({ stateDir: state.dir, ...(fail === undefined ? {} : { fail }) }),
  };
}

/**
 * The harness resolves `gh` from this process's own `PATH` on Windows, whatever
 * environment it hands the command, so a suite that wants the stand-in has to
 * put it there and take it away again.
 */
async function withFakeGhOnPath<T>(bin: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previous;
    }
  }
}

/** The attempt's delivery request, as the coordinator builds it. */
function requestFor(fixture: Fixture, checks = CHECKS): DeliveryRequest {
  return {
    workspacePath: fixture.workspace,
    branch: BRANCH,
    baseCommit: fixture.baseCommit,
    logsDir: fixture.logsDir,
    runId: RUN_ID,
    reportPath: path.join(fixture.parent, 'runs', RUN_ID, 'result.json'),
    task: { id: 'SAM1-11', title: 'Create the marker file' },
    checks,
    sourceRef: {
      type: 'jira',
      scope: 'https://example.atlassian.net',
      id: '10011',
      key: 'SAM1-11',
      url: 'https://example.atlassian.net/browse/SAM1-11',
      updatedAt: '2026-09-16T11:00:00.000Z',
    },
  };
}

/** Whether the destination repository holds the attempt's branch at all. */
function destinationHasBranch(fixture: Fixture): boolean {
  try {
    git(fixture.parent, '--git-dir', fixture.remote, 'rev-parse', `refs/heads/${BRANCH}`);
    return true;
  } catch {
    return false;
  }
}

/** The commit a branch points at in the destination repository. */
function destinationCommit(fixture: Fixture): string {
  return git(
    fixture.parent,
    '--git-dir',
    fixture.remote,
    'rev-parse',
    `refs/heads/${BRANCH}`,
  ).trim();
}

/** Runs one delivery and returns what it threw, as an error. */
async function refusal(deliver: () => Promise<unknown>): Promise<Error> {
  const cause = await deliver().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(cause instanceof Error)) {
    throw new Error(`expected a failure, received ${String(cause)}`);
  }
  return cause;
}

describe('the GitHub delivery step', () => {
  it('pushes the attempt branch and creates one pull request with the issue and the checks', async () => {
    const fixture = await createFixture();
    const request = requestFor(fixture);

    const delivered = await withFakeGhOnPath(
      fixture.bin,
      async () => await fixture.delivery.deliver(request, new AbortController().signal),
    );

    // The delivery reports the revision it published and verified, which is the
    // working copy's own checked-out tip.
    expect(delivered).toEqual({
      url: `https://github.com/${REPOSITORY}/pull/1`,
      number: 1,
      head: git(fixture.workspace, 'rev-parse', 'HEAD').trim(),
      created: true,
    });
    // The destination holds the branch the workspace holds, at the same commit.
    expect(destinationCommit(fixture)).toBe(
      git(fixture.workspace, 'rev-parse', `refs/heads/${BRANCH}`).trim(),
    );

    const calls = await fakeGhCalls(fixture.gh);
    expect(calls.map((call) => call.op)).toEqual(['list', 'create']);
    // The lookup reads the pull request's own state, so a match that is no
    // longer open cannot be mistaken for a delivery.
    expect(calls[0]?.argv).toContain('url,state');
    const created = calls[1];
    expect(created?.repo).toBe(REPOSITORY);
    expect(created?.head).toBe(BRANCH);
    expect(created?.base).toBe(BASE_BRANCH);
    expect(created?.title).toBe('SAM1-11: Create the marker file');
    expect(created?.body).toContain('SAM1-11');
    expect(created?.body).toContain('https://example.atlassian.net/browse/SAM1-11');
    expect(created?.body).toContain(CHECKS);

    // What was published stays beside the run's own evidence.
    const body = await readFile(
      path.join(fixture.logsDir, 'delivery-pull-request-body.md'),
      'utf8',
    );
    expect(body).toBe(created?.body);
    expect(await fakePullRequests(fixture.gh)).toHaveLength(1);
  });

  it('finds the pull request it created, and updates the same branch and pull request', async () => {
    const fixture = await createFixture();
    const first = await withFakeGhOnPath(
      fixture.bin,
      async () => await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
    );
    expect(first?.created).toBe(true);

    // A later attempt commits more work in the same retained workspace.
    await writeFile(
      path.join(fixture.workspace, 'src', 'greet-all.mjs'),
      'export const greetAll = 2;\n',
      'utf8',
    );
    git(fixture.workspace, 'commit', '--quiet', '--all', '--message', 'extend greetAll');

    // A later delivery is a later attempt, with its own run directory and logs.
    const laterLogs = path.join(fixture.parent, 'later-logs');
    await mkdir(laterLogs, { recursive: true });
    const second = await withFakeGhOnPath(
      fixture.bin,
      async () =>
        await fixture.delivery.deliver(
          {
            ...requestFor(fixture, '2 of 2 configured checks exited 0 (round: passed)'),
            logsDir: laterLogs,
          },
          new AbortController().signal,
        ),
    );

    // A later delivery to the same pull request reports its own, later
    // revision: the commit each round delivered is not lost when the branch
    // moves on.
    expect(second).toEqual({
      url: first?.url,
      number: 1,
      head: git(fixture.workspace, 'rev-parse', 'HEAD').trim(),
      created: false,
    });
    expect(second?.head).not.toBe(first?.head);
    expect(destinationCommit(fixture)).toBe(
      git(fixture.workspace, 'rev-parse', `refs/heads/${BRANCH}`).trim(),
    );

    const calls = await fakeGhCalls(fixture.gh);
    expect(calls.map((call) => call.op)).toEqual(['list', 'create', 'list', 'edit']);
    expect(calls[3]?.url).toBe(first?.url);
    expect(calls[3]?.body).toContain('2 of 2 configured checks exited 0');
    // GitHub is the record: one pull request, updated, not a second one.
    const held = await fakePullRequests(fixture.gh);
    expect(held).toHaveLength(1);
    expect(held[0]?.body).toContain('2 of 2 configured checks exited 0');
  });

  it('refuses a workspace that still holds uncommitted work, naming the paths', async () => {
    const fixture = await createFixture({ leftover: 'leftover.txt' });

    const failure = await withFakeGhOnPath(fixture.bin, async () =>
      refusal(
        async () =>
          await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
      ),
    );

    expect(failure).toBeInstanceOf(DeliveryError);
    expect(failure.message).toContain('"leftover.txt"');
    expect(failure.message).toContain('uncommitted changes');
    expect(failure.message).toContain('never commits or discards');
    // Nothing was pushed and nothing was asked of GitHub.
    expect(destinationHasBranch(fixture)).toBe(false);
    expect(await fakeGhCalls(fixture.gh)).toEqual([]);
  });

  it('refuses to publish a recorded branch left behind the revision that passed', async () => {
    const fixture = await createFixture();
    // The turn's later work landed on a branch of its own, and the recorded
    // branch stayed where the earlier commit was: what the checks decided is
    // the checked-out revision, not the older branch this step would push.
    git(fixture.workspace, 'checkout', '--quiet', '-b', 'task/harn-17-work');
    await writeFile(
      path.join(fixture.workspace, 'src', 'greet-all.mjs'),
      'export const greetAll = 2;\n',
      'utf8',
    );
    git(fixture.workspace, 'commit', '--quiet', '--all', '--message', 'extend greetAll');
    const validated = git(fixture.workspace, 'rev-parse', 'HEAD').trim();
    const recordedCommit = git(fixture.workspace, 'rev-parse', `refs/heads/${BRANCH}`).trim();
    expect(recordedCommit).not.toBe(validated);

    const failure = await withFakeGhOnPath(fixture.bin, async () =>
      refusal(
        async () =>
          await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
      ),
    );

    expect(failure).toBeInstanceOf(DeliveryError);
    // The failure names both revisions and the branch it refused to publish.
    expect(failure.message).toContain(validated);
    expect(failure.message).toContain(recordedCommit);
    expect(failure.message).toContain(BRANCH);
    expect(failure.message).toContain('never force-pushes');
    // Nothing was pushed and nothing was asked of GitHub.
    expect(destinationHasBranch(fixture)).toBe(false);
    expect(await fakeGhCalls(fixture.gh)).toEqual([]);
    // Every commit and branch is still where the turn left it, with a clean tree.
    expect(git(fixture.workspace, 'rev-parse', 'refs/heads/task/harn-17-work').trim()).toBe(
      validated,
    );
    expect(git(fixture.workspace, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(recordedCommit);
    expect(git(fixture.workspace, 'status', '--porcelain').trim()).toBe('');
  });

  it('refuses a missing recorded branch even when HEAD resolves successfully', async () => {
    const fixture = await createFixture();
    const head = git(fixture.workspace, 'rev-parse', 'HEAD').trim();
    const failure = await withFakeGhOnPath(fixture.bin, async () =>
      refusal(
        async () =>
          await fixture.delivery.deliver(
            { ...requestFor(fixture), branch: 'harness/missing-branch' },
            new AbortController().signal,
          ),
      ),
    );

    expect(failure).toBeInstanceOf(DeliveryError);
    expect(failure.message).toContain('git rev-parse');
    expect(destinationHasBranch(fixture)).toBe(false);
    expect(await fakeGhCalls(fixture.gh)).toEqual([]);
    expect(git(fixture.workspace, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(fixture.workspace, 'status', '--porcelain').trim()).toBe('');
  });

  it('delivers when the checkout is on another branch at the same revision', async () => {
    const fixture = await createFixture();
    const validated = git(fixture.workspace, 'rev-parse', 'HEAD').trim();
    // An ordinary local branch is not itself a reason to refuse: the revision
    // that would be published is still the one the checks validated.
    git(fixture.workspace, 'checkout', '--quiet', '-b', 'task/harn-17-work');

    const delivered = await withFakeGhOnPath(
      fixture.bin,
      async () => await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
    );

    expect(delivered).toEqual({
      url: `https://github.com/${REPOSITORY}/pull/1`,
      number: 1,
      head: validated,
      created: true,
    });
    expect(destinationCommit(fixture)).toBe(validated);
  });

  it('fails with what gh said, keeping its output beside the run', async () => {
    const fixture = await createFixture({ fail: 'create' });

    const failure = await withFakeGhOnPath(fixture.bin, async () =>
      refusal(
        async () =>
          await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
      ),
    );

    expect(failure).toBeInstanceOf(DeliveryError);
    expect(failure.message).toContain('gh pr create');
    expect(failure.message).toContain('Resource not accessible by integration');
    expect(failure.message).toContain('gh auth status');
    expect(await fakePullRequests(fixture.gh)).toEqual([]);

    const diagnostics = await readFile(
      path.join(fixture.logsDir, 'delivery-gh-pr-create.stderr.log'),
      'utf8',
    );
    expect(diagnostics).toContain('Resource not accessible by integration');
  });

  it('delivers nothing when the branch holds no commit beyond its recorded base', async () => {
    const fixture = await createFixture({ work: false });

    const delivered = await withFakeGhOnPath(
      fixture.bin,
      async () => await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
    );

    expect(delivered).toBeNull();
    expect(await fakeGhCalls(fixture.gh)).toEqual([]);
    expect(destinationHasBranch(fixture)).toBe(false);
  });

  it.each(['CLOSED', 'MERGED'] as const)(
    'refuses to edit a %s pull request into a delivery no open review receives',
    async (state) => {
      const fixture = await createFixture({ existing: { state } });

      const failure = await withFakeGhOnPath(fixture.bin, async () =>
        refusal(
          async () =>
            await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
        ),
      );

      expect(failure).toBeInstanceOf(DeliveryError);
      expect(failure.message).toContain('is not open');
      expect(failure.message).toContain(state);
      expect(failure.message).toContain(`https://github.com/${REPOSITORY}/pull/1`);
      expect(failure.message).toContain('never reopens');
      expect(failure.message).toContain('reopen');

      // The branch really was pushed before the lookup, but the pull request
      // was neither edited nor duplicated, and its own body is untouched.
      expect(destinationHasBranch(fixture)).toBe(true);
      const calls = await fakeGhCalls(fixture.gh);
      expect(calls.map((call) => call.op)).toEqual(['list']);
      const held = await fakePullRequests(fixture.gh);
      expect(held).toHaveLength(1);
      expect(held[0]?.body).toBe(`the body a previous delivery wrote (${state})`);
    },
  );

  it('still reuses the one open pull request when a closed one also matches', async () => {
    const fixture = await createFixture();
    // An older attempt's pull request was closed, and a later one is open: the
    // open match is still this attempt's review, and it is the one that is
    // updated rather than creating a second.
    await seedPullRequests(fixture, [{ state: 'CLOSED' }, { state: 'OPEN' }]);

    const delivered = await withFakeGhOnPath(
      fixture.bin,
      async () => await fixture.delivery.deliver(requestFor(fixture), new AbortController().signal),
    );

    const url = `https://github.com/${REPOSITORY}/pull/2`;
    expect(delivered).toEqual({
      url,
      number: 2,
      head: git(fixture.workspace, 'rev-parse', 'HEAD').trim(),
      created: false,
    });
    const calls = await fakeGhCalls(fixture.gh);
    expect(calls.map((call) => call.op)).toEqual(['list', 'edit']);
    expect(calls[1]?.url).toBe(url);
    expect(destinationHasBranch(fixture)).toBe(true);
  });

  it('says what is unknown when the harness stops a delivery command', async () => {
    const fixture = await createFixture();

    const failure = await withFakeGhOnPath(fixture.bin, async () =>
      refusal(async () => await fixture.delivery.deliver(requestFor(fixture), AbortSignal.abort())),
    );

    expect(failure).toBeInstanceOf(DeliveryError);
    expect(failure.message).toContain('was stopped');
    expect(failure.message).toContain('how far the delivery got is unknown');
    // Nothing was asked of GitHub, and nothing was pushed.
    expect(await fakeGhCalls(fixture.gh)).toEqual([]);
    expect(destinationHasBranch(fixture)).toBe(false);
  });
});
