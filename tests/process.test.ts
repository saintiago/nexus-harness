/**
 * The process boundary, with real operating-system processes.
 *
 * `runInvocation` is the harness's one bounded invocation and `runCommand` is
 * what a configured setup or check command goes through: an executable plus
 * literal arguments and never a shell, output kept in the run's own log files,
 * a limit and a caller's stop request that end the whole tree the invocation
 * started, and a launch failure that is never reported as a command that ran.
 * Which command to run and what its result means belong to the caller, and stay
 * in the fast suites (`docs/testing.md`).
 *
 * Every process a case starts is either waited for or stopped and confirmed
 * gone before the case ends, and every path is under a temporary directory the
 * suite removes afterwards.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/process/command.js';
import { runInvocation } from '../src/process/invocation.js';
import type { InvocationResult } from '../src/process/invocation.js';
import { collectHostUtilityWords } from '../src/process/stop.js';
import { createTempDir } from './support.js';
import { pause, readJsonWhenWritten, waitUntilGone } from './integration-support.js';

/** Runs one invocation of the host's own Node, capturing what it wrote. */
async function invokeNode(
  script: string,
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly stop?: AbortSignal;
    readonly env?: NodeJS.ProcessEnv;
    /** Extra arguments handed to the script, after the ones the runner adds. */
    readonly args?: readonly string[];
  },
): Promise<{
  readonly result: InvocationResult;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  const result = await runInvocation({
    command: [process.execPath, '--input-type=module', '-e', script, ...(options.args ?? [])],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.env === undefined ? {} : { env: options.env }),
    onStdout: (chunk) => {
      stdout += chunk;
    },
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { result, stdout, stderr };
}

/**
 * A script that records its own PID and the PID of a child it starts, and then
 * keeps running until something kills the tree. The record is written only once
 * the child really exists, so a record that exists names two live processes.
 */
function hangWithChildScript(record: string): string {
  return [
    `const { spawn } = await import('node:child_process');`,
    `const { writeFileSync } = await import('node:fs');`,
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {`,
    `  stdio: 'ignore',`,
    `  windowsHide: true,`,
    `});`,
    `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, child: child.pid }));`,
    `setInterval(() => {}, 1000);`,
  ].join('\n');
}

describe('one bounded invocation', () => {
  it('receives the literal argument array, and never through a shell', async () => {
    const cwd = await createTempDir();
    const args = ['a b', '$(echo hi)', '"quoted"', 'x;y', '--flag=1', '%PATH%'];

    const { result, stdout } = await invokeNode(
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      { cwd, timeoutMs: 30_000, args },
    );

    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.termination).toBeNull();
    expect(JSON.parse(stdout)).toEqual(args);
  }, 45_000);

  it('reports an executable that cannot be started as a launch failure', async () => {
    const cwd = await createTempDir();

    const result = await runInvocation({
      command: ['nexus-there-is-no-such-executable', 'run'],
      cwd,
      timeoutMs: 30_000,
    });

    // A command that never started is never a command that ran: no exit code,
    // and the reason it could not start is carried.
    expect(result.outcome).toBe('failed-to-launch');
    expect(result.exitCode).toBeNull();
    expect(result.launchError).not.toBeNull();
    expect(result.termination).toBeNull();
  }, 45_000);

  it('reports a working directory that is not there as a launch failure', async () => {
    const parent = await createTempDir();
    const absent = path.join(parent, 'absent');

    const result = await runInvocation({
      command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: absent,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe('failed-to-launch');
    expect(result.exitCode).toBeNull();
    expect(result.launchError).toContain(absent);
  }, 45_000);

  it('reports an ordinary nonzero exit as a command that ran', async () => {
    const cwd = await createTempDir();

    const { result, stdout, stderr } = await invokeNode(
      'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3);',
      { cwd, timeoutMs: 30_000 },
    );

    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.termination).toBeNull();
    expect(stdout).toBe('out\n');
    expect(stderr).toBe('err\n');
  }, 45_000);

  it('gives the invocation the environment it was handed, and nothing else', async () => {
    const cwd = await createTempDir();
    // The token this process really holds is the one a source run removes before
    // its commands run (docs/WORKFLOW.md §7): the invocation inherits the copy
    // it was given, so a variable left out of that copy is simply not there.
    const secret = 'nexus-token-that-must-not-travel';
    const saved = process.env.NEXUS_TEST_TOKEN;
    process.env.NEXUS_TEST_TOKEN = secret;
    const environment: NodeJS.ProcessEnv = { ...process.env, NEXUS_TEST_KEPT: 'kept' };
    delete environment.NEXUS_TEST_TOKEN;
    try {
      const { result, stdout } = await invokeNode(
        'process.stdout.write(JSON.stringify({ token: process.env.NEXUS_TEST_TOKEN ?? null, kept: process.env.NEXUS_TEST_KEPT ?? null }))',
        { cwd, timeoutMs: 30_000, env: environment },
      );

      expect(result.outcome).toBe('exited');
      expect(JSON.parse(stdout)).toEqual({ token: null, kept: 'kept' });
    } finally {
      if (saved === undefined) {
        delete process.env.NEXUS_TEST_TOKEN;
      } else {
        process.env.NEXUS_TEST_TOKEN = saved;
      }
    }
  }, 45_000);
});

describe('one command in a run', () => {
  it('keeps both output streams in the run’s own log files', async () => {
    const workDir = await createTempDir();
    const logsDir = path.join(workDir, 'runs', 'run-1', 'logs');
    await mkdir(logsDir, { recursive: true });

    const result = await runCommand({
      command: [
        process.execPath,
        '-e',
        'process.stdout.write("hello\\n"); process.stderr.write("note\\n")',
      ],
      cwd: workDir,
      logsDir,
      label: 'check-1',
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.command).toEqual([
      process.execPath,
      '-e',
      'process.stdout.write("hello\\n"); process.stderr.write("note\\n")',
    ]);
    expect(result.cwd).toBe(workDir);
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.endedAt))).toBe(false);
    expect(result.stdoutPath).toBe(path.join(logsDir, 'check-1.stdout.log'));
    expect(result.stderrPath).toBe(path.join(logsDir, 'check-1.stderr.log'));
    expect(await readFile(result.stdoutPath, 'utf8')).toBe('hello\n');
    expect(await readFile(result.stderrPath, 'utf8')).toBe('note\n');
  }, 45_000);

  it('persists the logs of a command that could not start, and reports no exit code', async () => {
    const workDir = await createTempDir();
    const logsDir = path.join(workDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    const result = await runCommand({
      command: ['nexus-there-is-no-such-executable', 'run'],
      cwd: workDir,
      logsDir,
      label: 'setup-1',
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe('failed-to-launch');
    expect(result.exitCode).toBeNull();
    expect(result.launchError).not.toBeNull();
    expect(await readFile(result.stdoutPath, 'utf8')).toBe('');
    expect(await readFile(result.stderrPath, 'utf8')).toBe('');
  }, 45_000);

  it('refuses to record an invocation outside a directory that exists, and runs nothing', async () => {
    const workDir = await createTempDir();
    const marker = path.join(workDir, 'ran.txt');

    const failure = await runCommand({
      command: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
      cwd: workDir,
      // The run's own evidence directory is not there, so there is nowhere to
      // keep this command's output: the run is stopped before the command runs.
      logsDir: path.join(workDir, 'missing', 'logs'),
      label: 'check-1',
      timeoutMs: 30_000,
    }).then(
      () => null,
      (cause: Error) => cause,
    );

    expect(failure?.message).toContain('could not be created');
    expect(failure?.message).toContain(path.join(workDir, 'missing', 'logs', 'check-1.stdout.log'));
    await pause(50);
    expect(existsSync(marker)).toBe(false);
  }, 45_000);
});

describe('ending what an invocation started', () => {
  it('stops the invocation and the whole tree it started at its limit', async () => {
    const cwd = await createTempDir();
    const record = path.join(cwd, 'tree.json');
    const started = Date.now();

    const { result } = await invokeNode(hangWithChildScript(record), {
      cwd,
      timeoutMs: 3000,
    });
    const recorded = await readJsonWhenWritten(record);
    const pid = Number(recorded.pid);
    const child = Number(recorded.child);

    // Both processes really ran: the record is written only once the child the
    // invocation started exists.
    expect(Number.isInteger(pid)).toBe(true);
    expect(Number.isInteger(child)).toBe(true);
    expect(result.outcome).toBe('timed-out');
    expect(result.timeoutMs).toBe(3000);
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    // The invocation was stopped, never waited out.
    expect(Date.now() - started).toBeLessThan(30_000);

    // What was stopped is the tree: the invocation and the child it started.
    expect(await waitUntilGone(pid)).toBe(true);
    expect(await waitUntilGone(child)).toBe(true);
  }, 60_000);

  it('stops a running invocation when the caller stops the run, and says which stop it was', async () => {
    const cwd = await createTempDir();
    const record = path.join(cwd, 'tree.json');
    const controller = new AbortController();

    const pending = invokeNode(hangWithChildScript(record), {
      cwd,
      timeoutMs: 60_000,
      stop: controller.signal,
    });
    let recorded: Record<string, unknown>;
    let result: InvocationResult;
    try {
      recorded = await readJsonWhenWritten(record);
      controller.abort();
      ({ result } = await pending);
    } catch (cause) {
      // Whatever happens, the invocation this case started is stopped and
      // awaited before the case ends.
      controller.abort();
      await pending.catch(() => undefined);
      throw cause;
    }

    expect(result.outcome).toBe('stopped');
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    expect(await waitUntilGone(Number(recorded.pid))).toBe(true);
    expect(await waitUntilGone(Number(recorded.child))).toBe(true);
  }, 60_000);

  it('starts nothing at all when the stop arrived before the invocation did', async () => {
    const cwd = await createTempDir();
    const marker = path.join(cwd, 'ran.txt');
    const controller = new AbortController();
    controller.abort();

    const { result } = await invokeNode(
      `const { writeFileSync } = await import('node:fs'); writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      { cwd, timeoutMs: 30_000, stop: controller.signal },
    );

    // The omission is the stop it is, and the command really never ran.
    expect(result.outcome).toBe('stopped');
    expect(result.termination).toBe('confirmed');
    expect(result.exitCode).toBeNull();
    await pause(50);
    expect(existsSync(marker)).toBe(false);
  }, 45_000);
});

describe('what a failed stop repeats of its utility', () => {
  it('keeps a late failure on standard error after a long success prefix', () => {
    const words = collectHostUtilityWords();
    words.noteStdout('x'.repeat(1000));
    words.noteStderr('ERROR: The process "1234" not found.');

    expect(words.failureDetail()).toBe(': ERROR: The process "1234" not found.');
  });

  it('falls back to standard output when standard error is empty', () => {
    const words = collectHostUtilityWords();
    words.noteStdout('refused: no such process');

    expect(words.failureDetail()).toBe(': refused: no such process');
  });

  it('keeps only the bound of what one stream says, and says it was cut', () => {
    const words = collectHostUtilityWords();
    words.noteStderr('a'.repeat(500));

    const detail = words.failureDetail();
    expect(detail.endsWith('[truncated]')).toBe(true);
    expect(detail.startsWith(': aaaa')).toBe(true);
    expect(detail.length).toBeLessThan(500);
  });
});
