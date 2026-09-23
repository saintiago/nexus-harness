/**
 * The coding runtime adapter, with a real stand-in runtime program.
 *
 * `runCodexTurn` starts the configured runtime exactly as production does — its
 * own fixed arguments, the prompt on standard input, the working root as the
 * process's working directory — and reads the documented JSON event stream it
 * answers with. Only a turn that reported that it completed is a turn: a runtime
 * that reported a failure, one that exited without reporting a completion, one
 * whose stream contradicted itself, one whose output is not the documented
 * interface, and one that could not be started are all execution failures of the
 * turn, and none of them is rounded up to a completed turn. What the runtime
 * wrote before it failed stays in the turn's own log.
 *
 * The stand-in here is a small Node script that answers one of those endings,
 * put first on `PATH` for one case only, so a real runtime process crosses the
 * boundary and no live provider or credential is involved.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentError, runCodexTurn } from '../../src/agents/codex/adapter.js';
import { codexRuntime } from '../../src/agents/codex/runtime.js';
import type { CodexRuntime } from '../../src/agents/codex/runtime.js';
import { openAgentLog } from '../../src/reporting/logs.js';
import type { AgentTurnRequest, AgentTurnResult } from '../../src/runs/contracts.js';
import { createTempDir, readText } from '../support.js';
import { installStandIn, withPathPrefix } from './integration-support.js';

/** One coding turn's request, the working tree it runs in, and its own log. */
async function openTurn(): Promise<AgentTurnRequest> {
  const root = await createTempDir();
  const workspacePath = path.join(root, 'workspace');
  const logsDir = path.join(root, 'logs');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  return {
    kind: 'implementation',
    turn: 1,
    task: {
      id: 'HARN-77',
      title: 'Finish the greeting',
      description: 'Implement the greeting the ticket describes.',
      acceptanceCriteria: ['The greeting is implemented.'],
    },
    workspacePath,
    sourceRoot: path.join(root, 'repo'),
    baseCommit: '0'.repeat(40),
    agentLog: await openAgentLog(logsDir, 1),
    repair: null,
    stop: new AbortController().signal,
  };
}

/**
 * One stand-in runtime program: it consumes the prompt the adapter writes, then
 * answers with exactly the output lines it was given and exits with the code it
 * was given. Standard error is written verbatim, as a real runtime's diagnostic
 * would be.
 */
function runtimeProgram(input: {
  readonly lines?: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
}): string {
  const lines = (input.lines ?? []).map((line) => JSON.stringify(line)).join(', ');
  return [
    `let prompt = '';`,
    `process.stdin.setEncoding('utf8');`,
    `process.stdin.on('data', (chunk) => { prompt += chunk; });`,
    `process.stdin.on('end', () => {`,
    input.stderr === undefined ? '' : `  process.stderr.write(${JSON.stringify(input.stderr)});`,
    `  for (const line of [${lines}]) {`,
    `    process.stdout.write(line + '\\n');`,
    `  }`,
    `  process.exit(${String(input.exitCode ?? 0)});`,
    `});`,
    ``,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** One documented event line. */
function event(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

const TURN_COMPLETED = event({ type: 'turn.completed' });

/** What running the adapter against one stand-in runtime produced. */
interface TurnOutcome {
  readonly result: AgentTurnResult | null;
  readonly failure: unknown;
  /** What the turn's own log holds, read back after the turn ended. */
  readonly log: string;
}

/**
 * Runs one adapter turn against a stand-in program first on `PATH`, or against
 * an explicitly named runtime when a case is about a runtime that cannot start.
 * The turn's log is closed afterwards, as its caller owns it.
 */
async function runTurn(
  program: string | null,
  options: {
    readonly command?: readonly string[];
  } = {},
): Promise<TurnOutcome> {
  const request = await openTurn();
  const runtime: CodexRuntime =
    options.command === undefined ? codexRuntime() : codexRuntime({ command: options.command });
  const run = async (): Promise<AgentTurnResult> => await runCodexTurn(request, runtime);
  let result: AgentTurnResult | null = null;
  let failure: unknown = null;
  try {
    if (program === null) {
      result = await run();
    } else {
      const standIn = await installStandIn('codex', program);
      result = await withPathPrefix(standIn.bin, run);
    }
  } catch (cause) {
    failure = cause;
  } finally {
    await request.agentLog.close();
  }
  return { result, failure, log: await readText(request.agentLog.path) };
}

/** The message of the one failure a case expected, as an `AgentError`. */
function agentFailure(failure: unknown): string {
  expect(failure).toBeInstanceOf(AgentError);
  return (failure as Error).message;
}

describe('how a coding turn ends', () => {
  it('reports a completed turn as the agent’s own summary, and keeps its stream', async () => {
    const outcome = await runTurn(
      runtimeProgram({
        lines: [
          event({ type: 'thread.started', thread_id: 'session-1' }),
          event({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'I appended the line.' },
          }),
          TURN_COMPLETED,
        ],
      }),
    );

    // Agent text, and only agent text: nothing here is a check result.
    expect(outcome.failure).toBeNull();
    expect(outcome.result).toEqual({ summary: 'I appended the line.' });
    // The runtime's own output is kept as the turn wrote it, events and all.
    expect(outcome.log).toContain('turn.completed');
    expect(outcome.log).toContain('thread.started');
  }, 45_000);

  it('rejects a turn the runtime reported as failed, keeping what it wrote', async () => {
    const outcome = await runTurn(
      runtimeProgram({
        lines: [
          event({
            type: 'turn.failed',
            error: { message: 'the model could not complete the request' },
          }),
        ],
      }),
    );

    expect(outcome.result).toBeNull();
    expect(agentFailure(outcome.failure)).toContain(
      'reported that the turn failed: the model could not complete the request',
    );
    expect(outcome.log).toContain('turn.failed');
  }, 45_000);

  it('rejects a stream that reports a failed turn and a completed turn at once', async () => {
    const outcome = await runTurn(
      runtimeProgram({
        lines: [
          event({ type: 'turn.failed', error: { message: 'the request was refused' } }),
          TURN_COMPLETED,
        ],
      }),
    );

    expect(agentFailure(outcome.failure)).toContain(
      'reported a failed turn and a completed turn, so the turn cannot be read as completed',
    );
    expect(outcome.result).toBeNull();
  }, 45_000);

  it('rejects a runtime that exits without reporting that the turn completed', async () => {
    const outcome = await runTurn(
      runtimeProgram({
        lines: [
          event({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'looks done to me' },
          }),
        ],
      }),
    );

    const message = agentFailure(outcome.failure);
    expect(message).toContain('exited with code 0 without reporting that the turn completed');
    expect(message).toContain('An unexpected runtime interface is an execution failure');
    // Nothing is invented for a turn that stopped short of completing, and what
    // it did say is kept where it said it.
    expect(outcome.result).toBeNull();
    expect(outcome.log).toContain('looks done to me');
  }, 45_000);

  it('counts output that is not the documented event interface', async () => {
    const outcome = await runTurn(runtimeProgram({ lines: ['this is not an event at all'] }));

    const message = agentFailure(outcome.failure);
    expect(message).toContain('1 of its output lines were not JSON events');
    expect(message).toContain('this is not an event at all');
  }, 45_000);

  it('repeats what the runtime said when it exits nonzero without completing', async () => {
    const outcome = await runTurn(
      runtimeProgram({
        stderr: 'not logged in: run `codex login` to authenticate\n',
        exitCode: 1,
      }),
    );

    const message = agentFailure(outcome.failure);
    expect(message).toContain('exited with code 1 without reporting a completed turn');
    // The runtime's own diagnostic is repeated, not replaced by a category this
    // adapter invented for it.
    expect(message).toContain('not logged in: run `codex login` to authenticate');
  }, 45_000);

  it('rejects a runtime that cannot be started, and starts nothing', async () => {
    const root = await createTempDir();
    const outcome = await runTurn(null, {
      command: [path.join(root, 'nexus-no-such-runtime')],
    });

    const message = agentFailure(outcome.failure);
    expect(message).toContain('the coding runtime could not be started');
    expect(outcome.result).toBeNull();
    expect(outcome.log).toContain('could not be started');
  }, 45_000);
});
