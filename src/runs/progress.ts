/**
 * How the run's timeline and its reasons word what happened: turn names, round
 * descriptions, counts, and the one-line forms the timeline holds.
 *
 * Wording only. The decisions live in the loop (runner.ts) and in how a run ends
 * (finalize.ts); this module never reads a working copy, runs a command, or
 * writes a file.
 */
import { commandSucceeded } from '../checks/round.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CancellationEvidence,
  ChangedPath,
  CheckRoundResult,
  HarnessConfig,
  TimeoutEvidence,
} from '../shared/types.js';
import type { AgentTurnShutdown } from './contracts.js';

/**
 * A problem, or any other text, as the single line the timeline holds. Problems
 * from the helpers can span several lines; the timeline keeps the first line,
 * which is the one naming what went wrong, and the report keeps the full text.
 */
export function oneLine(text: string): string {
  const [first = ''] = text.split('\n');
  const trimmed = first.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? text.replace(/\s+/g, ' ').trim() : trimmed;
}

/** `1 check`, `2 checks`: a count in the timeline and the reasons reads as prose. */
export function count(amount: number, singular: string): string {
  return `${amount} ${amount === 1 ? singular : `${singular}s`}`;
}

/** The plan a round is about to run, as the timeline names it. */
export function describePlan(config: HarnessConfig): string {
  return `${count(config.setup.length, 'setup command')}, ${count(config.checks.length, 'check')}`;
}

/** How many checks were observed not to succeed, out of those that were run. */
export function describeFailedChecks(round: CheckRoundResult): string {
  const failed = round.checks.filter((result) => !commandSucceeded(result)).length;
  return `${failed} of ${count(round.checks.length, 'check')} did not pass`;
}

/** How the timeline names one top-level coding turn. */
export function nameTurn(kind: AttemptKind, turn: number): string {
  return kind === 'implementation' ? 'implementation turn' : `repair turn ${String(turn)}`;
}

/** How the reasons name one top-level coding turn, in a sentence. */
export function describeTurn(kind: AttemptKind, turn: number): string {
  return kind === 'implementation' ? 'the implementation turn' : nameTurn(kind, turn);
}

/** How many repair turns the attempts so far have spent. */
export function repairsSpent(attempts: readonly AttemptEvidence[]): number {
  return attempts.filter((attempt) => attempt.kind === 'repair').length;
}

/** Why a run that ends green ended where it did, with the allowance it spent. */
export function describePassed(
  kind: AttemptKind,
  turn: number,
  spent: number,
  allowed: number,
): string {
  return kind === 'implementation'
    ? `every configured check passed after ${describeTurn(kind, turn)}`
    : `every configured check passed after ${describeTurn(kind, turn)} (${String(spent)} of ${String(allowed)} repair turns used)`;
}

/** What a completed round did, as the timeline records it. */
export function describeRound(round: CheckRoundResult): string {
  if (round.outcome === 'passed') {
    return 'passed';
  }
  if (round.outcome === 'failed') {
    return `failed, ${round.checks.filter(commandSucceeded).length} of ${count(round.checks.length, 'check')} passed`;
  }
  return `execution-error, ${oneLine(round.problem ?? 'no explanation was recorded')}`;
}

/** How the timeline names the limit that expired. */
export function describeTimeoutLimit(evidence: TimeoutEvidence): string {
  return evidence.limit === 'task'
    ? `the run's task deadline (${String(evidence.limitMs)} ms)`
    : `a configured command limit (${String(evidence.limitMs)} ms)`;
}

/** Why a run whose limit expired during a round of checks ended there. */
export function describeRoundTimeout(phase: string, evidence: TimeoutEvidence): string {
  const what =
    evidence.limit === 'task'
      ? "the run's task deadline expired"
      : 'a configured command was stopped at its limit';
  const stopped =
    evidence.termination === 'confirmed'
      ? 'nothing further was started'
      : 'the stop could not be confirmed, so the working copy must not be reused and nothing further was started';
  return `${what} during ${phase}: ${stopped}`;
}

/** Why a run whose caller stopped it during a round of checks ended there. */
export function describeRoundCancelled(evidence: CancellationEvidence): string {
  const stopped =
    evidence.termination === 'confirmed'
      ? 'nothing further was started'
      : 'the stop could not be confirmed, so the working copy must not be reused and nothing further was started';
  return `the run was stopped by its caller during ${evidence.phase}: ${stopped}`;
}

/** What an unconfirmed stop is told the harness knows, when it recorded no reason. */
export const NO_TERMINATION_REASON = 'the harness recorded no reason for the unconfirmed stop';

/**
 * Why a coding turn's own stop of the execution it started cannot be read as a
 * clean one, or `null` when that stop was confirmed or nothing was stopped.
 *
 * A turn that stopped what it had started and could not confirm the end of it
 * leaves a working copy that may still be written to. That is never rounded down
 * to a confirmed stop, in a report or in the reason a run ends with
 * (docs/spec.md §3).
 */
export function unconfirmedShutdownProblem(shutdown: AgentTurnShutdown | null): string | null {
  return shutdown?.termination === 'unconfirmed'
    ? (shutdown.problem ?? NO_TERMINATION_REASON)
    : null;
}

/** The clause a reason carries for a turn whose own stop could not be confirmed. */
export function shutdownNote(problem: string | null): string {
  return problem === null
    ? ''
    : `; the harness could not confirm that everything the coding runtime started had ended (${oneLine(problem)}), so the working copy may still be written to`;
}

/**
 * One changed path, as the run timeline lists it: what happened to it, where the
 * difference was seen, and — for the three categories a reviewer has to look at
 * first — why it is worth a look. The path is squeezed onto one line, because the
 * timeline holds one line per state change; the report keeps the path exactly as
 * Git reported it.
 */
export function describeChangedPath(entry: ChangedPath): string {
  const file = entry.path.replace(/\s+/g, ' ').trim();
  const review =
    entry.categories.length === 0 ? '' : ` - ${entry.categories.join('/')}: review this change`;
  return `${file} (${entry.kind}, ${entry.states.join(', ')})${review}`;
}
