import path from 'node:path';
import {
  briefWriterRoleInstructions,
  developmentRoleInstructions,
  evidenceCouncilRoleInstructions,
  type IdeaRole,
  purposeCouncilRoleInstructions,
  purposeVerifierRoleInstructions,
  recoveryRoleInstructions,
  researcherRoleInstructions,
  reviewerRoleInstructions,
  simplicityCouncilRoleInstructions,
  type AgentEvent,
  type AgentProfile,
  type AgentRuntimeSettings,
} from '../agent-runtime/index.js';
import type { CodingRuntime } from '../adapters/coding-runtime.js';
import type { JiraSettings } from '../adapters/jira.js';
import type { NotificationSettings } from '../adapters/notifications.js';
import {
  resolveCredential,
  type NexusConfiguration,
  type ProjectConfiguration,
  type WorkflowName,
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

/** The role whose constant instructions one invocation carries, selected by the execution policy. */
export type ProfileRole = 'developer' | 'reviewer' | 'recovery' | IdeaRole;

/** The complete constant instructions of each role, defined by the role contracts. */
const roleInstructions: Record<ProfileRole, readonly string[]> = {
  developer: developmentRoleInstructions,
  reviewer: reviewerRoleInstructions,
  recovery: recoveryRoleInstructions,
  'purpose-verifier': purposeVerifierRoleInstructions,
  researcher: researcherRoleInstructions,
  'brief-writer': briefWriterRoleInstructions,
  'purpose-council': purposeCouncilRoleInstructions,
  'evidence-council': evidenceCouncilRoleInstructions,
  'simplicity-council': simplicityCouncilRoleInstructions,
};

/** The configured idea refinement profile of each role. */
const ideaRoleSettings: Record<IdeaRole, keyof NexusConfiguration['ideaRefinement']['profiles']> = {
  'purpose-verifier': 'purposeVerifier',
  researcher: 'researcher',
  'brief-writer': 'briefWriter',
  'purpose-council': 'purposeCouncil',
  'evidence-council': 'evidenceCouncil',
  'simplicity-council': 'simplicityCouncil',
};

/**
 * The profiles the execution policy selects for one role: developer ladder entries identify
 * developer profiles, the reviewer profile identifies a reviewer profile, the recovery profile
 * identifies a recovery profile and the idea refinement settings identify the six idea roles. One
 * profile may be selected for more than one role.
 */
function profilesForRole(
  configuration: NexusConfiguration,
  role: ProfileRole,
): ReadonlySet<string> {
  const { developerLadder, reviewerProfile, recoveryProfile } = configuration.executionPolicy;
  switch (role) {
    case 'developer':
      return new Set(developerLadder.map((entry) => entry.profile));
    case 'reviewer':
      return new Set([reviewerProfile]);
    case 'recovery':
      return new Set([recoveryProfile]);
    case 'purpose-verifier':
    case 'researcher':
    case 'brief-writer':
    case 'purpose-council':
    case 'evidence-council':
    case 'simplicity-council':
      return new Set([configuration.ideaRefinement.profiles[ideaRoleSettings[role]]]);
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
 * activity observer, the configured base instructions and invocation limit, and the configured
 * profiles as AgentProfile values. The profiles this role selects carry that role's constant
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
  onActivity: (activity: AgentEvent) => void,
): AgentRuntimeSettings {
  const selected = profilesForRole(nexus, role);
  return {
    codingRuntime,
    baseInstructions: nexus.agentRuntime.baseInstructions,
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
        toolSettings: profile.toolSettings,
      };
    }),
    invocationLimitMinutes: nexus.executionPolicy.agentInvocationLimitMinutes,
    onActivity,
  };
}

/** The stable queue execution state and record paths for one configured project. */
export type ExecutionPaths = {
  /** The execution directory: workflow state, task selection and recovery records. */
  readonly directory: string;
  /** The ExecutionRunner's workflow-state filepath. */
  readonly workflowStateFile: string;
  /** SelectTask's selection filepath. */
  readonly selectionFile: string;
};

/**
 * The execution directory and record paths Application supplies for one project and selected
 * workflow. Idea refinement uses its own directory beside the finite delivery queue's, so the two
 * workflows keep separate workflow state, selection and logs.
 */
export function executionPaths(
  nexus: NexusConfiguration,
  project: ProjectConfiguration,
  workflow: WorkflowName,
): ExecutionPaths {
  const directory = path.join(
    nexus.storage.root,
    'executions',
    project.taskSource.project,
    ...(workflow === 'idea-refinement' ? ['idea-refinement'] : []),
  );
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
 * installed settings supply them. Credential values never enter prompts or artifacts.
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
