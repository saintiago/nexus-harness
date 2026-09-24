import path from 'node:path';
import { z } from 'zod';
import { deepFreeze, readDocument, resolveExecutable, validate } from './document.js';

/** Required paths and identifiers are nonempty. */
const identifier = z.string().trim().min(1);

/** The workflows the operator command selects; each name identifies its configured definition. */
export const workflowNames = ['finite-delivery', 'idea-refinement'] as const;

export type WorkflowName = (typeof workflowNames)[number];

/** Profiles conform to AgentProfile in the AgentRuntime design. */
const profileSchema = z.strictObject({
  id: identifier,
  model: identifier,
  effort: identifier.nullable(),
  instructions: z.array(z.string()),
  toolSettings: z.record(z.string(), z.unknown()),
});

/** A credential reference names an entry in the Credentials settings; the host resolves its value. */
const credentialReference = identifier;

/** The six idea refinement role profiles and the council-cycle bound. */
const ideaRefinementSchema = z.strictObject({
  profiles: z.strictObject({
    purposeVerifier: identifier,
    researcher: identifier,
    briefWriter: identifier,
    purposeCouncil: identifier,
    evidenceCouncil: identifier,
    simplicityCouncil: identifier,
  }),
  maxCouncilCycles: z.number().int().positive(),
});

const nexusConfigurationSchema = z
  .strictObject({
    workflow: z.strictObject({
      'finite-delivery': identifier,
      'idea-refinement': identifier,
    }),
    storage: z.strictObject({
      root: identifier,
    }),
    agentRuntime: z.strictObject({
      baseInstructions: z.array(z.string()),
      provider: z.strictObject({
        kind: z.literal('codex'),
        executable: identifier,
      }),
      profiles: z.array(profileSchema),
    }),
    executionPolicy: z.strictObject({
      // Durations state their unit in the setting name and are nonnegative.
      agentInvocationLimitMinutes: z.number().nonnegative(),
      developerLadder: z.array(
        z.strictObject({
          profile: identifier,
          repairAllowance: z.number().int().nonnegative(),
        }),
      ),
      reviewerProfile: identifier,
      recoveryProfile: identifier,
      maxRecoveryAttempts: z.number().int().positive(),
    }),
    ideaRefinement: ideaRefinementSchema,
    notifications: z.strictObject({
      provider: z.literal('sns'),
      // The AWS Region that owns the destination topic.
      region: identifier,
      destination: identifier,
      credentials: z.strictObject({
        accessKeyId: credentialReference,
        secretAccessKey: credentialReference,
        sessionToken: credentialReference.optional(),
      }),
    }),
    credentials: z.record(identifier, z.strictObject({ environment: identifier })),
    nexusLens: z.strictObject({
      appId: z.number().int().positive(),
      installationId: z.number().int().positive(),
      login: identifier,
      privateKey: credentialReference,
    }),
  })
  .superRefine((configuration, context) => {
    const profileIds = new Set<string>();
    configuration.agentRuntime.profiles.forEach((profile, index) => {
      if (profileIds.has(profile.id)) {
        context.addIssue({
          code: 'custom',
          path: ['agentRuntime', 'profiles', index, 'id'],
          message: `Duplicate profile ID "${profile.id}"`,
        });
      }
      profileIds.add(profile.id);
    });

    const { developerLadder, reviewerProfile, recoveryProfile } = configuration.executionPolicy;
    if (developerLadder.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['executionPolicy', 'developerLadder'],
        message: 'At least one developer profile is required',
      });
    }

    developerLadder.forEach((entry, index) => {
      if (!profileIds.has(entry.profile)) {
        context.addIssue({
          code: 'custom',
          path: ['executionPolicy', 'developerLadder', index, 'profile'],
          message: `Unknown profile "${entry.profile}"`,
        });
      }
    });
    if (!profileIds.has(reviewerProfile)) {
      context.addIssue({
        code: 'custom',
        path: ['executionPolicy', 'reviewerProfile'],
        message: `Unknown profile "${reviewerProfile}"`,
      });
    }
    if (!profileIds.has(recoveryProfile)) {
      context.addIssue({
        code: 'custom',
        path: ['executionPolicy', 'recoveryProfile'],
        message: `Unknown profile "${recoveryProfile}"`,
      });
    }

    const ideaProfiles = configuration.ideaRefinement.profiles;
    for (const [role, profile] of Object.entries(ideaProfiles)) {
      if (!profileIds.has(profile)) {
        context.addIssue({
          code: 'custom',
          path: ['ideaRefinement', 'profiles', role],
          message: `Unknown profile "${profile}"`,
        });
      }
    }

    const credentialReferences: [string, (string | number)[]][] = [
      [
        configuration.notifications.credentials.accessKeyId,
        ['notifications', 'credentials', 'accessKeyId'],
      ],
      [
        configuration.notifications.credentials.secretAccessKey,
        ['notifications', 'credentials', 'secretAccessKey'],
      ],
      [configuration.nexusLens.privateKey, ['nexusLens', 'privateKey']],
    ];
    const sessionToken = configuration.notifications.credentials.sessionToken;
    if (sessionToken !== undefined) {
      credentialReferences.push([sessionToken, ['notifications', 'credentials', 'sessionToken']]);
    }
    for (const [reference, location] of credentialReferences) {
      if (!Object.hasOwn(configuration.credentials, reference)) {
        context.addIssue({
          code: 'custom',
          path: [...location],
          message: `Unknown credential reference "${reference}"`,
        });
      }
    }
  });

export type NexusConfiguration = z.infer<typeof nexusConfigurationSchema>;

/** Validate and resolve Nexus configuration from a parsed JSON value. */
export function parseNexusConfiguration(
  value: unknown,
  configDirectory: string,
): NexusConfiguration {
  const configuration = validate(nexusConfigurationSchema, value, 'Nexus configuration');
  return resolveNexusConfiguration(configuration, path.resolve(configDirectory));
}

/** Read, validate and resolve a Nexus configuration file. */
export async function loadNexusConfiguration(filePath: string): Promise<NexusConfiguration> {
  const absolute = path.resolve(filePath);
  const value = await readDocument(absolute, 'Nexus');
  const configuration = validate(
    nexusConfigurationSchema,
    value,
    `Nexus configuration ${absolute}`,
  );
  return resolveNexusConfiguration(configuration, path.dirname(absolute));
}

/** Resolve path-valued settings against the directory of their owning configuration file. */
function resolveNexusConfiguration(
  configuration: NexusConfiguration,
  directory: string,
): NexusConfiguration {
  return deepFreeze({
    ...configuration,
    agentRuntime: {
      ...configuration.agentRuntime,
      provider: {
        ...configuration.agentRuntime.provider,
        executable: resolveExecutable(configuration.agentRuntime.provider.executable, directory),
      },
    },
    workflow: {
      'finite-delivery': path.resolve(directory, configuration.workflow['finite-delivery']),
      'idea-refinement': path.resolve(directory, configuration.workflow['idea-refinement']),
    },
    storage: { root: path.resolve(directory, configuration.storage.root) },
  });
}

/** Resolve a credential reference from the host environment. */
export function resolveCredential(
  configuration: NexusConfiguration,
  reference: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const resolution = Object.hasOwn(configuration.credentials, reference)
    ? configuration.credentials[reference]
    : undefined;
  if (resolution === undefined) {
    throw new Error(`Unknown credential reference "${reference}"`);
  }
  const value = environment[resolution.environment];
  if (value === undefined || value === '') {
    throw new Error(
      `Credential "${reference}" is not set in environment variable "${resolution.environment}"`,
    );
  }
  return value;
}
