import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../../adapters/git.js';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../../index.js';
import { parseAgentReport, responseFormatText } from '../../agent-reports.js';
import { readRecord, readRequiredRecord, writeRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import {
  reviewResponseSchema,
  toFinding,
  validateReviewResponse,
  type ReviewOutput,
} from '../../review/artifacts.js';
import { retainStageFailure } from '../failure.js';
import { prepareDocumentationPublication } from '../publication.js';
import { stageRoot } from '../storage.js';
import { documentationReviewDeclaration, documentationReviewsDirectory } from './artifacts.js';

/** Architecture's child assesses the assembled revision before the deterministic parent publishes it. */
export function createReviewPreparationPublication(settings: {
  readonly selectionFile: string;
  readonly baseBranch: string;
  readonly reviewerProfile: string;
  readonly reviewer: AgentRoleRunner;
  readonly git: GitAdapter;
  readonly publish: EventPublisher;
}): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    async function failed(reason: string): Promise<'failed'> {
      await retainStageFailure(stageRoot(root, 'architecture'), reason);
      settings.publish({
        source: 'review-preparation-publication',
        type: 'failed',
        data: { reason },
      });
      return 'failed';
    }
    const prepared = await prepareDocumentationPublication({
      root,
      taskKey: selection.taskKey,
      baseBranch: settings.baseBranch,
      git: settings.git,
    });
    if (prepared.kind === 'failed') return failed(prepared.reason);
    if (prepared.kind === 'unchanged') return 'unchanged';
    const { head, baseRevision, worktree, documents } = prepared;
    const reportFile = path.join(root, documentationReviewsDirectory, `${head}.json`);
    let report = await readRecord(reportFile, documentationReviewDeclaration);
    if (report === null) {
      const diff = await settings.git.readDiff(worktree, baseRevision, head);
      if (!diff.ok) return failed(diff.fault.message);
      const assessment = await settings.reviewer.run({
        operation: 'review',
        profile: settings.reviewerProfile,
        workspace: { root: worktree },
        context: [
          `Review the assembled documentation publication for ${selection.taskKey} at exact revision ${head}, comparison base ${baseRevision}.`,
          `Source input: ${JSON.stringify(selection.task)}\nConversation: ${JSON.stringify(selection.conversation)}`,
          `Accepted document references: ${JSON.stringify(documents)}. Read their stage results and evaluations under ${root}.`,
          'Assess the complete publication for consistency with accepted requirements, UX and architecture and the documentation-only boundary. No prior findings are supplied; return an empty priorFindings array.',
          diff.value,
          responseFormatText(reviewResponseSchema),
        ].join('\n\n'),
        outputSchema: z.toJSONSchema(reviewResponseSchema),
        task: selection.taskKey,
      });
      if (!assessment.ok) return failed(assessment.fault.message);
      const response = parseAgentReport(
        assessment.value.output,
        reviewResponseSchema,
        'documentation reviewer',
      );
      validateReviewResponse(response, []);
      report = {
        ...response,
        findings: response.findings.map(toFinding),
        profile: settings.reviewerProfile,
        headRevision: head,
      } satisfies ReviewOutput;
      await mkdir(path.dirname(reportFile), { recursive: true });
      await writeRecord(reportFile, report);
    }
    const observed = await settings.git.inspectRepository(worktree);
    if (!observed.ok) return failed(observed.fault.message);
    if (report.headRevision !== head || observed.value.headRevision !== head)
      return failed(
        'The publication head changed during review; obtain evaluation of the new revision.',
      );
    if (report.verdict !== 'approved')
      return failed(
        `Documentation review ${report.verdict}: ${report.summary}; findings: ${reportFile}. Repair before retrying.`,
      );
    return 'approved';
  };
}
