/**
 * The configuration contract: two files with disjoint ownership, composed into
 * the effective configuration every command runs on (docs/WORKFLOW.md §1).
 *
 * The tests below are grouped by what they prove: what each file may contain,
 * what each file is refused for carrying, what the two must supply to each
 * other, and that one harness configuration really does serve two different
 * connected projects.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  escalationTiers,
  loadConfiguration,
  loadTask,
  resolveWorkDir,
} from '../src/config/load.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';
import type { HarnessConfig, Task } from '../src/shared/types.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  documentedHarnessConfig,
  documentedProjectConfig,
  documentedTask,
  repoRoot,
  writeConfigPair,
  writeJsonFile,
  type JsonObject,
} from './support.js';

afterEach(cleanupTempDirectories);

/** One field map, written as the two files that own its fields. */
async function loadConfig(fields: JsonObject = documentedConfig): Promise<HarnessConfig> {
  const directory = await createTempDir();
  const { harnessPath, projectPath } = await writeConfigPair(directory, directory, fields);
  return (await loadConfiguration(harnessPath, projectPath)).config;
}

/** One harness configuration, beside the documented project configuration. */
async function loadHarness(value: unknown): Promise<HarnessConfig> {
  const directory = await createTempDir();
  const harnessPath = await writeJsonFile(directory, HARNESS_CONFIG_FILE_NAME, value);
  const projectPath = await writeJsonFile(
    directory,
    PROJECT_CONFIG_FILE_NAME,
    documentedProjectConfig,
  );
  return (await loadConfiguration(harnessPath, projectPath)).config;
}

/** One project configuration, beside the documented harness configuration. */
async function loadProject(value: unknown): Promise<HarnessConfig> {
  const directory = await createTempDir();
  const harnessPath = await writeJsonFile(
    directory,
    HARNESS_CONFIG_FILE_NAME,
    documentedHarnessConfig,
  );
  const projectPath = await writeJsonFile(directory, PROJECT_CONFIG_FILE_NAME, value);
  return (await loadConfiguration(harnessPath, projectPath)).config;
}

function harnessWith(overrides: JsonObject): JsonObject {
  return { ...documentedHarnessConfig, ...overrides };
}

function projectWith(overrides: JsonObject): JsonObject {
  return { ...documentedProjectConfig, ...overrides };
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
  it('composes the harness and project examples this repository carries', async () => {
    const harnessPath = path.join(repoRoot, 'docs', 'nexus.config.example.json');
    const projectPath = path.join(repoRoot, PROJECT_CONFIG_FILE_NAME);
    const loaded = await loadConfiguration(harnessPath, projectPath);

    // The Nexus-wide example's own fields.
    expect(loaded.harness.maxRepairs).toBe(2);
    expect(loaded.harness.taskTimeoutMinutes).toBe(60);
    expect(loaded.harness.commandTimeoutMinutes).toBe(10);
    expect(loaded.harness.escalation?.map((tier) => tier.name)).toEqual(['flash', 'astra']);
    expect(loaded.harness.reviewer?.app.login).toBe('nexus-lens[bot]');
    expect(loaded.harness.completion?.reviewerTokenEnv).toBe('NEXUS_LENS_TOKEN');

    // The launch prefixes are applied as written: a bare `codex` name stays
    // bare, for the host launcher's own PATH resolution.
    expect(loaded.config.agent.command[0]).toBe('codex');
    expect(loaded.config.agent.command.slice(1)).toEqual([
      '--profile',
      'nexus-flash',
      '--model',
      'deepseek-flash',
    ]);
    expect(escalationTiers(loaded.config).map((tier) => tier.name)).toEqual(['flash', 'astra']);
    expect(loaded.config.workDir).toBe('../.harness');

    // This repository's own project configuration, as it composes.
    expect(loaded.project.source?.projectKey).toBe('HARN');
    expect(loaded.project.delivery?.repository).toBe('saintiago/nexus-harness');
    expect(loaded.config.setup).toEqual([['npm', 'ci']]);
    expect(loaded.config.checks).toEqual([['npm', 'run', 'validate']]);
    expect(loaded.config.review).toMatchObject({
      type: 'github',
      repository: 'saintiago/nexus-harness',
      checkName: 'Nexus Lens review',
      app: { appId: 5001141, installationId: 163007360, login: 'nexus-lens[bot]' },
    });
    expect(loaded.config.delivery?.completion?.postMergeWorkflows).toEqual(['ci.yml']);
    expect(loaded.config.delivery?.completion?.doneStatus).toBe('Done');

    const task = await loadTask(path.join(repoRoot, 'examples', 'task.json'));
    expect(task).toEqual(documentedTask);
  });
});

describe('file and JSON errors', () => {
  it('names the harness file it could not read, and what was expected of it', async () => {
    const directory = await createTempDir();
    const missing = path.join(directory, 'absent.json');
    const projectPath = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );

    const error = await rejectionFrom(() => loadConfiguration(missing, projectPath));

    expect(error.file).toBe(missing);
    expect(error.message).toContain(missing);
    expect(error.message).toMatch(/cannot be read/);
    expect(error.message).toContain(HARNESS_CONFIG_FILE_NAME);
  });

  it('names the project file it could not read, and where one belongs', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      documentedHarnessConfig,
    );
    const missing = path.join(directory, 'connected-project', PROJECT_CONFIG_FILE_NAME);

    const error = await rejectionFrom(() => loadConfiguration(harnessPath, missing));

    expect(error.file).toBe(missing);
    expect(error.message).toContain(missing);
    expect(error.message).toMatch(/cannot be read/);
    expect(error.message).toContain(PROJECT_CONFIG_FILE_NAME);
  });

  it('names the harness file with malformed JSON', async () => {
    const directory = await createTempDir();
    const broken = path.join(directory, HARNESS_CONFIG_FILE_NAME);
    await writeFile(broken, '{ "workDir": }', 'utf8');
    const projectPath = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );

    const error = await rejectionFrom(() => loadConfiguration(broken, projectPath));

    expect(error.message).toContain(broken);
    expect(error.message).toMatch(/not valid JSON/);
  });

  it('names the project file with malformed JSON', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      documentedHarnessConfig,
    );
    const broken = path.join(directory, PROJECT_CONFIG_FILE_NAME);
    await writeFile(broken, '{ "setup": }', 'utf8');

    const error = await rejectionFrom(() => loadConfiguration(harnessPath, broken));

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

describe('which file owns which field', () => {
  it('refuses a project field in the harness configuration, naming the project file', async () => {
    const projectFields: JsonObject = {
      setup: documentedProjectConfig.setup,
      checks: documentedProjectConfig.checks,
      source: {
        type: 'jira',
        siteUrl: 'https://example.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'SAM1',
      },
      delivery: { type: 'github', repository: 'owner/name', baseBranch: 'main' },
    };
    for (const [field, value] of Object.entries(projectFields)) {
      const error = await rejectionFrom(() => loadHarness(harnessWith({ [field]: value })));
      expect(error.message).toContain(field);
      expect(error.message).toContain(PROJECT_CONFIG_FILE_NAME);
      expect(error.message).toMatch(/belongs to the project configuration/);
    }
  });

  it('refuses a Nexus-wide field in the project configuration, naming the harness file', async () => {
    for (const field of [
      'workDir',
      'maxRepairs',
      'taskTimeoutMinutes',
      'commandTimeoutMinutes',
      'agent',
      'escalation',
      'reviewer',
      'completion',
    ]) {
      const error = await rejectionFrom(() => loadProject(projectWith({ [field]: 'anything' })));
      expect(error.message).toContain(field);
      expect(error.message).toMatch(/belongs to the Nexus-wide harness configuration/);
      expect(error.message).toContain('--config');
    }
  });

  it('refuses a combined single-file configuration instead of falling back to it', async () => {
    // The retired shape: one file carrying both files' fields. It is read as
    // the harness configuration and refused for every project field it carries,
    // rather than silently composed or defaulted.
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, HARNESS_CONFIG_FILE_NAME, documentedConfig);
    const projectPath = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );

    const error = await rejectionFrom(() => loadConfiguration(harnessPath, projectPath));

    expect(error.problems).toHaveLength(2);
    expect(error.message).toMatch(/setup: /);
    expect(error.message).toMatch(/checks: /);
  });
});

describe('harness configuration validation', () => {
  function harnessWithout(key: keyof typeof documentedHarnessConfig): JsonObject {
    const copy: JsonObject = { ...documentedHarnessConfig };
    delete copy[key];
    return copy;
  }

  const rejections: Array<[name: string, value: JsonObject, problems: RegExp[]]> = [
    ['a missing required field', harnessWithout('maxRepairs'), [/maxRepairs/]],
    ['an unknown field', harnessWith({ extra: true }), [/Unrecognized key: "extra"/]],
    ['a null workDir', harnessWith({ workDir: null }), [/workDir/]],
    ['a blank workDir', harnessWith({ workDir: '   ' }), [/workDir must not be blank/]],
    [
      'a negative maxRepairs',
      harnessWith({ maxRepairs: -1 }),
      [/maxRepairs must be a nonnegative/],
    ],
    [
      'a fractional maxRepairs',
      harnessWith({ maxRepairs: 1.5 }),
      [/maxRepairs must be an integer/],
    ],
    ['a maxRepairs given as a string', harnessWith({ maxRepairs: '2' }), [/maxRepairs/]],
    [
      'a zero taskTimeoutMinutes',
      harnessWith({ taskTimeoutMinutes: 0 }),
      [/taskTimeoutMinutes must be a positive integer/],
    ],
    [
      'a negative commandTimeoutMinutes',
      harnessWith({ commandTimeoutMinutes: -5 }),
      [/commandTimeoutMinutes must be a positive integer/],
    ],
    ['an agent that is not an object', harnessWith({ agent: 'codex' }), [/agent:/]],
    ['a null agent', harnessWith({ agent: null }), [/agent:/]],
    ['an agent without a runtime', harnessWith({ agent: { command: ['codex'] } }), [/agent\.runtime/]],
    [
      'an agent without a command',
      harnessWith({ agent: { runtime: 'codex' } }),
      [/agent\.command/],
    ],
    [
      'an agent with an unknown field',
      harnessWith({ agent: { runtime: 'codex', command: ['codex'], provider: 'deepseek' } }),
      [/agent: Unrecognized key: "provider"/],
    ],
    [
      'an unsupported runtime',
      harnessWith({ agent: { runtime: 'claude', command: ['claude'] } }),
      [/agent\.runtime: must be "codex"/],
    ],
    [
      'a runtime that is not the implemented one spelled differently',
      harnessWith({ agent: { runtime: 'DeepSeek', command: ['codex'] } }),
      [/agent\.runtime/],
    ],
    [
      'an empty agent command',
      harnessWith({ agent: { runtime: 'codex', command: [] } }),
      [/agent\.command: must not be empty/],
    ],
    [
      'a blank agent executable',
      harnessWith({ agent: { runtime: 'codex', command: ['  ', '--profile', 'deepseek'] } }),
      [/agent\.command\[0\]: the first item must be a nonblank executable/],
    ],
    [
      'a non-string agent argument',
      harnessWith({ agent: { runtime: 'codex', command: ['codex', 7] } }),
      [/agent\.command\[1\]/],
    ],
  ];

  for (const [name, value, problems] of rejections) {
    it(`rejects ${name}`, async () => {
      await expectRejected(() => loadHarness(value), ...problems);
    });
  }

  it('reports every problem at once instead of the first', async () => {
    const error = await rejectionFrom(() =>
      loadHarness(harnessWith({ maxRepairs: -1, taskTimeoutMinutes: 0 })),
    );

    expect(error.problems).toHaveLength(2);
    expect(error.message).toMatch(/maxRepairs/);
    expect(error.message).toMatch(/taskTimeoutMinutes/);
  });
});

describe('project configuration validation', () => {
  function projectWithout(key: keyof typeof documentedProjectConfig): JsonObject {
    const copy: JsonObject = { ...documentedProjectConfig };
    delete copy[key];
    return copy;
  }

  const rejections: Array<[name: string, value: JsonObject, problems: RegExp[]]> = [
    ['a missing setup list', projectWithout('setup'), [/setup/]],
    ['a missing checks list', projectWithout('checks'), [/checks/]],
    ['an unknown field', projectWith({ extra: true }), [/Unrecognized key: "extra"/]],
    ['an empty checks list', projectWith({ checks: [] }), [/checks: must contain at least one/]],
    [
      'a check that is not a command array',
      projectWith({ checks: ['npm test'] }),
      [/checks\[0\]: must be an array of string arguments/],
    ],
    ['a command with no executable', projectWith({ checks: [[]] }), [/checks\[0\]/]],
    [
      'a blank executable',
      projectWith({ checks: [['  ', 'test']] }),
      [/checks\[0\]\[0\]: the first item must be a nonblank executable/],
    ],
    ['a non-string argument', projectWith({ checks: [[123]] }), [/checks\[0\]\[0\]/]],
    [
      'a setup entry that is not a command array',
      projectWith({ setup: [{ cmd: 'npm' }] }),
      [/setup\[0\]: must be an array of string arguments/],
    ],
  ];

  for (const [name, value, problems] of rejections) {
    it(`rejects ${name}`, async () => {
      await expectRejected(() => loadProject(value), ...problems);
    });
  }

  it('reports every problem at once instead of the first', async () => {
    const error = await rejectionFrom(() =>
      loadProject(projectWith({ setup: 'npm ci', checks: [] })),
    );

    expect(error.problems).toHaveLength(2);
    expect(error.message).toMatch(/setup/);
    expect(error.message).toMatch(/checks/);
  });

  it('accepts an empty setup list, which docs/WORKFLOW.md allows', async () => {
    const config = await loadProject(projectWith({ setup: [] }));
    expect(config.setup).toEqual([]);
  });

  it('keeps literal empty arguments rather than dropping them', async () => {
    const config = await loadProject(projectWith({ checks: [['npm', 'run', '--', '']] }));
    expect(config.checks).toEqual([['npm', 'run', '--', '']]);
  });
});

describe('the optional agent selection', () => {
  it('normalizes an omitted agent to the documented ordinary Codex launch', async () => {
    const config = await loadConfig(documentedConfig);

    // The default launch is a value like any other; it is not a fallback for a
    // selection that failed, and nothing in either file can change it.
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

    const config = await loadHarness(harnessWith({ agent: { runtime: 'codex', command } }));

    // Nothing is joined, reordered, expanded, or dropped: the harness does not
    // know which of these arguments are paths, and it does not guess.
    expect(config.agent).toEqual({ runtime: 'codex', command });
  });

  it('resolves a relative path-valued executable from the harness file directory', async () => {
    const directory = await createTempDir();
    const nested = path.join(directory, 'inputs');
    const harnessPath = await writeJsonFile(
      nested,
      HARNESS_CONFIG_FILE_NAME,
      harnessWith({
        agent: {
          runtime: 'codex',
          command: [path.join('.', 'tools', 'codex-launcher.cmd'), '--profile', 'deepseek'],
        },
      }),
    );
    const projectPath = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );

    const config = (await loadConfiguration(harnessPath, projectPath)).config;

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

    const absoluteConfig = await loadHarness(
      harnessWith({ agent: { runtime: 'codex', command: [absolute, '--model', 'x'] } }),
    );
    expect(absoluteConfig.agent.command).toEqual([absolute, '--model', 'x']);

    // A bare name is not a path: the host launcher resolves it from PATH, as it
    // resolves the executable of any other configured command.
    const bareConfig = await loadHarness(
      harnessWith({ agent: { runtime: 'codex', command: ['codex', '--model', 'x'] } }),
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
    const config = await loadHarness(
      harnessWith({
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
    await expectRejected(() => loadHarness(harnessWith({ escalation: [] })), /at least one tier/);
    await expectRejected(
      () => loadHarness(harnessWith({ escalation: [{ name: '  ' }] })),
      /escalation\[\]\.name/,
    );
    await expectRejected(
      () => loadHarness(harnessWith({ escalation: [{ name: 'pro' }, { name: 'pro' }] })),
      /distinct/,
    );
    await expectRejected(
      () => loadHarness(harnessWith({ escalation: [{ name: 'pro', maxRepairs: -1 }] })),
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

  it('is absent when the project configuration does not ask for it', async () => {
    const config = await loadProject(documentedProjectConfig);

    expect(config.delivery).toBeUndefined();
  });

  it('keeps the destination repository and base branch as they were written', async () => {
    const config = await loadProject(projectWith({ delivery: gitHub }));

    expect(config.delivery).toEqual(gitHub);
  });

  const rejections: Array<[name: string, value: unknown, problems: RegExp[]]> = [
    ['a delivery that is not an object', projectWith({ delivery: 'github' }), [/delivery:/]],
    ['a null delivery', projectWith({ delivery: null }), [/delivery:/]],
    [
      'a delivery without a type',
      projectWith({ delivery: { repository: 'example-owner/example-repo', baseBranch: 'main' } }),
      [/delivery\.type/],
    ],
    [
      'an unsupported delivery type',
      projectWith({ delivery: { ...gitHub, type: 'gitlab' } }),
      [/delivery\.type: must be "github"/],
    ],
    [
      'a repository given as a URL',
      projectWith({ delivery: { ...gitHub, repository: 'https://github.com/example-owner/x' } }),
      [/delivery\.repository/],
    ],
    [
      'a repository without an owner',
      projectWith({ delivery: { ...gitHub, repository: 'example-repo' } }),
      [/delivery\.repository/],
    ],
    [
      'a blank base branch',
      projectWith({ delivery: { ...gitHub, baseBranch: '   ' } }),
      [/delivery\.baseBranch/],
    ],
    [
      'a base branch with whitespace',
      projectWith({ delivery: { ...gitHub, baseBranch: 'release 1' } }),
      [/delivery\.baseBranch/],
    ],
    [
      'a base branch that starts with an option dash',
      projectWith({ delivery: { ...gitHub, baseBranch: '--repo' } }),
      [/delivery\.baseBranch/],
    ],
    [
      'an unknown delivery field',
      projectWith({ delivery: { ...gitHub, remote: 'somewhere' } }),
      [/delivery: Unrecognized key: "remote"/],
    ],
  ];

  for (const [name, value, problems] of rejections) {
    it(`rejects ${name}`, async () => {
      await expectRejected(() => loadProject(value), ...problems);
    });
  }
});

describe('composing two files', () => {
  const JIRA = {
    type: 'jira',
    siteUrl: 'https://example.atlassian.net',
    cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
    projectKey: 'SAM1',
    tokenEnv: 'JIRA_API_TOKEN',
  };
  const REVIEWER = {
    app: {
      appId: 5001141,
      installationId: 163007360,
      privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
      login: 'nexus-lens[bot]',
    },
    reviewer: { runtime: 'codex', command: ['codex', '--profile', 'nexus-astra'] },
  };
  const COMPLETION = {
    lensApp: 'nexus-lens[bot]',
    lensAppId: 5001141,
    lensCheckName: 'Nexus Lens review',
    reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
  };

  /** One connected project: its Jira queue and its GitHub destination. */
  function connectedProject(
    jiraProjectKey: string,
    repository: string,
    workflows: readonly string[],
  ): JsonObject {
    return projectWith({
      source: { ...JIRA, projectKey: jiraProjectKey },
      delivery: {
        type: 'github',
        repository,
        baseBranch: 'main',
        completion: { postMergeWorkflows: workflows, toDoStatus: 'To Do', doneStatus: 'Done' },
      },
    });
  }

  it('composes two project configurations with one harness configuration', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      harnessWith({ reviewer: REVIEWER, completion: COMPLETION }),
    );
    const firstPath = await writeJsonFile(
      path.join(directory, 'first'),
      PROJECT_CONFIG_FILE_NAME,
      connectedProject('SAM1', 'owner/first', ['first.yml']),
    );
    const secondPath = await writeJsonFile(
      path.join(directory, 'second'),
      PROJECT_CONFIG_FILE_NAME,
      connectedProject('HARN', 'owner/second', ['second.yml', 'second-nightly.yml']),
    );

    const first = (await loadConfiguration(harnessPath, firstPath)).config;
    const second = (await loadConfiguration(harnessPath, secondPath)).config;

    // What each project owns differs, and comes from that project's own file.
    expect(first.source?.projectKey).toBe('SAM1');
    expect(second.source?.projectKey).toBe('HARN');
    expect(first.delivery?.repository).toBe('owner/first');
    expect(second.delivery?.repository).toBe('owner/second');
    expect(first.delivery?.completion?.postMergeWorkflows).toEqual(['first.yml']);
    expect(second.delivery?.completion?.postMergeWorkflows).toEqual([
      'second.yml',
      'second-nightly.yml',
    ]);
    // A review belongs to the repository its own project delivers to.
    expect(first.review?.repository).toBe('owner/first');
    expect(second.review?.repository).toBe('owner/second');

    // What the harness configuration owns is the same in both, once composed.
    expect(first.agent).toEqual(second.agent);
    expect(first.workDir).toBe(second.workDir);
    expect(first.maxRepairs).toBe(second.maxRepairs);
    expect(first.review?.app).toEqual(second.review?.app);
    expect(first.review?.reviewer).toEqual(second.review?.reviewer);
    expect(first.review?.checkName).toBe('Nexus Lens review');
    expect(first.delivery?.completion?.reviewerTokenEnv).toBe('NEXUS_LENS_TOKEN');
    expect(first.delivery?.completion?.doneStatus).toBe('Done');
    // Both took the harness configuration's own polling defaults.
    expect(first.delivery?.completion?.pollIntervalSeconds).toBe(30);
    expect(second.delivery?.completion?.pollIntervalSeconds).toBe(30);
  });

  it('composes the reviewer identity and the completion policy consistently', async () => {
    await expectRejected(
      () =>
        loadHarness(
          harnessWith({ reviewer: REVIEWER, completion: { ...COMPLETION, lensAppId: 999 } }),
        ),
      /completion/,
    );
    await expectRejected(
      () =>
        loadHarness(
          harnessWith({
            reviewer: REVIEWER,
            completion: { ...COMPLETION, lensCheckName: 'Something else' },
          }),
        ),
      /completion/,
    );
  });

  it('refuses a Nexus-wide reviewer that the project cannot support', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      harnessWith({ reviewer: REVIEWER }),
    );
    const localOnly = await writeJsonFile(
      path.join(directory, 'local-only'),
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );
    const connectionOnly = await writeJsonFile(
      path.join(directory, 'connection-only'),
      PROJECT_CONFIG_FILE_NAME,
      projectWith({ source: JIRA }),
    );

    const localError = await rejectionFrom(() => loadConfiguration(harnessPath, localOnly));
    expect(localError.file).toBe(localOnly);
    expect(localError.message).toMatch(/source: /);
    expect(localError.message).toMatch(/delivery: /);
    expect(localError.message).toContain(harnessPath);

    const partialError = await rejectionFrom(() => loadConfiguration(harnessPath, connectionOnly));
    expect(partialError.message).toMatch(/delivery: /);
    expect(partialError.message).not.toMatch(/source: /);
  });

  it('refuses a project completion the harness configuration cannot gate', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      documentedHarnessConfig,
    );
    const projectPath = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      connectedProject('SAM1', 'owner/first', ['first.yml']),
    );

    const error = await rejectionFrom(() => loadConfiguration(harnessPath, projectPath));

    expect(error.file).toBe(harnessPath);
    expect(error.message).toMatch(/completion: /);
    expect(error.message).toContain(projectPath);
  });

  it('refuses completion outcomes that cannot mean anything in the Jira workflow', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      harnessWith({ reviewer: REVIEWER, completion: COMPLETION }),
    );
    const sameOutcomes = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      connectedProject('SAM1', 'owner/first', ['first.yml']),
    );
    const reviewStatus = await writeJsonFile(
      path.join(directory, 'review-status'),
      PROJECT_CONFIG_FILE_NAME,
      projectWith({
        source: JIRA,
        delivery: {
          type: 'github',
          repository: 'owner/first',
          baseBranch: 'main',
          completion: {
            postMergeWorkflows: ['ci.yml'],
            toDoStatus: 'In Review',
            doneStatus: 'Done',
          },
        },
      }),
    );
    const sameStatuses = await writeJsonFile(
      path.join(directory, 'same-statuses'),
      PROJECT_CONFIG_FILE_NAME,
      projectWith({
        source: JIRA,
        delivery: {
          type: 'github',
          repository: 'owner/first',
          baseBranch: 'main',
          completion: { postMergeWorkflows: ['ci.yml'], toDoStatus: 'Done', doneStatus: 'Done' },
        },
      }),
    );

    const statusError = await rejectionFrom(() => loadConfiguration(harnessPath, reviewStatus));
    expect(statusError.file).toBe(reviewStatus);
    expect(statusError.message).toMatch(/reviewStatus "In Review"/);

    const sameError = await rejectionFrom(() => loadConfiguration(harnessPath, sameStatuses));
    expect(sameError.message).toMatch(/toDoStatus and doneStatus must be different/);
  });
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

  async function loadTaskValue(value: unknown): Promise<Task> {
    const directory = await createTempDir();
    return loadTask(await writeJsonFile(directory, 'task.json', value));
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
  it('resolves a relative workDir from the harness file directory', async () => {
    const directory = await createTempDir();
    const nested = path.join(directory, 'nested');
    const harnessPath = await writeJsonFile(
      nested,
      HARNESS_CONFIG_FILE_NAME,
      harnessWith({ workDir: './out' }),
    );
    const projectPath = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );

    const config = (await loadConfiguration(harnessPath, projectPath)).config;

    // The point of the test: resolution must not depend on the process directory
    // or on where the connected project's checkout happens to be.
    expect(process.cwd()).not.toBe(nested);
    expect(resolveWorkDir(config, harnessPath)).toBe(path.join(nested, 'out'));
  });

  it('resolves a parent-relative workDir without leaving the harness directory', async () => {
    const directory = await createTempDir();
    const nested = path.join(directory, 'nested');
    const harnessPath = await writeJsonFile(
      nested,
      HARNESS_CONFIG_FILE_NAME,
      harnessWith({ workDir: '../runs' }),
    );
    const projectPath = await writeJsonFile(
      directory,
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );

    const config = (await loadConfiguration(harnessPath, projectPath)).config;

    expect(resolveWorkDir(config, harnessPath)).toBe(path.join(directory, 'runs'));
  });

  it('keeps an absolute workDir as given', async () => {
    const directory = await createTempDir();
    const absolute = path.join(directory, 'elsewhere');
    const harnessPath = await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      harnessWith({ workDir: absolute }),
    );
    const projectPath = await writeJsonFile(
      path.join(directory, 'project'),
      PROJECT_CONFIG_FILE_NAME,
      documentedProjectConfig,
    );

    const config = (await loadConfiguration(harnessPath, projectPath)).config;

    expect(resolveWorkDir(config, harnessPath)).toBe(absolute);
  });
});
