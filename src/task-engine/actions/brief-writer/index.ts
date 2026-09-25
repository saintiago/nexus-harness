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
  latestCycleArtifact,
  readCycleArtifact,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import { purposeArtifact } from '../purpose-verifier/artifacts.js';
import { researchArtifact } from '../researcher/artifacts.js';
import {
  councilArtifacts,
  councilReviewers,
  type CouncilReport,
} from '../review-council/artifacts.js';
import { briefArtifact, briefContentSchema, readBriefRevision, type Brief } from './artifacts.js';

/**
 * BriefWriter runs the writer role for the open council cycle and saves the revision the council
 * reviews. It works from the captured idea, the purpose assessment and research report in force
 * for the cycle, the preceding briefs and the preceding council objections. Each cycle writes one
 * revision: a rewritten brief is a new cycle's artifact, which leaves every earlier approval
 * behind. A repeated invocation in the same cycle reuses the revision it already wrote.
 */

export type BriefWriterSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The writer role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** The preceding cycle's complete council results, when that cycle produced all three. */
async function precedingCouncil(
  root: string,
  submission: number,
  cycle: number,
): Promise<CouncilReport[] | null> {
  if (cycle <= 1) {
    return null;
  }
  const cycleRoot = ideaCycleDirectory(root, submission, cycle - 1);
  const reports: CouncilReport[] = [];
  for (const reviewer of councilReviewers) {
    const report = await readCycleArtifact(cycleRoot, councilArtifacts[reviewer]);
    if (report === null) {
      return null;
    }
    reports.push(report);
  }
  return reports;
}

/**
 * The preceding objections as a compact list: each non-approving reviewer's verdict, short
 * summary and correction per criterion. The full reports stay at their artifact paths; the writer
 * prompt never copies them wholesale.
 */
function condensedObjections(reports: readonly CouncilReport[]): string {
  const lines = reports
    .filter((report) => report.verdict !== 'approve')
    .flatMap((report) => [
      `- ${report.reviewer} council (${report.verdict}) summary: ${report.summary}`,
      ...report.findings.map((finding) => `  - ${finding.criterion}: ${finding.correction}`),
    ]);
  return lines.length === 0 ? '- no unaddressed objection was recorded.' : lines.join('\n');
}

/** The latest brief written before the current cycle, when one exists. */
async function precedingBrief(
  root: string,
  submission: number,
  cycle: number,
): Promise<{ readonly cycle: number; readonly path: string; readonly value: Brief } | null> {
  for (let number = cycle - 1; number >= 1; number -= 1) {
    const cycleRoot = ideaCycleDirectory(root, submission, number);
    const value = await readBriefRevision(cycleRoot);
    if (value !== null) {
      return {
        cycle: number,
        value,
        path: path.join(cycleRoot, briefArtifact.pathFromArtifactsRoot),
      };
    }
  }
  return null;
}

/** Create BriefWriter over the refinement area it writes into. */
export function createBriefWriter(settings: BriefWriterSettings): BoundAction {
  return async () => {
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const existing = await readBriefRevision(cycleRoot);
    if (
      existing !== null &&
      existing.submission === plan.submission &&
      existing.cycle === plan.cycle
    ) {
      // The revision this cycle writes already exists; a repeated invocation reuses it.
      publishIdeaOutcome({
        publish: settings.publish,
        source: 'brief-writer',
        taskKey: (await readIdeaInput(root, plan.submission)).taskKey,
        cycle: plan.cycle,
        outcome: 'written',
        detail: `revision ${String(existing.revision)}`,
        artifact: path.join(cycleRoot, briefArtifact.pathFromArtifactsRoot),
      });
      return 'written';
    }

    const input = await readIdeaInput(root, plan.submission);
    const purpose = await latestCycleArtifact(root, plan.submission, plan.cycle, purposeArtifact);
    const research = await latestCycleArtifact(root, plan.submission, plan.cycle, researchArtifact);
    if (purpose === null || research === null) {
      throw new Error(
        `The brief writer needs the purpose assessment and research report of submission ` +
          `${String(plan.submission)}; one of them is missing before cycle ${String(plan.cycle)}.`,
      );
    }
    const earlier = await precedingBrief(root, plan.submission, plan.cycle);
    const objections = await precedingCouncil(root, plan.submission, plan.cycle);
    const guidance = await projectGuidanceText(root);
    const context = [
      `Write brief revision ${String(plan.cycle)} for the current captured idea.`,
      capturedIdeaText(root, plan, input),
      `Purpose assessment in force (cycle ${String(purpose.cycle)}): ` +
        `${purpose.path}\n${JSON.stringify(purpose.value, null, 2)}`,
      `Research report in force (cycle ${String(research.cycle)}): ` +
        `${research.path}\n${JSON.stringify(research.value, null, 2)}`,
      earlier === null
        ? 'No earlier brief revision exists for this submission.'
        : `Latest earlier brief revision (cycle ${String(earlier.cycle)}): ${earlier.path}\n` +
          'Its cumulative change summary (carry it forward and extend it): ' +
          earlier.value.changeSummary,
      objections === null
        ? 'No earlier council objections exist for this submission.'
        : 'Address each objection of the preceding council cycle explicitly. Full reports stay ' +
          `readable at their artifact paths if you need them:\n${condensedObjections(objections)}`,
      'Aim for a decision aid of about 300-500 words. State the improvement as one idea: the need,',
      'opportunity or desired outcome and why it may matter or fit the project, as coherent prose',
      'rather than separate problem, value and project-fit essays. The remaining fields carry the',
      'strongest supporting evidence, meaningful alternatives, smallest plausible scope and key',
      'uncertainty (state the key uncertainty in the assumptions list). Do not prescribe',
      'implementation, detailed requirements, command syntax, file or line inventories, schemas,',
      'component placement, acceptance criteria or resolution of design tradeoffs. Keep research',
      'detail in the research artifact and cite it selectively.',
      'The council reviews this revision for project fit, coherent value, fidelity to the',
      'author\u2019s intent, evidence quality, fairly represented alternatives, explicit',
      'uncertainty and the smallest useful scope.',
      await retainedHistoryText(root, plan, { reviewer: null }),
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(briefContentSchema),
    ].join('\n\n');

    const content = await invokeIdeaRole({
      root,
      plan,
      role: 'brief-writer',
      operation: 'BriefWriter',
      taskKey: input.taskKey,
      context,
      schema: briefContentSchema,
      runner: settings.runner,
    });
    const brief: Brief = {
      ...content,
      revision: plan.cycle,
      submission: plan.submission,
      cycle: plan.cycle,
    };
    const file = await writeCycleArtifact(cycleRoot, briefArtifact, brief);
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'brief-writer',
      taskKey: input.taskKey,
      cycle: plan.cycle,
      outcome: 'written',
      detail: `revision ${String(brief.revision)}`,
      artifact: file,
    });
    return 'written';
  };
}
