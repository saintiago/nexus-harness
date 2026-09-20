/**
 * `check-config`: read and validate a configuration file, and a task file when
 * one is given, and print what it validated.
 *
 * It is static: it creates nothing, runs nothing, contacts nothing, and resolves
 * no credential.
 */
import path from 'node:path';
import { ConfigError, loadHarnessConfig, loadTask, resolveWorkDir } from '../config/load.js';
import type { Command, HarnessConfig, Task } from '../shared/types.js';
import { EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './context.js';
import type { CliContext } from './context.js';
import { USAGE_HINT } from './help.js';
import type { ParsedOptions } from './options.js';

function commandCount(commands: readonly Command[]): string {
  return `${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`;
}

function describeConfig(config: HarnessConfig, configPath: string, workDir: string): string {
  const lines = [
    `check-config: ${configPath} is valid`,
    `  workDir                ${workDir} (resolved from this file)`,
    `  maxRepairs             ${config.maxRepairs}`,
    `  taskTimeoutMinutes     ${config.taskTimeoutMinutes}`,
    `  commandTimeoutMinutes  ${config.commandTimeoutMinutes}`,
    `  setup                  ${commandCount(config.setup)}`,
    `  checks                 ${commandCount(config.checks)}`,
  ];
  const { delivery, source, review } = config;
  if (delivery !== undefined) {
    lines.push(`  delivery               github ${delivery.repository} -> ${delivery.baseBranch}`);
    if (delivery.completion !== undefined) {
      const completion = delivery.completion;
      lines.push(
        `  delivery completion    reviewer ${completion.lensApp}, check ${completion.lensCheckName}, ` +
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
  const { config: configArgument, task: taskArgument } = options;

  if (configArgument === undefined) {
    io.err(`error: check-config requires --config\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  // CLI paths resolve from the invocation directory; workDir resolves from the
  // configuration file instead (see resolveWorkDir). A task file is optional:
  // without one this validates the configuration alone, and still creates
  // nothing, starts nothing, and resolves no credential.
  const configPath = path.resolve(cwd, configArgument);

  try {
    const config = await loadHarnessConfig(configPath);
    io.out(describeConfig(config, configPath, resolveWorkDir(config, configPath)));
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

/**
 * The loop's real collaborators, and nothing else: every one of them is an
 * ordinary function of the module that owns it (docs/architecture.md §3). The
 * CLI composes them; it does not implement any part of the loop.
 *
 * The one piece of composition the selection needs is here: the adapter is
 * handed the effective agent selection, so every top-level turn of the run — the
 * implementation and every repair — starts the same configured launch prefix.
 * The runner never sees the prefix except as the value it records
 * (docs/architecture.md §2).
 */
