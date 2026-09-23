import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BoundAction } from '../../index.js';
import { readRecord, writeRecord } from '../records.js';
import { currentRoundDeclaration, currentRoundFile } from './artifacts.js';

/**
 * StartRound creates the next round's artifact directory and persists its number as the current
 * round. The record sits beside the round directories so it can be read before they are resolved.
 *
 * A missing record means no round has started in this workspace; a present but unreadable or
 * invalid record is an error. Earlier round directories and any existing next directory are
 * retained in place as history.
 */

export type StartRoundSettings = {
  /** The workspace reference the current selection retains. */
  readonly workspace: { readonly root: string };
};

/** Create StartRound over the workspace whose rounds it numbers. */
export function createStartRound(settings: StartRoundSettings): BoundAction {
  return async () => {
    const root = settings.workspace.root;
    const recordFile = path.join(root, currentRoundFile);
    const current = await readRecord(recordFile, currentRoundDeclaration);
    const number = (current?.number ?? 0) + 1;

    await mkdir(path.join(root, 'artifacts', String(number)), { recursive: true });
    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeRecord(recordFile, { number });
    return 'started';
  };
}
