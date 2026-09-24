/**
 * Focused integration tests: the real StartRound, Develop and Verify run one development cycle over
 * a real temporary repository, real Git and Processes adapters, real round storage and the
 * producer-owned artifact declarations. The agent runtime and the Jira source are controlled, so no
 * provider, network or paid turn is involved. The review result of round 1 is supplied as the input
 * the Review action produces.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../src/agent-runtime/index.js';
import { createGitAdapter } from '../src/adapters/git.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import {
  type DevelopmentOutput,
  type FindingResponse,
} from '../src/task-engine/actions/develop/artifacts.js';
import { createDevelop } from '../src/task-engine/actions/develop/index.js';
import { reviewArtifact, type Finding } from '../src/task-engine/actions/review/artifacts.js';
import { createStartRound } from '../src/task-engine/actions/start-round/index.js';
import { createVerify } from '../src/task-engine/actions/verify/index.js';
import type { VerificationOutput } from '../src/task-engine/actions/verify/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { runnerOf } from './support/agent-runner.js';
import { scriptedJira } from './support/jira.js';

/** Git and check commands run with a supplied environment; host Git configuration is disabled. */
const environment = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Nexus Tests',
  GIT_AUTHOR_EMAIL: 'nexus@example.com',
  GIT_COMMITTER_NAME: 'Nexus Tests',
  GIT_COMMITTER_EMAIL: 'nexus@example.com',
};

const git = createGitAdapter((args, directory, onOutput) =>
  run({ executable: 'git', args, directory, environment }, onOutput),
);

let root = '';
let events: EngineEvent[] = [];
let workspaceRoot = '';
let worktree = '';
let source = '';
let selectionFile = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-development-cycle-'));
  events = [];
  const origin = path.join(root, 'origin.git');
  source = path.join(root, 'source');
  await mkdir(root, { recursive: true });
  await gitCommand(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  await gitCommand(['init', '--quiet', '--initial-branch=main', source], root);
  await writeFile(path.join(source, 'readme.md'), 'initial\n');
  await gitCommand(['add', 'readme.md'], source);
  await gitCommand(['commit', '--quiet', '--message', 'initial'], source);
  await gitCommand(['remote', 'add', 'origin', origin], source);
  await gitCommand(['push', '--quiet', 'origin', 'main'], source);
  const baseRevision = await headOf(source);

  workspaceRoot = path.join(root, 'workspace');
  worktree = path.join(workspaceRoot, 'worktree');
  await mkdir(workspaceRoot, { recursive: true });
  await gitCommand(['clone', '--quiet', origin, worktree], root);
  await gitCommand(['checkout', '--quiet', '-b', 'task/NEX-1', baseRevision], worktree);
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify(
      {
        taskKey: 'NEX-1',
        repository: origin,
        branch: 'task/NEX-1',
        baseRevision,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  selectionFile = path.join(root, 'executions', 'selection.json');
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeFile(
    selectionFile,
    `${JSON.stringify(
      {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: { id: '1', key: 'NEX-1', fields: { summary: 'Implement the feature' } },
        conversation: [],
        workspace: { root: workspaceRoot },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Decode one stream's chunks as text. */
function text(outputs: readonly ProcessOutput[], stream: ProcessOutput['stream']): string {
  const chunks = outputs.filter((output) => output.stream === stream).map((output) => output.chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run one git command as test setup and return its stdout. */
async function gitCommand(args: readonly string[], directory: string): Promise<string> {
  const outputs: ProcessOutput[] = [];
  const result = await run({ executable: 'git', args, directory, environment }, (output) => {
    outputs.push(output);
  });
  if (!result.ok || result.value.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${text(outputs, 'stderr')}`);
  }
  return text(outputs, 'stdout');
}

/** The commit a repository's HEAD points to. */
async function headOf(repository: string): Promise<string> {
  return (await gitCommand(['rev-parse', 'HEAD'], repository)).trim();
}

/** Stage every worktree change and commit it, as a completed development turn leaves it. */
async function stageAndCommit(message: string): Promise<void> {
  await gitCommand(['add', '--all'], worktree);
  await gitCommand(['commit', '--quiet', '--message', message], worktree);
}

/** Write one new file in the worktree and commit it with every other staged change. */
async function commit(name: string, content: string, message: string): Promise<void> {
  await writeFile(path.join(worktree, name), content);
  await stageAndCommit(message);
}

/** One scripted development turn: what it changes and what it reports. */
type Turn = {
  readonly findingResponses: readonly FindingResponse[];
  readonly change: () => Promise<void>;
};

/** A controlled developer runtime that performs each scripted turn in the real worktree. */
function scriptedDeveloper(turns: readonly Turn[]): {
  readonly runtime: AgentRuntime;
  readonly profiles: string[];
} {
  const profiles: string[] = [];
  const remaining = [...turns];
  return {
    profiles,
    runtime: {
      async run(profile) {
        profiles.push(profile);
        const turn = remaining.shift();
        if (turn === undefined) {
          throw new Error('The scripted developer has no turn left.');
        }
        await turn.change();
        return ok({
          output: JSON.stringify({
            status: 'completed',
            summary: 'Implemented and committed the change.',
            findingResponses: turn.findingResponses,
          }),
        });
      },
    },
  };
}

const taskIssue = {
  id: '1',
  key: 'NEX-1',
  fields: { summary: 'Implement the feature', description: { type: 'doc', content: [] } },
};

/** The action under test, bound to the real workspace and controlled agent/source. */
function actions(runtime: AgentRuntime): {
  readonly startRound: ReturnType<typeof createStartRound>;
  readonly develop: ReturnType<typeof createDevelop>;
  readonly verify: ReturnType<typeof createVerify>;
} {
  const { jira } = scriptedJira({
    readIssue: () => ok(taskIssue),
    readComments: () => ok([{ id: 'c1', body: 'Original request.' }]),
  });
  return {
    startRound: createStartRound({
      taskKey: 'NEX-1',
      workspace: { root: workspaceRoot },
      developerLadder: [
        { profile: 'dev-a', repairAllowance: 1 },
        { profile: 'dev-b', repairAllowance: 1 },
      ],
      publish: (event) => events.push(event),
    }),
    develop: createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      jira,
      publish: (event) => events.push(event),
    }),
    verify: createVerify({
      workspace: { root: workspaceRoot },
      checks: [
        {
          name: 'feature-check',
          command: { executable: 'bash', args: ['-c', '[ -f feature.txt ] && echo checked'] },
        },
      ],
      environment,
      git,
      runCommand: run,
      publish: (event) => events.push(event),
    }),
  };
}

/** Read one round artifact document. */
async function readArtifact(round: number, name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'artifacts', String(round), name), 'utf8'),
  ) as unknown;
}

/** The current round plan as StartRound recorded it. */
async function readCurrentRound(): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'state', 'current-round.json'), 'utf8'),
  ) as unknown;
}

describe('development cycle', () => {
  it('plans each round from the review rejection and the failed check', async () => {
    const finding: Finding = {
      id: 'NEX-1-finding-1',
      title: 'The feature has no regression check',
      severity: 'blocking',
      basis: 'The task requires a verified feature.',
      evidence: 'The check does not cover the feature.',
      impact: 'Regressions reach the base branch.',
      repairGuidance: 'Cover the feature with the configured check.',
      locations: [{ path: 'feature.txt', line: 1 }],
    };
    const developer = scriptedDeveloper([
      {
        findingResponses: [],
        change: () => commit('feature.txt', 'feature\n', 'add the feature'),
      },
      {
        findingResponses: [
          {
            findingId: finding.id,
            status: 'addressed',
            response: 'The feature is covered by the configured check.',
          },
        ],
        change: async () => {
          // The first repair still fails the configured check.
          await rm(path.join(worktree, 'feature.txt'));
          await writeFile(path.join(worktree, 'broken.txt'), 'broken\n');
          await stageAndCommit('attempt the repair');
        },
      },
      {
        findingResponses: [
          {
            findingId: finding.id,
            status: 'addressed',
            response: 'Restored the feature with the check passing.',
          },
        ],
        change: async () => {
          await rm(path.join(worktree, 'broken.txt'));
          await writeFile(path.join(worktree, 'feature.txt'), 'feature repaired\n');
          await stageAndCommit('restore the feature');
        },
      },
    ]);
    const cycle = actions(developer.runtime);
    const helpers = createArtifactHelpers({ root: workspaceRoot });

    // Round 1: plan, implement, verify and review the change.
    await expect(cycle.startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 1,
      profile: 'dev-a',
      reason: expect.stringContaining('initial implementation uses the first profile "dev-a"'),
    });
    await expect(cycle.develop()).resolves.toBe('completed');
    const firstDevelopment = (await readArtifact(1, 'development.json')) as DevelopmentOutput;
    await expect(cycle.verify()).resolves.toBe('passed');
    const firstVerification = (await readArtifact(1, 'verification.json')) as VerificationOutput;
    expect(firstVerification.headRevision).toBe(firstDevelopment.headRevision);
    await helpers.writeOutputArtifact(reviewArtifact, {
      profile: 'reviewer',
      headRevision: firstDevelopment.headRevision,
      verdict: 'changesRequested',
      summary: 'The regression check must cover the feature.',
      findings: [finding],
      priorFindings: [],
    });

    // Round 2: the review requested changes, so the round policy continues the initial profile.
    await expect(cycle.startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 2,
      profile: 'dev-a',
      reason: expect.stringContaining('continues with the initial profile "dev-a"'),
    });

    // The repair answers the review's finding but fails the configured check.
    await expect(cycle.develop()).resolves.toBe('completed');
    expect((await readArtifact(2, 'development.json')) as DevelopmentOutput).toMatchObject({
      profile: 'dev-a',
      findingResponses: [{ findingId: finding.id, status: 'addressed' }],
    });
    await expect(cycle.verify()).resolves.toBe('failed');
    expect((await readArtifact(2, 'verification.json')) as VerificationOutput).toMatchObject({
      status: 'failed',
      checks: [{ name: 'feature-check', exitCode: 1 }],
    });

    // The executed repair turn used "dev-a"'s allowance; the failed check advances to "dev-b".
    await expect(cycle.startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 3,
      profile: 'dev-b',
      reason: expect.stringContaining('advances to profile "dev-b"'),
    });

    // Round 3: the escalated profile repairs the change and passes verification.
    await expect(cycle.develop()).resolves.toBe('completed');
    expect((await readArtifact(3, 'development.json')) as DevelopmentOutput).toMatchObject({
      profile: 'dev-b',
      status: 'completed',
    });
    await expect(cycle.verify()).resolves.toBe('passed');

    expect(developer.profiles).toEqual(['dev-a', 'dev-a', 'dev-b']);
    expect(await headOf(worktree)).toBe(
      ((await readArtifact(3, 'development.json')) as DevelopmentOutput).headRevision,
    );
    // Each round's check output is preserved under that round's own directory.
    expect(
      await readFile(
        path.join(workspaceRoot, 'artifacts', '2', 'checks', '0', 'stdout.log'),
        'utf8',
      ),
    ).toBe('');
    expect(
      await readFile(
        path.join(workspaceRoot, 'artifacts', '3', 'checks', '0', 'stdout.log'),
        'utf8',
      ),
    ).toBe('checked\n');
  });
});
