/**
 * The stand-in coding runtime of the built-CLI end-to-end suite.
 *
 * It is a real program that a real `codex` name resolves to, on the `PATH` of the
 * CLI the suite starts. The production adapter starts it exactly as it starts the
 * real runtime — `codex --ask-for-approval never exec --sandbox danger-full-access
 * --json -`, prompt on standard input — so nothing in `src/` knows this file
 * exists and no flag reaches it. Everything above this boundary is real: the CLI
 * process, its argument parsing, Git, the target's own commands, the filesystem,
 * the reports.
 *
 * It works in the working copy it was started in and speaks the documented event
 * stream on standard output. Two records are kept for the suite to read back:
 *
 *   turns.jsonl          one line per invocation: the arguments the adapter used,
 *                        the working directory, the prompt in full, and the
 *                        beacon tokens of this process and of its own child
 *   runtime-events.jsonl one line per event: what the turn did, and which
 *                        interrupts arrived, and when
 *
 * A turn's plan comes from the `FAKE_CODEX` environment variable the harness
 * passes to the CLI, which the CLI passes on to it. Turns are strictly
 * sequential — the harness runs one coding turn at a time — so the plan a turn
 * follows is the one at the index of the turns already recorded.
 *
 * Signals are recorded and ignored, so that the interrupt a test sends to the CLI
 * cannot end this turn by itself: the behaviour under test is that the *harness*
 * stops the runtime it started, and a stand-in that died of the interrupt would
 * prove nothing about that stop path and would race it. On a console interrupt it
 * is not saved by these handlers in practice — measured, not assumed: the harness
 * starts its runtime without a console on Windows, and in a process group of its
 * own elsewhere, so the interrupt never reaches this process at all.
 *
 * While it runs, every invocation answers on a liveness beacon named by a token
 * only that process recorded. The suite asks the beacon, never a bare PID,
 * whether the process a turn recorded is still there.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beaconAnswers, randomToken, startBeacon } from './beacon.mjs';

const config = JSON.parse(process.env.FAKE_CODEX ?? '{}');
const stateDir = config.stateDir;
const turnsFile = path.join(stateDir, 'turns.jsonl');
const eventsFile = path.join(stateDir, 'runtime-events.jsonl');
const self = fileURLToPath(import.meta.url);

const record = (event, extra = {}) =>
  appendFileSync(eventsFile, `${JSON.stringify({ event, at: Date.now(), ...extra })}\n`, 'utf8');
const emit = (one) => process.stdout.write(`${JSON.stringify(one)}\n`);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => record('signal', { signal, pid: process.pid }));
}

if (process.argv.includes('--version')) {
  // The prerequisite probe the live verifier makes before it spends a call: it
  // asks whether the selected launcher starts at all, and a turn is not a turn.
  // Nothing is recorded, so no plan is consumed by it.
  process.stdout.write('codex-cli stand-in\n');
  process.exit(0);
}

// This process's own token, and the token its holding child is given: both are
// recorded in turns.jsonl, so the suite can ask each process itself whether it
// is gone rather than asking a PID that may now belong to something else.
/** The directory the beacons answer from: sockets live in its `beacons/` child. */
const beaconDirectory = stateDir;
const holdFlag = process.argv.indexOf('--hold');
const beaconToken = holdFlag >= 0 ? (process.argv[holdFlag + 1] ?? randomToken()) : randomToken();
const beaconReady = startBeacon(beaconDirectory, beaconToken);

if (holdFlag >= 0) {
  // The process a holding turn manages. It never ends on its own, so a stop that
  // did not reach it stays visible as a live PID after the run has ended.
  void beaconReady.then(() => {
    record('hold-start', { pid: process.pid, token: beaconToken });
  });
  setInterval(() => {}, 250);
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    prompt += chunk;
  });
  process.stdin.on('end', () => {
    void run(prompt);
  });
}

async function run(prompt) {
  const seen = existsSync(turnsFile)
    ? readFileSync(turnsFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '').length
    : 0;
  const plan = (config.plans ?? [])[seen] ?? {};
  const holdMs = Number(plan.holdMs ?? 0);
  const holdToken = holdMs > 0 ? randomToken() : null;
  const hold =
    holdToken === null
      ? null
      : spawn(process.execPath, [self, '--hold', holdToken], { stdio: 'ignore' });
  // The record names the child's beacon only once that beacon answers, so a
  // recorded token always names a listener that exists.
  const childAnswers =
    holdToken === null ? false : await beaconAnswers(beaconDirectory, holdToken, 10_000);
  // This process's own beacon, before the record that names it.
  await beaconReady;

  appendFileSync(
    turnsFile,
    `${JSON.stringify({
      index: seen,
      pid: process.pid,
      pidToken: beaconToken,
      child: hold === null ? null : hold.pid,
      childToken: childAnswers ? holdToken : null,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      prompt,
      environmentPresent: Object.fromEntries(
        (plan.inspectEnvironment ?? []).map((name) => [name, process.env[name] !== undefined]),
      ),
    })}\n`,
    'utf8',
  );
  record('turn-start', {
    index: seen,
    pid: process.pid,
    child: hold === null ? null : hold.pid,
    cwd: process.cwd(),
  });

  for (const edit of plan.edits ?? []) {
    const file = path.join(process.cwd(), edit.file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, edit.text, 'utf8');
  }
  for (const file of plan.removes ?? []) {
    rmSync(path.join(process.cwd(), file), { force: true });
  }
  record('edits-written', { files: (plan.edits ?? []).map((edit) => edit.file) });

  if (plan.reviewInspection !== undefined) {
    const inspection = plan.reviewInspection;
    let verdict;
    try {
      // This is executed by the runtime process in its actual working directory,
      // not by the test after the turn. Both ordinary read boundaries must work.
      const committed = execFileSync('git', ['show', `HEAD:${inspection.file}`], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const checkedOut = readFileSync(inspection.file, 'utf8').replaceAll('\r\n', '\n');
      if (checkedOut !== committed.replaceAll('\r\n', '\n')) {
        throw new Error('the required file disagrees with the committed content');
      }
      const blocking = checkedOut.includes(inspection.blockingText);
      record('review-inspection', { file: inspection.file, blocking });
      verdict = blocking ? inspection.blockingVerdict : inspection.clearVerdict;
    } catch (cause) {
      record('review-inspection-failed', { file: inspection.file });
      verdict = JSON.stringify({
        verdict: 'inconclusive',
        summary: `Required file/tool access failed: ${String(cause)}`.slice(0, 2000),
        findings: [],
      });
    }
    writeFileSync(path.join(process.cwd(), '..', 'verdict.json'), verdict, 'utf8');
  }

  const mode = plan.mode ?? 'ok';
  const summary = plan.summary ?? 'the turn is done';

  if (mode === 'auth') {
    // A runtime that cannot authenticate: it says so on standard error and ends
    // without the event stream the adapter reads.
    process.stderr.write('not logged in: run `codex login` to authenticate\n');
    record('end', { mode });
    process.exitCode = 1;
    return;
  }
  if (mode === 'crashed') {
    // A runtime that ends without reporting anything at all.
    record('end', { mode });
    process.exitCode = 3;
    return;
  }
  if (mode === 'malformed') {
    // Not an event stream at all: a runtime whose interface is not the one the
    // adapter was written for.
    process.stdout.write('thinking about the task, no events here\n');
    record('end', { mode });
    process.exitCode = 0;
    return;
  }
  if (mode === 'incomplete') {
    // A message and an exit, but no completed turn: the turn never finished.
    emit({ type: 'thread.started', thread_id: 'stand-in' });
    emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: summary } });
    record('end', { mode });
    process.exitCode = 0;
    return;
  }
  if (mode === 'failed') {
    // The turn itself reports failure while the process ends cleanly.
    emit({ type: 'thread.started', thread_id: 'stand-in' });
    emit({ type: 'turn.failed', error: { message: summary } });
    record('end', { mode });
    process.exitCode = 1;
    return;
  }

  emit({ type: 'thread.started', thread_id: 'stand-in' });
  emit({ type: 'turn.started' });
  process.stderr.write(`progress: working in ${process.cwd()}\n`);
  emit({
    type: 'item.started',
    item: {
      id: 'i1',
      type: 'command_execution',
      command: 'node tools/run-checks.mjs',
      status: 'in_progress',
    },
  });
  emit({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: summary } });

  if (holdMs > 0) {
    // A turn that is still working when the run is stopped: it keeps working and
    // never reports a completed turn, because an interrupted runtime never does.
    record('holding', { pid: process.pid, holdMs });
    setInterval(() => {}, 250);
    return;
  }

  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
  record('end', { mode });
  process.exitCode = 0;
}
