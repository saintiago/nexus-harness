import path from 'node:path';
import type {
  JiraAdapter,
  JiraComment,
  JiraDocument,
  JiraTransition,
} from '../../../adapters/jira.js';
import { fault, ok, type Result } from '../../../result.js';
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
  readIdeaInput,
  readIdeaPlan,
  readSubmissionArtifact,
  writeSubmissionArtifact,
} from '../idea-storage.js';
import { projectGuideArtifact, projectGuideFollowUpArtifact } from '../project-guide/artifacts.js';
import { researchArtifact, researchFollowUpArtifact } from '../researcher/artifacts.js';
import { writeRecord } from '../records.js';
import type { IdeaInput, IdeaSelection } from '../select-idea/artifacts.js';
import { capturedTransition, publishDocument } from '../source.js';
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
 * the approved refined idea with the cycles used and the cumulative change summary, moves the item
 * to its configured approved state and leaves one handoff artifact referencing the shared issue
 * workspace and the retained artifacts it rests on. The three returns publish concise
 * human-facing feedback with the latest idea, the cycles used and the plain reason — unsuitable,
 * an essential author decision or exhausted attempts — and move the item to its configured
 * waiting-for-feedback state. Internal conversation stays in the cycle's artifacts. Publication
 * uses the captured selection snapshot without reading the issue or its conversation again.
 * Every human-facing comment reports the cycles used and what refinement changed, including a
 * return that stopped before a refined idea revision existed.
 */

export type PublishDecisionSettings = {
  /** The retained selection: the captured issue, transitions and shared workspace references. */
  readonly selection: IdeaSelection;
  /** The configured statuses the terminal routes move the item into and name back to. */
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

/** Create PublishDecision over the retained selection and source it updates. */
export function createPublishDecision(settings: PublishDecisionSettings): BoundAction {
  const { selection, jira, publish } = settings;
  const root = selection.workspace.root;

  return async (input?: unknown) => {
    const decision = decisionOf(input);
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
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

    /** Write the approval's handoff for the reviewed revision. */
    async function writeHandoff(revision: { readonly path: string }): Promise<void> {
      const references = await handoffReferences(root, plan.submission, plan.cycle);
      const framing = await readCycleArtifact(
        ideaCycleDirectory(root, plan.submission, 1),
        framingArtifact,
      );
      const handoff: IdeaHandoff = {
        issue: { id: selection.source.issueId, key: selection.taskKey },
        issueWorkspace: selection.issueWorkspace.root,
        capturedInput: ideaSubmissionInputFile(root, plan.submission),
        framing:
          framing === null
            ? null
            : path.join(
                ideaCycleDirectory(root, plan.submission, 1),
                framingArtifact.pathFromArtifactsRoot,
              ),
        refinedIdea: revision.path,
        ...references,
        decision: decisionFile,
      };
      await writeRecord(path.join(root, ideaHandoffFile), handoff);
    }

    const existing = await readSubmissionArtifact(root, plan.submission, decisionArtifact);
    if (existing !== null) {
      if (existing.decision !== decision) {
        throw new Error(
          `Submission ${String(plan.submission)} already recorded the "${existing.decision}" ` +
            `decision; it cannot also record "${decision}".`,
        );
      }
      // The route's source updates are already saved; a repeated invocation completes any
      // outstanding required output and reuses the record.
      if (decision === 'approved' && existing.refinedIdea !== null) {
        await writeHandoff({ path: existing.refinedIdea });
      }
      return reported(existing, decisionFile);
    }

    const inputRecord = await readIdeaInput(root, plan.submission);
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

    const targetStatus =
      decision === 'approved' ? settings.statuses.approved : settings.statuses.waitingForFeedback;
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
            submittedStatus: settings.statuses.submitted,
          });
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
      refinedIdea: revision?.path ?? null,
      revision: revision?.value.revision ?? null,
      editor: editorFile,
      challenger:
        challenger === null ? null : path.join(cycleRoot, challengerArtifact.pathFromArtifactsRoot),
      reason,
      comment: text,
      source: {
        transition: { id: transition.value.id, to: targetStatus },
        status: targetStatus,
        commentId: typeof comment.id === 'string' ? comment.id : null,
      },
    };
    const file = await writeSubmissionArtifact(root, plan.submission, decisionArtifact, record);
    if (decision === 'approved' && revision !== null) {
      await writeHandoff(revision);
    }
    return reported(record, file);
  };
}
