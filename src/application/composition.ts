import path from 'node:path';
import {
  developmentRoleInstructions,
  recoveryRoleInstructions,
  reviewerRoleInstructions,
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
} from '../configuration/index.js';
import { installationConfigSetting } from './installation.js';

/**
 * Composition turns resolved project and Nexus configuration into the construction settings of
 * the components. It resolves credential references against the host, attaches each profile's role
 * instructions and hands every capability through unchanged. Each component's own constructor
 * performs the construction; this module contains no lifecycle or commands.
 */

/** The host environment credential references resolve their values from. */
type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** The role whose constant instructions a profile carries, selected by the execution policy. */
type ProfileRole = 'developer' | 'reviewer' | 'recovery';

/** How the execution policy selects a profile for each role, named in conflict reports. */
const roleSelection: Record<ProfileRole, string> = {
  developer: 'a developer ladder entry',
  reviewer: 'the reviewer profile',
  recovery: 'the recovery profile',
};

/** The complete constant instructions of each role, defined by the role contracts. */
const roleInstructions: Record<ProfileRole, readonly string[]> = {
  developer: developmentRoleInstructions,
  reviewer: reviewerRoleInstructions,
  recovery: recoveryRoleInstructions,
};

/**
 * The role each execution-policy-selected profile serves: developer ladder entries identify
 * developer profiles, the reviewer profile identifies a reviewer profile and the recovery profile
 * identifies a recovery profile. A profile carries one role's instructions, so selecting the same
 * ID for another role is a configuration conflict, reported instead of silently choosing a role.
 */
function selectedProfileRoles(configuration: NexusConfiguration): ReadonlyMap<string, ProfileRole> {
  const roles = new Map<string, ProfileRole>();
  const select = (profile: string, role: ProfileRole): void => {
    const selected = roles.get(profile);
    if (selected === undefined) {
      roles.set(profile, role);
      return;
    }
    if (selected !== role) {
      throw new Error(
        `Agent profile "${profile}" is referenced as both ${roleSelection[selected]} and ` +
          `${roleSelection[role]}; one profile cannot serve incompatible roles. Configure ` +
          'separate profile IDs for each role.',
      );
    }
  };
  for (const entry of configuration.executionPolicy.developerLadder) {
    select(entry.profile, 'developer');
  }
  select(configuration.executionPolicy.reviewerProfile, 'reviewer');
  select(configuration.executionPolicy.recoveryProfile, 'recovery');
  return roles;
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
 * The AgentRuntime construction settings: the supplied coding-provider capability and activity
 * observer, the configured base instructions and invocation limit, and the configured profiles as
 * AgentProfile values carrying one role's constant instructions followed by their configured
 * instructions and their native tool settings. A configured instruction that exactly repeats a
 * selected role constant is dropped, so the constant is stated once per invocation; all other
 * configured instructions keep their order.
 */
export function createAgentRuntimeSettings(
  nexus: NexusConfiguration,
  codingRuntime: CodingRuntime,
  onActivity: (activity: AgentEvent) => void,
): AgentRuntimeSettings {
  const roles = selectedProfileRoles(nexus);
  return {
    codingRuntime,
    baseInstructions: nexus.agentRuntime.baseInstructions,
    profiles: nexus.agentRuntime.profiles.map((profile): AgentProfile => {
      const role = roles.get(profile.id);
      const constants = role === undefined ? undefined : roleInstructions[role];
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

/** The queue execution directory and record paths Application supplies for a project. */
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
