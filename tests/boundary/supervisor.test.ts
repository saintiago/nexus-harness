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
import { pathToFileURL } from 'node:url';
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
  holderFilePath,
  holdersDir,
  intakeConsumerProblem,
  processIsAlive,
} from '../../src/supervisor/owner.js';
import { createIncidentReporter } from '../../src/supervisor/report.js';
import { readTicketCompletion } from '../../src/supervisor/completion.js';
import { createRecoveryTurn } from '../../src/supervisor/recovery.js';
import type { RecoveryBrief } from '../../src/supervisor/recovery.js';
import { runNexusWorker, WORKER_STOP_GRACE_MS } from '../../src/supervisor/worker.js';
import { EXIT_INPUT_ERROR, EXIT_OK } from '../../src/cli/context.js';
import { superviseCli } from '../../src/cli/supervise.js';
import { createHttpClient } from '../../src/sources/jira/http.js';
import { intakeLockPath } from '../../src/sources/receipts.js';
import { runCommand } from '../../src/process/command.js';
import { repoRoot } from '../support.js';
import {
  installStandIn,
  pause,
  runProgram,
  serviceFetch,
  startLocalService,
  withPathPrefix,
} from './integration-support.js';
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
    await writeCurrentIncident(root, {
      version: 1,
      id: incident.id,
      workerPid: null,
      launch: null,
    });
    expect(await readCurrentIncident(root)).toEqual({
      version: 1,
      id: incident.id,
      workerPid: null,
      launch: null,
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

/** Every claim file one supervision's root currently holds, by rank. */
async function heldClaims(root: string): Promise<readonly string[]> {
  return (await readdir(holdersDir(root)).catch(() => [] as string[])).sort();
}

describe('the supervisor’s own ownership', () => {
  it('lets exactly one of two starts own the queue, whoever publishes its claim first', async () => {
    const root = await tempDir();
    const now = (): Date => new Date('2026-09-23T00:00:00Z');
    // The claim is the lock: the exclusive publication of a rank decides, so
    // two invocations that both read an unclaimed root cannot both own it.
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
    expect(await heldClaims(root)).toEqual([]);
  }, 30_000);

  it('adopts a claim an interrupted start left behind, exactly once', async () => {
    const root = await tempDir();
    const now = (): Date => new Date('2026-09-23T00:00:00Z');
    // An invocation that published its claim and then died before deciding:
    // its process is nobody's, so the claim cannot own anything and the next
    // start takes the queue over rather than refusing beside a dead claim.
    const stale = JSON.stringify({
      version: 1,
      pid: 4242,
      token: 'stale',
      startedAt: 't',
      intent: 'run',
      repoPath: 'C:/target',
      rank: 1,
    });
    await mkdir(holdersDir(root), { recursive: true });
    await writeFile(holderFilePath(root, 1), stale, 'utf8');
    const isAlive = (pid: number): boolean => pid === process.pid;
    const takes = await Promise.all([
      acquireSupervisorOwnership({ root, intent: 'run', repoPath: 'C:/target', now, isAlive }),
      acquireSupervisorOwnership({ root, intent: 'run', repoPath: 'C:/target', now, isAlive }),
    ]);
    expect(takes.filter((take) => take.ok)).toHaveLength(1);
    const owner = takes.find((take) => take.ok);
    if (owner?.ok !== true) {
      throw new Error('nobody owned the queue');
    }
    expect(owner.ownership.record.pid).toBe(process.pid);
    // The dead claim was taken away, and only the live one is left.
    expect(await heldClaims(root)).toEqual(['holder-000002.json']);
    await owner.ownership.release();
    expect(await heldClaims(root)).toEqual([]);
  }, 30_000);

  it('refuses a second and a third start beside a live claim, and removes nothing', async () => {
    const root = await tempDir();
    const now = (): Date => new Date('2026-09-23T00:00:00Z');
    const isAlive = (pid: number): boolean => pid === process.pid;

    // A acquires the queue and owns it.
    const a = await acquireSupervisorOwnership({
      root,
      intent: 'run',
      repoPath: 'C:/target',
      now,
      isAlive,
    });
    expect(a.ok).toBe(true);
    const aFile = holderFilePath(root, 1);
    const aRecord = JSON.parse(await readFile(aFile, 'utf8')) as { token: string };

    // B publishes its own claim and is held exactly there — the schedule the
    // race turns on: its rank is above A's, so it can never overtake A, and it
    // must not remove anything of A's while it decides.
    let releaseB: () => void = () => undefined;
    const bHeld = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let bPublished: () => void = () => undefined;
    const published = new Promise<void>((resolve) => {
      bPublished = resolve;
    });
    const b = acquireSupervisorOwnership({
      root,
      intent: 'run',
      repoPath: 'C:/target',
      now,
      isAlive,
      onClaimPublished: async (claim) => {
        expect(claim.rank).toBe(2);
        bPublished();
        await bHeld;
      },
    });
    await published;

    // C starts beside the two claims already there. Whatever it does, it can
    // never end up owning the queue beside A: A's claim is live and below it.
    const c = await acquireSupervisorOwnership({
      root,
      intent: 'watch',
      repoPath: 'C:/target',
      now,
      isAlive,
    });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.problem).toContain('another supervisor already runs');
    }
    expect(JSON.parse(await readFile(aFile, 'utf8'))).toEqual(aRecord);

    // B resumes with its claim published before C's attempt and after A's
    // ownership: it refuses by name, and A's claim is exactly as it was.
    releaseB();
    const bResult = await b;
    expect(bResult.ok).toBe(false);
    if (!bResult.ok) {
      expect(bResult.problem).toContain('another supervisor already runs');
    }
    expect(JSON.parse(await readFile(aFile, 'utf8'))).toEqual(aRecord);
    expect(await heldClaims(root)).toEqual(['holder-000001.json']);

    if (a.ok) {
      await a.ownership.release();
    }
    expect(await heldClaims(root)).toEqual([]);
  }, 30_000);

  it('withdraws a claim a delayed contender publishes below one already deciding', async () => {
    const root = await tempDir();
    const now = (): Date => new Date('2026-09-23T00:00:00Z');
    const isAlive = (pid: number): boolean => pid === process.pid;

    // A reads the empty directory and is delayed before it publishes: the rank
    // it worked out is stale the moment another start takes that rank.
    let releaseA: () => void = () => undefined;
    const aHeld = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aPublished: () => void = () => undefined;
    const aAtPublication = new Promise<void>((resolve) => {
      aPublished = resolve;
    });
    let aPaused = false;
    let readRank: number | null = null;
    const a = acquireSupervisorOwnership({
      root,
      intent: 'run',
      repoPath: 'C:/target',
      now,
      isAlive,
      beforeClaimPublish: async (rank) => {
        if (aPaused) {
          return;
        }
        aPaused = true;
        readRank = rank;
        aPublished();
        await aHeld;
      },
    });
    await aAtPublication;
    // A read an empty directory: the rank it is holding on to is the first one.
    expect(readRank).toBe(1);

    // B takes the queue under that rank while A is still delayed.
    const b = await acquireSupervisorOwnership({
      root,
      intent: 'run',
      repoPath: 'C:/target',
      now,
      isAlive,
    });
    expect(b.ok).toBe(true);

    // C publishes the rank above B's and is delayed before it decides. B then
    // releases, so C's own decision no longer sees a live claim below it: C
    // really owns the queue, under a rank A's stale listing never held.
    let releaseC: () => void = () => undefined;
    const cHeld = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    let cPublished: () => void = () => undefined;
    const cAtPublication = new Promise<void>((resolve) => {
      cPublished = resolve;
    });
    const c = acquireSupervisorOwnership({
      root,
      intent: 'watch',
      repoPath: 'C:/target',
      now,
      isAlive,
      onClaimPublished: async (claim) => {
        expect(claim.rank).toBe(2);
        cPublished();
        await cHeld;
      },
    });
    await cAtPublication;
    if (b.ok) {
      await b.ownership.release();
    }
    releaseC();
    const cResult = await c;
    expect(cResult.ok).toBe(true);

    // A resumes. The rank it named is free again, so its publication lands
    // below C's — and it must not read that as owning the queue beside the
    // invocation that really does.
    releaseA();
    const aResult = await a;
    expect(aResult.ok).toBe(false);
    if (!aResult.ok) {
      expect(aResult.problem).toContain('another supervisor already runs');
    }
    // Exactly one claim is held: C's, above the rank A's stale listing named.
    expect(await heldClaims(root)).toEqual(['holder-000002.json']);
    if (cResult.ok) {
      await cResult.ownership.release();
    }
    expect(await heldClaims(root)).toEqual([]);
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
    const file = holderFilePath(root, 1);
    const held = JSON.parse(await readFile(file, 'utf8')) as { token: string };
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
    // The live claim was not touched by the refused invocation.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(held);
    // The same claim with its process gone cannot own anything: a restart
    // adopts the queue, and the dead claim is cleared away with it.
    const adopted = await acquireSupervisorOwnership({
      root,
      intent: 'watch',
      repoPath: 'C:/target',
      now,
      isAlive: () => false,
    });
    expect(adopted.ok).toBe(true);
    if (first.ok) {
      // The first holder's claim is gone, so its release leaves the holder in
      // place: it no longer owns the queue.
      await first.ownership.release();
    }
    if (adopted.ok) {
      expect(await heldClaims(root)).toEqual([path.basename(adopted.ownership.file)]);
      await adopted.ownership.release();
    }
    expect(await heldClaims(root)).toEqual([]);
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
      onStarted: (pid) => {
        started.push(pid);
      },
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

  it('starts the worker it launched only once its launch is really recorded', async () => {
    const directory = await tempDir();
    const record = path.join(directory, 'current.json');
    const marker = path.join(directory, 'proceeded.txt');
    // The gate, as the real CLI carries it: a worker reads the launch out of its
    // own environment and waits for the supervisor's record to name it before
    // it does anything.
    const entry = path.join(directory, 'gated.mts');
    await writeFile(
      entry,
      [
        "import { writeFile } from 'node:fs/promises';",
        `import { awaitLaunchRegistration, launchFromEnvironment } from ${JSON.stringify(
          pathToFileURL(path.join(repoRoot, 'src', 'supervisor', 'launch.js')).href,
        )};`,
        'const launch = launchFromEnvironment(process.env);',
        'if (launch === null) { process.exit(4); }',
        'const problem = await awaitLaunchRegistration({ ...launch, pid: process.pid, timeoutMs: 30_000 });',
        'if (problem !== null) { process.exit(5); }',
        `await writeFile(${JSON.stringify(marker)}, 'the worker proceeded');`,
      ].join('\n'),
      'utf8',
    );
    const launch = { file: record, token: 'launch-1' };

    // The supervisor's half completes the record with the child's own PID: the
    // child proceeds, and its work is what the record named.
    const outcome = await runNexusWorker({
      entry,
      interpreter: process.execPath,
      interpreterArgs: ['--import', 'tsx'],
      intent: 'run',
      scope: null,
      repoPath: directory,
      configPath: path.join(directory, 'nexus.config.json'),
      cwd: repoRoot,
      stop: new AbortController().signal,
      launch,
      onStarted: async (pid) => {
        await writeFile(
          record,
          JSON.stringify({
            version: 1,
            id: null,
            workerPid: pid,
            launch: { token: launch.token, at: '2026-09-23T00:00:00.000Z' },
          }),
          'utf8',
        );
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.launchProblem).toBeNull();
    expect(await readFile(marker, 'utf8')).toContain('the worker proceeded');

    // A registration that fails stops the child where it waits: it began
    // nothing, and the launch's failure is what the supervisor is given rather
    // than a worker that ran under a record nothing holds.
    await rm(marker, { force: true });
    await rm(record, { force: true });
    await expect(
      runNexusWorker({
        entry,
        interpreter: process.execPath,
        interpreterArgs: ['--import', 'tsx'],
        intent: 'run',
        scope: null,
        repoPath: directory,
        configPath: path.join(directory, 'nexus.config.json'),
        cwd: repoRoot,
        stop: new AbortController().signal,
        launch,
        onStarted: async () => {
          throw new Error('the pointer could not be written');
        },
      }),
    ).rejects.toThrow(/could not be registered/);
    expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
  }, 60_000);

  it('sees a worker that ends while its own registration is still being written', async () => {
    const directory = await tempDir();
    // A worker that ends immediately: whichever way it got there, its ending
    // happens while the supervisor is still writing down that it started.
    const entry = await workerScript(directory, 'process.exit(7);\n');
    const outcome = await runNexusWorker({
      entry,
      interpreter: process.execPath,
      intent: 'run',
      scope: null,
      repoPath: directory,
      configPath: path.join(directory, 'nexus.config.json'),
      cwd: directory,
      stop: new AbortController().signal,
      onStarted: async () => {
        await pause(250);
      },
    });
    // The ending is kept, not lost: a supervisor that missed it would wait for
    // work that is already over, and would never invoke recovery for it.
    expect(outcome.exitCode).toBe(7);
    expect(outcome.signal).toBeNull();
    expect(outcome.launchProblem).toBeNull();
    expect(outcome.stopRequested).toBe(false);
  }, 30_000);

  it('keeps a launched worker waiting for a registration that lands late', async () => {
    const directory = await tempDir();
    const record = path.join(directory, 'current.json');
    const pidFile = path.join(directory, 'pid.txt');
    const marker = path.join(directory, 'waited.txt');
    const entry = path.join(directory, 'waiting.mts');
    await writeFile(
      entry,
      [
        `import { writeFile } from 'node:fs/promises';`,
        `import { awaitLaunchRegistration } from ${JSON.stringify(
          pathToFileURL(path.join(repoRoot, 'src', 'supervisor', 'launch.js')).href,
        )};`,
        `await writeFile(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');`,
        `const problem = await awaitLaunchRegistration({ file: ${JSON.stringify(record)}, token: 'late', pid: process.pid, timeoutMs: 30_000 });`,
        `await writeFile(${JSON.stringify(marker)}, problem === null ? 'proceeded' : problem, 'utf8');`,
      ].join('\n'),
      'utf8',
    );

    const waiting = runProgram(process.execPath, ['--import', 'tsx', entry], { cwd: repoRoot });
    let pid: number | null = null;
    for (let attempt = 0; attempt < 100 && pid === null; attempt += 1) {
      const text = await readFile(pidFile, 'utf8').catch(() => '');
      pid = text.trim() === '' ? null : Number(text.trim());
      if (pid === null) {
        await pause(50);
      }
    }
    expect(pid).not.toBeNull();
    // The registration lands after the child has been waiting for a while: a
    // wait that let the process exit would leave the launch undecided.
    await pause(250);
    await writeFile(
      record,
      JSON.stringify({
        version: 1,
        launch: { token: 'late', at: '2026-09-23T00:00:00.000Z' },
        workerPid: pid,
      }),
      'utf8',
    );

    const outcome = await waiting;
    expect(outcome.code).toBe(0);
    expect(await readFile(marker, 'utf8')).toBe('proceeded');
  }, 60_000);

  it('keeps a launched worker alive to give up by itself when nothing registers it', async () => {
    const directory = await tempDir();
    const record = path.join(directory, 'current.json');
    const marker = path.join(directory, 'waited.txt');
    const entry = path.join(directory, 'giving-up.mts');
    await writeFile(
      entry,
      [
        `import { writeFile } from 'node:fs/promises';`,
        `import { awaitLaunchRegistration } from ${JSON.stringify(
          pathToFileURL(path.join(repoRoot, 'src', 'supervisor', 'launch.js')).href,
        )};`,
        `const problem = await awaitLaunchRegistration({ file: ${JSON.stringify(record)}, token: 'never', pid: process.pid, timeoutMs: 1_500 });`,
        `await writeFile(${JSON.stringify(marker)}, problem ?? 'proceeded', 'utf8');`,
      ].join('\n'),
      'utf8',
    );
    const startedAt = Date.now();
    const outcome = await runProgram(process.execPath, ['--import', 'tsx', entry], {
      cwd: repoRoot,
    });
    // The wait really lasts its own bound, and it ends in a diagnostic rather
    // than in a process that exited with the launch never decided.
    expect(outcome.code).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_200);
    expect(await readFile(marker, 'utf8')).toContain('never registered it');
  }, 60_000);

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
          ending: 'exited' as const,
          launch: null,
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
        notification: null,
        logsDir: () => path.join(directory, 'logs'),
        cwd: directory,
        now: () => new Date('2026-09-23T00:04:00.000Z'),
      });
      const jira = { kind: 'jira' as const, http, token: 'token' };
      const first = await reporter({
        incident,
        stop: new AbortController().signal,
        jira,
      });
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
          notification: null,
          logsDir: () => path.join(directory, 'logs'),
          cwd: directory,
          now: () => new Date('2026-09-23T00:05:00.000Z'),
        });
        const second = await restartReporter({
          incident: { ...incident, report: first.report },
          stop: new AbortController().signal,
          jira: { kind: 'jira', http: restartHttp, token: 'token' },
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

  it('reads a blocker’s completion from the ticket itself, never from an exit code', async () => {
    /** One issue answer in the documented shape, with the status it reports. */
    const issueAnswer = (key: string, status: string): unknown => ({
      id: `id-${key}`,
      key,
      fields: {
        summary: `${key} summary`,
        description: null,
        status: { name: status },
        labels: [],
        project: { key: JIRA_CONFIG.projectKey },
        issuetype: { name: 'Task' },
        updated: '2026-09-23T00:00:00.000Z',
      },
    });
    const service = await startLocalService((request) => {
      if (request.url.includes('/issue/HARN-77')) {
        return { status: 200, body: JSON.stringify(issueAnswer('HARN-77', 'Done')) };
      }
      if (request.url.includes('/issue/HARN-78')) {
        return { status: 200, body: JSON.stringify(issueAnswer('HARN-78', 'To Do')) };
      }
      return { status: 404, body: JSON.stringify({ errorMessages: ['no such issue'] }) };
    });
    try {
      const http = createHttpClient(JIRA_CONFIG, 'token', { fetch: serviceFetch(service.origin) });
      const stop = new AbortController().signal;
      // The configured done status is completion, and nothing else is.
      expect(
        await readTicketCompletion({ http, key: 'HARN-77', doneStatus: 'Done', stop }),
      ).toMatchObject({ kind: 'completed' });
      const moved = await readTicketCompletion({ http, key: 'HARN-78', doneStatus: 'Done', stop });
      expect(moved.kind).toBe('not-completed');
      if (moved.kind === 'not-completed') {
        expect(moved.detail).toContain('To Do');
      }
      // A ticket that is not there never reached the done status either.
      const missing = await readTicketCompletion({
        http,
        key: 'HARN-999',
        doneStatus: 'Done',
        stop,
      });
      expect(missing.kind).toBe('not-completed');
    } finally {
      await service.close();
    }

    // A read the connected project refuses is an answer either way: the plan
    // holds rather than advancing on a guess.
    const refused = await startLocalService(() => ({ status: 503, body: '{}' }));
    try {
      const http = createHttpClient(JIRA_CONFIG, 'token', {
        fetch: serviceFetch(refused.origin),
      });
      const take = await readTicketCompletion({
        http,
        key: 'HARN-77',
        doneStatus: 'Done',
        stop: new AbortController().signal,
      });
      expect(take.kind).toBe('unknown');
      if (take.kind === 'unknown') {
        expect(take.problem).toContain('could not be read');
      }
    } finally {
      await refused.close();
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
    const sent = await reporter({
      incident,
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
    expect(sent.report.notification).toMatchObject({ state: 'sent', messageId: 'abc-123' });
    expect(sent.problem).toBeNull();

    // A second publication of the same incident is not a second notification.
    const again = await reporter({
      incident: { ...incident, report: sent.report },
      stop: new AbortController().signal,
      jira: { kind: 'none' },
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
        // A publisher that could not be started at all: nothing of it ran, so
        // the summary definitely did not leave the machine and a later
        // invocation may send it. A publisher that *ran* and failed is
        // uncertain whatever its exit code, and is recorded as such.
        publisher: [path.join(directory, 'not-there-publisher')],
      },
      logsDir: (entry) => incidentDir(directory, entry.id),
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
    });
    const failed = await reporter({
      incident,
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
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
      jira: { kind: 'none' },
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
      jira: { kind: 'none' },
    });
    expect(restart.report.notification).toMatchObject({ state: 'sent', messageId: 'abc-123' });
    expect(restart.problem).toBeNull();
    expect((await readdir(logsDir)).filter((name) => name.endsWith('.stdout.log'))).toHaveLength(1);
  }, 30_000);

  it('adopts the acknowledgement of a publisher that ran and then reported an unsuccessful ending', async () => {
    const directory = await tempDir();
    const logsDir = path.join(directory, 'incident-logs');
    const topicArn = 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications';
    const runs: string[] = [];
    // A publisher that sent the summary, printed the identity the topic gave it,
    // and then timed out. Its ending does not prove the topic refused anything,
    // so the identity it wrote is what this reporter has to read back.
    const runNotification: typeof runCommand = async (request) => {
      runs.push(request.label);
      await mkdir(request.logsDir, { recursive: true });
      const stdoutPath = path.join(request.logsDir, `${request.label}.stdout.log`);
      const stderrPath = path.join(request.logsDir, `${request.label}.stderr.log`);
      await writeFile(
        stdoutPath,
        JSON.stringify({ MessageId: 'timed-1', TopicArn: topicArn }),
        'utf8',
      );
      await writeFile(stderrPath, '', 'utf8');
      return {
        command: [...request.command],
        cwd: request.cwd,
        startedAt: '2026-09-23T00:04:00.000Z',
        endedAt: '2026-09-23T00:06:00.000Z',
        outcome: 'timed-out',
        exitCode: null,
        signal: null,
        launchError: null,
        timeoutMs: request.timeoutMs,
        termination: 'unconfirmed',
        terminationProblem: 'the publisher had not ended when its limit expired',
        stdoutPath,
        stderrPath,
      };
    };
    const notification = {
      topicArn,
      email: 'saint282@gmail.com',
      publisher: ['aws', 'sns', 'publish'],
    };
    const reporter = createIncidentReporter({
      notification,
      logsDir: () => logsDir,
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
      runNotification,
    });
    const incident = reportIncident('ns');
    const published = await reporter({
      incident,
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
    expect(published.report.notification).toMatchObject({ state: 'sent', messageId: 'timed-1' });
    expect(published.problem).toBeNull();

    // A restart reads that acknowledgement: the summary is never sent twice.
    const restart = await reporter({
      incident: { ...incident, report: published.report },
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
    expect(restart.report.notification).toMatchObject({ state: 'sent', messageId: 'timed-1' });
    expect(runs).toHaveLength(1);
  }, 30_000);

  it('records an unacknowledged send that ran as uncertain rather than retryable', async () => {
    const directory = await tempDir();
    const logsDir = path.join(directory, 'incident-logs');
    const runs: string[] = [];
    // A publisher that was killed before it acknowledged anything: the summary
    // may or may not have reached the topic, and nothing here may send it again.
    const runNotification: typeof runCommand = async (request) => {
      runs.push(request.label);
      await mkdir(request.logsDir, { recursive: true });
      const stdoutPath = path.join(request.logsDir, `${request.label}.stdout.log`);
      const stderrPath = path.join(request.logsDir, `${request.label}.stderr.log`);
      await writeFile(stdoutPath, '', 'utf8');
      await writeFile(stderrPath, '', 'utf8');
      return {
        command: [...request.command],
        cwd: request.cwd,
        startedAt: '2026-09-23T00:04:00.000Z',
        endedAt: '2026-09-23T00:05:00.000Z',
        outcome: 'signalled',
        exitCode: null,
        signal: 'SIGKILL',
        launchError: null,
        timeoutMs: request.timeoutMs,
        termination: 'confirmed',
        terminationProblem: null,
        stdoutPath,
        stderrPath,
      };
    };
    const notification = {
      topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
      email: 'saint282@gmail.com',
      publisher: ['aws', 'sns', 'publish'],
    };
    const reporter = createIncidentReporter({
      notification,
      logsDir: () => logsDir,
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
      runNotification,
    });
    const incident = reportIncident('ns');
    const uncertain = await reporter({
      incident,
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
    expect(uncertain.report.notification).toMatchObject({ state: 'interrupted', messageId: null });
    expect(uncertain.report.notification?.problem).toContain('may or may not have reached');
    expect(uncertain.problem).toContain('not sent again automatically');

    // It is never repeated automatically, however many invocations follow.
    const restart = await reporter({
      incident: { ...incident, report: uncertain.report },
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
    expect(restart.report.notification?.state).toBe('interrupted');
    expect(runs).toHaveLength(1);
  }, 30_000);

  it('records a publisher that exited nonzero without an acknowledgement as uncertain', async () => {
    const directory = await tempDir();
    const logsDir = path.join(directory, 'incident-logs');
    const runs: string[] = [];
    // A publisher that sent the summary and then failed on the way out — a
    // response timeout, a connection dropped after the request was accepted —
    // prints nothing an invocation can quote. Its exit code is a normal one,
    // and a normal nonzero exit is no proof that the topic refused anything.
    const runNotification: typeof runCommand = async (request) => {
      runs.push(request.label);
      await mkdir(request.logsDir, { recursive: true });
      const stdoutPath = path.join(request.logsDir, `${request.label}.stdout.log`);
      const stderrPath = path.join(request.logsDir, `${request.label}.stderr.log`);
      await writeFile(stdoutPath, '', 'utf8');
      await writeFile(stderrPath, 'Could not connect to the endpoint URL\n', 'utf8');
      return {
        command: [...request.command],
        cwd: request.cwd,
        startedAt: '2026-09-23T00:04:00.000Z',
        endedAt: '2026-09-23T00:05:00.000Z',
        outcome: 'exited',
        exitCode: 255,
        signal: null,
        launchError: null,
        timeoutMs: request.timeoutMs,
        termination: null,
        terminationProblem: null,
        stdoutPath,
        stderrPath,
      };
    };
    const notification = {
      topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
      email: 'saint282@gmail.com',
      publisher: ['aws', 'sns', 'publish'],
    };
    const reporter = createIncidentReporter({
      notification,
      logsDir: () => logsDir,
      cwd: directory,
      now: () => new Date('2026-09-23T00:04:00.000Z'),
      runNotification,
    });
    const incident = reportIncident('ns');
    const uncertain = await reporter({
      incident,
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
    expect(uncertain.report.notification?.state).toBe('interrupted');
    expect(uncertain.report.notification?.problem).toContain('exit code 255');
    expect(uncertain.problem).toContain('not sent again automatically');

    // A restart leaves it alone rather than sending a second email: the first
    // one may have been accepted before the connection failed.
    const restart = await reporter({
      incident: { ...incident, report: uncertain.report },
      stop: new AbortController().signal,
      jira: { kind: 'none' },
    });
    expect(restart.report.notification?.state).toBe('interrupted');
    expect(runs).toHaveLength(1);
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
      jira: { kind: 'none' },
    });
    expect(outcome.report.notification).toMatchObject({ state: 'interrupted', messageId: null });
    expect(outcome.problem).toContain('not sent again automatically');
    // No second attempt was made: the one log the first invocation wrote is
    // still the only one.
    expect((await readdir(logsDir)).filter((name) => name.endsWith('.stdout.log'))).toHaveLength(1);
  }, 30_000);
});

describe('the recovery turn’s own launch', () => {
  /** One brief, as the supervisor writes it for a fresh incident. */
  function briefFor(dir: string): RecoveryBrief {
    return {
      incidentId: 'incident-1',
      incidentPath: path.join(path.dirname(dir), 'incident.json'),
      dir,
      installRoot: 'C:/nexus',
      workDir: 'C:/runs',
      repoPath: 'C:/target',
      configPath: 'C:/nexus.config.json',
      projectConfigPath: 'C:/target/nexus.project.json',
      intent: 'ticket',
      scope: 'HARN-51',
      attempt: 1,
      maxAttempts: 2,
      timeoutMinutes: 60,
      stop: {
        at: '2026-09-23T00:01:00.000Z',
        intent: 'ticket',
        scope: 'HARN-51',
        exitCode: null,
        signal: 'SIGKILL',
        ending: 'signalled',
        launch: null,
        signature: 'signature',
      },
      earlier: [],
      previous: null,
      jira: { siteUrl: 'https://site.atlassian.com', projectKey: 'HARN' },
      jiraProblem: null,
      notification: null,
    };
  }

  it('creates the attempt directory it was given, runs the configured launch there and reads its judgment', async () => {
    const directory = await tempDir();
    // The turn's own directory does not exist yet: a fresh incident writes one
    // attempt directory per attempt, and the launch has to make it before it
    // can write the prompt the runtime reads.
    const dir = path.join(directory, 'incidents', 'incident-1', 'attempt-1');
    const standIn = await installStandIn(
      'codex',
      [
        "import { writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "let prompt = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        '  writeFileSync(',
        "    path.join(process.cwd(), 'outcome.json'),",
        '    JSON.stringify({',
        "      status: 'repaired',",
        "      summary: 'the stand-in runtime repaired the situation',",
        "      cause: 'a half-written run',",
        "      resolution: 'the workspace was returned to its recorded branch',",
        '      preserved: [],',
        '      resume: null,',
        "      ticket: { key: 'HARN-51' },",
        '    }),',
        '  );',
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    const turn = createRecoveryTurn({
      selection: { runtime: 'codex', command: ['codex'] },
      environment: process.env,
    });
    const result = await withPathPrefix(standIn.bin, () =>
      turn({ brief: briefFor(dir), dir, stop: new AbortController().signal }),
    );

    expect(result.judgment?.status).toBe('repaired');
    expect(result.judgment?.ticket?.key).toBe('HARN-51');
    expect(result.problem).toBeNull();
    // The prompt really was written into the directory the supervisor named,
    // and the turn's own log lives beside it.
    expect(await readFile(path.join(dir, 'input.md'), 'utf8')).toContain('incident-1');
    expect(result.logPath).toBe(path.join(dir, 'recovery.log'));
    expect(await readFile(result.logPath ?? '', 'utf8')).toContain('turn.completed');
  }, 60_000);

  it('never hands the prompt to a runtime whose launch could not be recorded', async () => {
    const directory = await tempDir();
    const dir = path.join(directory, 'incidents', 'incident-1', 'attempt-1');
    const marker = path.join(directory, 'prompted.txt');
    // The stand-in writes a marker only once it has been handed its prompt: a
    // runtime whose launch could not be recorded must never get that far.
    const standIn = await installStandIn(
      'codex',
      [
        "import { writeFileSync } from 'node:fs';",
        "let prompt = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        `  writeFileSync(${JSON.stringify(marker)}, 'the prompt arrived');`,
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    const turn = createRecoveryTurn({
      selection: { runtime: 'codex', command: ['codex'] },
      environment: process.env,
    });
    const result = await withPathPrefix(standIn.bin, () =>
      turn({
        brief: briefFor(dir),
        dir,
        stop: new AbortController().signal,
        onStarted: async () => {
          throw new Error('the attempt record could not be written');
        },
      }),
    );

    expect(result.judgment).toBeNull();
    expect(result.problem).toContain('could not be registered');
    expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
  }, 60_000);
});

describe('the supervised command around a checkout it cannot read', () => {
  it('starts anyway, runs the real worker, and reports the incident a person has to fix', async () => {
    const root = await tempDir();
    const bin = await tempDir();
    const target = path.join(root, 'target');
    await mkdir(target, { recursive: true });
    // The connected project's configuration is exactly what the recovery agent
    // is here to repair: the supervisor has to start with it broken.
    await writeFile(path.join(target, 'nexus.project.json'), '{ this is not json', 'utf8');
    const publisher = path.join(bin, 'publish.mjs');
    await writeFile(
      publisher,
      'process.stdout.write(JSON.stringify({ MessageId: "smoke-1", TopicArn: "arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications" }));\n',
      'utf8',
    );
    const harnessPath = path.join(root, 'harness.json');
    await writeFile(
      harnessPath,
      JSON.stringify({
        workDir: 'runs',
        maxRepairs: 1,
        taskTimeoutMinutes: 1,
        commandTimeoutMinutes: 1,
        recovery: {
          agent: { runtime: 'codex', command: ['codex'] },
          maxAttempts: 1,
          notifications: {
            topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
            email: 'saint282@gmail.com',
            publisher: [process.execPath, publisher],
          },
        },
      }),
      'utf8',
    );
    // A stand-in recovery runtime that answers with the judgment a broken
    // project configuration deserves: a person has to fix it.
    const standIn = await installStandIn(
      'codex',
      [
        "import { writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "let prompt = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        '  writeFileSync(',
        "    path.join(process.cwd(), 'outcome.json'),",
        '    JSON.stringify({',
        "      status: 'unrecoverable',",
        "      summary: 'the connected project has no readable configuration',",
        "      cause: 'nexus.project.json is not valid JSON',",
        "      help: 'write the project configuration again',",
        '    }),',
        '  );',
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    // The worker stand-in stops exactly the way the ordinary CLI stops on a
    // configuration it cannot read: a diagnostic on standard error and a
    // nonzero exit. It is a real child process, started by the real worker
    // launcher.
    const worker = path.join(bin, 'worker.mjs');
    await writeFile(
      worker,
      "process.stderr.write('error: the project configuration is not valid JSON\\n');\nprocess.exit(1);\n",
      'utf8',
    );
    const lines: string[] = [];
    const code = await withPathPrefix(standIn.bin, () =>
      superviseCli(['run', '--repo', target, '--config', harnessPath], {
        cwd: root,
        io: { out: (text) => lines.push(text), err: (text) => lines.push(text) },
        supervisorParts: { entry: worker },
      }),
    );

    // The supervision reached the end a person owns: the worker really ran and
    // stopped on the broken configuration, the recovery turn ran, and the
    // incident was reported. The project's own problem was named, not rounded
    // into a refusal before a worker ever existed.
    expect(code).toBe(EXIT_INPUT_ERROR);
    expect(lines.join('\n')).toContain('could not be read');
    expect(lines.join('\n')).toContain('supervise run: attention');
    const workDir = path.join(root, 'runs');
    const namespaces = await readdir(path.join(workDir, '.supervisor'));
    expect(namespaces).toHaveLength(1);
    const supervisorRootDir = path.join(workDir, '.supervisor', namespaces[0] ?? '');
    const ids = await readdir(path.join(supervisorRootDir, 'incidents'));
    expect(ids).toHaveLength(1);
    const incident = await readIncident(incidentFilePath(supervisorRootDir, ids[0] ?? ''));
    expect(incident?.stage).toBe('help');
    expect(incident?.stops).toHaveLength(1);
    expect(incident?.attempts).toHaveLength(1);
    expect(incident?.attempts[0]?.outcome).toBe('unrecoverable');
    expect(incident?.conclusion?.detail).toContain('write the project configuration again');
    // One attempt was the bound, and the summary really was published.
    expect(incident?.report.notification).toMatchObject({ state: 'sent', messageId: 'smoke-1' });
    // An incident about a ticket nobody could name yet is the email's to carry.
    expect(incident?.ticket).toBeNull();
  }, 60_000);
});

describe('a project configuration the recovery agent repairs', () => {
  it('writes the incident’s Jira report through the connection the repair restored', async () => {
    const root = await tempDir();
    const bin = await tempDir();
    const target = path.join(root, 'target');
    await mkdir(target, { recursive: true });
    const projectFile = path.join(target, 'nexus.project.json');
    const marker = path.join(target, '.worker-ran');
    const tokenEnv = 'NEXUS_TEST_JIRA_TOKEN';
    // The connected project's configuration cannot be read at all: the
    // recovery agent is invoked to repair it, and the report this incident
    // owes has to be written through the connection the repair restored.
    await writeFile(projectFile, '{ this is not json', 'utf8');
    const repaired = {
      setup: [],
      checks: [['node', 'check.mjs']],
      source: {
        type: 'jira',
        siteUrl: 'https://site.atlassian.net',
        cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
        projectKey: 'HARN',
        ...JIRA_SOURCE_DEFAULTS,
        tokenEnv,
      },
    };
    const publisher = path.join(bin, 'publish.mjs');
    await writeFile(
      publisher,
      'process.stdout.write(JSON.stringify({ MessageId: "smoke-1", TopicArn: "arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications" }));\n',
      'utf8',
    );
    const harnessPath = path.join(root, 'harness.json');
    await writeFile(
      harnessPath,
      JSON.stringify({
        workDir: 'runs',
        maxRepairs: 1,
        taskTimeoutMinutes: 1,
        commandTimeoutMinutes: 1,
        recovery: {
          agent: { runtime: 'codex', command: ['codex'] },
          maxAttempts: 1,
          notifications: {
            topicArn: 'arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications',
            email: 'saint282@gmail.com',
            publisher: [process.execPath, publisher],
          },
        },
      }),
      'utf8',
    );
    // A stand-in recovery runtime that repairs exactly what stopped the
    // worker — the project configuration — and names the ticket it belongs to.
    const standIn = await installStandIn(
      'codex',
      [
        "import { writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "let prompt = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        `  writeFileSync(${JSON.stringify(projectFile)}, JSON.stringify(${JSON.stringify(repaired)}));`,
        '  writeFileSync(',
        "    path.join(process.cwd(), 'outcome.json'),",
        '    JSON.stringify({',
        "      status: 'repaired',",
        "      summary: 'the project configuration was written again',",
        "      cause: 'nexus.project.json was not valid JSON',",
        "      resolution: 'the configuration was written again from the repository copy',",
        '      preserved: [],',
        "      resume: 'the queue resumes',",
        "      ticket: { key: 'HARN-51', url: 'https://malton-family.atlassian.net/browse/HARN-51' },",
        '    }),',
        '  );',
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    // The worker stops on the unreadable configuration once; the resumed one
    // — after the repair — settles.
    const worker = path.join(bin, 'worker.mjs');
    await writeFile(
      worker,
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `if (existsSync(${JSON.stringify(marker)})) { process.exit(0); }`,
        `writeFileSync(${JSON.stringify(marker)}, 'first');`,
        "process.stderr.write('error: the project configuration is not valid JSON\\n');",
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );
    const service = await startLocalService((request) => {
      if (request.method === 'GET' && request.url.includes('/comment')) {
        return { status: 200, body: JSON.stringify({ comments: [], total: 0 }) };
      }
      return { status: 201, body: JSON.stringify({ id: '10042' }) };
    });
    const lines: string[] = [];
    const previousToken = process.env[tokenEnv];
    process.env[tokenEnv] = 'test-token';
    let code: number;
    try {
      code = await withPathPrefix(standIn.bin, () =>
        superviseCli(['run', '--repo', target, '--config', harnessPath], {
          cwd: root,
          io: { out: (text) => lines.push(text), err: (text) => lines.push(text) },
          supervisorParts: { entry: worker },
          fetch: serviceFetch(service.origin),
        }),
      );
    } finally {
      if (previousToken === undefined) {
        delete process.env[tokenEnv];
      } else {
        process.env[tokenEnv] = previousToken;
      }
      await service.close();
    }

    expect(code).toBe(EXIT_OK);
    expect(lines.join('\n')).toContain('supervise run: settled');
    // The comment really was written into the ticket's own thread, through
    // the connection the repair restored — not silently omitted because the
    // file could not be read when the supervision started.
    const posted = service.requests.find((request) => request.method === 'POST');
    expect(posted?.url).toContain('/rest/api/3/issue/HARN-51/comment');
    expect(posted?.body).toContain('Harness recovery report');
    const workDir = path.join(root, 'runs');
    const namespaces = await readdir(path.join(workDir, '.supervisor'));
    const supervisorRootDir = path.join(workDir, '.supervisor', namespaces[0] ?? '');
    const ids = await readdir(path.join(supervisorRootDir, 'incidents'));
    const incident = await readIncident(incidentFilePath(supervisorRootDir, ids[0] ?? ''));
    expect(incident?.ticket?.key).toBe('HARN-51');
    expect(incident?.report.commentId).toBe('10042');
    expect(incident?.report.problem).toBeNull();
    expect(incident?.report.notification).toMatchObject({ state: 'sent', messageId: 'smoke-1' });
    expect(incident?.resumedAt).not.toBeNull();
  }, 90_000);
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
