/**
 * The one place the ticket conversation history is composed from concrete
 * connectors.
 *
 * The history module itself reads nothing remote: it is handed a Jira thread
 * reader and a pull request conversation reader here, and everything else it
 * does is local files. The Jira reader is the existing connector's own comment
 * read; the GitHub reader is the existing App client's conversation read, and
 * a project with no reviewer App configured gets an explicit gap instead of an
 * empty conversation presented as a complete one.
 */
import { readCommentThread } from '../sources/jira/comments.js';
import type { HttpClient } from '../sources/jira/http.js';
import type { GitHubReviewConfig, JiraSourceConfig, SourceRef } from '../shared/types.js';
import type {
  HistoryReaders,
  PullRequestConversationRead,
  ReadComment,
} from '../history/contract.js';
import { createTicketHistory } from '../history/sync.js';
import type { TicketHistory } from '../history/contract.js';
import type { ReviewRepository } from '../reviews/contract.js';
import { createGitHubReviewClient, resolveAppPrivateKey } from '../reviews/github.js';

/** Where the Jira thread is read from, when the project has a connection. */
export interface HistoryJiraParts {
  readonly http: HttpClient;
  readonly config: JiraSourceConfig;
  readonly token: string;
}

/**
 * Opens the reviewer App client the pull request conversation is read through,
 * on first use. A command that never prepares a snapshot never resolves the
 * key, and a credential that is missing or unusable becomes the gap the
 * snapshot names rather than a failure that stops a command which does not
 * review anything.
 */
export function lazyGitHubRepository(
  review: GitHubReviewConfig,
  parts: { readonly fetch?: typeof fetch } = {},
): () => Promise<ReviewRepository | null> {
  let opened: Promise<ReviewRepository | null> | null = null;
  return async () => {
    opened ??= (async () => {
      const privateKey = await resolveAppPrivateKey(review, process.env);
      return createGitHubReviewClient(review, privateKey, {
        ...(parts.fetch === undefined ? {} : { fetch: parts.fetch }),
        now: () => new Date(),
      });
    })();
    return await opened;
  };
}

/** The readers one connected project's history is built from. */
function readersFor(parts: {
  readonly jira: HistoryJiraParts;
  readonly openRepository?: () => Promise<ReviewRepository | null>;
  readonly observedAt: () => string;
}): HistoryReaders {
  return {
    jiraThread: async (ref, stop) => {
      const thread = await readCommentThread(
        parts.jira.http,
        parts.jira.token,
        ref.id,
        ref.key,
        stop,
      );
      const comments: ReadComment[] = thread.comments.map((comment) => ({
        sourceId: comment.id,
        author: comment.author,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        text: comment.text,
        url: `${ref.url}?focusedCommentId=${encodeURIComponent(comment.id)}`,
      }));
      return { comments, truncated: thread.truncated };
    },

    pullRequestConversation: async (
      ref: SourceRef,
      workspaceId: string,
      stop: AbortSignal,
    ): Promise<PullRequestConversationRead | null> => {
      if (parts.openRepository === undefined) {
        throw new Error(
          'this project has no configured reviewer App, so its pull request conversation ' +
            `cannot be read by the harness for ${ref.key}; its Jira thread is still complete`,
        );
      }
      const repository = await parts.openRepository();
      if (repository === null || repository.readConversation === undefined) {
        throw new Error(
          'the configured GitHub App could not be used to read the pull request conversation; ' +
            `its Jira thread is still complete`,
        );
      }
      const pullRequest = await repository.findOpenPullRequest(`harness/${workspaceId}`, stop);
      if (pullRequest === null) {
        return { pullRequest: null, comments: [], truncated: false };
      }
      const conversation = await repository.readConversation(pullRequest.number, stop);
      const comments: ReadComment[] = conversation.entries.map((entry) => ({
        sourceId: String(entry.id),
        author: entry.login,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        text:
          entry.path === null
            ? entry.body
            : `${entry.path}${entry.line === null ? '' : `:${String(entry.line)}`} — ${entry.body}`,
        url: entry.url,
        ...(entry.state === null ? {} : { state: entry.state }),
        commit: entry.commitId,
        path: entry.path,
        line: entry.line,
        body: entry.body,
        reviewId: entry.reviewId,
        inReplyToId: entry.inReplyToId,
      }));
      return {
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
          title: pullRequest.title,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          headSha: pullRequest.headSha,
          observedAt: parts.observedAt(),
        },
        comments,
        truncated: conversation.truncated,
      };
    },
  };
}

/**
 * The ticket history one connected project uses: the same object is handed to
 * the coding coordinator and to the review scan, so both roles prepare their
 * snapshots with the same organization and the same local paths.
 */
export function createConfiguredHistory(parts: {
  readonly workDir: string;
  readonly jira: HistoryJiraParts;
  /**
   * Opens the GitHub App client the pull request conversation is read through.
   * It is opened on first use so a command that never prepares a snapshot never
   * resolves the credential; a failure becomes an explicit gap in the snapshot,
   * never an empty conversation presented as a complete one. Absent means the
   * project has no reviewer App configured.
   */
  readonly openRepository?: () => Promise<ReviewRepository | null>;
  readonly login: string | null;
  readonly now?: () => Date;
}): TicketHistory {
  const now = parts.now ?? ((): Date => new Date());
  return createTicketHistory({
    workDir: parts.workDir,
    readers: readersFor({
      jira: parts.jira,
      ...(parts.openRepository === undefined ? {} : { openRepository: parts.openRepository }),
      observedAt: () => now().toISOString(),
    }),
    ...(parts.login === null ? {} : { harnessAuthors: [parts.login] }),
    now,
  });
}
