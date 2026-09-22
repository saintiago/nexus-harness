/**
 * The CLI fixtures both command-line suites share: an in-process invocation of the
 * real entry point, the two configuration files a command reads, and the real Git
 * repository and run directory the run-boundary cases drive. Nothing here starts a
 * provider, and every temporary directory is removed by the lifecycle the test file
 * registers.
 */

/**
 * The command line: what it accepts, what it refuses, what it prints, and what
 * it exits with.
 *
 * Most of these tests are static or near-static — help, usage errors, input
 * validation, and the refusals that must happen before anything runs — and they
 * prove that nothing was created and nothing was started by looking at the
 * filesystem and at probes that would have recorded having run.
 *
 * The `run` tests below are real runs, with one substitution: the coding turn.
 * The source is a real temporary Git repository, and the preflight, the run
 * directory, the clone, the configured checks through real child processes, and
 * the report are the harness's own code; the report each test reads back is the
 * `result.json` the harness wrote. What is substituted is
 * `dependencies.runAgentTurn` — the one collaborator that talks to a runtime —
 * as `tests/local-run.integration.test.ts` substitutes it, so no provider,
 * account, or network is involved and nothing here can depend on one.
 *
 * The one thing a run at this boundary cannot do is deliver a real OS signal to
 * itself, so an interrupt is delivered through the CLI's own `signals` seam: the
 * handler the CLI installed is called, which is what a delivered signal does.
 * That proves the CLI's side of the contract — it cancels the run, waits for it
 * to finalize, and releases the handler — and it is stated as the limit it is:
 * the platform's delivery of a real signal is not exercised here.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { runCli } from './operations.js';
import { ownFixtureOperation, runProcess as ownedProcess } from './lifecycle.js';
import type { CliContext, CliTerminal, InterruptSignals } from '../../src/cli/context.js';
import type { AgentTurnRequest, RunnerDependencies } from '../../src/runs/contracts.js';
import type { RunReport } from '../../src/shared/types.js';
import {
  createTempDir,
  documentedConfig,
  documentedProjectConfig,
  documentedTask,
  repoRoot,
  splitConfig,
  writeJsonFile,
  type JsonObject,
} from '../support.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../../src/config/paths.js';
import { gitFixtureEnvironment } from './git.js';

/** The private Git environment every fixture command in these suites runs in. */
let fixtureEnvironment: NodeJS.ProcessEnv = {};

/** Prepares that environment for one test, before anything commits. */
export async function beginCliFixtureEnvironment(): Promise<void> {
  return ownFixtureOperation('CLI Git environment setup', async () => {
    fixtureEnvironment = await gitFixtureEnvironment({
      name: 'Nexus CLI Test',
      email: 'cli@example.test',
    });
  });
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

export interface CliRunOptions {
  /** Directory relative arguments resolve from. Defaults to the repository. */
  readonly cwd?: string;
  /** Interrupt signals to hand the CLI instead of the process's own. */
  readonly signals?: InterruptSignals;
  /** Loop collaborators to substitute; the real ones are kept for the rest. */
  readonly dependencies?: Partial<RunnerDependencies>;
  /** An interactive terminal for the CLI to write to, instead of plain output. */
  readonly terminal?: CliTerminal;
}

/** Runs the CLI in-process with captured output. */
export async function run(
  argv: readonly string[],
  options: CliRunOptions = {},
): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    cwd: options.cwd ?? repoRoot,
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    },
  };
  if (options.signals !== undefined) {
    context.signals = options.signals;
  }
  if (options.dependencies !== undefined) {
    context.dependencies = options.dependencies;
  }
  const code = await runCli(argv, context);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in a real process, exercising the entry-point guard. */
export function runProcess(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return ownedProcess(process.execPath, args, { cwd });
}

/**
 * Writes one field map as the two configuration files a command reads, plus the
 * task file, into a fresh temporary directory. The connected project's own
 * configuration sits in the same directory, which is also what `--project`
 * names for the read-only commands.
 */
export async function writeInputs(
  config: unknown = documentedConfig,
  task: unknown = documentedTask,
): Promise<{
  directory: string;
  configPath: string;
  projectPath: string;
  taskPath: string;
}> {
  return ownFixtureOperation('writeInputs setup', async () => {
    const directory = await createTempDir();
    const { harness, project } = splitConfig(config as JsonObject);
    const configPath = await writeJsonFile(directory, HARNESS_CONFIG_FILE_NAME, harness);
    const projectPath = await writeJsonFile(directory, PROJECT_CONFIG_FILE_NAME, project);
    const taskPath = await writeJsonFile(directory, 'task.json', task);
    return { directory, configPath, projectPath, taskPath };
  });
}

/** The argv of a `check-config` from `cwd`, with every path as given. */
export function checkConfigArgv(parts: {
  readonly config: string;
  readonly project: string;
  readonly task?: string;
}): string[] {
  return [
    'check-config',
    '--config',
    parts.config,
    '--project',
    parts.project,
    ...(parts.task === undefined ? [] : ['--task', parts.task]),
  ];
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits, bounded, for something a fixture recorded. Waiting for the condition
 * itself is what makes this honest: a fixed pause would be either flaky on a
 * loaded machine or dead time on an idle one, and neither is a test of anything.
 */
export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`this test waited for ${what}, and it never happened`);
    }
    await pause(10);
  }
}

export function runGit(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return ownedProcess('git', args, { cwd, env: fixtureEnvironment });
}

export async function gitOrThrow(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} in ${cwd} exited ${String(result.code)}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * A clean Git repository with one commit: the source a run starts from, with the
 * project configuration a connected repository carries committed at its root.
 */
export async function createSourceRepository(
  parent: string,
  project: JsonObject = documentedProjectConfig,
  name = 'target-project',
): Promise<string> {
  return ownFixtureOperation('createSourceRepository setup', async () => {
    const repo = path.join(parent, name);
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'README.md'), '# target project\n', 'utf8');
    await writeJsonFile(repo, PROJECT_CONFIG_FILE_NAME, project);
    await gitOrThrow(['init', '--quiet', '--initial-branch=main'], repo);
    await gitOrThrow(['add', '--all'], repo);
    await gitOrThrow(['commit', '--quiet', '--message', 'target: baseline'], repo);
    return repo;
  });
}

/** A configured command that records that it ran. */
export const PROBE_SOURCE = "require('node:fs').appendFileSync(process.argv[2], 'ran\\n');\n";

/**
 * A check that counts its own invocations in a file outside the working copy and
 * is red exactly when `redWhen` holds. The working copy is identical on every
 * round, so what the run reacts to is the fixture's own count — which is what
 * lets a test say exactly which round is green and which is red.
 */
export function countingCheck(redWhen: string): string {
  return [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    'const counter = process.argv[2];',
    'let count = 0;',
    'try { count = Number(readFileSync(counter, "utf8")); } catch {}',
    'count += 1;',
    'writeFileSync(counter, String(count), "utf8");',
    `process.exit(${redWhen} ? 1 : 0);`,
    '',
  ].join('\n');
}

/** A check that always exits 0. */
export const GREEN_CHECK: readonly string[] = [process.execPath, '-e', 'process.exit(0)'];

export interface RunFixture {
  /** The temporary parent directory every path below is under. */
  readonly parent: string;
  /** The source repository: a real Git repository with one commit. */
  readonly source: string;
  /** Where the config's `workDir` resolves to: `<parent>/out`. */
  readonly outDir: string;
  readonly configPath: string;
  readonly taskPath: string;
  /** The file a probe would append to, and the probe command itself. */
  readonly sentinel: string;
  readonly probe: string;
  /** Every coding turn the run asked for, in order. */
  readonly calls: AgentTurnRequest[];
  /** The substitution to hand the CLI: a coding turn that changes nothing. */
  readonly dependencies: Partial<RunnerDependencies>;
}

/**
 * A fixture with everything a real run needs: a clean source repository, a
 * configuration whose `workDir` resolves from the configuration file's directory,
 * a task file, and a probe that would record having run.
 */
export async function createRunFixture(
  parts: {
    /** Configuration fields to replace; the fixture's own values are kept. */
    readonly config?: Record<string, unknown>;
    /** Where the configuration file goes. Defaults to the fixture parent. */
    readonly configDirectory?: string;
    /** What the coding turn does. Defaults to recording the request and changing nothing. */
    readonly agent?: RunnerDependencies['runAgentTurn'];
  } = {},
): Promise<RunFixture> {
  return ownFixtureOperation('createRunFixture setup', async () => {
    const parent = await createTempDir();
    const outDir = path.join(parent, 'out');
    const sentinel = path.join(parent, 'sentinel.txt');
    const probe = path.join(parent, 'probe.cjs');
    await writeFile(probe, PROBE_SOURCE, 'utf8');

    // The fixture's fields, routed to the file that owns each of them: the
    // project's own commands are committed in the repository a run clones, and
    // the Nexus-wide settings live beside it.
    const { harness, project } = splitConfig({
      workDir: './out',
      maxRepairs: 2,
      taskTimeoutMinutes: 30,
      commandTimeoutMinutes: 5,
      setup: [],
      checks: [GREEN_CHECK],
      ...parts.config,
    } as JsonObject);
    const source = await createSourceRepository(parent, project);

    const calls: AgentTurnRequest[] = [];
    const agent: RunnerDependencies['runAgentTurn'] =
      parts.agent ??
      (async (request) => {
        calls.push(request);
        return { summary: 'the fixture turn changed nothing' };
      });

    const configDirectory = parts.configDirectory ?? parent;
    await mkdir(configDirectory, { recursive: true });
    const configPath = await writeJsonFile(configDirectory, HARNESS_CONFIG_FILE_NAME, harness);
    const taskPath = await writeJsonFile(parent, 'task.json', documentedTask);

    return {
      parent,
      source,
      outDir,
      configPath,
      taskPath,
      sentinel,
      probe,
      calls,
      dependencies: { runAgentTurn: agent },
    };
  });
}

/** The argv of a run from `cwd`, with every path given relative to it. */
export function runArgv(parts: {
  readonly repo: string;
  readonly config: string;
  readonly task: string;
}): string[] {
  return ['run', '--repo', parts.repo, '--config', parts.config, '--task', parts.task];
}

/** The one run directory under an output directory, and the report it holds. */
export async function readRun(outDir: string): Promise<{ runDir: string; report: RunReport }> {
  const runsRoot = path.join(outDir, 'runs');
  const entries = (await readdir(runsRoot)).sort();
  expect(entries, `${outDir} holds exactly one run directory`).toHaveLength(1);
  const [only = ''] = entries;
  const runDir = path.join(runsRoot, only);
  const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as RunReport;
  return { runDir, report };
}

/** Interrupt signals a test owns: it records the handler, and can call it. */
export interface RecordingSignals extends InterruptSignals {
  /** How many handlers the CLI installed. */
  registered: number;
  /** How many times the CLI released them again. */
  released: number;
  /** Calls the installed handler, as a delivered signal would. */
  interrupt(): void;
}

export function recordingSignals(): RecordingSignals {
  let handler: (() => void) | null = null;
  const signals: RecordingSignals = {
    registered: 0,
    released: 0,
    onInterrupt: (one) => {
      handler = one;
      signals.registered += 1;
      return () => {
        handler = null;
        signals.released += 1;
      };
    },
    interrupt: () => {
      if (handler === null) {
        throw new Error('this test interrupted a run that had installed no handler');
      }
      handler();
    },
  };
  return signals;
}
