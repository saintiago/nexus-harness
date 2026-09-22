/** Standalone boundary calls use the same lifetime as calls inside a task. */
import { createGitHubDelivery as delivery } from '../../src/delivery/github.js';
import { runCodexPrompt as prompt, runCodexTurn as turn } from '../../src/agents/codex/adapter.js';
import { runGit as git } from '../../src/workspace/git.js';
import { prepareWorkspace as prepare } from '../../src/workspace/prepare.js';
import { preflightSource as preflight } from '../../src/workspace/preflight.js';
import { inspectWorkspaceChanges as inspect } from '../../src/workspace/changes.js';
import {
  inspectBranchStanding as standing,
  returnToRecordedBranch as restore,
} from '../../src/workspace/branch.js';
import {
  reopenWorkspace as reopen,
  resolveWorkspace as resolve,
} from '../../src/workspace/reopen.js';
import {
  prepareReviewView as view,
  reviewViewProblem as viewProblem,
} from '../../src/reviews/view.js';
import { createBaselineReviewer as baselineReviewer } from '../../src/reviews/baseline.js';
import { allocateRunDirectory as allocate } from '../../src/workspace/run-directory.js';
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
  sourceItem?: Parameters<typeof prepare>[3],
): ReturnType<typeof prepare> {
  return ownFixtureOperation('the workspace preparation', (stop) =>
    prepare(run, source, { ...bounds, stop: combineStop(stop, bounds.stop) }, sourceItem),
  );
}

export function allocateRunDirectory(
  ...args: Parameters<typeof allocate>
): ReturnType<typeof allocate> {
  return ownFixtureOperation('the run directory allocation', () => allocate(...args));
}

export function inspectBranchStanding(
  workspace: Parameters<typeof standing>[0],
  branch: Parameters<typeof standing>[1],
  bounds: Parameters<typeof standing>[2] = {},
  read: Parameters<typeof standing>[3] = {},
): ReturnType<typeof standing> {
  return ownFixtureOperation('the branch inspection', (stop) =>
    standing(workspace, branch, { ...bounds, stop: combineStop(stop, bounds.stop) }, read),
  );
}

export function returnToRecordedBranch(
  workspace: Parameters<typeof restore>[0],
  branch: Parameters<typeof restore>[1],
  bounds: Parameters<typeof restore>[2] = {},
  read: Parameters<typeof restore>[3] = {},
): ReturnType<typeof restore> {
  return ownFixtureOperation('the branch recovery', (stop) =>
    restore(workspace, branch, { ...bounds, stop: combineStop(stop, bounds.stop) }, read),
  );
}

export function resolveWorkspace(...args: Parameters<typeof resolve>): ReturnType<typeof resolve> {
  return ownFixtureOperation('the workspace resolution', () => resolve(...args));
}

export function reopenWorkspace(
  workDir: Parameters<typeof reopen>[0],
  workspaceId: Parameters<typeof reopen>[1],
  expected: Parameters<typeof reopen>[2],
  bounds: Parameters<typeof reopen>[3] = {},
): ReturnType<typeof reopen> {
  return ownFixtureOperation('the workspace reopening', (stop) =>
    reopen(workDir, workspaceId, expected, { ...bounds, stop: combineStop(stop, bounds.stop) }),
  );
}

export function prepareReviewView(
  request: Parameters<typeof view>[0],
  callerStop: Parameters<typeof view>[1],
): ReturnType<typeof view> {
  return ownFixtureOperation('the review view preparation', (stop) =>
    view(request, combineStop(stop, callerStop)),
  );
}

export function reviewViewProblem(
  request: Parameters<typeof viewProblem>[0],
  callerStop: Parameters<typeof viewProblem>[1],
): ReturnType<typeof viewProblem> {
  return ownFixtureOperation('the review view verification', (stop) =>
    viewProblem(request, combineStop(stop, callerStop)),
  );
}

export function createBaselineReviewer(
  ...args: Parameters<typeof baselineReviewer>
): ReturnType<typeof baselineReviewer> {
  const review = baselineReviewer(...args);
  return (request) =>
    ownFixtureOperation('the baseline reviewer', (stop) =>
      review({ ...request, stop: combineStop(stop, request.stop) }),
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
