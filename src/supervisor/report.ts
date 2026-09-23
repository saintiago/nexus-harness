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
 * The email summary is the harder half, because a topic has no thread to look
 * in. Its publication is therefore written down in two steps: the summary is
 * recorded as `pending` before the publisher is started, and its acknowledged
 * `MessageId` (or its failure) afterwards. A restart that finds `pending` reads
 * the publisher's own output before it would ever send anything again — an
 * acknowledgement there is adopted, and the absence of one is recorded as an
 * interrupted publication that is never repeated automatically, because a
 * second email is worse than an unconfirmed one. Publication state and the
 * sender's output are both checked through {@link reportNeedsPublication}, so a
 * report that could not be finished stays reachable after the incident it
 * belongs to has been resumed.
 *
 * The report is context, not authority. It says what the recovery agent found
 * and did; the configured checks, the Nexus Lens review and the completion path
 * remain the only things that decide whether work is done
 * (docs/WORKFLOW.md §12).
 */
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
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
      (incident.scope === null ? '' : ` The worker was scoped to ${incident.scope}.`) +
      (incident.ticket === null
        ? ''
        : ` This report belongs to ${incident.ticket.key}, which is written into that item's ` +
          'thread.'),
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
        `Resumption: ${attempt.resume ?? 'the interrupted work resumes after that blocker'}. The ` +
          'parent starts that blocker first and records the moment the interrupted work itself ' +
          'is started again.',
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

/**
 * The complete record of one incident, as the ticket's shared history keeps it.
 *
 * The concise report above is one publication of one incident; this is the
 * whole thing — every stop, every attempt with the cause it investigated and
 * the work it preserved, the conclusion, the resumption the queue was given,
 * and the publication identities — so a developer or reviewer turn reads what
 * really happened instead of a summary that says evidence exists elsewhere. It
 * is written for both roles, and it is context like everything else: what
 * decides whether work is done stays the configured checks, the Nexus Lens
 * review and the completion path (docs/WORKFLOW.md §12).
 */
export function incidentHistoryText(incident: IncidentRecord): string {
  const lines: string[] = [
    `Harness recovery incident ${incident.id} (complete record).`,
    '',
    `State: ${incident.stage}` +
      (incident.conclusion === null
        ? ''
        : ` — concluded ${incident.conclusion.outcome} at ${incident.conclusion.at}: ` +
          incident.conclusion.detail),
    `Ticket: ` +
      (incident.ticket === null
        ? 'the recovery did not identify one'
        : `${incident.ticket.key}${incident.ticket.url === null ? '' : ` (${incident.ticket.url})`}`),
    `Resumption: ` +
      (incident.resumedAt === null
        ? 'the interrupted work has not been started again yet'
        : `the interrupted work was really started again at ${incident.resumedAt}`),
  ];
  if (incident.sequence?.blocker !== null && incident.sequence !== null) {
    lines.push(
      `Blocker ranked first: ${incident.sequence.blocker.key} — ${incident.sequence.blocker.reason}` +
        (incident.sequence.blockerStartedAt === null
          ? ' (not started yet)'
          : ` (started ${incident.sequence.blockerStartedAt})`),
    );
  }
  lines.push('', 'Stops observed:');
  for (const stop of incident.stops) {
    lines.push(
      `- ${stop.at}: \`queue ${stop.intent === 'watch' ? 'watch' : 'run'}\`` +
        `${stop.scope === null ? '' : ` scoped to ${stop.scope}`} ended ` +
        (stop.signal === null
          ? `with exit code ${String(stop.exitCode)}`
          : `on signal ${stop.signal}`),
    );
  }
  lines.push(
    '',
    `Recovery attempts: ${String(incident.attempts.length)} of at most ${String(incident.maxAttempts)}.`,
  );
  for (const attempt of incident.attempts) {
    lines.push(
      `- Attempt ${String(attempt.attempt)} (${attempt.startedAt} → ${attempt.endedAt}): ${attempt.outcome}`,
    );
    if (attempt.summary !== null) lines.push(`  Summary: ${attempt.summary}`);
    if (attempt.cause !== null) lines.push(`  Cause: ${attempt.cause}`);
    if (attempt.resolution !== null) lines.push(`  Resolution: ${attempt.resolution}`);
    if (attempt.preserved.length > 0) lines.push(`  Preserved: ${attempt.preserved.join('; ')}`);
    if (attempt.resume !== null) lines.push(`  Resumes: ${attempt.resume}`);
    if (attempt.blocker !== null) {
      lines.push(`  Blocker first: ${attempt.blocker.key} — ${attempt.blocker.reason}`);
    }
    if (attempt.help !== null) lines.push(`  Human help required: ${attempt.help}`);
    if (attempt.problem !== null) lines.push(`  Problem: ${attempt.problem}`);
    if (attempt.dir !== null) lines.push(`  Turn directory: ${attempt.dir}`);
    if (attempt.logPath !== null) lines.push(`  Turn log: ${attempt.logPath}`);
  }
  lines.push(
    '',
    'Publication: ' +
      (incident.report.commentId === null
        ? 'no Jira comment is recorded'
        : `Jira comment ${incident.report.commentId}${incident.report.publishedAt === null ? '' : ` at ${incident.report.publishedAt}`}`) +
      '; ' +
      (incident.report.notification === null
        ? 'no email summary was configured'
        : `email summary ${incident.report.notification.state} for ${incident.report.notification.email}` +
          (incident.report.notification.messageId === null
            ? ''
            : ` (message ${incident.report.notification.messageId})`)) +
      '.',
  );
  if (incident.report.problem !== null) {
    lines.push(`Reporting problem: ${incident.report.problem}`);
  }
  lines.push(
    '',
    'This is recovery context for whatever turn reads it: it is never an approval, a verification,',
    'or a substitute for a passed check, a review verdict, or the completion path.',
  );
  return `${lines.join('\n')}\n`;
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
  /**
   * Persists what has been recorded so far, called before a publication is
   * attempted and again once it is known to have been attempted. The caller
   * writes it down durably; the reporter never assumes it happened.
   */
  readonly checkpoint?: ((report: IncidentReport) => Promise<void>) | undefined;
}) => Promise<ReportOutcome>;

/**
 * Whether one concluded incident still needs its report published.
 *
 * A comment is outstanding while the ticket it belongs to is known and no
 * comment id was acknowledged — a report written before an invocation stopped
 * is looked for in the ticket's own thread, so this is about a publication that
 * really has to be made, not about a comment that might already be there. An
 * email summary is outstanding while it is `failed` (the publisher reported a
 * failure and never sent it) or `pending` (an attempt was in flight and has to
 * be reconciled against the publisher's own output). A summary that was sent,
 * and one whose acknowledgement can no longer be found, are both finished:
 * repeating either would publish a second email for one incident.
 */
export function reportNeedsPublication(
  incident: IncidentRecord,
  parts: {
    /** Whether the connected project has a Jira thread the report is written into. */
    readonly jira: boolean;
    readonly notification: RecoveryNotificationConfig | null;
  },
): boolean {
  const commentOutstanding =
    parts.jira && incident.ticket !== null && incident.report.commentId === null;
  const state = incident.report.notification?.state ?? null;
  const emailOutstanding =
    parts.notification !== null && (state === 'failed' || state === 'pending' || state === null);
  return commentOutstanding || emailOutstanding;
}

/**
 * The reporter one supervisor invocation uses. Every publication is
 * acknowledged before it is recorded, and every already-acknowledged or
 * already-attempted publication is left alone: this is what keeps a restart
 * from writing a second report for one incident.
 */
export function createIncidentReporter(parts: IncidentReporterParts): IncidentReporter {
  const runNotification = parts.runNotification ?? runCommand;
  return async ({ incident, stop, checkpoint }) => {
    const text = incidentReportText(incident, parts.notification);
    let commentId = incident.report.commentId;
    let publishedAt = incident.report.publishedAt;
    const commentText = incident.report.commentText ?? text.text;
    let notification = incident.report.notification;
    const problems: string[] = [];
    const writeDown = async (report: IncidentReport): Promise<void> => {
      await checkpoint?.(report);
    };
    const reportSoFar = (): IncidentReport => ({
      publishedAt,
      commentId,
      commentText,
      notification,
      problem: problems.length === 0 ? null : problems.join(' '),
    });

    if (incident.ticket !== null && parts.jira !== undefined) {
      const key = incident.ticket.key;
      if (commentId === null) {
        // What will be posted is written down before it is posted, with the
        // report's own first line as its identity: an invocation that stops
        // between the post and its acknowledgement leaves the exact text behind
        // for the next one to find in the ticket's thread.
        await writeDown({ ...reportSoFar(), commentText: text.text });
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
      } else if (previous?.state === 'interrupted') {
        // An interrupted publication that was never acknowledged is recorded
        // once and never repeated automatically: a second email for one
        // incident is worse than an unconfirmed one, and only a person can
        // check the topic.
      } else if (previous?.state === 'pending') {
        // An attempt was in flight when the invocation before this one stopped.
        // Its own publisher's output says whether the topic acknowledged it.
        const acknowledged = await acknowledgedSummary(parts, incident);
        if (acknowledged !== null) {
          notification = {
            topicArn: parts.notification.topicArn,
            email: parts.notification.email,
            state: 'sent',
            messageId: acknowledged,
            problem: null,
          };
        } else {
          const detail =
            'the publication was interrupted and the publisher acknowledged nothing, so it may ' +
            'or may not have reached the topic';
          notification = {
            topicArn: parts.notification.topicArn,
            email: parts.notification.email,
            state: 'interrupted',
            messageId: null,
            problem: detail,
          };
          problems.push(
            `the email summary to ${parts.notification.email} was left in flight by an earlier ` +
              `invocation (${detail}); it is not sent again automatically, because a second ` +
              `summary for one incident is worse than an unconfirmed one — check ` +
              `${parts.notification.topicArn} before resending it by hand`,
          );
        }
      } else if (previous !== null && previous.state !== 'failed') {
        problems.push(
          `the email summary to ${parts.notification.email} may or may not have been published ` +
            'before the supervisor stopped (the publication was interrupted), so it is not sent ' +
            'again automatically; check the topic before resending it by hand',
        );
      } else if (stop.aborted) {
        problems.push('the email summary was not sent: the supervisor was stopped first');
      } else {
        // Written down as pending before the publisher starts: a restart reads
        // this state as "an attempt was made", never as "nothing was tried".
        notification = {
          topicArn: parts.notification.topicArn,
          email: parts.notification.email,
          state: 'pending',
          messageId: null,
          problem: null,
        };
        await writeDown(reportSoFar());
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
  // The publication's own evidence lives beside the incident; the directory is
  // created here so a report that runs before anything else wrote it still
  // keeps the publisher's output. Each attempt gets its own label: the command
  // log files are created exclusively, so a retry after a failure writes its
  // own log rather than failing to write at all, and every attempt's output
  // stays readable for the reconciliation that adopts an interrupted one.
  await mkdir(parts.logsDir(incident), { recursive: true });
  const logsDir = parts.logsDir(incident);
  const label = await notificationLabel(logsDir);
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
    logsDir,
    label,
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

/** How many publication attempts one incident's log directory may hold. */
const MAX_NOTIFICATION_ATTEMPTS = 50;

/** The label one publication attempt's own log files use. */
async function notificationLabel(logsDir: string): Promise<string> {
  const base = 'recovery-notification';
  let names: readonly string[];
  try {
    names = await readdir(logsDir);
  } catch {
    names = [];
  }
  for (let index = 1; index <= MAX_NOTIFICATION_ATTEMPTS; index += 1) {
    const label = index === 1 ? base : `${base}-${String(index)}`;
    if (!names.includes(`${label}.stdout.log`) && !names.includes(`${label}.stderr.log`)) {
      return label;
    }
  }
  throw new Error(
    `the incident's notification log directory "${logsDir}" already holds ` +
      `${String(MAX_NOTIFICATION_ATTEMPTS)} publication attempts; inspect it by hand instead of ` +
      'publishing another summary',
  );
}

/**
 * The message identity a publisher acknowledged, read back from the output of
 * the attempts this incident already made. This is the only evidence a
 * publication that was in flight left behind: the topic itself is never
 * queried, and reading these files changes nothing.
 */
async function acknowledgedSummary(
  parts: IncidentReporterParts,
  incident: IncidentRecord,
): Promise<string | null> {
  const notification = parts.notification;
  if (notification === null) {
    return null;
  }
  const dir = parts.logsDir(incident);
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const logs = names
    .filter((name) => /^recovery-notification(-[0-9]+)?\.stdout\.log$/.test(name))
    .sort();
  for (const name of logs) {
    const text = await readFile(path.join(dir, name), 'utf8').catch(() => '');
    const topic = /"TopicArn"\s*:\s*"([^"]+)"/.exec(text);
    if (topic !== null && topic[1] !== notification.topicArn) {
      continue;
    }
    const match = /"MessageId"\s*:\s*"([^"]+)"/.exec(text);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}
