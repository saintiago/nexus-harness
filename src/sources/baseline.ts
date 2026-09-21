/**
 * The pre-delivery baseline diagnosis: the one bounded reviewer turn a
 * completed red baseline on a fresh workspace enters before any coding turn.
 *
 * ```text
 * completed red baseline -> one reviewer turn over the snapshot
 *                              |                     |
 *                    actionable finding      nothing actionable
 *                              |                     |
 *              one comment + return to ready   one comment + stay in review
 *                              |
 *            the next claim continues the same workspace
 * ```
 *
 * The ticket is claimed, its workspace is created, and the baseline checks fail
 * before a developer starts. That is not a failed attempt to publish and wait
 * on: the reviewer inspects the exact source snapshot and the evidence the
 * configured commands wrote, and says either what the next coding turn should
 * repair or why no repair may be made. An actionable finding is recorded in
 * Jira as one comment and the item returns to the status it was claimed from,
 * with its workspace pointer preserved — nothing else about an attempt happens,
 * and no separate ticket, label, or manual ranking step is invented. Everything
 * else leaves the item In Review with the evidence and what a person must do.
 *
 * Nothing here is published anywhere but Jira, and nothing here is evidence of
 * a review: there is no pull request yet, so no GitHub review, Lens approval, or
 * check is fabricated for one.
 *
 * The marker inside the comment is what a restart reads: the same evidence
 * identity — the same immutable item, snapshot, commands, and results — is never
 * diagnosed twice, no second reviewer turn is paid for, and the run resumes by
 * making the status move it had not yet made.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import { readBaselineFinding } from '../reviews/baseline.js';
import { BASELINE_GUIDANCE_PREFIX } from '../runs/contracts.js';
import { unconfirmedShutdownProblem } from '../runs/progress.js';
import type { CheckRoundResult, CommandResult, SourceRef, Task } from '../shared/types.js';
import type {
  BaselineDiagnosis,
  BaselineDiagnosisOutcome,
  BaselineDiagnosisRequest,
  BaselineFinding,
  BaselineItem,
  BaselineRecord,
  BaselineReview,
  BaselineReviewResult,
  BaselineResumeOutcome,
  BaselineReviewedFinding,
  SourceIo,
  SourceNote,
} from './contract.js';
import { SourceError } from './contract.js';
import { readReceipt, receiptFilePath, updateReceipt } from './receipts.js';

/** The prefix of the marker one diagnosis comment carries, in the Jira thread. */
export const BASELINE_MARKER_PREFIX = 'nexus-baseline:';

/** How wide one comment line may grow before it is truncated. */
const LINE_LIMIT = 600;

/** The marker naming one actionable finding for one evidence identity. */
function repairMarker(evidenceId: string): string {
  return `${BASELINE_MARKER_PREFIX}repair:${evidenceId}`;
}

/** The marker naming one non-actionable diagnosis for one evidence identity. */
function attentionMarker(evidenceId: string): string {
  return `${BASELINE_MARKER_PREFIX}attention:${evidenceId}`;
}

/**
 * The identity of one baseline observation: the immutable item, the snapshot the
 * baseline ran against, and the configured commands with the results they
 * produced. Same item, same snapshot, same results — the same evidence, which a
 * restart recognises and never diagnoses twice. A changed snapshot, a changed
 * command, or a different result is new evidence and is diagnosed again.
 */
export function baselineEvidenceId(
  ref: SourceRef,
  baseCommit: string,
  round: CheckRoundResult,
): string {
  const invocation = (result: CommandResult): readonly unknown[] => [
    result.command,
    result.outcome,
    result.exitCode,
    result.signal,
    result.launchError,
  ];
  return createHash('sha256')
    .update(
      JSON.stringify([
        ref.type,
        ref.scope,
        ref.id,
        baseCommit,
        round.setup.map(invocation),
        round.checks.map(invocation),
      ]),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);
}

/** One line of text, so a finding cannot grow a comment without limit. */
function oneLine(text: string, limit = LINE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** The one marker on the thread that belongs to this evidence, and what it is. */
function markerFor(
  notes: readonly SourceNote[],
  evidenceId: string,
): { readonly kind: 'repair' | 'attention'; readonly note: SourceNote } | null {
  for (const note of notes) {
    for (const kind of ['repair', 'attention'] as const) {
      if (note.text.includes(`${BASELINE_MARKER_PREFIX}${kind}:${evidenceId}`)) {
        return { kind, note };
      }
    }
  }
  return null;
}

/**
 * The one comment a diagnosis posts. It names the failing check, the evidence,
 * the likely cause and the repair for an actionable finding — or why nothing is
 * actionable and what a person must do — and it carries the marker a restart
 * reads. It carries no transcript, no diff, and no credential.
 */
function diagnosisParagraphs(parts: {
  readonly key: string;
  readonly finding: BaselineFinding;
  readonly marker: string;
  readonly readyStatus: string;
  readonly reviewStatus: string;
}): readonly string[] {
  const { key, finding, marker, readyStatus, reviewStatus } = parts;
  if (finding.outcome === 'repair') {
    return [
      `${key}: the configured baseline checks failed before any coding turn, and the diagnosis is ` +
        `actionable (${marker}, written by the Nexus harness).`,
      `Failing check: ${oneLine(finding.failingCheck)}`,
      `Evidence: ${oneLine(finding.evidence)}`,
      `Likely cause: ${oneLine(finding.likelyCause)}`,
      `Repair guidance: ${oneLine(finding.repairGuidance)}`,
      `Returned to "${readyStatus}" with its workspace pointer preserved: the next claim continues ` +
        'the same retained workspace, repairs the baseline before anything else, and then carries ' +
        'on with the original task. The configured checks still decide the attempt, and nothing is ' +
        'delivered or reviewed until a post-agent round passes every one of them.',
    ];
  }
  return [
    `${key}: the configured baseline checks failed before any coding turn, and no repair is ` +
      `actionable (${marker}, written by the Nexus harness).`,
    `Why no repair: ${oneLine(finding.reason)}`,
    `Required action: ${oneLine(finding.requiredAction)}`,
    `It stays in "${reviewStatus}" for a person. No coding turn is started from this diagnosis, ` +
      'the harness does not guess at a repair, and nothing is delivered or reviewed.',
  ];
}

/** The fields of one actionable finding, in the order its comment writes them. */
const REPAIR_FIELD_LABELS = [
  'Failing check',
  'Evidence',
  'Likely cause',
  'Repair guidance',
] as const;
/** The fields of one non-actionable finding, in the order its comment writes them. */
const ATTENTION_FIELD_LABELS = ['Why no repair', 'Required action'] as const;

/**
 * The requirement every actionable finding carries before its own fields: the
 * baseline is what the attempt repairs first, and the original task continues
 * only after it. It travels with the fields, as a guidance line of its own, so
 * neither the thread nor the evidence can hand a developer the finding without
 * the order it belongs in — and the coding prompt renders it as the requirement
 * it is rather than as context (docs/WORKFLOW.md §11).
 */
const REPAIR_FIRST_GUIDANCE = 'repair the baseline before continuing the original task';

/**
 * The reviewed finding one diagnosis comment carries, as separate guidance
 * lines: one line per field, each one exactly as wide as the comment's own
 * bound, so a later attempt is handed every field whole instead of one collapsed
 * paragraph whose tail — the likely cause and the repair — is what got cut.
 * An actionable finding carries the requirement to repair the baseline first
 * ahead of its fields; a non-actionable one carries its own two fields.
 *
 * A comment without a diagnosis marker, or without any of the fields, produces
 * nothing: the caller falls back to the ordinary one-line rendering of it. The
 * labels are this harness's own, written by `diagnosisParagraphs` above.
 */
export function baselineGuidanceLines(text: string): readonly string[] {
  if (!text.includes(BASELINE_MARKER_PREFIX)) {
    return [];
  }
  const repair: string[] = [];
  const attention: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    for (const label of REPAIR_FIELD_LABELS) {
      const prefix = `${label}: `;
      if (line.startsWith(prefix)) {
        repair.push(findingGuidanceLine(label, line.slice(prefix.length)));
      }
    }
    for (const label of ATTENTION_FIELD_LABELS) {
      const prefix = `${label}: `;
      if (line.startsWith(prefix)) {
        attention.push(findingGuidanceLine(label, line.slice(prefix.length)));
      }
    }
  }
  // The two shapes are exclusive in a comment this harness wrote. Should a
  // thread ever carry a mix, the actionable fields win: the ordering
  // requirement is never dropped from a finding a developer may act on.
  return repair.length > 0 ? [repairFirstGuidanceLine(), ...repair] : attention;
}

/** The one line that says what comes first, in the shape of a finding field. */
function repairFirstGuidanceLine(): string {
  return `${BASELINE_GUIDANCE_PREFIX}${REPAIR_FIRST_GUIDANCE}`;
}

/** One labelled field of a reviewed finding, as the line a later attempt reads. */
function findingGuidanceLine(label: string, value: string): string {
  const field = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  return `${BASELINE_GUIDANCE_PREFIX}${field}: ${value}`;
}

/**
 * The same reviewed finding, read back from the evidence instead of from the
 * comment that carries it, as the same guidance lines: each field bounded
 * exactly as the comment bounds it, so a developer who cannot be handed the
 * thread is handed the same finding the thread would have given them
 * (docs/WORKFLOW.md §11). An actionable finding is the same finding either way,
 * ordering requirement included.
 */
export function baselineFindingGuidanceLines(finding: BaselineFinding): readonly string[] {
  const labelled: readonly (readonly [string, string])[] =
    finding.outcome === 'repair'
      ? [
          [REPAIR_FIELD_LABELS[0], finding.failingCheck],
          [REPAIR_FIELD_LABELS[1], finding.evidence],
          [REPAIR_FIELD_LABELS[2], finding.likelyCause],
          [REPAIR_FIELD_LABELS[3], finding.repairGuidance],
        ]
      : [
          [ATTENTION_FIELD_LABELS[0], finding.reason],
          [ATTENTION_FIELD_LABELS[1], finding.requiredAction],
        ];
  const fields = labelled.map(([label, value]) => findingGuidanceLine(label, oneLine(value)));
  return finding.outcome === 'repair' ? [repairFirstGuidanceLine(), ...fields] : fields;
}

/** The file one pending diagnosis keeps what a restart resumes from. */
export const BASELINE_EVIDENCE_FILE = 'evidence.json';

/**
 * What one pre-delivery diagnosis records before its reviewer turn: the identity
 * of the evidence, the task the baseline failed under, the retained workspace it
 * ran in, and the completed red round itself. It is the local half of the
 * deduplication record — the comment on the item's thread is the remote half —
 * and it is what an invocation that stopped after this record was written, and
 * before the finding was published, resumes from instead of leaving the ticket
 * in the running status.
 */
export interface BaselineEvidence {
  readonly version: 1;
  /** The evidence identity; also the name of the directory this record lives in. */
  readonly evidenceId: string;
  /**
   * The connected project the evidence belongs to: the namespace
   * `src/config/load.ts` derives from the composed connection identity, the same
   * one the project's intake lock is named by. One `workDir` serves several
   * connected projects, and neither reads, finishes, nor publishes the other's
   * evidence (docs/WORKFLOW.md §11).
   */
  readonly project: string;
  readonly ref: SourceRef;
  /** The task the baseline failed under, as the item was prepared for it. */
  readonly task: Task;
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseCommit: string;
  };
  /** The configured commands and the results they produced. */
  readonly baseline: CheckRoundResult;
  /** How this piece of evidence ended; absent while its diagnosis is unfinished. */
  readonly closed?: 'repair' | 'attention' | 'left-alone';
  readonly closedAt?: string;
}

/**
 * Where one diagnosis keeps its evidence:
 * `<workDir>/baseline/<project>/<evidenceId>`.
 */
function evidenceDirectory(workDir: string, project: string, evidenceId: string): string {
  return path.join(workDir, 'baseline', project, evidenceId);
}

/** The record file of one piece of evidence. */
function evidenceFile(workDir: string, project: string, evidenceId: string): string {
  return path.join(evidenceDirectory(workDir, project, evidenceId), BASELINE_EVIDENCE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One nonblank string field of a record, or `null` when it does not hold one. */
function textField(record: Record<string, unknown>, name: string): string | null {
  const value = record[name];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Why a file under the diagnosis's own evidence directory cannot be read as its record. */
function evidenceProblem(file: string, problem: string): SourceError {
  return new SourceError(
    'fatal',
    `the baseline evidence "${file}" ${problem}, so the diagnosis it describes cannot be ` +
      'resumed. Inspect it by hand; do not treat it as nothing pending.',
  );
}

/**
 * Reads one diagnosis's record. `null` means the file is not there — a
 * diagnosis that never reached its reviewer turn, or one whose record was
 * written by something else entirely — while a file that is there and does not
 * hold a record this harness wrote is refused by name. Treating a corrupt record
 * as "nothing pending" is exactly how a diagnosis that never finished would be
 * forgotten, and the item left in the running status with nothing looking for
 * it. The record has to be one this connected project wrote: evidence of
 * another project under the same output directory is refused rather than
 * finished or published through this project's connection.
 */
async function readEvidence(file: string, project: string): Promise<BaselineEvidence | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw evidenceProblem(file, `could not be read (${messageOf(cause)})`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw evidenceProblem(file, `is not valid JSON (${messageOf(cause)})`);
  }
  if (!isRecord(value) || value['version'] !== 1) {
    throw evidenceProblem(file, 'is not a record this harness wrote');
  }
  const evidenceId = textField(value, 'evidenceId');
  const recordProject = textField(value, 'project');
  const ref = value['ref'];
  const task = value['task'];
  const workspace = value['workspace'];
  const baseline = value['baseline'];
  if (
    evidenceId === null ||
    recordProject === null ||
    !isRecord(ref) ||
    !isRecord(task) ||
    !isRecord(workspace) ||
    !isRecord(baseline)
  ) {
    throw evidenceProblem(file, 'does not hold the item, task, workspace, and round it describes');
  }
  if (recordProject !== project) {
    throw evidenceProblem(
      file,
      'was written for another connected project than the one reading it',
    );
  }
  const refFields = ['type', 'scope', 'id', 'key', 'url', 'updatedAt'].map((name) =>
    textField(ref, name),
  );
  const taskId = textField(task, 'id');
  const taskTitle = textField(task, 'title');
  const taskDescription = textField(task, 'description');
  const acceptanceCriteria = task['acceptanceCriteria'];
  const workspaceId = textField(workspace, 'workspaceId');
  const workspacePath = textField(workspace, 'workspacePath');
  const branch = textField(workspace, 'branch');
  const baseCommit = textField(workspace, 'baseCommit');
  const closedAt = textField(value, 'closedAt');
  const closed = value['closed'];
  if (
    refFields.some((field) => field === null) ||
    taskId === null ||
    taskTitle === null ||
    taskDescription === null ||
    !Array.isArray(acceptanceCriteria) ||
    !acceptanceCriteria.every((criterion) => typeof criterion === 'string') ||
    workspaceId === null ||
    workspacePath === null ||
    branch === null ||
    baseCommit === null ||
    !Array.isArray(baseline['setup']) ||
    !Array.isArray(baseline['checks'])
  ) {
    throw evidenceProblem(file, 'does not hold the fields a diagnosis resumes from');
  }

  const sourceRef: SourceRef = {
    type: refFields[0] ?? '',
    scope: refFields[1] ?? '',
    id: refFields[2] ?? '',
    key: refFields[3] ?? '',
    url: refFields[4] ?? '',
    updatedAt: refFields[5] ?? '',
  };
  const round = baseline as unknown as CheckRoundResult;
  // The identity is recomputed from what the record holds: evidence whose own
  // record no longer hashes to the name it was kept under is evidence this
  // harness cannot recognise, and it is refused rather than diagnosed again.
  if (baselineEvidenceId(sourceRef, baseCommit, round) !== evidenceId) {
    throw evidenceProblem(file, 'does not hash to the evidence identity it was kept under');
  }
  const closedKind =
    closed === 'repair' || closed === 'attention' || closed === 'left-alone' ? closed : null;

  return {
    version: 1,
    evidenceId,
    project: recordProject,
    ref: sourceRef,
    task: {
      id: taskId,
      title: taskTitle,
      description: taskDescription,
      acceptanceCriteria: [...acceptanceCriteria] as readonly string[],
    },
    workspace: { workspaceId, workspacePath, branch, baseCommit },
    baseline: round,
    ...(closedKind === null ? {} : { closed: closedKind }),
    ...(closedAt === null ? {} : { closedAt }),
  };
}

/** Writes one diagnosis's record, exclusively, before its reviewer turn runs. */
async function writeEvidence(file: string, evidence: BaselineEvidence): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
      encoding: 'utf8',
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw evidenceProblem(file, 'is already there, so this diagnosis cannot record its own');
    }
    throw evidenceProblem(file, `could not be written (${messageOf(cause)})`);
  }
}

/**
 * Marks one piece of evidence as finished, atomically and through a
 * same-directory temporary file, so a reader never sees half of one. A record
 * that is no longer there is left alone — the item's own thread is the authority
 * on what was published — and one that cannot be read back is reported by the
 * caller rather than overwritten with a record this harness did not write.
 */
async function closeEvidence(
  file: string,
  project: string,
  closed: BaselineEvidence['closed'],
): Promise<void> {
  const current = await readEvidence(file, project);
  if (current === null) {
    return;
  }
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...current, closed, closedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, file);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw evidenceProblem(file, `could not be marked as finished (${messageOf(cause)})`);
  }
}

/**
 * Every record the connected `project` has kept under `workDir`, oldest name
 * first. They are read in that fixed order so a resume is deterministic; each
 * one is skipped as soon as it says it finished, so a resolved diagnosis costs
 * one read and no remote call. Only this project's own evidence directory is
 * read: a `workDir` serves several connected projects, and starting one of them
 * must never enumerate, finish, or publish another's pending evidence
 * (docs/WORKFLOW.md §11).
 */
async function evidenceFiles(workDir: string, project: string): Promise<readonly string[]> {
  const root = path.join(workDir, 'baseline', project);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new SourceError(
      'fatal',
      `the retained baseline evidence under "${root}" could not be read: ${messageOf(cause)}`,
    );
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(root, name, BASELINE_EVIDENCE_FILE));
}

/**
 * What one resume outcome means for the intake that asked for it: `null` when
 * the pending diagnosis left nothing in the way — nothing was pending, or the
 * finding is published and the item is back in its ready status — and the stop
 * the caller has to make otherwise, with whether everything the diagnosis
 * started was confirmed stopped.
 *
 * An unconfirmed stop is never rounded down: the caller keeps its intake lock
 * and starts nothing else, because a reviewer runtime may still be running and
 * writing to the evidence (docs/spec.md §3, §11). The rule lives here once, so
 * the source command and the serial queue cannot read the same outcome
 * differently.
 */
export function resumeStop(
  resumed: BaselineResumeOutcome | null,
): { readonly detail: string; readonly cleanupConfirmed: boolean } | null {
  if (resumed === null || resumed.kind === 'repair') {
    return null;
  }
  return {
    detail: resumed.detail,
    cleanupConfirmed: resumed.kind === 'problem' ? true : resumed.cleanupConfirmed,
  };
}

/** What one pre-delivery diagnosis is built from, all ordinary pieces. */
export interface BaselineDiagnosisParts {
  /** The one bounded local reviewer turn the diagnosis runs. */
  readonly reviewer: BaselineReview;
  /** The item's own thread and status, as the diagnosis reads and writes them. */
  readonly record: BaselineRecord;
  /** The status an actionable finding returns the item to: where work is claimed from. */
  readonly readyStatus: string;
  /** The status a non-actionable diagnosis leaves the item in. */
  readonly reviewStatus: string;
  /**
   * How long one reviewer turn may run before it is stopped, in milliseconds.
   * The turn is bounded like every other launch the harness starts: a reviewer
   * that never answers cannot hold the intake open.
   */
  readonly reviewerTimeoutMs: number;
  /**
   * The connected project this diagnosis belongs to: the namespace the
   * composed configuration derives from its own connection identity, the same
   * one its intake lock is named by (`projectLockNamespace` in
   * `src/config/load.ts`). It names the evidence directory under `workDir`, so
   * two connected projects sharing one output directory never read, finish, or
   * publish each other's pending diagnoses (docs/WORKFLOW.md §11).
   */
  readonly project: string;
  /** `<workDir>`: where the diagnosis's own evidence directories are kept. */
  readonly workDir: string;
  readonly io: SourceIo;
}

/**
 * The one pre-delivery diagnosis. It is built once per source command and reused
 * for every red baseline that command observes.
 */
export function createBaselineDiagnosis(parts: BaselineDiagnosisParts): BaselineDiagnosis {
  const { reviewer, record, readyStatus, reviewStatus, reviewerTimeoutMs, project, workDir, io } =
    parts;

  /**
   * One outcome for a step that did not finish: a stop the caller asked for is
   * reported as the cancellation it is, and everything else is the attention
   * result whose evidence a person needs. `cleanupConfirmed` is `false` only
   * when the reviewer turn's own stop could not be confirmed: the intake then
   * keeps its lock instead of declaring an evidence directory safe while a
   * runtime may still be writing to it.
   */
  const unfinished = (
    stop: AbortSignal,
    detail: string,
    commentId: string | null,
    cleanupConfirmed = true,
  ): BaselineDiagnosisOutcome =>
    stop.aborted
      ? { kind: 'cancelled', detail, cleanupConfirmed }
      : { kind: 'attention', detail, commentId, cleanupConfirmed };

  /** One status move, reported as the step it is rather than as a refusal. */
  const move = async (
    item: BaselineItem,
    target: string,
    stop: AbortSignal,
  ): Promise<{ readonly moved: boolean } | { readonly problem: string }> => {
    try {
      const outcome = await record.moveFromRunning(item.ref.id, target, stop);
      return { moved: outcome === 'moved' };
    } catch (cause) {
      return { problem: messageOf(cause) };
    }
  };

  /**
   * Marks one piece of retained evidence as finished, and reports a failure to
   * do so without contradicting what the item's own thread already holds: the
   * comment is what decides, and an unreadable record is read again — never
   * diagnosed again — by the next resume.
   */
  const finish = async (
    file: string,
    evidence: BaselineEvidence,
    closed: BaselineEvidence['closed'],
  ): Promise<void> => {
    try {
      await closeEvidence(file, project, closed);
    } catch (cause) {
      io.err(
        `${evidence.ref.key}: the baseline diagnosis is on the issue, but its retained evidence ` +
          `could not be marked finished: ${messageOf(cause)}`,
      );
    }
  };

  /**
   * What the local receipt says once a diagnosis the item has been told about
   * has finished. It is bookkeeping beside the item's own thread, so a receipt
   * that cannot be read back is reported and nothing else is changed.
   */
  const noteFeedback = async (ref: SourceRef, commentId: string | null): Promise<void> => {
    const file = receiptFilePath(workDir, ref);
    try {
      if ((await readReceipt(file)) === null) {
        return;
      }
      await updateReceipt(file, {
        feedback: 'sent',
        ...(commentId === null ? {} : { commentId }),
      });
    } catch (cause) {
      io.err(
        `${ref.key}: the baseline diagnosis is on the issue, but its receipt could not be ` +
          `updated: ${messageOf(cause)}`,
      );
    }
  };

  const diagnose = async (request: BaselineDiagnosisRequest): Promise<BaselineDiagnosisOutcome> => {
    const { item, workspace, baseline, stop } = request;
    const key = item.ref.key;
    const evidenceId = baselineEvidenceId(item.ref, workspace.baseCommit, baseline);
    const dir = evidenceDirectory(workDir, project, evidenceId);
    const file = evidenceFile(workDir, project, evidenceId);

    if (stop.aborted) {
      return {
        kind: 'cancelled',
        detail: `${key}: the intake was stopped before its red baseline could be diagnosed`,
        cleanupConfirmed: true,
      };
    }

    // What a restart reads: the evidence is recorded before the reviewer turn
    // runs, so an invocation that stops between the two is finished by the
    // next one instead of leaving the item in the running status. A record
    // that is already there belongs to this same evidence — the identity is
    // recomputed from everything the diagnosis acts on — and is reused.
    let recorded: BaselineEvidence | null;
    try {
      recorded = await readEvidence(file, project);
    } catch (cause) {
      return unfinished(stop, `${key}: ${messageOf(cause)}`, null);
    }
    if (recorded === null) {
      const evidence: BaselineEvidence = {
        version: 1,
        evidenceId,
        project,
        ref: item.ref,
        task: item.task,
        workspace: {
          workspaceId: workspace.workspaceId,
          workspacePath: workspace.workspacePath,
          branch: workspace.branch,
          baseCommit: workspace.baseCommit,
        },
        baseline,
      };
      try {
        await writeEvidence(file, evidence);
      } catch (cause) {
        return unfinished(
          stop,
          `${key}: its red baseline was not diagnosed, and nothing was published or moved: ` +
            messageOf(cause),
          null,
        );
      }
      recorded = evidence;
    }

    let notes: readonly SourceNote[];
    try {
      notes = await record.listComments(item.ref.id, stop);
    } catch (cause) {
      return unfinished(
        stop,
        `${key}: its thread could not be read, so its red baseline was not diagnosed and the ` +
          `item was not moved: ${messageOf(cause)}`,
        null,
      );
    }

    // The thread is the deduplication record: evidence that already carries a
    // finding is never diagnosed again, and a run that stopped between the
    // comment and the status move resumes by making that one move.
    const existing = markerFor(notes, evidenceId);
    if (existing !== null) {
      const target = existing.kind === 'repair' ? readyStatus : reviewStatus;
      const moved = await move(item, target, stop);
      if ('problem' in moved) {
        return unfinished(
          stop,
          `${key}: its baseline finding is already on the issue (comment ` +
            `${existing.note.id}), but moving it to "${target}" failed: ${moved.problem}`,
          existing.note.id,
        );
      }
      const detail =
        `${key}: this exact baseline evidence was already diagnosed (comment ` +
        `${existing.note.id}); no second reviewer turn was started and no second comment was ` +
        `written` +
        (moved.moved
          ? `, and the item was moved to "${target}"`
          : `, and the item had already left its running status`);
      await finish(file, recorded, existing.kind);
      io.out(detail);
      return existing.kind === 'repair'
        ? { kind: 'repair', detail, commentId: existing.note.id }
        : { kind: 'attention', detail, commentId: existing.note.id, cleanupConfirmed: true };
    }

    io.out(
      `${key}: a completed red baseline before any coding turn; one reviewer turn is diagnosing ` +
        `the snapshot at ${workspace.baseCommit} (evidence under ${dir})`,
    );
    let reviewed: BaselineReviewResult;
    try {
      // The one turn is bounded like every other launch: the run's own stop
      // request, and a limit of its own so a reviewer that never answers
      // cannot hold the intake open.
      const turnStop = AbortSignal.any([stop, AbortSignal.timeout(Math.max(1, reviewerTimeoutMs))]);
      reviewed = await reviewer({
        dir,
        item,
        workspace: { path: workspace.workspacePath, baseCommit: workspace.baseCommit },
        baseline,
        stop: turnStop,
      });
    } catch (cause) {
      reviewed = {
        summary: null,
        finding: null,
        problem: messageOf(cause),
        logPath: path.join(dir, 'reviewer.log'),
        shutdown: null,
      };
    }

    // The reviewer turn's own stop is carried, never rounded down: an
    // unconfirmed one means the intake must keep its lock, because something
    // the reviewer runtime started may still be writing to its evidence.
    const unconfirmed = unconfirmedShutdownProblem(reviewed.shutdown ?? null);

    // A turn that failed, was stopped, wrote nothing usable, or left its view
    // changed has no finding: the diagnosis records that instead of guessing
    // at a repair, and the item stays In Review for a person.
    const finding: BaselineFinding = reviewed.finding ?? {
      outcome: 'inconclusive',
      reason: `the baseline diagnostic produced no usable finding: ${
        reviewed.problem ?? 'no reason was recorded'
      }`,
      requiredAction:
        unconfirmed === null
          ? 'Check the configured reviewer launch, its credentials, and the evidence under ' +
            `"${dir}", then move the item back to "${readyStatus}" to continue it, or repair the ` +
            'baseline by hand.'
          : 'Everything the reviewer runtime started was not seen to end ' +
            `(${oneLine(unconfirmed)}), so the intake lock is kept for inspection and nothing the ` +
            `diagnosis wrote is treated as settled. Check the reviewer launch and the evidence ` +
            `under "${dir}" by hand, then move the item back to "${readyStatus}" to continue it, ` +
            'or repair the baseline by hand.',
    };

    const marker =
      finding.outcome === 'repair' ? repairMarker(evidenceId) : attentionMarker(evidenceId);
    const paragraphs = diagnosisParagraphs({
      key,
      finding,
      marker,
      readyStatus,
      reviewStatus,
    });

    let commentId: string;
    try {
      commentId = await record.postComment(item.ref.id, paragraphs, stop);
    } catch (cause) {
      return unfinished(
        stop,
        `${key}: the diagnosis could not be confirmed on the issue, so nothing was moved and ` +
          `the red baseline still needs a person: ${messageOf(cause)}`,
        null,
        unconfirmed === null,
      );
    }

    const target = finding.outcome === 'repair' ? readyStatus : reviewStatus;
    const moved = await move(item, target, stop);
    if ('problem' in moved) {
      return unfinished(
        stop,
        `${key}: the diagnosis is on the issue (comment ${commentId}) but moving it to ` +
          `"${target}" failed: ${moved.problem}`,
        commentId,
        unconfirmed === null,
      );
    }

    const where = moved.moved
      ? `the item was moved to "${target}"`
      : `the item had already left its running status, so it was left where it is`;
    await finish(file, recorded, finding.outcome === 'repair' ? 'repair' : 'attention');
    if (finding.outcome === 'repair') {
      const detail =
        `${key}: the red baseline is diagnosed and actionable (comment ${commentId}); ${where} ` +
        'with its workspace pointer preserved, ready for the next claim to repair the baseline ' +
        'and continue the original task';
      io.out(detail);
      return { kind: 'repair', detail, commentId };
    }
    const detail =
      `${key}: the red baseline is not actionable (comment ${commentId}); ${where} with the ` +
      'evidence and the required action, so a person decides what happens next';
    io.err(detail);
    return { kind: 'attention', detail, commentId, cleanupConfirmed: unconfirmed === null };
  };

  /**
   * Finishing what a previous invocation left pending, before anything is
   * discovered or claimed.
   *
   * The retained evidence says a diagnosis began for one exact snapshot,
   * configured command list, and set of results; the item's own thread says
   * whether its finding was already published. So this makes only the step that
   * is really missing: the status move for a finding that is already on the
   * thread, or the publication of one the reviewer turn already wrote. It never
   * starts a second reviewer turn for the same evidence, never writes a second
   * comment, and never touches an item a person has moved somewhere else.
   */
  const resume = async (stop: AbortSignal): Promise<BaselineResumeOutcome | null> => {
    if (stop.aborted) {
      return {
        kind: 'cancelled',
        detail: 'the intake was stopped before any pending baseline diagnosis could be resumed',
        cleanupConfirmed: true,
      };
    }

    let files: readonly string[];
    try {
      files = await evidenceFiles(workDir, project);
    } catch (cause) {
      return { kind: 'problem', detail: messageOf(cause) };
    }

    const resumed: {
      readonly kind: 'repair' | 'attention';
      readonly detail: string;
      readonly commentId: string | null;
      readonly cleanupConfirmed: boolean;
    }[] = [];
    for (const file of files) {
      if (stop.aborted) {
        return {
          kind: 'cancelled',
          detail: 'the intake was stopped while a pending baseline diagnosis was being resumed',
          cleanupConfirmed: true,
        };
      }
      let evidence: BaselineEvidence | null;
      try {
        evidence = await readEvidence(file, project);
      } catch (cause) {
        return { kind: 'problem', detail: messageOf(cause) };
      }
      if (evidence === null || evidence.closed !== undefined) {
        continue;
      }

      const key = evidence.ref.key;
      const where = path.dirname(file);
      let running: boolean;
      try {
        running = await record.isRunning(evidence.ref.id, stop);
      } catch (cause) {
        return {
          kind: 'problem',
          detail:
            `${key}: the baseline diagnosis retained under "${where}" could not be resumed, ` +
            `because the item could not be read: ${messageOf(cause)}`,
        };
      }
      if (!running) {
        // The item is not in the running status. That may be a person's
        // decision, which stands — or this harness's own move, made before the
        // local record was finished. The item's own thread says which: evidence
        // that already carries its own marker was published, so the record is
        // finished with the outcome it published and the workspace's next claim
        // is still told the finding. Nothing is moved and nothing is written to
        // the thread: the item stays exactly where it is.
        let notes: readonly SourceNote[];
        try {
          notes = await record.listComments(evidence.ref.id, stop);
        } catch (cause) {
          if (stop.aborted) {
            return {
              kind: 'cancelled',
              detail:
                `${key}: the intake was stopped before the retained baseline diagnosis under ` +
                `"${where}" could be reconciled with its item`,
              cleanupConfirmed: true,
            };
          }
          return {
            kind: 'problem',
            detail:
              `${key}: the baseline diagnosis retained under "${where}" could not be reconciled ` +
              `with the item's own thread, so intake stops for a person: ${messageOf(cause)}`,
          };
        }
        const published = markerFor(notes, evidence.evidenceId);
        await finish(file, evidence, published?.kind ?? 'left-alone');
        io.out(
          published === null
            ? `${key}: the baseline diagnosis retained under "${where}" was not resumed: the item ` +
                'has left the running status, so it is left exactly where it is'
            : `${key}: the baseline diagnosis retained under "${where}" is already on the issue ` +
                `(comment ${published.note.id}); the item has left the running status, so it stays ` +
                'where it is and the retained evidence now records the finding it published',
        );
        continue;
      }

      io.out(
        `${key}: resuming the baseline diagnosis a previous invocation left pending (evidence ` +
          `under ${where})`,
      );
      const outcome = await diagnose({
        item: { ref: evidence.ref, task: evidence.task },
        workspace: evidence.workspace,
        baseline: evidence.baseline,
        stop,
      });
      if (outcome.kind === 'cancelled') {
        return {
          kind: 'cancelled',
          detail: outcome.detail,
          cleanupConfirmed: outcome.cleanupConfirmed,
        };
      }
      await noteFeedback(evidence.ref, outcome.commentId);
      resumed.push({
        kind: outcome.kind,
        detail: outcome.detail,
        commentId: outcome.commentId,
        cleanupConfirmed: outcome.kind === 'repair' ? true : outcome.cleanupConfirmed,
      });
    }

    const [first] = resumed;
    if (first === undefined) {
      return null;
    }
    const actionable = resumed.find((outcome) => outcome.kind === 'repair');
    return {
      kind: actionable === undefined ? 'attention' : 'repair',
      detail: resumed.map((outcome) => outcome.detail).join(' '),
      commentId: (actionable ?? first).commentId,
      cleanupConfirmed: resumed.every((outcome) => outcome.cleanupConfirmed),
    };
  };

  /**
   * Reading back the finding one retained workspace was returned for repair
   * with. A claim that continues that workspace has to be told it, and the
   * item's own thread — the ordinary source of it — may not be readable or may
   * not carry it, so this is the evidence's own record: the newest piece of
   * this project's evidence whose workspace is that workspace and whose finding
   * was published as a repair.
   *
   * `none` means nothing was returned for repair and nothing has to be
   * recovered. `problem` means either that a required finding cannot be read
   * back — its file is gone or unusable — or that the evidence cannot be read
   * clearly enough to say which of the two this is, and both leave the caller
   * stopping rather than starting a developer without the finding.
   */
  const reviewedFinding = async (
    workspaceId: string,
    stop: AbortSignal,
  ): Promise<BaselineReviewedFinding> => {
    if (stop.aborted) {
      return {
        kind: 'problem',
        detail:
          `the reviewed baseline finding of workspace "${workspaceId}" was not read back, ` +
          'because the intake was stopped first',
      };
    }
    let files: readonly string[];
    try {
      files = await evidenceFiles(workDir, project);
    } catch (cause) {
      return { kind: 'problem', detail: messageOf(cause) };
    }

    const returned: { readonly evidence: BaselineEvidence; readonly where: string }[] = [];
    for (const file of files) {
      if (stop.aborted) {
        return {
          kind: 'problem',
          detail:
            `the reviewed baseline finding of workspace "${workspaceId}" was not read back, ` +
            'because the intake was stopped first',
        };
      }
      let evidence: BaselineEvidence | null;
      try {
        evidence = await readEvidence(file, project);
      } catch (cause) {
        return { kind: 'problem', detail: messageOf(cause) };
      }
      if (evidence === null || evidence.workspace.workspaceId !== workspaceId) {
        continue;
      }
      if (evidence.closed === undefined) {
        // An unfinished diagnosis is finished before anything is claimed, so
        // this is not a state a claim may read past: whether the finding was
        // returned for repair is not established, and a person decides.
        return {
          kind: 'problem',
          detail:
            `the baseline evidence this harness kept under "${path.dirname(file)}" for workspace ` +
            `"${workspaceId}" was never finished, so whether its finding was returned for repair ` +
            'cannot be established',
        };
      }
      if (evidence.closed === 'repair') {
        returned.push({ evidence, where: path.dirname(file) });
      }
    }

    // The evidence is kept oldest name first; a workspace carries at most the
    // one repair it was returned with, and the newest is the one a later claim
    // is told if it ever carries more than one.
    returned.sort((left, right) =>
      (right.evidence.closedAt ?? '').localeCompare(left.evidence.closedAt ?? ''),
    );
    const [newest] = returned;
    if (newest === undefined) {
      return { kind: 'none' };
    }
    try {
      return { kind: 'finding', finding: await readBaselineFinding(newest.where) };
    } catch (cause) {
      return {
        kind: 'problem',
        detail:
          `the reviewed baseline finding of workspace "${workspaceId}" is required — its evidence ` +
          `under "${newest.where}" says it was returned for repair — and cannot be read back: ` +
          messageOf(cause),
      };
    }
  };

  return { diagnose, resume, reviewedFinding };
}
