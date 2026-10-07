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
  challengerRoleInstructions,
  developmentRoleInstructions,
  ideaEditorRoleInstructions,
  jevUseGuidance,
  memoryAnalysisGuidance,
  memoryUseGuidance,
  preparationRoleInstructions,
  projectGuideRoleInstructions,
  recoveryRoleInstructions,
  researcherRoleInstructions,
  reviewerRoleInstructions,
} from '../src/agent-runtime/index.js';
import {
  createJevCapability,
  jevExecutablePath,
  type JevCapability,
} from '../src/application/jev.js';
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
import {
  preparationReportingGuidance,
  preparationSharedGuidance,
} from '../src/task-engine/actions/preparation/context.js';
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

/** The controlled host environment with a JEv key: composition composes enabled JEv access. */
const jevHostEnvironment = {
  ...hostEnvironment,
  JEV_API_KEY: 'host-resolved-jev-key',
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
    environment: Readonly<Record<string, string | undefined>> = hostEnvironment,
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
    const settings = createAgentRuntimeSettings(configuration, role, codingRuntime, environment);
    return { runtime: createAgentRuntime(settings), settings, requests };
  }

  /** A coding runtime that is never invoked: construction settings do not run an invocation. */
  function unusedRuntime(): CodingRuntime {
    return {
      execute() {
        return Promise.resolve({ ok: true, value: { output: '{"status":"completed"}' } });
      },
    };
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
      // The configured native settings are preserved beside the composed JEv server entry.
      expect(request.toolSettings).toMatchObject(configured.toolSettings);
      expect(request.directory).toBe(path.join(workspaceRoot, 'worktree'));
      expect(request.timeLimitMs).toBe(
        configuration.executionPolicy.agentInvocationLimitMinutes * 60_000,
      );
      expect(requests).toHaveLength(1);
    }
  });

  it('carries the prototype author role on every profile of its escalation ladder', () => {
    const configuration = nexus();
    const authors = configuration.preparation.profiles.prototype.authors;
    // The configured ladder must actually escalate for this check to mean anything.
    expect(authors.length).toBeGreaterThan(1);
    const { settings } = harness(configuration, 'prototype-author');

    for (const profile of authors) {
      const configured = configuration.agentRuntime.profiles.find(
        (candidate) => candidate.id === profile,
      )!;
      // Every selectable ladder profile carries the prototype author's constant instructions, so a
      // promoted repair round never loses its role.
      expect(settings.profiles.find((candidate) => candidate.id === profile)?.instructions).toEqual(
        [...preparationRoleInstructions['prototype-author'], ...configured.instructions],
      );
    }
  });

  it('carries the developer role on every profile of its ladder', () => {
    const configuration = nexus();
    const ladder = configuration.executionPolicy.developerLadder;
    // The configured ladder must actually escalate for this check to mean anything.
    expect(ladder.length).toBeGreaterThan(1);
    const { settings } = harness(configuration, 'developer');

    for (const entry of ladder) {
      const configured = configuration.agentRuntime.profiles.find(
        (candidate) => candidate.id === entry.profile,
      )!;
      // Every selectable ladder profile carries the developer's constant instructions, so a
      // promoted repair round never loses its role.
      expect(
        settings.profiles.find((candidate) => candidate.id === entry.profile)?.instructions,
      ).toEqual([...developmentRoleInstructions, ...configured.instructions]);
    }
  });

  it('delivers the developer and reviewer coherence obligations once', async () => {
    const configuration = nexus();
    const selected = [
      {
        role: 'developer',
        profile: configuration.executionPolicy.developerLadder[0]!.profile,
        obligations: [
          "Apply the project's existing design and ownership principles",
          'Reconcile affected existing intent',
          'Remove superseded rules and mechanisms together with dependent validation',
          'confirmed shared ownership cause',
          'Complete this reconciliation before review',
          'preserve task scope and the existing gates',
        ],
      },
      {
        role: 'reviewer',
        profile: configuration.executionPolicy.reviewerProfile,
        obligations: [
          'Inspect whether the resulting',
          'superseded rules or mechanisms',
          'confirm any shared ownership cause',
          'Accept adequate work and keep optional suggestions distinct',
          'no extra attempts or bypass of revision-bound review, merge or check gates',
        ],
      },
    ] as const;

    for (const { role, profile, obligations } of selected) {
      const { runtime, requests } = harness(configuration, role);
      await runtime.run(profile, { root: workspaceRoot }, context, () => undefined);

      const prompt = requests[0]!.prompt;
      for (const obligation of obligations) {
        expect(occurrences(prompt, obligation), `${role}: ${obligation}`).toBe(1);
      }
    }
  });

  it('gives every preparation role its own constant and no shared preparation guidance', async () => {
    const configuration = nexus();
    const profiles = configuration.preparation.profiles;
    const selected: ReadonlyArray<{
      readonly role: ProfileRole;
      readonly profile: string;
      readonly instructions: readonly string[];
    }> = [
      {
        role: 'requirements-author',
        profile: profiles.requirements.author,
        instructions: preparationRoleInstructions['requirements-author'],
      },
      {
        role: 'requirements-evaluator',
        profile: profiles.requirements.evaluator,
        instructions: preparationRoleInstructions['requirements-evaluator'],
      },
      {
        role: 'ux-author',
        profile: profiles.ux.author,
        instructions: preparationRoleInstructions['ux-author'],
      },
      {
        role: 'ux-evaluator',
        profile: profiles.ux.evaluator,
        instructions: preparationRoleInstructions['ux-evaluator'],
      },
      ...profiles.prototype.authors.map(
        (
          profile,
        ): {
          readonly role: ProfileRole;
          readonly profile: string;
          readonly instructions: readonly string[];
        } => ({
          role: 'prototype-author',
          profile,
          instructions: preparationRoleInstructions['prototype-author'],
        }),
      ),
      {
        role: 'prototype-evaluator',
        profile: profiles.prototype.evaluator,
        instructions: preparationRoleInstructions['prototype-evaluator'],
      },
      {
        role: 'architecture-author',
        profile: profiles.architecture.author,
        instructions: preparationRoleInstructions['architecture-author'],
      },
      {
        role: 'architecture-evaluator',
        profile: profiles.architecture.evaluator,
        instructions: preparationRoleInstructions['architecture-evaluator'],
      },
    ];

    for (const { role, profile, instructions } of selected) {
      const { runtime, settings, requests } = harness(configuration, role);
      await runtime.run(profile, { root: workspaceRoot }, context, () => undefined);

      const request = requests.at(-1)!;
      const attached = settings.profiles.find(
        (candidate) => candidate.id === profile,
      )!.instructions;
      expect(occurrences(request.prompt, instructions.join('\n\n')), `${role} role constant`).toBe(
        1,
      );
      for (const instruction of instructions) {
        expect(request.prompt, `${role}: ${instruction}`).toContain(instruction);
      }
      // The shared preparation guidance and the reporting mechanics belong to the action-supplied
      // stage context, never to a selected profile: a profile carries only the invoked role's
      // specific instructions.
      expect(attached.join('\n')).not.toContain(preparationSharedGuidance);
      expect(attached.join('\n')).not.toContain(preparationReportingGuidance);
      expect(request.prompt).not.toContain(preparationSharedGuidance);
      expect(request.prompt).not.toContain(preparationReportingGuidance);
      expect(request.prompt).toContain(context);
      for (const other of selected) {
        if (other.role !== role) {
          expect(request.prompt, `${role} excludes ${other.role}`).not.toContain(
            other.instructions[0]!,
          );
        }
      }
    }
  });

  it('gives every preparation author and evaluator the explicit shared memory tools', async () => {
    const configured = nexusConfiguration();
    configured.memory = {
      enabled: true,
      serviceUrl: 'http://127.0.0.1:8081',
      mcp: { command: 'npx', args: ['-y', 'amem-mcp'], directory: '/opt/amem' },
      analysisProfile: 'nexus-astra',
    };
    const configuration = parseNexusConfiguration(configured, installationDirectory);
    const profiles = configuration.preparation.profiles;
    const selected: readonly { readonly role: ProfileRole; readonly profile: string }[] = [
      { role: 'requirements-author', profile: profiles.requirements.author },
      { role: 'requirements-evaluator', profile: profiles.requirements.evaluator },
      { role: 'ux-author', profile: profiles.ux.author },
      { role: 'ux-evaluator', profile: profiles.ux.evaluator },
      ...profiles.prototype.authors.map(
        (profile): { readonly role: ProfileRole; readonly profile: string } => ({
          role: 'prototype-author',
          profile,
        }),
      ),
      { role: 'prototype-evaluator', profile: profiles.prototype.evaluator },
      { role: 'architecture-author', profile: profiles.architecture.author },
      { role: 'architecture-evaluator', profile: profiles.architecture.evaluator },
    ];

    for (const { role, profile } of selected) {
      const { runtime, settings, requests } = harness(configuration, role);
      await runtime.run(profile, { root: workspaceRoot }, context, () => undefined);
      const tools = settings.profiles.find((candidate) => candidate.id === profile)!.toolSettings;
      // Search and save are both available: no `enabled_tools` restriction narrows the server to
      // the analysis role's search-only access.
      expect(tools).toMatchObject({ config: { 'mcp_servers.amem.enabled': true } });
      expect(
        (tools as { config: Record<string, unknown> }).config['mcp_servers.amem.enabled_tools'],
      ).toBeUndefined();
      expect(requests.at(-1)!.prompt).toContain(memoryUseGuidance);
    }
  });

  it('removes configured copies of Nexus-owned guidance whenever the capability is unavailable', async () => {
    const configured = nexusConfiguration();
    configured.agentRuntime.baseInstructions = [
      ...configured.agentRuntime.baseInstructions,
      memoryUseGuidance,
    ];
    configured.agentRuntime.profiles[0]!.instructions = [
      ...configured.agentRuntime.profiles[0]!.instructions,
      memoryAnalysisGuidance,
      memoryUseGuidance,
    ];
    const configuration = parseNexusConfiguration(configured, installationDirectory);
    const { runtime, settings, requests } = harness(configuration, 'developer');

    await runtime.run('nexus-flash', { root: workspaceRoot }, context, () => undefined);

    // Memory is omitted, so neither the general memory guidance nor the analyst-only guidance is
    // supplied, and configured copies cannot leave a false availability statement in the prompt.
    expect(occurrences(requests.at(-1)!.prompt, memoryUseGuidance)).toBe(0);
    expect(occurrences(requests.at(-1)!.prompt, memoryAnalysisGuidance)).toBe(0);
    expect(settings.baseInstructions).not.toContain(memoryUseGuidance);
    expect(
      settings.profiles.find((profile) => profile.id === 'nexus-flash')!.instructions,
    ).not.toContain(memoryAnalysisGuidance);
    expect(settings.baseInstructions).toContain('Follow the project documentation.');

    // With memory enabled the applicable constant is supplied once and the analyst-only constant
    // a developer configured is still removed.
    const enabled = nexusConfiguration();
    enabled.memory = {
      enabled: true,
      serviceUrl: 'http://127.0.0.1:8081',
      mcp: { command: 'npx', args: ['-y', 'amem-mcp'], directory: '/opt/amem' },
      analysisProfile: 'nexus-astra',
    };
    enabled.agentRuntime.baseInstructions = [
      ...enabled.agentRuntime.baseInstructions,
      memoryUseGuidance,
    ];
    enabled.agentRuntime.profiles[0]!.instructions = [
      ...enabled.agentRuntime.profiles[0]!.instructions,
      memoryAnalysisGuidance,
    ];
    const enabledHarness = harness(
      parseNexusConfiguration(enabled, installationDirectory),
      'developer',
    );
    await enabledHarness.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      context,
      () => undefined,
    );
    expect(occurrences(enabledHarness.requests.at(-1)!.prompt, memoryUseGuidance)).toBe(1);
    expect(occurrences(enabledHarness.requests.at(-1)!.prompt, memoryAnalysisGuidance)).toBe(0);
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

  it('gives each idea refinement role its own constant prompt', async () => {
    const configuration = nexus();
    const ideaProfiles = configuration.ideaRefinement.profiles;
    const selected = [
      {
        role: 'idea-editor',
        profile: ideaProfiles.editor,
        instructions: ideaEditorRoleInstructions,
      },
      {
        role: 'researcher',
        profile: ideaProfiles.researcher,
        instructions: researcherRoleInstructions,
      },
      {
        role: 'project-guide',
        profile: ideaProfiles.projectGuide,
        instructions: projectGuideRoleInstructions,
      },
      {
        role: 'challenger',
        profile: ideaProfiles.challenger,
        instructions: challengerRoleInstructions,
      },
    ] as const;

    for (const { role, profile, instructions } of selected) {
      const { runtime, settings, requests } = harness(configuration, role);
      await runtime.run(profile, { root: workspaceRoot }, context, () => undefined);

      const request = requests.at(-1)!;
      const attached = settings.profiles.find(
        (candidate) => candidate.id === profile,
      )!.instructions;
      for (const instruction of instructions) {
        expect(occurrences(request.prompt, instruction)).toBe(1);
        expect(attached).toContain(instruction);
      }
      // The editor, researcher and Project guide share a profile; each invocation carries only
      // its own role constant and none of the other idea roles' duties.
      for (const other of selected) {
        if (other.role !== role) {
          expect(request.prompt).not.toContain(other.instructions[0]!);
        }
      }
      expect(request.prompt).toContain(context);
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

  it('composes optional JEv access and its guidance once for every role and profile', async () => {
    const enabled = nexusConfiguration();
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    const configuration = parseNexusConfiguration(enabled, installationDirectory);
    const preparation = configuration.preparation.profiles;
    const idea = configuration.ideaRefinement.profiles;
    const ladder = configuration.executionPolicy.developerLadder.map((entry) => entry.profile);
    const selectable: readonly {
      readonly role: ProfileRole;
      readonly profiles: readonly string[];
    }[] = [
      { role: 'developer', profiles: ladder },
      { role: 'reviewer', profiles: [configuration.executionPolicy.reviewerProfile] },
      { role: 'recovery', profiles: [configuration.executionPolicy.recoveryProfile] },
      { role: 'idea-editor', profiles: [idea.editor] },
      { role: 'researcher', profiles: [idea.researcher] },
      { role: 'project-guide', profiles: [idea.projectGuide] },
      { role: 'challenger', profiles: [idea.challenger] },
      { role: 'requirements-author', profiles: [preparation.requirements.author] },
      { role: 'requirements-evaluator', profiles: [preparation.requirements.evaluator] },
      { role: 'ux-author', profiles: [preparation.ux.author] },
      { role: 'ux-evaluator', profiles: [preparation.ux.evaluator] },
      { role: 'prototype-author', profiles: preparation.prototype.authors },
      { role: 'prototype-evaluator', profiles: [preparation.prototype.evaluator] },
      { role: 'architecture-author', profiles: [preparation.architecture.author] },
      { role: 'architecture-evaluator', profiles: [preparation.architecture.evaluator] },
    ];

    for (const { role, profiles } of selectable) {
      const { runtime, settings, requests } = harness(configuration, role, jevHostEnvironment);
      for (const profile of profiles) {
        await runtime.run(profile, { root: workspaceRoot }, context, () => undefined);
        const tools = settings.profiles.find((candidate) => candidate.id === profile)!.toolSettings;
        expect(tools, `${role}: ${profile}`).toMatchObject({
          isolatedMcpServers: ['jev'],
          config: {
            'mcp_servers.jev.command': jevExecutablePath(),
            'mcp_servers.jev.args': [],
            'mcp_servers.jev.enabled': true,
            'mcp_servers.jev.required': false,
            'mcp_servers.jev.enabled_tools': ['ask_jev'],
            'mcp_servers.jev.disabled_tools': [],
            'mcp_servers.jev.env_vars': ['JEV_API_KEY'],
          },
        });
        expect(occurrences(requests.at(-1)!.prompt, jevUseGuidance)).toBe(1);
      }
    }
  });

  it('keeps existing tools and the search-only analysis memory access with enabled JEv', async () => {
    const enabled = nexusConfiguration();
    enabled.memory = {
      enabled: true,
      serviceUrl: 'http://127.0.0.1:4748',
      mcp: { command: 'npm', args: ['run', '--silent', 'mcp'], directory: './agentic-memory' },
      analysisProfile: 'nexus-astra',
    };
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    const configuration = parseNexusConfiguration(enabled, installationDirectory);

    const developer = harness(configuration, 'developer', jevHostEnvironment).settings;
    const tools = developer.profiles.find((profile) => profile.id === 'nexus-flash')!.toolSettings;
    expect(tools).toMatchObject({
      config: {
        'mcp_servers.amem.enabled': true,
        'mcp_servers.jev.enabled': true,
      },
    });
    // Search and save stay available to the developer; only the analyst is restricted to search.
    expect(JSON.stringify(tools)).not.toContain('mcp_servers.amem.enabled_tools');

    const analysis = harness(configuration, 'analysis', jevHostEnvironment).settings;
    const analyst = analysis.profiles.find((profile) => profile.id === 'nexus-astra')!.toolSettings;
    expect(analyst).toMatchObject({
      config: {
        'mcp_servers.amem.enabled_tools': ['memory_search'],
        'mcp_servers.jev.enabled': true,
      },
    });
  });

  it('composes no JEv tool or guidance when disabled, omitted or missing its host key', async () => {
    // A base configuration that would otherwise enable the reserved server is overridden, and a
    // configured copy of the Nexus-owned guidance is removed from base and profile instructions.
    /** Add a configured copy of the owned constant to the base and selected profile instructions. */
    const repeatGuidance = (
      configuration: ReturnType<typeof nexusConfiguration>,
    ): ReturnType<typeof nexusConfiguration> => {
      configuration.agentRuntime.baseInstructions = [
        ...configuration.agentRuntime.baseInstructions,
        jevUseGuidance,
      ];
      configuration.agentRuntime.profiles[0]!.instructions = [
        ...configuration.agentRuntime.profiles[0]!.instructions,
        jevUseGuidance,
      ];
      return configuration;
    };
    const inherited = nexusConfiguration();
    inherited.agentRuntime.profiles[0]!.toolSettings = {
      profile: 'nexus-flash',
      config: { 'mcp_servers.jev.enabled': true },
    };
    const omitted = parseNexusConfiguration(repeatGuidance(inherited), installationDirectory);
    const { runtime, settings, requests } = harness(omitted, 'developer');
    await runtime.run('nexus-flash', { root: workspaceRoot }, context, () => undefined);
    const tools = settings.profiles.find((profile) => profile.id === 'nexus-flash')!.toolSettings;
    expect(tools).toMatchObject({ config: { 'mcp_servers.jev.enabled': false } });
    expect(occurrences(requests.at(-1)!.prompt, jevUseGuidance)).toBe(0);
    expect(settings.baseInstructions).not.toContain(jevUseGuidance);
    expect(
      settings.profiles.find((profile) => profile.id === 'nexus-flash')!.instructions,
    ).not.toContain(jevUseGuidance);
    // Unrelated configured instructions survive the removal.
    expect(settings.baseInstructions).toContain('Follow the project documentation.');

    const disabled = nexusConfiguration();
    disabled.jev = { enabled: false, credential: 'jevApiKey' };
    const parsed = parseNexusConfiguration(repeatGuidance(disabled), installationDirectory);
    const disabledHarness = harness(parsed, 'developer', jevHostEnvironment);
    await disabledHarness.runtime.run(
      'nexus-flash',
      { root: workspaceRoot },
      context,
      () => undefined,
    );
    expect(
      disabledHarness.settings.profiles.find((profile) => profile.id === 'nexus-flash')!
        .toolSettings,
    ).toMatchObject({ config: { 'mcp_servers.jev.enabled': false } });
    expect(occurrences(disabledHarness.requests.at(-1)!.prompt, jevUseGuidance)).toBe(0);

    const enabled = nexusConfiguration();
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    const parsedEnabled = parseNexusConfiguration(repeatGuidance(enabled), installationDirectory);
    const missingKey = harness(parsedEnabled, 'developer', hostEnvironment);
    await missingKey.runtime.run('nexus-flash', { root: workspaceRoot }, context, () => undefined);
    expect(
      missingKey.settings.profiles.find((profile) => profile.id === 'nexus-flash')!.toolSettings,
    ).toMatchObject({ config: { 'mcp_servers.jev.enabled': false } });
    expect(occurrences(missingKey.requests.at(-1)!.prompt, jevUseGuidance)).toBe(0);
  });

  it('owns the reserved JEv server settings a profile configuration supplies', async () => {
    const conflicting = {
      'mcp_servers.jev.command': '/inherited/nexus/node_modules/.bin/jev-mcp',
      'mcp_servers.jev.args': ['--inherited'],
      'mcp_servers.jev.enabled': true,
      'mcp_servers.jev.required': true,
      'mcp_servers.jev.enabled_tools': ['other_tool'],
      'mcp_servers.jev.disabled_tools': ['ask_jev'],
      'mcp_servers.jev.env_vars': ['JEV_MODEL'],
      'mcp_servers.jev.env': {
        JEV_MODEL: 'inherited-model',
        JEV_TIMEOUT_MS: '13',
        JEV_API_KEY: 'inherited-key',
      },
      'mcp_servers.jev.url': 'https://example.invalid/mcp',
      'mcp_servers.amem.command': 'kept',
    };
    const owned = {
      'mcp_servers.jev.command': jevExecutablePath(),
      'mcp_servers.jev.args': [],
      'mcp_servers.jev.enabled': true,
      'mcp_servers.jev.required': false,
      'mcp_servers.jev.enabled_tools': ['ask_jev'],
      'mcp_servers.jev.disabled_tools': [],
      'mcp_servers.jev.env_vars': ['JEV_API_KEY'],
    };

    const enabled = nexusConfiguration();
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    enabled.agentRuntime.profiles[0]!.toolSettings = {
      profile: 'nexus-flash',
      config: { ...conflicting },
    };
    const enabledSettings = createAgentRuntimeSettings(
      parseNexusConfiguration(enabled, installationDirectory),
      'developer',
      unusedRuntime(),
      jevHostEnvironment,
    );
    const enabledProfile = enabledSettings.profiles.find(
      (profile) => profile.id === 'nexus-flash',
    )!;
    expect(enabledProfile.toolSettings).toMatchObject({ profile: 'nexus-flash', config: owned });
    // No inherited conflicting setting survives: no literal environment, HTTP transport,
    // tool exclusion or stale command can alter the reserved server's effective configuration.
    expect(
      Object.keys(enabledProfile.toolSettings['config'] as Record<string, unknown>)
        .filter((key) => key.startsWith('mcp_servers.jev.'))
        .sort(),
    ).toEqual(Object.keys(owned).sort());
    // Unrelated profile settings keep their ownership.
    expect(
      (enabledProfile.toolSettings['config'] as Record<string, unknown>)[
        'mcp_servers.amem.command'
      ],
    ).toBe('kept');

    // Disabled and omitted integrations own the server the same way, so an inherited HTTP entry
    // cannot make the composed stdio command invalid at provider bootstrap.
    const omitted = nexusConfiguration();
    omitted.agentRuntime.profiles[0]!.toolSettings = {
      profile: 'nexus-flash',
      config: { ...conflicting },
    };
    const omittedSettings = createAgentRuntimeSettings(
      parseNexusConfiguration(omitted, installationDirectory),
      'developer',
      unusedRuntime(),
      jevHostEnvironment,
    );
    const omittedProfile = omittedSettings.profiles.find(
      (profile) => profile.id === 'nexus-flash',
    )!;
    expect(omittedProfile.toolSettings).toMatchObject({
      profile: 'nexus-flash',
      config: { ...owned, 'mcp_servers.jev.enabled': false },
    });
    expect(
      (omittedProfile.toolSettings['config'] as Record<string, unknown>)['mcp_servers.jev.url'],
    ).toBeUndefined();
  });

  it('preserves malformed native configuration for the coding adapter to reject', () => {
    const configured = nexusConfiguration();
    configured.agentRuntime.profiles[0]!.toolSettings = {
      profile: 'nexus-flash',
      config: ['invalid-native-setting'],
    };
    const settings = createAgentRuntimeSettings(
      parseNexusConfiguration(configured, installationDirectory),
      'developer',
      unusedRuntime(),
      hostEnvironment,
    );

    // Composition does not normalize the invalid value into an empty override object: the real
    // coding adapter owns rejecting it, as it did before JEv settings were always composed.
    expect(settings.profiles.find((profile) => profile.id === 'nexus-flash')!.toolSettings).toEqual(
      { profile: 'nexus-flash', config: ['invalid-native-setting'] },
    );

    // A disabled integration preserves the malformed value the same way.
    const disabled = nexusConfiguration();
    disabled.jev = { enabled: false, credential: 'jevApiKey' };
    disabled.agentRuntime.profiles[0]!.toolSettings = {
      profile: 'nexus-flash',
      config: ['invalid-native-setting'],
    };
    const disabledSettings = createAgentRuntimeSettings(
      parseNexusConfiguration(disabled, installationDirectory),
      'developer',
      unusedRuntime(),
      jevHostEnvironment,
    );
    expect(
      disabledSettings.profiles.find((profile) => profile.id === 'nexus-flash')!.toolSettings,
    ).toEqual({ profile: 'nexus-flash', config: ['invalid-native-setting'] });
  });

  it('supplies the composed JEv guidance once when a configured instruction repeats it', async () => {
    const enabled = nexusConfiguration();
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    enabled.agentRuntime.baseInstructions = [
      ...enabled.agentRuntime.baseInstructions,
      jevUseGuidance,
    ];
    enabled.agentRuntime.profiles[0]!.instructions = [
      ...enabled.agentRuntime.profiles[0]!.instructions,
      jevUseGuidance,
    ];
    const configuration = parseNexusConfiguration(enabled, installationDirectory);
    const { runtime, settings, requests } = harness(configuration, 'developer', jevHostEnvironment);

    await runtime.run('nexus-flash', { root: workspaceRoot }, context, () => undefined);

    expect(occurrences(requests.at(-1)!.prompt, jevUseGuidance)).toBe(1);
    expect(
      settings.profiles.find((profile) => profile.id === 'nexus-flash')!.instructions,
    ).not.toContain(jevUseGuidance);
    expect(settings.baseInstructions).toContain(jevUseGuidance);
  });

  it('keeps the composed JEv key out of settings and prompts', async () => {
    const enabled = nexusConfiguration();
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    const configuration = parseNexusConfiguration(enabled, installationDirectory);
    const { runtime, settings, requests } = harness(configuration, 'developer', jevHostEnvironment);

    await runtime.run('nexus-flash', { root: workspaceRoot }, context, () => undefined);

    const key = jevHostEnvironment.JEV_API_KEY;
    expect(JSON.stringify(settings)).not.toContain(key);
    expect(requests.at(-1)!.prompt).not.toContain(key);
    expect(JSON.stringify(requests.at(-1)!.toolSettings)).not.toContain(key);
  });
});

describe('JEv capability construction', () => {
  /** The constructed capability, failing the check when the integration is unexpectedly disabled. */
  function capabilityOf(
    configuration: NexusConfiguration,
    environment: Readonly<Record<string, string | undefined>>,
  ): JevCapability {
    const capability = createJevCapability(configuration, environment);
    if (capability === null) {
      throw new Error('the JEv capability is absent although the integration is enabled');
    }
    return capability;
  }

  it('constructs the public client only for an enabled integration with a host key', () => {
    const omitted = nexus();
    expect(createJevCapability(omitted, jevHostEnvironment)).toBeNull();

    const disabled = nexusConfiguration();
    disabled.jev = { enabled: false, credential: 'jevApiKey' };
    expect(
      createJevCapability(
        parseNexusConfiguration(disabled, installationDirectory),
        jevHostEnvironment,
      ),
    ).toBeNull();

    const enabled = nexusConfiguration();
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    const configuration = parseNexusConfiguration(enabled, installationDirectory);
    const capability = createJevCapability(configuration, jevHostEnvironment);
    expect(capability?.kind).toBe('available');
    if (capability?.kind !== 'available') {
      throw new Error('the enabled integration did not construct a client');
    }
    expect(typeof capability.client.evaluate).toBe('function');
  });

  it('reports missing credentials and unusable keys without failing construction', () => {
    const enabled = nexusConfiguration();
    enabled.jev = { enabled: true, credential: 'jevApiKey' };
    const configuration = parseNexusConfiguration(enabled, installationDirectory);

    expect(capabilityOf(configuration, {}).kind).toBe('missing-credential');
    expect(capabilityOf(configuration, { JEV_API_KEY: '' }).kind).toBe('missing-credential');
    expect(capabilityOf(configuration, { JEV_API_KEY: 'bad\u0000key' }).kind).toBe('unavailable');
  });
});
