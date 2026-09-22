/**
 * The GitHub delivery boundary: a passed attempt's branch really pushed to a
 * destination, and its pull request found, created, or refused with `gh`.
 *
 * The destination is a disposable bare repository on disk and `gh` is a stand-in
 * program that records every invocation, so the whole step runs for real —
 * `git status`, `git rev-parse`, `git rev-list`, `git push`, and the `gh`
 * commands — without a live account. What is proved here is that boundary's
 * contract: what is published is the revision the checks validated, a working
 * copy that still holds uncommitted work is refused rather than committed for,
 * an attempt with nothing to deliver is not an error, and a failure keeps the
 * command's own output beside the run.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeliveryError, createGitHubDelivery } from '../src/delivery/github.js';
import type { DeliveryRequest } from '../src/delivery/github.js';
import type { GitHubDeliveryConfig } from '../src/shared/types.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import {
  createRepository,
  createTempDir,
  fixtureGit,
  gitOrFail,
  installStandIn,
  useIsolatedGitEnvironment,
  withPathPrefix,
} from './integration-support.js';
import type { RepositoryFixture } from './integration-support.js';

useIsolatedGitEnvironment();

/** The destination one delivery publishes to, as the configuration names it. */
const CONFIG: GitHubDeliveryConfig = {
  type: 'github',
  repository: 'example/target',
  baseBranch: 'main',
};

/**
 * A stand-in `gh`: it appends what it was invoked with, its working directory,
 * and the two environment facts the boundary is responsible for, and answers
 * the pull request calls according to the mode the case selected. Its answers go
 * to the streams the boundary reads, exactly as the real CLI's would.
 */
const STAND_IN_GH = [
  `const { appendFileSync } = await import('node:fs');`,
  `const args = process.argv.slice(2);`,
  `appendFileSync(process.env.NEXUS_GH_RECORD, JSON.stringify({`,
  `  args,`,
  `  cwd: process.cwd(),`,
  `  promptDisabled: process.env.GH_PROMPT_DISABLED ?? null,`,
  `  updateNotifier: process.env.GH_NO_UPDATE_NOTIFIER ?? null,`,
  `  inheritedGitDir: process.env.GIT_DIR ?? null,`,
  `  secret: process.env.NEXUS_GH_SECRET ?? null,`,
  `}) + '\\n');`,
  `const mode = process.env.NEXUS_GH_MODE ?? 'create';`,
  `const subcommand = args.slice(0, 2).join(' ');`,
  `const open = { url: 'https://github.com/example/target/pull/9', state: 'OPEN' };`,
  `const merged = { url: 'https://github.com/example/target/pull/8', state: 'MERGED' };`,
  `if (subcommand === 'pr list') {`,
  `  if (mode === 'fail') {`,
  `    process.stderr.write('gh: authentication is required\\n');`,
  `    process.exit(4);`,
  `  }`,
  `  process.stdout.write(`,
  `    JSON.stringify(mode === 'update' ? [merged, open] : mode === 'closed' ? [merged] : []),`,
  `  );`,
  `  process.exit(0);`,
  `}`,
  `if (subcommand === 'pr create') {`,
  `  process.stdout.write('https://github.com/example/target/pull/9\\n');`,
  `  process.exit(0);`,
  `}`,
  `if (subcommand === 'pr edit') {`,
  `  process.exit(0);`,
  `}`,
  `process.stderr.write('gh: unexpected ' + args.join(' ') + '\\n');`,
  `process.exit(2);`,
].join('\n');

/** One stand-in `gh` invocation, as it recorded itself. */
interface GhRecord {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly promptDisabled: string | null;
  readonly updateNotifier: string | null;
  readonly inheritedGitDir: string | null;
  readonly secret: string | null;
}

/** Everything one delivery case works with. */
interface DeliveryFixture {
  readonly fixture: RepositoryFixture;
  readonly prepared: PreparedWorkspace;
  /** The bare repository the branch is pushed to. */
  readonly destination: string;
  /** How the stand-in `gh` answers this case's pull request calls. */
  readonly mode: string;
  readonly recordFile: string;
  readonly request: DeliveryRequest;
}

/** A prepared attempt with one commit of work, and a bare destination. */
async function deliverableAttempt(mode: string): Promise<DeliveryFixture> {
  const fixture = await createRepository();
  const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
  const run = await allocateRunDirectory(fixture.workDir);
  const prepared = await prepareWorkspace(run, source, {
    deadlineMs: Date.now() + 120_000,
    now: () => new Date(),
  });
  await mkdir(prepared.logsDir, { recursive: true });
  await writeFile(path.join(prepared.workspacePath, 'work.txt'), 'the attempt’s work\n', 'utf8');
  await gitOrFail(['add', '--all'], prepared.workspacePath);
  await gitOrFail(['commit', '--quiet', '--message', 'the attempt’s work'], prepared.workspacePath);

  const destinationParent = await createTempDir();
  const destination = path.join(destinationParent, 'target.git');
  await gitOrFail(['init', '--quiet', '--bare', destination], destinationParent);

  const recordFile = path.join(fixture.parent, `gh-${mode}.jsonl`);
  return {
    fixture,
    prepared,
    destination,
    mode,
    recordFile,
    request: {
      workspacePath: prepared.workspacePath,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      logsDir: prepared.logsDir,
      runId: prepared.runId,
      reportPath: path.join(prepared.runDir, 'result.json'),
      task: { id: 'HARN-23', title: 'Rebuild the boundary tests' },
      checks: 'the configured checks passed',
      sourceRef: {
        type: 'jira',
        scope: 'https://example.atlassian.net',
        id: '10001',
        key: 'HARN-23',
        url: 'https://example.atlassian.net/browse/HARN-23',
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

/** The commit one branch of the destination holds, or `null` when it holds none. */
async function destinationBranch(destination: string, branch: string): Promise<string | null> {
  const result = await fixtureGit(
    ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
    destination,
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Runs one delivery with the stand-in `gh` first on `PATH`. The environment the
 * step is handed is this process's own, with the operator's credential and an
 * inherited Git variable that would redirect a command, so the case proves what
 * the boundary does with them. Both are put back afterwards.
 */
async function deliver(
  fixture: DeliveryFixture,
  stop: AbortSignal = new AbortController().signal,
): Promise<Awaited<ReturnType<ReturnType<typeof createGitHubDelivery>['deliver']>>> {
  const standIn = await installStandIn('gh', STAND_IN_GH);
  const saved = {
    mode: process.env.NEXUS_GH_MODE,
    record: process.env.NEXUS_GH_RECORD,
    secret: process.env.NEXUS_GH_SECRET,
    gitDir: process.env.GIT_DIR,
  };
  process.env.NEXUS_GH_MODE = fixture.mode;
  process.env.NEXUS_GH_RECORD = fixture.recordFile;
  process.env.NEXUS_GH_SECRET = 'operator-token';
  process.env.GIT_DIR = path.join(fixture.fixture.parent, 'nowhere.git');
  try {
    return await withPathPrefix(standIn.bin, async () => {
      const delivery = createGitHubDelivery(CONFIG, {
        pushUrl: fixture.destination,
        env: process.env,
      });
      return await delivery.deliver(fixture.request, stop);
    });
  } finally {
    restoreEnvironment(saved);
  }
}

/** Puts the environment the way the case found it. */
function restoreEnvironment(saved: {
  readonly mode: string | undefined;
  readonly record: string | undefined;
  readonly secret: string | undefined;
  readonly gitDir: string | undefined;
}): void {
  for (const [name, value] of [
    ['NEXUS_GH_MODE', saved.mode],
    ['NEXUS_GH_RECORD', saved.record],
    ['NEXUS_GH_SECRET', saved.secret],
    ['GIT_DIR', saved.gitDir],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

/** Every stand-in `gh` invocation one case made, in order. */
async function ghRecords(file: string): Promise<readonly GhRecord[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as GhRecord);
}

/** The error one delivery that was expected to fail rejected with. */
async function deliveryFailureOf(
  fixture: DeliveryFixture,
  stop?: AbortSignal,
): Promise<DeliveryError> {
  try {
    await deliver(fixture, stop);
  } catch (cause) {
    if (!(cause instanceof DeliveryError)) {
      throw new Error(`the delivery failed with something else: ${String(cause)}`, { cause });
    }
    return cause;
  }
  throw new Error('the delivery was expected to fail, and it did not');
}

describe('the GitHub delivery step', () => {
  it('pushes the validated revision and creates one pull request for it', async () => {
    const fixture = await deliverableAttempt('create');
    const commit = (
      await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], fixture.prepared.workspacePath)
    ).trim();
    const delivered = await deliver(fixture);

    expect(delivered).toEqual({
      url: 'https://github.com/example/target/pull/9',
      number: 9,
      head: commit,
      created: true,
    });
    // The destination really holds the branch, at the revision that passed.
    expect(await destinationBranch(fixture.destination, fixture.prepared.branch)).toBe(commit);

    const records = await ghRecords(fixture.recordFile);
    expect(records).toHaveLength(2);
    const [listed, created] = records;
    expect(listed?.args.slice(0, 2)).toEqual(['pr', 'list']);
    expect(listed?.args).toContain('example/target');
    expect(listed?.args).toContain(fixture.prepared.branch);
    expect(listed?.args).toContain('main');
    expect(created?.args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(created?.args).toContain('HARN-23: Rebuild the boundary tests');

    // Both commands ran in the retained working copy, with prompts disabled, the
    // operator's own environment passed through unchanged, and the inherited Git
    // variable that would redirect them dropped.
    for (const record of records) {
      expect(record.cwd).toBe(fixture.prepared.workspacePath);
      expect(record.promptDisabled).toBe('1');
      expect(record.updateNotifier).toBe('1');
      expect(record.inheritedGitDir).toBeNull();
      expect(record.secret).toBe('operator-token');
    }
    expect(existsSync(path.join(fixture.prepared.logsDir, 'delivery-git-push.stdout.log'))).toBe(
      true,
    );

    const bodyFile = path.join(fixture.prepared.logsDir, 'delivery-pull-request-body.md');
    const body = await readFile(bodyFile, 'utf8');
    expect(body).toContain('HARN-23: https://example.atlassian.net/browse/HARN-23');
    expect(body).toContain('Checks: the configured checks passed');
    expect(body).toContain(`Harness run: ${fixture.prepared.runId}`);
  }, 120_000);

  it('updates the one open pull request instead of creating a second one', async () => {
    const fixture = await deliverableAttempt('update');

    const delivered = await deliver(fixture);

    expect(delivered?.url).toBe('https://github.com/example/target/pull/9');
    expect(delivered?.number).toBe(9);
    expect(delivered?.created).toBe(false);
    expect(delivered?.head).toBe(
      await destinationBranch(fixture.destination, fixture.prepared.branch),
    );
    const records = await ghRecords(fixture.recordFile);
    const [listed, edited] = records;
    expect(listed?.args.slice(0, 2)).toEqual(['pr', 'list']);
    expect(edited?.args.slice(0, 3)).toEqual([
      'pr',
      'edit',
      'https://github.com/example/target/pull/9',
    ]);
    expect(records.some((record) => record.args[1] === 'create')).toBe(false);
  }, 120_000);

  it('refuses a working copy that still holds uncommitted work, and pushes nothing', async () => {
    const fixture = await deliverableAttempt('create');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(fixture.prepared.workspacePath, 'left.txt'), 'left behind\n', 'utf8');

    const error = await deliveryFailureOf(fixture);

    expect(error.message).toContain('left.txt');
    expect(error.message).toContain('still hold uncommitted changes');
    expect(error.message).toContain('never commits or discards');
    // Nothing was pushed and no pull request was touched.
    expect(await destinationBranch(fixture.destination, fixture.prepared.branch)).toBeNull();
    expect(existsSync(fixture.recordFile)).toBe(false);
    // The working copy is kept exactly as the turn left it.
    expect(await readFile(path.join(fixture.prepared.workspacePath, 'left.txt'), 'utf8')).toBe(
      'left behind\n',
    );
  }, 120_000);

  it('refuses to publish a branch the checks never validated', async () => {
    const fixture = await deliverableAttempt('create');
    // The checkout is moved back to the recorded base while the recorded branch
    // keeps the commit that passed: pushing the branch would publish a revision
    // the checks never saw.
    const tip = (
      await gitOrFail(
        ['rev-parse', '--verify', `refs/heads/${fixture.prepared.branch}^{commit}`],
        fixture.prepared.workspacePath,
      )
    ).trim();
    await gitOrFail(
      ['checkout', '--quiet', '--detach', fixture.prepared.baseCommit],
      fixture.prepared.workspacePath,
    );

    const error = await deliveryFailureOf(fixture);

    expect(error.message).toContain(`is checked out at ${fixture.prepared.baseCommit}`);
    expect(error.message).toContain(`is at ${tip}`);
    expect(error.message).toContain(
      'Nothing was pushed and no pull request was created or updated',
    );
    expect(await destinationBranch(fixture.destination, fixture.prepared.branch)).toBeNull();
  }, 120_000);

  it('delivers when the checkout is on another branch at the revision that passed', async () => {
    const fixture = await deliverableAttempt('create');
    const validated = (
      await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], fixture.prepared.workspacePath)
    ).trim();
    // A branch of its own at the very revision the recorded branch holds: the
    // revision is what a delivery compares, not the branch's name.
    await gitOrFail(['checkout', '--quiet', '-b', 'side'], fixture.prepared.workspacePath);

    const delivered = await deliver(fixture);

    expect(delivered?.head).toBe(validated);
    expect(delivered?.created).toBe(true);
    expect(await destinationBranch(fixture.destination, fixture.prepared.branch)).toBe(validated);
  }, 120_000);

  it('delivers nothing when the branch holds no commit beyond its recorded base', async () => {
    const fixture = await deliverableAttempt('create');
    // A passed attempt that committed nothing has nothing to deliver.
    await gitOrFail(
      ['reset', '--quiet', '--hard', fixture.prepared.baseCommit],
      fixture.prepared.workspacePath,
    );

    const delivered = await deliver(fixture);

    expect(delivered).toBeNull();
    expect(existsSync(fixture.recordFile)).toBe(false);
    expect(await destinationBranch(fixture.destination, fixture.prepared.branch)).toBeNull();
  }, 120_000);

  it('reports what a failed command said, with its output kept beside the run', async () => {
    const fixture = await deliverableAttempt('fail');

    const error = await deliveryFailureOf(fixture);

    expect(error.message).toContain('gh pr list failed');
    expect(error.message).toContain('gh: authentication is required');
    expect(error.message).toContain('gh auth status');
    expect(
      await readFile(path.join(fixture.prepared.logsDir, 'delivery-gh-pr-list.stderr.log'), 'utf8'),
    ).toBe('gh: authentication is required\n');
  }, 120_000);

  it('refuses a pull request that is not open instead of editing it back into looking current', async () => {
    const fixture = await deliverableAttempt('closed');

    const error = await deliveryFailureOf(fixture);

    expect(error.message).toContain('is not open');
    expect(error.message).toContain('(MERGED)');
    expect(error.message).toContain('delivery-pull-request-body.md');
    // The branch was pushed — the harness never pretends otherwise — but no
    // closed pull request was touched.
    expect(await destinationBranch(fixture.destination, fixture.prepared.branch)).not.toBeNull();
    const records = await ghRecords(fixture.recordFile);
    expect(records.map((record) => record.args[1])).toEqual(['list']);
  }, 120_000);

  it('says what is unknown when the harness has to stop a delivery command', async () => {
    const fixture = await deliverableAttempt('create');
    const controller = new AbortController();
    controller.abort();

    const error = await deliveryFailureOf(fixture, controller.signal);

    expect(error.message).toContain('git status was stopped');
    expect(error.message).toContain('how far the delivery got is unknown');
    // A stopped command is never reported as a completed one.
    expect(await destinationBranch(fixture.destination, fixture.prepared.branch)).toBeNull();
  }, 120_000);
});
