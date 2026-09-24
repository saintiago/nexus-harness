import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
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
import { researchArtifact, researchReportSchema } from './artifacts.js';

/**
 * Researcher runs the research role for the open council cycle and saves its enrichment report.
 * The agent works from the captured idea, the retained history and the prepared project worktree,
 * and may use its configured web tools; the action binds the report to the cycle's declared
 * artifact.
 */

export type ResearcherSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The research role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** Create Researcher over the refinement area it reports into. */
export function createResearcher(settings: ResearcherSettings): BoundAction {
  return async () => {
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const input = await readIdeaInput(root, plan.submission);
    const guidance = await projectGuidanceText(root);
    const context = [
      'Enrich the current captured idea with useful findings, options and sources.',
      capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { reviewer: null }),
      'Use the prepared worktree, project knowledge, existing work and your configured web tools.',
      'Give links and access dates for external sources and keep source facts distinct from your',
      'own suggestions. Do not scrutinize or reject the idea and do not select an architecture.',
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(researchReportSchema),
    ].join('\n\n');

    const report = await invokeIdeaRole({
      root,
      plan,
      role: 'researcher',
      operation: 'Researcher',
      taskKey: input.taskKey,
      context,
      schema: researchReportSchema,
      runner: settings.runner,
    });
    const file = await writeCycleArtifact(
      ideaCycleDirectory(root, plan.submission, plan.cycle),
      researchArtifact,
      report,
    );
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'researcher',
      taskKey: input.taskKey,
      cycle: plan.cycle,
      outcome: 'reported',
      detail: `${String(report.sources.length)} source${report.sources.length === 1 ? '' : 's'}`,
      artifact: file,
    });
    return 'reported';
  };
}
