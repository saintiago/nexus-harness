/**
 * The review-to-completion path through the built CLI: the reviewer credential
 * is resolved from the environment variable the configuration names, the pass
 * runs after a batch through the operator's own GitHub credential, and a missing
 * reviewer credential is an input error before anything is armed.
 *
 * Nothing here contacts GitHub or Jira: the stand-in `gh` is a real program on
 * the command line the completion step runs, and the fake HTTP boundary answers
 * Jira's REST API. The coding runtime is never started, because the batch is
 * empty — the completion pass is the only thing this test exercises.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { CliContext } from '../src/cli/context.js';
import { EXIT_INPUT_ERROR, EXIT_OK } from '../src/cli/context.js';
import { fakeCompletionCalls, installFakeGhCompletion } from './fixtures/local-target.js';
import type { FakeCompletionState } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir, fakeConsole } from './support.js';

afterEach(cleanupTempDirectories);

const REVIEWER_TOKEN = 'nexus-lens-reviewer-token';
const OPERATOR_TOKEN = 'operator-github-token';

/** A repository the source preflight accepts: a clean checkout with a commit. */
async function createRepo(parent: string): Promise<string> {
  const repo = path.join(parent, 'target');
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# target\n', 'utf8');
  const { spawnSync } = await import('node:child_process');
  const run = (args: readonly string[]): void => {
    const result = spawnSync('git', [...args], { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  };
  run(['init', '--quiet', '--initial-branch=main']);
  run(['add', '--all']);
  run([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@local',
    'commit',
    '--quiet',
    '-m',
    'baseline',
  ]);
  return repo;
}

/** A Jira boundary that answers every search with an empty page. */
function emptyJira(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ issues: [], isLast: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

interface CliFixture {
  readonly parent: string;
  readonly repo: string;
  readonly configPath: string;
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly gh: FakeCompletionState;
}

async function createFixture(
  options: { readonly reviewerToken?: boolean } = {},
): Promise<CliFixture> {
  const parent = await createTempDir();
  const repo = await createRepo(parent);
  const workDir = path.join(parent, 'harness');
  const gh = await installFakeGhCompletion(parent);

  const configPath = path.join(parent, 'harness.config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        workDir,
        maxRepairs: 0,
        taskTimeoutMinutes: 5,
        commandTimeoutMinutes: 1,
        setup: [],
        checks: [['node', '-e', 'process.exit(0)']],
        source: {
          type: 'jira',
          siteUrl: 'https://example.atlassian.net',
          cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
          projectKey: 'HARN',
          tokenEnv: 'JIRA_API_TOKEN',
        },
        delivery: {
          type: 'github',
          repository: 'saintiago/nexus-harness',
          baseBranch: 'main',
          completion: {
            lensApp: 'nexus-lens',
            lensCheckName: 'Nexus Lens',
            reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
            postMergeWorkflows: ['ci.yml'],
            toDoStatus: 'To Do',
            doneStatus: 'Done',
            pollIntervalSeconds: 5,
            deadlineSeconds: 30,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.dirname(gh.command)}${path.delimiter}${process.env.PATH ?? ''}`,
    JIRA_API_TOKEN: 'jira-service-account-token',
    GH_TOKEN: OPERATOR_TOKEN,
    FAKE_GH: JSON.stringify({ stateDir: gh.dir, token: OPERATOR_TOKEN }),
  };
  delete env['NEXUS_LENS_TOKEN'];
  if (options.reviewerToken !== false) {
    env['NEXUS_LENS_TOKEN'] = REVIEWER_TOKEN;
  }

  return { parent, repo, configPath, workDir, env, gh };
}

/** The CLI context one invocation uses: a recorder, and the fake Jira boundary. */
function contextFor(io: ReturnType<typeof fakeConsole>): CliContext {
  return {
    cwd: process.cwd(),
    io: io.io,
    fetch: emptyJira(),
    completionParts: { command: 'gh' },
  };
}

describe('the completion path through the CLI', () => {
  it('reports the completion pass and makes no reviewer-authenticated write', async () => {
    const fixture = await createFixture();
    const io = fakeConsole();

    const previous = process.env;
    process.env = { ...previous, ...fixture.env };
    try {
      const code = await runCli(
        ['source', 'run', '--repo', fixture.repo, '--config', fixture.configPath],
        { ...contextFor(io), cwd: fixture.parent },
      );

      expect(code).toBe(EXIT_OK);
      const output = io.chunks.join('');
      expect(output).toContain('completed  0 finished with a verified merge');
      // The batch found no eligible issue and the completion pass found no In
      // Review item, so only the Jira search ran: nothing was armed or written.
      expect(output).not.toContain('auto-merge enabled');
      expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    } finally {
      process.env = previous;
    }
  });

  it('refuses a configuration whose reviewer credential is not in the environment', async () => {
    const fixture = await createFixture({ reviewerToken: false });
    const io = fakeConsole();

    const previous = process.env;
    process.env = { ...previous, ...fixture.env };
    try {
      const code = await runCli(
        ['source', 'run', '--repo', fixture.repo, '--config', fixture.configPath],
        { ...contextFor(io), cwd: fixture.parent },
      );

      expect(code).toBe(EXIT_INPUT_ERROR);
      const output = io.chunks.join('');
      expect(output).toContain('the environment variable NEXUS_LENS_TOKEN is missing or blank');
      expect(output).not.toContain(OPERATOR_TOKEN);
      expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    } finally {
      process.env = previous;
    }
  });
});
