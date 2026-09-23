/**
 * The supervisor's real contracts on this host: its state files, its locks, the
 * worker process it starts, and the publication boundaries a report crosses —
 * a real HTTP request to a local stand-in Jira, and a real publisher process.
 *
 * Each case works in a temporary directory it owns, and every process it starts
 * is waited for before the case ends. Nothing here uses a live service, an
 * agent, or a credential (docs/testing.md, docs/WORKFLOW.md §12).
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfiguration } from '../../src/config/load.js';
import {
  incidentDir,
  incidentFilePath,
  openIncident,
  readCurrentIncident,
  readIncident,
  writeCurrentIncident,
  writeIncident,
} from '../../src/supervisor/incident.js';
import {
  acquireSupervisorOwnership,
  intakeConsumerProblem,
  processIsAlive,
} from '../../src/supervisor/owner.js';
import { createIncidentReporter } from '../../src/supervisor/report.js';
import { runNexusWorker, WORKER_STOP_GRACE_MS } from '../../src/supervisor/worker.js';
import { createHttpClient } from '../../src/sources/jira/http.js';
import { intakeLockPath } from '../../src/sources/receipts.js';
import { serviceFetch, startLocalService } from './integration-support.js';
import { JIRA_SOURCE_DEFAULTS } from '../../src/config/schema.js';

/** The Jira connection the report is written through, as the schema defaults it. */
const JIRA_CONFIG = {
  type: 'jira' as const,
  siteUrl: 'https://site.atlassian.net',
  cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
  projectKey: 'HARN',
  ...JIRA_SOURCE_DEFAULTS,
};

/** One temporary directory this case owns, removed when it ends. */
const owned: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-supervisor-'));
  owned.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of owned.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** One worker script the case really starts. */
async function workerScript(directory: string, body: string): Promise<string> {
  const file = path.join(directory, 'worker.mjs');
  await writeFile(file, body, 'utf8');
  return file;
}

describe('the supervisor’s incident state', () => {
  it('writes one incident atomically and reads it back whole', async () => {
    const root = await tempDir();
    const incident = openIncident('ns', 'run', null, 2, () => new Date('2026-09-23T00:00:00Z'));
    const file = incidentFilePath(root, incident.id);
    await writeIncident(file, incident);
    const read = await readIncident(file);
    expect(read).toMatchObject({ id: incident.id, maxAttempts: 2, stage: 'open' });
    // The pointer is what a restart adopts from.
    await writeCurrentIncident(root, { version: 1, id: incident.id, workerPid: null });
    expect(await readCurrentIncident(root)).toEqual({
      version: 1,
      id: incident.id,
      workerPid: null,
    });
    await writeCurrentIncident(root, null);
    expect(await readCurrentIncident(root)).toBeNull();
  });

  it('refuses a corrupt incident instead of treating it as absence', async () => {
    const root = await tempDir();
    const file = incidentFilePath(root, 'broken');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    await expect(readIncident(file)).rejects.toThrow(/not valid JSON/);
    // A record this harness did not write is refused the same way.
    await writeFile(file, JSON.stringify({ version: 2 }), 'utf8');
    await expect(readIncident(file)).rejects.toThrow(/not a record this harness wrote/);
  });
});

describe('the supervisor’s own ownership', () => {
  it('lets exactly one of two starts own the queue, whoever creates the record first', async () => {
    const root = await tempDir();
    const now = (): Date => new Date('2026-09-23T00:00:00Z');
    // The record is the lock: the exclusive creation itself decides, so two
    // invocations that both read an absent record cannot both become owner.
    const isAlive = (pid: number): boolean => pid === process.pid;
    const [first, second] = await Promise.all([
      acquireSupervisorOwnership({ root, intent: 'run', repoPath: 'C:/target', now, isAlive }),
      acquireSupervisorOwnership({ root, intent: 'watch', repoPath: 'C:/target', now, isAlive }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const refused = first.ok ? second : first;
    if (!refused.ok) {
      expect(refused.problem).toContain('another supervisor already runs');
    }
    for (const take of [first, second]) {
      if (take.ok) {
        await take.ownership.release();
      }
    }
    expect(await readFile(path.join(root, 'owner.json'), 'utf8').catch(() => null)).toBeNull();
  }, 30_000);

  it('takes one stale record over exactly once when two invocations race for it', async () => {
    const root = await tempDir();
    const now = (): Date => new Date('2026-09-23T00:00:00Z');
    // An earlier supervisor that is really gone: its PID is nobody's.
    await writeFile(
      path.join(root, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 4242,
        token: 'stale',
        startedAt: 't',
        intent: 'run',
        repoPath: 'C:/target',
      }),
      'utf8',
    );
    const isAlive = (pid: number): boolean => pid === process.pid;
    const takes = await Promise.all([
      acquireSupervisorOwnership({ root, intent: 'run', repoPath: 'C:/target', now, isAlive }),
      acquireSupervisorOwnership({ root, intent: 'run', repoPath: 'C:/target', now, isAlive }),
    ]);
    expect(takes.filter((take) => take.ok)).toHaveLength(1);
    const recorded = JSON.parse(await readFile(path.join(root, 'owner.json'), 'utf8')) as {
      pid: number;
    };
    expect(recorded.pid).toBe(process.pid);
    for (const take of takes) {
      if (take.ok) {
        await take.ownership.release();
      }
    }
  }, 30_000);

  it('refuses a live owner and adopts one whose process is gone', async () => {
    const root = await tempDir();
    const now = (): Date => new Date('2026-09-23T00:00:00Z');
    const first = await acquireSupervisorOwnership({
      root,
      intent: 'run',
      repoPath: 'C:/target',
      now,
    });
    expect(first.ok).toBe(true);
    const second = await acquireSupervisorOwnership({
      root,
      intent: 'watch',
      repoPath: 'C:/target',
      now,
      isAlive: () => true,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.problem).toContain('another supervisor already runs');
    }
    // The record names a dead process (this test's own id is never used as a
    // live one): a restart adopts it rather than refusing.
    const adopted = await acquireSupervisorOwnership({
      root,
      intent: 'watch',
      repoPath: 'C:/target',
      now,
      isAlive: () => false,
    });
    expect(adopted.ok).toBe(true);
    if (first.ok) {
      // The first holder no longer owns the record, so it leaves it in place.
      await first.ownership.release();
    }
    if (adopted.ok) {
      await adopted.ownership.release();
    }
    expect(await readFile(path.join(root, 'owner.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('refuses to activate beside a live raw queue consumer', async () => {
    const workDir = await tempDir();
    const namespace = 'namespace';
    const lock = intakeLockPath(workDir, namespace);
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({ version: 1, pid: 4242, startedAt: '2026-09-23T00:00:00Z', token: 't' }),
      'utf8',
    );

    const live = await intakeConsumerProblem({
      workDir,
      namespace,
      isAlive: () => true,
    });
    expect(live).toContain('a raw queue consumer already holds');
    expect(live).toContain(String(4242));

    // A consumer that is gone leaves the lock alone: it is the incident's
    // business, and nothing here breaks a lock.
    const gone = await intakeConsumerProblem({ workDir, namespace, isAlive: () => false });
    expect(gone).toBeNull();
    expect(await readFile(path.join(lock, 'owner.json'), 'utf8')).toContain('4242');

    expect(await intakeConsumerProblem({ workDir, namespace, isAlive: () => true })).not.toBeNull();
  });

  it('reports this host’s own liveness for a real process and a free id', () => {
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(0)).toBe(false);
  });
});

describe('the worker process', () => {
  it('starts the real CLI-shaped child, reports its PID, and reads its exit', async () => {
    const directory = await tempDir();
    const entry = await workerScript(directory, 'process.exit(3);\n');
    const started: number[] = [];
    const outcome = await runNexusWorker({
      entry,
      interpreter: process.execPath,
      intent: 'run',
      scope: null,
      repoPath: directory,
      configPath: path.join(directory, 'nexus.config.json'),
      cwd: directory,
      stop: new AbortController().signal,
      onStarted: (pid) => started.push(pid),
      onLine: () => undefined,
    });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.signal).toBeNull();
    expect(outcome.launchProblem).toBeNull();
    expect(outcome.stopRequested).toBe(false);
    expect(started).toHaveLength(1);
  }, 30_000);

  it('reports a crash that left no report as the signal it was', async () => {
    const directory = await tempDir();
    const entry = await workerScript(
      directory,
      "process.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 5_000);\n",
    );
    const outcome = await runNexusWorker({
      entry,
      interpreter: process.execPath,
      intent: 'ticket',
      scope: 'HARN-51',
      repoPath: directory,
      configPath: path.join(directory, 'nexus.config.json'),
      cwd: directory,
      stop: new AbortController().signal,
    });
    // Windows reports a killed process as an exit code and POSIX as a signal;
    // either way the supervisor reads it as the unexpected stop it was.
    expect(outcome.signal !== null || outcome.exitCode !== 0).toBe(true);
    expect(WORKER_STOP_GRACE_MS).toBeGreaterThan(0);
  }, 30_000);

  it('reports an entry that cannot be started at all', async () => {
    const directory = await tempDir();
    const outcome = await runNexusWorker({
      entry: path.join(directory, 'missing.mjs'),
      interpreter: process.execPath,
      intent: 'run',
      scope: null,
      repoPath: directory,
      configPath: path.join(directory, 'nexus.config.json'),
      cwd: directory,
      stop: new AbortController().signal,
    });
    // A missing entry is an ordinary nonzero exit of the interpreter, which the
    // supervisor reads as an unexpected stop rather than as a settled worker.
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.launchProblem).toBeNull();
  }, 30_000);
});

describe('the incident report’s publication boundaries', () => {
  /** One incident about a ticket, with one repaired attempt behind it. */
  function reportIncident(namespace: string) {
    const base = openIncident(
      namespace,
      'ticket',
      'HARN-51',
      2,
      () => new Date('2026-09-23T00:00:00Z'),
    );
    return {
      ...base,
      stage: 'settled' as const,
      ticket: { key: 'HARN-51', url: 'https://site.atlassian.net/browse/HARN-51' },
      stops: [
        {
          at: '2026-09-23T00:01:00.000Z',
          intent: 'ticket' as const,
          scope: 'HARN-51',
          exitCode: 1,
          signal: null,
          signature: 'signature',
        },
      ],
      attempts: [
        {
          attempt: 1,
          startedAt: '2026-09-23T00:02:00.000Z',
          endedAt: '2026-09-23T00:03:00.000Z',
          outcome: 'repaired' as const,
          summary: 'the run directory was half written',
          cause: 'the worker was killed mid-run',
          resolution: 'the workspace was restored to its recorded branch',
          preserved: ['committed work kept on harness/HARN-51'],
          resume: 'HARN-51 resumes from that workspace',
          blocker: null,
          help: null,
          problem: null,
          dir: null,
          logPath: null,
        },
      ],
      conclusion: {
        outcome: 'repaired' as const,
        detail: 'the workspace was restored',
        at: '2026-09-23T00:03:00.000Z',
      },
    };
  }

  it('writes the concise report into the ticket’s own thread, once', async () => {
    const directory = await tempDir();
    const service = await startLocalService((request) => {
      if (request.method === 'GET' && request.url.includes('/comment')) {
        return { status: 200, body: JSON.stringify({ comments: [], total: 0 }) };
      }
      return { status: 201, body: JSON.stringify({ id: '10042' }) };
    });
    try {
      const incident = reportIncident('ns');
      const http = createHttpClient(JIRA_CONFIG, 'token', { fetch: serviceFetch(service.origin) });
      const reporter = createIncidentReporter({
        jira: { http, token: 'token' },
        notification: null,
        logsDir: () => path.join(directory, 'logs'),
        cwd: directory,
        now: () => new Date('2026-09-23T00:04:00.000Z'),
      });
      const first = await reporter({ incident, stop: new AbortController().signal });
      expect(first.report.commentId).toBe('10042');
      expect(first.problem).toBeNull();
      const posted = service.requests.find((request) => request.method === 'POST');
      expect(posted?.url).toContain('/rest/api/3/issue/HARN-51/comment');
      expect(posted?.body).toContain('Harness recovery report');

      // The same incident again — a restart — checks the thread first and keeps
      // the comment it finds rather than posting a second one.
      const serviceWithReport = await startLocalService(() => ({
        status: 200,
        body: JSON.stringify({
          comments: [
            {
              id: '10042',
              created: '2026-09-23T00:04:00.000Z',
              author: { displayName: 'nexus' },
              body: {
                type: 'doc',
                version: 1,
                content: first.report.commentText
                  ?.split('\n\n')
                  .map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
              },
            },
          ],
          total: 1,
        }),
      }));
      try {
        const restartHttp = createHttpClient(JIRA_CONFIG, 'token', {
          fetch: serviceFetch(serviceWithReport.origin),
        });
        const restartReporter = createIncidentReporter({
          jira: { http: restartHttp, token: 'token' },
          notification: null,
          logsDir: () => path.join(directory, 'logs'),
          cwd: directory,
          now: () => new Date('2026-09-23T00:05:00.000Z'),
        });
        const second = await restartReporter({
          incident: { ...incident, report: first.report },
          stop: new AbortController().signal,
        });
        expect(second.report.commentId).toBe('10042');
        expect(serviceWithReport.requests.filter((request) => request.method === 'POST')).toEqual(
          [],
        );
      } finally {
        await serviceWithReport.close();
      }
    } finally {
      await service.close();
    }
  }, 30_000);

  it('publishes the email summary through the configured publisher and records its id', async () => {
    const directory = await tempDir();
    const publisher = path.join(directory, 'publish.mjs');
    await writeFile(
      publisher,
      'process.stdout.write(JSON.stringify({ MessageId: "abc-123" }));\n',
      'utf8',
    );
    const incident = reportIncident('ns');
    const reporter = createIncidentReporter({
      notification: {
        topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
        email: 'saint282@gmail.com',
        publisher: [process.execPath, publisher],
      },
      logsDir: (entry) => incidentDir(directory, entry.id),
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
    });
    const sent = await reporter({ incident, stop: new AbortController().signal });
    expect(sent.report.notification).toMatchObject({ state: 'sent', messageId: 'abc-123' });
    expect(sent.problem).toBeNull();

    // A second publication of the same incident is not a second notification.
    const again = await reporter({
      incident: { ...incident, report: sent.report },
      stop: new AbortController().signal,
    });
    expect(again.report.notification).toMatchObject({ state: 'sent', messageId: 'abc-123' });
  }, 30_000);

  it('records a failed summary without repeating the recovery that came before it', async () => {
    const directory = await tempDir();
    const incident = reportIncident('ns');
    const reporter = createIncidentReporter({
      notification: {
        topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
        email: 'saint282@gmail.com',
        publisher: [process.execPath, path.join(directory, 'not-there.mjs')],
      },
      logsDir: (entry) => incidentDir(directory, entry.id),
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
    });
    const failed = await reporter({ incident, stop: new AbortController().signal });
    expect(failed.report.notification?.state).toBe('failed');
    expect(failed.problem).toContain('could not be published');
    expect(failed.report.commentId).toBeNull();
    // The summary's own failure is recorded, so a person can resend it without
    // the recovery being repeated.
    expect(failed.report.notification?.problem).toContain('did not publish the summary');
  }, 30_000);

  it('writes the summary down as pending before publishing, and reconciles an interrupted one from its own output', async () => {
    const directory = await tempDir();
    const logsDir = path.join(directory, 'incident-logs');
    const publisher = path.join(directory, 'publish.mjs');
    await writeFile(
      publisher,
      'process.stdout.write(JSON.stringify({ MessageId: "abc-123", TopicArn: "arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications" }));\n',
      'utf8',
    );
    const notification = {
      topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
      email: 'saint282@gmail.com',
      publisher: [process.execPath, publisher],
    };
    const reporter = createIncidentReporter({
      notification,
      logsDir: () => logsDir,
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
    });
    const incident = reportIncident('ns');
    const written: string[] = [];
    const sent = await reporter({
      incident,
      stop: new AbortController().signal,
      checkpoint: async (report) => {
        written.push(report.notification?.state ?? 'none');
      },
    });
    // The attempt is durable before it crosses the network: a restart reads
    // "pending" — an attempt was made — never "nothing was tried".
    expect(written).toEqual(['pending']);
    expect(sent.report.notification).toMatchObject({ state: 'sent', messageId: 'abc-123' });

    // The invocation that sent it stopped before it recorded the answer. The
    // next one reads the record and the publisher's own acknowledgement instead
    // of sending a second summary for one incident.
    const restart = await reporter({
      incident: {
        ...incident,
        report: {
          ...incident.report,
          notification: {
            topicArn: notification.topicArn,
            email: notification.email,
            state: 'pending',
            messageId: null,
            problem: null,
          },
        },
      },
      stop: new AbortController().signal,
    });
    expect(restart.report.notification).toMatchObject({ state: 'sent', messageId: 'abc-123' });
    expect(restart.problem).toBeNull();
    expect((await readdir(logsDir)).filter((name) => name.endsWith('.stdout.log'))).toHaveLength(1);
  }, 30_000);

  it('never sends a second summary for an interrupted publication it cannot confirm', async () => {
    const directory = await tempDir();
    const logsDir = path.join(directory, 'incident-logs');
    // The publisher wrote its own log and died before it acknowledged
    // anything: the summary may or may not have reached the topic.
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, 'recovery-notification.stdout.log'), '', 'utf8');
    const publisher = path.join(directory, 'publish.mjs');
    await writeFile(publisher, 'process.stdout.write("{}");\n', 'utf8');
    const notification = {
      topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
      email: 'saint282@gmail.com',
      publisher: [process.execPath, publisher],
    };
    const incident = reportIncident('ns');
    const reporter = createIncidentReporter({
      notification,
      logsDir: () => logsDir,
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
    });
    const outcome = await reporter({
      incident: {
        ...incident,
        report: {
          ...incident.report,
          notification: {
            topicArn: notification.topicArn,
            email: notification.email,
            state: 'pending',
            messageId: null,
            problem: null,
          },
        },
      },
      stop: new AbortController().signal,
    });
    expect(outcome.report.notification).toMatchObject({ state: 'interrupted', messageId: null });
    expect(outcome.problem).toContain('not sent again automatically');
    // No second attempt was made: the one log the first invocation wrote is
    // still the only one.
    expect((await readdir(logsDir)).filter((name) => name.endsWith('.stdout.log'))).toHaveLength(1);
  }, 30_000);
});

describe('a project configuration that names the supervisable queue', () => {
  it('composes the recovery policy with its launch and publisher resolved', async () => {
    const directory = await tempDir();
    await writeFile(
      path.join(directory, 'harness.json'),
      JSON.stringify({
        workDir: 'runs',
        maxRepairs: 2,
        taskTimeoutMinutes: 60,
        commandTimeoutMinutes: 10,
        recovery: {
          agent: { runtime: 'codex', command: ['./bin/recovery', '--profile', 'nexus-recovery'] },
          maxAttempts: 3,
          notifications: {
            topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
            email: 'saint282@gmail.com',
          },
        },
      }),
      'utf8',
    );
    await writeFile(
      path.join(directory, 'nexus.project.json'),
      JSON.stringify({ setup: [], checks: [['node', 'check.mjs']] }),
      'utf8',
    );
    const loaded = await loadConfiguration(
      path.join(directory, 'harness.json'),
      path.join(directory, 'nexus.project.json'),
    );
    expect(loaded.config.recovery?.maxAttempts).toBe(3);
    expect(loaded.config.recovery?.agent.command[0]).toBe(path.join(directory, 'bin', 'recovery'));
    expect(loaded.config.recovery?.notifications?.publisher).toEqual(['aws', 'sns', 'publish']);
  });
});
