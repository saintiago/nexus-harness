/**
 * The source commands through the real CLI: the coordinator, the connector and
 * the real runner, in child processes, against a fake Jira HTTP boundary and
 * stand-in runtimes. Every test here drives the real CLI, so its wall is the
 * host's wall clock; the four failing cases the file used to share with the
 * coordinator suite are gone from it, and the coordinator suite no longer pays
 * for a repository clone to test a lock.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK } from '../src/cli/context.js';
import type { CliContext, InterruptSignals } from '../src/cli/context.js';
import { readReceipt, receiptFilePath } from '../src/sources/receipts.js';
import type { EscalationTier, RunReport } from '../src/shared/types.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import {
  readWorkspaceState,
  recordWorkspaceAttempt,
  sourceItemFor,
  workspaceStatePath,
} from '../src/workspace/state.js';
import {
  fakeGhCalls,
  fakeTurns,
  installFakeGh,
  installFakeRuntime,
} from './fixtures/local-target.js';
import type { FakeGhState, FakePlan } from './fixtures/local-target.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import { SCOPE, refFor, until } from './fixtures/source.js';
import {
  createTempDir,
  documentedHarnessConfig,
  fakeConsole,
  latestHistorySnapshot,
  screenAfter,
  writeJsonFile,
} from './support.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';

useFixtureLifecycle();

// ---------------------------------------------------------------------------
// The CLI, the coordinator, the connector, and the real runner
// ---------------------------------------------------------------------------

interface FakeIssue {
  readonly id: string;
  /** The display key; a site can rename an issue, and its id stays the same. */
  key: string;
  readonly summary: string;
  status: string;
  updated: string;
  /** The labels the site holds; the queue label is added when the site is built. */
  labels?: string[];
}

interface FakeJira {
  readonly fetch: typeof fetch;
  readonly calls: Array<{ method: string; url: string; body: unknown }>;
  readonly comments: string[];
  /** The issue thread as the site holds it: what the harness posted, plus seeds. */
  readonly thread: Array<{
    readonly id: string;
    readonly author: { readonly displayName: string };
    readonly created: string;
    readonly body: unknown;
  }>;
  readonly issues: FakeIssue[];
}

function jiraDocument(): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Write the marker file the issue asks for.' }],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Acceptance criteria' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'The marker file exists.' }] },
            ],
          },
        ],
      },
    ],
  };
}

/** A Jira site in memory: search, reads, transitions, and comments. */
function fakeJira(issues: FakeIssue[]): FakeJira {
  const calls: FakeJira['calls'] = [];
  const comments: string[] = [];
  const thread: FakeJira['thread'] = [];
  const transitionsFrom = (status: string): Array<Record<string, unknown>> => {
    if (status === 'To Do') {
      // Both the claim and the refusal move an issue out of the ready status: a
      // refusal publishes its reason and takes the issue straight to review.
      return [
        { id: '11', name: 'Start work', to: { name: 'In Progress' } },
        { id: '21', name: 'Take out of the queue', to: { name: 'In Review' } },
      ];
    }
    if (status === 'In Progress') {
      return [{ id: '31', name: 'Send for review', to: { name: 'In Review' } }];
    }
    return [];
  };

  const jsonResponse = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** The labels the site holds for one issue; every issue carries the queue label. */
  const labelsOf = (issue: FakeIssue): string[] => {
    issue.labels ??= ['harness-task'];
    return issue.labels;
  };

  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? 'GET';
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, url, body });

    if (url.endsWith('/search/jql')) {
      const eligible = issues.filter((issue) => issue.status === 'To Do');
      return jsonResponse({
        issues: eligible.map((issue) => ({
          id: issue.id,
          key: issue.key,
          fields: {
            summary: issue.summary,
            status: { name: issue.status },
            labels: labelsOf(issue),
            project: { key: 'SAM1' },
            issuetype: { name: 'Task' },
            updated: issue.updated,
          },
        })),
        isLast: true,
      });
    }

    const issueMatch = /\/issue\/(\d+)(?:[/?]|$)/.exec(url);
    const issue = issues.find((candidate) => candidate.id === issueMatch?.[1]);
    if (issueMatch !== null && url.includes('/transitions')) {
      if (method === 'POST') {
        const wanted = (body?.['transition'] as { id?: string } | undefined)?.id;
        const chosen = transitionsFrom(issue?.status ?? '').find(
          (transition) => transition['id'] === wanted,
        );
        if (issue !== undefined && chosen !== undefined) {
          issue.status = String((chosen['to'] as { name: string }).name);
        }
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ transitions: transitionsFrom(issue?.status ?? '') });
    }
    if (issueMatch !== null && url.includes('/comment')) {
      if (method === 'GET') {
        // The connector reads the issue's thread before every attempt; what this
        // site holds is what the harness itself posted, in order.
        return jsonResponse({ comments: thread, total: thread.length });
      }
      comments.push(JSON.stringify(body?.['body']));
      const id = `comment-${String(comments.length)}`;
      thread.push({
        id,
        author: { displayName: 'Harness' },
        // Stamped on this process's own clock, one second apart, so the moment a
        // comment was posted is later than the ledger entry of the attempt that
        // ended just before it: a later attempt asking for what was added since
        // then really sees the harness's own comment for the attempt before it.
        created: new Date(Date.now() + thread.length * 1000).toISOString(),
        body: body?.['body'] ?? null,
      });
      return jsonResponse({ id });
    }
    if (issueMatch !== null && method === 'PUT' && issue !== undefined) {
      // The only write the connector makes to an issue is the pointer label.
      const update = body?.['update'] as { labels?: Array<{ add?: string }> } | undefined;
      for (const change of update?.labels ?? []) {
        const add = change.add;
        if (typeof add === 'string' && !labelsOf(issue).includes(add)) {
          labelsOf(issue).push(add);
        }
      }
      return new Response(null, { status: 204 });
    }
    if (issue !== undefined) {
      return jsonResponse({
        id: issue.id,
        key: issue.key,
        fields: {
          summary: issue.summary,
          description: jiraDocument(),
          status: { name: issue.status },
          labels: labelsOf(issue),
          project: { key: 'SAM1' },
          issuetype: { name: 'Task' },
          updated: issue.updated,
        },
      });
    }
    return jsonResponse({ errorMessages: ['not found'] }, 404);
  };

  return { fetch: impl as unknown as typeof fetch, calls, comments, thread, issues };
}

interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

let fixtureEnvironment: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  fixtureEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Nexus Source Test',
    GIT_AUTHOR_EMAIL: 'source@example.test',
    GIT_COMMITTER_NAME: 'Nexus Source Test',
    GIT_COMMITTER_EMAIL: 'source@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
});

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: fixtureEnvironment, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function gitOrFail(args: readonly string[], cwd: string): Promise<void> {
  const result = await runProcess('git', args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

/** A clean repository with one commit and a config that points at a Jira queue. */
async function createTarget(
  options: {
    readonly delivery?: boolean;
    /** Commit a check that is green until the marker file holds anything else. */
    readonly markerCheck?: boolean;
    /** The escalation ladder the configuration declares, when a test wants one. */
    readonly escalation?: readonly EscalationTier[];
    /** The intake order the source configuration selects; the default when omitted. */
    readonly ordering?: 'priority' | 'rank';
  } = {},
): Promise<{
  directory: string;
  repo: string;
  configPath: string;
  workDir: string;
}> {
  const directory = await createTempDir();
  const repo = path.join(directory, 'target-project');
  await mkdir(repo, { recursive: true });
  // The target project's bytes are what this fixture writes, on any host: the
  // harness's own Git invocations inherit this machine's system configuration,
  // which rewrites line endings at checkout, while the fixture's do not, so
  // without this a committed file would read as modified after a checkout the
  // harness made (tests/runner.test.ts commits the same file for the same
  // reason).
  await writeFile(path.join(repo, '.gitattributes'), '* -text\n', 'utf8');
  await writeFile(path.join(repo, 'README.md'), '# target\n', 'utf8');
  if (options.markerCheck === true) {
    await mkdir(path.join(repo, 'tools'), { recursive: true });
    await writeFile(path.join(repo, 'tools', 'check.mjs'), MARKER_CHECK_SOURCE, 'utf8');
  }
  // The connected project's own configuration is committed with it: its Jira
  // queue, its check, and — when a test asks for one — its GitHub destination.
  await writeJsonFile(repo, PROJECT_CONFIG_FILE_NAME, {
    setup: [],
    checks:
      options.markerCheck === true
        ? [[process.execPath, 'tools/check.mjs']]
        : [[process.execPath, '-e', 'process.exit(0)']],
    source: {
      type: 'jira',
      siteUrl: SCOPE,
      cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
      projectKey: 'SAM1',
      ...(options.ordering === undefined ? {} : { ordering: options.ordering }),
      pollIntervalSeconds: 5,
      tokenEnv: 'JIRA_API_TOKEN',
    },
    ...(options.delivery === true
      ? {
          delivery: {
            type: 'github',
            repository: 'example-owner/example-repo',
            baseBranch: 'main',
          },
        }
      : {}),
  });
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);

  const configPath = await writeJsonFile(directory, HARNESS_CONFIG_FILE_NAME, {
    ...documentedHarnessConfig,
    workDir: './runs',
    maxRepairs: 1,
    ...(options.escalation === undefined ? {} : { escalation: options.escalation }),
  });

  return { directory, repo, configPath, workDir: path.join(directory, 'runs') };
}

/**
 * The check a ladder test's project runs: no marker file is the feature not
 * implemented yet, which is what makes the committed baseline green; the awaited
 * text is the feature done; anything else is a real failed check, in the
 * project's own runner.
 */
const MARKER_CHECK_SOURCE = [
  "import { existsSync, readFileSync } from 'node:fs';",
  '',
  "if (!existsSync('MARKER.md')) {",
  "  console.log('marker: skipped, the feature is not implemented in this working copy');",
  '} else {',
  "  const text = readFileSync('MARKER.md', 'utf8').trim();",
  "  if (text === 'done') {",
  "    console.log('marker: ok');",
  '  } else {',
  '    console.log(`marker: wrong, it holds ${JSON.stringify(text)}`);',
  '    process.exitCode = 1;',
  '  }',
  '}',
  '',
].join('\n');

/**
 * A disposable destination for the delivery step: a bare repository the branch
 * can really be pushed into, and the stand-in `gh` the pull request commands
 * resolve to.
 */
async function createDeliveryDestination(directory: string): Promise<{
  readonly remote: string;
  readonly bin: string;
  readonly state: FakeGhState;
}> {
  const remote = path.join(directory, 'delivery-origin.git');
  await gitOrFail(['init', '--quiet', '--bare', remote], directory);
  const { bin, state } = await installFakeGh(directory);
  return { remote, bin, state };
}

/**
 * Runs `body` with the stand-in `gh` first on this process's own `PATH` and told
 * which state directory it keeps. The CLI builds both the child environment and
 * (on Windows) its own executable resolution from this process, so a suite that
 * wants the stand-in has to put it there and take it away again.
 */
async function withFakeGhOnPath<T>(
  bin: string,
  state: FakeGhState,
  body: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  const previousConfig = process.env.FAKE_GH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  process.env.FAKE_GH = JSON.stringify({ stateDir: state.dir });
  try {
    return await body();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousConfig === undefined) {
      delete process.env.FAKE_GH;
    } else {
      process.env.FAKE_GH = previousConfig;
    }
  }
}

/**
 * Runs `body` with the stand-in `codex` first on this process's own `PATH` and
 * told which plans its turns follow. The CLI builds both the child environment
 * and (on Windows) its own executable resolution from this process, so a suite
 * that wants the stand-in has to put it there and take it away again.
 */
async function withFakeRuntimeOnPath<T>(
  bin: string,
  state: { readonly dir: string },
  plans: readonly FakePlan[],
  body: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  const previousConfig = process.env.FAKE_CODEX;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  process.env.FAKE_CODEX = JSON.stringify({ stateDir: state.dir, plans });
  try {
    return await body();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousConfig === undefined) {
      delete process.env.FAKE_CODEX;
    } else {
      process.env.FAKE_CODEX = previousConfig;
    }
  }
}

/** The single run directory one source batch left under a target's output. */
async function onlyRunDirectory(workDir: string): Promise<string> {
  const runs = (await readdir(path.join(workDir, 'runs'))).filter((name) =>
    name.startsWith('run-'),
  );
  expect(runs).toHaveLength(1);
  return path.join(workDir, 'runs', runs[0] ?? '');
}

/**
 * Every run's report one target's output holds, oldest attempt first. The
 * report itself says which attempt of its workspace it was, and that is what
 * orders them: a run ID carries a second-resolution timestamp plus random bits,
 * so two runs of one intake can share a second and sorting their directory
 * names is not the order the attempts happened in. The workspace a report names
 * is likewise read from the report, never guessed from the directories beside
 * it.
 */
async function reportsByAttempt(workDir: string): Promise<readonly RunReport[]> {
  const runsRoot = path.join(workDir, 'runs');
  const reports = await Promise.all(
    (await readdir(runsRoot))
      .filter((name) => name.startsWith('run-'))
      .map(
        async (name) =>
          JSON.parse(await readFile(path.join(runsRoot, name, 'result.json'), 'utf8')) as RunReport,
      ),
  );
  return reports.sort(
    (left, right) => (left.workspace.attempt ?? 0) - (right.workspace.attempt ?? 0),
  );
}

interface CliOptions {
  readonly fetch: typeof fetch;
  readonly signals?: InterruptSignals;
  readonly dependencies?: CliContext['dependencies'];
  readonly deliveryParts?: CliContext['deliveryParts'];
  /** An interactive terminal for the CLI to write to, instead of plain output. */
  readonly terminal?: CliContext['io']['terminal'];
  /** Called for every line the command prints, while it is printing. */
  readonly onOut?: (text: string) => void;
}

async function runSourceCli(
  argv: readonly string[],
  cwd: string,
  options: CliOptions,
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    cwd,
    io: {
      out: (text) => {
        out.push(text);
        options.onOut?.(text);
      },
      err: (text) => err.push(text),
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    },
    fetch: options.fetch,
  };
  if (options.signals !== undefined) {
    context.signals = options.signals;
  }
  if (options.dependencies !== undefined) {
    context.dependencies = options.dependencies;
  }
  if (options.deliveryParts !== undefined) {
    context.deliveryParts = options.deliveryParts;
  }
  const code = await runCli(argv, context);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A recorded interrupt: the handler the CLI installed, called by the test. */
function recordingSignals(): InterruptSignals & { interrupt(): void; registered(): number } {
  const handlers: Array<() => void> = [];
  return {
    onInterrupt: (handler) => {
      handlers.push(handler);
      return () => {
        handlers.splice(handlers.indexOf(handler), 1);
      };
    },
    interrupt: () => {
      for (const handler of [...handlers]) {
        handler();
      }
    },
    registered: () => handlers.length,
  };
}

// Every test in this suite drives the real CLI: real Git and child processes on
// the host, whose wall-clock cost follows the machine's load rather than any
// wait the harness itself keeps. The five-second default is a stopwatch, not an
// assertion, and a busy host can run it out without anything hanging — the
// watch tests above already take the same room for the same reason. A test that
// really hangs still fails here.
describe('the source commands through the CLI', { timeout: 20_000 }, () => {
  it('previews the queue, claims nothing, and writes nothing', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'list', '--config', target.configPath, '--project', target.repo],
        target.directory,
        { fetch: jira.fetch },
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('SAM1-11');
      expect(result.out).toContain('valid');
      expect(result.out).toContain('nothing was claimed');
      expect(
        jira.calls.every((call) => call.method === 'GET' || call.url.endsWith('/search/jql')),
      ).toBe(true);
      expect(existsSync(target.workDir)).toBe(false);
      expect(jira.issues[0]?.status).toBe('To Do');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('runs one eligible issue once, reports it, and refuses to repeat it', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const first = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(first.err).toBe('');
      expect(first.code).toBe(EXIT_OK);
      expect(first.out).toContain('source completed');
      expect(first.out).toContain('1 passed');
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: passed');

      const runs = await readdir(path.join(target.workDir, 'runs'));
      const runDir = path.join(
        target.workDir,
        'runs',
        runs.find((name) => name.startsWith('run-')) ?? '',
      );
      expect(runs.filter((name) => name.startsWith('run-'))).toHaveLength(1);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
        sourceRef?: { id: string; key: string };
      };
      expect(report.status).toBe('passed');
      expect(report.sourceRef).toMatchObject({ id: '10011', key: 'SAM1-11' });
      const snapshot = JSON.parse(
        await readFile(path.join(runDir, 'source-task.json'), 'utf8'),
      ) as {
        task: { id: string };
        source: { id: string };
      };
      expect(snapshot.task.id).toBe('SAM1-11');
      expect(snapshot.source.id).toBe('10011');

      const receiptPath = receiptFilePath(target.workDir, refFor('10011', 'SAM1-11'));
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
        runId?: string;
        feedback?: string;
      };
      expect(receipt.feedback).toBe('sent');
      expect(receipt.runId).toBe(path.basename(runDir));

      // A second scan of the same queue claimed nothing and started no run.
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('already attempted');
      expect(
        (await readdir(path.join(target.workDir, 'runs'))).filter((name) =>
          name.startsWith('run-'),
        ),
      ).toHaveLength(1);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('draws a source run’s activity in the pane, and leaves the summary behind it', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          request.onActivity?.({ kind: 'message', text: 'writing the marker' });
          request.onActivity?.({ kind: 'change', text: 'add MARKER.md' });
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const console = fakeConsole({ columns: 80, rows: 24 });

      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies, terminal: console.io.terminal },
      );

      expect(result.code).toBe(EXIT_OK);
      // The same pane the file-task command draws: what the turn reported was
      // drawn while it ran, by cursor moves over a bounded block.
      const raw = console.chunks.join('');
      expect(raw).toContain('agent: writing the marker');
      expect(raw).toContain('change: add MARKER.md');
      expect(raw).toContain('\u001b[');

      // And the batch's own summary is ordinary output, printed after the turn's
      // pane was finalized: the pane's boundary and rows stay in the timeline,
      // in order, above the batch's own lines.
      const screen = screenAfter(console.chunks);
      const shown = screen.join('\n');
      expect(shown).toMatch(
        /\d{2}:\d{2}:\d{2} ---- developer: SAM1-11 — implementation turn ----\n\d{2}:\d{2}:\d{2} agent: writing the marker\n\d{2}:\d{2}:\d{2} change: add MARKER\.md\n\d{2}:\d{2}:\d{2} implementation turn result: completed/,
      );
      // What the reservation said on the live terminal is the key and the act;
      // its receipt path and immutable ID stay in the run's own evidence.
      expect(screen.some((line) => line.endsWith(' SAM1-11: reserved; claiming'))).toBe(true);
      expect(shown).not.toContain('receipts');
      expect(shown).toMatch(/^\d{2}:\d{2}:\d{2} source completed$/m);
      expect(screen.at(-1)).toMatch(/^\d{2}:\d{2}:\d{2}\s{2,}skipped /);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('continues the workspace its pointer names when the issue is moved back, in the same clone', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      let turns = 0;
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          turns += 1;
          const file = turns === 1 ? 'MARKER.md' : 'SECOND.md';
          await writeFile(path.join(request.workspacePath, file), 'done\n', 'utf8');
          // Each attempt commits what it wrote: the next attempt continues this
          // clone, and a coding turn starts only from committed state (HARN-35).
          await gitOrFail(['add', file], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', `write ${file}`],
            request.workspacePath,
          );
          return { summary: `wrote ${file}` };
        },
      };
      const first = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );
      expect(first.code).toBe(EXIT_OK);
      const runNames = (): Promise<string[]> =>
        readdir(path.join(target.workDir, 'runs')).then((names) =>
          names.filter((name) => name.startsWith('run-')),
        );
      const [firstRun] = await runNames();

      // The run that created the workspace named it after the ticket key, so
      // retained work is recognizable without reading a label or a report, and
      // wrote the pointer label the next attempt is found by. A continuation
      // adds no second directory beside it.
      const workspaceId = 'SAM1-11';
      expect(workspaceId).toBe(jira.issues[0]?.key);
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json') && !name.endsWith('.history'),
        ),
      ).toEqual([workspaceId]);
      const ledgerPath = path.join(target.workDir, 'workspaces', `${workspaceId}.json`);
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
        workspaceId?: string;
        branch?: string;
        sourceItem?: unknown;
      };
      expect(ledger.workspaceId).toBe(workspaceId);
      expect(ledger.branch).toBe(`harness/${workspaceId}`);
      expect(ledger.sourceItem).toEqual({
        type: 'jira',
        scope: SCOPE,
        id: '10011',
        key: 'SAM1-11',
      });
      expect(jira.issues[0]?.labels).toContain(`harness-ws-${workspaceId}`);

      // The operator moves the issue back to the ready status; the pointer label
      // is still on it, so the next scan continues that clone.
      if (jira.issues[0] === undefined) {
        throw new Error('the fixture issue disappeared');
      }
      jira.issues[0].status = 'To Do';
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(second.err).toBe('');
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('1 passed');
      const secondRun = (await runNames()).find((name) => name !== firstRun);
      expect(secondRun).toBeDefined();
      const report = JSON.parse(
        await readFile(
          path.join(target.workDir, 'runs', `${secondRun ?? ''}`, 'result.json'),
          'utf8',
        ),
      ) as {
        status: string;
        workspace: { workspaceId: string; continued: boolean; attempt: number };
      };
      expect(report.status).toBe('passed');
      expect(report.workspace).toMatchObject({
        workspaceId,
        continued: true,
        attempt: 2,
      });
      // The same clone: the file the first attempt left is still there, and the
      // continuation wrote no second pointer label and created no second
      // directory for the same ticket.
      expect(existsSync(path.join(target.workDir, 'workspaces', workspaceId, 'MARKER.md'))).toBe(
        true,
      );
      expect(
        (jira.issues[0].labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual([`harness-ws-${workspaceId}`]);
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json') && !name.endsWith('.history'),
        ),
      ).toEqual([workspaceId]);
      const after = JSON.parse(await readFile(ledgerPath, 'utf8')) as { attempts?: unknown[] };
      expect(after.attempts).toHaveLength(2);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('returns a continued workspace to its recorded branch before the next coding turn', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const starts: string[] = [];
      let firstTurn = true;
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          starts.push(
            (
              await runProcess(
                'git',
                ['symbolic-ref', '--quiet', '--short', 'HEAD'],
                request.workspacePath,
              )
            ).stdout.trim(),
          );
          if (firstTurn) {
            // The first attempt commits on a branch of its own and leaves the
            // checkout there, so the workspace it leaves behind is on a clean
            // branch that descends from the recorded one (HARN-35).
            firstTurn = false;
            await gitOrFail(
              ['checkout', '--quiet', '-b', 'task/harn-35-side'],
              request.workspacePath,
            );
            await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
            await gitOrFail(['add', 'MARKER.md'], request.workspacePath);
            await gitOrFail(
              ['commit', '--quiet', '--message', 'the marker'],
              request.workspacePath,
            );
            return { summary: 'committed the marker on a branch of its own' };
          }
          await writeFile(
            path.join(request.workspacePath, 'SECOND.md'),
            'the continuation\n',
            'utf8',
          );
          return { summary: 'worked in the continued workspace' };
        },
      };
      const first = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );
      expect(first.code).toBe(EXIT_OK);

      // The operator moves the issue back to the ready status; the pointer label
      // is still on it, so the next scan continues that clone.
      if (jira.issues[0] === undefined) {
        throw new Error('the fixture issue disappeared');
      }
      jira.issues[0].status = 'To Do';
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(second.err).toBe('');
      expect(second.code).toBe(EXIT_OK);
      // Both coding turns started on the branch the workspace records, and the
      // continuation really worked in the returned checkout.
      expect(starts).toEqual(['harness/SAM1-11', 'harness/SAM1-11']);
      const workspacePath = path.join(target.workDir, 'workspaces', 'SAM1-11');
      const recorded = (
        await runProcess('git', ['rev-parse', 'refs/heads/harness/SAM1-11'], workspacePath)
      ).stdout.trim();
      const side = (
        await runProcess('git', ['rev-parse', 'refs/heads/task/harn-35-side'], workspacePath)
      ).stdout.trim();
      expect(recorded).toBe(side);
      expect(
        (
          await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath)
        ).stdout.trim(),
      ).toBe('harness/SAM1-11');
      expect(existsSync(path.join(workspacePath, 'SECOND.md'))).toBe(true);
      expect(existsSync(path.join(workspacePath, 'MARKER.md'))).toBe(true);

      // The continuation is the second attempt in the workspace's own ledger.
      const ledger = JSON.parse(
        await readFile(path.join(target.workDir, 'workspaces', 'SAM1-11.json'), 'utf8'),
      ) as { attempts?: unknown[] };
      expect(ledger.attempts).toHaveLength(2);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  }, 30_000);

  it('names a new workspace after its ticket key, and points the next attempt at it', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10023',
        key: 'SAM1-23',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      // The ticket key is what a person sees: the terminal names the workspace
      // it prepared, and the retained directory is named after the ticket.
      expect(result.out).toContain('SAM1-23');
      expect(result.out).toContain('harness/SAM1-23');
      const workspacePath = path.join(target.workDir, 'workspaces', 'SAM1-23');
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json') && !name.endsWith('.history'),
        ),
      ).toEqual(['SAM1-23']);
      // The attempt's own evidence keeps its generated run id, beside the
      // workspace rather than in its name.
      const runs = await readdir(path.join(target.workDir, 'runs'));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/^run-/);
      const report = JSON.parse(
        await readFile(path.join(target.workDir, 'runs', runs[0] ?? '', 'result.json'), 'utf8'),
      ) as RunReport;
      expect(report.workspace).toMatchObject({
        workspaceId: 'SAM1-23',
        path: workspacePath,
        branch: 'harness/SAM1-23',
        continued: false,
        attempt: 1,
      });
      // The clone really is on the branch its id names.
      expect(
        (
          await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath)
        ).stdout.trim(),
      ).toBe('harness/SAM1-23');
      // The pointer label names the same workspace, through the one mechanism
      // that already recorded it, and the ledger keeps the immutable issue id as
      // the ownership authority.
      expect(jira.issues[0]?.labels).toContain('harness-ws-SAM1-23');
      const ledger = await readWorkspaceState(target.workDir, 'SAM1-23');
      expect(ledger?.sourceItem).toEqual({
        type: 'jira',
        scope: SCOPE,
        id: '10023',
        key: 'SAM1-23',
      });
      expect(ledger?.branch).toBe('harness/SAM1-23');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('keeps the pointer-owned workspace when the ticket key changes under it', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      let turns = 0;
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          turns += 1;
          const file = turns === 1 ? 'MARKER.md' : 'SECOND.md';
          await writeFile(path.join(request.workspacePath, file), 'done\n', 'utf8');
          // Each attempt commits what it wrote: the renamed ticket continues the
          // same clone, and a coding turn starts only from committed state
          // (HARN-35).
          await gitOrFail(['add', file], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', `write ${file}`],
            request.workspacePath,
          );
          return { summary: `wrote ${file}` };
        },
      };
      const first = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );
      expect(first.code).toBe(EXIT_OK);
      expect(jira.issues[0]?.labels).toContain('harness-ws-SAM1-11');

      // The site renames the ticket. Its immutable id — the ownership authority —
      // does not change, and the pointer label still names the workspace the work
      // lives in.
      if (jira.issues[0] === undefined) {
        throw new Error('the fixture issue disappeared');
      }
      jira.issues[0].key = 'SAM1-99';
      jira.issues[0].updated = '2026-09-17T11:00:00.000Z';
      jira.issues[0].status = 'To Do';
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(second.err).toBe('');
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('1 passed');
      // The exact directory the pointer names was reopened: the new key names
      // nothing, and nothing was renamed to it.
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json') && !name.endsWith('.history'),
        ),
      ).toEqual(['SAM1-11']);
      expect(existsSync(path.join(target.workDir, 'workspaces', 'SAM1-99'))).toBe(false);
      const reports = await reportsByAttempt(target.workDir);
      expect(reports).toHaveLength(2);
      expect(reports[1]?.workspace).toMatchObject({
        workspaceId: 'SAM1-11',
        branch: 'harness/SAM1-11',
        continued: true,
        attempt: 2,
      });
      // The ledger keeps the identity it recorded when the workspace was made:
      // the display key is not rewritten, and the immutable id still matches.
      const ledger = await readWorkspaceState(target.workDir, 'SAM1-11');
      expect(ledger?.sourceItem).toEqual({
        type: 'jira',
        scope: SCOPE,
        id: '10011',
        key: 'SAM1-11',
      });
      expect(
        (jira.issues[0].labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual(['harness-ws-SAM1-11']);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('continues a run-* workspace its legacy pointer names, unchanged', async () => {
    const target = await createTarget();
    const legacyId = 'run-20260916100000-abcdef12';
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
        // The pointer an earlier, generated-name attempt wrote: it still decides
        // where this ticket's work lives.
        labels: ['harness-task', `harness-ws-${legacyId}`],
      },
    ]);
    // The workspace such an attempt left: the clone on its own branch, and the
    // ledger beside it recording that attempt.
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const legacy = await prepareWorkspace(
      await allocateRunDirectory(target.workDir, {
        kind: 'create',
        preferredWorkspaceId: legacyId,
      }),
      source,
      { deadlineMs: Date.now() + 60_000, now: () => new Date() },
      sourceItemFor(refFor('10011', 'SAM1-11')),
    );
    await recordWorkspaceAttempt(target.workDir, legacyId, {
      runId: legacyId,
      outcome: 'failed',
      reason: 'the earlier attempt ended failed',
      endedAt: '2026-09-16T10:30:00.000Z',
      reportPath: path.join(target.workDir, 'runs', legacyId, 'result.json'),
    });
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      // The legacy pointer reopened the exact directory it names; no workspace
      // was created for the ticket key, and nothing was migrated or renamed.
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json') && !name.endsWith('.history'),
        ),
      ).toEqual([legacyId]);
      expect(existsSync(path.join(target.workDir, 'workspaces', 'SAM1-11'))).toBe(false);
      // The one run of this intake wrote a report; the run directory the
      // fixture's own setup allocated kept none.
      const runNames = await readdir(path.join(target.workDir, 'runs'));
      const reportName = runNames.find((name) =>
        existsSync(path.join(target.workDir, 'runs', name, 'result.json')),
      );
      const report = JSON.parse(
        await readFile(path.join(target.workDir, 'runs', reportName ?? '', 'result.json'), 'utf8'),
      ) as RunReport;
      expect(report.workspace).toMatchObject({
        workspaceId: legacyId,
        path: legacy.workspacePath,
        branch: `harness/${legacyId}`,
        continued: true,
        attempt: 2,
      });
      expect(await readFile(path.join(legacy.workspacePath, 'MARKER.md'), 'utf8')).toBe('done\n');
      expect(
        (jira.issues[0]?.labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual([`harness-ws-${legacyId}`]);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  /**
   * The workspace a name already holds, as an earlier attempt or an operator
   * would leave it: the directory with a file in it, and — when the test asks for
   * one — the ledger beside it recording whose work it is. What a fresh claim
   * finds when the name its ticket key prefers is already taken.
   */
  async function plantWorkspace(
    workDir: string,
    workspaceId: string,
    ledger:
      | {
          readonly kind: 'yes';
          readonly sourceRoot: string;
          readonly sourceItem: unknown;
        }
      | { readonly kind: 'no' },
  ): Promise<{ readonly workspacePath: string; readonly ledgerPath: string }> {
    const workspacePath = path.join(workDir, 'workspaces', workspaceId);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, 'PRIVATE.txt'), 'earlier work\n', 'utf8');
    const ledgerPath = workspaceStatePath(workDir, workspaceId);
    if (ledger.kind === 'yes') {
      await writeFile(
        ledgerPath,
        `${JSON.stringify({
          version: 1,
          workspaceId,
          sourceRoot: ledger.sourceRoot,
          baseCommit: 'a'.repeat(40),
          branch: `harness/${workspaceId}`,
          createdAt: '2026-09-16T10:00:00.000Z',
          sourceItem: ledger.sourceItem,
          attempts: [],
        })}\n`,
        'utf8',
      );
    }
    return { workspacePath, ledgerPath };
  }

  /** What a planted workspace holds, so a test can prove a refusal touched nothing. */
  async function snapshotPlantedWorkspace(planted: {
    readonly workspacePath: string;
    readonly ledgerPath: string;
  }): Promise<{ readonly file: string; readonly ledger: string | null }> {
    return {
      file: await readFile(path.join(planted.workspacePath, 'PRIVATE.txt'), 'utf8'),
      ledger: existsSync(planted.ledgerPath) ? await readFile(planted.ledgerPath, 'utf8') : null,
    };
  }

  /** A coding turn a refusal must never reach: the item is not claimed at all. */
  const refusedTurn: CliContext['dependencies'] = {
    runAgentTurn: async () => {
      throw new Error('a refused item must not start a coding turn');
    },
  };

  it("refuses a fresh ticket whose key names another item's workspace, and touches nothing", async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', {
      kind: 'yes',
      sourceRoot: source.sourceRoot,
      sourceItem: sourceItemFor(refFor('10099', 'SAM1-99')),
    });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        {
          fetch: jira.fetch,
          dependencies: refusedTurn,
        },
      );

      // The refusal is reported on the terminal as well as in the issue's own
      // comment, and intake goes on with nothing claimed.
      expect(result.err).toContain('SAM1-11: refused');
      expect(result.err).toContain('never overwrites');
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      // The issue is told why, and what an operator can do about it.
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(1);
      const refusal = jira.comments[0] ?? '';
      expect(refusal).toContain('SAM1-11');
      expect(refusal).toContain('SAM1-99');
      expect(refusal).toContain('never overwrites');
      expect(refusal).toContain('move it aside');
      // Nothing was claimed, no run was created, no pointer label was written,
      // and the other item's workspace is exactly as it was.
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
      expect(jira.issues[0]?.labels).toEqual(['harness-task']);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('refuses a fresh ticket whose key names a directory with no ledger', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', { kind: 'no' });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies: refusedTurn },
      );

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      expect(jira.issues[0]?.status).toBe('In Review');
      const refusal = jira.comments[0] ?? '';
      // Missing trustworthy ownership: the harness cannot tell whose work it is,
      // so it neither adopts it nor overwrites it, and says how to proceed.
      expect(refusal).toContain('no ledger');
      expect(refusal).toContain('harness-ws-SAM1-11');
      expect(refusal).toContain('move it aside');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
      expect(existsSync(planted.ledgerPath)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('refuses a fresh ticket whose key names a ledger with no item identity', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', {
      kind: 'yes',
      sourceRoot: source.sourceRoot,
      sourceItem: null,
    });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies: refusedTurn },
      );

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      const refusal = jira.comments[0] ?? '';
      expect(refusal).toContain('no source item identity');
      expect(refusal).toContain('never adopts or migrates a workspace on its own');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it("refuses to adopt a fresh ticket's own workspace, with no pointer saying so", async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', {
      kind: 'yes',
      sourceRoot: source.sourceRoot,
      sourceItem: sourceItemFor(refFor('10011', 'SAM1-11')),
    });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies: refusedTurn },
      );

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      const refusal = jira.comments[0] ?? '';
      // The workspace is this item's, but nothing points at it: adoption is the
      // operator's deliberate step, and the refusal names the exact label.
      expect(refusal).toContain('its ledger records that it is this item');
      expect(refusal).toContain('never adopts a workspace on its own');
      expect(refusal).toContain('harness-ws-SAM1-11');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
      expect(jira.issues[0]?.labels).toEqual(['harness-task']);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('runs one attempt per ladder tier in the same workspace, keeping the issue running until the end', async () => {
    const ladder: readonly EscalationTier[] = [
      {
        name: 'flash',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
        // The requested Flash allowance: an implementation turn plus two
        // repairs. The first rung spends all three of its own turns before the
        // ladder climbs.
        maxRepairs: 2,
      },
      {
        name: 'astra',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-astra', '--model', 'gpt-6-astra'],
        },
        maxRepairs: 2,
      },
    ];
    const target = await createTarget({ markerCheck: true, escalation: ladder });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Write the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const runtime = await installFakeRuntime(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';
    /** The issue's status as the climb moved on, read while the ladder was running. */
    const statusWhenEscalating: string[] = [];

    try {
      const result = await withFakeRuntimeOnPath(
        runtime.bin,
        runtime.state,
        [
          // The flash attempt: an implementation turn and both repair turns its
          // allowance allows, every round red, so the allowance is spent on
          // ordinary failed checks and the ladder climbs. Every turn commits what
          // it leaves — a coding turn starts only from committed state (HARN-35)
          // — and the notes file is work nothing later touches, so the stronger
          // attempt really inherits the weaker one's committed working copy.
          {
            edits: [
              { file: 'MARKER.md', text: 'not yet\n' },
              { file: 'NOTES.md', text: 'flash was here\n' },
            ],
            commit: 'flash: the first try, committed',
            summary: 'flash: first try',
          },
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            commit: 'flash: the first repair, still wrong',
            summary: 'flash: first repair, still wrong',
          },
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            commit: 'flash: the second repair, still wrong',
            summary: 'flash: second repair, still wrong',
          },
          // The astra attempt continues the same clone and finishes it.
          { edits: [{ file: 'MARKER.md', text: 'done\n' }], summary: 'astra: finished the marker' },
        ],
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              onOut: (text) => {
                if (text.includes('escalating to tier')) {
                  statusWhenEscalating.push(jira.issues[0]?.status ?? 'gone');
                }
              },
            },
          ),
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('source completed');
      expect(result.out).toContain('1 passed');
      // The tier each attempt reports is the launch that ran it: flash's
      // implementation and both repairs, then astra.
      expect(result.out).toContain('(attempt 1 of 2, tier flash)');
      expect(result.out).toContain('escalating to tier astra (attempt 2 of 2)');
      expect(result.out).toContain('(attempt 2 of 2, tier astra)');

      // Four real runtime invocations: flash's implementation and its two
      // allowed repairs, then astra's implementation. What was really launched
      // is the tier's own prefix, and it is the prefix each run's report records
      // — every attempt, the continuation included.
      const turns = await fakeTurns(runtime.state);
      expect(turns).toHaveLength(4);
      const flashPrefix = ['--profile', 'nexus-flash', '--model', 'deepseek-flash'];
      const astraPrefix = ['--profile', 'nexus-astra', '--model', 'gpt-6-astra'];
      expect(turns[0]?.argv.slice(0, flashPrefix.length)).toEqual(flashPrefix);
      expect(turns[1]?.argv.slice(0, flashPrefix.length)).toEqual(flashPrefix);
      expect(turns[2]?.argv.slice(0, flashPrefix.length)).toEqual(flashPrefix);
      expect(turns[3]?.argv.slice(0, astraPrefix.length)).toEqual(astraPrefix);
      expect(turns[3]?.argv.slice(astraPrefix.length)).toEqual([
        '--ask-for-approval',
        'never',
        'exec',
        '--sandbox',
        'danger-full-access',
        '--json',
        '-',
      ]);

      // Each attempt is its own run with its own report: the launch that ran it,
      // and the repair turns its own allowance let it spend. The reports are
      // ordered by the attempt each one records, and the workspace is read from
      // the report rather than from the directory listing: a continuation's own
      // run allocates a workspace directory the run never uses.
      const reports = await reportsByAttempt(target.workDir);
      expect(reports).toHaveLength(2);
      const [flash, astra] = reports;
      expect(flash?.status).toBe('failed');
      expect(flash?.repairsUsed).toBe(2);
      expect(flash?.agent.command).toEqual([
        'codex',
        '--profile',
        'nexus-flash',
        '--model',
        'deepseek-flash',
      ]);
      expect(astra?.status).toBe('passed');
      expect(astra?.repairsUsed).toBe(0);
      expect(astra?.agent.command).toEqual([
        'codex',
        '--profile',
        'nexus-astra',
        '--model',
        'gpt-6-astra',
      ]);
      expect(astra?.workspace.continued).toBe(true);
      expect(astra?.workspace.attempt).toBe(2);
      expect(reports.map((report) => report.workspace.attempt)).toEqual([1, 2]);
      // One workspace holds both attempts, named after the ticket key: the
      // continuation adds no directory of its own beside the clone it reopened.
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json') && !name.endsWith('.history'),
        ),
      ).toEqual(['SAM1-11']);
      // The pointer label records the workspace the reports name, and every turn
      // really worked in it.
      const workspaceId = astra?.workspace.workspaceId ?? '';
      const workspacePath = astra?.workspace.path ?? '';
      expect(workspaceId).toBe('SAM1-11');
      expect(flash?.workspace.workspaceId).toBe(workspaceId);
      expect(
        (jira.issues[0]?.labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual([`harness-ws-${workspaceId}`]);
      expect(new Set(turns.map((turn) => turn.cwd))).toEqual(new Set([workspacePath]));
      // The workspace the flash attempt left is the one astra worked in: the file
      // nobody touched afterwards is still there, and astra's own report sees it
      // as part of the whole diff against the recorded base.
      expect(existsSync(path.join(workspacePath, 'NOTES.md'))).toBe(true);
      expect(astra?.changes.paths.map((entry) => entry.path)).toContain('NOTES.md');
      // Both attempts are recorded against that one workspace's ledger, with the
      // tier that ran each of them.
      const ladderLedger = JSON.parse(
        await readFile(path.join(target.workDir, 'workspaces', `${workspaceId}.json`), 'utf8'),
      ) as { attempts?: Array<{ tier?: string; outcome?: string }> };
      expect(ladderLedger.attempts?.map((attempt) => [attempt.tier, attempt.outcome])).toEqual([
        ['flash', 'failed'],
        ['astra', 'passed'],
      ]);

      // The stronger attempt is told what the weaker one did through the one
      // identified history snapshot a developer turn is handed (HARN-41): the
      // ledger keeps the tier that ran each attempt (asserted above), and the
      // comment the harness published for the weaker attempt before the next
      // rung ran is part of the snapshot. The intake's own excerpts are not
      // replayed beside it (docs/spec.md §11).
      const strongerPrompt = turns[3]?.prompt ?? '';
      const strongerSnapshot = await latestHistorySnapshot(target.workDir, workspaceId);
      expect(strongerPrompt).toContain(strongerSnapshot.dir);
      // The weaker attempt's complete report is what the stronger one reads:
      // its outcome, and every turn it spent before its allowance ran out.
      const weakerAttempt = strongerSnapshot.index.entries.find(
        (entry) => entry.kind === 'developer-report',
      );
      expect(weakerAttempt?.text).toContain('Outcome: failed');
      expect(weakerAttempt?.text).toContain('flash: second repair, still wrong');
      // The comment the harness published for it is the report's own rendering,
      // recognised rather than duplicated beside it.
      expect(strongerSnapshot.index.mirrors.map((mirror) => mirror.ofEntryId)).toContain(
        weakerAttempt?.id,
      );

      // Jira: one comment per attempt, the issue still in the running status when
      // the climb moved on, and exactly one move to review, after both comments.
      expect(statusWhenEscalating).toEqual(['In Progress']);
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(2);
      expect(jira.comments[0]).toContain('finished: failed');
      expect(jira.comments[0]).toContain('Attempt 1 of 2 (tier flash)');
      // The flash comment names the repair allowance the first rung really spent.
      expect(jira.comments[0]).toContain('Repairs used: 2');
      expect(jira.comments[0]).toContain('still climbing its escalation ladder');
      expect(jira.comments[1]).toContain('finished: passed');
      expect(jira.comments[1]).toContain('Attempt 2 of 2 (tier astra)');
      const transitions = jira.calls.filter(
        (call) => call.method === 'POST' && call.url.includes('/transitions'),
      );
      expect(transitions).toHaveLength(2);
      expect(transitions[0]?.body).toMatchObject({ transition: { id: '11' } });
      expect(transitions[1]?.body).toMatchObject({ transition: { id: '31' } });
      const lastTransition = jira.calls.findLastIndex(
        (call) => call.method === 'POST' && call.url.includes('/transitions'),
      );
      const commentPosts = jira.calls
        .map((call, index) => ({ call, index }))
        .filter(({ call }) => call.method === 'POST' && call.url.includes('/comment'))
        .map(({ index }) => index);
      expect(commentPosts).toHaveLength(2);
      expect(commentPosts[1] ?? -1).toBeLessThan(lastTransition);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  // Five real coding turns — each with its own baseline, post-turn check round,
  // and the Git step that returns the checkout to its recorded branch — need
  // more than the default five seconds on a busy host.
  it('restarts a re-armed continuation at the first tier, keeping its workspace and its history', async () => {
    const ladder: readonly EscalationTier[] = [
      {
        name: 'flash',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
        maxRepairs: 1,
      },
      {
        name: 'astra',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-astra', '--model', 'gpt-6-astra'],
        },
        maxRepairs: 1,
      },
    ];
    const target = await createTarget({ markerCheck: true, escalation: ladder });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Write the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const runtime = await installFakeRuntime(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const argv = ['source', 'run', '--repo', target.repo, '--config', target.configPath];
      const run = await withFakeRuntimeOnPath(
        runtime.bin,
        runtime.state,
        [
          // The first intake spends the whole ladder without fixing the check:
          // flash's two turns, then astra's two. Each turn commits what it
          // leaves, because the turn that follows it — a repair, or the next
          // rung, or the next cycle — starts only from committed state (HARN-35).
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            commit: 'flash: first try',
            summary: 'flash: first try',
          },
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            commit: 'flash: still wrong',
            summary: 'flash: still wrong',
          },
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            commit: 'astra: first try',
            summary: 'astra: first try',
          },
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            commit: 'astra: still wrong',
            summary: 'astra: still wrong',
          },
          // The re-armed issue is a new coding cycle, so it starts at the first
          // tier again — in the same retained workspace, with everything the
          // earlier cycles left in it.
          { edits: [{ file: 'MARKER.md', text: 'done\n' }], summary: 'flash: finished it' },
        ],
        async () => {
          const first = await runSourceCli(argv, target.directory, { fetch: jira.fetch });
          expect(first.code).toBe(EXIT_INPUT_ERROR);
          expect(jira.issues[0]?.status).toBe('In Review');

          // The operator puts the issue back to work; its pointer label still
          // names the workspace, so the next intake continues it — and because
          // escalation is local to one coding cycle, that cycle starts at its
          // first tier again: Flash, in the same clone.
          if (jira.issues[0] === undefined) {
            throw new Error('the fixture issue disappeared');
          }
          jira.issues[0].status = 'To Do';
          const second = await runSourceCli(argv, target.directory, { fetch: jira.fetch });
          return { first, second };
        },
      );

      expect(run.second.err).toBe('');
      expect(run.second.code).toBe(EXIT_OK);
      expect(run.second.out).toContain('1 passed');
      // One attempt was made, in the same workspace, by the first tier of the
      // new cycle: the weaker launch really ran, not the rung the workspace's
      // attempt count would have mapped to.
      const turns = await fakeTurns(runtime.state);
      expect(turns).toHaveLength(5);
      expect(turns[4]?.argv.slice(0, 2)).toEqual(['--profile', 'nexus-flash']);
      // The new cycle's attempt is told what the earlier cycles did and what the
      // item's own thread said since through the identified history snapshot it
      // is handed (HARN-41): the ledger keeps every attempt and its tier, and
      // the harness's own comment for each spent rung is part of the snapshot.
      // The intake's own excerpts are not replayed beside it (docs/spec.md §11).
      const prompt = turns[4]?.prompt ?? '';
      const snapshot = await latestHistorySnapshot(target.workDir, 'SAM1-11');
      expect(prompt).toContain(snapshot.dir);
      // Both earlier cycles are what the snapshot holds: one complete report per
      // attempt, and each of the two comments the harness published for them
      // authenticated as that report's own rendering.
      const earlier = snapshot.index.entries.filter((entry) => entry.kind === 'developer-report');
      expect(earlier).toHaveLength(2);
      expect(earlier.every((entry) => entry.text.includes('Outcome: failed'))).toBe(true);
      expect(snapshot.index.mirrors.map((mirror) => mirror.ofEntryId)).toEqual(
        earlier.map((entry) => entry.id),
      );
      // The reports are ordered by the attempt each one records, not by their
      // directory names: run IDs have second resolution, so two runs of one
      // intake can share a second and sorting the names could reverse them.
      // The workspace attempt history is truthful and separate from the cycle's
      // own escalation index: the re-armed attempt is attempt 3 of the
      // workspace, and its report records that, while the ladder it climbed
      // started at its first rung.
      const reports = await reportsByAttempt(target.workDir);
      expect(reports.map((report) => report.status)).toEqual(['failed', 'failed', 'passed']);
      expect(reports.map((report) => report.workspace.attempt)).toEqual([1, 2, 3]);
      expect(new Set(reports.map((report) => report.workspace.workspaceId)).size).toBe(1);
      const continued = reports[2];
      expect(continued?.agent.command).toEqual([
        'codex',
        '--profile',
        'nexus-flash',
        '--model',
        'deepseek-flash',
      ]);
      expect(continued?.workspace.continued).toBe(true);
      expect(continued?.workspace.attempt).toBe(3);
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(3);
      expect(jira.comments[2]).toContain('finished: passed');
      // The comment names the rung of the cycle it ran in, while the run's
      // report and the ledger keep the workspace's own attempt count.
      expect(jira.comments[2]).toContain('Attempt 1 of 2 (tier flash)');
      // The ledger keeps every attempt, in order, with the tier that ran it: the
      // escalation index restarted, the workspace's history did not.
      const workspaceId = continued?.workspace.workspaceId ?? '';
      const ledger = JSON.parse(
        await readFile(path.join(target.workDir, 'workspaces', `${workspaceId}.json`), 'utf8'),
      ) as { attempts?: Array<{ tier?: string; outcome?: string }> };
      expect(ledger.attempts?.map((attempt) => [attempt.tier, attempt.outcome])).toEqual([
        ['flash', 'failed'],
        ['astra', 'failed'],
        ['flash', 'passed'],
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  }, 30_000);

  it('does not spend the stronger tier on a runtime that could not finish the turn', async () => {
    const ladder: readonly EscalationTier[] = [
      {
        name: 'flash',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
        maxRepairs: 1,
      },
      {
        name: 'astra',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-astra', '--model', 'gpt-6-astra'],
        },
        maxRepairs: 1,
      },
    ];
    const target = await createTarget({ markerCheck: true, escalation: ladder });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Write the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const runtime = await installFakeRuntime(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await withFakeRuntimeOnPath(
        runtime.bin,
        runtime.state,
        // A runtime that cannot authenticate or cannot finish its turn reports a
        // failed turn and ends without the event stream a completed one has. No
        // check ran after it, so this is not an ordinary red round.
        [{ mode: 'failed', summary: 'not logged in' }],
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            { fetch: jira.fetch },
          ),
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.out).toContain('1 failed');
      // Only the first rung ran: a stronger tier would be spent on the same
      // infrastructure, not on the code.
      const turns = await fakeTurns(runtime.state);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.argv.slice(0, 2)).toEqual(['--profile', 'nexus-flash']);
      expect(result.out).not.toContain('escalating to tier');
      // The issue is told the exact outcome and moved out of the queue, so the
      // failure is visible to a human instead of sitting in the running status.
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: failed');
      expect(jira.comments[0]).toContain('the coding runtime reported that the turn failed');
      expect(jira.comments[0]).not.toContain('escalation ladder');
      expect(
        jira.calls.filter((call) => call.method === 'POST' && call.url.includes('/transitions')),
      ).toHaveLength(2);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('runs a failed attempt, reports it, and exits nonzero', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async () => {
          throw new Error('the runtime could not be started');
        },
      };
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath, '--limit', '1'],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.out).toContain('1 failed');
      // The issue still needs human attention; it is not left running, and it is
      // certainly not marked Done.
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments[0]).toContain('finished: failed');
      expect(jira.comments[0]).toContain('the runtime could not be started');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('delivers a passed attempt and puts the pull request on the issue', async () => {
    const target = await createTarget({ delivery: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          await gitOrFail(['add', '--all'], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', 'write the marker'],
            request.workspacePath,
          );
          return { summary: 'wrote and committed the marker' };
        },
      };
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      const url = 'https://github.com/example-owner/example-repo/pull/1';
      expect(result.out).toContain(`pull request created: ${url}`);

      // Jira received the link, and the issue is not represented as merged or Done.
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain(`Pull request: ${url}`);
      expect(jira.comments[0]).toContain('never marks this issue Done');
      expect(jira.issues[0]?.status).toBe('In Review');

      // The destination really holds the attempt's branch, at the commit its
      // workspace holds: the delivery pushed work, not a stale copy of it.
      const runDir = await onlyRunDirectory(target.workDir);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
        workspace: { path: string; branch: string };
      };
      expect(report.status).toBe('passed');
      const pushed = await runProcess(
        'git',
        ['--git-dir', destination.remote, 'rev-parse', `refs/heads/${report.workspace.branch}`],
        target.directory,
      );
      const local = await runProcess('git', ['rev-parse', 'HEAD'], report.workspace.path);
      expect(pushed.code).toBe(0);
      expect(pushed.stdout.trim()).toBe(local.stdout.trim());

      // GitHub was asked exactly once, and the pull request carries the issue
      // reference and the same check summary the issue's comment carries.
      const calls = await fakeGhCalls(destination.state);
      expect(calls.map((call) => call.op)).toEqual(['list', 'create']);
      expect(calls[1]?.repo).toBe('example-owner/example-repo');
      expect(calls[1]?.head).toBe(report.workspace.branch);
      expect(calls[1]?.base).toBe('main');
      expect(calls[1]?.body).toContain('SAM1-11');
      expect(calls[1]?.body).toContain('1 of 1 configured checks exited 0 (round: passed)');
      expect(existsSync(path.join(runDir, 'logs', 'delivery-pull-request-body.md'))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('refuses a passed attempt that left uncommitted work, and still tells the issue', async () => {
    const target = await createTarget({ delivery: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          // The turn passes the checks but leaves its work uncommitted.
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker without committing it' };
        },
      };
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.out).toContain('uncommitted changes');
      expect(result.out).toContain('MARKER.md');
      expect(result.out).toContain('never commits or discards');
      // The retry is an operator step with git and gh, not a return to the
      // ready status, which would start a coding run instead.
      expect(result.out).toContain('starts a new coding run');

      // The run's own evidence is a passing run, exactly as it was written.
      const runDir = await onlyRunDirectory(target.workDir);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
      };
      expect(report.status).toBe('passed');

      // The receipt carries the delivery failure into the next attempt.
      const receipt = await readReceipt(
        receiptFilePath(target.workDir, refFor('10011', 'SAM1-11')),
      );
      expect(receipt?.outcome).toBe('passed');
      expect(receipt?.problem).toContain('delivery:');
      expect(receipt?.problem).toContain('MARKER.md');

      // Nothing was pushed and GitHub was not asked, because the refusal comes
      // before the push; the issue is still told the passed outcome the run
      // produced, with the delivery failure beside it, so a passed task is not
      // left in the running status where a Jira-only coordinator cannot see it.
      expect(await fakeGhCalls(destination.state)).toEqual([]);
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: passed');
      expect(jira.comments[0]).toContain('Delivery:');
      expect(jira.comments[0]).toContain('MARKER.md');
      expect(jira.comments[0]).not.toContain('Pull request:');
      expect(jira.comments[0]).not.toContain('nor the harness pushes');
      expect(jira.issues[0]?.status).toBe('In Review');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('returns a recorded branch a turn left behind, and delivers what the checks passed', async () => {
    const target = await createTarget({ delivery: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          // Ordinary local Git use during coding: the turn commits on a branch
          // of its own and leaves the checkout there. The harness returns the
          // checkout to the branch the workspace records before the checks that
          // judge it, so the checks and the delivery are about one revision
          // (HARN-35).
          await gitOrFail(
            ['checkout', '--quiet', '-b', 'task/harn-17-marker'],
            request.workspacePath,
          );
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          await gitOrFail(['add', '--all'], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', 'write the marker'],
            request.workspacePath,
          );
          return { summary: 'wrote and committed the marker on a branch of its own' };
        },
      };
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      const runDir = await onlyRunDirectory(target.workDir);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
        workspace: { path: string; branch: string };
      };
      const validated = (
        await runProcess('git', ['rev-parse', 'HEAD'], report.workspace.path)
      ).stdout.trim();
      const recorded = (
        await runProcess(
          'git',
          ['rev-parse', `refs/heads/${report.workspace.branch}`],
          report.workspace.path,
        )
      ).stdout.trim();
      // The checkout is on the recorded branch, at the commit the turn made on
      // its own branch: the checks that passed ran on the revision delivery
      // would publish, so that is the revision it publishes (HARN-17).
      expect(report.status).toBe('passed');
      expect(recorded).toBe(validated);
      expect(
        (
          await runProcess(
            'git',
            ['symbolic-ref', '--quiet', '--short', 'HEAD'],
            report.workspace.path,
          )
        ).stdout.trim(),
      ).toBe(report.workspace.branch);

      // The branch the turn used still holds the commit it made: returning the
      // checkout to the recorded branch reset and discarded nothing.
      const taskBranch = (
        await runProcess(
          'git',
          ['rev-parse', 'refs/heads/task/harn-17-marker'],
          report.workspace.path,
        )
      ).stdout.trim();
      expect(taskBranch).toBe(validated);
      expect(
        (await runProcess('git', ['status', '--porcelain'], report.workspace.path)).stdout.trim(),
      ).toBe('');

      // The destination holds that same revision, and the issue is told the
      // passed outcome with the pull request that carries it.
      const pushed = await runProcess(
        'git',
        ['--git-dir', destination.remote, 'rev-parse', `refs/heads/${report.workspace.branch}`],
        target.directory,
      );
      expect(pushed.code).toBe(0);
      expect(pushed.stdout.trim()).toBe(validated);
      const url = 'https://github.com/example-owner/example-repo/pull/1';
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain(`pull request created: ${url}`);
      const receipt = await readReceipt(
        receiptFilePath(target.workDir, refFor('10011', 'SAM1-11')),
      );
      expect(receipt?.outcome).toBe('passed');
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: passed');
      expect(jira.comments[0]).toContain(`Pull request: ${url}`);
      expect(jira.issues[0]?.status).toBe('In Review');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  }, 30_000);

  it('stops a turn that left a dirty branch of its own, and tells the issue why', async () => {
    const target = await createTarget({ delivery: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          // The turn commits its work on a branch of its own and leaves
          // uncommitted work beside it: returning the checkout to the branch
          // the workspace records would mean switching a dirty checkout, which
          // the harness never does (HARN-35).
          await gitOrFail(
            ['checkout', '--quiet', '-b', 'task/harn-35-marker'],
            request.workspacePath,
          );
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          await gitOrFail(['add', '--all'], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', 'write the marker'],
            request.workspacePath,
          );
          await writeFile(
            path.join(request.workspacePath, 'notes.md'),
            'never committed\n',
            'utf8',
          );
          return { summary: 'left a dirty branch of its own' };
        },
      };
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      // The run stopped before any check round ran after the turn, and the
      // failure names both branches and what a person can do by hand.
      const runDir = await onlyRunDirectory(target.workDir);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
        reason: string;
        attempts: readonly { readonly checks: unknown }[];
        workspace: { path: string; branch: string };
      };
      expect(report.status).toBe('failed');
      expect(report.attempts).toHaveLength(1);
      expect(report.attempts[0]?.checks).toBeNull();
      expect(report.reason).toContain('task/harn-35-marker');
      expect(report.reason).toContain(report.workspace.branch);
      expect(report.reason).toContain('notes.md');
      expect(report.reason).toMatch(/Commit or remove those paths by hand/);
      expect(result.code).toBe(EXIT_INPUT_ERROR);

      // Nothing left the machine: no push, no pull request, and GitHub was not
      // asked anything at all.
      expect(await fakeGhCalls(destination.state)).toEqual([]);
      const pushed = await runProcess(
        'git',
        ['--git-dir', destination.remote, 'rev-parse', `refs/heads/${report.workspace.branch}`],
        target.directory,
      );
      expect(pushed.code).not.toBe(0);

      // What the turn left is kept exactly where it is: its commit on its own
      // branch, and the path it never committed.
      const head = (
        await runProcess(
          'git',
          ['symbolic-ref', '--quiet', '--short', 'HEAD'],
          report.workspace.path,
        )
      ).stdout.trim();
      expect(head).toBe('task/harn-35-marker');
      expect(await readFile(path.join(report.workspace.path, 'notes.md'), 'utf8')).toBe(
        'never committed\n',
      );

      // The issue carries the failed outcome and its reason, and a person
      // decides what happens next.
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: failed');
      expect(jira.comments[0]).toContain('task/harn-35-marker');
      expect(jira.issues[0]?.status).toBe('In Review');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  }, 30_000);

  it('refuses a continuation whose workspace still holds uncommitted work, and starts no turn', async () => {
    const target = await createTarget({ markerCheck: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      let turns = 0;
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          turns += 1;
          // The attempt writes the marker and never commits it: the round after
          // it is green — it reads what the turn left — and the working copy is
          // dirty when the run ends.
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker, and never committed it' };
        },
      };
      const first = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );
      expect(first.code).toBe(EXIT_OK);
      expect(first.out).toContain('1 passed');
      const runsDir = path.join(target.workDir, 'runs');
      const runNames = (): Promise<string[]> =>
        readdir(runsDir).then((names) => names.filter((name) => name.startsWith('run-')));
      const [firstRun] = await runNames();
      const workspacePath = path.join(target.workDir, 'workspaces', 'SAM1-11');
      expect(await readFile(path.join(workspacePath, 'MARKER.md'), 'utf8')).toBe('done\n');

      // The operator moves the issue back to the ready status, so the next scan
      // would continue that workspace. It refuses instead: a coding turn is
      // started only from the workspace's own committed state, and no turn is
      // started at all (HARN-35).
      if (jira.issues[0] === undefined) {
        throw new Error('the fixture issue disappeared');
      }
      jira.issues[0].status = 'To Do';
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(second.err).toContain('SAM1-11: refused');
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('1 refused');
      // No second run, and the only coding turn that ever ran was the first
      // attempt's: the refused continuation started none.
      expect(await runNames()).toEqual([firstRun]);
      expect(turns).toBe(1);

      // The issue is told which branch and which paths stop it, and what a
      // person can do by hand.
      expect(jira.comments).toHaveLength(2);
      const refusal = jira.comments[1] ?? '';
      expect(refusal).toContain('cannot be continued');
      expect(refusal).toContain('harness/SAM1-11');
      expect(refusal).toContain('MARKER.md');
      expect(refusal).toMatch(/Commit or remove those paths by hand/);
      expect(jira.issues[0]?.status).toBe('In Review');

      // The work is kept exactly where the attempt left it.
      expect(await readFile(path.join(workspacePath, 'MARKER.md'), 'utf8')).toBe('done\n');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  }, 30_000);

  it('keeps a passed attempt local when no delivery step is configured', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          await gitOrFail(['add', '--all'], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', 'write the marker'],
            request.workspacePath,
          );
          return { summary: 'wrote and committed the marker' };
        },
      };
      // A stand-in gh and a reachable destination are configured for the
      // delivery step that this configuration does not ask for: they stay unused.
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      expect(result.code).toBe(EXIT_OK);
      expect(await fakeGhCalls(destination.state)).toEqual([]);
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).not.toContain('Pull request:');
      expect(jira.comments[0]).toContain('nor the harness pushes');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  // One real poll interval of five seconds has to elapse, so this test is given
  // more room than the default timeout rather than a shorter interval than the
  // documented minimum.
  it(
    'watch picks up an issue made eligible later, then stops on interrupt',
    { timeout: 30_000 },
    async () => {
      const target = await createTarget();
      const jira = fakeJira([
        {
          id: '10012',
          key: 'SAM1-12',
          summary: 'A later issue',
          status: 'Blocked',
          updated: '2026-09-16T12:00:00.000Z',
        },
      ]);
      const previous = process.env.JIRA_API_TOKEN;
      process.env.JIRA_API_TOKEN = 'test-token';
      const signals = recordingSignals();

      try {
        const dependencies: CliContext['dependencies'] = {
          runAgentTurn: async (request) => {
            await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
            return { summary: 'wrote the marker' };
          },
        };
        const watching = runSourceCli(
          ['source', 'watch', '--repo', target.repo, '--config', target.configPath],
          target.directory,
          { fetch: jira.fetch, signals, dependencies },
        );

        // The first scan finds nothing; the queue becomes ready while it waits.
        await until(
          () => jira.calls.some((call) => call.url.endsWith('/search/jql')),
          'the first scan',
        );
        await until(() => signals.registered() === 1, 'the interrupt handler');
        jira.issues[0]!.status = 'To Do';

        // The poll interval is 5 seconds; the run and its feedback follow the
        // second scan. The interrupt arrives once the result was published.
        await until(() => jira.comments.length === 1, 'the result comment', 20_000);
        signals.interrupt();
        const result = await watching;

        expect(result.code).toBe(EXIT_CANCELLED);
        expect(jira.issues[0]?.status).toBe('In Review');
        expect(
          jira.calls.filter((call) => call.url.endsWith('/search/jql')).length,
        ).toBeGreaterThanOrEqual(2);
        const runs = (await readdir(path.join(target.workDir, 'runs'))).filter((name) =>
          name.startsWith('run-'),
        );
        expect(runs).toHaveLength(1);
        expect(signals.registered()).toBe(0);
      } finally {
        if (previous === undefined) {
          delete process.env.JIRA_API_TOKEN;
        } else {
          process.env.JIRA_API_TOKEN = previous;
        }
      }
    },
  );

  it('refuses a source command without a source or a token, creating nothing', async () => {
    const target = await createTarget();
    // A harness configuration with no Nexus-wide extras, composed with a
    // project that has no Jira connection of its own: nothing to take tasks
    // from, which is what the source command has to say.
    const withoutSource = await writeJsonFile(
      target.directory,
      HARNESS_CONFIG_FILE_NAME,
      documentedHarnessConfig,
    );
    const plainProject = path.join(target.directory, 'plain-project');
    await writeJsonFile(plainProject, PROJECT_CONFIG_FILE_NAME, {
      setup: [],
      checks: [['node', '-e', 'process.exit(0)']],
    });
    const previous = process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_API_TOKEN;

    try {
      const missingToken = await runSourceCli(
        ['source', 'list', '--config', target.configPath, '--project', target.repo],
        target.directory,
        { fetch: fakeJira([]).fetch },
      );
      const missingSource = await runSourceCli(
        ['source', 'list', '--config', withoutSource, '--project', plainProject],
        target.directory,
        { fetch: fakeJira([]).fetch },
      );

      expect(missingToken.code).toBe(EXIT_INPUT_ERROR);
      expect(missingToken.err).toContain('JIRA_API_TOKEN');
      expect(missingSource.code).toBe(EXIT_INPUT_ERROR);
      expect(missingSource.err).toContain('no "source" object');
      expect(existsSync(target.workDir)).toBe(false);
    } finally {
      if (previous !== undefined) {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('takes the ticket Jira’s Rank order put first, not the smallest key', async () => {
    const target = await createTarget({ ordering: 'rank' });
    const jira = fakeJira([
      {
        id: '10013',
        key: 'SAM1-13',
        summary: 'The board’s first ready ticket',
        status: 'To Do',
        updated: '2026-09-19T11:00:00.000Z',
      },
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'The board’s second ready ticket',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath, '--limit', '1'],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.code).toBe(EXIT_OK);
      // Rank mode asks Jira for the board's own order and takes the first ticket
      // of that answer as-is: the smaller key waits for a later scan instead.
      const search = jira.calls.find((call) => call.url.endsWith('/search/jql'));
      expect((search?.body as { jql: string }).jql).toContain(
        'ORDER BY Rank ASC, created ASC, key ASC',
      );
      expect(jira.issues.find((issue) => issue.status === 'In Review')?.key).toBe('SAM1-13');
      expect(jira.issues.find((issue) => issue.key === 'SAM1-11')?.status).toBe('To Do');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('returns Jira’s refusal of Rank JQL and starts no task', async () => {
    const target = await createTarget({ ordering: 'rank' });
    const calls: Array<{ readonly method: string; readonly url: string }> = [];
    const refuseRank = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ method: init.method ?? 'GET', url });
      return new Response(
        JSON.stringify({
          errorMessages: ['Field Rank does not exist or you do not have permission to view it'],
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    };
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: refuseRank as unknown as typeof fetch },
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      // The bounded answer Jira gave is reported, and nothing else happened: one
      // search was sent, no Priority scan was tried instead, no run directory or
      // workspace exists, and no issue was read, claimed, commented on, or moved.
      expect(result.out).toContain('source stopped');
      expect(result.out).toContain('discovery failed');
      expect(result.out).toContain('HTTP 400');
      expect(result.out).toContain('Field Rank does not exist');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain('/rest/api/3/search/jql');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(existsSync(path.join(target.workDir, 'workspaces'))).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });
});
