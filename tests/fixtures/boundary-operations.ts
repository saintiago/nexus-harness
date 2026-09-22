/** Standalone boundary calls use the same lifetime as calls inside a task. */
import { createGitHubDelivery as delivery } from '../../src/delivery/github.js';
import { runCodexPrompt as prompt, runCodexTurn as turn } from '../../src/agents/codex/adapter.js';
import { runGit as git } from '../../src/workspace/git.js';
import { prepareWorkspace as prepare } from '../../src/workspace/prepare.js';
import { preflightSource as preflight } from '../../src/workspace/preflight.js';
import { inspectWorkspaceChanges as inspect } from '../../src/workspace/changes.js';
import { combineStop, ownFixtureOperation } from './lifecycle.js';

export function createGitHubDelivery(
  ...args: Parameters<typeof delivery>
): ReturnType<typeof delivery> {
  const real = delivery(...args);
  return {
    deliver(request, callerStop) {
      return ownFixtureOperation('the delivery', (stop) =>
        real.deliver(request, combineStop(stop, callerStop)),
      );
    },
  };
}

export function runCodexPrompt(
  request: Parameters<typeof prompt>[0],
  runtime?: Parameters<typeof prompt>[1],
): ReturnType<typeof prompt> {
  return ownFixtureOperation('the standalone runtime prompt', async (stop) => {
    try {
      return await prompt({ ...request, stop: combineStop(stop, request.stop) }, runtime);
    } finally {
      await request.agentLog.close();
    }
  });
}

export function runCodexTurn(
  request: Parameters<typeof turn>[0],
  runtime?: Parameters<typeof turn>[1],
): ReturnType<typeof turn> {
  return ownFixtureOperation('the standalone coding turn', async (stop) => {
    try {
      return await turn({ ...request, stop: combineStop(stop, request.stop) }, runtime);
    } finally {
      await request.agentLog.close();
    }
  });
}

export function runGit(
  args: Parameters<typeof git>[0],
  cwd: Parameters<typeof git>[1],
  bounds: Parameters<typeof git>[2] = {},
): ReturnType<typeof git> {
  return ownFixtureOperation('the production Git command', (stop) =>
    git(args, cwd, { ...bounds, stop: combineStop(stop, bounds.stop) }),
  );
}

export function preflightSource(
  request: Parameters<typeof preflight>[0],
): ReturnType<typeof preflight> {
  return ownFixtureOperation('the source preflight', (stop) =>
    preflight({
      ...request,
      bounds: { ...request.bounds, stop: combineStop(stop, request.bounds?.stop) },
    }),
  );
}

export function prepareWorkspace(
  run: Parameters<typeof prepare>[0],
  source: Parameters<typeof prepare>[1],
  bounds: Parameters<typeof prepare>[2],
): ReturnType<typeof prepare> {
  return ownFixtureOperation('the workspace preparation', (stop) =>
    prepare(run, source, { ...bounds, stop: combineStop(stop, bounds.stop) }),
  );
}

export function inspectWorkspaceChanges(
  workspace: Parameters<typeof inspect>[0],
  bounds: Parameters<typeof inspect>[1] = {},
): ReturnType<typeof inspect> {
  return ownFixtureOperation('the workspace comparison', (stop) =>
    inspect(workspace, { ...bounds, stop: combineStop(stop, bounds.stop) }),
  );
}

/** Restoration is part of the owned promise, even on timeout or setup failure. */
export function withFixtureEnvironment<T>(
  environment: NodeJS.ProcessEnv,
  body: () => Promise<T>,
): Promise<T> {
  return ownFixtureOperation('the boundary environment', async () => {
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    const apply = (values: NodeJS.ProcessEnv): void => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    apply(environment);
    try {
      return await body();
    } finally {
      apply(previous);
    }
  });
}
