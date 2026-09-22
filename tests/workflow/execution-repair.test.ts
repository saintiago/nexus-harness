/**
 * The first workflow: a task really runs, its first round is red, the same
 * runtime repairs it, and the pass that is reported is the revision the
 * configured check really judged.
 *
 * The whole run is the harness's own code — the preflight, the run directory,
 * the clone, the repository-local identity, the configured command through a
 * real process, the branch return, the report and the workspace ledger — and
 * only the coding turn is supplied by the case. What is proved is what no lower
 * layer can: those pieces agree end to end, the repair turn is handed the
 * failure the round observed with its output, and the run's own report names
 * the revision that passed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_OK } from '../../src/cli/context.js';
import { runCli } from '../../src/cli.js';
import type { AgentTurnRequest } from '../../src/runs/contracts.js';
import type { AttemptEvidence } from '../../src/shared/types.js';
import { gitOrFail, useOwnedProcesses } from '../boundary/integration-support.js';
import {
  TARGET_RESULT_DONE,
  TARGET_RESULT_FILE,
  branchHead,
  commitEverything,
  createTargetProject,
  readRunReport,
  recordingIo,
} from './support.js';

useOwnedProcesses();

describe('a task run end to end', () => {
  it('repairs the round the implementation left red, and reports what passed', async () => {
    const project = await createTargetProject();
    const recorded = recordingIo();
    const turns: AgentTurnRequest[] = [];

    const code = await runCli(
      ['run', '--repo', project.repo, '--config', project.configPath, '--task', project.taskPath],
      {
        cwd: project.parent,
        io: recorded.io,
        dependencies: {
          runAgentTurn: async (request) => {
            turns.push(request);
            const result = path.join(request.workspacePath, TARGET_RESULT_FILE);
            if (request.kind === 'implementation') {
              await writeFile(result, 'half\n', 'utf8');
              await commitEverything(request.workspacePath, 'a first draft of the greeting');
              return { summary: 'wrote a first draft' };
            }
            await writeFile(result, TARGET_RESULT_DONE, 'utf8');
            await commitEverything(request.workspacePath, 'finish the greeting');
            return { summary: 'finished the greeting' };
          },
        },
      },
    );

    expect(recorded.err).toEqual([]);
    expect(code).toBe(EXIT_OK);
    // The outcome block names the status, the repair that was spent, and where
    // the run kept its working copy and its report.
    expect(recorded.text()).toContain(': passed');
    expect(recorded.text()).toContain('repairs    1 of 2 repair turns used');

    const { runDir, report } = await readRunReport(project.workDir);
    expect(report['status']).toBe('passed');
    expect(report['repairsUsed']).toBe(1);

    // Two coding turns ran, in the order the loop decided: the implementation
    // whose round was red, then the repair whose round passed.
    const attempts = report['attempts'] as AttemptEvidence[];
    expect(attempts.map((attempt) => attempt.kind)).toEqual(['implementation', 'repair']);
    expect(attempts[0]?.checks?.outcome).toBe('failed');
    expect(attempts[1]?.checks?.outcome).toBe('passed');
    expect(attempts[1]?.agentSummary).toBe('finished the greeting');

    // The repair turn was handed the observed failure: the command the round ran
    // and the output it really wrote, read back from the run's own log file.
    expect(turns).toHaveLength(2);
    const repair = turns[1];
    expect(repair?.kind).toBe('repair');
    expect(repair?.repair?.repairedTurn).toBe(1);
    const [failure] = repair?.repair?.failures ?? [];
    expect(failure?.result.exitCode).toBe(1);
    expect(failure?.output).toContain('the work is not finished');
    expect(failure?.result.stdoutPath.startsWith(runDir)).toBe(true);
    expect(await readFile(failure?.result.stdoutPath ?? '', 'utf8')).toContain('result.txt');

    // The pass really is about the revision the working copy holds, and the
    // repair's commit is on the branch the workspace records.
    const workspace = report['workspace'] as { path: string; branch: string };
    expect(await readFile(path.join(workspace.path, TARGET_RESULT_FILE), 'utf8')).toBe(
      TARGET_RESULT_DONE,
    );
    const head = await branchHead(workspace.path, workspace.branch);
    expect(head).toBe((await gitOrFail(['rev-parse', 'HEAD'], workspace.path)).trim());
    expect(report['changes']).toMatchObject({ inspected: true, problem: null });
  });
});
