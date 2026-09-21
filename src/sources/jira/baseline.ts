/**
 * The Jira side of the pre-delivery baseline diagnosis: the item's own thread,
 * one comment, and one move out of the running status.
 *
 * It reads and writes an item freshly every time. The thread is where the
 * diagnosis's marker lives, so a repeated pass or a restart finds the comment it
 * already wrote instead of writing a second one, and the status move is made
 * only while the item really is still in the running status it was claimed into.
 */
import type { JiraSourceConfig } from '../../shared/types.js';
import type { BaselineRecord } from '../contract.js';
import { listIssueNotes, moveFromStatus, postIssueComment } from './completion.js';
import type { HttpClient } from './http.js';
import { readIssue, sameName } from './issue.js';

/**
 * The Jira operations one pre-delivery diagnosis needs, built once per source
 * command from the validated configuration and the resolved token. The token is
 * not a property of the returned object: it lives in the client's closure.
 */
export function createJiraBaselineRecord(
  config: JiraSourceConfig,
  http: HttpClient,
): BaselineRecord {
  return {
    listComments: (id, stop) => listIssueNotes(http, id, stop, http.token),
    postComment: (id, paragraphs, stop) => postIssueComment(http, id, paragraphs, stop),
    isRunning: async (id, stop) => {
      const issue = await readIssue(http, id, stop);
      return issue !== null && sameName(issue.fields.status, config.runningStatus);
    },
    moveFromRunning: (id, target, stop) =>
      moveFromStatus(http, id, config.runningStatus, target, stop),
  };
}
