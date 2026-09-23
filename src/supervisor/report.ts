/**
 * One incident's report: the concise Jira record of what happened, and the
 * email summary carried to the operator through the configured SNS topic.
 *
 * The report is written from the incident record and nothing else, so it can be
 * composed — and its deduplication checked — without starting anything. Every
 * publication identity the remote side acknowledges is recorded back into the
 * incident, which is what makes reporting survive a supervisor restart: a
 * comment already acknowledged is never posted twice, a comment whose own write
 * was interrupted is looked for in the ticket's thread before another is sent,
 * and a summary already handed to the topic is never published again.
 *
 * The report is context, not authority. It says what the recovery agent found
 * and did; the configured checks, the Nexus Lens review and the completion path
 * remain the only things that decide whether work is done
 * (docs/WORKFLOW.md §12).
 */
import { readFile } from 'node:fs/promises';
import { buildCommentDocument } from '../sources/jira/adf-text.js';
import { readCommentThread } from '../sources/jira/comments.js';
import type { HttpClient } from '../sources/jira/http.js';
import { runCommand } from '../process/command.js';
import { messageOf } from '../shared/errors.js';
import type { RecoveryNotificationConfig } from '../shared/types.js';
import type { IncidentRecord, IncidentReport, RecoveryAttempt } from './incident.js';

/** How long one notification command may take: a command bound like any other. */
const NOTIFICATION_TIMEOUT_MS = 120_000;

/** One incident's report, as text and as the subject line it travels under. */
export interface IncidentReportText {
  readonly subject: string;
  readonly paragraphs: readonly string[];
  readonly text: string;
}

/** The one attempt this report is about: the newest, when there is one. */
function concludingAttempt(incident: IncidentRecord): RecoveryAttempt | null {
  return incident.attempts.at(-1) ?? null;
}

/** What the report calls the incident's subject. */
function incidentSubject(incident: IncidentRecord, outcome: string): string {
  const what = incident.scope ?? incident.ticket?.key ?? incident.id;
  return `Nexus recovery: ${what} ${outcome}`;
}

/**
 * The concise report of one incident: what stopped, what the recovery agent
 * found and did, what it preserved, what resumes, and what is still a person's
 * to decide. It is written for both readers of the shared history — the next
 * developer turn and the next reviewer turn read the same text — and it never
 * claims a verification it did not get.
 */
export function incidentReportText(
  incident: IncidentRecord,
  notification: RecoveryNotificationConfig | null,
): IncidentReportText {
  const attempt = concludingAttempt(incident);
  const stop = incident.stops.at(-1) ?? null;
  const ended =
    stop === null
      ? 'the worker stopped without a recorded ending'
      : stop.signal === null
        ? `\`queue ${incident.intent === 'watch' ? 'watch' : 'run'}\` ended with exit code ${String(stop.exitCode)}`
        : `\`queue ${incident.intent === 'watch' ? 'watch' : 'run'}\` ended on signal ${stop.signal}`;
  const outcome =
    incident.conclusion?.outcome === 'repaired'
      ? 'repaired'
      : incident.conclusion?.outcome === 'blocked'
        ? 'blocker ranked first'
        : 'needs human help';

  // The first paragraph is the report's identity: an interrupted publication is
  // recognized in the ticket's thread by exactly this line, which names the
  // incident it belongs to.
  const paragraphs: string[] = [
    `Harness recovery report (incident ${incident.id}). The supervised queue stopped ` +
      'unexpectedly, and the separate recovery agent was invoked to investigate, preserve and ' +
      'repair the situation.',
  ];
  paragraphs.push(
    `What happened: ${ended}${stop === null ? '' : ` at ${stop.at}`}.` +
      (incident.scope === null ? '' : ` The worker was scoped to ${incident.scope}.`),
  );
  paragraphs.push(
    `Recovery: ${String(incident.attempts.length)} of at most ${String(incident.maxAttempts)} ` +
      'attempt(s) spent; the bound is the configured recovery.maxAttempts, and a repeated unchanged ' +
      'failure ends in a request for human help rather than another attempt.',
  );
  if (attempt === null) {
    paragraphs.push(
      'Result: no recovery judgment was produced, so a person has to decide what happens next.',
    );
  } else {
    paragraphs.push(`Cause: ${attempt.cause ?? 'the recovery turn did not say.'}`);
    if (attempt.outcome === 'repaired') {
      paragraphs.push(
        `Repaired: ${attempt.resolution ?? attempt.summary ?? 'no detail was given.'}`,
      );
    } else if (attempt.outcome === 'blocked') {
      paragraphs.push(
        `Blocker ranked first: ${attempt.blocker?.key ?? 'an unnamed ticket'} — ` +
          `${attempt.blocker?.reason ?? 'no reason was given.'}`,
      );
      paragraphs.push(
        `Resumption recorded: ${attempt.resume ?? 'the interrupted work resumes after that blocker.'}`,
      );
    } else if (attempt.outcome === 'unrecoverable') {
      paragraphs.push(
        `Human help required: ${attempt.help ?? 'the recovery turn said a person is needed.'}`,
      );
    } else {
      paragraphs.push(
        `The recovery attempt produced no usable judgment: ${attempt.problem ?? 'no reason was given.'}`,
      );
    }
    if (attempt.preserved.length > 0) {
      paragraphs.push(`Preserved work: ${attempt.preserved.join('; ')}`);
    }
    if (attempt.outcome === 'repaired' && attempt.resume !== null) {
      paragraphs.push(`Resumes: ${attempt.resume}`);
    }
    paragraphs.push(
      `Evidence: the recovery turn's judgment and log are kept beside the incident record in the ` +
        'configured output directory; the working copies, run reports and receipts it read are kept ' +
        'where they were.',
    );
  }
  if (notification !== null) {
    const sent = incident.report.notification;
    paragraphs.push(
      sent?.state === 'sent'
        ? `Email: this summary was sent to ${notification.email} through ${notification.topicArn}.`
        : `Email: the summary to ${notification.email} through ${notification.topicArn} was not ` +
            `confirmed (${sent?.problem ?? 'no acknowledgment was recorded'}).`,
    );
  }
  if (incident.report.problem !== null) {
    paragraphs.push(`Reporting problem: ${incident.report.problem}`);
  }
  paragraphs.push(
    `Outcome: ${outcome}. This report is recovery context, not verification: it never substitutes ` +
      'for a passed check, a Nexus Lens review verdict, or the completion path, and recovery never ' +
      'approves, merges, pushes, or marks a ticket Done.',
  );
  return {
    subject: incidentSubject(incident, outcome),
    paragraphs,
    text: paragraphs.join('\n\n'),
  };
}

/** What one incident report publication concluded. */
export interface ReportOutcome {
  /** The report state to store on the incident, merged by the caller. */
  readonly report: IncidentReport;
  /** What a person must fix about the report itself, when anything. */
  readonly problem: string | null;
}

/** Everything one incident reporter needs to publish. */
export interface IncidentReporterParts {
  /** The Jira boundary, when the connected project has a source to write to. */
  readonly jira?: { readonly http: HttpClient; readonly token: string } | undefined;
  /** Where the email summary goes, when the policy configures it. */
  readonly notification: RecoveryNotificationConfig | null;
  /**
   * The directory the notification command's own output is kept under, named by
   * the incident: one incident's publication evidence stays with its record.
   */
  readonly logsDir: (incident: IncidentRecord) => string;
  /** The working directory the notification command runs in. */
  readonly cwd: string;
  readonly now: () => Date;
  readonly runNotification?: typeof runCommand;
}

/** Publishes one incident's report once, restart-safely. */
export type IncidentReporter = (request: {
  readonly incident: IncidentRecord;
  readonly stop: AbortSignal;
}) => Promise<ReportOutcome>;

/**
 * The reporter one supervisor invocation uses. Every publication is
 * acknowledged before it is recorded, and every already-acknowledged or
 * already-attempted publication is left alone: this is what keeps a restart
 * from writing a second report for one incident.
 */
export function createIncidentReporter(parts: IncidentReporterParts): IncidentReporter {
  const runNotification = parts.runNotification ?? runCommand;
  return async ({ incident, stop }) => {
    const text = incidentReportText(incident, parts.notification);
    let commentId = incident.report.commentId;
    let publishedAt = incident.report.publishedAt;
    const commentText = incident.report.commentText ?? text.text;
    let notification = incident.report.notification;
    const problems: string[] = [];

    if (incident.ticket !== null && parts.jira !== undefined) {
      const key = incident.ticket.key;
      if (commentId === null) {
        // The report may have been posted by an invocation that crashed before
        // recording its id: look for it in the ticket's own thread first, and
        // adopt the comment that already carries this report's own identity.
        const marker = text.paragraphs[0] ?? '';
        const found = await alreadyPublished(parts.jira, key, marker, stop).then(
          (id) => ({ id, problem: null }),
          (cause: unknown) => ({
            id: null,
            problem:
              'the ticket thread could not be read to check for an already-published report: ' +
              messageOf(cause),
          }),
        );
        if (found.problem !== null) {
          // Fail closed: an unreadable thread is not permission to post another
          // report onto it.
          problems.push(found.problem);
        } else if (found.id !== null) {
          commentId = found.id;
          publishedAt = parts.now().toISOString();
        } else if (stop.aborted) {
          problems.push('the report was not posted: the supervisor was stopped first');
        } else {
          try {
            commentId = await postReport(parts.jira, key, text.paragraphs, stop);
            publishedAt = parts.now().toISOString();
          } catch (cause) {
            problems.push(
              `the concise Jira report for incident ${incident.id} could not be posted to ${key}: ` +
                messageOf(cause),
            );
          }
        }
      }
    } else if (incident.ticket === null && parts.jira !== undefined) {
      problems.push(
        `incident ${incident.id} names no ticket, so no Jira report was written; the recovery ` +
          'agent did not identify which item the stop belonged to',
      );
    }

    if (parts.notification !== null) {
      const previous = notification;
      if (previous?.state === 'sent') {
        // Already published: a restart never sends one incident's summary twice.
      } else if (previous !== null && previous.state !== 'failed') {
        problems.push(
          `the email summary to ${parts.notification.email} may or may not have been published ` +
            'before the supervisor stopped (the publication was interrupted), so it is not sent ' +
            'again automatically; check the topic before resending it by hand',
        );
      } else if (stop.aborted) {
        problems.push('the email summary was not sent: the supervisor was stopped first');
      } else {
        try {
          const messageId = await sendSummary(
            runNotification,
            parts,
            incident,
            text.subject,
            text.text,
          );
          notification = {
            topicArn: parts.notification.topicArn,
            email: parts.notification.email,
            state: 'sent',
            messageId,
            problem: null,
          };
        } catch (cause) {
          notification = {
            topicArn: parts.notification.topicArn,
            email: parts.notification.email,
            state: 'failed',
            messageId: null,
            problem: messageOf(cause),
          };
          problems.push(
            `the email summary to ${parts.notification.email} could not be published through ` +
              `${parts.notification.topicArn}: ${messageOf(cause)}`,
          );
        }
      }
    }

    const report: IncidentReport = {
      publishedAt,
      commentId,
      commentText,
      notification,
      problem: problems.length === 0 ? null : problems.join(' '),
    };
    return { report, problem: report.problem };
  };
}

/**
 * The comment already carrying this exact report, when one is there. The
 * comparison is against the text the harness would publish, so a different
 * comment — however similar — is never adopted as this incident's report.
 */
async function alreadyPublished(
  jira: { readonly http: HttpClient; readonly token: string },
  key: string,
  marker: string,
  stop: AbortSignal,
): Promise<string | null> {
  const thread = await readCommentThread(jira.http, jira.token, key, key, stop);
  const wanted = marker.trim();
  for (const comment of [...thread.comments].reverse()) {
    if (comment.text.trim().startsWith(wanted)) {
      return comment.id;
    }
  }
  return null;
}

/** Posts one report as ordinary ADF paragraphs; the acknowledged id or a refusal. */
async function postReport(
  jira: { readonly http: HttpClient; readonly token: string },
  key: string,
  paragraphs: readonly string[],
  stop: AbortSignal,
): Promise<string> {
  const answer = await jira.http.request({
    method: 'POST',
    path: `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
    body: { body: buildCommentDocument(paragraphs) },
    signal: stop,
    mutation: true,
  });
  const id =
    typeof answer === 'object' && answer !== null && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)['id']
      : undefined;
  if (typeof id !== 'string' || id === '') {
    throw new Error(
      `issue ${key}: the report was sent, but its answer did not acknowledge a comment ID, so ` +
        'this harness will not claim it was delivered',
    );
  }
  return id;
}

/**
 * Publishes one summary through the configured topic and reads the identity the
 * publisher acknowledged from its standard output. A publisher that exited
 * successfully without one is recorded as a refusal rather than assumed
 * delivered.
 */
async function sendSummary(
  runNotification: typeof runCommand,
  parts: IncidentReporterParts,
  incident: IncidentRecord,
  subject: string,
  text: string,
): Promise<string | null> {
  const notification = parts.notification;
  if (notification === null) {
    return null;
  }
  const result = await runNotification({
    command: [
      ...notification.publisher,
      '--topic-arn',
      notification.topicArn,
      '--subject',
      subject,
      '--message',
      text,
    ],
    cwd: parts.cwd,
    logsDir: parts.logsDir(incident),
    label: `recovery-notification`,
    timeoutMs: NOTIFICATION_TIMEOUT_MS,
  });
  if (result.outcome !== 'exited' || result.exitCode !== 0) {
    throw new Error(
      `"${notification.publisher.join(' ')}" did not publish the summary (${result.outcome}` +
        `${result.exitCode === null ? '' : `, exit code ${String(result.exitCode)}`}); its output ` +
        `is kept beside the incident record`,
    );
  }
  // The AWS CLI prints the publish result as JSON; the message identity is what
  // a restart checks before it would ever consider publishing again.
  const stdout = await readFile(result.stdoutPath, 'utf8').catch(() => '');
  const match = /"MessageId"\s*:\s*"([^"]+)"/.exec(stdout);
  return match?.[1] ?? null;
}
