import type { TerminationOutcome } from '../shared/types.js';

/**
 * The stop a workspace step recorded, when the harness had to stop it: whether
 * everything that step started was seen to end, and what could not be confirmed.
 * It is the same two parts a configured command's stop is recorded in, so a
 * caller that has to say why a run ended can carry an unconfirmed stop from a
 * Git step rather than rounding it down.
 */
export interface WorkspaceStepStop {
  /** The Git stop trigger and bound, when recorded by the invocation. */
  readonly kind?: 'timeout' | 'cancelled';
  readonly timeoutMs?: number;
  readonly termination: TerminationOutcome;
  readonly problem: string | null;
}

/** A source repository or output location that cannot be used for a run. */
export class WorkspaceError extends Error {
  /**
   * Why the harness stopped the step that failed, when a stop is what failed it;
   * `null` for every other failure. A step that was stopped — at its limit, or
   * because the run's caller stopped it — is never reported as an ordinary
   * failure, and an unconfirmed stop is never reported as a clean one.
   */
  readonly stop: WorkspaceStepStop | null;

  constructor(message: string, options?: { cause?: unknown; stop?: WorkspaceStepStop | null }) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.stop = options?.stop ?? null;
  }
}

/** The stop a failed workspace step recorded, when its failure carries one. */
export function workspaceStopOf(cause: unknown): WorkspaceStepStop | null {
  return cause instanceof WorkspaceError ? cause.stop : null;
}
