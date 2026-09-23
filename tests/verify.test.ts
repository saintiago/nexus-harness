/**
 * Component tests: the real Verify executes the configured checks, preserves their output and
 * records the revision it checked over real temporary storage. Repository observations and command
 * results are controlled; no live service or paid work is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitAdapter } from '../src/adapters/git.js';
import type { ProcessCommand } from '../src/adapters/processes.js';
import type { Command } from '../src/configuration/index.js';
import { fault, ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { devArtifact } from '../src/task-engine/actions/develop/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import {
  createVerify,
  type CommandExecution,
  type VerifySettings,
} from '../src/task-engine/actions/verify/index.js';
import { repositoryState, scriptedGit } from './support/git.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);
const otherRevision = '3'.repeat(40);

const environment = { PATH: '/usr/bin', NEXUS_TEST: 'verify' };

let root = '';
let events: EngineEvent[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-verify-'));
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One scripted command result, with the output it streams before exiting. */
type ScriptedCheck = {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly fault?: string;
};

/** A command capability that answers from the script and records the commands it received. */
function scriptedRunCommand(checks: readonly ScriptedCheck[]): {
  readonly runCommand: CommandExecution;
  readonly calls: ProcessCommand[];
} {
  const calls: ProcessCommand[] = [];
  let index = 0;
  return {
    calls,
    async runCommand(command, onOutput) {
      calls.push(command);
      const check = checks[Math.min(index, checks.length - 1)];
      index += 1;
      if (check === undefined) {
        throw new Error('No scripted check result remains.');
      }
      if (check.stdout !== undefined) {
        onOutput({ stream: 'stdout', chunk: Buffer.from(check.stdout) });
      }
      if (check.stderr !== undefined) {
        onOutput({ stream: 'stderr', chunk: Buffer.from(check.stderr) });
      }
      return check.fault === undefined ? ok({ exitCode: check.exitCode ?? 0 }) : fault(check.fault);
    },
  };
}

/** One workspace whose current round already holds the development result to check. */
async function workspace(options: {
  readonly round?: number;
  readonly taskKey?: string;
  readonly developmentTaskKey?: string;
}): Promise<{ readonly workspaceRoot: string; readonly worktree: string }> {
  const round = options.round ?? 1;
  const taskKey = options.taskKey ?? 'NEX-1';
  const workspaceRoot = path.join(root, 'workspace');
  const worktree = path.join(workspaceRoot, 'worktree');
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', String(round)), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'current-round.json'),
    `${JSON.stringify({ number: round })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify(
      { taskKey, repository: '/origin/repository.git', branch: `task/${taskKey}`, baseRevision },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const helpers = createArtifactHelpers({ root: workspaceRoot });
  await helpers.writeOutputArtifact(devArtifact, {
    taskKey: options.developmentTaskKey ?? taskKey,
    profile: 'dev-a',
    status: 'completed',
    baseRevision,
    headRevision,
    summary: 'Implemented the retry guard.',
    findingResponses: [],
  });
  return { workspaceRoot, worktree };
}

/** Verify over the workspace, configured checks and controlled capabilities. */
function verifyOver(options: {
  readonly workspaceRoot: string;
  readonly checks: readonly { readonly name: string; readonly command: Command }[];
  readonly git: GitAdapter;
  readonly runCommand: CommandExecution;
}): ReturnType<typeof createVerify> {
  const settings: VerifySettings = {
    workspace: { root: options.workspaceRoot },
    checks: options.checks,
    environment,
    git: options.git,
    runCommand: options.runCommand,
    publish: (event) => events.push(event),
  };
  return createVerify(settings);
}

const validateCheck = {
  name: 'validate',
  command: { executable: 'npm', args: ['run', 'validate'] },
};
const lintCheck = { name: 'lint', command: { executable: 'npm', args: ['run', 'lint'] } };

/** Read one round artifact document. */
async function readRoundArtifact(workspaceRoot: string, name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'artifacts', '1', name), 'utf8'),
  ) as unknown;
}

describe('Verify', () => {
  it('runs the configured checks and records their exit codes and logs', async () => {
    const { workspaceRoot, worktree } = await workspace({});
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision }),
    ]);
    const { runCommand, calls } = scriptedRunCommand([
      { exitCode: 0, stdout: 'all good\n' },
      { exitCode: 0, stdout: 'clean\n', stderr: 'warning\n' },
    ]);
    const verify = verifyOver({
      workspaceRoot,
      checks: [validateCheck, lintCheck],
      git,
      runCommand,
    });

    await expect(verify()).resolves.toBe('passed');

    expect(await readRoundArtifact(workspaceRoot, 'verification.json')).toEqual({
      headRevision,
      status: 'passed',
      checks: [
        {
          name: 'validate',
          exitCode: 0,
          stdoutPath: 'checks/0/stdout.log',
          stderrPath: 'checks/0/stderr.log',
        },
        {
          name: 'lint',
          exitCode: 0,
          stdoutPath: 'checks/1/stdout.log',
          stderrPath: 'checks/1/stderr.log',
        },
      ],
    });
    expect(calls).toEqual([
      {
        executable: 'npm',
        args: ['run', 'validate'],
        directory: worktree,
        environment,
      },
      {
        executable: 'npm',
        args: ['run', 'lint'],
        directory: worktree,
        environment,
      },
    ]);
    expect(
      await readFile(
        path.join(workspaceRoot, 'artifacts', '1', 'checks', '0', 'stdout.log'),
        'utf8',
      ),
    ).toBe('all good\n');
    expect(
      await readFile(
        path.join(workspaceRoot, 'artifacts', '1', 'checks', '1', 'stderr.log'),
        'utf8',
      ),
    ).toBe('warning\n');
    expect(events).toEqual([]);
  });

  it('completes every check and records failed with the failing exit codes', async () => {
    const { workspaceRoot } = await workspace({});
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision }),
    ]);
    const { runCommand, calls } = scriptedRunCommand([
      { exitCode: 2, stdout: 'failure\n' },
      { exitCode: 0 },
    ]);
    const verify = verifyOver({
      workspaceRoot,
      checks: [validateCheck, lintCheck],
      git,
      runCommand,
    });

    await expect(verify()).resolves.toBe('failed');

    expect(calls).toHaveLength(2);
    expect(await readRoundArtifact(workspaceRoot, 'verification.json')).toEqual({
      headRevision,
      status: 'failed',
      checks: [
        {
          name: 'validate',
          exitCode: 2,
          stdoutPath: 'checks/0/stdout.log',
          stderrPath: 'checks/0/stderr.log',
        },
        {
          name: 'lint',
          exitCode: 0,
          stdoutPath: 'checks/1/stdout.log',
          stderrPath: 'checks/1/stderr.log',
        },
      ],
    });
    expect(events).toEqual([
      {
        source: 'verify',
        type: 'failed',
        data: { reason: expect.stringContaining('"validate" exited 2') },
      },
    ]);
  });

  it('fails before running checks when the worktree is not at the development revision', async () => {
    const { workspaceRoot } = await workspace({});
    const { git } = scriptedGit([repositoryState({ headRevision: otherRevision })]);
    const { runCommand, calls } = scriptedRunCommand([{ exitCode: 0 }]);
    const verify = verifyOver({
      workspaceRoot,
      checks: [validateCheck],
      git,
      runCommand,
    });

    await expect(verify()).rejects.toThrow(/at revision 3+, not the development result's 2+/);

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'verification.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('fails before running a command that could clean initially dirty tracked files', async () => {
    const { workspaceRoot } = await workspace({});
    // The scripted command would leave the worktree clean if it ran; the pre-check must reject the
    // pre-existing tracked changes before the post-check inspection can see that cleaned state.
    const { git } = scriptedGit([
      repositoryState({ headRevision, trackedChanges: true }),
      repositoryState({ headRevision }),
    ]);
    const { runCommand, calls } = scriptedRunCommand([{ exitCode: 0, stdout: 'cleaned\n' }]);
    const verify = verifyOver({
      workspaceRoot,
      checks: [validateCheck],
      git,
      runCommand,
    });

    await expect(verify()).rejects.toThrow(/holds tracked changes/);

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'verification.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('records failed when the checks leave tracked changes', async () => {
    const { workspaceRoot } = await workspace({});
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision, trackedChanges: true }),
    ]);
    const { runCommand } = scriptedRunCommand([{ exitCode: 0 }]);
    const verify = verifyOver({
      workspaceRoot,
      checks: [validateCheck],
      git,
      runCommand,
    });

    await expect(verify()).resolves.toBe('failed');

    expect(await readRoundArtifact(workspaceRoot, 'verification.json')).toMatchObject({
      headRevision,
      status: 'failed',
      checks: [{ name: 'validate', exitCode: 0 }],
    });
    expect(events.at(-1)).toEqual({
      source: 'verify',
      type: 'failed',
      data: { reason: expect.stringMatching(/left tracked changes/) },
    });
  });

  it('records no verdict and preserves the captured logs when the checks change the revision', async () => {
    const { workspaceRoot } = await workspace({});
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision: otherRevision }),
    ]);
    const { runCommand, calls } = scriptedRunCommand([{ exitCode: 0, stdout: 'checked\n' }]);
    const verify = verifyOver({
      workspaceRoot,
      checks: [validateCheck],
      git,
      runCommand,
    });

    await expect(verify()).rejects.toThrow(/left the worktree at revision 3+, not 2+/);

    expect(calls).toHaveLength(1);
    expect(
      await readFile(
        path.join(workspaceRoot, 'artifacts', '1', 'checks', '0', 'stdout.log'),
        'utf8',
      ),
    ).toBe('checked\n');
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'verification.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('treats a command that cannot complete as an execution error without recording a verdict', async () => {
    const { workspaceRoot } = await workspace({});
    const { git } = scriptedGit([repositoryState({ headRevision })]);
    const { runCommand } = scriptedRunCommand([
      { fault: 'Cannot start "npm"', stdout: 'partial\n' },
    ]);
    const verify = verifyOver({
      workspaceRoot,
      checks: [validateCheck],
      git,
      runCommand,
    });

    await expect(verify()).rejects.toThrow('Cannot start "npm"');
    // Output captured before the failure is preserved.
    expect(
      await readFile(
        path.join(workspaceRoot, 'artifacts', '1', 'checks', '0', 'stdout.log'),
        'utf8',
      ),
    ).toBe('partial\n');
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'verification.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('rejects a missing development result and a mismatched prepared task', async () => {
    const missing = await workspace({});
    await rm(path.join(missing.workspaceRoot, 'artifacts', '1', 'development.json'));
    const { git } = scriptedGit([repositoryState({ headRevision })]);
    const { runCommand } = scriptedRunCommand([{ exitCode: 0 }]);
    await expect(
      verifyOver({
        workspaceRoot: missing.workspaceRoot,
        checks: [validateCheck],
        git,
        runCommand,
      })(),
    ).rejects.toThrow(/Required artifact/);

    const mismatched = await workspace({ developmentTaskKey: 'NEX-2' });
    await expect(
      verifyOver({
        workspaceRoot: mismatched.workspaceRoot,
        checks: [validateCheck],
        git,
        runCommand,
      })(),
    ).rejects.toThrow(/not the prepared "NEX-1"/);
  });
});
