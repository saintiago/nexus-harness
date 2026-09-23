import path from 'node:path';
import type { AgentResult, AgentRuntime } from '../../../agent-runtime/index.js';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import type { JiraAdapter, JiraComment, JiraIssue } from '../../../adapters/jira.js';
import { messageOf } from '../../../result.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import { createArtifactHelpers, type ArtifactHistoryValue } from '../artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
  type PreparedWorkspace,
} from '../prepare-workspace/artifacts.js';
import { readRecord, writeRecord } from '../records.js';
import { reviewArtifact, type Finding, type ReviewOutput } from '../review/artifacts.js';
import { repairArtifact, type RepairOutput } from '../select-repair/artifacts.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { verificationArtifact, type VerificationOutput } from '../verify/artifacts.js';
import {
  devArtifact,
  developmentResponseSchema,
  type DevelopmentOutput,
  type DevelopmentResponse,
  type FindingResponse,
} from './artifacts.js';

/**
 * Develop implements the selected task or repairs the preceding round's findings in the retained
 * worktree. It refreshes the task and conversation from the source into the selection record,
 * assembles the round's context from the earlier-round artifacts and invokes the developer profile
 * once. The action records the profile and observed repository revisions; the agent supplies only
 * status, summary and finding responses. A completed turn must leave committed work on the prepared
 * branch; otherwise the recorded summary also carries the observed readiness failure.
 *
 * Source, repository and invocation failures are execution errors. Unusable agent output is an
 * execution error, not a failed report.
 */

export type DevelopSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured initial developer profile; a selected repair supplies the later rounds. */
  readonly initialProfile: string;
  readonly runtime: AgentRuntime;
  readonly git: GitAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

/** The earlier-round values of the artifacts this action reads as history. */
type RoundHistories = {
  readonly development: readonly ArtifactHistoryValue<DevelopmentOutput>[];
  readonly verification: readonly ArtifactHistoryValue<VerificationOutput>[];
  readonly review: readonly ArtifactHistoryValue<ReviewOutput>[];
  readonly repair: readonly ArtifactHistoryValue<RepairOutput>[];
};

/** The most recent value of an artifact history, or null when it has none. */
function latest<Value>(
  history: readonly ArtifactHistoryValue<Value>[],
): ArtifactHistoryValue<Value> | null {
  return history.at(-1) ?? null;
}

/** The profile this round runs: the latest selected repair's, or the configured initial profile. */
function profileForRound(
  history: readonly ArtifactHistoryValue<RepairOutput>[],
  initialProfile: string,
): string {
  const selected = latest(history);
  if (selected === null) {
    return initialProfile;
  }
  const { decision, profile } = selected.value;
  if (decision === 'selected' && profile !== null && profile.trim() !== '') {
    return profile;
  }
  throw new Error(
    `The repair decision in round ${selected.number} selects no profile for the next round.`,
  );
}

/** Why the observed worktree is not a committed implementation ready for verification, or null. */
function readinessProblem(state: RepositoryState, prepared: PreparedWorkspace): string | null {
  if (state.headRevision === null) {
    return 'the worktree has no revision';
  }
  if (state.branch !== prepared.branch) {
    return `the worktree is on branch "${state.branch ?? 'no branch'}", not the prepared "${prepared.branch}"`;
  }
  if (state.trackedChanges) {
    return 'tracked changes are uncommitted';
  }
  if (state.untrackedChanges) {
    return 'untracked files are uncommitted';
  }
  return null;
}

/** Read the worktree's identity and uncommitted work; a Git failure is an execution error. */
async function inspectRepository(git: GitAdapter, worktree: string): Promise<RepositoryState> {
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  return inspection.value;
}

/** Read the current source issue; a source access failure is an execution error. */
async function readIssue(jira: JiraAdapter, issueId: string): Promise<JiraIssue> {
  const result = await jira.readIssue(issueId);
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return result.value;
}

/** Read the current source conversation; a source access failure is an execution error. */
async function readConversation(jira: JiraAdapter, issueId: string): Promise<JiraComment[]> {
  const result = await jira.readComments(issueId);
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return [...result.value];
}

/** The agent's report, or an error naming why its output is unusable. */
function parseResponse(output: string): DevelopmentResponse {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(`The development agent returned unusable output: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const parsed = developmentResponseSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join('.') : '<report>';
        return `${location}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(
      `The development agent's report does not match the response format: ${issues}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** Require exactly one response per supplied finding, with no unknown or repeated IDs. */
function requireFindingResponses(
  responses: readonly FindingResponse[],
  findings: readonly Finding[],
): void {
  const supplied = new Set(findings.map((finding) => finding.id));
  const answered = new Set<string>();
  for (const response of responses) {
    if (!supplied.has(response.findingId)) {
      throw new Error(
        `The development agent responded to unknown finding "${response.findingId}".`,
      );
    }
    if (answered.has(response.findingId)) {
      throw new Error(
        `The development agent responded more than once to finding "${response.findingId}".`,
      );
    }
    answered.add(response.findingId);
  }
  const missing = findings.map((finding) => finding.id).filter((id) => !answered.has(id));
  if (missing.length > 0) {
    throw new Error(
      `The development agent did not respond to finding${missing.length === 1 ? '' : 's'} ` +
        `${missing.map((id) => `"${id}"`).join(', ')}.`,
    );
  }
}

/** One earlier round's artifact path, relative to the workspace root. */
function roundArtifact(root: string, round: number, pathFromArtifactsRoot: string): string {
  return path.join(root, 'artifacts', String(round), pathFromArtifactsRoot);
}

/** The available earlier-round results and their paths, in round order. */
function historySection(root: string, histories: RoundHistories): string {
  const rounds = new Map<number, string[]>();
  const add = (number: number, description: string, file: string): void => {
    const lines = rounds.get(number) ?? [];
    lines.push(`  - ${description}: ${roundArtifact(root, number, file)}`);
    rounds.set(number, lines);
  };
  for (const value of histories.development) {
    add(
      value.number,
      `development result (${value.value.status})`,
      devArtifact.pathFromArtifactsRoot,
    );
  }
  for (const value of histories.verification) {
    add(
      value.number,
      `verification result (${value.value.status})`,
      verificationArtifact.pathFromArtifactsRoot,
    );
  }
  for (const value of histories.review) {
    add(
      value.number,
      `review result (${value.value.verdict})`,
      reviewArtifact.pathFromArtifactsRoot,
    );
  }
  for (const value of histories.repair) {
    add(
      value.number,
      `repair decision (${value.value.decision})`,
      repairArtifact.pathFromArtifactsRoot,
    );
  }
  if (rounds.size === 0) {
    return 'Earlier rounds: none.';
  }
  const ordered = [...rounds.entries()].sort(([left], [right]) => left - right);
  return [
    'Earlier rounds (read these for prior decisions and evidence):',
    ...ordered.flatMap(([number, lines]) => [`- Round ${number}:`, ...lines]),
  ].join('\n');
}

/** The latest recorded check results and their log paths, or null when none were recorded. */
function checkEvidence(root: string, histories: RoundHistories): string | null {
  const recorded = latest(histories.verification);
  if (recorded === null) {
    return null;
  }
  return [
    `Latest recorded verification (round ${recorded.number}): ${recorded.value.status}.`,
    ...recorded.value.checks.map(
      (check) =>
        `- check "${check.name}": exit code ${check.exitCode}, ` +
        `stdout ${roundArtifact(root, recorded.number, check.stdoutPath)}, ` +
        `stderr ${roundArtifact(root, recorded.number, check.stderrPath)}`,
    ),
  ].join('\n');
}

/** The report shape and identity rules; the action observes the profile and revisions itself. */
const responseInstructions = `Return exactly one JSON object with this shape, and nothing else:
{"status":"completed"|"failed","summary":"<what changed and why, or why implementation could not be completed>","findingResponses":[{"findingId":"<supplied finding ID>","status":"addressed"|"disputed"|"unresolved","response":"<the change, disagreement or remaining problem, with supporting evidence>"}]}
Include exactly one findingResponses entry for every supplied finding ID and no others; use an empty array when no findings are supplied. status "completed" means the implementation is committed on the prepared branch and ready for verification; "failed" means it could not be completed.`;

/** Create Develop over the configured selection, profiles, developer runtime and adapters. */
export function createDevelop(settings: DevelopSettings): BoundAction {
  return async () => {
    const selection = await readRecord(settings.selectionFile, selectionDeclaration);
    if (selection === null) {
      throw new Error(`Selection at "${settings.selectionFile}" does not exist.`);
    }
    const root = selection.workspace.root;
    const worktree = path.join(root, 'worktree');
    const helpers = createArtifactHelpers({ root });

    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRecord(preparedFile, preparedWorkspaceDeclaration);
    if (prepared === null) {
      throw new Error(`Prepared workspace at "${preparedFile}" does not exist.`);
    }

    const histories: RoundHistories = {
      development: await helpers.readArtifactHistory(devArtifact),
      verification: await helpers.readArtifactHistory(verificationArtifact),
      review: await helpers.readArtifactHistory(reviewArtifact),
      repair: await helpers.readArtifactHistory(repairArtifact),
    };
    const profile = profileForRound(histories.repair, settings.initialProfile);
    const existing = (await helpers.readOptionalInputArtifacts(devArtifact))[0];

    // A repetition reuses a current-round report only while it still describes this task, profile,
    // comparison base and committed revision. Otherwise another invocation is needed.
    const before = await inspectRepository(settings.git, worktree);
    if (
      existing !== null &&
      existing.taskKey === selection.taskKey &&
      existing.profile === profile &&
      existing.baseRevision === prepared.baseRevision &&
      existing.headRevision === before.headRevision &&
      (existing.status === 'failed' || readinessProblem(before, prepared) === null)
    ) {
      return existing.status;
    }

    const issue = await readIssue(settings.jira, selection.source.issueId);
    const conversation = await readConversation(settings.jira, selection.source.issueId);
    // The selection owns the task and conversation; refresh them in place, preserving the selected
    // identity and the retained workspace reference.
    await writeRecord(settings.selectionFile, {
      ...selection,
      task: issue,
      conversation,
    });

    const latestReview = latest(histories.review);
    const findings = latestReview?.value.findings ?? [];
    const evidence = checkEvidence(root, histories);
    const context = [
      `Task ${selection.taskKey} (Jira issue ${issue.key})`,
      JSON.stringify(issue, null, 2),
      `Prepared branch: ${prepared.branch} (comparison base ${prepared.baseRevision})`,
      `Local selection record (refreshed task and complete conversation): ${settings.selectionFile}`,
      latestReview === null
        ? 'No review findings are supplied for this round.'
        : `Findings to respond to (complete values from the review in round ${latestReview.number}):\n` +
          JSON.stringify(findings, null, 2),
      historySection(root, histories),
      ...(evidence === null ? [] : [evidence]),
      responseInstructions,
    ].join('\n\n');

    settings.publish({
      source: 'develop',
      type: 'agent-started',
      data: { role: 'developer', operation: 'Develop', profile, task: selection.taskKey },
    });
    let result: AgentResult;
    try {
      result = await settings.runtime.run(profile, { root }, context);
    } finally {
      settings.publish({ source: 'develop', type: 'agent-finished', data: null });
    }
    if (!result.ok) {
      throw new Error(result.fault.message);
    }

    const response = parseResponse(result.value.output);
    requireFindingResponses(response.findingResponses, findings);

    const after = await inspectRepository(settings.git, worktree);
    if (after.headRevision === null) {
      throw new Error(
        `The development turn left the worktree at "${worktree}" without a revision.`,
      );
    }
    const problem = readinessProblem(after, prepared);
    let status: DevelopmentOutput['status'] = 'completed';
    let summary = response.summary;
    let failureReason: string | null = null;
    if (response.status === 'failed') {
      status = 'failed';
      failureReason = `The development turn reported incomplete work: ${response.summary}`;
    } else if (problem !== null) {
      // A completed turn whose worktree is not ready becomes failed, and the summary keeps both the
      // agent's explanation and the observed readiness failure for a later repair round.
      status = 'failed';
      failureReason = `The development turn reported completed work, but ${problem}.`;
      summary = `${response.summary} ${failureReason}`;
    }
    if (failureReason !== null) {
      settings.publish({ source: 'develop', type: 'failed', data: { reason: failureReason } });
    }

    const output: DevelopmentOutput = {
      taskKey: selection.taskKey,
      profile,
      status,
      baseRevision: prepared.baseRevision,
      headRevision: after.headRevision,
      summary,
      findingResponses: response.findingResponses,
    };
    await helpers.writeOutputArtifact(devArtifact, output);
    return status;
  };
}
