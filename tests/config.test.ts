/**
 * Configuration and input validation as decisions: which documents each file
 * accepts, what an omitted optional field means, which launch and path rules are
 * applied once, and what the two files compose into.
 *
 * The schemas and the composition helpers are ordinary functions; the loader
 * cases read and write two small JSON documents in a temporary directory and
 * nothing else. No Git, command, or connector runs here (docs/testing.md).
 */
import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ConfigError,
  escalationTiers,
  loadConfiguration,
  loadHarnessFile,
  loadTask,
  projectLockNamespace,
  resolveAgentSelection,
  resolveWorkDir,
} from '../src/config/load.js';
import {
  COMPLETION_DEFAULTS,
  DEFAULT_AGENT_SELECTION,
  JIRA_SOURCE_DEFAULTS,
  MIN_POLL_INTERVAL_SECONDS,
  checkCompletionStatuses,
  harnessConfigSchema,
  misplacedFields,
  projectConfigSchema,
  sourceSchema,
  taskSchema,
} from '../src/config/schema.js';
import type { CompletionConfig, HarnessConfig } from '../src/shared/types.js';
import { createTempDir, repoRoot, writeJsonFile } from './support.js';

/** The documented Nexus-wide harness configuration. */
const HARNESS = {
  workDir: '../.harness',
  maxRepairs: 2,
  taskTimeoutMinutes: 60,
  commandTimeoutMinutes: 10,
};

/** The documented project configuration. */
const PROJECT = {
  setup: [['npm', 'ci']],
  checks: [['npm', 'run', 'validate']],
};

/** One Jira source object with every documented default left out. */
const SOURCE = {
  type: 'jira',
  siteUrl: 'https://name.atlassian.net',
  cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
  projectKey: 'SAM1',
};

/** The composed configuration one `loadConfiguration` case produced. */
function problemsOf(error: unknown): readonly string[] {
  expect(error).toBeInstanceOf(ConfigError);
  return (error as ConfigError).problems;
}

describe('the harness configuration document', () => {
  it('accepts the documented document and refuses every required field that is missing', () => {
    expect(harnessConfigSchema.safeParse(HARNESS).success).toBe(true);
    for (const field of ['workDir', 'maxRepairs', 'taskTimeoutMinutes', 'commandTimeoutMinutes']) {
      const document: Record<string, unknown> = { ...HARNESS };
      delete document[field];
      expect(harnessConfigSchema.safeParse(document).success).toBe(false);
    }
  });

  it('rejects unknown fields, wrong types, and values outside their documented bounds', () => {
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [{ ...HARNESS, extra: true }, /Unrecognized key/i],
      [{ ...HARNESS, workDir: '   ' }, /workDir must not be blank/],
      [{ ...HARNESS, maxRepairs: -1 }, /maxRepairs must be a nonnegative integer/],
      [{ ...HARNESS, maxRepairs: 1.5 }, /maxRepairs must be an integer/],
      [{ ...HARNESS, maxRepairs: '2' }, /maxRepairs/],
      [{ ...HARNESS, taskTimeoutMinutes: 0 }, /taskTimeoutMinutes must be a positive integer/],
      [{ ...HARNESS, commandTimeoutMinutes: 0 }, /commandTimeoutMinutes must be a positive/],
    ];
    for (const [document, message] of cases) {
      const result = harnessConfigSchema.safeParse(document);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toMatch(message);
    }
  });

  it('accepts only the implemented coding runtime and a nonempty launch', () => {
    const agent = { runtime: 'codex', command: ['codex', '--profile', 'nexus-flash'] };
    expect(harnessConfigSchema.safeParse({ ...HARNESS, agent }).success).toBe(true);
    expect(
      harnessConfigSchema.safeParse({ ...HARNESS, agent: { ...agent, runtime: 'claude' } }).success,
    ).toBe(false);
    expect(
      harnessConfigSchema.safeParse({ ...HARNESS, agent: { runtime: 'codex', command: [] } })
        .success,
    ).toBe(false);
    expect(
      harnessConfigSchema.safeParse({
        ...HARNESS,
        agent: { runtime: 'codex', command: ['   '] },
      }).success,
    ).toBe(false);
  });

  it('requires an escalation ladder to be nonempty, distinct and well-formed', () => {
    expect(
      harnessConfigSchema.safeParse({
        ...HARNESS,
        escalation: [{ name: 'flash' }, { name: 'astra', maxRepairs: 0 }],
      }).success,
    ).toBe(true);
    expect(harnessConfigSchema.safeParse({ ...HARNESS, escalation: [] }).success).toBe(false);
    expect(
      harnessConfigSchema.safeParse({
        ...HARNESS,
        escalation: [{ name: 'flash' }, { name: 'flash' }],
      }).success,
    ).toBe(false);
    expect(
      harnessConfigSchema.safeParse({ ...HARNESS, escalation: [{ name: '  ' }] }).success,
    ).toBe(false);
    expect(
      harnessConfigSchema.safeParse({ ...HARNESS, escalation: [{ name: 'flash', maxRepairs: -1 }] })
        .success,
    ).toBe(false);
  });

  it('requires the reviewer integration and the completion policy to name one Lens identity', () => {
    const reviewer = {
      app: {
        appId: 5001141,
        installationId: 163007360,
        privateKeyPathEnv: 'NEXUS_LENS_PRIVATE_KEY_PATH',
        login: 'nexus-lens[bot]',
      },
      reviewer: { runtime: 'codex', command: ['codex'] },
      checkName: 'Nexus Lens review',
    };
    const completion = {
      lensApp: 'nexus-lens[bot]',
      lensAppId: 5001141,
      lensCheckName: 'Nexus Lens review',
      reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
    };
    expect(harnessConfigSchema.safeParse({ ...HARNESS, reviewer, completion }).success).toBe(true);
    expect(
      harnessConfigSchema.safeParse({
        ...HARNESS,
        reviewer,
        completion: { ...completion, lensCheckName: 'Some other check' },
      }).success,
    ).toBe(false);
    // The reviewer credential must not be the operator's own variable.
    expect(
      harnessConfigSchema.safeParse({
        ...HARNESS,
        completion: { ...completion, reviewerTokenEnv: 'GH_TOKEN' },
      }).success,
    ).toBe(false);
  });

  it('reports every problem of one document at once instead of the first', async () => {
    const directory = await createTempDir();
    const file = await writeJsonFile(directory, 'nexus.config.json', {
      ...HARNESS,
      workDir: '  ',
      maxRepairs: -1,
      taskTimeoutMinutes: 0,
    });

    try {
      await loadHarnessFile(file);
      expect.unreachable('the document should have been refused');
    } catch (cause) {
      expect(problemsOf(cause)).toEqual([
        'workDir: workDir must not be blank',
        'maxRepairs: maxRepairs must be a nonnegative integer',
        'taskTimeoutMinutes: taskTimeoutMinutes must be a positive integer',
      ]);
    }
  });
});

describe('the project configuration document', () => {
  it('accepts the documented document and refuses an empty or malformed plan', () => {
    expect(projectConfigSchema.safeParse(PROJECT).success).toBe(true);
    expect(projectConfigSchema.safeParse({ ...PROJECT, checks: [] }).success).toBe(false);
    expect(projectConfigSchema.safeParse({ ...PROJECT, setup: [[]] }).success).toBe(false);
    expect(projectConfigSchema.safeParse({ ...PROJECT, checks: [['npm', 1]] }).success).toBe(false);
    expect(projectConfigSchema.safeParse({ ...PROJECT, projectKey: 'SAM1' }).success).toBe(false);
  });

  it('keeps an empty setup list and literal empty arguments exactly as written', () => {
    const parsed = projectConfigSchema.parse({
      setup: [],
      checks: [['npm', 'run', 'validate', '']],
    });
    expect(parsed.setup).toEqual([]);
    expect(parsed.checks).toEqual([['npm', 'run', 'validate', '']]);
  });

  it('normalizes the Jira site and fills the documented source defaults', () => {
    const parsed = sourceSchema.parse(SOURCE);
    expect(parsed.siteUrl).toBe('https://name.atlassian.net');
    expect(parsed).toMatchObject(JIRA_SOURCE_DEFAULTS);
    // A trailing slash is the one automatic normalization.
    expect(sourceSchema.parse({ ...SOURCE, siteUrl: 'https://name.atlassian.net/' }).siteUrl).toBe(
      'https://name.atlassian.net',
    );
  });

  it('refuses a site that is not the canonical HTTPS origin', () => {
    for (const siteUrl of [
      'http://name.atlassian.net',
      'https://user:secret@name.atlassian.net',
      'https://name.atlassian.net/?query=1',
      'https://name.atlassian.net/some/path',
      'not-a-url',
    ]) {
      expect(sourceSchema.safeParse({ ...SOURCE, siteUrl }).success).toBe(false);
    }
  });

  it('refuses a cloud ID that is not a UUID, a blank project key, and a spaced label', () => {
    expect(sourceSchema.safeParse({ ...SOURCE, cloudId: 'not-a-uuid' }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...SOURCE, projectKey: '  ' }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...SOURCE, label: 'two labels' }).success).toBe(false);
  });

  it('requires three distinct statuses and a bounded, integer poll interval', () => {
    expect(sourceSchema.safeParse({ ...SOURCE, reviewStatus: 'To Do' }).success).toBe(false);
    expect(
      sourceSchema.safeParse({ ...SOURCE, pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS - 1 })
        .success,
    ).toBe(false);
    expect(sourceSchema.safeParse({ ...SOURCE, pollIntervalSeconds: 5.5 }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...SOURCE, ordering: 'created' }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...SOURCE, tokenEnv: 'not a name' }).success).toBe(false);
  });

  it('accepts only the implemented source and delivery types', () => {
    expect(
      projectConfigSchema.safeParse({ ...PROJECT, source: { ...SOURCE, type: 'linear' } }).success,
    ).toBe(false);
    const delivery = { type: 'github', repository: 'owner/name', baseBranch: 'main' };
    expect(projectConfigSchema.safeParse({ ...PROJECT, delivery }).success).toBe(true);
    expect(
      projectConfigSchema.safeParse({ ...PROJECT, delivery: { ...delivery, type: 'gitlab' } })
        .success,
    ).toBe(false);
    expect(
      projectConfigSchema.safeParse({
        ...PROJECT,
        delivery: { ...delivery, repository: 'https://github.com/owner/name' },
      }).success,
    ).toBe(false);
    expect(
      projectConfigSchema.safeParse({
        ...PROJECT,
        delivery: { ...delivery, baseBranch: '--upload-pack=evil' },
      }).success,
    ).toBe(false);
  });

  it('requires at least one post-merge workflow, named as a file, path or numeric id', () => {
    const delivery = {
      type: 'github',
      repository: 'owner/name',
      baseBranch: 'main',
      completion: { postMergeWorkflows: [], toDoStatus: 'To Do', doneStatus: 'Done' },
    };
    expect(projectConfigSchema.safeParse({ ...PROJECT, delivery }).success).toBe(false);
    for (const workflows of [['ci.yml'], ['.github/workflows/ci.yaml'], ['1234']]) {
      expect(
        projectConfigSchema.safeParse({
          ...PROJECT,
          delivery: {
            ...delivery,
            completion: { ...delivery.completion, postMergeWorkflows: workflows },
          },
        }).success,
      ).toBe(true);
    }
    expect(
      projectConfigSchema.safeParse({
        ...PROJECT,
        delivery: {
          ...delivery,
          completion: { ...delivery.completion, postMergeWorkflows: ['--workflow'] },
        },
      }).success,
    ).toBe(false);
  });
});

describe('the completion statuses', () => {
  const completion: CompletionConfig = {
    lensApp: 'nexus-lens[bot]',
    lensAppId: 1,
    lensCheckName: 'Nexus Lens review',
    reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
    postMergeWorkflows: ['ci.yml'],
    toDoStatus: 'To Do',
    doneStatus: 'Done',
    ...COMPLETION_DEFAULTS,
  };

  it('refuses one status for both outcomes and either outcome equal to the review status', () => {
    expect(checkCompletionStatuses('In Review', completion)).toBeNull();
    expect(checkCompletionStatuses('To Do', completion)).toMatch(/must differ from the source/);
    expect(checkCompletionStatuses('In Review', { ...completion, doneStatus: 'to do' })).toMatch(
      /must be different statuses/,
    );
  });
});

describe('the task input', () => {
  const task = {
    id: 'example-001',
    title: 'Add a greeting function',
    description: 'Implement the greeting the ticket describes.',
    acceptanceCriteria: ['The greeting is implemented.', 'The tests cover it.'],
  };

  it('accepts the documented task and refuses blank or empty required fields', () => {
    expect(taskSchema.safeParse(task).success).toBe(true);
    for (const field of ['id', 'title', 'description']) {
      expect(taskSchema.safeParse({ ...task, [field]: '  ' }).success).toBe(false);
    }
    expect(taskSchema.safeParse({ ...task, acceptanceCriteria: [] }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, acceptanceCriteria: ['ok', ' '] }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, extra: 'no' }).success).toBe(false);
  });

  it('reports the fields of a task file it could not read back', async () => {
    const directory = await createTempDir();
    const file = await writeJsonFile(directory, 'task.json', { ...task, title: '' });
    await expect(loadTask(file)).rejects.toThrow(/title: title must not be blank/);
    await expect(loadTask(path.join(directory, 'missing.json'))).rejects.toThrow(/cannot be read/);
  });
});

describe('the launch and path rules applied once', () => {
  it('leaves a bare executable for the host and resolves a relative path', () => {
    expect(
      resolveAgentSelection(
        { runtime: 'codex', command: ['codex', '--profile', 'x'] },
        'C:/a/b.json',
      ),
    ).toEqual({ runtime: 'codex', command: ['codex', '--profile', 'x'] });
    const resolved = resolveAgentSelection(
      { runtime: 'codex', command: ['./bin/codex', '--model', 'm'] },
      path.join('C:', 'config', 'nexus.config.json'),
    );
    expect(resolved.command[0]).toBe(path.resolve('C:/config/bin/codex'));
    expect(resolved.command.slice(1)).toEqual(['--model', 'm']);
  });

  it('resolves the output directory against the configuration file, not the working directory', () => {
    const config = { ...HARNESS } as HarnessConfig;
    expect(resolveWorkDir(config, path.join('C:', 'config', 'nexus.config.json'))).toBe(
      path.resolve('C:/config/../.harness'),
    );
  });

  it('synthesizes the one ordinary rung, and uses a declared ladder as written', () => {
    const config = {
      ...HARNESS,
      setup: [],
      checks: [['check']],
      agent: { runtime: 'codex' as const, command: ['codex'] },
    } as HarnessConfig;
    expect(escalationTiers(config)).toEqual([
      { name: 'default', agent: config.agent, maxRepairs: config.maxRepairs },
    ]);
    const declared = [{ name: 'flash', agent: config.agent, maxRepairs: 1 }];
    expect(escalationTiers({ ...config, escalation: declared })).toEqual(declared);
  });

  it('names one connected project independently of its queue tuning and spelling', () => {
    const source: NonNullable<HarnessConfig['source']> = {
      type: 'jira',
      siteUrl: 'https://name.atlassian.net',
      cloudId: '9337C4DA-7D33-4C1D-B03C-DB207E537F88',
      projectKey: 'sam1',
      ...JIRA_SOURCE_DEFAULTS,
    };
    const delivery: NonNullable<HarnessConfig['delivery']> = {
      type: 'github',
      repository: 'Owner/Name',
      baseBranch: 'main',
    };
    const config: HarnessConfig = {
      ...HARNESS,
      setup: [],
      checks: [['check']],
      agent: DEFAULT_AGENT_SELECTION,
      source,
      delivery,
    };
    const equivalent: HarnessConfig = {
      ...config,
      source: { ...source, cloudId: source.cloudId.toLowerCase(), projectKey: 'SAM1' },
      delivery: { ...delivery, repository: 'owner/name' },
    };
    expect(projectLockNamespace(config)).toBe(projectLockNamespace(equivalent));
    // Queue tuning is not part of the identity.
    expect(
      projectLockNamespace({
        ...config,
        source: { ...source, label: 'another-label', pollIntervalSeconds: 60 },
        delivery: { ...delivery, baseBranch: 'develop' },
      }),
    ).toBe(projectLockNamespace(config));
    // Another project is another namespace.
    expect(projectLockNamespace({ ...config, source: { ...source, projectKey: 'SAM2' } })).not.toBe(
      projectLockNamespace(config),
    );
    expect(projectLockNamespace(config)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('composing the two configuration files', () => {
  it('composes the two checked-in examples this repository carries', async () => {
    const { config } = await loadConfiguration(
      path.join(repoRoot, 'docs', 'nexus.config.example.json'),
      path.join(repoRoot, 'docs', 'nexus.project.example.json'),
    );

    expect(config.workDir).toBe('../.harness');
    // The documented launch and every ladder rung are kept with their prefixes.
    expect(config.agent.command).toEqual([
      'codex',
      '--profile',
      'nexus-flash',
      '--model',
      'deepseek-flash',
    ]);
    expect(escalationTiers(config).map((tier) => tier.name)).toEqual(['flash', 'astra']);
    expect(escalationTiers(config).map((tier) => tier.maxRepairs)).toEqual([2, 2]);
    expect(config.review?.repository).toBe('owner/name');
    expect(config.delivery?.completion?.postMergeWorkflows).toEqual(['ci.yml']);
  });

  it('loads the documented pair and composes both sides', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', HARNESS);
    const projectPath = await writeJsonFile(directory, 'nexus.project.json', PROJECT);

    const { config, harness, project } = await loadConfiguration(harnessPath, projectPath);

    expect(config.workDir).toBe(HARNESS.workDir);
    expect(config.maxRepairs).toBe(2);
    expect(config.setup).toEqual(PROJECT.setup);
    expect(config.checks).toEqual(PROJECT.checks);
    // The documented ordinary launch is applied, and no integration appears that
    // the files never declared.
    expect(config.agent).toEqual(DEFAULT_AGENT_SELECTION);
    expect(harness.agent).toEqual(DEFAULT_AGENT_SELECTION);
    expect(config.source).toBeUndefined();
    expect(config.delivery).toBeUndefined();
    expect(config.review).toBeUndefined();
    expect(project.checks).toEqual(PROJECT.checks);
  });

  it('refuses a field in the file the other side owns, naming where it belongs', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', {
      ...HARNESS,
      checks: [['npm', 'test']],
    });
    const projectPath = await writeJsonFile(directory, 'nexus.project.json', {
      ...PROJECT,
      maxRepairs: 2,
    });

    await expect(loadConfiguration(harnessPath, projectPath)).rejects.toThrow(
      /belongs to the project configuration/,
    );

    const harnessOnly = await writeJsonFile(directory, 'harness-2.json', {
      ...HARNESS,
      source: SOURCE,
    });
    await expect(loadHarnessFile(harnessOnly)).rejects.toThrow(
      /belongs to the project configuration/,
    );

    const cleanHarness = await writeJsonFile(directory, 'harness-3.json', HARNESS);
    const projectOnly = await writeJsonFile(directory, 'project-2.json', {
      ...PROJECT,
      maxRepairs: 2,
    });
    await expect(loadConfiguration(cleanHarness, projectOnly)).rejects.toThrow(
      /belongs to the Nexus-wide harness configuration/,
    );
  });

  it('refuses a project completion without a harness-wide policy, naming both files', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', HARNESS);
    const projectPath = await writeJsonFile(directory, 'nexus.project.json', {
      ...PROJECT,
      delivery: {
        type: 'github',
        repository: 'owner/name',
        baseBranch: 'main',
        completion: { postMergeWorkflows: ['ci.yml'], toDoStatus: 'To Do', doneStatus: 'Done' },
      },
    });

    try {
      await loadConfiguration(harnessPath, projectPath);
      expect.unreachable('the composition should have been refused');
    } catch (cause) {
      expect(problemsOf(cause).join('\n')).toMatch(/declares no "completion" policy/);
      expect(problemsOf(cause).join('\n')).toContain(projectPath);
    }
  });

  it('resolves a ladder rung that names no launch or allowance from the top level', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', {
      ...HARNESS,
      agent: { runtime: 'codex', command: ['./bin/codex', '--profile', 'flash'] },
      escalation: [{ name: 'flash' }, { name: 'astra', maxRepairs: 0 }],
    });
    const projectPath = await writeJsonFile(directory, 'nexus.project.json', PROJECT);

    const { config } = await loadConfiguration(harnessPath, projectPath);

    const tiers = escalationTiers(config);
    const resolved = path.resolve(path.join(directory, 'bin', 'codex'));
    expect(tiers[0]).toEqual({
      name: 'flash',
      agent: { runtime: 'codex', command: [resolved, '--profile', 'flash'] },
      maxRepairs: 2,
    });
    expect(tiers[1]).toEqual({
      name: 'astra',
      agent: { runtime: 'codex', command: [resolved, '--profile', 'flash'] },
      maxRepairs: 0,
    });
  });

  it('composes the review path only when the harness reviewer and the project connection meet', async () => {
    const directory = await createTempDir();
    const reviewer = {
      app: {
        appId: 7,
        installationId: 8,
        privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
        login: 'nexus-lens[bot]',
      },
      reviewer: { runtime: 'codex', command: ['codex', '--profile', 'lens'] },
      checkName: 'Nexus Lens review',
    };
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', {
      ...HARNESS,
      reviewer,
    });

    const withoutDelivery = await writeJsonFile(directory, 'project-jira-only.json', {
      ...PROJECT,
      source: SOURCE,
    });
    const jiraOnly = await loadConfiguration(harnessPath, withoutDelivery);
    expect(jiraOnly.config.review).toBeUndefined();

    const connected = await writeJsonFile(directory, 'project-connected.json', {
      ...PROJECT,
      source: SOURCE,
      delivery: { type: 'github', repository: 'owner/name', baseBranch: 'main' },
    });
    const composed = await loadConfiguration(harnessPath, connected);
    expect(composed.config.review).toEqual({
      type: 'github',
      repository: 'owner/name',
      app: reviewer.app,
      reviewer: reviewer.reviewer,
      checkName: 'Nexus Lens review',
    });
  });

  it('refuses a project completion whose statuses would repeat a source status', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', {
      ...HARNESS,
      reviewer: {
        app: {
          appId: 7,
          installationId: 8,
          privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
          login: 'nexus-lens[bot]',
        },
        reviewer: { runtime: 'codex', command: ['codex'] },
      },
      completion: {
        lensApp: 'nexus-lens[bot]',
        lensAppId: 7,
        lensCheckName: 'Nexus Lens review',
        reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
      },
    });
    const projectPath = await writeJsonFile(directory, 'nexus.project.json', {
      ...PROJECT,
      source: SOURCE,
      delivery: {
        type: 'github',
        repository: 'owner/name',
        baseBranch: 'main',
        completion: {
          postMergeWorkflows: ['ci.yml'],
          toDoStatus: 'In Review',
          doneStatus: 'Done',
        },
      },
    });

    try {
      await loadConfiguration(harnessPath, projectPath);
      expect.unreachable('the composition should have been refused');
    } catch (cause) {
      expect(problemsOf(cause).join('\n')).toMatch(/must differ from the source's reviewStatus/);
    }
  });

  it('applies the completion policy defaults, keeps declared bounds, and needs no source', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', {
      ...HARNESS,
      reviewer: {
        app: {
          appId: 7,
          installationId: 8,
          privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
          login: 'nexus-lens[bot]',
        },
        reviewer: { runtime: 'codex', command: ['codex'] },
      },
      completion: {
        lensApp: 'nexus-lens[bot]',
        lensAppId: 7,
        lensCheckName: 'Nexus Lens review',
        reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
      },
    });
    const projectPath = await writeJsonFile(directory, 'nexus.project.json', {
      ...PROJECT,
      delivery: {
        type: 'github',
        repository: 'owner/name',
        baseBranch: 'main',
        completion: {
          postMergeWorkflows: ['1234'],
          toDoStatus: 'To Do',
          doneStatus: 'Done',
        },
      },
    });

    const { config } = await loadConfiguration(harnessPath, projectPath);

    // The harness-wide policy defaults are applied where the file says nothing.
    expect(config.delivery?.completion).toMatchObject({
      pollIntervalSeconds: COMPLETION_DEFAULTS.pollIntervalSeconds,
      deadlineSeconds: COMPLETION_DEFAULTS.deadlineSeconds,
      postMergeWorkflows: ['1234'],
      toDoStatus: 'To Do',
      doneStatus: 'Done',
    });
    // A project with no source still composes its completion; the statuses are
    // then checked against each other alone.
    expect(config.source).toBeUndefined();
    expect(config.delivery?.completion?.lensApp).toBe('nexus-lens[bot]');
  });

  it('takes the declared completion polling bounds rather than the defaults', async () => {
    const directory = await createTempDir();
    const harnessPath = await writeJsonFile(directory, 'nexus.config.json', {
      ...HARNESS,
      completion: {
        lensApp: 'nexus-lens[bot]',
        lensAppId: 7,
        lensCheckName: 'Nexus Lens review',
        reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
        pollIntervalSeconds: 11,
        deadlineSeconds: 120,
      },
    });
    const projectPath = await writeJsonFile(directory, 'nexus.project.json', {
      ...PROJECT,
      delivery: {
        type: 'github',
        repository: 'owner/name',
        baseBranch: 'main',
        completion: {
          postMergeWorkflows: ['ci.yml'],
          toDoStatus: 'To Do',
          doneStatus: 'Done',
        },
      },
    });

    const { config } = await loadConfiguration(harnessPath, projectPath);

    expect(config.delivery?.completion?.pollIntervalSeconds).toBe(11);
    expect(config.delivery?.completion?.deadlineSeconds).toBe(120);
  });

  it('reports a configuration file that is missing or not valid JSON under its own path', async () => {
    const directory = await createTempDir();
    const missing = path.join(directory, 'nexus.config.json');
    await expect(loadHarnessFile(missing)).rejects.toThrow(/cannot be read/);

    const wrongShape = await writeJsonFile(directory, 'wrong-shape.json', {
      ...HARNESS,
      workDir: 42,
    });
    await expect(loadHarnessFile(wrongShape)).rejects.toThrow(/workDir/);

    const notJson = path.join(directory, 'not-json.config.json');
    await writeFile(notJson, '{ this is not JSON', 'utf8');
    await expect(loadHarnessFile(notJson)).rejects.toThrow(/is not valid JSON/);
  });
});

describe('which fields a document carries', () => {
  it('names the owned fields a document carries, and nothing else', () => {
    expect(misplacedFields({ setup: [], checks: [] }, ['setup', 'checks'])).toEqual([
      'setup',
      'checks',
    ]);
    expect(misplacedFields({ setup: [] }, ['checks'])).toEqual([]);
    expect(misplacedFields(null, ['setup'])).toEqual([]);
    expect(misplacedFields([], ['setup'])).toEqual([]);
  });
});
