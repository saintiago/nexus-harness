import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowName } from '../configuration/index.js';
import type { ExperienceHandoff } from '../task-engine/actions/analyze-experience/artifacts.js';
import { ideaRoundPlanDeclaration } from '../task-engine/actions/start-idea-round/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../task-engine/actions/prepare-workspace/artifacts.js';
import { readRecord } from '../task-engine/actions/records.js';
import type { IdeaSelection } from '../task-engine/actions/select-idea/artifacts.js';
import type { Selection } from '../task-engine/actions/select-task/artifacts.js';
import {
  currentRoundDeclaration,
  currentRoundFile,
} from '../task-engine/actions/start-round/artifacts.js';

/**
 * Application's workflow bindings for AnalyzeExperience: the terminal handoff each workflow state
 * supplies and the producer-owned evidence it selects from the retained workspace. The action
 * itself switches on no workflow name, task source status or concrete action implementation;
 * these tables own that workflow knowledge. See docs/task-engine/actions/analyze-experience.md.
 */

/** The evidence area one finite-delivery terminal retained. */
type FiniteEvidence = 'round' | 'preparation';

/** One finite-delivery terminal: the outcome the workflow preserves and the producer that stated it. */
export const finiteDeliveryTerminals = {
  'complete-completed': {
    outcome: 'completed',
    producer: 'complete-task',
    evidence: 'round',
  },
  'complete-failed': { outcome: 'failed', producer: 'complete-task', evidence: 'round' },
  'prepare-failed': { outcome: 'failed', producer: 'prepare-workspace', evidence: 'preparation' },
  'start-round-exhausted': { outcome: 'exhausted', producer: 'start-round', evidence: 'round' },
  'deliver-failed': { outcome: 'failed', producer: 'deliver', evidence: 'round' },
  'review-inconclusive': { outcome: 'inconclusive', producer: 'review', evidence: 'round' },
} as const satisfies Record<
  string,
  { readonly outcome: string; readonly producer: string; readonly evidence: FiniteEvidence }
>;

export type FiniteDeliveryTerminal = keyof typeof finiteDeliveryTerminals;

/** One idea-refinement terminal: its preserved outcome and the producer that stated it. */
export const ideaRefinementTerminals = {
  'publish-approved': {
    outcome: 'approved',
    producer: 'publish-decision',
  },
  'publish-unsuitable': {
    outcome: 'waiting-for-feedback',
    producer: 'publish-decision',
  },
  'publish-author-decision': {
    outcome: 'waiting-for-feedback',
    producer: 'publish-decision',
  },
  'publish-attempts-exhausted': {
    outcome: 'waiting-for-feedback',
    producer: 'publish-decision',
  },
  'start-submission-exhausted': {
    outcome: 'exhausted',
    producer: 'start-idea-round',
  },
} as const satisfies Record<string, { readonly outcome: string; readonly producer: string }>;

export type IdeaRefinementTerminal = keyof typeof ideaRefinementTerminals;

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

/** The idea-refinement terminal one workflow state supplied. */
export function ideaTerminalOf(input: unknown): IdeaRefinementTerminal {
  return terminalOf(input, ideaRefinementTerminals, 'idea refinement');
}

/** The producer that states one workflow terminal's reason, so the binding can carry it forward. */
export function terminalProducer(
  workflow: WorkflowName,
  terminal: FiniteDeliveryTerminal | IdeaRefinementTerminal | string,
): string | null {
  if (workflow === 'idea-refinement') {
    const found = ideaRefinementTerminals[terminal as IdeaRefinementTerminal];
    return found === undefined ? null : found.producer;
  }
  const found = finiteDeliveryTerminals[terminal as FiniteDeliveryTerminal];
  return found === undefined ? null : found.producer;
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

/** The finite-delivery evidence files one terminal retained, in the order the analyst reads them. */
async function finiteEvidence(root: string, area: FiniteEvidence): Promise<string[]> {
  const files: string[] = [];
  if (area === 'preparation') {
    files.push(...(await retainedFiles(root, 'state')));
    return files;
  }
  const prepared = path.join(root, preparedWorkspaceFile);
  if (await isFile(prepared)) {
    files.push(prepared);
  }
  const round = await readRecord(path.join(root, currentRoundFile), currentRoundDeclaration);
  if (round !== null) {
    files.push(path.join(root, currentRoundFile));
    files.push(...(await retainedFiles(root, path.join('artifacts', String(round.number)))));
  } else {
    // No round was opened; whatever preparation retained is this attempt's evidence.
    files.push(...(await retainedFiles(root, 'state')));
  }
  return files;
}

/** The attempt identity one finite-delivery workspace currently retains, or an unprepared one. */
async function finiteAttempt(root: string): Promise<string> {
  const prepared = await readRecord(
    path.join(root, preparedWorkspaceFile),
    preparedWorkspaceDeclaration,
  );
  return prepared === null ? 'unprepared' : prepared.branch;
}

/** The current idea submission's identity and retained artifacts. */
async function ideaAttempt(root: string): Promise<{
  readonly attemptId: string;
  readonly files: string[];
}> {
  const plan = await readRecord(
    path.join(root, ideaRoundPlanDeclaration.file),
    ideaRoundPlanDeclaration,
  );
  if (plan === null) {
    return { attemptId: 'unprepared', files: [] };
  }
  return {
    attemptId: `submission-${String(plan.submission)}`,
    files: await retainedFiles(
      root,
      path.join('artifacts', 'submissions', String(plan.submission)),
    ),
  };
}

/** The evidence one finite-delivery terminal handoff carries, as the action's input shape. */
function evidence(handoff: { readonly files: readonly string[] }): { readonly path: string }[] {
  return handoff.files.map((file) => ({ path: file }));
}

/** Build the terminal handoff of one finite-delivery terminal for the selected work item. */
export async function finiteDeliveryHandoff(options: {
  readonly selection: Selection;
  readonly terminal: FiniteDeliveryTerminal;
  readonly reason: string | null;
}): Promise<ExperienceHandoff> {
  const root = options.selection.workspace.root;
  const terminal = finiteDeliveryTerminals[options.terminal];
  const files = await finiteEvidence(root, terminal.evidence);
  return {
    workId: options.selection.taskKey,
    workflow: 'finite-delivery',
    attemptId: await finiteAttempt(root),
    terminalId: options.terminal,
    outcome: terminal.outcome,
    reason: options.reason,
    workspaceRoot: root,
    artifacts: evidence({ files }),
  };
}

/** Build the terminal handoff of one idea-refinement terminal for the selected submission. */
export async function ideaRefinementHandoff(options: {
  readonly selection: IdeaSelection;
  readonly terminal: IdeaRefinementTerminal;
  readonly reason: string | null;
}): Promise<ExperienceHandoff> {
  const root = options.selection.workspace.root;
  const terminal = ideaRefinementTerminals[options.terminal];
  const attempt = await ideaAttempt(root);
  return {
    workId: options.selection.taskKey,
    workflow: 'idea-refinement',
    attemptId: attempt.attemptId,
    terminalId: options.terminal,
    outcome: terminal.outcome,
    reason: options.reason,
    workspaceRoot: root,
    artifacts: evidence(attempt),
  };
}

/**
 * Build the handoff of an operational error Application observed after the worker settled: the
 * original fault and the interrupted attempt's retained evidence, recorded before recovery can
 * replace that attempt.
 */
export async function operationalErrorHandoff(options: {
  readonly workflow: WorkflowName;
  readonly selection: Selection | IdeaSelection;
  readonly failure: string;
}): Promise<ExperienceHandoff> {
  if (options.workflow === 'idea-refinement') {
    const selection = options.selection as IdeaSelection;
    const attempt = await ideaAttempt(selection.workspace.root);
    return {
      workId: selection.taskKey,
      workflow: options.workflow,
      attemptId: attempt.attemptId,
      terminalId: 'operational-error',
      outcome: 'error',
      reason: options.failure,
      workspaceRoot: selection.workspace.root,
      artifacts: evidence(attempt),
    };
  }
  const selection = options.selection as Selection;
  const root = selection.workspace.root;
  const round = await readRecord(path.join(root, currentRoundFile), currentRoundDeclaration);
  const files = await finiteEvidence(root, round === null ? 'preparation' : 'round');
  return {
    workId: selection.taskKey,
    workflow: options.workflow,
    attemptId: await finiteAttempt(root),
    terminalId: 'operational-error',
    outcome: 'error',
    reason: options.failure,
    workspaceRoot: root,
    artifacts: evidence({ files }),
  };
}
