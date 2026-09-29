import path from 'node:path';
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
  readCycleArtifact,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import { editorHelpArtifact } from '../idea-editor/artifacts.js';
import {
  researchArtifact,
  researchFollowUpArtifact,
  researchResponseSchema,
  type ResearchContribution,
} from './artifacts.js';

/**
 * Researcher runs the research role. The cycle's initial enrichment works from the captured idea,
 * the retained history, the prepared project worktree and its configured web tools; a focused
 * follow-up answers the specific question the editor asked, without repeating the investigation.
 * The contribution is short, its findings and sources stay in the artifact, and a follow-up to
 * the other contributor's question is not requested of this role.
 */

export type ResearcherSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The research role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** The contribution phase the workflow supplied with the invocation. */
type ResearchPhase = 'initial' | 'focused';

/** The phase the workflow supplied with the invocation. */
function phaseOf(input: unknown): ResearchPhase {
  const phase =
    typeof input === 'object' && input !== null
      ? (input as { readonly phase?: unknown }).phase
      : undefined;
  if (phase === 'initial' || phase === 'focused') {
    return phase;
  }
  throw new Error(
    `The idea workflow supplied Researcher the unknown phase ${JSON.stringify(phase)}.`,
  );
}

/** Create Researcher over the refinement area it contributes to. */
export function createResearcher(settings: ResearcherSettings): BoundAction {
  /** Publish a saved contribution and return its workflow outcome. */
  function contributed(
    taskKey: string,
    cycle: number,
    sources: number,
    artifact: string,
  ): 'contributed' {
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'researcher',
      taskKey,
      cycle,
      outcome: 'contributed',
      detail: `${String(sources)} source${sources === 1 ? '' : 's'}`,
      artifact,
    });
    return 'contributed';
  }

  return async (input?: unknown) => {
    const phase = phaseOf(input);
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const artifact = phase === 'initial' ? researchArtifact : researchFollowUpArtifact;
    const inputRecord = await readIdeaInput(root, plan.submission);
    const file = path.join(cycleRoot, artifact.pathFromArtifactsRoot);

    let question: string | null = null;
    if (phase === 'focused') {
      const help = await readCycleArtifact(cycleRoot, editorHelpArtifact);
      if (help === null || help.disposition !== 'help-requested') {
        throw new Error(
          `A focused research contribution answers an editor help request; submission ` +
            `${String(plan.submission)} cycle ${String(plan.cycle)} has none.`,
        );
      }
      question = help.help?.researcher ?? null;
      if (question === null) {
        // The editor asked the Project guide only; this role contributes nothing.
        return 'not-requested';
      }
    }

    const existing = await readCycleArtifact(cycleRoot, artifact);
    if (existing !== null) {
      return contributed(inputRecord.taskKey, plan.cycle, existing.sources.length, file);
    }

    const guidance = await projectGuidanceText(root);
    const context = [
      question === null
        ? 'Enrich the stated idea\u2019s proposed change, why it matters and the principle behind ' +
          'it with sourced knowledge, examples and conceptual possibilities that give it substance.'
        : `Answer this focused question from the editor, without repeating the investigation:\n` +
          question,
      await capturedIdeaText(root, plan, inputRecord),
      // The Project guide contributes concurrently; its pending contribution is not this role's.
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: 'project-guide' }),
      'Use the prepared worktree, project knowledge, existing work and your configured web tools.',
      'Keep suggestions and options at idea level: strengthen the author\u2019s proposal without',
      'replacing it with another idea, and produce no implementation plan or draft configuration.',
      'Give links and access dates for external sources and keep source facts distinct from your',
      'own suggestions. Do not scrutinize or reject the idea and do not select an architecture.',
      'Give the editor a short contribution with the most useful discoveries; keep the detail in',
      'this report.',
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(researchResponseSchema),
    ].join('\n\n');

    const response = await invokeIdeaRole({
      root,
      plan,
      role: 'researcher',
      operation: 'Researcher',
      input: inputRecord,
      context,
      schema: researchResponseSchema,
      runner: settings.runner,
      publish: settings.publish,
    });
    const stored: ResearchContribution = {
      ...response,
      role: 'researcher',
      question,
    };
    await writeCycleArtifact(cycleRoot, artifact, stored);
    return contributed(inputRecord.taskKey, plan.cycle, response.sources.length, file);
  };
}
