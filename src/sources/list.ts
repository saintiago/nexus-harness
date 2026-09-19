/**
 * The read-only `source list` preview: the eligible items, their disposition,
 * and nothing else.
 *
 * It reads existing receipts, but it does not create a directory, take a lock,
 * claim anything, or start a run, so an item it shows as valid is still waiting
 * (docs/WORKFLOW.md section 7).
 */
import type { SourceRef } from '../shared/types.js';
import type { SourcePreview } from './contract.js';
import { SourceError } from './contract.js';
import { decideAttempt } from './eligibility.js';
import { readReceipt, receiptFilePath } from './receipts.js';

/** One entry of a read-only preview. */
export interface SourceListEntry {
  readonly disposition: 'valid' | 'continuable' | 'invalid' | 'stale' | 'refused';
  readonly ref: SourceRef;
  readonly title: string;
  /** What the harness would do with the item, or why it will not act on it. */
  readonly detail: string;
}

/**
 * The read-only preview: eligible items, their disposition, and nothing else. It
 * reads existing receipts, but it does not create a directory, take a lock,
 * claim anything, or start a run, so an item it shows as valid is still waiting
 * (docs/WORKFLOW.md §7).
 */
export async function listSource(preview: SourcePreview): Promise<readonly SourceListEntry[]> {
  const candidates = await preview.source.listEligible(preview.stop);
  const entries: SourceListEntry[] = [];

  for (const candidate of candidates) {
    const receipt = await readReceipt(receiptFilePath(preview.workDir, candidate.ref));
    const decision = await decideAttempt(preview.workDir, candidate, receipt);
    if (decision.kind === 'refuse') {
      entries.push({
        disposition: 'refused',
        ref: candidate.ref,
        title: candidate.title,
        detail: decision.reason,
      });
      continue;
    }

    try {
      const prepared = await preview.source.prepare(candidate, preview.stop);
      entries.push(
        prepared === null
          ? {
              disposition: 'stale',
              ref: candidate.ref,
              title: candidate.title,
              detail: 'no longer eligible at the time of the preview',
            }
          : decision.kind === 'continue'
            ? {
                disposition: 'continuable',
                ref: prepared.ref,
                title: prepared.task.title,
                detail:
                  `continues workspace ${decision.workspace.workspaceId} ` +
                  `(attempt ${String(decision.workspace.attempt)})`,
              }
            : {
                disposition: 'valid',
                ref: prepared.ref,
                title: prepared.task.title,
                detail: 'valid and unattempted: this run would create its workspace',
              },
      );
    } catch (cause) {
      if (cause instanceof SourceError && cause.kind === 'invalid-task') {
        entries.push({
          disposition: 'invalid',
          ref: candidate.ref,
          title: candidate.title,
          detail: cause.message,
        });
        continue;
      }
      throw cause;
    }
  }

  return entries;
}
