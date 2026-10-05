import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import {
  capturedIdeaText,
  ideaReportContracts,
  invokeIdeaRole,
  projectGuidanceText,
  publishIdeaOutcome,
  readRetainedIdeaReport,
  readRetainedRefinedIdea,
  readRetainedRefinedIdeaRevision,
  responseFormatText,
  retainedHistoryText,
  type IdeaInvocationOutcome,
} from '../idea-context.js';
import {
  ideaCycleDirectory,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import { challengerArtifact, type ChallengerReport } from '../challenger/artifacts.js';
import { projectGuideArtifact, projectGuideFollowUpArtifact } from '../project-guide/artifacts.js';
import { researchArtifact, researchFollowUpArtifact } from '../researcher/artifacts.js';
import type { IdeaRoundPlan } from '../start-idea-round/artifacts.js';
import {
  editorHelpArtifact,
  editorResponseArtifact,
  editorTurnResponseSchema,
  framingArtifact,
  framingResponseSchema,
  refinedIdeaArtifact,
  type EditorDisposition,
  type EditorTurn,
  type EditorTurnResponse,
  type RefinedIdeaRead,
} from './artifacts.js';

/**
 * IdeaEditor runs the editor role. In cycle 1 it first frames the author's proposal and the few
 * questions that could develop it, then writes the refined idea from the researcher's and Project
 * guide's contributions. After a Challenger discussion it responds with a revision, an answer, a
 * rebuttal, a focused help request or a return to the author. Every written revision is a new
 * immutable artifact of its cycle; a repeated invocation reuses a completed turn, and completes one
 * an interruption left half-saved by requesting a response specifically for the retained revision.
 * A retry that changes that revision fails before saving its response.
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

/**
 * The deliverable instruction every editor turn that writes or answers about the refined idea
 * carries: the concise length and plain language of the decision aid, the precedence of benefit
 * over implementation mechanics, and the cumulative refinement summary publication adds beside
 * the cycle count. The specification owns the wording; the editor's role prompt adds only its
 * particular duties.
 */
export const refinedIdeaDeliverableInstruction = [
  'The refined idea is a concise decision aid of about 150-200 words across its stated parts, one',
  'to three short sentences each, in plain language. The length guidance includes the open',
  'questions and is not a validation gate. Explain the benefit and guiding principle before',
  'component names or integration mechanics. Retain architectural directions the author supplied,',
  'but keep supporting implementation detail in the research and project guidance artifacts.',
  'Keep external sources and project measurements distinguishable: a claim from a source stays',
  'attributed instead of reading as the author\u2019s proposal or a local measurement.',
  'Remove repetition before returning the idea rather than relying on publication to shorten it.',
  'Write changeSummary as one or two short sentences describing the useful changes, without',
  'repeating the refined idea or narrating the agents\u2019 work.',
].join('\n');

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
    return turn.reason !== null && turn.help === null && turn.refinedIdea === null;
  }
  if (turn.reason !== null) {
    return false;
  }
  if (turn.disposition === 'help-requested') {
    return (
      turn.help !== null &&
      (turn.help.researcher !== null || turn.help.projectGuide !== null) &&
      turn.refinedIdea === null
    );
  }
  if (turn.help !== null) {
    return false;
  }
  if (turn.disposition === 'revised') {
    return turn.refinedIdea !== null;
  }
  return turn.refinedIdea === null;
}

/** Why one editor turn is not usable for its task, or null. The saved turn is never normalized. */
function turnProblem(task: IdeaEditorTask, turn: EditorTurnResponse): string | null {
  if (turnIsValid(task, turn)) {
    return null;
  }
  return (
    `The idea editor's "${turn.disposition}" turn does not carry exactly the parts the ` +
    `${task} task requires: reason only for an unsuitable or author-decision-needed return, ` +
    'help only for a help-requested turn with a focused question, and refinedIdea only for a ' +
    'revised turn.'
  );
}

/** The path of one cycle's refined idea revision. */
function revisionFile(root: string, submission: number, cycle: number): string {
  return path.join(
    ideaCycleDirectory(root, submission, cycle),
    refinedIdeaArtifact.pathFromArtifactsRoot,
  );
}

/** The next refined idea revision number of one submission. */
async function nextRevision(root: string, plan: IdeaRoundPlan, workId: string): Promise<number> {
  let revision = 0;
  for (let number = 1; number <= plan.cycle; number += 1) {
    const read = await readRetainedRefinedIdeaRevision({
      root,
      workId,
      plan,
      cycleRoot: ideaCycleDirectory(root, plan.submission, number),
      context:
        `IdeaEditor computing the next refined idea revision of submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${workId}.`,
    });
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
  plan: IdeaRoundPlan,
  workId: string,
): Promise<RefinedIdeaRead | null> {
  const read = await readRetainedRefinedIdeaRevision({
    root,
    workId,
    plan,
    cycleRoot: ideaCycleDirectory(root, plan.submission, plan.cycle),
    context:
      `IdeaEditor reading its retained refined idea revision of submission ` +
      `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${workId}.`,
  });
  return read !== null &&
    read.value.submission === plan.submission &&
    read.value.cycle === plan.cycle
    ? read
    : null;
}

/** Constrain recovery to explaining the immutable revision whose response was not saved. */
async function recoveryText(root: string, plan: IdeaRoundPlan, workId: string): Promise<string[]> {
  const retained = await cycleRevision(root, plan, workId);
  if (retained === null) {
    return [];
  }
  return [
    'Interrupted editor turn recovery: the revision below was saved, but its response was not. ' +
      'Complete that turn instead of drafting another revision. Return disposition "revised" ' +
      'and repeat its content exactly in refinedIdea (omit revision, submission and cycle). ' +
      'Write a response describing this retained revision accurately, including any concern it ' +
      'leaves unresolved. Do not claim a correction absent from this revision, change its content, ' +
      'request help or choose another disposition. Further changes require a later cycle.\n' +
      `${retained.path}\n${JSON.stringify(retained.value, null, 2)}`,
  ];
}

/** The contributions the editor's response is built on, as invocation context. */
async function contributionsText(
  root: string,
  plan: IdeaRoundPlan,
  workId: string,
  task: IdeaEditorTask,
): Promise<string[]> {
  if (task !== 'edit') {
    return [];
  }
  const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
  const contributions: string[] = [];
  for (const [label, artifact, contract] of [
    ['Researcher', researchArtifact, ideaReportContracts.research],
    ['Project guide', projectGuideArtifact, ideaReportContracts.projectGuidance],
  ] as const) {
    const contribution = await readRetainedIdeaReport({
      root,
      workId,
      plan,
      cycleRoot,
      declaration: artifact,
      contract,
      context:
        `IdeaEditor reading the ${label} contribution of submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${workId}.`,
    });
    if (contribution === null) {
      throw new Error(
        `The refined idea needs the ${label.toLowerCase()} contribution of submission ` +
          `${String(plan.submission)} cycle ${String(plan.cycle)}.`,
      );
    }
    contributions.push(
      `${label} contribution: ${path.join(cycleRoot, artifact.pathFromArtifactsRoot)}\n` +
        JSON.stringify(contribution, null, 2),
    );
  }
  return contributions;
}

/** The focused contributions answering the editor's help request, as invocation context. */
async function focusedText(root: string, plan: IdeaRoundPlan, workId: string): Promise<string[]> {
  const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
  const focused: string[] = [];
  for (const [artifact, contract] of [
    [researchFollowUpArtifact, ideaReportContracts.research],
    [projectGuideFollowUpArtifact, ideaReportContracts.projectGuidance],
  ] as const) {
    const contribution = await readRetainedIdeaReport({
      root,
      workId,
      plan,
      cycleRoot,
      declaration: artifact,
      contract,
      context:
        `IdeaEditor reading the focused contribution of submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${workId}.`,
    });
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

/**
 * The Challenger result that opened the supplied cycle: the latest one strictly before that cycle,
 * which the cycle's editor turn answers. An unusable retained result is preserved under the
 * challenger's report responsibility before the read fails.
 */
async function latestChallengerBefore(
  root: string,
  plan: IdeaRoundPlan,
  workId: string,
): Promise<{ readonly path: string; readonly report: ChallengerReport } | null> {
  for (let number = plan.cycle - 1; number >= 1; number -= 1) {
    const cycleRoot = ideaCycleDirectory(root, plan.submission, number);
    const report = await readRetainedIdeaReport({
      root,
      workId,
      plan,
      cycleRoot,
      declaration: challengerArtifact,
      contract: ideaReportContracts.challenge,
      context:
        `IdeaEditor reading the Challenger result of submission ${String(plan.submission)} ` +
        `cycle ${String(number)} for idea ${workId}.`,
    });
    if (report !== null) {
      return { path: path.join(cycleRoot, challengerArtifact.pathFromArtifactsRoot), report };
    }
  }
  return null;
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
    const existing = await readRetainedIdeaReport({
      root,
      workId: taskKey,
      plan,
      cycleRoot,
      declaration: framingArtifact,
      contract: ideaReportContracts.framing,
      context:
        `IdeaEditor reading its retained framing of submission ${String(plan.submission)} ` +
        `cycle ${String(plan.cycle)} for idea ${taskKey}.`,
    });
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

    const outcome = await invokeIdeaRole({
      root,
      plan,
      role: 'idea-editor',
      operation: 'FrameIdea',
      reportKind: 'idea-framing',
      input,
      context,
      schema: framingResponseSchema,
      runner: settings.runner,
      publish: settings.publish,
    });
    const framing = outcome.report;
    await writeCycleArtifact(cycleRoot, framingArtifact, framing);
    await outcome.resolveFeedback({ path: file }, framing);
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
    const existing = await readRetainedIdeaReport({
      root,
      workId: taskKey,
      plan,
      cycleRoot,
      declaration: editorResponseArtifact,
      contract: ideaReportContracts.editorTurn,
      context:
        `IdeaEditor reading its retained turn of submission ${String(plan.submission)} ` +
        `cycle ${String(plan.cycle)} for idea ${taskKey}.`,
    });
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
    const input = await readIdeaInput(root, plan.submission);
    const projectGuidance = await projectGuidanceText(root);
    const context = [
      'Write the refined idea revision for the current captured idea from the contributions',
      'below. Its `idea` part states the author\u2019s proposed change, why it matters and the',
      'principle behind it; `projectFit` states why it belongs in this project; `feasibility`',
      'states a plausible way forward given the known constraints and evidence; `openQuestions`',
      'lists only the material questions the next workflow must answer and reports null when the',
      'revision states none.',
      'Preserve the author\u2019s intent and do not turn the idea into requirements, design',
      'decisions or an implementation plan. If pursuing the idea does not look sensible, return',
      'it as unsuitable with the author-facing reason; ask an essential author decision plainly',
      'when only the author can make it.',
      'This task returns "revised", "unsuitable" or "author-decision-needed" only. A revised ' +
        'turn carries the refinedIdea; an unsuitable or author-decision-needed return carries the ' +
        'author-facing reason and no refinedIdea, and reports help as null.',
      refinedIdeaDeliverableInstruction,
      await capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: null }),
      ...(await contributionsText(root, plan, input.taskKey, 'edit')),
      ...(projectGuidance === null ? [] : [projectGuidance]),
      ...(await recoveryText(root, plan, input.taskKey)),
      responseFormatText(editorTurnResponseSchema),
    ].join('\n\n');

    const outcome = await invokeIdeaRole({
      root,
      plan,
      role: 'idea-editor',
      operation: 'EditIdea',
      reportKind: 'idea-editor-turn',
      input,
      context,
      schema: editorTurnResponseSchema,
      runner: settings.runner,
      publish: settings.publish,
    });
    const problem = turnProblem('edit', outcome.report);
    if (problem !== null) {
      await outcome.reject(problem);
    }
    return persist(root, plan, input.taskKey, 'edit', outcome);
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
    const existing = await readRetainedIdeaReport({
      root,
      workId: taskKey,
      plan,
      cycleRoot,
      declaration: editorResponseArtifact,
      contract: ideaReportContracts.editorTurn,
      context:
        `IdeaEditor reading its retained turn of submission ${String(plan.submission)} ` +
        `cycle ${String(plan.cycle)} for idea ${taskKey}.`,
    });
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
    const help = await readRetainedIdeaReport({
      root,
      workId: taskKey,
      plan,
      cycleRoot,
      declaration: editorHelpArtifact,
      contract: ideaReportContracts.editorTurn,
      context:
        `IdeaEditor reading its retained help request of submission ${String(plan.submission)} ` +
        `cycle ${String(plan.cycle)} for idea ${taskKey}.`,
    });
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
    // The cycle was opened by the discussion the editor answers, which is the preceding cycle's
    // result: the current cycle's Challenger runs after this response.
    const discussion = await latestChallengerBefore(root, plan, taskKey);
    if (discussion === null) {
      throw new Error(
        `The editor responds to a Challenger result; submission ${String(plan.submission)} has ` +
          'none.',
      );
    }
    const revision = await readRetainedRefinedIdea({
      root,
      workId: taskKey,
      plan,
      submission: plan.submission,
      cycle: plan.cycle,
      context:
        `IdeaEditor reading the refined idea revision the Challenger discussed, submission ` +
        `${String(plan.submission)} cycle ${String(plan.cycle)} for idea ${taskKey}.`,
    });
    if (revision === null) {
      throw new Error(
        `The editor responds to the revision the Challenger discussed; submission ` +
          `${String(plan.submission)} has none.`,
      );
    }
    const input = await readIdeaInput(root, plan.submission);
    const focused = task === 'respond-after-help' ? await focusedText(root, plan, taskKey) : [];
    const guidance = await projectGuidanceText(root);
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
            'A help-requested turn names at least one focused question and reports null for the ' +
              'role it does not ask; every other disposition reports help as null. An unsuitable ' +
              'or author-decision-needed return carries the author-facing reason and no ' +
              'refinedIdea; answered, rebutted and help-requested turns report no refinedIdea.',
          ]),
      refinedIdeaDeliverableInstruction,
      await capturedIdeaText(root, plan, input),
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: null }),
      `The refined idea revision currently in force: ${revision.path}`,
      `The refined idea revision the Challenger assessed: ${discussion.report.refinedIdea}`,
      `The Challenger result to answer: ` +
        `${discussion.path}\n${JSON.stringify(discussion.report, null, 2)}`,
      ...focused,
      ...(guidance === null ? [] : [guidance]),
      ...(await recoveryText(root, plan, taskKey)),
      responseFormatText(editorTurnResponseSchema),
    ].join('\n\n');

    const outcome = await invokeIdeaRole({
      root,
      plan,
      role: 'idea-editor',
      operation: 'EditorResponse',
      reportKind: 'idea-editor-turn',
      input,
      context,
      schema: editorTurnResponseSchema,
      runner: settings.runner,
      publish: settings.publish,
    });
    const problem = turnProblem(task, outcome.report);
    if (problem !== null) {
      await outcome.reject(problem);
    }
    return persist(root, plan, taskKey, task, outcome);
  }

  /**
   * Save one editor turn: its short response always, its focused help request when it asks for
   * one, and the refined idea revision it wrote when it revised the idea. A revision gets its own
   * immutable artifact, so every earlier Challenger approval stays bound to the revision it
   * reviewed.
   */
  async function persist(
    root: string,
    plan: IdeaRoundPlan,
    workId: string,
    task: IdeaEditorTask,
    outcome: IdeaInvocationOutcome<typeof editorTurnResponseSchema>,
  ): Promise<string> {
    const { submission, cycle } = plan;
    const turn = outcome.report;
    const cycleRoot = ideaCycleDirectory(root, submission, cycle);
    const existing = await cycleRevision(root, plan, workId);
    if (
      existing !== null &&
      (turn.disposition !== 'revised' ||
        turn.refinedIdea === null ||
        !isDeepStrictEqual(existing.value, {
          ...turn.refinedIdea,
          openQuestions: turn.refinedIdea.openQuestions ?? [],
          revision: existing.value.revision,
          submission,
          cycle,
        }))
    ) {
      // The conflicting retry is rejected report evidence, not a silent execution error: the next
      // permitted turn must receive the retained revision and this reason.
      await outcome.reject(
        `The interrupted editor turn must complete the retained revision at "${existing.path}" ` +
          'without changing it; the retry response was not saved.',
      );
    }
    const returns =
      turn.disposition === 'unsuitable' || turn.disposition === 'author-decision-needed';
    const stored: EditorTurn = {
      disposition: turn.disposition,
      response: turn.response,
      reason: returns ? turn.reason : null,
      help: turn.disposition === 'help-requested' ? turn.help : null,
    };
    const inputRecord = await readIdeaInput(root, submission);
    const taskKey = inputRecord.taskKey;
    if (turn.disposition === 'help-requested') {
      const file = await writeCycleArtifact(cycleRoot, editorHelpArtifact, stored);
      await outcome.resolveFeedback({ path: file }, stored);
      return reported(taskKey, cycle, 'help-requested', null, file);
    }

    let revision: number | null = null;
    if (turn.disposition === 'revised') {
      if (turn.refinedIdea === null) {
        throw new Error('The editor revised the idea without returning the revision.');
      }
      if (existing === null) {
        revision = await nextRevision(root, plan, workId);
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
    await outcome.resolveFeedback({ path: file }, stored);
    const workflowOutcome =
      task === 'edit' ? editOutcome(turn.disposition) : responseOutcome(turn.disposition);
    return reported(
      taskKey,
      cycle,
      workflowOutcome,
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
