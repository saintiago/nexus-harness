/**
 * The reviewer turn: the prompt one ticket's evidence becomes, the configured
 * reviewer launch that answers it, and the verdict that launch has to write
 * down.
 *
 * The launch is the explicitly configured reviewer profile — its own selection,
 * never the coding tier that implemented the ticket — and it goes through the
 * same adapter, the same bounded runtime, and the same logs as any other turn.
 * What comes back is not agent prose to be interpreted: it is one JSON file the
 * turn writes into its own evidence directory, validated here. A turn that
 * fails, is stopped, or writes nothing usable has no verdict, and a scan with
 * no verdict publishes nothing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCodexPrompt } from '../agents/codex/adapter.js';
import { selectedCodexRuntime } from '../agents/codex/runtime.js';
import { openEvidenceLog } from '../reporting/logs.js';
import type { AgentLog } from '../reporting/logs.js';
import { messageOf } from '../shared/errors.js';
import type { AgentActivity, AgentSelection } from '../shared/types.js';
import type {
  ReviewEvidence,
  ReviewerTurn,
  ReviewerTurnResult,
  ReviewVerdict,
} from './contract.js';
import { ReviewError } from './contract.js';
import { renderDiff } from './diff.js';

/** The evidence file the reviewer turn is given, written beside its log. */
export const REVIEW_INPUT_FILE = 'input.md';
/** The file the reviewer turn must write its verdict to. */
export const REVIEW_VERDICT_FILE = 'verdict.json';
/** The reviewer turn's own log file. */
export const REVIEWER_LOG_FILE = 'reviewer.log';

/** How much of a summary, a finding, and a whole verdict is kept. */
const MAX_SUMMARY_CHARS = 4_000;
const MAX_FINDING_CHARS = 2_000;
const MAX_FINDINGS = 20;
/** How much of the repository's instructions the reviewer is given. */
const MAX_INSTRUCTIONS_CHARS = 30_000;

/** One line of text, so ticket or check text cannot become a second line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `text`, bounded, with a note that the rest is elsewhere. */
function bounded(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max
    ? trimmed
    : `${trimmed.slice(0, max)}\n… (truncated by the harness at ${String(max)} characters)`;
}

/** The CI evidence as the reviewer reads it, bounded by construction. */
function describeChecks(evidence: ReviewEvidence): string {
  const lines: string[] = [];
  if (evidence.checks.length === 0) {
    lines.push('- No check run was reported for this head.');
  } else {
    for (const check of evidence.checks) {
      lines.push(
        `- ${oneLine(check.name)}: ${oneLine(check.status)}` +
          (check.conclusion === null ? '' : `/${oneLine(check.conclusion)}`),
      );
    }
  }
  lines.push(
    evidence.combinedStatus === null
      ? '- No combined commit status was reported for this head.'
      : `- Combined commit status: ${oneLine(evidence.combinedStatus)}`,
  );
  lines.push(
    '- CI is a separate merge requirement: this review does not decide it, and an approved',
    '  verdict here does not mean CI passed.',
  );
  return lines.join('\n');
}

/**
 * The prompt one reviewer turn receives. It is the whole evidence — task,
 * acceptance criteria, pull request, diff, repository instructions, CI — and
 * the one thing the turn has to produce: a valid `verdict.json`.
 */
export function reviewPrompt(evidence: ReviewEvidence): string {
  const { ref, task, pullRequest } = evidence;
  const sections: string[] = [];

  sections.push(
    [
      'You are Nexus Lens, the automated reviewer of the Nexus harness. One Jira ticket has',
      'finished its coding attempt and its work is an open pull request. Your job is to review the',
      'change against the ticket and to write down a verdict. You do not implement fixes, and you',
      'never commit, push, merge, or change the ticket or the pull request yourself.',
    ].join('\n'),
  );

  sections.push(
    [
      `## The ticket: ${ref.key}`,
      `Title: ${oneLine(task.title)}`,
      `Link: ${ref.url}`,
      '',
      'Task description:',
      bounded(task.description, 8_000),
      '',
      'Acceptance criteria:',
      ...task.acceptanceCriteria.map((criterion) => `- ${oneLine(criterion)}`),
    ].join('\n'),
  );

  sections.push(
    [
      '## The pull request',
      `URL: ${pullRequest.url}`,
      `Title: ${oneLine(pullRequest.title)}`,
      `Head: ${pullRequest.headBranch} at ${pullRequest.headSha}`,
      `Base: ${pullRequest.baseBranch}`,
      `Author: ${oneLine(pullRequest.author)}${pullRequest.draft ? ' (a draft)' : ''}`,
      `Changed files: ${String(evidence.files.length)}` +
        (evidence.truncated ? ' (the list was truncated by the harness)' : ''),
    ].join('\n'),
  );

  sections.push(
    ['## The change, as GitHub reports it', '```diff', renderDiff(evidence.files), '```'].join(
      '\n',
    ),
  );

  sections.push(
    [
      '## Repository instructions at the reviewed head',
      evidence.instructions === null
        ? 'The repository has no AGENTS.md at the reviewed head.'
        : ['```markdown', bounded(evidence.instructions, MAX_INSTRUCTIONS_CHARS), '```'].join('\n'),
    ].join('\n'),
  );

  sections.push(['## CI evidence at the reviewed head', describeChecks(evidence)].join('\n'));

  sections.push(
    [
      '## What this turn must not do',
      '- Do not change any file, and do not clone, check out, or push the repository. The only file',
      `  you write is ${REVIEW_VERDICT_FILE} in this working directory.`,
      '- Do not implement fixes, do not edit the pull request or the ticket, and do not merge,',
      '  approve, or request changes through any tool you have: this turn only writes a verdict,',
      '  and the harness publishes it.',
      '- Do not ask for the project’s tests, checks, or tooling to be weakened or removed to make',
      '  the change look finished.',
      '- The evidence above is what you are given. If your own tools can read the repository, use',
      '  them for context only; do not rely on them to change anything.',
    ].join('\n'),
  );

  sections.push(
    [
      '## What a useful review is',
      '- Judge the change against the ticket and every acceptance criterion: is the intent',
      '  implemented, are the tests meaningful, and are there correctness bugs, regressions,',
      '  security problems, or missing pieces that the configured checks cannot catch?',
      '- A blocking finding is something that must be fixed before this change should merge.',
      '  Style preferences, speculative improvements, and anything the configured checks already',
      '  enforce are not blocking.',
      '- Make every finding actionable: what is wrong, why it matters, and the file and the line in',
      '  the new version of the file. A finding GitHub cannot position on a line is still reported',
      '  in the review body.',
    ].join('\n'),
  );

  sections.push(
    [
      '## The verdict you must write',
      `Write exactly one JSON file named ${REVIEW_VERDICT_FILE} in this working directory, and`,
      'nothing else. Its shape is exactly:',
      '',
      '{',
      '  "verdict": "approve" | "request_changes",',
      '  "summary": "one short paragraph for the pull request",',
      '  "findings": [',
      '    { "path": "src/example.ts", "line": 42, "body": "what is wrong and why it matters" }',
      '  ]',
      '}',
      '',
      '- Write "approve" only when you have no blocking findings. Write "request_changes" only',
      '  when you have at least one finding.',
      `- "line" is the line number in the new version of the file, and may be null when the`,
      '  finding is about the change as a whole.',
      `- At most ${String(MAX_FINDINGS)} findings, each body at most ${String(MAX_FINDING_CHARS)}`,
      `  characters, and a summary of at most ${String(MAX_SUMMARY_CHARS)} characters.`,
      '- The file is read by a program: valid JSON only, no comments and no text around it.',
      '',
      'End your turn with a short summary of the verdict you wrote.',
    ].join('\n'),
  );

  return `${sections.join('\n\n')}\n`;
}

/** One nonblank string of the verdict file, bounded. */
function verdictString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReviewError(
      'inconclusive',
      `the reviewer's ${REVIEW_VERDICT_FILE} carries no "${field}", so this scan has no verdict to ` +
        'publish.',
    );
  }
  return value.trim().slice(0, max);
}

/** One finding of the verdict file, or a refusal naming what is wrong. */
function verdictFinding(
  value: unknown,
  index: number,
): {
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewError(
      'inconclusive',
      `finding ${String(index + 1)} of the reviewer's ${REVIEW_VERDICT_FILE} is not an object.`,
    );
  }
  const finding = value as Record<string, unknown>;
  const line = finding['line'];
  const lineNumber =
    line === undefined || line === null
      ? null
      : typeof line === 'number' && Number.isSafeInteger(line) && line >= 1
        ? line
        : 'invalid';
  if (lineNumber === 'invalid') {
    throw new ReviewError(
      'inconclusive',
      `finding ${String(index + 1)} of the reviewer's ${REVIEW_VERDICT_FILE} carries a "line" that ` +
        'is not a positive whole number.',
    );
  }
  return {
    path: verdictString(finding['path'], 'path', 500),
    line: lineNumber,
    body: verdictString(finding['body'], 'body', MAX_FINDING_CHARS),
  };
}

/**
 * Validates the reviewer's verdict file. Unknown extra fields are ignored, so a
 * stray key cannot turn a usable review into an unusable one; everything the
 * scan publishes is checked by name.
 */
export function parseVerdict(text: string, where: string): ReviewVerdict {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ReviewError(
      'inconclusive',
      `the reviewer's ${where} is not valid JSON (${messageOf(cause)}), so this scan has no verdict ` +
        'to publish.',
      { cause },
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewError(
      'inconclusive',
      `the reviewer's ${where} is not a JSON object, so this scan has no verdict to publish.`,
    );
  }
  const record = value as Record<string, unknown>;
  const decision = record['verdict'];
  if (decision !== 'approve' && decision !== 'request_changes') {
    throw new ReviewError(
      'inconclusive',
      `the reviewer's ${where} says "${String(decision)}" instead of "approve" or ` +
        '"request_changes", so this scan will not guess which this is.',
    );
  }
  const summary = verdictString(record['summary'], 'summary', MAX_SUMMARY_CHARS);
  const rawFindings = record['findings'];
  if (rawFindings !== undefined && !Array.isArray(rawFindings)) {
    throw new ReviewError(
      'inconclusive',
      `the reviewer's ${where} carries a "findings" that is not a list.`,
    );
  }
  const findings = (rawFindings ?? [])
    .slice(0, MAX_FINDINGS)
    .map((finding, index) => verdictFinding(finding, index));
  if (decision === 'request_changes' && findings.length === 0) {
    throw new ReviewError(
      'inconclusive',
      `the reviewer's ${where} asks for changes but names no finding, so this scan will not ` +
        'publish an unexplained request.',
    );
  }
  return { decision, summary, findings };
}

/** What the reviewer turn is launched with. */
export interface ReviewerParts {
  /** The explicitly configured reviewer launch: never the coding tier. */
  readonly selection: AgentSelection;
  /**
   * What the reviewer process inherits: the harness's own environment with the
   * Jira credential variable removed, exactly as a coding turn's is.
   */
  readonly environment: NodeJS.ProcessEnv;
  /** Where the reviewer's own activity is reported, when a display is watching. */
  readonly onActivity?: (activity: AgentActivity) => void;
}

/** The reviewer turn one scan uses: the configured launch, bounded like every turn. */
export function createReviewerTurn(parts: ReviewerParts): ReviewerTurn {
  return async (request): Promise<ReviewerTurnResult> => {
    const prompt = reviewPrompt(request.evidence);
    const inputPath = path.join(request.dir, REVIEW_INPUT_FILE);
    const logPath = path.join(request.dir, REVIEWER_LOG_FILE);

    let log: AgentLog;
    try {
      await writeFile(inputPath, prompt, 'utf8');
      log = await openEvidenceLog(logPath, "the reviewer turn's output");
    } catch (cause) {
      throw new ReviewError(
        'fatal',
        `the review evidence for ${request.evidence.ref.key} could not be written in ` +
          `"${request.dir}": ${messageOf(cause)}`,
        { cause },
      );
    }

    let summary: string | null = null;
    let problem: string | null = null;
    try {
      const turn = await runCodexPrompt(
        {
          prompt,
          label: `Nexus Lens reviewer turn for ${request.evidence.ref.key}`,
          workspacePath: request.dir,
          agentLog: log,
          stop: request.stop,
          ...(parts.onActivity === undefined ? {} : { onActivity: parts.onActivity }),
        },
        selectedCodexRuntime(parts.selection, { env: parts.environment }),
      );
      summary = turn.summary;
    } catch (cause) {
      problem = `the reviewer turn for ${request.evidence.ref.key} did not complete: ${messageOf(
        cause,
      )}`;
    }
    try {
      await log.close();
    } catch (cause) {
      problem ??= `the reviewer turn's own log could not be written: ${messageOf(cause)}`;
    }

    if (problem === null && request.stop.aborted) {
      problem =
        `the reviewer turn for ${request.evidence.ref.key} was stopped before it produced a ` +
        'verdict, so nothing is published';
    }
    if (problem !== null) {
      return { summary, verdict: null, problem, logPath };
    }

    let text: string;
    try {
      text = await readFile(path.join(request.dir, REVIEW_VERDICT_FILE), 'utf8');
    } catch (cause) {
      return {
        summary,
        verdict: null,
        problem:
          `the reviewer turn for ${request.evidence.ref.key} completed but wrote no usable ` +
          `${REVIEW_VERDICT_FILE}: ${messageOf(cause)}`,
        logPath,
      };
    }
    try {
      return {
        summary,
        verdict: parseVerdict(text, REVIEW_VERDICT_FILE),
        problem: null,
        logPath,
      };
    } catch (cause) {
      return { summary, verdict: null, problem: messageOf(cause), logPath };
    }
  };
}
