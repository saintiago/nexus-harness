/**
 * What a configuration file and a task file may contain, and what an omitted
 * optional field means: the zod schemas, the documented defaults, and nothing
 * that reads a file or resolves a path.
 *
 * Every default here is one docs/WORKFLOW.md documents. A value the file does
 * not supply and the document does not default is a validation problem, never a
 * silent guess.
 */
import { z } from 'zod';
import type { AgentSelection } from '../shared/types.js';

/** A string that is present and contains something other than whitespace. */
function nonBlankString(field: string): z.ZodString {
  return z.string().refine((value) => value.trim().length > 0, {
    error: `${field} must not be blank`,
  });
}

/** A bounded integer. Fractional, non-finite and non-numeric values are rejected. */
function boundedInteger(field: string, minimum: number, requirement: string): z.ZodNumber {
  return z
    .int({ error: `${field} must be an integer` })
    .min(minimum, { error: `${field} must be ${requirement}` });
}

/**
 * An executable plus literal arguments. The list is never empty and the first
 * item is the executable, so a blank entry cannot become a shell call.
 */
const commandSchema = z
  .array(z.string(), { error: 'must be an array of string arguments' })
  .min(1, { error: 'must not be empty; the first item is the executable' })
  .refine((command) => command.length === 0 || (command[0] ?? '').trim().length > 0, {
    error: 'the first item must be a nonblank executable',
    path: [0],
  });

/**
 * The optional agent selection. The runtime names the adapter to run, and only
 * the implemented one is accepted: rejecting `"claude"` and the other names of
 * runtimes the harness does not have is the point, rather than a placeholder
 * that would start Codex under a different name (docs/architecture.md §4).
 */
const agentSchema = z.strictObject({
  runtime: z.literal('codex', {
    error:
      'must be "codex": the Codex CLI is the only coding runtime this harness implements, so ' +
      'another runtime name is rejected rather than run through the Codex adapter',
  }),
  command: commandSchema,
});

/** Documented defaults of the optional Jira `source` object. */
export const JIRA_SOURCE_DEFAULTS = {
  issueType: 'Task',
  label: 'harness-task',
  readyStatus: 'To Do',
  runningStatus: 'In Progress',
  reviewStatus: 'In Review',
  pollIntervalSeconds: 30,
  tokenEnv: 'JIRA_API_TOKEN',
} as const;

/** The smallest delay between two watch scans, in seconds (docs/WORKFLOW.md §5). */
export const MIN_POLL_INTERVAL_SECONDS = 5;

/** A Jira Cloud cloud ID, as Atlassian's gateway routes use it. */
const CLOUD_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A single Jira label: no whitespace, so the JQL term stays one literal. */
const LABEL_PATTERN = /^\S+$/;

/** An environment-variable name. The token itself never appears in JSON. */
const TOKEN_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A canonical Jira Cloud origin. Only normalization is automatic: a trailing
 * slash is removed, so the same site always reads the same way in a receipt
 * identity and a browser link. Credentials, a query, a fragment, a non-root
 * path, and a non-HTTPS scheme are refused rather than rewritten, and no other
 * site is ever chosen silently (docs/WORKFLOW.md §5).
 */
const jiraSiteUrlSchema = nonBlankString('siteUrl').transform((value, ctx) => {
  const problem = (message: string): typeof z.NEVER => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return problem('siteUrl must be an absolute HTTPS URL such as "https://name.atlassian.net"');
  }
  if (url.protocol !== 'https:') {
    return problem('siteUrl must use https: Jira Cloud is reached over TLS');
  }
  if (url.username !== '' || url.password !== '') {
    return problem('siteUrl must not carry credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    return problem('siteUrl must not carry a query or a fragment');
  }
  if (url.pathname.replace(/\/+$/, '') !== '') {
    return problem('siteUrl must be the site origin with no path');
  }
  return `${url.protocol}//${url.host}`;
});

/**
 * The optional source object. `"jira"` is the only implemented type: a
 * placeholder for a connector nobody has written would be a way to accept a
 * configuration the harness cannot honour (docs/WORKFLOW.md §5).
 */
const jiraSourceSchema = z
  .strictObject({
    type: z.literal('jira', {
      error:
        'must be "jira": Jira Cloud is the only task source this harness implements, so ' +
        'another source name is rejected rather than accepted as a placeholder',
    }),
    siteUrl: jiraSiteUrlSchema,
    cloudId: z.string({ error: 'cloudId must be a string' }).regex(CLOUD_ID_PATTERN, {
      error:
        'cloudId must be the Atlassian cloud ID (a UUID): service-account API tokens use the ' +
        'api.atlassian.com gateway route, which is keyed by it',
    }),
    projectKey: nonBlankString('projectKey'),
    issueType: nonBlankString('issueType').default(JIRA_SOURCE_DEFAULTS.issueType),
    label: nonBlankString('label')
      .regex(LABEL_PATTERN, { error: 'label must be a single Jira label without whitespace' })
      .default(JIRA_SOURCE_DEFAULTS.label),
    readyStatus: nonBlankString('readyStatus').default(JIRA_SOURCE_DEFAULTS.readyStatus),
    runningStatus: nonBlankString('runningStatus').default(JIRA_SOURCE_DEFAULTS.runningStatus),
    reviewStatus: nonBlankString('reviewStatus').default(JIRA_SOURCE_DEFAULTS.reviewStatus),
    pollIntervalSeconds: boundedInteger(
      'pollIntervalSeconds',
      MIN_POLL_INTERVAL_SECONDS,
      `an integer of at least ${String(MIN_POLL_INTERVAL_SECONDS)} seconds`,
    ).default(JIRA_SOURCE_DEFAULTS.pollIntervalSeconds),
    tokenEnv: z
      .string({ error: 'tokenEnv must be a string' })
      .regex(TOKEN_ENV_PATTERN, {
        error: 'tokenEnv must be an environment-variable name such as "JIRA_API_TOKEN"',
      })
      .default(JIRA_SOURCE_DEFAULTS.tokenEnv),
  })
  .refine(
    (source) =>
      source.readyStatus !== source.runningStatus &&
      source.readyStatus !== source.reviewStatus &&
      source.runningStatus !== source.reviewStatus,
    {
      error:
        'readyStatus, runningStatus and reviewStatus must be three distinct status names: ' +
        'otherwise a claim or a result could not be told apart from the state it started in',
      path: ['readyStatus'],
    },
  );

/** Validates one `source` object: the documented optional field of a config. */
export const sourceSchema = jiraSourceSchema;

export const harnessConfigSchema = z.strictObject({
  workDir: nonBlankString('workDir'),
  maxRepairs: boundedInteger('maxRepairs', 0, 'a nonnegative integer'),
  taskTimeoutMinutes: boundedInteger('taskTimeoutMinutes', 1, 'a positive integer'),
  commandTimeoutMinutes: boundedInteger('commandTimeoutMinutes', 1, 'a positive integer'),
  setup: z.array(commandSchema, { error: 'must be an array of command arrays' }),
  checks: z
    .array(commandSchema, { error: 'must be an array of command arrays' })
    .min(1, { error: 'must contain at least one command' }),
  agent: agentSchema.optional(),
  escalation: z
    .array(
      z.strictObject({
        name: nonBlankString('escalation[].name'),
        agent: agentSchema.optional(),
        maxRepairs: boundedInteger(
          'escalation[].maxRepairs',
          0,
          'a nonnegative integer',
        ).optional(),
      }),
      { error: 'escalation must be an array of tiers' },
    )
    .min(1, { error: 'escalation must hold at least one tier' })
    .refine((tiers) => new Set(tiers.map((tier) => tier.name)).size === tiers.length, {
      error: 'escalation tier names must be distinct: two tiers with one name are one tier',
    })
    .optional(),
  source: sourceSchema.optional(),
});

/**
 * The launch the harness uses when the configuration names none: the installed
 * Codex CLI, with the user's own ordinary defaults. It is a launch prefix like
 * any other, and not a fallback: a run whose configured selection fails does not
 * come back to this one (docs/spec.md §2).
 */
export const DEFAULT_AGENT_SELECTION: AgentSelection = {
  runtime: 'codex',
  command: ['codex'],
};
export const taskSchema = z.strictObject({
  id: nonBlankString('id'),
  title: nonBlankString('title'),
  description: nonBlankString('description'),
  acceptanceCriteria: z
    .array(nonBlankString('acceptanceCriteria item'), {
      error: 'must be an array of nonblank strings',
    })
    .min(1, { error: 'must contain at least one acceptance criterion' }),
});
