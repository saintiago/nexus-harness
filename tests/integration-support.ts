/**
 * Shared support for the boundary suites: real temporary directories, a private
 * Git environment, and the small pieces a fixture that must really start
 * something needs — a launcher that puts a stand-in first on `PATH`, and the
 * bounded process checks a stop is verified with.
 *
 * Nothing here reaches a provider, a credential store, or this repository: every
 * path a case touches is under a temporary directory the suite owns, and the Git
 * environment is one the machine's own global configuration, hooks, and identity
 * cannot change. A directory a case created through {@link createTempDir} is
 * removed after that case, so a fixture never leaves a repository, a log, or a
 * clone of a failed run behind.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { createTempDir, removeWithRetry } from './support.js';

/**
 * The temporary-directory helpers every boundary case uses, re-exported so a
 * suite imports its whole fixture surface from one file. A directory created by
 * `createTempDir` is removed after the case that created it, whatever the case
 * did with it.
 */
export { createTempDir, removeWithRetry };

/** What one real program wrote, and how it ended. */
export interface ProgramResult {
  /** Exit code of a program that ran and exited; `null` when it never started. */
  readonly code: number | null;
  /** Terminating signal of a program that was killed; `null` otherwise. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one real program to its end, with the environment it is given. */
export function runProgram(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<ProgramResult> {
  const environment = options.env ?? process.env;
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (cause) => {
      // A program that could not be started reports what the host said, exactly
      // as a program that wrote it would.
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${cause.message}\n` });
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Runs `work` with `bin` first on this process's `PATH`, and puts `PATH` back
 * afterwards however `work` ended. A stand-in is only ever reached by a command
 * a case runs inside `work`, and only while that case runs.
 */
export async function withPathPrefix<T>(bin: string, work: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH ?? '';
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    return await work();
  } finally {
    process.env.PATH = saved;
  }
}

/**
 * A stand-in program: a Node script, and a launcher named so that a command
 * resolved by its bare name on `PATH` starts the script instead of the installed
 * program. Real `git`, `gh`, and `node` invocations are never confused with it,
 * because only a case that puts {@link StandIn.bin} first on `PATH` sees it.
 */
export interface StandIn {
  /** The directory the launcher was written to; put it first on `PATH`. */
  readonly bin: string;
  /** The script the launcher runs, for a case that reads it back. */
  readonly scriptPath: string;
}

/** Writes the launcher and script for one stand-in program named `name`. */
export async function installStandIn(name: string, script: string): Promise<StandIn> {
  const bin = await createTempDir();
  const scriptPath = path.join(bin, `${name}.mjs`);
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(
      path.join(bin, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      'utf8',
    );
  } else {
    const launcher = path.join(bin, name);
    await writeFile(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
      'utf8',
    );
    await chmod(launcher, 0o755);
  }
  return { bin, scriptPath };
}

/** True while this host still reports a process with that PID. */
export function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for `ms`, for a case that has to let a real process get somewhere. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits, bounded, for a process to be gone, then insists that it is. */
export async function waitUntilGone(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (stillRunning(pid) && Date.now() < deadline) {
    await pause(50);
  }
  return !stillRunning(pid);
}

/** Reads one file the moment it holds JSON `want`, or fails saying what it read. */
export async function readJsonWhenWritten(
  file: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch (cause) {
      if (Date.now() >= deadline) {
        throw new Error(`"${file}" was never written: ${String(cause)}`, { cause });
      }
    }
    await pause(25);
  }
}

/** One request a stand-in service really received. */
export interface ReceivedRequest {
  readonly method: string;
  /** The path and query the adapter asked for, as it sent them. */
  readonly url: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly body: string;
}

/** What the stand-in service answers one request with. */
export interface ServiceAnswer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/**
 * A real HTTP service on this host's loopback, and everything it received. A
 * service adapter is driven through it against answers a test wrote, so a real
 * request crosses a real socket without any live account or credential. The
 * service is closed before the case that started it ends, connections included.
 */
export interface LocalService {
  /** The origin to dial, for example `http://127.0.0.1:54321`. */
  readonly origin: string;
  /** Every request the service received, in the order it received them. */
  readonly requests: ReceivedRequest[];
  close(): Promise<void>;
}

/** Starts one stand-in service that answers `answer` for every request. */
export async function startLocalService(
  answer: (request: ReceivedRequest, index: number) => ServiceAnswer,
): Promise<LocalService> {
  const requests: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      const sent = answer(requests[requests.length - 1]!, requests.length - 1);
      response.writeHead(sent.status, {
        ...(sent.headers ?? {}),
        ...(sent.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      });
      response.end(sent.body ?? '');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the stand-in service did not report the port it listens on');
  }

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A fetch keeps its connection alive; the service is closed with the
        // connections it holds, so a case never waits for one of them.
        server.closeAllConnections();
        server.close((cause) => {
          if (cause === undefined) {
            resolve();
          } else {
            reject(cause);
          }
        });
      }),
  };
}

/**
 * The real `fetch`, dialling `origin` instead of the host the adapter built its
 * URL for. The adapter's own URL, headers, redirect policy, and signal are all
 * still what it made them: only the machine the request reaches is local.
 */
export function serviceFetch(origin: string): typeof fetch {
  const local = new URL(origin);
  return (input, init) => {
    const asked = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    asked.protocol = local.protocol;
    asked.host = local.host;
    return globalThis.fetch(asked, init);
  };
}

/** The environment one fixture Git command commits with, on top of this one. */
export function fixtureGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_AUTHOR_NAME: 'Nexus Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Nexus Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Runs the host's real Git, with an identity a fixture commit can use. A case
 * that is about what Git does *without* any identity passes
 * `{ identity: false }` and gets exactly the environment the suite runs under.
 */
export function fixtureGit(
  args: readonly string[],
  cwd: string,
  options: { readonly identity?: boolean } = {},
): Promise<ProgramResult> {
  const env = options.identity === false ? process.env : fixtureGitEnvironment();
  return runProgram('git', args, { cwd, env });
}

/** Runs a fixture Git command and insists that it succeeded. */
export async function gitOrFail(
  args: readonly string[],
  cwd: string,
  options: { readonly identity?: boolean } = {},
): Promise<string> {
  const result = await fixtureGit(args, cwd, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** A temporary source repository with one commit, and an output location beside it. */
export interface RepositoryFixture {
  /** The temporary directory both the source and the output location live under. */
  readonly parent: string;
  /** The source repository, committed on `main`. */
  readonly repo: string;
  /** The run's output location, outside the source. */
  readonly workDir: string;
}

/** Creates one source repository with a committed baseline, and an output location. */
export async function createRepository(): Promise<RepositoryFixture> {
  const parent = await createTempDir();
  const repo = path.join(parent, 'repo');
  await mkdir(repo);
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  await writeFile(path.join(repo, 'README.md'), 'baseline\n', 'utf8');
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);
  return { parent, repo, workDir: path.join(parent, 'runs') };
}

/**
 * Gives the suite a private Git environment: no system configuration, no
 * global configuration, and no prompt. The identity a fixture commit needs is
 * supplied per command ({@link fixtureGit}), never here, so a case can observe
 * what a Git command really does without one.
 */
export function useIsolatedGitEnvironment(): void {
  let directory: string | undefined;
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-git-'));
    const emptyConfig = path.join(directory, 'empty.gitconfig');
    await writeFile(emptyConfig, '', 'utf8');
    const names: Record<string, string> = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_TERMINAL_PROMPT: '0',
    };
    for (const [name, value] of Object.entries(names)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterAll(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    saved.clear();
    if (directory !== undefined) {
      const target = directory;
      await removeWithRetry(() => rm(target, { recursive: true, force: true }));
    }
  });
}
