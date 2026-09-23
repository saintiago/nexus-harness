/**
 * The supervisor: a small parent that runs Nexus, and a separate recovery agent
 * it invokes when that worker stops unexpectedly.
 *
 * ```text
 *   worker (queue run|watch) ── settled ──> done
 *        │                                    ▲
 *        │ unexpected stop                    │ resume the work
 *        ▼                                    │
 *   incident record ──> recovery agent ── repaired / blocker ranked first
 *        │                     │
 *        │                     └ unrecoverable, repeated unchanged failure,
 *        │                       or the attempt bound reached
 *        └──> actionable request for human help
 * ```
 *
 * The design keeps the ordinary loop ordinary. The supervisor adds no
 * exceptional-case branch to the queue: it starts the same CLI the operator
 * started, watches how that process ended, and hands the judgment — what the
 * cause was, what work to preserve, what to repair, which ticket should come
 * first — to the recovery agent (docs/WORKFLOW.md §12). What the supervisor
 * itself owns is bounded and deterministic: one worker at a time, an incident
 * record that survives restarts, at most `recovery.maxAttempts` attempts, one
 * published report per incident, and a stop that stays stopped when the
 * operator asked for it.
 */
import path from 'node:path';
import { phaseStop } from '../runs/stops.js';
import { messageOf } from '../shared/errors.js';
import type { RecoveryConfig } from '../shared/types.js';
import type { HttpClient } from '../sources/jira/http.js';
import {
  incidentDir,
  incidentFilePath,
  openIncident,
  readCurrentIncident,
  readIncident,
  stopSignature,
  supervisorRoot,
  unchangedAfterRecovery,
  writeCurrentIncident,
  writeIncident,
} from './incident.js';
import type { IncidentRecord, RecoveryAttempt, SupervisorIntent } from './incident.js';
import { acquireSupervisorOwnership, intakeConsumerProblem, processIsAlive } from './owner.js';
import type { LivenessProbe } from './owner.js';
import type { RecoveryBrief, RecoveryTurnResult } from './recovery.js';
import type { IncidentReporter } from './report.js';
import { classifyWorkerStop, runNexusWorker } from './worker.js';
import type { WorkerOutcome, WorkerRequest } from './worker.js';

/** Where the supervisor's own lines go. */
export interface SuperviseIo {
  out(text: string): void;
  err(text: string): void;
}

/** One recovery turn, as the supervisor invokes it. */
export type RecoveryTurn = (request: {
  readonly brief: RecoveryBrief;
  readonly dir: string;
  readonly stop: AbortSignal;
}) => Promise<RecoveryTurnResult>;

/** Everything one supervision invocation needs, as ordinary functions. */
export interface SuperviseRequest {
  readonly intent: SupervisorIntent;
  /** The ticket a `ticket` intent is scoped to, or `null`. */
  readonly scope: string | null;
  readonly workDir: string;
  /** The connected project's stable lock namespace, as the queue derives it. */
  readonly namespace: string;
  readonly repoPath: string;
  readonly configPath: string;
  readonly projectConfigPath: string;
  /** The Nexus installation the supervisor runs from. */
  readonly installRoot: string;
  /** The CLI entry the worker runs; the same file this process runs. */
  readonly entry: string;
  readonly interpreter: string;
  /** The interpreter arguments the worker is started with, passed on unchanged. */
  readonly interpreterArgs: readonly string[];
  /** The directory the worker starts in. */
  readonly cwd: string;
  readonly recovery: RecoveryConfig;
  /**
   * The bound one recovery turn runs under, in milliseconds: the configured
   * task timeout, unchanged. A recovery turn is a turn like any other.
   */
  readonly recoveryTurnTimeoutMs: number;
  readonly io: SuperviseIo;
  /** The operator's stop request: an interrupt of the supervisor itself. */
  readonly stop: AbortSignal;
  readonly now: () => Date;
  /** The Jira boundary the concise report is written through, when there is one. */
  readonly jira?: { readonly http: HttpClient; readonly token: string } | undefined;
  /** The project's Jira identity, when its configuration declares a source. */
  readonly jiraIdentity?: { readonly siteUrl: string; readonly projectKey: string } | undefined;
  /** The recovery turn's own boundaries, supplied by the command that composes it. */
  readonly recoveryTurn: RecoveryTurn;
  readonly reporter: IncidentReporter;
  /** Stood in for by a test; the real worker starts the Nexus CLI. */
  readonly worker?: ((request: WorkerRequest) => Promise<WorkerOutcome>) | undefined;
  readonly isAlive?: LivenessProbe | undefined;
}

/** One supervision invocation's outcome. */
export interface SuperviseSummary {
  readonly outcome: 'settled' | 'cancelled' | 'attention';
  /** Worker invocations this supervisor started. */
  readonly workerRuns: number;
  /** Recovery turns this supervisor started, across every incident it handled. */
  readonly recoveries: number;
  readonly problem: string | null;
  /** The incident this invocation handled, when it handled one. */
  readonly incidentId: string | null;
}

/**
 * The supervisor's own outward boundaries, and the paths it reads them from.
 * The command composes the real ones; a test substitutes the pieces it drives,
 * exactly as the other commands' `…Parts` do.
 */
export interface SupervisorParts {
  /** The worker: the Nexus CLI, started as a child process by default. */
  readonly worker: (request: WorkerRequest) => Promise<WorkerOutcome>;
  readonly recoveryTurn: RecoveryTurn;
  readonly reporter: IncidentReporter;
  /** The CLI entry the worker runs; the same file this process runs. */
  readonly entry: string;
  readonly interpreter: string;
  /** The interpreter arguments the worker runs with; see the worker. */
  readonly interpreterArgs: readonly string[];
  readonly cwd: string;
  /** The Nexus installation the supervisor and its recovery turn work on. */
  readonly installRoot: string;
  readonly isAlive: LivenessProbe;
}

/**
 * One supervision invocation. Everything the caller composes — the worker, the
 * recovery turn, the reporter — is handed in, so the decisions this module owns
 * are decided from explicit evidence.
 */
export async function supervise(request: SuperviseRequest): Promise<SuperviseSummary> {
  const { io, stop } = request;
  const root = supervisorRoot(request.workDir, request.namespace);
  const runWorker = request.worker ?? runNexusWorker;
  const isAlive = request.isAlive ?? processIsAlive;
  let workerRuns = 0;
  let recoveries = 0;
  let reportProblem: string | null = null;

  const summary = (
    outcome: SuperviseSummary['outcome'],
    problem: string | null,
    incident: IncidentRecord | null,
  ): SuperviseSummary => ({
    outcome,
    workerRuns,
    recoveries,
    problem,
    incidentId: incident?.id ?? null,
  });

  const ownership = await acquireSupervisorOwnership({
    root,
    intent: request.intent,
    repoPath: request.repoPath,
    now: request.now,
    isAlive,
  });
  if (!ownership.ok) {
    io.err(`supervisor: ${ownership.problem}`);
    return summary('attention', ownership.problem, null);
  }

  try {
    const activation = await intakeConsumerProblem({
      workDir: request.workDir,
      namespace: request.namespace,
      isAlive,
    });
    if (activation !== null) {
      io.err(`supervisor: ${activation}`);
      return summary('attention', activation, null);
    }

    let incident: IncidentRecord | null;
    try {
      incident = await adoptIncident(root, io, isAlive);
    } catch (cause) {
      const problem = messageOf(cause);
      io.err(`supervisor: ${problem}`);
      return summary('attention', problem, null);
    }

    for (;;) {
      if (stop.aborted) {
        return summary('cancelled', null, incident);
      }

      if (incident !== null) {
        // Everything an adopted or open incident still needs happens before the
        // worker runs again: the remaining recovery attempts, the conclusion,
        // and the one report that conclusion produces.
        const handled = await handleIncident(request, root, incident, io, () => {
          recoveries += 1;
        });
        incident = handled.incident;
        if (handled.reportProblem !== null) {
          reportProblem = handled.reportProblem;
        }
        if (incident.stage === 'help') {
          return summary(
            'attention',
            incident.conclusion?.detail ?? 'the incident needs human help',
            incident,
          );
        }
        if (stop.aborted) {
          return summary('cancelled', null, incident);
        }
        // A settled incident is resumed here, and the resumption is recorded on
        // it: the interrupted work really is started again rather than only
        // promised, whatever blocker was ranked ahead of it.
        if (incident.resumedAt === null) {
          const at = request.now().toISOString();
          incident = { ...incident, resumedAt: at, updatedAt: at };
          await persist(root, incident);
          io.out(`supervisor: incident ${incident.id}: the queue resumes now.`);
        }
      }

      const pointer = incident?.id ?? null;
      workerRuns += 1;
      io.out(
        `supervisor: starting worker ${String(workerRuns)} (\`queue ${
          request.intent === 'watch' ? 'watch' : 'run'
        }\`${request.scope === null ? '' : ` --ticket ${request.scope}`})`,
      );
      const outcome = await runWorker({
        entry: request.entry,
        interpreter: request.interpreter,
        interpreterArgs: request.interpreterArgs,
        intent: request.intent,
        scope: request.scope,
        repoPath: request.repoPath,
        configPath: request.configPath,
        cwd: request.cwd,
        stop,
        onLine: (text) => {
          io.out(text);
        },
        onStarted: (pid) => {
          void writeCurrentIncident(root, { version: 1, id: pointer, workerPid: pid }).catch(
            (cause: unknown) => {
              io.err(
                `supervisor: the running worker could not be recorded (${messageOf(cause)}), so a ` +
                  'restart cannot tell that it is still running.',
              );
            },
          );
        },
      });
      if (pointer === null) {
        // No incident is being handled: nothing is left behind for a restart to
        // adopt, and the worker's own intake lock is what keeps a second
        // consumer out while nothing is recorded here.
        await writeCurrentIncident(root, null).catch(() => undefined);
      } else {
        await writeCurrentIncident(root, { version: 1, id: pointer, workerPid: null }).catch(
          () => undefined,
        );
      }

      if (outcome.launchProblem !== null) {
        io.err(`supervisor: ${outcome.launchProblem}`);
      }
      const verdict = classifyWorkerStop(outcome);
      if (verdict === 'settled') {
        io.out(
          `supervisor: the worker finished its work (exit code 0) after ${String(workerRuns)} ` +
            'invocation(s); nothing is left to recover.',
        );
        if (incident !== null) {
          await writeCurrentIncident(root, null);
        }
        return summary(reportProblem === null ? 'settled' : 'attention', reportProblem, incident);
      }
      if (verdict === 'cancelled') {
        io.out(
          'supervisor: the operator stopped this supervision, and the worker stopped with it. ' +
            'Nothing is recovered from an intentional stop; the evidence stays where it is.',
        );
        return summary('cancelled', null, incident);
      }

      // An unexpected stop: a signal, a crash, a nonzero exit, or a worker that
      // never started. This is the one case the recovery agent exists for.
      const at = request.now().toISOString();
      const signature = stopSignature(
        request.intent,
        request.scope,
        outcome.exitCode,
        outcome.signal,
      );
      // Every stopped episode is its own incident with its own one report. A
      // resumed worker that failed again therefore opens a new one — unless
      // that failure is the very one its recovery reported repaired, which is
      // the repetition that ends in an actionable request for human help
      // instead of another recovery.
      const previous = incident;
      const repeated = previous !== null && unchangedAfterRecovery(previous, signature);
      incident = openIncident(
        request.namespace,
        request.intent,
        request.scope,
        request.recovery.maxAttempts,
        request.now,
      );
      const ended =
        outcome.signal === null
          ? `exit code ${String(outcome.exitCode)}`
          : `signal ${outcome.signal}`;
      io.out(
        workerRuns === 1
          ? `supervisor: the worker stopped unexpectedly (${ended}), so incident ${incident.id} was opened.`
          : `supervisor: the resumed worker stopped unexpectedly again (${ended}), recorded on ` +
              `incident ${incident.id}.`,
      );
      incident = {
        ...incident,
        updatedAt: at,
        stops: [
          {
            at,
            intent: request.intent,
            scope: request.scope,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            signature,
          },
        ],
        ...(repeated
          ? {
              stage: 'help' as const,
              conclusion: {
                outcome: 'help' as const,
                detail:
                  'the same failure returned unchanged after a recovery attempt that reported ' +
                  'the situation repaired, so another attempt would spend the same work for the ' +
                  'same result. A person decides what happens next: ' +
                  (previous?.attempts.at(-1)?.summary ?? 'see the earlier recovery turn log'),
                at,
              },
            }
          : {}),
      };
      await persist(root, incident);
    }
  } finally {
    await ownership.ownership.release();
  }
}

/** Writes one incident record and points the supervisor at it. */
async function persist(root: string, incident: IncidentRecord): Promise<void> {
  await writeIncident(incidentFilePath(root, incident.id), incident);
  await writeCurrentIncident(root, { version: 1, id: incident.id, workerPid: null });
}

/**
 * The incident an earlier supervisor left, when one is really still being
 * handled. A record whose worker is genuinely still running is a refusal, not
 * an adoption: a restart must not put a second worker beside one that never
 * stopped.
 */
async function adoptIncident(
  root: string,
  io: SuperviseIo,
  isAlive: LivenessProbe,
): Promise<IncidentRecord | null> {
  const current = await readCurrentIncident(root);
  if (current === null) {
    return null;
  }
  const pid = current.workerPid;
  if (pid !== null && isAlive(pid)) {
    throw new Error(
      `a worker started by an earlier supervisor is still running (pid ${String(pid)}), so this ` +
        'invocation will not start a second one beside it. Wait for it, or stop it by hand, and ' +
        'run the supervisor again.',
    );
  }
  if (current.id === null) {
    return null;
  }
  const incident = await readIncident(incidentFilePath(root, current.id));
  if (incident === null) {
    throw new Error(
      `the supervisor's current-incident pointer names "${current.id}", and its record is gone. ` +
        'Inspect the output directory by hand; the supervisor will not guess what was spent.',
    );
  }
  io.out(
    `supervisor: adopting incident ${incident.id} (${String(incident.stops.length)} stop(s), ` +
      `${String(incident.attempts.length)} recovery attempt(s) already spent).`,
  );
  return incident;
}

/** What handling one incident did, and what it left a person to fix. */
interface HandledIncident {
  readonly incident: IncidentRecord;
  readonly reportProblem: string | null;
}

/**
 * One incident, carried as far as it can go: another recovery attempt while the
 * bound and the failure's own history allow one, or an actionable request for
 * human help. A concluded incident is reported here, so a restart that adopted
 * one finishes exactly what the interrupted invocation had left — the report,
 * and never another recovery.
 */
async function handleIncident(
  request: SuperviseRequest,
  root: string,
  incident: IncidentRecord,
  io: SuperviseIo,
  onRecovery: () => void,
): Promise<HandledIncident> {
  let current = incident;
  while (current.stage === 'open') {
    if (current.attempts.length >= current.maxAttempts) {
      current = conclude(
        current,
        'help',
        `the recovery bound was reached: ${String(current.attempts.length)} attempt(s) of at most ` +
          `${String(current.maxAttempts)} could not return the queue to a state it can carry. ` +
          (current.attempts.at(-1)?.help ??
            current.attempts.at(-1)?.problem ??
            'Inspect the incident record and the recovery turn logs.'),
        request.now,
      );
      break;
    }
    const attempt = current.attempts.length + 1;
    const dir = path.join(incidentDir(root, current.id), `attempt-${String(attempt)}`);
    io.out(
      `supervisor: incident ${current.id}: starting recovery attempt ${String(attempt)} of at ` +
        `most ${String(current.maxAttempts)}.`,
    );
    onRecovery();
    const bounded = phaseStop(request.recoveryTurnTimeoutMs, request.stop);
    let result: RecoveryTurnResult;
    try {
      result = await request.recoveryTurn({
        brief: briefFor(request, root, current, attempt),
        dir,
        stop: bounded.signal,
      });
    } catch (cause) {
      result = {
        judgment: null,
        problem: `the recovery turn could not be run: ${messageOf(cause)}`,
        dir,
        logPath: null,
      };
    }
    bounded.cancel();

    const endedAt = request.now().toISOString();
    const recorded: RecoveryAttempt = {
      attempt,
      startedAt: current.updatedAt,
      endedAt,
      outcome: result.judgment?.status ?? 'failed',
      summary: result.judgment?.summary ?? null,
      cause: result.judgment?.cause ?? null,
      resolution: result.judgment?.resolution ?? null,
      preserved: result.judgment?.preserved ?? [],
      resume: result.judgment?.resume ?? null,
      blocker: result.judgment?.blocker ?? null,
      help: result.judgment?.help ?? null,
      problem: result.problem,
      dir: result.dir,
      logPath: result.logPath,
    };
    current = { ...current, attempts: [...current.attempts, recorded], updatedAt: endedAt };

    if (result.judgment === null) {
      io.err(
        `supervisor: incident ${current.id}: recovery attempt ${String(attempt)} produced no ` +
          `judgment${result.problem === null ? '' : `: ${result.problem}`}`,
      );
    } else {
      io.out(
        `supervisor: incident ${current.id}: recovery attempt ${String(attempt)} concluded ` +
          `${result.judgment.status}.`,
      );
    }

    if (result.judgment !== null && result.judgment.status === 'unrecoverable') {
      current = conclude(
        current,
        'help',
        result.judgment.help ?? 'the recovery agent could not repair the situation',
        request.now,
      );
    } else if (result.judgment !== null) {
      const blocked = result.judgment.status === 'blocked';
      current = conclude(
        current,
        blocked ? 'blocked' : 'repaired',
        result.judgment.resolution ??
          result.judgment.summary ??
          'the recovery agent returned the situation to the queue',
        request.now,
      );
      if (blocked && result.judgment.blocker !== null) {
        io.out(
          `supervisor: incident ${current.id}: ${result.judgment.blocker.key} is ranked ahead of ` +
            'the interrupted work' +
            (result.judgment.resume === null
              ? '.'
              : `, which resumes afterwards: ${result.judgment.resume}`),
        );
      }
    }
    await persist(root, current);
  }

  // A concluded incident is reported once, and the report's own identities make
  // a restart idempotent.
  return await finishIncident(request, root, current);
}

/** One incident's conclusion, and the record it produces. */
function conclude(
  incident: IncidentRecord,
  outcome: 'repaired' | 'blocked' | 'help',
  detail: string,
  now: () => Date,
): IncidentRecord {
  const at = now().toISOString();
  return {
    ...incident,
    stage: outcome === 'help' ? 'help' : 'settled',
    updatedAt: at,
    conclusion: { outcome, detail, at },
  };
}

/**
 * Publishes one concluded incident's report and stores what the remote side
 * acknowledged. A report problem is returned rather than thrown: the recovery
 * itself is not repeated because its summary could not be sent.
 */
async function finishIncident(
  request: SuperviseRequest,
  root: string,
  incident: IncidentRecord,
): Promise<HandledIncident> {
  if (incident.stage === 'open') {
    return { incident, reportProblem: null };
  }
  let outcome;
  try {
    outcome = await request.reporter({ incident, stop: request.stop });
  } catch (cause) {
    const detail = `the incident report for ${incident.id} could not be published: ${messageOf(cause)}`;
    request.io.err(`supervisor: ${detail}`);
    return { incident, reportProblem: detail };
  }
  const updated: IncidentRecord = {
    ...incident,
    report: outcome.report,
    updatedAt: request.now().toISOString(),
  };
  await writeIncident(incidentFilePath(root, incident.id), updated);
  if (outcome.problem !== null) {
    request.io.err(`supervisor: ${outcome.problem}`);
    return { incident: updated, reportProblem: outcome.problem };
  }
  request.io.out(
    `supervisor: incident ${incident.id}: the concise report was published` +
      (outcome.report.commentId === null ? '' : ` as Jira comment ${outcome.report.commentId}`) +
      (outcome.report.notification?.state === 'sent'
        ? ', and its email summary was confirmed'
        : '') +
      '.',
  );
  return { incident: updated, reportProblem: null };
}

/** Everything one recovery turn is told about the incident it answers. */
function briefFor(
  request: SuperviseRequest,
  root: string,
  incident: IncidentRecord,
  attempt: number,
): RecoveryBrief {
  const stop = incident.stops.at(-1);
  if (stop === undefined) {
    throw new Error(`incident ${incident.id} has no recorded stop to recover from`);
  }
  return {
    incidentId: incident.id,
    incidentPath: incidentFilePath(root, incident.id),
    dir: path.join(incidentDir(root, incident.id), `attempt-${String(attempt)}`),
    installRoot: request.installRoot,
    workDir: request.workDir,
    repoPath: request.repoPath,
    configPath: request.configPath,
    projectConfigPath: request.projectConfigPath,
    intent: incident.intent,
    scope: incident.scope,
    attempt,
    maxAttempts: incident.maxAttempts,
    timeoutMinutes: Math.round(request.recoveryTurnTimeoutMs / 60_000),
    stop,
    earlier: incident.attempts,
    jira: request.jiraIdentity ?? null,
    notification:
      request.recovery.notifications === undefined
        ? null
        : {
            topicArn: request.recovery.notifications.topicArn,
            email: request.recovery.notifications.email,
          },
  };
}
