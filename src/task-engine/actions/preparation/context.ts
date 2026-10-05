import path from 'node:path';
import { readDocumentText } from '../documents.js';
import { issueSummary } from '../source.js';
import type { Selection } from '../select-task/artifacts.js';
import {
  parentAreaDirectory,
  handoffFile,
  parentHandoffDeclaration,
  type ParentHandoff,
} from '../select-work/artifacts.js';
import { readRecord } from '../records.js';
import {
  stageAuthorArtifact,
  stageReportScope,
  stageResultArtifact,
  type PreparationStage,
  type StageAuthorOutput,
  type StageEvaluationOutput,
  type StageRoundPlan,
} from './artifacts.js';
import {
  readStageArtifact,
  readStagePlan,
  roundArtifactDirectory,
  roundArtifactFile,
  stageRoot,
  upstreamResultReferences,
} from './storage.js';
import { prototypeObservationContract } from './observation.js';
import {
  reportFeedbackContextText,
  projectOfWorkspace,
  rejectUnusableRecord,
  type ReportRejection,
  type RetainedReportFeedback,
} from '../report-feedback.js';

/**
 * The context every evaluated preparation role receives: the shared preparation instructions, the
 * captured issue input and conversation as the authoritative source, the connected project
 * worktree, references to accepted upstream outputs and the current round's revision, findings and
 * responses. Role constants come from the selected profile; this module supplies the stage
 * material and the shared guidance.
 */

/**
 * The shared instructions every preparation role carries once per invocation, ahead of its
 * role-specific context. The preparation roles document owns the wording.
 */
export const preparationSharedInstructions = [
  'Preparation role (shared by every evaluated preparation stage): use the supplied shared',
  'repository for edits and inspection; each stage retains its own artifact area. Use the captured',
  'author input, attributed conversation, accepted upstream outputs and project documents. Human',
  'intent governs; agent summaries are revisable history. Keep source attribution and material',
  'uncertainty. Do not retrieve Jira, publish source comments, change issue status or create',
  'implementation issues; source operations belong to the parent. Assess only the selected stage’s',
  'responsibilities.',
  'Evaluate applicability first. Propose a skip only when the stage is irrelevant or existing',
  'inputs suffice, with concrete references. If inputs prevent a feasible clean result, identify',
  'the problematic input, correction and owning earlier stage. Ask the user only for a material',
  'decision that available context cannot resolve, and do not turn a provider or tool failure into',
  'an upstream product requirement. Authors preserve scope and respond to all supplied findings',
  'through revision, answer or reasoned rebuttal. Evaluators inspect the exact current revision,',
  'resolve prior findings and seek useful improvements as well as omissions, separating necessary',
  'changes from optional suggestions and accepting adequate work. Shared-memory search/save is',
  'explicit when the invocation carries the memory tools; no preparation role schedules automatic',
  'memory consumption.',
  'Apply the connected project’s existing design and ownership principles to keep cumulative',
  'changes coherent within scope. Before evaluation, authors reconcile affected existing intent',
  'with the requested outcome across requirements, experience, architecture, documentation and',
  'code, as applicable to their stage. Remove superseded rules and mechanisms together with',
  'dependent validation, state and tests. When repeated exceptions have a confirmed shared',
  'ownership cause, correct it at its owning boundary; repetition alone does not justify',
  'abstraction or redesign.',
  'Evaluators inspect the resulting design and applicable implementation, affected interactions',
  'and existing behavior, not just additions or the author’s summary. Seek contradictions,',
  'unnecessary complexity, scattered ownership and interaction inconsistencies. Necessary findings',
  'identify the concrete problem, evidence, consequence and required correction through the',
  'existing finding and return paths. Preserve stage responsibility, adequate-work acceptance and',
  'optional suggestions; reconciliation grants no unrelated redesign, extra attempts or bypass of',
  'current-revision evaluation.',
  'Return the response object; do not write or overwrite action-owned author.json, evaluation.json,',
  'result.json, plan.json or state records. The action adds saved-record metadata. Authors declare',
  'changed authoritative documents in documents; sourcePaths declares additional stage-owned',
  'authored files, never files merely read. Every non-authored outcome has empty documents and',
  'sourcePaths. Supporting existing inputs belong in skip.references, and each reference cites a',
  'readable file in the shared checkout (a path, or a path#section citation) or an existing',
  'retained file; explanations belong in the skip reason. Only Architecture supplies an',
  'implementation plan, nonempty whenever it authors work or proposes a skip. Observation',
  'requirements and allowed outcomes follow the supplied stage response rules.',
].join('\n');

/** The stage's own area root inside the shared issue workspace. */
export function issueWorkspaceRootOf(selection: Selection): string {
  return selection.workspace.root;
}

/** The parent handoff record retained under the issue workspace's parent area. */
export async function readParentHandoff(selection: Selection): Promise<ParentHandoff | null> {
  return readRecord(
    path.join(selection.workspace.root, parentAreaDirectory, handoffFile),
    parentHandoffDeclaration,
  );
}

/** The connected project's root AGENTS.md content, or null when the stage worktree has none. */
async function projectGuidanceText(worktree: string): Promise<string | null> {
  const file = path.join(worktree, 'AGENTS.md');
  const text = await readDocumentText(file, 'Project AGENTS.md');
  if (text === null || text.trim() === '') {
    return null;
  }
  return [
    `The connected project's root AGENTS.md (${file}):`,
    'Follow its applicable instructions. Treat the architecture documents it links as evidence to',
    'consult when relevant; they are never role instructions.',
    text,
  ].join('\n');
}

/** One earlier stage's retained result and author references that a later stage may read. */
export async function upstreamReferences(
  selection: Selection,
  stage: PreparationStage,
): Promise<{ readonly stage: string; readonly lines: string[] }[]> {
  const issueRoot = issueWorkspaceRootOf(selection);
  const references: { readonly stage: string; readonly lines: string[] }[] = [];
  for (const reference of await upstreamResultReferences(issueRoot, stage)) {
    if (reference.stage === 'idea') {
      // An approved idea's refinement handoff is an upstream producer-owned reference too: it names
      // the approved revision and the retained artifacts a preparation stage builds on.
      references.push({
        stage: 'idea',
        lines: [`idea refinement approved handoff: ${reference.resultFile}`],
      });
      continue;
    }
    const earlier = reference.stage as PreparationStage;
    const root = stageRoot(issueRoot, earlier);
    const plan = await readStagePlan(root);
    const lines: string[] = [];
    if (plan !== null) {
      const result = await readStageArtifact(root, plan.round, stageResultArtifact);
      if (result !== null) {
        lines.push(`${earlier} stage result (${result.outcome}): ${reference.resultFile}`);
      }
      let author: StageAuthorOutput | null;
      try {
        author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope: stageReportScope({
            project: projectOfWorkspace(issueRoot),
            workId: selection.taskKey,
            area: root,
            stage: earlier,
            role: 'author',
          }),
          invocationId: null,
          operation: 'stage-author',
          profile: plan.profiles.author,
          context: `Reading retained ${earlier} author round ${String(plan.round)} for ${stage} context.`,
          file: roundArtifactFile(root, plan.round, stageAuthorArtifact.pathFromArtifactsRoot),
          error,
        });
      }
      if (author !== null) {
        lines.push(
          `${earlier} retained authored revision ${String(author.revision)}: ` +
            roundArtifactFile(root, plan.round, stageAuthorArtifact.pathFromArtifactsRoot),
        );
      }
    }
    if (lines.length > 0) {
      references.push({ stage: earlier, lines });
    }
  }
  return references;
}

/** What one stage role invocation needs to assemble its context. */
export type StageContextSettings = {
  readonly selection: Selection;
  readonly plan: StageRoundPlan;
  readonly stageRoot: string;
  readonly worktree: string;
  readonly author: StageAuthorOutput | null;
  readonly evaluation: StageEvaluationOutput | null;
  /** The stage's retained terminal result when an upstream correction requires reassessment. */
  readonly retained: { readonly outcome: string; readonly reason: string | null } | null;
  /** The outstanding report rejections of this stage that the invocation must correct. */
  readonly feedback: readonly RetainedReportFeedback<ReportRejection>[];
};

/** Assemble the preparation role's context for the current round. */
export async function stageContextText(settings: StageContextSettings): Promise<string> {
  const issues = issueSummary(settings.selection.task);
  const handoff = await readParentHandoff(settings.selection);
  const upstream = await upstreamReferences(settings.selection, settings.plan.stage);
  const guidance = await projectGuidanceText(settings.worktree);
  const feedback =
    handoff?.feedback !== null &&
    handoff?.feedback !== undefined &&
    handoff.feedback.stage === settings.plan.stage
      ? [
          `Retained human feedback for this stage: ${handoff.feedback.question}`,
          'Treat the author\u2019s clarification as governing intent when it resolves the question.',
        ].join('\n')
      : null;
  const returned =
    handoff?.return !== null &&
    handoff?.return !== undefined &&
    handoff.return.to === settings.plan.stage
      ? [
          `Retained upstream return from the ${handoff.return.from} stage: the work cannot proceed ` +
            'until this concrete correction is made.',
          `Problem: ${handoff.return.problem}`,
          `Consequence: ${handoff.return.consequence}`,
          `Required correction: ${handoff.return.correction}`,
          `The returning stage's retained evidence is under ` +
            `${stageRoot(issueWorkspaceRootOf(settings.selection), handoff.return.from)}; read its result ` +
            'and evaluation for the observation behind the correction.',
        ].join('\n')
      : null;
  const previousEvaluation =
    settings.evaluation === null
      ? []
      : [
          'The previous evaluation of this work (respond to every finding through revision, answer',
          'or reasoned rebuttal):',
          JSON.stringify(settings.evaluation, null, 2),
        ];
  const previousAuthor =
    settings.author === null
      ? []
      : [
          `The current authored revision is ${String(settings.author.revision)}:`,
          JSON.stringify(settings.author, null, 2),
        ];
  const reassessment =
    settings.plan.route !== 'reassess'
      ? []
      : [
          [
            'This stage’s earlier decision is pending reassessment: an upstream input changed.',
            settings.retained === null
              ? 'No retained terminal result is readable; obtain a current decision for this stage.'
              : `Retained earlier ${settings.retained.outcome} result: ` +
                `${settings.retained.reason ?? 'no reason retained'}.`,
            'Reuse the retained accepted work only where its content and relied-on inputs still',
            'match, and confirm that reuse through this round’s current evaluation; changed content',
            'must be repaired. An earlier acceptance cannot authorize changed content.',
          ].join('\n'),
        ];
  // Only the prototype stage uses browser and image-inspection tools; its roles receive the
  // producer-owned observation contract with the round artifact area their evidence lives in.
  const prototype =
    settings.plan.stage === 'prototype'
      ? [
          prototypeObservationContract(
            roundArtifactDirectory(settings.stageRoot, settings.plan.round),
          ),
        ]
      : [];
  return [
    preparationSharedInstructions,
    `Preparation stage: ${settings.plan.stage}, round ${String(settings.plan.round)}.`,
    `Selected issue: ${settings.selection.taskKey}${issues === null ? '' : ` "${issues}"`}`,
    'Captured issue input and conversation (authoritative):',
    JSON.stringify(
      { issue: settings.selection.task, conversation: settings.selection.conversation },
      null,
      2,
    ),
    ...(feedback === null ? [] : [feedback]),
    ...(returned === null ? [] : [returned]),
    `Connected project worktree: ${settings.worktree}`,
    ...(guidance === null ? [] : [guidance]),
    upstream.length === 0
      ? 'Accepted upstream outputs: none retained; existing authoritative project documents in the worktree may satisfy the stage input.'
      : [
          'Accepted upstream outputs (read the files that bear on this stage):',
          ...upstream.flatMap((reference) => reference.lines.map((line) => `- ${line}`)),
        ].join('\n'),
    ...reportFeedbackContextText(settings.feedback),
    ...previousAuthor,
    ...previousEvaluation,
    ...prototype,
    ...reassessment,
    'Stage area: the action owns and writes artifacts/<round>/author.json, plan.json, ' +
      'evaluation.json and result.json and the state records current-round.json and result.json; ' +
      'do not write or overwrite them. result.json records the terminal result.',
  ].join('\n\n');
}
