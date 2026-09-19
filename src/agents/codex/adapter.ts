/**
 * One top-level coding turn, run through the Codex CLI and normalized for the
 * runner: a summary and, when the turn stopped something, how that stop went.
 *
 * The runtime is started in the run's working copy, which is the working root
 * Codex uses and the root its sandbox keeps writes inside. A turn that reports a
 * completed one is a summary; everything else rejects, and the runner treats a
 * rejected turn as a failed run. What the runtime says about the work — including
 * a claim that tests passed — is agent text: it is kept as the turn's summary and
 * never becomes a check result. Nothing vendor-specific leaves this module, and
 * credentials stay in the runtime's own environment, never in a task, a
 * configuration, a log, or a report.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { planLaunch } from '../../process/launch.js';
import { within } from '../../process/stop.js';
import type { AgentTurnRequest, AgentTurnResult } from '../../runs/contracts.js';
import { messageOf } from '../../shared/errors.js';
import type { TerminationOutcome } from '../../shared/types.js';
import { agentMessage, failureText, parseEvent } from './events.js';
import type { RuntimeOutcome, RuntimeReport } from './events.js';
import { promptFor } from './prompt.js';
import { CODEX_EXEC_ARGUMENTS, codexRuntime } from './runtime.js';
import type { CodexRuntime } from './runtime.js';

/** How much of a runtime's own diagnostic this module repeats in a reason. */
const MAX_DIAGNOSTIC_CHARS = 400;

/** The longest summary kept from a runtime's final message; its log keeps it all. */
const MAX_SUMMARY_CHARS = 2000;
/** A coding turn that could not complete. The runner treats it as a failed run. */
export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentError';
  }
}
/** The first `max` characters of `text`, flattened onto one line. */
function excerpt(text: string, max = MAX_DIAGNOSTIC_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)} [truncated]`;
}

/** The agent's own words, bounded: the turn's log keeps the whole message. */
function normalizedSummary(text: string | null): string | null {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') {
    return null;
  }
  return trimmed.length <= MAX_SUMMARY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_SUMMARY_CHARS)} [truncated: this turn's log holds the full message]`;
}
/**
 * Runs one top-level coding turn through the runtime and awaits its completion.
 *
 * The turn resolves with what the runtime reported about a completed turn, and
 * rejects — with an {@link AgentError} — for every other ending: a runtime that
 * could not be started, one that reported a failure, one that exited without
 * reporting a completed turn, and one whose stream contradicted itself. A turn
 * the harness stopped because the run was stopped resolves instead, carrying the
 * stop's own record, so the runner can read what was actually observed rather
 * than a failure invented on the way out.
 *
 * The turn's output is written to the log it was given as it arrives, so a turn
 * that fails keeps what it wrote before it failed; the caller owns that log and
 * closes it.
 */
export async function runCodexTurn(
  request: AgentTurnRequest,
  runtime: CodexRuntime = codexRuntime(),
): Promise<AgentTurnResult> {
  const { agentLog: log, workspacePath, stop, kind, turn } = request;
  const prompt = promptFor(request);
  const [executable = '', ...prefix] = runtime.command;
  // The prefix, then the adapter's own arguments: the configured launch and the
  // fixed interface, in that order and never joined into one string.
  const execArguments = [...prefix, ...CODEX_EXEC_ARGUMENTS];
  const invocation = [...runtime.command, ...CODEX_EXEC_ARGUMENTS].join(' ');
  log.write(`# ${invocation} — ${kind} turn ${String(turn)}, working root ${workspacePath}\n`);

  if (stop.aborted) {
    // The run was stopped before this turn started anything, and work is never
    // begun after the run it belongs to has been stopped. Nothing of this turn
    // ran, so nothing of it is left running: the stop is confirmed, and no
    // runtime is started only to be stopped again.
    log.write('# the run was already stopped: no runtime was started\n');
    return { summary: null, shutdown: { termination: 'confirmed', problem: null } };
  }

  const plan = planLaunch(executable, execArguments, workspacePath);
  if (!plan.ok) {
    log.write(`# the runtime could not be started: ${plan.problem}\n`);
    throw new AgentError(`the coding runtime could not be started: ${plan.problem}`);
  }
  const { file, args: launcherArgs, verbatim } = plan.launcher;

  const report: RuntimeReport = {
    summary: null,
    sessionId: null,
    completed: false,
    failure: null,
    unreadable: 0,
    firstUnreadable: null,
  };

  const outcome = await new Promise<RuntimeOutcome>((resolve) => {
    let launchError: string | null = null;
    let settled = false;
    let stopped = false;
    let termination: TerminationOutcome | null = null;
    let terminationProblem: string | null = null;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let stderrHead = '';
    /** Output that has arrived but does not yet end in a line break. */
    let buffered = '';
    let markEnded: () => void = () => undefined;
    const endedOnce = new Promise<void>((settleEnded) => {
      markEnded = settleEnded;
    });
    /** Held by the run's stop request for exactly as long as this turn runs. */
    let onStop: (() => void) | null = null;

    /**
     * Reads one line of the runtime's event stream. Event types this adapter
     * does not know are ignored on purpose — the interface is read for what the
     * turn reported, not validated against a list that would then have to keep
     * up with the CLI. A line that is not an event at all is counted, because an
     * interface that is not the one this adapter was written for is exactly what
     * an incomplete completion has to be reported as.
     */
    const readLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') {
        return;
      }
      const event = parseEvent(trimmed);
      if (event === null) {
        report.unreadable += 1;
        report.firstUnreadable ??= trimmed;
        return;
      }
      switch (event['type']) {
        case 'thread.started': {
          const sessionId = event['thread_id'];
          if (typeof sessionId === 'string' && sessionId !== '') {
            report.sessionId = sessionId;
          }
          return;
        }
        case 'item.completed': {
          const message = agentMessage(event['item']);
          if (message !== null) {
            report.summary = message;
          }
          return;
        }
        case 'turn.completed':
          report.completed = true;
          return;
        case 'turn.failed':
          report.failure = failureText(event) ?? 'the runtime reported that the turn failed';
          return;
        case 'error':
          report.failure = failureText(event) ?? 'the runtime reported an error';
          return;
        default:
          return;
      }
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (onStop !== null) {
        // The run's stop request outlives this turn, so this turn's listener is
        // released rather than left on it.
        stop.removeEventListener('abort', onStop);
      }
      // A killed runtime can end mid-line. What is left cannot be read as an
      // event, and is counted as what it is rather than dropped silently.
      readLine(buffered);
      buffered = '';
      resolve({
        launchError,
        stopped,
        termination,
        terminationProblem,
        exitCode,
        signal,
        report,
        stderrHead,
      });
    };

    /**
     * Ends the runtime and everything it started, once the run that owns it is
     * stopped. Only the stop that reaches the operating system *and* a runtime
     * seen to end is confirmed: a tree that may still be running must never be
     * reported as stopped, and the wait is what makes "it ended" an observation
     * rather than an assumption.
     */
    const stopOwnedRuntime = async (): Promise<void> => {
      if (settled || stopped) {
        // It ended by itself just as the harness stopped it — its own ending is
        // the result — or it is already being stopped.
        return;
      }
      const { pid } = child;
      if (pid === undefined) {
        // Nothing of this turn ever started, so no tree of ours exists to stop.
        termination = 'confirmed';
        finish();
        return;
      }
      stopped = true;

      const stopProblem = await runtime.stopTree(pid);
      const endedInTime = await within(endedOnce, runtime.stopGraceMs);
      termination = stopProblem === null && endedInTime ? 'confirmed' : 'unconfirmed';
      terminationProblem =
        termination === 'confirmed'
          ? null
          : (stopProblem ??
            `the coding runtime had not ended ${String(runtime.stopGraceMs)} ms after it was stopped`);
      finish();
    };

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(file, [...launcherArgs], {
        cwd: workspacePath,
        env: runtime.env,
        // The prompt arrives on standard input and nothing else is interactive:
        // a turn must never wait for a terminal that is not there.
        stdio: ['pipe', 'pipe', 'pipe'] as const,
        // On Windows the runtime is deliberately *not* detached: a detached
        // process gets a console of its own, and everything it then runs writes
        // to that console instead of the pipes captured here. It is stopped by
        // PID there instead, which needs no process group. Elsewhere it leads
        // its own group, which is what lets the whole tree be signalled at once.
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: verbatim,
        windowsHide: true,
      });
    } catch (cause) {
      launchError = `${messageOf(cause)} (working directory "${workspacePath}")`;
      finish();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      log.write(chunk);
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        readLine(line);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      log.write(chunk);
      if (stderrHead.length < MAX_DIAGNOSTIC_CHARS) {
        stderrHead += chunk;
      }
    });

    // A runtime that exits without reading its prompt closes this pipe under the
    // write: its own ending is the result of the turn, and an unread prompt is
    // not a second failure to report.
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);

    child.on('error', (cause) => {
      // Only a runtime that never started is a launch failure; one that already
      // ran reports what happened through 'close'.
      if (child.pid === undefined) {
        launchError = `${messageOf(cause)} (working directory "${workspacePath}")`;
        finish();
      }
    });

    child.on('close', (code, childSignal) => {
      exitCode = code;
      signal = childSignal;
      markEnded();
      if (stopped) {
        // The stop path is waiting for exactly this end and owns the result: the
        // turn is recorded as stopped, with how it was stopped.
        return;
      }
      finish();
    });

    onStop = () => {
      void stopOwnedRuntime();
    };
    stop.addEventListener('abort', onStop, { once: true });
    if (stop.aborted) {
      // It arrived between the check above and this listener: the runtime is
      // stopped the same way, rather than left running past the run.
      onStop();
    }
  });

  if (outcome.stopped) {
    // The run was stopped, so the turn was too. What the runtime managed to
    // report before that is kept as the turn's summary, and the stop's own
    // record goes back with it — the runner decides what a stopped turn means.
    log.write(
      `# stopped: the run was stopped, and this runtime's stop is ${String(outcome.termination)}` +
        (outcome.terminationProblem === null ? '' : ` (${outcome.terminationProblem})`) +
        '\n',
    );
    return {
      summary: normalizedSummary(outcome.report.summary),
      // A stop is never rounded down: an unconfirmed one stays unconfirmed.
      shutdown: {
        termination: outcome.termination ?? 'unconfirmed',
        problem: outcome.terminationProblem,
      },
    };
  }

  const { report: parsed } = outcome;

  if (outcome.launchError !== null) {
    log.write(`# the runtime could not be started: ${outcome.launchError}\n`);
    throw new AgentError(`the coding runtime could not be started: ${outcome.launchError}`);
  }

  if (parsed.failure !== null) {
    // An authentication failure, a refused request, and a broken runtime all
    // arrive here as the runtime's own report of itself; the harness repeats
    // what it said instead of inventing a category for it.
    log.write(`# the runtime reported a failure: ${excerpt(parsed.failure)}\n`);
    throw new AgentError(
      parsed.completed
        ? `the coding runtime reported a failed turn and a completed turn, so the turn cannot be ` +
            `read as completed: ${excerpt(parsed.failure)}`
        : `the coding runtime reported that the turn failed: ${excerpt(parsed.failure)}`,
    );
  }

  const errorNote =
    outcome.stderrHead.trim() === ''
      ? ''
      : `; its error output begins: "${excerpt(outcome.stderrHead)}"`;

  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const how =
      outcome.signal === null
        ? `exited with code ${String(outcome.exitCode)}`
        : `was killed by ${outcome.signal} without a stop the harness asked for`;
    log.write(`# ${how} without reporting a completed turn\n`);
    throw new AgentError(
      `the coding runtime ${how} without reporting a completed turn${errorNote}`,
    );
  }

  if (!parsed.completed) {
    const lines =
      parsed.unreadable === 0
        ? ''
        : `; ${String(parsed.unreadable)} of its output lines were not JSON events` +
          (parsed.firstUnreadable === null
            ? ''
            : `, beginning with "${excerpt(parsed.firstUnreadable, 120)}"`);
    log.write('# the runtime exited 0 without reporting a completed turn\n');
    throw new AgentError(
      `the coding runtime exited with code 0 without reporting that the turn completed${lines}` +
        `${errorNote}. An unexpected runtime interface is an execution failure, not a completed ` +
        `turn; what it wrote is in "${log.path}"`,
    );
  }

  log.write(`# completed: exit code 0, session ${parsed.sessionId ?? 'not reported'}\n`);
  return { summary: normalizedSummary(parsed.summary) };
}
