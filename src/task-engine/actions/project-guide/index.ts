import path from 'node:path';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import { editorHelpArtifact } from '../idea-editor/artifacts.js';
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
import {
  projectGuideArtifact,
  projectGuideFollowUpArtifact,
  projectGuideResponseSchema,
} from './artifacts.js';

/**
 * ProjectGuide runs the project guidance role. The cycle's initial contribution discovers the
 * project's purpose documents in the prepared worktree and infers direction from code and commits
 * when they are absent, explaining how the idea could fit and which real constraints matter; a
 * focused follow-up answers the specific question the editor asked.
 */

export type ProjectGuideSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The guidance role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** The contribution phase the workflow supplied with the invocation. */
type GuidancePhase = 'initial' | 'focused';

/** The phase the workflow supplied with the invocation. */
function phaseOf(input: unknown): GuidancePhase {
  const phase =
    typeof input === 'object' && input !== null
      ? (input as { readonly phase?: unknown }).phase
      : undefined;
  if (phase === 'initial' || phase === 'focused') {
    return phase;
  }
  throw new Error(
    `The idea workflow supplied ProjectGuide the unknown phase ${JSON.stringify(phase)}.`,
  );
}

/** Create ProjectGuide over the refinement area it contributes to. */
export function createProjectGuide(settings: ProjectGuideSettings): BoundAction {
  /** Publish a saved contribution and return its workflow outcome. */
  function contributed(
    taskKey: string,
    cycle: number,
    provisional: boolean,
    artifact: string,
  ): 'contributed' {
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'project-guide',
      taskKey,
      cycle,
      outcome: 'contributed',
      detail: provisional ? 'provisional project direction' : null,
      artifact,
    });
    return 'contributed';
  }

  return async (input?: unknown) => {
    const phase = phaseOf(input);
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const artifact = phase === 'initial' ? projectGuideArtifact : projectGuideFollowUpArtifact;
    const inputRecord = await readIdeaInput(root, plan.submission);
    const file = path.join(cycleRoot, artifact.pathFromArtifactsRoot);

    let question: string | null = null;
    if (phase === 'focused') {
      const help = await readCycleArtifact(cycleRoot, editorHelpArtifact);
      if (help === null || help.disposition !== 'help-requested') {
        throw new Error(
          `A focused project guidance contribution answers an editor help request; submission ` +
            `${String(plan.submission)} cycle ${String(plan.cycle)} has none.`,
        );
      }
      question = help.help?.projectGuide ?? null;
      if (question === null) {
        // The editor asked the Researcher only; this role contributes nothing.
        return 'not-requested';
      }
    }

    const existing = await readCycleArtifact(cycleRoot, artifact);
    if (existing !== null) {
      return contributed(inputRecord.taskKey, plan.cycle, existing.provisional, file);
    }

    const guidance = await projectGuidanceText(root);
    const context = [
      question === null
        ? 'Assess how the current captured idea could fit this project\u2019s purpose and ' +
          'long-term direction, and give the editor a short contribution.'
        : `Answer this focused question from the editor, without repeating the investigation:\n` +
          question,
      await capturedIdeaText(root, plan, inputRecord),
      // The Researcher contributes concurrently; its pending contribution is not this role's.
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: 'researcher' }),
      'Find the project\u2019s purpose, charter and vision documents yourself in the supplied',
      'worktree. If they are absent or incomplete, infer direction from code and commits, label',
      'the inference as provisional and cite the evidence. Explain what existing capabilities',
      'help and which real constraints matter; distinguish enduring purpose from choices the',
      'idea proposes to change, and suggest the smallest steering that would improve fit.',
      'Missing documents alone are not a reason to block the idea. Do not design architecture,',
      'write requirements or ask the idea to settle design decisions.',
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(projectGuideResponseSchema),
    ].join('\n\n');

    const response = await invokeIdeaRole({
      root,
      plan,
      role: 'project-guide',
      operation: 'ProjectGuide',
      input: inputRecord,
      context,
      schema: projectGuideResponseSchema,
      runner: settings.runner,
    });
    await writeCycleArtifact(cycleRoot, artifact, {
      ...response,
      role: 'project-guide',
      question,
    });
    return contributed(inputRecord.taskKey, plan.cycle, response.provisional, file);
  };
}
