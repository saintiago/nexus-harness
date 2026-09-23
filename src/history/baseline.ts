/** Reuse the baseline review's accepted outcome, never its unvalidated finding file. */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readBaselineOutcome } from '../reviews/baseline.js';
import { readBaselineEvidence } from '../sources/baseline.js';
import { messageOf } from '../shared/errors.js';
import type { SourceRef } from '../shared/types.js';
import type { LocalReport, ReviewerReportDigest } from './reports.js';

export async function readBaselineReports(parts: {
  readonly workDir: string;
  readonly ref: SourceRef;
  readonly workspaceId: string;
}): Promise<{ reports: LocalReport[]; problems: string[] }> {
  const reports: LocalReport[] = [];
  const problems: string[] = [];
  const directories = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        problems.push(`baseline history at "${dir}" could not be listed: ${messageOf(cause)}`);
      }
      return [];
    }
  };
  const root = path.join(parts.workDir, 'baseline');
  for (const project of await directories(root)) {
    for (const name of await directories(path.join(root, project))) {
      const dir = path.join(root, project, name);
      const evidenceFile = path.join(dir, 'evidence.json');
      let evidence;
      try {
        evidence = await readBaselineEvidence(evidenceFile, project);
        if (evidence === null) throw new Error('the evidence record is missing');
      } catch (cause) {
        problems.push(
          `baseline history identity at "${evidenceFile}" is unavailable: ${messageOf(cause)}`,
        );
        continue;
      }
      if (
        evidence.ref.type !== parts.ref.type ||
        evidence.ref.scope !== parts.ref.scope ||
        evidence.ref.id !== parts.ref.id ||
        evidence.workspace.workspaceId !== parts.workspaceId
      )
        continue;
      const sourceId = `baseline-${project}-${evidence.evidenceId}`;
      const file = path.join(dir, 'outcome.json');
      let createdAt = evidence.closedAt ?? 'unknown';
      try {
        const outcome = await readBaselineOutcome(dir);
        if (outcome === null) {
          // An evidence record exists before the first turn prepares its input.
          // Only an already-started or closed diagnosis promises a past report.
          const files = await readdir(dir);
          if (
            evidence.closed === undefined &&
            !files.includes('input.md') &&
            !files.includes('reviewer.log')
          )
            continue;
          throw new Error(
            'the retained baseline outcome is missing; finding.json is not accepted evidence',
          );
        }
        const text = await readFile(file, 'utf8');
        createdAt = (await stat(file)).mtime.toISOString();
        const finding = outcome.state === 'finding' ? outcome.finding : null;
        const digest: ReviewerReportDigest = {
          version: 1,
          kind: 'reviewer-report',
          reviewId: sourceId,
          ref: evidence.ref,
          workspaceId: parts.workspaceId,
          round: null,
          task: { id: evidence.task.id, title: evidence.task.title },
          head: evidence.workspace.baseCommit,
          decision: finding?.outcome === 'repair' ? 'request_changes' : 'inconclusive',
          summary: `Baseline diagnosis: ${finding?.outcome ?? 'rejected'}`,
          findings:
            finding === null
              ? []
              : [{ id: 'F1', path: file, line: null, body: JSON.stringify(finding, null, 2) }],
          createdAt,
          textFile: '',
          recordFile: file,
          recordProblem: null,
          published: null,
          ...(evidence.publication === undefined
            ? {}
            : {
                jiraPublication: { ...evidence.publication, url: null },
              }),
        };
        reports.push({
          kind: 'reviewer-report',
          digest,
          complete: true,
          problem: null,
          legacy: true,
          text:
            `# Baseline reviewer report — ${sourceId}\n\nSource: ${file}\n` +
            `Reviewed commit: ${digest.head}\nTime: ${createdAt} (retained outcome file modification time; original turn time unavailable)\n` +
            `Publication: ${evidence.publication?.commentId ?? 'not recorded'}\n\n${text}`,
        });
      } catch (cause) {
        const problem = `baseline reviewer report ${sourceId} at "${file}" is unavailable: ${messageOf(cause)}`;
        reports.push({
          kind: 'missing-report',
          role: 'reviewer',
          sourceId,
          ref: evidence.ref,
          round: null,
          createdAt,
          text: problem,
          problem,
          reportPath: file,
        });
      }
    }
  }
  return { reports, problems };
}
