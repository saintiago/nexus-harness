import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE, runCli } from '../src/cli.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  documentedTask,
  repoRoot,
  writeJsonFile,
} from './support.js';

afterEach(cleanupTempDirectories);

interface CliResult {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in-process with captured output. */
async function run(argv: readonly string[], cwd: string = repoRoot): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in a real process, exercising the entry point guard. */
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

describe('help', () => {
  for (const argv of [[], ['--help'], ['-h'], ['check-config', '--help'], ['run', '--help']]) {
    it(`prints help and succeeds for: ${argv.join(' ') || '(no arguments)'}`, async () => {
      const result = await run(argv);

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('Usage:');
      expect(result.out).toContain('check-config');
      expect(result.err).toBe('');
    });
  }
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

  it('accepts the --option=value form', async () => {
    const { configPath, taskPath } = await writeInputs();

    const result = await run([`check-config`, `--config=${configPath}`, `--task=${taskPath}`]);

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

  it('creates nothing and runs no configured command', async () => {
    const directory = await createTempDir();
    const sentinel = path.join(directory, 'sentinel.txt');
    // Written as a file rather than passed to `--eval`, so the probe cannot run
    // by accident in this process; if check-config executed it, the sentinel would exist.
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

    const result = await run(['check-config', '--config', configPath, '--task', taskPath]);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(probe)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(path.join(directory, '.harness'))).toBe(false);
  });
});

describe('usage errors', () => {
  const rejections: Array<[name: string, argv: string[], problem: RegExp]> = [
    ['a missing --task', ['check-config', '--config', 'harness.config.json'], /--task/],
    ['a missing --config and --task', ['check-config'], /--config and --task/],
    ['an unknown command', ['deploy'], /unknown command "deploy"/],
    ['an unknown option', ['check-config', '--repo', '.'], /unknown option "--repo"/],
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
  ];

  for (const [name, argv, problem] of rejections) {
    it(`rejects ${name}`, async () => {
      const result = await run(argv);

      expect(result.code).toBe(EXIT_USAGE);
      expect(result.err).toMatch(problem);
      expect(result.out).toBe('');
    });
  }
});

describe('run', () => {
  it('refuses the unimplemented run command without touching its arguments', async () => {
    const result = await run([
      'run',
      '--repo',
      '../target-project',
      '--config',
      'harness.config.json',
      '--task',
      'examples/task.json',
    ]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toMatch(/not implemented/i);
    expect(result.err).not.toMatch(/unknown option/);
    expect(result.out).toBe('');
  });
});

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
