import path from 'node:path';
import type { BoundAction } from '../../index.js';
import { createArtifactHelpers } from '../artifacts.js';
import { deliveryArtifact } from '../deliver/artifacts.js';
import { readUsableDevelopmentOutcome } from '../develop/artifacts.js';
import { readRecord, readRequiredRecord } from '../records.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { verificationArtifact } from '../verify/artifacts.js';

/**
 * Choose the initial finite child phase from producer-owned retained evidence. Snapshot restore
 * already preserves an interrupted active child's phase; this operation handles a new admission of
 * retained work without opening a new coding round for an already-delivered revision.
 */
export function createRouteDeliveryEntry(settings: {
  readonly selectionFile: string;
}): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const round = await readRecord(path.join(root, currentRoundFile), currentRoundDeclaration);
    if (round === null) return 'round';
    const helpers = createArtifactHelpers({ root });
    const development = await readUsableDevelopmentOutcome({
      areaRoot: root,
      taskKey: selection.taskKey,
      round: round.number,
      context: `Routing retained delivery for task ${selection.taskKey}.`,
    });
    if (development === null) return 'round';
    const [verification, delivery] = await helpers.readOptionalInputArtifacts(
      verificationArtifact,
      deliveryArtifact,
    );
    if (development.status === 'failed') return 'round';
    if (verification === null || verification.headRevision !== development.headRevision)
      return 'verify';
    if (verification.status === 'failed') return 'round';
    if (delivery === null || delivery.headRevision !== development.headRevision) return 'deliver';
    return 'review';
  };
}
