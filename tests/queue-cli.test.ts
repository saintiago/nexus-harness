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
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/context.js';
import type { CliContext, InterruptSignals } from '../src/cli/context.js';
import { loadConfiguration, projectLockNamespace } from '../src/config/load.js';
import { acquireIntakeLock, intakeLockPath } from '../src/sources/receipts.js';
import { git, installFakeGhCompletion, fakeCompletionCalls } from './fixtures/local-target.js';
import {
  HARNESS_CONFIG_FILE_NAME,
  PROJECT_CONFIG_FILE_NAME,
  projectConfigFile,
} from '../src/config/paths.js';
import {
  cleanupTempDirectories,
  createTempDir,
  splitConfig,
  writeJsonFile,
  type JsonObject,
} from './support.js';

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

/** The Nexus-wide side of the fixture queue: limits, launch, and reviewer. */
function queueHarnessConfig(workDir: string): Record<string, unknown> {
  return {
    workDir,
    maxRepairs: 1,
    taskTimeoutMinutes: 5,
    commandTimeoutMinutes: 5,
    agent: { runtime: 'codex', command: ['codex'] },
    reviewer: {
      app: {
        appId: 5_001_141,
        installationId: 163_007_360,
        privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
        login: 'nexus-lens[bot]',
      },
      reviewer: { runtime: 'codex', command: ['codex'] },
      checkName: 'Nexus Lens review',
    },
    completion: {
      lensApp: 'nexus-lens[bot]',
      lensAppId: 5_001_141,
      lensCheckName: 'Nexus Lens review',
      reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
      pollIntervalSeconds: 5,
      deadlineSeconds: 30,
    },
  };
}

/** The connected project's own side: its commands, queue, and destination. */
function queueProjectConfig(): Record<string, unknown> {
  return {
    setup: [],
    checks: [['node', '--version']],
    source: SOURCE,
    delivery: {
      type: 'github',
      repository: 'saintiago/nexus-harness',
      baseBranch: 'main',
      completion: {
        postMergeWorkflows: ['ci.yml'],
        toDoStatus: 'To Do',
        doneStatus: 'Done',
      },
    },
  };
}

/**
 * The whole fixture queue as one field map, for a test that replaces parts of
 * it: the fixture itself routes each field to the file that owns it.
 */
function queueConfig(workDir: string): Record<string, unknown> {
  return { ...queueHarnessConfig(workDir), ...queueProjectConfig() };
}

/**
 * The same configuration with a different Nexus Lens identity, still one
 * identity on both sides of the harness configuration: the reviewer that scans
 * the pull request and the completion gate that requires its check.
 */
function lensQueueConfig(workDir: string): Record<string, unknown> {
  const config = queueConfig(workDir);
  const reviewer = config['reviewer'] as Record<string, unknown>;
  const app = reviewer['app'] as Record<string, unknown>;
  app['appId'] = 123;
  app['login'] = 'nexus-lens';
  reviewer['checkName'] = 'Nexus Lens';
  const completion = config['completion'] as Record<string, unknown>;
  completion['lensAppId'] = 123;
  completion['lensApp'] = 'nexus-lens';
  completion['lensCheckName'] = 'Nexus Lens';
  return config;
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
  readonly queries: string[];
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
  const workDir = path.join(root, 'out');
  // The connected project's own configuration is committed with the checkout
  // the queue prepares and clones from; the Nexus-wide file sits beside it.
  const config = (parts.config ?? queueConfig)(workDir);
  const { harness, project } = splitConfig(config as JsonObject);
  await writeJsonFile(repo, PROJECT_CONFIG_FILE_NAME, project);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(repo, 'README.md'), 'the target repository\n', 'utf8');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--message', 'baseline');

  const configPath = await writeJsonFile(root, HARNESS_CONFIG_FILE_NAME, harness);

  // The two tokens and the App key the queue resolves before it runs anything.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(root, 'lens.pem');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
  process.env['JIRA_API_TOKEN'] = 'test-jira-token';
  process.env['NEXUS_LENS_TOKEN'] = 'test-lens-token';
  process.env['NEXUS_LENS_KEY_PATH'] = keyPath;

  const lines: string[] = [];
  const requests: string[] = [];
  const queries: string[] = [];
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

  const jiraFetch: typeof fetch = async (input, init) => {
    queries.push((JSON.parse(String(init?.body)) as { jql: string }).jql);
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
    queries,
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

/**
 * One CLI invocation of the fixture, with output and interrupt registration of
 * its own: two queue processes in one test must not share the single handler
 * the fixture's own context records.
 */
function invocation(
  fixture: CliFixture,
  onLine: (text: string) => void = () => undefined,
): { readonly context: CliContext; readonly lines: string[]; interrupt(): void } {
  let handler: (() => void) | null = null;
  const lines: string[] = [];
  const signals: InterruptSignals = {
    onInterrupt: (next) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
  };
  return {
    lines,
    context: {
      ...fixture.context,
      signals,
      io: {
        out: (text) => {
          lines.push(text);
          onLine(text);
        },
        err: (text) => {
          lines.push(`error: ${text}`);
          onLine(`error: ${text}`);
        },
      },
    },
    interrupt: () => handler?.(),
  };
}

/** A second connected project's own configuration: another Jira queue and destination. */
function secondProjectConfig(): Record<string, unknown> {
  const config = queueProjectConfig();
  config['source'] = { ...SOURCE, projectKey: 'MAG' };
  config['delivery'] = {
    ...(config['delivery'] as Record<string, unknown>),
    repository: 'saintiago/magic-collection-keeper',
  };
  return config;
}

/**
 * A second connected repository beside the fixture's own, under the same Nexus
 * installation: its `nexus.project.json` names its own queue, and the shared
 * harness configuration stays the one file the fixture wrote.
 */
async function secondConnectedRepo(root: string): Promise<string> {
  const repo = path.join(root, 'target-two');
  mkdirSync(repo, { recursive: true });
  await writeJsonFile(repo, PROJECT_CONFIG_FILE_NAME, secondProjectConfig());
  git(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(repo, 'README.md'), 'the second target repository\n', 'utf8');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--message', 'baseline');
  return repo;
}

describe('the queue command line', () => {
  it.each(['run', 'watch'])(
    'stops %s on authoritative In Progress ownership before a ready claim',
    async (mode) => {
      const fixture = await cliFixture({});
      const issue = {
        id: '7',
        key: 'SAM1-7',
        fields: {
          summary: 'Interrupted ticket',
          status: { name: 'In Progress' },
          labels: ['harness-task'],
          project: { key: 'SAM1' },
          issuetype: { name: 'Task' },
          updated: '2026-09-20T00:00:00Z',
        },
      };
      const queries: string[] = [];
      const code = await runCli(
        ['queue', mode, '--config', fixture.configPath, '--repo', fixture.repo],
        {
          ...fixture.context,
          fetch: async (input, init) => {
            if (String(input).includes('/search/jql')) {
              queries.push((JSON.parse(String(init?.body)) as { jql: string }).jql);
              return new Response(JSON.stringify({ issues: [issue], isLast: true }));
            }
            expect(init?.method).toBe('GET');
            return new Response(JSON.stringify(issue));
          },
        },
      );
      expect(code).toBe(EXIT_INPUT_ERROR);
      expect(output(fixture)).toContain('SAM1-7: still In Progress');
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('status = "In Progress"');
      expect(fixture.turns()).toBe(0);
      expect(fixture.release()).toBe(true);
    },
  );

  it('resumes an admitted merged In Review ticket, then a restart after Done has no completion effects', async () => {
    const fixture = await cliFixture({ config: lensQueueConfig });
    // Queue mode must not depend on a pre-minted, expiring environment token.
    delete process.env['NEXUS_LENS_TOKEN'];
    const root = path.dirname(fixture.configPath);
    const workDir = path.join(root, 'out');
    const workspace = 'run-20260101000000-abcdef01';
    const head = 'a'.repeat(40);
    const merge = git(fixture.repo, 'rev-parse', 'HEAD').trim();
    const remote = path.join(root, 'remote.git');
    git(root, 'clone', '--bare', fixture.repo, remote);
    git(fixture.repo, 'remote', 'add', 'origin', remote);
    mkdirSync(path.join(workDir, 'workspaces', workspace), { recursive: true });
    const logs = path.join(workDir, 'completion-logs', '7');
    mkdirSync(logs, { recursive: true });
    await writeFile(
      path.join(logs, 'completion-armed-head.json'),
      JSON.stringify({ head, number: 29, waitingSince: null }),
    );
    const gh = await installFakeGhCompletion(root);
    const prUrl = 'https://github.com/saintiago/nexus-harness/pull/29';
    await writeFile(
      gh.pullRequestsFile,
      JSON.stringify({
        number: 29,
        url: prUrl,
        repo: 'saintiago/nexus-harness',
        state: 'MERGED',
        isDraft: false,
        headRefName: `harness/${workspace}`,
        baseRefName: 'main',
        headRefOid: head,
        mergeCommit: { oid: merge },
      }) + '\n',
    );
    await writeFile(
      gh.reviewsFile,
      JSON.stringify([
        {
          id: 555,
          url: `${prUrl}#pullrequestreview-555`,
          author: { login: 'nexus-lens' },
          state: 'APPROVED',
          body: 'Approved',
          commitId: head,
        },
      ]),
    );
    await writeFile(
      gh.checksFile,
      JSON.stringify([
        { name: 'Nexus Lens', state: 'SUCCESS', conclusion: 'SUCCESS', link: prUrl },
      ]),
    );
    await writeFile(
      gh.runsFile,
      JSON.stringify({
        databaseId: 4242,
        workflowId: 17,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        headSha: merge,
        headBranch: 'main',
        url: 'https://github.com/saintiago/nexus-harness/actions/runs/4242',
      }) + '\n',
    );
    let status = 'In Review';
    const comments: unknown[] = [];
    let moves = 0;
    let tokens = 0;
    const context: CliContext = {
      ...fixture.context,
      completionParts: {
        command: gh.command,
        env: {
          ...process.env,
          GH_TOKEN: 'operator-token',
          FAKE_GH: JSON.stringify({ stateDir: gh.dir, token: 'operator-token' }),
        },
      },
      refreshParts: { fetchUrl: remote },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const json = (data: unknown) => new Response(JSON.stringify(data));
        if (url.hostname === 'api.github.com') {
          if (url.pathname.endsWith('/access_tokens')) {
            // Exercise the production queue's token request: the installed
            // Lens App does not grant Actions permission, even though public
            // post-merge workflow evidence is readable with its token.
            expect(body).toEqual({
              repositories: ['nexus-harness'],
              permissions: {
                pull_requests: 'write',
                checks: 'write',
                contents: 'read',
                statuses: 'read',
                metadata: 'read',
              },
            });
            tokens += 1;
            return json({ token: 'fresh-app-token', expires_at: '2099-01-01T00:00:00Z' });
          }
          expect(url.pathname).toBe('/repos/saintiago/nexus-harness/pulls');
          return json([]); // Already merged; no reviewer turn may run.
        }
        const issue = {
          id: '7',
          key: 'SAM1-7',
          fields: {
            summary: 'Delivered ticket',
            status: { name: status },
            labels: ['harness-task', `harness-ws-${workspace}`],
            project: { key: 'SAM1' },
            issuetype: { name: 'Task' },
            updated: '2026-09-20T00:00:00Z',
          },
        };
        if (url.pathname.endsWith('/search/jql')) {
          return json({
            issues: String(body['jql']).includes(`status = "${status}"`) ? [issue] : [],
            isLast: true,
          });
        }
        if (url.pathname.endsWith('/changelog')) return json({ values: [], isLast: true });
        if (url.pathname.endsWith('/comment')) {
          if (init?.method === 'POST') {
            const comment = {
              id: String(comments.length + 1),
              body: body['body'],
              created: '2026-09-20T12:00:00Z',
            };
            comments.push(comment);
            return json(comment);
          }
          return json({ comments, total: comments.length });
        }
        if (url.pathname.endsWith('/transitions')) {
          if (init?.method === 'POST') {
            expect(body).toEqual({ transition: { id: 'done' } });
            moves += 1;
            status = 'Done';
            return new Response(null, { status: 204 });
          }
          return json({ transitions: [{ id: 'done', name: 'Done', to: { name: 'Done' } }] });
        }
        expect(url.pathname).toContain('/issue/7');
        return json(issue);
      },
    };
    const args = ['queue', 'run', '--config', fixture.configPath, '--repo', fixture.repo];
    expect(await runCli(args, context), output(fixture)).toBe(EXIT_OK);
    expect(status).toBe('Done');
    expect(comments).toHaveLength(1);
    expect(moves).toBe(1);
    expect(tokens).toBe(1);
    expect(fixture.turns()).toBe(0);
    const calls = await fakeCompletionCalls(gh);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.credential === 'fresh-app-token')).toBe(true);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
    expect(await runCli(args, context)).toBe(EXIT_OK);
    expect(await fakeCompletionCalls(gh)).toEqual(calls);
    expect(comments).toHaveLength(1);
    expect(moves).toBe(1);
    expect(tokens).toBe(1);
  }, 30_000);

  it('creates the missing completion evidence directory and resolves the ticket it resumes', async () => {
    const fixture = await cliFixture({ config: lensQueueConfig });
    // Queue mode must not depend on a pre-minted, expiring environment token.
    delete process.env['NEXUS_LENS_TOKEN'];
    const root = path.dirname(fixture.configPath);
    const workDir = path.join(root, 'out');
    const workspace = 'run-20260101000000-abcdef01';
    const head = 'a'.repeat(40);
    const merge = git(fixture.repo, 'rev-parse', 'HEAD').trim();
    const remote = path.join(root, 'remote.git');
    git(root, 'clone', '--bare', fixture.repo, remote);
    git(fixture.repo, 'remote', 'add', 'origin', remote);
    mkdirSync(path.join(workDir, 'workspaces', workspace), { recursive: true });
    // The production restart: an approved In Review ticket whose completion
    // pass never wrote anything, so `completion-logs` does not exist at all.
    const logs = path.join(workDir, 'completion-logs', '7');
    expect(existsSync(path.join(workDir, 'completion-logs'))).toBe(false);
    const gh = await installFakeGhCompletion(root);
    const prUrl = 'https://github.com/saintiago/nexus-harness/pull/29';
    await writeFile(
      gh.pullRequestsFile,
      JSON.stringify({
        number: 29,
        url: prUrl,
        repo: 'saintiago/nexus-harness',
        state: 'OPEN',
        isDraft: false,
        headRefName: `harness/${workspace}`,
        baseRefName: 'main',
        headRefOid: head,
        mergeCommit: null,
      }) + '\n',
    );
    await writeFile(
      gh.reviewsFile,
      JSON.stringify([
        {
          id: 555,
          url: `${prUrl}#pullrequestreview-555`,
          author: { login: 'nexus-lens' },
          state: 'APPROVED',
          body: 'Approved',
          commitId: head,
        },
      ]),
    );
    await writeFile(
      gh.checksFile,
      JSON.stringify([
        { name: 'Nexus Lens', state: 'SUCCESS', conclusion: 'SUCCESS', link: prUrl },
      ]),
    );
    await writeFile(
      gh.runsFile,
      JSON.stringify({
        databaseId: 4242,
        workflowId: 17,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        headSha: merge,
        headBranch: 'main',
        url: 'https://github.com/saintiago/nexus-harness/actions/runs/4242',
      }) + '\n',
    );
    let status = 'In Review';
    const comments: unknown[] = [];
    let moves = 0;
    const context: CliContext = {
      ...fixture.context,
      completionParts: {
        command: gh.command,
        env: {
          ...process.env,
          GH_TOKEN: 'operator-token',
          // GitHub performs the merge itself once the harness armed auto-merge.
          FAKE_GH: JSON.stringify({
            stateDir: gh.dir,
            token: 'operator-token',
            mergeOnArm: merge,
          }),
        },
      },
      refreshParts: { fetchUrl: remote },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const json = (data: unknown) => new Response(JSON.stringify(data));
        if (url.hostname === 'api.github.com') {
          if (url.pathname.endsWith('/access_tokens')) {
            expect(body).toEqual({
              repositories: ['nexus-harness'],
              permissions: {
                pull_requests: 'write',
                checks: 'write',
                contents: 'read',
                statuses: 'read',
                metadata: 'read',
              },
            });
            return json({ token: 'fresh-app-token', expires_at: '2099-01-01T00:00:00Z' });
          }
          expect(url.pathname).toBe('/repos/saintiago/nexus-harness/pulls');
          return json([]); // No reviewer turn may run in this queue test.
        }
        const issue = {
          id: '7',
          key: 'SAM1-7',
          fields: {
            summary: 'Delivered ticket',
            status: { name: status },
            labels: ['harness-task', `harness-ws-${workspace}`],
            project: { key: 'SAM1' },
            issuetype: { name: 'Task' },
            updated: '2026-09-20T00:00:00Z',
          },
        };
        if (url.pathname.endsWith('/search/jql')) {
          return json({
            issues: String(body['jql']).includes(`status = "${status}"`) ? [issue] : [],
            isLast: true,
          });
        }
        if (url.pathname.endsWith('/changelog')) return json({ values: [], isLast: true });
        if (url.pathname.endsWith('/comment')) {
          if (init?.method === 'POST') {
            const comment = {
              id: String(comments.length + 1),
              body: body['body'],
              created: '2026-09-20T12:00:00Z',
            };
            comments.push(comment);
            return json(comment);
          }
          return json({ comments, total: comments.length });
        }
        if (url.pathname.endsWith('/transitions')) {
          if (init?.method === 'POST') {
            expect(body).toEqual({ transition: { id: 'done' } });
            moves += 1;
            status = 'Done';
            return new Response(null, { status: 204 });
          }
          return json({ transitions: [{ id: 'done', name: 'Done', to: { name: 'Done' } }] });
        }
        expect(url.pathname).toContain('/issue/7');
        return json(issue);
      },
    };
    const args = ['queue', 'run', '--config', fixture.configPath, '--repo', fixture.repo];

    expect(await runCli(args, context), output(fixture)).toBe(EXIT_OK);

    expect(status).toBe('Done');
    expect(comments).toHaveLength(1);
    expect(moves).toBe(1);
    expect(fixture.turns()).toBe(0);
    const calls = await fakeCompletionCalls(gh);
    // The one write is the operator's auto-merge request; every read the pass
    // made used the App installation token.
    expect(calls.filter((call) => call.op === 'merge')).toHaveLength(1);
    expect(calls.find((call) => call.op === 'merge')?.credential).toBe('operator-token');
    expect(
      calls
        .filter((call) => call.op !== 'merge')
        .every((call) => call.credential === 'fresh-app-token'),
    ).toBe(true);
    // The directory that was missing now holds the pass's own evidence.
    expect(existsSync(path.join(logs, 'completion-armed-head.json'))).toBe(true);
    expect(readdirSync(logs).some((name) => name.endsWith('.stdout.log'))).toBe(true);
  }, 30_000);

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

    const withoutDelivery = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        delete config['delivery'];
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', withoutDelivery.configPath, '--repo', withoutDelivery.repo],
        withoutDelivery.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    expect(output(withoutDelivery)).toContain('has no "delivery" object');
    expect(output(withoutDelivery)).toContain(
      path.join(withoutDelivery.repo, PROJECT_CONFIG_FILE_NAME),
    );
    expect(output(withoutDelivery)).not.toContain('has no "reviewer" object');

    const withoutReview = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        delete config['reviewer'];
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', withoutReview.configPath, '--repo', withoutReview.repo],
        withoutReview.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    expect(output(withoutReview)).toContain('has no "reviewer" object');

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

  it('refuses a reviewer that does not publish the check the completion gate requires', async () => {
    const otherCheck = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        (config['completion'] as Record<string, unknown>)['lensCheckName'] = 'Something else';
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', otherCheck.configPath, '--repo', otherCheck.repo],
        otherCheck.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    // The loader owns this agreement: the queue never sees a configuration in
    // which the reviewer and the completion gate name different artifacts.
    expect(output(otherCheck)).toContain('must name the same Nexus Lens App, login and check');

    const otherLogin = await cliFixture({
      config: (workDir) => {
        const config = queueConfig(workDir);
        (config['completion'] as Record<string, unknown>)['lensApp'] = 'someone-else[bot]';
        return config;
      },
    });
    expect(
      await runCli(
        ['queue', 'run', '--config', otherLogin.configPath, '--repo', otherLogin.repo],
        otherLogin.context,
      ),
    ).toBe(EXIT_INPUT_ERROR);
    expect(output(otherLogin)).toContain('must name the same Nexus Lens App, login and check');
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
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.queries.map((query) => query.match(/AND status = "([^"]+)"/)?.[1])).toEqual([
      'In Progress',
      'In Review',
      'To Do',
      'To Do',
    ]);
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
          // The line carries its emission time, so the act is recognized by
          // what it says rather than by how the row begins.
          if (text.includes('queue idle')) {
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
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.queries.map((query) => query.match(/AND status = "([^"]+)"/)?.[1])).toEqual([
      'In Progress',
      'In Review',
      'To Do',
      'To Do',
    ]);
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

  it('refuses to start while another consumer holds the same project lock', async () => {
    const fixture = await cliFixture({ config: queueConfig });
    const workDir = path.join(path.dirname(fixture.configPath), 'out');
    // The namespace comes from the composed configuration, exactly as the
    // command derives it: a second consumer of this project and workDir takes
    // the same lock.
    const loaded = await loadConfiguration(fixture.configPath, projectConfigFile(fixture.repo));
    const namespace = projectLockNamespace(loaded.config);
    const lock = await acquireIntakeLock(workDir, namespace, () => new Date());
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
      expect(existsSync(intakeLockPath(workDir, namespace))).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('refuses the same project twice while a different project consumes the same workDir', async () => {
    const fixture = await cliFixture({ config: queueConfig });
    const root = path.dirname(fixture.configPath);
    const workDir = path.join(root, 'out');
    const otherRepo = await secondConnectedRepo(root);
    const firstNamespace = projectLockNamespace(
      (await loadConfiguration(fixture.configPath, projectConfigFile(fixture.repo))).config,
    );
    const otherNamespace = projectLockNamespace(
      (await loadConfiguration(fixture.configPath, projectConfigFile(otherRepo))).config,
    );
    expect(otherNamespace).not.toBe(firstNamespace);

    // One queue process for the first project, held open in watch mode.
    let idle: () => void = () => undefined;
    const reachedIdle = new Promise<void>((resolve) => {
      idle = resolve;
    });
    const first = invocation(fixture, (text) => {
      if (text.includes('queue idle')) idle();
    });
    const watching = runCli(
      ['queue', 'watch', '--config', fixture.configPath, '--repo', fixture.repo],
      first.context,
    );
    await reachedIdle;

    try {
      // The same connected project and the same workDir: the running queue's
      // lock refuses the second consumer before anything is read.
      const requestsBefore = fixture.requests.length;
      const same = invocation(fixture);
      const refused = await runCli(
        ['queue', 'run', '--config', fixture.configPath, '--repo', fixture.repo],
        same.context,
      );
      expect(refused).toBe(EXIT_INPUT_ERROR);
      expect(same.lines.join('\n')).toContain('another intake consumer holds');
      expect(fixture.requests).toHaveLength(requestsBefore);
      expect(fixture.turns()).toBe(0);

      // A different connected project uses the same harness configuration and
      // the same workDir, and finishes its own empty queue.
      const other = invocation(fixture);
      const otherCode = await runCli(
        ['queue', 'run', '--config', fixture.configPath, '--repo', otherRepo],
        other.context,
      );
      expect(otherCode).toBe(EXIT_OK);
      expect(other.lines.join('\n')).toContain('queue run: completed');
      expect(other.lines.join('\n')).toContain('0 ticket(s) reached the configured Done status');

      // The first queue is still the only consumer of its own project.
      expect(existsSync(intakeLockPath(workDir, firstNamespace))).toBe(true);
    } finally {
      first.interrupt();
      expect(await watching).toBe(EXIT_CANCELLED);
    }
  });
});
