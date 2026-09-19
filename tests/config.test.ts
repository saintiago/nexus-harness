import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  escalationTiers,
  loadHarnessConfig,
  loadTask,
  resolveWorkDir,
} from '../src/config/load.js';
import type { HarnessConfig, Task } from '../src/shared/types.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  documentedTask,
  repoRoot,
  writeJsonFile,
  type JsonObject,
} from './support.js';

afterEach(cleanupTempDirectories);

function configWith(overrides: JsonObject): JsonObject {
  return { ...documentedConfig, ...overrides };
}

function configWithout(key: keyof typeof documentedConfig): JsonObject {
  const copy: JsonObject = { ...documentedConfig };
  delete copy[key];
  return copy;
}

async function loadConfig(value: unknown): Promise<HarnessConfig> {
  const directory = await createTempDir();
  return loadHarnessConfig(await writeJsonFile(directory, 'harness.config.json', value));
}

async function loadTaskValue(value: unknown): Promise<Task> {
  const directory = await createTempDir();
  return loadTask(await writeJsonFile(directory, 'task.json', value));
}

/** Runs `load` expecting a {@link ConfigError}, and returns it. */
async function rejectionFrom(load: () => Promise<unknown>): Promise<ConfigError> {
  const cause = await load().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(cause instanceof ConfigError)) {
    throw new Error(`expected a ConfigError, received ${String(cause)}`);
  }
  return cause;
}

async function expectRejected(load: () => Promise<unknown>, ...problems: RegExp[]): Promise<void> {
  const error = await rejectionFrom(load);
  expect(error.problems.length).toBeGreaterThan(0);
  for (const problem of problems) {
    expect(error.message).toMatch(problem);
  }
}

describe('the checked-in examples', () => {
  it('accepts harness.config.json and examples/task.json unchanged', async () => {
    const config = await loadHarnessConfig(path.join(repoRoot, 'harness.config.json'));
    // The six required fields are the documented example's own values; the
    // optional agent object is this checkout's local launch, which is a Codex
    // invocation that names the native profile and the model it selects.
    const { agent, ...fields } = config;
    expect(fields).toEqual(documentedConfig);
    expect(agent).toEqual(config.agent);
    expect(config.agent.runtime).toBe('codex');
    expect(config.agent.command.slice(1)).toEqual([
      '--profile',
      'deepseek',
      '--model',
      'deepseek-flash',
    ]);
    expect(config.agent.command[0] ?? '').not.toBe('');

    const task = await loadTask(path.join(repoRoot, 'examples', 'task.json'));
    expect(task).toEqual(documentedTask);
  });
});

describe('file and JSON errors', () => {
  it('names the file it could not read', async () => {
    const directory = await createTempDir();
    const missing = path.join(directory, 'absent.json');

    const error = await rejectionFrom(() => loadHarnessConfig(missing));

    expect(error.file).toBe(missing);
    expect(error.message).toContain(missing);
    expect(error.message).toMatch(/cannot be read/);
  });

  it('names the file with malformed JSON', async () => {
    const directory = await createTempDir();
    const broken = path.join(directory, 'harness.config.json');
    await writeFile(broken, '{ "workDir": }', 'utf8');

    const error = await rejectionFrom(() => loadHarnessConfig(broken));

    expect(error.message).toContain(broken);
    expect(error.message).toMatch(/not valid JSON/);
  });

  it('applies the same reporting to a task file', async () => {
    const directory = await createTempDir();
    const broken = path.join(directory, 'task.json');
    await writeFile(broken, '[]', 'utf8');

    const error = await rejectionFrom(() => loadTask(broken));

    expect(error.message).toContain(broken);
  });
});

describe('configuration validation', () => {
  const rejections: Array<[name: string, value: JsonObject, problems: RegExp[]]> = [
    ['a missing required field', configWithout('maxRepairs'), [/maxRepairs/]],
    ['an unknown field', configWith({ extra: true }), [/Unrecognized key: "extra"/]],
    ['a null workDir', configWith({ workDir: null }), [/workDir/]],
    ['a blank workDir', configWith({ workDir: '   ' }), [/workDir must not be blank/]],
    ['a negative maxRepairs', configWith({ maxRepairs: -1 }), [/maxRepairs must be a nonnegative/]],
    ['a fractional maxRepairs', configWith({ maxRepairs: 1.5 }), [/maxRepairs must be an integer/]],
    ['a maxRepairs given as a string', configWith({ maxRepairs: '2' }), [/maxRepairs/]],
    [
      'a zero taskTimeoutMinutes',
      configWith({ taskTimeoutMinutes: 0 }),
      [/taskTimeoutMinutes must be a positive integer/],
    ],
    [
      'a negative commandTimeoutMinutes',
      configWith({ commandTimeoutMinutes: -5 }),
      [/commandTimeoutMinutes must be a positive integer/],
    ],
    ['an empty checks list', configWith({ checks: [] }), [/checks: must contain at least one/]],
    [
      'a check that is not a command array',
      configWith({ checks: ['npm test'] }),
      [/checks\[0\]: must be an array of string arguments/],
    ],
    ['a command with no executable', configWith({ checks: [[]] }), [/checks\[0\]/]],
    [
      'a blank executable',
      configWith({ checks: [['  ', 'test']] }),
      [/checks\[0\]\[0\]: the first item must be a nonblank executable/],
    ],
    ['a non-string argument', configWith({ checks: [[123]] }), [/checks\[0\]\[0\]/]],
    [
      'a setup entry that is not a command array',
      configWith({ setup: [{ cmd: 'npm' }] }),
      [/setup\[0\]: must be an array of string arguments/],
    ],
    ['an agent that is not an object', configWith({ agent: 'codex' }), [/agent:/]],
    ['a null agent', configWith({ agent: null }), [/agent:/]],
    [
      'an agent without a runtime',
      configWith({ agent: { command: ['codex'] } }),
      [/agent\.runtime/],
    ],
    ['an agent without a command', configWith({ agent: { runtime: 'codex' } }), [/agent\.command/]],
    [
      'an agent with an unknown field',
      configWith({ agent: { runtime: 'codex', command: ['codex'], provider: 'deepseek' } }),
      [/agent: Unrecognized key: "provider"/],
    ],
    [
      'an unsupported runtime',
      configWith({ agent: { runtime: 'claude', command: ['claude'] } }),
      [/agent\.runtime: must be "codex"/],
    ],
    [
      'a runtime that is not the implemented one spelled differently',
      configWith({ agent: { runtime: 'DeepSeek', command: ['codex'] } }),
      [/agent\.runtime/],
    ],
    [
      'an empty agent command',
      configWith({ agent: { runtime: 'codex', command: [] } }),
      [/agent\.command: must not be empty/],
    ],
    [
      'a blank agent executable',
      configWith({ agent: { runtime: 'codex', command: ['  ', '--profile', 'deepseek'] } }),
      [/agent\.command\[0\]: the first item must be a nonblank executable/],
    ],
    [
      'a non-string agent argument',
      configWith({ agent: { runtime: 'codex', command: ['codex', 7] } }),
      [/agent\.command\[1\]/],
    ],
  ];

  for (const [name, value, problems] of rejections) {
    it(`rejects ${name}`, async () => {
      await expectRejected(() => loadConfig(value), ...problems);
    });
  }

  it('reports every problem at once instead of the first', async () => {
    const error = await rejectionFrom(() =>
      loadConfig({ ...documentedConfig, maxRepairs: -1, checks: [] }),
    );

    expect(error.problems).toHaveLength(2);
    expect(error.message).toMatch(/maxRepairs/);
    expect(error.message).toMatch(/checks/);
  });

  it('accepts an empty setup list, which docs/WORKFLOW.md allows', async () => {
    const config = await loadConfig(configWith({ setup: [] }));
    expect(config.setup).toEqual([]);
  });

  it('keeps literal empty arguments rather than dropping them', async () => {
    const config = await loadConfig(configWith({ checks: [['npm', 'run', '--', '']] }));
    expect(config.checks).toEqual([['npm', 'run', '--', '']]);
  });
});

describe('the optional agent selection', () => {
  it('normalizes an omitted agent to the documented ordinary Codex launch', async () => {
    const config = await loadConfig(documentedConfig);

    // The default launch is a value like any other; it is not a fallback for a
    // selection that failed, and nothing else in the file can change it.
    expect(config.agent).toEqual({ runtime: 'codex', command: ['codex'] });
  });

  it('keeps an explicit profile and model prefix exactly as it was written', async () => {
    const command = [
      'codex',
      '--profile',
      'deepseek',
      '--model',
      'deepseek-v4-pro',
      '',
      'a literal argument with spaces',
    ];

    const config = await loadConfig(configWith({ agent: { runtime: 'codex', command } }));

    // Nothing is joined, reordered, expanded, or dropped: the harness does not
    // know which of these arguments are paths, and it does not guess.
    expect(config.agent).toEqual({ runtime: 'codex', command });
  });

  it('resolves a relative path-valued executable from the configuration file directory', async () => {
    const directory = await createTempDir();
    const nested = path.join(directory, 'inputs');
    const configPath = await writeJsonFile(
      nested,
      'harness.config.json',
      configWith({
        agent: {
          runtime: 'codex',
          command: [path.join('.', 'tools', 'codex-launcher.cmd'), '--profile', 'deepseek'],
        },
      }),
    );

    const config = await loadHarnessConfig(configPath);

    // Resolved once, against the file that named it, and the rest of the prefix
    // is left alone: its arguments are interpreted by the launched program.
    expect(config.agent.command).toEqual([
      path.join(nested, 'tools', 'codex-launcher.cmd'),
      '--profile',
      'deepseek',
    ]);
    expect(process.cwd()).not.toBe(nested);
  });

  it('keeps an absolute executable and a bare name as they were written', async () => {
    const directory = await createTempDir();
    const absolute = path.join(directory, 'elsewhere', 'codex.exe');

    const absoluteConfig = await loadConfig(
      configWith({ agent: { runtime: 'codex', command: [absolute, '--model', 'x'] } }),
    );
    expect(absoluteConfig.agent.command).toEqual([absolute, '--model', 'x']);

    // A bare name is not a path: the host launcher resolves it from PATH, as it
    // resolves the executable of any other configured command.
    const bareConfig = await loadConfig(
      configWith({ agent: { runtime: 'codex', command: ['codex', '--model', 'x'] } }),
    );
    expect(bareConfig.agent.command).toEqual(['codex', '--model', 'x']);
  });
});

describe('the optional escalation ladder', () => {
  it('is one rung built from agent and maxRepairs when none is declared', async () => {
    const config = await loadConfig(documentedConfig);

    expect(config.escalation).toBeUndefined();
    expect(escalationTiers(config)).toEqual([
      {
        name: 'default',
        agent: { runtime: 'codex', command: ['codex'] },
        maxRepairs: config.maxRepairs,
      },
    ]);
  });

  it('keeps a declared ladder in order, and a rung that names nothing inherits', async () => {
    const config = await loadConfig(
      configWith({
        agent: { runtime: 'codex', command: ['codex', '--profile', 'deepseek'] },
        maxRepairs: 1,
        escalation: [
          {
            name: 'flash',
            agent: { runtime: 'codex', command: ['codex', '--model', 'deepseek-flash'] },
            maxRepairs: 2,
          },
          { name: 'pro' },
        ],
      }),
    );

    expect(escalationTiers(config)).toEqual([
      {
        name: 'flash',
        agent: { runtime: 'codex', command: ['codex', '--model', 'deepseek-flash'] },
        maxRepairs: 2,
      },
      {
        name: 'pro',
        agent: { runtime: 'codex', command: ['codex', '--profile', 'deepseek'] },
        maxRepairs: 1,
      },
    ]);
  });

  it('rejects a ladder that is empty, unnamed, or ambiguous', async () => {
    await expectRejected(() => loadConfig(configWith({ escalation: [] })), /at least one tier/);
    await expectRejected(
      () => loadConfig(configWith({ escalation: [{ name: '  ' }] })),
      /escalation\[\]\.name/,
    );
    await expectRejected(
      () => loadConfig(configWith({ escalation: [{ name: 'pro' }, { name: 'pro' }] })),
      /distinct/,
    );
    await expectRejected(
      () => loadConfig(configWith({ escalation: [{ name: 'pro', maxRepairs: -1 }] })),
      /maxRepairs/,
    );
  });
});

describe('the optional delivery step', () => {
  const gitHub = {
    type: 'github',
    repository: 'example-owner/example-repo',
    baseBranch: 'main',
  };

  it('is absent when the configuration does not ask for it', async () => {
    const config = await loadConfig(documentedConfig);

    expect(config.delivery).toBeUndefined();
  });

  it('keeps the destination repository and base branch as they were written', async () => {
    const config = await loadConfig(configWith({ delivery: gitHub }));

    expect(config.delivery).toEqual(gitHub);
  });

  const rejections: Array<[name: string, value: unknown, problems: RegExp[]]> = [
    ['a delivery that is not an object', configWith({ delivery: 'github' }), [/delivery:/]],
    ['a null delivery', configWith({ delivery: null }), [/delivery:/]],
    [
      'a delivery without a type',
      configWith({ delivery: { repository: 'example-owner/example-repo', baseBranch: 'main' } }),
      [/delivery\.type/],
    ],
    [
      'an unsupported delivery type',
      configWith({ delivery: { ...gitHub, type: 'gitlab' } }),
      [/delivery\.type: must be "github"/],
    ],
    [
      'a repository given as a URL',
      configWith({ delivery: { ...gitHub, repository: 'https://github.com/example-owner/x' } }),
      [/delivery\.repository/],
    ],
    [
      'a repository without an owner',
      configWith({ delivery: { ...gitHub, repository: 'example-repo' } }),
      [/delivery\.repository/],
    ],
    [
      'a blank base branch',
      configWith({ delivery: { ...gitHub, baseBranch: '   ' } }),
      [/delivery\.baseBranch/],
    ],
    [
      'a base branch with whitespace',
      configWith({ delivery: { ...gitHub, baseBranch: 'release 1' } }),
      [/delivery\.baseBranch/],
    ],
    [
      'a base branch that starts with an option dash',
      configWith({ delivery: { ...gitHub, baseBranch: '--repo' } }),
      [/delivery\.baseBranch/],
    ],
    [
      'an unknown delivery field',
      configWith({ delivery: { ...gitHub, remote: 'somewhere' } }),
      [/delivery: Unrecognized key: "remote"/],
    ],
  ];

  for (const [name, value, problems] of rejections) {
    it(`rejects ${name}`, async () => {
      await expectRejected(() => loadConfig(value), ...problems);
    });
  }
});

describe('task validation', () => {
  function taskWith(overrides: JsonObject): JsonObject {
    return { ...documentedTask, ...overrides };
  }

  function taskWithout(key: keyof typeof documentedTask): JsonObject {
    const copy: JsonObject = { ...documentedTask };
    delete copy[key];
    return copy;
  }

  const rejections: Array<[name: string, value: JsonObject, problems: RegExp[]]> = [
    ['a missing title', taskWithout('title'), [/title/]],
    ['a missing id', taskWithout('id'), [/id/]],
    ['a blank title', taskWith({ title: '   ' }), [/title must not be blank/]],
    ['a blank description', taskWith({ description: '\n' }), [/description must not be blank/]],
    [
      'an empty acceptanceCriteria list',
      taskWith({ acceptanceCriteria: [] }),
      [/acceptanceCriteria: must contain at least one/],
    ],
    [
      'a blank acceptance criterion',
      taskWith({ acceptanceCriteria: ['fine', ' '] }),
      [/acceptanceCriteria\[1\]: acceptanceCriteria item must not be blank/],
    ],
    [
      'acceptanceCriteria that is not a list',
      taskWith({ acceptanceCriteria: 'x' }),
      [/acceptanceCriteria: must be an array of nonblank strings/],
    ],
    ['an unknown field', taskWith({ owner: 'someone' }), [/Unrecognized key: "owner"/]],
  ];

  for (const [name, value, problems] of rejections) {
    it(`rejects ${name}`, async () => {
      await expectRejected(() => loadTaskValue(value), ...problems);
    });
  }
});

describe('workDir resolution', () => {
  it('resolves a relative workDir from the configuration file directory', async () => {
    const directory = await createTempDir();
    const nested = path.join(directory, 'nested');
    const configPath = await writeJsonFile(
      nested,
      'harness.config.json',
      configWith({ workDir: './out' }),
    );

    const config = await loadHarnessConfig(configPath);

    // The point of the test: resolution must not depend on the process directory.
    expect(process.cwd()).not.toBe(nested);
    expect(resolveWorkDir(config, configPath)).toBe(path.join(nested, 'out'));
  });

  it('resolves a parent-relative workDir without leaving the config directory', async () => {
    const directory = await createTempDir();
    const nested = path.join(directory, 'nested');
    const configPath = await writeJsonFile(
      nested,
      'harness.config.json',
      configWith({ workDir: '../runs' }),
    );

    const config = await loadHarnessConfig(configPath);

    expect(resolveWorkDir(config, configPath)).toBe(path.join(directory, 'runs'));
  });

  it('keeps an absolute workDir as given', async () => {
    const directory = await createTempDir();
    const absolute = path.join(directory, 'elsewhere');
    const configPath = await writeJsonFile(
      directory,
      'harness.config.json',
      configWith({ workDir: absolute }),
    );

    const config = await loadHarnessConfig(configPath);

    expect(resolveWorkDir(config, configPath)).toBe(absolute);
  });
});
