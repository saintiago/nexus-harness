/**
 * Protocol tests: the worker side encodes events and its final result, the line reader decodes
 * complete lines across chunk boundaries, and the parent bridge launches a controlled child
 * process and observes its events, result, exit and diagnostics. The controlled worker only
 * writes scripted protocol output; no service or configuration is involved.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentActivity, EngineEvent } from '../src/task-engine/index.js';
import {
  createWorkerLineReader,
  createWorkerProtocol,
  encodeWorkerMessage,
  parseWorkerLine,
} from '../src/application/protocol.js';
import { createWorkerLaunch } from '../src/application/worker-launch.js';

const controlledWorker = fileURLToPath(
  new URL('./fixtures/worker/protocol-worker.mjs', import.meta.url),
);

let workingDirectory = '';
let projectConfigPath = '';

beforeAll(async () => {
  workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'nexus-worker-protocol-'));
  projectConfigPath = path.join(workingDirectory, 'project.config.json');
});

afterAll(async () => {
  await rm(workingDirectory, { recursive: true, force: true });
});

/** Launch the controlled worker with one scenario and record the events it reported. */
async function launch(scenario: string): Promise<{
  readonly events: readonly EngineEvent[];
  readonly activity: readonly AgentActivity[];
  readonly completion: Awaited<ReturnType<ReturnType<typeof createWorkerLaunch>>>;
}> {
  const events: EngineEvent[] = [];
  const activity: AgentActivity[] = [];
  const completion = await createWorkerLaunch({
    executable: process.execPath,
    entry: controlledWorker,
  })(
    {
      projectConfigPath,
      workflow: 'finite-delivery',
      logDirectory: workingDirectory,
      environment: { NEXUS_TEST_SCENARIO: scenario },
    },
    (event) => {
      events.push(event);
    },
    (packet) => {
      activity.push(packet);
    },
  );
  return { events, activity, completion };
}

describe('worker protocol messages', () => {
  it('round-trips the events and final result the worker sends', () => {
    const encoded = encodeWorkerMessage({
      kind: 'event',
      event: { source: 'execution-runner', type: 'state', data: { name: 'select' } },
    });
    expect(encoded.endsWith('\n')).toBe(true);
    expect(parseWorkerLine(encoded.trimEnd())).toEqual({
      kind: 'message',
      message: {
        kind: 'event',
        event: { source: 'execution-runner', type: 'state', data: { name: 'select' } },
      },
    });

    const result = { kind: 'result', result: { ok: true, value: 'drained' } } as const;
    expect(parseWorkerLine(encodeWorkerMessage(result).trimEnd())).toEqual({
      kind: 'message',
      message: result,
    });
    expect(
      parseWorkerLine(
        encodeWorkerMessage({
          kind: 'result',
          result: { ok: false, fault: { message: 'invalid state' } },
        }).trimEnd(),
      ),
    ).toEqual({
      kind: 'message',
      message: { kind: 'result', result: { ok: false, fault: { message: 'invalid state' } } },
    });

    const activity = {
      kind: 'agent-activity',
      invocationId: 'inv-1',
      timestamp: '2026-09-24T22:00:00.000Z',
      activity: { type: 'message', text: 'implementing the change' },
    } as const;
    expect(parseWorkerLine(encodeWorkerMessage(activity).trimEnd())).toEqual({
      kind: 'message',
      message: activity,
    });
  });

  it('rejects lines that are not protocol messages', () => {
    const rejected = [
      'not json',
      '[]',
      '{"kind":"start"}',
      '{"kind":"event","event":{"source":"test"}}',
      '{"kind":"agent-activity","timestamp":"2026-09-24T22:00:00.000Z","activity":{"type":"message","text":"x"}}',
      '{"kind":"agent-activity","invocationId":"inv-1","activity":{"type":"message","text":"x"}}',
      '{"kind":"agent-activity","invocationId":"inv-1","timestamp":"2026-09-24T22:00:00.000Z","activity":{"type":"typing","text":"x"}}',
      '{"kind":"result","result":{"ok":true}}',
      '{"kind":"result","result":{"ok":false,"fault":{}}}',
    ];
    for (const line of rejected) {
      expect(parseWorkerLine(line).kind, line).toBe('invalid');
    }
  });

  it('isolates an event whose data cannot be serialized', () => {
    const output: string[] = [];
    const diagnostics: string[] = [];
    const protocol = createWorkerProtocol(
      { write: (text) => output.push(text) },
      { write: (text) => diagnostics.push(text) },
    );
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    protocol.event({ source: 'test', type: 'progress', data: cyclic });
    protocol.result({ ok: true, value: 'drained' });

    expect(output).toEqual(['{"kind":"result","result":{"ok":true,"value":"drained"}}\n']);
    expect(diagnostics.join('')).toContain('could not report its event');
  });

  it('decodes complete lines across chunk boundaries without cutting characters', () => {
    const lines: string[] = [];
    const reader = createWorkerLineReader((line) => lines.push(line));
    const encoded = Buffer.from(
      '{"kind":"event","event":{"source":"test","type":"progress","data":"café"}}\n',
      'utf8',
    );
    const split = encoded.indexOf(0xc3) + 1;

    reader.push(encoded.subarray(0, split));
    reader.push(encoded.subarray(split));

    expect(reader.end()).toBe('');
    expect(lines).toEqual([
      '{"kind":"event","event":{"source":"test","type":"progress","data":"café"}}',
    ]);
  });
});

describe('worker bridge', () => {
  it('forwards events and observes the final result of a clean run', async () => {
    const { events, completion } = await launch('ok');

    expect(events).toEqual([{ source: 'test', type: 'progress', data: { projectConfigPath } }]);
    expect(completion).toEqual({
      result: { ok: true, value: 'drained' },
      exitCode: 0,
      problem: null,
      diagnostics: '',
    });
  });

  it('forwards attributable activity with its invocation identity', async () => {
    const { events, activity, completion } = await launch('activity');

    expect(events).toEqual([]);
    expect(activity).toEqual([
      {
        invocationId: 'inv-1',
        timestamp: '2026-09-24T22:00:00.000Z',
        activity: { type: 'message', text: 'controlled activity' },
      },
    ]);
    expect(completion.result).toEqual({ ok: true, value: 'drained' });
    expect(completion.problem).toBeNull();
  });

  it('carries a returned execution fault with its failing exit', async () => {
    const { completion } = await launch('fault');

    expect(completion.result).toEqual({ ok: false, fault: { message: 'controlled fault' } });
    expect(completion.exitCode).toBe(1);
    expect(completion.problem).toBeNull();
  });

  it('reports a worker that exits without a result instead of completing', async () => {
    const { completion } = await launch('no-result');

    expect(completion.result).toBeNull();
    expect(completion.exitCode).toBe(0);
    expect(completion.problem).toBeNull();
  });

  it('collects standard error diagnostics', async () => {
    const { completion } = await launch('diagnostics');

    expect(completion.result).toEqual({ ok: true, value: 'drained' });
    expect(completion.diagnostics).toBe('controlled diagnostic\n');
    expect(completion.problem).toBeNull();
  });

  it('observes a nonzero exit after a result rather than completing', async () => {
    const { completion } = await launch('failed-exit');

    expect(completion.result).toEqual({ ok: true, value: 'drained' });
    expect(completion.exitCode).toBe(3);
  });

  it('reports malformed protocol output as a problem', async () => {
    const expected: Readonly<Record<string, RegExp>> = {
      'bad-event': /without a string source and type/,
      'not-json': /not JSON/,
      truncated: /incomplete protocol line/,
      'two-results': /more than one final result/,
      'late-event': /event after its final result/,
      'late-activity': /agent activity after its final result/,
    };
    for (const [scenario, message] of Object.entries(expected)) {
      const { completion } = await launch(scenario);
      expect(completion.problem, scenario).toMatch(message);
    }
  });
});
