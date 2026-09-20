/**
 * `review scan` and `review watch`: the Nexus Lens review commands.
 *
 * They load the configuration, resolve the two credentials the review path
 * names — the Jira service-account token and the GitHub App's private key —
 * build the read-only Jira queue and the GitHub App client, and hand ordinary
 * functions to the scan. This is the only place a review is constructed: no
 * other command reads a review credential, contacts the repository as the App,
 * or starts a reviewer turn. Everything a reviewer sees, and everything it
 * publishes, is decided by the modules below and is printed here.
 */
import path from 'node:path';
import { ConfigError, loadConfiguration, resolveWorkDir } from '../config/load.js';
import { projectConfigFile } from '../config/paths.js';
import type { ReviewScanContext, ReviewSummary } from '../reviews/contract.js';
import { ReviewError } from '../reviews/contract.js';
import { createGitHubReviewClient, resolveAppPrivateKey } from '../reviews/github.js';
import { createReviewerTurn } from '../reviews/reviewer.js';
import { scanReviews, watchReviews } from '../reviews/scan.js';
import type { SourceCandidate, SourceTask } from '../sources/contract.js';
import { SourceError } from '../sources/contract.js';
import { createJiraSource } from '../sources/jira/connector.js';
import { resolveJiraToken } from '../sources/jira/http.js';
import type { GitHubReviewConfig, JiraSourceConfig } from '../shared/types.js';
import { createActivityDisplay } from './activity.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './context.js';
import type { CliContext, CliIo } from './context.js';
import { USAGE_HINT } from './help.js';
import { listOptions, parseOptions, REVIEW_SCAN_OPTIONS, REVIEW_WATCH_OPTIONS } from './options.js';
import type { ParsedOptions } from './options.js';
import { hostSignals } from './signals.js';
import { abortableSleep } from './source-command.js';

/**
 * The environment a reviewer turn inherits, with both the Jira token and the
 * App key-path variables removed after the parent resolves them. Unrelated
 * runtime settings and `process.env` itself are preserved. Windows environment
 * names are case-insensitive, including when configuration spells them differently.
 */
function environmentWithout(environment: NodeJS.ProcessEnv, ...names: string[]): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...environment };
  const normalize = (name: string): string =>
    process.platform === 'win32' ? name.toUpperCase() : name;
  const removed = new Set(names.map(normalize));
  for (const name of Object.keys(copy)) {
    if (removed.has(normalize(name))) {
      delete copy[name];
    }
  }
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

/** A compact count of what one scan did, and anything it could not do. */
function describeReviewSummary(summary: ReviewSummary): string {
  const lines = [
    `review ${summary.outcome}`,
    `  scanned    ${String(summary.scanned)} eligible ticket(s)`,
    `  reviewed   ${String(summary.reviewed)} (approved: ${String(summary.approved)}, ` +
      `changes requested: ${String(summary.changesRequested)})`,
    `  unchanged  ${String(summary.unchanged)} already decided for their reviewed head`,
    `  attention  ${String(summary.attention)} need a coordinator; see publication details above`,
    `  skipped    ${String(summary.skipped)} no longer eligible`,
    `  reviewer   ${String(summary.reviewerRuns)} reviewer turn(s) started`,
  ];
  if (summary.problem !== null) {
    lines.push(`  problem    ${summary.problem}`);
  }
  return lines.join('\n');
}

/** How a review command's own outcome becomes an exit code. */
function exitCodeForReview(summary: ReviewSummary): number {
  if (summary.outcome === 'cancelled') {
    return EXIT_CANCELLED;
  }
  if (summary.outcome === 'stopped' || summary.attention > 0) {
    return EXIT_INPUT_ERROR;
  }
  return EXIT_OK;
}

type ReviewSubcommand = 'scan' | 'watch';

/**
 * One `review` invocation: load the configuration, resolve the Jira token and
 * the App key the configuration names, build the read-only queue and the App
 * client, and hand the scan ordinary functions.
 */
async function reviewCommand(
  subcommand: ReviewSubcommand,
  options: ParsedOptions,
  context: CliContext,
): Promise<number> {
  const { cwd, io } = context;
  const { config: configArgument, project: projectArgument, limit: limitArgument } = options;

  if (configArgument === undefined || projectArgument === undefined) {
    const missing = [
      configArgument === undefined ? '--config' : undefined,
      projectArgument === undefined ? '--project' : undefined,
    ].filter((name): name is string => name !== undefined);
    io.err(`error: review ${subcommand} requires ${listOptions(missing)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  let limit: number | undefined;
  if (limitArgument !== undefined) {
    const parsed = parseLimit(limitArgument);
    if (parsed === null) {
      io.err(
        `error: option "--limit" takes a positive integer; received "${limitArgument}"\n${USAGE_HINT}`,
      );
      return EXIT_USAGE;
    }
    limit = parsed;
  }

  // A review never opens a working copy: the connected project's root is read
  // for its configuration only, and the pull request itself is read from
  // GitHub's own record (docs/WORKFLOW.md §9).
  const configPath = path.resolve(cwd, configArgument);
  const projectPath = projectConfigFile(path.resolve(cwd, projectArgument));
  let config;
  try {
    config = (await loadConfiguration(configPath, projectPath)).config;
  } catch (cause) {
    if (cause instanceof ConfigError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const review: GitHubReviewConfig | undefined = config.review;
  if (review === undefined) {
    io.err(
      [
        `error: the configuration composed from ${configPath} and ${projectPath} has no review ` +
          'path, so there is nothing to review.',
        'A review command needs the harness configuration\'s "reviewer" object, and the ' +
          'project\'s "source" and "delivery"; docs/WORKFLOW.md section 9 defines them.',
      ].join('\n'),
    );
    return EXIT_INPUT_ERROR;
  }
  const source: JiraSourceConfig | undefined = config.source;
  if (source === undefined) {
    // The loader composes a review only with a source; this is the same refusal
    // said where a person reads it, should that ever change.
    io.err(
      `error: the configuration composed from ${configPath} and ${projectPath} gives the ` +
        'reviewer no "source": a review scans the Jira tickets that connection reports as being ' +
        'in review.',
    );
    return EXIT_INPUT_ERROR;
  }

  try {
    const token = resolveJiraToken(source, process.env);
    const privateKey = await resolveAppPrivateKey(review, process.env);
    const childEnvironment = environmentWithout(
      process.env,
      source.tokenEnv,
      review.app.privateKeyPathEnv,
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      ...(config.delivery?.completion === undefined
        ? []
        : [config.delivery.completion.reviewerTokenEnv]),
    );

    // The review queue is the existing Jira connector read-only, with its
    // eligibility status set to the status a review scans: nothing else about
    // the connection changes, and no claim, transition, or comment is made.
    const jira = createJiraSource(
      { ...source, readyStatus: source.reviewStatus },
      token,
      context.fetch === undefined ? {} : { fetch: context.fetch },
    );
    const repository = createGitHubReviewClient(review, privateKey, {
      ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      now: () => new Date(),
    });

    // One display for the whole invocation: every review writes its progress
    // and its reviewer activity through it, so the pane outlives one turn.
    const pane = createActivityDisplay(io);
    const activeIo: CliIo = {
      out: (text) => {
        pane.line(text);
      },
      err: (text) => {
        pane.error(text);
      },
    };
    const reviewer = createReviewerTurn({
      selection: review.reviewer,
      environment: childEnvironment,
      onActivity: (activity) => {
        pane.activity(activity);
      },
      onTurnStart: (ticket) => {
        pane.beginInvocation({ role: 'reviewer', ticket, phase: 'review' });
      },
      onTurnEnd: () => {
        pane.endInvocation();
      },
    });

    const stop = new AbortController();
    const release = (context.signals ?? hostSignals()).onInterrupt(() => {
      if (stop.signal.aborted) {
        activeIo.err(
          'interrupt received again: the review is already stopping, and this CLI is still ' +
            'waiting for it to finish.',
        );
        return;
      }
      activeIo.err(
        [
          'interrupt received: asking the review to stop, and waiting for the reviewer turn and the',
          'scan to finish before this command exits. Evidence is kept; nothing new is published.',
        ].join('\n'),
      );
      stop.abort(new Error('the user interrupted the review scan'));
    });

    try {
      const scan: ReviewScanContext = {
        queue: {
          list: (signal) => jira.listEligible(signal),
          prepare: (candidate: SourceCandidate, signal): Promise<SourceTask | null> =>
            jira.prepare(candidate, signal),
        },
        repository,
        reviewer,
        workDir: resolveWorkDir(config, configPath),
        login: review.app.login,
        checkName: review.checkName,
        // The reviewer launch is bounded by the same task timeout a run gets;
        // it is one turn, never a repair loop.
        reviewerTimeoutMs: config.taskTimeoutMinutes * 60_000,
        io: activeIo,
        stop: stop.signal,
        now: () => new Date(),
        sleep: abortableSleep,
      };
      const summary =
        subcommand === 'scan'
          ? await scanReviews(scan, limit)
          : await watchReviews({ ...scan, pollIntervalMs: source.pollIntervalSeconds * 1000 });

      pane.close();
      activeIo.out(describeReviewSummary(summary));
      return exitCodeForReview(summary);
    } finally {
      release();
      pane.close();
    }
  } catch (cause) {
    if (cause instanceof ReviewError || cause instanceof SourceError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }
}

/** `review scan` and `review watch`: the review subcommands. */
export async function reviewCli(args: readonly string[], context: CliContext): Promise<number> {
  const { io } = context;
  const [subcommand, ...rest] = args;

  if (subcommand === undefined) {
    io.err(`error: review requires one of: scan, watch\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand.startsWith('-')) {
    io.err(`error: unknown option "${subcommand}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand !== 'scan' && subcommand !== 'watch') {
    io.err(
      `error: unknown review command "${subcommand}"; expected "scan" or "watch"\n${USAGE_HINT}`,
    );
    return EXIT_USAGE;
  }

  const parsed = parseOptions(
    rest,
    subcommand === 'scan' ? REVIEW_SCAN_OPTIONS : REVIEW_WATCH_OPTIONS,
  );
  if (!parsed.ok) {
    io.err(`error: ${parsed.message}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  return reviewCommand(subcommand, parsed.options, context);
}
