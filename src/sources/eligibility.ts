/**
 * What one discovered item is: a first attempt, a continuation of the workspace
 * its pointer label names, or something the harness will not act on.
 *
 * Nothing is created here. It reads the item as it was just prepared — the
 * pointer labels that read observed, never what a search result said earlier —
 * its receipt, and what exists on this machine; whether a checkout is still
 * usable is decided when the attempt opens it.
 */
import type { ContinuedWorkspace } from '../workspace/reopen.js';
import { resolveWorkspace, takenWorkspaceNameProblem } from '../workspace/reopen.js';
import { sourceItemFor } from '../workspace/state.js';
import { WORKSPACE_POINTER_PREFIX, workspacePointerLabel } from './contract.js';
import type { SourceTask } from './contract.js';
import type { SourceReceipt } from './receipts.js';

/** The receipt as a one-line summary for the terminal. */
function describeReceipt(receipt: SourceReceipt): string {
  const parts: string[] = [];
  parts.push(
    receipt.outcome === undefined ? 'reserved, no run recorded' : `run ${receipt.outcome}`,
  );
  if (receipt.runId !== undefined) {
    parts.push(receipt.runId);
  }
  if (receipt.feedback !== undefined) {
    parts.push(`feedback ${receipt.feedback}`);
  }
  if (receipt.problem !== undefined) {
    parts.push(receipt.problem);
  }
  return parts.join('; ');
}
/** What the coordinator will do with one discovered item, and why. */
type AttemptDecision =
  /** No pointer and no receipt: a first attempt, which creates its workspace. */
  | { readonly kind: 'fresh' }
  /** One pointer that resolves here: continue that workspace. */
  | { readonly kind: 'continue'; readonly workspace: ContinuedWorkspace }
  /** Something the harness will not act on, published as a refusal. */
  | { readonly kind: 'refuse'; readonly reason: string };

/**
 * Which of the three this item is (docs/implement-workspace-continuation.md).
 * Nothing is created here: this only reads the prepared item's pointer labels,
 * its receipt, and what exists on this machine.
 *
 * `sourceRoot` is the real root of the repository this run targets, when the
 * caller resolved one: a workspace whose ledger records another repository is
 * refused. `null` means the caller cannot check that dimension (the read-only
 * preview, which takes no `--repo`).
 */
export async function decideAttempt(
  workDir: string,
  item: SourceTask,
  receipt: SourceReceipt | null,
  sourceRoot: string | null,
): Promise<AttemptDecision> {
  const pointers = item.pointers;
  if (pointers.length > 1) {
    return {
      kind: 'refuse',
      reason:
        `it names ${String(pointers.length)} workspaces (${pointers.join(', ')}) and which one to ` +
        'continue cannot be guessed: leave exactly one pointer label on it',
    };
  }
  const [workspaceId] = pointers;
  if (workspaceId !== undefined) {
    const resolution = await resolveWorkspace(workDir, workspaceId, {
      sourceItem: sourceItemFor(item.ref),
      sourceRoot,
    });
    if (!resolution.ok) {
      return { kind: 'refuse', reason: resolution.problem };
    }
    // Reading the checkout itself is the attempt's job, not the preview's: this
    // decides from what exists on disk, and a workspace that is not on the branch
    // its ledger records is refused when the attempt opens it.
    return { kind: 'continue', workspace: resolution.workspace };
  }

  // No pointer: this is a first attempt, which would create a workspace. The
  // name the source prefers for it — a Jira ticket key — may already be held by
  // a workspace, and nothing here adopts one or overwrites it, not even for the
  // item its ledger records: the refusal names what is there and how to continue
  // it through a pointer label, or how to move it out of the way
  // (docs/implement-workspace-continuation.md).
  if (item.preferredWorkspaceId !== undefined) {
    const conflict = await takenWorkspaceNameProblem(
      workDir,
      item.preferredWorkspaceId,
      { sourceItem: sourceItemFor(item.ref), sourceRoot },
      workspacePointerLabel(item.preferredWorkspaceId),
    );
    if (conflict !== null) {
      return { kind: 'refuse', reason: conflict };
    }
  }

  if (receipt !== null) {
    return {
      kind: 'refuse',
      reason:
        `it was already attempted (${describeReceipt(receipt)}), and nothing names a workspace to ` +
        `continue: add a ${WORKSPACE_POINTER_PREFIX}<workspaceId> label to work in its workspace ` +
        'again, or create a new issue',
    };
  }
  return { kind: 'fresh' };
}
