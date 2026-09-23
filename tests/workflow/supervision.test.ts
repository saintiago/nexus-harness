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
import { RECOVERY_OUTCOME_FILE, parseRecoveryJudgment } from '../../src/supervisor/recovery.js';
import {
  incidentDir,
  incidentFilePath,
  readCurrentIncident,
  readIncident,
  supervisorRoot,
  writeCurrentIncident,
  writeIncident,
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
          shutdown: null,
          dir,
          logPath: null,
        };
    }
    const text = JSON.stringify(judgment);
    await writeFile(path.join(dir, 'outcome.json'), text, 'utf8');
    const parsed = parseRecoveryJudgment(text, 'outcome.json');
      if ('problem' in parsed) {
        return { judgment: null, problem: parsed.problem, shutdown: null, dir, logPath: null };
      }
      return {
        judgment: parsed,
        problem: null,
        shutdown: null,
        dir,
        logPath: path.join(dir, 'recovery.log'),
      };
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

  it('ends an unchanged repeated scoped failure in a request for human help', async () => {
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
      // The ticket is what makes the repetition unambiguous: the same worker,
      // for the same ticket, ending the same way, with nothing done in between.
      scope: 'HARN-51',
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

  it('investigates an unscoped repeat once, then asks for a person when nothing moves', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    // An unscoped `run` failure could be a different ticket entirely, so the
    // first repetition is investigated rather than assumed. A whole chain of
    // stops that each did nothing at all, every one of them already
    // investigated, is what ends in a person's hands.
    const recovery = scriptedRecovery([
      {
        status: 'repaired',
        summary: 'the queue was returned to work',
        cause: 'a stale lock',
        resolution: 'the lock was explained',
        preserved: [],
        resume: 'the queue resumes',
      },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      worker: scriptedWorker([ended(1)]),
      recoveryTurn: recovery,
      maxAttempts: 2,
    });

    expect(summary.outcome).toBe('attention');
    expect(summary.problem).toContain('without doing any work');
    // Two investigated incidents, then the third stop ends the supervision.
    expect(summary.workerRuns).toBe(3);
    expect(summary.recoveries).toBe(2);
    const incident = await storedIncident(workDir);
    expect(incident?.stage).toBe('help');
    expect(incident?.origin?.incident).not.toBeNull();
  }, 30_000);

  it('runs the blocker a blocked judgment ranked first, and records the resumption after it', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const requests: { intent: string; scope: string | null }[] = [];
    const recovery = scriptedRecovery([
      {
        status: 'blocked',
        summary: 'the shared module is broken',
        cause: 'HARN-77 has not landed',
        resolution: 'HARN-77 was returned to its ready status',
        preserved: ['committed work on harness/HARN-51'],
        resume: 'HARN-51 resumes once HARN-77 is done',
        blocker: { key: 'HARN-77', reason: 'it repairs the shared module' },
      },
    ]);
    const endings = [ended(1), ended(0), ended(0)];
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      scope: 'HARN-51',
      worker: async (request) => {
        requests.push({ intent: request.intent, scope: request.scope });
        return endings[requests.length - 1] ?? ended(0);
      },
      recoveryTurn: recovery,
    });

    expect(summary.outcome).toBe('settled');
    expect(requests.map((request) => request.scope)).toEqual(['HARN-51', 'HARN-77', 'HARN-51']);
    expect(requests[1]?.intent).toBe('ticket');
    const incident = await storedIncident(workDir);
    expect(incident?.conclusion?.outcome).toBe('blocked');
    expect(incident?.sequence?.blocker?.key).toBe('HARN-77');
    // The blocker really started, and the interrupted work really started
    // again: both are recorded, and the resumption only after the blocker.
    expect(incident?.sequence?.blockerStartedAt).not.toBeNull();
    expect(incident?.resumedAt).not.toBeNull();
  }, 30_000);

  it('carries an interrupted blocker to its confirmed result before resuming', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const root = supervisorRoot(workDir, 'namespace');
    // The state a crash *during the blocker* leaves: the incident is concluded
    // `blocked`, its blocker was started, no result of that blocker was ever
    // observed — and the pointer names the worker that died with the crash.
    const incident = await seedIncident(root);
    const seeded = await readIncident(incidentFilePath(root, incident.id));
    if (seeded === null) {
      throw new Error('the seeded incident is gone');
    }
    await writeIncident(incidentFilePath(root, incident.id), {
      ...seeded,
      scope: 'HARN-51',
      ticket: { key: 'HARN-51', url: null },
      conclusion: {
        outcome: 'blocked',
        detail: 'HARN-77 has to land first',
        at: '2026-09-23T00:03:00.000Z',
      },
      sequence: {
        intent: 'ticket',
        scope: 'HARN-51',
        blocker: { key: 'HARN-77', reason: 'it repairs the shared module' },
        blockerStartedAt: '2026-09-23T00:04:00.000Z',
        blockerSettledAt: null,
      },
    });
    await writeCurrentIncident(root, {
      version: 1,
      id: incident.id,
      workerPid: 4242,
      launch: { token: 'the-blocker', at: '2026-09-23T00:04:00.000Z' },
    });
    const requests: (string | null)[] = [];
    const recovery = scriptedRecovery([{ status: 'repaired', summary: 's', cause: 'c' }]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      scope: 'HARN-51',
      isAlive: () => false,
      worker: async (request) => {
        requests.push(request.scope);
        return ended(0);
      },
      recoveryTurn: recovery,
    });

    // The blocker runs again: its start alone was never its result. Only after
    // it really settles does the interrupted work run.
    expect(requests).toEqual(['HARN-77', 'HARN-51']);
    expect(summary.outcome).toBe('settled');
    expect(recovery.calls).toBe(0);
    const stored = await readIncident(incidentFilePath(root, incident.id));
    expect(stored?.sequence?.blockerStartedAt).not.toBeNull();
    expect(stored?.sequence?.blockerSettledAt).not.toBeNull();
    expect(stored?.resumedAt).not.toBeNull();
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

  it('adopts the judgment an interrupted attempt left behind instead of spending another', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const root = supervisorRoot(workDir, 'namespace');
    const incident = await seedIncident(root);
    // An earlier invocation wrote the attempt down and started its turn, then
    // stopped. The turn itself finished and left its judgment in its own
    // directory; the restart adopts exactly that, and counts it as spent.
    const dir = path.join(incidentDir(root, incident.id), 'attempt-1');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, RECOVERY_OUTCOME_FILE),
      JSON.stringify({
        status: 'repaired',
        summary: 'the retained judgment of an interrupted invocation',
        cause: 'a half-written run',
        resolution: 'the workspace was returned to its recorded branch',
        preserved: [],
        resume: 'the queue resumes',
        ticket: { key: 'HARN-51', url: 'https://site.atlassian.net/browse/HARN-51' },
      }),
      'utf8',
    );
      await seedPending(root, incident.id, { attempt: 2, dir, turnPid: 5252 });

    const recovery = scriptedRecovery([
      { status: 'repaired', summary: 'this turn should never run', cause: 'c' },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => false,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
    });

    expect(recovery.calls).toBe(0);
    expect(summary.outcome).toBe('settled');
    const stored = await readIncident(incidentFilePath(root, incident.id));
    expect(stored?.pending).toBeNull();
    expect(stored?.attempts).toHaveLength(2);
    expect(stored?.attempts[1]).toMatchObject({
      attempt: 2,
      outcome: 'repaired',
      cause: 'a half-written run',
    });
    // The ticket the adopted judgment named is what the report is written into.
    expect(stored?.ticket?.key).toBe('HARN-51');
    expect(stored?.report.commentId).toBe('10042');
  }, 30_000);

  it('counts an interrupted attempt toward the bound and asks for a person when it is spent', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const root = supervisorRoot(workDir, 'namespace');
    const incident = await seedIncident(root);
    const dir = path.join(incidentDir(root, incident.id), 'attempt-1');
    await mkdir(dir, { recursive: true });
      await seedPending(root, incident.id, { attempt: 2, dir, turnPid: 5252 });

    const recovery = scriptedRecovery([
      { status: 'repaired', summary: 'this turn should never run', cause: 'c' },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => false,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
      maxAttempts: 2,
    });

    // The interrupted attempt was really spent, so the bound is the bound: no
    // recovery runs, and the incident ends where a person has to look.
    expect(recovery.calls).toBe(0);
    expect(summary.workerRuns).toBe(0);
    const stored = await readIncident(incidentFilePath(root, incident.id));
    expect(stored?.attempts).toHaveLength(2);
    expect(stored?.attempts[1]?.problem).toContain('did not finish producing a judgment');
  }, 30_000);

  it('refuses to start a recovery turn while an earlier one is still running', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const root = supervisorRoot(workDir, 'namespace');
    const incident = await seedIncident(root);
      await seedPending(root, incident.id, {
        attempt: 1,
        dir: path.join(root, 'attempt-1'),
        turnPid: 5252,
      });
    const recovery = scriptedRecovery([{ status: 'repaired', summary: 's', cause: 'c' }]);

    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => true,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
    });

    expect(summary.outcome).toBe('attention');
    expect(summary.problem).toContain('recovery turn');
    expect(summary.workerRuns).toBe(0);
      expect(recovery.calls).toBe(0);
    }, 30_000);

    it('refuses the crash window between spawning a worker and recording it', async () => {
      const { workDir, repoPath, configPath } = await workspace();
      const root = supervisorRoot(workDir, 'namespace');
      // The pointer an invocation that died between spawning its worker and
      // recording the PID leaves behind: a launch, and no process. The worker it
      // started is gated on exactly that record, so it began nothing — and
      // nothing here may start a second worker beside a process nobody can name.
      await writeCurrentIncident(root, {
        version: 1,
        id: null,
        workerPid: null,
        launch: { token: 'never-registered', at: '2026-09-23T00:00:30.000Z' },
      });
      const recovery = scriptedRecovery([{ status: 'repaired', summary: 's', cause: 'c' }]);
      const summary = await runSupervision({
        workDir,
        repoPath,
        configPath,
        worker: scriptedWorker([ended(0)]),
        recoveryTurn: recovery,
      });

      expect(summary.outcome).toBe('attention');
      expect(summary.problem).toContain('never finished recording');
      expect(summary.problem).toContain('never-registered');
      expect(summary.workerRuns).toBe(0);
      expect(recovery.calls).toBe(0);
    }, 30_000);

    it('refuses the crash window between spawning a recovery turn and recording it', async () => {
      const { workDir, repoPath, configPath } = await workspace();
      const root = supervisorRoot(workDir, 'namespace');
      const incident = await seedIncident(root);
      const dir = path.join(incidentDir(root, incident.id), 'attempt-1');
      await mkdir(dir, { recursive: true });
      // An attempt with no runtime PID at all: nothing is handed to a recovery
      // turn before it is recorded, so this one never began — and a restart
      // cannot tell whether its runtime exists, so it refuses instead of
      // counting it as an attempt that produced nothing.
      await seedPending(root, incident.id, { attempt: 1, dir, turnPid: null });
      const recovery = scriptedRecovery([{ status: 'repaired', summary: 's', cause: 'c' }]);
      const summary = await runSupervision({
        workDir,
        repoPath,
        configPath,
        isAlive: () => true,
        worker: scriptedWorker([ended(0)]),
        recoveryTurn: recovery,
      });

      expect(summary.outcome).toBe('attention');
      expect(summary.problem).toContain('names no process');
      expect(summary.workerRuns).toBe(0);
      expect(summary.recoveries).toBe(0);
      expect(recovery.calls).toBe(0);
      const stored = await readIncident(incidentFilePath(root, incident.id));
      expect(stored?.pending).not.toBeNull();
    }, 30_000);

  it('does not read an unfinished run directory as the queue doing work', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    // The reviewer's failure: a worker that creates its run directory and then
    // stops on the same operational problem would otherwise look like progress
    // on every pass, so the unchanged failure would never be bounded.
    let created = 0;
    const recovery = scriptedRecovery([
      {
        status: 'repaired',
        summary: 'the lock was explained',
        cause: 'a stale lock',
        resolution: 'the lock was explained and the work returned',
        preserved: [],
        resume: 'the queue resumes',
      },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      scope: 'HARN-51',
      maxAttempts: 2,
      worker: async () => {
        created += 1;
        await mkdir(path.join(workDir, 'runs', `run-${String(created)}`), { recursive: true });
        return ended(1);
      },
      recoveryTurn: recovery,
    });

    expect(summary.outcome).toBe('attention');
    expect(summary.problem).toContain('unchanged');
    // One investigation, then a person: the second stop repeats the failure the
    // first recovery reported repaired, with nothing done in between.
    expect(summary.recoveries).toBe(1);
    expect(recovery.calls).toBe(1);
    expect(created).toBe(2);
    const incident = await storedIncident(workDir);
    expect(incident?.stage).toBe('help');
  }, 30_000);

  it('asks for a person when the same investigated cause returns after real work', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    let created = 0;
    const recovery = scriptedRecovery([
      {
        status: 'repaired',
        summary: 'the intake lock was explained',
        cause: 'the intake lock was stale',
        resolution: 'the lock was explained and the work returned',
        preserved: [],
        resume: 'the queue resumes',
        ticket: { key: 'HARN-51' },
      },
    ]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      maxAttempts: 2,
      worker: async () => {
        created += 1;
        // A run that really finished, whatever it concluded: that is the queue's
        // own evidence that it did something between the two stops.
        const dir = path.join(workDir, 'runs', `run-${String(created)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'result.json'), '{}', 'utf8');
        return ended(1);
      },
      recoveryTurn: recovery,
    });

    expect(summary.outcome).toBe('attention');
    expect(summary.problem).toContain('the same failure returned unchanged');
    expect(summary.problem).toContain('the intake lock was stale');
    // Both incidents were really investigated: the repetition is read from what
    // the two recoveries found, not from an exit code.
    expect(summary.recoveries).toBe(2);
    expect(created).toBe(2);
  }, 30_000);

  it('keeps a request for human help stopped until a person acknowledges it', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const root = supervisorRoot(workDir, 'namespace');
    const incident = await seedIncident(root);
    const seeded = await readIncident(incidentFilePath(root, incident.id));
    if (seeded === null) {
      throw new Error('the seeded incident is gone');
    }
    // The state an invocation leaves when it stops right after persisting an
    // exhausted conclusion: the incident asks for a person.
    await writeIncident(incidentFilePath(root, incident.id), {
      ...seeded,
      stage: 'help',
      sequence: null,
      conclusion: {
        outcome: 'help',
        detail: 'the shared module has to be repaired by hand',
        at: '2026-09-23T00:04:00.000Z',
      },
    });
    const recovery = scriptedRecovery([{ status: 'repaired', summary: 's', cause: 'c' }]);
    const stopped = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => false,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
    });

    expect(stopped.outcome).toBe('attention');
    expect(stopped.problem).toContain('human help');
    expect(stopped.workerRuns).toBe(0);
    expect(recovery.calls).toBe(0);

    // A person did what the request asked for and acknowledged it in the record:
    // the queue starts again, and nothing else about the incident is repeated.
    const held = await readIncident(incidentFilePath(root, incident.id));
    await writeIncident(incidentFilePath(root, incident.id), {
      ...(held ?? seeded),
      acknowledgement: {
        at: '2026-09-23T00:10:00.000Z',
        note: 'the shared module was repaired by hand',
      },
    });
    const resumed = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => false,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
    });

    expect(resumed.outcome).toBe('settled');
    expect(resumed.workerRuns).toBe(1);
    expect(recovery.calls).toBe(0);
  }, 30_000);

  it('holds for reconciliation when a recovery runtime could not be confirmed stopped', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const recovery: RecoveryTurn = async ({ dir, onStarted }) => {
      await mkdir(dir, { recursive: true });
      await onStarted?.(5252);
      return {
        judgment: null,
        problem:
          'the recovery turn was stopped before it produced a judgment — its time limit expired.',
        shutdown: {
          termination: 'unconfirmed',
          problem: 'the coding runtime had not ended 5000 ms after it was stopped',
        },
        dir,
        logPath: null,
      };
    };
    const held = await runSupervision({
      workDir,
      repoPath,
      configPath,
      worker: scriptedWorker([ended(1)]),
      recoveryTurn: recovery,
    });

    // Nothing else runs beside a process that may still be repairing the
    // workspace, and the incident keeps owning it.
    expect(held.outcome).toBe('attention');
    expect(held.problem).toContain('could not be confirmed stopped');
    expect(held.recoveries).toBe(1);
    expect(held.workerRuns).toBe(1);
    const incident = await storedIncident(workDir);
    expect(incident?.stage).toBe('open');
    expect(incident?.attempts).toHaveLength(0);
    expect(incident?.pending?.turnPid).toBe(5252);
    expect(incident?.pending?.problem).toContain('could not be confirmed stopped');

    // A restart that finds that runtime gone reconciles the attempt: it counts
    // as spent, and the incident goes on from there.
    const scripted = scriptedRecovery([
      {
        status: 'repaired',
        summary: 'the workspace was returned to its recorded branch',
        cause: 'the worker was killed mid-run',
        resolution: 'the workspace was returned',
        preserved: [],
        resume: 'the queue resumes',
        ticket: { key: 'HARN-51' },
      },
    ]);
    const resumed = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => false,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: scripted,
    });

    expect(resumed.outcome).toBe('settled');
    // The reconciled attempt is spent, the incident's remaining bound is spent
    // on the repair, and the resumed worker settles.
    expect(resumed.workerRuns).toBe(1);
    expect(resumed.recoveries).toBe(1);
    const stored = await readIncident(incidentFilePath(supervisorRoot(workDir, 'namespace'), incident?.id ?? ''));
    expect(stored?.pending).toBeNull();
    expect(stored?.attempts).toHaveLength(2);
    expect(stored?.attempts[0]?.problem).toContain('could not be confirmed stopped');
  }, 30_000);

  it('finishes a report an earlier invocation could not publish, without recovering again', async () => {
    const { workDir, repoPath, configPath } = await workspace();
    const root = supervisorRoot(workDir, 'namespace');
    const incident = await seedIncident(root);
    // The report failed in the earlier invocation: the summary never reached
    // the topic, and the incident's own record says so. A restart finishes that
    // publication — and never repeats the recovery that already succeeded.
    const seeded = await readIncident(incidentFilePath(root, incident.id));
    if (seeded === null) {
      throw new Error('the seeded incident is gone');
    }
    await writeIncident(incidentFilePath(root, incident.id), {
      ...seeded,
      report: {
        publishedAt: null,
        commentId: null,
        commentText: null,
        notification: {
          topicArn: NOTIFICATION.topicArn,
          email: NOTIFICATION.email,
          state: 'failed',
          messageId: null,
          problem: 'the publisher was not found',
        },
        problem: 'the email summary could not be published',
      },
    });

    const recovery = scriptedRecovery([{ status: 'repaired', summary: 's', cause: 'c' }]);
    const summary = await runSupervision({
      workDir,
      repoPath,
      configPath,
      isAlive: () => false,
      worker: scriptedWorker([ended(0)]),
      recoveryTurn: recovery,
    });

    expect(recovery.calls).toBe(0);
    const stored = await readIncident(incidentFilePath(root, incident.id));
    expect(stored?.report.notification?.state).toBe('sent');
    expect(stored?.report.problem).toBeNull();
    expect(stored?.report.commentId).toBe('10042');
    expect(summary.recoveries).toBe(0);
  }, 30_000);
});

/**
 * Replaces the seeded incident with one whose attempt is still in flight, as an
 * invocation that stopped mid-turn leaves it.
 */
  async function seedPending(
    root: string,
    id: string,
    pending: {
      readonly attempt: number;
      readonly dir: string;
      /** The runtime PID the attempt records, or none for the crash window. */
      readonly turnPid: number | null;
      readonly problem?: string | null;
    },
  ): Promise<void> {
  const file = incidentFilePath(root, id);
  const incident = await readIncident(file);
  if (incident === null) {
    throw new Error('the seeded incident is gone');
  }
  await writeIncident(file, {
    ...incident,
    stage: 'open',
    conclusion: null,
    attempts: incident.attempts.slice(0, pending.attempt - 1),
      pending: {
        attempt: pending.attempt,
        startedAt: '2026-09-23T00:02:00.000Z',
        supervisorPid: 4242,
        turnPid: pending.turnPid,
        dir: pending.dir,
        logPath: null,
        problem: pending.problem ?? null,
      },
    });
    await writeCurrentIncident(root, { version: 1, id, workerPid: null, launch: null });
}

/** One concluded incident an earlier supervisor left behind, un-reported. */
async function seedIncident(root: string): Promise<IncidentRecord> {
  const { openIncident } = await import('../../src/supervisor/incident.js');
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
    await writeCurrentIncident(root, {
      version: 1,
      id: incident.id,
      workerPid: 4242,
      launch: null,
    });
  await mkdir(incidentDir(root, incident.id), { recursive: true });
  return incident;
}
