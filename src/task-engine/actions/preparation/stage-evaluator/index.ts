import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../../adapters/git.js';
import { messageOf } from '../../../../result.js';
import {
  authoredIdentity,
  retainEvaluationContent,
  requireEvaluationContent,
  sourceInputIdentity,
} from '../evaluation-content.js';
import {
  actionOutcomeEvent,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../../../index.js';
import { parseAgentReport, responseFormatText } from '../../agent-reports.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageEvaluationResponseSchema,
  toFindings,
  type AssessedContent,
  type PreparationStage,
  type StageAuthorOutput,
  type StageEvaluationOutput,
} from '../artifacts.js';
import { stageContextText } from '../context.js';
import {
  precedingStageEvaluation,
  priorStageFindings,
  preparationWorktree,
  readStageArtifact,
  readStagePlan,
  readStageTerminal,
  reusedPreparationContent,
  roundArtifactDirectory,
  roundArtifactFile,
  stageRoot,
  upstreamResultReferences,
  writeStageArtifact,
} from '../storage.js';
import {
  observationContentProblem,
  readPrototypeObservation,
  type PrototypeObservation,
  type PrototypeObservationRole,
} from '../observation.js';

/**
 * StageEvaluator assesses the exact authored revision of one evaluated preparation round. It
 * resolves the previous round's findings, distinguishes necessary changes from optional
 * suggestions and accepts the work, the author's skip proposal or a concrete upstream return. A
 * report that assesses another revision or invents a skip the author did not propose is unusable.
 */

export type StageEvaluatorSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly stage: PreparationStage;
  /** The evaluator role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly git: GitAdapter;
  readonly publish: EventPublisher;
};

/**
 * Why the evaluator's report is not a usable assessment of the current revision, or null. The
 * report disposes of exactly the prior findings the response round inherited, keeps open findings
 * in its current list, and states a verdict its current blocking findings support.
 */
function reportProblem(
  report: z.output<typeof stageEvaluationResponseSchema>,
  settings: {
    readonly stage: PreparationStage;
    readonly authorRevision: number;
    readonly authorProposedSkip: boolean;
    readonly priorFindings: readonly { readonly id: string }[];
  },
): string | null {
  const { authorRevision, authorProposedSkip, priorFindings } = settings;
  if (report.assessedRevision !== authorRevision) {
    return (
      `the report assesses revision ${String(report.assessedRevision)} while the authored ` +
      `revision is ${String(authorRevision)}`
    );
  }
  if (report.verdict === 'accepted-skip' && !authorProposedSkip) {
    return 'the evaluator accepted a skip the author did not propose';
  }
  if (report.verdict === 'return-upstream' && report.upstream === null) {
    return 'a return-upstream verdict needs the problematic input, consequence and correction';
  }
  if (settings.stage !== 'prototype') {
    if (report.observation !== null) {
      return 'only the Storybook Refinement stage retains a prototype observation';
    }
  } else if (report.verdict === 'accepted') {
    if (authorProposedSkip) {
      return (
        'accepting a prototype skip proposal is an accepted-skip decision, which needs no ' +
        'preview evidence'
      );
    }
    if (report.observation === null) {
      return (
        'accepting applicable prototype work needs the evaluator\u2019s own saved browser ' +
        'observation'
      );
    }
  } else if (report.observation !== null) {
    return (
      'only an accepted applicable prototype carries an evaluator observation; a skip decision, ' +
      'change request or upstream return carries null'
    );
  }

  const current = new Set<string>();
  for (const finding of report.findings) {
    if (current.has(finding.id)) {
      return `finding "${finding.id}" is reported more than once`;
    }
    current.add(finding.id);
  }
  const supplied = new Set(priorFindings.map((finding) => finding.id));
  const answered = new Set<string>();
  for (const disposition of report.priorFindings) {
    if (!supplied.has(disposition.findingId)) {
      return `prior finding "${disposition.findingId}" is not part of the inherited set`;
    }
    if (answered.has(disposition.findingId)) {
      return `prior finding "${disposition.findingId}" is disposed of more than once`;
    }
    answered.add(disposition.findingId);
    const present = current.has(disposition.findingId);
    if (disposition.disposition === 'open' && !present) {
      return (
        `prior finding "${disposition.findingId}" is left open without appearing in the current ` +
        'findings'
      );
    }
    if (disposition.disposition !== 'open' && present) {
      return (
        `prior finding "${disposition.findingId}" is reported as "${disposition.disposition}" ` +
        'while it is still in the current findings'
      );
    }
  }
  const missing = priorFindings.map((finding) => finding.id).filter((id) => !answered.has(id));
  if (missing.length > 0) {
    return (
      `the report does not dispose of prior finding${missing.length === 1 ? '' : 's'} ` +
      `${missing.map((id) => `"${id}"`).join(', ')}`
    );
  }

  const blocking = report.findings.filter((finding) => finding.severity === 'blocking');
  if (
    (report.verdict === 'accepted' || report.verdict === 'accepted-skip') &&
    blocking.length > 0
  ) {
    return (
      `the report accepts the revision while reporting blocking finding` +
      `${blocking.length === 1 ? '' : 's'} ${blocking.map((finding) => `"${finding.id}"`).join(', ')}`
    );
  }
  if (report.verdict === 'changes-requested' && blocking.length === 0) {
    return 'a changes-requested verdict needs at least one current blocking finding';
  }
  return null;
}

/**
 * Validate the author's and the evaluator's saved observations against the exact revision an
 * accepted applicable prototype assesses: both records must be readable evidence covering the
 * stage-owned prototype paths, and their observed content must still match the evaluated revision.
 * Missing or stale evidence cannot produce acceptance.
 */
async function requirePrototypeEvidence(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly roundDirectory: string;
  readonly author: StageAuthorOutput;
  readonly evaluator: { readonly path: string } | null;
  readonly assessed: readonly AssessedContent[];
}): Promise<void> {
  if (settings.author.observation === null) {
    throw new Error(
      'The prototype author report carries no observation; an accepted applicable prototype needs ' +
        'the author\u2019s own browser evidence.',
    );
  }
  if (settings.evaluator === null) {
    throw new Error(
      'The prototype evaluator report carries no observation; an accepted applicable prototype ' +
        'needs the evaluator\u2019s own browser evidence.',
    );
  }
  const declared: readonly (readonly [PrototypeObservationRole, string])[] = [
    ['author', settings.author.observation.path],
    ['evaluator', settings.evaluator.path],
  ];
  for (const [role, observationPath] of declared) {
    let observation: PrototypeObservation;
    try {
      observation = await readPrototypeObservation({
        declared: observationPath,
        roundDirectory: settings.roundDirectory,
        role,
      });
    } catch (error) {
      throw new Error(`The ${role} prototype observation is unusable: ${messageOf(error)}`, {
        cause: error,
      });
    }
    const problem = await observationContentProblem({
      git: settings.git,
      worktree: settings.worktree,
      observation,
      assessed: settings.assessed,
      observedPaths: settings.author.sourcePaths,
    });
    if (problem !== null) {
      throw new Error(`The ${role} prototype observation is unusable: ${problem}.`);
    }
  }
}

/** Create the StageEvaluator invocation for one evaluated preparation stage. */
export function createStageEvaluator(settings: StageEvaluatorSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = stageRoot(selection.workspace.root, settings.stage);
    const worktree = preparationWorktree(selection.workspace.root);
    const plan = await readStagePlan(root);
    if (plan === null || plan.stage !== settings.stage) {
      throw new Error(
        `No ${settings.stage} round plan exists under "${root}"; the evaluator needs an opened ` +
          'round.',
      );
    }
    const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
    if (author === null) {
      throw new Error(
        `Round ${String(plan.round)} of the ${settings.stage} stage has no authored revision to ` +
          'assess.',
      );
    }
    const findings = await priorStageFindings(root, plan);
    // A response or reassessment round resolves the preceding evaluation's findings against the
    // revision or reuse it assesses; a fresh round was already evaluated on its own revision, if
    // at all.
    const previous = plan.route === 'new' ? null : await precedingStageEvaluation(root, plan.round);

    // A skip may explicitly reuse the immediately preceding acceptance; resolve those paths before
    // the assessment so the new basis binds their complete current observation, source paths
    // included, instead of losing them with the reference.
    const reused =
      author.outcome === 'skip-proposed'
        ? await reusedPreparationContent({
            root,
            round: plan.round,
            worktree,
            stage: settings.stage,
            references: author.skip?.references ?? [],
          })
        : null;
    const retained = await retainEvaluationContent({
      git: settings.git,
      worktree,
      author,
      reused: reused?.paths ?? [],
    });
    const upstream = await upstreamResultReferences(selection.workspace.root, settings.stage);
    const basis = {
      author: { path: roundArtifactFile(root, plan.round, 'author.json') },
      authorIdentity: authoredIdentity(author),
      sourceIdentity: sourceInputIdentity(selection),
      upstream: upstream.map((reference) => ({
        result: { path: reference.resultFile },
        identity: reference.identity,
      })),
      content: retained.content,
    };
    const retainedDecision =
      plan.route === 'reassess'
        ? await (async () => {
            const terminal = await readStageTerminal(root);
            return terminal === null
              ? null
              : { outcome: terminal.outcome, reason: terminal.reason };
          })()
        : null;
    const context = await stageContextText({
      selection,
      plan,
      stageRoot: root,
      worktree,
      author,
      evaluation: previous,
      retained: retainedDecision,
    });
    const result = await settings.runner.run({
      operation: 'stage-evaluator',
      profile: plan.profiles.evaluator,
      // The invocation's workspace is the preparation issue root; AgentRuntime resolves the one
      // shared checkout at its worktree/ child. Stage areas only hold artifacts.
      workspace: { root: selection.workspace.root },
      context: [
        context,
        `Assess the exact authored revision ${String(author.revision)} and resolve every prior ` +
          'finding. Accept adequate work, the author\u2019s evaluated skip or a concrete upstream ' +
          'return; separate necessary changes from optional suggestions.',
        'The assessed repository content retained for this evaluation (path at revision, or a ' +
          'retained deletion): ' +
          JSON.stringify(basis.content),
        'The relied-on upstream results this decision binds: ' + JSON.stringify(basis.upstream),
        findings.length === 0
          ? 'No prior findings are inherited by this round; return an empty priorFindings array.'
          : `Eligible prior finding IDs: ${findings
              .map((finding) => `"${finding.id}"`)
              .join(', ')}. Return exactly one priorFindings disposition for each and none for ` +
            'any other ID; an open disposition requires the finding in findings, and resolved or ' +
            'withdrawn findings stay out of it.',
        'State a verdict the current findings support: accepted and accepted-skip require no ' +
          'blocking finding, and changes-requested needs at least one.',
        responseFormatText(stageEvaluationResponseSchema),
      ].join('\n\n'),
      outputSchema: z.toJSONSchema(stageEvaluationResponseSchema),
      task: selection.taskKey,
    });
    if (!result.ok) {
      throw new Error(result.fault.message);
    }
    const report = parseAgentReport(
      result.value.output,
      stageEvaluationResponseSchema,
      `${settings.stage} evaluator`,
    );
    const problem = reportProblem(report, {
      stage: settings.stage,
      authorRevision: author.revision,
      authorProposedSkip: author.outcome === 'skip-proposed',
      priorFindings: findings,
    });
    if (problem !== null) {
      throw new Error(`The ${settings.stage} evaluator report is unusable: ${problem}.`);
    }
    if (settings.stage === 'prototype' && report.verdict === 'accepted') {
      await requirePrototypeEvidence({
        git: settings.git,
        worktree,
        roundDirectory: roundArtifactDirectory(root, plan.round),
        author,
        evaluator: report.observation,
        assessed: retained.content,
      });
    }

    await requireEvaluationContent({
      git: settings.git,
      worktree,
      content: retained.content,
    });
    const currentAuthor = await readStageArtifact(root, plan.round, stageAuthorArtifact);
    if (currentAuthor === null || authoredIdentity(currentAuthor) !== authoredIdentity(author))
      throw new Error('The authored report changed during assessment; reevaluation is required.');
    const output: StageEvaluationOutput = {
      basis,
      assessedRevision: report.assessedRevision,
      verdict: report.verdict,
      reason: report.reason,
      observation: report.observation,
      findings: toFindings(report.findings),
      priorFindings: report.priorFindings,
      upstream: report.upstream,
    };
    await writeStageArtifact(root, plan.round, stageEvaluationArtifact, output);
    const artifact = path.join(
      root,
      'artifacts',
      String(plan.round),
      stageEvaluationArtifact.pathFromArtifactsRoot,
    );
    settings.publish(
      actionOutcomeEvent('stage-evaluator', {
        task: selection.taskKey,
        round: plan.round,
        outcome: report.verdict,
        detail: `${settings.stage} · revision ${String(author.revision)}`,
        artifact: { path: artifact },
      }),
    );
    return report.verdict;
  };
}
