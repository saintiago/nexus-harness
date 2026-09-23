/**
 * The supervised queue, assembled: a worker that stops unexpectedly, a recovery
 * agent that answers it, the incident record that survives the pass, and a
 * restart of the supervisor that picks that record up.
 *
 * The cases drive the supervisor's own loop with the two responses it gets from
 * outside — how the worker ended, and what the recovery turn concluded — and
 * read the state it keeps on disk. The worker process, the locks and the report
 * publications have their own boundary cases; nothing here repeats them
 * (docs/testing.md, docs/WORKFLOW.md §12).
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRecoveryJudgment } from '../../src/supervisor/recovery.js';
import {
  incidentDir,
  incidentFilePath,
  readCurrentIncident,
  readIncident,
  supervisorRoot,
} from '../../src/supervisor/incident.js';
import type { IncidentRecord } from '../../src/supervisor/incident.js';
import { supervise } from '../../src/supervisor/supervise.js';
import type { SuperviseRequest, SuperviseSummary } from '../../src/supervisor/supervise.js';
import type { RecoveryTurn } from '../../src/supervisor/supervise.js';
import type { WorkerOutcome, WorkerRequest } from '../../src/supervisor/worker.js';
import type { RecoveryNotificationConfig } from '../../src/shared/types.js';

/** One temporary tree this case owns and removes when it ends. */
const owned: string[] = [];

afterEach(async () => {
  for (const directory of owned.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** The paths one supervision invocation works on, in a directory of its own. */
async function workspace(): Promise<{
  readonly workDir: string;
  readonly repoPath: string;
  readonly configPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'nexus-supervision-'));
  owned.push(root);
  const workDir = path.join(root, 'runs');
  const repoPath = path.join(root, 'target');
  await mkdir(workDir, { recursive: true });
  await mkdir(repoPath, { recursive: true });
  const configPath = path.join(root, 'nexus.config.json');
  await writeFile(configPath, '{}', 'utf8');
  return { workDir, repoPath, configPath };
}

/** The recovery notification policy one incident reports through. */
const NOTIFICATION: RecoveryNotificationConfig = {
  topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
  email: 'saint282@gmail.com',
  publisher: ['aws', 'sns', 'publish'],
};

/** A worker that ends the way the case wrote down, run after run. */
function scriptedWorker(
  endings: readonly WorkerOutcome[],
): (request: WorkerRequest) => Promise<WorkerOutcome> {
  let index = 0;
  return async () => {
    const outcome = endings[Math.min(index, endings.length - 1)];
    index += 1;
    if (outcome === undefined) {
      throw new Error('the case ran out of scripted worker endings');
    }
    return outcome;
  };
}

/** One ending, as the supervisor observes it. */
function ended(exitCode: number | null, signal: string | null = null): WorkerOutcome {
  return { exitCode, signal, launchProblem: null, stopRequested: false };
}

/**
 * A recovery turn that writes the judgment its case scripted into the turn's
 * own directory, exactly as a real turn does, so the supervisor reads it back
 * through the same validation.
 */
function scriptedRecovery(
  judgments: readonly (object | null)[],
): RecoveryTurn & { readonly calls: number } {
  let calls = 0;
  const scripted = (async ({ dir }: { readonly dir: string }) => {
    const judgment = judgments[Math.min(calls, judgments.length - 1)];
    calls += 1;
    await mkdir(dir, { recursive: true });
    if (judgment === null || judgment === undefined) {
      return {
        judgment: null,
        problem: 'the scripted turn produced no judgment',
        dir,
        logPath: null,
      };
    }
    const text = JSON.stringify(judgment);
    await writeFile(path.join(dir, 'outcome.json'), text, 'utf8');
    const parsed = parseRecoveryJudgment(text, 'outcome.json');
    if ('problem' in parsed) {
      return { judgment: null, problem: parsed.problem, dir, logPath: null };
    }
    return { judgment: parsed, problem: null, dir, logPath: path.join(dir, 'recovery.log') };
  }) as unknown as RecoveryTurn & { readonly calls: number };
  Object.defineProperty(scripted, 'calls', { get: () => calls });
  return scripted;
}

/** One supervision invocation with everything outside it supplied. */
async function runSupervision(overrides: {
  readonly workDir: string;
  readonly repoPath: string;
  readonly configPath: string;
  readonly worker: SuperviseRequest['worker'];
  readonly recoveryTurn: SuperviseRequest['recoveryTurn'];
  readonly maxAttempts?: number;
  readonly stop?: AbortSignal;
  readonly isAlive?: SuperviseRequest['isAlive'];
  readonly scope?: string | null;
  readonly reporter?: SuperviseRequest['reporter'];
  readonly lines?: string[];
}): Promise<SuperviseSummary> {
  const lines = overrides.lines ?? [];
  const reports: IncidentRecord[] = [];
  return await supervise({
    intent: overrides.scope === undefined || overrides.scope === null ? 'run' : 'ticket',
    scope: overrides.scope ?? null,
    workDir: overrides.workDir,
    namespace: 'namespace',
    repoPath: overrides.repoPath,
    configPath: overrides.configPath,
    projectConfigPath: path.join(overrides.repoPath, 'nexus.project.json'),
    installRoot: overrides.repoPath,
    entry: path.join(overrides.repoPath, 'cli.js'),
    interpreter: process.execPath,
    interpreterArgs: [],
    cwd: overrides.repoPath,
    recovery: {
      agent: { runtime: 'codex', command: ['codex', '--profile', 'nexus-recovery'] },
      maxAttempts: overrides.maxAttempts ?? 2,
      notifications: NOTIFICATION,
    },
    recoveryTurnTimeoutMs: 60 * 60_000,
    io: {
      out: (text) => lines.push(text),
      err: (text) => lines.push(text),
    },
    stop: overrides.stop ?? new AbortController().signal,
    now: () => new Date('2026-09-23T00:00:00.000Z'),
    recoveryTurn: overrides.recoveryTurn,
    reporter:
      overrides.reporter ??
      (async ({ incident }) => {
        reports.push(incident);
        return {
          report: {
            publishedAt: '2026-09-23T00:00:00.000Z',
            commentId: '10042',
            commentText: 'the report',
            notification: {
              topicArn: NOTIFICATION.topicArn,
              email: NOTIFICATION.email,
              state: 'sent' as const,
              messageId: 'message-1',
              problem: null,
            },
            problem: null,
          },
          problem: null,
        };
      }),
    logsDir: path.join(overrides.workDir, '.supervisor'),
    worker: overrides.worker,
    ...(overrides.isAlive === undefined ? {} : { isAlive: overrides.isAlive }),
  });
}

/**
 * The newest incident a supervision left behind. A settled one is no longer
 * pointed at — that is what a restart adopts, and settled work is finished —
 * but its record is kept as the incident's own evidence, which this case reads.
 */
async function storedIncident(workDir: string): Promise<IncidentRecord> {
  const root = supervisorRoot(workDir, 'namespace');
  const current = await readCurrentIncident(root);
  const ids = await readdir(path.join(root, 'incidents')).catch(() => [] as string[]);
  const pointed = current?.id ?? null;
  const ordered = [pointed, ...ids.sort().reverse()].filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
  for (const id of [...new Set(ordered)]) {
    const record = await readIncident(incidentFilePath(root, id));
    if (record !== null) {
      return record;
    }
  }
  throw new Error('the supervision left no incident record behind');
}

describe('a supervised queue', () => {
  it('recovers an unexpected stop, resumes the work, and records the resumption', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const recovery = scriptedRecovery([
      {
        status: 'repaired',
        summary: 'the worker was killed mid-run',
        cause: 'a killed consumer left a half-written run',
        resolution: 'the workspace was returned to its recorded branch',
        preserved: ['committed work on harness/HARN-51'],
        resume: 'HARN-51 resumes from that workspace',
      },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      scope: 'HARN-51',
      worker: scriptedWorker([ended(1), ended(0)]),
      recoveryTurn: recovery,
    });

    expect(summary.outcome).toBe('settled');
    expect(summary.workerRuns).toBe(2);
    expect(summary.recoveries).toBe(1);
    expect(recovery.calls).toBe(1);

    const incident = await storedIncident(workDir);
    expect(incident?.stops).toHaveLength(1);
    expect(incident?.attempts).toHaveLength(1);
    expect(incident?.attempts[0]).toMatchObject({
      outcome: 'repaired',
      cause: 'a killed consumer left a half-written run',
      resume: 'HARN-51 resumes from that workspace',
    });
    expect(incident?.conclusion?.outcome).toBe('repaired');
    expect(incident?.resumedAt).not.toBeNull();
    expect(incident?.report.commentId).toBe('10042');
    expect(incident?.report.notification?.state).toBe('sent');
  }, 30_000);

  it('ends an unchanged repeated failure in a request for human help', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const recovery = scriptedRecovery([
      {
        status: 'repaired',
        summary: 'the lock was explained',
        cause: 'a stale lock',
        resolution: 'the lock was explained and the work returned',
        preserved: [],
        resume: 'the queue resumes',
      },
      {
        status: 'repaired',
        summary: 'this second attempt should never run',
        cause: 'the same stale lock',
        resolution: 'nothing changed',
        preserved: [],
        resume: null,
      },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      worker: scriptedWorker([ended(1)]),
      recoveryTurn: recovery,
    });

    expect(summary.outcome).toBe('attention');
    expect(summary.problem).toContain('the same failure returned unchanged');
    expect(summary.workerRuns).toBe(2);
    expect(summary.recoveries).toBe(1);
    expect(recovery.calls).toBe(1);
    const incident = await storedIncident(workDir);
    expect(incident?.stage).toBe('help');
    expect(incident?.conclusion?.outcome).toBe('help');
    // The report of the human-help ending is published like any other.
    expect(incident?.report.commentId).toBe('10042');
  }, 30_000);

  it('bounds the attempts one incident may spend', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const recovery = scriptedRecovery([null]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      worker: scriptedWorker([ended(1)]),
      recoveryTurn: recovery,
      maxAttempts: 2,
    });

    expect(summary.outcome).toBe('attention');
    expect(summary.problem).toContain('the recovery bound was reached');
    expect(summary.recoveries).toBe(2);
    // The bound is reached before the queue runs again: the worker stopped
    // once, and two recovery turns could not return it to work.
    expect(summary.workerRuns).toBe(1);
    expect(recovery.calls).toBe(2);
    const incident = await storedIncident(workDir);
    expect(incident?.attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'failed']);
    expect(incident?.stage).toBe('help');
  }, 30_000);

  it('keeps an intentional cancellation stopped, and recovers nothing from it', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const stop = new AbortController();
    const recovery = scriptedRecovery([
      {
        status: 'repaired',
        summary: 's',
        cause: 'c',
        resolution: 'r',
        preserved: [],
        resume: null,
      },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      stop: stop.signal,
      worker: async () => {
        stop.abort(new Error('the user pressed Ctrl+C'));
        return { exitCode: 130, signal: null, launchProblem: null, stopRequested: true };
      },
      recoveryTurn: recovery,
    });

    expect(summary.outcome).toBe('cancelled');
    expect(summary.recoveries).toBe(0);
    expect(recovery.calls).toBe(0);
    const root = supervisorRoot(workDir, 'namespace');
    expect(await readCurrentIncident(root)).toBeNull();
    expect(await readFile(incidentFilePath(root, 'none'), 'utf8').catch(() => null)).toBeNull();
  }, 30_000);

  it('refuses to start a second worker while an adopted one is still running', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const root = supervisorRoot(workDir, 'namespace');
    const incident = await seedIncident(root);
    const recovery = scriptedRecovery([{ status: 'repaired', summary: 's', cause: 'c' }]);
    const live = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => true,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
    });

    expect(live.outcome).toBe('attention');
    expect(live.problem).toContain('still running');
    expect(live.workerRuns).toBe(0);
    expect(recovery.calls).toBe(0);

    // The same record, with its process really gone, is adopted and finished
    // instead: the report the earlier supervisor may not have published.
    const adopted = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => false,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
    });
    expect(adopted.workerRuns).toBe(1);
    expect(recovery.calls).toBe(0);
    const stored = await readIncident(incidentFilePath(root, incident.id));
    expect(stored?.report.commentId).toBe('10042');
  }, 30_000);
});

/** One concluded incident an earlier supervisor left behind, un-reported. */
async function seedIncident(root: string): Promise<IncidentRecord> {
  const { openIncident, writeCurrentIncident, writeIncident } =
    await import('../../src/supervisor/incident.js');
  const incident = openIncident(
    'namespace',
    'run',
    null,
    2,
    () => new Date('2026-09-23T00:00:00Z'),
  );
  const seeded: IncidentRecord = {
    ...incident,
    stage: 'settled',
    conclusion: {
      outcome: 'repaired',
      detail: 'the workspace was returned',
      at: '2026-09-23T00:03:00.000Z',
    },
    stops: [
      {
        at: '2026-09-23T00:01:00.000Z',
        intent: 'run',
        scope: null,
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
        outcome: 'repaired',
        summary: 'the workspace was returned',
        cause: 'a half-written run',
        resolution: 'the workspace was returned to its recorded branch',
        preserved: [],
        resume: null,
        blocker: null,
        help: null,
        problem: null,
        dir: null,
        logPath: null,
      },
    ],
  };
  await writeIncident(incidentFilePath(root, incident.id), seeded);
  await writeCurrentIncident(root, { version: 1, id: incident.id, workerPid: 4242 });
  await mkdir(incidentDir(root, incident.id), { recursive: true });
  return incident;
}
