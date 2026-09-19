import type { CancellationEvidence, TimeoutEvidence } from '../shared/types.js';

/**
 * The stop request one phase of a run works under: the run's remaining task
 * time, and the caller's own stop request, in the one form a phase can honour.
 *
 * Both triggers abort the same signal, so a phase has one thing to watch, and
 * `AbortController` keeps the first of them: the reason the phase stopped for is
 * the first that arrived, and a second trigger reaching an already-stopped phase
 * changes nothing.
 */
/** Which of the two triggers stopped a run: its own deadline, or its caller. */
type StopKind = 'timeout' | 'cancelled';

/**
 * The reason a stop request carries. The signal is what a runtime honours; the
 * kind is how the run reads back which trigger arrived, so the reason it reports
 * is the one that happened rather than the other one.
 */
class RunStopReason extends Error {
  readonly kind: StopKind;

  constructor(kind: StopKind, message: string) {
    super(message);
    this.name = 'RunStopReason';
    this.kind = kind;
  }
}

/** What one phase is given to stop with, and how the run reads it back. */
interface PhaseStop {
  /** Aborts when the run's deadline expires or its caller stops it, and only then. */
  readonly signal: AbortSignal;
  /**
   * Why it aborted: the first of the two triggers to arrive, or `null` when
   * neither has. Read after the phase returns, this is what the run stopped for.
   */
  kind(): StopKind | null;
  /**
   * Releases both triggers: the deadline timer is cleared and the caller's stop
   * request is no longer listened to. A phase that has returned leaves nothing
   * armed behind it, and the signal it handed out is left un-aborted by this —
   * releasing a phase's stop ends the phase's interest in it, it does not stop
   * the phase.
   */
  cancel(): void;
}

/**
 * The stop request one phase of a run works under: the run's remaining task
 * time, and the caller's own stop request, in the one form a phase can honour.
 *
 * Both triggers abort the same signal, so a phase has one thing to watch, and
 * `AbortController` keeps the first of them: the reason the phase stopped for is
 * the first that arrived, and a second trigger reaching an already-stopped phase
 * changes nothing.
 */
export function phaseStop(remainingMs: number, callerStop: AbortSignal | undefined): PhaseStop {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort(
        new RunStopReason(
          'timeout',
          `the run's remaining task time (${String(remainingMs)} ms) is used up`,
        ),
      );
    },
    Math.max(0, remainingMs),
  );

  /** Held by the caller's stop request for exactly as long as this phase runs. */
  let onCallerStop: (() => void) | null = null;
  if (callerStop !== undefined) {
    onCallerStop = () => {
      controller.abort(new RunStopReason('cancelled', 'the run was stopped by its caller'));
    };
    callerStop.addEventListener('abort', onCallerStop, { once: true });
    if (callerStop.aborted) {
      // It arrived before this phase listened for it: the phase is stopped the
      // same way rather than started as if nothing had been asked.
      onCallerStop();
    }
  }

  return {
    signal: controller.signal,
    kind: () => {
      const { reason } = controller.signal;
      return controller.signal.aborted && reason instanceof RunStopReason ? reason.kind : null;
    },
    cancel: () => {
      clearTimeout(timer);
      if (onCallerStop !== null) {
        callerStop?.removeEventListener('abort', onCallerStop);
      }
    },
  };
}

/**
 * What stopped a run, and why it ended there. The run ends for exactly one of
 * these: the deadline it was given, or the stop its caller asked for. Each
 * carries the evidence its report keeps — the two are different records, because
 * an expired limit and a run its caller ended are different facts.
 */
export type StopCause =
  | { readonly kind: 'timeout'; readonly reason: string; readonly evidence: TimeoutEvidence }
  | {
      readonly kind: 'cancelled';
      readonly reason: string;
      readonly evidence: CancellationEvidence;
    };
