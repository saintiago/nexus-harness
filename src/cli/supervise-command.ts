/**
 * `supervise run`, `supervise watch` and `supervise ticket`: the supervised
 * queue commands.
 *
 * They compose one supervision invocation and nothing else: the configuration
 * (with the recovery policy it must declare), the connected project's Jira
 * boundary when its report has a ticket to be written to, the worker that runs
 * the same Nexus CLI, the recovery turn the configured profile answers with,
 * and the reporter that publishes the concise Jira report and the email
 * summary. Which of those ran, and in what order, belongs to the supervisor
 * (docs/WORKFLOW.md §12).
 *
 * A finite intent exits when the worker settles, an interrupted one exits with
 * the conventional cancellation code without recovering anything, and every
 * incident that ended in a request for human help exits nonzero with the
 * evidence kept — the same outcomes an unsupervised queue has, plus the
 * incident record beside them.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ConfigError,
  loadConfiguration,
  projectLockNamespace,
  resolveWorkDir,
} from '../config/load.js';
import { projectConfigFile } from '../config/paths.js';
import { messageOf } from '../shared/errors.js';
import type { HarnessConfig, JiraSourceConfig } from '../shared/types.js';
import { createHttpClient, resolveJiraToken } from '../sources/jira/http.js';
import { SourceError } from '../sources/contract.js';
import type { HttpClient } from '../sources/jira/http.js';
import { incidentDir, supervisorRoot } from '../supervisor/incident.js';
import { createRecoveryTurn } from '../supervisor/recovery.js';
import { createIncidentReporter } from '../supervisor/report.js';
import type { IncidentRecord } from '../supervisor/incident.js';
import { supervise } from '../supervisor/supervise.js';
import type { SupervisorParts, SuperviseSummary } from '../supervisor/supervise.js';
import { runNexusWorker } from '../supervisor/worker.js';
import { createActivityDisplay } from './activity.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './context.js';
import type { CliContext, CliIo } from './context.js';
import { USAGE_HINT } from './help.js';
import {
  listOptions,
  parseOptions,
  SUPERVISE_RUN_OPTIONS,
  SUPERVISE_TICKET_OPTIONS,
  SUPERVISE_WATCH_OPTIONS,
} from './options.js';
import { queueConfigurationProblem } from './queue-command.js';
import { hostSignals } from './signals.js';

/** Which supervision the operator asked for, and what it was given. */
interface SuperviseCommandOptions {
  readonly intent: 'run' | 'watch' | 'ticket';
  /** The ticket a scoped run follows; `null` for the two other intents. */
  readonly scope: string | null;
  readonly configPath: string;
  readonly repoPath: string;
}

/** How one supervision result becomes an exit code, and what it prints. */
function describeSummary(summary: SuperviseSummary, intent: string): string {
  const lines = [
    `supervise ${intent}: ${summary.outcome}`,
    `  workers    ${String(summary.workerRuns)} queue invocation(s) started`,
    `  recoveries ${String(summary.recoveries)} recovery turn(s) started`,
  ];
  if (summary.incidentId !== null) {
    lines.push(`  incident   ${summary.incidentId}`);
  }
  if (summary.problem !== null) {
    lines.push(`  problem    ${summary.problem}`);
  }
  if (summary.outcome === 'settled' && summary.workerRuns > 0 && summary.recoveries === 0) {
    lines.push('  note       the queue finished without an incident');
  }
  return lines.join('\n');
}

/**
 * The directory the supervisor treats as the Nexus installation: the nearest
 * directory above the CLI entry that carries a `package.json`, so a checkout
 * that runs `src/cli.ts` through `tsx` and one that runs `dist/cli.js` agree.
 */
function installationRoot(entry: string): string {
  let directory = path.dirname(path.resolve(entry));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(path.join(directory, 'package.json'))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return path.dirname(path.resolve(entry));
}

/** The CLI entry and interpreter the worker is started with. */
function entryParts(
  context: CliContext,
): { entry: string; interpreter: string; cwd: string } | string {
  const substitute = context.supervisorParts?.entry;
  if (substitute !== undefined) {
    return {
      entry: substitute,
      interpreter: context.supervisorParts?.interpreter ?? process.execPath,
      cwd: context.supervisorParts?.cwd ?? context.cwd,
    };
  }
  const entry = process.argv[1];
  if (entry === undefined || entry.trim() === '') {
    return (
      'the supervisor could not determine which Nexus CLI entry to run: this process was started ' +
      'without an entry file. Start the supervisor through the installed CLI, or through ' +
      '`npm run dev -- supervise …`.'
    );
  }
  return { entry: path.resolve(entry), interpreter: process.execPath, cwd: context.cwd };
}

/**
 * One `supervise` invocation: load the configuration, refuse one that declares
 * no recovery policy, resolve the Jira boundary its report will be written
 * through, and hand the supervisor its collaborators.
 */
async function superviseCommand(
  options: SuperviseCommandOptions,
  context: CliContext,
): Promise<number> {
  const { intent, scope, configPath, repoPath } = options;
  const projectPath = projectConfigFile(repoPath);
  const { io } = context;

  let config: HarnessConfig;
  try {
    config = (await loadConfiguration(configPath, projectPath)).config;
  } catch (cause) {
    if (cause instanceof ConfigError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const recovery = config.recovery;
  if (recovery === undefined) {
    io.err(
      `error: ${configPath} declares no "recovery" policy, so there is no recovery agent to ` +
        'invoke and no notification policy to report through. A supervised run needs that object; ' +
        'docs/WORKFLOW.md section 12 defines it, and docs/nexus.config.example.json shows it.',
    );
    return EXIT_INPUT_ERROR;
  }
  const queueProblem = queueConfigurationProblem(config, configPath, projectPath);
  if (queueProblem !== null) {
    io.err(`error: ${queueProblem}`);
    return EXIT_INPUT_ERROR;
  }

  const workDir = resolveWorkDir(config, configPath);
  const namespace = projectLockNamespace(config);
  const root = supervisorRoot(workDir, namespace);
  const parts = entryParts(context);
  if (typeof parts === 'string') {
    io.err(`error: ${parts}`);
    return EXIT_INPUT_ERROR;
  }

  // The report's own Jira boundary: the connected project's source connection,
  // resolved before anything runs so a missing credential is a refusal rather
  // than an incident. The service account that wrote the ticket is the one that
  // writes the recovery report into the same thread.
  let jira: { http: HttpClient; token: string } | undefined;
  let jiraIdentity: { siteUrl: string; projectKey: string } | undefined;
  const sourceConfig = config.source as JiraSourceConfig;
  try {
    const token = resolveJiraToken(sourceConfig, process.env);
    jira = {
      http: createHttpClient(
        sourceConfig,
        token,
        context.fetch === undefined ? {} : { fetch: context.fetch },
      ),
      token,
    };
    jiraIdentity = { siteUrl: sourceConfig.siteUrl, projectKey: sourceConfig.projectKey };
  } catch (cause) {
    if (cause instanceof SourceError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const stop = new AbortController();
  const pane = createActivityDisplay(io);
  const activeIo: CliIo = {
    out: (text) => {
      pane.line(text);
    },
    err: (text) => {
      pane.error(text);
    },
  };
  const release = (context.signals ?? hostSignals()).onInterrupt(() => {
    if (stop.signal.aborted) {
      activeIo.err(
        'interrupt received again: this supervision is already stopping, and it is still waiting ' +
          'for the worker to stop itself and clean up before it exits.',
      );
      return;
    }
    activeIo.err(
      [
        'interrupt received: asking the supervised queue to stop. Nothing is recovered from an',
        'intentional stop: the worker is stopped, its evidence is kept, and this command exits',
        'with the conventional cancellation code.',
      ].join('\n'),
    );
    stop.abort(new Error('the user interrupted the supervision'));
  });

  try {
    const substitute = context.supervisorParts ?? {};
    const parts0: SupervisorParts = {
      worker: substitute.worker ?? runNexusWorker,
      recoveryTurn:
        substitute.recoveryTurn ??
        createRecoveryTurn({
          selection: recovery.agent,
          environment: process.env,
          onActivity: (activity) => {
            pane.activity(activity);
          },
          onTurnStart: (ticket) => {
            pane.beginInvocation({ role: 'recovery', ticket, phase: 'recovery attempt' });
          },
          onTurnEnd: () => {
            pane.endInvocation();
          },
        }),
      reporter:
        substitute.reporter ??
        createIncidentReporter({
          ...(jira === undefined ? {} : { jira }),
          notification: recovery.notifications ?? null,
          logsDir: (incident: IncidentRecord) => incidentDir(root, incident.id),
          cwd: workDir,
          now: () => new Date(),
        }),
      entry: substitute.entry ?? parts.entry,
      interpreter: substitute.interpreter ?? parts.interpreter,
      cwd: substitute.cwd ?? parts.cwd,
      installRoot: substitute.installRoot ?? installationRoot(substitute.entry ?? parts.entry),
      isAlive:
        substitute.isAlive ??
        ((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (cause) {
            return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        }),
    };

    const summary = await supervise({
      intent,
      scope,
      workDir,
      namespace,
      repoPath,
      configPath,
      projectConfigPath: projectPath,
      installRoot: parts0.installRoot,
      entry: parts0.entry,
      interpreter: parts0.interpreter,
      cwd: parts0.cwd,
      recovery,
      recoveryTurnTimeoutMs: config.taskTimeoutMinutes * 60_000,
      io: { out: activeIo.out, err: activeIo.err },
      stop: stop.signal,
      now: () => new Date(),
      ...(jira === undefined ? {} : { jira }),
      ...(jiraIdentity === undefined ? {} : { jiraIdentity }),
      recoveryTurn: parts0.recoveryTurn,
      reporter: parts0.reporter,
      logsDir: root,
      worker: parts0.worker,
      isAlive: parts0.isAlive,
    });

    pane.close();
    activeIo.out(describeSummary(summary, intent));
    if (summary.outcome === 'cancelled') {
      return EXIT_CANCELLED;
    }
    return summary.outcome === 'settled' ? EXIT_OK : EXIT_INPUT_ERROR;
  } catch (cause) {
    pane.close();
    if (cause instanceof SourceError) {
      activeIo.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    activeIo.err(`error: the supervision could not be completed: ${messageOf(cause)}`);
    return EXIT_INPUT_ERROR;
  } finally {
    release();
    pane.close();
  }
}

/** The three supervised intents, and the one positional a scoped run needs. */
export async function superviseCli(args: readonly string[], context: CliContext): Promise<number> {
  const { cwd, io } = context;
  const [subcommand, ...rest] = args;

  if (subcommand === undefined) {
    io.err(`error: supervise requires one of: run, watch, ticket\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand.startsWith('-')) {
    io.err(`error: unknown option "${subcommand}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand !== 'run' && subcommand !== 'watch' && subcommand !== 'ticket') {
    io.err(
      `error: unknown supervise command "${subcommand}"; expected "run", "watch" or "ticket"` +
        `\n${USAGE_HINT}`,
    );
    return EXIT_USAGE;
  }

  let scope: string | null = null;
  let optionArguments = rest;
  if (subcommand === 'ticket') {
    const [key, ...remaining] = rest;
    if (key === undefined || key.startsWith('-')) {
      io.err(`error: supervise ticket requires a ticket key, for example HARN-51\n${USAGE_HINT}`);
      return EXIT_USAGE;
    }
    scope = key;
    optionArguments = remaining;
  }

  const allowed =
    subcommand === 'watch'
      ? SUPERVISE_WATCH_OPTIONS
      : subcommand === 'ticket'
        ? SUPERVISE_TICKET_OPTIONS
        : SUPERVISE_RUN_OPTIONS;
  const parsed = parseOptions(optionArguments, allowed);
  if (!parsed.ok) {
    io.err(`error: ${parsed.message}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  const missing = [
    parsed.options.config === undefined ? '--config' : undefined,
    parsed.options.repo === undefined ? '--repo' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    io.err(`error: supervise ${subcommand} requires ${listOptions(missing)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  return superviseCommand(
    {
      intent: subcommand,
      scope,
      configPath: path.resolve(cwd, parsed.options.config ?? ''),
      repoPath: path.resolve(cwd, parsed.options.repo ?? ''),
    },
    context,
  );
}
