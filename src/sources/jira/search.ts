/**
 * The configured queue, and the paged search that consumes it: the JQL the
 * queue boundary is, and one finite, ordered, de-duplicated batch of
 * candidates.
 *
 * Search results can lag, so they are candidates, not claims.
 */
import type { JiraSourceConfig } from '../../shared/types.js';
import type { SourceCandidate } from '../contract.js';
import { parseWorkspacePointers } from '../contract.js';
import type { HttpClient } from './http.js';
import { malformed, parseIssue, refFor } from './issue.js';
import { isRecord } from './json.js';

/** The most issues one search page may return. */
const SEARCH_PAGE_SIZE = 100;
/** The fields the enhanced search needs to build a candidate. */
const SEARCH_FIELDS = ['summary', 'status', 'updated', 'labels', 'project', 'issuetype'];
/** A JQL string literal, quoted and escaped rather than interpolated raw. */
function jqlLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The configured queue, as the documented JQL: the project, the issue type, the
 * label, and the ready status, with a deterministic order. No arbitrary JQL and
 * no timestamp cursor: the configured values are the whole queue definition
 * (docs/WORKFLOW.md §5).
 */
export function queueJql(config: JiraSourceConfig): string {
  return [
    `project = ${jqlLiteral(config.projectKey)}`,
    `AND issuetype = ${jqlLiteral(config.issueType)}`,
    `AND labels = ${jqlLiteral(config.label)}`,
    `AND status = ${jqlLiteral(config.readyStatus)}`,
    'ORDER BY created ASC, key ASC',
  ].join(' ');
}
/**
 * Every eligible issue, across every page, in the order the search returned
 * them, with immutable IDs de-duplicated. `total` and the deprecated
 * `startAt` pagination are deliberately unused (docs/architecture.md §9).
 */
export async function listEligibleIssues(
  config: JiraSourceConfig,
  http: HttpClient,
  stop: AbortSignal,
): Promise<readonly SourceCandidate[]> {
  const jql = queueJql(config);
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;

  for (;;) {
    const answer = await http.request({
      method: 'POST',
      path: '/rest/api/3/search/jql',
      body: {
        jql,
        maxResults: SEARCH_PAGE_SIZE,
        fields: SEARCH_FIELDS,
        ...(pageToken === null ? {} : { nextPageToken: pageToken }),
      },
      signal: stop,
    });
    if (!isRecord(answer)) {
      throw malformed('the search answer', 'not an object');
    }
    const issuesValue = answer['issues'];
    if (!Array.isArray(issuesValue)) {
      throw malformed('the search answer', 'no issues array');
    }

    for (const raw of issuesValue) {
      const issue = parseIssue(raw, 'a search result');
      if (seen.has(issue.id)) {
        continue;
      }
      seen.add(issue.id);
      candidates.push({
        ref: refFor(config, issue),
        title: issue.fields.summary,
        // The workspace pointers the issue carries now. A run only ever reads
        // them; the one that creates a workspace writes its own.
        pointers: parseWorkspacePointers(issue.fields.labels),
      });
    }

    if (answer['isLast'] === true) {
      return candidates;
    }
    const next = answer['nextPageToken'];
    if (typeof next !== 'string' || next.trim() === '') {
      throw malformed(
        'the search answer',
        'a page that is not the last one carried no continuation token',
      );
    }
    if (seenTokens.has(next)) {
      throw malformed(
        'the search answer',
        'a page repeated a continuation token, which would never end',
      );
    }
    seenTokens.add(next);
    pageToken = next;
  }
}
