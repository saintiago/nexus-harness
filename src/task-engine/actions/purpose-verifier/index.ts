import type { AgentRuntime } from '../../../agent-runtime/index.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import {
  capturedIdeaText,
  invokeIdeaRole,
  projectGuidanceText,
  publishIdeaOutcome,
  responseFormatText,
  retainedHistoryText,
} from '../idea-context.js';
import {
  ideaCycleDirectory,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import { purposeArtifact, purposeReportSchema } from './artifacts.js';

/**
 * PurposeVerifier runs the purpose role for the open council cycle and saves its assessment. The
 * agent discovers the project's purpose documents in the prepared worktree and infers direction
 * from code and commits when they are absent or incomplete; the action binds the report to the
 * cycle's declared artifact.
 */

export type PurposeVerifierSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  readonly runtime: AgentRuntime;
  readonly publish: EventPublisher;
};

/** Create PurposeVerifier over the refinement area it reports into. */
export function createPurposeVerifier(settings: PurposeVerifierSettings): BoundAction {
  return async () => {
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const input = await readIdeaInput(root, plan.submission);
    const guidance = await projectGuidanceText(root);
    const context = [
      'Assess the current captured idea against this project\u2019s enduring purpose.',
      capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { reviewer: null }),
      'Search the supplied worktree for the project\u2019s purpose, charter and long-term vision.',
      'When those documents are absent or incomplete, infer direction from its code and commit',
      'history, label inferred claims as provisional and state the uncertainty that remains.',
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(purposeReportSchema),
    ].join('\n\n');

    const report = await invokeIdeaRole({
      root,
      plan,
      role: 'purpose-verifier',
      operation: 'PurposeVerifier',
      taskKey: input.taskKey,
      context,
      schema: purposeReportSchema,
      runtime: settings.runtime,
      publish: settings.publish,
    });
    const file = await writeCycleArtifact(
      ideaCycleDirectory(root, plan.submission, plan.cycle),
      purposeArtifact,
      report,
    );
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'purpose-verifier',
      taskKey: input.taskKey,
      cycle: plan.cycle,
      outcome: 'reported',
      detail: report.provisional ? 'provisional project direction' : null,
      artifact: file,
    });
    return 'reported';
  };
}
