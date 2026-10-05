import path from 'node:path';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import { editorHelpArtifact } from '../idea-editor/artifacts.js';
import {
  capturedIdeaText,
  finishRetainedIdeaCorrection,
  ideaReportContracts,
  invokeIdeaRole,
  projectGuidanceText,
  publishIdeaOutcome,
  readRetainedIdeaReport,
  responseFormatText,
  retainedHistoryText,
} from '../idea-context.js';
import {
  ideaCycleDirectory,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import {
  projectGuideArtifact,
  projectGuideFollowUpArtifact,
  projectGuideResponseSchema,
  type ProjectGuideContribution,
} from './artifacts.js';

/**
 * ProjectGuide runs the project guidance role. The cycle's initial contribution discovers the
 * project's purpose documents in the prepared worktree and infers direction from code and commits
 * when they are absent, explaining how the idea could fit and which real constraints matter; a
 * focused follow-up answers the specific question the editor asked. The complete assessment lives
 * in the invocation's Markdown report; the machine outcome is the completion the join consumes.
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
  function contributed(taskKey: string, cycle: number, artifact: string): 'contributed' {
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'project-guide',
      taskKey,
      cycle,
      outcome: 'contributed',
      detail: null,
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
    const reportName = phase === 'initial' ? 'project-guide' : 'project-guide-follow-up';
    const inputRecord = await readIdeaInput(root, plan.submission);
    const file = path.join(cycleRoot, artifact.pathFromArtifactsRoot);

    let question: string | null = null;
    if (phase === 'focused') {
      const help = await readRetainedIdeaReport({
        root,
        workId: inputRecord.taskKey,
        plan,
        cycleRoot,
        declaration: editorHelpArtifact,
        contract: ideaReportContracts.editorTurn,
        context:
          `ProjectGuide reading the editor help request of submission ` +
          `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${inputRecord.taskKey}.`,
      });
      if (help === null || help.value.disposition !== 'help-requested') {
        throw new Error(
          `A focused project guidance contribution answers an editor help request; submission ` +
            `${String(plan.submission)} cycle ${String(plan.cycle)} has none.`,
        );
      }
      question = help.value.help?.projectGuide ?? null;
      if (question === null) {
        // The editor asked the Researcher only; this role contributes nothing.
        return 'not-requested';
      }
    }

    const existing = await readRetainedIdeaReport({
      root,
      workId: inputRecord.taskKey,
      plan,
      cycleRoot,
      declaration: artifact,
      contract: ideaReportContracts.projectGuidance,
      context:
        `ProjectGuide reading its retained ${phase === 'initial' ? 'guidance' : 'focused'} ` +
        `contribution of submission ${String(plan.submission)} cycle ${String(plan.cycle)} ` +
        `for idea ${inputRecord.taskKey}.`,
    });
    if (existing !== null) {
      // The saved contribution already answers for the rejections its invocation was supplied;
      // an interrupted correction write finishes here without another invocation.
      await finishRetainedIdeaCorrection({
        root,
        workId: inputRecord.taskKey,
        contract: ideaReportContracts.projectGuidance,
        read: existing,
      });
      return contributed(inputRecord.taskKey, plan.cycle, file);
    }

    const guidance = await projectGuidanceText(root);
    const context = [
      question === null
        ? 'Assess how the current captured idea could fit this project\u2019s purpose and ' +
          'long-term direction, and give the editor a short contribution.'
        : `Answer this focused question from the editor, without repeating the investigation:\n` +
          question,
      'Write the complete guidance in this invocation\u2019s assigned Markdown report: the short',
      'contribution the editor reads, how the idea could fit, the smallest steering that would',
      'improve that fit, the real constraints, the documents, files and commits each material',
      'claim rests on, whether the direction is inferred provisionally, and any uncertainty. The',
      'editor reads that report directly.',
      await capturedIdeaText(root, plan, inputRecord),
      // The Researcher contributes concurrently; its pending contribution is not this role's.
      await retainedHistoryText(root, plan, {
        workId: inputRecord.taskKey,
        omitCurrentCycleOf: 'researcher',
      }),
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

    const outcome = await invokeIdeaRole({
      root,
      plan,
      role: 'project-guide',
      operation: 'ProjectGuide',
      reportKind: 'project-guidance',
      reportName,
      input: inputRecord,
      context,
      schema: projectGuideResponseSchema,
      runner: settings.runner,
    });
    const stored: ProjectGuideContribution = {
      taskKey: inputRecord.taskKey,
      role: 'project-guide',
      profile: outcome.profile,
      question,
      report: outcome.assignedReport,
      reportIdentity: outcome.reportFile.identity,
      invocationId: outcome.invocationId,
    };
    await writeCycleArtifact(cycleRoot, artifact, stored);
    await outcome.finishFeedback({ path: file }, stored);
    return contributed(inputRecord.taskKey, plan.cycle, file);
  };
}
