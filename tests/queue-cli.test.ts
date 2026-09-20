/**
 * `queue run` and `queue watch` at the command boundary.
 *
 * These tests are about what the commands accept and refuse, and about the
 * shape of the process a healthy queue is: an empty queue ends a finite run
 * successfully, an idle watch stays one foreground process until it is
 * interrupted, and a second consumer is refused before anything is claimed.
 * Nothing here contacts Jira or GitHub: the Jira boundary is a fake `fetch` that
 * answers the queue's search with an empty page.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/context.js';
import type { CliContext, InterruptSignals } from '../src/cli/context.js';
import { acquireIntakeLock, intakeLockPath } from '../src/sources/receipts.js';
import { git } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir, writeJsonFile } from './support.js';

afterEach(async () => {
  await cleanupTempDirectories();
  delete process.env['JIRA_API_TOKEN'];
  delete process.env['NEXUS_LENS_TOKEN'];
  delete process.env['NEXUS_LENS_KEY_PATH'];
});

/** The queue's connection, as the documented example configures it. */
const SOURCE = {
  type: 'jira',
  siteUrl: 'https://example.atlassian.net',
  cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
  projectKey: 'SAM1',
  label: 'harness-task',
  pollIntervalSeconds: 5,
  tokenEnv: 'JIRA_API_TOKEN',
};

/** The review and delivery sides of one queue, as they must agree. */
function queueConfig(workDir: string): Record<string, unknown> {
  return {
    workDir,
    maxRepairs: 1,
    taskTimeoutMinutes: 5,
    commandTimeoutMinutes: 5,
    setup: [],
    checks: [['node', '--version']],
    delivery: {
      type: 'github',
      repository: 'saintiago/nexus-harness',
      baseBranch: 'main',
      completion: {
        lensApp: 'nexus-lens[bot]',
        lensAppId: 5_001_141,
        lensCheckName: 'Nexus Lens review',
        reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
        postMergeWorkflows: ['ci.yml'],
        toDoStatus: 'To Do',
        doneStatus: 'Done',
        pollIntervalSeconds: 5,
        deadlineSeconds: 30,
      },
    },
    source: SOURCE,
    review: {
      type: 'github',
      repository: 'saintiago/nexus-harness',
      app: {
        appId: 5_001_141,
        installationId: 163_007_360,
        privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
        login: 'nexus-lens[bot]',
      },
      reviewer: { runtime: 'codex', command: ['codex'] },
      checkName: 'Nexus Lens review',
    },
  };
}

interface CliFixture {
  /** The operator's checkout the queue would prepare and clone from. */
  readonly repo: string;
  /** The configuration file, already written. */
  readonly configPath: string;
  /** What the invocation printed, in order. */
  readonly lines: string[];
  /** Every request the fake Jira boundary was asked for. */
  readonly requests: string[];
  /** The interrupt handler the command installed, when it installed one. */
  readonly interrupt: () => void;
  readonly release: () => boolean;
  /** Whether any coding turn was started. */
  readonly turns: () => number;
  readonly context: CliContext;
}

/** One command-line fixture: a clean checkout, a config, and every fake. */
async function cliFixture(parts: {
  readonly config?: (workDir: string) => unknown;
  readonly cwd?: string;
}): Promise<CliFixture> {
  const root = await createTempDir();
  const repo = path.join(root, 'target');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(repo, 'README.md'), 'the target repository\n', 'utf8');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--message', 'baseline');

  const workDir = path.join(root, 'out');
  const config = (parts.config ?? queueConfig)(workDir);
  const configPath = await writeJsonFile(root, 'harness.queue.json', config);

  // The two tokens and the App key the queue resolves before it runs anything.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(root, 'lens.pem');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
  process.env['JIRA_API_TOKEN'] = 'test-jira-token';
  process.env['NEXUS_LENS_TOKEN'] = 'test-lens-token';
  process.env['NEXUS_LENS_KEY_PATH'] = keyPath;

  const lines: string[] = [];
  const requests: string[] = [];
  let turns = 0;
  let handler: (() => void) | null = null;
  let released = false;

  const signals: InterruptSignals = {
    onInterrupt: (next) => {
      handler = next;
      return () => {
        released = true;
        handler = null;
      };
    },
  };

  const jiraFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    // Every queue read here is the eligible-issues search: answer it with one
    // final, empty page, so no ticket is ever claimed.
    return new Response(JSON.stringify({ issues: [], isLast: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const context: CliContext = {
    cwd: parts.cwd ?? root,
    io: {
      out: (text) => {
        lines.push(text);
      },
      err: (text) => {
        lines.push(`error: ${text}`);
      },
    },
    signals,
    fetch: jiraFetch,
    dependencies: {
      runAgentTurn: async () => {
        turns += 1;
        throw new Error('no coding turn may run in a queue test');
      },
    },
  };

  return {
    repo,
    configPath,
    lines,
    requests,
    interrupt: () => handler?.(),
    release: () => released,
    turns: () => turns,
    context,
  };
}

/** Every line the invocation wrote, as one readable block. */
function output(fixture: CliFixture): string {
  return fixture.lines.join('\n');
}

describe('the queue command line', () => {
  it('requires one of its two subcommands', async () => {
    const fixture = await cliFixture({ config: queueConfig });

    const code = await runCli(['queue'], fixture.context);

    expect(code).toBe(EXIT_USAGE);
    expect(output(fixture)).toContain('queue requires one of: run, watch');
  });

  it('refuses an unknown subcommand and a missing option', async () => {
    const fixture = await cliFixture({ config: queueConfig });

    expect(await runCli(['queue', 'scan'], fixture.context)).toBe(EXIT_USAGE);
    expect(await runCli(['queue', 'run'], fixture.context)).toBe(EXIT_USAGE);
    expect(await runCli(['queue', 'watch', '--config', fixture.configPath], fixture.context)).toBe(
      EXIT_USAGE,
    );
    expect(output(fixture)).toContain('unknown queue command "scan"');
    expect(output(fixture)).toContain('queue run requires --config and --repo');
    expect(output(fixture)).toContain('queue watch requires --repo');
  });

  it('does not accept the one-item commands option on a queue command', async () => {
    const fixture = await cliFixture({ config: queueConfig });

    const code = await runCli(
      ['queue', 'run', '--config', fixture.configPath, '--repo', fixture.repo, '--limit', '1'],
      fixture.context,
    );

    expect(code).toBe(EXIT_USAGE);
    expect(output(fixture)).toContain('unknown option "--limit"');
  });

  it('refuses a configuration that could never complete a ticket', async () => {
    const withoutSource = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        delete config['source'];
        delete config['review'];
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', withoutSource.configPath, '--repo', withoutSource.repo],
        withoutSource.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    expect(output(withoutSource)).toContain('has no "source" object');

    const withoutReview = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        delete config['review'];
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', withoutReview.configPath, '--repo', withoutReview.repo],
        withoutReview.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    expect(output(withoutReview)).toContain('has no "review" object');

    const withoutCompletion = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        delete (config['delivery'] as Record<string, unknown>)['completion'];
        return config;
      },
    });
    expect(
      await runCli(
        [
          'queue',
          'run',
          '--config',
          withoutCompletion.configPath,
          '--repo',
          withoutCompletion.repo,
        ],
        withoutCompletion.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    expect(output(withoutCompletion)).toContain('without "delivery.completion"');
  });

  it('refuses a review that does not publish the check the completion gate requires', async () => {
    const otherRepository = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        (config['review'] as Record<string, unknown>)['repository'] = 'someone/else';
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', otherRepository.configPath, '--repo', otherRepository.repo],
        otherRepository.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    // The loader owns this agreement: the queue never sees a configuration in
    // which the review and the completion path describe different artifacts.
    expect(output(otherRepository)).toContain('completion Lens identity must match');

    const otherCheck = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        (config['review'] as Record<string, unknown>)['checkName'] = 'Something else';
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', otherCheck.configPath, '--repo', otherCheck.repo],
        otherCheck.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    expect(output(otherCheck)).toContain('completion Lens identity must match');
  });

  it('exits successfully when the queue is empty and claims nothing', async () => {
    const fixture = await cliFixture({ config: queueConfig });

    const code = await runCli(
      ['queue', 'run', '--config', fixture.configPath, '--repo', fixture.repo],
      fixture.context,
    );

    expect(code).toBe(EXIT_OK);
    expect(output(fixture)).toContain('queue run: completed');
    expect(output(fixture)).toContain('no eligible ticket');
    expect(output(fixture)).toContain('0 ticket(s) reached the configured Done status');
    expect(fixture.turns()).toBe(0);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toContain('/rest/api/3/search/jql');
    // The command installed one interrupt handler and let go of it again.
    expect(fixture.release()).toBe(true);
  });

  it('stays one foreground process while idle, and exits when interrupted', async () => {
    const fixture = await cliFixture({ config: queueConfig });
    let idle = (): void => {};
    const reachedIdle = new Promise<void>((resolve) => {
      idle = resolve;
    });
    const watching: CliContext = {
      ...fixture.context,
      io: {
        out: (text) => {
          fixture.lines.push(text);
          if (text.startsWith('queue idle')) {
            idle();
          }
        },
        err: (text) => {
          fixture.lines.push(`error: ${text}`);
        },
      },
    };

    const running = runCli(
      ['queue', 'watch', '--config', fixture.configPath, '--repo', fixture.repo],
      watching,
    );
    await reachedIdle;
    fixture.interrupt();

    expect(await running).toBe(EXIT_CANCELLED);
    expect(output(fixture)).toContain('queue idle: no eligible ticket');
    expect(output(fixture)).toContain('queue watch: cancelled');
    expect(fixture.turns()).toBe(0);
    expect(fixture.requests).toHaveLength(1);
  });

  it('exits nonzero on a queue the source cannot answer, instead of polling it', async () => {
    const fixture = await cliFixture({ config: queueConfig });
    const failing: CliContext = {
      ...fixture.context,
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fixture.requests.push(url);
        return new Response('the site is unavailable', { status: 503 });
      },
    };

    const code = await runCli(
      ['queue', 'watch', '--config', fixture.configPath, '--repo', fixture.repo],
      failing,
    );

    expect(code).toBe(EXIT_INPUT_ERROR);
    expect(output(fixture)).toContain('queue watch: stopped');
    expect(output(fixture)).toContain('503');
    expect(output(fixture)).not.toContain('queue idle');
    expect(fixture.turns()).toBe(0);
  });

  it('refuses to start while another consumer holds the intake lock', async () => {
    const fixture = await cliFixture({ config: queueConfig });
    const workDir = path.join(path.dirname(fixture.configPath), 'out');
    const lock = await acquireIntakeLock(workDir, () => new Date());
    try {
      const code = await runCli(
        ['queue', 'run', '--config', fixture.configPath, '--repo', fixture.repo],
        fixture.context,
      );

      expect(code).toBe(EXIT_INPUT_ERROR);
      expect(output(fixture)).toContain('another intake consumer holds');
      // Nothing was read and nothing ran: the lock is the first thing after the
      // checkout preflight.
      expect(fixture.requests).toEqual([]);
      expect(fixture.turns()).toBe(0);
      expect(existsSync(intakeLockPath(workDir))).toBe(true);
    } finally {
      await lock.release();
    }
  });
});
