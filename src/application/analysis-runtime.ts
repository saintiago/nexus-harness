import { z } from 'zod';
import { createAgentRuntime, type AgentResult } from '../agent-runtime/index.js';
import { createCodingRuntime } from '../adapters/coding-runtime.js';
import type { NexusConfiguration } from '../configuration/index.js';
import { completionAnalysisResponseSchema, type AnalysisAgentRequest } from './analysis.js';
import { createAnalysisAgentRuntimeSettings } from './composition.js';

/**
 * The parent-side completion-analysis wiring: the configured analysis profile over the coding
 * provider. The analyst inspects one completed task's retained evidence and returns candidate
 * observations; it runs with the shared memory server restricted to search, because Nexus
 * validates and submits the returned observations itself. See docs/memory/integration.md.
 */

/** What building the analysis runtime needs: resolved Nexus configuration and provider host settings. */
export type AnalysisRuntimeConstruction = {
  readonly nexus: NexusConfiguration;
  /** The host settings the provider process runs with, without Nexus credentials. */
  readonly environment: Readonly<Record<string, string>>;
};

/** The parent-side analysis capability: one analyst invocation for one completed task. */
export type AnalysisRuntime = {
  readonly analyze: (request: AnalysisAgentRequest) => Promise<AgentResult>;
};

/** Builds the completion-analysis runtime from resolved configuration and provider settings. */
export type AnalysisRuntimeFactory = (construction: AnalysisRuntimeConstruction) => AnalysisRuntime;

/** Create the completion-analysis runtime over the configured analysis profile. */
export function createAnalysisRuntime(construction: AnalysisRuntimeConstruction): AnalysisRuntime {
  const { nexus, environment } = construction;
  const codingRuntime = createCodingRuntime({
    executable: nexus.agentRuntime.provider.executable,
    environment,
  });
  return {
    async analyze(request) {
      const memory = nexus.memory;
      if (memory === undefined || !memory.enabled) {
        return {
          ok: false,
          fault: { message: 'Memory is disabled, so no completion analysis can run.' },
        };
      }
      const runtime = createAgentRuntime(createAnalysisAgentRuntimeSettings(nexus, codingRuntime));
      return runtime.run(
        memory.analysisProfile,
        request.workspace,
        request.context,
        request.onActivity,
        // The provider enforces the response shape; Application still validates the returned
        // observations and their evidence before anything is submitted.
        z.toJSONSchema(completionAnalysisResponseSchema),
      );
    },
  };
}
