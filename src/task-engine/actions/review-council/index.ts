import path from 'node:path';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import { briefArtifact, readBriefRevision } from '../brief-writer/artifacts.js';
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
  councilArtifacts,
  councilResponseSchema,
  councilRoles,
  type CouncilReport,
  type CouncilReviewer,
  type CouncilVerdict,
} from './artifacts.js';

/**
 * One council reviewer runs its role against the exact current brief revision and saves exactly
 * one verdict with the criterion, evidence and correction of every objection. The three reviewers
 * run independently: each invocation omits the other reviewers' current-cycle results from its
 * context. A repeated invocation for the same brief revision reuses the result it already saved.
 */

/**
 * The one shared objection standard every council invocation carries. It adds no output field and
 * no route. It keeps objections on the idea as the author proposed it and keeps unresolved design
 * choices out of the verdict unless they change the idea-stage decision; the remaining choices
 * belong to Requirements and Design.
 */
export const councilObjectionStandard = [
  'Before you object, ask how the objection improves the idea. An objection may sharpen, narrow',
  'or correct the idea as the author proposed it, name a genuine ambiguity in the stated idea, or',
  'show that it should not proceed (idea_not_working): preventing a bad idea is a real improvement.',
  'An objection never silently replaces the author\u2019s proposal with a different or more generic',
  'idea. Factual or design nitpicks that do not change the idea-stage outcome are not objections,',
  'incidental implementation detail the brief should not contain is not an objection, and the',
  'brief\u2019s length alone is never a fault. An unresolved design choice is a blocker only when it',
  'changes the idea-stage decision: whether the idea is worth developing, its purpose fit, value,',
  'evidence or smallest useful scope. Otherwise it belongs to Requirements and Design.',
].join('\n');

/** The operation name each reviewer's invocation boundary carries. */
export const councilOperations: Readonly<Record<CouncilReviewer, string>> = {
  purpose: 'PurposeCouncil',
  evidence: 'EvidenceCouncil',
  simplicity: 'SimplicityCouncil',
};

/** The review each reviewer focuses on, supplied as invocation context. */
const reviewFocus: Readonly<Record<CouncilReviewer, string>> = {
  purpose:
    'Check project fit, coherent value, evidence quality and fidelity to the stated idea; flag a ' +
    'genuine ambiguity in it rather than silently replacing the proposal.',
  evidence:
    'Check that the idea\u2019s need, value and fit are substantiated, alternatives are represented ' +
    'fairly, sources support the claims and uncertainty is explicit.',
  simplicity:
    'Check that the smallest useful scope is proposed, that nothing avoidable is promised and ' +
    'that design decisions are left to the next workflow.',
};

export type CouncilReviewerSettings = {
  /** The reviewer this invocation carries. */
  readonly reviewer: CouncilReviewer;
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The council role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** Create one council reviewer over the refinement area it reports into. */
export function createCouncilReviewer(settings: CouncilReviewerSettings): BoundAction {
  const operation = councilOperations[settings.reviewer];
  const artifact = councilArtifacts[settings.reviewer];

  /** Publish the result this reviewer saved or reused. */
  function report(verdict: CouncilVerdict, cycle: number, taskKey: string, file: string): void {
    publishIdeaOutcome({
      publish: settings.publish,
      source: operation,
      taskKey,
      cycle,
      outcome: verdict,
      detail: null,
      artifact: file,
    });
  }

  return async () => {
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const input = await readIdeaInput(root, plan.submission);
    const brief = await readBriefRevision(cycleRoot);
    if (brief === null) {
      throw new Error(
        `No brief revision exists for submission ${String(plan.submission)} cycle ` +
          `${String(plan.cycle)}; the council reviews a written brief.`,
      );
    }
    const briefFile = path.join(cycleRoot, briefArtifact.pathFromArtifactsRoot);
    const existing = await readCycleArtifact(cycleRoot, artifact);
    if (existing !== null && existing.brief === briefFile && existing.revision === brief.revision) {
      // This reviewer already answered for this exact revision; reuse the saved verdict.
      report(
        existing.verdict,
        plan.cycle,
        input.taskKey,
        path.join(cycleRoot, artifact.pathFromArtifactsRoot),
      );
      return existing.verdict;
    }

    const guidance = await projectGuidanceText(root);
    const context = [
      `Independently review brief revision ${String(brief.revision)} of the current captured idea.`,
      councilObjectionStandard,
      'Object only to material gaps that affect the idea-stage decision. Do not request',
      'implementation detail, file inventories, acceptance criteria or resolved design tradeoffs',
      'the brief should not contain, and do not fail it on word count or style. Keep your summary',
      'short, every correction actionable, and read the retained history selectively.',
      reviewFocus[settings.reviewer],
      capturedIdeaText(root, plan, input),
      `The exact brief revision you review: ${briefFile}\n` + JSON.stringify(brief, null, 2),
      'Submit your own verdict before considering any other result, and do not read the other',
      'reviewers\u2019 results for this cycle; they are pending until all three have answered.',
      await retainedHistoryText(root, plan, { reviewer: settings.reviewer }),
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(councilResponseSchema),
    ].join('\n\n');

    const response = await invokeIdeaRole({
      root,
      plan,
      role: councilRoles[settings.reviewer],
      operation,
      taskKey: input.taskKey,
      context,
      schema: councilResponseSchema,
      runner: settings.runner,
    });
    if (response.verdict === 'approve' && response.findings.length > 0) {
      throw new Error(
        `The ${settings.reviewer} council reviewer approved brief revision ` +
          `${String(brief.revision)} while naming unresolved findings.`,
      );
    }
    if (response.verdict !== 'approve' && response.findings.length === 0) {
      throw new Error(
        `The ${settings.reviewer} council reviewer chose "${response.verdict}" without naming a ` +
          'criterion, evidence and correction.',
      );
    }

    const result: CouncilReport = {
      reviewer: settings.reviewer,
      verdict: response.verdict,
      summary: response.summary,
      findings: response.findings,
      brief: briefFile,
      revision: brief.revision,
    };
    const file = await writeCycleArtifact(cycleRoot, artifact, result);
    publishIdeaOutcome({
      publish: settings.publish,
      source: operation,
      taskKey: input.taskKey,
      cycle: plan.cycle,
      outcome: result.verdict,
      detail: null,
      artifact: file,
    });
    return result.verdict;
  };
}
