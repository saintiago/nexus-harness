/**
 * `source list`, `source run` and `source watch`: the intake commands.
 *
 * They load the configuration, resolve the credential the configuration names
 * (and nothing else), build the one connector the `source` type selects, and
 * hand ordinary functions to the coordinator. This is the only place in the
 * harness that constructs a source, so no other command reads a Jira credential,
 * contacts Jira, or creates intake state. The wait watch uses is here too: an
 * abortable sleep, so an interrupt never waits for a poll interval to elapse.
 */
import path from 'node:path';
import { ConfigError, escalationTiers, loadHarnessConfig, resolveWorkDir } from '../config/load.js';
import { createGitHubDelivery } from '../delivery/github.js';
import { runTask } from '../runs/runner.js';
import type { HarnessConfig, JiraSourceConfig } from '../shared/types.js';
import { SourceError } from '../sources/contract.js';
import type { SourceContext, SourceSummary } from '../sources/contract.js';
import { runSource, watchSource } from '../sources/coordinator.js';
import type { SourceWatchOptions } from '../sources/coordinator.js';
import { createJiraSource } from '../sources/jira/connector.js';
import { resolveJiraToken } from '../sources/jira/http.js';
import { listSource } from '../sources/list.js';
import type { SourceListEntry } from '../sources/list.js';
import { WorkspaceError } from '../workspace/errors.js';
import { preflightSource } from '../workspace/preflight.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './context.js';
import type { CliContext } from './context.js';
import { composeDependencies } from './dependencies.js';
import { USAGE_HINT } from './help.js';
import {
  listOptions,
  parseOptions,
  SOURCE_LIST_OPTIONS,
  SOURCE_RUN_OPTIONS,
  SOURCE_WATCH_OPTIONS,
} from './options.js';
import type { ParsedOptions } from './options.js';
import { hostSignals } from './signals.js';

export function abortableSleep(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (stop.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      stop.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    stop.addEventListener('abort', finish, { once: true });
  });
}

/**
 * The environment a source run's child processes inherit: the same one, with the
 * variable that holds the Jira credential removed. The token is never handed to
 * project code or to the coding runtime, and `process.env` itself is not
 * modified (docs/architecture.md §9).
 */
function environmentWithout(environment: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...environment };
  delete copy[name];
  return copy;
}

/** A `--limit` value: a positive integer, or nothing this command accepts. */
function parseLimit(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const limit = Number(value);
  return Number.isSafeInteger(limit) ? limit : null;
}

/** How a source command's own failure is reported, and with which exit code. */
function exitCodeForSource(summary: SourceSummary): number {
  if (summary.outcome === 'cancelled') {
    return EXIT_CANCELLED;
  }
  if (summary.outcome === 'stopped') {
    return EXIT_INPUT_ERROR;
  }
  return summary.failed > 0 || summary.cancelled > 0 || summary.invalid > 0
    ? EXIT_INPUT_ERROR
    : EXIT_OK;
}

/** A compact count of what one source batch did, and anything it could not. */
function describeSourceSummary(summary: SourceSummary): string {
  const lines = [
    `source ${summary.outcome}`,
    `  attempts   ${String(summary.attempted)} reserved: ${String(summary.passed)} passed, ` +
      `${String(summary.failed)} failed, ${String(summary.cancelled)} cancelled`,
    `  skipped    ${String(summary.skipped)} already attempted or no longer eligible, ` +
      `${String(summary.invalid)} invalid task description(s), ` +
      `${String(summary.refused)} refused and told why`,
  ];
  if (summary.problem !== null) {
    lines.push(`  problem    ${summary.problem}`);
  }
  if (!summary.cleanupConfirmed) {
    lines.push('  cleanup    not confirmed: the intake lock was left for manual inspection');
  }
  return lines.join('\n');
}

type SourceSubcommand = 'list' | 'run' | 'watch';

/**
 * One `source` invocation: load the configuration, resolve the credential the
 * configuration names (and nothing else), build the one connector the `source`
 * type selects, and hand ordinary functions to the coordinator.
 *
 * This is the only place in the harness that constructs a source, so no other
 * command reads a Jira credential, contacts Jira, or creates intake state
 * (docs/architecture.md §7).
 */
async function sourceCommand(
  subcommand: SourceSubcommand,
  options: ParsedOptions,
  context: CliContext,
): Promise<number> {
  const { cwd, io } = context;
  const { config: configArgument, repo: repoArgument, limit: limitArgument } = options;

  const missing = [
    configArgument === undefined ? '--config' : undefined,
    subcommand !== 'list' && repoArgument === undefined ? '--repo' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    io.err(`error: source ${subcommand} requires ${listOptions(missing)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  let limit: number | null = null;
  if (limitArgument !== undefined) {
    limit = parseLimit(limitArgument);
    if (limit === null) {
      io.err(
        `error: option "--limit" takes a positive integer; received "${limitArgument}"\n${USAGE_HINT}`,
      );
      return EXIT_USAGE;
    }
  }

  const configPath = path.resolve(cwd, configArgument ?? '');
  let config: HarnessConfig;
  try {
    config = await loadHarnessConfig(configPath);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const sourceConfig: JiraSourceConfig | undefined = config.source;
  if (sourceConfig === undefined) {
    io.err(
      [
        `error: ${configPath} has no "source" object, so there is nothing to take tasks from.`,
        'A source command needs one; docs/WORKFLOW.md section 5 defines it.',
      ].join('\n'),
    );
    return EXIT_INPUT_ERROR;
  }

  // The credential is resolved here, for a source command only, from the one
  // environment variable the configuration names. It is never a configuration
  // value, never a task field, and never printed: the message a missing token
  // produces names the variable and not a value.
  let token: string;
  try {
    token = resolveJiraToken(sourceConfig, process.env);
  } catch (cause) {
    if (cause instanceof SourceError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const workDir = resolveWorkDir(config, configPath);
  const connector = createJiraSource(
    sourceConfig,
    token,
    context.fetch === undefined ? {} : { fetch: context.fetch },
  );

  const stop = new AbortController();
  const release = (context.signals ?? hostSignals()).onInterrupt(() => {
    if (stop.signal.aborted) {
      io.err(
        'interrupt received again: intake is already stopping, and this CLI is still waiting for it to finish.',
      );
      return;
    }
    io.err(
      [
        'interrupt received: asking intake to stop, and waiting for the active run to finalize before',
        'this command exits. Artifacts and receipts are kept; nothing new is claimed.',
      ].join('\n'),
    );
    stop.abort(new Error('the user interrupted intake'));
  });

  try {
    if (subcommand === 'list') {
      let entries: readonly SourceListEntry[];
      try {
        entries = await listSource({ source: connector, workDir, stop: stop.signal });
      } catch (cause) {
        io.err(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
        return stop.signal.aborted ? EXIT_CANCELLED : EXIT_INPUT_ERROR;
      }
      for (const entry of entries) {
        io.out(`${entry.disposition.padEnd(9)} ${entry.ref.key}  ${entry.title}`);
        io.out(`          ${entry.ref.url}`);
        io.out(`          ${entry.detail}`);
      }
      io.out(
        `source list: ${String(entries.length)} eligible issue(s); nothing was claimed, no run was ` +
          'started, and no directory was created',
      );
      return EXIT_OK;
    }

    // A source run's commands and coding runtime inherit everything except the
    // Jira credential variable, and the same effective agent selection a
    // file-task run would use.
    const repoPath = path.resolve(cwd, repoArgument ?? '');
    const childEnvironment = environmentWithout(process.env, sourceConfig.tokenEnv);
    // Delivery is built only when the configuration asks for it, and its
    // commands inherit the same environment a coding turn does: everything
    // except the Jira credential variable (docs/WORKFLOW.md §8).
    const deliveryParts = context.deliveryParts ?? {};
    const delivery =
      config.delivery === undefined
        ? undefined
        : createGitHubDelivery(config.delivery, {
            ...deliveryParts,
            env: deliveryParts.env ?? childEnvironment,
          });
    const dependencies = composeDependencies(
      context,
      io,
      () => undefined,
      config.agent,
      childEnvironment,
    );

    const intake: SourceContext = {
      source: connector,
      workDir,
      // The ladder the coordinator climbs: what the configuration declares, or
      // the single ordinary rung built from `agent` and `maxRepairs`.
      tiers: escalationTiers(config),
      repoPath,
      io,
      stop: stop.signal,
      preflight: preflightSource,
      ...(delivery === undefined ? {} : { delivery }),
      run: ({
        task,
        sourceRef,
        stop: runStop,
        tier,
        continuedWorkspace,
        onWorkspaceReady,
        guidance,
      }) =>
        runTask(
          {
            task,
            // A rung runs the launch and the repair allowance it names; the rest
            // of the configuration is the run's own.
            config:
              tier === undefined
                ? config
                : { ...config, agent: tier.agent, maxRepairs: tier.maxRepairs },
            repoPath,
            workDir,
            stop: runStop,
            sourceRef,
            ...(tier === undefined ? {} : { tierName: tier.name }),
            ...(guidance === undefined ? {} : { guidance }),
            ...(continuedWorkspace === undefined ? {} : { continuedWorkspace }),
            ...(onWorkspaceReady === undefined ? {} : { onWorkspaceReady }),
          },
          dependencies,
        ),
      now: () => new Date(),
      sleep: abortableSleep,
    };

    const summary =
      subcommand === 'run'
        ? await runSource(intake, limit)
        : await watchSource({
            ...intake,
            pollIntervalMs: sourceConfig.pollIntervalSeconds * 1000,
          } satisfies SourceWatchOptions);

    io.out(describeSourceSummary(summary));
    return exitCodeForSource(summary);
  } catch (cause) {
    if (cause instanceof SourceError || cause instanceof WorkspaceError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  } finally {
    release();
  }
}

/** `source list`, `source run` and `source watch`: the intake subcommands. */
export async function sourceCli(args: readonly string[], context: CliContext): Promise<number> {
  const { io } = context;
  const [subcommand, ...rest] = args;

  if (subcommand === undefined) {
    io.err(`error: source requires one of: list, run, watch\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand.startsWith('-')) {
    io.err(`error: unknown option "${subcommand}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand !== 'list' && subcommand !== 'run' && subcommand !== 'watch') {
    io.err(
      `error: unknown source command "${subcommand}"; expected "list", "run", or "watch"\n${USAGE_HINT}`,
    );
    return EXIT_USAGE;
  }

  const allowed =
    subcommand === 'list'
      ? SOURCE_LIST_OPTIONS
      : subcommand === 'run'
        ? SOURCE_RUN_OPTIONS
        : SOURCE_WATCH_OPTIONS;
  const parsed = parseOptions(rest, allowed);
  if (!parsed.ok) {
    io.err(`error: ${parsed.message}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  return sourceCommand(subcommand, parsed.options, context);
}
