/**
 * Component tests: the operator command parses the documented input, resolves configuration paths
 * against the working directory, presents application events through the real OperatorInterface
 * wiring and maps execution outcomes to process exit codes. A controlled Application supplies the
 * work, so nothing external runs and no configuration file is read.
 */

import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  operatorUsage,
  parseOperatorCommand,
  runOperatorCommand,
} from '../src/application/command.js';
import type {
  Application,
  ApplicationSettings,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
} from '../src/application/index.js';
import { installationConfigSetting } from '../src/application/installation.js';

const workingDirectory = '/srv/nexus-project';

/** The recorded output streams one command run wrote to. */
type Streams = { readonly output: string[]; readonly diagnostics: string[] };

function streams(): Streams {
  return { output: [], diagnostics: [] };
}

/**
 * The failure a broken output pipe reports, as a Node stream reports it: asynchronously through the
 * stream's own error and close events, neither thrown by nor caught around the write call.
 */
function brokenPipeError(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
}

/** A controlled output stream that records every chunk that reaches it and fails every write. */
function brokenPipeStream(): { readonly output: Writable; readonly chunks: string[] } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback(brokenPipeError());
    },
  });
  return { output, chunks };
}

/** A controlled output stream whose failure surfaces only after the write call has returned. */
function delayedBrokenPipeStream(): { readonly output: Writable; readonly chunks: string[] } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      setTimeout(() => callback(brokenPipeError()), 10);
    },
  });
  return { output, chunks };
}

/** A controlled output stream that records every chunk and accepts closing without an error. */
function closingStream(): { readonly output: Writable; readonly chunks: string[] } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { output, chunks };
}

/** A controlled Application reporting one configured outcome and recording the requests it saw. */
function controlledApplication(outcome: ExecutionResult['outcome']): {
  readonly application: Application;
  readonly requests: ExecutionRequest[];
} {
  const listeners = new Set<(event: ExecutionEvent) => void>();
  const requests: ExecutionRequest[] = [];
  return {
    requests,
    application: {
      execute(request) {
        requests.push(request);
        const result: ExecutionResult = { outcome, reason: 'controlled result', report: null };
        for (const listener of [...listeners]) {
          listener({ source: 'application', type: 'finished', data: result });
        }
        return Promise.resolve(result);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

describe('operator command parsing', () => {
  it('accepts the documented command forms', () => {
    expect(parseOperatorCommand(['--help'])).toEqual({ kind: 'help' });
    expect(parseOperatorCommand(['queue', 'run', '--project-config', 'project.json'])).toEqual({
      kind: 'run',
      projectConfigPath: 'project.json',
    });
  });

  it('rejects missing arguments and unknown options', () => {
    const rejected: readonly (readonly string[])[] = [
      [],
      ['run'],
      ['queue'],
      ['queue', 'stop'],
      ['queue', 'run'],
      ['queue', 'run', '--project'],
      ['queue', 'run', '--project-config'],
      ['queue', 'run', '--project-config', '--help'],
      ['queue', 'run', '--project-config', 'one', '--project-config', 'two'],
      ['--help', 'extra'],
    ];
    for (const args of rejected) {
      expect(parseOperatorCommand(args).kind, args.join(' ')).toBe('invalid');
    }
  });
});

describe('operator command', () => {
  it('prints help without constructing an application or reading configuration', async () => {
    const output = streams();
    const application = vi.fn(() => controlledApplication('completed').application);

    const code = await runOperatorCommand({
      args: ['--help'],
      workingDirectory,
      environment: {},
      output: { write: (text) => output.output.push(text) },
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application,
    });

    expect(code).toBe(0);
    expect(output.output.join('')).toBe(operatorUsage);
    expect(output.diagnostics).toEqual([]);
    expect(application).not.toHaveBeenCalled();
  });

  it('reports invalid input with exit code 2 before reading configuration', async () => {
    const output = streams();
    const application = vi.fn(() => controlledApplication('completed').application);

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--unknown'],
      workingDirectory,
      environment: {},
      output: { write: (text) => output.output.push(text) },
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application,
    });

    expect(code).toBe(2);
    expect(output.output).toEqual([]);
    expect(output.diagnostics.join('')).toContain('Unknown option');
    expect(application).not.toHaveBeenCalled();
  });

  it('requires the installation configuration setting', async () => {
    const output = streams();
    const application = vi.fn(() => controlledApplication('completed').application);

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', 'project.json'],
      workingDirectory,
      environment: {},
      output: { write: (text) => output.output.push(text) },
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application,
    });

    expect(code).toBe(1);
    expect(output.diagnostics.join('')).toContain(installationConfigSetting);
    expect(application).not.toHaveBeenCalled();
  });

  it('resolves both filepaths against the working directory and completes', async () => {
    const output = streams();
    const controlled = controlledApplication('completed');
    const received: ApplicationSettings[] = [];

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', 'configs/project.json'],
      workingDirectory,
      environment: { [installationConfigSetting]: 'configs/nexus.json' },
      output: { write: (text) => output.output.push(text) },
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application: (settings) => {
        received.push(settings);
        return controlled.application;
      },
    });

    expect(code).toBe(0);
    expect(controlled.requests).toEqual([
      { projectConfigPath: path.join(workingDirectory, 'configs/project.json') },
    ]);
    expect(received[0]?.installationConfigPath).toBe(
      path.join(workingDirectory, 'configs/nexus.json'),
    );
    expect(output.output.join('')).toContain('finished completed: controlled result');
  });

  it('exits 1 when execution needs attention', async () => {
    const output = streams();
    const controlled = controlledApplication('needs-attention');

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', 'project.json'],
      workingDirectory,
      environment: { [installationConfigSetting]: 'nexus.json' },
      output: { write: (text) => output.output.push(text) },
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application: () => controlled.application,
    });

    expect(code).toBe(1);
    expect(output.output.join('')).toContain('finished needs-attention: controlled result');
    expect(output.diagnostics).toEqual([]);
  });

  it('prints a parent initialization failure and exits 1', async () => {
    const output = streams();
    const application: Application = {
      execute: () => Promise.reject(new Error('Cannot read Nexus configuration /missing.json')),
      subscribe: () => () => {},
    };

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', 'project.json'],
      workingDirectory,
      environment: { [installationConfigSetting]: 'nexus.json' },
      output: { write: (text) => output.output.push(text) },
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application: () => application,
    });

    expect(code).toBe(1);
    expect(output.diagnostics.join('')).toContain('Cannot read Nexus configuration /missing.json');
  });
});

describe('operator command output failure', () => {
  it('stops rendering and completes execution when the output stream breaks asynchronously', async () => {
    const output = streams();
    const { output: broken, chunks } = brokenPipeStream();
    const writeAttempts = vi.spyOn(broken, 'write');
    const listeners = new Set<(event: ExecutionEvent) => void>();
    let unsubscriptions = 0;
    const application: Application = {
      async execute() {
        // The boundary observes the stream before rendering starts, so an asynchronous failure is
        // handled whenever it arrives.
        expect(broken.listenerCount('error')).toBe(1);
        for (const listener of [...listeners]) {
          listener({ source: 'application', type: 'running', data: null });
        }
        // Let the stream deliver its EPIPE error and closure while execution continues.
        await new Promise((resolve) => setImmediate(resolve));
        for (const listener of [...listeners]) {
          listener({ source: 'application', type: 'finished', data: { outcome: 'completed' } });
        }
        return { outcome: 'completed', reason: 'controlled result', report: null };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscriptions += 1;
        };
      },
    };

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', 'project.json'],
      workingDirectory,
      environment: { [installationConfigSetting]: 'nexus.json' },
      output: broken,
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application: () => application,
    });

    expect(code).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('running');
    expect(writeAttempts).toHaveBeenCalledTimes(1);
    expect(output.diagnostics).toEqual([]);
    expect(unsubscriptions).toBe(1);
    expect(listeners.size).toBe(0);
    // Presentation stopped, so the boundary released its stream listeners.
    expect(broken.listenerCount('error')).toBe(0);
    expect(broken.listenerCount('close')).toBe(0);
  });

  it('absorbs a failure that arrives after presentation stops and then releases its listeners', async () => {
    const output = streams();
    const { output: broken, chunks } = delayedBrokenPipeStream();
    const listeners = new Set<(event: ExecutionEvent) => void>();
    const application: Application = {
      execute() {
        for (const listener of [...listeners]) {
          listener({ source: 'application', type: 'running', data: null });
        }
        return Promise.resolve({ outcome: 'completed', reason: 'controlled result', report: null });
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', 'project.json'],
      workingDirectory,
      environment: { [installationConfigSetting]: 'nexus.json' },
      output: broken,
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application: () => application,
    });

    // The write was still flushing when presentation stopped, so the boundary keeps listening
    // until the failure it may still report has arrived.
    expect(code).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(broken.listenerCount('error')).toBe(1);
    await vi.waitFor(() => {
      expect(broken.listenerCount('error')).toBe(0);
    });
    expect(broken.listenerCount('close')).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(output.diagnostics).toEqual([]);
  });

  it('stops rendering when the output stream closes without reporting an error', async () => {
    const output = streams();
    const { output: closing, chunks } = closingStream();
    const writeAttempts = vi.spyOn(closing, 'write');
    const listeners = new Set<(event: ExecutionEvent) => void>();
    const application: Application = {
      async execute() {
        for (const listener of [...listeners]) {
          listener({ source: 'application', type: 'running', data: null });
        }
        // The consumer goes away without the stream reporting an error.
        closing.destroy();
        await new Promise((resolve) => setImmediate(resolve));
        for (const listener of [...listeners]) {
          listener({ source: 'application', type: 'finished', data: { outcome: 'completed' } });
        }
        return { outcome: 'completed', reason: 'controlled result', report: null };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };

    const code = await runOperatorCommand({
      args: ['queue', 'run', '--project-config', 'project.json'],
      workingDirectory,
      environment: { [installationConfigSetting]: 'nexus.json' },
      output: closing,
      diagnostics: { write: (text) => output.diagnostics.push(text) },
      application: () => application,
    });

    expect(code).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(writeAttempts).toHaveBeenCalledTimes(1);
    expect(closing.listenerCount('error')).toBe(0);
    expect(closing.listenerCount('close')).toBe(0);
    expect(output.diagnostics).toEqual([]);
  });
});
