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
import {
  readRefinedIdeaRevision,
  refinedIdeaArtifact,
  refinedIdeaContentSchema,
  type RefinedIdea,
} from './artifacts.js';

/**
 * BriefWriter runs the writer role for the open council cycle and saves the refined idea revision
 * the council reviews. It works from the captured idea, the purpose assessment and research report
 * in force for the cycle, the preceding refined ideas and the preceding council objections. Each
 * cycle writes one revision: a rewritten refined idea is a new cycle's artifact, which leaves
 * every earlier approval behind. A repeated invocation in the same cycle reuses the revision it
 * already wrote.
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

/** The latest refined idea written before the current cycle, when one exists. */
async function precedingRefinedIdea(
  root: string,
  submission: number,
  cycle: number,
): Promise<{ readonly cycle: number; readonly path: string; readonly value: RefinedIdea } | null> {
  for (let number = cycle - 1; number >= 1; number -= 1) {
    const read = await readRefinedIdeaRevision(ideaCycleDirectory(root, submission, number));
    if (read !== null) {
      return { cycle: number, path: read.path, value: read.value };
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
    const existing = await readRefinedIdeaRevision(cycleRoot);
    if (
      existing !== null &&
      existing.value.submission === plan.submission &&
      existing.value.cycle === plan.cycle
    ) {
      // The revision this cycle writes already exists; a repeated invocation reuses it.
      publishIdeaOutcome({
        publish: settings.publish,
        source: 'brief-writer',
        taskKey: (await readIdeaInput(root, plan.submission)).taskKey,
        cycle: plan.cycle,
        outcome: 'written',
        detail: `revision ${String(existing.value.revision)}`,
        artifact: existing.path,
      });
      return 'written';
    }

    const input = await readIdeaInput(root, plan.submission);
    const purpose = await latestCycleArtifact(root, plan.submission, plan.cycle, purposeArtifact);
    const research = await latestCycleArtifact(root, plan.submission, plan.cycle, researchArtifact);
    if (purpose === null || research === null) {
      throw new Error(
        `The refined idea writer needs the purpose assessment and research report of submission ` +
          `${String(plan.submission)}; one of them is missing before cycle ${String(plan.cycle)}.`,
      );
    }
    const earlier = await precedingRefinedIdea(root, plan.submission, plan.cycle);
    const objections = await precedingCouncil(root, plan.submission, plan.cycle);
    const guidance = await projectGuidanceText(root);
    const context = [
      `Write refined idea revision ${String(plan.cycle)} for the current captured idea.`,
      capturedIdeaText(root, plan, input),
      `Purpose assessment in force (cycle ${String(purpose.cycle)}): ` +
        `${purpose.path}\n${JSON.stringify(purpose.value, null, 2)}`,
      `Research report in force (cycle ${String(research.cycle)}): ` +
        `${research.path}\n${JSON.stringify(research.value, null, 2)}`,
      earlier === null
        ? 'No earlier refined idea revision exists for this submission.'
        : `Latest earlier refined idea (cycle ${String(earlier.cycle)}): ${earlier.path}\n` +
          'Its cumulative change summary (carry it forward and extend it): ' +
          earlier.value.changeSummary,
      objections === null
        ? 'No earlier council objections exist for this submission.'
        : 'Address each objection of the preceding council cycle explicitly. Full reports stay ' +
          `readable at their artifact paths if you need them:\n${condensedObjections(objections)}`,
      'Keep the refined idea short by default: about 150-200 words across all four parts, with',
      'only material detail and plain, direct language. Give each part one to three short',
      'sentences and keep open questions to at most a few. That length is a default, not a rigid',
      'cap: keep any context the council needs to decide. Work on the author\u2019s idea as',
      'submitted and keep its proposed concept and direction rather than replacing it with a',
      'different or more generic idea. State the refined idea in clear parts: `idea` states the',
      'desirable change, why it matters and the principle behind it, without committing to',
      'implementation; `projectFit` states why it belongs in this project; `feasibility` states',
      'a plausible path given the known constraints and evidence, not a design or implementation',
      'plan; and `openQuestions` lists only the material questions the next workflow must answer,',
      'omitting them when there are none. Keep detailed research in the research artifact and',
      'cite it selectively; the refined idea stays concise and on point. Do not prescribe',
      'implementation or settle design decisions: no mechanism selection, detailed requirements,',
      'command syntax, file or line inventories, schemas, component placement, acceptance',
      'criteria or resolution of design tradeoffs. Keep council history out of the idea\u2019s',
      'parts; changeSummary is the cumulative account of what refinement changed. The council',
      'reviews this revision for project fit, coherent value, fidelity to the author\u2019s',
      'intent, evidence quality, fairly represented alternatives and the smallest useful scope.',
      await retainedHistoryText(root, plan, { reviewer: null }),
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(refinedIdeaContentSchema),
    ].join('\n\n');

    const content = await invokeIdeaRole({
      root,
      plan,
      role: 'brief-writer',
      operation: 'BriefWriter',
      taskKey: input.taskKey,
      context,
      schema: refinedIdeaContentSchema,
      runner: settings.runner,
    });
    const refinedIdea = {
      ...content,
      revision: plan.cycle,
      submission: plan.submission,
      cycle: plan.cycle,
    };
    const file = await writeCycleArtifact(cycleRoot, refinedIdeaArtifact, refinedIdea);
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'brief-writer',
      taskKey: input.taskKey,
      cycle: plan.cycle,
      outcome: 'written',
      detail: `revision ${String(refinedIdea.revision)}`,
      artifact: file,
    });
    return 'written';
  };
}
