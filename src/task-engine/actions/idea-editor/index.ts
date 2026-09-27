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
  latestChallenger,
  latestRefinedIdea,
  readCycleArtifact,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import { projectGuideArtifact, projectGuideFollowUpArtifact } from '../project-guide/artifacts.js';
import { researchArtifact, researchFollowUpArtifact } from '../researcher/artifacts.js';
import {
  editorHelpArtifact,
  editorResponseArtifact,
  editorTurnResponseSchema,
  framingArtifact,
  framingResponseSchema,
  readRefinedIdeaRevision,
  refinedIdeaArtifact,
  type EditorDisposition,
  type EditorTurn,
  type EditorTurnResponse,
} from './artifacts.js';

/**
 * IdeaEditor runs the editor role. In cycle 1 it first frames the author's proposal and the few
 * questions that could develop it, then writes the refined idea from the researcher's and Project
 * guide's contributions. After a Challenger discussion it responds with a revision, an answer, a
 * rebuttal, a focused help request or a return to the author. Every written revision is a new
 * immutable artifact of its cycle; a repeated invocation reuses what it already wrote.
 */

export type IdeaEditorSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The editor role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
};

/** The editor task XState supplies with the invocation. */
export const ideaEditorTasks = ['frame', 'edit', 'respond', 'respond-after-help'] as const;

export type IdeaEditorTask = (typeof ideaEditorTasks)[number];

/** The dispositions one task may return. */
const taskDispositions: Readonly<Record<IdeaEditorTask, readonly EditorDisposition[]>> = {
  frame: [],
  edit: ['revised', 'unsuitable', 'author-decision-needed'],
  respond: [
    'revised',
    'answered',
    'rebutted',
    'help-requested',
    'unsuitable',
    'author-decision-needed',
  ],
  'respond-after-help': ['revised', 'answered', 'rebutted', 'unsuitable', 'author-decision-needed'],
};

/** The task the workflow supplied with the invocation. */
function taskOf(input: unknown): IdeaEditorTask {
  const task =
    typeof input === 'object' && input !== null
      ? (input as { readonly task?: unknown }).task
      : undefined;
  const found = ideaEditorTasks.find((candidate) => candidate === task);
  if (found === undefined) {
    throw new Error(
      `The idea workflow supplied IdeaEditor the unknown task ${JSON.stringify(task)}.`,
    );
  }
  return found;
}

/** The edit task's outcome: a written revision, or the return the editor chose. */
function editOutcome(disposition: EditorDisposition): string {
  return disposition === 'revised' ? 'written' : disposition;
}

/** A response task's outcome: one response for every revise, answer or rebuttal. */
function responseOutcome(disposition: EditorDisposition): string {
  if (disposition === 'revised' || disposition === 'answered' || disposition === 'rebutted') {
    return 'responded';
  }
  return disposition;
}

/** True when the editor's turn carries the parts its task and disposition need. */
function turnIsValid(
  task: IdeaEditorTask,
  turn: {
    readonly disposition: EditorDisposition;
    readonly reason: string | null;
    readonly help: {
      readonly researcher: string | null;
      readonly projectGuide: string | null;
    } | null;
    readonly refinedIdea: unknown | null;
  },
): boolean {
  if (!taskDispositions[task].includes(turn.disposition)) {
    return false;
  }
  if (turn.disposition === 'unsuitable' || turn.disposition === 'author-decision-needed') {
    return turn.reason !== null && turn.refinedIdea === null;
  }
  if (turn.disposition === 'help-requested') {
    return turn.help !== null && (turn.help.researcher !== null || turn.help.projectGuide !== null);
  }
  if (turn.disposition === 'revised') {
    return turn.refinedIdea !== null;
  }
  return turn.refinedIdea === null;
}

/** The path of one cycle's refined idea revision. */
function revisionFile(root: string, submission: number, cycle: number): string {
  return path.join(
    ideaCycleDirectory(root, submission, cycle),
    refinedIdeaArtifact.pathFromArtifactsRoot,
  );
}

/** The next refined idea revision number of one submission. */
async function nextRevision(root: string, submission: number, cycle: number): Promise<number> {
  let revision = 0;
  for (let number = 1; number <= cycle; number += 1) {
    const read = await readRefinedIdeaRevision(ideaCycleDirectory(root, submission, number));
    if (read !== null) {
      revision = Math.max(revision, read.value.revision);
    }
  }
  return revision + 1;
}

/**
 * The refined idea revision this cycle already wrote, when an interrupted turn left one. A
 * revision is immutable history, so a repeated turn reuses it instead of writing another one.
 */
async function cycleRevision(
  root: string,
  submission: number,
  cycle: number,
): Promise<Awaited<ReturnType<typeof readRefinedIdeaRevision>>> {
  const read = await readRefinedIdeaRevision(ideaCycleDirectory(root, submission, cycle));
  return read !== null && read.value.submission === submission && read.value.cycle === cycle
    ? read
    : null;
}

/** The contributions the editor's response is built on, as invocation context. */
async function contributionsText(
  root: string,
  submission: number,
  cycle: number,
  task: IdeaEditorTask,
): Promise<string[]> {
  if (task !== 'edit') {
    return [];
  }
  const cycleRoot = ideaCycleDirectory(root, submission, cycle);
  const contributions: string[] = [];
  for (const [role, artifact] of [
    ['Researcher', researchArtifact],
    ['Project guide', projectGuideArtifact],
  ] as const) {
    const contribution = await readCycleArtifact(cycleRoot, artifact);
    if (contribution === null) {
      throw new Error(
        `The refined idea needs the ${role.toLowerCase()} contribution of submission ` +
          `${String(submission)} cycle ${String(cycle)}.`,
      );
    }
    contributions.push(
      `${role} contribution: ${path.join(cycleRoot, artifact.pathFromArtifactsRoot)}\n` +
        JSON.stringify(contribution, null, 2),
    );
  }
  return contributions;
}

/** The focused contributions answering the editor's help request, as invocation context. */
async function focusedText(root: string, submission: number, cycle: number): Promise<string[]> {
  const cycleRoot = ideaCycleDirectory(root, submission, cycle);
  const focused: string[] = [];
  for (const artifact of [researchFollowUpArtifact, projectGuideFollowUpArtifact]) {
    const contribution = await readCycleArtifact(cycleRoot, artifact);
    if (contribution !== null) {
      focused.push(
        `Focused ${contribution.role} contribution: ` +
          `${path.join(cycleRoot, artifact.pathFromArtifactsRoot)}\n` +
          JSON.stringify(contribution, null, 2),
      );
    }
  }
  return focused;
}

/** Create IdeaEditor over the refinement area it writes into. */
export function createIdeaEditor(settings: IdeaEditorSettings): BoundAction {
  /** Publish a saved editor artifact and return its workflow outcome. */
  function reported(
    taskKey: string,
    cycle: number,
    outcome: string,
    detail: string | null,
    artifact: string,
  ): string {
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'idea-editor',
      taskKey,
      cycle,
      outcome,
      detail,
      artifact,
    });
    return outcome;
  }

  /** Frame the author's proposal, or report the essential author decision it found. */
  async function frame(root: string, taskKey: string, cycle: number): Promise<string> {
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const file = path.join(cycleRoot, framingArtifact.pathFromArtifactsRoot);
    const existing = await readCycleArtifact(cycleRoot, framingArtifact);
    if (existing !== null) {
      return reported(
        taskKey,
        cycle,
        existing.authorDecision === null ? 'framed' : 'author-decision-needed',
        existing.authorDecision === null ? `${String(existing.questions.length)} questions` : null,
        file,
      );
    }

    const input = await readIdeaInput(root, plan.submission);
    const guidance = await projectGuidanceText(root);
    const context = [
      'Frame the author\u2019s proposed change and the few questions that could usefully develop',
      'it for this refinement conversation. Preserve their intent; keep your interpretation open',
      'to correction. Ask an essential author decision only when one is already missing: an',
      'element the author can still supply through refinement is not one.',
      await capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: null }),
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(framingResponseSchema),
    ].join('\n\n');

    const framing = await invokeIdeaRole({
      root,
      plan,
      role: 'idea-editor',
      operation: 'FrameIdea',
      taskKey,
      context,
      schema: framingResponseSchema,
      runner: settings.runner,
    });
    await writeCycleArtifact(cycleRoot, framingArtifact, framing);
    return reported(
      taskKey,
      cycle,
      framing.authorDecision === null ? 'framed' : 'author-decision-needed',
      framing.authorDecision === null ? `${String(framing.questions.length)} questions` : null,
      file,
    );
  }

  /** Write the refined idea revision from the cycle's contributions, or return it to its author. */
  async function edit(root: string, taskKey: string, cycle: number): Promise<string> {
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const turnFile = path.join(cycleRoot, editorResponseArtifact.pathFromArtifactsRoot);
    const existing = await readCycleArtifact(cycleRoot, editorResponseArtifact);
    if (existing !== null) {
      const outcome = editOutcome(existing.disposition);
      return reported(
        taskKey,
        cycle,
        outcome,
        null,
        outcome === 'written' ? revisionFile(root, plan.submission, plan.cycle) : turnFile,
      );
    }
    const written = await cycleRevision(root, plan.submission, plan.cycle);
    if (written !== null) {
      // A previous edit wrote this cycle's revision before its response was saved.
      return reported(
        taskKey,
        cycle,
        'written',
        `revision ${String(written.value.revision)}`,
        written.path,
      );
    }

    const input = await readIdeaInput(root, plan.submission);
    const projectGuidance = await projectGuidanceText(root);
    const context = [
      'Write the refined idea revision for the current captured idea from the contributions',
      'below. Keep it short by default: about 150-200 words across its parts, one to three short',
      'sentences each, only material detail and plain language. Its `idea` part states the',
      'author\u2019s proposed change, why it matters and the principle behind it; `projectFit`',
      'states why it belongs in this project; `feasibility` states a plausible way forward given',
      'the known constraints and evidence; `openQuestions` lists only the material questions the',
      'next workflow must answer and may be omitted. Preserve the author\u2019s intent and do not',
      'turn the idea into requirements, design decisions or an implementation plan. Write',
      'changeSummary as the cumulative account of what refinement has changed. If pursuing the',
      'idea does not look sensible, return it as unsuitable with the author-facing reason; ask an',
      'essential author decision plainly when only the author can make it.',
      await capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: null }),
      ...(await contributionsText(root, plan.submission, plan.cycle, 'edit')),
      ...(projectGuidance === null ? [] : [projectGuidance]),
      responseFormatText(editorTurnResponseSchema),
    ].join('\n\n');

    const turn = await invokeIdeaRole({
      root,
      plan,
      role: 'idea-editor',
      operation: 'EditIdea',
      taskKey,
      context,
      schema: editorTurnResponseSchema,
      runner: settings.runner,
    });
    if (!turnIsValid('edit', turn)) {
      throw new Error(
        `The idea editor returned the "${turn.disposition}" disposition without the parts the ` +
          'edit task needs.',
      );
    }
    return persist(root, plan.submission, plan.cycle, 'edit', turn);
  }

  /** Respond to the Challenger's concern, with focused help when the editor asks for it. */
  async function respond(
    root: string,
    taskKey: string,
    cycle: number,
    task: 'respond' | 'respond-after-help',
  ): Promise<string> {
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const turnFile = path.join(cycleRoot, editorResponseArtifact.pathFromArtifactsRoot);
    const existing = await readCycleArtifact(cycleRoot, editorResponseArtifact);
    if (existing !== null) {
      return reported(
        taskKey,
        cycle,
        responseOutcome(existing.disposition),
        null,
        existing.disposition === 'revised'
          ? revisionFile(root, plan.submission, plan.cycle)
          : turnFile,
      );
    }
    const help = await readCycleArtifact(cycleRoot, editorHelpArtifact);
    if (task === 'respond' && help !== null) {
      // The response asked for help before the invocation was interrupted; route it again.
      return reported(
        taskKey,
        cycle,
        'help-requested',
        null,
        path.join(cycleRoot, editorHelpArtifact.pathFromArtifactsRoot),
      );
    }
    const written = await cycleRevision(root, plan.submission, plan.cycle);
    if (written !== null) {
      // A previous response revised the idea before its turn was saved; the revision stands.
      return reported(
        taskKey,
        cycle,
        'responded',
        `revision ${String(written.value.revision)}`,
        written.path,
      );
    }

    // The cycle was opened by the discussion the editor answers, which may be the preceding
    // cycle's result: the current cycle's Challenger runs after this response.
    const discussion = await latestChallenger(root, plan.submission, plan.cycle);
    if (discussion === null) {
      throw new Error(
        `The editor responds to a Challenger result; submission ${String(plan.submission)} has ` +
          'none.',
      );
    }
    const revision = await latestRefinedIdea(root, plan.submission, plan.cycle);
    if (revision === null) {
      throw new Error(
        `The editor responds to the revision the Challenger discussed; submission ` +
          `${String(plan.submission)} has none.`,
      );
    }
    const input = await readIdeaInput(root, plan.submission);
    const focused =
      task === 'respond-after-help' ? await focusedText(root, plan.submission, plan.cycle) : [];
    const context = [
      ...(task === 'respond-after-help'
        ? [
            'Answer the Challenger with the focused help below. Revise what is weak, answer what',
            'can be answered or rebut a mistaken objection; you do not have to accept every',
            'suggestion. Request no further help in this turn.',
          ]
        : [
            'Respond to the Challenger\u2019s concern about the current refined idea revision.',
            'Revise what is weak, answer what can be answered or rebut a mistaken objection; you',
            'do not have to accept every suggestion. When knowledge is missing, request focused',
            'help from the researcher or the Project guide, naming the specific questions. If the',
            'idea is unsuitable, explain why; ask an essential author decision plainly when only',
            'the author can make it.',
          ]),
      await capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: null }),
      `The refined idea revision the Challenger assessed is the revision in force above: ` +
        revision.path,
      `The Challenger result to answer: ` +
        `${discussion.path}\n${JSON.stringify(discussion.report, null, 2)}`,
      ...focused,
      responseFormatText(editorTurnResponseSchema),
    ].join('\n\n');

    const turn = await invokeIdeaRole({
      root,
      plan,
      role: 'idea-editor',
      operation: 'EditorResponse',
      taskKey,
      context,
      schema: editorTurnResponseSchema,
      runner: settings.runner,
    });
    if (!turnIsValid(task, turn)) {
      throw new Error(
        `The idea editor returned the "${turn.disposition}" disposition without the parts the ` +
          `${task} task needs.`,
      );
    }
    return persist(root, plan.submission, plan.cycle, task, turn);
  }

  /**
   * Save one editor turn: its short response always, its focused help request when it asks for
   * one, and the refined idea revision it wrote when it revised the idea. A revision gets its own
   * immutable artifact, so every earlier Challenger approval stays bound to the revision it
   * reviewed.
   */
  async function persist(
    root: string,
    submission: number,
    cycle: number,
    task: IdeaEditorTask,
    turn: EditorTurnResponse,
  ): Promise<string> {
    const cycleRoot = ideaCycleDirectory(root, submission, cycle);
    const returns =
      turn.disposition === 'unsuitable' || turn.disposition === 'author-decision-needed';
    const stored: EditorTurn = {
      disposition: turn.disposition,
      response: turn.response,
      reason: returns ? turn.reason : null,
      help: turn.disposition === 'help-requested' ? turn.help : null,
    };
    const taskKey = (await readIdeaInput(root, submission)).taskKey;
    if (turn.disposition === 'help-requested') {
      const file = await writeCycleArtifact(cycleRoot, editorHelpArtifact, stored);
      return reported(taskKey, cycle, 'help-requested', null, file);
    }

    let revision: number | null = null;
    if (turn.disposition === 'revised') {
      if (turn.refinedIdea === null) {
        throw new Error('The editor revised the idea without returning the revision.');
      }
      const existing = await cycleRevision(root, submission, cycle);
      if (existing === null) {
        revision = await nextRevision(root, submission, cycle);
        const { openQuestions, ...parts } = turn.refinedIdea;
        await writeCycleArtifact(cycleRoot, refinedIdeaArtifact, {
          ...parts,
          ...(openQuestions === null ? {} : { openQuestions }),
          revision,
          submission,
          cycle,
        });
      } else {
        revision = existing.value.revision;
      }
    }
    const file = await writeCycleArtifact(cycleRoot, editorResponseArtifact, stored);
    const outcome =
      task === 'edit' ? editOutcome(turn.disposition) : responseOutcome(turn.disposition);
    return reported(
      taskKey,
      cycle,
      outcome,
      revision === null ? null : `revision ${String(revision)}`,
      revision === null ? file : revisionFile(root, submission, cycle),
    );
  }

  return async (input?: unknown) => {
    const task = taskOf(input);
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const taskKey = (await readIdeaInput(root, plan.submission)).taskKey;
    if (task === 'frame') {
      return frame(root, taskKey, plan.cycle);
    }
    if (task === 'edit') {
      return edit(root, taskKey, plan.cycle);
    }
    return respond(root, taskKey, plan.cycle, task);
  };
}
