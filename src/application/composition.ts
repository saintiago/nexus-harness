import path from 'node:path';
import {
  challengerRoleInstructions,
  developmentRoleInstructions,
  type IdeaRole,
  ideaEditorRoleInstructions,
  projectGuideRoleInstructions,
  recoveryRoleInstructions,
  researcherRoleInstructions,
  reviewerRoleInstructions,
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
import {
  createMemory,
  createReceiptStore,
  disabledMemory,
  unavailableMemory,
  type Memory,
  type MemoryProviders,
  type MemorySettings,
} from '../memory/index.js';
import { messageOf } from '../result.js';
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
  'idea-editor': ideaEditorRoleInstructions,
  researcher: researcherRoleInstructions,
  'project-guide': projectGuideRoleInstructions,
  challenger: challengerRoleInstructions,
};

/** The configured idea refinement profile of each role. */
const ideaRoleSettings: Record<IdeaRole, keyof NexusConfiguration['ideaRefinement']['profiles']> = {
  'idea-editor': 'editor',
  researcher: 'researcher',
  'project-guide': 'projectGuide',
  challenger: 'challenger',
};

/**
 * The profiles the execution policy selects for one role: developer ladder entries identify
 * developer profiles, the reviewer profile identifies a reviewer profile, the recovery profile
 * identifies a recovery profile and the idea refinement settings identify the four idea roles. One
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
    case 'idea-editor':
    case 'researcher':
    case 'project-guide':
    case 'challenger':
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

/**
 * The resolved Memory construction settings of one configuration, or null when the integration is
 * disabled. Secrets resolve through the Credentials settings and stay out of artifacts and
 * prompts.
 */
export function createMemorySettings(
  nexus: NexusConfiguration,
  environment: HostEnvironment = process.env,
): MemorySettings | null {
  const memory = nexus.memory;
  if (memory === undefined || !memory.enabled) {
    return null;
  }
  return {
    storeId: memory.storeId,
    storageRoot: nexus.storage.root,
    qdrant: {
      url: memory.qdrant.url,
      collection: memory.qdrant.collection,
      ...(memory.qdrant.credential === undefined
        ? {}
        : { apiKey: resolveCredential(nexus, memory.qdrant.credential, environment) }),
    },
    embedding: {
      cacheDir: memory.embedding.cacheDir,
      allowDownloads: memory.embedding.allowDownloads,
    },
    model: {
      endpoint: memory.model.endpoint,
      model: memory.model.model,
      ...(memory.model.credential === undefined
        ? {}
        : { apiKey: resolveCredential(nexus, memory.model.credential, environment) }),
    },
    neighbors: memory.neighbors,
    searchLimit: memory.searchLimit,
    linkedLimit: memory.linkedLimit,
    contextMaxChars: memory.contextMaxChars,
    lockWaitMs: memory.lockWaitMs,
    providerTimeoutMs: memory.providerTimeoutMs,
    modelMaxOutputTokens: memory.model.maxOutputTokens,
  };
}

/** Where one process reports diagnostics that do not affect execution. */
type MemoryDiagnostics = { write(text: string): unknown };

/**
 * The Memory capability one process uses. A disabled integration constructs nothing; a provider
 * that cannot be initialized — including a memory credential the host does not supply — is
 * reported and degrades to an unavailable memory, so normal workflow execution continues without
 * supplemental context or ingestion. The degraded memory still captures every observation it
 * receives as a pending receipt, so an accepted hand-off keeps its snapshot instead of being lost
 * with its workspace.
 */
export async function createConfiguredMemory(
  nexus: NexusConfiguration,
  environment: HostEnvironment,
  diagnostics: MemoryDiagnostics,
  providers?: Partial<MemoryProviders>,
): Promise<Memory> {
  const memory = nexus.memory;
  if (memory === undefined || !memory.enabled) {
    return disabledMemory();
  }
  // Capturing an observation needs only local storage, so it stays available while the external
  // providers are unavailable.
  const capture = createReceiptStore({ root: nexus.storage.root, storeId: memory.storeId });
  const unavailable = (reason: string): Memory => {
    try {
      diagnostics.write(`Nexus memory is unavailable: ${reason}\n`);
    } catch {
      // A failed diagnostic report leaves the degradation itself unchanged.
    }
    return unavailableMemory(reason, capture);
  };
  try {
    const settings = createMemorySettings(nexus, environment);
    if (settings === null) {
      return disabledMemory();
    }
    return await createMemory(providers === undefined ? settings : { ...settings, providers });
  } catch (error) {
    return unavailable(messageOf(error));
  }
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
 * The credential references Memory resolves for its Qdrant and model providers. They are
 * Nexus-owned settings: a process that constructs Memory resolves them, while the commands and
 * agents it does not cover run without them.
 */
function memoryCredentialReferences(nexus: NexusConfiguration): string[] {
  return [nexus.memory?.qdrant?.credential, nexus.memory?.model?.credential].filter(
    (reference): reference is string => reference !== undefined,
  );
}

/**
 * The environment the worker process runs with: the parent environment without the notification
 * credentials only the parent's Notifications adapter resolves, and with the installation
 * configuration filepath the worker must read. The worker resolves the project's Jira credential
 * and the Nexus Lens private key for its own adapters and constructs Memory, so it keeps the
 * memory provider credentials its own Memory resolves; the commands and agents it runs do not
 * receive them.
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
 * Lens private key, the SNS keys and the Memory provider credentials. Provider credentials stay,
 * because the coding provider's own installed settings supply them. Credential values never enter
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
      ...memoryCredentialReferences(nexus),
      nexus.nexusLens.privateKey,
    ]),
  );
}

/**
 * The environment the recovery agent runs with: the host settings its tools need — the current
 * project's Jira credential, the coding provider's credentials and the operator's Git and gh CLI
 * configuration — without the Nexus Lens private key, the notification credentials and the Memory
 * provider credentials, which recovery does not use. Recovery reads and changes tickets through
 * its authenticated shell tools; it publishes no reviews and sends no notifications itself.
 */
export function recoveryEnvironment(
  nexus: NexusConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return withoutSettings(
    environment,
    credentialSettings(nexus, [
      ...notificationCredentialReferences(nexus),
      ...memoryCredentialReferences(nexus),
      nexus.nexusLens.privateKey,
    ]),
  );
}
