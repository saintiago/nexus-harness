import path from 'node:path';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../../index.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import { retainTerminalReason } from '../../terminal-reason.js';
import { stageReturnExhaustionFile, type PreparationStage } from '../artifacts.js';
import { readReturnCount, returnCountFile, stageRoot, writeReturnCount } from '../storage.js';

/**
 * RecordStageReturn counts one upstream return of the selected issue against the configured
 * stage allowance. Within the allowance it returns 'return'; a return that would exceed it
 * retains its reason and returns 'exhausted' instead, so exhaustion requests attention without
 * declaring the work unsuitable. The count is persisted in the stage area and survives restarts.
 */

export type RecordStageReturnSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /** The configured upstream-return allowance for one stage of one selection. */
  readonly maxUpstreamReturns: number;
  readonly publish: EventPublisher;
};

/** Create RecordStageReturn over the stage area it counts. */
export function createRecordStageReturn(settings: RecordStageReturnSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = stageRoot(selection.workspace.root, settings.stage);
    const count = (await readReturnCount(root)) + 1;
    if (count > settings.maxUpstreamReturns) {
      const reason =
        `The configured maximum of ${String(settings.maxUpstreamReturns)} upstream ` +
        `return${settings.maxUpstreamReturns === 1 ? '' : 's'} for the ${settings.stage} stage is ` +
        'reached; the retained findings request attention instead of another return.';
      await retainTerminalReason(path.join(root, stageReturnExhaustionFile), reason);
      settings.publish({ source: 'record-stage-return', type: 'exhausted', data: { reason } });
      return 'exhausted';
    }
    await writeReturnCount(root, count);
    settings.publish(
      actionOutcomeEvent('record-stage-return', {
        task: selection.taskKey,
        round: null,
        outcome: 'return',
        detail: `${settings.stage} · return ${String(count)}`,
        artifact: { path: path.join(root, returnCountFile) },
      }),
    );
    return 'return';
  };
}
