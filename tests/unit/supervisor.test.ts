/**
 * The supervisor's own decisions: how a worker's ending is read, when two
 * failures are the same failure, what a recovery judgment may say, and what the
 * incident report and prompt carry.
 *
 * These are decisions over explicit evidence — a worker outcome, an incident
 * record, a judgment file, a configuration object — so they are decided here,
 * with no process, file or service. The assembled supervision, its locks and
 * its publications are the boundary and workflow layers' own cases
 * (docs/testing.md, docs/WORKFLOW.md §12).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECOVERY_PUBLISHER,
  DEFAULT_RECOVERY_SELECTION,
  harnessConfigSchema,
  RECOVERY_DEFAULTS,
} from '../../src/config/schema.js';
import {
  openIncident,
  stopSignature,
  unchangedAfterRecovery,
} from '../../src/supervisor/incident.js';
import type { IncidentRecord } from '../../src/supervisor/incident.js';
import { recoveryPrompt, parseRecoveryJudgment } from '../../src/supervisor/recovery.js';
import type { RecoveryBrief } from '../../src/supervisor/recovery.js';
import { incidentReportText } from '../../src/supervisor/report.js';
import { classifyWorkerStop, workerArguments } from '../../src/supervisor/worker.js';
import type { WorkerOutcome } from '../../src/supervisor/worker.js';

/** One worker ending, as the supervisor observes it. */
function outcome(overrides: Partial<WorkerOutcome>): WorkerOutcome {
  return {
    exitCode: 0,
    signal: null,
    launchProblem: null,
    stopRequested: false,
    ...overrides,
  };
}

/** One incident with a stop and, optionally, a recovery attempt behind it. */
function incidentWith(options: {
  readonly stops: readonly (readonly [number | null, string | null])[];
  readonly lastAttempt?: 'repaired' | 'blocked' | 'failed';
  readonly scope?: string | null;
}): IncidentRecord {
  const scope = options.scope ?? null;
  const base = openIncident(
    'namespace',
    scope === null ? 'run' : 'ticket',
    scope,
    2,
    () => new Date('2026-09-23T00:00:00Z'),
  );
  return {
    ...base,
    ...(options.lastAttempt === 'repaired' || options.lastAttempt === 'blocked'
      ? {
          stage: 'settled' as const,
          conclusion: {
            outcome: options.lastAttempt,
            detail: 'the recovery agent returned the queue to work',
            at: '2026-09-23T00:03:00.000Z',
          },
          // A concluded incident that returned the queue to work owes the very
          // work the stop interrupted: that is what a repeated stop repeats.
          sequence: {
            intent: scope === null ? ('run' as const) : ('ticket' as const),
            scope,
            blocker: null,
            blockerStartedAt: null,
          },
        }
      : {}),
    stops: options.stops.map(([exitCode, signal]) => ({
      at: '2026-09-23T00:01:00.000Z',
      intent: scope === null ? ('run' as const) : ('ticket' as const),
      scope,
      exitCode,
      signal,
      signature: stopSignature(scope === null ? 'run' : 'ticket', scope, exitCode, signal),
    })),
    attempts:
      options.lastAttempt === undefined
        ? []
        : [
            {
              attempt: 1,
              startedAt: '2026-09-23T00:02:00.000Z',
              endedAt: '2026-09-23T00:03:00.000Z',
              outcome: options.lastAttempt,
              summary: 'the recovery agent reported on the stop',
              cause: 'a stale lock',
              resolution: 'the lock was explained and the work returned to the queue',
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
}

describe('how a worker ending is read', () => {
  it('treats a plain zero exit as settled work', () => {
    expect(classifyWorkerStop(outcome({}))).toBe('settled');
  });

  it('treats any other ending as an unexpected stop, a crash included', () => {
    expect(classifyWorkerStop(outcome({ exitCode: 1 }))).toBe('stopped');
    expect(classifyWorkerStop(outcome({ exitCode: null, signal: 'SIGKILL' }))).toBe('stopped');
    expect(
      classifyWorkerStop(outcome({ exitCode: null, signal: null, launchProblem: 'not found' })),
    ).toBe('stopped');
  });

  it('keeps an intentional cancellation stopped', () => {
    expect(classifyWorkerStop(outcome({ exitCode: 130, stopRequested: true }))).toBe('cancelled');
    expect(
      classifyWorkerStop(outcome({ exitCode: null, signal: 'SIGINT', stopRequested: true })),
    ).toBe('cancelled');
    // The same ending without the operator's own request is a crash.
    expect(classifyWorkerStop(outcome({ exitCode: 130 }))).toBe('stopped');
  });
});

describe('when a resumed worker fails with the very failure that was repaired', () => {
  const repaired = incidentWith({ stops: [[1, null]], lastAttempt: 'repaired', scope: 'HARN-51' });
  const same = {
    intent: 'ticket' as const,
    scope: 'HARN-51',
    exitCode: 1,
    signal: null,
    progress: false,
  };

  it('sees the identical scoped ending, with no progress between, as unchanged', () => {
    expect(unchangedAfterRecovery(repaired, same)).toBe(true);
  });

  it('never reads an unscoped ending as unchanged: only an investigation can say', () => {
    // An exit code is conventional, so a `run` or `watch` failure could be a
    // different ticket entirely — and only the recovery turn's own look at the
    // workspace and the queue can say which. That stop opens its own incident.
    const unscoped = incidentWith({ stops: [[1, null]], lastAttempt: 'repaired' });
    expect(unchangedAfterRecovery(unscoped, { ...same, intent: 'run', scope: null })).toBe(false);
  });

  it('does not see a different ending, or one where the work moved on, that way', () => {
    expect(unchangedAfterRecovery(repaired, { ...same, exitCode: 2 })).toBe(false);
    expect(unchangedAfterRecovery(repaired, { ...same, signal: 'SIGKILL' })).toBe(false);
    // Run evidence written since the resumption is progress: whatever failed
    // this time, it is not the same unrepaired failure.
    expect(unchangedAfterRecovery(repaired, { ...same, progress: true })).toBe(false);
  });

  it('does not see an unrepaired attempt, another ticket, or a help ending that way', () => {
    expect(
      unchangedAfterRecovery(
        incidentWith({ stops: [[1, null]], lastAttempt: 'failed', scope: 'HARN-51' }),
        same,
      ),
    ).toBe(false);
    expect(unchangedAfterRecovery(repaired, { ...same, scope: 'HARN-77' })).toBe(false);
    expect(
      unchangedAfterRecovery(incidentWith({ stops: [[1, null]], scope: 'HARN-51' }), same),
    ).toBe(false);
    // An incident that already ended in a request for human help is reported,
    // not recovered again.
    expect(
      unchangedAfterRecovery(
        {
          ...repaired,
          stage: 'help',
          conclusion: { outcome: 'help', detail: 'a person is needed', at: 't' },
        },
        same,
      ),
    ).toBe(false);
  });

  it('gives one ending one signature, and a ticket scope its own', () => {
    expect(stopSignature('run', null, 1, null)).toBe(stopSignature('run', null, 1, null));
    expect(stopSignature('run', null, 1, null)).not.toBe(stopSignature('run', null, 2, null));
    expect(stopSignature('run', null, 1, null)).not.toBe(stopSignature('run', 'HARN-51', 1, null));
  });
});

describe('the recovery judgment a turn may write', () => {
  const repaired = JSON.stringify({
    status: 'repaired',
    summary: 'the worker crashed on a stale lock',
    cause: 'a lock left by a killed consumer',
    resolution: 'the lock was explained and the queue returned to its ready status',
    preserved: ['workspace HARN-51 kept at its recorded branch'],
    resume: 'HARN-51 resumes from its retained workspace',
  });

  it('reads a complete judgment', () => {
    const parsed = parseRecoveryJudgment(repaired, 'outcome.json');
    expect(parsed).toMatchObject({
      status: 'repaired',
      cause: 'a lock left by a killed consumer',
      preserved: ['workspace HARN-51 kept at its recorded branch'],
    });
  });

  it('refuses a judgment that runs past a bound rather than cutting it down', () => {
    const parsed = parseRecoveryJudgment(
      JSON.stringify({
        status: 'repaired',
        summary: 'x'.repeat(4_001),
        cause: 'a cause',
      }),
      'outcome.json',
    );
    expect('problem' in parsed && parsed.problem).toContain('past the');
  });

  it('refuses an unexplained blocked or unrecoverable verdict', () => {
    const blocked = parseRecoveryJudgment(
      JSON.stringify({ status: 'blocked', summary: 's', cause: 'c' }),
      'outcome.json',
    );
    expect('problem' in blocked && blocked.problem).toContain('without naming the blocker');
    const help = parseRecoveryJudgment(
      JSON.stringify({ status: 'unrecoverable', summary: 's', cause: 'c' }),
      'outcome.json',
    );
    expect('problem' in help && help.problem).toContain('what a person must');
    const missing = parseRecoveryJudgment(
      JSON.stringify({ status: 'in_progress' }),
      'outcome.json',
    );
    expect('problem' in missing && missing.problem).toContain('instead of');
    const broken = parseRecoveryJudgment('not json', 'outcome.json');
    expect('problem' in broken && broken.problem).toContain('not valid JSON');
  });

  it('reads a blocker ranked ahead of the interrupted work', () => {
    const parsed = parseRecoveryJudgment(
      JSON.stringify({
        status: 'blocked',
        summary: 'a dependency ticket has to land first',
        cause: 'the interrupted work depends on a broken shared module',
        resolution: 'HARN-77 was returned to its queue',
        resume: 'the interrupted ticket resumes after HARN-77 lands',
        blocker: { key: 'HARN-77', reason: 'its change repairs the shared module' },
      }),
      'outcome.json',
    );
    expect(parsed).toMatchObject({
      status: 'blocked',
      blocker: { key: 'HARN-77', reason: 'its change repairs the shared module' },
    });
  });
});

describe('what the recovery turn is told', () => {
  const brief: RecoveryBrief = {
    incidentId: 'incident-1',
    incidentPath: 'runs/.supervisor/namespace/incidents/incident-1/incident.json',
    dir: 'runs/.supervisor/namespace/incidents/incident-1/attempt-1',
    installRoot: 'C:/nexus',
    workDir: 'runs',
    repoPath: 'C:/target',
    configPath: 'C:/nexus.config.json',
    projectConfigPath: 'C:/target/nexus.project.json',
    intent: 'ticket',
    scope: 'HARN-51',
    attempt: 2,
    maxAttempts: 2,
    timeoutMinutes: 60,
    stop: {
      at: '2026-09-23T00:01:00.000Z',
      intent: 'ticket',
      scope: 'HARN-51',
      exitCode: null,
      signal: 'SIGKILL',
      signature: 'signature',
    },
    earlier: [],
    previous: {
      id: 'incident-0',
      path: 'runs/.supervisor/namespace/incidents/incident-0/incident.json',
    },
    jira: { siteUrl: 'https://site.atlassian.net', projectKey: 'HARN' },
    notification: { topicArn: 'arn:aws:sns:eu-north-1:1:topic', email: 'a@b.example' },
  };

  it('carries the incident, the paths, the bound and the outcome contract', () => {
    const prompt = recoveryPrompt(brief);
    expect(prompt).toContain('incident-1');
    expect(prompt).toContain('ended on signal SIGKILL');
    expect(prompt).toContain('C:/nexus');
    expect(prompt).toContain('attempt 2 of at most 2');
    expect(prompt).toContain('HARN-51');
    expect(prompt).toContain('outcome.json');
    expect(prompt).toContain('a@b.example');
    // The previous incident is named, and the ticket the report belongs to is
    // part of the judgment the turn has to write.
    expect(prompt).toContain('incident-0');
    expect(prompt).toContain('"ticket"');
    // The rules that stay with the ordinary harness, and the one authority a
    // recovery turn may not borrow.
    expect(prompt).toContain('never a substitute for a passed check');
    expect(prompt).toContain('Do not weaken, skip, delete, or loosen');
  });
});

describe('the incident report', () => {
  const notification = {
    topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
    email: 'saint282@gmail.com',
    publisher: ['aws', 'sns', 'publish'],
  };

  it('reports the cause, the preserved work, the resumption and the email', () => {
    const incident: IncidentRecord = {
      ...incidentWith({ stops: [[null, 'SIGKILL']], lastAttempt: 'blocked' }),
      scope: 'HARN-51',
      ticket: { key: 'HARN-51', url: 'https://site.atlassian.net/browse/HARN-51' },
      attempts: [
        {
          attempt: 1,
          startedAt: '2026-09-23T00:02:00.000Z',
          endedAt: '2026-09-23T00:03:00.000Z',
          outcome: 'blocked',
          summary: 'a blocker has to land first',
          cause: 'a shared module is broken',
          resolution: 'HARN-77 was returned to its queue',
          preserved: ['workspace HARN-51 kept on its recorded branch'],
          resume: 'HARN-51 resumes after HARN-77',
          blocker: { key: 'HARN-77', reason: 'it repairs the shared module' },
          help: null,
          problem: null,
          dir: null,
          logPath: null,
        },
      ],
      conclusion: {
        outcome: 'blocked',
        detail: 'HARN-77 is ranked ahead',
        at: '2026-09-23T00:03:00.000Z',
      },
      report: {
        publishedAt: null,
        commentId: null,
        commentText: null,
        notification: {
          topicArn: notification.topicArn,
          email: notification.email,
          state: 'failed',
          messageId: null,
          problem: 'the publisher was not found',
        },
        problem: 'the summary could not be published',
      },
    };
    const report = incidentReportText(incident, notification);
    expect(report.subject).toContain('HARN-51');
    expect(report.text).toContain('ended on signal SIGKILL');
    expect(report.text).toContain('a shared module is broken');
    expect(report.text).toContain('Blocker ranked first: HARN-77 — it repairs the shared module');
    expect(report.text).toContain('Resumption recorded: HARN-51 resumes after HARN-77');
    expect(report.text).toContain('workspace HARN-51 kept on its recorded branch');
    expect(report.text).toContain('not confirmed');
    expect(report.text).toContain('Reporting problem: the summary could not be published');
    expect(report.text).toContain('never substitutes for a passed check');
  });
});

describe('the configured recovery policy', () => {
  const HARNESS = {
    workDir: 'runs',
    maxRepairs: 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
  };

  it('defaults to the nexus-recovery profile, gpt-6-astra at high effort, and two attempts', () => {
    const parsed = harnessConfigSchema.parse({ ...HARNESS, recovery: {} });
    expect(parsed.recovery?.maxAttempts).toBe(RECOVERY_DEFAULTS.maxAttempts);
    expect(DEFAULT_RECOVERY_SELECTION.command).toEqual([
      'codex',
      '--profile',
      'nexus-recovery',
      '--model',
      'gpt-6-astra',
      '-c',
      'model_reasoning_effort=high',
    ]);
    expect(DEFAULT_RECOVERY_PUBLISHER).toEqual(['aws', 'sns', 'publish']);
  });

  it('refuses a notification policy that could not be published to', () => {
    const result = harnessConfigSchema.safeParse({
      ...HARNESS,
      recovery: { notifications: { topicArn: 'not-an-arn', email: 'nobody' } },
    });
    expect(result.success).toBe(false);
    const problems = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(problems.join('\n')).toContain('SNS topic ARN');
    expect(problems.join('\n')).toContain('email address');
  });

  it('refuses zero attempts: an incident gets at least one recovery turn', () => {
    const result = harnessConfigSchema.safeParse({ ...HARNESS, recovery: { maxAttempts: 0 } });
    expect(result.success).toBe(false);
  });

  it('refuses an unknown recovery field rather than ignoring it', () => {
    const result = harnessConfigSchema.safeParse({ ...HARNESS, recovery: { retries: 3 } });
    expect(result.success).toBe(false);
  });

  it('names the worker command a scoped intent runs', () => {
    expect(
      workerArguments({
        intent: 'ticket',
        scope: 'HARN-51',
        repoPath: 'C:/target',
        configPath: 'C:/nexus.config.json',
      }),
    ).toEqual([
      'queue',
      'run',
      '--repo',
      'C:/target',
      '--config',
      'C:/nexus.config.json',
      '--ticket',
      'HARN-51',
    ]);
    expect(
      workerArguments({
        intent: 'watch',
        scope: null,
        repoPath: 'C:/target',
        configPath: 'C:/nexus.config.json',
      }),
    ).toEqual(['queue', 'watch', '--repo', 'C:/target', '--config', 'C:/nexus.config.json']);
  });
});

describe('the incident record a restart adopts', () => {
  it('starts open, spends nothing, and records no resumption yet', () => {
    const record = openIncident(
      'namespace',
      'run',
      null,
      2,
      () => new Date('2026-09-23T00:00:00Z'),
    );
    expect(record).toMatchObject({
      version: 1,
      namespace: 'namespace',
      intent: 'run',
      stage: 'open',
      maxAttempts: 2,
      resumedAt: null,
      stops: [],
      attempts: [],
      conclusion: null,
    });
    expect(record.report).toMatchObject({
      publishedAt: null,
      commentId: null,
      notification: null,
      problem: null,
    });
  });
});
