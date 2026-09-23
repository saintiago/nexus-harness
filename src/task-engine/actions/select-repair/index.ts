import type { BoundAction } from '../../index.js';
import { createArtifactHelpers } from '../artifacts.js';
import { devArtifact, type DevelopmentOutput } from '../develop/artifacts.js';
import { reviewArtifact, type ReviewOutput } from '../review/artifacts.js';
import { verificationArtifact, type VerificationOutput } from '../verify/artifacts.js';
import { repairArtifact, type RepairOutput } from './artifacts.js';

/**
 * SelectRepair applies the configured repair allowance and profile escalation to the failed
 * implementation round. A failed development report, a failed verification of the current revision
 * or a review requesting changes on it is a repair trigger; an operational exception or an
 * inconclusive review is not. The decision is derived from the round's development reports, so
 * repeated evaluation of unchanged reports produces the same decision and empty rounds or selected
 * but unexecuted repairs consume no allowance.
 */

/** One configured developer profile and the repair turns it allows. */
export type DeveloperProfileAllowance = {
  readonly profile: string;
  readonly repairAllowance: number;
};

export type SelectRepairSettings = {
  /** The workspace reference the current selection retains. */
  readonly workspace: { readonly root: string };
  /** The developer ladder in escalation order. */
  readonly developerLadder: readonly DeveloperProfileAllowance[];
};

/** The decision without its counter; selectRepair adds the count of executed repair turns. */
type RepairChoice = Pick<RepairOutput, 'decision' | 'profile' | 'reason'>;

/**
 * Whether the current round needs a repair. A verification or review result for another revision
 * is not a trigger for this development revision.
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
  if (
    review !== null &&
    review.verdict === 'changesRequested' &&
    review.headRevision === development.headRevision
  ) {
    return true;
  }
  return false;
}

/**
 * Apply the configured ladder to the repair turns already executed: continue the current profile
 * while its allowance remains, then escalate to the next configured profile.
 */
function policyChoice(
  ladder: readonly DeveloperProfileAllowance[],
  repairsUsed: number,
  currentProfile: string,
): RepairChoice {
  let index = repairsUsed;
  for (const entry of ladder) {
    if (index < entry.repairAllowance) {
      return {
        decision: 'selected',
        profile: entry.profile,
        reason:
          entry.profile === currentProfile
            ? `The repair continues with profile "${entry.profile}", whose allowance of ` +
              `${entry.repairAllowance} covers repair turn ${repairsUsed + 1}.`
            : `Profile "${currentProfile}" has no allowance remaining; the repair escalates to ` +
              `profile "${entry.profile}", whose allowance of ${entry.repairAllowance} covers ` +
              `repair turn ${repairsUsed + 1}.`,
      };
    }
    index -= entry.repairAllowance;
  }
  return {
    decision: 'exhausted',
    profile: null,
    reason:
      `The configured repair policy is exhausted after ${repairsUsed} ` +
      `repair${repairsUsed === 1 ? '' : 's'}: ` +
      `${ladder.map((entry) => `"${entry.profile}" allows ${entry.repairAllowance}`).join(', ')}.`,
  };
}

/** Create SelectRepair over the workspace's round history and the configured developer ladder. */
export function createSelectRepair(settings: SelectRepairSettings): BoundAction {
  return async () => {
    const helpers = createArtifactHelpers(settings.workspace);
    const [development] = await helpers.readInputArtifacts(devArtifact);
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

    // The initial implementation is not a repair; every earlier-round development report is a
    // completed repair turn. A selected repair that has not produced a report consumes no
    // allowance, and empty rounds produce no report.
    const earlierReports = await helpers.readArtifactHistory(devArtifact);
    const repairsUsed = earlierReports.length;
    const choice = policyChoice(settings.developerLadder, repairsUsed, development.profile);
    const output: RepairOutput = { ...choice, repairsUsed };
    await helpers.writeOutputArtifact(repairArtifact, output);
    return output.decision;
  };
}
