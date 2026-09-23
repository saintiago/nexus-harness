import type { NexusConfiguration, ProjectConfiguration } from '../../src/configuration/index.js';

/** A project configuration value covering every documented setting group. */
export function projectConfiguration(): ProjectConfiguration {
  return {
    repository: {
      source: './repository.git',
      mainBranch: 'main',
    },
    preparation: [{ executable: 'npm', args: ['ci'] }],
    checks: [{ name: 'validate', command: { executable: 'npm', args: ['run', 'validate'] } }],
    taskSource: {
      kind: 'jira',
      siteUrl: 'https://example.atlassian.net',
      project: 'NEX',
      credential: 'jiraApiToken',
      selection: {
        query: 'project = NEX AND status = "To Do"',
        orderBy: 'Rank ASC',
      },
      fields: {
        workspacePointer: 'customfield_10001',
        pullRequest: 'customfield_10002',
      },
      statuses: {
        ready: 'To Do',
        inProgress: 'In Progress',
        review: 'In Review',
        done: 'Done',
      },
    },
    delivery: {
      repository: 'owner/repository',
      baseBranch: 'main',
      reviewCheck: 'Nexus Lens review',
      postMergeChecks: [{ name: 'validate', workflow: 'validate.yml' }],
      completion: {
        pollIntervalSeconds: 30,
        waitLimitSeconds: 1800,
      },
    },
  };
}

/** A Nexus configuration value covering every documented setting group. */
export function nexusConfiguration(): NexusConfiguration {
  return {
    workflow: {
      path: './workflows/finite-delivery.ts',
    },
    storage: {
      root: './state',
    },
    agentRuntime: {
      baseInstructions: ['Follow the project documentation.'],
      provider: {
        kind: 'codex',
        executable: 'codex',
      },
      profiles: [
        {
          id: 'nexus-flash',
          model: 'deepseek-flash',
          effort: 'max',
          instructions: ['You are the Nexus development agent.'],
          toolSettings: { profile: 'nexus-flash' },
        },
        {
          id: 'nexus-astra',
          model: 'gpt-6-astra',
          effort: 'high',
          instructions: [],
          toolSettings: { profile: 'nexus-astra' },
        },
        {
          id: 'nexus-recovery',
          model: 'gpt-6-astra',
          effort: 'high',
          instructions: ['You are the Nexus recovery agent.'],
          toolSettings: { profile: 'nexus-recovery' },
        },
      ],
    },
    executionPolicy: {
      agentInvocationLimitMinutes: 60,
      developerLadder: [
        { profile: 'nexus-flash', repairAllowance: 2 },
        { profile: 'nexus-astra', repairAllowance: 2 },
      ],
      reviewerProfile: 'nexus-astra',
      recoveryProfile: 'nexus-recovery',
      maxRecoveryAttempts: 1,
    },
    notifications: {
      provider: 'sns',
      destination: 'arn:aws:sns:eu-west-1:000000000000:nexus',
      credential: 'nexusNotifications',
    },
    credentials: {
      jiraApiToken: { environment: 'JIRA_API_TOKEN' },
      nexusNotifications: { environment: 'NEXUS_NOTIFICATIONS_CREDENTIALS' },
      nexusLensPrivateKey: { environment: 'NEXUS_LENS_PRIVATE_KEY_PATH' },
    },
    nexusLens: {
      appId: 5001141,
      installationId: 163007360,
      login: 'nexus-lens[bot]',
      privateKey: 'nexusLensPrivateKey',
    },
  };
}
