import path from 'node:path';
import type {
  JiraAdapter,
  JiraComment,
  JiraDocument,
  JiraTransition,
} from '../../../adapters/jira.js';
import { fault, ok, type Result } from '../../../result.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import { briefArtifact, type Brief } from '../brief-writer/artifacts.js';
import { cycleCouncilReports, publishIdeaOutcome } from '../idea-context.js';
import {
  ideaCycleDirectory,
  ideaSubmissionInputFile,
  ideaSubmissionArtifactFile,
  latestCycleArtifact,
  readCycleArtifact,
  readIdeaPlan,
  readSubmissionArtifact,
  writeSubmissionArtifact,
} from '../idea-storage.js';
import { purposeArtifact } from '../purpose-verifier/artifacts.js';
import { researchArtifact } from '../researcher/artifacts.js';
import {
  councilArtifacts,
  strongestVerdict,
  type CouncilReport,
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
 * the approved brief, moves the item to its configured approved state and leaves one handoff
 * artifact with references to the captured idea, brief, purpose assessment, research and council
 * decisions. A return publishes concise human-facing feedback and moves the item to its configured
 * waiting-for-feedback state; internal council feedback stays in the cycle's artifacts. Publication
 * uses the captured selection snapshot without reading the issue or its conversation again.
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

/** One bullet list's lines, or a line stating that the list is empty. */
function bullets(label: string, items: readonly string[]): string[] {
  return items.length === 0
    ? [`${label}: none recorded.`]
    : [`${label}:`, ...items.map((item) => `- ${item}`)];
}

/** The approved brief as the human-facing comment the Requirements and Design workflow reads. */
function approvedComment(brief: Brief): string {
  return [
    `Approved idea brief (revision ${String(brief.revision)})`,
    '',
    `Problem: ${brief.problem}`,
    `Expected value: ${brief.value}`,
    `Project fit: ${brief.projectFit}`,
    '',
    ...bullets('Supporting evidence', brief.evidence),
    ...bullets('Existing alternatives', brief.alternatives),
    '',
    `Smallest useful scope: ${brief.scope}`,
    ...bullets('Assumptions', brief.assumptions),
  ].join('\n');
}

/** The human-facing reason and requested action of one returned idea. */
function returnedComment(
  strongest: CouncilReport,
  reason: string,
  submittedStatus: string,
): string {
  return [
    'This idea cannot move forward as submitted.',
    '',
    `Reason: ${reason}`,
    strongest.summary,
    '',
    'Requested changes:',
    ...strongest.findings.map(
      (finding) => `- ${finding.criterion}: ${finding.correction} (evidence: ${finding.evidence})`,
    ),
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
    const brief = await readCycleArtifact(cycleRoot, briefArtifact);
    if (brief === null) {
      throw new Error(
        `No brief revision exists for submission ${String(plan.submission)} cycle ` +
          `${String(plan.cycle)}; the decision needs the reviewed brief.`,
      );
    }
    const briefFile = path.join(cycleRoot, briefArtifact.pathFromArtifactsRoot);
    const terminal: IdeaTerminal = decision === 'approved' ? 'approved' : 'waiting-for-feedback';

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

    const existing = await readSubmissionArtifact(root, plan.submission, decisionArtifact);
    if (existing !== null) {
      if (existing.decision !== decision) {
        throw new Error(
          `Submission ${String(plan.submission)} cycle ${String(plan.cycle)} already recorded the ` +
            `"${existing.decision}" decision; it cannot also record "${decision}".`,
        );
      }
      // The route's work is already saved; a repeated invocation reuses its record.
      return reported(
        existing,
        ideaSubmissionArtifactFile(root, plan.submission, decisionArtifact),
      );
    }

    const reports = await cycleCouncilReports(root, plan);
    for (const report of reports) {
      if (report.brief !== briefFile || report.revision !== brief.revision) {
        throw new Error(
          `The ${report.reviewer} council result names brief "${report.brief}" revision ` +
            `${String(report.revision)}, not the current "${briefFile}" revision ` +
            `${String(brief.revision)}.`,
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
    const text =
      decision === 'approved'
        ? approvedComment(brief)
        : returnedComment(
            strongestReport,
            decision === 'returned-to-author'
              ? 'A council reviewer found that an internal revision is unlikely to make this ' +
                  'idea worthwhile.'
              : 'The idea did not converge within the configured council cycles.',
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
      brief: briefFile,
      revision: brief.revision,
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
      const references = await reportReferences(root, plan.submission, plan.cycle);
      const handoff: IdeaHandoff = {
        issue: { id: selection.source.issueId, key: selection.taskKey },
        issueWorkspace: selection.issueWorkspace.root,
        capturedInput: ideaSubmissionInputFile(root, plan.submission),
        brief: briefFile,
        purpose: references.purpose,
        research: references.research,
        council: {
          purpose: path.join(cycleRoot, councilArtifacts.purpose.pathFromArtifactsRoot),
          evidence: path.join(cycleRoot, councilArtifacts.evidence.pathFromArtifactsRoot),
          simplicity: path.join(cycleRoot, councilArtifacts.simplicity.pathFromArtifactsRoot),
        },
        decision: file,
      };
      await writeRecord(path.join(root, ideaHandoffFile), handoff);
    }
    return reported(record, file);
  };
}
