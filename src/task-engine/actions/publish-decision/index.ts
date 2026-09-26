import path from 'node:path';
import type {
  JiraAdapter,
  JiraComment,
  JiraDocument,
  JiraTransition,
} from '../../../adapters/jira.js';
import { fault, ok, type Result } from '../../../result.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import { readRefinedIdeaRevision, type RefinedIdea } from '../brief-writer/artifacts.js';
import { cycleCouncilReports, publishIdeaOutcome } from '../idea-context.js';
import {
  ideaCycleDirectory,
  ideaSubmissionInputFile,
  ideaSubmissionArtifactFile,
  latestCycleArtifact,
  readIdeaPlan,
  readSubmissionArtifact,
  writeSubmissionArtifact,
} from '../idea-storage.js';
import { purposeArtifact } from '../purpose-verifier/artifacts.js';
import { researchArtifact } from '../researcher/artifacts.js';
import {
  councilArtifacts,
  strongestVerdict,
  type CouncilFinding,
} from '../review-council/artifacts.js';
import { capturedTransition, publishDocument } from '../source.js';
import { writeRecord } from '../records.js';
import type { IdeaSelection } from '../select-idea/artifacts.js';
import {
  decisionArtifact,
  ideaDecisions,
  ideaHandoffFile,
  type IdeaDecision,
  type IdeaDecisionRecord,
  type IdeaHandoff,
} from './artifacts.js';

/**
 * PublishDecision applies one terminal route to the source and records it. An approval publishes
 * the approved refined idea, moves the item to its configured approved state and leaves one handoff
 * artifact with references to the captured idea, refined idea, purpose assessment, research and
 * council decisions. A return publishes concise human-facing feedback and moves the item to its
 * configured waiting-for-feedback state; internal council feedback stays in the cycle's artifacts.
 * Publication uses the captured selection snapshot without reading the issue or its conversation
 * again.
 */

export type PublishDecisionSettings = {
  /** The retained selection: the captured issue, transitions and shared workspace references. */
  readonly selection: IdeaSelection;
  /** The configured statuses the two terminal routes move the item into and name back to. */
  readonly statuses: {
    readonly submitted: string;
    readonly approved: string;
    readonly waitingForFeedback: string;
  };
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

/** The route one publication invocation carries. */
function decisionOf(input: unknown): IdeaDecision {
  const decision =
    typeof input === 'object' && input !== null
      ? (input as { readonly decision?: unknown }).decision
      : undefined;
  const found = ideaDecisions.find((candidate) => candidate === decision);
  if (found === undefined) {
    throw new Error(
      `The idea workflow supplied PublishDecision the unknown decision ${JSON.stringify(decision)}.`,
    );
  }
  return found;
}

/** The workflow outcome the two terminal decision routes declare. */
type IdeaTerminal = 'approved' | 'waiting-for-feedback';

/** One Jira document whose paragraphs are the supplied text's lines. */
function documentOf(text: string): JiraDocument {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split('\n')
      .map((line) =>
        line.trim() === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
  };
}

/**
 * The refined idea every human-facing comment reproduces: its stated parts, in order, with the
 * parts a retained revision never carried left out.
 */
function refinedIdeaSection(idea: RefinedIdea, heading: string): string[] {
  return [
    `${heading} (revision ${String(idea.revision)})`,
    '',
    `Idea: ${idea.idea}`,
    ...(idea.projectFit === null ? [] : ['', `Project fit: ${idea.projectFit}`]),
    ...(idea.feasibility === null ? [] : ['', `Feasibility: ${idea.feasibility}`]),
    ...(idea.openQuestions.length === 0
      ? []
      : ['', 'Open questions:', ...idea.openQuestions.map((question) => `- ${question}`)]),
  ];
}

/**
 * The approved refined idea as the human-facing comment the Requirements and Design workflow
 * reads, with the council history kept to the cycles used and the cumulative change summary.
 */
function approvedComment(idea: RefinedIdea): string {
  return [
    ...refinedIdeaSection(idea, 'Approved refined idea'),
    '',
    `Council cycles used: ${String(idea.cycle)}`,
    `What refinement changed: ${idea.changeSummary}`,
  ].join('\n');
}

/**
 * The human-facing comment for one returned idea: the plain outcome, the latest refined idea, the
 * cycles used with the cumulative change summary, and the actionable corrections that stopped
 * approval, followed by the single next step. Exhaustion is reported as exhaustion and a return
 * reports that the council did not approve; neither judges the idea's worth. Raw reviewer
 * summaries, verdict names, criteria, evidence, code citations and tool transcripts stay in the
 * artifacts.
 */
function returnedComment(
  idea: RefinedIdea,
  decision: IdeaDecision,
  findings: readonly CouncilFinding[],
  submittedStatus: string,
): string {
  const outcome =
    decision === 'unable-to-converge'
      ? `Attempts exhausted after ${String(idea.cycle)} ` +
        `${idea.cycle === 1 ? 'cycle' : 'cycles'}: the council did not approve this idea.`
      : 'Returned for feedback: the council did not approve this idea.';
  // Distinct corrections only: two reviewers requesting the same change are one request.
  const corrections = [...new Set(findings.map((finding) => finding.correction))];
  return [
    outcome,
    '',
    ...refinedIdeaSection(idea, 'Latest refined idea'),
    '',
    `Council cycles used: ${String(idea.cycle)}`,
    `What refinement changed: ${idea.changeSummary}`,
    ...(corrections.length === 0
      ? []
      : ['', 'What stopped approval:', ...corrections.map((correction) => `- ${correction}`)]),
    '',
    'Please reply with your feedback or a revised idea in a Jira comment, then move the item ' +
      `back to "${submittedStatus}" to resubmit it.`,
  ].join('\n');
}

/** The permitted captured transition moving the item into the named status. */
function transitionInto(selection: IdeaSelection, status: string): Result<JiraTransition> {
  for (const value of selection.transitions.fromActive) {
    const transition = capturedTransition(value);
    if (transition !== null && transition.to.name === status) {
      return ok(transition);
    }
  }
  return fault(
    `The selection captured for ${selection.taskKey} holds no transition into "${status}".`,
  );
}

/** The captured conversation as provider comments. */
function capturedComments(selection: IdeaSelection): JiraComment[] {
  return selection.conversation.flatMap((value) =>
    typeof value === 'object' && value !== null && typeof (value as JiraComment).id === 'string'
      ? [value as JiraComment]
      : [],
  );
}

/** The sources of the purpose assessment and research report a handoff references. */
async function reportReferences(
  root: string,
  submission: number,
  cycle: number,
): Promise<{ readonly purpose: string; readonly research: string }> {
  const purpose = await latestCycleArtifact(root, submission, cycle, purposeArtifact);
  const research = await latestCycleArtifact(root, submission, cycle, researchArtifact);
  if (purpose === null || research === null) {
    throw new Error(
      `Submission ${String(submission)} has no purpose assessment or research report to hand off.`,
    );
  }
  return { purpose: purpose.path, research: research.path };
}

/** Create PublishDecision over the retained selection and source it updates. */
export function createPublishDecision(settings: PublishDecisionSettings): BoundAction {
  const { selection, jira, publish } = settings;
  const root = selection.workspace.root;

  return async (input?: unknown) => {
    const decision = decisionOf(input);
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const refinedIdea = await readRefinedIdeaRevision(cycleRoot);
    if (refinedIdea === null) {
      throw new Error(
        `No refined idea revision exists for submission ${String(plan.submission)} cycle ` +
          `${String(plan.cycle)}; the decision needs the reviewed refined idea.`,
      );
    }
    const refinedIdeaFile = refinedIdea.path;
    const terminal: IdeaTerminal = decision === 'approved' ? 'approved' : 'waiting-for-feedback';
    const decisionFile = ideaSubmissionArtifactFile(root, plan.submission, decisionArtifact);

    /** Publish the outcome of the decision and its saved record. */
    function reported(record: IdeaDecisionRecord, file: string): IdeaTerminal {
      publishIdeaOutcome({
        publish,
        source: 'publish-decision',
        taskKey: selection.taskKey,
        cycle: plan.cycle,
        outcome: terminal,
        detail: record.decision,
        artifact: file,
      });
      return terminal;
    }

    /**
     * Write the approval's handoff for the reviewed refined idea revision. The handoff is a required
     * output of the approved route: a repeated invocation that finds the decision already saved
     * establishes it before reporting the same outcome.
     */
    async function writeHandoff(): Promise<void> {
      const references = await reportReferences(root, plan.submission, plan.cycle);
      const handoff: IdeaHandoff = {
        issue: { id: selection.source.issueId, key: selection.taskKey },
        issueWorkspace: selection.issueWorkspace.root,
        capturedInput: ideaSubmissionInputFile(root, plan.submission),
        brief: refinedIdeaFile,
        purpose: references.purpose,
        research: references.research,
        council: {
          purpose: path.join(cycleRoot, councilArtifacts.purpose.pathFromArtifactsRoot),
          evidence: path.join(cycleRoot, councilArtifacts.evidence.pathFromArtifactsRoot),
          simplicity: path.join(cycleRoot, councilArtifacts.simplicity.pathFromArtifactsRoot),
        },
        decision: decisionFile,
      };
      await writeRecord(path.join(root, ideaHandoffFile), handoff);
    }

    const existing = await readSubmissionArtifact(root, plan.submission, decisionArtifact);
    if (existing !== null) {
      if (existing.decision !== decision) {
        throw new Error(
          `Submission ${String(plan.submission)} cycle ${String(plan.cycle)} already recorded the ` +
            `"${existing.decision}" decision; it cannot also record "${decision}".`,
        );
      }
      // The route's source updates are already saved; a repeated invocation completes any
      // outstanding required output and reuses the record.
      if (decision === 'approved') {
        await writeHandoff();
      }
      return reported(existing, decisionFile);
    }

    const reports = await cycleCouncilReports(root, plan);
    for (const report of reports) {
      if (report.brief !== refinedIdeaFile || report.revision !== refinedIdea.value.revision) {
        throw new Error(
          `The ${report.reviewer} council result names refined idea "${report.brief}" revision ` +
            `${String(report.revision)}, not the current "${refinedIdeaFile}" revision ` +
            `${String(refinedIdea.value.revision)}.`,
        );
      }
    }
    const verdicts = reports.map((report) => report.verdict);
    const approved = verdicts.every((verdict) => verdict === 'approve');
    const unworkable = verdicts.includes('idea_not_working');
    if (decision === 'approved' && !approved) {
      throw new Error('Approval requires every council reviewer to approve the current revision.');
    }
    if (decision === 'returned-to-author' && !unworkable) {
      throw new Error(
        'Returning the idea to its author requires an "idea_not_working" council verdict.',
      );
    }
    if (decision === 'unable-to-converge' && approved) {
      throw new Error('A unanimously approved revision cannot be reported as unable to converge.');
    }
    const strongest = strongestVerdict(verdicts);
    const strongestReport = reports.find((report) => report.verdict === strongest) ?? reports[0];
    if (strongestReport === undefined) {
      throw new Error('The council produced no result to report.');
    }

    const targetStatus =
      decision === 'approved' ? settings.statuses.approved : settings.statuses.waitingForFeedback;
    // An exhausted return publishes every non-approving reviewer's material correction; an
    // unworkable verdict publishes the corrections of the strongest reviewer.
    const blockingFindings =
      decision === 'unable-to-converge'
        ? reports
            .filter((report) => report.verdict !== 'approve')
            .flatMap((report) => report.findings)
        : strongestReport.findings;
    const text =
      decision === 'approved'
        ? approvedComment(refinedIdea.value)
        : returnedComment(
            refinedIdea.value,
            decision,
            blockingFindings,
            settings.statuses.submitted,
          );
    const comment = await publishDocument(
      jira,
      selection.source.issueId,
      capturedComments(selection),
      documentOf(text),
    );

    const transition = transitionInto(selection, targetStatus);
    if (!transition.ok) {
      throw new Error(transition.fault.message);
    }
    const applied = await jira.transitionIssue(selection.source.issueId, transition.value.id);
    if (!applied.ok) {
      throw new Error(applied.fault.message);
    }

    const record: IdeaDecisionRecord = {
      decision,
      strongestVerdict: strongest,
      brief: refinedIdeaFile,
      revision: refinedIdea.value.revision,
      feedback: reports,
      comment: text,
      source: {
        transition: { id: transition.value.id, to: targetStatus },
        status: targetStatus,
        commentId: typeof comment.id === 'string' ? comment.id : null,
      },
    };
    const file = await writeSubmissionArtifact(root, plan.submission, decisionArtifact, record);
    if (decision === 'approved') {
      await writeHandoff();
    }
    return reported(record, file);
  };
}
