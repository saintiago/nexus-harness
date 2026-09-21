/**
 * `queue run` and `queue watch`: the serial queue commands.
 *
 * They are the one place the serial loop's four phases are composed, and the
 * only place a queue invocation resolves the credentials those phases need:
 *
 * - the existing Jira source and retained-workspace runner, taken one ticket at
 *   a time, with the configured delivery step;
 * - the completion pass's arm step, taken for the delivered head before the
 *   review can publish the final required check;
 * - the existing Nexus Lens review scan, narrowed to that one ticket;
 * - the existing review-to-completion pass, narrowed to that one ticket;
 * - the source-readiness step that fetches the base branch and only ever
 *   fast-forwards the operator's checkout to the verified merge commit.
 *
 * The loop itself decides only the order, and it is a foreground control loop:
 * `queue watch` is this process, not a daemon. One intake lock is held for the
 * whole invocation, so a second consumer cannot start between two tickets, and
 * every command's own option table keeps the one-item commands exactly as they
 * were (docs/WORKFLOW.md §11).
 */
import path from 'node:path';
import {
  ConfigError,
  escalationTiers,
  loadConfiguration,
  projectLockNamespace,
  resolveWorkDir,
} from '../config/load.js';
import { projectConfigFile } from '../config/paths.js';
import { createGitHubCompletion } from '../delivery/completion.js';
import { createGitHubDelivery } from '../delivery/github.js';
import type {
  QueueArmOutcome,
  QueueCompletionOutcome,
  QueueReviewOutcome,
  QueueSummary,
} from '../queue/loop.js';
import { runQueue } from '../queue/loop.js';
import type { QueueRunMode } from '../queue/loop.js';
import { runTask } from '../runs/runner.js';
import { messageOf } from '../shared/errors.js';
import type { HarnessConfig, JiraSourceConfig } from '../shared/types.js';
import { createCompletionPass } from '../sources/completion.js';
import type { ArmOutcome, CompletionOutcome } from '../sources/completion.js';
import type { SourceContext, SourceTake } from '../sources/contract.js';
import { SourceError } from '../sources/contract.js';
import { createBaselineDiagnosis } from '../sources/baseline.js';
import { takeOneItem } from '../sources/coordinator.js';
import { createJiraBaselineRecord } from '../sources/jira/baseline.js';
import { discoverQueueWork } from '../sources/jira/queue.js';
import { createJiraCompletionSource, readReviewItem } from '../sources/jira/completion.js';
import { createJiraSource } from '../sources/jira/connector.js';
import { createHttpClient, resolveJiraToken } from '../sources/jira/http.js';
import { acquireIntakeLock } from '../sources/receipts.js';
import type { ReviewScanContext, ReviewSummary } from '../reviews/contract.js';
import { ReviewError } from '../reviews/contract.js';
import { createBaselineReviewer } from '../reviews/baseline.js';
import { createGitHubReviewClient, resolveAppPrivateKey } from '../reviews/github.js';
import { createReviewerTurn } from '../reviews/reviewer.js';
import { scanReviews } from '../reviews/scan.js';
import { reviewViews } from '../reviews/view.js';
import { WorkspaceError } from '../workspace/errors.js';
import { preflightSource } from '../workspace/preflight.js';
import { refreshSource } from '../workspace/refresh.js';
import { createActivityDisplay } from './activity.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './context.js';
import type { CliContext, CliIo } from './context.js';
import { composeDependencies } from './dependencies.js';
import { USAGE_HINT } from './help.js';
import { listOptions, parseOptions, QUEUE_RUN_OPTIONS, QUEUE_WATCH_OPTIONS } from './options.js';
import { hostSignals } from './signals.js';
import { abortableSleep } from './source-command.js';

/**
 * The environment a command inherits, with the variables the harness resolved
 * removed. Windows environment names are case-insensitive, including when the
 * configuration spells them differently; `process.env` itself is never modified.
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

/** What one queue command is asked for, and everything it needs to answer. */
interface QueueCommandOptions {
  readonly mode: QueueRunMode;
  readonly configPath: string;
  readonly repoPath: string;
}

/**
 * Everything the configured queue needs, or the reason it cannot be one.
 *
 * A queue completes a ticket through a chain of three configured pieces, so a
 * configuration that cannot complete one is refused before any credential is
 * resolved. The loader already refuses a completion policy whose App, login,
 * or check disagrees with the configured reviewer; what is left for the queue
 * itself is that all three objects are there, because other commands treat
 * them as optional.
 */
function queueConfigurationProblem(
  config: HarnessConfig,
  harnessPath: string,
  projectPath: string,
): string | null {
  if (config.source === undefined) {
    return (
      `${projectPath} has no "source" object, so there is no queue to take tickets from ` +
      '(docs/WORKFLOW.md section 5).'
    );
  }
  if (config.delivery === undefined) {
    return (
      `${projectPath} has no "delivery" object, so a passed attempt would stay local and no pull ` +
      'request could be completed. A queue command needs one; docs/WORKFLOW.md section 8 defines it.'
    );
  }
  if (config.review === undefined) {
    return (
      `${harnessPath} has no "reviewer" object, so a ticket could never be reviewed before it is ` +
      'completed. A queue command needs the Nexus-wide reviewer integration; docs/WORKFLOW.md ' +
      'section 9 defines it.'
    );
  }
  const delivery = config.delivery;
  const completion = delivery.completion;
  if (completion === undefined) {
    return (
      `${projectPath} configures "delivery" without "delivery.completion", so nothing would ever ` +
      'mark a ticket Done. A queue command needs that object; docs/WORKFLOW.md section 10 defines ' +
      'it.'
    );
  }
  return null;
}

/** One review scan's summary, as the loop reads it. */
function reviewPhase(summary: ReviewSummary): QueueReviewOutcome {
  if (summary.outcome === 'cancelled') {
    return { state: 'cancelled', detail: 'the review was stopped' };
  }
  if (summary.problem !== null) {
    return { state: 'attention', detail: summary.problem };
  }
  const [item] = summary.items;
  if (item === undefined) {
    return {
      state: 'attention',
      detail:
        'the ticket is not in the configured review status, so the queue cannot review what it ' +
        'just delivered',
    };
  }
  if (item.disposition === 'attention') {
    return { state: 'attention', detail: item.detail };
  }
  if (item.disposition === 'skipped') {
    return {
      state: 'attention',
      detail: `it left the review status before it could be reviewed (${item.detail})`,
    };
  }
  if (item.disposition === 'unchanged') {
    return {
      state: 'clear',
      detail: `its current head already carries the reviewer's completed verdict (${item.detail})`,
    };
  }
  return {
    state: 'clear',
    detail:
      item.decision === 'approve'
        ? `Nexus Lens approved it (${item.detail})`
        : `Nexus Lens requested changes (${item.detail}); the completion path reads that verdict`,
  };
}

/** One completion pass's outcome for the one ticket it was narrowed to. */
function completionPhase(outcomes: readonly CompletionOutcome[]): QueueCompletionOutcome {
  const [outcome] = outcomes;
  if (outcome === undefined) {
    return {
      state: 'attention',
      detail:
        'the ticket is not in the configured review status, so the completion path had nothing to ' +
        'read',
    };
  }
  switch (outcome.status) {
    case 'done':
      return {
        state: 'done',
        detail: outcome.detail,
        mergeCommit: outcome.mergeCommit ?? null,
      };
    case 'to-do':
      return { state: 'to-do', detail: outcome.detail };
    case 'pending':
      return { state: 'pending', detail: outcome.detail };
    case 'attention':
      return { state: 'attention', detail: outcome.detail };
    default:
      // `observed`: nothing was concluded, and nothing was written. A queue
      // cannot carry a ticket from that position, so a person looks at it.
      return { state: 'attention', detail: outcome.detail };
  }
}

/** One arm pass's outcome for the one ticket it was narrowed to. */
function armPhase(outcomes: readonly ArmOutcome[]): QueueArmOutcome {
  const [outcome] = outcomes;
  if (outcome === undefined) {
    return {
      state: 'attention',
      detail:
        'the ticket is not in the configured review status, so native auto-merge had nothing to arm',
    };
  }
  switch (outcome.status) {
    case 'armed':
      return { state: 'armed', detail: outcome.detail };
    case 'attention':
      return { state: 'attention', detail: outcome.detail };
    default:
      return { state: 'observed', detail: outcome.detail };
  }
}

/** A compact account of one queue invocation, and anything it could not do. */
function describeQueueSummary(summary: QueueSummary, mode: QueueRunMode): string {
  const lines = [
    `queue ${mode}: ${summary.outcome}`,
    `  completed  ${String(summary.completed)} ticket(s) reached the configured Done status`,
    `  attempts   ${String(summary.attempts)} coding attempt(s) started`,
  ];
  if (summary.ticket !== null) {
    lines.push(`  ticket     ${summary.ticket.ref.key} ${summary.ticket.ref.url}`);
  }
  if (summary.problem !== null) {
    lines.push(`  problem    ${summary.problem}`);
  }
  if (!summary.cleanupConfirmed) {
    lines.push(
      '  cleanup    not confirmed: something this invocation started may still be running, so the ' +
        'intake lock is left for inspection',
    );
  }
  return lines.join('\n');
}

/** How a queue invocation's own outcome becomes an exit code. */
function exitCodeForQueue(summary: QueueSummary): number {
  if (summary.outcome === 'cancelled') {
    return EXIT_CANCELLED;
  }
  return summary.outcome === 'stopped' ? EXIT_INPUT_ERROR : EXIT_OK;
}

/**
 * One `queue` invocation: load the configuration, refuse one that cannot
 * complete a ticket, resolve the credentials its phases need, hold the intake
 * lock for the whole run, and hand the serial loop its four ordinary phases.
 */
async function queueCommand(options: QueueCommandOptions, context: CliContext): Promise<number> {
  const { mode, configPath, repoPath } = options;
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

  const problem = queueConfigurationProblem(config, configPath, projectPath);
  if (problem !== null) {
    io.err(`error: ${problem}`);
    return EXIT_INPUT_ERROR;
  }
  // The three objects the check above proved present.
  const sourceConfig = config.source as JiraSourceConfig;
  const reviewConfig = config.review;
  const deliveryConfig = config.delivery;
  const completionConfig = deliveryConfig?.completion;
  if (
    reviewConfig === undefined ||
    deliveryConfig === undefined ||
    completionConfig === undefined
  ) {
    throw new Error('unreachable: the queue configuration was checked above');
  }

  const workDir = resolveWorkDir(config, configPath);
  // The queue's exclusivity is the connected project's, not the storage
  // root's: the same composed identity names the lock every phase of this
  // invocation holds, so two different projects sharing this `workDir` do not
  // exclude one another (docs/spec.md §6, docs/WORKFLOW.md §11).
  const lockNamespace = projectLockNamespace(config);
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

  // Fatal errors caught after timeline cleanup still carry its emission stamp.
  let errorIo = io;
  try {
    // The Jira credential and App key are resolved here; the App client renews
    // installation tokens for completion evidence reads as needed.
    // Each child gets neither the Jira token nor the App key path, and the
    // reviewer's own token never reaches the coding runtime, the checks, or the
    // operator's own `git`/`gh` commands (docs/architecture.md §9).
    const privateKey = await resolveAppPrivateKey(reviewConfig, process.env);
    const operatorEnvironment = environmentWithout(
      process.env,
      sourceConfig.tokenEnv,
      reviewConfig.app.privateKeyPathEnv,
    );
    const childEnvironment = environmentWithout(
      operatorEnvironment,
      completionConfig.reviewerTokenEnv,
    );
    const reviewerEnvironment = environmentWithout(
      process.env,
      sourceConfig.tokenEnv,
      reviewConfig.app.privateKeyPathEnv,
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      completionConfig.reviewerTokenEnv,
    );

    const jiraParts = context.fetch === undefined ? {} : { fetch: context.fetch };
    const jiraHttp = createHttpClient(sourceConfig, token, jiraParts);
    const connector = createJiraSource(sourceConfig, token, jiraParts, jiraHttp);
    // The review queue is the same connection with its eligibility status set
    // to the review status: it claims nothing, transitions nothing, and posts
    // no comment.
    const reviewQueue = createJiraSource(
      { ...sourceConfig, readyStatus: sourceConfig.reviewStatus },
      token,
      jiraParts,
    );
    const repository = createGitHubReviewClient(reviewConfig, privateKey, {
      ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      now: () => new Date(),
    });
    const deliveryParts = context.deliveryParts ?? {};
    const delivery = createGitHubDelivery(deliveryConfig, {
      ...deliveryParts,
      env: deliveryParts.env ?? childEnvironment,
    });
    const completionParts = context.completionParts ?? {};
    const completionActions = createGitHubCompletion(
      completionConfig,
      repository.installationToken,
      {
        ...completionParts,
        env: completionParts.env ?? childEnvironment,
      },
    );

    // One display for the whole invocation: every attempt of every ticket
    // writes its progress through it, so the pane outlives the runs it shows.
    const pane = createActivityDisplay(io);
    const activeIo: CliIo = {
      out: (text) => {
        pane.line(text);
      },
      err: (text) => {
        pane.error(text);
      },
    };
    errorIo = activeIo;
    const sourceIo = { out: activeIo.out, err: activeIo.err };

    const stop = new AbortController();
    const release = (context.signals ?? hostSignals()).onInterrupt(() => {
      if (stop.signal.aborted) {
        activeIo.err(
          'interrupt received again: the queue is already stopping, and this CLI is still ' +
            'waiting for the active phase to finish before it exits.',
        );
        return;
      }
      activeIo.err(
        [
          'interrupt received: asking the queue to stop, and waiting for the active phase and its',
          'cleanup before this command exits. Artifacts, receipts, and workspaces are kept, and no',
          'next ticket is started.',
        ].join('\n'),
      );
      stop.abort(new Error('the user interrupted the queue'));
    });

    try {
      // The source/output preflight comes first, exactly as it does for a finite
      // batch: a refused checkout must not leave an intake lock behind. The
      // whole invocation then holds one intake lock, so a second consumer cannot
      // take work while this queue is between tickets or waiting in watch mode.
      let sourceRoot: string;
      try {
        ({ sourceRoot } = await preflightSource({
          repoPath,
          workDir,
          bounds: { stop: stop.signal },
        }));
      } catch (cause) {
        if (cause instanceof WorkspaceError) {
          activeIo.err(cause.message);
          return EXIT_INPUT_ERROR;
        }
        throw cause;
      }
      const lock = await acquireQueueLock(workDir, lockNamespace, activeIo);
      if (lock === null) {
        return EXIT_INPUT_ERROR;
      }

      // Whether everything this invocation started was confirmed stopped. A
      // stop that could not be confirmed leaves the lock for inspection rather
      // than releasing it: something may still be writing to a working copy
      // (docs/spec.md §6).
      let cleanupConfirmed = true;
      try {
        // The pre-delivery baseline diagnosis: one reviewer turn over the
        // snapshot a red baseline ran against, recorded in Jira only. The queue
        // carries the ticket it returns for repair through the same runner and
        // ladder as any other repair (docs/WORKFLOW.md §11).
        const baselineDiagnosis = createBaselineDiagnosis({
          reviewer: createBaselineReviewer({
            selection: reviewConfig.reviewer,
            environment: reviewerEnvironment,
            onActivity: (activity) => {
              pane.activity(activity);
            },
            onTurnStart: (ticket) => {
              pane.beginInvocation({ role: 'reviewer', ticket, phase: 'baseline diagnosis' });
            },
            onTurnEnd: () => {
              pane.endInvocation();
            },
          }),
          record: createJiraBaselineRecord(sourceConfig, jiraHttp),
          readyStatus: sourceConfig.readyStatus,
          reviewStatus: sourceConfig.reviewStatus,
          reviewerTimeoutMs: config.taskTimeoutMinutes * 60_000,
          workDir,
          io: sourceIo,
        });

        const intake: SourceContext = {
          source: connector,
          workDir,
          lockNamespace,
          tiers: escalationTiers(config),
          repoPath,
          io: sourceIo,
          stop: stop.signal,
          preflight: preflightSource,
          delivery,
          baselineDiagnosis,
          run: ({
            task,
            sourceRef,
            stop: runStop,
            tier,
            continuedWorkspace,
            preferredWorkspaceId,
            onWorkspaceReady,
            guidance,
          }) => {
            const agent = tier?.agent ?? config.agent;
            const dependencies = composeDependencies(
              context,
              activeIo,
              () => undefined,
              agent,
              childEnvironment,
              pane,
            );
            return runTask(
              {
                task,
                config:
                  tier === undefined ? config : { ...config, agent, maxRepairs: tier.maxRepairs },
                repoPath,
                workDir,
                stop: runStop,
                sourceRef,
                ...(tier === undefined ? {} : { tierName: tier.name }),
                ...(guidance === undefined ? {} : { guidance }),
                ...(continuedWorkspace === undefined ? {} : { continuedWorkspace }),
                // A first attempt of a fresh claim creates the workspace, so the
                // name the item's source prefers for it — a Jira ticket key —
                // travels with the request, exactly as `source run` hands it
                // over. A continuation is not told one: its workspace is the
                // one its pointer names
                // (docs/implement-workspace-continuation.md).
                ...(preferredWorkspaceId === undefined ? {} : { preferredWorkspaceId }),
                ...(onWorkspaceReady === undefined ? {} : { onWorkspaceReady }),
              },
              dependencies,
            );
          },
          now: () => new Date(),
          sleep: abortableSleep,
        };

        const reviewerTurn = createReviewerTurn({
          selection: reviewConfig.reviewer,
          environment: reviewerEnvironment,
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

        const summary = await runQueue(
          {
            io: sourceIo,
            stop: stop.signal,
            sleep: abortableSleep,
            pollIntervalMs: sourceConfig.pollIntervalSeconds * 1000,
            completionPollIntervalMs: completionConfig.pollIntervalSeconds * 1000,
            discover: async () => {
              // A previous invocation can stop after a red baseline was diagnosed
              // and before its finding was recorded on the ticket. That item is
              // still in the running status, where a fresh scan never looks and
              // where the queue's own recovery refuses to guess: finishing the
              // diagnosis here is what returns it to its ready status, so the
              // ordinary repair claim continues the same retained workspace
              // (docs/WORKFLOW.md §11).
              const resumed = await baselineDiagnosis.resume(stop.signal);
              if (resumed !== null) {
                if (resumed.kind === 'problem' || resumed.kind === 'attention') {
                  throw new SourceError('fatal', resumed.detail);
                }
                if (resumed.kind === 'repair') {
                  sourceIo.out(resumed.detail);
                }
                // `cancelled` wrote nothing: the loop checks the stop request
                // before it consumes anything.
              }
              return await discoverQueueWork(sourceConfig, jiraHttp, stop.signal);
            },
            consume: async ({ only }): Promise<SourceTake> => {
              try {
                return await takeOneItem(intake, {
                  lockHeld: true,
                  ...(only === null ? {} : { only }),
                });
              } catch (cause) {
                if (cause instanceof SourceError || cause instanceof WorkspaceError) {
                  return {
                    outcome: 'attention',
                    ticket: only,
                    run: null,
                    skipped: 0,
                    problem: cause.message,
                    cleanupConfirmed: true,
                  };
                }
                throw cause;
              }
            },
            arm: async ({ ticket }): Promise<QueueArmOutcome> => {
              const pass = createCompletionPass({
                config: completionConfig,
                repository: deliveryConfig.repository,
                baseBranch: deliveryConfig.baseBranch,
                source: createJiraCompletionSource(sourceConfig, jiraHttp),
                actions: completionActions,
                workDir,
                io: sourceIo,
                now: () => new Date(),
                sleep: abortableSleep,
                only: ticket.ref,
              });
              try {
                return armPhase(await pass.arm(stop.signal));
              } catch (cause) {
                if (stop.signal.aborted) {
                  return { state: 'cancelled', detail: 'the auto-merge request was stopped' };
                }
                if (cause instanceof SourceError || cause instanceof ReviewError) {
                  return { state: 'attention', detail: cause.message };
                }
                throw cause;
              }
            },
            review: async ({ ticket }): Promise<QueueReviewOutcome> => {
              const scan: ReviewScanContext = {
                queue: {
                  list: (signal) => reviewQueue.listEligible(signal),
                  prepare: (candidate, signal) => reviewQueue.prepare(candidate, signal),
                },
                repository,
                reviewer: reviewerTurn,
                views: reviewViews(),
                workDir,
                sourceRoot,
                login: reviewConfig.app.login,
                checkName: reviewConfig.checkName,
                reviewerTimeoutMs: config.taskTimeoutMinutes * 60_000,
                io: sourceIo,
                stop: stop.signal,
                now: () => new Date(),
                sleep: abortableSleep,
                only: ticket.ref,
              };
              try {
                // A restarted invocation may find a PR already merged. The
                // completion pass alone can verify its admission, merge and CI.
                const item = await readReviewItem(sourceConfig, jiraHttp, ticket, stop.signal);
                if (
                  item?.pointers.length === 1 &&
                  (await repository.findOpenPullRequest(
                    `harness/${item.pointers[0] ?? ''}`,
                    stop.signal,
                  )) === null
                ) {
                  return {
                    state: 'clear',
                    detail: 'no open PR; completion must verify the previously admitted merge',
                  };
                }
                return reviewPhase(await scanReviews(scan, 1));
              } catch (cause) {
                if (stop.signal.aborted) {
                  return { state: 'cancelled', detail: 'the review was stopped' };
                }
                if (cause instanceof ReviewError || cause instanceof SourceError) {
                  return { state: 'attention', detail: cause.message };
                }
                throw cause;
              }
            },
            complete: async ({ ticket }): Promise<QueueCompletionOutcome> => {
              const pass = createCompletionPass({
                config: completionConfig,
                repository: deliveryConfig.repository,
                baseBranch: deliveryConfig.baseBranch,
                source: createJiraCompletionSource(sourceConfig, jiraHttp),
                actions: completionActions,
                workDir,
                io: sourceIo,
                now: () => new Date(),
                sleep: abortableSleep,
                only: ticket.ref,
              });
              try {
                return completionPhase(await pass.run(stop.signal));
              } catch (cause) {
                if (stop.signal.aborted) {
                  return { state: 'cancelled', detail: 'the completion reading was stopped' };
                }
                if (cause instanceof SourceError || cause instanceof ReviewError) {
                  return { state: 'attention', detail: cause.message };
                }
                throw cause;
              }
            },
            ready: async ({ mergeCommit }) => {
              await refreshSource(
                {
                  repoPath,
                  baseBranch: deliveryConfig.baseBranch,
                  repository: deliveryConfig.repository,
                  mergedCommit: mergeCommit,
                  bounds: { stop: stop.signal },
                },
                context.refreshParts ?? {},
              );
            },
          },
          mode,
        );

        cleanupConfirmed = summary.cleanupConfirmed;
        pane.close();
        activeIo.out(describeQueueSummary(summary, mode));
        return exitCodeForQueue(summary);
      } finally {
        await releaseQueueLock(lock, activeIo, cleanupConfirmed);
      }
    } finally {
      release();
      pane.close();
    }
  } catch (cause) {
    if (cause instanceof SourceError || cause instanceof WorkspaceError) {
      errorIo.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }
}

/** The exclusive intake lock, reported where a person reads it. */
async function acquireQueueLock(
  workDir: string,
  namespace: string,
  io: CliIo,
): Promise<{ readonly dir: string; readonly release: () => Promise<void> } | null> {
  try {
    return await acquireIntakeLock(workDir, namespace, () => new Date());
  } catch (cause) {
    if (cause instanceof SourceError) {
      io.err(`error: ${cause.message}`);
      return null;
    }
    throw cause;
  }
}

/**
 * Releasing the queue's own lock, or leaving it for inspection. A cleanup that
 * was not confirmed means something this invocation started may still be
 * writing, so the lock is kept exactly as an unconfirmed stop keeps it in a
 * `source` command.
 */
async function releaseQueueLock(
  lock: { readonly dir: string; readonly release: () => Promise<void> } | null,
  io: CliIo,
  cleanupConfirmed: boolean,
): Promise<void> {
  if (lock === null) {
    return;
  }
  if (!cleanupConfirmed) {
    io.err(
      `the intake lock "${lock.dir}" was left in place for inspection: the invocation could not ` +
        'confirm that everything it started had stopped, so a working copy may still be written to',
    );
    return;
  }
  try {
    await lock.release();
  } catch (cause) {
    io.err(`the intake lock "${lock.dir}" was left in place for inspection: ${messageOf(cause)}`);
  }
}

/** `queue run` and `queue watch`: the two serial queue subcommands. */
export async function queueCli(args: readonly string[], context: CliContext): Promise<number> {
  const { cwd, io } = context;
  const [subcommand, ...rest] = args;

  if (subcommand === undefined) {
    io.err(`error: queue requires one of: run, watch\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand.startsWith('-')) {
    io.err(`error: unknown option "${subcommand}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand !== 'run' && subcommand !== 'watch') {
    io.err(
      `error: unknown queue command "${subcommand}"; expected "run" or "watch"\n${USAGE_HINT}`,
    );
    return EXIT_USAGE;
  }

  const parsed = parseOptions(rest, subcommand === 'run' ? QUEUE_RUN_OPTIONS : QUEUE_WATCH_OPTIONS);
  if (!parsed.ok) {
    io.err(`error: ${parsed.message}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  const missing = [
    parsed.options.config === undefined ? '--config' : undefined,
    parsed.options.repo === undefined ? '--repo' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    io.err(`error: queue ${subcommand} requires ${listOptions(missing)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  return queueCommand(
    {
      mode: subcommand,
      configPath: path.resolve(cwd, parsed.options.config ?? ''),
      repoPath: path.resolve(cwd, parsed.options.repo ?? ''),
    },
    context,
  );
}
