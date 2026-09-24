/**
 * Composition tests: real parsed project and Nexus configuration supplies the construction
 * settings of existing components. Provider capabilities are supplied fakes — a recording HTTP
 * transport, a recording coding runtime and a controlled host environment — so no live service,
 * credential or agent turn is involved.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAgentRuntimeSettings,
  createJiraSettings,
  createNotificationSettings,
  type ProfileRole,
} from '../src/application/composition.js';
import {
  createAgentRuntime,
  developmentRoleInstructions,
  recoveryRoleInstructions,
  reviewerRoleInstructions,
} from '../src/agent-runtime/index.js';
import type { CodingRuntime, CodingRuntimeRequest } from '../src/adapters/coding-runtime.js';
import {
  createJiraAdapter,
  type JiraHttpRequest,
  type JiraHttpResponse,
} from '../src/adapters/jira.js';
import { createNotificationsAdapter } from '../src/adapters/notifications.js';
import {
  parseNexusConfiguration,
  parseProjectConfiguration,
  type NexusConfiguration,
  type ProjectConfiguration,
} from '../src/configuration/index.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const configurationDirectory = '/etc/nexus/project';
const installationDirectory = '/etc/nexus/installation';

/** The host credential values composition resolves; each is a controlled fake value. */
const hostEnvironment = {
  JIRA_API_TOKEN: 'host-resolved-jira-token',
  AWS_ACCESS_KEY_ID: 'host-resolved-access-key',
  AWS_SECRET_ACCESS_KEY: 'host-resolved-secret-key',
  AWS_SESSION_TOKEN: 'host-resolved-session-token',
};

/** The real parsed project configuration. */
function project(): ProjectConfiguration {
  return parseProjectConfiguration(projectConfiguration(), configurationDirectory);
}

/** The real parsed Nexus configuration. */
function nexus(): NexusConfiguration {
  return parseNexusConfiguration(nexusConfiguration(), installationDirectory);
}

/** How often the text contains the part. */
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('Jira construction', () => {
  it('uses the configured gateway API base and the host-resolved API token', async () => {
    const configuration = project();
    const settings = createJiraSettings(configuration, nexus(), hostEnvironment);
    const requests: JiraHttpRequest[] = [];
    const adapter = createJiraAdapter(settings, (request) => {
      requests.push(request);
      const answer: JiraHttpResponse = {
        status: 200,
        body: JSON.stringify({ id: '10001', key: 'NEX-7', fields: { summary: 'Task' } }),
      };
      return Promise.resolve(answer);
    });

    const issue = await adapter.readIssue('NEX-7');

    expect(issue.ok).toBe(true);
    expect(settings.connection.apiToken).toBe(hostEnvironment.JIRA_API_TOKEN);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${configuration.taskSource.apiBase}/rest/api/3/issue/NEX-7`,
    );
    expect(url.searchParams.get('fields')).toBe('*all,-comment');
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${hostEnvironment.JIRA_API_TOKEN}`);
  });

  it('requires the referenced host credential to be set', () => {
    expect(() => createJiraSettings(project(), nexus(), {})).toThrow(/JIRA_API_TOKEN/);
  });

  it('requires the project credential reference to identify a configured credential', () => {
    const configuration = projectConfiguration();
    configuration.taskSource.credential = 'missing';

    expect(() =>
      createJiraSettings(
        parseProjectConfiguration(configuration, configurationDirectory),
        nexus(),
        hostEnvironment,
      ),
    ).toThrow(/Unknown credential reference "missing"/);
  });
});

describe('Notifications construction', () => {
  it('uses the configured SNS Region, destination and host-resolved credentials', () => {
    const configuration = nexus();
    const settings = createNotificationSettings(configuration, hostEnvironment);

    expect(settings).toEqual({
      connection: { region: configuration.notifications.region },
      credentials: {
        accessKeyId: hostEnvironment.AWS_ACCESS_KEY_ID,
        secretAccessKey: hostEnvironment.AWS_SECRET_ACCESS_KEY,
        sessionToken: hostEnvironment.AWS_SESSION_TOKEN,
      },
      destination: configuration.notifications.destination,
    });
    expect(typeof createNotificationsAdapter(settings).publish).toBe('function');
  });

  it('leaves the session token unset when no reference is configured', () => {
    const configured = nexusConfiguration();
    delete configured.notifications.credentials.sessionToken;
    const settings = createNotificationSettings(
      parseNexusConfiguration(configured, installationDirectory),
      hostEnvironment,
    );

    expect(settings.credentials).toEqual({
      accessKeyId: hostEnvironment.AWS_ACCESS_KEY_ID,
      secretAccessKey: hostEnvironment.AWS_SECRET_ACCESS_KEY,
    });
  });

  it('requires the referenced host credentials to be set', () => {
    expect(() => createNotificationSettings(nexus(), {})).toThrow(/AWS_ACCESS_KEY_ID/);
  });
});

describe('AgentRuntime construction', () => {
  const workspaceRoot = '/srv/nexus/workspaces/NEX-7';
  const context = 'Task NEX-7\n\nImplement the requested change and return the report.';

  /** A real AgentRuntime over a recording coding provider with the settings composed for a role. */
  function harness(
    configuration: NexusConfiguration,
    role: ProfileRole,
  ): {
    readonly runtime: ReturnType<typeof createAgentRuntime>;
    readonly settings: ReturnType<typeof createAgentRuntimeSettings>;
    readonly requests: CodingRuntimeRequest[];
  } {
    const requests: CodingRuntimeRequest[] = [];
    const codingRuntime: CodingRuntime = {
      execute(request) {
        requests.push(request);
        return Promise.resolve({ ok: true, value: { output: '{"status":"completed"}' } });
      },
    };
    const settings = createAgentRuntimeSettings(configuration, role, codingRuntime);
    return { runtime: createAgentRuntime(settings), settings, requests };
  }

  it('includes each selected role constant exactly once for its role', async () => {
    const configuration = nexus();
    const selected = [
      {
        role: 'developer',
        profile: configuration.executionPolicy.developerLadder[0]!.profile,
        instructions: developmentRoleInstructions,
      },
      {
        role: 'reviewer',
        profile: configuration.executionPolicy.reviewerProfile,
        instructions: reviewerRoleInstructions,
      },
      {
        role: 'recovery',
        profile: configuration.executionPolicy.recoveryProfile,
        instructions: recoveryRoleInstructions,
      },
    ] as const;
    const configuredInitialProfile = configuration.agentRuntime.profiles.find(
      (candidate) => candidate.id === selected[0].profile,
    )!;
    expect(configuredInitialProfile.instructions.length).toBeGreaterThan(0);

    for (const { role, profile, instructions } of selected) {
      const { runtime, settings, requests } = harness(configuration, role);
      const result = await runtime.run(profile, { root: workspaceRoot }, context, () => undefined);
      expect(result.ok).toBe(true);

      const configured = configuration.agentRuntime.profiles.find(
        (candidate) => candidate.id === profile,
      )!;
      const request = requests.at(-1)!;
      expect(settings.profiles.find((candidate) => candidate.id === profile)?.instructions).toEqual(
        [...instructions, ...configured.instructions],
      );
      for (const instruction of instructions) {
        expect(occurrences(request.prompt, instruction)).toBe(1);
      }
      for (const instruction of configured.instructions) {
        expect(occurrences(request.prompt, instruction)).toBe(1);
      }
      expect(request.prompt).toContain(context);
      expect(request.prompt).toContain(configuration.agentRuntime.baseInstructions[0]!);
      expect(request.model).toBe(configured.model);
      expect(request.effort).toBe(configured.effort);
      expect(request.toolSettings).toEqual(configured.toolSettings);
      expect(request.directory).toBe(path.join(workspaceRoot, 'worktree'));
      expect(request.timeLimitMs).toBe(
        configuration.executionPolicy.agentInvocationLimitMinutes * 60_000,
      );
      expect(requests).toHaveLength(1);
    }
  });

  it('drops a configured copy of the selected role constant and keeps the other instructions', async () => {
    const configured = nexusConfiguration();
    const developer = configured.agentRuntime.profiles.find(
      (candidate) => candidate.id === configured.executionPolicy.developerLadder[0]!.profile,
    )!;
    const adapted = developmentRoleInstructions[0]!.replace(
      'You are the Nexus development agent.',
      'You are the Nexus development agent for this repository.',
    );
    developer.instructions = [
      'Open with the repository contribution guide.',
      ...developmentRoleInstructions,
      adapted,
      'Close with the verification evidence.',
    ];
    const configuration = parseNexusConfiguration(configured, installationDirectory);
    const { runtime, settings, requests } = harness(configuration, 'developer');

    expect(
      settings.profiles.find((candidate) => candidate.id === developer.id)?.instructions,
    ).toEqual([
      ...developmentRoleInstructions,
      'Open with the repository contribution guide.',
      adapted,
      'Close with the verification evidence.',
    ]);

    await runtime.run(developer.id, { root: workspaceRoot }, context, () => undefined);
    for (const instruction of developmentRoleInstructions) {
      expect(occurrences(requests[0]!.prompt, instruction)).toBe(1);
    }
    expect(occurrences(requests[0]!.prompt, adapted)).toBe(1);
  });

  it('gives a profile shared by the developer ladder and the reviewer only the invoked role', async () => {
    const developerAndReviewer = nexusConfiguration();
    const shared = developerAndReviewer.executionPolicy.developerLadder[0]!.profile;
    developerAndReviewer.executionPolicy.reviewerProfile = shared;
    const configuration = parseNexusConfiguration(developerAndReviewer, installationDirectory);
    const configured = configuration.agentRuntime.profiles.find(
      (candidate) => candidate.id === shared,
    )!;

    const developer = harness(configuration, 'developer');
    await expect(
      developer.runtime.run(shared, { root: workspaceRoot }, context, () => undefined),
    ).resolves.toEqual({
      ok: true,
      value: { output: '{"status":"completed"}' },
    });
    const developerPrompt = developer.requests[0]!.prompt;
    for (const instruction of developmentRoleInstructions) {
      expect(occurrences(developerPrompt, instruction)).toBe(1);
    }
    expect(developerPrompt).not.toContain(reviewerRoleInstructions[0]!);
    for (const instruction of configured.instructions) {
      expect(occurrences(developerPrompt, instruction)).toBe(1);
    }

    const reviewer = harness(configuration, 'reviewer');
    await expect(
      reviewer.runtime.run(shared, { root: workspaceRoot }, context, () => undefined),
    ).resolves.toEqual({
      ok: true,
      value: { output: '{"status":"completed"}' },
    });
    const reviewerPrompt = reviewer.requests[0]!.prompt;
    for (const instruction of reviewerRoleInstructions) {
      expect(occurrences(reviewerPrompt, instruction)).toBe(1);
    }
    expect(reviewerPrompt).not.toContain(developmentRoleInstructions[0]!);
    for (const instruction of configured.instructions) {
      expect(occurrences(reviewerPrompt, instruction)).toBe(1);
    }
  });

  it('gives a profile shared by the reviewer and recovery only the invoked role', async () => {
    const reviewerAndRecovery = nexusConfiguration();
    const shared = reviewerAndRecovery.executionPolicy.reviewerProfile;
    reviewerAndRecovery.executionPolicy.recoveryProfile = shared;
    const configuration = parseNexusConfiguration(reviewerAndRecovery, installationDirectory);
    const configured = configuration.agentRuntime.profiles.find(
      (candidate) => candidate.id === shared,
    )!;

    const reviewer = harness(configuration, 'reviewer');
    await expect(
      reviewer.runtime.run(shared, { root: workspaceRoot }, context, () => undefined),
    ).resolves.toEqual({
      ok: true,
      value: { output: '{"status":"completed"}' },
    });
    const reviewerPrompt = reviewer.requests[0]!.prompt;
    for (const instruction of reviewerRoleInstructions) {
      expect(occurrences(reviewerPrompt, instruction)).toBe(1);
    }
    expect(reviewerPrompt).not.toContain(recoveryRoleInstructions[0]!);

    const recovery = harness(configuration, 'recovery');
    await expect(
      recovery.runtime.run(shared, { root: workspaceRoot }, context, () => undefined),
    ).resolves.toEqual({
      ok: true,
      value: { output: '{"status":"completed"}' },
    });
    const recoveryPrompt = recovery.requests[0]!.prompt;
    for (const instruction of recoveryRoleInstructions) {
      expect(occurrences(recoveryPrompt, instruction)).toBe(1);
    }
    expect(recoveryPrompt).not.toContain(reviewerRoleInstructions[0]!);
    for (const instruction of configured.instructions) {
      expect(occurrences(reviewerPrompt, instruction)).toBe(1);
      expect(occurrences(recoveryPrompt, instruction)).toBe(1);
    }
  });

  it('keeps host credential values out of the assembled prompt', async () => {
    const configuration = nexus();
    const { runtime, requests } = harness(configuration, 'reviewer');

    await runtime.run(
      configuration.executionPolicy.reviewerProfile,
      { root: workspaceRoot },
      context,
      () => undefined,
    );

    for (const value of Object.values(hostEnvironment)) {
      expect(requests[0]!.prompt).not.toContain(value);
    }
  });
});
