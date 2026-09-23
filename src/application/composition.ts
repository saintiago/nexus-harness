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
