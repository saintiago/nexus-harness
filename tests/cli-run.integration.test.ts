/**
 * The run boundary: a real repository, a real clone, and a substituted coding turn.
 *
 * Each case here drives the CLI in process against a real temporary Git repository: the preflight, run directory, clone, configured checks through real child processes and the report are the harness own code, and only the coding turn is substituted. The interrupt cases deliver the CLI own signal seam, which is what a delivered signal does; the parser and display layer lives in tests/cli.test.ts.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK } from '../src/cli/context.js';
import type { InterruptSignals } from '../src/cli/context.js';
import { ReportError } from '../src/reporting/errors.js';
import type { RunnerDependencies } from '../src/runs/contracts.js';
import type { AgentActivity } from '../src/shared/types.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';
import {
  createTempDir,
  documentedHarnessConfig,
  documentedProjectConfig,
  documentedTask,
  fakeConsole,
  repoRoot,
  screenAfter,
  writeJsonFile,
  type JsonObject,
} from './support.js';
import {
  countingCheck,
  createRunFixture,
  gitOrThrow,
  readRun,
  recordingSignals,
  run,
  runArgv,
  waitFor,
  beginCliFixtureEnvironment,
} from './fixtures/cli.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';

useFixtureLifecycle();

beforeEach(beginCliFixtureEnvironment);

describe('run', () => {
  it('runs a task, reports the pass, and keeps the working copy and the report', async () => {
    const fixture = await createRunFixture();

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);

    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect(report.repairsUsed).toBe(0);
    expect(report.task).toEqual({ id: documentedTask.id, title: documentedTask.title });
    // The agent's own account of its turn is kept, and is not what decided the run.
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.agentSummary).toBe('the fixture turn changed nothing');
    expect(report.attempts[0]?.checks?.outcome).toBe('passed');

    // Progress, then the outcome: the status, why, the repairs used, and where
    // the run kept everything. Every ordinary row carries its emission time.
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} baseline check-round result: passed$/m);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} implementation turn started$/m);
    expect(result.out).toContain(`run ${report.runId}: passed`);
    expect(result.out).toContain('reason     every configured check passed');
    expect(result.out).toContain('repairs    0 of 2 repair turns used');
    expect(result.out).toContain(`run dir    ${runDir}`);
    expect(result.out).toContain(
      `workspace  ${path.join(path.dirname(path.dirname(runDir)), 'workspaces', path.basename(runDir))}`,
    );
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} review warning: /m);

    // The coding turn was asked once, for the implementation, in the run's own
    // working copy, with the task as it was loaded.
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.kind).toBe('implementation');
    expect(fixture.calls[0]?.turn).toBe(1);
    expect(fixture.calls[0]?.task).toEqual(documentedTask);
    expect(fixture.calls[0]?.workspacePath).toBe(
      path.join(path.dirname(path.dirname(runDir)), 'workspaces', path.basename(runDir)),
    );
    expect(fixture.calls[0]?.sourceRoot).toBe(fixture.source);
  });

  it('validates and runs a local project with the shared reviewer and completion policy', async () => {
    const policy = JSON.parse(
      await readFile(path.join(repoRoot, 'docs', 'nexus.config.example.json'), 'utf8'),
    ) as JsonObject;
    const fixture = await createRunFixture({
      config: { reviewer: policy['reviewer'], completion: policy['completion'] },
    });
    const validation = await run([
      'check-config',
      '--config',
      fixture.configPath,
      '--project',
      fixture.source,
    ]);
    expect(validation.code).toBe(EXIT_OK);
    expect(validation.err).toBe('');
    expect(validation.out).toContain('reviewer               github app');
    expect(validation.out).not.toContain('  review                 github');
    expect(validation.out).not.toContain('  delivery               github');
    expect(existsSync(fixture.outDir)).toBe(false);

    const source = await run([
      'source',
      'list',
      '--config',
      fixture.configPath,
      '--project',
      fixture.source,
    ]);
    expect(source.code).toBe(EXIT_INPUT_ERROR);
    expect(source.err).toContain('has no "source" object');
    expect(source.err).toContain(path.join(fixture.source, PROJECT_CONFIG_FILE_NAME));
    expect(existsSync(fixture.outDir)).toBe(false);

    const result = await run(
      runArgv({ repo: fixture.source, config: fixture.configPath, task: fixture.taskPath }),
      { dependencies: fixture.dependencies },
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.err).toBe('');
    const { report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect('sourceRef' in report).toBe(false);
    expect(existsSync(path.join(fixture.outDir, '.intake'))).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it('ignores a configured source: no credential, no intake state, no provenance', async () => {
    const fixture = await createRunFixture({
      config: {
        source: {
          type: 'jira',
          siteUrl: 'https://example.atlassian.net',
          cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
          projectKey: 'SAM1',
          // A name nothing sets: a file-task run must not look for it at all.
          tokenEnv: 'NEXUS_FILE_RUN_MUST_NOT_READ_THIS',
        },
      },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_OK);
    const { report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect('sourceRef' in report).toBe(false);
    expect(existsSync(path.join(fixture.outDir, '.intake'))).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it('repairs a red round and reports the repair it used', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'sequenced-check.cjs');
    // Green on the first run (the baseline), red on the second (after the
    // implementation), green again on the third (after the repair).
    await writeFile(check, countingCheck('count === 2'), 'utf8');
    const fixture = await createRunFixture({
      config: { maxRepairs: 1, checks: [[process.execPath, check, counter]] },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_OK);
    const { report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[1]?.kind).toBe('repair');
    expect(result.out).toContain('repairs    1 of 1 repair turns used');

    // The repair turn was told what the red round observed, and the checks really
    // ran three times, in the run's own working copy.
    const repair = fixture.calls[1];
    expect(repair?.turn).toBe(2);
    expect(repair?.repair?.repairedTurn).toBe(1);
    expect(repair?.repair?.failures).toHaveLength(1);
    expect(repair?.repair?.failures[0]?.result.exitCode).toBe(1);
    expect(await readFile(counter, 'utf8')).toBe('3');
  });

  it('reports a failure without claiming a success', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'always-red-check.cjs');
    // Green for the baseline, red from then on, and no repair allowance.
    await writeFile(check, countingCheck('count >= 2'), 'utf8');
    const fixture = await createRunFixture({
      config: { maxRepairs: 0, checks: [[process.execPath, check, counter]] },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('failed');
    expect(result.out).toContain(`run ${report.runId}: failed`);
    expect(result.out).not.toMatch(/^\d{2}:\d{2}:\d{2} run \S+: passed$/m);
    expect(result.out).toContain('the repair allowance is exhausted');
    expect(result.out).toContain('repairs    0 of 0 repair turns used');
    // The report exists and is named; it is a failed run, not a missing one.
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);
  });

  it('keeps the loaded inputs fixed while the working copy rewrites them', async () => {
    const fixture = await createRunFixture({
      agent: async (request) => {
        fixture.calls.push(request);
        // What the target project does to the input files while a run is in
        // progress: nothing it writes can change which commands decide the run.
        // The Nexus-wide file and the working copy's own project configuration
        // are both rewritten, and neither is read again.
        await writeJsonFile(fixture.parent, 'nexus.config.json', {
          workDir: './rewritten',
          maxRepairs: 0,
          taskTimeoutMinutes: 30,
          commandTimeoutMinutes: 5,
        });
        await writeJsonFile(request.workspacePath, PROJECT_CONFIG_FILE_NAME, {
          setup: [],
          checks: [[process.execPath, '-e', 'process.exit(1)']],
        });
        await writeJsonFile(fixture.parent, 'task.json', {
          ...documentedTask,
          id: 'rewritten-001',
          title: 'Rewritten while the run was in progress',
        });
        return { summary: 'rewrote the inputs' };
      },
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    // The run still ended on the plan it loaded, and still names the task it was
    // asked for: a re-read config would have made the post-agent round red.
    expect(result.code).toBe(EXIT_OK);
    const { report } = await readRun(fixture.outDir);
    expect(report.status).toBe('passed');
    expect(report.task).toEqual({ id: documentedTask.id, title: documentedTask.title });
  });

  it('reports a preparation failure as a failed run that kept its evidence', async () => {
    const fixture = await createRunFixture();

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: {
          ...fixture.dependencies,
          prepareWorkspace: async () => {
            throw new WorkspaceError('the fixture refused to prepare a working copy');
          },
        },
      },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toBe('');
    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('failed');
    expect(report.workspace.prepared).toBe(false);
    expect(report.workspace.problem).toMatch(/refused to prepare a working copy/);
    expect(result.out).toContain(`run ${report.runId}: failed`);
    expect(result.out).toContain('workspace  no working copy was prepared');
    expect(result.out).toContain(`run dir    ${runDir}`);
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);
    // No coding turn is invented for a run that never had a working copy.
    expect(fixture.calls).toEqual([]);
  });

  it('reports a report-write failure, keeps the run, and never claims the report', async () => {
    const fixture = await createRunFixture();

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: {
          ...fixture.dependencies,
          writeRunReport: async (request) => {
            throw new ReportError(
              `the report "${path.join(request.run.runDir, 'result.json')}" could not be written: the disk is full`,
            );
          },
        },
      },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    const runsRoot = path.join(fixture.outDir, 'runs');
    const entries = await readdir(runsRoot);
    expect(entries).toHaveLength(1);
    const runDir = path.join(runsRoot, entries[0] ?? '');

    // The failure is named, with the location the run was kept in...
    expect(result.err).toMatch(/could not be reported/);
    expect(result.err).toMatch(/the disk is full/);
    expect(result.err).toContain(runDir);
    // ...and nothing anywhere says the run finished, or that a report exists.
    expect(result.out).not.toMatch(/^\d{2}:\d{2}:\d{2} run run-\S+: /m);
    expect(result.out).not.toMatch(/result\.json/);
    expect(existsSync(path.join(runDir, 'result.json'))).toBe(false);
    // What the run did produce is still there to inspect.
    expect(existsSync(path.join(runDir, 'logs', 'run.log'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The activity pane under the run status
// ---------------------------------------------------------------------------

/**
 * A coding turn that reports synthetic activity, as the real adapter reports
 * what a runtime is doing: one message, one command, and its result.
 */
function reportingAgent(): RunnerDependencies['runAgentTurn'] {
  const activities: readonly AgentActivity[] = [
    { kind: 'message', text: 'I will change one file.' },
    { kind: 'command', text: 'npm test' },
    { kind: 'result', text: 'exit 1' },
  ];
  return async (request) => {
    for (const activity of activities) {
      request.onActivity?.(activity);
    }
    return { summary: 'the file now holds the new line' };
  };
}

describe('the activity pane under the run status', () => {
  it('draws the activity in the developer pane, and keeps it in the timeline', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    const raw = console.chunks.join('');
    // What the turn reported was drawn into the pane, in place: the cursor
    // moves of a bounded pane are in the stream, and the lines are there.
    expect(raw).toContain('agent: I will change one file.');
    expect(raw).toContain('run: npm test');
    expect(raw).toContain('result: exit 1');
    expect(raw).toContain('\u001b[');

    // The pane is finalized into the timeline when the turn ends: the
    // invocation's boundary and its rows stay in scrollback, the progress and
    // the outcome block follow them in order, and the last thing printed is
    // where the report is.
    const { runDir, report } = await readRun(fixture.outDir);
    const screen = screenAfter(console.chunks);
    const shown = screen.join('\n');
    expect(shown).toMatch(
      /^\d{2}:\d{2}:\d{2} ---- developer: example-001 — implementation turn ----$/m,
    );
    expect(shown).toMatch(/^\d{2}:\d{2}:\d{2} implementation turn started$/m);
    // The rows the pane drew are the segment that follows the boundary, before
    // the turn's own result line.
    expect(shown).toMatch(
      /\d{2}:\d{2}:\d{2} agent: I will change one file\.\n\d{2}:\d{2}:\d{2} run: npm test\n\d{2}:\d{2}:\d{2} result: exit 1\n\d{2}:\d{2}:\d{2} implementation turn result: completed/,
    );
    expect(shown).toMatch(new RegExp(`^\\d{2}:\\d{2}:\\d{2} run ${report.runId}: passed$`, 'm'));
    expect(screen.at(-1)).toMatch(/^\d{2}:\d{2}:\d{2} {3}report {5}\S/);
    expect(screen.at(-1)?.endsWith(`  report     ${path.join(runDir, 'result.json')}`)).toBe(true);
  });

  it('writes ordinary activity lines, with no cursor sequences, when redirected', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} run: npm test$/m);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} agent: I will change one file\.$/m);
    expect(result.out).toMatch(/^\d{2}:\d{2}:\d{2} result: exit 1$/m);
    expect(`${result.out}${result.err}`).not.toContain('\u001b');
  });

  it('stamps and highlights what the pane draws, in the stream the terminal saw', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    const raw = console.chunks.join('');
    // The message carries the local time it reached the viewer, the highlight,
    // and the reset that ends it inside the same line.
    // eslint-disable-next-line no-control-regex
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} \u001b\[33magent: I will change one file\.\u001b\[0m/);
    // Work lines are stamped the same way and stay in the terminal's own color.
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} run: npm test\r\n/);
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} result: exit 1\r\n/);
  });

  it('uses plain output without cursor sequences when the terminal asks for no color', async () => {
    const fixture = await createRunFixture({ agent: reportingAgent() });
    const console = fakeConsole({ columns: 80, rows: 24, color: false });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    const raw = result.out;
    expect(console.chunks).toEqual([]);
    expect(raw).not.toContain('\u001b');
    expect(raw).toMatch(/\d{2}:\d{2}:\d{2} agent: I will change one file\.\n/);
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/\u001b\[[0-9;]*m/);
  });

  it('keeps the task, the phase, and the model on screen without the startup inventory', async () => {
    const fixture = await createRunFixture({
      config: {
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
      },
      agent: reportingAgent(),
    });
    const console = fakeConsole({ columns: 100, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    // The interactive view carries the task, the phase, and the selected model.
    const screen = screenAfter(console.chunks);
    expect(screen.join('\n')).toMatch(/^\d{2}:\d{2}:\d{2} run \S+ started: task "example-001" /m);
    expect(screen.some((line) => line.endsWith('agent: runtime codex, model deepseek-flash'))).toBe(
      true,
    );
    expect(screen.some((line) => line.endsWith(' implementation turn started'))).toBe(true);
    // The useful path stays; the inventory a reader does not need — the launch
    // prefix, the deadline timestamp, the revision, the branch and base commit,
    // the commit identity — is left to the run log.
    const shown = screen.join('\n');
    for (const inventory of [
      'launch prefix',
      'task deadline set for',
      'immutable id',
      ' on branch ',
      'Git identity',
      'revision ',
    ]) {
      expect(shown, `the interactive view still shows "${inventory}"`).not.toContain(inventory);
    }
    expect(screen.some((line) => line.includes('workspace prepared at '))).toBe(true);

    // What the run wrote to its own timeline is untouched by the presentation.
    const { runDir } = await readRun(fixture.outDir);
    const timeline = await readFile(path.join(runDir, 'logs', 'run.log'), 'utf8');
    expect(timeline).toContain(
      'agent selected: runtime codex, launch prefix ["codex","--profile","nexus-flash","--model","deepseek-flash"]',
    );
    expect(timeline).toContain('task deadline set for');
    expect(timeline).toContain('workspace Git identity configured:');
    expect(timeline).toContain('workspace prepared at');
  });

  it('shows a repair turn’s activity through the same pane', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'sequenced-check.cjs');
    // Green for the baseline, red after the implementation, green after the
    // repair: the run really spends one repair turn.
    await writeFile(check, countingCheck('count === 2'), 'utf8');
    const turns: number[] = [];
    const fixture = await createRunFixture({
      config: { maxRepairs: 1, checks: [[process.execPath, check, counter]] },
      agent: async (request) => {
        turns.push(request.turn);
        request.onActivity?.({ kind: 'message', text: `turn ${String(request.turn)} reporting` });
        return { summary: null };
      },
    });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_OK);
    expect(turns).toEqual([1, 2]);
    const raw = console.chunks.join('');
    expect(raw).toContain('agent: turn 1 reporting');
    expect(raw).toContain('agent: turn 2 reporting');
    // Two panes, each opened by its own boundary and each holding only its own
    // turn's row: the implementation's pane was finalized before the repair's
    // boundary, so the repair never inherits the row before it.
    const shown = screenAfter(console.chunks).join('\n');
    expect(shown).toMatch(
      /\d{2}:\d{2}:\d{2} ---- developer: example-001 — implementation turn ----\n\d{2}:\d{2}:\d{2} agent: turn 1 reporting\n\d{2}:\d{2}:\d{2} implementation turn result: completed/,
    );
    expect(shown).toMatch(
      /\d{2}:\d{2}:\d{2} ---- developer: example-001 — repair turn 2 ----\n\d{2}:\d{2}:\d{2} agent: turn 2 reporting\n\d{2}:\d{2}:\d{2} repair turn 2 result: completed/,
    );
    expect(result.err).toBe('');
  });

  it('keeps the failed turn’s pane ahead of the outcome of a failed run, too', async () => {
    const counter = path.join(await createTempDir(), 'count.txt');
    const check = path.join(await createTempDir(), 'always-red-check.cjs');
    // Green for the baseline, red from then on, with no repair allowance.
    await writeFile(check, countingCheck('count >= 2'), 'utf8');
    const fixture = await createRunFixture({
      config: { maxRepairs: 0, checks: [[process.execPath, check, counter]] },
      agent: reportingAgent(),
    });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    const { runDir, report } = await readRun(fixture.outDir);
    const screen = screenAfter(console.chunks);
    expect(report.status).toBe('failed');
    const shown = screen.join('\n');
    expect(shown).toMatch(
      /\d{2}:\d{2}:\d{2} ---- developer: example-001 — implementation turn ----\n\d{2}:\d{2}:\d{2} agent: I will change one file\.\n\d{2}:\d{2}:\d{2} run: npm test\n\d{2}:\d{2}:\d{2} result: exit 1\n\d{2}:\d{2}:\d{2} implementation turn result: completed/,
    );
    expect(shown).toMatch(new RegExp(`^\\d{2}:\\d{2}:\\d{2} run ${report.runId}: failed$`, 'm'));
    expect(shown).toContain(`run dir    ${runDir}`);
    expect(shown).toContain(`report     ${path.join(runDir, 'result.json')}`);
  });

  it('leaves a usable screen behind an interrupt, with the outcome and its paths', async () => {
    const signals = recordingSignals();
    const fixture = await createRunFixture({
      agent: async (request) => {
        request.onActivity?.({ kind: 'message', text: 'still working' });
        await new Promise<void>((resolve) => {
          if (request.stop.aborted) {
            resolve();
            return;
          }
          request.stop.addEventListener('abort', () => resolve(), { once: true });
        });
        return { summary: null };
      },
    });
    const console = fakeConsole({ columns: 80, rows: 24 });

    const running = run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      {
        cwd: fixture.parent,
        signals,
        dependencies: fixture.dependencies,
        terminal: console.io.terminal,
      },
    );
    await waitFor(() => console.chunks.join('').includes('agent: still working'), 'the pane line');
    signals.interrupt();
    const result = await running;

    expect(result.code).toBe(EXIT_CANCELLED);
    expect(result.err).toMatch(/interrupt received: asking the run to stop/);

    const { runDir, report } = await readRun(fixture.outDir);
    const screen = screenAfter(console.chunks);
    const shown = screen.join('\n');
    // The stopped turn's pane was finalized as it returned, so what it showed
    // stays above the cancellation and the paths.
    expect(shown).toMatch(
      /\d{2}:\d{2}:\d{2} ---- developer: example-001 — implementation turn ----\n\d{2}:\d{2}:\d{2} agent: still working\n\d{2}:\d{2}:\d{2} implementation turn result: completed/,
    );
    expect(shown).toMatch(new RegExp(`^\\d{2}:\\d{2}:\\d{2} run ${report.runId}: cancelled$`, 'm'));
    expect(shown).toContain(`run dir    ${runDir}`);
    expect(shown).toContain(`report     ${path.join(runDir, 'result.json')}`);
  });
});

describe('run refusals', () => {
  it('refuses an invalid configuration before starting anything', async () => {
    const fixture = await createRunFixture();
    // The Nexus-wide file carries the invalid limit; the connected project's
    // own probes stay where they are, and nothing may run.
    await writeJsonFile(fixture.parent, 'nexus.config.json', {
      ...documentedHarnessConfig,
      maxRepairs: -1,
      workDir: './out',
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toContain(path.join(fixture.parent, 'nexus.config.json'));
    expect(result.err).toMatch(/maxRepairs/);
    expect(result.out).toBe('');
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('refuses a task file that is not valid JSON before starting anything', async () => {
    const fixture = await createRunFixture();
    await writeFile(path.join(fixture.parent, 'task.json'), '{ "id": "example-001", }', 'utf8');

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/is not valid JSON/);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('refuses a dirty source repository without running any command or turn', async () => {
    const fixture = await createRunFixture();
    // A probe the run would have to execute to make its sentinel appear: it is
    // the connected project's own setup and check, committed here so the only
    // reason it cannot run is the dirty checkout below.
    await writeJsonFile(fixture.source, PROJECT_CONFIG_FILE_NAME, {
      setup: [[process.execPath, fixture.probe, fixture.sentinel]],
      checks: [[process.execPath, fixture.probe, fixture.sentinel]],
    });
    await gitOrThrow(['add', '--all'], fixture.source);
    await gitOrThrow(['commit', '--quiet', '--message', 'probe: record a run'], fixture.source);
    await writeFile(path.join(fixture.source, 'uncommitted.txt'), 'work in progress\n', 'utf8');

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/is not a clean checkout/);
    expect(result.err).toContain('uncommitted.txt');
    expect(result.out).toBe('');
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('refuses an output directory inside the source repository', async () => {
    const fixture = await createRunFixture();
    // The configuration stays outside the source so the checkout is clean, and
    // points its output at a directory inside it.
    const configPath = await writeJsonFile(fixture.parent, 'overlap.config.json', {
      workDir: './target-project/runs',
      maxRepairs: 2,
      taskTimeoutMinutes: 30,
      commandTimeoutMinutes: 5,
    });

    const result = await run(
      runArgv({ repo: 'target-project', config: 'overlap.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/lies inside it/);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(path.join(fixture.source, 'runs'))).toBe(false);
    expect(existsSync(configPath)).toBe(true);
  });

  it('refuses a source that is not a repository', async () => {
    const fixture = await createRunFixture();
    // A plain directory that carries the project configuration a connected
    // repository would, so the refusal is about Git, not about the file.
    const plain = path.join(fixture.parent, 'not-a-repository');
    await mkdir(plain, { recursive: true });
    await writeJsonFile(plain, PROJECT_CONFIG_FILE_NAME, documentedProjectConfig);

    const result = await run(
      runArgv({ repo: 'not-a-repository', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toMatch(/is not inside a Git repository/);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.outDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

/** How long a fixture turn waits for a stop that a failing test never sends. */

const TURN_BACKSTOP_MS = 15_000;

/**
 * A coding turn that runs until the run it belongs to is stopped, and records
 * whether it saw that stop. It is the collaborator a real interrupt has to reach.
 */
function waitingAgent(marks: {
  started: boolean;
  sawStop: boolean;
}): RunnerDependencies['runAgentTurn'] {
  return async (request) => {
    marks.started = true;
    await new Promise<void>((resolve) => {
      if (request.stop.aborted) {
        marks.sawStop = true;
        resolve();
        return;
      }
      // The backstop exists only so that a test which fails before it interrupts
      // cannot leave this turn waiting until the run's own deadline: it is never
      // what ends a passing test.
      const backstop = setTimeout(() => {
        resolve();
      }, TURN_BACKSTOP_MS);
      backstop.unref();
      request.stop.addEventListener(
        'abort',
        () => {
          clearTimeout(backstop);
          marks.sawStop = true;
          resolve();
        },
        { once: true },
      );
    });
    return { summary: null };
  };
}

describe('interrupts', () => {
  it('cancels the run, waits for it to finalize, and exits 130', async () => {
    const marks = { started: false, sawStop: false };
    const fixture = await createRunFixture({ agent: waitingAgent(marks) });
    const signals = recordingSignals();

    const running = run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, signals, dependencies: fixture.dependencies },
    );

    // The run is inside its coding turn, which is what an interrupt arrives on.
    await waitFor(() => marks.started, 'started the coding turn');
    expect(signals.registered).toBe(1);
    signals.interrupt();
    const result = await running;

    // The stop reached the run's own cancellation path, not a second mechanism.
    expect(marks.sawStop).toBe(true);
    expect(result.code).toBe(EXIT_CANCELLED);
    expect(result.err).toMatch(/interrupt received: asking the run to stop/);
    expect(result.out).toContain('cancelled');

    // The CLI waited for the run to finalize: the report is there, it says the
    // run was cancelled, and it says where that happened.
    const { runDir, report } = await readRun(fixture.outDir);
    expect(report.status).toBe('cancelled');
    expect(report.cancellation?.phase).toBe('implementation turn');
    expect(result.out).toContain(`run ${report.runId}: cancelled`);
    expect(result.out).toContain(`run dir    ${runDir}`);
    expect(result.out).toContain(`report     ${path.join(runDir, 'result.json')}`);

    // Nothing is left installed once the run is over.
    expect(signals.released).toBe(1);
  });

  it('exits 130 and creates nothing when the stop arrives before any run directory', async () => {
    const fixture = await createRunFixture();
    // An interrupt that arrives before the run has allocated anything: the run
    // is refused rather than reported, because there is nothing to report.
    const signals: InterruptSignals = {
      onInterrupt: (handler) => {
        handler();
        return () => undefined;
      },
    };

    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, signals, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_CANCELLED);
    expect(result.err).toMatch(/cancelled: the run was stopped by its caller/);
    expect(result.err).toMatch(/before any run directory was allocated/);
    expect(result.out).toBe('');
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.outDir)).toBe(false);
  });

  it('installs a signal handler for the duration of a run, and releases it after', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const during: number[] = [];
    const fixture = await createRunFixture({
      agent: async () => {
        during.push(process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'));
        return { summary: null };
      },
    });

    // No signals seam: this uses the real one, so the counts below are the
    // process's own signal listeners, installed by the CLI and nothing else.
    const result = await run(
      runArgv({ repo: 'target-project', config: 'nexus.config.json', task: 'task.json' }),
      { cwd: fixture.parent, dependencies: fixture.dependencies },
    );

    expect(result.code).toBe(EXIT_OK);
    const [sigs = 0, terms = 0] = before;
    expect(during).toEqual([sigs + 1, terms + 1]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The real process
// ---------------------------------------------------------------------------
