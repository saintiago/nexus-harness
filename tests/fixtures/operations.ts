/** Real production entry points, registered before they can start fixture work. */
import { runCommand as command } from '../../src/process/command.js';
import { runCheckRound as round } from '../../src/checks/round.js';
import { runTask as task } from '../../src/runs/runner.js';
import { combineStop, ownFixtureOperation } from './lifecycle.js';

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
