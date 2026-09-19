/**
 * Reading one Jira issue: the fields the queue depends on, the eligibility test
 * that is run again on every read, and the immutable source reference.
 *
 * An answer that is not the documented REST API v3 shape is refused by name
 * rather than guessed at.
 */
import type { JiraSourceConfig, SourceRef } from '../../shared/types.js';
import { SourceError } from '../contract.js';
import type { HttpClient } from './http.js';
import { isRecord, nested, stringField } from './json.js';

/** The issue fields the connector asks for, and no others. */
const ISSUE_FIELDS = 'summary,description,status,labels,project,issuetype,updated';
/** The issue fields this connector reads. Everything is validated, not assumed. */
export interface IssueFields {
  readonly summary: string;
  readonly description: unknown;
  readonly status: string;
  readonly labels: readonly string[];
  readonly projectKey: string;
  readonly issueType: string;
  readonly updated: string;
}

export interface JiraIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: IssueFields;
}

export function malformed(where: string, problem: string): SourceError {
  return new SourceError(
    'fatal',
    `${where} was not the documented Jira REST API v3 shape (${problem}), so this connector will ` +
      'not guess what it said',
  );
}

/**
 * Parses one issue object. A search result carries no description and an issue
 * read carries one; both go through the same validation of the fields the queue
 * depends on.
 */
export function parseIssue(value: unknown, where: string): JiraIssue {
  if (!isRecord(value)) {
    throw malformed(where, 'not an object');
  }
  const id = stringField(value, 'id');
  const key = stringField(value, 'key');
  const fields = nested(value, 'fields');
  if (id === null || key === null || fields === null) {
    throw malformed(where, 'no id, key, or fields');
  }
  const summary = stringField(fields, 'summary');
  const status = nested(fields, 'status');
  const project = nested(fields, 'project');
  const issueType = nested(fields, 'issuetype');
  const updated = stringField(fields, 'updated');
  const statusName = status === null ? null : stringField(status, 'name');
  const projectKey = project === null ? null : stringField(project, 'key');
  const issueTypeName = issueType === null ? null : stringField(issueType, 'name');
  const labelsValue = fields['labels'];
  const labels = Array.isArray(labelsValue)
    ? labelsValue.filter((label): label is string => typeof label === 'string')
    : null;
  if (
    summary === null ||
    statusName === null ||
    projectKey === null ||
    issueTypeName === null ||
    updated === null ||
    labels === null
  ) {
    throw malformed(where, 'a field the queue depends on is missing');
  }
  return {
    id,
    key,
    fields: {
      summary,
      description: fields['description'],
      status: statusName,
      labels,
      projectKey,
      issueType: issueTypeName,
      updated,
    },
  };
}

/** Names are compared as names: trimmed, and case-insensitively. */
export function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Whether one issue is still in the configured queue. */
export function isEligible(config: JiraSourceConfig, fields: IssueFields): boolean {
  return (
    fields.projectKey === config.projectKey &&
    sameName(fields.issueType, config.issueType) &&
    fields.labels.includes(config.label) &&
    sameName(fields.status, config.readyStatus)
  );
}

/** The source reference of one issue: immutable ID, browser link, revision. */
export function refFor(config: JiraSourceConfig, issue: JiraIssue): SourceRef {
  return {
    type: 'jira',
    scope: config.siteUrl,
    id: issue.id,
    key: issue.key,
    url: `${config.siteUrl}/browse/${issue.key}`,
    updatedAt: issue.fields.updated,
  };
}
/** Reads one issue's current content. `null` means it is gone. */
export async function readIssue(
  http: HttpClient,
  id: string,
  stop: AbortSignal,
): Promise<JiraIssue | null> {
  const raw = await http.request({
    method: 'GET',
    path: `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${ISSUE_FIELDS}`,
    signal: stop,
    absentOk: true,
  });
  return raw === null ? null : parseIssue(raw, `issue ${id}`);
}
