import { describe, expect, it } from 'vitest';
import {
  parseNexusConfiguration,
  parseProjectConfiguration,
  resolveCredential,
} from '../src/configuration/index.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const configurationDirectory = '/etc/nexus';

describe('project configuration', () => {
  it('resolves a relative repository source against the configuration directory', () => {
    const configuration = parseProjectConfiguration(projectConfiguration(), '/etc/nexus/project');

    expect(configuration.repository.source).toBe('/etc/nexus/project/repository.git');
  });

  it('leaves remote and absolute repository sources unchanged', () => {
    const sources = [
      'https://github.com/owner/repository.git',
      'git@github.com:owner/repository.git',
      '/srv/git/repository.git',
    ];

    for (const source of sources) {
      const configuration = projectConfiguration();
      configuration.repository.source = source;

      expect(
        parseProjectConfiguration(configuration, configurationDirectory).repository.source,
      ).toBe(source);
    }
  });

  it('rejects a setting owned by the Nexus configuration', () => {
    const configuration = { ...projectConfiguration(), storage: { root: './state' } };

    expect(() => parseProjectConfiguration(configuration, configurationDirectory)).toThrow(
      /Unrecognized key: "storage"/,
    );
  });

  it('rejects empty required identifiers', () => {
    const configuration = projectConfiguration();
    configuration.taskSource.project = '   ';

    expect(() => parseProjectConfiguration(configuration, configurationDirectory)).toThrow(
      /taskSource\.project/,
    );
  });

  it('requires commands to state an executable and an argument array', () => {
    const missingArguments = {
      ...projectConfiguration(),
      preparation: [{ executable: 'npm' }],
    };
    expect(() => parseProjectConfiguration(missingArguments, configurationDirectory)).toThrow(
      /preparation\.0\.args/,
    );

    const missingExecutable = {
      ...projectConfiguration(),
      checks: [{ name: 'validate', command: { args: ['run', 'validate'] } }],
    };
    expect(() => parseProjectConfiguration(missingExecutable, configurationDirectory)).toThrow(
      /checks\.0\.command\.executable/,
    );
  });

  it('keeps a shell command executable and arguments separate', () => {
    const configuration = projectConfiguration();
    configuration.preparation = [{ executable: 'bash', args: ['-c', 'npm ci && npm test'] }];

    const prepared = parseProjectConfiguration(configuration, configurationDirectory);

    expect(prepared.preparation).toEqual([
      { executable: 'bash', args: ['-c', 'npm ci && npm test'] },
    ]);
  });

  it('resolves path-valued command executables and preserves opaque arguments', () => {
    const configuration = projectConfiguration();
    configuration.preparation = [
      { executable: './bin/prepare', args: ['--config', './config/prepare.json'] },
      { executable: 'tools/check.sh', args: [] },
      { executable: 'npm', args: ['ci'] },
    ];
    configuration.checks = [
      {
        name: 'validate',
        command: { executable: '/usr/local/bin/validate', args: ['./scripts/validate'] },
      },
    ];

    const prepared = parseProjectConfiguration(configuration, configurationDirectory);

    expect(prepared.preparation).toEqual([
      { executable: '/etc/nexus/bin/prepare', args: ['--config', './config/prepare.json'] },
      { executable: '/etc/nexus/tools/check.sh', args: [] },
      { executable: 'npm', args: ['ci'] },
    ]);
    expect(prepared.checks[0]!.command).toEqual({
      executable: '/usr/local/bin/validate',
      args: ['./scripts/validate'],
    });
  });

  it('requires durations to state their unit and be nonnegative', () => {
    const unitless = {
      ...projectConfiguration(),
      delivery: {
        ...projectConfiguration().delivery,
        completion: { pollInterval: 30, waitLimit: 1800 },
      },
    };
    expect(() => parseProjectConfiguration(unitless, configurationDirectory)).toThrow(
      /Unrecognized key/,
    );

    const negative = projectConfiguration();
    negative.delivery.completion.waitLimitSeconds = -1;
    expect(() => parseProjectConfiguration(negative, configurationDirectory)).toThrow(
      /delivery\.completion\.waitLimitSeconds/,
    );

    const zero = projectConfiguration();
    zero.delivery.completion.pollIntervalSeconds = 0;
    expect(
      parseProjectConfiguration(zero, configurationDirectory).delivery.completion
        .pollIntervalSeconds,
    ).toBe(0);
  });
});

describe('Nexus configuration', () => {
  it('resolves the workflow path and storage root against the configuration directory', () => {
    const configuration = parseNexusConfiguration(nexusConfiguration(), '/etc/nexus/installation');

    expect(configuration.workflow.path).toBe(
      '/etc/nexus/installation/workflows/finite-delivery.ts',
    );
    expect(configuration.storage.root).toBe('/etc/nexus/installation/state');
  });

  it('resolves a relative provider executable and preserves bare and absolute ones', () => {
    const relative = nexusConfiguration();
    relative.agentRuntime.provider.executable = './bin/codex';
    expect(
      parseNexusConfiguration(relative, '/etc/nexus/installation').agentRuntime.provider.executable,
    ).toBe('/etc/nexus/installation/bin/codex');

    const bare = nexusConfiguration();
    bare.agentRuntime.provider.executable = 'codex';
    expect(
      parseNexusConfiguration(bare, '/etc/nexus/installation').agentRuntime.provider.executable,
    ).toBe('codex');

    const absolute = nexusConfiguration();
    absolute.agentRuntime.provider.executable = '/opt/codex/bin/codex';
    expect(
      parseNexusConfiguration(absolute, '/etc/nexus/installation').agentRuntime.provider.executable,
    ).toBe('/opt/codex/bin/codex');
  });

  it('rejects a setting owned by the project configuration', () => {
    const configuration = { ...nexusConfiguration(), delivery: {} };

    expect(() => parseNexusConfiguration(configuration, configurationDirectory)).toThrow(
      /Unrecognized key: "delivery"/,
    );
  });

  it('requires unique profile IDs', () => {
    const configuration = nexusConfiguration();
    configuration.agentRuntime.profiles.push({
      id: 'nexus-flash',
      model: 'deepseek-flash',
      effort: 'max',
      instructions: [],
      toolSettings: {},
    });

    expect(() => parseNexusConfiguration(configuration, configurationDirectory)).toThrow(
      /Duplicate profile ID "nexus-flash"/,
    );
  });

  it('requires profile references to identify configured profiles', () => {
    const ladder = nexusConfiguration();
    ladder.executionPolicy.developerLadder[1]!.profile = 'missing';
    expect(() => parseNexusConfiguration(ladder, configurationDirectory)).toThrow(
      /Unknown profile "missing"/,
    );

    const reviewer = nexusConfiguration();
    reviewer.executionPolicy.reviewerProfile = 'missing';
    expect(() => parseNexusConfiguration(reviewer, configurationDirectory)).toThrow(
      /executionPolicy\.reviewerProfile/,
    );

    const recovery = nexusConfiguration();
    recovery.executionPolicy.recoveryProfile = 'missing';
    expect(() => parseNexusConfiguration(recovery, configurationDirectory)).toThrow(
      /executionPolicy\.recoveryProfile/,
    );
  });

  it('requires an initial developer profile', () => {
    const configuration = nexusConfiguration();
    configuration.executionPolicy.developerLadder = [];

    expect(() => parseNexusConfiguration(configuration, configurationDirectory)).toThrow(
      /At least one developer profile is required/,
    );
  });

  it('accepts nonnegative integral repair allowances while requiring positive recovery attempts', () => {
    const immediateEscalation = nexusConfiguration();
    immediateEscalation.executionPolicy.developerLadder[0]!.repairAllowance = 0;
    expect(
      parseNexusConfiguration(immediateEscalation, configurationDirectory).executionPolicy
        .developerLadder[0]!.repairAllowance,
    ).toBe(0);

    const negative = nexusConfiguration();
    negative.executionPolicy.developerLadder[0]!.repairAllowance = -1;
    expect(() => parseNexusConfiguration(negative, configurationDirectory)).toThrow(
      /repairAllowance/,
    );

    const fractional = nexusConfiguration();
    fractional.executionPolicy.developerLadder[0]!.repairAllowance = 1.5;
    expect(() => parseNexusConfiguration(fractional, configurationDirectory)).toThrow(
      /repairAllowance/,
    );

    const attempts = nexusConfiguration();
    attempts.executionPolicy.maxRecoveryAttempts = 0;
    expect(() => parseNexusConfiguration(attempts, configurationDirectory)).toThrow(
      /maxRecoveryAttempts/,
    );
  });

  it('requires Nexus credential references to identify configured credentials', () => {
    const lens = nexusConfiguration();
    lens.nexusLens.privateKey = 'missing';
    expect(() => parseNexusConfiguration(lens, configurationDirectory)).toThrow(
      /Unknown credential reference "missing"/,
    );

    const notifications = nexusConfiguration();
    notifications.notifications.credentials.secretAccessKey = 'missing';
    expect(() => parseNexusConfiguration(notifications, configurationDirectory)).toThrow(
      /notifications\.credentials\.secretAccessKey/,
    );

    const sessionToken = nexusConfiguration();
    sessionToken.notifications.credentials.sessionToken = 'missing';
    expect(() => parseNexusConfiguration(sessionToken, configurationDirectory)).toThrow(
      /notifications\.credentials\.sessionToken/,
    );
  });

  it('accepts notifications without a session token reference and requires the SNS Region', () => {
    expect(
      parseNexusConfiguration(nexusConfiguration(), configurationDirectory).notifications
        .credentials,
    ).toEqual({
      accessKeyId: 'awsAccessKeyId',
      secretAccessKey: 'awsSecretAccessKey',
      sessionToken: 'awsSessionToken',
    });

    const withoutSession = nexusConfiguration();
    delete withoutSession.notifications.credentials.sessionToken;
    expect(
      parseNexusConfiguration(withoutSession, configurationDirectory).notifications.credentials,
    ).toEqual({ accessKeyId: 'awsAccessKeyId', secretAccessKey: 'awsSecretAccessKey' });

    const blankRegion = nexusConfiguration();
    blankRegion.notifications.region = '   ';
    expect(() => parseNexusConfiguration(blankRegion, configurationDirectory)).toThrow(
      /notifications\.region/,
    );
  });

  it('returns immutable settings values', () => {
    const configuration = parseNexusConfiguration(nexusConfiguration(), configurationDirectory);

    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.agentRuntime.profiles[0]!)).toBe(true);
    expect(() => {
      configuration.storage.root = '/elsewhere';
    }).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(configuration))).toEqual(configuration);
  });
});

describe('credential resolution', () => {
  const configuration = parseNexusConfiguration(nexusConfiguration(), configurationDirectory);

  it('resolves a credential reference from the host environment', () => {
    expect(
      resolveCredential(configuration, 'jiraApiToken', { JIRA_API_TOKEN: 'token-value' }),
    ).toBe('token-value');
  });

  it('rejects an unknown credential reference', () => {
    expect(() => resolveCredential(configuration, 'missing', {})).toThrow(
      /Unknown credential reference "missing"/,
    );
  });

  it('rejects a credential whose host value is not set', () => {
    expect(() => resolveCredential(configuration, 'jiraApiToken', {})).toThrow(/JIRA_API_TOKEN/);
  });
});
