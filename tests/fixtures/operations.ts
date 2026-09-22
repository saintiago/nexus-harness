/** Real production entry points, registered before they can start fixture work. */
import { runCommand as command } from '../../src/process/command.js';
import { runCheckRound as round } from '../../src/checks/round.js';
import { runTask as task } from '../../src/runs/runner.js';
import { runCli as cli } from '../../src/cli.js';
import { hostSignals } from '../../src/cli/signals.js';
import { combineStop, ownFixtureOperation } from './lifecycle.js';

/** Keep real host/caller signals, adding the fixture's stop without emitting a host signal. */
export function runCli(
  argv: Parameters<typeof cli>[0],
  context: NonNullable<Parameters<typeof cli>[1]>,
): ReturnType<typeof cli> {
  return ownFixtureOperation('the in-process CLI', async (stop) => {
    const signals = context.signals ?? hostSignals();
    const releases = new Set<() => void>();
    try {
      return await cli(argv, {
        ...context,
        signals: {
          onInterrupt(handler) {
            const releaseSignal = signals.onInterrupt(handler);
            const release = (): void => {
              stop.removeEventListener('abort', handler);
              releaseSignal();
              releases.delete(release);
            };
            releases.add(release);
            stop.addEventListener('abort', handler, { once: true });
            // Disposal may start while the CLI is still reading configuration.
            if (stop.aborted) handler();
            return release;
          },
        },
      });
    } finally {
      for (const release of releases) release();
    }
  });
}

export function runCommand(request: Parameters<typeof command>[0]): ReturnType<typeof command> {
  return ownFixtureOperation('the command', (stop) =>
    command({ ...request, stop: combineStop(stop, request.stop) }),
  );
}

export function runCheckRound(request: Parameters<typeof round>[0]): ReturnType<typeof round> {
  return ownFixtureOperation('the check round', (stop) =>
    round({ ...request, stop: combineStop(stop, request.stop) }),
  );
}

export function runTask(
  request: Parameters<typeof task>[0],
  dependencies: Parameters<typeof task>[1],
): ReturnType<typeof task> {
  return ownFixtureOperation('the run', (stop) =>
    task({ ...request, stop: combineStop(stop, request.stop) }, dependencies),
  );
}
