/**
 * The failure feedback a repair turn is given: the checks a completed red round
 * observed not to succeed, with the output each of them wrote.
 *
 * Only a completed red round becomes feedback. A round that could not be
 * executed is an infrastructure failure, so no repair turn is given it.
 */
import { commandSucceeded } from '../checks/round.js';
import { readCommandOutput } from '../reporting/logs.js';
import type { CheckRoundResult, FailedCommand } from '../shared/types.js';

/**
 * What a completed red round observed not to succeed, with the output each of
 * those commands wrote, as a repair turn is given it.
 *
 * Only a completed red round reaches a repair turn, and such a round ran every
 * check and every setup command successfully — a setup command that did not
 * succeed, and a command that could not be started, would have stopped the round
 * as an execution error instead — so the failures are the checks that did not
 * exit `0`.
 */
export async function failedCommands(round: CheckRoundResult): Promise<FailedCommand[]> {
  const failures: FailedCommand[] = [];
  for (const result of round.checks) {
    if (!commandSucceeded(result)) {
      failures.push({ result, output: await readCommandOutput(result) });
    }
  }
  return failures;
}
