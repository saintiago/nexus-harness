/**
 * Focused integration tests: the real Processes adapter runs small controlled child processes
 * to establish arguments, standard input, output, exit and timeout behavior.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type ProcessOutput } from '../src/adapters/processes.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-processes-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Collect every emitted chunk in arrival order. */
function collect(outputs: ProcessOutput[]): (output: ProcessOutput) => void {
  return (output) => {
    outputs.push(output);
  };
}

/** Decode one stream's chunks as text. */
function text(outputs: readonly ProcessOutput[], stream: ProcessOutput['stream']): string {
  const chunks = outputs.filter((output) => output.stream === stream).map((output) => output.chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** True while the process exists. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Wait until every process has ended. */
async function waitForProcessesToEnd(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 2000;
  while (pids.some(isRunning)) {
    if (Date.now() > deadline) {
      throw new Error(`Processes still running: ${pids.filter(isRunning).join(', ')}`);
    }
    await delay(20);
  }
}

describe('Processes adapter', () => {
  it('passes the executable, arguments and working directory and streams both outputs', async () => {
    const directory = await temporaryDirectory();
    const outputs: ProcessOutput[] = [];

    const result = await run(
      {
        executable: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) })); console.error("stderr-marker");',
          'two words',
          '; echo injected',
          '*',
        ],
        directory,
        environment: {},
      },
      collect(outputs),
    );

    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
    expect(text(outputs, 'stderr')).toBe('stderr-marker\n');
    expect(JSON.parse(text(outputs, 'stdout'))).toEqual({
      cwd: await realpath(directory),
      args: ['two words', '; echo injected', '*'],
    });
  });

  it('uses the supplied environment without inheriting unrelated host values', async () => {
    const directory = await temporaryDirectory();
    const outputs: ProcessOutput[] = [];
    process.env.NEXUS_PROCESSES_TEST_UNRELATED = 'unrelated-value';
    try {
      const result = await run(
        {
          executable: process.execPath,
          args: [
            '-e',
            'console.log(JSON.stringify({ supplied: process.env.SUPPLIED ?? null, unrelated: process.env.NEXUS_PROCESSES_TEST_UNRELATED ?? null }));',
          ],
          directory,
          environment: { SUPPLIED: 'supplied-value' },
        },
        collect(outputs),
      );

      expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
      expect(JSON.parse(text(outputs, 'stdout'))).toEqual({
        supplied: 'supplied-value',
        unrelated: null,
      });
    } finally {
      delete process.env.NEXUS_PROCESSES_TEST_UNRELATED;
    }
  });

  it('returns a nonzero exit code as a command result', async () => {
    const result = await run(
      {
        executable: process.execPath,
        args: ['-e', 'process.exit(3)'],
        directory: await temporaryDirectory(),
        environment: {},
      },
      () => {},
    );

    expect(result).toEqual({ ok: true, value: { exitCode: 3 } });
  });

  it('leaves standard input unconnected when the command supplies none', async () => {
    const outputs: ProcessOutput[] = [];

    const result = await run(
      {
        executable: process.execPath,
        args: [
          '-e',
          'const { readFileSync } = require("node:fs"); console.log(JSON.stringify({ stdin: readFileSync(0, "utf8") }));',
        ],
        directory: await temporaryDirectory(),
        environment: {},
      },
      collect(outputs),
    );

    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
    expect(JSON.parse(text(outputs, 'stdout'))).toEqual({ stdin: '' });
  });

  it('delivers large Unicode standard input intact and ends the stream', async () => {
    const directory = await temporaryDirectory();
    const outputs: ProcessOutput[] = [];
    const input = 'Revisión completa ✓ 你好 — '.repeat(8000);
    const script = `
      const { createHash } = require('node:crypto');
      const { readFileSync } = require('node:fs');
      const received = readFileSync(0, 'utf8');
      console.log(JSON.stringify({
        received: received.length,
        digest: createHash('sha256').update(received, 'utf8').digest('hex'),
      }));
    `;

    const result = await run(
      {
        executable: process.execPath,
        args: ['-e', script],
        directory,
        environment: {},
        input,
      },
      collect(outputs),
    );

    expect(input.length).toBeGreaterThan(150_000);
    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
    expect(JSON.parse(text(outputs, 'stdout'))).toEqual({
      received: input.length,
      digest: createHash('sha256').update(input, 'utf8').digest('hex'),
    });
  });

  it('faults without hanging when the command ends before consuming supplied input', async () => {
    const input = 'Revisión completa ✓ 你好 — '.repeat(8000);

    const result = await run(
      {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        directory: await temporaryDirectory(),
        environment: {},
        input,
      },
      () => {},
    );

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/standard input/) },
    });
  });

  it('returns a fault excluding secrets when the command cannot start', async () => {
    const directory = await temporaryDirectory();
    const executable = path.join(directory, 'no-such-command');

    const result = await run(
      {
        executable,
        args: ['--token', 'secret-value'],
        directory,
        environment: { SECRET: 'secret-value' },
      },
      () => {},
    );

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining(executable) },
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it("applies the time limit and ends the command's process group", async () => {
    const directory = await temporaryDirectory();
    const outputs: ProcessOutput[] = [];
    const script = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      console.log(JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
      setInterval(() => {}, 1000);
    `;
    const pids: number[] = [];
    try {
      const result = await run(
        {
          executable: process.execPath,
          args: ['-e', script],
          directory,
          environment: {},
          timeLimitMs: 300,
        },
        collect(outputs),
      );

      expect(result).toMatchObject({
        ok: false,
        fault: { message: expect.stringMatching(/time limit/) },
      });
      const observed = JSON.parse(text(outputs, 'stdout')) as {
        child: number;
        grandchild: number;
      };
      pids.push(observed.child, observed.grandchild);

      await waitForProcessesToEnd(pids);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already ended.
        }
      }
    }
  });

  it('returns the command result when an output observer fails', async () => {
    const result = await run(
      {
        executable: process.execPath,
        args: ['-e', 'console.log("output")'],
        directory: await temporaryDirectory(),
        environment: {},
      },
      () => {
        throw new Error('observer failure');
      },
    );

    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
  });
});
