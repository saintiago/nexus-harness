import { StringDecoder } from 'node:string_decoder';
import { messageOf } from '../result.js';
import type { EngineEvent, WorkflowResult } from '../task-engine/index.js';

/**
 * The worker protocol from the Application design: newline-delimited JSON on the worker's standard
 * output. The worker sends each TaskEngine event unchanged and its final workflow result as its
 * last message; standard error carries diagnostics. The parent reads both and never treats a zero
 * exit alone as completion.
 */

/** The worker's standard output sink. */
export type OutputSink = { write(text: string): unknown };

/** One message the worker sends to its parent. */
export type WorkerMessage =
  | { readonly kind: 'event'; readonly event: EngineEvent }
  | { readonly kind: 'result'; readonly result: WorkflowResult };

/** Encode one protocol message as one newline-terminated JSON line. */
export function encodeWorkerMessage(message: WorkerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** True for a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The workflow result a message carries, or null when the value is not one. */
function parseResult(value: unknown): WorkflowResult | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['ok'] === true && typeof value['value'] === 'string') {
    return { ok: true, value: value['value'] };
  }
  const failure = value['fault'];
  if (value['ok'] === false && isRecord(failure) && typeof failure['message'] === 'string') {
    return { ok: false, fault: { message: failure['message'] } };
  }
  return null;
}

/** One decoded stdout line: a protocol message, or why the line is not one. */
export type WorkerLine =
  | { readonly kind: 'message'; readonly message: WorkerMessage }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Decode one stdout line into the protocol message it carries. */
export function parseWorkerLine(line: string): WorkerLine {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `The worker wrote a line that is not JSON: ${messageOf(error)}`,
    };
  }
  if (!isRecord(value)) {
    return { kind: 'invalid', reason: 'The worker wrote a JSON value that is not a message.' };
  }
  const kind = value['kind'];
  if (kind === 'event') {
    const event = value['event'];
    if (
      !isRecord(event) ||
      typeof event['source'] !== 'string' ||
      typeof event['type'] !== 'string'
    ) {
      return {
        kind: 'invalid',
        reason: 'The worker wrote an event message without a string source and type.',
      };
    }
    return {
      kind: 'message',
      message: {
        kind: 'event',
        event: { source: event['source'], type: event['type'], data: event['data'] },
      },
    };
  }
  if (kind === 'result') {
    const result = parseResult(value['result']);
    if (result === null) {
      return {
        kind: 'invalid',
        reason: 'The worker wrote a result message that is not a workflow result.',
      };
    }
    return { kind: 'message', message: { kind: 'result', result } };
  }
  return {
    kind: 'invalid',
    reason: `The worker wrote an unknown message kind ${JSON.stringify(kind) ?? String(kind)}.`,
  };
}

/**
 * Split a byte stream into complete lines, decoding text across chunk boundaries so a multi-byte
 * character split between chunks survives. end() returns the incomplete trailing text, which the
 * caller reports as a truncated protocol line.
 */
export function createWorkerLineReader(onLine: (line: string) => void): {
  push(chunk: Uint8Array): void;
  end(): string;
} {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = (text: string): void => {
    pending += text;
    let index = pending.indexOf('\n');
    while (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      onLine(line);
      index = pending.indexOf('\n');
    }
  };
  return {
    push: (chunk) => {
      consume(decoder.write(chunk));
    },
    end: () => {
      consume(decoder.end());
      const trailing = pending;
      pending = '';
      return trailing;
    },
  };
}

/** The worker side of the protocol: write events and the final result to standard output. */
export type WorkerProtocol = {
  event(event: EngineEvent): void;
  result(result: WorkflowResult): void;
};

/** Create the worker protocol over its standard output and standard error sinks. */
export function createWorkerProtocol(stdout: OutputSink, diagnostics: OutputSink): WorkerProtocol {
  const send = (message: WorkerMessage): void => {
    let line: string;
    try {
      line = encodeWorkerMessage(message);
    } catch (error) {
      diagnostics.write(`Nexus could not report its ${message.kind}: ${messageOf(error)}\n`);
      return;
    }
    stdout.write(line);
  };
  return {
    event: (event) => {
      send({ kind: 'event', event });
    },
    result: (result) => {
      send({ kind: 'result', result });
    },
  };
}
