/**
 * The worker the supervisor runs: one Nexus queue invocation, as a child
 * process, with its own terminal.
 *
 * The supervisor does not re-implement the queue: it starts the same CLI the
 * operator started, with `queue run` or `queue watch` and the same two files,
 * and lets it draw its own activity pane. The child's streams are inherited, so
 * the display an operator watches is exactly the one a raw queue would draw
 * (docs/spec.md, "Terminal display"), and the supervisor writes only its own
 * lines around it.
 *
 * What comes back is evidence, not a verdict: the process lost to a signal, the
 * exit code of an exit, or the reason it could not be started at all. Whether
 * that is an unexpected stop — anything but a plain zero exit, or any ending
 * that arrives after the operator asked for a stop — is decided in one place
 * ({@link classifyWorkerStop}), and a crash with no report at all is an
 * ordinary unexpected stop rather than a special case (docs/WORKFLOW.md §12).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { requestTreeStop } from '../process/stop.js';
import { messageOf } from '../shared/errors.js';
import type { SupervisorIntent } from './incident.js';

/**
 * How long the supervisor waits after forwarding the operator's interrupt
 * before it stops the worker's tree itself. A queue that received the interrupt
 * finalizes its active phase and its cleanup first — that is what its own
 * cancellation contract asks it to do — and this bound is what keeps a worker
 * that never finishes from holding the supervisor forever. A stop this made is
 * still the operator's stop: no recovery follows it.
 */
export const WORKER_STOP_GRACE_MS = 60_000;

/** What one worker invocation is asked to run. */
export interface WorkerRequest {
  /** The Nexus CLI entry the child runs; the same file the supervisor is. */
  readonly entry: string;
  /** The interpreter that runs it: this process's own Node.js. */
  readonly interpreter: string;
  /**
   * The interpreter arguments this process was itself started with. They are
   * passed on unchanged, so a supervisor started through a loader — `tsx`, for
   * example — runs the worker the same way it is running itself rather than
   * handing Node a file it cannot read.
   */
  readonly interpreterArgs?: readonly string[];
  readonly intent: SupervisorIntent;
  /** The ticket a `ticket` intent scopes the worker to, or `null`. */
  readonly scope: string | null;
  readonly repoPath: string;
  readonly configPath: string;
  /** The directory the child starts in: the supervisor's own. */
  readonly cwd: string;
  /** The operator's stop request; an interrupt of the supervisor itself. */
  readonly stop: AbortSignal;
  /** Where the supervisor's own lines about the worker go. */
  readonly onLine?: (text: string) => void;
  /**
   * The PID of the process that was really started, as soon as it exists. The
   * supervisor records it, so a restart can tell that a worker is still running
   * instead of starting a second one beside it.
   */
  readonly onStarted?: (pid: number) => void;
}

/** What one worker invocation left behind. */
export interface WorkerOutcome {
  /** The exit code, or `null` when a signal or a launch failure ended it. */
  readonly exitCode: number | null;
  /** The signal that ended the child, or `null` when it exited itself. */
  readonly signal: string | null;
  /** Why the child could not be started at all, when it could not. */
  readonly launchProblem: string | null;
  /** Whether the supervisor had asked for a stop when the child ended. */
  readonly stopRequested: boolean;
}

/** What the supervisor makes of one worker ending. */
export type WorkerVerdict =
  /** The queue finished its work: nothing to recover. */
  | 'settled'
  /** The operator's own stop: the queue stays stopped. */
  | 'cancelled'
  /** Anything else: an unexpected stop, including a crash with no report. */
  | 'stopped';

/**
 * The one decision about a worker ending. A zero exit is the queue's own
 * settled result; any other ending is the operator's stop when they asked for
 * one, and an unexpected stop when they did not. A child that never started is
 * an unexpected stop too: it produced no exit of its own to trust.
 */
export function classifyWorkerStop(outcome: WorkerOutcome): WorkerVerdict {
  if (outcome.launchProblem !== null) {
    return 'stopped';
  }
  if (outcome.exitCode === 0 && outcome.signal === null) {
    return 'settled';
  }
  return outcome.stopRequested ? 'cancelled' : 'stopped';
}

/** The CLI arguments one intent runs the worker with. */
export function workerArguments(request: {
  readonly intent: SupervisorIntent;
  readonly scope: string | null;
  readonly repoPath: string;
  readonly configPath: string;
}): readonly string[] {
  const mode = request.intent === 'watch' ? 'watch' : 'run';
  return [
    'queue',
    mode,
    '--repo',
    request.repoPath,
    '--config',
    request.configPath,
    ...(request.intent === 'ticket' && request.scope !== null ? ['--ticket', request.scope] : []),
  ];
}

/**
 * Runs one worker to completion and reports how it ended. The child inherits
 * the supervisor's standard streams, so its activity pane is drawn on the
 * operator's terminal exactly as an unsupervised queue would draw it. It is its
 * own process group on this host's POSIX platforms, so the supervisor's stop
 * reaches the whole tree it became; on Windows the console delivers the
 * interrupt to the group already, and the tree is stopped by PID when the grace
 * expires.
 */
export async function runNexusWorker(request: WorkerRequest): Promise<WorkerOutcome> {
  const args = [
    ...(request.interpreterArgs ?? []),
    request.entry,
    ...workerArguments({
      intent: request.intent,
      scope: request.scope,
      repoPath: request.repoPath,
      configPath: request.configPath,
    }),
  ];
  const command = [request.interpreter, ...args].join(' ');
  request.onLine?.(`worker: ${command}`);

  let child: ChildProcess;
  try {
    child = spawn(request.interpreter, args, {
      cwd: request.cwd,
      stdio: 'inherit',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (cause) {
    return {
      exitCode: null,
      signal: null,
      launchProblem: `the worker could not be started: ${messageOf(cause)}`,
      stopRequested: request.stop.aborted,
    };
  }
  if (child.pid !== undefined) {
    request.onStarted?.(child.pid);
  }

  let stopRequested = request.stop.aborted;
  let stopTimer: NodeJS.Timeout | null = null;
  let forwarded = false;

  const forwardStop = (): void => {
    if (forwarded) {
      return;
    }
    forwarded = true;
    stopRequested = true;
    request.onLine?.(
      'worker: the operator asked this supervisor to stop, so the worker is being stopped too ' +
        'and its own cleanup is waited for.',
    );
    const pid = child.pid;
    if (pid !== undefined && process.platform !== 'win32') {
      // The worker is a process-group leader of its own on this platform, so
      // the terminal's own Ctrl+C reached the supervisor and never the worker:
      // the interrupt is delivered here, and its own handler finalizes.
      try {
        process.kill(pid, 'SIGINT');
      } catch (cause) {
        request.onLine?.(
          `worker: the interrupt could not be delivered to pid ${String(pid)}: ${messageOf(cause)}`,
        );
      }
    }
    stopTimer = setTimeout(() => {
      const stopped = child.pid;
      if (stopped === undefined) {
        return;
      }
      request.onLine?.(
        `worker: it did not finish within ${String(Math.round(WORKER_STOP_GRACE_MS / 1000))}s of ` +
          'the stop request, so its process tree is being stopped now.',
      );
      void requestTreeStop(stopped).then((problem) => {
        if (problem !== null) {
          request.onLine?.(`worker: stopping its tree was not confirmed: ${problem}`);
        }
      });
    }, WORKER_STOP_GRACE_MS);
    stopTimer.unref?.();
  };

  const stopListener = (): void => {
    forwardStop();
  };
  request.stop.addEventListener('abort', stopListener, { once: true });

  return await new Promise<WorkerOutcome>((resolve) => {
    let launchProblem: string | null = null;
    child.on('error', (cause) => {
      launchProblem ??= `the worker could not be started: ${messageOf(cause)}`;
    });
    child.on('close', (code, signal) => {
      if (stopTimer !== null) {
        clearTimeout(stopTimer);
      }
      request.stop.removeEventListener('abort', stopListener);
      if (request.stop.aborted) {
        stopRequested = true;
      }
      resolve({
        exitCode: code,
        signal,
        launchProblem,
        stopRequested,
      });
    });
    if (request.stop.aborted) {
      forwardStop();
    }
  });
}
