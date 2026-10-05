import path from 'node:path';
import type { JiraAdapter, JiraDocument } from '../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import {
  challengerArtifact,
  isBoundChallengerReport,
  type ChallengerReport,
} from '../challenger/artifacts.js';
import {
  editorResponseArtifact,
  framingArtifact,
  readRefinedIdeaRevision,
  refinedIdeaIdentity,
  type RefinedIdea,
  type RefinedIdeaRead,
  type RetainedFraming,
} from '../idea-editor/artifacts.js';
import {
  ideaReportContracts,
  publishIdeaOutcome,
  readRetainedIdeaReport,
  readRetainedIdeaReportAtFile,
  readRetainedRefinedIdea,
  type AnyIdeaReportDeclaration,
} from '../idea-context.js';
import {
  ideaCycleDirectory,
  ideaSubmissionArtifactFile,
  ideaSubmissionInputFile,
  readCycleArtifact,
  readIdeaPlan,
  readSubmissionArtifact,
  writeSubmissionArtifact,
} from '../idea-storage.js';
import { projectGuideArtifact, projectGuideFollowUpArtifact } from '../project-guide/artifacts.js';
import { readRequiredRecord, writeRecord } from '../records.js';
import { recordIdentity } from '../report-feedback.js';
import { researchArtifact, researchFollowUpArtifact } from '../researcher/artifacts.js';
import type { IdeaInput } from '../select-idea/artifacts.js';
import { selectionDeclaration, type Selection } from '../select-task/artifacts.js';
import type { IdeaRoundPlan } from '../start-idea-round/artifacts.js';
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
  /**
   * The source statuses this publication may write from: the status the child's selection left
   * behind and the target a repeated publication already applied. Any other status is an
   * unexpected human change the publication preserves instead of overwriting. Absent leaves the
   * transition unvalidated for callers that supply no expected source state.
   */
  readonly expected?: readonly string[];
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
function capturedIdeaSection(input: IdeaInput, framing: RetainedFraming | null): string[] {
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
function refinementSummary(idea: RefinedIdea | null, framing: RetainedFraming | null): string {
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
  readonly framing: RetainedFraming | null;
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

/**
 * True when one bound Challenger result assessed exactly the supplied refined idea revision and
 * editor outcome: the recorded paths and content identities both match, so changed content can
 * never reuse an earlier approval.
 */
function binds(
  report: ChallengerReport,
  revision: RefinedIdeaRead,
  editor: { readonly file: string; readonly identity: string } | null,
): boolean {
  return (
    report.refinedIdea === revision.path &&
    report.refinedIdeaIdentity === refinedIdeaIdentity(revision) &&
    report.editorResponse === (editor === null ? null : editor.file) &&
    report.editorIdentity === (editor === null ? null : editor.identity) &&
    report.revision === revision.value.revision
  );
}

/**
 * Require the exact evidence one recorded approval rests on: the refined idea revision it names,
 * the editor outcome and bound Markdown the Challenger assessed, the Challenger result with its
 * bound Markdown, and the framing the cycle falls back to. A missing or changed artifact is an
 * unusable approval preserved as its producer's rejection evidence, so neither retained replay
 * nor parent publication can reuse an approval of content that is no longer readable. The
 * framing is the editor outcome itself when the revision stood alone and otherwise its fallback,
 * which recording also required to be usable when the cycle states one.
 */
async function requireRecordedApproval(settings: {
  readonly root: string;
  readonly workId: string;
  readonly plan: IdeaRoundPlan;
  readonly record: IdeaDecisionRecord;
  readonly context: string;
}): Promise<RefinedIdeaRead> {
  const { record } = settings;
  if (record.refinedIdea === null || record.challenger === null) {
    throw new Error('The retained approval has no refined idea or Challenger reference.');
  }
  const idea = await readRefinedIdeaRevision(path.dirname(record.refinedIdea));
  if (idea === null || idea.path !== record.refinedIdea) {
    throw new Error(
      `The retained approval names no refined idea revision at "${record.refinedIdea}".`,
    );
  }
  const assessed = await readRetainedIdeaReportAtFile({
    root: settings.root,
    workId: settings.workId,
    plan: settings.plan,
    file: record.challenger,
    declaration: challengerArtifact,
    contract: ideaReportContracts.challenge,
    context: `${settings.context} Reading the Challenger result it rests on.`,
  });
  if (assessed === null) {
    throw new Error(`The retained approval names no Challenger result at "${record.challenger}".`);
  }
  const standalone = assessed.value.editorResponse === null;
  if (!standalone) {
    await readRetainedIdeaReport({
      root: settings.root,
      workId: settings.workId,
      plan: settings.plan,
      cycleRoot: ideaCycleDirectory(settings.root, settings.plan.submission, settings.plan.cycle),
      declaration: framingArtifact,
      contract: ideaReportContracts.framing,
      context: `${settings.context} Reading the framing the approval falls back to.`,
    });
  }
  const declaration: AnyIdeaReportDeclaration = standalone
    ? framingArtifact
    : editorResponseArtifact;
  const editor = await readRetainedIdeaReportAtFile({
    root: settings.root,
    workId: settings.workId,
    plan: settings.plan,
    file: record.editor,
    declaration,
    contract: standalone ? ideaReportContracts.framing : ideaReportContracts.editorTurn,
    context:
      `${settings.context} Reading the editor ` +
      `${standalone ? 'framing' : 'outcome'} the approval assessed.`,
  });
  if (editor === null) {
    throw new Error(
      `The retained approval names no editor ${standalone ? 'framing' : 'outcome'} at ` +
        `"${record.editor}".`,
    );
  }
  if (
    idea.value.revision !== record.revision ||
    !isBoundChallengerReport(assessed.value) ||
    assessed.value.verdict !== 'approve' ||
    !binds(
      assessed.value,
      idea,
      standalone ? null : { file: editor.file, identity: recordIdentity(editor.value) },
    )
  ) {
    throw new Error('The retained approval does not bind its refined idea and editor outcome.');
  }
  return idea;
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
      if (existing.decision === 'approved') {
        const approval = await requireRecordedApproval({
          root,
          workId: selection.taskKey,
          plan,
          record: existing,
          context:
            `RecordIdeaDecision replaying the recorded approval of submission ` +
            `${String(plan.submission)} for idea ${selection.taskKey}.`,
        });
        await writeHandoff(
          selection,
          root,
          plan.submission,
          plan.cycle,
          approval.path,
          decisionFile,
        );
      }
      return reported(settings, existing, selection.taskKey, plan.cycle, decisionFile);
    }

    const revision = await readRetainedRefinedIdea({
      root,
      workId: selection.taskKey,
      plan,
      submission: plan.submission,
      cycle: plan.cycle,
      context:
        `RecordIdeaDecision reading the refined idea revision in force for submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} of idea ${selection.taskKey}.`,
    });
    const turn = await readRetainedIdeaReport({
      root,
      workId: selection.taskKey,
      plan,
      cycleRoot,
      declaration: editorResponseArtifact,
      contract: ideaReportContracts.editorTurn,
      context:
        `RecordIdeaDecision reading the editor outcome of submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${selection.taskKey}.`,
    });
    const turnFile = turn === null ? null : turn.file;
    const editorBinding =
      turn === null ? null : { file: turn.file, identity: recordIdentity(turn.value) };
    const challenger = await readRetainedIdeaReport({
      root,
      workId: selection.taskKey,
      plan,
      cycleRoot,
      declaration: challengerArtifact,
      contract: ideaReportContracts.challenge,
      context:
        `RecordIdeaDecision reading the Challenger result of submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${selection.taskKey}.`,
    });
    const framing = await readRetainedIdeaReport({
      root,
      workId: selection.taskKey,
      plan,
      cycleRoot: ideaCycleDirectory(root, plan.submission, 1),
      declaration: framingArtifact,
      contract: ideaReportContracts.framing,
      context:
        `RecordIdeaDecision reading the framing of submission ` +
        `${String(plan.submission)} for idea ${selection.taskKey}.`,
    });

    let reason: string | null = null;
    if (decision === 'approved') {
      if (revision === null) {
        throw new Error('Approval needs the refined idea revision the Challenger approved.');
      }
      if (
        challenger === null ||
        !isBoundChallengerReport(challenger.value) ||
        challenger.value.verdict !== 'approve' ||
        !binds(challenger.value, revision, editorBinding)
      ) {
        throw new Error(
          'Approval requires the current cycle\u2019s Challenger result to approve the exact ' +
            'refined idea revision and editor outcome it reviewed.',
        );
      }
    }
    if (decision === 'unsuitable') {
      if (turn === null || turn.value.disposition !== 'unsuitable' || turn.value.reason === null) {
        throw new Error(
          'Returning an unsuitable idea requires the editor to have explained why in its ' +
            'response for this cycle.',
        );
      }
      reason = turn.value.reason;
    }
    if (decision === 'author-decision-needed') {
      const fromTurn =
        turn?.value.disposition === 'author-decision-needed' ? turn.value.reason : null;
      const fromFraming = framing?.value.authorDecision?.question ?? null;
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
        !isBoundChallengerReport(challenger.value) ||
        challenger.value.verdict !== 'discuss' ||
        !binds(challenger.value, revision, editorBinding)
      ) {
        throw new Error(
          'An exhausted return requires the current cycle\u2019s Challenger result to discuss ' +
            'the exact refined idea revision and editor outcome it reviewed.',
        );
      }
      if (challenger.value.obstacle === null) {
        throw new Error(
          'An exhausted return needs the Challenger\u2019s plain statement of the remaining ' +
            'obstacle.',
        );
      }
      reason = challenger.value.obstacle;
    }

    const editorFile = turnFile ?? (framing === null ? null : framing.file);
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
            framing: framing === null ? null : framing.value,
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
      challenger: challenger === null ? null : challenger.file,
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
    if (
      status !== target &&
      settings.expected !== undefined &&
      (status === null || !settings.expected.includes(status))
    ) {
      // A human pause is preserved and reported before local evidence is judged: nothing is
      // published while the issue is not in a status this publication may write from.
      publish({
        source: 'publish-decision',
        type: 'failed',
        data: {
          reason:
            `Issue ${settings.selection.taskKey} is in status "${status ?? 'unknown'}" while ` +
            `the idea publication expected one of ` +
            `${settings.expected.map((value) => `"${value}"`).join(', ')}; an unexpected human ` +
            'change is preserved instead of overwritten.',
        },
      });
      return 'failed';
    }
    if (record.decision === 'approved') {
      // Publication revalidates the approval it reuses before any source write: a bound report
      // removed or changed after the decision was recorded must fail here instead of authorizing
      // the approved transition or reusing the retained comment.
      await requireRecordedApproval({
        root,
        workId: settings.selection.taskKey,
        plan,
        record,
        context:
          `PublishDecision reusing the recorded approval of submission ` +
          `${String(plan.submission)} for idea ${settings.selection.taskKey}.`,
      });
    }
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
