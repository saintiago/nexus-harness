import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime, type AgentResult } from '../agent-runtime/index.js';
import { createCodingRuntime } from '../adapters/coding-runtime.js';
import type { NexusConfiguration } from '../configuration/index.js';
import { messageOf } from '../result.js';
import type { ExperienceAnalyst } from '../task-engine/actions/analyze-experience/index.js';
import {
  beginAgentInvocation,
  type AgentActivityPublisher,
  type EventPublisher,
} from '../task-engine/index.js';
import { createAgentRuntimeSettings } from './composition.js';
import { prepareOperationalWorktree } from './operational-worktree.js';

/**
 * Application's parent-side wiring of the AnalyzeExperience analyst: the configured analysis
 * profile over the coding provider, with the shared memory server restricted to search because
 * the action validates and submits the returned observations itself. Application constructs the
 * action's analyst capability without importing the Memory component. See
 * docs/memory/integration.md and docs/task-engine/actions/analyze-experience.md.
 */

/** What building the analysis runtime needs: resolved configuration and provider host settings. */
export type AnalysisRuntimeConstruction = {
  readonly nexus: NexusConfiguration;
  /** The host settings the provider process runs with, without Nexus credentials. */
  readonly environment: Readonly<Record<string, string>>;
  /** Announces the analyst invocation's boundaries to the execution's observers. */
  readonly publish: EventPublisher;
  /** Transports the analyst invocation's activity on the engine's activity channel. */
  readonly publishActivity: AgentActivityPublisher;
  /** The execution's agent activity directory the invocation's own log lives under. */
  readonly activityDirectory: string;
};

/** Builds the parent-side analyst capability from resolved configuration and host settings. */
export type AnalysisRuntimeFactory = (
  construction: AnalysisRuntimeConstruction,
) => ExperienceAnalyst;

/** Create the analyst capability over the configured analysis profile. */
export function createAnalysisRuntime(
  construction: AnalysisRuntimeConstruction,
): ExperienceAnalyst {
  const { nexus, environment } = construction;
  const memory = nexus.memory;
  const codingRuntime = createCodingRuntime({
    executable: nexus.agentRuntime.provider.executable,
    environment,
  });
  return async (request): Promise<AgentResult> => {
    if (memory === undefined || !memory.enabled) {
      return {
        ok: false,
        fault: { message: 'Memory is disabled, so no experience analysis can run.' },
      };
    }
    // One invocation carries its own identity and activity, like every other agent invocation.
    const invocation = beginAgentInvocation({
      agentName: 'analysis',
      operation: 'AnalyzeExperience',
      ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId }),
      profile: memory.analysisProfile,
      directory: construction.activityDirectory,
      publish: construction.publish,
      publishActivity: construction.publishActivity,
    });
    const runtime = createAgentRuntime(
      createAgentRuntimeSettings(nexus, 'analysis', codingRuntime, environment),
    );
    let result: AgentResult;
    try {
      await prepareOperationalWorktree(path.join(request.workspace.root, 'worktree'), environment);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const helper = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./cli.js', import.meta.url)))}`;
      const evidence = quote(request.workspace.root);
      result = await runtime.run(
        memory.analysisProfile,
        request.workspace,
        `${request.context}\n\nEvidence helpers (JSON output; usage is logged in this invocation):\n` +
          `${helper} evidence list ${evidence}\n` +
          `${helper} evidence read ${evidence} <relative-files...> [--max-bytes <n>]\n` +
          'Use these instead of writing artifact-listing/reading scripts. Read known files directly ' +
          'when simpler; select relevant evidence, and increase --max-bytes if a needed file is truncated. ' +
          'The inventory omits worktree/ unless explicitly selected. Interpret evidence and revisions yourself.',
        (activity) => {
          // The invocation channel carries the activity to the operator and its durable log; the
          // action also retains it with the analysis request that produced the invocation.
          invocation.activity(activity);
          request.onActivity(activity);
        },
        // The action derives the response schema from its own contract; the provider enforces the
        // shape and the action still validates the returned observations and their evidence.
        request.outputSchema,
      );
    } catch (error) {
      invocation.finish({ outcome: 'failed', reason: messageOf(error) });
      return { ok: false, fault: { message: messageOf(error) } };
    }
    invocation.finish(
      result.ok ? { outcome: 'finished' } : { outcome: 'failed', reason: result.fault.message },
    );
    return result;
  };
}
