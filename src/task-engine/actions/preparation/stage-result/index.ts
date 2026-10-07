import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../../index.js';
import { readRecord, readRequiredRecord, writeRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import { terminalReasonSchema } from '../../terminal-reason.js';
import {
  isBoundStageAuthorOutput,
  isBoundStageEvaluationOutput,
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stagePlanArtifact,
  stageResultArtifact,
  stageTerminalDeclaration,
  stageReturnExhaustionFile,
  stageRoundExhaustionFile,
  type PreparationResult,
  type ReturnReport,
  type PreparationStage,
} from '../artifacts.js';
import {
  clearStageReportValidationError,
  preparationWorktree,
  readStageArtifact,
  readStageRoleArtifact,
  readStagePlan,
  requireCurrentAcceptance,
  requireRetainedDecision,
  requireRetainedResultAssociation,
  requireReturnReport,
  requireStageReport,
  requireNeedsInputReport,
  roundArtifactDirectory,
  roundArtifactFile,
  stageRoot,
  writeStageArtifact,
} from '../storage.js';
import { evidenceFilePath, requireRetainedPrototypeEvidence } from '../observation.js';

/**
 * StageResult saves the terminal result envelope of one evaluated preparation stage: its outcome,
 * the assessed authored revision, its output references, the evaluation reference, the
 * action-observed reason for a question or exhaustion, and the upstream destination, correction
 * and returning Markdown report when one applies. The parent publication reads this saved result;
 * the child returns only its outcome and this reference. Acceptance validates the evaluation's
 * complete basis — the authored outcome, captured source input, relied-on upstream results and
 * observed repository revision — so changed input or authored work cannot be published from a
 * stale decision.
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
    const roleContext = {
      issueRoot,
      stage: settings.stage,
      workId: selection.taskKey,
      round: plan.round,
      context: `Finalizing ${settings.stage} round ${String(plan.round)} for task ${selection.taskKey}.`,
    };
    const readAuthor = () =>
      readStageRoleArtifact({
        ...roleContext,
        role: 'author',
        profile: plan.profiles.author,
      });
    const readEvaluation = () =>
      readStageRoleArtifact({
        ...roleContext,
        role: 'evaluator',
        profile: plan.profiles.evaluator,
      });
    const completed = await readStageArtifact(root, plan.round, stageResultArtifact);
    if (completed !== null) {
      if (outcome !== completed.outcome && outcome !== 'exhausted') {
        throw new Error(
          'A completed preparation round cannot be rewritten with a different result.',
        );
      }
      // The roles whose current-round saved outcome this replay validates. Clearing their pending
      // validation-error context belongs to these checks, never to opening a historical report.
      const validated = new Set<'author' | 'evaluator'>();
      if (outcome === 'accepted' || outcome === 'skipped') {
        const author = await readAuthor();
        if (author === null) {
          throw new Error('A retained acceptance must keep its authored report.');
        }
        const evaluation = await readEvaluation();
        // A completed round is replayed, not freshly finalized: its retained decision is validated
        // by report association and applicable prototype evidence, so later-stage document edits
        // or a legacy record without a repository observation cannot invalidate it.
        const decidedEvaluation = await requireRetainedDecision({
          issueRoot,
          stage: settings.stage,
          selection,
          round: plan.round,
          verdict: outcome === 'accepted' ? 'accepted' : 'accepted-skip',
          author,
          evaluation,
          git: settings.git,
        });
        // The replay adopts a retained result only while its recorded attribution identifies the
        // round's producing assessment, before any evidence resolves through it.
        requireRetainedResultAssociation({
          root,
          round: plan.round,
          result: completed,
          author,
          evaluation: decidedEvaluation,
        });
        validated.add('author');
        validated.add('evaluator');
      }
      if (outcome === 'needsInput') {
        await requireNeedsInputReport({
          issueRoot,
          stage: settings.stage,
          round: plan.round,
          workId: selection.taskKey,
          authoredRevision: completed.authoredRevision,
        });
        validated.add('author');
      }
      if (outcome !== 'exhausted' && completed.returnFinding?.report != null) {
        // A replayed return keeps its returning role's Markdown readable through the producer's
        // saved binding: an unusable report is preserved as that role's rejection evidence instead
        // of replaying a correction whose assessment is missing or unreadable.
        await requireReturnReport({
          issueRoot,
          workId: selection.taskKey,
          returned: {
            stage: settings.stage,
            role: completed.returnFinding.role ?? null,
            report: completed.returnFinding.report,
          },
          context:
            `Replaying the retained ${settings.stage} return of round ${String(plan.round)} for ` +
            `task ${selection.taskKey}.`,
        });
        if (completed.returnFinding.role !== null) {
          validated.add(completed.returnFinding.role);
        }
      } else if (outcome === 'returnUpstream') {
        // Combined returns have no Markdown binding. Validate the current round's producing
        // functional outcome before completing its pending clear, rather than relying on the
        // terminal envelope or merely opening history.
        const author = await readAuthor();
        if (author === null || author.revision !== completed.authoredRevision) {
          throw new Error('A retained return must keep its producing authored revision.');
        }
        const evaluation = await readEvaluation();
        const evaluatorReturn = evaluation !== null && evaluation.upstream !== null;
        const upstream = evaluatorReturn ? evaluation.upstream : author.upstream;
        if (
          (evaluatorReturn
            ? evaluation.verdict !== 'return-upstream' ||
              evaluation.assessedRevision !== author.revision
            : author.outcome !== 'return-upstream') ||
          upstream === null ||
          upstream.stage !== completed.returnStage ||
          upstream.correction !== completed.returnFinding?.correction
        ) {
          throw new Error('A retained combined return must keep its producing upstream outcome.');
        }
        const producer = evaluatorReturn ? evaluation : author;
        if (producer.report !== undefined) {
          await requireStageReport({
            issueRoot,
            workId: selection.taskKey,
            stage: settings.stage,
            role: evaluatorReturn ? 'evaluator' : 'author',
            binding: producer,
            profile: producer.profile ?? null,
            file: roundArtifactFile(
              root,
              plan.round,
              evaluatorReturn
                ? stageEvaluationArtifact.pathFromArtifactsRoot
                : stageAuthorArtifact.pathFromArtifactsRoot,
            ),
            context: roleContext.context,
          });
        }
        validated.add(evaluatorReturn ? 'evaluator' : 'author');
      }
      if (
        outcome !== 'exhausted' &&
        settings.stage === 'prototype' &&
        (completed.outcome === 'accepted' || completed.prototype !== null)
      ) {
        const author = await readAuthor();
        if (author === null) {
          throw new Error('A retained prototype must keep its authored report.');
        }
        const evaluation = await readEvaluation();
        if (evaluation === null) {
          throw new Error('A retained prototype must keep its evaluated decision.');
        }
        await requireRetainedPrototypeEvidence({
          artifactsRoot: path.join(root, 'artifacts'),
          roundDirectory: roundArtifactDirectory(root, plan.round),
          observations: completed.prototypeObservations,
          author,
          evaluation,
        });
        validated.add('author');
        validated.add('evaluator');
      }
      // A validated replay of the current round's saved outcomes is the owner continuation: a
      // saved replacement whose clear was interrupted completes here, and a resolved error never
      // reaches a later round.
      for (const role of validated) {
        await clearStageReportValidationError({
          issueRoot,
          stage: settings.stage,
          workId: selection.taskKey,
          role,
        });
      }
      const terminal =
        outcome === 'exhausted'
          ? {
              ...completed,
              outcome,
              reason: await readExhaustionReason(root),
              documents: [],
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
    const author = await readAuthor();
    if (author === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'report.',
      );
    }
    // The roles whose current-round saved outcome this finalization validates.
    const validated = new Set<'author' | 'evaluator'>();
    if (outcome === 'needsInput') {
      await requireNeedsInputReport({
        issueRoot,
        stage: settings.stage,
        round: plan.round,
        workId: selection.taskKey,
        authoredRevision: author.revision,
      });
      validated.add('author');
    }
    const evaluation = await readEvaluation();
    const upstream = evaluation?.upstream ?? author.upstream;
    // The published reason is action-observed: the author's question the parent must relay, or
    // the exhaustion the workflow retained. Assessment text lives in the Markdown reports, and a
    // return's concrete correction travels in the return finding.
    const reason =
      outcome === 'needsInput'
        ? author.question
        : outcome === 'exhausted'
          ? await readExhaustionReason(root)
          : null;

    /**
     * The returning role's saved Markdown report binding: the evaluator's when its verdict carried
     * the upstream request, otherwise the author's. A retained combined record has no report
     * binding, but still identifies the responsible role; its former problem and consequence
     * travel through the return finding instead.
     */
    const returningReport = (): {
      readonly role: 'author' | 'evaluator';
      readonly binding: ReturnReport | null;
    } | null => {
      if (upstream === null) {
        return null;
      }
      if (evaluation !== null && evaluation.upstream !== null) {
        return isBoundStageEvaluationOutput(evaluation)
          ? {
              role: 'evaluator',
              binding: {
                outcome: {
                  path: roundArtifactFile(
                    root,
                    plan.round,
                    stageEvaluationArtifact.pathFromArtifactsRoot,
                  ),
                },
                profile: evaluation.profile,
                report: evaluation.report,
                invocationId: evaluation.invocationId,
              },
            }
          : { role: 'evaluator', binding: null };
      }
      return isBoundStageAuthorOutput(author)
        ? {
            role: 'author',
            binding: {
              outcome: {
                path: roundArtifactFile(
                  root,
                  plan.round,
                  stageAuthorArtifact.pathFromArtifactsRoot,
                ),
              },
              profile: author.profile,
              report: author.report,
              invocationId: author.invocationId,
            },
          }
        : { role: 'author', binding: null };
    };

    const returning = outcome === 'returnUpstream' ? returningReport() : null;
    if (returning !== null) {
      // A return cannot leave this stage without the assessment that explains it: read the
      // returning role's Markdown through its saved binding, preserving an unusable report as that
      // role's rejection evidence instead of saving a return whose evidence is missing or
      // unreadable.
      if (returning.binding !== null) {
        await requireReturnReport({
          issueRoot,
          workId: selection.taskKey,
          returned: { stage: settings.stage, role: returning.role, report: returning.binding },
          context:
            `Finalizing the ${settings.stage} return of round ${String(plan.round)} for task ` +
            `${selection.taskKey}.`,
        });
      }
      validated.add(returning.role);
    }

    /**
     * A retained combined return's former problem and consequence text: a current return explains
     * both in the returning role's Markdown report, while the legacy record has no report and
     * keeps its text as history for the destination stage.
     */
    const returningHistory = (): {
      readonly problem: string;
      readonly consequence: string;
    } | null => {
      if (upstream === null) {
        return null;
      }
      if (evaluation !== null && evaluation.upstream !== null) {
        return isBoundStageEvaluationOutput(evaluation)
          ? null
          : { problem: evaluation.upstream.problem, consequence: evaluation.upstream.consequence };
      }
      if (isBoundStageAuthorOutput(author) || author.upstream === null) {
        return null;
      }
      return { problem: author.upstream.problem, consequence: author.upstream.consequence };
    };

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
      validated.add('author');
      if (evaluation !== null) {
        validated.add('evaluator');
      }
    }
    if (author.plan.length > 0) {
      // The implementation plan stays a stage artifact consumed through its own declaration; it
      // is not a changed authoritative document and never joins the accepted document set.
      await writeStageArtifact(root, plan.round, stagePlanArtifact, author.plan);
    }
    if (
      settings.stage === 'architecture' &&
      (outcome === 'accepted' || outcome === 'skipped') &&
      author.plan.length === 0
    ) {
      throw new Error(
        'The Architecture result needs the nonempty implementation plan its handoff requires; ' +
          'the authored report carries none.',
      );
    }

    /**
     * The action-observed repository revision the accepted round is bound to. Finalization already
     * required it, so a missing observation is only possible for a former saved record that must
     * be reassessed instead of finalized.
     */
    const assessedRevision = (): string => {
      const revision = evaluation?.basis.repositoryRevision;
      if (revision === undefined) {
        throw new Error(
          'The retained evaluation carries no repository observation; a current decision is ' +
            'required.',
        );
      }
      return revision;
    };

    // The retained prototype implementation tickets reuse: the stage's evaluated revision, not
    // whatever HEAD later holds.
    let prototype: PreparationResult['prototype'] = null;
    /** The author's and the evaluator's retained observation records for an accepted prototype. */
    const retainedObservations: PreparationResult['prototypeObservations'] = [];
    if (outcome === 'accepted' && settings.stage === 'prototype') {
      const revision = assessedRevision();
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
      // Retained references are not enough: the records and screenshots must still be readable
      // when the acceptance is finalized.
      await requireRetainedPrototypeEvidence({
        artifactsRoot: path.join(root, 'artifacts'),
        roundDirectory,
        observations: retainedObservations,
        author,
        evaluation,
      });
    }

    /**
     * The accepted changed documents. The evaluation observed one repository revision after
     * committing the declared stage work, so every accepted document is retained at that revision;
     * unchanged adequate documents are simply absent from the set and need no binding.
     */
    const authoredDocuments: PreparationResult['documents'] = [];
    /** The stage-owned paths outside the authoritative documents that stay on the retained branch. */
    const sourcePaths: PreparationResult['sourcePaths'] = [];
    if (outcome === 'accepted') {
      const revision = assessedRevision();
      for (const document of author.documents) {
        const relative = path.relative(worktree, path.resolve(worktree, document.path));
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(
            `The declared document "${document.path}" lies outside the shared preparation ` +
              'checkout.',
          );
        }
        authoredDocuments.push({ path: path.resolve(worktree, document.path), revision });
      }
      for (const value of new Set(author.sourcePaths)) {
        const relative = path.relative(worktree, path.resolve(worktree, value));
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(
            `The declared source path "${value}" lies outside the shared preparation checkout.`,
          );
        }
        sourcePaths.push(relative);
      }
    }

    const documents: PreparationResult['documents'] = authoredDocuments;
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
      sourcePaths,
      skipReferences: outcome === 'skipped' ? (author.skip?.references ?? []) : [],
      outputs,
      evaluation: { path: evaluationRef },
      reason,
      returnStage: outcome === 'returnUpstream' ? (upstream?.stage ?? null) : null,
      returnFinding:
        outcome === 'returnUpstream' && upstream !== null
          ? {
              stage: upstream.stage,
              correction: upstream.correction,
              role: returning?.binding == null ? null : returning.role,
              report: returning?.binding ?? null,
              ...(returningHistory() ?? {}),
            }
          : null,
      prototype,
      prototypeObservations: retainedObservations,
    };
    if (result.outcome === 'returnUpstream' && result.returnStage === null) {
      throw new Error(
        `The ${settings.stage} stage cannot return upstream without naming the earlier stage.`,
      );
    }
    // A finalized round's validated outcomes are the owners' saved replacements: complete any
    // interrupted clear so a resolved error never reaches a later round.
    for (const role of validated) {
      await clearStageReportValidationError({
        issueRoot,
        stage: settings.stage,
        workId: selection.taskKey,
        role,
      });
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
