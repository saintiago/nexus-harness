/**
 * Reading, validating, and composing the two configuration files.
 *
 * One Nexus-wide harness configuration (`--config`) says how this instance runs
 * work: where runs write, how long they may take, which coding launches they
 * use, and which reviewer follows them. One project configuration, in the
 * connected repository's own root, says what that repository is: the commands
 * that decide a task there, its Jira connection, and its GitHub destination.
 * This module reads both, composes them, and returns the {@link HarnessConfig}
 * every command runs on (docs/WORKFLOW.md §1).
 *
 * Inputs are rejected rather than repaired: no value is coerced, no key is
 * ignored, no environment variable is interpolated, and no field is defaulted
 * beyond the documented ones. Which file owns a field is part of the contract,
 * so a field in the wrong file, a project that cannot supply what the harness
 * configuration's reviewer and completion policy need, and every other mismatch
 * are refused with both paths and the field named. The schemas themselves live
 * in schema.ts; this module reads files, applies them, and resolves the
 * path-valued fields against the harness configuration's own directory.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type {
  AgentSelection,
  CompletionConfig,
  EscalationTier,
  GitHubDeliveryConfig,
  GitHubReviewAppConfig,
  GitHubReviewConfig,
  HarnessConfig,
  Task,
} from '../shared/types.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from './paths.js';
import {
  DEFAULT_AGENT_SELECTION,
  HARNESS_OWNED_FIELDS,
  PROJECT_OWNED_FIELDS,
  checkCompletionStatuses,
  harnessConfigSchema,
  misplacedFields,
  projectConfigSchema,
  taskSchema,
} from './schema.js';
import type { HarnessFileConfig, ProjectFileConfig } from './schema.js';

/**
 * A configuration or task input that could not be read, did not validate, or
 * could not be composed. `problems` holds one entry per field, ready to print
 * under the file name; a cross-file problem names the other file itself.
 */
export class ConfigError extends Error {
  readonly file: string;
  readonly problems: readonly string[];

  constructor(file: string, problems: readonly string[]) {
    super([file, ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'ConfigError';
    this.file = file;
    this.problems = problems;
  }
}

/** The two files one command was given, and the configuration they compose. */
export interface LoadedConfiguration {
  /** The effective, composed configuration every command runs on. */
  readonly config: HarnessConfig;
  /** What the harness configuration file declared, validated and resolved. */
  readonly harness: ResolvedHarnessConfig;
  /** What the project configuration file declared, validated. */
  readonly project: ProjectFileConfig;
}

/**
 * One harness configuration file, validated and with its launches resolved: the
 * exact selection a run would start, and the reviewer integration that follows
 * the connected project (docs/WORKFLOW.md §1, "Agent launch and path rules").
 */
export interface ResolvedHarnessConfig {
  readonly workDir: string;
  readonly maxRepairs: number;
  readonly taskTimeoutMinutes: number;
  readonly commandTimeoutMinutes: number;
  /** The coding launch, already defaulted and with its executable resolved. */
  readonly agent: AgentSelection;
  /** The ladder, with every rung's launch resolved and allowance defaulted. */
  readonly escalation?: readonly EscalationTier[];
  /** The Nexus Lens integration, with the reviewer launch resolved. */
  readonly reviewer?: ResolvedReviewerConfig;
  /** The review-to-completion policy, unchanged: it names no launch. */
  readonly completion?: HarnessFileConfig['completion'];
}

/** The Nexus-wide reviewer integration, with its launch resolved. */
export interface ResolvedReviewerConfig {
  readonly app: GitHubReviewAppConfig;
  readonly reviewer: AgentSelection;
  readonly checkName: string;
}

/** Whether an executable names a path rather than a bare program name. */
function namesAPath(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\');
}

/**
 * Applies the documented launch-path rules to one selection: a relative
 * path-valued executable resolves against the harness configuration file's
 * directory, once, before anything is started; an absolute path is used as
 * supplied; a bare name is left alone, for the host launcher's own `PATH`
 * resolution. The remaining arguments are opaque and are never resolved,
 * joined, or expanded (docs/WORKFLOW.md §1, "Agent launch and path rules").
 */
export function resolveAgentSelection(agent: AgentSelection, configPath: string): AgentSelection {
  const [executable = '', ...prefix] = agent.command;
  const resolved =
    namesAPath(executable) && !path.isAbsolute(executable)
      ? path.resolve(path.dirname(path.resolve(configPath)), executable)
      : executable;
  return { runtime: agent.runtime, command: [resolved, ...prefix] };
}

/** Renders `['checks', 0, 1]` as `checks[0][1]`. */
function formatPath(segments: readonly PropertyKey[]): string {
  let formatted = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else if (formatted === '') {
      formatted = String(segment);
    } else {
      formatted += `.${String(segment)}`;
    }
  }
  return formatted;
}

/**
 * Turns Zod issues into `field: what is wrong` lines. Whole-document problems
 * (an unknown top-level key, a root value of the wrong type) carry no path and
 * describe themselves.
 */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = formatPath(issue.path);
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });
}

/**
 * Reads one JSON document. `hint` says what the file is for, so a file that is
 * simply not there reads as the missing half of the configuration contract
 * rather than as a mistyped path.
 */
async function readJson(file: string, hint: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    throw new ConfigError(file, [`cannot be read: ${messageOf(cause)} (expected ${hint})`]);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ConfigError(file, [`is not valid JSON: ${messageOf(cause)}`]);
  }
}

/** Validates one document against one schema, reporting under its file name. */
function parseOrExplain<T>(schema: z.ZodType<T>, document: unknown, file: string): T {
  const result = schema.safeParse(document);
  if (!result.success) {
    throw new ConfigError(file, describeIssues(result.error));
  }
  return result.data;
}

/**
 * Refuses a document that carries a field the other file owns, naming where
 * that field belongs. A combined single-file configuration, or a project field
 * pasted into the Nexus-wide file, is then a one-line diagnosis instead of a
 * bare unrecognized key.
 */
function refuseMisplacedFields(
  document: unknown,
  file: string,
  owned: readonly string[],
  belongs: string,
): void {
  const misplaced = misplacedFields(document, owned);
  if (misplaced.length > 0) {
    throw new ConfigError(
      file,
      misplaced.map((field) => `${field}: ${belongs}`),
    );
  }
}

/**
 * Reads the Nexus-wide harness configuration and one connected project's
 * configuration, validates each on its own, and composes the effective
 * configuration (docs/WORKFLOW.md §1). `harnessPath` names the harness
 * configuration file and `projectPath` the project configuration file itself;
 * a caller that was handed a repository directory reads it with
 * `projectConfigFile`.
 */
export async function loadConfiguration(
  harnessPath: string,
  projectPath: string,
): Promise<LoadedConfiguration> {
  const harness = await loadHarnessFile(harnessPath);

  const projectHint =
    `the project configuration a connected repository carries at its root ` +
    `(${PROJECT_CONFIG_FILE_NAME})`;
  const projectRaw = await readJson(projectPath, projectHint);
  refuseMisplacedFields(
    projectRaw,
    projectPath,
    HARNESS_OWNED_FIELDS,
    'belongs to the Nexus-wide harness configuration passed with --config, not to the ' +
      'project configuration',
  );

  const project = parseOrExplain(projectConfigSchema, projectRaw, projectPath);
  const config = compose(harness, project, harnessPath, projectPath);
  return { config, harness, project };
}

/**
 * One Nexus-wide harness configuration file on its own: the output directory,
 * the limits, the coding launches, and the reviewer integration, validated,
 * defaulted, and with their launch paths resolved. A project field in it is
 * refused with where it belongs, exactly as through {@link loadConfiguration}.
 *
 * Only the opt-in live verifier reads a harness configuration without a
 * connected project: its disposable fixture supplies the project side itself
 * (docs/WORKFLOW.md §3, "Opt-in live verification").
 */
export async function loadHarnessFile(harnessPath: string): Promise<ResolvedHarnessConfig> {
  const hint = `the Nexus-wide harness configuration (${HARNESS_CONFIG_FILE_NAME})`;
  const raw = await readJson(harnessPath, hint);
  refuseMisplacedFields(
    raw,
    harnessPath,
    PROJECT_OWNED_FIELDS,
    `belongs to the project configuration (${PROJECT_CONFIG_FILE_NAME} in the connected ` +
      "repository's root), not to the Nexus-wide harness configuration",
  );
  return resolveHarnessFile(parseOrExplain(harnessConfigSchema, raw, harnessPath), harnessPath);
}

/**
 * Applies the documented launch-path rules to a whole harness configuration
 * once, before anything runs: an omitted `agent` is the documented ordinary
 * Codex launch, a relative path-valued executable resolves against the harness
 * configuration file's own directory, and a ladder rung that names no launch or
 * allowance inherits the top-level one.
 */
function resolveHarnessFile(
  harness: HarnessFileConfig,
  harnessPath: string,
): ResolvedHarnessConfig {
  const agent = resolveAgentSelection(harness.agent ?? DEFAULT_AGENT_SELECTION, harnessPath);
  return {
    workDir: harness.workDir,
    maxRepairs: harness.maxRepairs,
    taskTimeoutMinutes: harness.taskTimeoutMinutes,
    commandTimeoutMinutes: harness.commandTimeoutMinutes,
    agent,
    ...(harness.escalation === undefined
      ? {}
      : {
          escalation: harness.escalation.map((tier) => ({
            name: tier.name,
            agent: resolveAgentSelection(tier.agent ?? agent, harnessPath),
            maxRepairs: tier.maxRepairs ?? harness.maxRepairs,
          })),
        }),
    ...(harness.reviewer === undefined
      ? {}
      : {
          reviewer: {
            app: harness.reviewer.app,
            reviewer: resolveAgentSelection(harness.reviewer.reviewer, harnessPath),
            checkName: harness.reviewer.checkName,
          },
        }),
    ...(harness.completion === undefined ? {} : { completion: harness.completion }),
  };
}

/**
 * The composed configuration alone, for a command that does not print what each
 * file declared.
 */
export async function loadEffectiveConfig(
  harnessPath: string,
  projectPath: string,
): Promise<HarnessConfig> {
  return (await loadConfiguration(harnessPath, projectPath)).config;
}

/**
 * The two files meet here and nowhere else: harness-wide fields come from the
 * harness configuration, project fields from the project configuration, and the
 * objects that need both sides — a review, and one project's completion — are
 * built here. Anything the two cannot supply to each other is a mismatch, and a
 * mismatch stops the command before it claims anything (docs/WORKFLOW.md §1).
 */
function compose(
  harness: ResolvedHarnessConfig,
  project: ProjectFileConfig,
  harnessPath: string,
  projectPath: string,
): HarnessConfig {
  const reviewer = harness.reviewer;
  const policy = harness.completion;
  const delivery = project.delivery;
  const source = project.source;
  const projectCompletion = delivery?.completion;

  // A review reviews the repository its project delivers to, through the Jira
  // connection that project scans: without both there is nothing to review, so
  // the Nexus-wide reviewer cannot be in force for this project.
  if (reviewer !== undefined && (source === undefined || delivery === undefined)) {
    throw new ConfigError(projectPath, [
      ...(source === undefined
        ? [
            `source: ${harnessPath} configures the Nexus Lens reviewer, whose scans read the ` +
              'project\u2019s Jira connection, and this project configuration declares none. Add ' +
              '"source" here, or remove "reviewer" from the harness configuration',
          ]
        : []),
      ...(delivery === undefined
        ? [
            `delivery: ${harnessPath} configures the Nexus Lens reviewer, whose reviews belong ` +
              'to the repository a project delivers to, and this project configuration declares ' +
              'none. Add "delivery" here, or remove "reviewer" from the harness configuration',
          ]
        : []),
    ]);
  }

  // The project names the workflows and the statuses; the harness-wide policy
  // names the reviewer that gates them. One without the other is not a
  // completion.
  if (projectCompletion !== undefined && policy === undefined) {
    throw new ConfigError(harnessPath, [
      `completion: ${projectPath} declares "delivery.completion", and this harness configuration ` +
        'declares no "completion" policy naming the Nexus Lens reviewer\u2019s identity and ' +
        'credential. Add "completion" here, or remove "delivery.completion" from the project ' +
        'configuration',
    ]);
  }

  const completion: CompletionConfig | undefined =
    projectCompletion === undefined || policy === undefined
      ? undefined
      : {
          lensApp: policy.lensApp,
          lensAppId: policy.lensAppId,
          lensCheckName: policy.lensCheckName,
          reviewerTokenEnv: policy.reviewerTokenEnv,
          postMergeWorkflows: projectCompletion.postMergeWorkflows,
          toDoStatus: projectCompletion.toDoStatus,
          doneStatus: projectCompletion.doneStatus,
          pollIntervalSeconds: policy.pollIntervalSeconds,
          deadlineSeconds: policy.deadlineSeconds,
        };

  // The one completion check that needs the project's own Jira workflow: moving
  // an item out of review has to mean something (docs/WORKFLOW.md §10).
  if (completion !== undefined && source !== undefined) {
    const problem = checkCompletionStatuses(source.reviewStatus, completion);
    if (problem !== null) {
      throw new ConfigError(projectPath, [`delivery.completion: ${problem}`]);
    }
  }

  const deliveryConfig: GitHubDeliveryConfig | undefined =
    delivery === undefined
      ? undefined
      : {
          type: 'github',
          repository: delivery.repository,
          baseBranch: delivery.baseBranch,
          ...(completion === undefined ? {} : { completion }),
        };

  const review: GitHubReviewConfig | undefined =
    reviewer === undefined || delivery === undefined
      ? undefined
      : {
          type: 'github',
          repository: delivery.repository,
          app: reviewer.app,
          reviewer: reviewer.reviewer,
          checkName: reviewer.checkName,
        };

  return {
    workDir: harness.workDir,
    maxRepairs: harness.maxRepairs,
    taskTimeoutMinutes: harness.taskTimeoutMinutes,
    commandTimeoutMinutes: harness.commandTimeoutMinutes,
    setup: project.setup,
    checks: project.checks,
    // The launches the harness configuration resolved once: an explicit
    // selection with its path rules applied, or the documented ordinary Codex
    // launch; a ladder rung that names nothing inherits the top-level one.
    agent: harness.agent,
    ...(harness.escalation === undefined ? {} : { escalation: harness.escalation }),
    // A project without a Jira connection stays without one: a file-task
    // command must not acquire a connector, a credential, or intake state
    // because a field it never asked for was given a default
    // (docs/WORKFLOW.md §5).
    ...(source === undefined ? {} : { source }),
    ...(deliveryConfig === undefined ? {} : { delivery: deliveryConfig }),
    ...(review === undefined ? {} : { review }),
  };
}

/**
 * The ladder a source run climbs, whether or not the configuration declared one:
 * a single rung built from `agent` and `maxRepairs` is the ordinary case, and a
 * declared ladder is used as written. The name of the synthesized rung is
 * `default`, which is what a comment calls it when nothing named it.
 */
export function escalationTiers(config: HarnessConfig): readonly EscalationTier[] {
  return (
    config.escalation ?? [{ name: 'default', agent: config.agent, maxRepairs: config.maxRepairs }]
  );
}

/** Reads and validates a task file. */
export async function loadTask(taskPath: string): Promise<Task> {
  const raw = await readJson(taskPath, 'the task file passed with --task');
  return parseOrExplain(taskSchema, raw, taskPath);
}

/**
 * Resolves `workDir` against the directory holding the harness configuration
 * file, so the same harness configuration points at the same output directory
 * whatever the process working directory is. An absolute `workDir` is returned
 * unchanged.
 */
export function resolveWorkDir(config: HarnessConfig, harnessConfigPath: string): string {
  return path.resolve(path.dirname(path.resolve(harnessConfigPath)), config.workDir);
}
