import path from 'node:path';
import { z } from 'zod';
import { deepFreeze, readDocument, resolveExecutable, validate } from './document.js';

/** Required paths and identifiers are nonempty. */
const identifier = z.string().trim().min(1);

/** A positive safe integer setting, and the nonnegative variant the lock wait also accepts. */
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

/** An http(s) URL without embedded credentials, a query or a fragment. */
const httpUrl = (description: string): z.ZodString =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (url) => url.startsWith('http://') || url.startsWith('https://'),
      `${description} must start with http:// or https://`,
    )
    .refine((url) => {
      if (!URL.canParse(url)) {
        return false;
      }
      const endpoint = new URL(url);
      return endpoint.username === '' && endpoint.password === '' && !/[?#]/.test(url);
    }, `${description} must be valid and contain no credentials, query or fragment`);

/**
 * The project workflow the operator command runs. Its children are invoked machine actors of the
 * parent; they are not separately selected operator modes.
 */
export const workflowNames = ['project'] as const;

export type WorkflowName = (typeof workflowNames)[number];

/** The configured parent/child workflow definition paths. */
export type WorkflowDefinitions = {
  readonly project: string;
  readonly children: {
    readonly 'idea-refinement': string;
    readonly 'finite-delivery': string;
    readonly preparation: string;
  };
};

/** The preparation stage profiles and positive allowances. */
const stageProfilesSchema = z.strictObject({
  author: identifier,
  evaluator: identifier,
});

/**
 * The prototype stage's author ladder: its ordered profiles escalate as repair rounds open and
 * never downgrade. A single profile is a ladder that never promotes.
 */
const prototypeProfilesSchema = z.strictObject({
  authors: z.array(identifier).min(1),
  evaluator: identifier,
});

/** The four evaluated preparation stages and the finite round/upstream-return allowances. */
const preparationSchema = z.strictObject({
  maxRounds: z.number().int().positive(),
  maxUpstreamReturns: z.number().int().positive(),
  profiles: z.strictObject({
    requirements: stageProfilesSchema,
    ux: stageProfilesSchema,
    prototype: prototypeProfilesSchema,
    architecture: stageProfilesSchema,
  }),
});

/** The preparation stage names the configuration and the workflow share. */
export const preparationStages = ['requirements', 'ux', 'prototype', 'architecture'] as const;

export type PreparationStage = (typeof preparationStages)[number];

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

/** The four idea refinement role profiles and the conversation-cycle bound. */
const ideaRefinementSchema = z.strictObject({
  profiles: z.strictObject({
    editor: identifier,
    researcher: identifier,
    projectGuide: identifier,
    challenger: identifier,
  }),
  maxCycles: z.number().int().positive(),
});

/** The AMEM MCP stdio entry point one memory-enabled agent session launches. */
const memoryMcpSchema = z.strictObject({
  /** The launcher command of the MCP server. */
  command: identifier,
  /** Its arguments. */
  args: z.array(z.string()),
  /** The working directory the server process runs in. */
  directory: identifier,
});

/** The service-backed memory settings: the service URL, MCP access and analysis profile. */
const memoryServiceSettings = {
  serviceUrl: httpUrl('A memory service URL'),
  mcp: memoryMcpSchema,
  analysisProfile: identifier,
};

/** Enabled memory: the shared service URL, MCP access and experience-analysis profile. */
const memoryEnabledSchema = z.strictObject({
  enabled: z.literal(true),
  ...memoryServiceSettings,
});

/**
 * A disabled memory integration performs no service call and exposes no agent tool. The service
 * settings and the obsolete direct-integration settings are accepted and ignored here, so an
 * operator can switch memory off without deleting its configuration while enabled memory can only
 * name the service.
 */
const memoryDisabledSchema = z.strictObject({
  enabled: z.literal(false),
  serviceUrl: memoryServiceSettings.serviceUrl.optional(),
  mcp: memoryServiceSettings.mcp.optional(),
  analysisProfile: memoryServiceSettings.analysisProfile.optional(),
  storeId: identifier.optional(),
  qdrant: z
    .strictObject({
      url: httpUrl('A Qdrant URL'),
      collection: identifier,
      credential: credentialReference.optional(),
    })
    .optional(),
  embedding: z
    .strictObject({
      cacheDir: identifier,
      allowDownloads: z.boolean(),
    })
    .optional(),
  model: z
    .strictObject({
      endpoint: httpUrl('A model endpoint'),
      model: identifier,
      credential: credentialReference.optional(),
      maxOutputTokens: positiveInteger.optional(),
    })
    .optional(),
  neighbors: positiveInteger.optional(),
  searchLimit: positiveInteger.optional(),
  linkedLimit: nonNegativeInteger.optional(),
  contextMaxChars: positiveInteger.optional(),
  lockWaitMs: nonNegativeInteger.optional(),
  providerTimeoutMs: positiveInteger.optional(),
});

/**
 * The optional memory settings. Omitting the section or setting `enabled: false` disables agent
 * tools and experience analysis; enabling it requires the shared service URL, the MCP entry point
 * and the configured experience-analysis profile.
 */
const memorySchema = z
  .discriminatedUnion('enabled', [memoryDisabledSchema, memoryEnabledSchema])
  .optional();

const nexusConfigurationSchema = z
  .strictObject({
    workflow: z.strictObject({
      project: identifier,
      children: z.strictObject({
        'finite-delivery': identifier,
        'idea-refinement': identifier,
        preparation: identifier,
      }),
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
    preparation: preparationSchema,
    ideaRefinement: ideaRefinementSchema,
    memory: memorySchema,
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

    const stageProfiles: [string, readonly string[]][] = [];
    for (const stage of ['requirements', 'ux', 'architecture'] as const) {
      const profiles = configuration.preparation.profiles[stage];
      stageProfiles.push([`${stage}.author`, [profiles.author]]);
      stageProfiles.push([`${stage}.evaluator`, [profiles.evaluator]]);
    }
    const prototype = configuration.preparation.profiles.prototype;
    prototype.authors.forEach((profile, index) => {
      stageProfiles.push([`prototype.authors.${String(index)}`, [profile]]);
    });
    stageProfiles.push(['prototype.evaluator', [prototype.evaluator]]);
    for (const [part, profiles] of stageProfiles) {
      for (const profile of profiles) {
        if (!profileIds.has(profile)) {
          context.addIssue({
            code: 'custom',
            path: ['preparation', 'profiles', ...part.split('.')],
            message: `Unknown profile "${profile}"`,
          });
        }
      }
    }

    // The experience-analysis profile is one of the configured agent profiles.
    if (
      configuration.memory?.enabled === true &&
      !profileIds.has(configuration.memory.analysisProfile)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['memory', 'analysisProfile'],
        message: `Unknown profile "${configuration.memory.analysisProfile}"`,
      });
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
  const memory =
    configuration.memory === undefined || !configuration.memory.enabled
      ? undefined
      : {
          ...configuration.memory,
          mcp: {
            ...configuration.memory.mcp,
            directory: path.resolve(directory, configuration.memory.mcp.directory),
          },
        };
  return deepFreeze({
    ...configuration,
    ...(memory === undefined ? {} : { memory }),
    agentRuntime: {
      ...configuration.agentRuntime,
      provider: {
        ...configuration.agentRuntime.provider,
        executable: resolveExecutable(configuration.agentRuntime.provider.executable, directory),
      },
    },
    workflow: {
      project: path.resolve(directory, configuration.workflow.project),
      children: {
        'finite-delivery': path.resolve(
          directory,
          configuration.workflow.children['finite-delivery'],
        ),
        'idea-refinement': path.resolve(
          directory,
          configuration.workflow.children['idea-refinement'],
        ),
        preparation: path.resolve(directory, configuration.workflow.children.preparation),
      },
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
