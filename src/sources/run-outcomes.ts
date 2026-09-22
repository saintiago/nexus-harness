/**
 * What a finished run's own evidence says about intake: the two readings the
 * coordinator makes from a {@link RunTaskResult} before it decides whether the
 * escalation ladder climbs and whether the pre-delivery diagnosis applies.
 *
 * Both are ordinary functions over the result the runner already produced — its
 * status, its stop evidence, the repair turns it really spent, and the rounds it
 * observed — so the decisions can be exercised without a repository, a command,
 * or a coding turn. No reason string is read anywhere here: rewording a run's
 * sentence can never change where the ladder goes or whether a diagnosis runs
 * (docs/implement-workspace-continuation.md, docs/WORKFLOW.md §11).
 */
import type { RunTaskResult } from '../runs/contracts.js';
import type { CheckRoundResult } from '../shared/types.js';

/**
 * Whether a run's own evidence says the escalation ladder may climb from it:
 * the attempt ended on an ordinary completed red check round whose repair
 * allowance was spent, and nothing else stopped it.
 *
 * Every other ending is terminal at the rung that produced it — a coding turn
 * that could not finish (a launch, authentication, or protocol error), a round
 * that could not be executed (a setup failure, a check that could not be
 * launched), an expired limit, a cancellation, or a stop that was not confirmed
 * — and escalating those would spend a stronger launch on infrastructure rather
 * than on code. The fields below are what says which ending a run had: the
 * status, the stop evidence, the repair turns the rung's own run really spent,
 * and the last turn's own round.
 */
export function exhaustedRedRound(run: RunTaskResult, allowance: number): boolean {
  if (run.status !== 'failed' || run.timeout !== null || run.cancellation !== null) {
    return false;
  }
  if (run.repairsUsed < allowance) {
    // The tier's own allowance was not spent: the rung has not exhausted the
    // repair turns it was given, so a stronger launch is not spent here yet.
    return false;
  }
  const lastTurn = run.attempts.at(-1);
  return lastTurn !== undefined && lastTurn.checks?.outcome === 'failed';
}

/**
 * Whether a run ended on a completed red baseline of a fresh workspace, before
 * any coding turn: every setup command succeeded, the check round completed with
 * a nonzero result, and nothing else stopped the run. That is the one ending the
 * pre-delivery diagnosis applies to.
 *
 * Every other ending is left exactly as it was: a baseline that could not be
 * executed (a setup failure, a command that could not be launched, a missing
 * host tool), a cancellation, an expired limit, an incomplete round, a
 * continuation that started red — which may proceed to its coding turn, by
 * contract — and a workspace whose own attempt record could not be written all
 * keep their existing outcomes.
 */
export function completedRedBaseline(
  run: RunTaskResult,
): run is RunTaskResult & { readonly baseline: CheckRoundResult } {
  return (
    run.status === 'failed' &&
    run.timeout === null &&
    run.cancellation === null &&
    run.workspace !== null &&
    run.workspace.continued !== true &&
    run.attempts.length === 0 &&
    run.baseline !== null &&
    run.baseline.outcome === 'failed'
  );
}
