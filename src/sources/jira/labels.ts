/**
 * The workspace pointer label on an issue: what it says, and the one write that
 * adds it.
 *
 * It is written exactly once, by the run that creates the workspace, after that
 * workspace exists and before any coding turn runs; a later attempt only reads
 * it. A write whose outcome is unknown is an uncertain-write and stops intake
 * rather than being sent again.
 */
import { workspacePointerLabel } from '../contract.js';
import type { SourceTask } from '../contract.js';
import type { HttpClient } from './http.js';

/**
 * Adds the workspace pointer label to one issue, once: the write that records
 * where an attempt's work lives, made by the run that creates the workspace and
 * never replayed.
 */
export async function recordWorkspacePointer(
  http: HttpClient,
  item: SourceTask,
  workspaceId: string,
  stop: AbortSignal,
): Promise<void> {
  await http.request({
    method: 'PUT',
    path: `/rest/api/3/issue/${encodeURIComponent(item.ref.id)}`,
    body: { update: { labels: [{ add: workspacePointerLabel(workspaceId) }] } },
    signal: stop,
    mutation: true,
  });
}
