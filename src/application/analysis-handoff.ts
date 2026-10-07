import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExperienceHandoff,
  ExperienceHandoffIdentity,
} from '../task-engine/actions/analyze-experience/artifacts.js';
import { reportBindingOf } from '../task-engine/actions/agent-reports.js';
import { roundArtifactPath } from '../task-engine/actions/artifacts.js';
import { completionFailureArtifact } from '../task-engine/actions/complete-task/artifacts.js';
import { deliveryFailureArtifact } from '../task-engine/actions/deliver/artifacts.js';
import { listIdeaSubmissions } from '../task-engine/actions/idea-storage.js';
import {
  parentAreaDirectory,
  type SelectionFailure,
  selectionFailureDeclaration,
} from '../task-engine/actions/select-work/artifacts.js';
import {
  preparationAttemptDeclaration,
  preparationStages,
  stageRoundPlanDeclaration,
  type PreparationStage,
} from '../task-engine/actions/preparation/artifacts.js';
import { implementationHandoffFailureDeclaration } from '../task-engine/actions/project/implementation-handoff/artifacts.js';
import { stageFailureDeclaration } from '../task-engine/actions/preparation/failure.js';
import { preparationPublicationFailureDeclaration } from '../task-engine/actions/project/publish-preparation/artifacts.js';
import {
  readStageTerminal,
  readStagePlan,
  stageRoot,
  stageRounds,
} from '../task-engine/actions/preparation/storage.js';
import { reportFeedbackDirectory } from '../task-engine/actions/report-feedback.js';
import {
  attemptDeclaration,
  attemptFile,
  preparationFailureDeclaration,
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../task-engine/actions/prepare-workspace/artifacts.js';
import { readRecord, type RecordDeclaration } from '../task-engine/actions/records.js';
import type { Selection } from '../task-engine/actions/select-task/artifacts.js';
import {
  currentRoundDeclaration,
  currentRoundFile,
  roundExhaustionDeclaration,
} from '../task-engine/actions/start-round/artifacts.js';
import { ideaRoundPlanDeclaration } from '../task-engine/actions/start-idea-round/artifacts.js';
import { terminalReasonSchema } from '../task-engine/actions/terminal-reason.js';

/**
 * Application's workflow bindings for AnalyzeExperience: the terminal handoff each workflow state
 * supplies and the producer-owned evidence it selects from the retained workspace. The action
 * itself switches on no workflow name, task source status or concrete action implementation;
 * these tables own that workflow knowledge. See docs/task-engine/actions/analyze-experience.md.
 */

/** The evidence area one finite-delivery terminal retained. */
type FiniteEvidence = 'round' | 'preparation';

/** How one terminal producer retains the reason for its failed or exhausted outcome. */
type TerminalReasonRecord =
  | { readonly kind: 'state'; readonly declaration: RecordDeclaration }
  | { readonly kind: 'round'; readonly pathFromArtifactsRoot: string };

/** One finite-delivery terminal: the outcome the workflow preserves and the producer that stated it. */
export const finiteDeliveryTerminals = {
  'complete-completed': {
    outcome: 'completed',
    producer: 'complete-task',
    evidence: 'round',
  },
  'complete-failed': {
    outcome: 'failed',
    producer: 'complete-task',
    evidence: 'round',
    reason: {
      kind: 'round',
      pathFromArtifactsRoot: completionFailureArtifact.pathFromArtifactsRoot,
    },
  },
  'prepare-failed': {
    outcome: 'failed',
    producer: 'prepare-workspace',
    evidence: 'preparation',
    reason: { kind: 'state', declaration: preparationFailureDeclaration },
  },
  'start-round-exhausted': {
    outcome: 'exhausted',
    producer: 'start-round',
    evidence: 'round',
    reason: { kind: 'state', declaration: roundExhaustionDeclaration },
  },
  'deliver-failed': {
    outcome: 'failed',
    producer: 'deliver',
    evidence: 'round',
    reason: { kind: 'round', pathFromArtifactsRoot: deliveryFailureArtifact.pathFromArtifactsRoot },
  },
  'review-publication-failed': {
    outcome: 'failed',
    producer: 'review-publication',
    evidence: 'round',
  },
} as const satisfies Record<
  string,
  {
    readonly outcome: string;
    readonly producer: string;
    readonly evidence: FiniteEvidence;
    readonly reason?: TerminalReasonRecord;
  }
>;

export type FiniteDeliveryTerminal = keyof typeof finiteDeliveryTerminals;

/**
 * The parent's idea-publication terminals: the business decision the parent published. Analysis
 * preserves the destination; the decision record carries the child's reason.
 */
export const ideaPublicationTerminals = ['idea-approved', 'idea-feedback'] as const;

export type IdeaPublicationTerminal = (typeof ideaPublicationTerminals)[number];

/**
 * The parent's preparation-terminal handoffs a binding captures: the evaluated stage the parent
 * published, the business destination the analysis preserves and the producer that stated the
 * reason. A skip and an exhaustion are published outcomes too; a blocked preparation never reaches
 * the parent. The former intermediate-success terminal is not captured any more: it survives only
 * as the legacy binding of a retained snapshot paused at that state.
 */
export const preparationTerminalEntries = {
  'preparation-handoff': { outcome: 'handed-off', destination: 'select' },
  'preparation-waiting': { outcome: 'needs-input', destination: 'select' },
  'preparation-exhausted': { outcome: 'exhausted', destination: 'select' },
  'preparation-publication-failed': { outcome: 'failed', destination: 'blocked' },
  'preparation-failed': { outcome: 'failed', destination: 'blocked' },
  'handoff-failed': { outcome: 'failed', destination: 'blocked' },
  'selection-failed': { outcome: 'failed', destination: 'blocked' },
} as const satisfies Record<
  string,
  { readonly outcome: string; readonly destination: 'route' | 'handoff' | 'select' | 'blocked' }
>;

export type PreparationTerminal = keyof typeof preparationTerminalEntries;

/** Whether one value names a parent preparation terminal. */
export function isPreparationTerminal(value: unknown): value is PreparationTerminal {
  return typeof value === 'string' && Object.hasOwn(preparationTerminalEntries, value);
}

const ideaPublicationOutcomes: Record<IdeaPublicationTerminal, string> = {
  'idea-approved': 'approved',
  'idea-feedback': 'waiting-for-feedback',
};

/** The operation terminal one workflow state supplies with its AnalyzeExperience invocation. */
type TerminalInput = { readonly terminal?: unknown };

/** One workflow-supplied terminal name, or an execution error naming the unknown value. */
function terminalOf<Terminal extends string>(
  input: unknown,
  terminals: Readonly<Record<Terminal, unknown>>,
  workflow: string,
): Terminal {
  const terminal = (input as TerminalInput | undefined)?.terminal;
  const found = Object.keys(terminals).find((candidate) => candidate === terminal);
  if (found === undefined) {
    throw new Error(
      `The ${workflow} workflow supplied AnalyzeExperience the unknown terminal ` +
        `${JSON.stringify(terminal)}.`,
    );
  }
  return found as Terminal;
}

/** The finite-delivery terminal one workflow state supplied. */
export function finiteTerminalOf(input: unknown): FiniteDeliveryTerminal {
  return terminalOf(input, finiteDeliveryTerminals, 'finite delivery');
}

/** The parent idea-publication terminal one parent state supplied. */
export function ideaPublicationTerminalOf(input: unknown): IdeaPublicationTerminal {
  return terminalOf(input, { 'idea-approved': true, 'idea-feedback': true }, 'idea publication');
}

/** Whether one path currently exists as a file. */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * The regular files one retained directory tree holds, in stable order. Symbolic links are left
 * out: a citation must resolve to a real file inside the work item, and a link could point outside
 * it when the analyst later reads it.
 */
async function retainedFiles(root: string, relative: string): Promise<string[]> {
  const files: string[] = [];
  /** One directory's entries, or null when it does not exist. */
  async function entriesOf(directory: string): Promise<Dirent<string>[] | null> {
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  async function walk(directory: string): Promise<void> {
    const entries = await entriesOf(directory);
    if (entries === null) {
      return;
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile()) {
        files.push(target);
      }
    }
  }
  await walk(path.join(root, relative));
  return files;
}

/**
 * The attempt state one finite-delivery workspace retains: the identity PrepareWorkspace recorded
 * for it and the current round it opened. An attempt prepared before the identity was retained
 * falls back to its branch name, as the earlier binding did.
 */
async function finiteAttemptState(root: string): Promise<{
  readonly attemptId: string;
  readonly round: number | null;
}> {
  const [attempt, prepared, round] = await Promise.all([
    readRecord(path.join(root, attemptFile), attemptDeclaration),
    readRecord(path.join(root, preparedWorkspaceFile), preparedWorkspaceDeclaration),
    readRecord(path.join(root, currentRoundFile), currentRoundDeclaration),
  ]);
  return {
    attemptId: attempt?.attemptId ?? prepared?.branch ?? 'unprepared',
    round: round?.number ?? null,
  };
}

/** The finite-delivery evidence files one terminal retained, in the order the analyst reads them. */
async function finiteEvidence(
  root: string,
  area: FiniteEvidence,
  round: number | null,
): Promise<string[]> {
  const files: string[] = [];
  if (area === 'preparation') {
    files.push(...(await retainedFiles(root, 'state')));
    return files;
  }
  const prepared = path.join(root, preparedWorkspaceFile);
  if (await isFile(prepared)) {
    files.push(prepared);
  }
  if (round === null) {
    // No round was opened; whatever preparation retained is this attempt's evidence.
    files.push(...(await retainedFiles(root, 'state')));
    return files;
  }
  files.push(path.join(root, currentRoundFile));
  // Earlier rounds are this attempt's history: they retain the failed approaches and changed
  // conclusions the analyst needs after the attempt's own evidence is replaced.
  for (let number = 1; number <= round; number += 1) {
    files.push(...(await retainedFiles(root, path.join('artifacts', String(number)))));
  }
  return files;
}

/** How one terminal states its producer's reason record, when the producer retains one. */
function terminalReasonRecordOf(terminal: {
  readonly outcome: string;
  readonly producer: string;
  readonly reason?: TerminalReasonRecord;
}): TerminalReasonRecord | undefined {
  return terminal.reason;
}

/** The file one terminal producer retained its stated reason in, or null when it states none. */
function terminalReasonFile(
  root: string,
  record: TerminalReasonRecord | undefined,
  round: number | null,
): string | null {
  if (record === undefined) {
    return null;
  }
  if (record.kind === 'state') {
    return path.join(root, record.declaration.file);
  }
  return round === null ? null : roundArtifactPath(root, round, record.pathFromArtifactsRoot);
}

/**
 * Read the reason the terminal's producer retained, or null when it stated none. A malformed
 * record is an error: the binding reports it as an unavailable capture instead of dropping the
 * producer's reason.
 */
async function retainedTerminalReason(file: string | null): Promise<string | null> {
  if (file === null) {
    return null;
  }
  const record = await readRecord(file, { file, schema: terminalReasonSchema });
  return record === null ? null : record.reason;
}

/**
 * The idea submission one terminal handoff belongs to: the planned submission, or the newest
 * retained submission when a later one was created before its plan was saved. The retained
 * selection names the submission it opens, and a partial initialization is that interrupted
 * submission, never the previous plan's submission.
 */
async function ideaSubmission(root: string): Promise<number | null> {
  const plan = await readRecord(
    path.join(root, ideaRoundPlanDeclaration.file),
    ideaRoundPlanDeclaration,
  );
  const retained = (await listIdeaSubmissions(root)).at(-1) ?? 0;
  const submission = Math.max(plan?.submission ?? 0, retained);
  return submission === 0 ? null : submission;
}

/** One idea submission's identity and retained artifacts under the refinement area. */
async function ideaAttempt(root: string): Promise<{
  readonly attemptId: string;
  readonly files: string[];
}> {
  const submission = await ideaSubmission(root);
  if (submission === null) {
    return { attemptId: 'unprepared', files: [] };
  }
  return {
    attemptId: `submission-${String(submission)}`,
    files: await retainedFiles(root, path.join('artifacts', 'submissions', String(submission))),
  };
}

/**
 * The associated Markdown one selected producer outcome binds, or null when the record carries no
 * binding. The shared binding declaration is the producer's exported association; a former
 * combined record keeps its narrative in place and states none. Reading is best-effort: a file
 * that is not a JSON record contributes nothing, and its own bytes stay selected evidence.
 */
async function boundReportOf(file: string): Promise<string | null> {
  if (!file.endsWith('.json')) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
  return reportBindingOf(value)?.report.path ?? null;
}

/**
 * The evidence one terminal handoff carries, as the action's input shape: the selected producer
 * outcomes and files, extended with the Markdown reports their bindings associate, so capture
 * retains the complete narrative before the attempt that produced it can be discarded. Original
 * paths stay in place and keep their identities; a repeated path is selected once.
 */
async function handoffArtifacts(files: readonly string[]): Promise<{ readonly path: string }[]> {
  const selected = [...files];
  const known = new Set(selected);
  for (const file of files) {
    const report = await boundReportOf(file);
    if (report !== null && !known.has(report)) {
      known.add(report);
      selected.push(report);
    }
  }
  return selected.map((path) => ({ path }));
}

/** Build the terminal handoff of one finite-delivery terminal for the selected work item. */
export async function finiteDeliveryHandoff(options: {
  readonly selection: Selection;
  readonly terminal: FiniteDeliveryTerminal;
}): Promise<ExperienceHandoff> {
  const root = options.selection.workspace.root;
  const terminal = finiteDeliveryTerminals[options.terminal];
  const attempt = await finiteAttemptState(root);
  const files = await finiteEvidence(root, terminal.evidence, attempt.round);
  const reasonFile = terminalReasonFile(root, terminalReasonRecordOf(terminal), attempt.round);
  if (reasonFile !== null && !files.includes(reasonFile) && (await isFile(reasonFile))) {
    files.push(reasonFile);
  }
  return {
    workId: options.selection.taskKey,
    workflow: 'finite-delivery',
    attemptId: attempt.attemptId,
    terminalId: options.terminal,
    outcome: terminal.outcome,
    reason: await retainedTerminalReason(reasonFile),
    workspaceRoot: root,
    artifacts: await handoffArtifacts(files),
  };
}

/**
 * Build the terminal handoff of one parent idea publication for the selected submission: the
 * refinement area's retained artifacts after the parent published the decision.
 */
export async function ideaPublicationHandoff(options: {
  readonly selection: Selection;
  readonly terminal: IdeaPublicationTerminal;
}): Promise<ExperienceHandoff> {
  const root = path.join(options.selection.workspace.root, 'refinement');
  const attempt = await ideaAttempt(root);
  return {
    workId: options.selection.taskKey,
    workflow: 'idea-refinement',
    attemptId: attempt.attemptId,
    terminalId: options.terminal,
    outcome: ideaPublicationOutcomes[options.terminal],
    reason: null,
    workspaceRoot: root,
    artifacts: await handoffArtifacts(attempt.files),
  };
}

/**
 * The opaque handoff attempt identity of one preparation attempt: the retained unique value, the
 * stage and the round, or an explicit no-round value. The minted value contains no colon, so the
 * colon-separated tuple is unambiguous and distinct attempts never share an identity.
 */
function preparationAttemptIdentity(
  attemptId: string,
  stage: PreparationStage,
  round: number | null,
): string {
  return `${attemptId}:${stage}:${round === null ? 'no-round' : `round-${String(round)}`}`;
}

/**
 * The identity one preparation area's handoff uses: the retained stage attempt combined with the
 * stage and round for a new-format stage, or the former stage/round tuple for a pre-upgrade area
 * that has no attempt record, so a retained legacy attempt replays its former identity.
 */
function preparationHandoffIdentity(settings: {
  readonly attemptId: string | null;
  readonly stage: PreparationStage;
  readonly round: number | null;
  readonly legacy: string;
}): string {
  return settings.attemptId === null
    ? settings.legacy
    : preparationAttemptIdentity(settings.attemptId, settings.stage, settings.round);
}

/**
 * The retained identity of one preparation stage area: its attempt declaration and round plan,
 * read through the stage's own producers. A retained stage attempt names a fresh attempt even
 * when its stage, round and terminal repeat; a pre-upgrade area without the attempt record keeps
 * its former stage/round tuple.
 */
async function preparationAreaIdentity(
  root: string,
  stage: PreparationStage,
): Promise<{ readonly attemptId: string; readonly round: number | null }> {
  const [plan, attempt] = await Promise.all([
    readRecord(path.join(root, stageRoundPlanDeclaration.file), stageRoundPlanDeclaration),
    readRecord(path.join(root, preparationAttemptDeclaration.file), preparationAttemptDeclaration),
  ]);
  const round = plan?.round ?? null;
  return {
    attemptId: preparationHandoffIdentity({
      attemptId: attempt?.attemptId ?? null,
      stage,
      round,
      legacy: round === null ? 'unprepared' : `${stage}-round-${String(round)}`,
    }),
    round,
  };
}

/**
 * The identity one successful implementation handoff replays or records: the existing preparation
 * handoff derivation from the published stage's retained attempt and round declarations, with the
 * legacy fallback for a pre-upgrade area. A binding resolves it before evidence discovery, so a
 * recorded final request is reused instead of rebuilt with a conflicting expanded artifact list.
 */
export async function preparationSuccessIdentity(options: {
  readonly selection: Selection;
  /** The evaluated stage whose success the implementation handoff completed; Architecture. */
  readonly stage: PreparationStage;
}): Promise<ExperienceHandoffIdentity> {
  const { attemptId } = await preparationAreaIdentity(
    stageRoot(options.selection.workspace.root, options.stage),
    options.stage,
  );
  return {
    workId: options.selection.taskKey,
    workflow: 'preparation',
    attemptId,
    terminalId: 'preparation-handoff',
  };
}

/**
 * The complete retained preparation evidence of one successful implementation handoff: the issue
 * root's parent area and every evaluated stage's retained state, validation history and numbered
 * round trees, in stable stage, numeric-round and path order. Missing areas contribute nothing,
 * and cumulative rounds are selected whole so rejected revisions, evaluated skips, corrections
 * and reevaluations keep their original stage, round and revision attribution.
 */
async function preparationSuccessEvidence(issueRoot: string): Promise<string[]> {
  const selected = new Set<string>();
  const collect = async (area: string, relative: string): Promise<void> => {
    for (const file of await retainedFiles(area, relative)) {
      selected.add(file);
    }
  };
  await collect(issueRoot, parentAreaDirectory);
  for (const stage of preparationStages) {
    const area = stageRoot(issueRoot, stage);
    await collect(area, 'state');
    await collect(area, reportFeedbackDirectory);
    for (const round of await stageRounds(area)) {
      await collect(area, path.join('artifacts', String(round)));
    }
  }
  return [...selected];
}

/**
 * Build the terminal handoff of one published preparation result. The final successful handoff
 * selects the whole retained preparation, because consolidation moved its analysis boundary to
 * the implementation handoff; every other terminal keeps the published stage area's own retained
 * state and current round. A fresh attempt's identity distinguishes repeated stage, round and
 * terminal values.
 */
export async function preparationHandoff(options: {
  readonly selection: Selection;
  readonly terminal: PreparationTerminal;
  /** The evaluated stage the parent published; the selection may already name its destination. */
  readonly stage: PreparationStage;
}): Promise<ExperienceHandoff> {
  const stage = options.stage;
  const issueRoot = options.selection.workspace.root;
  const root = stageRoot(issueRoot, stage);
  const identity = await preparationAreaIdentity(root, stage);
  const success = options.terminal === 'preparation-handoff';
  const files = success
    ? await preparationSuccessEvidence(issueRoot)
    : [
        ...(await retainedFiles(root, 'state')),
        ...(identity.round === null
          ? []
          : await retainedFiles(root, path.join('artifacts', String(identity.round)))),
      ];
  const result = await readStageTerminal(root);
  const isHandoff = success || options.terminal === 'handoff-failed';
  let reason = result?.reason ?? null;
  if (!success && isHandoff) files.push(...(await retainedFiles(issueRoot, parentAreaDirectory)));
  if (options.terminal === 'handoff-failed') {
    reason =
      (
        await readRecord(
          path.join(issueRoot, implementationHandoffFailureDeclaration.file),
          implementationHandoffFailureDeclaration,
        )
      )?.reason ?? null;
  } else if (
    options.terminal === 'preparation-failed' ||
    options.terminal === 'preparation-publication-failed'
  ) {
    const declaration =
      options.terminal === 'preparation-publication-failed'
        ? preparationPublicationFailureDeclaration
        : stageFailureDeclaration;
    reason = (await readRecord(path.join(root, declaration.file), declaration))?.reason ?? null;
  }

  return {
    workId: options.selection.taskKey,
    workflow: 'preparation',
    attemptId: identity.attemptId,
    terminalId: options.terminal,
    outcome: preparationTerminalEntries[options.terminal].outcome,
    reason,
    workspaceRoot:
      isHandoff || files.some((file) => file.startsWith(path.join(issueRoot, 'parent')))
        ? issueRoot
        : root,
    artifacts: await handoffArtifacts(files),
  };
}

/**
 * Capture the producer's actual failed candidate and reason. Only an explicitly retained selected
 * snapshot can supply stage evidence; a failure before ownership uses its execution-level record.
 */
export async function selectionFailureHandoff(options: {
  readonly failure: SelectionFailure;
  readonly failureFile: string;
}): Promise<ExperienceHandoff> {
  const selection = options.failure.selection;
  const selectedFailureFile =
    selection === null
      ? null
      : path.join(selection.workspace.root, parentAreaDirectory, selectionFailureDeclaration.file);
  const owned = selectedFailureFile !== null && (await isFile(selectedFailureFile));
  const root =
    owned && selection !== null ? selection.workspace.root : path.dirname(options.failureFile);
  const area =
    !owned || selection === null || selection.stage === 'idea' || selection.stage === 'delivery'
      ? null
      : selection.stage;
  const files = area === null ? [] : await retainedFiles(stageRoot(root, area), 'state');
  return {
    workId: options.failure.taskKey,
    workflow: 'selection',
    attemptId:
      selection === null
        ? `candidate-${options.failure.source.issueId}`
        : area === null
          ? 'unprepared'
          : `${area}-selection`,
    terminalId: 'selection-failed',
    outcome: 'failed',
    reason: options.failure.reason,
    workspaceRoot: root,
    artifacts: await handoffArtifacts([
      owned && selectedFailureFile !== null ? selectedFailureFile : options.failureFile,
      ...files,
    ]),
  };
}

/**
 * Build the handoff of an operational error Application observed after the worker settled: the
 * original fault and the interrupted attempt's retained evidence, recorded before recovery can
 * replace that attempt.
 */
export async function operationalErrorHandoff(options: {
  readonly selection: Selection;
  readonly failure: string;
}): Promise<ExperienceHandoff> {
  const selection = options.selection;
  const root = selection.workspace.root;
  if (selection.stage === 'idea') {
    const refinement = path.join(root, 'refinement');
    const attempt = await ideaAttempt(refinement);
    return {
      workId: selection.taskKey,
      workflow: 'idea-refinement',
      attemptId: attempt.attemptId,
      terminalId: 'operational-error',
      outcome: 'error',
      reason: options.failure,
      workspaceRoot: refinement,
      artifacts: await handoffArtifacts(attempt.files),
    };
  }
  if (selection.stage !== 'delivery') {
    // A preparation stage's attempt retains its rounds and state under its own area; its round is
    // read through the preparation stage's own declarations, not the finite-delivery schema. The
    // operational-error identity is the same derivation the stage's published terminals use, while
    // a pre-upgrade area keeps its former operational-error tuple and workflow naming.
    const area = stageRoot(root, selection.stage);
    const plan = await readStagePlan(area);
    const attempt = await readRecord(
      path.join(area, preparationAttemptDeclaration.file),
      preparationAttemptDeclaration,
    );
    const files = [
      ...(await retainedFiles(area, 'state')),
      ...(plan === null
        ? []
        : await retainedFiles(area, path.join('artifacts', String(plan.round)))),
    ];
    return {
      workId: selection.taskKey,
      workflow: selection.stage,
      attemptId: preparationHandoffIdentity({
        attemptId: attempt?.attemptId ?? null,
        stage: selection.stage,
        round: plan?.round ?? null,
        legacy: plan === null ? 'unprepared' : `round-${String(plan.round)}`,
      }),
      terminalId: 'operational-error',
      outcome: 'error',
      reason: options.failure,
      workspaceRoot: area,
      artifacts: await handoffArtifacts(files),
    };
  }
  const attempt = await finiteAttemptState(root);
  const files = await finiteEvidence(
    root,
    attempt.round === null ? 'preparation' : 'round',
    attempt.round,
  );
  return {
    workId: selection.taskKey,
    workflow: 'finite-delivery',
    attemptId: attempt.attemptId,
    terminalId: 'operational-error',
    outcome: 'error',
    reason: options.failure,
    workspaceRoot: root,
    artifacts: await handoffArtifacts(files),
  };
}
