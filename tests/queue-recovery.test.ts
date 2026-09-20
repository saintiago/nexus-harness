import { describe, expect, it } from 'vitest';
import type { JiraSourceConfig } from '../src/shared/types.js';
import { createHttpClient } from '../src/sources/jira/http.js';
import { discoverQueueWork } from '../src/sources/jira/queue.js';

const config: JiraSourceConfig = {
  type: 'jira',
  siteUrl: 'https://example.atlassian.net',
  cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
  projectKey: 'HARN',
  issueType: 'Task',
  label: 'harness-task',
  readyStatus: 'To Do',
  runningStatus: 'In Progress',
  reviewStatus: 'In Review',
  pollIntervalSeconds: 5,
  tokenEnv: 'JIRA_TOKEN',
};

function issue(id: string, status: string, pointers: string[] = []) {
  return {
    id,
    key: `HARN-${id}`,
    fields: {
      summary: `Task ${id}`,
      status: { name: status },
      labels: ['harness-task', ...pointers],
      project: { key: 'HARN' },
      issuetype: { name: 'Task' },
      updated: '2026-09-20T00:00:00Z',
    },
  };
}

function fixture(listed: ReturnType<typeof issue>[], fresh = listed) {
  const reads: string[] = [];
  const http = createHttpClient(config, 'offline-token', {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      reads.push(url.pathname);
      if (url.pathname.endsWith('/search/jql')) {
        const { jql } = JSON.parse(String(init?.body)) as { jql: string };
        const status = /AND status = "([^"]+)"/.exec(jql)?.[1];
        return new Response(
          JSON.stringify({
            issues: listed.filter((i) => i.fields.status.name === status),
            isLast: true,
          }),
        );
      }
      expect(init?.method).toBe('GET');
      const id = url.pathname.split('/').at(-1);
      const found = fresh.find((i) => i.id === id);
      return new Response(JSON.stringify(found ?? {}), { status: found ? 200 : 404 });
    },
  });
  return { read: () => discoverQueueWork(config, http, new AbortController().signal), reads };
}

describe('authoritative Jira queue recovery', () => {
  it('resumes In Review ahead of an unrelated ready ticket and a retained repair', async () => {
    const f = fixture([
      issue('1', 'To Do'),
      issue('2', 'In Review'),
      issue('3', 'To Do', ['harness-ws-work']),
    ]);
    expect(await f.read()).toMatchObject({ phase: 'review', ticket: { ref: { id: '2' } } });
  });

  it('refuses In Progress even without a workspace pointer or a local receipt', async () => {
    const f = fixture([issue('1', 'To Do'), issue('2', 'In Progress')]);
    await expect(f.read()).rejects.toThrow('HARN-2: still In Progress');
    expect(f.reads.filter((url) => url.endsWith('/search/jql'))).toHaveLength(1);
  });

  it('refuses ambiguous active ownership', async () => {
    const f = fixture([issue('1', 'In Review'), issue('2', 'In Review')]);
    await expect(f.read()).rejects.toThrow('Multiple In Review tickets');
  });

  it('uses a fresh read to recognize Done and never reruns it', async () => {
    const f = fixture([issue('1', 'In Review')], [issue('1', 'Done')]);
    expect(await f.read()).toBeNull();
  });

  it('uses a fresh read to resume a To Do repair through its pointer', async () => {
    const f = fixture([issue('1', 'In Review')], [issue('1', 'To Do', ['harness-ws-work'])]);
    expect(await f.read()).toMatchObject({ phase: 'repair', ticket: { ref: { id: '1' } } });
  });

  it('prioritizes retained repairs while preserving native order among them', async () => {
    const f = fixture([
      issue('1', 'To Do'),
      issue('3', 'To Do', ['harness-ws-work3']),
      issue('2', 'To Do', ['harness-ws-work2']),
    ]);
    expect(await f.read()).toMatchObject({ phase: 'repair', ticket: { ref: { id: '3' } } });
  });

  it('refuses missing authoritative reads instead of claiming unrelated work', async () => {
    await expect(fixture([issue('1', 'In Progress')], []).read()).rejects.toThrow(
      'cannot read queue ownership',
    );
  });

  it('does not resume an issue relabelled out of the configured queue', async () => {
    const changed = issue('1', 'In Review');
    changed.fields.labels = [];
    expect(await fixture([issue('1', 'In Review')], [changed]).read()).toBeNull();
  });
});
