import { createAgentRuntime } from '../agent-runtime/index.js';
import { createCodingRuntime } from '../adapters/coding-runtime.js';
import { createNotificationsAdapter } from '../adapters/notifications.js';
import {
  createAgentRuntimeSettings,
  createNotificationSettings,
  recoveryEnvironment,
} from './composition.js';
import type { RecoveryRuntime, RecoveryRuntimeConstruction } from './recovery.js';

/**
 * The parent-side recovery wiring: the configured recovery AgentRuntime over the coding provider,
 * and the Notifications adapter Application publishes saved reports through. The recovery agent
 * runs with the current project's Jira credential, the provider's settings and the operator's Git
 * and gh CLI configuration, and without the Nexus Lens or notification credentials it does not
 * use. Credential values stay in host settings and never enter the recovery context.
 */
export function createRecoveryRuntime(settings: RecoveryRuntimeConstruction): RecoveryRuntime {
  const { nexus, environment } = settings;
  const codingRuntime = createCodingRuntime({
    executable: nexus.agentRuntime.provider.executable,
    environment: recoveryEnvironment(nexus, environment),
  });
  return {
    async invoke(request) {
      // AgentRuntime keeps no state between invocations; each invocation supplies its own
      // activity observer, so recovery activity stays attributable to its invocation.
      const runtime = createAgentRuntime(
        createAgentRuntimeSettings(nexus, 'recovery', codingRuntime),
      );
      return runtime.run(
        nexus.executionPolicy.recoveryProfile,
        request.workspace,
        request.context,
        request.onActivity,
      );
    },
    async notify(subject, body) {
      return createNotificationsAdapter(createNotificationSettings(nexus, environment)).publish(
        subject,
        body,
      );
    },
  };
}
