/**
 * Test support: adapt a controlled AgentRuntime to the agent runner an action consumes. The real
 * runner — created by Application's action binding — assigns each invocation's identity and
 * transports its attributable activity; action-scoped tests exercise the action's own behavior
 * with this adapter, while Application's composition and the system journeys cover the real one.
 */

import { writeFile } from 'node:fs/promises';
import { createAgentRuntime, type AgentRuntime } from '../../src/agent-runtime/index.js';
import type { CodingRuntime, CodingRuntimeRequest } from '../../src/adapters/coding-runtime.js';
import { createAgentRuntimeSettings, type ProfileRole } from '../../src/application/composition.js';
import type { NexusConfiguration } from '../../src/configuration/index.js';
import { ok } from '../../src/result.js';
import type { AgentRoleRunner } from '../../src/task-engine/index.js';

/** One controlled runtime as the role runner of the action under test. */
export function runnerOf(runtime: AgentRuntime): AgentRoleRunner {
  return {
    run: (request) =>
      runtime.run(
        request.profile,
        request.workspace,
        request.context,
        () => undefined,
        request.outputSchema,
      ),
  };
}

/**
 * One role runner assembled exactly as Application assembles it: the resolved Nexus configuration
 * supplies the role's constant instructions on every selected profile, AgentRuntime assembles the
 * prompt and a recording coding provider answers each invocation with the controlled output. The
 * returned requests expose the complete prompt the provider received.
 */
export function composedRunner(
  configuration: NexusConfiguration,
  role: ProfileRole,
  respond: (request: CodingRuntimeRequest) => string | Promise<string>,
): { readonly runner: AgentRoleRunner; readonly requests: CodingRuntimeRequest[] } {
  const requests: CodingRuntimeRequest[] = [];
  const codingRuntime: CodingRuntime = {
    async execute(request) {
      requests.push(request);
      return ok({ output: await respond(request) });
    },
  };
  const runtime = createAgentRuntime(
    createAgentRuntimeSettings(configuration, role, codingRuntime),
  );
  return { runner: runnerOf(runtime), requests };
}

/**
 * Write one controlled invocation's Markdown report to the path its assembled prompt or supplied
 * context assigns. Callers compose the minimal outcome their role returns; this proves the agent
 * writes the assigned report instead of returning narrative in its response.
 */
export async function writeAssignedReport(
  contextOrPrompt: string,
  markdown: string,
): Promise<string> {
  const match = /^Assigned Markdown report: (.+)$/m.exec(contextOrPrompt);
  if (match === null) {
    throw new Error('The invocation assigns no Markdown report path.');
  }
  const file = match[1]!.trim();
  await writeFile(file, markdown, 'utf8');
  return file;
}
