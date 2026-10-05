import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../../index.js';
import { readRecord, readRequiredRecord, writeRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import { terminalReasonSchema } from '../../terminal-reason.js';
import { requireEvaluationContent } from '../evaluation-content.js';
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
  reusedPreparationContent,
  requireCurrentAcceptance,
  roundArtifactDirectory,
  stageRoot,
  writeStageArtifact,
} from '../storage.js';
import { evidenceFilePath, requireRetainedPrototypeEvidence } from '../observation.js';

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
      if (
        outcome !== 'exhausted' &&
        settings.stage === 'prototype' &&
        (completed.outcome === 'accepted' || completed.prototype !== null)
      ) {
        const evaluation = await readStageArtifact(root, plan.round, stageEvaluationArtifact);
        if (evaluation === null) {
          throw new Error('A retained prototype must keep its evaluated decision.');
        }
        await requireRetainedPrototypeEvidence({
          git: settings.git,
          worktree,
          artifactsRoot: path.join(root, 'artifacts'),
          observations: completed.prototypeObservations,
          assessed: evaluation.basis.content,
          observedPaths: completed.sourcePaths,
        });
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
              prototypeObservations: [],
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
      // is not a changed authoritative document and never joins the accepted document set.
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
    /** The author's and the evaluator's retained observation records for an accepted prototype. */
    const retainedObservations: PreparationResult['prototypeObservations'] = [];
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
      const roundDirectory = roundArtifactDirectory(root, plan.round);
      const declared = [
        ['author', author.observation?.path ?? null],
        ['evaluator', evaluation?.observation?.path ?? null],
      ] as const;
      for (const [role, declaredPath] of declared) {
        if (declaredPath === null) {
          throw new Error(
            `An accepted prototype must retain the ${role}'s observation record and none was ` +
              'declared.',
          );
        }
        const file = evidenceFilePath(roundDirectory, declaredPath);
        if (file === null) {
          throw new Error(
            `The ${role}'s prototype observation "${declaredPath}" lies outside the round ` +
              `artifact area "${roundDirectory}".`,
          );
        }
        retainedObservations.push({ role, path: file });
      }
      if (evaluation === null) {
        throw new Error('An accepted prototype must retain the evaluated decision it relies on.');
      }
      // Retained references are not enough: the records and screenshots must still be readable and
      // bound to the assessed content when the acceptance is finalized.
      await requireRetainedPrototypeEvidence({
        git: settings.git,
        worktree,
        artifactsRoot: path.join(root, 'artifacts'),
        observations: retainedObservations,
        assessed: evaluation.basis.content,
        observedPaths: author.sourcePaths,
      });
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

    // Only the immediately preceding round may supply reused assets. A later rejection or return
    // invalidates that acceptance; never search backwards past it for convenient work. The reused
    // content must still match the acceptance it came from, and this round's decision must bind it.
    const reuse = await reusedPreparationContent({
      root,
      round: plan.round,
      worktree,
      stage: settings.stage,
      references: outcome === 'skipped' ? (author.skip?.references ?? []) : [],
    });
    if (outcome === 'skipped') {
      await requireEvaluationContent({ git: settings.git, worktree, content: reuse.content });
      const bound = new Set((evaluation?.basis.content ?? []).map((entry) => entry.path));
      for (const relative of reuse.paths) {
        if (!bound.has(relative)) {
          throw new Error(
            `The ${settings.stage} evaluation does not bind the reused content "${relative}"; ` +
              'a current decision is required.',
          );
        }
      }
    }

    // The stage-owned paths outside the authoritative documents stay on the retained branch: the
    // authored source paths, plus the source paths a skip reuses from the preceding acceptance.
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
        : [...reuse.sourcePaths];

    // Existing authoritative documents an evaluated skip relied on that this round does not
    // already report as reused documents, with their saved revisions.
    const existingDocuments: PreparationResult['existingDocuments'] = [...reuse.existingDocuments];
    if (outcome === 'skipped') {
      const reused = new Set(reuse.paths.map((relative) => path.resolve(worktree, relative)));
      for (const entry of evaluation?.basis.content ?? []) {
        if (!entry.exists) continue;
        if (reused.has(path.resolve(worktree, entry.path))) continue;
        existingDocuments.push({
          path: path.resolve(worktree, entry.path),
          revision: entry.revision,
        });
      }
    }

    if (outcome === 'skipped' && settings.stage === 'prototype') {
      // A reused acceptance keeps the prototype implementation tickets reference; changed
      // prototype content cannot pass the reuse validation above.
      prototype = reuse.prototype;
      retainedObservations.length = 0;
      retainedObservations.push(...reuse.prototypeObservations);
      if (prototype !== null) {
        // Reuse copies references; the retained records themselves must still be readable evidence
        // for the acceptance they came from, or the skip cannot keep authorizing the prototype.
        await requireRetainedPrototypeEvidence({
          git: settings.git,
          worktree,
          artifactsRoot: path.join(root, 'artifacts'),
          observations: retainedObservations,
          assessed: reuse.content,
          observedPaths: reuse.sourcePaths,
        });
      }
    }

    const documents: PreparationResult['documents'] = [...authoredDocuments, ...reuse.documents];
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
      prototypeObservations: retainedObservations,
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
