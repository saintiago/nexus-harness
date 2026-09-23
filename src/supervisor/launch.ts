/**
 * The launch handshake: how a worker the supervisor started learns that its
 * launch was really recorded, and what a supervisor that finds an unregistered
 * launch says about it.
 *
 * Spawning a process and writing down which process it is are two steps, and a
 * supervisor that dies between them would otherwise leave a child nobody's
 * records name — a restart would read "no worker is running" and start a second
 * one beside work that is already going on. So the order is turned around: the
 * supervisor writes the launch's own record — a token, and no PID yet — before
 * it spawns anything, hands the child that token in its environment, and
 * records the child's PID in the same record before the child may proceed. The
 * child waits here for that record to name it, so a worker that was never
 * registered never began any work at all (docs/WORKFLOW.md §12).
 *
 * The parent's half lives beside the supervisor's own state; this module is the
 * child's half and the words both halves use, so one file's shape is defined
 * once.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The file the supervisor registers a launch in: its own pointer record. */
export const LAUNCH_PATH_ENV = 'NEXUS_SUPERVISION_LAUNCH';
/** The token that names this launch inside that record. */
export const LAUNCH_TOKEN_ENV = 'NEXUS_SUPERVISION_LAUNCH_TOKEN';

/**
 * How long a launched worker waits for its own registration before it gives up
 * and exits without doing anything. Registration is one small file write the
 * supervisor makes immediately after spawning, so this bound is only reached
 * when the supervisor is gone; it is generous so a slow disk cannot turn a real
 * launch into a refused one.
 */
export const LAUNCH_TIMEOUT_MS = 60_000;

/** How often the waiting child re-reads its launch record. */
const LAUNCH_POLL_MS = 25;

/** One launch, as the supervisor's pointer record carries it. */
export interface LaunchRecord {
  readonly version: 1;
  readonly launch: { readonly token: string; readonly at: string } | null;
  readonly workerPid: number | null;
}

/** What one waiting child was told to look for. */
export interface LaunchWait {
  /** The record the supervisor registered the launch in. */
  readonly file: string;
  readonly token: string;
  /** The waiting process's own id, which the record has to name. */
  readonly pid: number;
  readonly timeoutMs?: number;
  /** Injected by a test; the real wait sleeps between reads. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Whether one read of the launch record names exactly this launch. */
function registered(text: string, token: string, pid: number): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    // A record that is being rewritten is not a registration yet: keep waiting,
    // and let the bound decide if it never becomes one.
    return false;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const launch = record['launch'];
  if (typeof launch !== 'object' || launch === null || Array.isArray(launch)) {
    return false;
  }
  return (launch as Record<string, unknown>)['token'] === token && record['workerPid'] === pid;
}

/** The wait's own clock and sleep, as a caller may substitute them. */
function waitParts(request: LaunchWait): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
} {
  return {
    sleep:
      request.sleep ??
      (async (ms: number) => {
        await new Promise<void>((resolve) => {
          // The wait is deliberately referenced: while a launched worker waits
          // for its own registration, this timer is the only work keeping the
          // process alive, and an unref'd one would let the process exit with
          // the launch never decided — neither registered nor refused.
          setTimeout(resolve, ms);
        });
      }),
    now: request.now ?? (() => Date.now()),
  };
}

/**
 * Waits until the supervisor's record for this launch names this process, and
 * returns a problem — never a silent proceed — when it never does. The wait is
 * the whole point: nothing the command does may begin before the launch that
 * will be responsible for it is durable, so a supervisor that died in the
 * window between spawn and registration leaves a process that did nothing.
 */
export async function awaitLaunchRegistration(request: LaunchWait): Promise<string | null> {
  const { file, token, pid } = request;
  const timeoutMs = request.timeoutMs ?? LAUNCH_TIMEOUT_MS;
  const { sleep, now } = waitParts(request);
  const deadline = now() + timeoutMs;
  for (;;) {
    let text: string | null;
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        return (
          `the launch record "${file}" could not be read (${String(cause)}), so this process ` +
          'cannot tell whether the supervisor that started it registered it. It does nothing ' +
          'here; check the supervisor and the record by hand before running the queue again.'
        );
      }
      text = null;
    }
    if (text !== null && registered(text, token, pid)) {
      return null;
    }
    if (now() >= deadline) {
      return (
        `the supervisor that started this process (pid ${String(pid)}, launch token ${token}) ` +
        `never registered it in "${file}" within ${String(Math.round(timeoutMs / 1000))}s, so ` +
        'nothing was begun. A supervisor that stops in the window between spawning its worker ' +
        'and recording it leaves exactly this behind; a person has to say what happened before ' +
        'the queue runs again.'
      );
    }
    await sleep(LAUNCH_POLL_MS);
  }
}

/**
 * What a supervisor says when it finds a launch it cannot reconcile: its token
 * is written down, but no process was ever recorded for it, so nothing can tell
 * whether the child it spawned is still there. The child is gated on the very
 * registration that never came — it has begun no work and exits by itself — and
 * a person clears the state before another worker is started.
 */
export function unreconciledLaunchProblem(request: {
  readonly file: string;
  readonly token: string;
  readonly at: string;
}): string {
  return (
    `an earlier supervisor left a worker launch it never finished recording: the launch ` +
    `(token ${request.token}, started ${request.at}) in "${request.file}" names no process, so ` +
    'nothing can tell whether the worker it spawned is still there. No second worker is started ' +
    'here, and the worker of that launch is started gated — it does nothing until its own ' +
    `registration exists and gives up after ${String(Math.round(LAUNCH_TIMEOUT_MS / 1000))}s ` +
    'by itself. Make sure no worker of that launch is running, remove that record (or the ' +
    'supervision state it lives in), and run the supervisor again.'
  );
}

/** The launch record a worker was started with, from its own environment. */
export function launchFromEnvironment(
  environment: NodeJS.ProcessEnv,
): { readonly file: string; readonly token: string } | null {
  const file = environment[LAUNCH_PATH_ENV];
  const token = environment[LAUNCH_TOKEN_ENV];
  if (file === undefined || file.trim() === '' || token === undefined || token.trim() === '') {
    return null;
  }
  return { file: path.resolve(file), token };
}

/** The environment one launched worker is started with. */
export function launchEnvironment(request: {
  readonly file: string;
  readonly token: string;
}): Record<string, string> {
  return {
    [LAUNCH_PATH_ENV]: request.file,
    [LAUNCH_TOKEN_ENV]: request.token,
  };
}
