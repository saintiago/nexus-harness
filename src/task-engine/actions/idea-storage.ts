import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../../result.js';
import type { ArtifactContent, ArtifactDeclaration } from './artifacts.js';
import { challengerArtifact, type ChallengerReport } from './challenger/artifacts.js';
import { describeIssues, parseDocument, readDocumentText, writeDocument } from './documents.js';
import { readRequiredRecord, writeRecord } from './records.js';
import { ensureRoundDirectory, listNumberedHistory } from './round-storage.js';
import { readRefinedIdeaRevision, type RefinedIdeaRead } from './idea-editor/artifacts.js';
import { decisionArtifact } from './publish-decision/artifacts.js';
import { ideaInputDeclaration, type IdeaInput } from './select-idea/artifacts.js';
import { ideaRoundPlanDeclaration, type IdeaRoundPlan } from './start-idea-round/artifacts.js';

/**
 * The idea refinement artifact layout: one stable refinement area holds numbered submissions, each
 * with numbered conversation cycles. These helpers resolve that layout and read and write the
 * declared documents within it; they choose no roles, judge no discussion and decide no routes.
 */

/** The submissions' directory under a refinement area's artifacts directory. */
export const ideaSubmissionsDirectory = 'artifacts/submissions';

/** The directory holding one submission's captured input and council cycles. */
export function ideaSubmissionDirectory(root: string, submission: number): string {
  return path.join(root, ideaSubmissionsDirectory, String(submission));
}

/** The directory holding one conversation cycle's declared artifacts. */
export function ideaCycleDirectory(root: string, submission: number, cycle: number): string {
  return path.join(ideaSubmissionDirectory(root, submission), 'cycles', String(cycle));
}

/** The retained copy of one submission's captured idea input. */
export function ideaSubmissionInputFile(root: string, submission: number): string {
  return path.join(ideaSubmissionDirectory(root, submission), ideaInputDeclaration.file);
}

/** The file one submission-level artifact declaration resolves to. */
export function ideaSubmissionArtifactFile(
  root: string,
  submission: number,
  declaration: ArtifactDeclaration,
): string {
  return path.join(ideaSubmissionDirectory(root, submission), declaration.pathFromArtifactsRoot);
}

/** The retained submission numbers of a refinement area, in ascending order. */
export async function listIdeaSubmissions(root: string): Promise<number[]> {
  return listNumberedHistory(path.join(root, ideaSubmissionsDirectory));
}

/** The retained cycle numbers of one submission, in ascending order. */
export async function listIdeaCycles(root: string, submission: number): Promise<number[]> {
  return listNumberedHistory(path.join(ideaSubmissionDirectory(root, submission), 'cycles'));
}

/** Read the refinement area's current plan; a missing or invalid plan is an execution error. */
export async function readIdeaPlan(root: string): Promise<IdeaRoundPlan> {
  return readRequiredRecord(
    path.join(root, ideaRoundPlanDeclaration.file),
    ideaRoundPlanDeclaration,
    'Idea round plan',
  );
}

/** Write the retained copy of one submission's captured idea input. */
export async function writeIdeaInput(
  root: string,
  submission: number,
  input: IdeaInput,
): Promise<string> {
  const file = ideaSubmissionInputFile(root, submission);
  await writeRecord(file, input);
  return file;
}

/** Read the captured idea input of one submission; a missing or invalid input is an error. */
export async function readIdeaInput(root: string, submission: number): Promise<IdeaInput> {
  return readRequiredRecord(
    ideaSubmissionInputFile(root, submission),
    ideaInputDeclaration,
    'Captured idea input',
  );
}

/**
 * True when a submission already reached a decision. The latest submission is checked by default:
 * a decided selection is finished work, so the next run selects again instead of continuing it.
 */
export async function submissionDecided(root: string, submission?: number): Promise<boolean> {
  const number = submission ?? (await listIdeaSubmissions(root)).at(-1);
  if (number === undefined) {
    return false;
  }
  return (await readSubmissionArtifact(root, number, decisionArtifact)) !== null;
}

/** Read one submission-level artifact, or null when the submission did not produce it. */
export async function readSubmissionArtifact<Declaration extends ArtifactDeclaration>(
  root: string,
  submission: number,
  declaration: Declaration,
): Promise<ArtifactContent<Declaration> | null> {
  const file = ideaSubmissionArtifactFile(root, submission, declaration);
  const text = await readDocumentText(file, 'Artifact');
  return text === null ? null : parseCycleArtifact(file, declaration, text);
}

/** Write one submission-level artifact and return its path. */
export async function writeSubmissionArtifact<Declaration extends ArtifactDeclaration>(
  root: string,
  submission: number,
  declaration: Declaration,
  content: ArtifactContent<Declaration>,
): Promise<string> {
  const file = ideaSubmissionArtifactFile(root, submission, declaration);
  await mkdir(path.dirname(file), { recursive: true });
  await writeDocument(file, content, 'Artifact');
  return file;
}

/** Create one submission's directory and its cycles directory. */
export async function openIdeaSubmission(root: string, submission: number): Promise<string> {
  const directory = ideaSubmissionDirectory(root, submission);
  await mkdir(path.join(directory, 'cycles'), { recursive: true });
  return directory;
}

/** Create one conversation cycle's artifact directory and return its path. */
export async function ensureIdeaCycle(
  root: string,
  submission: number,
  cycle: number,
): Promise<string> {
  await openIdeaSubmission(root, submission);
  return ensureRoundDirectory(
    path.join(ideaSubmissionDirectory(root, submission), 'cycles'),
    cycle,
  );
}

/** Validate one stored cycle artifact against its declaration. */
function parseCycleArtifact<Declaration extends ArtifactDeclaration>(
  file: string,
  declaration: Declaration,
  text: string,
): ArtifactContent<Declaration> {
  const parsed = parseDocument(text, declaration.schema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(`Artifact at "${file}" is not valid JSON: ${messageOf(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `Artifact at "${file}" does not match its declared content type: ` +
        describeIssues(parsed.error, '<artifact>'),
      { cause: parsed.error },
    );
  }
  // safeParse erases the generic schema's output type.
  return parsed.content as ArtifactContent<Declaration>;
}

/** Read one cycle artifact, or null when the cycle did not produce it. */
export async function readCycleArtifact<Declaration extends ArtifactDeclaration>(
  cycleRoot: string,
  declaration: Declaration,
): Promise<ArtifactContent<Declaration> | null> {
  const file = path.join(cycleRoot, declaration.pathFromArtifactsRoot);
  const text = await readDocumentText(file, 'Artifact');
  return text === null ? null : parseCycleArtifact(file, declaration, text);
}

/** Write one cycle artifact and return its path. */
export async function writeCycleArtifact<Declaration extends ArtifactDeclaration>(
  cycleRoot: string,
  declaration: Declaration,
  content: ArtifactContent<Declaration>,
): Promise<string> {
  const file = path.join(cycleRoot, declaration.pathFromArtifactsRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeDocument(file, content, 'Artifact');
  return file;
}

/**
 * The refined idea revision in force at or before the supplied cycle: the latest revision written
 * for this submission, in the shape the writing implementation stored it. An editor response that
 * answers or rebuts without changing the idea leaves this revision in force, so a Challenger
 * assesses the revision it actually reviewed rather than a new one.
 */
export async function latestRefinedIdea(
  root: string,
  submission: number,
  cycle: number,
): Promise<RefinedIdeaRead | null> {
  for (let number = cycle; number >= 1; number -= 1) {
    const read = await readRefinedIdeaRevision(ideaCycleDirectory(root, submission, number));
    if (read !== null) {
      return read;
    }
  }
  return null;
}

/** One Challenger result and the file it was read from. */
export type ChallengerRead = {
  readonly path: string;
  readonly report: ChallengerReport;
};

/**
 * The Challenger result that opened the supplied cycle: the latest one at or before that cycle,
 * which the cycle's editor response answers. The current cycle's Challenger runs after that
 * response, so a result it produced is never the one an editor turn answers.
 */
export async function latestChallenger(
  root: string,
  submission: number,
  cycle: number,
): Promise<ChallengerRead | null> {
  for (let number = cycle; number >= 1; number -= 1) {
    const cycleRoot = ideaCycleDirectory(root, submission, number);
    const report = await readCycleArtifact(cycleRoot, challengerArtifact);
    if (report !== null) {
      return {
        path: path.join(cycleRoot, challengerArtifact.pathFromArtifactsRoot),
        report,
      };
    }
  }
  return null;
}
