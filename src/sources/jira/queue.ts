/** Authoritative queue recovery before a fresh claim; no local queue state. */
import type { JiraSourceConfig } from '../../shared/types.js';
import type { QueueRecovery } from '../../queue/loop.js';
import { SourceError, WORKSPACE_POINTER_PREFIX } from '../contract.js';
import type { HttpClient } from './http.js';
import { isEligible, readIssue, refFor, sameName } from './issue.js';
import { listEligibleIssues } from './search.js';

export async function discoverQueueWork(
  config: JiraSourceConfig,
  http: HttpClient,
  stop: AbortSignal,
): Promise<QueueRecovery | null> {
  const active = new Map<string, QueueRecovery>();
  const repairs = new Map<string, QueueRecovery>();
  for (const status of [config.runningStatus, config.reviewStatus, config.readyStatus]) {
    const candidates = await listEligibleIssues({ ...config, readyStatus: status }, http, stop);
    for (const candidate of candidates) {
      const issue = await readIssue(http, candidate.ref.id, stop);
      if (issue === null) {
        throw new SourceError(
          'fatal',
          `${candidate.ref.key}: cannot read queue ownership; inspect Jira before retrying`,
        );
      }
      const fields = issue.fields;
      active.delete(issue.id);
      repairs.delete(issue.id);
      if (!isEligible({ ...config, readyStatus: fields.status }, fields)) continue;
      const ticket = { ref: refFor(config, issue), title: fields.summary };
      if (sameName(fields.status, config.runningStatus)) {
        throw new SourceError(
          'fatal',
          `${issue.key}: still ${config.runningStatus}; inspect and stop its existing consumer before returning it to ${config.readyStatus}. No unrelated ticket was claimed.`,
        );
      }
      if (sameName(fields.status, config.reviewStatus)) {
        active.set(issue.id, { ticket, phase: 'review' });
      } else if (
        sameName(fields.status, config.readyStatus) &&
        fields.labels.some((label) => label.startsWith(WORKSPACE_POINTER_PREFIX))
      ) {
        repairs.set(issue.id, { ticket, phase: 'repair' });
      }
    }
  }
  if (active.size > 1) {
    throw new SourceError(
      'fatal',
      `Multiple In Review tickets need attention: ${[...active.values()].map(({ ticket }) => ticket.ref.key).join(', ')}. Resolve ownership before starting the queue.`,
    );
  }
  // A delivered ticket must finish before ready work, including older repairs.
  // Ready repairs retain Jira's native order; no candidate is reserved here.
  return active.values().next().value ?? repairs.values().next().value ?? null;
}
