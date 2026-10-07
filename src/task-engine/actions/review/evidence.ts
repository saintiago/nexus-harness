import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../../../result.js';
import { capturedSourcePathOf, retainCapturedSource } from '../readable-source.js';

/**
 * Review's invocation-local evidence: the captured `{ issue, conversation }`, the refreshed
 * pull-request conversation and the exact comparison diff bytes the assembled context references.
 * The files sit beside the invocation's assigned Markdown report, so the mutable selection record
 * and later source refreshes cannot change what an earlier invocation can inspect. They are
 * supporting input, not workflow outcomes; a storage failure fails the fresh assessment through
 * ordinary execution handling instead of invoking the reviewer with missing evidence.
 */

/** The complete captured pull-request conversation of one invocation's evidence. */
export const prConversationEvidenceFile = 'pr-conversation.json';

/** The complete comparison diff of one invocation's evidence, stored exactly as returned. */
export const comparisonDiffEvidenceFile = 'comparison.diff';

/** One invocation's readable evidence paths, absolute as recorded from the artifact area. */
export type ReviewEvidence = {
  readonly capturedSource: string;
  readonly prConversation: string;
  readonly comparisonDiff: string;
};

/**
 * Retain one evidence file unchanged when the invocation already has it, and require it readable
 * afterwards so the invocation never references unavailable evidence.
 */
async function retainEvidenceFile(file: string, content: string): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(
        `The review evidence at "${file}" could not be retained: ${messageOf(error)}`,
        { cause: error },
      );
    }
  }
  try {
    await readFile(file);
  } catch (error) {
    throw new Error(`The review evidence at "${file}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/**
 * Retain the invocation's captured source, pull-request conversation and comparison diff beside
 * its assigned Markdown report. The values are the same captured values the assembled context
 * renders; the diff keeps its exact bytes, including a valid empty diff.
 */
export async function retainReviewEvidence(settings: {
  readonly reportFile: string;
  readonly task: unknown;
  readonly conversation: readonly unknown[];
  readonly pullRequestConversation: unknown;
  readonly diff: string;
}): Promise<ReviewEvidence> {
  const directory = path.dirname(settings.reportFile);
  const capturedSource = capturedSourcePathOf(settings.reportFile);
  await retainCapturedSource({
    file: capturedSource,
    task: settings.task,
    conversation: settings.conversation,
  });
  try {
    await readFile(capturedSource);
  } catch (error) {
    throw new Error(
      `The review evidence at "${capturedSource}" could not be read: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const prConversation = path.join(directory, prConversationEvidenceFile);
  await retainEvidenceFile(
    prConversation,
    `${JSON.stringify(settings.pullRequestConversation, null, 2)}\n`,
  );
  const comparisonDiff = path.join(directory, comparisonDiffEvidenceFile);
  await retainEvidenceFile(comparisonDiff, settings.diff);
  return { capturedSource, prConversation, comparisonDiff };
}
