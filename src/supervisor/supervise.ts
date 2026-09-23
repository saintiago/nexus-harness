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
 *
 * Nothing here trusts the invocation that wrote the state. The state is the
 * incident records under the supervisor's own root, and a restart reads them
 * back before it does anything: an attempt that was left in flight is reconciled
 * against the runtime it started and the judgment it may have left behind, a
 * concluded incident whose report is unfinished is finished again, and the work
 * a conclusion still owes the queue — a blocker first, then the interrupted
 * ticket — is really started, innermost first. The pointer file carries only
 * what the records cannot: which worker is running right now.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { phaseStop } from '../runs/stops.js';
import { messageOf } from '../shared/errors.js';
import type { RecoveryConfig } from '../shared/types.js';
import {
  incidentDir,
  incidentFilePath,
  currentIncidentPath,
  openIncident,
  readCurrentIncident,
  readIncident,
  stopSignature,
  supervisorRoot,
  unchangedAfterRecovery,
  writeCurrentIncident,
  writeIncident,
} from './incident.js';
import type {
  CurrentIncident,
  IncidentRecord,
  PendingRecovery,
  RecoveryAttempt,
  StopOrigin,
  SupervisorIntent,
} from './incident.js';
import { unreconciledLaunchProblem } from './launch.js';
import { acquireSupervisorOwnership, intakeConsumerProblem, processIsAlive } from './owner.js';
import type { LivenessProbe } from './owner.js';
import { RECOVERY_OUTCOME_FILE, isProblem, parseRecoveryJudgment } from './recovery.js';
import type {
  RecoveryBrief,
  RecoveryJudgment,
  RecoveryTurnRequest,
  RecoveryTurnResult,
} from './recovery.js';
import { reportNeedsPublication } from './report.js';
import type { IncidentJiraBoundary, IncidentReporter } from './report.js';
import { classifyWorkerStop, runNexusWorker } from './worker.js';
import type { WorkerOutcome, WorkerRequest } from './worker.js';

/** Where the supervisor's own lines go. */
export interface SuperviseIo {
  out(text: string): void;
  err(text: string): void;
}

/** One recovery turn, as the supervisor invokes it. */
export type RecoveryTurn = (request: RecoveryTurnRequest) => Promise<RecoveryTurnResult>;

/**
 * The connected project's Jira side, as it can be read at one moment: the
 * boundary a comment is written through, the project's own identity as the
 * recovery prompt names it, or neither when the project has no such source.
 */
export interface JiraBoundaryTake {
  readonly boundary: IncidentJiraBoundary;
  readonly identity: { readonly siteUrl: string; readonly projectKey: string } | null;
}

/** Everything one supervision invocation needs, as ordinary functions. */
export interface SuperviseRequest {
  readonly intent: SupervisorIntent;
  /** The ticket a `ticket` intent is scoped to, or `null`. */
  readonly scope: string | null;
  readonly workDir: string;
  /**
   * The id the supervisor's own state lives under. It names the supervision of
   * one checkout from one harness configuration, never the connected project's
   * queue identity: that state has to stay readable while a broken project
   * configuration is exactly what has to be repaired (docs/WORKFLOW.md §12).
   */
  readonly namespace: string;
  /**
   * The connected project's own intake-lock namespace, as the queue derives it,
   * or `null` when the project's configuration could not be read. The
   * activation check reads that lock; with no namespace to read it under, no
   * live raw consumer can be identified and the check is skipped, which the
   * command says out loud.
   */
  readonly queueNamespace?: string | null;
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
  /**
   * Where the concise report's Jira comment goes, read from the connected
   * project's configuration as it stands at the moment it is needed.
   *
   * It is resolved again here rather than captured once when this invocation
   * started, because a broken project configuration is exactly what the
   * recovery agent is invoked to repair: an incident whose repair restored the
   * connection owes a comment written through it, and it must not be lost
   * because the file could not be read before the repair
   * (docs/WORKFLOW.md §12).
   */
  readonly jiraBoundary: () => Promise<JiraBoundaryTake>;
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
  /** The CLI entry the worker runs; the same file this process is. */
  readonly entry: string;
  readonly interpreter: string;
  /** The interpreter arguments the worker runs with; see the worker. */
  readonly interpreterArgs: readonly string[];
  readonly cwd: string;
  /** The Nexus installation the supervisor and its recovery turn work on. */
  readonly installRoot: string;
  readonly isAlive: LivenessProbe;
}

/** One incident record and the file it was read from. */
interface KnownIncident {
  readonly record: IncidentRecord;
  readonly path: string;
}

/** One worker invocation the supervisor is about to start. */
interface WorkerStep {
  readonly intent: SupervisorIntent;
  readonly scope: string | null;
  /**
   * The incident whose resume plan this step carries out, or `null` for the
   * ordinary worker the operator asked for.
   */
  readonly plan: { readonly known: KnownIncident; readonly blocker: boolean } | null;
}

/** What the queue's own run evidence looked like at one moment. */
interface RunEvidence {
  readonly ok: boolean;
  readonly marker: string | null;
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
  const handled = new Set<string>();
  let workerRuns = 0;
  let recoveries = 0;
  // What a person still has to fix about a report, kept for the summary: a
  // publication problem never repeats a recovery that succeeded, and never
  // disappears because a later step went well.
  let reportProblem: string | null;

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
    const activation = await activationProblem(request, isAlive);
    if (activation !== null) {
      io.err(`supervisor: ${activation}`);
      return summary('attention', activation, null);
    }

    // Everything an earlier invocation left behind is read back before
    // anything new starts: a record that cannot be read is a refusal, and every
    // concluded incident whose report is unfinished is finished here, whatever
    // the pointer says now.
    let incidents: readonly KnownIncident[];
    let carried: KnownIncident | null;
    try {
      incidents = await readSupervisionState(root);
      reportProblem = await finishOutstandingReports(request, root, incidents);
      carried = await adoptIncident(request, incidents, io, isAlive);
      incidents = await readSupervisionState(root);
    } catch (cause) {
      const problem = messageOf(cause);
      io.err(`supervisor: ${problem}`);
      return summary('attention', problem, null);
    }

    for (;;) {
      if (stop.aborted) {
        return summary('cancelled', null, carried?.record ?? null);
      }

      // A carried incident is carried as far as it can go: the remaining
      // recovery attempts, the conclusion, and the one report that conclusion
      // produces. Handling it once per invocation is enough — a report that
      // failed is retried by the next invocation's own sweep, never in a loop.
      if (carried !== null && !handled.has(carried.record.id)) {
        let done: HandledIncident;
        try {
          done = await handleIncident(request, root, carried, incidents, io, () => {
            recoveries += 1;
          });
        } catch (cause) {
          const problem = messageOf(cause);
          io.err(`supervisor: ${problem}`);
          return summary('attention', problem, carried.record);
        }
        handled.add(carried.record.id);
        carried = done.incident;
        reportProblem = done.reportProblem ?? reportProblem;
        if (done.hold !== null) {
          // A recovery runtime that could not be confirmed ended keeps the
          // incident's ownership of it: nothing runs beside a process that
          // may still be repairing the workspace.
          io.err(`supervisor: ${done.hold}`);
          return summary('attention', done.hold, carried.record);
        }
        if (carried.record.stage === 'help') {
          return summary(
            'attention',
            carried.record.conclusion?.detail ?? 'the incident needs human help',
            carried.record,
          );
        }
        if (stop.aborted) {
          return summary('cancelled', null, carried.record);
        }
      }

      incidents = await readSupervisionState(root);
      const open = newestOpen(incidents);
      if (open !== null && !handled.has(open.record.id)) {
        carried = open;
        continue;
      }
      // A conclusion that asked for a person keeps the queue stopped until
      // that person really resolves it. Restarting the supervisor is not an
      // answer to the request, and starting a fresh worker here would silently
      // reset the bound the incident already spent.
      const unresolved = unresolvedHelp(incidents);
      if (unresolved !== null) {
        const detail = unresolved.record.conclusion?.detail ?? 'the incident needs human help';
        const problem =
          `incident ${unresolved.record.id} ended in a request for human help that is not ` +
          `resolved yet: ${detail} Nothing runs until a person does what it asks and ` +
          `acknowledges it in "${unresolved.path}" — a top-level "acknowledgement": ` +
          '{ "at": …, "note": … } — because only a person can say the thing it asked for was ' +
          'really done. Run the supervisor again afterwards.';
        io.err(`supervisor: ${problem}`);
        return summary('attention', problem, unresolved.record);
      }
      const owed = owedWork(incidents);
      let step: WorkerStep;
      if (owed.length > 0) {
        const known = owed[0];
        if (known === undefined) {
          throw new Error('unreachable: owed work was picked from an empty list');
        }
        io.out(planMessage(known));
        step = stepOf(known);
        carried = known;
      } else {
        step = { intent: request.intent, scope: request.scope, plan: null };
        carried = null;
      }

      const mode = step.intent === 'watch' ? 'watch' : 'run';
      workerRuns += 1;
      io.out(
        `supervisor: starting worker ${String(workerRuns)} (\`queue ${mode}\`` +
          `${step.scope === null ? '' : ` --ticket ${step.scope}`})` +
          (step.plan === null
            ? ''
            : ` for incident ${step.plan.known.record.id}` +
              `${step.plan.blocker ? ', the blocker ranked ahead of the interrupted work' : ''}`),
      );
      const before = await runEvidence(request);
      // The launch is written down before the child exists: its own token,
      // and no PID yet. The child waits for the record to name it before it
      // begins any work, so a supervisor that dies between spawning its
      // worker and recording it leaves a worker that did nothing at all, and
      // a restart refuses that launch instead of starting a second worker.
      const launch = { token: randomUUID(), at: request.now().toISOString() };
      try {
        await writeCurrentIncident(root, {
          version: 1,
          id: step.plan?.known.record.id ?? null,
          workerPid: null,
          launch,
        });
      } catch (cause) {
        // The launch could not be written down, so no child may be started
        // under it: the handshake's first half is what the child waits on.
        const problem = `the launch of a worker could not be written down: ${messageOf(cause)}`;
        io.err(`supervisor: ${problem}`);
        return summary('attention', problem, carried?.record ?? null);
      }
      let started = false;
      let outcome: WorkerOutcome;
      try {
        outcome = await runWorker({
          entry: request.entry,
          interpreter: request.interpreter,
          interpreterArgs: request.interpreterArgs,
          intent: step.intent,
          scope: step.scope,
          repoPath: request.repoPath,
          configPath: request.configPath,
          cwd: request.cwd,
          stop,
          launch: { file: currentIncidentPath(root), token: launch.token },
          onLine: (text) => {
            io.out(text);
          },
          // The child begins nothing until this write is durable: the worker
          // awaits it, and a registration that fails stops the child rather
          // than letting it run under a launch nothing recorded.
          onStarted: async (pid) => {
            started = true;
            await recordWorkerStarted(request, root, step, pid, io, launch);
          },
        });
      } catch (cause) {
        // The launch of this worker could not be registered durably. The child
        // is gated on exactly that record, so it began nothing; this is the
        // supervisor's own failure, not a worker's stop to recover from, and
        // nothing else starts under it.
        const problem = messageOf(cause);
        io.err(`supervisor: ${problem}`);
        return summary('attention', problem, carried?.record ?? null);
      }
      // A worker substitute may report no PID at all. One that started without
      // reporting one is still work that ran, and the step it carries out — the
      // blocker's start, or the resumption of the interrupted work — is
      // recorded the same way, never before it really started.
      if (!started && outcome.launchProblem === null) {
        await recordWorkerStarted(request, root, step, null, io, null).catch(() => undefined);
      }
      const after = await runEvidence(request);
      const progress = !before.ok || !after.ok || before.marker !== after.marker;
      await settlePointer(root);

      if (outcome.launchProblem !== null) {
        io.err(`supervisor: ${outcome.launchProblem}`);
      }
      const verdict = classifyWorkerStop(outcome);
      if (verdict === 'settled') {
        if (step.plan !== null && step.plan.blocker) {
          // The blocker's own worker really settled: that is the confirmed
          // result the plan waits for, and it is recorded before anything the
          // plan owes next is started.
          await recordBlockerSettled(request, root, step.plan.known, io);
          continue;
        }
        if (owedWork(await readSupervisionState(root)).length > 0) {
          // A blocker settled, or another incident's owed work is still open:
          // the work it was ranked ahead of runs in the next pass of this loop.
          continue;
        }
        io.out(
          `supervisor: the worker finished its work (exit code 0) after ${String(workerRuns)} ` +
            'invocation(s); nothing is left to recover.',
        );
        await writeCurrentIncident(root, null).catch(() => undefined);
        return summary(
          reportProblem === null ? 'settled' : 'attention',
          reportProblem,
          carried?.record ?? null,
        );
      }
      if (verdict === 'cancelled') {
        io.out(
          'supervisor: the operator stopped this supervision, and the worker stopped with it. ' +
            'Nothing is recovered from an intentional stop; the evidence stays where it is.',
        );
        return summary('cancelled', null, carried?.record ?? null);
      }

      // An unexpected stop: a signal, a crash, a nonzero exit, or a worker that
      // never started. This is the one case the recovery agent exists for.
      const at = request.now().toISOString();
      const previous = previousIncidentFor(incidents, step);
      const repeated =
        previous !== null &&
        unchangedAfterRecovery(previous.record, {
          intent: step.intent,
          scope: step.scope,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          progress,
        });
      // A stop that ends a worker which was already resuming, without the queue
      // having done anything at all in between, is a repetition whichever exit
      // code it wears. The first such repetition is still investigated — an
      // unscoped failure could be a different ticket entirely — but a whole
      // chain of them, every one of which a recovery turn already investigated,
      // ends in a person's hands rather than in another attempt.
      const origin: StopOrigin =
        step.plan === null
          ? { incident: null, progress: true }
          : { incident: step.plan.known.record.id, progress };
      const barren = origin.incident !== null && !origin.progress;
      const chain = barren ? 1 + barrenChain(incidents, origin.incident) : 0;
      const exhausted =
        !repeated &&
        barren &&
        chain >= request.recovery.maxAttempts &&
        previous !== null &&
        previous.record.conclusion !== null &&
        previous.record.conclusion.outcome !== 'help';
      const opened = openIncident(
        request.namespace,
        step.intent,
        step.scope,
        request.recovery.maxAttempts,
        request.now,
      );
      const ended =
        outcome.signal === null
          ? `exit code ${String(outcome.exitCode)}`
          : `signal ${outcome.signal}`;
      io.out(
        `supervisor: the worker stopped unexpectedly (${ended}), so incident ${opened.id} was ` +
          `opened${previous === null ? '' : ` over ${previous.record.id}`}.`,
      );
      const stopped: IncidentRecord = {
        ...opened,
        updatedAt: at,
        origin,
        stops: [
          {
            at,
            intent: step.intent,
            scope: step.scope,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            signature: stopSignature(step.intent, step.scope, outcome.exitCode, outcome.signal),
          },
        ],
        ...(repeated || exhausted
          ? {
              stage: 'help' as const,
              conclusion: {
                outcome: 'help' as const,
                detail: repeated
                  ? 'the same failure returned unchanged after a recovery attempt that reported ' +
                    'the situation repaired, so another attempt would spend the same work for the ' +
                    'same result. A person decides what happens next: ' +
                    (previous?.record.attempts.at(-1)?.summary ??
                      'see the earlier recovery turn log')
                  : `the queue stopped ${String(chain)} times in a row without doing any work at ` +
                    'all, and every one of those stops was already investigated by a recovery ' +
                    'turn that reported the situation repaired. Another attempt would spend the ' +
                    'same work for the same result, so a person decides what happens next, ' +
                    `starting from incident ${String(origin.incident)}.`,
                at,
              },
            }
          : {}),
      };
      await persist(root, stopped);
      carried = { record: stopped, path: incidentFilePath(root, stopped.id) };
      incidents = await readSupervisionState(root);
    }
  } finally {
    await ownership.ownership.release();
  }
}

/** Every incident the supervisor's own root holds, oldest first. */
async function readSupervisionState(root: string): Promise<readonly KnownIncident[]> {
  const dir = path.join(root, 'incidents');
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(
      `the supervisor's incident directory "${dir}" could not be read: ${messageOf(cause)}`,
      { cause },
    );
  }
  const incidents: KnownIncident[] = [];
  for (const name of [...names].sort()) {
    const file = incidentFilePath(root, name);
    // A record that cannot be read back refuses the whole supervision: no
    // restart may round "an incident I cannot read" into "nothing happened".
    const record = await readIncident(file);
    if (record !== null) {
      incidents.push({ record, path: file });
    }
  }
  return incidents;
}

/** The newest incident that is still open, or `null` when none is. */
function newestOpen(incidents: readonly KnownIncident[]): KnownIncident | null {
  const open = incidents.filter((known) => known.record.stage === 'open');
  return open.at(-1) ?? null;
}

/**
 * The newest incident that ended in a request for human help nobody has
 * acknowledged yet, or `null` when there is none. It stops everything the
 * queue would otherwise start, whichever invocation finds it.
 */
function unresolvedHelp(incidents: readonly KnownIncident[]): KnownIncident | null {
  const asking = incidents.filter(
    (known) => known.record.stage === 'help' && known.record.acknowledgement === null,
  );
  return asking.at(-1) ?? null;
}

/**
 * The work the queue is still owed, newest first: every concluded incident
 * whose resume plan has not been carried out — its blocker not started yet, or
 * its interrupted work not started again. The newest one is the innermost
 * interruption, so it is carried first, and whatever it was waiting on follows.
 */
function owedWork(incidents: readonly KnownIncident[]): readonly KnownIncident[] {
  return incidents
    .filter(
      (known) =>
        known.record.stage === 'settled' &&
        known.record.sequence !== null &&
        known.record.resumedAt === null,
    )
    .toReversed();
}

/** What one incident's resume plan runs next. */
function stepOf(known: KnownIncident): WorkerStep {
  const plan = known.record.sequence;
  if (plan === null) {
    throw new Error(`incident ${known.record.id} owes no work, so no step belongs to it`);
  }
  // The blocker is owed while it has no confirmed result: a start alone is not
  // a settled blocker, and a crash during its worker leaves it owed too.
  if (plan.blocker !== null && plan.blockerSettledAt === null) {
    return { intent: 'ticket', scope: plan.blocker.key, plan: { known, blocker: true } };
  }
  return { intent: plan.intent, scope: plan.scope, plan: { known, blocker: false } };
}

/** One line naming what an owed incident's next step is for. */
function planMessage(known: KnownIncident): string {
  const plan = known.record.sequence;
  if (plan === null) {
    return `supervisor: incident ${known.record.id} owes no work.`;
  }
  if (plan.blocker !== null && plan.blockerSettledAt === null) {
    return (
      `supervisor: incident ${known.record.id}: ${plan.blocker.key} is ranked ahead of the ` +
      'interrupted work and has not settled yet, so its worker runs first.'
    );
  }
  return `supervisor: incident ${known.record.id}: the interrupted work resumes now.`;
}

/**
 * Records, once, that one worker invocation really started: the pointer keeps
 * its PID — under the launch the child is waiting on — so a restart never
 * starts a second worker beside it, and the incident whose plan this worker
 * carries out records the step it was owed — the blocker's start, or the
 * resumption of the interrupted work itself, which is recorded when that work
 * really starts and never before.
 *
 * This is the child's own gate as well: nothing of the worker happens until
 * this write is durable, so a failure here is a launch that never was, and it
 * is raised to the caller rather than swallowed.
 */
async function recordWorkerStarted(
  request: SuperviseRequest,
  root: string,
  step: WorkerStep,
  pid: number | null,
  io: SuperviseIo,
  launch: { readonly token: string; readonly at: string } | null,
): Promise<void> {
  const pointer = (id: string | null): CurrentIncident => ({
    version: 1,
    id,
    workerPid: pid,
    launch,
  });
  if (step.plan === null) {
    await writeCurrentIncident(root, pointer(null));
    return;
  }
  const known = step.plan.known;
  const plan = known.record.sequence;
  if (plan === null) {
    await writeCurrentIncident(root, pointer(known.record.id));
    return;
  }
  const at = request.now().toISOString();
  const updated: IncidentRecord = step.plan.blocker
    ? { ...known.record, sequence: { ...plan, blockerStartedAt: at }, updatedAt: at }
    : { ...known.record, resumedAt: at, updatedAt: at };
  await writeIncident(incidentFilePath(root, updated.id), updated);
  await writeCurrentIncident(root, pointer(updated.id));
  if (step.plan.blocker) {
    io.out(
      `supervisor: incident ${updated.id}: the blocker ${step.scope ?? ''} is running, and the ` +
        'interrupted work follows it.',
    );
  } else {
    io.out(`supervisor: incident ${updated.id}: the queue resumes now.`);
  }
}

/**
 * Records that the blocker a plan ranked ahead of the interrupted work really
 * settled. The plan advances on this result and on nothing else: a started
 * blocker that never settled — a crash during its worker included — leaves the
 * step owed, and a restart carries it out again.
 */
async function recordBlockerSettled(
  request: SuperviseRequest,
  root: string,
  known: KnownIncident,
  io: SuperviseIo,
): Promise<void> {
  // The record is read back before it is written: the blocker's own start was
  // recorded when its worker was registered, and this write must not take that
  // evidence away.
  const file = incidentFilePath(root, known.record.id);
  const latest = await readIncident(file);
  const plan = latest?.sequence ?? null;
  if (plan === null || plan.blocker === null || plan.blockerSettledAt !== null) {
    return;
  }
  const at = request.now().toISOString();
  const updated: IncidentRecord = {
    ...(latest ?? known.record),
    sequence: { ...plan, blockerSettledAt: at },
    updatedAt: at,
  };
  await writeIncident(file, updated);
  io.out(
    `supervisor: incident ${updated.id}: the blocker ${plan.blocker.key} settled, so the ` +
      'interrupted work runs next.',
  );
}

/**
 * Leaves the pointer describing what is left: the incident being carried next,
 * or nothing when the queue is really back to its ordinary state. It is what a
 * restart adopts from when the records themselves are ambiguous about what was
 * running.
 */
async function settlePointer(root: string): Promise<void> {
  const incidents = await readSupervisionState(root);
  const next = newestOpen(incidents) ?? owedWork(incidents)[0] ?? null;
  if (next === null) {
    await writeCurrentIncident(root, null).catch(() => undefined);
    return;
  }
  await writeCurrentIncident(root, {
    version: 1,
    id: next.record.id,
    workerPid: null,
    launch: null,
  }).catch(() => undefined);
}

/**
 * The worker's own run evidence under the output directory: the newest run
 * that reached its own report (see the loop below for what that means).
 */
async function runEvidence(request: SuperviseRequest): Promise<RunEvidence> {
  const dir = path.join(request.workDir, 'runs');
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, marker: null };
    }
    // Evidence that cannot be read is not evidence of progress: the caller
    // treats it conservatively, as work that may have moved on.
    return { ok: false, marker: null };
  }
  const runs = [...names].filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)).sort();
  // A run that was created and then abandoned — the worker died before the run
  // reached its own report — is not evidence that the queue did anything: it is
  // a bookkeeping artifact that a failure repeating unchanged produces again on
  // every pass, which would make that failure look like progress forever. Only
  // a run that finished, whatever it concluded, is work the queue really did.
  for (const name of runs.toReversed()) {
    const finished = await stat(path.join(dir, name, 'result.json')).then(
      () => true,
      () => false,
    );
    if (finished) {
      return { ok: true, marker: name };
    }
  }
  return { ok: true, marker: null };
}

/** The incident this stop repeats, when one names the same work. */
function previousIncidentFor(
  incidents: readonly KnownIncident[],
  step: WorkerStep,
): KnownIncident | null {
  const same = incidents.filter(
    (known) => known.record.scope === step.scope && known.record.stage !== 'open',
  );
  return same.at(-1) ?? null;
}

/**
 * The same investigated cause coming back, when that is what one stop is.
 *
 * "The same failure again" cannot be read from an exit code, and it cannot be
 * read from a run directory either: a worker that creates its directory and
 * then dies on the same operational problem leaves one behind every time. The
 * comparison is therefore made on what the two recoveries investigated — the
 * ticket both of them judged the work to belong to, and the cause each named —
 * and only where the queue really ran something in between: the earlier
 * incident concluded `repaired` or `blocked`, its work left a finished run
 * behind, and this attempt investigates the very cause that recovery reported.
 * Then another attempt would spend the same work for the same result.
 */
function repeatedInvestigatedCause(
  current: IncidentRecord,
  previous: KnownIncident | null,
  judgment: RecoveryJudgment,
): string | null {
  if (previous === null || judgment.ticket === null) {
    return null;
  }
  const conclusion = previous.record.conclusion;
  if (conclusion === null || conclusion.outcome === 'help') {
    return null;
  }
  if (current.origin === null || !current.origin.progress) {
    return null;
  }
  if (previous.record.ticket?.key !== judgment.ticket.key) {
    return null;
  }
  const earlier = previous.record.attempts.at(-1)?.cause ?? null;
  if (earlier === null || normalizedCause(earlier) !== normalizedCause(judgment.cause)) {
    return null;
  }
  return (
    `the same failure returned unchanged: this attempt investigated the cause the recovery at ` +
    `incident ${previous.record.id} reported repaired — "${judgment.cause}" — and the queue ` +
    'stopped again after really running in between, so another attempt would spend the same ' +
    'work for the same result. A person decides what happens next.'
  );
}

/** One investigated cause, as two recoveries' own words compare. */
function normalizedCause(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * How many incidents in a row before this one stopped the same work without the
 * queue doing anything at all. Each link is an incident whose own origin names
 * the incident that resumed it, and whose resumed worker left no run evidence
 * behind; the chain ends at the first stop that made progress, or at a worker
 * the operator asked for directly.
 */
function barrenChain(incidents: readonly KnownIncident[], id: string | null): number {
  let count = 0;
  let current = id;
  while (current !== null) {
    const known = incidents.find((candidate) => candidate.record.id === current);
    if (known === undefined) {
      break;
    }
    const origin = known.record.origin;
    if (origin === null || origin.incident === null || origin.progress) {
      break;
    }
    count += 1;
    current = origin.incident;
  }
  return count;
}

/** The activation check: a raw consumer that is really running is refused. */
async function activationProblem(
  request: SuperviseRequest,
  isAlive: LivenessProbe,
): Promise<string | null> {
  const queueNamespace = request.queueNamespace ?? request.namespace;
  if (queueNamespace === null) {
    return null;
  }
  return await intakeConsumerProblem({
    workDir: request.workDir,
    namespace: queueNamespace,
    isAlive,
  });
}

/** Writes one incident record and points the supervisor at it. */
async function persist(root: string, incident: IncidentRecord): Promise<void> {
  await writeIncident(incidentFilePath(root, incident.id), incident);
  await writeCurrentIncident(root, {
    version: 1,
    id: incident.id,
    workerPid: null,
    launch: null,
  });
}

/**
 * One incident, changed from the newest state on disk rather than from a
 * snapshot a caller read earlier. Two writers of one incident — the loop's own
 * step records and the report's publication, chiefly — must never take each
 * other's evidence away, and an older snapshot reaching the file last is
 * exactly how that would happen.
 */
async function updateIncident(
  root: string,
  id: string,
  change: (latest: IncidentRecord) => IncidentRecord,
): Promise<KnownIncident> {
  const file = incidentFilePath(root, id);
  const latest = await readIncident(file);
  if (latest === null) {
    throw new Error(
      `incident ${id} has no record at "${file}" to write back to; inspect the supervision ` +
        'state by hand.',
    );
  }
  const updated = change(latest);
  await writeIncident(file, updated);
  return { record: updated, path: file };
}

/**
 * The incident an earlier supervisor left open, when one is really still being
 * handled. A record whose worker is genuinely still running is a refusal, not
 * an adoption: a restart must not put a second worker beside one that never
 * stopped.
 */
async function adoptIncident(
  request: SuperviseRequest,
  incidents: readonly KnownIncident[],
  io: SuperviseIo,
  isAlive: LivenessProbe,
): Promise<KnownIncident | null> {
  const root = supervisorRoot(request.workDir, request.namespace);
  const current = await readCurrentIncident(root);
  const pid = current?.workerPid ?? null;
  if (current?.launch !== null && current?.launch !== undefined && pid === null) {
    // A launch that names no process cannot be reconciled: the worker it
    // started may be there or not, and only the record that never came could
    // have told. The child is gated on exactly that record — it has begun no
    // work — and this invocation refuses rather than starting a second one.
    throw new Error(
      unreconciledLaunchProblem({
        file: currentIncidentPath(root),
        token: current.launch.token,
        at: current.launch.at,
      }),
    );
  }
  if (pid !== null && isAlive(pid)) {
    throw new Error(
      `a worker started by an earlier supervisor is still running (pid ${String(pid)}), so this ` +
        'invocation will not start a second one beside it. Wait for it, or stop it by hand, and ' +
        'run the supervisor again.',
    );
  }
  const open = newestOpen(incidents);
  if (open === null) {
    return null;
  }
  io.out(
    `supervisor: adopting incident ${open.record.id} (${String(open.record.stops.length)} ` +
      `stop(s), ${String(open.record.attempts.length)} recovery attempt(s) already spent` +
      `${current?.id === undefined || current.id === null || current.id === open.record.id ? '' : `, pointer ${current.id}`}).`,
  );
  return open;
}

/** What handling one incident did, and what it left a person to fix. */
interface HandledIncident {
  readonly incident: KnownIncident;
  readonly reportProblem: string | null;
  /**
   * Set when the incident cannot go on for a person's own reconciliation: its
   * recovery runtime could not be confirmed ended, so it may still be
   * repairing the workspace. Nothing else may start until that is settled.
   */
  readonly hold: string | null;
}

/** One recovery attempt's own ending, however it was obtained. */
interface AttemptOutcome {
  readonly attempt: number;
  readonly startedAt: string;
  readonly result: RecoveryTurnResult;
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
  known: KnownIncident,
  incidents: readonly KnownIncident[],
  io: SuperviseIo,
  onRecovery: () => void,
): Promise<HandledIncident> {
  let current = known;
  // The incident this one continues, when it continues one: the recovery of a
  // repeated failure is judged against the very recovery that returned the
  // queue to work before it.
  const origin = known.record.origin?.incident ?? null;
  const previous =
    origin === null
      ? null
      : (incidents.find((candidate) => candidate.record.id === origin) ?? null);
  while (current.record.stage === 'open') {
    if (request.stop.aborted) {
      // The operator asked the supervision to stop: the incident is left open
      // where it is, with no attempt spent, and the caller reports the
      // cancellation rather than a request for human help.
      break;
    }
    if (current.record.pending !== null) {
      // A turn an earlier invocation started and never finished recording:
      // reconciled against its own process and its own judgment, and counted
      // toward the bound, never started again blindly.
      const reconciled = await reconcilePendingAttempt(request, current, io);
      const recorded = await recordAttempt(request, root, current, reconciled, io, previous);
      current = recorded.incident;
      if (recorded.hold !== null) {
        return { incident: current, reportProblem: null, hold: recorded.hold };
      }
      continue;
    }
    if (current.record.attempts.length >= current.record.maxAttempts) {
      const concluded = conclude(
        current.record,
        'help',
        `the recovery bound was reached: ${String(current.record.attempts.length)} attempt(s) of ` +
          `at most ${String(current.record.maxAttempts)} could not return the queue to a state it ` +
          'can carry. ' +
          (current.record.attempts.at(-1)?.help ??
            current.record.attempts.at(-1)?.problem ??
            'Inspect the incident record and the recovery turn logs.'),
        request.now,
      );
      current = { record: concluded, path: current.path };
      await persist(root, concluded);
      break;
    }
    const started = await startAttempt(request, root, current, incidents, io, onRecovery);
    const recorded = await recordAttempt(request, root, current, started, io, previous);
    current = recorded.incident;
    if (recorded.hold !== null) {
      return { incident: current, reportProblem: null, hold: recorded.hold };
    }
  }
  return await finishIncident(request, root, current);
}

/**
 * One fresh recovery attempt: written down as pending before its turn is ever
 * launched, so a restart knows an attempt is in flight, reconciles it, and
 * counts it toward the bound instead of starting the same work twice.
 */
async function startAttempt(
  request: SuperviseRequest,
  root: string,
  known: KnownIncident,
  incidents: readonly KnownIncident[],
  io: SuperviseIo,
  onRecovery: () => void,
): Promise<AttemptOutcome> {
  const current = known.record;
  const attempt = current.attempts.length + 1;
  const dir = path.join(incidentDir(root, current.id), `attempt-${String(attempt)}`);
  const startedAt = request.now().toISOString();
  const pending: PendingRecovery = {
    attempt,
    startedAt,
    supervisorPid: process.pid,
    turnPid: null,
    dir,
    logPath: null,
    problem: null,
  };
  const pendingRecord: IncidentRecord = { ...current, pending, updatedAt: startedAt };
  await writeIncident(incidentFilePath(root, current.id), pendingRecord);
  io.out(
    `supervisor: incident ${current.id}: starting recovery attempt ${String(attempt)} of at most ` +
      `${String(current.maxAttempts)}.`,
  );
  onRecovery();
  const bounded = phaseStop(request.recoveryTurnTimeoutMs, request.stop);
  let recordedPid: Promise<void> = Promise.resolve();
  let result: RecoveryTurnResult;
  try {
    // The brief is composed from the project's configuration as it stands now:
    // a repair of an earlier attempt — or of this incident's own earlier
    // attempt — is what names the thread the report goes into.
    const jiraTake = await resolveJiraTake(request);
    result = await request.recoveryTurn({
      brief: briefFor(request, root, pendingRecord, attempt, incidents, jiraTake),
      dir,
      stop: bounded.signal,
      onStarted: (pid) => {
        // The runtime's own PID, written beside the attempt: the process that
        // may still be repairing a workspace is this one, not the supervisor.
        // The turn's own launch waits on this write before it is handed its
        // prompt, and a failure is let out — never swallowed — so nothing
        // repairs a workspace under a launch no record names.
        recordedPid = writeIncident(incidentFilePath(root, current.id), {
          ...pendingRecord,
          pending: { ...pending, turnPid: pid },
        });
        return recordedPid;
      },
    });
  } catch (cause) {
    result = {
      judgment: null,
      problem: `the recovery turn could not be run: ${messageOf(cause)}`,
      shutdown: null,
      dir,
      logPath: null,
    };
  }
  bounded.cancel();
  await recordedPid.catch(() => undefined);
  return { attempt, startedAt, result };
}

/**
 * The attempt an earlier supervisor started and never finished recording. A
 * turn whose runtime is still running is a refusal — it may still be repairing
 * the workspace — and one whose process is gone is reconciled against the
 * judgment it left behind: that judgment is adopted whole when it is there, and
 * an interrupted turn is recorded as an attempt that produced none. Either way
 * it counts toward the bound, because it was really spent.
 *
 * An attempt that names no process is neither of those: nothing is handed to a
 * recovery runtime before it is recorded, so an attempt with no PID is one
 * whose turn never began. Nothing about it can be reconciled — a restart
 * cannot tell whether that runtime exists — and it is refused by name instead
 * of being rounded into an attempt that produced nothing.
 */
async function reconcilePendingAttempt(
  request: SuperviseRequest,
  known: KnownIncident,
  io: SuperviseIo,
): Promise<AttemptOutcome> {
  const pending = known.record.pending;
  if (pending === null) {
    throw new Error(`incident ${known.record.id} has no attempt to reconcile`);
  }
  const isAlive = request.isAlive ?? processIsAlive;
  if (pending.turnPid === null) {
    throw new Error(
      `incident ${known.record.id}: the recovery attempt an earlier supervisor started ` +
        `(${pending.startedAt}) names no process, so nothing can tell whether its runtime is ` +
        'still there. No turn is started beside it, and this attempt is not rounded into one ' +
        'that ran: the attempt directory is ' +
        `"${pending.dir}" — inspect it and the processes on this host, then run the supervisor ` +
        'again.',
    );
  }
  if (isAlive(pending.turnPid)) {
    throw new Error(
      `incident ${known.record.id}: the recovery turn an earlier supervisor started is still ` +
        `running (pid ${String(pending.turnPid)}), so this invocation will not start another one ` +
        'beside it. Wait for it, or stop it by hand, and run the supervisor again.',
    );
  }
  const outcomePath = path.join(pending.dir, RECOVERY_OUTCOME_FILE);
  let result: RecoveryTurnResult;
  try {
    const text = await readFile(outcomePath, 'utf8');
    const parsed = parseRecoveryJudgment(text, RECOVERY_OUTCOME_FILE);
    result = isProblem(parsed)
      ? {
          judgment: null,
          problem: parsed.problem,
          shutdown: null,
          dir: pending.dir,
          logPath: pending.logPath,
        }
      : {
          judgment: parsed,
          problem: null,
          shutdown: null,
          dir: pending.dir,
          logPath: pending.logPath,
        };
  } catch (cause) {
    result = {
      judgment: null,
      problem:
        pending.problem ??
        `the recovery turn started at ${pending.startedAt} did not finish producing a judgment, ` +
          `and its outcome could not be read back (${messageOf(cause)}). An interrupted attempt ` +
          'counts as spent and is never repeated blindly; inspect ' +
          `"${pending.dir}" before deciding what happens next.`,
      shutdown: null,
      dir: pending.dir,
      logPath: pending.logPath,
    };
  }
  io.out(
    `supervisor: incident ${known.record.id}: attempt ${String(pending.attempt)} was left in ` +
      'flight by an earlier invocation and is reconciled now' +
      `${result.judgment === null ? ' without a judgment.' : ` as ${result.judgment.status}.`}`,
  );
  return { attempt: pending.attempt, startedAt: pending.startedAt, result };
}

/**
 * Records one attempt from its own result and concludes the incident from it.
 *
 * One result is not recorded like the others: a turn whose runtime could not
 * be confirmed stopped may still be repairing the workspace it was given. That
 * attempt stays in flight — the incident keeps owning the process it recorded
 * — and the caller is handed a hold instead of another turn or a worker, so
 * nothing runs beside a process nobody has accounted for.
 */
async function recordAttempt(
  request: SuperviseRequest,
  root: string,
  known: KnownIncident,
  outcome: AttemptOutcome,
  io: SuperviseIo,
  previous: KnownIncident | null,
): Promise<{ readonly incident: KnownIncident; readonly hold: string | null }> {
  const current = known.record;
  const endedAt = request.now().toISOString();
  if (outcome.result.shutdown?.termination === 'unconfirmed') {
    const shutdown = outcome.result.shutdown;
    const detail =
      `the recovery turn's runtime could not be confirmed stopped ` +
      `(${shutdown.problem ?? 'no reason was recorded'}), so it may still be repairing the ` +
      'workspace. The attempt stays in flight and this incident keeps owning that process: ' +
      'nothing else runs beside it. Wait for it, or stop it by hand, and run the supervisor ' +
      'again; the attempt is then reconciled and counted as spent.';
    io.err(`supervisor: incident ${current.id}: ${detail}`);
    // The record is read back before it is written: the attempt's own PID was
    // recorded when the turn's runtime was registered, and this write keeps
    // it — the incident goes on owning exactly that process.
    const file = incidentFilePath(root, current.id);
    const latest = (await readIncident(file)) ?? current;
    const pending = latest.pending;
    let incident = latest;
    if (pending !== null) {
      incident = { ...latest, pending: { ...pending, problem: detail }, updatedAt: endedAt };
      await writeIncident(file, incident);
    }
    return { incident: { record: incident, path: known.path }, hold: detail };
  }
  const judgment = outcome.result.judgment;
  const recorded: RecoveryAttempt = {
    attempt: outcome.attempt,
    startedAt: outcome.startedAt,
    endedAt,
    outcome: judgment?.status ?? 'failed',
    summary: judgment?.summary ?? null,
    cause: judgment?.cause ?? null,
    resolution: judgment?.resolution ?? null,
    preserved: judgment?.preserved ?? [],
    resume: judgment?.resume ?? null,
    blocker: judgment?.blocker ?? null,
    help: judgment?.help ?? null,
    problem: outcome.result.problem,
    dir: outcome.result.dir,
    logPath: outcome.result.logPath,
  };
  let updated: IncidentRecord = {
    ...current,
    pending: null,
    attempts: [...current.attempts, recorded],
    updatedAt: endedAt,
    // The ticket this stop belonged to, as the turn investigated it. It is only
    // taken up where the incident has no ticket of its own: an unscoped
    // `run`/`watch` stop is how an incident gets a thread to be written into at
    // all, while a scoped one already names the item the operator followed, and
    // its report belongs in that item's thread.
    ...(judgment === null || judgment.ticket === null || current.scope !== null
      ? {}
      : { ticket: judgment.ticket }),
  };

  if (judgment === null) {
    io.err(
      `supervisor: incident ${current.id}: recovery attempt ${String(outcome.attempt)} produced ` +
        `no judgment${outcome.result.problem === null ? '' : `: ${outcome.result.problem}`}`,
    );
  } else {
    io.out(
      `supervisor: incident ${current.id}: recovery attempt ${String(outcome.attempt)} concluded ` +
        `${judgment.status}.`,
    );
  }

  const repeatedCause =
    judgment === null ? null : repeatedInvestigatedCause(current, previous, judgment);
  if (repeatedCause !== null) {
    // The cause this attempt investigated is the cause an earlier one reported
    // repaired, and the queue really ran something in between: another attempt
    // would spend the same work for the same result, so this ends where a
    // person decides instead.
    updated = conclude(updated, 'help', repeatedCause, request.now);
    io.err(`supervisor: incident ${updated.id}: ${repeatedCause}`);
  } else if (judgment !== null && judgment.status === 'unrecoverable') {
    updated = conclude(
      updated,
      'help',
      judgment.help ?? 'the recovery agent could not repair the situation',
      request.now,
    );
  } else if (judgment !== null) {
    const blocked = judgment.status === 'blocked';
    updated = conclude(
      updated,
      blocked ? 'blocked' : 'repaired',
      judgment.resolution ??
        judgment.summary ??
        'the recovery agent returned the situation to the queue',
      request.now,
    );
    // A blocker that names the interrupted ticket itself ranks nothing ahead
    // of it: the queue is simply resumed.
    const blocker =
      blocked &&
      judgment.blocker !== null &&
      (updated.scope === null || judgment.blocker.key.toUpperCase() !== updated.scope.toUpperCase())
        ? judgment.blocker
        : null;
    updated = {
      ...updated,
      sequence: {
        intent: updated.intent,
        scope: updated.scope,
        blocker,
        blockerStartedAt: null,
        blockerSettledAt: null,
      },
    };
    if (blocker !== null) {
      io.out(
        `supervisor: incident ${updated.id}: ${blocker.key} is ranked ahead of the interrupted ` +
          'work' +
          (judgment.resume === null ? '.' : `, which resumes afterwards: ${judgment.resume}`),
      );
    }
  }
  const next: KnownIncident = { record: updated, path: known.path };
  await persist(root, updated);
  return { incident: next, hold: null };
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
    // A request for human help resumes nothing: it is reported, and the
    // supervision stops there.
    ...(outcome === 'help' ? { sequence: null } : {}),
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
  known: KnownIncident,
): Promise<HandledIncident> {
  if (known.record.stage === 'open') {
    return { incident: known, reportProblem: null, hold: null };
  }
  const published = await publish(request, root, known.record);
  return { ...published, hold: null };
}

/** One incident's publication, with what it left to fix. */
async function publish(
  request: SuperviseRequest,
  root: string,
  incident: IncidentRecord,
): Promise<{ readonly incident: KnownIncident; readonly reportProblem: string | null }> {
  let outcome;
  try {
    // The boundary is read now rather than remembered from when this
    // invocation started: a project configuration the recovery agent repaired
    // is exactly what the report this incident owes has to be written through.
    outcome = await request.reporter({
      incident,
      stop: request.stop,
      jira: await resolveJiraBoundary(request),
      checkpoint: async (report) => {
        // The publication state is written down before it crosses the network,
        // so a restart reads an in-flight send as in-flight rather than as an
        // unattempted one, and one incident is never published twice. The
        // newest record is the one written back: the step this incident was
        // carried through must not be taken away by a state older than it.
        const at = request.now().toISOString();
        await updateIncident(root, incident.id, (latest) => ({ ...latest, report, updatedAt: at }));
      },
    });
  } catch (cause) {
    const detail = `the incident report for ${incident.id} could not be published: ${messageOf(cause)}`;
    request.io.err(`supervisor: ${detail}`);
    return {
      incident: { record: incident, path: incidentFilePath(root, incident.id) },
      reportProblem: detail,
    };
  }
  const known = await updateIncident(root, incident.id, (latest) => ({
    ...latest,
    report: outcome.report,
    updatedAt: request.now().toISOString(),
  }));
  if (outcome.problem !== null) {
    request.io.err(`supervisor: ${outcome.problem}`);
    return { incident: known, reportProblem: outcome.problem };
  }
  request.io.out(
    `supervisor: incident ${incident.id}: the concise report was published` +
      (outcome.report.commentId === null ? '' : ` as Jira comment ${outcome.report.commentId}`) +
      (outcome.report.notification?.state === 'sent'
        ? ', and its email summary was confirmed'
        : '') +
      '.',
  );
  return { incident: known, reportProblem: null };
}

/**
 * Finishes every concluded incident whose report is still unfinished, wherever
 * it sits in the root. A report that failed in an earlier invocation stays
 * reachable this way even after the incident it belongs to was resumed and the
 * pointer moved on; the reporter's own identities keep it from publishing
 * anything twice, and reporting never repeats a recovery that succeeded.
 */
async function finishOutstandingReports(
  request: SuperviseRequest,
  root: string,
  incidents: readonly KnownIncident[],
): Promise<string | null> {
  let problem: string | null = null;
  for (const known of incidents) {
    const incident = known.record;
    if (incident.stage === 'open') {
      continue;
    }
    // Read as the project stands now, for the same reason the publication
    // itself is: a comment a repaired configuration owes is still outstanding.
    const jira = await resolveJiraBoundary(request);
    const needed = reportNeedsPublication(incident, {
      jira: jira.kind !== 'none',
      notification: request.recovery.notifications ?? null,
    });
    if (!needed) {
      continue;
    }
    const published = await publish(request, root, incident);
    problem = published.reportProblem ?? problem;
  }
  return problem;
}

/** The connected project's Jira side, as its configuration stands right now. */
async function resolveJiraBoundary(request: SuperviseRequest): Promise<IncidentJiraBoundary> {
  return (await resolveJiraTake(request)).boundary;
}

/**
 * The connected project's Jira side, as its configuration stands right now,
 * with a configuration that cannot be read named rather than thrown: a project
 * file the recovery agent has not repaired yet is a state this supervision is
 * expected to run through, not one that stops it.
 */
async function resolveJiraTake(request: SuperviseRequest): Promise<JiraBoundaryTake> {
  try {
    return await request.jiraBoundary();
  } catch (cause) {
    return {
      boundary: {
        kind: 'unreadable',
        problem: `the connected project's configuration could not be read: ${messageOf(cause)}`,
      },
      identity: null,
    };
  }
}

/** Everything one recovery turn is told about the incident it answers. */
function briefFor(
  request: SuperviseRequest,
  root: string,
  incident: IncidentRecord,
  attempt: number,
  incidents: readonly KnownIncident[],
  jira: JiraBoundaryTake,
): RecoveryBrief {
  const stop = incident.stops.at(-1);
  if (stop === undefined) {
    throw new Error(`incident ${incident.id} has no recorded stop to recover from`);
  }
  const previous = incidents
    .filter((known) => known.record.id !== incident.id && known.record.scope === incident.scope)
    .at(-1);
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
    previous: previous === undefined ? null : { id: previous.record.id, path: previous.path },
    jira: jira.identity,
    jiraProblem: jira.boundary.kind === 'unreadable' ? jira.boundary.problem : null,
    notification:
      request.recovery.notifications === undefined
        ? null
        : {
            topicArn: request.recovery.notifications.topicArn,
            email: request.recovery.notifications.email,
          },
  };
}
