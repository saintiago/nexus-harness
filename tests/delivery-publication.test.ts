/**
 * Focused integration tests: the parent-owned delivery milestone and completion writes preserve an
 * unexpected human status change instead of overwriting it. Temporary records stand in for a
 * delivery attempt; no live source or repository is involved.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JiraComment, JiraTransition } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import { createCompleteDelivery } from '../src/task-engine/actions/project/complete-delivery/index.js';
import { createPublishDeliveryReport } from '../src/task-engine/actions/project/source-boundaries/index.js';
import { scriptedJira } from './support/jira.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** One delivery attempt whose round carries the development and delivery evidence. */
async function deliveryAttempt(status: string): Promise<{
  readonly selectionFile: string;
  readonly status: () => string;
  readonly comments: readonly JiraComment[];
  readonly jira: ReturnType<typeof scriptedJira>['jira'];
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-delivery-publication-'));
  temporaryDirectories.push(directory);
  const root = path.join(directory, 'NEX-1');
  const selectionFile = path.join(directory, 'selection.json');
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({ number: 1, profile: 'dev-a', reason: 'The initial round.' }),
  );
  await writeFile(
    path.join(root, 'artifacts', '1', 'development.json'),
    JSON.stringify({
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision: '1'.repeat(40),
      headRevision: '2'.repeat(40),
      summary: 'Added the feature.',
    }),
  );
  await writeFile(
    path.join(root, 'artifacts', '1', 'delivery.json'),
    JSON.stringify({
      repository: 'owner/repository',
      pullRequestNumber: 7,
      pullRequestUrl: 'https://github.com/owner/repository/pull/7',
      headRevision: '2'.repeat(40),
    }),
  );
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: { id: '1', key: 'NEX-1', fields: { summary: 'Implement the feature' } },
      conversation: [],
      workspace: { root },
      stage: 'delivery',
    }),
  );
  let current = status;
  const comments: JiraComment[] = [];
  const transitions: JiraTransition[] = [
    { id: '31', name: 'Review', to: { id: '4', name: 'In Review' } },
    { id: '41', name: 'Done', to: { id: '5', name: 'Done' } },
  ];
  const { jira } = scriptedJira({
    readIssue: () =>
      ok({
        id: '1',
        key: 'NEX-1',
        fields: {
          summary: 'Implement the feature',
          description: { type: 'doc', content: [] },
          status: { id: '2', name: current },
        },
      }),
    readComments: () => ok([...comments]),
    readTransitions: () => ok(transitions),
    updateFields: () => ok(undefined),
    transitionIssue: (_issueId, transitionId) => {
      current = transitionId === '31' ? 'In Review' : 'Done';
      return ok(undefined);
    },
    addComment: (_issueId, body) => {
      const comment = { id: `c${String(comments.length + 1)}`, body };
      comments.push(comment);
      return ok(comment);
    },
  });
  return { selectionFile, status: () => current, comments, jira };
}

describe('delivery publication status preservation', () => {
  it('does not publish a delivery report over a human status change', async () => {
    const attempt = await deliveryAttempt('Waiting for Feedback');
    const publish = createPublishDeliveryReport({
      selectionFile: attempt.selectionFile,
      pullRequestField: 'customfield_10002',
      inProgressStatus: 'In Progress',
      reviewStatus: 'In Review',
      jira: attempt.jira,
      publish: () => undefined,
    });

    // The unexpected state is preserved; the milestone write is reported for attention.
    await expect(publish()).resolves.toBe('failed');
    expect(attempt.status()).toBe('Waiting for Feedback');
    expect(attempt.comments).toHaveLength(0);
  });

  it('does not complete a ticket a human rerouted', async () => {
    const attempt = await deliveryAttempt('Waiting for Feedback');
    const publish = createCompleteDelivery({
      selectionFile: attempt.selectionFile,
      doneStatus: 'Done',
      reviewStatus: 'In Review',
      jira: attempt.jira,
      publish: () => undefined,
    });

    await expect(publish()).resolves.toBe('failed');
    expect(attempt.status()).toBe('Waiting for Feedback');
  });

  it('still publishes the milestone and completes the retained review status', async () => {
    const status = { current: 'In Progress' };
    const attempt = await deliveryAttempt(status.current);
    const publish = createPublishDeliveryReport({
      selectionFile: attempt.selectionFile,
      pullRequestField: 'customfield_10002',
      inProgressStatus: 'In Progress',
      reviewStatus: 'In Review',
      jira: attempt.jira,
      publish: () => undefined,
    });
    const complete = createCompleteDelivery({
      selectionFile: attempt.selectionFile,
      doneStatus: 'Done',
      reviewStatus: 'In Review',
      jira: attempt.jira,
      publish: () => undefined,
    });

    await expect(publish()).resolves.toBe('published');
    expect(attempt.status()).toBe('In Review');
    await expect(complete()).resolves.toBe('completed');
    expect(attempt.status()).toBe('Done');
  });
});
