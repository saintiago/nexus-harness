import type { TerminalCapabilities } from '../operator-interface/index.js';

/**
 * Terminal capability detection for the operator presentation: an interactive terminal of its
 * current dimensions, color unless the operator disabled it, and its output sink. Presentation
 * owns pane use, wrapping and styled output.
 *
 * The output sink is a Node stream in production. A broken pipe or closure reaches it
 * asynchronously through the stream's own events rather than through the write call, so this
 * boundary observes error and close, stops rendering to a failed sink, and keeps listening until
 * the failures the issued writes reported have arrived. Presentation failure never affects the
 * execution the parent manages.
 */

/** The output stream capabilities terminal presentation requires. */
export type TerminalOutput = {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  /** Write one chunk; the callback reports the write settling, with its error when it failed. */
  write(text: string, settled?: (error?: Error | null) => void): unknown;
  /** The stream's asynchronous failure and closure notifications, when the sink is a stream. */
  on?(event: 'error' | 'close', listener: () => void): unknown;
  off?(event: 'error' | 'close', listener: () => void): unknown;
};

/** The presentation's terminal and the Application boundary's release of its stream listeners. */
export type ApplicationTerminal = TerminalCapabilities & {
  /** Stop rendering and release the output listeners once no issued write is still outstanding. */
  stop(): void;
};

/** Terminal capabilities for the supplied output and host environment. */
export function terminalCapabilities(
  output: TerminalOutput,
  environment: Readonly<Record<string, string | undefined>>,
): ApplicationTerminal {
  const interactive = output.isTTY === true;
  const observed = typeof output.on === 'function' && typeof output.off === 'function';
  let closed = false;
  let stopping = false;
  let unsettledWrites = 0;
  let unreportedFailures = 0;

  const release = (): void => {
    output.off?.('error', outputClosed);
    output.off?.('close', outputClosed);
  };
  const releaseIdle = (): void => {
    if (stopping && unsettledWrites === 0 && unreportedFailures === 0) {
      release();
    }
  };

  // A closed or broken output reports its failure asynchronously; without a listener the error
  // would crash the parent. Once seen, rendering stops and execution continues unaffected.
  const outputClosed = (): void => {
    closed = true;
    unreportedFailures = 0;
    releaseIdle();
  };
  // A failed write surfaces as the stream's error event, which may arrive after the write has
  // settled and after presentation has stopped; the listeners stay until it has.
  const settled = (error?: Error | null): void => {
    unsettledWrites -= 1;
    if (error !== undefined && error !== null && !closed) {
      unreportedFailures += 1;
    }
    releaseIdle();
  };
  if (observed) {
    output.on?.('error', outputClosed);
    output.on?.('close', outputClosed);
  }
  return {
    interactive,
    color: interactive && environment['NO_COLOR'] === undefined && environment['TERM'] !== 'dumb',
    size: () => ({ columns: output.columns ?? 0, rows: output.rows ?? 0 }),
    write: (text) => {
      if (closed) {
        return;
      }
      unsettledWrites += 1;
      try {
        output.write(text, settled);
      } catch {
        closed = true;
        settled();
      }
    },
    stop: () => {
      stopping = true;
      releaseIdle();
    },
  };
}
