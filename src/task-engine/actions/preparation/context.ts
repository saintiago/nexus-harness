import path from 'node:path';
import { readBoundReport, type ReportBinding } from '../agent-reports.js';
import { messageOf, type ArtifactRef } from '../../../result.js';
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
  isBoundStageAuthorOutput,
  isBoundStageEvaluationOutput,
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stagePlanArtifact,
  stageResultArtifact,
  type PreparationStage,
  type RetainedStageAuthorOutput,
  type RetainedStageEvaluationOutput,
  type StageRoundPlan,
} from './artifacts.js';
import {
  readStageArtifact,
  readStageRoleArtifact,
  readStagePlan,
  requireReturnReport,
  requireStageReport,
  roundArtifactDirectory,
  roundArtifactFile,
  stageRoot,
  upstreamResultReferences,
} from './storage.js';
import { prototypeObservationContract } from './observation.js';
import { validationErrorContextText, type PendingValidationError } from '../report-feedback.js';
import { capturedSourceText } from '../readable-source.js';

/**
 * The context every evaluated preparation role receives. The selected profile supplies the role's
 * constant purpose and standards; this module supplies the shared work and quality guidance once,
 * the readable captured source with its active corrections, references to the worktree, repository
 * instructions, upstream artifacts and local history, and finally the reporting mechanics. It
 * renders captured values directly and references retained bodies instead of embedding them.
 */

/**
 * The shared work and quality guidance every preparation role carries once per invocation, after
 * its role-specific instructions and before the task context. The preparation roles document owns
 * the wording.
 */
export const preparationSharedGuidance = [
  'Preparation guidance (shared once by every evaluated preparation stage; the selected role’s',
  'purpose and standards are supplied above):',
  'Authors and evaluators actively improve clarity, simplicity, usability, coherence and',
  'maintainability within the requested scope and their stage’s responsibility. Before submission',
  'or acceptance, resolve known material weaknesses and worthwhile simplifications. Ground a',
  'required change in a concrete problem, the affected user or responsibility, and the expected',
  'benefit; explain the evidence and correction. Passing functional checks or meeting a minimal',
  'checklist alone does not establish quality. Taste, hypothetical future needs and equally good',
  'alternatives do not justify further revisions: stop when no known material issue remains, not',
  'when no imaginable improvement exists, and explain why remaining suggestions are nonblocking.',
  'Existing work that meets this standard receives direct evaluation and acceptance without',
  'manufactured edits, citations or a reuse skip. Apply the standard to the selected role’s work;',
  'visual and motion assessment belongs only where relevant.',
  'Start with current captured requirements, active corrections and affected component contracts.',
  'Consult accepted upstream outputs, related documents and historical reports for specific questions;',
  'document indexes are navigation aids, not reading assignments. Human intent governs;',
  'agent summaries are revisable history.',
  'Keep source attribution and material uncertainty. Do not retrieve Jira, publish source comments,',
  'change issue status or create implementation issues; source operations belong to the parent.',
  'Assess only the selected stage’s responsibilities. Shared-memory search/save is explicit when',
  'the invocation carries the memory tools; no preparation role schedules automatic memory',
  'consumption.',
  'Evaluate applicability first. Propose an applicability skip when the stage is irrelevant, with',
  'reasons in the report and optional functional evidence references; document citations are not',
  'mandatory. Directly evaluate existing documents under the bounded material-quality standard. If',
  'inputs prevent a feasible clean result, identify the problematic input, correction and owning',
  'earlier stage. Ask the user only for a material decision that available context cannot resolve.',
  'Do not turn a provider or tool failure into an upstream product requirement.',
  'Apply the connected project’s existing design and ownership principles to keep cumulative',
  'changes coherent within scope. Before evaluation, authors reconcile affected existing intent',
  'with the requested outcome across requirements, experience, architecture, documentation and',
  'code, as applicable to their stage. Remove superseded rules and mechanisms together with',
  'dependent validation, state and tests. When repeated exceptions have a confirmed shared',
  'ownership cause, correct it at its owning boundary; repetition alone does not justify',
  'abstraction or redesign.',
  'Evaluators inspect the resulting design and applicable implementation, affected interactions',
  'and existing behavior, not just additions or the author’s summary. Expand inspection when',
  'evidence indicates wider impact or a shared cause; unrelated improvements are not completion',
  'requirements. Seek contradictions,',
  'unnecessary complexity, scattered ownership and interaction inconsistencies. Necessary findings',
  'identify the concrete problem, evidence, consequence and required correction through the',
  'existing finding and return paths. Preserve stage responsibility, bounded material-quality',
  'acceptance and optional suggestions; reconciliation grants no unrelated redesign, extra attempts',
  'or bypass of current-revision evaluation.',
].join('\n');

/**
 * The shared reporting guidance every preparation role receives once in the final context section,
 * after the work and its context. The preparation roles document owns the wording; the calling
 * action appends its stage-specific declarations, observation rules and response contract.
 */
export const preparationReportingGuidance = [
  'Preparation reporting (supplied once per invocation; the stage’s declarations and response',
  'rules follow):',
  'Write the narrative at the supplied Markdown report path. Return only the minimal response',
  'object; do not write or overwrite action-owned author.json, evaluation.json, result.json,',
  'plan.json or state records. The action adds observed identity, revision and report-binding',
  'metadata.',
  'Authors declare changed authoritative documents in documents; sourcePaths declares additional',
  'stage-owned authored files, never files merely read. Every non-authored outcome has empty',
  'documents and sourcePaths. Only Architecture supplies an implementation plan.',
  'Authors preserve scope and explain corrections, answers, disagreements and remaining problems',
  'in their assigned Markdown report, using previous reports as context without per-finding',
  'response or status records. Evaluators inspect current content, judge whether earlier concerns',
  'remain and seek useful improvements as well as omissions. Report actionable current findings',
  'in Markdown without stable IDs or disposition records, separating necessary changes from',
  'optional suggestions and explaining why the latter are nonblocking.',
  'Lead with the result, necessary corrections, verification and material limitations. Include',
  'evidence the next actor needs; omit repeated history and exhaustive inspection narratives.',
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

/** One retained record's file inside its stage round area. */
function artifactPath(
  issueRoot: string,
  stage: PreparationStage,
  round: number,
  artifactFile: string,
): string {
  return roundArtifactFile(stageRoot(issueRoot, stage), round, artifactFile);
}

/** The context one later stage's read of an earlier stage's retained role record reports. */
function upstreamContext(
  earlier: PreparationStage,
  role: 'author' | 'evaluator',
  round: number,
  stage: PreparationStage,
): string {
  return `Reading retained ${earlier} ${role} round ${String(round)} for ${stage} context.`;
}

/** One earlier stage's retained result, author and report references a later stage may read. */
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
      const author = await readStageRoleArtifact({
        issueRoot,
        stage: earlier,
        workId: selection.taskKey,
        round: plan.round,
        role: 'author',
        profile: plan.profiles.author,
        context: upstreamContext(earlier, 'author', plan.round, stage),
        required: result?.outcome === 'accepted' || result?.outcome === 'skipped',
      });
      if (author !== null) {
        if (isBoundStageAuthorOutput(author)) {
          // Referencing an accepted upstream report must not bypass its producer binding: a
          // missing or unreadable Markdown is preserved as that author's rejection evidence before
          // any later stage consumes the acceptance.
          await requireStageReport({
            issueRoot,
            workId: selection.taskKey,
            stage: earlier,
            role: 'author',
            binding: author,
            profile: author.profile,
            file: artifactPath(
              issueRoot,
              earlier,
              plan.round,
              stageAuthorArtifact.pathFromArtifactsRoot,
            ),
            context: upstreamContext(earlier, 'author', plan.round, stage),
          });
        }
        lines.push(
          `${earlier} retained authored revision ${String(author.revision)}: ` +
            artifactPath(
              issueRoot,
              earlier,
              plan.round,
              stageAuthorArtifact.pathFromArtifactsRoot,
            ) +
            (isBoundStageAuthorOutput(author) ? `; report: ${author.report.path}` : ''),
        );
      }
      const evaluation = await readStageRoleArtifact({
        issueRoot,
        stage: earlier,
        workId: selection.taskKey,
        round: plan.round,
        role: 'evaluator',
        profile: plan.profiles.evaluator,
        context: upstreamContext(earlier, 'evaluator', plan.round, stage),
        required: result?.outcome === 'accepted' || result?.outcome === 'skipped',
      });
      if (evaluation !== null && isBoundStageEvaluationOutput(evaluation)) {
        // The accepted result's own assessment is evidence later stages rely on; validate its
        // Markdown binding under the evaluator's report responsibility before exposing the result.
        await requireStageReport({
          issueRoot,
          workId: selection.taskKey,
          stage: earlier,
          role: 'evaluator',
          binding: evaluation,
          profile: evaluation.profile,
          file: artifactPath(
            issueRoot,
            earlier,
            plan.round,
            stageEvaluationArtifact.pathFromArtifactsRoot,
          ),
          context: upstreamContext(earlier, 'evaluator', plan.round, stage),
        });
      }
      lines.push(`${earlier} stage history: ${root}`);
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
  /** The authored record this invocation reads as current work, or null. */
  readonly author: RetainedStageAuthorOutput | null;
  /** The round that retained the authored record above; the current round when there is none. */
  readonly authorRound: number;
  /** The most recent preceding evaluation, or null when none is retained. */
  readonly evaluation: RetainedStageEvaluationOutput | null;
  /** The round that retained the evaluation above; null when there is none. */
  readonly evaluationRound: number | null;
  /**
   * Earlier author rounds retained after that evaluation and before the current work. Their
   * reports stay inspectable so a later role judges their corrections without inferred resolution.
   */
  readonly interveningAuthors: readonly {
    readonly round: number;
    readonly author: RetainedStageAuthorOutput;
  }[];
  /** The assigned Markdown report path for this invocation's own response. */
  readonly report: ArtifactRef;
  /** The retained copy of the exact captured source this context renders. */
  readonly capturedSource: string;
  /** The stage's retained terminal result when an upstream correction requires reassessment. */
  readonly retained: { readonly outcome: string; readonly reason: string | null } | null;
  /** The pending validation error of this stage's role that the invocation must correct. */
  readonly feedback: PendingValidationError | null;
  /** The route-specific work instruction for this invocation. */
  readonly work: readonly string[];
  /** The stage-specific declarations, observation rules and response contract for this stage. */
  readonly reporting: readonly string[];
  /**
   * Preserve an unreadable bound producer report as that producer's rejection evidence, then
   * fail: the responsible role receives the correction obligation instead of the evidence
   * silently disappearing.
   */
  readonly rejectUnreadableReport: (settings: {
    readonly role: 'author' | 'evaluator';
    readonly round: number;
    readonly report: ArtifactRef;
    readonly invocationId: string;
    readonly profile: string;
    readonly error: Error;
  }) => Promise<never>;
};

/** One readable bound report's Markdown text, or the producer's rejection evidence. */
async function reportText(settings: {
  readonly binding: ReportBinding & { readonly profile: string };
  readonly role: 'author' | 'evaluator';
  readonly round: number;
  readonly kind: string;
  readonly reject: StageContextSettings['rejectUnreadableReport'];
}): Promise<string> {
  try {
    return (await readBoundReport(settings.binding, settings.kind)).text;
  } catch (error) {
    return await settings.reject({
      role: settings.role,
      round: settings.round,
      report: settings.binding.report,
      invocationId: settings.binding.invocationId,
      profile: settings.binding.profile,
      error: error instanceof Error ? error : new Error(messageOf(error)),
    });
  }
}

/**
 * Validate one referenced bound report through its producer binding without placing its body in
 * the prompt. Referencing a report must not bypass record usability: a missing or unreadable
 * report is preserved as its producer's rejection evidence before the invocation continues.
 */
async function validateBoundReport(settings: {
  readonly binding: ReportBinding & { readonly profile: string };
  readonly role: 'author' | 'evaluator';
  readonly round: number;
  readonly kind: string;
  readonly reject: StageContextSettings['rejectUnreadableReport'];
}): Promise<void> {
  await reportText(settings);
}

/**
 * True when an evaluation left a correction this stage must still address: a changes-requested
 * assessment, or the returned assessment whose concrete correction is still the retained pending
 * return from this stage. A consumed return and every accepted assessment are supporting history.
 */
function activeEvaluation(
  evaluation: RetainedStageEvaluationOutput,
  handoff: ParentHandoff | null,
  stage: PreparationStage,
): boolean {
  if (evaluation.verdict === 'changes-requested') {
    return true;
  }
  return (
    evaluation.verdict === 'return-upstream' &&
    handoff?.return !== null &&
    handoff?.return !== undefined &&
    handoff.return.from === stage
  );
}

/** One active preceding evaluation: its complete validated concerns, directly available. */
async function activeEvaluationSection(settings: {
  readonly evaluation: RetainedStageEvaluationOutput;
  readonly round: number;
  readonly reject: StageContextSettings['rejectUnreadableReport'];
}): Promise<string> {
  const { evaluation } = settings;
  if (!isBoundStageEvaluationOutput(evaluation)) {
    return [
      `The previous ${evaluation.verdict} evaluation (retained combined report; context for ` +
        'corrections, disagreements and remaining problems):',
      JSON.stringify(evaluation, null, 2),
    ].join('\n');
  }
  const text = await reportText({
    binding: evaluation,
    role: 'evaluator',
    round: settings.round,
    kind: 'Stage evaluation report',
    reject: settings.reject,
  });
  return [
    `The previous evaluation of this work is ${evaluation.verdict} (profile ` +
      `${evaluation.profile}, invocation ${evaluation.invocationId}, assessed revision ` +
      `${String(evaluation.assessedRevision)}); its assigned Markdown report: ` +
      evaluation.report.path,
    'The complete validated evaluation Markdown (active concerns: problem, consequence, required ' +
      'correction, optional suggestions and uncertainty):',
    text,
  ].join('\n');
}

/** One retained upstream return as context: its concrete correction and the returning assessment. */
async function returnSection(settings: {
  readonly handoff: ParentHandoff | null;
  readonly selection: Selection;
  readonly stage: PreparationStage;
  readonly reject: StageContextSettings['rejectUnreadableReport'];
}): Promise<string | null> {
  const returned = settings.handoff?.return;
  if (returned === undefined || returned === null || returned.to !== settings.stage) {
    return null;
  }
  const lines = [
    `Retained upstream return from the ${returned.from} stage: the work cannot proceed until ` +
      'this concrete correction is made.',
    `Required correction: ${returned.correction}`,
  ];
  if (returned.report !== null) {
    lines.push(
      `The returning role's Markdown report (its problem and consequence): ` +
        `${returned.report.report.path}`,
    );
    // The report is read through the returning role's saved binding: a missing or unreadable
    // report is preserved as that role's rejection evidence and fails this context instead of
    // silently dropping the assessment or embedding replacement bytes.
    const text = await requireReturnReport({
      issueRoot: issueWorkspaceRootOf(settings.selection),
      workId: settings.selection.taskKey,
      returned: { stage: returned.from, role: returned.role, report: returned.report },
      context:
        `Reading the ${returned.from} return for the ${settings.stage} stage context of task ` +
        `${settings.selection.taskKey}.`,
    });
    if (text !== null) {
      lines.push('The complete returning assessment:', text);
    }
  } else {
    if (returned.problem !== undefined) lines.push(`Problem: ${returned.problem}`);
    if (returned.consequence !== undefined) lines.push(`Consequence: ${returned.consequence}`);
  }
  lines.push(
    `The returning stage's retained evidence is under ` +
      `${stageRoot(issueWorkspaceRootOf(settings.selection), returned.from)}; read its result and ` +
      'evaluation for the observation behind the correction.',
  );
  return lines.join('\n');
}

/** The readable captured source section with its retained evidence reference. */
function capturedSourceSection(
  settings: StageContextSettings,
  handoff: ParentHandoff | null,
): string {
  const issues = issueSummary(settings.selection.task);
  return [
    'Captured issue input and conversation (authoritative):',
    `Selected issue: ${settings.selection.taskKey}${issues === null ? '' : ` "${issues}"`}`,
    capturedSourceText({
      sourcePath: settings.capturedSource,
      task: settings.selection.task,
      conversation: settings.selection.conversation,
      publications: handoff?.publications ?? [],
    }),
    `The exact captured source is retained at ${settings.capturedSource}; inspect it before ` +
      'relying on any content this rendering does not display.',
  ].join('\n');
}

/** The active corrections this invocation must address directly, or that none are retained. */
async function activeCorrectionsSection(
  settings: StageContextSettings,
  handoff: ParentHandoff | null,
): Promise<string> {
  const items: string[] = [];
  const feedback =
    handoff?.feedback !== null &&
    handoff?.feedback !== undefined &&
    handoff.feedback.stage === settings.plan.stage
      ? [
          `Retained human question for this stage: ${handoff.feedback.question}`,
          'The captured conversation above carries the human answer or feedback that followed; ' +
            'treat the captured clarification as governing intent when it resolves the question.',
        ].join('\n')
      : null;
  if (feedback !== null) {
    items.push(feedback);
  }
  const returned = await returnSection({
    handoff,
    selection: settings.selection,
    stage: settings.plan.stage,
    reject: settings.rejectUnreadableReport,
  });
  if (returned !== null) {
    items.push(returned);
  }
  items.push(...validationErrorContextText(settings.feedback));
  if (
    settings.evaluation !== null &&
    activeEvaluation(settings.evaluation, handoff, settings.plan.stage)
  ) {
    items.push(
      await activeEvaluationSection({
        evaluation: settings.evaluation,
        round: settings.evaluationRound ?? settings.authorRound,
        reject: settings.rejectUnreadableReport,
      }),
    );
  }
  return items.length === 0
    ? 'Active corrections: none retained for this stage; the references and history below are context.'
    : [
        'Active corrections (address these directly; history does not replace them):',
        ...items,
      ].join('\n\n');
}

/** The reassessment statement identifying the changed input that requires a fresh decision. */
function reassessmentSection(
  settings: StageContextSettings,
  handoff: ParentHandoff | null,
): string[] {
  if (settings.plan.route !== 'reassess') {
    return [];
  }
  const changed =
    handoff?.return !== null &&
    handoff?.return !== undefined &&
    handoff.return.to === settings.plan.stage
      ? `the ${handoff.return.from} upstream correction above`
      : handoff?.feedback !== null &&
          handoff?.feedback !== undefined &&
          handoff.feedback.stage === settings.plan.stage
        ? 'the retained human question and its captured answer above'
        : 'a refreshed upstream input';
  return [
    [
      'This stage’s earlier decision is pending reassessment: an upstream input changed.',
      `Changed input: ${changed}.`,
      settings.retained === null
        ? 'No retained terminal result is readable; obtain a current decision for this stage.'
        : `Retained earlier ${settings.retained.outcome} result: ` +
          `${settings.retained.reason ?? 'no reason retained'}.`,
      'Assess the current content against the corrected input: leave adequate current',
      'documents unchanged, repair what the correction affects and confirm the result through',
      'this round’s current evaluation. An earlier acceptance cannot authorize changed content.',
    ].join('\n'),
  ];
}

/** The current authored work as attributed references, never as an embedded report body. */
async function currentWorkLines(settings: StageContextSettings): Promise<string[]> {
  const { author } = settings;
  if (author === null) {
    return [
      'No authored revision exists yet for this round; author the work or propose an evaluated skip.',
    ];
  }
  const bound = isBoundStageAuthorOutput(author);
  if (bound) {
    await validateBoundReport({
      binding: author,
      role: 'author',
      round: settings.authorRound,
      kind: 'Stage author report',
      reject: settings.rejectUnreadableReport,
    });
  }
  const identity =
    `The current authored revision is ${String(author.revision)} (stage ${author.stage}, ` +
    `outcome ${author.outcome}` +
    (bound
      ? `, profile ${author.profile}, invocation ${author.invocationId}).`
      : '; retained combined report, readable history judged against the current response rules).');
  const lines = [
    identity,
    'Its retained author record: ' +
      artifactPath(
        settings.selection.workspace.root,
        author.stage,
        settings.authorRound,
        stageAuthorArtifact.pathFromArtifactsRoot,
      ),
  ];
  lines.push(
    bound
      ? `Its assigned Markdown report: ${author.report.path}`
      : 'Its complete former narrative is retained in the record above.',
    'Read the record, its declarations and the report before judging; they are referenced rather ' +
      'than embedded.',
  );
  return lines;
}

/** One supporting-history reference for a preceding evaluation that left no active correction. */
async function supportingEvaluationLine(settings: StageContextSettings): Promise<string | null> {
  const evaluation = settings.evaluation;
  if (evaluation === null) {
    return null;
  }
  const round = settings.evaluationRound ?? settings.authorRound;
  const identity = isBoundStageEvaluationOutput(evaluation)
    ? `profile ${evaluation.profile}, invocation ${evaluation.invocationId}, `
    : '';
  const attribution =
    `The previous evaluation of this work is ${evaluation.verdict} (${identity}assessed revision ` +
    `${String(evaluation.assessedRevision)})`;
  if (!isBoundStageEvaluationOutput(evaluation)) {
    return (
      `- round ${String(round)}: ${attribution}; record ` +
      artifactPath(
        settings.selection.workspace.root,
        settings.plan.stage,
        round,
        stageEvaluationArtifact.pathFromArtifactsRoot,
      ) +
      ' (retained combined report, readable history). It left no pending correction.'
    );
  }
  await validateBoundReport({
    binding: evaluation,
    role: 'evaluator',
    round,
    kind: 'Stage evaluation report',
    reject: settings.rejectUnreadableReport,
  });
  return (
    `- round ${String(round)}: ${attribution}; record ` +
    artifactPath(
      settings.selection.workspace.root,
      settings.plan.stage,
      round,
      stageEvaluationArtifact.pathFromArtifactsRoot,
    ) +
    `; report ${evaluation.report.path}. Read it as supporting history; it left no pending correction.`
  );
}

/** The context references section: worktree, instructions, upstream and local history, work. */
async function referencesSection(
  settings: StageContextSettings,
  handoff: ParentHandoff | null,
): Promise<string> {
  const upstream = await upstreamReferences(settings.selection, settings.plan.stage);
  const lines: string[] = [
    `Connected project worktree: ${settings.worktree}`,
    `Repository instructions: read the connected project's root instruction file at ` +
      `"${path.join(settings.worktree, 'AGENTS.md')}" and any nested applicable instruction files ` +
      'before working, unless the provider already supplied that repository guidance natively. ' +
      'Follow their applicable instructions and keep those files intact. Linked design documents ' +
      'are evidence to consult, not additional role instructions.',
    upstream.length === 0
      ? 'Accepted upstream outputs: none retained; existing authoritative project documents in ' +
        'the worktree may satisfy the stage input.'
      : [
          'Accepted upstream outputs (read the files that bear on this stage):',
          ...upstream.flatMap((reference) => reference.lines.map((line) => `- ${line}`)),
        ].join('\n'),
    `Stage history: retained rounds, reports and further evidence under ${settings.stageRoot}.`,
  ];
  const history: string[] = [];
  const supporting =
    settings.evaluation !== null &&
    !activeEvaluation(settings.evaluation, handoff, settings.plan.stage)
      ? await supportingEvaluationLine(settings)
      : null;
  if (supporting !== null) {
    history.push(supporting);
  }
  for (const { round, author } of settings.interveningAuthors) {
    if (isBoundStageAuthorOutput(author)) {
      await validateBoundReport({
        binding: author,
        role: 'author',
        round,
        kind: 'Stage author report',
        reject: settings.rejectUnreadableReport,
      });
    }
    history.push(
      `- round ${String(round)} author revision ${String(author.revision)} (outcome ` +
        `${author.outcome}): ` +
        artifactPath(
          settings.selection.workspace.root,
          settings.plan.stage,
          round,
          stageAuthorArtifact.pathFromArtifactsRoot,
        ) +
        (isBoundStageAuthorOutput(author) ? `; report: ${author.report.path}` : ''),
    );
  }
  if (history.length > 0) {
    lines.push(
      [
        'Local history references (read the corrections, answers and disagreements they retain):',
        ...history,
      ].join('\n'),
    );
  }
  lines.push(...reassessmentSection(settings, handoff));
  lines.push(['This invocation’s work:', ...settings.work].join('\n'));
  lines.push(['Current work to assess:', ...(await currentWorkLines(settings))].join('\n'));
  if (settings.plan.stage === 'architecture') {
    lines.push(
      'The Architecture implementation plan this decision covers: ' +
        roundArtifactFile(
          settings.stageRoot,
          settings.plan.round,
          stagePlanArtifact.pathFromArtifactsRoot,
        ),
    );
  }
  return lines.join('\n\n');
}

/** The reporting mechanics section: assigned path, declaration rules and response contract once. */
function reportingSection(settings: StageContextSettings): string {
  const prototype =
    settings.plan.stage === 'prototype'
      ? [
          prototypeObservationContract(
            roundArtifactDirectory(settings.stageRoot, settings.plan.round),
          ),
        ]
      : [];
  return [
    preparationReportingGuidance,
    `Assigned Markdown report: ${settings.report.path}`,
    ...prototype,
    ...settings.reporting,
  ].join('\n\n');
}

/** Assemble the preparation role's context for the current round. */
export async function stageContextText(settings: StageContextSettings): Promise<string> {
  const handoff = await readParentHandoff(settings.selection);
  return [
    preparationSharedGuidance,
    [
      `Preparation stage: ${settings.plan.stage}, round ${String(settings.plan.round)}.`,
      `Round route: ${settings.plan.route}.`,
    ].join('\n'),
    capturedSourceSection(settings, handoff),
    await activeCorrectionsSection(settings, handoff),
    await referencesSection(settings, handoff),
    reportingSection(settings),
  ].join('\n\n');
}
