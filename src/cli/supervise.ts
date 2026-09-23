/**
 * `supervise run`, `supervise watch` and `supervise ticket`: the supervised
 * queue commands, and the one entry point that can still start when the rest of
 * Nexus cannot.
 *
 * The supervisor is a parent. It runs the queue as a child process and hands
 * that child's unexpected ending to a recovery agent, and it must be able to do
 * so while the harness it supervises is broken — a missing module, a
 * configuration the worker cannot read, an installation that will not start.
 * This module is therefore its own process entry:
 *
 * ```text
 *   node dist/cli/supervise.js run --repo <checkout> --config <harness.json>
 * ```
 *
 * It loads the harness configuration (its own recovery policy has to be
 * readable: that is the supervisor's own configuration, not the worker's), the
 * project configuration as far as it can be read, and none of the ordinary
 * commands: not `cli.ts`, and not any module it loads. The worker it starts is
 * the ordinary CLI beside this file, so the broken module that stops the worker
 * is exactly the incident the recovery agent is given to repair. `cli.ts`
 * dispatches the same command here, so `supervise` behaves identically through
 * either entry.
 *
 * Which of the composed pieces ran, and in what order, belongs to the
 * supervisor (docs/WORKFLOW.md §12).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { hostSignals } from './signals.js';
import { consoleContext } from './terminal.js';
import {
  ConfigError,
  loadConfiguration,
  loadHarnessFile,
  projectLockNamespace,
} from '../config/load.js';
import { projectConfigFile } from '../config/paths.js';
import { queueConfigurationProblem } from '../config/queue-requirements.js';
import { messageOf } from '../shared/errors.js';
import type { HarnessConfig, JiraSourceConfig, RecoveryConfig } from '../shared/types.js';
import { SourceError } from '../sources/contract.js';
import { createHttpClient, resolveJiraToken } from '../sources/jira/http.js';
import type { HttpClient } from '../sources/jira/http.js';
import { incidentDir, supervisorRoot } from '../supervisor/incident.js';
import type { IncidentRecord } from '../supervisor/incident.js';
import { createRecoveryTurn } from '../supervisor/recovery.js';
import { createIncidentReporter } from '../supervisor/report.js';
import { supervise } from '../supervisor/supervise.js';
import type { SupervisorParts, SuperviseSummary } from '../supervisor/supervise.js';
import { runNexusWorker } from '../supervisor/worker.js';

/** Which supervision the operator asked for, and what it was given. */
interface SuperviseCommandOptions {
  readonly intent: 'run' | 'watch' | 'ticket';
  /** The ticket a scoped run follows; `null` for the two other intents. */
  readonly scope: string | null;
  readonly configPath: string;
  readonly repoPath: string;
}

/**
 * Everything one supervision needs from the two configuration files, and what
 * of the connected project's side could not be read.
 */
interface SupervisionConfiguration {
  readonly workDir: string;
  /** The configured task timeout: the bound of one recovery turn, unchanged. */
  readonly taskTimeoutMinutes: number;
  /** The id the supervisor's own state lives under (see {@link supervisionId}). */
  readonly namespace: string;
  readonly recovery: RecoveryConfig;
  /** The project's own intake-lock namespace, or `null` when it could not be composed. */
  readonly queueNamespace: string | null;
  /** The composed configuration, when the project's file could be read. */
  readonly config: HarnessConfig | null;
  /** The project problems the worker will meet, named rather than swallowed. */
  readonly projectProblems: readonly string[];
}

/** One configuration read: the supervision it supports, or the reason it cannot. */
type SupervisionConfigurationTake =
  | { readonly ok: true; readonly value: SupervisionConfiguration }
  | { readonly ok: false; readonly problem: string };

/**
 * The id the supervisor's own state lives under.
 *
 * It is derived from the two things that name the supervision itself — the
 * checkout it supervises and the harness configuration it was started with —
 * and deliberately not from the connected project's configuration. Supervision
 * has to work while that configuration is broken, and its incident record has
 * to stay findable across the repair, so its own state cannot be keyed by it.
 */
function supervisionId(repoPath: string, configPath: string): string {
  const identity = ['supervision-v1', path.resolve(repoPath), path.resolve(configPath)];
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

/**
 * How one supervision result becomes an exit code, and what it prints.
 */
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
 * that runs `src/supervisor/cli.ts` through `tsx` and one that runs
 * `dist/supervisor/cli.js` agree.
 */
function installationRoot(entry: string): string {
  let directory = path.dirname(path.resolve(entry));
  for (let depth = 0; depth < 6; depth += 1) {
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

/**
 * The ordinary CLI entry the worker runs: the one beside this supervisor's own
 * entry. A supervisor started as `dist/cli/supervise.js` starts `dist/cli.js`,
 * and one started as `src/cli/supervise.ts` starts `src/cli.ts`; a supervisor
 * started through the ordinary CLI itself — `node dist/cli.js supervise …`, or
 * `npm run dev -- supervise …` — runs that very file. Either way the worker is
 * the command the operator would have run by hand.
 */
function workerEntry(entry: string): string {
  const resolved = path.resolve(entry);
  const extension = path.extname(resolved);
  if (path.basename(resolved, extension) === 'cli') {
    return resolved;
  }
  return path.join(path.dirname(path.dirname(resolved)), `cli${extension}`);
}

/** The CLI entry, interpreter and working directory the worker is started with. */
function entryParts(
  context: CliContext,
):
  { entry: string; interpreter: string; interpreterArgs: readonly string[]; cwd: string } | string {
  const substitute = context.supervisorParts?.entry;
  if (substitute !== undefined) {
    return {
      entry: substitute,
      interpreter: context.supervisorParts?.interpreter ?? process.execPath,
      interpreterArgs: context.supervisorParts?.interpreterArgs ?? [],
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
  return {
    entry: workerEntry(entry),
    interpreter: process.execPath,
    // How this process itself was started: a supervisor run through `tsx`
    // starts its worker through `tsx` too, and the loader arguments are passed
    // on unchanged rather than guessed at.
    interpreterArgs: [...process.execArgv],
    cwd: context.cwd,
  };
}

/**
 * Reads what supervision needs from the two files.
 *
 * The harness configuration is the supervisor's own and is read in full: an
 * unreadable one leaves nothing to supervise with. The connected project's
 * configuration is read as far as it can be, because a worker that cannot read
 * it is exactly one of the stops the recovery agent exists for: a readable one
 * has to compose a queue — a configuration that never could is refused before
 * anything claims — and one that cannot be read at all starts the supervision
 * anyway, with the project's own problems named and no intake lock to check.
 */
async function loadSupervision(
  options: SuperviseCommandOptions,
): Promise<SupervisionConfigurationTake> {
  const projectPath = projectConfigFile(options.repoPath);
  let harness;
  try {
    harness = await loadHarnessFile(options.configPath);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      return { ok: false, problem: cause.message };
    }
    throw cause;
  }
  const recovery = harness.recovery;
  if (recovery === undefined) {
    return {
      ok: false,
      problem:
        `${options.configPath} declares no "recovery" policy, so there is no recovery agent to ` +
        'invoke and no notification policy to report through. A supervised run needs that object; ' +
        'docs/WORKFLOW.md section 12 defines it, and docs/nexus.config.example.json shows it.',
    };
  }
  if (recovery.notifications === undefined) {
    return {
      ok: false,
      problem:
        `${options.configPath} carries a "recovery" policy without "recovery.notifications", so ` +
        'an incident could be recovered but its summary could not be emailed. A supervised run ' +
        'reports every incident in Jira and by email: name the SNS topic and the address, as ' +
        'docs/nexus.config.example.json shows (docs/WORKFLOW.md section 12).',
    };
  }
  const workDir = path.resolve(path.dirname(path.resolve(options.configPath)), harness.workDir);
  const namespace = supervisionId(options.repoPath, options.configPath);

  let config: HarnessConfig;
  try {
    config = (await loadConfiguration(options.configPath, projectPath)).config;
  } catch (cause) {
    if (cause instanceof ConfigError) {
      // The project's own file could not be read or composed. The supervisor
      // still starts: the worker will stop on exactly this, and the recovery
      // agent is the one asked to repair it.
      return {
        ok: true,
        value: {
          workDir,
          taskTimeoutMinutes: harness.taskTimeoutMinutes,
          namespace,
          recovery,
          queueNamespace: null,
          config: null,
          projectProblems: [cause.message],
        },
      };
    }
    throw cause;
  }

  const queueProblem = queueConfigurationProblem(config, options.configPath, projectPath);
  if (queueProblem !== null) {
    return { ok: false, problem: queueProblem };
  }
  return {
    ok: true,
    value: {
      workDir,
      taskTimeoutMinutes: harness.taskTimeoutMinutes,
      namespace,
      recovery,
      queueNamespace: projectLockNamespace(config),
      config,
      projectProblems: [],
    },
  };
}

/**
 * One `supervise` invocation: read what supervision needs, resolve the Jira
 * boundary its report is written through, and hand the supervisor its
 * collaborators.
 */
async function superviseCommand(
  options: SuperviseCommandOptions,
  context: CliContext,
): Promise<number> {
  const { intent, scope } = options;
  const { io } = context;
  const projectPath = projectConfigFile(options.repoPath);

  let loaded: SupervisionConfigurationTake;
  try {
    loaded = await loadSupervision(options);
  } catch (cause) {
    io.err(`error: ${messageOf(cause)}`);
    return EXIT_INPUT_ERROR;
  }
  if (!loaded.ok) {
    io.err(`error: ${loaded.problem}`);
    return EXIT_INPUT_ERROR;
  }
  const supervision = loaded.value;
  const { workDir, namespace, recovery } = supervision;
  const root = supervisorRoot(workDir, namespace);
  for (const problem of supervision.projectProblems) {
    io.err(
      `warning: the connected project's configuration could not be read, so this supervision ` +
        `starts without it and the recovery agent is told to repair it: ${problem}`,
    );
  }

  const parts = entryParts(context);
  if (typeof parts === 'string') {
    io.err(`error: ${parts}`);
    return EXIT_INPUT_ERROR;
  }

  // The report's own Jira boundary: the connected project's source connection,
  // resolved before anything runs so a missing credential is a refusal rather
  // than an incident. It is absent when the project's configuration could not
  // be read at all — a report written into a thread nobody can name yet waits
  // for the recovery agent's own judgment instead.
  let jira: { http: HttpClient; token: string } | undefined;
  let jiraIdentity: { siteUrl: string; projectKey: string } | undefined;
  const sourceConfig = supervision.config?.source as JiraSourceConfig | undefined;
  if (sourceConfig !== undefined) {
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
    const composed: SupervisorParts = {
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
      interpreterArgs: substitute.interpreterArgs ?? parts.interpreterArgs,
      cwd: substitute.cwd ?? parts.cwd,
      installRoot: substitute.installRoot ?? installationRoot(parts.entry),
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
      queueNamespace: supervision.queueNamespace,
      repoPath: options.repoPath,
      configPath: options.configPath,
      projectConfigPath: projectPath,
      installRoot: composed.installRoot,
      entry: composed.entry,
      interpreter: composed.interpreter,
      interpreterArgs: composed.interpreterArgs,
      cwd: composed.cwd,
      recovery,
      recoveryTurnTimeoutMs: recoveryTimeoutMs(supervision),
      io: { out: activeIo.out, err: activeIo.err },
      stop: stop.signal,
      now: () => new Date(),
      ...(jira === undefined ? {} : { jira }),
      ...(jiraIdentity === undefined ? {} : { jiraIdentity }),
      recoveryTurn: composed.recoveryTurn,
      reporter: composed.reporter,
      worker: composed.worker,
      isAlive: composed.isAlive,
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

/**
 * The bound of one recovery turn: the configured task timeout, unchanged. The
 * harness configuration is the supervisor's own, so it is read even when the
 * connected project's file is not; a missing file was already refused above.
 */
function recoveryTimeoutMs(supervision: SupervisionConfiguration): number {
  return supervision.taskTimeoutMinutes * 60_000;
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

/** True when this module is the process entry point, not an import. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const entryUrl = pathToFileURL(entry).href;
  if (entryUrl === import.meta.url) {
    return true;
  }
  // Windows path casing can differ between argv and import.meta.url.
  return process.platform === 'win32' && entryUrl.toLowerCase() === import.meta.url.toLowerCase();
}

if (isEntryPoint()) {
  try {
    process.exitCode = await superviseCli(process.argv.slice(2), consoleContext());
  } catch (cause) {
    process.stderr.write(`error: unexpected failure: ${String(cause)}\n`);
    process.exitCode = EXIT_INPUT_ERROR;
  }
}
