import type { ProjectConfiguration } from '../configuration/index.js';
import type { ExecutionPaths } from './composition.js';
import type { ExecutionRequest } from './index.js';

/**
 * The explicit failure boundary between work execution and recovery.
 *
 * Recovery integration is a separate pending task (docs/tasks/recovery.md). That task owns the
 * recovery AgentRuntime and Notifications adapter, the RecoveryReport, the configured allowance and
 * worker restarts. This boundary is where Application hands over a stopped execution and receives
 * the summary to report; the deferred implementation below stops every failed work invocation with
 * needs-attention, so an unimplemented recovery is never reported as a successful resume. Recovery
 * stays within the supplied project: cross-project repair and Nexus installation changes require
 * operator attention.
 */

/** The task workspace reference from the Workspace design, when a selection was readable. */
export type TaskWorkspaceRef = { readonly root: string };

/** What Application hands the recovery invocation when a work invocation cannot continue. */
export type RecoveryContext = {
  /** The original execution request. */
  readonly request: ExecutionRequest;
  /** The current project configuration recovery investigates and repairs within. */
  readonly project: ProjectConfiguration;
  /** Why execution stopped: the blocked outcome, fault, protocol or exit failure. */
  readonly failure: string;
  /** The queue execution state and record paths recovery reconciles. */
  readonly execution: ExecutionPaths;
  /** The task workspace the stopped execution retained, when known. */
  readonly workspace: TaskWorkspaceRef | null;
  /** The diagnostics the stopped worker wrote, when it ran. */
  readonly output: string;
};

/** What the recovery invocation reports back to Application. */
export type RecoveryStop = {
  readonly summary: string;
};

/** One recovery invocation of a stopped execution. */
export type RecoveryInvocation = (context: RecoveryContext) => Promise<RecoveryStop>;

/** The deferred recovery boundary: stop for operator attention without claiming a recovery. */
export const recoveryPending: RecoveryInvocation = async () => ({
  summary:
    'Recovery integration is not implemented yet, so this execution stopped needing operator ' +
    'attention.',
});
