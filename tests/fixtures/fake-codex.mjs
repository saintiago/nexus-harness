/**
 * The stand-in coding runtime of the built-CLI end-to-end suite.
 *
 * It is a real program that a real `codex` name resolves to, on the `PATH` of the
 * CLI the suite starts. The production adapter starts it exactly as it starts the
 * real runtime — `codex --ask-for-approval never exec --sandbox workspace-write
 * --json -`, prompt on standard input — so nothing in `src/` knows this file
 * exists and no flag reaches it. Everything above this boundary is real: the CLI
 * process, its argument parsing, Git, the target's own commands, the filesystem,
 * the reports.
 *
 * It works in the working copy it was started in and speaks the documented event
 * stream on standard output. Two records are kept for the suite to read back:
 *
 *   turns.jsonl          one line per invocation: the arguments the adapter used,
 *                        the working directory, and the prompt in full
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
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

if (process.argv.includes('--hold')) {
  // The process a holding turn manages. It never ends on its own, so a stop that
  // did not reach it stays visible as a live PID after the run has ended.
  record('hold-start', { pid: process.pid });
  setInterval(() => {}, 250);
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    prompt += chunk;
  });
  process.stdin.on('end', () => {
    run(prompt);
  });
}

function run(prompt) {
  const seen = existsSync(turnsFile)
    ? readFileSync(turnsFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '').length
    : 0;
  const plan = (config.plans ?? [])[seen] ?? {};
  const holdMs = Number(plan.holdMs ?? 0);
  const hold = holdMs > 0 ? spawn(process.execPath, [self, '--hold'], { stdio: 'ignore' }) : null;

  appendFileSync(
    turnsFile,
    `${JSON.stringify({
      index: seen,
      pid: process.pid,
      child: hold === null ? null : hold.pid,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      prompt,
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
