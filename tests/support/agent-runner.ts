/**
 * Test support: adapt a controlled AgentRuntime to the agent runner an action consumes. The real
 * runner — created by Application's action binding — assigns each invocation's identity and
 * transports its attributable activity; action-scoped tests exercise the action's own behavior
 * with this adapter, while Application's composition and the system journeys cover the real one.
 */

import type { AgentRuntime } from '../../src/agent-runtime/index.js';
import type { AgentRoleRunner } from '../../src/task-engine/index.js';

/** One controlled runtime as the role runner of the action under test. */
export function runnerOf(runtime: AgentRuntime): AgentRoleRunner {
  return {
    run: (request) =>
      runtime.run(request.profile, request.workspace, request.context, () => undefined),
  };
}
