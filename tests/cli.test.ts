/**
 * The command line: what it accepts, what it refuses, and what it prints.
 *
 * Help, the read-only configuration check, usage errors, path resolution, the color request and the entry-point guard as a real process — the parser and display layer, in process, with no repository and no child command behind it. The run-boundary cases live beside this file in tests/cli-run.integration.test.ts.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { colorAllowed } from '../src/cli.js';
import { EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/context.js';
import { preflightSource } from './fixtures/boundary-operations.js';
import {
  createTempDir,
  documentedConfig,
  documentedHarnessConfig,
  documentedTask,
  repoRoot,
  writeConfigPair,
  writeJsonFile,
} from './support.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';
import {
  run,
  writeInputs,
  checkConfigArgv,
  createRunFixture,
  readRun,
  recordingSignals,
  runArgv,
  runProcess,
  beginCliFixtureEnvironment,
} from './fixtures/cli.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';

useFixtureLifecycle();

beforeEach(beginCliFixtureEnvironment);

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

  it('composes two different projects with the same harness configuration', async () => {
    const directory = await createTempDir();
    const configPath = await writeJsonFile(directory, HARNESS_CONFIG_FILE_NAME, {
      ...documentedHarnessConfig,
      workDir: './.harness',
    });
    // One project per queue, each carrying its own repository and its own
    // commands, and sharing the one Nexus-wide file beside them.
    const first = await writeJsonFile(path.join(directory, 'first'), PROJECT_CONFIG_FILE_NAME, {
      setup: [],
      checks: [['node', '--version']],
      source: {
        type: 'jira',
        siteUrl: 'https://example.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'SAM1',
      },
      delivery: {
        type: 'github',
        repository: 'example-owner/first-project',
        baseBranch: 'main',
      },
    });
    const second = await writeJsonFile(path.join(directory, 'second'), PROJECT_CONFIG_FILE_NAME, {
      setup: [],
      checks: [
        ['npm', 'run', 'lint'],
        ['npm', 'test'],
      ],
      source: {
        type: 'jira',
        siteUrl: 'https://example.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'HARN',
      },
      delivery: {
        type: 'github',
        repository: 'example-owner/second-project',
        baseBranch: 'main',
      },
    });

    const firstRun = await run(
      checkConfigArgv({ config: configPath, project: path.dirname(first) }),
    );
    const secondRun = await run(
      checkConfigArgv({ config: configPath, project: path.dirname(second) }),
    );

    expect(firstRun.code).toBe(EXIT_OK);
    expect(secondRun.code).toBe(EXIT_OK);
    // Each project's own queue, repository, and commands, composed with the one
    // harness configuration's own values.
    expect(firstRun.out).toContain('project SAM1');
    expect(firstRun.out).toContain('github example-owner/first-project -> main');
    expect(firstRun.out).toContain('checks                 1 command');
    expect(secondRun.out).toContain('project HARN');
    expect(secondRun.out).toContain('github example-owner/second-project -> main');
    expect(secondRun.out).toContain('checks                 2 commands');
    for (const printed of [firstRun.out, secondRun.out]) {
      expect(printed).toContain(
        `maxRepairs             ${String(documentedHarnessConfig.maxRepairs)}`,
      );
      expect(printed).toContain(path.join(directory, '.harness'));
    }
  });
});

describe('check-config', () => {
  it('validates the checked-in examples and task file', async () => {
    const result = await run(
      checkConfigArgv({
        config: path.join('docs', 'nexus.config.example.json'),
        project: '.',
        task: path.join('examples', 'task.json'),
      }),
    );

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(path.join(repoRoot, '.harness'));
    // This repository's own project configuration, as it composes.
    expect(result.out).toContain('saintiago/nexus-harness');
    expect(result.out).toContain('example-001');
  });

  it('validates the two configurations on their own, without --task', async () => {
    const result = await run(
      checkConfigArgv({ config: path.join('docs', 'nexus.config.example.json'), project: '.' }),
    );

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(path.join(repoRoot, '.harness'));
    expect(result.out).not.toContain('acceptanceCriteria');
  });

  it('validates a source configuration without contacting it', async () => {
    const { directory, configPath } = await writeInputs({
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

    const result = await run(checkConfigArgv({ config: configPath, project: directory }));

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('example.atlassian.net');
    expect(result.out).toContain('NEXUS_CHECK_CONFIG_MUST_NOT_RESOLVE_THIS');
    // The documented default: Jira's own Priority field orders the queue.
    expect(result.out).toContain('source ordering');
    expect(result.out).toContain('priority: Jira priority DESC');
  });

  it('prints the configured intake order without contacting Jira', async () => {
    const { directory, configPath } = await writeInputs({
      ...documentedConfig,
      source: {
        type: 'jira',
        siteUrl: 'https://example.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'SAM1',
        tokenEnv: 'NEXUS_CHECK_CONFIG_MUST_NOT_RESOLVE_THIS',
        ordering: 'rank',
      },
    });

    const result = await run(checkConfigArgv({ config: configPath, project: directory }));

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('source ordering');
    expect(result.out).toContain('rank: Jira Rank ASC');
  });

  it('prints the delivery selection without contacting GitHub', async () => {
    const { directory, configPath } = await writeInputs({
      ...documentedConfig,
      delivery: {
        type: 'github',
        repository: 'example-owner/example-repo',
        baseBranch: 'main',
      },
    });

    const result = await run(checkConfigArgv({ config: configPath, project: directory }));

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('delivery');
    expect(result.out).toContain('example-owner/example-repo');
  });

  it('prints the composed completion selection without resolving its credential', async () => {
    const { directory, configPath } = await writeInputs({
      ...documentedConfig,
      source: {
        type: 'jira',
        siteUrl: 'https://example.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'SAM1',
        tokenEnv: 'NEXUS_CHECK_CONFIG_MUST_NOT_RESOLVE_THIS',
      },
      completion: {
        lensApp: 'nexus-lens',
        lensAppId: 123,
        lensCheckName: 'Nexus Lens',
        reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
      },
      delivery: {
        type: 'github',
        repository: 'example-owner/example-repo',
        baseBranch: 'main',
        completion: {
          postMergeWorkflows: ['ci.yml'],
          toDoStatus: 'To Do',
          doneStatus: 'Done',
        },
      },
    });

    const result = await run(checkConfigArgv({ config: configPath, project: directory }));

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
    const { directory, configPath, taskPath } = await writeInputs();

    const result = await run([
      'check-config',
      `--config=${configPath}`,
      `--project=${directory}`,
      `--task=${taskPath}`,
    ]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(configPath);
  });

  it('resolves workDir from the config file directory, not the invocation directory', async () => {
    const { directory, configPath, taskPath } = await writeInputs({
      ...documentedConfig,
      workDir: './out',
    });

    const result = await run(
      checkConfigArgv({ config: configPath, project: directory, task: taskPath }),
    );

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(path.join(directory, 'out'));
    expect(process.cwd()).not.toBe(directory);
  });

  it('reports an invalid configuration, naming the file and field', async () => {
    const { directory, configPath, taskPath } = await writeInputs({
      ...documentedConfig,
      maxRepairs: -1,
    });

    const result = await run(
      checkConfigArgv({ config: configPath, project: directory, task: taskPath }),
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toContain(configPath);
    expect(result.err).toMatch(/maxRepairs/);
    expect(result.out).toBe('');
  });

  it('reports an unreadable task file', async () => {
    const { directory, configPath } = await writeInputs();

    const result = await run(
      checkConfigArgv({
        config: configPath,
        project: directory,
        task: path.join(directory, 'absent.json'),
      }),
    );

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

    // Both configuration files, the probe included, live in the same directory:
    // whether check-config creates the output directory is what this proves.
    const { harnessPath: configPath, projectPath } = await writeConfigPair(directory, directory, {
      ...documentedConfig,
      workDir: './.harness',
      setup: [[process.execPath, probe]],
      checks: [[process.execPath, probe]],
    });
    const taskPath = await writeJsonFile(directory, 'task.json', documentedTask);

    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const signals = recordingSignals();
    const result = await run(
      checkConfigArgv({ config: configPath, project: directory, task: taskPath }),
      { signals },
    );

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(probe)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(path.join(directory, '.harness'))).toBe(false);
    expect(existsSync(projectPath)).toBe(true);
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
      ['run', '--config', 'nexus.config.json', '--task', 'examples/task.json'],
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
        config: '../nexus.config.json',
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
        'docs/nexus.config.example.json',
        '--project',
        '.',
        '--task',
        'examples/task.json',
      ],
      repoRoot,
    );

    expect(result.stderr).toBe('');
    expect(result.code).toBe(EXIT_OK);
  });

  it('exits 1 on invalid input', async () => {
    const { directory, configPath, taskPath } = await writeInputs({
      ...documentedConfig,
      checks: [],
    });

    const result = await runProcess(
      [
        '--import',
        'tsx',
        cli,
        ...checkConfigArgv({ config: configPath, project: directory, task: taskPath }),
      ],
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
