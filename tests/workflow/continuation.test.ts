/**
 * The fourth workflow: an attempt the operator interrupts keeps what it wrote,
 * and the next attempt continues that same working copy instead of starting
 * over.
 *
 * The stop is the run's own request — the one a `run` command hands to the
 * runner when the operator interrupts it — so the first attempt really is
 * cancelled mid-turn and really writes the report and the ledger entry of a
 * cancelled run. The continuation resolves the ticket's pointer through the
 * workspace ledger exactly as the source intake does, and its baseline is
 * allowed to be red because the interrupted attempt's own committed work is
 * what the next turn continues from.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentTurnRequest } from '../../src/runs/contracts.js';
import type { SourceRef } from '../../src/shared/types.js';
import { canonicalPath } from '../../src/workspace/git.js';
import { resolveWorkspace } from '../../src/workspace/reopen.js';
import { readWorkspaceState, sourceItemFor } from '../../src/workspace/state.js';
import { gitOrFail, useOwnedProcesses } from '../boundary/integration-support.js';
import {
  TARGET_RESULT_DONE,
  TARGET_RESULT_FILE,
  branchHead,
  commitEverything,
  createTargetProject,
  readReportFile,
  runTicket,
} from './support.js';

useOwnedProcesses();

const SITE = 'https://example.atlassian.net';
const REF: SourceRef = {
  type: 'jira',
  scope: SITE,
  id: '10077',
  key: 'HARN-77',
  url: `${SITE}/browse/HARN-77`,
  updatedAt: '2026-03-01T10:00:00.000Z',
};
const WORKSPACE_ID = 'HARN-77';
/** What the interrupted attempt had written and committed when it stopped. */
const WIP_FILE = 'wip.txt';

/** A promise a case resolves from inside the code under test. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('an interrupted attempt and its continuation', () => {
  it('keeps the stopped attempt, then finishes the same working copy on the next attempt', async () => {
    const project = await createTargetProject();
    const started = deferred();
    const controller = new AbortController();

    // The interrupted attempt: it commits the work it had written, and the
    // operator's stop arrives while its turn is still running.
    const running = runTicket({
      project,
      ref: REF,
      workspaceId: WORKSPACE_ID,
      stop: controller.signal,
      turn: async (request: AgentTurnRequest) => {
        await writeFile(path.join(request.workspacePath, WIP_FILE), 'notes from the first try\n');
        await writeFile(path.join(request.workspacePath, TARGET_RESULT_FILE), 'half\n', 'utf8');
        await commitEverything(request.workspacePath, 'a first draft of the greeting');
        started.resolve();
        await new Promise<void>((resolve) => {
          if (request.stop.aborted) {
            resolve();
            return;
          }
          request.stop.addEventListener('abort', () => resolve(), { once: true });
        });
        return { summary: 'stopped before the greeting was finished' };
      },
    });
    await started.promise;
    controller.abort(new Error('the operator interrupted the attempt'));
    const first = await running;

    // The interrupted attempt is a finished run of its own: cancelled, with its
    // report written, and with the working copy and ledger kept for a later
    // attempt.
    expect(first.status).toBe('cancelled');
    expect(first.workspaceLedgerProblem).toBeNull();
    expect(first.workspace).not.toBeNull();
    const workspacePath = first.workspace?.workspacePath ?? '';
    const branch = first.workspace?.branch ?? '';
    const delivered = await branchHead(workspacePath, branch);
    expect(await readFile(path.join(workspacePath, WIP_FILE), 'utf8')).toBe(
      'notes from the first try\n',
    );
    const firstReport = (await readReportFile(first.run.runDir)).report as {
      readonly status: string;
      readonly cancellation: { readonly termination: string } | null;
      readonly workspace: { readonly prepared: boolean; readonly path: string };
    };
    expect(firstReport.status).toBe('cancelled');
    expect(firstReport.cancellation?.termination).toBe('confirmed');
    expect(firstReport.workspace).toMatchObject({ prepared: true, path: workspacePath });

    // The ticket's pointer resolves through the workspace's own ledger, exactly
    // as the source intake resolves it before its next claim.
    const resolved = await resolveWorkspace(project.workDir, WORKSPACE_ID, {
      sourceItem: sourceItemFor(REF),
      sourceRoot: canonicalPath(project.repo),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.workspace).toMatchObject({
      workspacePath,
      branch,
      attempt: 2,
    });

    // The next attempt continues that clone: its baseline is red because the
    // interrupted turn left red work committed, and the attempt proceeds
    // anyway, which a fresh run would never do.
    const second = await runTicket({
      project,
      ref: REF,
      workspaceId: WORKSPACE_ID,
      continued: resolved.workspace,
      turn: async (request: AgentTurnRequest) => {
        expect(request.kind).toBe('implementation');
        expect(request.workspacePath).toBe(workspacePath);
        await writeFile(
          path.join(request.workspacePath, TARGET_RESULT_FILE),
          TARGET_RESULT_DONE,
          'utf8',
        );
        await commitEverything(request.workspacePath, 'finish the greeting');
        return { summary: 'finished the greeting in the continued workspace' };
      },
    });

    expect(second.status).toBe('passed');
    expect(second.workspace?.workspacePath).toBe(workspacePath);
    expect(second.baseline?.outcome).toBe('failed');

    // Nothing was reset or adopted: the continued attempt starts from what the
    // interrupted one left, keeps it, and moves the same recorded branch on.
    const finished = await branchHead(workspacePath, branch);
    expect(
      (await gitOrFail(['rev-list', '--count', `${delivered}..${finished}`], workspacePath)).trim(),
    ).toBe('1');
    expect(await readFile(path.join(workspacePath, WIP_FILE), 'utf8')).toBe(
      'notes from the first try\n',
    );
    expect(await readFile(path.join(workspacePath, TARGET_RESULT_FILE), 'utf8')).toBe(
      TARGET_RESULT_DONE,
    );
    expect(second.changes.paths.some((changed) => changed.path === WIP_FILE)).toBe(true);

    // The ledger holds both attempts of the one workspace, in order, and it is
    // still that ticket's workspace — the identity a pointer is trusted for.
    const state = await readWorkspaceState(project.workDir, WORKSPACE_ID);
    expect(state?.sourceItem).toEqual(sourceItemFor(REF));
    expect(state?.attempts.map((attempt) => attempt.outcome)).toEqual(['cancelled', 'passed']);
    expect(state?.attempts[1]?.runId).toBe(second.run.runId);

    // The last report is the pass, and the run directory of the interrupted
    // attempt is still beside it: neither attempt's evidence replaced the other.
    const { report } = await readReportFile(second.run.runDir);
    expect(report['status']).toBe('passed');
    expect(first.run.runDir).not.toBe(second.run.runDir);
  });
});
