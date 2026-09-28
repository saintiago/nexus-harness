import path from 'node:path';
import { z } from 'zod';
import type { AgentResult } from '../../../agent-runtime/index.js';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import type { JiraAdapter } from '../../../adapters/jira.js';
import type { Observation } from '../../../memory/index.js';
import { messageOf } from '../../../result.js';
import {
  actionOutcomeEvent,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../../index.js';
import {
  createArtifactHelpers,
  roundArtifactPath,
  type ArtifactHistoryValue,
} from '../artifacts.js';
import { describeIssues, parseDocument } from '../documents.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
  type PreparedWorkspace,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord, writeRecord } from '../records.js';
import { reviewArtifact, type Finding, type ReviewOutput } from '../review/artifacts.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { issueSummary, readComments, readIssue } from '../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { verificationArtifact, type VerificationOutput } from '../verify/artifacts.js';
import {
  issueQueryMaterial,
  observationSourceKey,
  recallForInvocation,
  rememberObserved,
  retrievalQuery,
  memoryContextOf,
  type MemoryContext,
} from '../memory.js';
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
 * assembles the round's context from the earlier-round artifacts and invokes the profile the
 * current round selected once. The action records the profile and observed repository revisions;
 * the agent supplies only status, summary and finding responses. A completed turn must leave
 * committed work on the prepared branch; otherwise the recorded summary also carries the observed
 * readiness failure.
 *
 * Source, repository and invocation failures are execution errors. Unusable agent output is an
 * execution error, not a failed report.
 */

export type DevelopSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The developer role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly git: GitAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
  /**
   * The memory capability, project identity and evidence directory of this execution; Application
   * supplies it, and an action without one performs no recall or ingestion.
   */
  readonly memory?: MemoryContext;
};

/** The earlier-round values of the artifacts this action reads as history. */
type RoundHistories = {
  readonly development: readonly ArtifactHistoryValue<DevelopmentOutput>[];
  readonly verification: readonly ArtifactHistoryValue<VerificationOutput>[];
  readonly review: readonly ArtifactHistoryValue<ReviewOutput>[];
};

/** The most recent value of an artifact history, or null when it has none. */
function latest<Value>(
  history: readonly ArtifactHistoryValue<Value>[],
): ArtifactHistoryValue<Value> | null {
  return history.at(-1) ?? null;
}

/**
 * Why the observed worktree does not hold the committed implementation ready for verification, or
 * null. Untracked files are the dependencies, caches and verification output the worktree is
 * expected to carry; only uncommitted tracked changes contradict the recorded revision.
 */
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

/** The agent's report, or an error naming why its output is unusable. */
function parseResponse(output: string): DevelopmentResponse {
  const parsed = parseDocument(output, developmentResponseSchema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(`The development agent returned unusable output: ${messageOf(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `The development agent's report does not match the response format: ` +
        describeIssues(parsed.error, '<report>'),
      { cause: parsed.error },
    );
  }
  return parsed.content;
}

/**
 * The deterministic observations one saved development result yields: one summary note and one
 * separate note per finding response, each carrying the complete finding it answers. Extraction
 * uses the artifact's own fields; the source key covers the artifact, the element selector and the
 * extracted content, so a rewritten artifact is a new observation and a reused one is the same.
 */
function developmentObservations(settings: {
  readonly root: string;
  readonly memory: MemoryContext;
  readonly taskKey: string;
  readonly subject: string;
  readonly round: number;
  readonly output: DevelopmentOutput;
  readonly findings: readonly Finding[];
  /** The earlier review artifact the findings came from, when one was read. */
  readonly findingArtifact: string | null;
}): Observation[] {
  const artifact = roundArtifactPath(
    settings.root,
    settings.round,
    devArtifact.pathFromArtifactsRoot,
  );
  const envelope =
    `Task ${settings.taskKey} "${settings.subject}" — project ${settings.memory.project}, ` +
    `role developer, round ${String(settings.round)}, outcome ${settings.output.status}, ` +
    `revision ${settings.output.headRevision}.`;
  const observation = (selector: string, content: string): Observation => {
    const text = `${envelope}\n${content}`;
    return {
      sourceKey: observationSourceKey({
        artifact,
        selector,
        material: { artifact: settings.output, content: text },
      }),
      content: text,
      provenance: {
        project: settings.memory.project,
        issue: settings.taskKey,
        workflow: settings.memory.workflow,
        role: 'developer',
        artifact,
        element: selector,
        round: settings.round,
        revision: settings.output.headRevision,
        ...(settings.findingArtifact !== null && selector.startsWith('finding-response:')
          ? { references: [settings.findingArtifact] }
          : {}),
      },
    };
  };
  return [
    observation('summary', `Development summary: ${settings.output.summary}`),
    ...settings.output.findingResponses.map((response) => {
      const finding = settings.findings.find((candidate) => candidate.id === response.findingId);
      return observation(
        `finding-response:${response.findingId}`,
        `Finding response (${response.status}) to finding "${response.findingId}": ` +
          `${response.response}\nOriginal finding: ` +
          (finding === undefined ? 'not supplied' : JSON.stringify(finding, null, 2)),
      );
    }),
  ];
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
  const memory = memoryContextOf(settings.memory);

  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const worktree = path.join(root, 'worktree');
    const helpers = createArtifactHelpers({ root });

    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRequiredRecord(
      preparedFile,
      preparedWorkspaceDeclaration,
      'Prepared workspace',
    );

    const histories: RoundHistories = {
      development: await helpers.readArtifactHistory(devArtifact),
      verification: await helpers.readArtifactHistory(verificationArtifact),
      review: await helpers.readArtifactHistory(reviewArtifact),
    };
    const round = await readRequiredRecord(
      path.join(root, currentRoundFile),
      currentRoundDeclaration,
      'Current round',
    );
    const profile = round.profile;
    const existing = (await helpers.readOptionalInputArtifacts(devArtifact))[0];
    const latestReview = latest(histories.review);

    /** Report the outcome referencing the current round's saved development report. */
    function report(status: DevelopmentOutput['status']): void {
      settings.publish(
        actionOutcomeEvent('develop', {
          task: selection.taskKey,
          round: round.number,
          outcome: status,
          detail: `profile ${profile}`,
          artifact: {
            path: roundArtifactPath(root, round.number, devArtifact.pathFromArtifactsRoot),
          },
        }),
      );
    }

    /** Observe one saved development result, whether it was just produced or reused. */
    async function observe(output: DevelopmentOutput): Promise<void> {
      const observations = developmentObservations({
        root,
        memory,
        taskKey: selection.taskKey,
        subject: issueSummary(selection.task) ?? selection.taskKey,
        round: round.number,
        output,
        findings: latestReview?.value.findings ?? [],
        findingArtifact:
          latestReview === null
            ? null
            : roundArtifactPath(root, latestReview.number, reviewArtifact.pathFromArtifactsRoot),
      });
      for (const observation of observations) {
        await rememberObserved(
          { memory: memory.memory, publish: settings.publish, source: 'develop' },
          observation,
        );
      }
    }

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
      // Reuse re-observes the same source keys; an accepted hand-off becomes a note even when the
      // first attempt's ingestion did not complete.
      await observe(existing);
      report(existing.status);
      return existing.status;
    }

    const issue = await readIssue(settings.jira, selection.source.issueId);
    const conversation = await readComments(settings.jira, selection.source.issueId);
    // The selection owns the task and conversation; refresh them in place, preserving the selected
    // identity and the retained workspace reference.
    await writeRecord(settings.selectionFile, {
      ...selection,
      task: issue,
      conversation,
    });

    const findings = latestReview?.value.findings ?? [];
    const evidence = checkEvidence(root, histories);
    const scope = {
      project: memory.project,
      workflow: memory.workflow,
      role: 'developer',
    };
    const latestVerification = latest(histories.verification);
    const recall = await recallForInvocation({
      memory: memory.memory,
      evidenceDirectory: memory.evidenceDirectory,
      publish: settings.publish,
      source: 'develop',
      scope,
      query: retrievalQuery(scope, [
        ...issueQueryMaterial(issue),
        ...(findings.length === 0 ? [] : [`repair findings: ${JSON.stringify(findings)}`]),
        ...(latestVerification?.value.status === 'failed' && evidence !== null
          ? [`verification failure: ${evidence}`]
          : []),
      ]),
    });
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
      ...(recall.block === null ? [] : [recall.block]),
      responseInstructions,
    ].join('\n\n');

    const result: AgentResult = await settings.runner.run({
      operation: 'Develop',
      profile,
      workspace: { root },
      context,
      outputSchema: z.toJSONSchema(developmentResponseSchema),
      invocationId: recall.invocationId,
      task: selection.taskKey,
      summary: issueSummary(issue),
    });
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
    await observe(output);
    report(status);
    return status;
  };
}
