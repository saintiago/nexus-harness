import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
import { createArtifactHelpers, type ArtifactHistoryValue } from '../artifacts.js';
import { devArtifact, type DevelopmentOutput } from '../develop/artifacts.js';
import { readRecord, writeRecord } from '../records.js';
import { reviewArtifact, type ReviewOutput } from '../review/artifacts.js';
import { verificationArtifact, type VerificationOutput } from '../verify/artifacts.js';
import { currentRoundDeclaration, currentRoundFile } from './artifacts.js';

/**
 * StartRound plans and opens an implementation round. It reads the current round's results and the
 * earlier rounds' development reports and reviews, selects the developer profile Develop must use,
 * creates the next round's artifact directory and saves the profile with its reason as the new
 * current-round record. A later invocation requires a same-revision repair trigger; exhaustion
 * opens no round and publishes its reason.
 *
 * A missing record means no round has started in this workspace; a present but unreadable or
 * invalid record is an error. Earlier round directories and any existing next directory are
 * retained in place as history.
 */

/** One configured developer profile and the executed repair turns it allows. */
export type DeveloperProfileAllowance = {
  /** The configured developer profile. */
  readonly profile: string;
  /** The number of executed repair turns this profile allows. */
  readonly repairAllowance: number;
};

export type StartRoundSettings = {
  /** The selected task key the round belongs to. */
  readonly taskKey: string;
  /** The workspace reference the current selection retains. */
  readonly workspace: { readonly root: string };
  /** The developer ladder in increasing capability order. */
  readonly developerLadder: readonly DeveloperProfileAllowance[];
  readonly publish: EventPublisher;
};

/** The next round's plan, or the exhausted policy with the reason to publish. */
type RoundPlan =
  | {
      readonly kind: 'open';
      readonly number: number;
      readonly profile: string;
      readonly reason: string;
    }
  | { readonly kind: 'exhausted'; readonly reason: string };

/** Everything the policy reads from the retained rounds, plus the current round's trigger. */
type PlanningEvidence = {
  /** The developer ladder in increasing capability order. */
  readonly ladder: readonly DeveloperProfileAllowance[];
  /** The retained development reports of this round and every earlier round, in round order. */
  readonly reports: readonly ArtifactHistoryValue<DevelopmentOutput>[];
  /** The retained review results of this round and every earlier round, in round order. */
  readonly reviews: readonly ArtifactHistoryValue<ReviewOutput>[];
  /** The current round's number. */
  readonly currentRound: number;
  /** Whether the current repair trigger is the current round's changes-requested review. */
  readonly reviewTrigger: boolean;
};

/**
 * Whether the current development result needs a repair: a failed report, a failed verification or
 * a changes-requested review of that report's revision. A result for another revision or an
 * inconclusive review is not a repair trigger.
 */
function hasRepairTrigger(
  development: DevelopmentOutput,
  verification: VerificationOutput | null,
  review: ReviewOutput | null,
): boolean {
  if (development.status === 'failed') {
    return true;
  }
  if (
    verification !== null &&
    verification.status === 'failed' &&
    verification.headRevision === development.headRevision
  ) {
    return true;
  }
  return (
    review !== null &&
    review.verdict === 'changesRequested' &&
    review.headRevision === development.headRevision
  );
}

/** The executed repair turns per profile: the development reports in rounds after the first. */
function repairTurns(
  reports: readonly ArtifactHistoryValue<DevelopmentOutput>[],
): ReadonlyMap<string, number> {
  const turns = new Map<string, number>();
  for (const { number, value } of reports) {
    // The initial implementation is not a repair; an unrun round produces no report at all.
    if (number === 1) {
      continue;
    }
    turns.set(value.profile, (turns.get(value.profile) ?? 0) + 1);
  }
  return turns;
}

/**
 * The changes-requested streak and the round whose review produced its latest increment. Each
 * reviewed head counts once in round order within the task/PR lifecycle, so a repeated publication
 * or a duplicate review of the same head is not a new rejection. An approval resets the streak;
 * other verdicts leave it unchanged.
 */
function rejectionStreak(reviews: readonly ArtifactHistoryValue<ReviewOutput>[]): {
  readonly streak: number;
  readonly latestRound: number | null;
} {
  let streak = 0;
  let latestRound: number | null = null;
  const reviewed = new Set<string>();
  for (const { number, value } of reviews) {
    if (reviewed.has(value.headRevision)) {
      continue;
    }
    reviewed.add(value.headRevision);
    if (value.verdict === 'changesRequested') {
      streak += 1;
      latestRound = number;
    } else if (value.verdict === 'approved') {
      streak = 0;
    }
  }
  return { streak, latestRound };
}

/** Why no further configured repair turn is available, naming the executed turns and allowances. */
function exhaustedReason(
  ladder: readonly DeveloperProfileAllowance[],
  reports: readonly ArtifactHistoryValue<DevelopmentOutput>[],
): string {
  const repairs = reports.filter((report) => report.number > 1).length;
  const allowances = ladder
    .map((entry) => `"${entry.profile}" allows ${entry.repairAllowance}`)
    .join(', ');
  return (
    `No profile at or above the current position has a remaining repair allowance after ` +
    `${repairs} executed repair turn${repairs === 1 ? '' : 's'}: ${allowances}.`
  );
}

/**
 * Select the next round's profile and state why: continue the strongest profile already used for a
 * repair while its allowance remains, advance one ladder entry when a distinct changes-requested
 * review brings the streak to an even count, then advance past every profile whose executed repair
 * turns reached its allowance. Advancement that passes the strongest entry exhausts the policy.
 */
function planNextRound(evidence: PlanningEvidence): RoundPlan {
  const { ladder, reports, reviews, currentRound, reviewTrigger } = evidence;
  const turns = repairTurns(reports);
  const positions = [...turns.keys()]
    .map((profile) => ladder.findIndex((entry) => entry.profile === profile))
    .filter((index) => index >= 0);
  // The strongest profile used for an executed repair, or the initial ladder profile when no
  // repair has run. A weaker profile is never selected again.
  let candidate = positions.length === 0 ? 0 : Math.max(...positions);

  const { streak, latestRound } = rejectionStreak(reviews);
  // Promotion needs the distinct changes-requested review that made the streak even: a failed
  // report or check, a duplicate review of an already reviewed head and an odd streak never promote.
  const promotion = reviewTrigger && latestRound === currentRound && streak > 0 && streak % 2 === 0;
  if (promotion && candidate + 1 < ladder.length) {
    candidate += 1;
  }

  let selected = candidate;
  let entry = ladder[selected];
  while (entry !== undefined && (turns.get(entry.profile) ?? 0) >= entry.repairAllowance) {
    selected += 1;
    entry = ladder[selected];
  }
  if (entry === undefined) {
    return { kind: 'exhausted', reason: exhaustedReason(ladder, reports) };
  }

  const previous = selected > candidate ? ladder[candidate] : undefined;
  const used = turns.get(entry.profile) ?? 0;
  const reason =
    previous !== undefined
      ? `Profile "${previous.profile}" has no repair allowance remaining; the repair advances ` +
        `to profile "${entry.profile}".`
      : promotion
        ? `The changes-requested streak reached ${streak}; the repair promotes to profile ` +
          `"${entry.profile}".`
        : used === 0
          ? `The repair continues with the initial profile "${entry.profile}", whose allowance ` +
            `of ${entry.repairAllowance} covers repair turn 1.`
          : `The repair continues with profile "${entry.profile}", which has executed ${used} of ` +
            `its ${entry.repairAllowance} allowed repair turns.`;
  return { kind: 'open', number: currentRound + 1, profile: entry.profile, reason };
}

/** Create StartRound over the workspace whose rounds it numbers. */
export function createStartRound(settings: StartRoundSettings): BoundAction {
  return async () => {
    const root = settings.workspace.root;
    const recordFile = path.join(root, currentRoundFile);
    const current = await readRecord(recordFile, currentRoundDeclaration);

    /**
     * Create the round directory and replace the current-round pointer. Every policy read and
     * decision has completed before this runs.
     */
    async function openRound(number: number, profile: string, reason: string): Promise<'started'> {
      await mkdir(path.join(root, 'artifacts', String(number)), { recursive: true });
      await mkdir(path.join(root, 'state'), { recursive: true });
      await writeRecord(recordFile, { number, profile, reason });
      settings.publish(
        actionOutcomeEvent('start-round', {
          task: settings.taskKey,
          round: number,
          outcome: 'started',
          detail: `profile ${profile}`,
          artifact: { path: recordFile },
        }),
      );
      return 'started';
    }

    if (current === null) {
      const first = settings.developerLadder[0];
      if (first === undefined) {
        throw new Error('The configured developer ladder contains no developer profile.');
      }
      return await openRound(
        1,
        first.profile,
        `The initial implementation uses the first profile "${first.profile}" of the configured ` +
          'developer ladder.',
      );
    }

    const helpers = createArtifactHelpers({ root });
    const [development] = await helpers.readOptionalInputArtifacts(devArtifact);
    if (development === null) {
      // The round was planned but never ran development: reuse its plan and advance nothing.
      return await openRound(current.number, current.profile, current.reason);
    }

    const [verification, review] = await helpers.readOptionalInputArtifacts(
      verificationArtifact,
      reviewArtifact,
    );
    if (!hasRepairTrigger(development, verification, review)) {
      throw new Error(
        'No repair trigger exists for the current development revision; the development result ' +
          'is complete and no verification or review failed for it.',
      );
    }

    // The retained reports and reviews of this round and every earlier round, in round order.
    const reports = [
      ...(await helpers.readArtifactHistory(devArtifact)),
      { number: current.number, value: development },
    ];
    const reviews = [
      ...(await helpers.readArtifactHistory(reviewArtifact)),
      ...(review === null ? [] : [{ number: current.number, value: review }]),
    ];
    const reviewTrigger =
      review !== null &&
      review.verdict === 'changesRequested' &&
      review.headRevision === development.headRevision;
    const plan = planNextRound({
      ladder: settings.developerLadder,
      reports,
      reviews,
      currentRound: current.number,
      reviewTrigger,
    });
    if (plan.kind === 'exhausted') {
      settings.publish({ source: 'start-round', type: 'exhausted', data: { reason: plan.reason } });
      return 'exhausted';
    }
    return await openRound(plan.number, plan.profile, plan.reason);
  };
}
