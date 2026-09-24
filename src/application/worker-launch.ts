import path from 'node:path';
import { run } from '../adapters/processes.js';
import type { EngineEvent, WorkflowResult } from '../task-engine/index.js';
import type { WorkerCompletion, WorkerLaunch, WorkerLaunchRequest } from './index.js';
import { createWorkerLineReader, parseWorkerLine } from './protocol.js';

/**
 * The parent side of the worker protocol: launch the internal worker entry as a child process,
 * forward the events it reports as they arrive and observe its final result, exit and diagnostics.
 * The parent never reads terminal text as a control protocol; only the protocol messages and the
 * process exit carry meaning.
 */

/** What the launch needs to run the worker entry. */
export type WorkerLaunchSettings = {
  /** The Node executable that runs the worker entry. */
  readonly executable: string;
  /** The absolute path of the internal worker entry module. */
  readonly entry: string;
};

/** Create the worker launch over the supplied Node executable and worker entry module. */
export function createWorkerLaunch(settings: WorkerLaunchSettings): WorkerLaunch {
  return async (request: WorkerLaunchRequest, onEvent: (event: EngineEvent) => void) => {
    let result: WorkflowResult | null = null;
    let problem: string | null = null;
    const diagnostics: Uint8Array[] = [];
    const reader = createWorkerLineReader((line) => {
      if (problem !== null) {
        return;
      }
      const parsed = parseWorkerLine(line);
      if (parsed.kind === 'invalid') {
        problem = parsed.reason;
        return;
      }
      if (parsed.message.kind === 'event') {
        if (result !== null) {
          problem = 'The worker sent an event after its final result.';
          return;
        }
        try {
          onEvent(parsed.message.event);
        } catch {
          // A listener failure is isolated from the launch and from execution decisions.
        }
        return;
      }
      if (result !== null) {
        problem = 'The worker sent more than one final result.';
        return;
      }
      result = parsed.message.result;
    });

    const execution = await run(
      {
        executable: settings.executable,
        args: [settings.entry, request.projectConfigPath],
        directory: path.dirname(request.projectConfigPath),
        environment: request.environment,
      },
      (output) => {
        if (output.stream === 'stdout') {
          reader.push(output.chunk);
        } else {
          diagnostics.push(output.chunk);
        }
      },
    );

    const trailing = reader.end();
    if (problem === null && trailing.trim() !== '') {
      problem = 'The worker ended with an incomplete protocol line.';
    }
    return {
      result,
      exitCode: execution.ok ? execution.value.exitCode : null,
      problem: problem ?? (execution.ok ? null : execution.fault.message),
      diagnostics: Buffer.concat(diagnostics).toString('utf8'),
    } satisfies WorkerCompletion;
  };
}
