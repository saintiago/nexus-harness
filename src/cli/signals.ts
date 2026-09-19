/**
 * The host's own interrupt signals, and nothing else.
 *
 * `SIGINT` is what Ctrl+C sends on every supported platform, and `SIGTERM` is
 * the ordinary way a Unix supervisor asks a process to stop. Windows has a
 * second one: Ctrl+Break reaches a process started in a new process group, and
 * Node reports it as `SIGBREAK`. A listener replaces Node's default handling
 * and is installed only for the duration of a run.
 */
import type { InterruptSignals } from './context.js';

const INTERRUPT_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];

export function hostSignals(): InterruptSignals {
  return {
    onInterrupt: (handler) => {
      for (const name of INTERRUPT_SIGNALS) {
        process.on(name, handler);
      }
      return () => {
        for (const name of INTERRUPT_SIGNALS) {
          process.off(name, handler);
        }
      };
    },
  };
}
