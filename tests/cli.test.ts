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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { colorAllowed, runCli } from '../src/cli.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/context.js';
import type { CliContext, CliTerminal, InterruptSignals } from '../src/cli/context.js';
import { ReportError } from '../src/reporting/errors.js';
import type { AgentTurnRequest, RunnerDependencies } from '../src/runs/contracts.js';
import type { AgentActivity, RunReport } from '../src/shared/types.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { preflightSource } from '../src/workspace/preflight.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  documentedTask,
  fakeConsole,
  repoRoot,
  screenAfter,
  writeJsonFile,
} from './support.js';

afterEach(cleanupTempDirectories);

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  out: string;
  err: string;
}

interface CliRunOptions {
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
async function run(argv: readonly string[], options: CliRunOptions = {}): Promise<CliResult> {
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

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in a real process, exercising the entry-point guard. */
function runProcess(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { cwd });
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

/** Writes a valid config and task pair into a fresh temporary directory. */
async function writeInputs(
  config: unknown = documentedConfig,
  task: unknown = documentedTask,
): Promise<{ directory: string; configPath: string; taskPath: string }> {
  const directory = await createTempDir();
  const configPath = await writeJsonFile(directory, 'harness.config.json', config);
  const taskPath = await writeJsonFile(directory, 'task.json', task);
  return { directory, configPath, taskPath };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits, bounded, for something a fixture recorded. Waiting for the condition
 * itself is what makes this honest: a fixed pause would be either flaky on a
 * loaded machine or dead time on an idle one, and neither is a test of anything.
 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`this test waited for ${what}, and it never happened`);
    }
    await pause(10);
  }
}

// ---------------------------------------------------------------------------
// A real source repository, and the files a run needs
// ---------------------------------------------------------------------------

/** A private Git environment, so the developer's own Git settings cannot decide a test. */
let fixtureEnvironment: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  fixtureEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Nexus CLI Test',
    GIT_AUTHOR_EMAIL: 'cli@example.test',
    GIT_COMMITTER_NAME: 'Nexus CLI Test',
    GIT_COMMITTER_EMAIL: 'cli@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
});

function runGit(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, env: fixtureEnvironment, windowsHide: true });
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

async function gitOrThrow(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} in ${cwd} exited ${String(result.code)}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/** A clean Git repository with one commit: the source a run starts from. */
async function createSourceRepository(parent: string, name = 'target-project'): Promise<string> {
  const repo = path.join(parent, name);
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# target project\n', 'utf8');
  await gitOrThrow(['init', '--quiet', '--initial-branch=main'], repo);
  await gitOrThrow(['add', '--all'], repo);
  await gitOrThrow(['commit', '--quiet', '--message', 'target: baseline'], repo);
  return repo;
}

/** A configured command that records that it ran. */
const PROBE_SOURCE = "require('node:fs').appendFileSync(process.argv[2], 'ran\\n');\n";

/**
 * A check that counts its own invocations in a file outside the working copy and
 * is red exactly when `redWhen` holds. The working copy is identical on every
 * round, so what the run reacts to is the fixture's own count — which is what
 * lets a test say exactly which round is green and which is red.
 */
function countingCheck(redWhen: string): string {
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
const GREEN_CHECK: readonly string[] = [process.execPath, '-e', 'process.exit(0)'];

interface RunFixture {
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
async function createRunFixture(
  parts: {
    /** Configuration fields to replace; the fixture's own values are kept. */
    readonly config?: Record<string, unknown>;
    /** Where the configuration file goes. Defaults to the fixture parent. */
    readonly configDirectory?: string;
    /** What the coding turn does. Defaults to recording the request and changing nothing. */
    readonly agent?: RunnerDependencies['runAgentTurn'];
  } = {},
): Promise<RunFixture> {
  const parent = await createTempDir();
  const source = await createSourceRepository(parent);
  const outDir = path.join(parent, 'out');
  const sentinel = path.join(parent, 'sentinel.txt');
  const probe = path.join(parent, 'probe.cjs');
  await writeFile(probe, PROBE_SOURCE, 'utf8');

  const calls: AgentTurnRequest[] = [];
  const agent: RunnerDependencies['runAgentTurn'] =
    parts.agent ??
    (async (request) => {
      calls.push(request);
      return { summary: 'the fixture turn changed nothing' };
    });

  const configDirectory = parts.configDirectory ?? parent;
  await mkdir(configDirectory, { recursive: true });
  const configPath = await writeJsonFile(configDirectory, 'harness.config.json', {
    workDir: './out',
    maxRepairs: 2,
    taskTimeoutMinutes: 30,
    commandTimeoutMinutes: 5,
    setup: [],
    checks: [GREEN_CHECK],
    ...parts.config,
  });
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
}

/** The argv of a run from `cwd`, with every path given relative to it. */
function runArgv(parts: {
  readonly repo: string;
  readonly config: string;
  readonly task: string;
}): string[] {
  return ['run', '--repo', parts.repo, '--config', parts.config, '--task', parts.task];
}

/** The one run directory under an output directory, and the report it holds. */
async function readRun(outDir: string): Promise<{ runDir: string; report: RunReport }> {
  const runsRoot = path.join(outDir, 'runs');
  const entries = (await readdir(runsRoot)).sort();
  expect(entries, `${outDir} holds exactly one run directory`).toHaveLength(1);
  const [only = ''] = entries;
  const runDir = path.join(runsRoot, only);
  const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as RunReport;
  return { runDir, report };
}

/** Interrupt signals a test owns: it records the handler, and can call it. */
interface RecordingSignals extends InterruptSignals {
  /** How many handlers the CLI installed. */
  registered: number;
  /** How many times the CLI released them again. */
  released: number;
  /** Calls the installed handler, as a delivered signal would. */
  interrupt(): void;
}

function recordingSignals(): RecordingSignals {
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

// ---------------------------------------------------------------------------
// Help, and the static command
// ---------------------------------------------------------------------------

describe('help', () => {
  for (const argv of [[], ['--help'], ['-h'], ['check-config', '--help'], ['run', '--help']]) {
    it(`prints help and succeeds for: ${argv.join(' ') || '(no arguments)'}`, async () => {
      const result = await run(argv);

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('Usage:');
      expect(result.out).toContain('check-config');
      // Both commands are named, so the help is not stale about what exists.
      expect(result.out).toMatch(/^\s+run\s+Run a task/m);
      expect(result.out).toMatch(/^\s+130\s/m);
      expect(result.err).toBe('');
    });
  }

  it('installs no signal handler and creates nothing', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const signals = recordingSignals();

    const result = await run(['--help'], { signals });

    expect(result.code).toBe(EXIT_OK);
    expect(signals.registered).toBe(0);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

describe('check-config', () => {
  it('validates the checked-in config and task files', async () => {
    const result = await run([
      'check-config',
      '--config',
      'harness.config.json',
      '--task',
      'examples/task.json',
    ]);

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(path.join(repoRoot, '.harness'));
    expect(result.out).toContain('example-001');
  });

  it('validates a configuration on its own, without --task', async () => {
    const result = await run(['check-config', '--config', 'harness.config.json']);

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(path.join(repoRoot, '.harness'));
    expect(result.out).not.toContain('acceptanceCriteria');
  });

  it('validates a source configuration without contacting it', async () => {
    const { configPath } = await writeInputs({
      ...documentedConfig,
      source: {
        type: 'jira',
        siteUrl: 'https://example.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'SAM1',
        // A source command would refuse this unset variable; check-config must
        // never look for it, so the name is one nothing sets in practice.
        tokenEnv: 'NEXUS_CHECK_CONFIG_MUST_NOT_RESOLVE_THIS',
      },
    });

    const result = await run(['check-config', '--config', configPath]);

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('example.atlassian.net');
    expect(result.out).toContain('NEXUS_CHECK_CONFIG_MUST_NOT_RESOLVE_THIS');
  });

  it('prints the delivery selection without contacting GitHub', async () => {
    const { configPath } = await writeInputs({
      ...documentedConfig,
      delivery: {
        type: 'github',
        repository: 'example-owner/example-repo',
        baseBranch: 'main',
      },
    });

    const result = await run(['check-config', '--config', configPath]);

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('delivery');
    expect(result.out).toContain('example-owner/example-repo');
  });

  it('prints the completion selection without resolving the reviewer credential', async () => {
    const { configPath } = await writeInputs({
      ...documentedConfig,
      source: {
        type: 'jira',
        siteUrl: 'https://example.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'SAM1',
        tokenEnv: 'NEXUS_CHECK_CONFIG_MUST_NOT_RESOLVE_THIS',
      },
      delivery: {
        type: 'github',
        repository: 'example-owner/example-repo',
        baseBranch: 'main',
        completion: {
          lensApp: 'nexus-lens',
          lensAppId: 123,
          lensCheckName: 'Nexus Lens',
          reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
          postMergeWorkflows: ['ci.yml'],
          toDoStatus: 'To Do',
          doneStatus: 'Done',
        },
      },
    });

    const result = await run(['check-config', '--config', configPath]);

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('delivery completion');
    expect(result.out).toContain('App 123');
    expect(result.out).toContain('Nexus Lens');
    expect(result.out).toContain('NEXUS_LENS_TOKEN');
    expect(result.out).toContain('ci.yml');
    expect(result.out).toContain('verified -> Done');
  });

  it('accepts the --option=value form', async () => {
    const { configPath, taskPath } = await writeInputs();

    const result = await run(['check-config', `--config=${configPath}`, `--task=${taskPath}`]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(configPath);
  });

  it('resolves workDir from the config file directory, not the invocation directory', async () => {
    const { directory, configPath, taskPath } = await writeInputs({
      ...documentedConfig,
      workDir: './out',
    });

    const result = await run(['check-config', '--config', configPath, '--task', taskPath]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(path.join(directory, 'out'));
    expect(process.cwd()).not.toBe(directory);
  });

  it('reports an invalid configuration, naming the file and field', async () => {
    const { configPath, taskPath } = await writeInputs({
      ...documentedConfig,
      maxRepairs: -1,
    });

    const result = await run(['check-config', '--config', configPath, '--task', taskPath]);

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toContain(configPath);
    expect(result.err).toMatch(/maxRepairs/);
    expect(result.out).toBe('');
  });

  it('reports an unreadable task file', async () => {
    const { directory, configPath } = await writeInputs();

    const result = await run([
      'check-config',
      '--config',
      configPath,
      '--task',
      path.join(directory, 'absent.json'),
    ]);

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/cannot be read/);
  });

  it('creates nothing, runs no configured command, and needs no credentials', async () => {
    const directory = await createTempDir();
    const sentinel = path.join(directory, 'sentinel.txt');
    // Written as a file rather than passed to `--eval`, so the probe cannot run
    // by accident in this process: if check-config executed it, the sentinel
    // would exist.
    const probe = path.join(directory, 'probe.cjs');
    await writeFile(
      probe,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`,
      'utf8',
    );

    const configPath = await writeJsonFile(directory, 'harness.config.json', {
      ...documentedConfig,
      workDir: './.harness',
      setup: [[process.execPath, probe]],
      checks: [[process.execPath, probe]],
    });
    const taskPath = await writeJsonFile(directory, 'task.json', documentedTask);

    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const signals = recordingSignals();
    const result = await run(['check-config', '--config', configPath, '--task', taskPath], {
      signals,
    });

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(probe)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(path.join(directory, '.harness'))).toBe(false);
    // Nothing static installs a way to stop a run, because it starts none.
    expect(signals.registered).toBe(0);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

describe('usage errors', () => {
  const rejections: Array<[name: string, argv: string[], problem: RegExp]> = [
    ['a check-config with no --config', ['check-config'], /--config/],
    ['an unknown command', ['deploy'], /unknown command "deploy"/],
    ['an unknown option', ['check-config', '--repo', '.'], /unknown option "--repo"/],
    ['a --limit on check-config', ['check-config', '--limit', '1'], /unknown option "--limit"/],
    ['a leading option instead of a command', ['--config', 'x'], /unknown option "--config"/],
    [
      'a repeated option',
      ['check-config', '--config', 'a.json', '--config', 'b.json'],
      /"--config" was given more than once/,
    ],
    ['an option with no value', ['check-config', '--config'], /requires a path value/],
    [
      'an option followed by another option',
      ['check-config', '--config', '--task'],
      /requires a path value/,
    ],
    ['an empty inline value', ['check-config', '--config='], /requires a path value/],
    ['a valued help flag', ['check-config', '--help=1'], /does not take a value/],
    ['a run with no options at all', ['run'], /--repo, --config and --task/],
    [
      'a run without --repo',
      ['run', '--config', 'harness.config.json', '--task', 'examples/task.json'],
      /--repo/,
    ],
    [
      'an unknown run option',
      ['run', '--repo', '.', '--config', 'a.json', '--task', 'b.json', '--json'],
      /unknown option "--json"/,
    ],
    ['a run option with no value', ['run', '--repo'], /requires a path value/],
    ['a source with no subcommand', ['source'], /source requires one of: list, run, watch/],
    ['an unknown source subcommand', ['source', 'deploy'], /unknown source command "deploy"/],
    ['a source list without --config', ['source', 'list'], /--config/],
    ['a source run without --repo', ['source', 'run', '--config', 'a.json'], /--repo/],
    ['a source watch without --repo', ['source', 'watch', '--config', 'a.json'], /--repo/],
    [
      'a --task on a source command',
      ['source', 'list', '--config', 'a.json', '--task', 'b.json'],
      /unknown option "--task"/,
    ],
    [
      'a --limit outside source run',
      ['source', 'watch', '--repo', '.', '--config', 'a.json', '--limit', '1'],
      /unknown option "--limit"/,
    ],
    [
      'a zero --limit',
      ['source', 'run', '--repo', '.', '--config', 'a.json', '--limit', '0'],
      /positive integer/,
    ],
    [
      'a non-numeric --limit',
      ['source', 'run', '--repo', '.', '--config', 'a.json', '--limit', 'many'],
      /positive integer/,
    ],
  ];

  for (const [name, argv, problem] of rejections) {
    it(`rejects ${name}`, async () => {
      const result = await run(argv);

      expect(result.code).toBe(EXIT_USAGE);
      expect(result.err).toMatch(problem);
      expect(result.out).toBe('');
    });
  }

  it('refuses a run whose command line is wrong without reading anything', async () => {
    const fixture = await createRunFixture();

    const result = await run(['run', '--repo', fixture.source, '--bogus'], {
      cwd: fixture.parent,
      dependencies: fixture.dependencies,
    });

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toMatch(/unknown option "--bogus"/);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.outDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The paths a run resolves
// ---------------------------------------------------------------------------

describe('run path resolution', () => {
  it('resolves CLI paths from the invocation directory and workDir from the config directory', async () => {
    // The configuration sits beside the source, the command is run from a third
    // directory, and every argument is relative to where it was invoked.
    const fixture = await createRunFixture();
    const elsewhere = path.join(fixture.parent, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const seen: Array<{ repoPath: string; workDir: string }> = [];

    const result = await run(
      runArgv({
        repo: '../target-project',
        config: '../harness.config.json',
        task: '../task.json',
      }),
      {
        cwd: elsewhere,
        dependencies: {
          ...fixture.dependencies,
          preflight: async (request) => {
            seen.push({ repoPath: request.repoPath, workDir: request.workDir });
            return preflightSource(request);
          },
        },
      },
    );

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    // CLI paths: resolved against the directory the command was run from.
    expect(seen[0]?.repoPath).toBe(fixture.source);
    // workDir: resolved against the directory the configuration file is in.
    expect(seen[0]?.workDir).toBe(fixture.outDir);

    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect(result.out).toContain(`run dir    ${runDir}`);
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);
  });

  it('follows the same rules when the source, the config, and the invocation differ', async () => {
    // Three separate directories: the source's parent, the configuration's own
    // directory, and the directory the command is run from. The run is placed by
    // the rules, not by where this command happened to be started.
    const configDirectory = path.join(await createTempDir(), 'configs');
    const fixture = await createRunFixture({ configDirectory });
    const elsewhere = path.join(fixture.parent, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const seen: Array<{ repoPath: string; workDir: string }> = [];

    const result = await run(
      runArgv({
        repo: fixture.source,
        config: fixture.configPath,
        task: fixture.taskPath,
      }),
      {
        cwd: elsewhere,
        dependencies: {
          ...fixture.dependencies,
          preflight: async (request) => {
            seen.push({ repoPath: request.repoPath, workDir: request.workDir });
            return preflightSource(request);
          },
        },
      },
    );

    expect(result.code).toBe(EXIT_OK);
    expect(seen[0]?.repoPath).toBe(fixture.source);
    // `workDir: './out'` resolves beside the configuration file, which is
    // neither the invocation directory nor the source repository's parent.
    expect(seen[0]?.workDir).toBe(path.join(configDirectory, 'out'));
    expect(existsSync(path.join(fixture.parent, 'out'))).toBe(false);
    const { report } = await readRun(path.join(configDirectory, 'out'));
    expect(report.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// What a run does, and what it refuses to do
// ---------------------------------------------------------------------------

describe('run', () => {
  it('runs a task, reports the pass, and keeps the working copy and the report', async () => {
    const fixture = await createRunFixture();

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);

    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect(report.repairsUsed).toBe(0);
    expect(report.task).toEqual({ id: documentedTask.id, title: documentedTask.title });
    // The agent's own account of its turn is kept, and is not what decided the run.
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.agentSummary).toBe('the fixture turn changed nothing');
    expect(report.attempts[0]?.checks?.outcome).toBe('passed');

    // Progress, then the outcome: the status, why, the repairs used, and where
    // the run kept everything.
    expect(result.out).toMatch(/^baseline check-round result: passed$/m);
    expect(result.out).toMatch(/^implementation turn started$/m);
    expect(result.out).toContain(`run ${report.runId}: passed`);
    expect(result.out).toContain('reason     every configured check passed');
    expect(result.out).toContain('repairs    0 of 2 repair turns used');
    expect(result.out).toContain(`run dir    ${runDir}`);
    expect(result.out).toContain(
      `workspace  ${path.join(path.dirname(path.dirname(runDir)), 'workspaces', path.basename(runDir))}`,
    );
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);
    expect(result.out).toMatch(/^review warning: /m);

    // The coding turn was asked once, for the implementation, in the run's own
    // working copy, with the task as it was loaded.
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.kind).toBe('implementation');
    expect(fixture.calls[0]?.turn).toBe(1);
    expect(fixture.calls[0]?.task).toEqual(documentedTask);
    expect(fixture.calls[0]?.workspacePath).toBe(
      path.join(path.dirname(path.dirname(runDir)), 'workspaces', path.basename(runDir)),
    );
    expect(fixture.calls[0]?.sourceRoot).toBe(fixture.source);
  });

  it('ignores a configured source: no credential, no intake state, no provenance', async () => {
    const fixture = await createRunFixture({
      config: {
        source: {
          type: 'jira',
          siteUrl: 'https://example.atlassian.net',
          cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
          projectKey: 'SAM1',
          // A name nothing sets: a file-task run must not look for it at all.
          tokenEnv: 'NEXUS_FILE_RUN_MUST_NOT_READ_THIS',
        },
      },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    const { report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect('sourceRef' in report).toBe(false);
    expect(existsSync(path.join(fixture.outDir, '.intake'))).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it('repairs a red round and reports the repair it used', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'sequenced-check.cjs');
    // Green on the first run (the baseline), red on the second (after the
    // implementation), green again on the third (after the repair).
    await writeFile(check, countingCheck('count === 2'), 'utf8');
    const fixture = await createRunFixture({
      config: { maxRepairs: 1, checks: [[process.execPath, check, counter]] },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_OK);
    const { report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[1]?.kind).toBe('repair');
    expect(result.out).toContain('repairs    1 of 1 repair turns used');

    // The repair turn was told what the red round observed, and the checks really
    // ran three times, in the run's own working copy.
    const repair = fixture.calls[1];
    expect(repair?.turn).toBe(2);
    expect(repair?.repair?.repairedTurn).toBe(1);
    expect(repair?.repair?.failures).toHaveLength(1);
    expect(repair?.repair?.failures[0]?.result.exitCode).toBe(1);
    expect(await readFile(counter, 'utf8')).toBe('3');
  });

  it('reports a failure without claiming a success', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'always-red-check.cjs');
    // Green for the baseline, red from then on, and no repair allowance.
    await writeFile(check, countingCheck('count >= 2'), 'utf8');
    const fixture = await createRunFixture({
      config: { maxRepairs: 0, checks: [[process.execPath, check, counter]] },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('failed');
    expect(result.out).toContain(`run ${report.runId}: failed`);
    expect(result.out).not.toMatch(/^run \S+: passed$/m);
    expect(result.out).toContain('the repair allowance is exhausted');
    expect(result.out).toContain('repairs    0 of 0 repair turns used');
    // The report exists and is named; it is a failed run, not a missing one.
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);
  });

  it('keeps the loaded inputs fixed while the working copy rewrites them', async () => {
    const fixture = await createRunFixture({
      agent: async (request) => {
        fixture.calls.push(request);
        // What the target project does to the two input files while a run is in
        // progress: nothing it writes can change which commands decide the run.
        await writeJsonFile(fixture.parent, 'harness.config.json', {
          workDir: './out',
          maxRepairs: 2,
          taskTimeoutMinutes: 30,
          commandTimeoutMinutes: 5,
          setup: [],
          checks: [[process.execPath, '-e', 'process.exit(1)']],
        });
        await writeJsonFile(fixture.parent, 'task.json', {
          ...documentedTask,
          id: 'rewritten-001',
          title: 'Rewritten while the run was in progress',
        });
        return { summary: 'rewrote the inputs' };
      },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    // The run still ended on the plan it loaded, and still names the task it was
    // asked for: a re-read config would have made the post-agent round red.
    expect(result.code).toBe(EXIT_OK);
    const { report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect(report.task).toEqual({ id: documentedTask.id, title: documentedTask.title });
  });

  it('reports a preparation failure as a failed run that kept its evidence', async () => {
    const fixture = await createRunFixture();

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: {
          ...fixture.dependencies,
          prepareWorkspace: async () => {
            throw new WorkspaceError('the fixture refused to prepare a working copy');
          },
        },
      },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toBe('');
    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('failed');
    expect(report.workspace.prepared).toBe(false);
    expect(report.workspace.problem).toMatch(/refused to prepare a working copy/);
    expect(result.out).toContain(`run ${report.runId}: failed`);
    expect(result.out).toContain('workspace  no working copy was prepared');
    expect(result.out).toContain(`run dir    ${runDir}`);
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);
    // No coding turn is invented for a run that never had a working copy.
    expect(fixture.calls).toEqual([]);
  });

  it('reports a report-write failure, keeps the run, and never claims the report', async () => {
    const fixture = await createRunFixture();

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: {
          ...fixture.dependencies,
          writeRunReport: async (request) => {
            throw new ReportError(
              `the report "${path.join(request.run.runDir, 'result.json')}" could not be written: the disk is full`,
            );
          },
        },
      },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    const runsRoot = path.join(fixture.outDir, 'runs');
    const entries = await readdir(runsRoot);
    expect(entries).toHaveLength(1);
    const runDir = path.join(runsRoot, entries[0] ?? '');

    // The failure is named, with the location the run was kept in...
    expect(result.err).toMatch(/could not be reported/);
    expect(result.err).toMatch(/the disk is full/);
    expect(result.err).toContain(runDir);
    // ...and nothing anywhere says the run finished, or that a report exists.
    expect(result.out).not.toMatch(/^run run-\S+: /m);
    expect(result.out).not.toMatch(/result\.json/);
    expect(existsSync(path.join(runDir, 'result.json'))).toBe(false);
    // What the run did produce is still there to inspect.
    expect(existsSync(path.join(runDir, 'logs', 'run.log'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The activity pane under the run status
// ---------------------------------------------------------------------------

/**
 * A coding turn that reports synthetic activity, as the real adapter reports
 * what a runtime is doing: one message, one command, and its result.
 */
function reportingAgent(): RunnerDependencies['runAgentTurn'] {
  const activities: readonly AgentActivity[] = [
    { kind: 'message', text: 'I will change one file.' },
    { kind: 'command', text: 'npm test' },
    { kind: 'result', text: 'exit 1' },
  ];
  return async (request) => {
    for (const activity of activities) {
      request.onActivity?.(activity);
    }
    return { summary: 'the file now holds the new line' };
  };
}

describe('the activity pane under the run status', () => {
  it('draws the activity in a pane, and takes the pane away before the outcome', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    const raw = console.chunks.join('');
    // What the turn reported was drawn into the pane, in place: the cursor
    // moves of a bounded pane are in the stream, and the lines are there.
    expect(raw).toContain('agent: I will change one file.');
    expect(raw).toContain('run: npm test');
    expect(raw).toContain('result: exit 1');
    expect(raw).toContain('\u001b[');

    // The outcome is what is left on screen: closing erased the pane, so the
    // terminal holds the run's progress and the outcome block, and the last
    // thing printed is where the report is.
    const { runDir, report } = await readRun(fixture.outDir);
    const screen = screenAfter(console.chunks);
    expect(screen.some((line) => line.includes('I will change one file.'))).toBe(false);
    expect(screen).toContain('implementation turn started');
    expect(screen.join('\n')).toMatch(new RegExp(`^run ${report.runId}: passed$`, 'm'));
    expect(screen.at(-1)).toBe(`  report     ${path.join(runDir, 'result.json')}`);
  });

  it('writes ordinary activity lines, with no cursor sequences, when redirected', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} run: npm test$/m);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} agent: I will change one file\.$/m);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} result: exit 1$/m);
    expect(`${result.out}${result.err}`).not.toContain('\u001b');
  });

  it('stamps and highlights what the pane draws, in the stream the terminal saw', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    const raw = console.chunks.join('');
    // The message carries the local time it reached the viewer, the highlight,
    // and the reset that ends it inside the same line.
    // eslint-disable-next-line no-control-regex
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} \u001b\[33magent: I will change one file\.\u001b\[0m/);
    // Work lines are stamped the same way and stay in the terminal's own color.
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} run: npm test\n/);
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} result: exit 1\n/);
  });

  it('draws the pane with no styling at all when the terminal asks for no color', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });
    const console = fakeConsole({ columns: 80, rows: 24, color: false });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    const raw = console.chunks.join('');
    // The pane still redraws in place, and each line still says when it arrived;
    // only the styling is gone.
    expect(raw).toContain('\u001b[');
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} agent: I will change one file\.\n/);
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/\u001b\[[0-9;]*m/);
  });

  it('keeps the task, the phase, and the model on screen without the startup inventory', async () => {
    const fixture = await createRunFixture({
      config: {
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
      },
      agent: reportingAgent(),
    });
    const console = fakeConsole({ columns: 100, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    // The interactive view carries the task, the phase, and the selected model.
    const screen = screenAfter(console.chunks);
    expect(screen.join('\n')).toMatch(/^run \S+ started: task "example-001" /m);
    expect(screen).toContain('agent: runtime codex, model deepseek-flash');
    expect(screen).toContain('implementation turn started');
    // The useful path stays; the inventory a reader does not need — the launch
    // prefix, the deadline timestamp, the revision, the branch and base commit,
    // the commit identity — is left to the run log.
    const shown = screen.join('\n');
    for (const inventory of [
      'launch prefix',
      'task deadline set for',
      'immutable id',
      ' on branch ',
      'Git identity',
      'revision ',
    ]) {
      expect(shown, `the interactive view still shows "${inventory}"`).not.toContain(inventory);
    }
    expect(screen.some((line) => line.startsWith('workspace prepared at '))).toBe(true);

    // What the run wrote to its own timeline is untouched by the presentation.
    const { runDir } = await readRun(fixture.outDir);
    const timeline = await readFile(path.join(runDir, 'logs', 'run.log'), 'utf8');
    expect(timeline).toContain(
      'agent selected: runtime codex, launch prefix ["codex","--profile","nexus-flash","--model","deepseek-flash"]',
    );
    expect(timeline).toContain('task deadline set for');
    expect(timeline).toContain('workspace Git identity configured:');
    expect(timeline).toContain('workspace prepared at');
  });

  it('shows a repair turn’s activity through the same pane', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'sequenced-check.cjs');
    // Green for the baseline, red after the implementation, green after the
    // repair: the run really spends one repair turn.
    await writeFile(check, countingCheck('count === 2'), 'utf8');
    const turns: number[] = [];
    const fixture = await createRunFixture({
      config: { maxRepairs: 1, checks: [[process.execPath, check, counter]] },
      agent: async (request) => {
        turns.push(request.turn);
        request.onActivity?.({ kind: 'message', text: `turn ${String(request.turn)} reporting` });
        return { summary: null };
      },
    });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    expect(turns).toEqual([1, 2]);
    const raw = console.chunks.join('');
    expect(raw).toContain('agent: turn 1 reporting');
    expect(raw).toContain('agent: turn 2 reporting');
    // The pane is drawn under the progress and taken away at the end, whichever
    // turn reported last.
    expect(screenAfter(console.chunks).some((line) => line.startsWith('agent: turn '))).toBe(false);
    expect(result.err).toBe('');
  });

  it('takes the pane away before the outcome of a failed run, too', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'always-red-check.cjs');
    // Green for the baseline, red from then on, with no repair allowance.
    await writeFile(check, countingCheck('count >= 2'), 'utf8');
    const fixture = await createRunFixture({
      config: { maxRepairs: 0, checks: [[process.execPath, check, counter]] },
      agent: reportingAgent(),
    });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    const { runDir, report } = await readRun(fixture.outDir);
    const screen = screenAfter(console.chunks);
    expect(report.status).toBe('failed');
    expect(screen.some((line) => line.includes('I will change one file.'))).toBe(false);
    expect(screen.join('\n')).toMatch(new RegExp(`^run ${report.runId}: failed$`, 'm'));
    expect(screen.join('\n')).toContain(`run dir    ${runDir}`);
    expect(screen.join('\n')).toContain(`report     ${path.join(runDir, 'result.json')}`);
  });

  it('leaves a usable screen behind an interrupt, with the outcome and its paths', async () => {
    const signals = recordingSignals();
    const fixture = await createRunFixture({
      agent: async (request) => {
        request.onActivity?.({ kind: 'message', text: 'still working' });
        await new Promise<void>((resolve) => {
          if (request.stop.aborted) {
            resolve();
            return;
          }
          request.stop.addEventListener('abort', () => resolve(), { once: true });
        });
        return { summary: null };
      },
    });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const running = run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        signals,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );
    await waitFor(() => console.chunks.join('').includes('agent: still working'), 'the pane line');
    signals.interrupt();
    const result = await running;

    expect(result.code).toBe(EXIT_CANCELLED);
    expect(result.err).toMatch(/interrupt received: asking the run to stop/);

    const { runDir, report } = await readRun(fixture.outDir);
    const screen = screenAfter(console.chunks);
    expect(screen.some((line) => line.includes('still working'))).toBe(false);
    expect(screen.join('\n')).toMatch(new RegExp(`^run ${report.runId}: cancelled$`, 'm'));
    expect(screen.join('\n')).toContain(`run dir    ${runDir}`);
    expect(screen.join('\n')).toContain(`report     ${path.join(runDir, 'result.json')}`);
  });
});

describe('the terminal’s color request', () => {
  it('reads only a set, non-empty NO_COLOR as a request for no color', () => {
    expect(colorAllowed({})).toBe(true);
    expect(colorAllowed({ NO_COLOR: '' })).toBe(true);
    expect(colorAllowed({ NO_COLOR: '1' })).toBe(false);
    expect(colorAllowed({ NO_COLOR: 'false' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refusals that must happen before anything runs
// ---------------------------------------------------------------------------

describe('run refusals', () => {
  it('refuses an invalid configuration before starting anything', async () => {
    const fixture = await createRunFixture();
    await writeJsonFile(fixture.parent, 'harness.config.json', {
      ...documentedConfig,
      maxRepairs: -1,
      workDir: './out',
      setup: [[process.execPath, fixture.probe, fixture.sentinel]],
      checks: [[process.execPath, fixture.probe, fixture.sentinel]],
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toContain(path.join(fixture.parent, 'harness.config.json'));
    expect(result.err).toMatch(/maxRepairs/);
    expect(result.out).toBe('');
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('refuses a task file that is not valid JSON before starting anything', async () => {
    const fixture = await createRunFixture();
    await writeFile(path.join(fixture.parent, 'task.json'), '{ "id": "example-001", }', 'utf8');

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/is not valid JSON/);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('refuses a dirty source repository without running any command or turn', async () => {
    const fixture = await createRunFixture();
    // A probe the run would have to execute to make its sentinel appear: it is
    // configured here, and it must never get the chance to run.
    const probeConfig = {
      workDir: './out',
      maxRepairs: 2,
      taskTimeoutMinutes: 30,
      commandTimeoutMinutes: 5,
      setup: [[process.execPath, fixture.probe, fixture.sentinel]],
      checks: [[process.execPath, fixture.probe, fixture.sentinel]],
    };
    await writeJsonFile(fixture.parent, 'harness.config.json', probeConfig);
    await writeFile(path.join(fixture.source, 'uncommitted.txt'), 'work in progress\n', 'utf8');

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/is not a clean checkout/);
    expect(result.err).toContain('uncommitted.txt');
    expect(result.out).toBe('');
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('refuses an output directory inside the source repository', async () => {
    const fixture = await createRunFixture();
    // The configuration stays outside the source so the checkout is clean, and
    // points its output at a directory inside it.
    const configPath = await writeJsonFile(fixture.parent, 'overlap.config.json', {
      workDir: './target-project/runs',
      maxRepairs: 2,
      taskTimeoutMinutes: 30,
      commandTimeoutMinutes: 5,
      setup: [],
      checks: [GREEN_CHECK],
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'overlap.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/lies inside it/);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(path.join(fixture.source, 'runs'))).toBe(false);
    expect(existsSync(configPath)).toBe(true);
  });

  it('refuses a source that is not a repository', async () => {
    const fixture = await createRunFixture();
    await mkdir(path.join(fixture.parent, 'not-a-repository'), { recursive: true });

    const result = await run(
      runArgv({ repo: 'not-a-repository', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/is not inside a Git repository/);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.outDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

/** How long a fixture turn waits for a stop that a failing test never sends. */
const TURN_BACKSTOP_MS = 15_000;

/**
 * A coding turn that runs until the run it belongs to is stopped, and records
 * whether it saw that stop. It is the collaborator a real interrupt has to reach.
 */
function waitingAgent(marks: {
  started: boolean;
  sawStop: boolean;
}): RunnerDependencies['runAgentTurn'] {
  return async (request) => {
    marks.started = true;
    await new Promise<void>((resolve) => {
      if (request.stop.aborted) {
        marks.sawStop = true;
        resolve();
        return;
      }
      // The backstop exists only so that a test which fails before it interrupts
      // cannot leave this turn waiting until the run's own deadline: it is never
      // what ends a passing test.
      const backstop = setTimeout(() => {
        resolve();
      }, TURN_BACKSTOP_MS);
      backstop.unref();
      request.stop.addEventListener(
        'abort',
        () => {
          clearTimeout(backstop);
          marks.sawStop = true;
          resolve();
        },
        { once: true },
      );
    });
    return { summary: null };
  };
}

describe('interrupts', () => {
  it('cancels the run, waits for it to finalize, and exits 130', async () => {
    const marks = { started: false, sawStop: false };
    const fixture = await createRunFixture({ agent: waitingAgent(marks) });
    const signals = recordingSignals();

    const running = run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, signals, dependencies: fixture.dependencies },
    );

    // The run is inside its coding turn, which is what an interrupt arrives on.
    await waitFor(() => marks.started, 'started the coding turn');
    expect(signals.registered).toBe(1);
    signals.interrupt();
    const result = await running;

    // The stop reached the run's own cancellation path, not a second mechanism.
    expect(marks.sawStop).toBe(true);
    expect(result.code).toBe(EXIT_CANCELLED);
    expect(result.err).toMatch(/interrupt received: asking the run to stop/);
    expect(result.out).toContain('cancelled');

    // The CLI waited for the run to finalize: the report is there, it says the
    // run was cancelled, and it says where that happened.
    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('cancelled');
    expect(report.cancellation?.phase).toBe('implementation turn');
    expect(result.out).toContain(`run ${report.runId}: cancelled`);
    expect(result.out).toContain(`run dir    ${runDir}`);
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);

    // Nothing is left installed once the run is over.
    expect(signals.released).toBe(1);
  });

  it('exits 130 and creates nothing when the stop arrives before any run directory', async () => {
    const fixture = await createRunFixture();
    // An interrupt that arrives before the run has allocated anything: the run
    // is refused rather than reported, because there is nothing to report.
    const signals: InterruptSignals = {
      onInterrupt: (handler) => {
        handler();
        return () => undefined;
      },
    };

    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, signals, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_CANCELLED);
    expect(result.err).toMatch(/cancelled: the run was stopped by its caller/);
    expect(result.err).toMatch(/before any run directory was allocated/);
    expect(result.out).toBe('');
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('installs a signal handler for the duration of a run, and releases it after', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const during: number[] = [];
    const fixture = await createRunFixture({
      agent: async () => {
        during.push(process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'));
        return { summary: null };
      },
    });

    // No signals seam: this uses the real one, so the counts below are the
    // process's own signal listeners, installed by the CLI and nothing else.
    const result = await run(
      runArgv({ repo: 'target-project', config: 'harness.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_OK);
    const [sigs = 0, terms = 0] = before;
    expect(during).toEqual([sigs + 1, terms + 1]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The real process
// ---------------------------------------------------------------------------

describe('as a process', () => {
  const cli = path.join(repoRoot, 'src', 'cli.ts');

  it('prints help and exits 0', async () => {
    const result = await runProcess(['--import', 'tsx', cli, '--help'], repoRoot);

    expect(result.stdout).toContain('Usage:');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(EXIT_OK);
  });

  it('validates the checked-in files and exits 0', async () => {
    const result = await runProcess(
      [
        '--import',
        'tsx',
        cli,
        'check-config',
        '--config',
        'harness.config.json',
        '--task',
        'examples/task.json',
      ],
      repoRoot,
    );

    expect(result.stderr).toBe('');
    expect(result.code).toBe(EXIT_OK);
  });

  it('exits 1 on invalid input', async () => {
    const { configPath, taskPath } = await writeInputs({ ...documentedConfig, checks: [] });

    const result = await runProcess(
      ['--import', 'tsx', cli, 'check-config', '--config', configPath, '--task', taskPath],
      repoRoot,
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.stderr).toMatch(/checks/);
  });

  it('exits 2 on a usage error', async () => {
    const result = await runProcess(['--import', 'tsx', cli, 'check-config'], repoRoot);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/--config/);
  });
});
