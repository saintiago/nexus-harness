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
  preparationStages,
  stageAuthorArtifact,
  stageResultArtifact,
  type PreparationStage,
  type StageAuthorOutput,
  type StageEvaluationOutput,
  type StageRoundPlan,
} from './artifacts.js';
import { stageRoot, readStagePlan } from './storage.js';

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

/** One earlier stage's retained result and author references that a later stage may read. */
export async function upstreamReferences(
  issueRoot: string,
  stage: PreparationStage,
): Promise<{ readonly stage: PreparationStage; readonly lines: string[] }[]> {
  const references: { readonly stage: PreparationStage; readonly lines: string[] }[] = [];
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
    const result = await readStageArtifactFile(
      root,
      plan.round,
      stageResultArtifact.pathFromArtifactsRoot,
    );
    if (result !== null) {
      lines.push(`${earlier} accepted result: ${result}`);
    }
    const author = await readStageArtifactFile(
      root,
      plan.round,
      stageAuthorArtifact.pathFromArtifactsRoot,
    );
    if (author !== null) {
      lines.push(`${earlier} author revision: ${author}`);
    }
    if (lines.length > 0) {
      references.push({ stage: earlier, lines });
    }
  }
  return references;
}

/** One stage artifact's filepath when it exists, or null. */
async function readStageArtifactFile(
  root: string,
  round: number,
  relative: string,
): Promise<string | null> {
  const file = path.join(root, 'artifacts', String(round), relative);
  return (await readDocumentText(file, 'Artifact')) === null ? null : file;
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
