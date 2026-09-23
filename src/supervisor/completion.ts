/**
 * Whether the ticket a blocker plan ranked ahead of the interrupted work has
 * really reached the connected project's configured done status.
 *
 * A worker that settles proves nothing about the ticket it was scoped to: a
 * scoped `queue run --ticket <KEY>` reports `completed` with nothing completed
 * when its ticket is not in a status the queue carries, so a plan that advanced
 * on that exit code would resume the interrupted work behind a blocker that
 * never ran. The evidence that advances a plan is therefore read from the
 * ticket itself — one read-only Jira read, no transition and no claim — and
 * only the configured done status is completion: a ticket somewhere else is not
 * complete, and a ticket that cannot be read is not assumed either.
 *
 * This is the supervisor's own gate and nothing else. It decides nothing about
 * the work itself: what makes a ticket *complete* stays the completion path's
 * verified merge and post-merge workflows, and this read only asks whether that
 * already happened (docs/WORKFLOW.md §12).
 */
import { messageOf } from '../shared/errors.js';
import type { HttpClient } from '../sources/jira/http.js';
import { readIssue, sameName } from '../sources/jira/issue.js';

/** What the connected project says about one ticket's completion. */
export type BlockerCompletionTake =
  | { readonly kind: 'completed'; readonly detail: string }
  | { readonly kind: 'not-completed'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly problem: string };

/**
 * Reads one ticket's completion. The read is the documented issue read of the
 * connector, so the status it reports is the one the queue itself would see; an
 * issue that is gone is not complete, and a read that failed is reported as
 * unknown rather than as either answer.
 */
export async function readTicketCompletion(request: {
  readonly http: HttpClient;
  readonly key: string;
  readonly doneStatus: string;
  readonly stop: AbortSignal;
}): Promise<BlockerCompletionTake> {
  let issue;
  try {
    issue = await readIssue(request.http, request.key, request.stop);
  } catch (cause) {
    return {
      kind: 'unknown',
      problem: `the ticket ${request.key} could not be read (${messageOf(cause)})`,
    };
  }
  if (issue === null) {
    return {
      kind: 'not-completed',
      detail: `${request.key} does not exist in the connected project, so it never reached ${request.doneStatus}`,
    };
  }
  const status = issue.fields.status;
  return sameName(status, request.doneStatus)
    ? {
        kind: 'completed',
        detail: `${request.key} is in the configured done status "${request.doneStatus}"`,
      }
    : {
        kind: 'not-completed',
        detail: `${request.key} is in "${status}", not the configured done status "${request.doneStatus}"`,
      };
}
