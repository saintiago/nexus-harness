import path from 'node:path';
import {
  challengerRoleInstructions,
  developmentRoleInstructions,
  type IdeaRole,
  ideaEditorRoleInstructions,
  memoryAnalysisGuidance,
  memoryUseGuidance,
  preparationRoleInstructions,
  preparationRoles,
  projectGuideRoleInstructions,
  recoveryRoleInstructions,
  researcherRoleInstructions,
  reviewerRoleInstructions,
  type AgentProfile,
  type AgentRuntimeSettings,
  type PreparationRole,
} from '../agent-runtime/index.js';
import type { CodingRuntime } from '../adapters/coding-runtime.js';
import type { JiraSettings } from '../adapters/jira.js';
import type { NotificationSettings } from '../adapters/notifications.js';
import {
  resolveCredential,
  type NexusConfiguration,
  type PreparationStage,
  type ProjectConfiguration,
} from '../configuration/index.js';
import { installationConfigSetting } from './installation.js';

/**
 * Composition turns resolved project and Nexus configuration into the construction settings of
 * the components. It resolves credential references against the host, attaches the selected role's
 * constant instructions and hands every capability through unchanged. Each component's own
 * constructor performs the construction; this module contains no lifecycle or commands.
 */

/** The host environment credential references resolve their values from. */
type HostEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The role whose constant instructions one invocation carries, selected by the execution policy.
 * The analysis role has no role constants: its guidance is the shared memory-analysis instruction.
 */
export type ProfileRole =
  'developer' | 'reviewer' | 'recovery' | 'analysis' | IdeaRole | PreparationRole;

/** The complete constant instructions of each role, defined by the role contracts. */
const roleInstructions: Record<ProfileRole, readonly string[]> = {
  developer: developmentRoleInstructions,
  reviewer: reviewerRoleInstructions,
  recovery: recoveryRoleInstructions,
  analysis: [],
  'idea-editor': ideaEditorRoleInstructions,
  researcher: researcherRoleInstructions,
  'project-guide': projectGuideRoleInstructions,
  challenger: challengerRoleInstructions,
  ...preparationRoleInstructions,
};

/** The configured idea refinement profile of each role. */
const ideaRoleSettings: Record<IdeaRole, keyof NexusConfiguration['ideaRefinement']['profiles']> = {
  'idea-editor': 'editor',
  researcher: 'researcher',
  'project-guide': 'projectGuide',
  challenger: 'challenger',
};

/** The configured stage and part each evaluated preparation role selects a profile for. */
export const preparationRoleSettings: Record<
  PreparationRole,
  { readonly stage: PreparationStage; readonly part: 'author' | 'evaluator' }
> = {
  'requirements-author': { stage: 'requirements', part: 'author' },
  'requirements-evaluator': { stage: 'requirements', part: 'evaluator' },
  'ux-author': { stage: 'ux', part: 'author' },
  'ux-evaluator': { stage: 'ux', part: 'evaluator' },
  'prototype-author': { stage: 'prototype', part: 'author' },
  'prototype-evaluator': { stage: 'prototype', part: 'evaluator' },
  'architecture-author': { stage: 'architecture', part: 'author' },
  'architecture-evaluator': { stage: 'architecture', part: 'evaluator' },
};

/**
 * The roles whose invocations receive the explicit AMEM memory tools when memory is enabled. The
 * experience-analysis profile is configured separately under the analysis contract, which exposes
 * search without direct saving because AnalyzeExperience submits the validated observations.
 */
const memoryToolRoles: ReadonlySet<ProfileRole> = new Set<ProfileRole>([
  'developer',
  'reviewer',
  'recovery',
  'idea-editor',
  'researcher',
  'project-guide',
  'challenger',
  ...preparationRoles,
]);

/**
 * The provider-native settings that launch the AMEM MCP server for one invocation: the configured
 * entry point, the shared service URL and the server's own identity. The provider's MCP support
 * owns the protocol; Nexus exports no tool server of its own.
 */
function memoryAgentSettings(
  memory: NexusConfiguration['memory'],
): Readonly<Record<string, unknown>> {
  if (memory === undefined || !memory.enabled) {
    return {};
  }
  return {
    'mcp_servers.amem.command': memory.mcp.command,
    'mcp_servers.amem.args': [...memory.mcp.args],
    'mcp_servers.amem.cwd': memory.mcp.directory,
    'mcp_servers.amem.env': { AMEM_MCP_SERVICE_URL: memory.serviceUrl },
    'mcp_servers.amem.enabled': true,
  };
}

/**
 * The AMEM MCP settings of the experience-analysis profile: the same configured server, restricted
 * to search because Nexus submits the analyst's validated observations itself.
 */
function memoryAnalysisToolSettings(
  memory: NexusConfiguration['memory'],
): Readonly<Record<string, unknown>> {
  if (memory === undefined || !memory.enabled) {
    return {};
  }
  return { ...memoryAgentSettings(memory), 'mcp_servers.amem.enabled_tools': ['memory_search'] };
}

/** One configured profile's tool settings with the memory tools added to its native overrides. */
function withMemoryTools(
  profile: AgentProfile,
  memoryTools: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (Object.keys(memoryTools).length === 0) {
    return profile.toolSettings;
  }
  const configured = profile.toolSettings['config'];
  const config =
    typeof configured === 'object' && configured !== null && !Array.isArray(configured)
      ? (configured as Readonly<Record<string, unknown>>)
      : {};
  return { ...profile.toolSettings, config: { ...config, ...memoryTools } };
}

/**
 * The profiles the execution policy selects for one role: developer ladder entries identify
 * developer profiles, the reviewer profile identifies a reviewer profile, the recovery profile
 * identifies a recovery profile, the configured analysis profile identifies the analysis role and
 * the idea refinement settings identify the four idea roles. One profile may be selected for more
 * than one role.
 */
function profilesForRole(
  configuration: NexusConfiguration,
  role: ProfileRole,
): ReadonlySet<string> {
  const { developerLadder, reviewerProfile, recoveryProfile } = configuration.executionPolicy;
  const preparation = preparationRoles.find((candidate) => candidate === role);
  if (preparation !== undefined) {
    const selected = preparationRoleSettings[preparation];
    const profiles = configuration.preparation.profiles[selected.stage];
    if (selected.part === 'author') {
      // Every profile of the prototype author ladder may be selected for the role, so each one
      // carries the role's instructions and tools.
      return new Set('authors' in profiles ? profiles.authors : [profiles.author]);
    }
    return new Set([profiles.evaluator]);
  }
  switch (role) {
    case 'developer':
      return new Set(developerLadder.map((entry) => entry.profile));
    case 'reviewer':
      return new Set([reviewerProfile]);
    case 'recovery':
      return new Set([recoveryProfile]);
    case 'analysis': {
      const memory = configuration.memory;
      return new Set(memory === undefined || !memory.enabled ? [] : [memory.analysisProfile]);
    }
    case 'idea-editor':
    case 'researcher':
    case 'project-guide':
    case 'challenger':
      return new Set([configuration.ideaRefinement.profiles[ideaRoleSettings[role]]]);
    default:
      throw new Error(`No configured profile role "${String(role)}" exists.`);
  }
}

/**
 * The Jira construction settings for one project. The configured API base is supplied verbatim,
 * preserving a cloud connection's gateway prefix, and the API token comes from the host.
 */
export function createJiraSettings(
  project: ProjectConfiguration,
  nexus: NexusConfiguration,
  environment: HostEnvironment = process.env,
): JiraSettings {
  const { apiBase, project: projectKey, credential, fields } = project.taskSource;
  return {
    connection: {
      apiBase,
      apiToken: resolveCredential(nexus, credential, environment),
    },
    project: projectKey,
    fields,
  };
}

/** The Notifications construction settings: the configured Region and destination and the SNS
 * credentials resolved from the host. The session token reference is optional. */
export function createNotificationSettings(
  nexus: NexusConfiguration,
  environment: HostEnvironment = process.env,
): NotificationSettings {
  const { region, destination, credentials } = nexus.notifications;
  return {
    connection: { region },
    credentials: {
      accessKeyId: resolveCredential(nexus, credentials.accessKeyId, environment),
      secretAccessKey: resolveCredential(nexus, credentials.secretAccessKey, environment),
      ...(credentials.sessionToken === undefined
        ? {}
        : { sessionToken: resolveCredential(nexus, credentials.sessionToken, environment) }),
    },
    destination,
  };
}

/**
 * The AgentRuntime construction settings for one role: the supplied coding-provider capability and
 * the configured base instructions and invocation limit, and the configured profiles as
 * AgentProfile values. Each invocation supplies its own activity observer. The profiles this role
 * selects carry that role's constant
 * instructions followed by their configured instructions and their native tool settings. A
 * configured instruction that exactly repeats a selected role constant is dropped, so the constant
 * is stated once per invocation; all other configured instructions keep their order. Selecting one
 * profile for several roles attaches only the invoked role's constant, so role instructions are
 * never combined.
 */
export function createAgentRuntimeSettings(
  nexus: NexusConfiguration,
  role: ProfileRole,
  codingRuntime: CodingRuntime,
): AgentRuntimeSettings {
  const selected = profilesForRole(nexus, role);
  // The memory guidance and tools accompany each other: a role without the tools does not carry
  // instructions for a capability its invocation cannot use. The analysis role instead searches
  // shared memory without saving, because AnalyzeExperience submits its validated observations.
  const memoryTools =
    role === 'analysis'
      ? memoryAnalysisToolSettings(nexus.memory)
      : memoryToolRoles.has(role)
        ? memoryAgentSettings(nexus.memory)
        : {};
  const memoryGuidance =
    Object.keys(memoryTools).length === 0
      ? null
      : role === 'analysis'
        ? memoryAnalysisGuidance
        : memoryUseGuidance;
  return {
    codingRuntime,
    baseInstructions:
      memoryGuidance !== null
        ? [...nexus.agentRuntime.baseInstructions, memoryGuidance]
        : nexus.agentRuntime.baseInstructions,
    profiles: nexus.agentRuntime.profiles.map((profile): AgentProfile => {
      const constants = selected.has(profile.id) ? roleInstructions[role] : undefined;
      return {
        id: profile.id,
        model: profile.model,
        effort: profile.effort,
        instructions:
          constants === undefined
            ? profile.instructions
            : [
                ...constants,
                ...profile.instructions.filter((instruction) => !constants.includes(instruction)),
              ],
        toolSettings: selected.has(profile.id)
          ? withMemoryTools(profile, memoryTools)
          : profile.toolSettings,
      };
    }),
    invocationLimitMinutes: nexus.executionPolicy.agentInvocationLimitMinutes,
  };
}

/** The stable queue execution state and record paths for one configured project. */
export type ExecutionPaths = {
  /** The execution directory: workflow state, task selection and recovery records. */
  readonly directory: string;
  /** The ExecutionRunner's workflow-state filepath. */
  readonly workflowStateFile: string;
  /** SelectWork's selection filepath. */
  readonly selectionFile: string;
};

/**
 * The execution directory and record paths Application supplies for one project. The composed
 * project parent and all of its children share one workflow state, selection and log directory.
 */
export function executionPaths(
  nexus: NexusConfiguration,
  project: ProjectConfiguration,
): ExecutionPaths {
  const directory = path.join(nexus.storage.root, 'executions', project.taskSource.project);
  return {
    directory,
    workflowStateFile: path.join(directory, 'workflow.json'),
    selectionFile: path.join(directory, 'selection.json'),
  };
}

/** The root under which task workspaces live for every configured project. */
export function workspaceRoot(nexus: NexusConfiguration): string {
  return path.join(nexus.storage.root, 'workspaces');
}

/**
 * The project's durable experience store: AnalyzeExperience's requests, analyses, submissions and
 * capture evidence, beside the workflow's execution state and outside every disposable workflow
 * attempt, so pending and interrupted work survives process exit.
 */
export function experienceStoreDirectory(paths: ExecutionPaths): string {
  return path.join(paths.directory, 'memory');
}

/** The host environment without the named settings, ready to spawn a child with. */
function withoutSettings(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string> {
  const excluded = new Set(names);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !excluded.has(name)) {
      result[name] = value;
    }
  }
  return result;
}

/** The host environment settings a list of credential references resolve their values from. */
function credentialSettings(nexus: NexusConfiguration, references: readonly string[]): string[] {
  return references.flatMap((reference) => {
    const resolution = nexus.credentials[reference];
    return resolution === undefined ? [] : [resolution.environment];
  });
}

/** The credential references the Notifications adapter resolves. */
function notificationCredentialReferences(nexus: NexusConfiguration): string[] {
  const { accessKeyId, secretAccessKey, sessionToken } = nexus.notifications.credentials;
  return sessionToken === undefined
    ? [accessKeyId, secretAccessKey]
    : [accessKeyId, secretAccessKey, sessionToken];
}

/**
 * The environment the worker process runs with: the parent environment without the notification
 * credentials only the parent's Notifications adapter resolves, and with the installation
 * configuration filepath the worker must read. The worker resolves the project's Jira credential
 * and the Nexus Lens private key for its own adapters.
 */
export function workerProcessEnvironment(
  nexus: NexusConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
  installationConfigPath: string,
): Record<string, string> {
  return {
    ...withoutSettings(
      environment,
      credentialSettings(nexus, notificationCredentialReferences(nexus)),
    ),
    [installationConfigSetting]: installationConfigPath,
  };
}

/**
 * The environment Nexus commands and agents run with: the host settings they need without any
 * credential setting the project or Nexus configuration resolves — the Jira API token, the Nexus
 * Lens private key and the SNS keys. Provider credentials stay, because the coding provider's own
 * installed settings supply them. The AMEM service owns its own collection, provider and model
 * credentials, so agents reach it through the service URL alone. Credential values never enter
 * prompts or artifacts.
 */
export function toolEnvironment(
  project: ProjectConfiguration,
  nexus: NexusConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return withoutSettings(
    environment,
    credentialSettings(nexus, [
      project.taskSource.credential,
      ...notificationCredentialReferences(nexus),
      nexus.nexusLens.privateKey,
    ]),
  );
}

/**
 * The environment the recovery agent runs with: the host settings its tools need — the current
 * project's Jira credential, the coding provider's credentials and the operator's Git and gh CLI
 * configuration — without the Nexus Lens private key and the notification credentials, which
 * recovery does not use. Recovery reads and changes tickets through its authenticated shell tools;
 * it publishes no reviews and sends no notifications itself.
 */
export function recoveryEnvironment(
  nexus: NexusConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return withoutSettings(
    environment,
    credentialSettings(nexus, [
      ...notificationCredentialReferences(nexus),
      nexus.nexusLens.privateKey,
    ]),
  );
}
