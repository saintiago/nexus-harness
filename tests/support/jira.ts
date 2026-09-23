import type {
  JiraAdapter,
  JiraComment,
  JiraDocument,
  JiraFieldUpdates,
  JiraIssue,
  JiraIssueIdentity,
  JiraIssueQuery,
  JiraRankTarget,
  JiraTransition,
} from '../../src/adapters/jira.js';
import type { Result } from '../../src/result.js';

/**
 * A controlled Jira adapter for action tests: the supplied operations answer the calls under test
 * and every other call fails the test. Recorded calls let a test assert the operations and their
 * arguments without reaching a live Jira site.
 */

/** The operations a test supplies. Answering is synchronous or asynchronous. */
export type JiraOperations = {
  searchIssues?(
    selection: JiraIssueQuery,
  ): Result<readonly JiraIssueIdentity[]> | Promise<Result<readonly JiraIssueIdentity[]>>;
  readIssue?(issueId: string): Result<JiraIssue> | Promise<Result<JiraIssue>>;
  readComments?(
    issueId: string,
  ): Result<readonly JiraComment[]> | Promise<Result<readonly JiraComment[]>>;
  readTransitions?(
    issueId: string,
  ): Result<readonly JiraTransition[]> | Promise<Result<readonly JiraTransition[]>>;
  updateFields?(issueId: string, fields: JiraFieldUpdates): Result<void> | Promise<Result<void>>;
  transitionIssue?(issueId: string, transitionId: string): Result<void> | Promise<Result<void>>;
  addComment?(issueId: string, body: JiraDocument): Result<JiraComment>;
  editComment?(issueId: string, commentId: string, body: JiraDocument): Result<JiraComment>;
  createIssue?(fields: Readonly<Record<string, unknown>>): Result<JiraIssueIdentity>;
  rankIssue?(issueId: string, target: JiraRankTarget): Result<void>;
};

/** A controlled adapter with the call it received for each unsupplied operation. */
export function scriptedJira(operations: JiraOperations): {
  readonly jira: JiraAdapter;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const unexpected = (operation: string): never => {
    throw new Error(`Unexpected Jira operation: ${operation}`);
  };
  const jira: JiraAdapter = {
    async searchIssues(selection) {
      calls.push(`search:${selection.query} order by ${selection.orderBy}`);
      return operations.searchIssues
        ? await operations.searchIssues(selection)
        : unexpected('searchIssues');
    },
    async readIssue(issueId) {
      calls.push(`read:${issueId}`);
      return operations.readIssue ? await operations.readIssue(issueId) : unexpected('readIssue');
    },
    async readComments(issueId) {
      calls.push(`comments:${issueId}`);
      return operations.readComments
        ? await operations.readComments(issueId)
        : unexpected('readComments');
    },
    async readTransitions(issueId) {
      calls.push(`transitions:${issueId}`);
      return operations.readTransitions
        ? await operations.readTransitions(issueId)
        : unexpected('readTransitions');
    },
    async updateFields(issueId, fields) {
      calls.push(`update:${issueId}:${JSON.stringify(fields)}`);
      return operations.updateFields
        ? await operations.updateFields(issueId, fields)
        : unexpected('updateFields');
    },
    async transitionIssue(issueId, transitionId) {
      calls.push(`transition:${issueId}:${transitionId}`);
      return operations.transitionIssue
        ? await operations.transitionIssue(issueId, transitionId)
        : unexpected('transitionIssue');
    },
    async addComment(issueId, body) {
      calls.push(`addComment:${issueId}`);
      return operations.addComment
        ? operations.addComment(issueId, body)
        : unexpected('addComment');
    },
    async editComment(issueId, commentId, body) {
      calls.push(`editComment:${issueId}:${commentId}`);
      return operations.editComment
        ? operations.editComment(issueId, commentId, body)
        : unexpected('editComment');
    },
    async createIssue(fields) {
      calls.push('createIssue');
      return operations.createIssue ? operations.createIssue(fields) : unexpected('createIssue');
    },
    async rankIssue(issueId, target) {
      calls.push(`rankIssue:${issueId}`);
      return operations.rankIssue ? operations.rankIssue(issueId, target) : unexpected('rankIssue');
    },
  };
  return { jira, calls };
}
