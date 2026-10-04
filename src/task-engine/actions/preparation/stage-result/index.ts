import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../../index.js';
import { readRecord, readRequiredRecord, writeRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import { terminalReasonSchema } from '../../terminal-reason.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stagePlanArtifact,
  stageResultArtifact,
  stageTerminalDeclaration,
  stageReturnExhaustionFile,
  stageRoundExhaustionFile,
  type PreparationResult,
  type PreparationStage,
} from '../artifacts.js';
import {
  readStageArtifact,
  readStagePlan,
  stageRoot,
  stageWorktree,
  writeStageArtifact,
} from '../storage.js';

/**
 * StageResult saves the terminal result envelope of one evaluated preparation stage: its outcome,
 * the assessed authored revision, its output references, the evaluation reference and a concrete
 * reason with the upstream destination when one applies. The parent publication reads this saved
 * result; the child returns only its outcome and this reference.
 */

export type StageResultSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /** The Git capability that observes the stage worktree revision the documents carry. */
  readonly git: GitAdapter;
  readonly publish: EventPublisher;
};

/** The terminal outcome the preparation workflow supplied with the invocation. */
function outcomeOf(input: unknown): PreparationResult['outcome'] {
  const outcome =
    typeof input === 'object' && input !== null
      ? (input as { readonly outcome?: unknown }).outcome
      : undefined;
  const known = ['accepted', 'skipped', 'returnUpstream', 'needsInput', 'exhausted'] as const;
  const found = known.find((candidate) => candidate === outcome);
  if (found === undefined) {
    throw new Error(
      `The preparation workflow supplied StageResult the unknown outcome ${JSON.stringify(outcome)}.`,
    );
  }
  return found;
}

/** One retained exhaustion reason for this stage, or null when none exists. */
async function readExhaustionReason(root: string): Promise<string | null> {
  for (const file of [stageRoundExhaustionFile, stageReturnExhaustionFile]) {
    const record = await readRecord(path.join(root, file), {
      file,
      schema: terminalReasonSchema,
    });
    if (record !== null) {
      return record.reason;
    }
  }
  return null;
}

/** Create StageResult over the stage area it finalizes. */
export function createStageResult(settings: StageResultSettings): BoundAction {
  return async (input?: unknown) => {
    const outcome = outcomeOf(input);
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = stageRoot(selection.workspace.root, settings.stage);
    const worktree = stageWorktree(selection.workspace.root, settings.stage);
    const plan = await readStagePlan(root);
    if (plan === null || plan.stage !== settings.stage) {
      throw new Error(`No ${settings.stage} round plan exists under "${root}" to finalize.`);
    }
    const completed = await readStageArtifact(root, plan.round, stageResultArtifact);
    if (completed !== null) {
      if (outcome !== completed.outcome && outcome !== 'exhausted') {
        throw new Error(
          'A completed preparation round cannot be rewritten with a different result.',
        );
      }
      const terminal =
        outcome === 'exhausted'
          ? {
              ...completed,
              outcome,
              reason: await readExhaustionReason(root),
              documents: [],
              existingDocuments: [],
              skipReferences: [],
              outputs: [],
              prototype: null,
              returnStage: null,
              returnFinding: null,
            }
          : completed;
      await writeRecord(path.join(root, stageTerminalDeclaration.file), terminal);
      settings.publish(
        actionOutcomeEvent('stage-result', {
          task: selection.taskKey,
          round: plan.round,
          outcome,
          detail: settings.stage,
          artifact: { path: path.join(root, stageTerminalDeclaration.file) },
        }),
      );
      return 'saved';
    }
    const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
    if (author === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'report.',
      );
    }
    const evaluation = await readStageArtifact(root, plan.round, stageEvaluationArtifact);
    const upstream = evaluation?.upstream ?? author.upstream;
    const reason =
      outcome === 'skipped'
        ? (author.skip?.reason ?? evaluation?.reason ?? author.summary)
        : outcome === 'returnUpstream'
          ? upstream === null
            ? author.summary
            : `${upstream.problem}; needed correction: ${upstream.correction}`
          : outcome === 'needsInput'
            ? (author.question ?? author.summary)
            : outcome === 'exhausted'
              ? ((await readExhaustionReason(root)) ?? evaluation?.reason ?? author.summary)
              : (evaluation?.reason ?? author.summary);

    if (outcome === 'accepted' || outcome === 'skipped') {
      const verdict = outcome === 'accepted' ? 'accepted' : 'accepted-skip';
      if (evaluation?.assessedRevision !== author.revision || evaluation.verdict !== verdict) {
        throw new Error(
          'Acceptance requires evaluation of the exact authored revision and applicability.',
        );
      }
    }
    if (author.plan.length > 0) {
      // The implementation plan stays a stage artifact consumed through its own declaration; it
      // is not a changed authoritative document and never triggers documentation publication.
      await writeStageArtifact(root, plan.round, stagePlanArtifact, author.plan);
    }
    // The stage worktree observation behind the result: the revision the changed documents carry
    // and, for built Storybook work, the retained prototype implementation tickets reuse.
    const inspectWorktree =
      settings.stage === 'prototype' ? author.outcome === 'authored' : author.documents.length > 0;
    let revision: string | null = null;
    let prototype: PreparationResult['prototype'] = null;
    if (inspectWorktree && outcome === 'accepted') {
      const paths =
        settings.stage === 'prototype' ? ['.'] : author.documents.map((document) => document.path);
      for (const file of paths) {
        const relative = path.relative(worktree, path.resolve(worktree, file));
        if (path.isAbsolute(relative) || relative.startsWith('..')) {
          throw new Error(`Accepted document "${file}" lies outside its worktree.`);
        }
      }
      const committed = await settings.git.commitPaths(
        worktree,
        paths,
        `Retain accepted ${settings.stage} content for ${selection.taskKey}`,
      );
      if (!committed.ok) throw new Error(committed.fault.message);
      const inspection = await settings.git.inspectRepository(worktree);
      if (!inspection.ok) {
        throw new Error(inspection.fault.message);
      }
      revision = inspection.value.headRevision;
      if (revision === null) throw new Error('Accepted content has no saved repository revision.');
      for (const document of author.documents) {
        const saved = await settings.git.readFileAtRevision(worktree, revision, document.path);
        if (!saved.ok) throw new Error(saved.fault.message);
        if (saved.value !== (await readFile(path.resolve(worktree, document.path), 'utf8'))) {
          throw new Error(
            `Accepted document "${document.path}" does not match its saved revision.`,
          );
        }
      }
      if (settings.stage === 'prototype') {
        const { branch, headRevision } = inspection.value;
        if (branch === null || headRevision === null) {
          throw new Error(
            `The prototype worktree at "${worktree}" retains no branch and revision for ` +
              'implementation reuse.',
          );
        }
        prototype = { branch, revision: headRevision };
      }
    }
    const existingDocuments: PreparationResult['existingDocuments'] = [];
    const skipReferences = outcome === 'skipped' ? (author.skip?.references ?? []) : [];
    if (skipReferences.length > 0) {
      const inspection = await settings.git.inspectRepository(worktree);
      if (!inspection.ok) throw new Error(inspection.fault.message);
      const head = inspection.value.headRevision;
      for (const reference of skipReferences) {
        const file = path.resolve(worktree, reference);
        const relative = path.relative(worktree, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        try {
          if (!(await stat(file)).isFile()) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (head === null)
          throw new Error('Existing authoritative documents need a saved revision.');
        const saved = await settings.git.readFileAtRevision(worktree, head, relative);
        if (!saved.ok) throw new Error(saved.fault.message);
        if (saved.value !== (await readFile(file, 'utf8'))) {
          throw new Error(
            `Existing document "${relative}" differs from its accepted repository revision.`,
          );
        }
        existingDocuments.push({ path: file, revision: head });
      }
    }
    const documents: PreparationResult['documents'] = (
      outcome === 'accepted' ? author.documents : []
    ).map((document) => ({
      path: path.resolve(worktree, document.path),
      revision,
    }));
    const outputs: PreparationResult['outputs'] = documents.map((document) => ({
      path: document.path,
    }));
    const evaluationRef = path.join(
      root,
      'artifacts',
      String(plan.round),
      evaluation === null
        ? stageAuthorArtifact.pathFromArtifactsRoot
        : stageEvaluationArtifact.pathFromArtifactsRoot,
    );
    const result: PreparationResult = {
      stage: settings.stage,
      outcome,
      authoredRevision: author.revision,
      documents,
      existingDocuments,
      skipReferences,
      outputs,
      evaluation: { path: evaluationRef },
      reason,
      returnStage: outcome === 'returnUpstream' ? (upstream?.stage ?? null) : null,
      returnFinding: outcome === 'returnUpstream' ? upstream : null,
      prototype,
    };
    if (result.outcome === 'returnUpstream' && result.returnStage === null) {
      throw new Error(
        `The ${settings.stage} stage cannot return upstream without naming the earlier stage.`,
      );
    }
    await writeStageArtifact(root, plan.round, stageResultArtifact, result);
    await writeRecord(path.join(root, stageTerminalDeclaration.file), result);
    const artifact = path.join(
      root,
      'artifacts',
      String(plan.round),
      stageResultArtifact.pathFromArtifactsRoot,
    );
    settings.publish(
      actionOutcomeEvent('stage-result', {
        task: selection.taskKey,
        round: plan.round,
        outcome,
        detail: `${settings.stage} · revision ${String(author.revision)}`,
        artifact: { path: artifact },
      }),
    );
    return 'saved';
  };
}
