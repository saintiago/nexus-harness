/**
 * What each configuration file and a task file may contain, and what an omitted
 * optional field means: the zod schemas, the documented defaults, and nothing
 * that reads a file or resolves a path.
 *
 * Configuration is two files with disjoint ownership (docs/WORKFLOW.md §1):
 * `harnessConfigSchema` describes the Nexus-wide harness configuration an
 * operator keeps — the output directory, the limits, the coding launches, and
 * the reviewer integration — and `projectConfigSchema` describes the project
 * configuration a connected repository carries at its root: its Jira
 * connection, its GitHub destination, and the commands that decide a task
 * there. Neither schema accepts a field the other owns; composing the two into
 * the effective configuration is load.ts's job.
 *
 * Every default here is one docs/WORKFLOW.md documents. A value the file does
 * not supply and the document does not default is a validation problem, never a
 * silent guess.
 */
import { z } from 'zod';
import type { AgentSelection, CompletionConfig } from '../shared/types.js';

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
  ordering: 'priority',
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
    ordering: z
      .enum(['priority', 'rank'], {
        error:
          'ordering must be "priority" or "rank": "priority" asks Jira for its own Priority ' +
          'field first, and "rank" asks for the board\'s native Rank order',
      })
      .default(JIRA_SOURCE_DEFAULTS.ordering),
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

/** A destination repository on GitHub: exactly one slash, no host, no URL. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * A base branch name: nonblank, without whitespace, and not starting with `-`,
 * so it is one literal argument to `gh` rather than something an option parser
 * could read as another flag. Git's own branch rules are not duplicated here.
 */
const BRANCH_PATTERN = /^[^\s-][^\s]*$/;

/** Documented defaults of the Nexus-wide review-to-completion policy. */
export const COMPLETION_DEFAULTS = {
  pollIntervalSeconds: 30,
  deadlineSeconds: 30 * 60,
} as const;

/** The smallest delay between two completion polls, in seconds. */
export const MIN_COMPLETION_POLL_INTERVAL_SECONDS = 5;

/**
 * One identifier for an expected post-merge GitHub Actions workflow: the file
 * name, the path under `.github/workflows`, or the numeric workflow ID. It is
 * one literal value and carries no option-like prefix.
 */
const WORKFLOW_PATTERN = /^(?:[1-9][0-9]*|(?:\.github\/workflows\/)?[A-Za-z0-9_.-]+\.ya?ml)$/;

/**
 * The optional Nexus-wide review-to-completion policy: which reviewer gates the
 * work, where its own credential is read from, and how GitHub's merge and
 * post-merge workflow state is polled. Every field that says who may gate the
 * work is required — nothing is defaulted into a configuration that would then
 * finish an item nobody named a reviewer for — and no project-specific outcome
 * belongs here (docs/WORKFLOW.md §1, §10).
 */
const completionSchema = z.strictObject({
  lensApp: nonBlankString('lensApp'),
  lensAppId: boundedInteger('lensAppId', 1, 'a positive integer'),
  lensCheckName: nonBlankString('lensCheckName'),
  reviewerTokenEnv: z
    .string({ error: 'reviewerTokenEnv must be a string' })
    .regex(TOKEN_ENV_PATTERN, {
      error:
        'reviewerTokenEnv must be an environment-variable name such as "NEXUS_LENS_TOKEN": ' +
        'the reviewer credential never appears in the configuration file',
    })
    .refine(
      (name) =>
        !['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].includes(
          name.toUpperCase(),
        ),
      { error: 'reviewerTokenEnv must be separate from the operator credential' },
    ),
  pollIntervalSeconds: boundedInteger(
    'pollIntervalSeconds',
    MIN_COMPLETION_POLL_INTERVAL_SECONDS,
    `an integer of at least ${String(MIN_COMPLETION_POLL_INTERVAL_SECONDS)} seconds`,
  ).default(COMPLETION_DEFAULTS.pollIntervalSeconds),
  deadlineSeconds: boundedInteger(
    'deadlineSeconds',
    MIN_COMPLETION_POLL_INTERVAL_SECONDS,
    `an integer of at least ${String(MIN_COMPLETION_POLL_INTERVAL_SECONDS)} seconds`,
  ).default(COMPLETION_DEFAULTS.deadlineSeconds),
});

/**
 * One project's completion outcomes: which post-merge workflows have to succeed
 * on the merge commit, and the two Jira statuses an item can end in. These
 * belong to the project because they name its own CI and its own workflow; the
 * reviewer identity and the polling bounds above do not.
 */
const projectCompletionSchema = z.strictObject({
  postMergeWorkflows: z
    .array(
      z.string({ error: 'postMergeWorkflows entries must be strings' }).regex(WORKFLOW_PATTERN, {
        error:
          'postMergeWorkflows entries must be a workflow file name such as "ci.yml", a path ' +
          'such as ".github/workflows/ci.yml", or a numeric workflow ID',
      }),
      { error: 'postMergeWorkflows must be an array of workflow identifiers' },
    )
    .min(1, {
      error:
        'postMergeWorkflows must name at least one expected post-merge workflow: an empty list ' +
        'is not evidence that CI passed',
    }),
  toDoStatus: nonBlankString('toDoStatus'),
  doneStatus: nonBlankString('doneStatus'),
});

/**
 * The one validation a completion object cannot express field by field: moving
 * an item out of review has to mean something, so both of its outcomes differ
 * from the review status it starts in and from each other.
 */
export function checkCompletionStatuses(
  reviewStatus: string,
  completion: CompletionConfig,
): string | null {
  const same = (left: string, right: string): boolean =>
    left.trim().toLowerCase() === right.trim().toLowerCase();
  if (same(completion.toDoStatus, completion.doneStatus)) {
    return (
      'toDoStatus and doneStatus must be different statuses: a failed outcome and a completed ' +
      'one cannot end in the same place'
    );
  }
  if (same(completion.toDoStatus, reviewStatus) || same(completion.doneStatus, reviewStatus)) {
    return (
      `toDoStatus and doneStatus must differ from the source's reviewStatus "${reviewStatus}": ` +
      'otherwise a completion outcome would look like the state it started in'
    );
  }
  return null;
}

/**
 * The optional delivery step of one project. `"github"` is the only implemented
 * type: a placeholder for a delivery service nobody has written would be a way
 * to accept a configuration the harness cannot honour (docs/WORKFLOW.md §8).
 * The repository named here is both what a passed attempt is pushed to and what
 * the Nexus-wide reviewer reviews: one project has one GitHub destination.
 */
const projectDeliverySchema = z.strictObject({
  type: z.literal('github', {
    error:
      'must be "github": pushing a branch with Git and managing its pull request with gh is the ' +
      'only delivery step this harness implements, so another type is rejected rather than ' +
      'accepted as a placeholder',
  }),
  repository: z.string({ error: 'repository must be a string' }).regex(REPOSITORY_PATTERN, {
    error:
      'repository must be the destination on github.com as "owner/name": no host, no URL, and ' +
      'no path',
  }),
  baseBranch: z.string({ error: 'baseBranch must be a string' }).regex(BRANCH_PATTERN, {
    error: 'baseBranch must be a branch name without whitespace, such as "main"',
  }),
  completion: projectCompletionSchema.optional(),
});

/** Documented defaults of the Nexus-wide `reviewer` object. */
export const REVIEW_DEFAULTS = {
  checkName: 'Nexus Lens review',
} as const;

/**
 * The GitHub App installation a review is published as. It carries no
 * credential: `privateKeyPathEnv` names the environment variable that holds the
 * path of the App's PEM key, and only a review command reads it
 * (docs/WORKFLOW.md §9).
 */
const githubReviewAppSchema = z.strictObject({
  appId: boundedInteger('app.appId', 1, 'a positive integer'),
  installationId: boundedInteger('app.installationId', 1, 'a positive integer'),
  privateKeyPathEnv: z
    .string({ error: 'app.privateKeyPathEnv must be a string' })
    .regex(TOKEN_ENV_PATTERN, {
      error:
        'app.privateKeyPathEnv must be an environment-variable name such as "NEXUS_LENS_KEY_PATH"',
    }),
  login: nonBlankString('app.login'),
});

/**
 * The Nexus-wide reviewer integration: which GitHub App publishes the reviews
 * and their check runs, and which launch answers them. It carries no repository
 * — the project configuration names the one repository each review belongs to —
 * and no credential: `app.privateKeyPathEnv` names the environment variable
 * holding the App key's path, and only a review command reads it
 * (docs/WORKFLOW.md §9).
 */
const reviewerSchema = z.strictObject({
  app: githubReviewAppSchema,
  reviewer: agentSchema,
  checkName: nonBlankString('reviewer.checkName').default(REVIEW_DEFAULTS.checkName),
});

/**
 * The project configuration a connected repository carries at its root: the
 * commands that decide a task in that repository, its Jira connection, and its
 * GitHub destination. Nothing Nexus-wide belongs here — no launch, no limit, no
 * output directory, and no reviewer identity (docs/WORKFLOW.md §1).
 */
export const projectConfigSchema = z.strictObject({
  setup: z.array(commandSchema, { error: 'must be an array of command arrays' }),
  checks: z
    .array(commandSchema, { error: 'must be an array of command arrays' })
    .min(1, { error: 'must contain at least one command' }),
  source: jiraSourceSchema.optional(),
  delivery: projectDeliverySchema.optional(),
});

/**
 * The Nexus-wide harness configuration an operator keeps: where runs write,
 * how much time and repair they get, which coding launches they use, and the
 * reviewer integration that follows them. It names no repository, no Jira
 * connection, and no project command; composing it with one project
 * configuration is load.ts's job (docs/WORKFLOW.md §1).
 */
export const harnessConfigSchema = z
  .strictObject({
    workDir: nonBlankString('workDir'),
    maxRepairs: boundedInteger('maxRepairs', 0, 'a nonnegative integer'),
    taskTimeoutMinutes: boundedInteger('taskTimeoutMinutes', 1, 'a positive integer'),
    commandTimeoutMinutes: boundedInteger('commandTimeoutMinutes', 1, 'a positive integer'),
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
    reviewer: reviewerSchema.optional(),
    completion: completionSchema.optional(),
  })
  .refine(
    (config) =>
      config.reviewer === undefined ||
      config.completion === undefined ||
      (config.reviewer.app.appId === config.completion.lensAppId &&
        config.reviewer.app.login === config.completion.lensApp &&
        config.reviewer.checkName === config.completion.lensCheckName),
    {
      error:
        'the reviewer integration and the completion policy must name the same Nexus Lens App, ' +
        'login and check: otherwise the completion gate would require a check the configured ' +
        'reviewer never publishes',
      path: ['completion'],
    },
  );

/** The validated contents of a Nexus-wide harness configuration file. */
export type HarnessFileConfig = z.infer<typeof harnessConfigSchema>;

/** The validated contents of one connected project's configuration file. */
export type ProjectFileConfig = z.infer<typeof projectConfigSchema>;

/**
 * The fields the project configuration owns. A harness configuration that
 * carries one is refused with where it belongs, rather than only as an
 * unrecognized key (docs/WORKFLOW.md §1).
 */
export const PROJECT_OWNED_FIELDS = ['setup', 'checks', 'source', 'delivery'] as const;

/**
 * The fields the Nexus-wide harness configuration owns; a project configuration
 * that carries one is refused the same way.
 */
export const HARNESS_OWNED_FIELDS = [
  'workDir',
  'maxRepairs',
  'taskTimeoutMinutes',
  'commandTimeoutMinutes',
  'agent',
  'escalation',
  'reviewer',
  'completion',
] as const;

/**
 * Which of `owned` this document carries. The loader asks before validating, so
 * a field that moved between the two files is reported as belonging to the
 * other one instead of as a typo.
 */
export function misplacedFields(document: unknown, owned: readonly string[]): string[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return [];
  const keys = new Set(Object.keys(document));
  return owned.filter((name) => keys.has(name));
}

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
