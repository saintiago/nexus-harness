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
import { handoffSchema, ideaHandoffFile } from '../publish-decision/artifacts.js';
import { readRecord } from '../records.js';
import {
  preparationStages,
  stageAuthorArtifact,
  stageResultArtifact,
  type PreparationStage,
  type StageAuthorOutput,
  type StageEvaluationOutput,
  type StageRoundPlan,
} from './artifacts.js';
import { readStageArtifact, readStagePlan, stageRoot } from './storage.js';

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
  'Preparation role (shared by every evaluated preparation stage): use the connected worktree,',
  'the captured author input, attributed conversation, accepted upstream outputs and project',
  'documents. Human intent governs; agent summaries are revisable history. Keep source attribution',
  'and material uncertainty. Do not retrieve Jira, publish source comments, change issue status or',
  'create implementation issues; source operations belong to the parent.',
  'Evaluate applicability first. Propose a skip only when the stage is irrelevant or existing',
  'inputs suffice, with concrete references. If inputs prevent a feasible clean result, identify',
  'the problematic input, correction and owning earlier stage. Ask the user only for a material',
  'decision that available context cannot resolve, and do not turn a provider or tool failure into',
  'an upstream product requirement. Authors preserve scope and respond to all supplied findings',
  'through revision, answer or reasoned rebuttal. Evaluators inspect the exact current revision,',
  'resolve prior findings and seek useful improvements as well as omissions, separating necessary',
  'changes from optional suggestions and accepting adequate work.',
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

/** The refinement area under the issue workspace root (Workspace design). */
const refinementArea = 'refinement';

/** One earlier stage's retained result and author references that a later stage may read. */
export async function upstreamReferences(
  issueRoot: string,
  stage: PreparationStage,
): Promise<{ readonly stage: string; readonly lines: string[] }[]> {
  const references: { readonly stage: string; readonly lines: string[] }[] = [];
  // An approved idea's refinement handoff is an upstream producer-owned reference too: it names
  // the approved revision and the retained artifacts a preparation stage builds on.
  const ideaHandoff = path.join(issueRoot, refinementArea, ideaHandoffFile);
  const approvedIdea = await readRecord(ideaHandoff, {
    file: ideaHandoffFile,
    schema: handoffSchema,
  });
  if (approvedIdea !== null) {
    references.push({
      stage: 'idea',
      lines: [`idea refinement approved handoff: ${ideaHandoff}`],
    });
  }
  for (const earlier of preparationStages) {
    if (earlier === stage) {
      break;
    }
    const root = stageRoot(issueRoot, earlier);
    const plan = await readStagePlan(root);
    if (plan === null) {
      continue;
    }
    const lines: string[] = [];
    // Read each retained result through its producer declaration: its outcome says whether the
    // stage accepted, skipped, returned or exhausted the work, so a consumer is never directed to
    // a result presented as accepted when it was not.
    const result = await readStageArtifact(root, plan.round, stageResultArtifact);
    if (result !== null) {
      lines.push(
        `${earlier} stage result (${result.outcome}): ` +
          roundArtifactFile(root, plan.round, stageResultArtifact.pathFromArtifactsRoot),
      );
    }
    const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
    if (author !== null) {
      lines.push(
        `${earlier} retained authored revision ${String(author.revision)}: ` +
          roundArtifactFile(root, plan.round, stageAuthorArtifact.pathFromArtifactsRoot),
      );
    }
    if (lines.length > 0) {
      references.push({ stage: earlier, lines });
    }
  }
  return references;
}

/** One stage round artifact's filepath. */
function roundArtifactFile(root: string, round: number, relative: string): string {
  return path.join(root, 'artifacts', String(round), relative);
}

/** What one stage role invocation needs to assemble its context. */
export type StageContextSettings = {
  readonly selection: Selection;
  readonly plan: StageRoundPlan;
  readonly stageRoot: string;
  readonly worktree: string;
  readonly author: StageAuthorOutput | null;
  readonly evaluation: StageEvaluationOutput | null;
};

/** Assemble the preparation role's context for the current round. */
export async function stageContextText(settings: StageContextSettings): Promise<string> {
  const issues = issueSummary(settings.selection.task);
  const handoff = await readParentHandoff(settings.selection);
  const upstream = await upstreamReferences(
    issueWorkspaceRootOf(settings.selection),
    settings.plan.stage,
  );
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
    ...previousAuthor,
    ...previousEvaluation,
    'Stage area: each round keeps author.json and evaluation.json under artifacts/<round>/; result.json records the terminal result.',
  ].join('\n\n');
}
