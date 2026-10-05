import { readFile } from 'node:fs/promises';
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
  preparationWorktree,
  readStageArtifact,
  readStagePlan,
  requireCurrentAcceptance,
  stageRoot,
  stageRounds,
  writeStageArtifact,
} from '../storage.js';

/**
 * StageResult saves the terminal result envelope of one evaluated preparation stage: its outcome,
 * the assessed authored revision, its output references, the evaluation reference and a concrete
 * reason with the upstream destination when one applies. The parent publication reads this saved
 * result; the child returns only its outcome and this reference. Acceptance validates the
 * evaluation's complete basis, so changed authored reports, inputs or assessed content cannot be
 * published from a stale decision.
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

/** True when the file's content still equals the content saved at one revision. */
async function retainedContentMatches(
  settings: { readonly git: GitAdapter; readonly worktree: string },
  relative: string,
  revision: string,
): Promise<boolean> {
  const saved = await settings.git.readFileAtRevision(settings.worktree, revision, relative);
  if (!saved.ok) return false;
  try {
    return (await readFile(path.join(settings.worktree, relative), 'utf8')) === saved.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
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
    const issueRoot = selection.workspace.root;
    const root = stageRoot(issueRoot, settings.stage);
    const worktree = preparationWorktree(issueRoot);
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
              sourcePaths: [],
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
      await requireCurrentAcceptance({
        issueRoot,
        stage: settings.stage,
        selection,
        round: plan.round,
        verdict,
        author,
        evaluation,
        git: settings.git,
      });
    }
    if (author.plan.length > 0) {
      // The implementation plan stays a stage artifact consumed through its own declaration; it
      // is not a changed authoritative document and never triggers documentation publication.
      await writeStageArtifact(root, plan.round, stagePlanArtifact, author.plan);
    }

    /** The assessed revision an authored round retained, or null for a reference-only skip. */
    const assessedRevision = (): string | null => {
      const revisions = new Set((evaluation?.basis.content ?? []).map((entry) => entry.revision));
      if (revisions.size > 1) {
        throw new Error('The evaluated content reports inconsistent repository revisions.');
      }
      return [...revisions][0] ?? null;
    };

    // The retained prototype implementation tickets reuse: the stage's evaluated revision, not
    // whatever HEAD later holds.
    let prototype: PreparationResult['prototype'] = null;
    if (outcome === 'accepted' && settings.stage === 'prototype') {
      const revision = assessedRevision();
      if (revision === null) {
        throw new Error('An accepted prototype must declare its retained source paths.');
      }
      const inspection = await settings.git.inspectRepository(worktree);
      if (!inspection.ok) throw new Error(inspection.fault.message);
      const branch = inspection.value.branch;
      if (branch === null) {
        throw new Error(
          `The preparation checkout at "${worktree}" retains no branch for implementation reuse.`,
        );
      }
      prototype = { branch, revision };
    }

    /** The accepted changed documents with the revision each was retained at. */
    const authoredDocuments: PreparationResult['documents'] =
      outcome === 'accepted'
        ? author.documents.map((document) => {
            const relative = path.relative(worktree, path.resolve(worktree, document.path));
            const entry = (evaluation?.basis.content ?? []).find(
              (candidate) => candidate.path === relative,
            );
            if (entry === undefined) {
              throw new Error(
                `The ${settings.stage} evaluation did not assess the declared document ` +
                  `"${document.path}".`,
              );
            }
            return { path: path.resolve(worktree, document.path), revision: entry.revision };
          })
        : [];

    // The stage-owned paths outside the authoritative documents stay on the retained branch.
    const sourcePaths: PreparationResult['sourcePaths'] =
      outcome === 'accepted'
        ? author.sourcePaths.map((value) => {
            const relative = path.relative(worktree, path.resolve(worktree, value));
            const entry = (evaluation?.basis.content ?? []).find(
              (candidate) => candidate.path === relative,
            );
            if (entry === undefined) {
              throw new Error(
                `The ${settings.stage} evaluation did not assess the declared source path ` +
                  `"${value}".`,
              );
            }
            return relative;
          })
        : [];

    // Existing authoritative documents an evaluated skip relied on, with their saved revisions.
    const existingDocuments: PreparationResult['existingDocuments'] = [];
    if (outcome === 'skipped') {
      for (const entry of evaluation?.basis.content ?? []) {
        if (!entry.exists) continue;
        existingDocuments.push({
          path: path.resolve(worktree, entry.path),
          revision: entry.revision,
        });
      }
    }

    // Only the immediately preceding round may supply reused assets. A later rejection or return
    // invalidates that acceptance; never search backwards past it for convenient work.
    const reusedDocuments: PreparationResult['documents'] = [];
    if (outcome === 'skipped') {
      const previousRound = (await stageRounds(root)).filter((round) => round < plan.round).at(-1);
      const previous =
        previousRound === undefined
          ? null
          : await readStageArtifact(root, previousRound, stageResultArtifact);
      if (
        previous !== null &&
        (previous.outcome === 'accepted' || previous.outcome === 'skipped')
      ) {
        const previousFile = path.join(
          root,
          'artifacts',
          String(previousRound),
          stageResultArtifact.pathFromArtifactsRoot,
        );
        const reusesResult = (author.skip?.references ?? []).some(
          (reference) => path.resolve(worktree, reference) === previousFile,
        );
        for (const document of previous.documents) {
          if (
            !reusesResult &&
            !(author.skip?.references ?? []).some(
              (reference) => path.resolve(worktree, reference) === document.path,
            )
          )
            continue;
          if (document.revision === null)
            throw new Error('Reused accepted content has no immutable revision.');
          const relative = path.relative(worktree, document.path);
          if (relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error(`Reused document "${document.path}" lies outside the checkout.`);
          if (
            !(await retainedContentMatches(
              { git: settings.git, worktree },
              relative,
              document.revision,
            ))
          )
            throw new Error('Reused document changed; a current decision is required.');
          reusedDocuments.push(document);
        }
        if (settings.stage === 'prototype' && previous.prototype !== null) {
          const reusesPrototype =
            reusesResult ||
            (author.skip?.references ?? []).some((reference) => {
              const file = path.resolve(worktree, reference);
              return (
                reference === previous.prototype?.revision ||
                reference === previous.prototype?.branch ||
                file === worktree ||
                existingDocuments.some((document) => path.resolve(document.path) === file)
              );
            });
          if (reusesPrototype) {
            const retainedPaths = new Set([
              ...previous.documents.map((document) => path.relative(worktree, document.path)),
              ...previous.sourcePaths,
            ]);
            for (const relative of retainedPaths) {
              if (
                !(await retainedContentMatches(
                  { git: settings.git, worktree },
                  relative,
                  previous.prototype.revision,
                ))
              )
                throw new Error(
                  'Retained prototype content changed; fresh observation is required.',
                );
            }
            prototype = previous.prototype;
          }
        }
      }
    }

    const documents: PreparationResult['documents'] = [...authoredDocuments, ...reusedDocuments];
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
      sourcePaths,
      skipReferences: outcome === 'skipped' ? (author.skip?.references ?? []) : [],
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
