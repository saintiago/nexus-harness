/**
 * `check-config`: read and validate the Nexus-wide harness configuration, the
 * connected project's configuration, and a task file when one is given, and
 * print the composed effective configuration they make.
 *
 * It is static: it creates nothing, runs nothing, contacts nothing, and resolves
 * no credential. What it validates is the composition the commands run on, so a
 * project field in the wrong file, a project that cannot supply what the
 * Nexus-wide reviewer needs, and every other mismatch is reported here first.
 */
import path from 'node:path';
import { ConfigError, loadConfiguration, loadTask, resolveWorkDir } from '../config/load.js';
import { projectConfigFile } from '../config/paths.js';
import type { HarnessFileConfig } from '../config/schema.js';
import type { Command, HarnessConfig, JiraOrdering, Task } from '../shared/types.js';
import { EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './context.js';
import type { CliContext } from './context.js';
import { USAGE_HINT } from './help.js';
import { listOptions } from './options.js';
import type { ParsedOptions } from './options.js';

function commandCount(commands: readonly Command[]): string {
  return `${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`;
}

/**
 * The configured intake order, as the field it puts first and the deterministic
 * tie-breakers Jira applies after it (docs/WORKFLOW.md §5).
 */
function describeOrdering(ordering: JiraOrdering): string {
  return ordering === 'rank'
    ? 'rank: Jira Rank ASC, then created ASC, then the issue key'
    : 'priority: Jira priority DESC, then created ASC, then the issue key';
}

/** What the Nexus-wide harness configuration file itself declared. */
function describeHarness(harness: HarnessFileConfig, harnessPath: string, workDir: string): string {
  const lines = [
    `check-config: ${harnessPath} is valid`,
    `  workDir                ${workDir} (resolved from this file)`,
    `  maxRepairs             ${harness.maxRepairs}`,
    `  taskTimeoutMinutes     ${harness.taskTimeoutMinutes}`,
    `  commandTimeoutMinutes  ${harness.commandTimeoutMinutes}`,
  ];
  if (harness.escalation !== undefined) {
    lines.push(
      `  escalation             ${String(harness.escalation.length)} tier(s): ` +
        harness.escalation.map((tier) => tier.name).join(', '),
    );
  }
  const { reviewer, completion } = harness;
  if (reviewer !== undefined) {
    lines.push(
      `  reviewer               github app ${String(reviewer.app.appId)} installation ` +
        `${String(reviewer.app.installationId)} as ${reviewer.app.login}, check ` +
        `"${reviewer.checkName}", key path environment variable ${reviewer.app.privateKeyPathEnv}`,
      `  reviewer launch        ${reviewer.reviewer.runtime} ${reviewer.reviewer.command.join(' ')}`,
    );
  }
  if (completion !== undefined) {
    lines.push(
      `  completion             reviewer ${completion.lensApp} ` +
        `(App ${String(completion.lensAppId)}), check "${completion.lensCheckName}", ` +
        `credential environment variable ${completion.reviewerTokenEnv}, ` +
        `poll ${String(completion.pollIntervalSeconds)}s, ` +
        `deadline ${String(completion.deadlineSeconds)}s`,
    );
  }
  return lines.join('\n');
}

/**
 * What the connected project composes to: its own fields, and the effective
 * objects the two files produce together — which repository a review belongs
 * to, and the completion gate one of its pull requests has to pass.
 */
function describeProject(config: HarnessConfig, projectPath: string): string {
  const lines = [
    `check-config: ${projectPath} is valid`,
    `  setup                  ${commandCount(config.setup)}`,
    `  checks                 ${commandCount(config.checks)}`,
  ];
  const { delivery, source, review } = config;
  if (delivery !== undefined) {
    lines.push(`  delivery               github ${delivery.repository} -> ${delivery.baseBranch}`);
    if (delivery.completion !== undefined) {
      const completion = delivery.completion;
      lines.push(
        `  delivery completion    reviewer ${completion.lensApp} (App ${String(completion.lensAppId)}), check ${completion.lensCheckName}, ` +
          `credential environment variable ${completion.reviewerTokenEnv}`,
        `  delivery completion    post-merge workflows ${completion.postMergeWorkflows.join(', ')}, ` +
          `fail -> ${completion.toDoStatus}, verified -> ${completion.doneStatus}, ` +
          `poll ${String(completion.pollIntervalSeconds)}s, deadline ${String(completion.deadlineSeconds)}s`,
      );
    }
  }
  if (source !== undefined) {
    lines.push(
      `  source                 jira ${source.siteUrl} project ${source.projectKey}`,
      `  source queue           issuetype ${source.issueType}, label ${source.label}, ` +
        `${source.readyStatus} -> ${source.runningStatus} -> ${source.reviewStatus}`,
      `  source ordering        ${describeOrdering(source.ordering)}`,
      `  source polling         ${String(source.pollIntervalSeconds)}s, token environment variable ${source.tokenEnv}`,
    );
  }
  if (review !== undefined) {
    lines.push(
      `  review                 github ${review.repository} as ${review.app.login}, app ` +
        `${String(review.app.appId)} installation ${String(review.app.installationId)}`,
      `  review scanning        ${source === undefined ? '(no source)' : source.reviewStatus}, ` +
        `check "${review.checkName}", key path environment variable ` +
        `${review.app.privateKeyPathEnv}`,
      `  review reviewer        ${review.reviewer.runtime} ${review.reviewer.command.join(' ')}`,
    );
  }
  return lines.join('\n');
}

function describeTask(task: Task, taskPath: string): string {
  return [
    `check-config: ${taskPath} is valid`,
    `  id                     ${task.id}`,
    `  title                  ${task.title}`,
    `  acceptanceCriteria     ${task.acceptanceCriteria.length} item(s)`,
  ].join('\n');
}

export async function checkConfig(options: ParsedOptions, context: CliContext): Promise<number> {
  const { cwd, io } = context;
  const { config: configArgument, project: projectArgument, task: taskArgument } = options;

  if (configArgument === undefined || projectArgument === undefined) {
    const missing = [
      configArgument === undefined ? '--config' : undefined,
      projectArgument === undefined ? '--project' : undefined,
    ].filter((name) => name !== undefined);
    io.err(`error: check-config requires ${listOptions(missing)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  // CLI paths resolve from the invocation directory; workDir resolves from the
  // harness configuration file instead (see resolveWorkDir). The project's own
  // configuration is read from its root, and a task file is optional: without
  // one this validates the configuration alone, and still creates nothing,
  // starts nothing, and resolves no credential.
  const harnessPath = path.resolve(cwd, configArgument);
  const projectPath = projectConfigFile(path.resolve(cwd, projectArgument));

  try {
    const loaded = await loadConfiguration(harnessPath, projectPath);
    io.out(
      describeHarness(loaded.harness, harnessPath, resolveWorkDir(loaded.config, harnessPath)),
    );
    io.out(describeProject(loaded.config, projectPath));
    if (taskArgument !== undefined) {
      const taskPath = path.resolve(cwd, taskArgument);
      const task = await loadTask(taskPath);
      io.out(describeTask(task, taskPath));
    }
    return EXIT_OK;
  } catch (cause) {
    if (cause instanceof ConfigError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }
}
