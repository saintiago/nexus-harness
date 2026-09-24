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
      apiBase: 'https://api.atlassian.com/ex/jira/9337c4da-7d33-4c1d-b03c-db207e537f88',
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
      ideas: {
        selection: {
          query: 'project = NEX AND status = "Idea"',
          orderBy: 'Rank ASC',
        },
        statuses: {
          submitted: 'Idea',
          active: 'Idea Refinement',
          approved: 'Draft',
          waitingForFeedback: 'Waiting for Feedback',
        },
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
      'finite-delivery': './workflows/finite-delivery.ts',
      'idea-refinement': './workflows/idea-refinement.ts',
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
          instructions: ['Prefer the repository contribution guide when it adds detail.'],
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
          id: 'nexus-review',
          model: 'gpt-6-astra',
          effort: 'high',
          instructions: [],
          toolSettings: { profile: 'nexus-astra' },
        },
        {
          id: 'nexus-recovery',
          model: 'gpt-6-astra',
          effort: 'high',
          instructions: [],
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
      reviewerProfile: 'nexus-review',
      recoveryProfile: 'nexus-recovery',
      maxRecoveryAttempts: 1,
    },
    ideaRefinement: {
      profiles: {
        purposeVerifier: 'nexus-astra',
        researcher: 'nexus-astra',
        briefWriter: 'nexus-astra',
        purposeCouncil: 'nexus-review',
        evidenceCouncil: 'nexus-review',
        simplicityCouncil: 'nexus-review',
      },
      maxCouncilCycles: 3,
    },
    notifications: {
      provider: 'sns',
      region: 'eu-west-1',
      destination: 'arn:aws:sns:eu-west-1:000000000000:nexus',
      credentials: {
        accessKeyId: 'awsAccessKeyId',
        secretAccessKey: 'awsSecretAccessKey',
        sessionToken: 'awsSessionToken',
      },
    },
    credentials: {
      jiraApiToken: { environment: 'JIRA_API_TOKEN' },
      awsAccessKeyId: { environment: 'AWS_ACCESS_KEY_ID' },
      awsSecretAccessKey: { environment: 'AWS_SECRET_ACCESS_KEY' },
      awsSessionToken: { environment: 'AWS_SESSION_TOKEN' },
      nexusLensPrivateKey: { environment: 'NEXUS_LENS_PRIVATE_KEY' },
    },
    nexusLens: {
      appId: 5001141,
      installationId: 163007360,
      login: 'nexus-lens[bot]',
      privateKey: 'nexusLensPrivateKey',
    },
  };
}
