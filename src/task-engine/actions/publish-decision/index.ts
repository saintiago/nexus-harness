import path from 'node:path';
import type { JiraAdapter, JiraDocument } from '../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import { challengerArtifact, type ChallengerReport } from '../challenger/artifacts.js';
import {
  editorResponseArtifact,
  framingArtifact,
  type FramingResponse,
  type RefinedIdea,
} from '../idea-editor/artifacts.js';
import { publishIdeaOutcome } from '../idea-context.js';
import {
  ideaCycleDirectory,
  ideaSubmissionArtifactFile,
  ideaSubmissionInputFile,
  latestRefinedIdea,
  readCycleArtifact,
  readIdeaPlan,
  readSubmissionArtifact,
  writeSubmissionArtifact,
} from '../idea-storage.js';
import { projectGuideArtifact, projectGuideFollowUpArtifact } from '../project-guide/artifacts.js';
import { readRequiredRecord, writeRecord } from '../records.js';
import { researchArtifact, researchFollowUpArtifact } from '../researcher/artifacts.js';
import type { IdeaInput } from '../select-idea/artifacts.js';
import { selectionDeclaration, type Selection } from '../select-task/artifacts.js';
import {
  applyTransition,
  publishDocument,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
} from '../source.js';
import {
  decisionArtifact,
  ideaDecisions,
  ideaHandoffFile,
  type IdeaDecision,
  type IdeaDecisionRecord,
  type IdeaHandoff,
} from './artifacts.js';

/**
 * RecordIdeaDecision composes and records the child's terminal decision without any source
 * capability: the approval or return, the exact refined idea revision and editor turn it observed,
 * the human-facing comment text and the handoff an approval leaves. PublishDecision is the
 * parent-owned publication that reads the recorded decision and applies it to the source.
 */

export type RecordIdeaDecisionSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured submitted status a returned idea names in its next step. */
  readonly submittedStatus: string;
  readonly publish: EventPublisher;
};

export type PublishDecisionSettings = {
  /** The retained selection identity the parent publishes for. */
  readonly selection: Selection;
  /** The refinement area holding the recorded decision. */
  readonly refinementRoot: string;
  /** The configured statuses the terminal routes move the item into. */
  readonly statuses: {
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

/** The workflow outcome the terminal decision routes declare. */
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

/** The captured idea's summary, or null when the captured issue does not carry one. */
function capturedSummary(input: IdeaInput): string | null {
  const issue = input.issue;
  const fields =
    typeof issue === 'object' && issue !== null
      ? (issue as { readonly fields?: unknown }).fields
      : undefined;
  const summary =
    typeof fields === 'object' && fields !== null
      ? (fields as { readonly summary?: unknown }).summary
      : undefined;
  return typeof summary === 'string' && summary.trim() !== '' ? summary : null;
}

/**
 * The idea a return presents when no refined idea revision exists yet: the captured idea and the
 * editor's framing of it, as the specification directs.
 */
function capturedIdeaSection(input: IdeaInput, framing: FramingResponse | null): string[] {
  const summary = capturedSummary(input);
  return [
    'Captured idea (no refined idea revision yet)',
    '',
    ...(summary === null ? [input.taskKey] : [summary]),
    ...(framing === null ? [] : ['', 'The editor\u2019s framing of it:', framing.framing]),
  ];
}

/**
 * The approved refined idea as the human-facing comment the Requirements and Design workflow
 * reads, with the conversation history kept to the cycles used and the cumulative change summary.
 */
function approvedComment(idea: RefinedIdea, cycles: number): string {
  return [
    ...refinedIdeaSection(idea, 'Approved refined idea'),
    '',
    `Conversation cycles used: ${String(cycles)}`,
    `What refinement changed: ${idea.changeSummary}`,
  ].join('\n');
}

/**
 * What the refinement accomplished, as one line for a human-facing comment: the latest revision's
 * cumulative summary, or what a return that stopped before a revision achieved instead.
 */
function refinementSummary(idea: RefinedIdea | null, framing: FramingResponse | null): string {
  if (idea !== null) {
    return idea.changeSummary;
  }
  return framing === null
    ? 'Refinement stopped before it produced a refined idea revision.'
    : 'The editor framed the author\u2019s proposal shown above; refinement stopped before a ' +
        'refined idea revision was written.';
}

/** The plain outcome line one return opens with. */
function returnOutcome(decision: IdeaDecision, cycles: number): string {
  switch (decision) {
    case 'unsuitable':
      return 'Returned for feedback: this idea does not look suitable to pursue.';
    case 'author-decision-needed':
      return 'Author decision needed: the refinement conversation cannot continue without it.';
    case 'attempts-exhausted':
      return (
        `Attempts exhausted after ${String(cycles)} ` +
        `${cycles === 1 ? 'cycle' : 'cycles'}: the configured cycle limit was reached before the ` +
        'idea was approved.'
      );
    default:
      return 'Returned for feedback.';
  }
}

/**
 * The human-facing comment for one returned idea: the plain outcome, the latest idea, the cycles
 * used with the refinement summary, the plain reason that stopped approval, and the single next
 * step. Exhaustion states the limit explicitly and gives the Challenger's author-facing statement
 * of the remaining obstacle; raw concerns, discussion and tool transcripts stay in the artifacts.
 */
function returnedComment(settings: {
  readonly input: IdeaInput;
  readonly framing: FramingResponse | null;
  readonly idea: RefinedIdea | null;
  readonly decision: IdeaDecision;
  readonly cycles: number;
  readonly reason: string;
  readonly submittedStatus: string;
}): string {
  return [
    returnOutcome(settings.decision, settings.cycles),
    '',
    ...(settings.idea === null
      ? capturedIdeaSection(settings.input, settings.framing)
      : refinedIdeaSection(settings.idea, 'Latest refined idea')),
    '',
    `Conversation cycles used: ${String(settings.cycles)}`,
    `What refinement changed: ${refinementSummary(settings.idea, settings.framing)}`,
    '',
    'Why it was returned:',
    settings.reason,
    '',
    'Please reply with your feedback, your decision or a revised idea in a Jira comment, then ' +
      `move the item back to "${settings.submittedStatus}" to resubmit it.`,
  ].join('\n');
}

/** True when one Challenger result assessed exactly the supplied revision and editor response. */
function binds(
  report: ChallengerReport,
  refinedIdea: string,
  editorResponse: string | null,
  revision: number,
): boolean {
  return (
    report.refinedIdea === refinedIdea &&
    report.editorResponse === editorResponse &&
    report.revision === revision
  );
}

/** The retained artifact paths one approved handoff references, in cycle order. */
async function handoffReferences(
  root: string,
  submission: number,
  cycle: number,
): Promise<{
  readonly editorResponses: string[];
  readonly contributions: string[];
  readonly challengerResults: string[];
}> {
  const editorResponses: string[] = [];
  const contributions: string[] = [];
  const challengerResults: string[] = [];
  for (let number = 1; number <= cycle; number += 1) {
    const cycleRoot = ideaCycleDirectory(root, submission, number);
    for (const artifact of [
      researchArtifact,
      researchFollowUpArtifact,
      projectGuideArtifact,
      projectGuideFollowUpArtifact,
    ]) {
      if ((await readCycleArtifact(cycleRoot, artifact)) !== null) {
        contributions.push(path.join(cycleRoot, artifact.pathFromArtifactsRoot));
      }
    }
    if ((await readCycleArtifact(cycleRoot, editorResponseArtifact)) !== null) {
      editorResponses.push(path.join(cycleRoot, editorResponseArtifact.pathFromArtifactsRoot));
    }
    if ((await readCycleArtifact(cycleRoot, challengerArtifact)) !== null) {
      challengerResults.push(path.join(cycleRoot, challengerArtifact.pathFromArtifactsRoot));
    }
  }
  return { editorResponses, contributions, challengerResults };
}

/** Create RecordIdeaDecision over the parent selection and the refinement area it records. */
export function createRecordIdeaDecision(settings: RecordIdeaDecisionSettings): BoundAction {
  return async (input?: unknown) => {
    const decision = decisionOf(input);
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = path.join(selection.workspace.root, 'refinement');
    const inputRecord: IdeaInput = {
      taskKey: selection.taskKey,
      source: selection.source,
      issue: selection.task,
      conversation: [...selection.conversation],
    };
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const decisionFile = ideaSubmissionArtifactFile(root, plan.submission, decisionArtifact);

    const existing = await readSubmissionArtifact(root, plan.submission, decisionArtifact);
    if (existing !== null) {
      if (existing.decision !== decision) {
        throw new Error(
          `Submission ${String(plan.submission)} already recorded the "${existing.decision}" ` +
            `decision; it cannot also record "${decision}".`,
        );
      }
      return reported(settings, existing, selection.taskKey, plan.cycle, decisionFile);
    }

    const revision = await latestRefinedIdea(root, plan.submission, plan.cycle);
    const turn = await readCycleArtifact(cycleRoot, editorResponseArtifact);
    const turnFile =
      turn === null ? null : path.join(cycleRoot, editorResponseArtifact.pathFromArtifactsRoot);
    const challenger = await readCycleArtifact(cycleRoot, challengerArtifact);
    const framing = await readCycleArtifact(
      ideaCycleDirectory(root, plan.submission, 1),
      framingArtifact,
    );

    let reason: string | null = null;
    if (decision === 'approved') {
      if (revision === null) {
        throw new Error('Approval needs the refined idea revision the Challenger approved.');
      }
      if (
        challenger === null ||
        challenger.verdict !== 'approve' ||
        !binds(challenger, revision.path, turnFile, revision.value.revision)
      ) {
        throw new Error(
          'Approval requires the current cycle\u2019s Challenger result to approve the exact ' +
            'refined idea revision and editor response it reviewed.',
        );
      }
    }
    if (decision === 'unsuitable') {
      if (turn === null || turn.disposition !== 'unsuitable' || turn.reason === null) {
        throw new Error(
          'Returning an unsuitable idea requires the editor to have explained why in its ' +
            'response for this cycle.',
        );
      }
      reason = turn.reason;
    }
    if (decision === 'author-decision-needed') {
      const fromTurn = turn?.disposition === 'author-decision-needed' ? turn.reason : null;
      const fromFraming = framing?.authorDecision?.question ?? null;
      const question = fromTurn ?? fromFraming;
      if (question === null) {
        throw new Error(
          'An author-decision return requires the editor to have asked the essential question.',
        );
      }
      reason = question;
    }
    if (decision === 'attempts-exhausted') {
      if (
        revision === null ||
        challenger === null ||
        challenger.verdict !== 'discuss' ||
        !binds(challenger, revision.path, turnFile, revision.value.revision)
      ) {
        throw new Error(
          'An exhausted return requires the current cycle\u2019s Challenger result to discuss ' +
            'the exact refined idea revision and editor response it reviewed.',
        );
      }
      if (challenger.obstacle === null) {
        throw new Error(
          'An exhausted return needs the Challenger\u2019s plain statement of the remaining ' +
            'obstacle.',
        );
      }
      reason = challenger.obstacle;
    }

    const editorFile =
      turnFile ??
      (framing === null
        ? null
        : path.join(
            ideaCycleDirectory(root, plan.submission, 1),
            framingArtifact.pathFromArtifactsRoot,
          ));
    if (editorFile === null) {
      throw new Error(
        `Submission ${String(plan.submission)} has no editor framing or response to decide on.`,
      );
    }
    if (decision !== 'approved' && reason === null) {
      throw new Error(`The "${decision}" return needs the plain reason it states.`);
    }

    const text =
      decision === 'approved'
        ? approvedComment(revision!.value, plan.cycle)
        : returnedComment({
            input: inputRecord,
            framing,
            idea: revision?.value ?? null,
            decision,
            cycles: plan.cycle,
            reason: reason ?? '',
            submittedStatus: settings.submittedStatus,
          });
    const record: IdeaDecisionRecord = {
      decision,
      refinedIdea: revision?.path ?? null,
      revision: revision?.value.revision ?? null,
      editor: editorFile,
      challenger:
        challenger === null ? null : path.join(cycleRoot, challengerArtifact.pathFromArtifactsRoot),
      reason,
      comment: text,
      // The parent-owned publication fills in the applied transition and comment identity.
      source: null,
    };
    const file = await writeSubmissionArtifact(root, plan.submission, decisionArtifact, record);
    if (decision === 'approved' && revision !== null) {
      await writeHandoff(selection, root, plan.submission, plan.cycle, revision.path, decisionFile);
    }
    return reported(settings, record, selection.taskKey, plan.cycle, file);
  };
}

/** Publish the recorded decision's outcome and its saved record. */
function reported(
  settings: { readonly publish: EventPublisher },
  record: IdeaDecisionRecord,
  taskKey: string,
  cycle: number,
  file: string,
): 'recorded' {
  publishIdeaOutcome({
    publish: settings.publish,
    source: 'record-idea-decision',
    taskKey,
    cycle,
    outcome: 'recorded',
    detail: record.decision,
    artifact: file,
  });
  return 'recorded';
}

/** Write the approval's handoff for the reviewed revision. */
async function writeHandoff(
  selection: Selection,
  root: string,
  submission: number,
  cycle: number,
  refinedIdea: string,
  decisionFile: string,
): Promise<void> {
  const references = await handoffReferences(root, submission, cycle);
  const framing = await readCycleArtifact(ideaCycleDirectory(root, submission, 1), framingArtifact);
  const handoff: IdeaHandoff = {
    issue: { id: selection.source.issueId, key: selection.taskKey },
    issueWorkspace: selection.workspace.root,
    capturedInput: ideaSubmissionInputFile(root, submission),
    framing:
      framing === null
        ? null
        : path.join(ideaCycleDirectory(root, submission, 1), framingArtifact.pathFromArtifactsRoot),
    refinedIdea,
    ...references,
    decision: decisionFile,
  };
  await writeRecord(path.join(root, ideaHandoffFile), handoff);
}

/**
 * Create the parent-owned idea publication: it reads the child's recorded decision, publishes the
 * human-facing comment and the configured status transition, and stores the applied identities in
 * the record. A repeated publication reuses the retained comment body and an already-applied
 * status instead of duplicating either.
 */
export function createPublishDecision(settings: PublishDecisionSettings): BoundAction {
  const { jira, publish } = settings;
  return async () => {
    const root = settings.refinementRoot;
    const plan = await readIdeaPlan(root);
    const record = await readSubmissionArtifact(root, plan.submission, decisionArtifact);
    if (record === null) {
      throw new Error(`Submission ${String(plan.submission)} has no recorded decision to publish.`);
    }
    const decisionFile = ideaSubmissionArtifactFile(root, plan.submission, decisionArtifact);
    const target =
      record.decision === 'approved'
        ? settings.statuses.approved
        : settings.statuses.waitingForFeedback;

    const issue = await readIssue(jira, settings.selection.source.issueId);
    const status = statusNameOf(issue);
    let transitionId: string | null = null;
    if (status !== target) {
      const found = await transitionInto(jira, issue, target);
      if (found.kind === 'blocked') {
        publish({ source: 'publish-decision', type: 'failed', data: { reason: found.reason } });
        return 'failed';
      }
      transitionId = found.transition.id;
      await applyTransition(jira, issue.id, found.transition);
    }
    const comments = await readComments(jira, settings.selection.source.issueId);
    const comment = await publishDocument(
      jira,
      settings.selection.source.issueId,
      comments,
      documentOf(record.comment),
    );
    const published: IdeaDecisionRecord = {
      ...record,
      source: {
        transition: { id: transitionId ?? record.source?.transition.id ?? 'none', to: target },
        status: target,
        commentId: typeof comment.id === 'string' ? comment.id : null,
      },
    };
    await writeSubmissionArtifact(root, plan.submission, decisionArtifact, published);
    const terminal: IdeaTerminal =
      record.decision === 'approved' ? 'approved' : 'waiting-for-feedback';
    publishIdeaOutcome({
      publish,
      source: 'publish-decision',
      taskKey: settings.selection.taskKey,
      cycle: plan.cycle,
      outcome: terminal,
      detail: record.decision,
      artifact: decisionFile,
    });
    return terminal;
  };
}
