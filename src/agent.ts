/**
 * The coding runtime: one top-level coding turn, run through the Codex CLI.
 *
 * ## The interface this adapter is written against
 *
 * The runtime is the host's own `codex` command, driven through `codex exec` —
 * the documented non-interactive form of the `@openai/codex` CLI. See README.md,
 * "Coding runtime", for the reference this was written against, the interface
 * version, how to install and authenticate it, and what could not be verified.
 * In short: `codex exec` takes its prompt on standard input when the prompt
 * argument is `-`, writes one JSON event per line to standard output when
 * `--json` is given, writes its progress to standard error, and exits when the
 * turn is over.
 *
 * ## The launch prefix
 *
 * How the runtime is started is configuration: one executable followed by
 * literal prefix arguments, which is what lets an operator select the installed
 * Codex, a compatible wrapper, a native profile, or a model without the runner
 * knowing anything about it (docs/spec.md §2). The prefix is not a complete
 * command: this adapter appends its own arguments
 * (`exec --sandbox workspace-write --json -`), starts the process in the run's
 * working copy, and writes the prompt to standard input. Nothing is joined into
 * a shell string, and no prefix argument is expanded, reordered, or interpreted.
 * A prefix that redirects the working directory, replaces the structured output,
 * or overrides the adapter's permission controls is outside this contract; so is
 * a credential in an argument, because the launch is recorded in the run's report
 * and timeline (docs/spec.md §5).
 *
 * Nothing vendor-specific leaves this module. The runner is handed a summary and
 * — when the turn stopped something — how that stop went (see
 * {@link AgentTurnResult}); no Codex flag, event, or type reaches it.
 *
 * ## What one turn is told, and where it works
 *
 * A turn works in the run's working copy and nowhere else. The runtime process
 * is started *in* that directory, which is the working root Codex uses and the
 * root its `workspace-write` sandbox keeps writes inside, so the binding is made
 * by the operating system and a working-copy path that a Windows `.cmd` shim
 * could not carry as an argument cannot fail a turn. The prompt carries the task
 * with its acceptance criteria, the project's own instructions as far as the
 * working copy holds them, and the constraints the harness puts on a coding
 * turn: do not weaken tests or tooling, do not touch the source checkout or the
 * harness's own configuration and command plan, and publish nothing. A repair
 * turn is given the failures the harness observed, with the output they wrote
 * and where that output lives. The prompt is written to the runtime's standard
 * input rather than passed as an argument: it is long, multi-line text.
 *
 * ## Completion, failure, and the stop of what the turn started
 *
 * A turn that reports a completed one is a summary. Everything else rejects, and
 * the runner treats a rejected turn as a failed run: a runtime that could not be
 * started, one that exits without reporting a completed turn, one that reports a
 * failure, and one whose stream contradicts itself are all execution failures,
 * and no check is run after one. What the runtime says about the work — including
 * a claim that tests passed — is agent text: it is kept as the turn's summary and
 * never becomes a check result (docs/spec.md §5).
 *
 * When the run is stopped — its deadline expired, or its caller stopped it — the
 * runtime is stopped the way a configured command is: the process tree this
 * module started is named by the PID it recorded, ended through the host's own
 * supported stop, and waited for up to a grace period. Only a stop that reached
 * the operating system *and* was seen to end is `confirmed`; anything else is
 * reported as `unconfirmed` with what could not be confirmed, so the run can
 * refuse to reuse a working copy something may still be writing to
 * (docs/spec.md §3). Nothing is started after a stop has arrived, a turn that
 * started nothing has nothing to stop, and a runtime that ends by itself while a
 * stop was pending is a runtime that ended by itself.
 *
 * ## Sessions
 *
 * The CLI can continue a session (`codex exec resume`), and this adapter
 * deliberately does not use it: every top-level coding turn is one fresh
 * invocation carrying everything it needs. A repair turn is therefore a
 * top-level turn like any other and spends one of the run's repairs, so resuming
 * can never quietly buy a runtime extra turns (docs/spec.md §2).
 *
 * ## Authentication
 *
 * Credentials are never part of a task, a configuration, or this module. They
 * stay where the runtime keeps them — the ambient environment and `CODEX_HOME` —
 * and the environment the runtime is started with is passed on as it is: it is
 * never read, written, logged, or repeated in a failure message, so no
 * authentication payload can reach a log, a report, or a timeline. See README.md,
 * "Coding runtime", for the supported ways to authenticate the CLI.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { STOP_GRACE_MS, planLaunch, requestTreeStop, within } from './checks.js';
import type { AgentTurnRequest, AgentTurnResult } from './runner.js';
import type { AgentSelection, FailedCommand, TerminationOutcome } from './types.js';

/** The runtime the harness runs when its caller names none: the installed CLI. */
export const CODEX_EXECUTABLE = 'codex';

/**
 * How the runtime is invoked, as the documented `codex exec` form: never ask a
 * human for approval, write events to standard output as JSON Lines, keep writes
 * inside the working copy, and read the prompt from standard input. The working
 * root is the directory the process is started in, so it is not named here — it
 * would be a path on a command line, and only a Windows `.cmd` shim would have
 * to refuse it.
 *
 * These are the adapter's own arguments and are not configurable: a configured
 * launch prefix is prepended to them and cannot replace them
 * (docs/WORKFLOW.md §1, "Agent contract"). A run is unattended, so an action
 * outside the `workspace-write` sandbox has to fail the turn instead of waiting
 * for an approval nobody is there to give; nothing here bypasses the sandbox or
 * retries with a weaker one.
 *
 * `--ask-for-approval never` is the CLI's global option and, on the installed
 * CLI (0.154.0), it is only accepted *before* the `exec` subcommand: the same
 * flag after `exec` is refused with `unexpected argument '--ask-for-approval'`.
 * It therefore sits at the front of the adapter's own arguments rather than
 * beside `--sandbox`, and the launch prefix is still used exactly as configured,
 * with everything here appended to it.
 */
export const CODEX_EXEC_ARGUMENTS: readonly string[] = [
  '--ask-for-approval',
  'never',
  'exec',
  '--sandbox',
  'workspace-write',
  '--json',
  '-',
];

/** The launch prefix an ordinary run uses: the installed CLI, no extra arguments. */
export const DEFAULT_CODEX_COMMAND: readonly string[] = [CODEX_EXECUTABLE];

/** The instruction file a working copy may hold, named in a prompt when it has one. */
const INSTRUCTION_FILE = 'AGENTS.md';

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

/**
 * What this module needs from its host to run one turn: the runtime to start,
 * the environment to start it in, and the one supported way to end a process
 * tree it started.
 *
 * Every part has a working default, and a test substitutes the parts it is
 * about. That substitution is also where another runtime, or a stand-in
 * executable on the test process's `PATH`, would be put: the boundary is the
 * runtime process, not this module's internals.
 */
export interface CodexRuntime {
  /**
   * The launch prefix to start: the executable, then literal prefix arguments,
   * exactly as the configuration selected them. `codex` on its own is resolved
   * from `PATH`; a path starts that executable. A `.cmd`/`.bat` on Windows is
   * started through the command interpreter, exactly as a configured command is
   * (see `checks.ts`).
   */
  readonly command: readonly string[];
  /**
   * The environment the runtime process inherits. This is where the runtime's
   * own authentication lives; it is passed on as it is, and never copied into a
   * log, a report, or a failure message.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Asks the host to end one process tree this module started, and says what the
   * request itself did: `null` when it succeeded, otherwise why it did not.
   */
  stopTree(pid: number): Promise<string | null>;
  /**
   * How long a stop is given to take effect before it is recorded as
   * unconfirmed, in milliseconds.
   */
  readonly stopGraceMs: number;
}

/**
 * The runtime an ordinary turn uses: the installed `codex`, this process's own
 * environment, the host's process-tree stop, and the same grace a configured
 * command's stop gets.
 */
export function codexRuntime(parts: Partial<CodexRuntime> = {}): CodexRuntime {
  return {
    command: DEFAULT_CODEX_COMMAND,
    env: process.env,
    stopTree: requestTreeStop,
    stopGraceMs: STOP_GRACE_MS,
    ...parts,
  };
}

/**
 * The runtime one turn of a run uses: the selection the configuration made,
 * through the host's own launcher.
 */
export function selectedCodexRuntime(
  agent: AgentSelection,
  parts: Partial<CodexRuntime> = {},
): CodexRuntime {
  return codexRuntime({ command: agent.command, ...parts });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
 * What the harness tells a coding turn about itself: the task it implements or
 * repairs, where it works, what the project asks of it, and what the harness
 * refuses to have done on its behalf. It is one prompt for both kinds of turn —
 * a repair turn is the same turn with what went wrong added.
 */
function promptFor(request: AgentTurnRequest): string {
  const { task, workspacePath, sourceRoot, baseCommit, kind, turn, repair } = request;
  const sections: string[] = [];

  sections.push(
    [
      'You are completing one task inside a detached working copy of a repository.',
      'A local harness started you, and it will run the project’s own configured checks in this',
      'working copy when you are done. Those checks, not your own account of the work, decide',
      'whether the task passed.',
    ].join('\n'),
  );

  sections.push(`## Task ${task.id}: ${task.title}\n${task.description.trim()}`);

  if (request.guidance !== undefined && request.guidance.length > 0) {
    // Context a source collected for this attempt: what the issue's comments said
    // since the previous one, and what the harness's own earlier attempts did.
    // Context for the work, never a command, a path, or a limit of its own.
    sections.push(
      [
        '## Guidance for this attempt',
        'A previous attempt at this task ended without the checks passing. These are the notes a',
        'person or another agent left since, and what the earlier attempts did:',
        ...request.guidance.map((line) => `- ${line}`),
        'Treat them as context for the work: they do not change the acceptance criteria above, and',
        'the same configured checks still decide whether this turn passed.',
      ].join('\n'),
    );
  }

  sections.push(
    ['## Acceptance criteria', ...task.acceptanceCriteria.map((one) => `- ${one.trim()}`)].join(
      '\n',
    ),
  );

  const instructions = existsSync(path.join(workspacePath, INSTRUCTION_FILE))
    ? `This working copy has its own ${INSTRUCTION_FILE} at its root: read it and follow it.`
    : `Whatever instructions the project keeps for coding agents — ${INSTRUCTION_FILE}, a README, contribution notes — are part of the task.`;
  sections.push(
    [
      '## Where you are working',
      `The working copy is ${workspacePath}. It was cloned from ${sourceRoot} and checked out at`,
      `${baseCommit}, and it is the project root for this turn: the runtime was started in it.`,
      instructions,
    ].join('\n'),
  );

  sections.push(
    [
      '## What this turn must not do',
      '- Do not weaken, skip, delete, or loosen the project’s tests, checks, linting, type checking,',
      '  or other tooling to make the work look finished. Fix the cause, not the way it is checked.',
      '- Do not change how the project is built or checked, and do not touch the harness that started',
      '  you: its configuration and the commands it runs live outside this working copy, and they are',
      '  not yours to change. Writes outside this working copy are refused by the sandbox.',
      `- Do not modify the source checkout this copy came from (${sourceRoot}), or any other` +
        ' checkout, and do not push, open pull requests, publish packages, deploy, or upload the work',
      '  anywhere: this turn’s work stays in this working copy.',
      `- Work only on the task. Leave everything you are not asked to change as you found it.`,
    ].join('\n'),
  );

  if (repair !== null) {
    sections.push(repairSection(kind, turn, repair));
  }

  sections.push(
    [
      '## When you are done',
      'Answer with a short summary of what you changed and why. The harness records it beside its',
      'own check results as your account of the turn, and it never counts as one of them.',
    ].join('\n'),
  );

  return `${sections.join('\n\n')}\n`;
}

/** What a repair turn is told about the round it repairs, failures and all. */
function repairSection(
  kind: AgentTurnRequest['kind'],
  turn: number,
  repair: NonNullable<AgentTurnRequest['repair']>,
): string {
  const lines = [
    `## Why this turn exists (${kind} turn ${String(turn)})`,
    `The harness ran the configured commands after turn ${String(repair.repairedTurn)}, and the ones`,
    'below did not exit 0. Fix the cause in the working copy; the commands themselves, and the',
    'harness configuration that defines them, are outside it and are not yours to change.',
  ];

  for (const failure of repair.failures) {
    lines.push('', failureSection(failure));
  }

  return lines.join('\n');
}

/** One failed command: the invocation the harness recorded, and what it wrote. */
function failureSection(failure: FailedCommand): string {
  const { result } = failure;
  const how =
    result.exitCode === null
      ? `${result.outcome}${result.signal === null ? '' : ` (${result.signal})`}`
      : `exit code ${String(result.exitCode)}`;
  return [
    `### ${JSON.stringify(result.command)} — ${how}`,
    `ran in ${result.cwd}`,
    `standard output: ${result.stdoutPath}`,
    `standard error: ${result.stderrPath}`,
    'Output as far as it was recorded:',
    failure.output.trim() === '' ? '(no output was written)' : failure.output.trim(),
  ].join('\n');
}

/** What one runtime process reported about itself, as this adapter reads it. */
interface RuntimeReport {
  /** The last complete agent message: the runtime's own account of the turn. */
  summary: string | null;
  /** The session the runtime opened, for the turn's log. Never resumed here. */
  sessionId: string | null;
  /** Whether the runtime reported that the turn completed. */
  completed: boolean;
  /** What the runtime reported as a failure, if it reported one. */
  failure: string | null;
  /** How many output lines were not JSON events, and the first of them. */
  unreadable: number;
  firstUnreadable: string | null;
}

/** What one runtime process did, before it is read as a turn or as a failure. */
interface RuntimeOutcome {
  readonly launchError: string | null;
  /** Whether the run's stop request is why the runtime was stopped. */
  readonly stopped: boolean;
  readonly termination: TerminationOutcome | null;
  readonly terminationProblem: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly report: RuntimeReport;
  /** The beginning of what the runtime wrote to standard error, for a reason. */
  readonly stderrHead: string;
}

/** A parsed JSON object with a `type`, or `null` for anything else on the stream. */
function parseEvent(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return typeof record['type'] === 'string' ? record : null;
}

/** The text of a completed agent message, or `null` when the item is another kind. */
function agentMessage(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (record['type'] !== 'agent_message') {
    return null;
  }
  const text = record['text'];
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

/** What a failure event says, where the documented failures carry their message. */
function failureText(event: Record<string, unknown>): string | null {
  const error = event['error'];
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
  }
  const message = event['message'];
  return typeof message === 'string' && message.trim() !== '' ? message : null;
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
